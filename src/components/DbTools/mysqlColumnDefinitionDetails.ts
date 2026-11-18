function columnAttributeText(definition: string): string {
  let quote = ''; let depth = 0; let out = ''
  for (let i = 0; i < definition.length; i++) {
    const ch = definition[i]
    if (quote) {
      out += ' '
      if (ch === '\\' && quote !== '`' && i + 1 < definition.length) { out += ' '; i++ }
      else if (ch === quote) {
        if (definition[i + 1] === quote) { out += ' '; i++ } else quote = ''
      }
    } else if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ' ' }
    else if (ch === '(') { depth++; out += ' ' }
    else if (ch === ')') { depth--; out += ' ' }
    else out += depth ? ' ' : ch
  }
  return out
}

export function mysqlColumnDefinitionDetails(definition: string): { charset: string | null; collation: string | null } {
  const attributes = columnAttributeText(definition)
  const charset = attributes.match(/\bCHARACTER\s+SET\s+([\w$]+)/i)?.[1] ?? null
  const collation = attributes.match(/\bCOLLATE\s+([\w$]+)/i)?.[1] ?? null
  return { charset, collation }
}

export function mysqlColumnDefinition(rawDdl: string, column: string): string | null {
  const tick = String.fromCharCode(96)
  const prefix = tick + column.split(tick).join(tick + tick) + tick + ' '
  const bodyStart = rawDdl.indexOf('(')
  if (bodyStart < 0) return null
  let start = bodyStart + 1, depth = 0, quote = ''
  for (let i = start; i < rawDdl.length; i++) {
    const ch = rawDdl[i]
    if (quote) {
      if (ch === String.fromCharCode(92) && quote !== tick) i++
      else if (ch === quote) {
        if (rawDdl[i + 1] === quote) i++
        else quote = ''
      }
    } else if (ch === "'" || ch === '"' || ch === tick) quote = ch
    else if (ch === '(') depth++
    else if ((ch === ',' || ch === ')') && depth === 0) {
      const definition = rawDdl.slice(start, i).trim()
      if (definition.startsWith(prefix)) return definition
      if (ch === ')') break
      start = i + 1
    } else if (ch === ')') depth--
  }
  return null
}

export function setMysqlColumnCollation(definition: string, collation: string): string | null {
  const tick = String.fromCharCode(96)
  if (!definition.startsWith(tick) || !definition.includes(tick + ' ')) return null
  const attributes = columnAttributeText(definition)
  const ranges = [...attributes.matchAll(/\b(?:CHARACTER\s+SET|COLLATE)\s+[\w$]+/ig)].reverse()
  let cleaned = definition
  for (const match of ranges) {
    let start = match.index!
    while (start > 0 && /\s/.test(definition[start - 1])) start--
    cleaned = cleaned.slice(0, start) + cleaned.slice(match.index! + match[0].length)
  }
  if (!collation) return cleaned
  if (!/^[\w$]+$/.test(collation)) return null
  return `${cleaned} COLLATE ${collation}`
}

export function setMysqlColumnUnsigned(definition: string, unsigned: boolean): string {
  const attributes = columnAttributeText(definition)
  const match = /\bUNSIGNED\b/i.exec(attributes)
  let out = definition
  if (unsigned && !match) {
    const typeEnd = attributes.search(/\s+(?:ZEROFILL|BINARY|CHARACTER\s+SET|COLLATE|NOT\s+NULL|NULL|DEFAULT|AUTO_INCREMENT|COMMENT|GENERATED|INVISIBLE|VISIBLE)\b/i)
    const insertAt = typeEnd < 0 ? out.length : typeEnd
    out = `${out.slice(0, insertAt).trimEnd()} UNSIGNED${out.slice(insertAt)}`
  } else if (!unsigned && match) {
    let start = match.index!
    while (start > 0 && /\s/.test(out[start - 1])) start--
    out = out.slice(0, start) + out.slice(match.index! + match[0].length)
  }
  return out.trim()
}
