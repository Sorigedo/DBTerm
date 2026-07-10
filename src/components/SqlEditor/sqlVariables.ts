export interface SqlVariable {
  name: string
  from: number
  to: number
}

export type SqlVariableMode = 'literal' | 'date' | 'raw'

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*/

function matchNamedVariable(sqlText: string, pos: number): SqlVariable | null {
  const ch = sqlText[pos]
  const next = sqlText[pos + 1]
  if (ch === ':') {
    if (next === ':' || sqlText[pos - 1] === ':') return null
    const m = sqlText.slice(pos + 1).match(NAME_RE)
    if (!m) return null
    const name = m[0]
    return { name, from: pos, to: pos + 1 + name.length }
  }
  if ((ch === '#' || ch === '$' || ch === '@' || ch === '?') && next === '{') {
    const close = sqlText.indexOf('}', pos + 2)
    if (close < 0) return null
    const name = sqlText.slice(pos + 2, close).trim()
    if (!NAME_RE.test(name) || name.length !== name.match(NAME_RE)?.[0].length) return null
    return { name, from: pos, to: close + 1 }
  }
  if (ch === '{' && next === '{') {
    const close = sqlText.indexOf('}}', pos + 2)
    if (close < 0) return null
    const name = sqlText.slice(pos + 2, close).trim()
    if (!NAME_RE.test(name) || name.length !== name.match(NAME_RE)?.[0].length) return null
    return { name, from: pos, to: close + 2 }
  }
  return null
}

export function findSqlVariables(sqlText: string): SqlVariable[] {
  const vars: SqlVariable[] = []
  let quote: "'" | '"' | '`' | '[' | null = null
  let lineComment = false
  let blockComment = false
  for (let i = 0; i < sqlText.length; i++) {
    const ch = sqlText[i]
    const next = sqlText[i + 1]
    if (lineComment) {
      if (ch === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i++ }
      continue
    }
    if (quote) {
      if (quote === '[') {
        if (ch === ']') quote = null
        continue
      }
      if (ch === quote) {
        if ((quote === '\'' || quote === '"') && next === quote) { i++; continue }
        quote = null
      }
      continue
    }
    if (ch === '-' && next === '-') { lineComment = true; i++; continue }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue }
    if (ch === '\'') { quote = '\''; continue }
    if (ch === '"') { quote = '"'; continue }
    if (ch === '`') { quote = '`'; continue }
    if (ch === '[') { quote = '['; continue }
    const variable = matchNamedVariable(sqlText, i)
    if (!variable) continue
    vars.push(variable)
    i = variable.to - 1
  }
  return vars
}

function escapedSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function sqlDateLiteral(value: string, connType?: string): string {
  const text = value.trim()
  if (/^null$/i.test(text)) return 'NULL'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return escapedSqlString(value)
  const literal = escapedSqlString(text)
  switch (connType) {
    case 'sqlServer':
      return `CONVERT(date, ${literal}, 23)`
    case 'oracle':
      return `DATE ${literal}`
    case 'clickHouse':
      return `toDate(${literal})`
    case 'sqlite':
      return `date(${literal})`
    case 'postgres':
    case 'kingBase':
    case 'openGauss':
    case 'duckdb':
      return `DATE ${literal}`
    case 'mysql':
    case 'mariadb':
    case 'tidb':
    case 'oceanBase':
      return literal
    default:
      return literal
  }
}

function sqlLiteral(value: string, mode: SqlVariableMode = 'literal', connType?: string): string {
  if (mode === 'raw') return value.trim() || 'NULL'
  if (mode === 'date') return sqlDateLiteral(value, connType)
  if (/^null$/i.test(value.trim())) return 'NULL'
  return escapedSqlString(value)
}

export function inferSqlVariableMode(name: string): SqlVariableMode {
  const n = name.toLowerCase()
  return n.includes('date') || n.endsWith('day') || n.endsWith('time') || n.endsWith('dt') ? 'date' : 'literal'
}

export function applySqlVariables(
  sqlText: string,
  variables: SqlVariable[],
  values: Record<string, string>,
  modes: Record<string, SqlVariableMode> = {},
  connType?: string,
): string {
  let out = ''
  let pos = 0
  for (const v of variables) {
    out += sqlText.slice(pos, v.from)
    out += sqlLiteral(values[v.name] ?? '', modes[v.name] ?? 'literal', connType)
    pos = v.to
  }
  out += sqlText.slice(pos)
  return out
}
