import { useState, useEffect, useCallback } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { X, Layers, Copy, Check, CheckCircle2, AlertTriangle, ChevronDown, ChevronRight, Download, Minus, Maximize2 } from 'lucide-react'
import SearchableSelect from './SearchableSelect'
import { useAppStore } from '../../stores/appStore'
import { structureDiffSelectionKey, isCurrentStructureDiff, currentStructureDiffResult } from './structureDiffSafety'
import { useRef } from 'react'
import { mysqlColumnDefinitionDetails } from './mysqlColumnDefinitionDetails'
import { explainIndexDifference, formatStructureDiffReport, type StructureDiffReportData, type ReportTableDiff } from './structureDiffReport'

const sdCard: CSSProperties = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }
const sdLabel: CSSProperties = { fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }
const SYSTEM_SCHEMAS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys', 'pg_catalog', 'pg_toast'])
function pickDefaultSchema(schemas: string[]): string {
  return schemas.find(s => !SYSTEM_SCHEMAS.has(s.toLowerCase())) ?? schemas[0] ?? ''
}

interface Props {
  connectionId: string
  schema: string
  table: string
  onClose: () => void
}

interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  key: string
  defaultValue: string | null
}

interface ColumnChange {
  name: string
  before: ColumnInfo
  after: ColumnInfo
  beforeDefinition?: string | null
  afterDefinition?: string | null
}

interface StructureDiff {
  added: ColumnInfo[]
  removed: ColumnInfo[]
  modified: ColumnChange[]
  alterSql: string
  dangerDrops: string[]
  tableOptions?: { kind: string; source: string; target: string } | null
  alterBlockReason?: string | null
}

interface TableInfo {
  name: string
  isView: boolean
}

interface SchemaTableDiff {
  table: string
  diff: StructureDiff
}
interface SchemaTableIssue {
  table: string
  reason: string
}

interface SchemaDiff {
  databaseDefinition: { identical: boolean; sourceDdl: string; targetDdl: string }
  missingTables: string[]
  extraTables: string[]
  changedTables: SchemaTableDiff[]
  uncomparableTables: SchemaTableIssue[]
  comparedTables: number
  comparisonScope: string
  alterSql: string
  dangerDrops: string[]
}

function ColBadge({ col }: { col: ColumnInfo }) {
  return (
    <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontWeight: 600, color: 'var(--text-bright)' }}>{col.name}</span>
      <span style={{ fontSize: 11, color: 'var(--accent)', background: 'var(--accent-bg)', borderRadius: 4, padding: '1px 5px' }}>
        {col.dataType}
      </span>
      {col.nullable && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>NULL</span>}
      {col.key && <span style={{ fontSize: 11, color: 'var(--warning)', background: 'rgba(234,88,12,0.1)', borderRadius: 4, padding: '1px 5px' }}>{col.key}</span>}
      {col.defaultValue !== null && (
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>默认: {col.defaultValue}</span>
      )}
    </span>
  )
}

function ColumnDefinitionDetails({ definition }: { definition?: string | null }) {
  if (!definition) return null
  const { charset, collation } = mysqlColumnDefinitionDetails(definition)
  if (!charset && !collation) return null
  return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
    {charset && <>字符集: {charset}{collation ? ' · ' : ''}</>}{collation && <>排序规则: {collation}</>}
  </span>
}

export default function StructureDiffPanel({ connectionId, schema, table, onClose }: Props) {
  const connections = useAppStore(s => s.connections)
  const dbConns = connections.filter(c => c.type !== 'ssh')
  const [mode, setMode] = useState<'table' | 'schema'>(table ? 'table' : 'schema')

  // 源表 (src)
  const [srcConnId, setSrcConnId] = useState(connectionId)
  const [srcSchema, setSrcSchema] = useState(schema)
  const [srcSchemas, setSrcSchemas] = useState<string[]>([])
  const [srcTable, setSrcTable] = useState(table)
  const [srcTables, setSrcTables] = useState<TableInfo[]>([])
  const [srcLoadingTables, setSrcLoadingTables] = useState(false)

  // 目标表 (dst)
  const [dstConnId, setDstConnId] = useState(connectionId)
  const [dstSchema, setDstSchema] = useState(schema)
  const [dstSchemas, setDstSchemas] = useState<string[]>([])
  const [dstTable, setDstTable] = useState('')
  const [dstTables, setDstTables] = useState<TableInfo[]>([])
  const [dstLoadingTables, setDstLoadingTables] = useState(false)

  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [diff, setDiff] = useState<StructureDiff | null>(null)
  const [schemaDiff, setSchemaDiff] = useState<SchemaDiff | null>(null)
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState(false)
  const [execResult, setExecResult] = useState<string>('')
  const [reportFormat, setReportFormat] = useState<'md' | 'txt' | 'json' | 'csv' | 'doc'>('md')
  const [reportError, setReportError] = useState('')
  const [minimized, setMinimized] = useState(false)
  const selectionKey = structureDiffSelectionKey([mode, srcConnId, srcSchema, srcTable, dstConnId, dstSchema, dstTable])
  const selectionRef = useRef(selectionKey)
  const requestRef = useRef(0)
  selectionRef.current = selectionKey
  const [resultKey, setResultKey] = useState<string | null>(null)
  useEffect(() => {
    setDiff(null); setSchemaDiff(null); setResultKey(null); setError(''); setExecResult('')
  }, [selectionKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !minimized) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, minimized])

  // 加载源 / 目标 schema 列表（连接变化时），默认选第一个非系统库
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<string[]>('list_schemas', { id: srcConnId })
        if (!alive) return
        setSrcSchemas(list)
        setSrcSchema(prev => (list.includes(prev) ? prev : pickDefaultSchema(list)))
      } catch { if (alive) setSrcSchemas([]) }
    })()
    return () => { alive = false }
  }, [srcConnId])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<string[]>('list_schemas', { id: dstConnId })
        if (!alive) return
        setDstSchemas(list)
        setDstSchema(prev => (list.includes(prev) ? prev : pickDefaultSchema(list)))
      } catch { if (alive) setDstSchemas([]) }
    })()
    return () => { alive = false }
  }, [dstConnId])

  // 加载源端表列表
  useEffect(() => {
    setSrcTables([])
    if (!srcConnId || !srcSchema) { setSrcLoadingTables(false); return }
    let alive = true
    setSrcLoadingTables(true)
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<TableInfo[]>('list_tables', { id: srcConnId, schema: srcSchema })
        if (alive) { setSrcTables(list); setSrcTable(prev => list.some(item => item.name === prev && !item.isView) ? prev : '') }
      } catch { if (alive) { setSrcTables([]); setSrcTable('') } } finally {
        if (alive) setSrcLoadingTables(false)
      }
    })()
    return () => { alive = false }
  }, [srcConnId, srcSchema])

  // 加载目标端表列表
  useEffect(() => {
    setDstTables([])
    if (!dstConnId || !dstSchema) { setDstLoadingTables(false); return }
    let alive = true
    setDstLoadingTables(true)
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<TableInfo[]>('list_tables', { id: dstConnId, schema: dstSchema })
        if (alive) { setDstTables(list); setDstTable(prev => list.some(item => item.name === prev && !item.isView) ? prev : '') }
      } catch { if (alive) { setDstTables([]); setDstTable('') } } finally {
        if (alive) setDstLoadingTables(false)
      }
    })()
    return () => { alive = false }
  }, [dstConnId, dstSchema])

  const runDiff = useCallback(async () => {
    const requestedKey = selectionKey
    const requestId = ++requestRef.current
    if (!srcSchema || !dstSchema) { setError('请选择源 Schema 和目标 Schema'); return }
    if (mode === 'table' && (!srcTable || !dstTable)) { setError('请选择源表和目标表'); return }
    setRunning(true)
    setError('')
    setDiff(null)
    setSchemaDiff(null)
    setExpandedTables(new Set())
    setExecResult('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      if (mode === 'table') {
        const result = await invoke<StructureDiff>('db_diff_structure', {
          srcId: srcConnId, srcSchema, srcTable, dstId: dstConnId, dstSchema, dstTable,
        })
        if (selectionRef.current !== requestedKey || requestRef.current !== requestId) return
        setDiff(result); setResultKey(requestedKey)
      } else {
        const result = await invoke<SchemaDiff>('db_diff_schema_snapshot', {
          srcId: srcConnId, srcSchema, dstId: dstConnId, dstSchema,
        })
        if (selectionRef.current !== requestedKey || requestRef.current !== requestId) return
        setResultKey(requestedKey)
        setSchemaDiff(result)
      }
    } catch (e) {
      if (selectionRef.current === requestedKey && requestRef.current === requestId) setError(String(e))
    } finally {
      if (requestRef.current === requestId) setRunning(false)
    }
  }, [mode, srcConnId, srcSchema, srcTable, srcTables, dstConnId, dstSchema, dstTable, dstTables, selectionKey])

  const currentSelection = [mode, srcConnId, srcSchema, srcTable, dstConnId, dstSchema, dstTable]
  const currentDiff = currentStructureDiffResult(resultKey, currentSelection, diff)
  const currentSchemaDiff = currentStructureDiffResult(resultKey, currentSelection, schemaDiff)
  const alterSql = mode === 'schema' ? currentSchemaDiff?.alterSql ?? '' : currentDiff?.alterSql ?? ''
  const dangerDrops = mode === 'schema' ? currentSchemaDiff?.dangerDrops ?? [] : currentDiff?.dangerDrops ?? []

  const copySql = () => {
    if (!alterSql || !isCurrentStructureDiff(resultKey, [mode, srcConnId, srcSchema, srcTable, dstConnId, dstSchema, dstTable])) return
    navigator.clipboard.writeText(alterSql).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const hasDiff = currentDiff && (currentDiff.added.length + currentDiff.removed.length + currentDiff.modified.length > 0 || !!currentDiff.tableOptions)
  const hasSchemaDiff = currentSchemaDiff && (!currentSchemaDiff.databaseDefinition.identical || (currentSchemaDiff.missingTables.length + currentSchemaDiff.extraTables.length + currentSchemaDiff.changedTables.length + currentSchemaDiff.uncomparableTables.length) > 0)
  const hasDangerDrop = dangerDrops.length > 0

  const asReportTable = (table: string, item: StructureDiff, targetTable = table): ReportTableDiff => ({
    table, targetTable, added: item.added, removed: item.removed, modified: item.modified, tableOptions: item.tableOptions,
  })
  const reportData = (): StructureDiffReportData | null => {
    if (mode === 'table' && currentDiff) return {
      mode, source: `${srcSchema}.${srcTable}`, target: `${dstSchema}.${dstTable}`, alterSql,
      tableDiff: asReportTable(srcTable, currentDiff, dstTable),
    }
    if (mode === 'schema' && currentSchemaDiff) return {
      mode, source: srcSchema, target: dstSchema, alterSql,
      databaseDefinition: currentSchemaDiff.databaseDefinition,
      missingTables: currentSchemaDiff.missingTables, extraTables: currentSchemaDiff.extraTables,
      changedTables: currentSchemaDiff.changedTables.map(item => asReportTable(item.table, item.diff, item.table)),
      uncomparableTables: currentSchemaDiff.uncomparableTables,
    }
    return null
  }
  const downloadReport = async () => {
    const data = reportData()
    if (!data) return
    setReportError('')
    const ext = reportFormat === 'doc' ? 'doc' : reportFormat
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const path = await save({ title: '下载结构对比报告', defaultPath: `dbterm-structure-diff.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
      if (!path) return
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('write_local_file', { path, content: formatStructureDiffReport(data, reportFormat) })
    } catch (e) { setReportError(`报告下载失败：${e}`) }
  }
  const reportExport = (dataAvailable: boolean) => dataAvailable && <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', padding: '8px 10px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8 }}>
    <Download size={13} color="var(--accent)" />
    <span style={{ fontSize: 12, color: 'var(--text-bright)', fontWeight: 600 }}>下载全部差异</span>
    <select value={reportFormat} onChange={e => setReportFormat(e.target.value as typeof reportFormat)} style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 7px', fontSize: 11 }}>
      <option value="md">Markdown</option><option value="txt">TXT</option><option value="json">JSON</option><option value="csv">CSV</option><option value="doc">Word（.doc）</option>
    </select>
    <button onClick={downloadReport} style={{ background: 'var(--accent)', color: '#fff', border: 0, borderRadius: 6, padding: '5px 10px', fontSize: 11, fontWeight: 600 }}>下载</button>
    {reportError && <span style={{ color: 'var(--error)', fontSize: 11 }}>{reportError}</span>}
  </div>

  function ConnSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    return (
      <SearchableSelect value={value} onChange={onChange} mono={false} searchPlaceholder="搜索连接…"
        items={dbConns.map(c => ({ value: c.id, label: c.name || c.host || c.id }))} />
    )
  }

  function TableSelect({ value, onChange, tables, loading }: { value: string; onChange: (v: string) => void; tables: TableInfo[]; loading: boolean }) {
    return (
      <SearchableSelect value={value} onChange={onChange} disabled={loading}
        options={tables.filter(t => !t.isView).map(t => t.name)} placeholder="选择表" searchPlaceholder="搜索表名…" />
    )
  }

  function renderSqlSection() {
    return (
      <section>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          生成的 ALTER SQL（仅供核对，需在 SQL 编辑器确认目标后逐表执行）
          {hasDangerDrop && <span style={{ fontSize: 11, color: 'var(--error)', display: 'flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={11} /> 包含高危 DROP COLUMN，执行前请备份</span>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>DDL 不能保证整批事务回滚；仅提供原文定义生成的 SQL，请确认目标并逐表审阅执行。</div>
        <div style={{ background: 'var(--bg)', border: `1px solid ${hasDangerDrop ? 'rgba(220,38,38,0.4)' : 'var(--border)'}`, borderRadius: 8, padding: 12, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflow: 'auto' }}>
          {alterSql}
        </div>
        {execResult && <div style={{ marginTop: 8, fontSize: 12, padding: '6px 10px', borderRadius: 6, background: execResult.startsWith('执行成功') ? 'rgba(22,163,74,0.1)' : 'var(--error-bg)', color: execResult.startsWith('执行成功') ? '#16a34a' : 'var(--error)' }}>{execResult}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button onClick={copySql} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: copied ? '#16a34a' : 'var(--text-muted)', padding: '5px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
            {copied ? <Check size={12} /> : <Copy size={12} />}{copied ? '已复制' : '复制 SQL'}
          </button>

        </div>
      </section>
    )
  }

  return createPortal(
    <>
      {minimized ? <button onClick={() => setMinimized(false)} style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 100001, display: 'flex', alignItems: 'center', gap: 8, padding: '11px 16px', borderRadius: 10, color: 'var(--text-bright)', background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,.2)', cursor: 'pointer' }}><Maximize2 size={14} />恢复结构对比</button> : <div className="cdlg-overlay">
        <div
          className="cdlg-box"
          onMouseDown={e => e.stopPropagation()}
          style={{
            width: 700,
            maxHeight: '88vh',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 14,
            overflow: 'hidden',
          }}
        >
          {/* 标题栏 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <Layers size={15} color="var(--accent)" />
            <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>结构对比</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>支持跨连接</span>
            <button onClick={() => setMinimized(true)} title="收起到右下角，稍后可恢复" style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><Minus size={15} /></button>
            <button onClick={onClose} title="关闭" style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>

          {/* 配置区 */}
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: 3, borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)', alignSelf: 'flex-start' }}>
              {(['table', 'schema'] as const).map(value => (
                <button key={value} onClick={() => { setMode(value); setDiff(null); setSchemaDiff(null); setError(''); setExecResult('') }}
                  style={{ padding: '5px 12px', borderRadius: 6, fontSize: 12, color: mode === value ? 'var(--text-bright)' : 'var(--text-muted)', background: mode === value ? 'var(--surface)' : 'transparent', border: mode === value ? '1px solid var(--border)' : '1px solid transparent' }}>
                  {value === 'table' ? '单表对比' : '整个 Schema'}
                </button>
              ))}
            </div>
            {mode === 'schema' && <div style={sdLabel}>核验库默认定义与当前账号可见的普通表；不含视图、存储程序、事件及权限。读取期间持有已捕获表的结构锁并复查表清单，不能阻止其他会话新建表；请暂停 DDL 后比对。结果仅反映本次读取。</div>}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 12, alignItems: 'center' }}>
              {/* 源（基准） */}
              <div style={sdCard}>
                <div style={sdLabel}>{mode === 'table' ? '源表（基准）' : '源 Schema（基准）'}</div>
                <ConnSelect value={srcConnId} onChange={v => { setSrcConnId(v); setSrcTable('') }} />
                <SearchableSelect value={srcSchema} onChange={setSrcSchema}
                  options={srcSchemas} placeholder="选择 Schema" searchPlaceholder="搜索 schema…" />
                {mode === 'table' && <TableSelect value={srcTable} onChange={setSrcTable} tables={srcTables} loading={srcLoadingTables} />}
              </div>

              <span style={{ color: 'var(--accent)', fontSize: 20, lineHeight: 1 }}>→</span>

              {/* 目标（待同步） */}
              <div style={sdCard}>
                <div style={sdLabel}>{mode === 'table' ? '目标表（待同步）' : '目标 Schema（待同步）'}</div>
                <ConnSelect value={dstConnId} onChange={v => { setDstConnId(v); setDstTable('') }} />
                <SearchableSelect value={dstSchema} onChange={setDstSchema}
                  options={dstSchemas} placeholder="选择 Schema" searchPlaceholder="搜索 schema…" />
                {mode === 'table' && <TableSelect value={dstTable} onChange={setDstTable} tables={dstTables} loading={dstLoadingTables} />}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {(() => { const dis = running || !srcSchema || !dstSchema || (mode === 'table' && (!srcTable || !dstTable)) || srcLoadingTables || dstLoadingTables; return (
              <button
                onClick={runDiff}
                disabled={dis}
                style={{
                  background: dis ? 'var(--surface-2)' : 'var(--accent)',
                  color: dis ? 'var(--text-muted)' : '#fff',
                  border: dis ? '1px solid var(--border)' : '1px solid var(--accent)',
                  cursor: dis ? 'not-allowed' : 'pointer',
                  borderRadius: 8, padding: '7px 18px', fontSize: 13, fontWeight: 600,
                }}
              >
                {running ? '对比中…' : mode === 'table' ? '对比结构' : '对比整个 Schema'}
              </button>
              )})()}
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {mode === 'table'
                  ? '以源表为基准，生成让目标表匹配源表结构的 ALTER SQL'
                  : '比较 MySQL 库默认选项和普通表完整定义；视图、存储程序和权限不在范围内'}
              </span>
            </div>

            {error && (
              <div style={{ fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6, padding: '6px 10px' }}>
                {error}
              </div>
            )}

            {/* 结构一致：紧凑徽标，不占整块空间 */}
            {currentDiff !== null && !hasDiff && (
              <div style={{ display: 'inline-flex', alignSelf: 'flex-start', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 8, background: 'rgba(22,163,74,0.10)', border: '1px solid rgba(22,163,74,0.30)', fontSize: 12.5, color: '#16a34a', fontWeight: 500 }}>
                <CheckCircle2 size={15} strokeWidth={2.2} /> 当前读取的两表完整定义一致（不含权限和外部依赖）
              </div>
            )}
            {currentSchemaDiff !== null && !hasSchemaDiff && (
              <div style={{ display: 'inline-flex', alignSelf: 'flex-start', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 8, background: 'rgba(22,163,74,0.10)', border: '1px solid rgba(22,163,74,0.30)', fontSize: 12.5, color: '#16a34a', fontWeight: 500 }}>
                <CheckCircle2 size={15} strokeWidth={2.2} /> 本次读取的库默认定义及{currentSchemaDiff.comparisonScope}中的 {currentSchemaDiff.comparedTables} 张同名表定义一致（不含视图、存储程序和权限）
              </div>
            )}
          </div>

          {currentSchemaDiff !== null && hasSchemaDiff && (
            <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {reportExport(true)}
              {!currentSchemaDiff.databaseDefinition.identical && <section style={sdCard}>
                <strong style={{ color: 'var(--text-bright)', fontSize: 12 }}>数据库默认定义不同（仅展示，不自动改写）</strong>
                <span style={sdLabel}>源库原文</span><pre style={{ whiteSpace: 'pre-wrap', margin: 0, color: 'var(--text)', fontSize: 11 }}>{currentSchemaDiff.databaseDefinition.sourceDdl}</pre>
                <span style={sdLabel}>目标库原文</span><pre style={{ whiteSpace: 'pre-wrap', margin: 0, color: 'var(--text)', fontSize: 11 }}>{currentSchemaDiff.databaseDefinition.targetDdl}</pre>
              </section>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {[
                  ['目标缺表', currentSchemaDiff.missingTables.length, 'var(--success)'],
                  ['目标多表', currentSchemaDiff.extraTables.length, 'var(--error)'],
                  ['结构不同', currentSchemaDiff.changedTables.length, 'var(--warning)'],
                  ['无法完整比对', currentSchemaDiff.uncomparableTables.length, 'var(--error)'],
                ].map(([label, count, color]) => (
                  <div key={String(label)} style={{ ...sdCard, gap: 3 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</span>
                    <span style={{ fontSize: 20, fontWeight: 650, color: String(color) }}>{count}</span>
                  </div>
                ))}
              </div>

              {currentSchemaDiff.missingTables.length > 0 && (
                <section>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--success)', marginBottom: 7 }}>目标缺少的表（{currentSchemaDiff.missingTables.length}）</div>
                  <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.8 }}>{currentSchemaDiff.missingTables.join('、')}</div>
                </section>
              )}
              {currentSchemaDiff.extraTables.length > 0 && (
                <section>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--error)', marginBottom: 7 }}>目标多出的表（{currentSchemaDiff.extraTables.length}）</div>
                  <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.8 }}>{currentSchemaDiff.extraTables.join('、')}</div>
                </section>
              )}
              {currentSchemaDiff.changedTables.length > 0 && (
                <section>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--warning)', marginBottom: 7 }}>同名表结构差异（{currentSchemaDiff.changedTables.length}）</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {currentSchemaDiff.changedTables.map(item => {
                      const expanded = expandedTables.has(item.table)
                      return (
                        <div key={item.table} style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2)', overflow: 'hidden' }}>
                          <button onClick={() => setExpandedTables(prev => { const next = new Set(prev); expanded ? next.delete(item.table) : next.add(item.table); return next })}
                            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px', color: 'var(--text-bright)', fontSize: 12, textAlign: 'left' }}>
                            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            <span style={{ fontWeight: 600 }}>{item.table}</span>
                            <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>
                              +{item.diff.added.length} / -{item.diff.removed.length} / ~{item.diff.modified.length}{item.diff.tableOptions ? ` / ${item.diff.tableOptions.kind}` : ''}
                            </span>
                          </button>
                          {expanded && (
                            <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 7 }}>
                              {item.diff.tableOptions && <div style={{ ...sdCard, gap: 5 }}>
                                <strong style={{ fontSize: 12, color: 'var(--warning)' }}>{item.diff.tableOptions.kind}不同</strong>
                                {item.diff.tableOptions.kind === '索引和约束' ? explainIndexDifference(item.diff.tableOptions.source, item.diff.tableOptions.target, item.table).map((line, index) => <div key={index} style={{ fontSize: 12, color: 'var(--text)' }}>{line}</div>) : <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                  {(['source', 'target'] as const).map((side) => (
                                    <div key={side} style={{ minWidth: 0 }}>
                                      <div style={{ ...sdLabel, marginBottom: 5 }}>{side === 'source' ? '源端定义' : '目标端定义'}</div>
                                      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.6, color: 'var(--text)' }}>{item.diff.tableOptions![side] || '（无）'}</pre>
                                    </div>
                                  ))}
                                </div>}
                              </div>}
                              {item.diff.added.map(col => <div key={`a-${col.name}`}><span style={{ color: 'var(--success)', marginRight: 8 }}>新增</span><ColBadge col={col} /></div>)}
                              {item.diff.removed.map(col => <div key={`r-${col.name}`}><span style={{ color: 'var(--error)', marginRight: 8 }}>删除</span><ColBadge col={col} /></div>)}
                              {item.diff.modified.map(change => <div key={`m-${change.name}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <div><span style={{ color: 'var(--warning)', marginRight: 8 }}>修改</span><ColBadge col={change.after} /></div>
                                <div style={{ paddingLeft: 36, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                                  <ColumnDefinitionDetails definition={change.beforeDefinition} />
                                  <ColumnDefinitionDetails definition={change.afterDefinition} />
                                </div>
                              </div>)}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </section>
              )}
              {currentSchemaDiff.uncomparableTables.length > 0 && (
                <section>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--error)', marginBottom: 7 }}>无法完整比对的表（{currentSchemaDiff.uncomparableTables.length}）</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {currentSchemaDiff.uncomparableTables.map(item => (
                      <div key={item.table} style={{ ...sdCard, gap: 4 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>{item.table}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.reason}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {(currentSchemaDiff.missingTables.length > 0 || currentSchemaDiff.extraTables.length > 0) && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '8px 10px', background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
                  缺失或多余的整表不自动生成 CREATE/DROP SQL；下方 SQL 仅同步同名表的列结构。
                </div>
              )}
              {currentSchemaDiff.alterSql && renderSqlSection()}
            </div>
          )}

          {/* 结果区：仅在有差异时展开滚动区 */}
          {currentDiff !== null && hasDiff && (
            <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
              {reportExport(true)}
                <>
                  {currentDiff.tableOptions && <section style={{ ...sdCard, gap: 6 }}>
                    <strong style={{ fontSize: 12, color: 'var(--warning)' }}>{currentDiff.tableOptions.kind}不同</strong>
                    {currentDiff.tableOptions.kind === '索引和约束' ? explainIndexDifference(currentDiff.tableOptions.source, currentDiff.tableOptions.target, dstTable).map((line, index) => <span key={index} style={{ fontSize: 12, color: 'var(--text)', fontFamily: line.startsWith('ALTER TABLE') ? 'var(--font-mono)' : undefined, overflowWrap: 'anywhere' }}>{line}</span>) : <><span style={sdLabel}>源：{currentDiff.tableOptions.source}</span><span style={sdLabel}>目标：{currentDiff.tableOptions.target}</span></>}
                  </section>}
                  {currentDiff.alterBlockReason && <div style={{ fontSize: 12, color: 'var(--warning)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px' }}>{currentDiff.alterBlockReason}</div>}
                  {/* 新增列 (ADD COLUMN) */}
                  {currentDiff.added.length > 0 && (
                    <section>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--success)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>✅</span> 目标缺少列（需 ADD）<span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({currentDiff.added.length})</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {currentDiff.added.map(col => (
                          <div key={col.name} style={{
                            background: 'rgba(22,163,74,0.08)', border: '1px solid rgba(22,163,74,0.2)',
                            borderRadius: 8, padding: '8px 12px',
                          }}>
                            <ColBadge col={col} />
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {/* 删除列 (DROP COLUMN — 高危) */}
                  {currentDiff.removed.length > 0 && (
                    <section>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--error)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <AlertTriangle size={13} />
                        目标多余列（需 DROP — 数据丢失）
                        <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({currentDiff.removed.length})</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {currentDiff.removed.map(col => (
                          <div key={col.name} style={{
                            background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.3)',
                            borderRadius: 8, padding: '8px 12px',
                          }}>
                            <ColBadge col={col} />
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {/* 修改列 (MODIFY COLUMN) */}
                  {currentDiff.modified.length > 0 && (
                    <section>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--warning)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>✏️</span> 列定义不同（需 MODIFY）<span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({currentDiff.modified.length})</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {currentDiff.modified.map(change => (
                          <div key={change.name} style={{
                            background: 'rgba(234,88,12,0.08)', border: '1px solid rgba(234,88,12,0.2)',
                            borderRadius: 8, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6,
                          }}>
                            <span style={{ fontWeight: 600, color: 'var(--warning)', fontSize: 12 }}>{change.name}</span>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>目标当前</div>
                                <ColBadge col={change.before} />
                                <ColumnDefinitionDetails definition={change.beforeDefinition} />
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>修改为（源）</div>
                                <ColBadge col={change.after} />
                                <ColumnDefinitionDetails definition={change.afterDefinition} />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                </>

              {/* ALTER SQL */}
              {currentDiff.alterSql && (
                <section>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                    生成的 ALTER SQL（仅供核对，需在 SQL 编辑器确认目标后逐表执行）
                    {hasDangerDrop && (
                      <span style={{ fontSize: 11, color: 'var(--error)', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <AlertTriangle size={11} /> 包含高危 DROP COLUMN，执行前请备份
                      </span>
                    )}
                  </div>
                  <div style={{
                    background: 'var(--bg)', border: `1px solid ${hasDangerDrop ? 'rgba(220,38,38,0.4)' : 'var(--border)'}`,
                    borderRadius: 8, padding: 12, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflow: 'auto',
                  }}>
                    {alterSql}
                  </div>

                  {execResult && (
                    <div style={{
                      marginTop: 8, fontSize: 12, padding: '6px 10px', borderRadius: 6,
                      background: execResult.startsWith('执行成功') ? 'rgba(22,163,74,0.1)' : 'var(--error-bg)',
                      color: execResult.startsWith('执行成功') ? '#16a34a' : 'var(--error)',
                    }}>
                      {execResult}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button
                      onClick={copySql}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5, fontSize: 12,
                        color: copied ? '#16a34a' : 'var(--text-muted)',
                        padding: '5px 12px', borderRadius: 7,
                        border: '1px solid var(--border)', background: 'var(--surface-2)',
                      }}
                    >
                      {copied ? <Check size={12} /> : <Copy size={12} />}
                      {copied ? '已复制' : '复制 SQL'}
                    </button>

                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>}


    </>,
    document.body
  )
}
