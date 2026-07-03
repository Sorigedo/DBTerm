// openGauss gs_index_advise — 单查询智能索引推荐（社区版内置函数）
//
// gs_index_advise('<SQL>') 分析单条查询并给出推荐索引（schema/table/column）。
// 通过现有 execute_query 走 PG 协议执行，独立面板、与 dbe_perf 看板互不影响。
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Lightbulb, Loader2, AlertTriangle } from 'lucide-react'

interface Props {
  connectionId: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface Advise { schema: string; table: string; column: string }

export default function OgIndexAdvisePanel({ connectionId, onClose, embedded }: Props) {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Advise[] | null>(null)

  useEffect(() => {
    if (embedded) return   // 嵌入时由 DBA 面板统一处理 Esc
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, embedded])

  const run = async () => {
    const sql = query.trim().replace(/;+\s*$/, '')
    if (!sql) { setError('请输入要分析的查询语句'); return }
    setLoading(true); setError(''); setResult(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      // 单引号转义，传入 gs_index_advise
      const escaped = sql.replace(/'/g, "''")
      const res = await invoke<R>('execute_query', { id: connectionId, sql: `SELECT * FROM gs_index_advise('${escaped}')` })
      // 返回列通常为 schema, table, column
      const ci = (name: string) => res.columns.findIndex(c => c.toLowerCase() === name)
      const si = ci('schema'), ti = ci('table'), coli = ci('column')
      setResult(res.rows.map(r => ({
        schema: String(r[si >= 0 ? si : 0] ?? ''),
        table: String(r[ti >= 0 ? ti : 1] ?? ''),
        column: String(r[coli >= 0 ? coli : 2] ?? ''),
      })))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const inner = (
    <>
        <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            粘贴一条 SQL 查询，openGauss 将分析其访问路径并推荐可建索引（不会实际建索引）。
          </div>
          <textarea value={query} onChange={e => setQuery(e.target.value)}
            placeholder="SELECT * FROM orders WHERE user_id = 100 AND status = 'paid'"
            rows={5}
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 12, fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, resize: 'vertical' }} />
          <div>
            <button onClick={run} disabled={loading}
              style={{ padding: '6px 16px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
              {loading ? <Loader2 size={13} className="spin" /> : <Lightbulb size={13} />} 分析推荐
            </button>
          </div>

          {error && (
            <div style={{ display: 'flex', gap: 8, padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'rgba(220,38,38,0.08)', borderRadius: 6 }}>
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{error}<br /><span style={{ color: 'var(--text-muted)' }}>注：gs_index_advise 为 openGauss 内置函数，原生 PostgreSQL 不支持。</span></span>
            </div>
          )}

          {result && (result.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)', fontSize: 12 }}>无索引推荐（查询已可高效执行，或无可优化点）</div>
          ) : (
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead style={{ background: 'var(--surface-2)' }}>
                  <tr>{['Schema', '表', '推荐索引列'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {result.map((r, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{r.schema || '—'}</td>
                      <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-bright)' }}>{r.table || '—'}</td>
                      <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent)' }}>{r.column || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
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
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 620, maxHeight: '84vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Lightbulb size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>openGauss 智能索引推荐</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>gs_index_advise</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={14} /></button>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}
