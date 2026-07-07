export interface SqlVariable {
  name: string
  from: number
  to: number
}

export type SqlVariableMode = 'literal' | 'raw'

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
    if (ch !== ':') continue
    if (next === ':' || sqlText[i - 1] === ':') continue
    const m = sqlText.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/)
    if (!m) continue
    const name = m[0]
    vars.push({ name, from: i, to: i + 1 + name.length })
    i += name.length
  }
  return vars
}

function sqlLiteral(value: string, mode: SqlVariableMode = 'literal'): string {
  if (mode === 'raw') return value.trim() || 'NULL'
  if (/^null$/i.test(value.trim())) return 'NULL'
  return `'${value.replace(/'/g, "''")}'`
}

export function applySqlVariables(
  sqlText: string,
  variables: SqlVariable[],
  values: Record<string, string>,
  modes: Record<string, SqlVariableMode> = {},
): string {
  let out = ''
  let pos = 0
  for (const v of variables) {
    out += sqlText.slice(pos, v.from)
    out += sqlLiteral(values[v.name] ?? '', modes[v.name] ?? 'literal')
    pos = v.to
  }
  out += sqlText.slice(pos)
  return out
}
