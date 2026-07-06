import type { ConnType } from '../../types'

type Quote = "'" | '"' | '`' | '['

interface DialectRules {
  identQuotes: Set<Quote>
}

const ALIAS_STOP_WORDS = new Set([
  'where', 'on', 'using', 'inner', 'left', 'right', 'outer', 'full', 'cross',
  'join', 'group', 'order', 'having', 'union', 'limit', 'offset', 'fetch', 'set',
  'as', 'and', 'or', 'select', 'values', 'with', 'window',
])

export interface SqlCompletionScope {
  aliases: Record<string, string>
  derivedColumns: Record<string, string[]>
}

export function stripQuoteIdent(s: string): string {
  const unwrapped = s.replace(/^[`"[]/, '').replace(/[`"\]]$/, '')
  const first = s[0]
  if (first === '`') return unwrapped.replace(/``/g, '`')
  if (first === '"') return unwrapped.replace(/""/g, '"')
  if (first === '[') return unwrapped.replace(/]]/g, ']')
  return unwrapped
}

function dialectRules(connType: ConnType | string): DialectRules {
  if (connType === 'sqlServer') return { identQuotes: new Set(['[']) }
  if (['mysql', 'mariadb', 'tidb', 'oceanBase', 'clickHouse'].includes(connType)) {
    return { identQuotes: new Set(['`']) }
  }
  return { identQuotes: new Set(['"']) }
}

function isIdentStart(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z_]/.test(ch)
}

function isIdentPart(ch: string | undefined): boolean {
  return !!ch && /[\w$]/.test(ch)
}

function skipWs(sql: string, pos: number): number {
  while (pos < sql.length && /\s/.test(sql[pos])) pos++
  return pos
}

function skipLineComment(sql: string, pos: number): number {
  const end = sql.indexOf('\n', pos + 2)
  return end < 0 ? sql.length : end + 1
}

function skipBlockComment(sql: string, pos: number): number {
  const end = sql.indexOf('*/', pos + 2)
  return end < 0 ? sql.length : end + 2
}

function skipQuoted(sql: string, pos: number): number {
  const quote = sql[pos] as Quote
  let i = pos + 1
  if (quote === '[') {
    while (i < sql.length) {
      if (sql[i] === ']' && sql[i + 1] === ']') { i += 2; continue }
      if (sql[i] === ']') break
      i++
    }
    return Math.min(i + 1, sql.length)
  }
  while (i < sql.length) {
    if (sql[i] === quote) {
      if ((quote === '\'' || quote === '"' || quote === '`') && sql[i + 1] === quote) { i += 2; continue }
      return i + 1
    }
    i++
  }
  return sql.length
}

function readIdent(sql: string, pos: number, rules: DialectRules): { text: string; end: number } | null {
  pos = skipWs(sql, pos)
  const ch = sql[pos] as Quote | undefined
  if (ch && rules.identQuotes.has(ch)) {
    const end = skipQuoted(sql, pos)
    return { text: stripQuoteIdent(sql.slice(pos, end)), end }
  }
  if (!isIdentStart(ch)) return null
  let end = pos + 1
  while (isIdentPart(sql[end])) end++
  return { text: sql.slice(pos, end), end }
}

function readQualifiedIdent(sql: string, pos: number, rules: DialectRules): { text: string; end: number } | null {
  const parts: string[] = []
  let cur = readIdent(sql, pos, rules)
  if (!cur) return null
  parts.push(cur.text)
  let end = cur.end
  while (true) {
    const dot = skipWs(sql, end)
    if (sql[dot] !== '.') break
    cur = readIdent(sql, dot + 1, rules)
    if (!cur) break
    parts.push(cur.text)
    end = cur.end
  }
  return { text: parts.join('.'), end }
}

function isKeywordAt(sql: string, pos: number, keyword: string): boolean {
  const before = sql[pos - 1]
  const after = sql[pos + keyword.length]
  return sql.slice(pos, pos + keyword.length).toLowerCase() === keyword
    && !isIdentPart(before)
    && !isIdentPart(after)
}

function findMatchingParen(sql: string, open: number): number {
  let depth = 0
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') { i = skipLineComment(sql, i) - 1; continue }
    if (ch === '/' && next === '*') { i = skipBlockComment(sql, i) - 1; continue }
    if (ch === '\'' || ch === '"' || ch === '`' || ch === '[') { i = skipQuoted(sql, i) - 1; continue }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function findTopLevelKeyword(sql: string, keyword: string, start = 0): number {
  let depth = 0
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') { i = skipLineComment(sql, i) - 1; continue }
    if (ch === '/' && next === '*') { i = skipBlockComment(sql, i) - 1; continue }
    if (ch === '\'' || ch === '"' || ch === '`' || ch === '[') { i = skipQuoted(sql, i) - 1; continue }
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue }
    if (depth === 0 && isKeywordAt(sql, i, keyword)) return i
  }
  return -1
}

function splitTopLevelComma(sql: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') { i = skipLineComment(sql, i) - 1; continue }
    if (ch === '/' && next === '*') { i = skipBlockComment(sql, i) - 1; continue }
    if (ch === '\'' || ch === '"' || ch === '`' || ch === '[') { i = skipQuoted(sql, i) - 1; continue }
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue }
    if (ch === ',' && depth === 0) {
      out.push(sql.slice(start, i))
      start = i + 1
    }
  }
  out.push(sql.slice(start))
  return out
}

function stripTrailingOrder(expr: string): string {
  return expr.trim().replace(/\s+(asc|desc)\s*$/i, '').trim()
}

function quotedIdentPattern(rules: DialectRules): string {
  const parts = ['[A-Za-z_]\\w*']
  if (rules.identQuotes.has('`')) parts.push('`(?:``|[^`])+`')
  if (rules.identQuotes.has('"')) parts.push('"(?:\"\"|[^"])+"')
  if (rules.identQuotes.has('[')) parts.push('\\[(?:\\]\\]|[^\\]])+\\]')
  return `(?:${parts.join('|')})`
}

function outputNameOf(expr: string, rules: DialectRules): string | null {
  const s = stripTrailingOrder(expr)
  if (!s || /^\*+$/.test(s) || /\.\s*\*$/.test(s)) return null

  const ident = quotedIdentPattern(rules)
  const asMatch = new RegExp(`\\bas\\s+(${ident})\\s*$`, 'i').exec(s)
  if (asMatch) return stripQuoteIdent(asMatch[1])

  const direct = new RegExp(`^(?:${ident}\\s*\\.\\s*)?(${ident})$`).exec(s)
  if (direct) return stripQuoteIdent(direct[1])

  const tail = new RegExp(`(?:^|[\\s)])(${ident})\\s*$`).exec(s)
  if (!tail) return null
  const alias = stripQuoteIdent(tail[1])
  if (!alias || ALIAS_STOP_WORDS.has(alias.toLowerCase())) return null
  return alias
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

export function extractSelectOutputColumns(sql: string, connType: ConnType | string): string[] {
  const rules = dialectRules(connType)
  const select = findTopLevelKeyword(sql, 'select')
  if (select < 0) return []
  const from = findTopLevelKeyword(sql, 'from', select + 6)
  const selectList = sql.slice(select + 6, from < 0 ? sql.length : from)
  return unique(splitTopLevelComma(selectList).map(expr => outputNameOf(expr, rules)).filter(Boolean) as string[])
}

export function buildSqlCompletionScope(doc: string, connType: ConnType | string): SqlCompletionScope {
  const rules = dialectRules(connType)
  const aliases: Record<string, string> = {}
  const derivedColumns: Record<string, string[]> = {}

  for (let i = 0; i < doc.length; i++) {
    const ch = doc[i]
    const next = doc[i + 1]
    if (ch === '-' && next === '-') { i = skipLineComment(doc, i) - 1; continue }
    if (ch === '/' && next === '*') { i = skipBlockComment(doc, i) - 1; continue }
    if (ch === '\'' || ch === '"' || ch === '`' || ch === '[') { i = skipQuoted(doc, i) - 1; continue }
    if (!isKeywordAt(doc, i, 'from') && !isKeywordAt(doc, i, 'join')) continue

    let pos = skipWs(doc, i + (doc.slice(i, i + 4).toLowerCase() === 'join' ? 4 : 4))
    if (doc[pos] === '(') {
      const close = findMatchingParen(doc, pos)
      if (close < 0) continue
      let aliasPos = skipWs(doc, close + 1)
      if (isKeywordAt(doc, aliasPos, 'as')) aliasPos = skipWs(doc, aliasPos + 2)
      const alias = readIdent(doc, aliasPos, rules)
      if (alias && !ALIAS_STOP_WORDS.has(alias.text.toLowerCase())) {
        const cols = extractSelectOutputColumns(doc.slice(pos + 1, close), connType)
        if (cols.length) derivedColumns[alias.text.toLowerCase()] = cols
      }
      continue
    }

    const tableRef = readQualifiedIdent(doc, pos, rules)
    if (!tableRef) continue
    const table = tableRef.text.split('.').pop() ?? tableRef.text
    if (!table) continue
    aliases[table.toLowerCase()] = table

    let aliasPos = skipWs(doc, tableRef.end)
    if (isKeywordAt(doc, aliasPos, 'as')) aliasPos = skipWs(doc, aliasPos + 2)
    const alias = readIdent(doc, aliasPos, rules)
    if (alias && !ALIAS_STOP_WORDS.has(alias.text.toLowerCase())) {
      aliases[alias.text.toLowerCase()] = table
    }
    i = tableRef.end
  }

  return { aliases, derivedColumns }
}

export function columnsOfTable(dbSchema: Record<string, string[]>, table: string): string[] {
  if (dbSchema[table]?.length) return dbSchema[table]
  const lc = table.toLowerCase()
  for (const k of Object.keys(dbSchema)) if (k.toLowerCase() === lc) return dbSchema[k]
  return []
}

export function memberColumnsForAlias(doc: string, dbSchema: Record<string, string[]>, alias: string, connType: ConnType | string): string[] {
  const scope = buildSqlCompletionScope(doc, connType)
  const key = alias.toLowerCase()
  if (scope.derivedColumns[key]?.length) return scope.derivedColumns[key]
  const table = scope.aliases[key]
  return table ? columnsOfTable(dbSchema, table) : []
}

export function selectOutputColumnsBefore(doc: string, pos: number, connType: ConnType | string): string[] {
  const out: string[] = []
  for (let i = 0; i < pos; i++) {
    const ch = doc[i]
    const next = doc[i + 1]
    if (ch === '-' && next === '-') { i = skipLineComment(doc, i) - 1; continue }
    if (ch === '/' && next === '*') { i = skipBlockComment(doc, i) - 1; continue }
    if (ch === '\'' || ch === '"' || ch === '`' || ch === '[') { i = skipQuoted(doc, i) - 1; continue }
    if (!isKeywordAt(doc, i, 'select')) continue
    const from = findTopLevelKeyword(doc.slice(i), 'from', 6)
    if (from < 0 || i + from >= pos) continue
    out.push(...extractSelectOutputColumns(doc.slice(i, i + from), connType))
  }
  return unique(out)
}

function depthAt(sql: string, pos: number): number {
  let depth = 0
  for (let i = 0; i < pos; i++) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') { i = skipLineComment(sql, i) - 1; continue }
    if (ch === '/' && next === '*') { i = skipBlockComment(sql, i) - 1; continue }
    if (ch === '\'' || ch === '"' || ch === '`' || ch === '[') { i = skipQuoted(sql, i) - 1; continue }
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
  }
  return depth
}

function lastSelectAtDepthBefore(doc: string, pos: number, depth: number): number {
  let curDepth = 0
  let last = -1
  for (let i = 0; i < pos; i++) {
    const ch = doc[i]
    const next = doc[i + 1]
    if (ch === '-' && next === '-') { i = skipLineComment(doc, i) - 1; continue }
    if (ch === '/' && next === '*') { i = skipBlockComment(doc, i) - 1; continue }
    if (ch === '\'' || ch === '"' || ch === '`' || ch === '[') { i = skipQuoted(doc, i) - 1; continue }
    if (ch === '(') { curDepth++; continue }
    if (ch === ')') { curDepth = Math.max(0, curDepth - 1); continue }
    if (curDepth === depth && isKeywordAt(doc, i, 'select')) last = i
  }
  return last
}

function clauseAllowsSelectAlias(doc: string, from: number, to: number): boolean {
  let depth = 0
  let lastClause = ''
  for (let i = from; i < to; i++) {
    const ch = doc[i]
    const next = doc[i + 1]
    if (ch === '-' && next === '-') { i = skipLineComment(doc, i) - 1; continue }
    if (ch === '/' && next === '*') { i = skipBlockComment(doc, i) - 1; continue }
    if (ch === '\'' || ch === '"' || ch === '`' || ch === '[') { i = skipQuoted(doc, i) - 1; continue }
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue }
    if (depth !== 0) continue
    if (isKeywordAt(doc, i, 'having')) lastClause = 'having'
    else if (isKeywordAt(doc, i, 'group')) {
      const byPos = skipWs(doc, i + 5)
      if (isKeywordAt(doc, byPos, 'by')) lastClause = 'group by'
    } else if (isKeywordAt(doc, i, 'order')) {
      const byPos = skipWs(doc, i + 5)
      if (isKeywordAt(doc, byPos, 'by')) lastClause = 'order by'
    } else if (
      isKeywordAt(doc, i, 'from')
      || isKeywordAt(doc, i, 'join')
      || isKeywordAt(doc, i, 'where')
      || isKeywordAt(doc, i, 'on')
      || isKeywordAt(doc, i, 'limit')
      || isKeywordAt(doc, i, 'offset')
    ) {
      lastClause = ''
    }
  }
  return !!lastClause
}

export function selectAliasColumnsBefore(doc: string, pos: number, connType: ConnType | string): string[] {
  const depth = depthAt(doc, pos)
  const select = lastSelectAtDepthBefore(doc, pos, depth)
  if (select < 0) return []
  const fromRel = findTopLevelKeyword(doc.slice(select, pos), 'from', 6)
  if (fromRel < 0) return []
  const from = select + fromRel
  if (!clauseAllowsSelectAlias(doc.slice(select, pos), fromRel, pos - select)) return []
  return extractSelectOutputColumns(doc.slice(select, from), connType)
}
