export interface ReportColumn {
  name: string
  dataType: string
  nullable: boolean
  key: string
  defaultValue: string | null
}

export interface ReportColumnChange {
  name: string
  before: ReportColumn
  after: ReportColumn
  beforeDefinition?: string | null
  afterDefinition?: string | null
}

export interface ReportTableDiff {
  table: string
  targetTable?: string
  added: ReportColumn[]
  removed: ReportColumn[]
  modified: ReportColumnChange[]
  tableOptions?: { kind: string; source: string; target: string } | null
}

export interface StructureDiffReportData {
  mode: 'table' | 'schema'
  source: string
  target: string
  alterSql: string
  databaseDefinition?: { identical: boolean; sourceDdl: string; targetDdl: string }
  missingTables?: string[]
  extraTables?: string[]
  changedTables?: ReportTableDiff[]
  uncomparableTables?: { table: string; reason: string }[]
  tableDiff?: ReportTableDiff
}

const columnText = (c: ReportColumn) => `${c.name} ${c.dataType}${c.nullable ? ' NULL' : ' NOT NULL'}${c.key ? ` [${c.key}]` : ''}${c.defaultValue !== null ? ` DEFAULT ${c.defaultValue}` : ''}`

export function explainIndexDifference(source: string, target: string, targetTable = '目标表'): string[] {
  type IndexDef = { name: string; type: string; columns: string; raw: string; sql?: string }
  const parse = (text: string): IndexDef[] | null => {
    const result: IndexDef[] = []
    const normalized = text.replace(/^\s*(?:\[索引和约束\]|【索引和约束】)\s*/i, '').trim()
    const definitions: string[] = []
    let start = 0, depth = 0, quoted = false
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized[i]
      if (char === '`' && normalized[i - 1] !== '\\') quoted = !quoted
      else if (!quoted && char === '(') depth++
      else if (!quoted && char === ')') depth--
      else if (!quoted && depth === 0 && char === ',') { definitions.push(normalized.slice(start, i).trim()); start = i + 1 }
    }
    if (normalized.slice(start).trim()) definitions.push(normalized.slice(start).trim())
    for (const line of definitions.flatMap(value => value.split(/\r?\n/)).map(value => value.trim()).filter(Boolean)) {
      const match = line.match(/^(PRIMARY\s+KEY|(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX))\s*(?:`([^`]+)`|"([^"]+)"|([^\s(]+))?\s*\(/i)
      if (!match) return null
      const type = match[1].replace(/\s+/g, ' ').toUpperCase()
      const name = type === 'PRIMARY KEY' ? 'PRIMARY' : (match[2] ?? match[3] ?? match[4] ?? '').trim()
      if (!name) return null
      const open = line.indexOf('(')
      let depth = 1, quoted = false, close = -1
      for (let i = open + 1; i < line.length; i++) {
        const char = line[i]
        if (char === '`' && line[i - 1] !== '\\') quoted = !quoted
        else if (!quoted && char === '(') depth++
        else if (!quoted && char === ')' && --depth === 0) { close = i; break }
      }
      if (close < 0) return null
      const columnSql = line.slice(open + 1, close).trim()
      const columns = columnSql.split(',').map(part => part.trim().replace(/^`([^`]+)`$/, '$1')).join(', ')
      const simpleColumns = columnSql.split(',').every(part => /^\s*`[A-Za-z0-9_$]+`\s*(?:ASC|DESC)?\s*$/i.test(part) || /^\s*[A-Za-z0-9_$]+\s*(?:ASC|DESC)?\s*$/i.test(part))
      const kind = type.startsWith('UNIQUE') ? 'UNIQUE INDEX' : type.startsWith('FULLTEXT') ? 'FULLTEXT INDEX' : type.startsWith('SPATIAL') ? 'SPATIAL INDEX' : 'INDEX'
      const sql = type !== 'PRIMARY KEY' && simpleColumns ? `ADD ${kind} \`${name.replace(/`/g, '``')}\` (${columnSql})` : undefined
      result.push({ name, type, columns, raw: line.replace(/\s+/g, ' ').trim(), sql })
    }
    return result
  }
  const before = parse(source)
  const after = parse(target)
  if (!before || !after) return ['索引定义无法自动解析，请检查两端的原始定义。', `源端：${source || '（无）'}`, `目标：${target || '（无）'}`]
  const beforeMap = new Map(before.map(index => [index.name, index]))
  const afterMap = new Map(after.map(index => [index.name, index]))
  const lines: string[] = ['目标表需要按源端调整以下索引：']
  const tableSql = `\`${targetTable.replace(/`/g, '``')}\``
  const dropSql = (name: string) => `ALTER TABLE ${tableSql} DROP INDEX \`${name.replace(/`/g, '``')}\`;`
  const addSql = (index: IndexDef) => index.sql ? `ALTER TABLE ${tableSql} ${index.sql};` : ''
  for (const index of before) {
    const other = afterMap.get(index.name)
    if (!other) {
      lines.push(`- 目标表需要新增索引 \`${index.name}\`（源端有，目标端缺少；包含：${index.columns}）`)
      const sql = addSql(index)
      if (sql) lines.push(sql)
      else lines.push('  该索引包含表达式或特殊定义，未自动拼 SQL；请按源端完整定义手动添加。')
    } else if (other.type !== index.type || other.columns !== index.columns) {
      lines.push(`- 目标表索引 \`${index.name}\` 需要替换：当前为 ${other.type}（${other.columns}），应改为源端的 ${index.type}（${index.columns}）`, dropSql(index.name))
      const sql = addSql(index)
      if (sql) lines.push(sql)
      else lines.push('  该索引包含表达式或特殊定义，未自动拼 SQL；请按源端完整定义手动修改。')
    }
  }
  for (const index of after) if (!beforeMap.has(index.name)) {
    lines.push(`- 目标表需要删除索引 \`${index.name}\`（源端没有；目标端多余，当前包含：${index.columns}）`, dropSql(index.name))
  }
  return lines.length === 1 ? ['索引相同'] : lines
}

export function formatStructureDiffReport(data: StructureDiffReportData, format: 'md' | 'txt' | 'json' | 'csv' | 'doc'): string {
  if (format === 'json') return JSON.stringify(data, null, 2)
  const tables = data.changedTables ?? (data.tableDiff ? [data.tableDiff] : [])
  if (format === 'csv') {
    const rows = [['类型', '表', '字段', '目标定义', '源定义']]
    for (const table of tables) {
      for (const c of table.added) rows.push(['新增字段', table.table, c.name, '', columnText(c)])
      for (const c of table.removed) rows.push(['删除字段', table.table, c.name, columnText(c), ''])
      for (const c of table.modified) rows.push(['修改字段', table.table, c.name, c.beforeDefinition ?? columnText(c.before), c.afterDefinition ?? columnText(c.after)])
      if (table.tableOptions) {
        if (table.tableOptions.kind === '索引和约束') rows.push(['表级差异', table.table, '', explainIndexDifference(table.tableOptions.source, table.tableOptions.target, table.targetTable ?? table.table).join('；'), ''])
        else rows.push(['表级差异', table.table, '', table.tableOptions.target, table.tableOptions.source])
      }
    }
    for (const t of data.missingTables ?? []) rows.push(['目标缺表', t, '', '', ''])
    for (const t of data.extraTables ?? []) rows.push(['目标多表', t, '', '', ''])
    for (const t of data.uncomparableTables ?? []) rows.push(['无法比对', t.table, '', t.reason, ''])
    return rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n'
  }
  const lines: string[] = [format === 'md' ? '# 数据库结构对比报告' : '数据库结构对比报告', '', `- 源：${data.source}`, `- 目标：${data.target}`, '']
  if (data.databaseDefinition && !data.databaseDefinition.identical) {
    lines.push(format === 'md' ? '## 数据库默认定义差异' : '【数据库默认定义差异】', '', '源库：', data.databaseDefinition.sourceDdl, '', '目标库：', data.databaseDefinition.targetDdl, '')
  }
  if ((data.missingTables ?? []).length) lines.push(format === 'md' ? '## 目标缺少的表' : '【目标缺少的表】', ...(data.missingTables ?? []).map(t => `- ${t}`), '')
  if ((data.extraTables ?? []).length) lines.push(format === 'md' ? '## 目标多出的表' : '【目标多出的表】', ...(data.extraTables ?? []).map(t => `- ${t}`), '')
  for (const table of tables) {
    lines.push(format === 'md' ? `## 表：${table.table}` : `【表：${table.table}】`)
    if (table.tableOptions) {
      lines.push(`表级差异：${table.tableOptions.kind}`)
      if (table.tableOptions.kind === '索引和约束') lines.push(...explainIndexDifference(table.tableOptions.source, table.tableOptions.target, table.targetTable ?? table.table).map(line => `- ${line}`))
      else lines.push(`源：${table.tableOptions.source}`, `目标：${table.tableOptions.target}`)
    }
    for (const c of table.added) lines.push(`新增字段：${columnText(c)}`)
    for (const c of table.removed) lines.push(`删除字段：${columnText(c)}`)
    for (const c of table.modified) lines.push(`修改字段：${c.name}`, `  目标：${c.beforeDefinition ?? columnText(c.before)}`, `  源：${c.afterDefinition ?? columnText(c.after)}`)
    lines.push('')
  }
  for (const issue of data.uncomparableTables ?? []) lines.push(`无法完整比对：${issue.table}；${issue.reason}`)
  if (data.alterSql) lines.push(format === 'md' ? '## ALTER TABLE' : '【ALTER TABLE】', data.alterSql, '')
  const body = lines.join('\n')
  if (format === 'doc') return `<html><head><meta charset="utf-8"></head><body><pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre></body></html>`
  return body
}
