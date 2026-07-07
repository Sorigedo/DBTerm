import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const frontendRoots = [
  'src/components/DbTools',
  'src/components/SqlEditor',
  'src/components/SchemaBrowser',
  'src/components/AssetPanel/DbSchemaTree.tsx',
  'src/components/RedisBrowser',
  'src/components/MongoBrowser',
  'src/stores/dbToolsStore.ts',
]

const dbCommandPrefixes = [
  'db_', 'duckdb_', 'sqlite_', 'mariadb_', 'tidb_', 'ss_', 'pg_',
  'mongo_', 'redis_', 'execute_query', 'list_schemas', 'list_tables',
  'list_ss_', 'table_columns', 'schema_columns', 'update_cell',
  'list_routines', 'list_tables_meta', 'get_table_ddl', 'get_routine_ddl',
  'sqlite_list_objects', 'sqlite_table_flags', 'write_local_',
]

const connTypes = [
  'mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss',
  'sqlite', 'duckdb', 'sqlServer', 'oracle', 'clickHouse', 'redis', 'mongodb',
]

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8')
}

function walk(target) {
  const abs = path.join(root, target)
  if (!fs.existsSync(abs)) return []
  const st = fs.statSync(abs)
  if (st.isFile()) return [target]
  const out = []
  for (const name of fs.readdirSync(abs)) {
    const rel = path.join(target, name)
    const s = fs.statSync(path.join(root, rel))
    if (s.isDirectory()) out.push(...walk(rel))
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(rel)
  }
  return out
}

function lineOf(text, index) {
  return text.slice(0, index).split(/\r?\n/).length
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function isDbCommand(cmd) {
  return dbCommandPrefixes.some((p) => cmd.startsWith(p))
}

function extractFrontendInvokes(files) {
  const calls = []
  const dynamic = []
  const re = /\binvoke(?:<[^>]+>)?\(\s*(['"`])([^'"`]+)\1/g
  const dynamicRe = /\binvoke(?:<[^>]+>)?\(\s*([A-Za-z_$][\w$]*)/g
  for (const file of files) {
    const text = read(file)
    let m
    while ((m = re.exec(text))) {
      calls.push({ command: m[2], file, line: lineOf(text, m.index) })
    }
    while ((m = dynamicRe.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 80), m.index)
      if (before.includes('await ') || before.includes('return ') || before.includes('=')) {
        dynamic.push({ expression: m[1], file, line: lineOf(text, m.index) })
      }
    }
  }
  return {
    calls: calls.filter((c) => isDbCommand(c.command)),
    dynamic,
  }
}

function extractRegisteredCommands() {
  const text = read('src-tauri/src/lib.rs')
  const registered = []
  const re = /(?:commands::(?:[A-Za-z_][\w]*::)+([A-Za-z_][\w]*)|^\s*([A-Za-z_][\w]*),)/gm
  let m
  while ((m = re.exec(text))) {
    const name = m[1] || m[2]
    if (name && isDbCommand(name)) registered.push(name)
  }
  return uniqueSorted(registered)
}

function extractToolCatalog() {
  const file = 'src/components/DbTools/dbToolsCatalog.tsx'
  const text = read(file)
  const tools = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('tool:')) continue
    const tool = /tool:\s*'([^']+)'/.exec(line)?.[1]
    const label = /label:\s*'([^']+)'/.exec(line)?.[1]
    const cat = /cat:\s*'([^']+)'/.exec(line)?.[1]
    const showExpr = /show:\s*(.+?)\s*\},?\s*$/.exec(line)?.[1]
    if (tool && label && cat) {
      tools.push({ tool, label, cat, showExpr: showExpr ?? '', file, line: i + 1 })
    }
  }
  return tools
}

function evalToolShow(expr, connType) {
  const isMysql = ['mysql', 'mariadb', 'tidb', 'oceanBase'].includes(connType)
  const isMysqlNative = ['mysql', 'mariadb'].includes(connType)
  const isPg = ['postgres', 'kingBase', 'openGauss'].includes(connType)
  const isCall = [...expr.matchAll(/is\(([^)]+)\)/g)].map((m) => {
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  }).flat()

  if (expr === 'any') return true
  if (expr === 'isMysql') return isMysql
  if (expr === 'isMysqlNative') return isMysqlNative
  if (expr === 'isPg') return isPg
  if (isCall.length > 0 && !expr.includes('=>')) return isCall.includes(connType)
  if (expr.includes('isMysql(c)') && expr.includes('isPg(c)')) return isMysql || isPg
  if (expr.includes('isMysql(c)')) return isMysql
  if (expr.includes('isPg(c)')) return isPg
  if (isCall.length > 0) return isCall.includes(connType)
  return false
}

function extractSwitchCases(file) {
  const text = read(file)
  const cases = []
  const re = /case\s+'([^']+)'\s*:/g
  let m
  while ((m = re.exec(text))) cases.push(m[1])
  return uniqueSorted(cases)
}

function extractSetEntries(file, exportName) {
  const text = read(file)
  const marker = `export const ${exportName}`
  const start = text.indexOf(marker)
  if (start < 0) return []
  const end = text.indexOf('])', start)
  if (end < 0) return []
  const block = text.slice(start, end)
  return uniqueSorted([...block.matchAll(/'([^']+)'/g)].map((m) => m[1]))
}

function byCommand(calls) {
  const map = new Map()
  for (const call of calls) {
    if (!map.has(call.command)) map.set(call.command, [])
    map.get(call.command).push(call)
  }
  return map
}

const sqlRiskPatterns = [
  { label: '硬编码反引号标识符', re: /\\`[^`]*\$\{|\\`[^`]*(?:schema|table|name|seq|selected)/i },
  { label: '硬编码双引号标识符', re: /"[^"\n]*\$\{(?:schema|table|name|col|alias|.*Table)/i },
  { label: 'MySQL SHOW 语句', re: /\bSHOW\s+(?:FULL|CREATE|COLLATION|CHARACTER|ENGINES|BINLOG|BINARY|GLOBAL|VARIABLES|ENGINE|ALL\s+SLAVES|EXPLAIN)/ },
  { label: 'SQLite/DuckDB PRAGMA', re: /\bPRAGMA\b/ },
  { label: '维护语句', re: /\b(?:OPTIMIZE|ANALYZE|CHECK)\s+TABLE\b|\bVACUUM\b/ },
  { label: '分页语法', re: /\b(?:LIMIT|TOP|FETCH\s+FIRST|OFFSET\s+\S+\s+ROWS\s+FETCH)\b/ },
  { label: '上下文切换', re: /\bUSE\s+|\bsearch_path\b/ },
  { label: 'DDL/DCL 生成', re: /\b(?:CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/ },
  { label: 'DML 生成', re: /\b(?:INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE)\b/ },
]

const sqlNoisePatterns = [
  /^\s*\/\//,
  /^\s*\*/,
  /^\s*\/\*/,
  /className=/,
  /data-tip=/,
  /placeholder=/,
  /title=/,
  /desc:/,
  /label:/,
  /toast\./,
  /window\.confirm/,
  /^\s*style=/,
  /^\s*<[^>]+style=/,
]

function lineTextAround(lines, index, before = 8, after = 8) {
  return lines.slice(Math.max(0, index - before), Math.min(lines.length, index + after + 1)).join('\n')
}

function detectRiskGuard(context) {
  const guards = []
  if (/\bconnType\b/.test(context)) guards.push('connType')
  if (/\bdialectFamily\s*\(/.test(context)) guards.push('dialectFamily')
  if (/\bisMysql|isMy\b|isMysqlFamily\s*\(/.test(context)) guards.push('mysql guard')
  if (/\bisPg|isPgFamily\s*\(/.test(context)) guards.push('pg guard')
  if (/\bisOracle|oracle/.test(context)) guards.push('oracle guard')
  if (/\bsqlServer|mssql/.test(context)) guards.push('mssql guard')
  if (/\bsqlite|isSqlite/.test(context)) guards.push('sqlite guard')
  if (/\bduckdb|isDuckdb/.test(context)) guards.push('duckdb guard')
  if (/\bqid\s*\(/.test(context)) guards.push('qid')
  if (/\btableRef\s*\(|\bdialectTableRef\s*\(|\bpreviewSelect\s*\(|\bbuildIndexSql\s*\(|\bcheckTableSql\s*\(/.test(context)) {
    guards.push('shared dialect helper')
  }
  if (/\bsupports[A-Z]\w*\s*\(/.test(context)) guards.push('capability guard')
  return uniqueSorted(guards)
}

function isLikelySqlLine(line) {
  if (!/[`'"]/.test(line)) return false
  if (!/\b(?:SELECT|SHOW|PRAGMA|VACUUM|ANALYZE|OPTIMIZE|CHECK|USE|SET\s+search_path|CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|GRANT|REVOKE|LIMIT|TOP|FETCH\s+FIRST|OFFSET)\b/.test(line)) {
    return false
  }
  const carrier = /\bsql\s*:|\b(?:const|let|var)\s+\w*sql\w*\s*=|\bsql\s*=|\b(?:return|=>)\s+`|\bq\s*\(`|\binvoke(?:<[^>]+>)?\(|\b(?:lines|stmts|postIdx|clauses)\.push\s*\(|\b(?:fillQuery|openSchemaFill|openAction|onRunSql|execSql|setPendingFill)\s*\(/i
  if (!carrier.test(line)) return false
  return !sqlNoisePatterns.some((re) => re.test(line))
}

function extractSqlRiskCandidates(files) {
  const candidates = []
  for (const file of files.filter((f) => !/\.test\.[tj]sx?$/.test(f))) {
    const text = read(file)
    const lines = text.split(/\r?\n/)
    lines.forEach((line, i) => {
      if (!isLikelySqlLine(line)) return
      const labels = sqlRiskPatterns.filter((p) => p.re.test(line)).map((p) => p.label)
      if (labels.length === 0) return
      const context = lineTextAround(lines, i)
      const guards = detectRiskGuard(context)
      const snippet = line.trim().replace(/\s+/g, ' ').slice(0, 180)
      candidates.push({
        file,
        line: i + 1,
        labels: uniqueSorted(labels),
        guards,
        snippet,
      })
    })
  }
  return candidates.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

function summarizeRisks(candidates) {
  const byLabel = new Map()
  const byGuard = new Map()
  for (const c of candidates) {
    for (const label of c.labels) byLabel.set(label, (byLabel.get(label) ?? 0) + 1)
    const guardKey = c.guards.length ? c.guards.join(', ') : '未检测到明显方言守卫'
    byGuard.set(guardKey, (byGuard.get(guardKey) ?? 0) + 1)
  }
  const rows = (map) => [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => [k, v])
  return { labelRows: rows(byLabel), guardRows: rows(byGuard) }
}

function renderTable(headers, rows) {
  const all = [headers, ...rows]
  const widths = headers.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? '').length)))
  const line = (row) => `| ${row.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join(' | ')} |`
  const sep = `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`
  return [line(headers), sep, ...rows.map(line)].join('\n')
}

function main() {
  const files = uniqueSorted(frontendRoots.flatMap(walk))
  const { calls, dynamic } = extractFrontendInvokes(files)
  const callMap = byCommand(calls)
  const registered = extractRegisteredCommands()
  const registeredSet = new Set(registered)
  const frontendCommands = uniqueSorted([...callMap.keys()])
  const missingRegistered = frontendCommands.filter((cmd) => !registeredSet.has(cmd))
  const unusedRegistered = registered.filter((cmd) => !callMap.has(cmd))

  const catalog = extractToolCatalog()
  const catalogTools = catalog.map((t) => t.tool)
  const dbToolPanelCases = extractSwitchCases('src/components/DbTools/DbToolPanels.tsx')
  const embeddedCases = extractSwitchCases('src/components/DbTools/advancedEmbed.tsx')
  const embeddedSet = extractSetEntries('src/components/DbTools/advancedEmbed.tsx', 'ADV_EMBEDDED')
  const renderedTools = new Set([...dbToolPanelCases, ...embeddedCases])

  const catalogMissingRender = catalog.filter((t) => !renderedTools.has(t.tool))
  const embeddedMissingCase = embeddedSet.filter((tool) => !embeddedCases.includes(tool))
  const embeddedCaseMissingSet = embeddedCases.filter((tool) => tool !== 'default' && !embeddedSet.includes(tool))
  const sqlRisks = extractSqlRiskCandidates(files)
  const sqlRiskSummary = summarizeRisks(sqlRisks)

  const report = []
  report.push('# DB 功能按钮与方言适配静态审计')
  report.push('')
  report.push('> 自动生成：`npm run audit:db-features`。这是静态审计，不替代真实数据库实连测试。')
  report.push('')
  report.push('## 汇总')
  report.push('')
  report.push(renderTable(
    ['项目', '数量'],
    [
      ['扫描前端文件', files.length],
      ['前端 DB invoke 命令', frontendCommands.length],
      ['后端已注册 DB 命令', registered.length],
      ['前端调用但后端未注册', missingRegistered.length],
      ['工具目录项', catalog.length],
      ['目录有但未渲染工具', catalogMissingRender.length],
      ['内嵌集合有但 switch 缺失', embeddedMissingCase.length],
      ['动态 invoke 调用点', dynamic.length],
      ['前端 SQL 方言风险候选', sqlRisks.length],
    ],
  ))
  report.push('')

  report.push('## 前端调用但后端未注册')
  report.push('')
  if (missingRegistered.length === 0) {
    report.push('未发现。')
  } else {
    const rows = missingRegistered.map((cmd) => {
      const first = callMap.get(cmd)?.[0]
      return [cmd, first ? `${first.file}:${first.line}` : '']
    })
    report.push(renderTable(['命令', '首次位置'], rows))
  }
  report.push('')

  report.push('## 工具目录渲染一致性')
  report.push('')
  if (catalogMissingRender.length === 0) {
    report.push('工具目录项均可在 `DbToolPanels` 或 `advancedEmbed` 中找到渲染分支。')
  } else {
    report.push(renderTable(
      ['工具', '标签', '分类', '位置'],
      catalogMissingRender.map((t) => [t.tool, t.label, t.cat, `${t.file}:${t.line}`]),
    ))
  }
  report.push('')

  report.push('## 工具入口方言可见矩阵')
  report.push('')
  report.push('来自 `src/components/DbTools/dbToolsCatalog.tsx`。`✓` 表示该工具会在对应连接类型下显示。')
  report.push('')
  report.push(renderTable(
    ['工具', '分类', ...connTypes],
    catalog.map((t) => [
      `${t.label} (${t.tool})`,
      t.cat,
      ...connTypes.map((c) => evalToolShow(t.showExpr, c) ? '✓' : ''),
    ]),
  ))
  report.push('')

  report.push('## DBA 内嵌工具一致性')
  report.push('')
  if (embeddedMissingCase.length === 0 && embeddedCaseMissingSet.length === 0) {
    report.push('`ADV_EMBEDDED` 与 `renderAdvancedEmbedded` 分支一致。')
  } else {
    if (embeddedMissingCase.length > 0) {
      report.push('### `ADV_EMBEDDED` 有但 switch 缺失')
      report.push('')
      report.push(embeddedMissingCase.map((x) => `- \`${x}\``).join('\n'))
      report.push('')
    }
    if (embeddedCaseMissingSet.length > 0) {
      report.push('### switch 有但 `ADV_EMBEDDED` 未列入')
      report.push('')
      report.push(embeddedCaseMissingSet.map((x) => `- \`${x}\``).join('\n'))
      report.push('')
    }
  }
  report.push('')

  report.push('## 动态 invoke 调用点')
  report.push('')
  report.push('这些调用需要人工或更深 AST 分析确认实际命令名。')
  report.push('')
  if (dynamic.length === 0) {
    report.push('未发现。')
  } else {
    report.push(renderTable(
      ['表达式', '位置'],
      dynamic.map((d) => [d.expression, `${d.file}:${d.line}`]),
    ))
  }
  report.push('')

  report.push('## 前端自拼 SQL 方言风险候选')
  report.push('')
  report.push('这些是静态扫描候选，不直接判定为 bug。若同一行或附近上下文检测到 `qid` / `tableRef` / `connType` / capability guard，通常表示已有方言分支或共享方言层保护。')
  report.push('')
  if (sqlRisks.length === 0) {
    report.push('未发现。')
  } else {
    report.push('### 按风险类型汇总')
    report.push('')
    report.push(renderTable(['类型', '数量'], sqlRiskSummary.labelRows))
    report.push('')
    report.push('### 按守卫/共享方言层汇总')
    report.push('')
    report.push(renderTable(['检测到的守卫', '数量'], sqlRiskSummary.guardRows))
    report.push('')
    report.push('### 候选明细')
    report.push('')
    report.push(renderTable(
      ['位置', '类型', '守卫', '片段'],
      sqlRisks.slice(0, 160).map((r) => [
        `${r.file}:${r.line}`,
        r.labels.join(', '),
        r.guards.join(', ') || '未检测到明显方言守卫',
        `\`${r.snippet.replace(/`/g, '\\`')}\``,
      ]),
    ))
    if (sqlRisks.length > 160) {
      report.push('')
      report.push(`候选较多，仅展示前 160 条；完整扫描数量：${sqlRisks.length}。`)
    }
  }
  report.push('')

  report.push('## 前端 DB 命令清单')
  report.push('')
  report.push(frontendCommands.map((cmd) => `- \`${cmd}\``).join('\n'))
  report.push('')

  report.push('## 后端已注册但本次前端扫描未发现直接调用')
  report.push('')
  report.push('可能由动态调用、非扫描目录、后台流程或未来入口使用；不直接判定为问题。')
  report.push('')
  report.push(unusedRegistered.map((cmd) => `- \`${cmd}\``).join('\n') || '无。')
  report.push('')

  const out = path.join(root, 'docs/db-feature-audit.md')
  fs.writeFileSync(out, `${report.join('\n')}\n`)
  console.log(`Wrote ${path.relative(root, out)}`)

  if (missingRegistered.length > 0 || catalogMissingRender.length > 0 || embeddedMissingCase.length > 0) {
    process.exitCode = 1
  }
}

main()
