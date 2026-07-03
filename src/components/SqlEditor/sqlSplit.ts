export type SqlSplitDialect =
  | 'mysql' | 'mariadb' | 'tidb' | 'oceanBase'
  | 'postgres' | 'kingBase' | 'openGauss'
  | 'sqlServer' | 'oracle' | 'sqlite' | 'duckdb' | 'clickHouse'
  | string

// 去掉注释与空白后判断语句是否“有效”（仅注释/空白 → 无效）
export function stripSqlComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, '')
    .replace(/#[^\n]*/g, '')
    .trim()
}

function isMysqlFamily(dialect?: SqlSplitDialect) {
  return ['mysql', 'mariadb', 'tidb', 'oceanBase'].includes(String(dialect))
}

function lineDirective(line: string, dialect?: SqlSplitDialect): { kind: 'delimiter'; value: string } | { kind: 'separator' } | null {
  const trimmed = line.trim()
  if (isMysqlFamily(dialect)) {
    const match = /^DELIMITER(?:\s+(\S+))?\s*$/i.exec(trimmed)
    if (match) return { kind: 'delimiter', value: match[1] || ';' }
  }
  if (dialect === 'sqlServer' && /^GO(?:\s+\d+)?$/i.test(trimmed)) return { kind: 'separator' }
  if (dialect === 'oracle' && trimmed === '/') return { kind: 'separator' }
  return null
}

function startsOracleBlock(line: string) {
  const upper = line.trimStart().toUpperCase()
  return upper.startsWith('DECLARE')
    || upper.startsWith('BEGIN')
    || /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION|TRIGGER|PACKAGE|TYPE)\b/.test(upper)
}

function pushStatement(stmts: string[], sql: string) {
  const trimmed = sql.trim()
  if (trimmed) stmts.push(trimmed)
}

// SQL 分句：忽略字符串和注释内结束符；MySQL 族支持 DELIMITER，SQL Server 支持 GO，Oracle 支持单独一行 /。
export function splitSqlStatements(sql: string, dialect?: SqlSplitDialect): string[] {
  const stmts: string[] = []
  let cur = ''
  let delimiter = ';'
  let i = 0
  const len = sql.length
  let lineStart = true
  let oracleBlock = false

  while (i < len) {
    if (lineStart) {
      const lineEnd = sql.indexOf('\n', i)
      const end = lineEnd === -1 ? len : lineEnd
      const directive = lineDirective(sql.slice(i, end), dialect)
      if (directive?.kind === 'delimiter') {
        pushStatement(stmts, cur)
        cur = ''
        delimiter = directive.value
        i = lineEnd === -1 ? len : lineEnd + 1
        lineStart = true
        continue
      }
      if (directive?.kind === 'separator') {
        pushStatement(stmts, cur)
        cur = ''
        oracleBlock = false
        i = lineEnd === -1 ? len : lineEnd + 1
        lineStart = true
        continue
      }
      if (dialect === 'oracle' && !stripSqlComments(cur) && startsOracleBlock(sql.slice(i, end))) {
        oracleBlock = true
      }
    }

    const ch = sql[i]
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      cur += end === -1 ? sql.slice(i) : sql.slice(i, end + 1)
      i = end === -1 ? len : end + 1
      lineStart = true
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      const block = end === -1 ? sql.slice(i) : sql.slice(i, end + 2)
      cur += block
      i = end === -1 ? len : end + 2
      lineStart = block.endsWith('\n')
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch
      let j = i + 1
      while (j < len) {
        if (sql[j] === '\\') { j += 2; continue }
        if (sql[j] === q && sql[j + 1] === q) { j += 2; continue }
        if (sql[j] === q) { j++; break }
        j++
      }
      const quoted = sql.slice(i, j)
      cur += quoted
      i = j
      lineStart = quoted.endsWith('\n')
    } else if (!oracleBlock && delimiter && sql.startsWith(delimiter, i)) {
      pushStatement(stmts, cur)
      cur = ''
      i += delimiter.length
      lineStart = false
    } else {
      cur += ch
      i++
      lineStart = ch === '\n'
    }
  }

  pushStatement(stmts, cur)
  return stmts
}

export function hasMysqlUserPreparedStmt(sql: string): boolean {
  return splitSqlStatements(sql, 'mysql').some(stmt => {
    const upper = stripSqlComments(stmt).trim().toUpperCase()
    return /^(PREPARE|EXECUTE|DEALLOCATE\s+PREPARE|DROP\s+PREPARE)\b/.test(upper)
  })
}

export function hasMysqlDelimiterDirective(sql: string): boolean {
  return sql.split(/\r?\n/).some(line => lineDirective(line, 'mysql')?.kind === 'delimiter')
}
