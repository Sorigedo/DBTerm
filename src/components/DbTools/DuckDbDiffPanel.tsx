import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X, GitCompare, Loader2 } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import SearchableSelect from './SearchableSelect'

interface Props {
  connectionId: string
  onClose: () => void
}

interface DiffTable { name: string; status: string }
interface DiffColumn { table: string; column: string; status: string; leftType: string | null; rightType: string | null }
interface DiffResult { tables: DiffTable[]; columns: DiffColumn[]; summary: string }

const TABLE_STATUS: Record<string, { label: string; color: string }> = {
  only_left:  { label: '左独有', color: '#dc2626' },
  only_right: { label: '右独有', color: '#16a34a' },
  common:     { label: '共有',   color: 'var(--text-muted)' },
}
const COL_STATUS: Record<string, { label: string; color: string }> = {
  only_left:    { label: '左独有列', color: '#dc2626' },
  only_right:   { label: '右独有列', color: '#16a34a' },
  type_changed: { label: '类型不同', color: '#ea580c' },
}

export default function DuckDbDiffPanel({ connectionId, onClose }: Props) {
  const connections = useAppStore(s => s.connections)
  const candidates = useMemo(
    () => connections.filter(c => c.id !== connectionId && c.type === 'duckdb'),
    [connections, connectionId],
  )
  const selfName = connections.find(c => c.id === connectionId)?.name ?? connectionId

  const [otherId, setOtherId] = useState('')
  const [result, setResult] = useState<DiffResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async () => {
    if (!otherId) { setError('请选择对比目标库'); return }
    setLoading(true); setError(''); setResult(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<DiffResult>('duckdb_db_diff', { leftId: connectionId, rightId: otherId })
      setResult(res)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const diffTables = result?.tables.filter(t => t.status !== 'common') ?? []

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 820, maxHeight: '86vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <GitCompare size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>DuckDB 双库 schema 对比</span>
          <div style={{ marginLeft: 'auto' }}>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>左库</span>
          <span style={{ fontSize: 12, color: 'var(--text-bright)', fontWeight: 600 }}>{selfName}</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 4px' }}>对比</span>
          <SearchableSelect width={260} mono={false}
            value={otherId} onChange={setOtherId}
            placeholder="选择右库（DuckDB）…"
            items={candidates.map(c => ({ value: c.id, label: c.name }))} />
          <button onClick={run} disabled={loading || !otherId}
            style={{ padding: '6px 14px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: loading || !otherId ? 'not-allowed' : 'pointer', opacity: loading || !otherId ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            {loading ? <Loader2 size={13} className="spin" /> : <GitCompare size={13} />} 对比
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: candidates.length === 0 || error ? 16 : 12 }}>
          {candidates.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 24 }}>没有其他 DuckDB 连接可对比（需至少两个 DuckDB 文件库）</div>
          ) : error ? (
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6 }}>{error}</div>
          ) : loading ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 32 }}>对比中…</div>
          ) : result ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontSize: 12, color: 'var(--text)' }}>{result.summary}</div>
              {/* 表差异 */}
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 6 }}>表差异（{diffTables.length}）</div>
                {diffTables.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--success)' }}>两库表集合一致 ✓</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead style={{ background: 'var(--surface-2)' }}>
                      <tr>
                        <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>表名</th>
                        <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', width: 100 }}>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diffTables.map((t, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                          <td style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{t.name}</td>
                          <td style={{ padding: '5px 10px', color: TABLE_STATUS[t.status]?.color ?? 'var(--text)' }}>{TABLE_STATUS[t.status]?.label ?? t.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              {/* 列差异 */}
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 6 }}>共有表的列差异（{result.columns.length}）</div>
                {result.columns.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--success)' }}>共有表的列一致 ✓</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead style={{ background: 'var(--surface-2)' }}>
                      <tr>
                        <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>表.列</th>
                        <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', width: 90 }}>状态</th>
                        <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>左类型</th>
                        <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>右类型</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.columns.map((c, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                          <td style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{c.table}.{c.column}</td>
                          <td style={{ padding: '5px 10px', color: COL_STATUS[c.status]?.color ?? 'var(--text)' }}>{COL_STATUS[c.status]?.label ?? c.status}</td>
                          <td style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)', color: c.leftType ? 'var(--text)' : 'var(--text-muted)' }}>{c.leftType ?? '—'}</td>
                          <td style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)', color: c.rightType ? 'var(--text)' : 'var(--text-muted)' }}>{c.rightType ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 32 }}>选择右库后点击「对比」查看 schema 差异（仅结构对比，不含数据）</div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
