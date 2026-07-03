// R4 — 分区表管理
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Trash2, AlertTriangle, Layers } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'

interface PartitionInfo {
  name: string
  method: string
  expression: string
  description: string
  rowCount: number
  dataLengthMb: number
  createdTime: string
}

interface Props {
  connectionId: string
  schema: string
  table: string
  onClose: () => void
}

type ConfirmAction = { type: 'drop' | 'truncate'; partition: string }

export default function PartitionPanel({ connectionId, schema, table, onClose }: Props) {
  const [parts, setParts] = useState<PartitionInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null)
  const [confirmInput, setConfirmInput] = useState('')
  const [acting, setActing] = useState(false)
  const [actMsg, setActMsg] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const list = await invoke<PartitionInfo[]>('db_list_partitions', { id: connectionId, schema, table })
      setParts(list)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [connectionId, schema, table])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setConfirm(null); if (!confirm) onClose() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, confirm])

  const doAction = async () => {
    if (!confirm || confirmInput !== confirm.partition) return
    setActing(true)
    setActMsg('')
    try {
      const cmd = confirm.type === 'drop' ? 'db_drop_partition' : 'db_truncate_partition'
      await invoke(cmd, { id: connectionId, schema, table, partitionName: confirm.partition })
      setActMsg(`已${confirm.type === 'drop' ? '删除' : '清空'}分区 ${confirm.partition}`)
      setConfirm(null)
      setConfirmInput('')
      load()
    } catch (e) {
      setActMsg(String(e))
    } finally {
      setActing(false)
    }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 700, display: 'flex', flexDirection: 'column', maxHeight: '85vh', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Layers size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>分区管理</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{schema}.{table}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="dbt-header-btn" onClick={load} disabled={loading}><RefreshCw size={12} className={loading ? 'spin' : ''} /></button>
            <button className="dbt-header-btn" onClick={onClose}><X size={12} /></button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {error && <div style={{ margin: 12, padding: 10, background: 'rgba(220,38,38,0.1)', borderRadius: 8, color: 'var(--error)', fontSize: 12 }}>{error}</div>}
          {actMsg && <div style={{ margin: '8px 12px', padding: 8, background: actMsg.startsWith('已') ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)', borderRadius: 6, fontSize: 11, color: actMsg.startsWith('已') ? '#16a34a' : '#dc2626' }}>{actMsg}</div>}

          {/* Confirm dialog */}
          {confirm && createPortal(
            <div className="cdlg-overlay" onMouseDown={() => setConfirm(null)}>
              <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
                style={{ width: 420, borderRadius: 14, padding: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                  <AlertTriangle size={18} color="var(--error)" />
                  <span style={{ fontWeight: 600, fontSize: 14 }}>
                    {confirm.type === 'drop' ? '删除分区' : '清空分区'}
                  </span>
                </div>
                <p style={{ fontSize: 12, color: 'var(--text)', marginBottom: 12, lineHeight: 1.6 }}>
                  {confirm.type === 'drop'
                    ? `将永久删除分区 "${confirm.partition}" 及其所有数据，此操作不可撤销。`
                    : `将清空分区 "${confirm.partition}" 的所有数据，此操作不可撤销。`
                  }
                  <br />输入分区名 <b>{confirm.partition}</b> 以确认：
                </p>
                <input
                  value={confirmInput}
                  onChange={e => setConfirmInput(e.target.value)}
                  placeholder={confirm.partition}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, marginBottom: 12 }}
                  autoFocus
                />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn-cancel" onClick={() => { setConfirm(null); setConfirmInput('') }}>取消</button>
                  <button
                    className="btn-danger"
                    disabled={confirmInput !== confirm.partition || acting}
                    onClick={doAction}
                  >
                    {confirm.type === 'drop' ? '删除分区' : '清空分区'}
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )}

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
                {['分区名', '分区方式', '描述/范围', '行数', '大小(MB)', '操作'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parts.map((p, i) => (
                <tr key={i} className="hover-row" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td style={{ padding: '8px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{p.name}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{p.method || '—'}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{p.description || '—'}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{p.rowCount.toLocaleString()}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>{p.dataLengthMb.toFixed(2)}</td>
                  <td style={{ padding: '8px 12px' }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        className="dbt-header-btn"
                        title="清空分区数据"
                        style={{ color: 'var(--warning)' }}
                        onClick={() => { setConfirm({ type: 'truncate', partition: p.name }); setConfirmInput('') }}
                      >
                        清空
                      </button>
                      <button
                        className="dbt-header-btn"
                        title="删除分区"
                        style={{ color: 'var(--error)' }}
                        onClick={() => { setConfirm({ type: 'drop', partition: p.name }); setConfirmInput('') }}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {parts.length === 0 && !loading && (
                <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>该表没有分区或不支持分区查询</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)' }}>
          删除/清空分区为不可撤销高危操作，请确认数据已备份
        </div>
      </div>
    </div>,
    document.body
  )
}
