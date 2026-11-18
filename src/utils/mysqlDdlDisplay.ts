/** Normalize MySQL DDL only for on-screen previews; never use this for execution or migration. */
export function normalizeMysqlDdlForDisplay(ddl: string): string {
  if (!/\bENGINE\s*=\s*InnoDB\b/i.test(ddl)) return ddl

  return ddl.split(/\r?\n/).map(line => {
    if (!/^\s*(?:PRIMARY\s+KEY|UNIQUE\s+(?:KEY|INDEX)|(?:KEY|INDEX))\b/i.test(line)) return line
    if (/\bUSING\s+/i.test(line)) return line

    const open = line.indexOf('(')
    if (open < 0) return line
    let depth = 0
    let inBacktick = false
    for (let i = open; i < line.length; i += 1) {
      const ch = line[i]
      if (ch === '`') {
        if (inBacktick && line[i + 1] === '`') { i += 1; continue }
        inBacktick = !inBacktick
      } else if (!inBacktick && ch === '(') depth += 1
      else if (!inBacktick && ch === ')') {
        depth -= 1
        if (depth === 0) return `${line.slice(0, i + 1)} USING BTREE${line.slice(i + 1)}`
      }
    }
    return line
  }).join('\n')
}
