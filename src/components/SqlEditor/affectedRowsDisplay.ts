import type { ConnType } from '../../types'
import { transactionControlStatement } from './transactionControl.ts'

type WriteKind = 'insert' | 'update' | 'delete' | 'merge' | 'replace' | 'other'

export interface AffectedRowsDisplay {
  summary: string
  detail: string
}

const MYSQL_FAMILY = new Set<ConnType>(['mysql', 'mariadb', 'tidb', 'oceanBase'])

const DIALECT_NAME: Partial<Record<ConnType, string>> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  tidb: 'TiDB',
  oceanBase: 'OceanBase',
}

// 保留括号和单词位置，清空字符串与注释，避免把数据内容误判为 SQL 关键字。
function maskSqlLiterals(sql: string, hashComments: boolean): string {
  let result = ''
  let quote: "'" | '"' | '`' | '[' | null = null
  let lineComment = false
  let blockComment = false

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (lineComment) {
      if (ch === '\n') { lineComment = false; result += '\n' } else result += ' '
      continue
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { result += '  '; blockComment = false; i++ } else result += ch === '\n' ? '\n' : ' '
      continue
    }
    if (quote) {
      if (quote === '[') {
        if (ch === ']' && next === ']') { result += '  '; i++; continue }
        if (ch === ']') quote = null
        result += ' '
        continue
      }
      if (ch === '\\') { result += '  '; i++; continue }
      if (ch === quote && next === quote) { result += '  '; i++; continue }
      if (ch === quote) quote = null
      result += ch === '\n' ? '\n' : ' '
      continue
    }
    if (ch === '-' && next === '-') { result += '  '; lineComment = true; i++; continue }
    if (hashComments && ch === '#') { result += ' '; lineComment = true; continue }
    if (ch === '/' && next === '*') { result += '  '; blockComment = true; i++; continue }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') { quote = ch; result += ' '; continue }
    result += ch
  }
  return result
}

function writeKind(maskedSql: string): WriteKind {
  const words: Array<{ word: string; depth: number }> = []
  let depth = 0
  const re = /[A-Za-z_]+|[()]/g
  for (const match of maskedSql.matchAll(re)) {
    const token = match[0]
    if (token === '(') { depth++; continue }
    if (token === ')') { depth = Math.max(0, depth - 1); continue }
    words.push({ word: token.toUpperCase(), depth })
  }
  const topLevel = words.filter(item => item.depth === 0).map(item => item.word)
  const first = topLevel[0]
  if (first === 'WITH') {
    const main = topLevel.find(word => ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE'].includes(word))
    return (main?.toLowerCase() as WriteKind | undefined) ?? 'other'
  }
  if (first && ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE'].includes(first)) return first.toLowerCase() as WriteKind
  return 'other'
}

function countValuesRows(maskedSql: string, endIndex: number): number | null {
  const beforeConflict = maskedSql.slice(0, endIndex)
  const valuesMatches = [...beforeConflict.matchAll(/\bVALUES\b/gi)]
  const values = valuesMatches[valuesMatches.length - 1]
  if (!values || values.index === undefined) return null

  const segment = beforeConflict.slice(values.index + values[0].length)
  let depth = 0
  let rows = 0
  for (const ch of segment) {
    if (ch === '(') {
      if (depth === 0) rows++
      depth++
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1)
    }
  }
  return rows > 0 && depth === 0 ? rows : null
}

function mysqlUpsertDisplay(connType: ConnType, maskedSql: string, affected: number): AffectedRowsDisplay | null {
  if (!MYSQL_FAMILY.has(connType)) return null
  const conflict = /\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i.exec(maskedSql)
  const isReplace = /^\s*REPLACE\b/i.test(maskedSql)
  if (!conflict && !isReplace) return null

  const name = DIALECT_NAME[connType] ?? 'MySQL'
  const inputRows = countValuesRows(maskedSql, conflict?.index ?? maskedSql.length)
  if (conflict) {
    if (inputRows === 1 && affected === 2) {
      return {
        summary: '更新 1 行（数据库计数 2）',
        detail: `更新 1 行（${name} 冲突更新的影响行计数为 2）`,
      }
    }
    if (inputRows === 1 && affected === 0) {
      return {
        summary: '数据未变化（数据库计数 0）',
        detail: `匹配 1 行但数据未变化（${name} 影响行计数为 0）`,
      }
    }
    if (inputRows === 1 && affected === 1) {
      return { summary: '插入 1 行', detail: '插入 1 行' }
    }
    if (inputRows !== null) {
      return {
        summary: `处理 ${inputRows} 行（数据库计数 ${affected}）`,
        detail: `处理 ${inputRows} 条输入记录（${name} 影响行计数 ${affected}；插入按 1、冲突更新按 2 计）`,
      }
    }
    return {
      summary: `数据库计数 ${affected}（UPSERT）`,
      detail: `${name} UPSERT 影响行计数 ${affected}（插入按 1、冲突更新按 2 计）`,
    }
  }

  if (inputRows === 1 && affected === 2) {
    return {
      summary: '替换 1 行（数据库计数 2）',
      detail: `${name} 替换 1 行（删除旧行和插入新行各计 1）`,
    }
  }
  if (inputRows === 1 && affected === 1) return { summary: '插入 1 行', detail: '插入 1 行' }
  if (inputRows !== null) {
    return {
      summary: `处理 ${inputRows} 行（数据库计数 ${affected}）`,
      detail: `处理 ${inputRows} 条输入记录（${name} REPLACE 影响行计数 ${affected}）`,
    }
  }
  return {
    summary: `数据库计数 ${affected}（REPLACE）`,
    detail: `${name} REPLACE 影响行计数 ${affected}（替换旧行时删除和插入分别计数）`,
  }
}

/**
 * 将驱动的 rowsAffected 转成面向用户的文案。原始计数不在这里修改；特殊方言只补充计数语义。
 */
export function affectedRowsDisplay(connType: ConnType, sql: string, affected: number): AffectedRowsDisplay {
  const txControl = transactionControlStatement(sql, connType)
  if (txControl === 'begin') return { summary: '事务已开始', detail: '事务已开始' }
  if (txControl === 'commit') return { summary: '事务已提交', detail: '事务已提交' }
  if (txControl === 'rollback') return { summary: '事务已回滚', detail: '事务已回滚' }

  const maskedSql = maskSqlLiterals(sql, MYSQL_FAMILY.has(connType))
  const mysqlSpecial = mysqlUpsertDisplay(connType, maskedSql, affected)
  if (mysqlSpecial) return mysqlSpecial

  switch (writeKind(maskedSql)) {
    case 'insert': {
      if (/\bON\s+CONFLICT\b[\s\S]*\bDO\s+UPDATE\b/i.test(maskedSql)) {
        return {
          summary: `写入 ${affected} 行（插入或冲突更新）`,
          detail: `写入 ${affected} 行（数据库计数包含插入和冲突更新）`,
        }
      }
      if (/^\s*INSERT\s+OR\s+REPLACE\b/i.test(maskedSql)) {
        return {
          summary: `写入 ${affected} 行（插入或替换）`,
          detail: `写入 ${affected} 行（SQLite 计数包含插入或替换）`,
        }
      }
      return { summary: `插入 ${affected} 行`, detail: `插入 ${affected} 行` }
    }
    case 'update': return { summary: `更新 ${affected} 行`, detail: `更新 ${affected} 行` }
    case 'delete': return { summary: `删除 ${affected} 行`, detail: `删除 ${affected} 行` }
    case 'merge': return { summary: `变更 ${affected} 行`, detail: `合并语句共变更 ${affected} 行` }
    case 'replace': return { summary: `替换 ${affected} 行`, detail: `替换 ${affected} 行` }
    default: return { summary: `影响 ${affected} 行`, detail: `影响 ${affected} 行` }
  }
}
