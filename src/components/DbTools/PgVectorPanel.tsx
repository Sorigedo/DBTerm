import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Boxes, Loader2, Play } from 'lucide-react'
import SearchableSelect from './SearchableSelect'

interface Props {
  connectionId: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface VectorColumn {
  schemaName: string
  tableName: string
  columnName: string
  dimensions: number | null
  indexType: string | null
}

interface QueryResult {
  columns: string[]
  rows: (string | null)[][]
  rowsAffected: number
  executionTimeMs: number
}

// pgvector 距离算子
const OPS = [
  { value: '<->', label: 'L2 距离（欧氏）' },
  { value: '<=>', label: '余弦距离' },
  { value: '<#>', label: '负内积' },
]

export default function PgVectorPanel({ connectionId, onClose, embedded }: Props) {
  const [cols, setCols] = useState<VectorColumn[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [selIdx, setSelIdx] = useState(0)
  const [vecText, setVecText] = useState('')
  const [op, setOp] = useState('<->')
  const [topK, setTopK] = useState(10)

  const [result, setResult] = useState<QueryResult | null>(null)
  const [querying, setQuerying] = useState(false)
  const [queryErr, setQueryErr] = useState('')
  const [usedSql, setUsedSql] = useState('')

  const loadCols = async () => {
    setLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<VectorColumn[]>('pg_vector_info', { id: connectionId })
      setCols(res)
      setError('')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadCols() }, [])
  useEffect(() => {
    if (embedded) return   // 嵌入时由 DBA 面板统一处理 Esc
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, embedded])

  const runQuery = async () => {
    const col = cols[selIdx]
    if (!col) { setQueryErr('请选择向量列'); return }
    // 校验查询向量：必须是逗号分隔的有限数字（同时防注入）
    const parts = vecText.split(',').map(s => s.trim()).filter(s => s.length > 0)
    if (parts.length === 0) { setQueryErr('请输入查询向量（逗号分隔的数字）'); return }
    const nums = parts.map(Number)
    if (nums.some(n => !Number.isFinite(n))) { setQueryErr('查询向量含非法数字'); return }
    if (col.dimensions && nums.length !== col.dimensions) {
      setQueryErr(`向量维度不匹配：该列为 ${col.dimensions} 维，输入了 ${nums.length} 维`); return
    }
    const k = Math.max(1, Math.min(1000, topK || 10))
    const vec = `[${nums.join(',')}]`
    // schema/table/column 来自 pg_vector_info（可信）；向量值已校验为纯数字
    const q = `"${col.columnName}" ${op} '${vec}'`
    const sql = `SELECT *, ${q} AS _distance FROM "${col.schemaName}"."${col.tableName}" ORDER BY ${q} LIMIT ${k}`
    setUsedSql(sql)
    setQuerying(true); setQueryErr('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<QueryResult>('execute_query', { id: connectionId, sql })
      setResult(res)
    } catch (e) {
      setQueryErr(String(e)); setResult(null)
    } finally {
      setQuerying(false)
    }
  }

  const col = cols[selIdx]

  const inner = (
    <>
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载向量列…</div>
          ) : error ? (
            <div style={{ margin: 16, padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6 }}>{error}</div>
          ) : cols.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              当前库未检测到 pgvector 向量列（需安装 pgvector 扩展并存在 vector 类型列）
            </div>
          ) : (
            <>
              {/* 查询配置区 */}
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 56 }}>向量列</span>
                  <SearchableSelect
                    value={String(selIdx)}
                    onChange={v => { setSelIdx(Number(v)); setResult(null) }}
                    items={cols.map((c, i) => ({
                      value: String(i),
                      label: `${c.schemaName}.${c.tableName}.${c.columnName}${c.dimensions ? ` (${c.dimensions}维)` : ''}${c.indexType ? ` [${c.indexType}]` : ' [无索引]'}`,
                    }))}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 56, marginTop: 6 }}>查询向量</span>
                  <textarea value={vecText} onChange={e => setVecText(e.target.value)}
                    placeholder={col?.dimensions ? `逗号分隔的 ${col.dimensions} 个数字，如 0.1, 0.2, ...` : '逗号分隔的数字，如 0.1, 0.2, 0.3'}
                    rows={2}
                    style={{ flex: 1, padding: '5px 8px', fontSize: 12, fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, resize: 'vertical' }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 56 }}>距离算子</span>
                  <SearchableSelect
                    value={op}
                    onChange={setOp}
                    items={OPS.map(o => ({ value: o.value, label: `${o.value} ${o.label}` }))}
                    mono={false}
                    width={220}
                  />
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>Top K</span>
                  <input type="number" min={1} max={1000} value={topK} onChange={e => setTopK(Number(e.target.value) || 10)}
                    style={{ width: 70, padding: '5px 8px', fontSize: 12, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
                  <button onClick={runQuery} disabled={querying}
                    style={{ marginLeft: 'auto', padding: '6px 14px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: querying ? 'not-allowed' : 'pointer', opacity: querying ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {querying ? <Loader2 size={13} className="spin" /> : <Play size={13} />} 查询
                  </button>
                </div>
                {col && !col.indexType && (
                  <div style={{ fontSize: 11, color: 'var(--warning)' }}>
                    ⚠ 该向量列无索引，大表近邻查询会全表扫描；建议创建 IVFFlat 或 HNSW 索引。
                  </div>
                )}
              </div>

              {/* 结果区 */}
              <div style={{ flex: 1, overflow: 'auto', padding: queryErr ? 16 : 0 }}>
                {queryErr ? (
                  <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6 }}>{queryErr}</div>
                ) : querying ? (
                  <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>查询中…</div>
                ) : result ? (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0, zIndex: 1 }}>
                      <tr>
                        {result.columns.map((c, i) => (
                          <th key={i} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', color: c === '_distance' ? 'var(--accent)' : 'var(--text-muted)', whiteSpace: 'nowrap' }}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, ri) => (
                        <tr key={ri} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                          {row.map((cell, ci) => (
                            <td key={ci} style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: result.columns[ci] === '_distance' ? 'var(--accent)' : 'var(--text)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              title={cell ?? 'NULL'}>
                              {cell === null ? <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>NULL</span> : cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>填入查询向量后点击「查询」，按相似度返回 Top K 行</div>
                )}
              </div>

              {result && usedSql && (
                <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={usedSql}>
                  {result.rows.length} 行 · {result.executionTimeMs}ms · {usedSql}
                </div>
              )}
            </>
          )}
        </div>
    </>
  )

  // 嵌入 DBA 面板：只渲染内容，无模态外壳
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
        style={{ width: 880, maxHeight: '88vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Boxes size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>pgvector 相似度查询</span>
          <div style={{ marginLeft: 'auto' }}>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}
