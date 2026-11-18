function tableDefinitionClauses(ddl: string): string[] {
  const open = ddl.indexOf('(')
  if (open < 0) return []

  const clauses: string[] = []
  let start = open + 1
  let depth = 0
  let quote = ''
  for (let i = start; i < ddl.length; i++) {
    const ch = ddl[i]
    if (quote) {
      if (ch === '\\' && quote !== '`') i++
      else if (ch === quote) {
        if (ddl[i + 1] === quote) i++
        else quote = ''
      }
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') {
      if (depth === 0) {
        clauses.push(ddl.slice(start, i).trim())
        break
      }
      depth--
    } else if (ch === ',' && depth === 0) {
      clauses.push(ddl.slice(start, i).trim())
      start = i + 1
    }
  }
  return clauses
}

function unquoteIdentifier(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('`') && trimmed.endsWith('`')) return trimmed.slice(1, -1).replace(/``/g, '`')
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replace(/""/g, '"')
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1).replace(/\]\]/g, ']')
  return trimmed
}

export function mysqlDdlIndexOrder(ddl: string): string[] {
  const order: string[] = []
  for (const clause of tableDefinitionClauses(ddl)) {
    if (/^PRIMARY\s+KEY\b/i.test(clause)) {
      order.push('PRIMARY')
      continue
    }
    const match = clause.match(/^(?:(?:UNIQUE|FULLTEXT|SPATIAL)\s+)?(?:KEY|INDEX)\s+(`(?:``|[^`])+`|"(?:""|[^"])+"|\[[^\]]+(?:\]\][^\]]*)*\]|[^\s(]+)/i)
    if (match) order.push(unquoteIdentifier(match[1]))
  }
  return order
}
