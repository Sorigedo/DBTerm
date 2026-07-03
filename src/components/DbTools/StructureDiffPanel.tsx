import { useState, useEffect, useCallback } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { X, Layers, Copy, Check, CheckCircle2, Play, AlertTriangle } from 'lucide-react'
import ConfirmDialog from '../shared/ConfirmDialog'
import SearchableSelect from './SearchableSelect'
import { useAppStore } from '../../stores/appStore'

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
}

interface StructureDiff {
  added: ColumnInfo[]
  removed: ColumnInfo[]
  modified: ColumnChange[]
  alterSql: string
  dangerDrops: string[]
}

interface TableInfo {
  name: string
  isView: boolean
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

export default function StructureDiffPanel({ connectionId, schema, table, onClose }: Props) {
  const connections = useAppStore(s => s.connections)
  const dbConns = connections.filter(c => c.type !== 'ssh')

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
  const [copied, setCopied] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [execResult, setExecResult] = useState<string>('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

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
    if (!srcConnId || !srcSchema) return
    let alive = true
    setSrcLoadingTables(true)
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<TableInfo[]>('list_tables', { id: srcConnId, schema: srcSchema })
        if (alive) setSrcTables(list)
      } catch { /* ignore */ } finally {
        if (alive) setSrcLoadingTables(false)
      }
    })()
    return () => { alive = false }
  }, [srcConnId, srcSchema])

  // 加载目标端表列表
  useEffect(() => {
    if (!dstConnId || !dstSchema) return
    let alive = true
    setDstLoadingTables(true)
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<TableInfo[]>('list_tables', { id: dstConnId, schema: dstSchema })
        if (alive) setDstTables(list)
      } catch { /* ignore */ } finally {
        if (alive) setDstLoadingTables(false)
      }
    })()
    return () => { alive = false }
  }, [dstConnId, dstSchema])

  const runDiff = useCallback(async () => {
    if (!srcTable || !dstTable) { setError('请选择源表和目标表'); return }
    setRunning(true)
    setError('')
    setDiff(null)
    setExecResult('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result = await invoke<StructureDiff>('db_diff_structure', {
        srcId: srcConnId,
        srcSchema,
        srcTable,
        dstId: dstConnId,
        dstSchema,
        dstTable,
      })
      setDiff(result)
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }, [srcConnId, srcSchema, srcTable, dstConnId, dstSchema, dstTable])

  const copySql = () => {
    if (!diff?.alterSql) return
    navigator.clipboard.writeText(diff.alterSql).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const executeAlter = async () => {
    if (!diff?.alterSql) return
    setExecuting(true)
    setExecResult('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('execute_query', { id: dstConnId, sql: diff.alterSql })
      setExecResult('执行成功 ✓ 表结构已更新')
    } catch (e) {
      setExecResult(`执行失败：${e}`)
    } finally {
      setExecuting(false)
      setConfirm(false)
    }
  }

  const hasDiff = diff && (diff.added.length + diff.removed.length + diff.modified.length) > 0
  const hasDangerDrop = (diff?.dangerDrops?.length ?? 0) > 0

  function ConnSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    return (
      <SearchableSelect value={value} onChange={onChange} mono={false} searchPlaceholder="搜索连接…"
        items={dbConns.map(c => ({ value: c.id, label: c.name || c.host || c.id }))} />
    )
  }

  function TableSelect({ value, onChange, tables, loading }: { value: string; onChange: (v: string) => void; tables: TableInfo[]; loading: boolean }) {
    return (
      <SearchableSelect value={value} onChange={onChange} disabled={loading}
        options={tables.map(t => t.name)} placeholder="选择表" searchPlaceholder="搜索表名…" />
    )
  }

  return createPortal(
    <>
      <div className="cdlg-overlay" onMouseDown={onClose}>
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
            <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>

          {/* 配置区 */}
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 12, alignItems: 'center' }}>
              {/* 源（基准） */}
              <div style={sdCard}>
                <div style={sdLabel}>源表（基准）</div>
                <ConnSelect value={srcConnId} onChange={v => { setSrcConnId(v); setSrcTable('') }} />
                <SearchableSelect value={srcSchema} onChange={setSrcSchema}
                  options={srcSchemas} placeholder="选择 Schema" searchPlaceholder="搜索 schema…" />
                <TableSelect value={srcTable} onChange={setSrcTable} tables={srcTables} loading={srcLoadingTables} />
              </div>

              <span style={{ color: 'var(--accent)', fontSize: 20, lineHeight: 1 }}>→</span>

              {/* 目标（待同步） */}
              <div style={sdCard}>
                <div style={sdLabel}>目标表（待同步）</div>
                <ConnSelect value={dstConnId} onChange={v => { setDstConnId(v); setDstTable('') }} />
                <SearchableSelect value={dstSchema} onChange={setDstSchema}
                  options={dstSchemas} placeholder="选择 Schema" searchPlaceholder="搜索 schema…" />
                <TableSelect value={dstTable} onChange={setDstTable} tables={dstTables} loading={dstLoadingTables} />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {(() => { const dis = running || !srcTable || !dstTable; return (
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
                {running ? '对比中…' : '对比结构'}
              </button>
              )})()}
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                以源表为基准，生成让目标表匹配源表结构的 ALTER SQL（仅生成，不自动执行）
              </span>
            </div>

            {error && (
              <div style={{ fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6, padding: '6px 10px' }}>
                {error}
              </div>
            )}

            {/* 结构一致：紧凑徽标，不占整块空间 */}
            {diff !== null && !hasDiff && (
              <div style={{ display: 'inline-flex', alignSelf: 'flex-start', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 8, background: 'rgba(22,163,74,0.10)', border: '1px solid rgba(22,163,74,0.30)', fontSize: 12.5, color: '#16a34a', fontWeight: 500 }}>
                <CheckCircle2 size={15} strokeWidth={2.2} /> 两表结构完全一致，无需同步
              </div>
            )}
          </div>

          {/* 结果区：仅在有差异时展开滚动区 */}
          {diff !== null && hasDiff && (
            <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <>
                  {/* 新增列 (ADD COLUMN) */}
                  {diff.added.length > 0 && (
                    <section>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--success)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>✅</span> 目标缺少列（需 ADD）<span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({diff.added.length})</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {diff.added.map(col => (
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
                  {diff.removed.length > 0 && (
                    <section>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--error)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <AlertTriangle size={13} />
                        目标多余列（需 DROP — 数据丢失）
                        <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({diff.removed.length})</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {diff.removed.map(col => (
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
                  {diff.modified.length > 0 && (
                    <section>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--warning)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>✏️</span> 列定义不同（需 MODIFY）<span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({diff.modified.length})</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {diff.modified.map(change => (
                          <div key={change.name} style={{
                            background: 'rgba(234,88,12,0.08)', border: '1px solid rgba(234,88,12,0.2)',
                            borderRadius: 8, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6,
                          }}>
                            <span style={{ fontWeight: 600, color: 'var(--warning)', fontSize: 12 }}>{change.name}</span>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                              <div>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>目标当前</div>
                                <ColBadge col={change.before} />
                              </div>
                              <div>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>修改为（源）</div>
                                <ColBadge col={change.after} />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                </>

              {/* ALTER SQL */}
              {diff.alterSql && (
                <section>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                    生成的 ALTER SQL
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
                    {diff.alterSql}
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
                    <button
                      onClick={() => setConfirm(true)}
                      disabled={executing}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5, fontSize: 12,
                        color: '#fff', padding: '5px 12px', borderRadius: 7,
                        background: 'var(--error)', opacity: executing ? 0.6 : 1,
                      }}
                    >
                      <Play size={12} />
                      {executing ? '执行中…' : '执行 ALTER SQL'}
                    </button>
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirm}
        title="确认执行 ALTER SQL"
        desc={`即将对目标表 ${dstSchema ? dstSchema + '.' : ''}${dstTable} 执行结构变更。${hasDangerDrop ? `\n\n⚠️ 高危：将 DROP ${diff?.dangerDrops?.length} 列，列中数据不可恢复，请确认已备份！` : '此操作不可撤销，请确认已备份数据。'}`}
        danger
        okText="确认执行"
        onOk={executeAlter}
        onCancel={() => setConfirm(false)}
      />
    </>,
    document.body
  )
}
