// PG4.1 — 声明式分区：分区树视图、ATTACH / DETACH / CREATE
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Layers, ChevronRight, AlertTriangle, Plus, Scissors } from 'lucide-react'

interface Props {
  connectionId: string
  schema?: string
  onClose: () => void
  onRunSql?: (sql: string) => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface PartitionedTable {
  schemaName: string
  tableName: string
  partStrategy: string  // r=range, l=list, h=hash
  partKeyExpr: string
  partCount: number
}

interface PartitionChild {
  schemaName: string
  tableName: string
  partBound: string
  isLeaf: boolean   // true if this child has no further partitions
  rowEstimate: number
  sizeMb: number
  isSubPartitioned: boolean
}

const STRATEGY_LABEL: Record<string, string> = { r: 'RANGE', l: 'LIST', h: 'HASH' }

export default function PgPartitionPanel({ connectionId, schema, onClose, onRunSql, embedded }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tables, setTables] = useState<PartitionedTable[]>([])
  const [selected, setSelected] = useState<PartitionedTable | null>(null)
  const [children, setChildren] = useState<PartitionChild[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // ATTACH / DETACH dialog state
  const [showAttach, setShowAttach] = useState(false)
  const [attachTable, setAttachTable] = useState('')
  const [attachBound, setAttachBound] = useState('')

  // CREATE new partition dialog
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createBound, setCreateBound] = useState('')

  useEffect(() => {
    if (embedded) return   // 嵌入时由 DBA 面板统一处理 Esc
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, embedded])

  const q = async (sql: string) => {
    const { invoke } = await import('@tauri-apps/api/core')
    type R = { columns: string[]; rows: (string | null)[][] }
    return invoke<R>('execute_query', { id: connectionId, sql })
  }

  const loadTables = async () => {
    setLoading(true); setError('')
    try {
      const schemaFilter = schema ? `AND n.nspname = '${schema.replace(/'/g, "''")}'` : ''
      const res = await q(`SELECT n.nspname, c.relname,
          pt.partstrat::text,
          pg_get_partkeydef(c.oid),
          (SELECT count(*) FROM pg_inherits WHERE inhparent = c.oid)::int
        FROM pg_partitioned_table pt
        JOIN pg_class c ON c.oid = pt.partrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'p'
        ${schemaFilter}
        ORDER BY n.nspname, c.relname`)
      const list = res.rows.map(r => ({
        schemaName:   String(r[0] ?? ''),
        tableName:    String(r[1] ?? ''),
        partStrategy: String(r[2] ?? ''),
        partKeyExpr:  String(r[3] ?? ''),
        partCount:    Number(r[4] ?? 0),
      }))
      setTables(list)
      if (list.length > 0 && !selected) loadChildren(list[0])
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadChildren = async (tbl: PartitionedTable) => {
    setSelected(tbl)
    setLoading(true); setError('')
    try {
      const res = await q(`SELECT n.nspname, c.relname,
          pg_get_expr(c.relpartbound, c.oid),
          EXISTS(SELECT 1 FROM pg_inherits pi WHERE pi.inhparent = c.oid) AS is_sub_partitioned,
          c.reltuples::bigint,
          pg_total_relation_size(c.oid) / 1024 / 1024
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE i.inhparent = (SELECT c2.oid FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid = c2.relnamespace WHERE n2.nspname = '${tbl.schemaName.replace(/'/g, "''")}' AND c2.relname = '${tbl.tableName.replace(/'/g, "''")}')
        ORDER BY c.relname`)
      setChildren(res.rows.map(r => ({
        schemaName:        String(r[0] ?? ''),
        tableName:         String(r[1] ?? ''),
        partBound:         String(r[2] ?? ''),
        isSubPartitioned:  r[3] === 't' || r[3] === 'true',
        rowEstimate:       Number(r[4] ?? 0),
        sizeMb:            Number(r[5] ?? 0),
        isLeaf:            r[3] !== 't' && r[3] !== 'true',
      })))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  useEffect(() => { loadTables() }, [])

  const detachPartition = (childSchema: string, childTable: string) => {
    if (!selected) return
    if (!window.confirm(
      `确认分离分区 "${childSchema}"."${childTable}"？\n\n` +
      `DETACH PARTITION 后该表将变为独立普通表，不再属于 "${selected.schemaName}"."${selected.tableName}"。\n` +
      `PG14+ 可用 DETACH PARTITION CONCURRENTLY 减少锁等待。`
    )) return
    const sql = `ALTER TABLE "${selected.schemaName}"."${selected.tableName}" DETACH PARTITION "${childSchema}"."${childTable}";`
    if (onRunSql) { onRunSql(sql); onClose() }
  }

  const doAttach = () => {
    if (!selected || !attachTable.trim()) return
    const sql = `ALTER TABLE "${selected.schemaName}"."${selected.tableName}" ATTACH PARTITION ${attachTable.trim()} ${attachBound.trim()};`
    if (onRunSql) { onRunSql(sql); onClose() }
  }

  const doCreate = () => {
    if (!selected || !createName.trim() || !createBound.trim()) return
    const strategy = STRATEGY_LABEL[selected.partStrategy] ?? 'RANGE'
    const sql = `CREATE TABLE "${selected.schemaName}"."${createName.trim()}" PARTITION OF "${selected.schemaName}"."${selected.tableName}" ${createBound.trim()};`
    void strategy
    if (onRunSql) { onRunSql(sql); onClose() }
  }

  const stratColor = (s: string) => s === 'r' ? 'var(--accent)' : s === 'l' ? '#16a34a' : '#ea580c'

  const inner = (
    <>
        {embedded && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            {schema && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {schema}</span>}
            <button onClick={() => selected ? loadChildren(selected) : loadTables()} disabled={loading} style={{ marginLeft: 'auto', color: 'var(--text-muted)', padding: 4, lineHeight: 0, background: 'transparent', cursor: 'pointer' }}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
          </div>
        )}

        {error && <div style={{ padding: '8px 16px', background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12, flexShrink: 0 }}>{error}</div>}

        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* 左侧：分区表列表 */}
          <div style={{ width: 220, borderRight: '1px solid var(--border)', overflow: 'auto', flexShrink: 0 }}>
            <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border-subtle)', position: 'sticky', top: 0, background: 'var(--surface)' }}>
              分区表 ({tables.length})
            </div>
            {tables.length === 0 && !loading && (
              <div style={{ padding: '16px 12px', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>无声明式分区表</div>
            )}
            {tables.map((t, i) => (
              <div
                key={i}
                onClick={() => loadChildren(t)}
                style={{
                  padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)',
                  background: selected?.tableName === t.tableName && selected?.schemaName === t.schemaName ? 'var(--surface-hover)' : '',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Layers size={11} color="var(--accent)" />
                  <span style={{ fontSize: 12, color: 'var(--text-bright)', fontFamily: 'var(--font-mono)', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.tableName}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: stratColor(t.partStrategy) }}>{STRATEGY_LABEL[t.partStrategy] ?? t.partStrategy}</span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, paddingLeft: 17 }}>{t.schemaName} · {t.partCount} 个分区</div>
              </div>
            ))}
          </div>

          {/* 右侧：分区详情 */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {selected ? (
              <>
                <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 13, color: 'var(--text-bright)' }}>{selected.schemaName}.{selected.tableName}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: stratColor(selected.partStrategy), background: `${stratColor(selected.partStrategy)}15`, padding: '2px 7px', borderRadius: 4 }}>{STRATEGY_LABEL[selected.partStrategy] ?? selected.partStrategy}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>BY {selected.partKeyExpr}</span>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => { setAttachTable(''); setAttachBound(''); setShowAttach(true) }}
                        style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)' }}
                      >
                        <Plus size={11} />ATTACH
                      </button>
                      <button
                        onClick={() => { setCreateName(''); setCreateBound(''); setShowCreate(true) }}
                        style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--accent)', background: 'var(--accent-bg)', color: 'var(--accent)' }}
                      >
                        <Plus size={11} />新建分区
                      </button>
                    </div>
                  </div>
                </div>

                <div style={{ flex: 1, overflow: 'auto' }}>
                  {loading && <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载分区列表…</div>}
                  {!loading && children.length === 0 && (
                    <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>此表尚无分区</div>
                  )}
                  {!loading && children.length > 0 && (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                        <tr>
                          {['分区表名', '分区条件', '是否子分区', '估算行数', '大小', '操作'].map(h => (
                            <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {children.map((c, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '7px 10px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                {c.isSubPartitioned && (
                                  <button onClick={() => setExpanded(prev => { const n = new Set(prev); n.has(c.tableName) ? n.delete(c.tableName) : n.add(c.tableName); return n })} style={{ lineHeight: 0, color: 'var(--text-muted)' }}>
                                    <ChevronRight size={10} className={expanded.has(c.tableName) ? 'rot90' : ''} />
                                  </button>
                                )}
                                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-bright)' }}>{c.tableName}</span>
                              </div>
                              <div style={{ fontSize: 10, color: 'var(--text-muted)', paddingLeft: c.isSubPartitioned ? 16 : 0 }}>{c.schemaName}</div>
                            </td>
                            <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.partBound}>{c.partBound}</td>
                            <td style={{ padding: '7px 10px', color: c.isSubPartitioned ? 'var(--accent)' : 'var(--text-muted)' }}>{c.isSubPartitioned ? '是 (子分区)' : '否'}</td>
                            <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{c.rowEstimate.toLocaleString()}</td>
                            <td style={{ padding: '7px 10px', color: 'var(--text-muted)' }}>{c.sizeMb >= 1024 ? `${(c.sizeMb / 1024).toFixed(1)}GB` : `${c.sizeMb.toFixed(1)}MB`}</td>
                            <td style={{ padding: '7px 10px' }}>
                              <button
                                onClick={() => detachPartition(c.schemaName, c.tableName)}
                                title="DETACH PARTITION（分离为独立表）"
                                style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--warning)', padding: '2px 7px', borderRadius: 4, border: '1px solid rgba(234,88,12,0.3)', background: 'rgba(234,88,12,0.05)' }}
                              >
                                <Scissors size={9} />DETACH
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                从左侧选择分区表
              </div>
            )}
          </div>
        </div>

        {/* ATTACH PARTITION 对话框 */}
        {showAttach && selected && createPortal(
          <div className="cdlg-overlay" onMouseDown={() => setShowAttach(false)}>
            <div className="cdlg-box" onMouseDown={e => e.stopPropagation()} style={{ width: 460, padding: 20, borderRadius: 14 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 16 }}>ATTACH PARTITION</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                将已存在的表绑定为 <code style={{ background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 3 }}>{selected.tableName}</code> 的分区。
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>现有表名（schema.table）</label>
                  <input value={attachTable} onChange={e => setAttachTable(e.target.value)}
                    placeholder={`public.orders_2025`}
                    style={{ width: '100%', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)' }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                    分区条件（FOR VALUES...）
                  </label>
                  <input value={attachBound} onChange={e => setAttachBound(e.target.value)}
                    placeholder={selected.partStrategy === 'r' ? "FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')" : selected.partStrategy === 'l' ? "FOR VALUES IN ('CN', 'US')" : "FOR VALUES WITH (MODULUS 4, REMAINDER 0)"}
                    style={{ width: '100%', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)' }} />
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--surface-2)', padding: '8px 10px', borderRadius: 6, marginBottom: 16, fontFamily: 'var(--font-mono)' }}>
                ALTER TABLE "{selected.schemaName}"."{selected.tableName}" ATTACH PARTITION {attachTable || '<table>'} {attachBound || '<FOR VALUES...>'};
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowAttach(false)} style={{ padding: '6px 14px', borderRadius: 6, fontSize: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }}>取消</button>
                <button onClick={doAttach} disabled={!attachTable.trim() || !attachBound.trim()} style={{ padding: '6px 14px', borderRadius: 6, fontSize: 12, background: 'var(--accent)', color: '#fff', fontWeight: 600 }}>生成 SQL 并执行</button>
              </div>
            </div>
          </div>,
          document.body
        )}

        {/* CREATE PARTITION 对话框 */}
        {showCreate && selected && createPortal(
          <div className="cdlg-overlay" onMouseDown={() => setShowCreate(false)}>
            <div className="cdlg-box" onMouseDown={e => e.stopPropagation()} style={{ width: 460, padding: 20, borderRadius: 14 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 16 }}>新建分区</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>新分区表名</label>
                  <input value={createName} onChange={e => setCreateName(e.target.value)}
                    placeholder="orders_2025q1"
                    style={{ width: '100%', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)' }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>分区条件（FOR VALUES...）</label>
                  <input value={createBound} onChange={e => setCreateBound(e.target.value)}
                    placeholder={selected.partStrategy === 'r' ? "FOR VALUES FROM ('2025-01-01') TO ('2025-04-01')" : selected.partStrategy === 'l' ? "FOR VALUES IN ('A', 'B')" : "FOR VALUES WITH (MODULUS 4, REMAINDER 1)"}
                    style={{ width: '100%', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)' }} />
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--surface-2)', padding: '8px 10px', borderRadius: 6, marginBottom: 8, fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
                CREATE TABLE "{selected.schemaName}"."{createName || '<name>'}" PARTITION OF "{selected.schemaName}"."{selected.tableName}" {createBound || '<FOR VALUES...>'};
              </div>
              <div style={{ padding: '6px 10px', background: 'rgba(234,88,12,0.06)', borderRadius: 6, fontSize: 11, color: 'var(--warning)', marginBottom: 16, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>在生产环境中创建分区前，请确保分区范围与现有分区不重叠，并在低峰期执行。</span>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowCreate(false)} style={{ padding: '6px 14px', borderRadius: 6, fontSize: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }}>取消</button>
                <button onClick={doCreate} disabled={!createName.trim() || !createBound.trim()} style={{ padding: '6px 14px', borderRadius: 6, fontSize: 12, background: 'var(--accent)', color: '#fff', fontWeight: 600 }}>生成 SQL 并执行</button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  )

  // 嵌入 DBA 面板：只渲染内容，无模态外壳（刷新已并入工具行）
  if (embedded) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {inner}
      </div>
    )
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 900, maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Layers size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>PG 声明式分区</span>
          {schema && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {schema}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={() => selected ? loadChildren(selected) : loadTables()} disabled={loading} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }}><X size={13} /></button>
          </div>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}
