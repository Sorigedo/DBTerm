import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, GitCompareArrows, Copy, Check, CheckCircle2, AlertTriangle, Loader } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import SearchableSelect from './SearchableSelect'
import { qid, tableRef } from '../../utils/sqlDialect'

interface Props {
  connectionId: string
  connType: string
  schema: string
  onClose: () => void
}

interface DiffSample {
  pk: string
  src: Record<string, string | null>
  dst: Record<string, string | null>
}

interface BackendResult {
  total_only_src: number
  total_only_dst: number
  total_mismatch: number
  rows_scanned: number
  samples_only_src: DiffSample[]
  samples_only_dst: DiffSample[]
  samples_mismatch: DiffSample[]
  sample_capped: boolean
}

interface DiffRow {
  pk: string
  kind: 'only-src' | 'only-dst' | 'diff'
  srcRow: Record<string, string | null>
  dstRow: Record<string, string | null>
}

interface Progress {
  scanned: number
  only_src: number
  only_dst: number
  mismatch: number
}

interface TableInfo {
  name: string
  isView: boolean
}

// 从样本数据提取所有列名（供表头渲染用）
function deriveCols(samples: DiffSample[], kind: 'src' | 'dst'): string[] {
  const set = new Set<string>()
  for (const s of samples) {
    Object.keys(kind === 'src' ? s.src : s.dst).forEach(k => set.add(k))
  }
  return [...set]
}

// 从 backend 结果生成前端用的同步 SQL（仅覆盖样本，大差异需后端导出）
function generateSyncSql(
  result: BackendResult,
  dstSchema: string,
  dstTable: string,
  connType: string,
): string {
  const tbl = tableRef(connType, dstSchema, dstTable)
  const q = (c: string) => qid(connType, c)
  const esc = (v: string | null) => v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`
  const lines: string[] = []

  for (const d of result.samples_only_src) {
    const cols = Object.keys(d.src).map(q).join(', ')
    const vals = Object.values(d.src).map(esc).join(', ')
    lines.push(`INSERT INTO ${tbl} (${cols}) VALUES (${vals});`)
  }
  for (const d of result.samples_only_dst) {
    const where = Object.entries(d.dst).map(([c, v]) =>
      v === null ? `${q(c)} IS NULL` : `${q(c)} = ${esc(v)}`
    ).join(' AND ')
    lines.push(`DELETE FROM ${tbl} WHERE ${where};`)
  }
  for (const d of result.samples_mismatch) {
    const setCols = Object.keys(d.src).filter(c => !(Object.keys(d.dst).includes(c) &&
      d.src[c] === d.dst[c]))
    if (setCols.length === 0) continue
    const set = setCols.map(c => `${q(c)} = ${esc(d.src[c])}`).join(', ')
    const where = Object.entries(d.src)
      .filter(([c]) => c in d.dst && d.src[c] === d.dst[c])  // pk cols are equal
      .slice(0, 1)  // pick at least one
      .map(([c, v]) => `${q(c)} = ${esc(v)}`).join(' AND ') || '1=1'
    lines.push(`UPDATE ${tbl} SET ${set} WHERE ${where};`)
  }
  return lines.join('\n')
}

// 系统库不作默认 schema（避免误选 information_schema 等）
const SYSTEM_SCHEMAS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys', 'pg_catalog', 'pg_toast'])
function pickDefaultSchema(schemas: string[]): string {
  return schemas.find(s => !SYSTEM_SCHEMAS.has(s.toLowerCase())) ?? schemas[0] ?? ''
}

export default function DataDiffPanel({ connectionId, connType, schema, onClose }: Props) {
  const connections = useAppStore(s => s.connections)
  const [tables, setTables] = useState<TableInfo[]>([])
  const [loadingTables, setLoadingTables] = useState(true)

  const [srcConnId, setSrcConnId] = useState(connectionId)
  const [srcSchema, setSrcSchema] = useState(schema)
  const [srcSchemas, setSrcSchemas] = useState<string[]>([])
  const [srcTable, setSrcTable]   = useState('')
  const [dstConnId, setDstConnId] = useState(connectionId)
  const [dstSchema, setDstSchema] = useState(schema)
  const [dstSchemas, setDstSchemas] = useState<string[]>([])
  const [dstTable, setDstTable]   = useState('')
  const [srcCols, setSrcCols]     = useState<{ name: string; key: string }[]>([])
  const [pkCols, setPkCols]       = useState<string[]>([])
  const [pkPickerOpen, setPkPickerOpen] = useState(false)

  const [running, setRunning]     = useState(false)
  const [progress, setProgress]   = useState<Progress | null>(null)
  const [error, setError]         = useState('')
  const [result, setResult]       = useState<BackendResult | null>(null)
  const [activeTab, setActiveTab] = useState<'only-src' | 'only-dst' | 'diff'>('only-src')
  const [sql, setSql]             = useState('')
  const [copied, setCopied]       = useState(false)

  // 用于目标表列表（目标连接变化时重新拉取）
  const [dstTables, setDstTables] = useState<TableInfo[]>([])
  const [loadingDstTables, setLoadingDstTables] = useState(false)

  const windowId = useRef(`${Date.now()}`).current

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // 源 schema 列表（源连接变化时）
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

  // 目标 schema 列表（目标连接变化时）
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

  // 源表列表（源连接 / schema 变化时）
  useEffect(() => {
    if (!srcSchema) { setTables([]); return }
    let alive = true
    setLoadingTables(true)
    setSrcTable('')
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<TableInfo[]>('list_tables', { id: srcConnId, schema: srcSchema })
        if (alive) setTables(list.filter(t => !t.isView))
      } catch (e) {
        if (alive) setError(String(e))
      } finally {
        if (alive) setLoadingTables(false)
      }
    })()
    return () => { alive = false }
  }, [srcConnId, srcSchema])

  // 选定源表后拉取列，自动预选主键（key === 'PRI'）
  useEffect(() => {
    if (!srcTable) { setSrcCols([]); setPkCols([]); return }
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const cols = await invoke<{ name: string; key: string }[]>('table_columns', { id: srcConnId, schema: srcSchema, table: srcTable })
        if (!alive) return
        setSrcCols(cols)
        setPkCols(cols.filter(c => c.key === 'PRI').map(c => c.name))  // 无主键则留空待用户选择
        setPkPickerOpen(false)
      } catch {
        if (alive) { setSrcCols([]); setPkCols([]) }
      }
    })()
    return () => { alive = false }
  }, [srcConnId, srcSchema, srcTable])

  // 目标表列表（目标连接 / schema 变化时）
  useEffect(() => {
    if (!dstSchema) { setDstTables([]); return }
    let alive = true
    setLoadingDstTables(true)
    setDstTable('')
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<TableInfo[]>('list_tables', { id: dstConnId, schema: dstSchema })
        if (alive) setDstTables(list.filter(t => !t.isView))
      } catch { /* 允许失败 */ } finally {
        if (alive) setLoadingDstTables(false)
      }
    })()
    return () => { alive = false }
  }, [dstConnId, dstSchema])

  const runDiff = useCallback(async () => {
    if (!srcTable || !dstTable) { setError('请选择源表和目标表'); return }
    if (pkCols.length === 0) { setError('请选择主键列'); return }

    setRunning(true)
    setError('')
    setResult(null)
    setSql('')
    setProgress(null)

    // 监听进度事件
    const { listen } = await import('@tauri-apps/api/event')
    const unlisten = await listen<Progress>(`diff_progress_${windowId}`, e => {
      setProgress(e.payload)
    })

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<BackendResult>('db_diff_data', {
        srcId: srcConnId,
        srcSchema,
        srcTable,
        dstId: dstConnId,
        dstSchema,
        dstTable,
        pkCols,
        windowId,
      })
      setResult(res)
      setSql(generateSyncSql(res, dstSchema, dstTable, connType))
      // 自动切到有差异的 tab
      if (res.total_only_src > 0) setActiveTab('only-src')
      else if (res.total_only_dst > 0) setActiveTab('only-dst')
      else if (res.total_mismatch > 0) setActiveTab('diff')
    } catch (e) {
      setError(String(e))
    } finally {
      unlisten()
      setRunning(false)
    }
  }, [srcConnId, srcSchema, srcTable, dstConnId, dstSchema, dstTable, pkCols, windowId])

  const copySql = () => {
    navigator.clipboard.writeText(sql).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // 把 backend 样本转为展示用的列表
  const tabRows: DiffRow[] = result
    ? activeTab === 'only-src'
      ? result.samples_only_src.map(s => ({ pk: s.pk, kind: 'only-src', srcRow: s.src, dstRow: s.dst }))
      : activeTab === 'only-dst'
      ? result.samples_only_dst.map(s => ({ pk: s.pk, kind: 'only-dst', srcRow: s.src, dstRow: s.dst }))
      : result.samples_mismatch.map(s => ({ pk: s.pk, kind: 'diff', srcRow: s.src, dstRow: s.dst }))
    : []

  // 列名：从样本中推断
  const displayCols = result
    ? activeTab === 'diff'
      ? deriveCols(result.samples_mismatch, 'src')
      : activeTab === 'only-src'
      ? deriveCols(result.samples_only_src, 'src')
      : deriveCols(result.samples_only_dst, 'dst')
    : []

  const totalCounts = result
    ? { 'only-src': result.total_only_src, 'only-dst': result.total_only_dst, 'diff': result.total_mismatch }
    : { 'only-src': 0, 'only-dst': 0, 'diff': 0 }

  const isClean = result && result.total_only_src === 0 && result.total_only_dst === 0 && result.total_mismatch === 0

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{
          width: 720, maxHeight: '88vh',
          display: 'flex', flexDirection: 'column',
          borderRadius: 14, overflow: 'hidden',
        }}
      >
        {/* 标题栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <GitCompareArrows size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>数据对比</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>· 按主键分块归并，支持千万级大表</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
        </div>

        {/* 配置区 */}
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* 源 → 目标 卡片 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 12, alignItems: 'stretch' }}>
            {/* 源 */}
            <div style={diffCardStyle}>
              <div style={diffCardLabel}>源</div>
              <SearchableSelect value={srcConnId} onChange={setSrcConnId} mono={false} searchPlaceholder="搜索连接…"
                items={connections.filter(c => c.type !== 'ssh' && c.type !== 'local').map(c => ({ value: c.id, label: c.name }))} />
              <SearchableSelect value={srcSchema} onChange={setSrcSchema}
                options={srcSchemas} placeholder="选择 Schema" searchPlaceholder="搜索 schema…" />
              <SearchableSelect value={srcTable} onChange={setSrcTable} disabled={loadingTables}
                options={tables.map(t => t.name)} placeholder="选择表" searchPlaceholder="搜索表名…" />
            </div>

            <span style={{ color: 'var(--accent)', fontSize: 20, lineHeight: 1, alignSelf: 'center' }}>→</span>

            {/* 目标 */}
            <div style={diffCardStyle}>
              <div style={diffCardLabel}>目标</div>
              <SearchableSelect value={dstConnId} onChange={setDstConnId} mono={false} searchPlaceholder="搜索连接…"
                items={connections.filter(c => c.type !== 'ssh' && c.type !== 'local').map(c => ({ value: c.id, label: c.name }))} />
              <SearchableSelect value={dstSchema} onChange={setDstSchema}
                options={dstSchemas} placeholder="选择 Schema" searchPlaceholder="搜索 schema…" />
              <SearchableSelect value={dstTable} onChange={setDstTable} disabled={loadingDstTables}
                options={dstTables.map(t => t.name)} placeholder="选择表" searchPlaceholder="搜索表名…" />
            </div>
          </div>

          {/* 对比键：默认用表自动识别的主键，仅需要时才展开选择其他列 */}
          {(() => {
            const hasPk = srcCols.some(c => c.key === 'PRI')
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={labelStyle}>对比键（按主键分块归并，无主键时可手动指定）</label>
                {!srcTable ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 2px' }}>请先选择源表</div>
                ) : srcCols.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 2px' }}>该表无列信息</div>
                ) : (hasPk && !pkPickerOpen) ? (
                  // 已自动识别主键：只展示主键，不刷屏所有列
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {pkCols.map((c, i) => (
                      <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '4px 10px', borderRadius: 7, fontFamily: 'var(--font-mono)', background: 'var(--accent-bg)', border: '1px solid var(--accent)', color: 'var(--accent)', fontWeight: 600 }}>
                        {pkCols.length > 1 && <span style={{ fontSize: 10, opacity: 0.85 }}>{i + 1}</span>}
                        {c}<span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>PK</span>
                      </span>
                    ))}
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>已自动识别主键</span>
                    <button onClick={() => setPkPickerOpen(true)} style={{ fontSize: 12, color: 'var(--accent)', padding: '2px 4px' }}>选择其他列</button>
                  </div>
                ) : (
                  // 手动指定（无主键表 / 用户自定义）：列出所有列供多选
                  <>
                    {!hasPk && <div style={{ fontSize: 11, color: 'var(--warning)' }}>未检测到主键，请手动选择用于分块对比的列</div>}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 96, overflowY: 'auto' }}>
                      {srcCols.map(c => {
                        const idx = pkCols.indexOf(c.name)
                        const on = idx >= 0
                        return (
                          <button key={c.name}
                            onClick={() => setPkCols(prev => on ? prev.filter(n => n !== c.name) : [...prev, c.name])}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 5,
                              fontSize: 12, padding: '4px 10px', borderRadius: 7, cursor: 'pointer',
                              fontFamily: 'var(--font-mono)',
                              background: on ? 'var(--accent-bg)' : 'var(--surface)',
                              border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                              color: on ? 'var(--accent)' : 'var(--text)',
                              fontWeight: on ? 600 : 400,
                            }}>
                            {on && <span style={{ fontSize: 10, opacity: 0.85 }}>{idx + 1}</span>}
                            {c.name}
                            {c.key === 'PRI' && <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>PK</span>}
                          </button>
                        )
                      })}
                    </div>
                    {hasPk && (
                      <button onClick={() => { setPkCols(srcCols.filter(c => c.key === 'PRI').map(c => c.name)); setPkPickerOpen(false) }}
                        style={{ alignSelf: 'flex-start', fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                        收起 · 恢复为主键
                      </button>
                    )}
                  </>
                )}
              </div>
            )
          })()}

          {/* 操作行 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {(() => { const dis = running || !srcTable || !dstTable || !pkCols.length; return (
            <button
              onClick={runDiff}
              disabled={dis}
              style={{
                background: dis ? 'var(--surface-2)' : 'var(--accent)',
                color: dis ? 'var(--text-muted)' : '#fff',
                border: dis ? '1px solid var(--border)' : '1px solid var(--accent)',
                cursor: dis ? 'not-allowed' : 'pointer',
                borderRadius: 8, padding: '7px 20px', fontSize: 13, fontWeight: 600,
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              {running && <Loader size={12} className="spin" />}
              {running ? '对比中…' : '开始对比'}
            </button>
            )})()}

            {/* 进度条 */}
            {running && progress && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                <div style={{
                  width: 160, height: 4, background: 'var(--surface-2)',
                  borderRadius: 2, overflow: 'hidden',
                }}>
                  <div style={{
                    width: '40%', height: '100%',
                    background: 'var(--accent)',
                    animation: 'progressPulse 1.2s ease-in-out infinite',
                  }} />
                </div>
                已扫描 {progress.scanned.toLocaleString()} 行
                {(progress.only_src + progress.only_dst + progress.mismatch) > 0 && (
                  <span style={{ color: 'var(--warning)' }}>
                    · 发现 {(progress.only_src + progress.only_dst + progress.mismatch).toLocaleString()} 处差异
                  </span>
                )}
              </div>
            )}

            {/* 完成摘要：成功 / 有差异 友好徽标 */}
            {!running && result && (isClean ? (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 8, background: 'rgba(22,163,74,0.10)', border: '1px solid rgba(22,163,74,0.30)', fontSize: 12.5, color: '#16a34a', fontWeight: 500 }}>
                <CheckCircle2 size={15} strokeWidth={2.2} />
                两表数据完全一致 · 已比对 {result.rows_scanned.toLocaleString()} 行（双表合计）
              </div>
            ) : (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 8, background: 'rgba(234,88,12,0.10)', border: '1px solid rgba(234,88,12,0.28)', fontSize: 12.5, color: '#ea580c', fontWeight: 500 }}>
                <AlertTriangle size={14} />
                发现 {(result.total_only_src + result.total_only_dst + result.total_mismatch).toLocaleString()} 处差异 · 已比对 {result.rows_scanned.toLocaleString()} 行（双表合计）
              </div>
            ))}
          </div>

          {error && (
            <div style={{ fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6, padding: '6px 10px' }}>
              {error}
            </div>
          )}
        </div>

        {/* 结果区 */}
        {result && !isClean && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Tab 切换 */}
            <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', flexShrink: 0, alignItems: 'center' }}>
              {([
                { key: 'only-src' as const, label: '仅源有', color: 'var(--success)' },
                { key: 'only-dst' as const, label: '仅目标有', color: 'var(--error)' },
                { key: 'diff' as const, label: '不一致', color: 'var(--warning)' },
              ]).map(tab => (
                <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{
                  padding: '8px 16px', fontSize: 12, fontWeight: 500,
                  borderBottom: activeTab === tab.key ? '2px solid var(--accent)' : '2px solid transparent',
                  color: activeTab === tab.key ? 'var(--text-bright)' : 'var(--text-muted)',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  {tab.label}
                  <span style={{
                    background: totalCounts[tab.key] > 0 ? tab.color : 'var(--surface-2)',
                    color: totalCounts[tab.key] > 0 ? '#fff' : 'var(--text-muted)',
                    borderRadius: 10, padding: '0 6px', fontSize: 11, fontWeight: 600,
                  }}>
                    {totalCounts[tab.key].toLocaleString()}
                  </span>
                </button>
              ))}

              {/* 样本截断提示 */}
              {result.sample_capped && (
                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <AlertTriangle size={11} />
                  仅显示前 200 条样本，同步 SQL 不完整
                </span>
              )}

              {/* 复制同步 SQL */}
              {sql && (
                <div style={{ marginLeft: 'auto', paddingRight: 12, display: 'flex', alignItems: 'center' }}>
                  <button onClick={copySql} style={{
                    display: 'flex', alignItems: 'center', gap: 5, fontSize: 12,
                    color: copied ? '#16a34a' : 'var(--text-muted)',
                    padding: '4px 10px', borderRadius: 6,
                    border: '1px solid var(--border)', background: 'var(--surface-2)',
                  }}>
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? '已复制' : result.sample_capped ? '复制样本 SQL' : '复制同步 SQL'}
                  </button>
                </div>
              )}
            </div>

            {/* 差异表格 */}
            <div style={{ flex: 1, overflow: 'auto' }}>
              {tabRows.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  此分类无差异
                </div>
              ) : activeTab === 'diff' ? (
                // 不一致行：展开每列对比
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-2)', position: 'sticky', top: 0, zIndex: 1 }}>
                      <th style={thStyle}>主键</th>
                      <th style={thStyle}>列名</th>
                      <th style={thStyle}>源值</th>
                      <th style={thStyle}>目标值</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tabRows.map((d, ri) =>
                      displayCols.map(col => {
                        const sv = d.srcRow[col] !== undefined ? String(d.srcRow[col] ?? '') : null
                        const dv = d.dstRow[col] !== undefined ? String(d.dstRow[col] ?? '') : null
                        const differs = sv !== dv
                        return (
                          <tr key={`${ri}-${col}`} style={{ background: differs ? 'rgba(234,88,12,0.07)' : undefined }}>
                            {col === displayCols[0] && (
                              <td style={{ ...tdStyle, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
                                rowSpan={displayCols.length}>
                                {d.pk}
                              </td>
                            )}
                            <td style={{ ...tdStyle, color: differs ? '#ea580c' : 'var(--text-muted)', fontWeight: differs ? 600 : 400 }}>{col}</td>
                            <td style={tdStyle}>{sv !== null ? sv : <NullTag />}</td>
                            <td style={tdStyle}>{dv !== null ? dv : <NullTag />}</td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              ) : (
                // only-src / only-dst：正常行展示
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-2)', position: 'sticky', top: 0, zIndex: 1 }}>
                      {displayCols.map(c => <th key={c} style={thStyle}>{c}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {tabRows.map((d, i) => {
                      const row = activeTab === 'only-src' ? d.srcRow : d.dstRow
                      return (
                        <tr key={i} style={{
                          background: activeTab === 'only-src' ? 'rgba(22,163,74,0.07)' : 'rgba(220,38,38,0.07)'
                        }}>
                          {displayCols.map(c => (
                            <td key={c} style={tdStyle}>
                              {row[c] !== undefined
                                ? (row[c] ?? <NullTag />)
                                : <span style={{ color: 'var(--text-muted)' }}>-</span>}
                            </td>
                          ))}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

function NullTag() {
  return <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>NULL</span>
}

const labelStyle: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }
const diffCardStyle: React.CSSProperties = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }
const diffCardLabel: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }
const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '6px 10px', fontSize: 11,
  fontWeight: 600, color: 'var(--text-muted)',
  borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
}
const tdStyle: React.CSSProperties = {
  padding: '5px 10px', borderBottom: '1px solid var(--border-subtle)',
  color: 'var(--text)', maxWidth: 220, overflow: 'hidden',
  textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
