import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { Trash2, RefreshCw, X, ShieldCheck } from 'lucide-react'

interface Props {
  onClose: () => void
}

export default function KnownHostsManager({ onClose }: Props) {
  const [hosts, setHosts] = useState<[string, string][]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const list = await invoke<[string, string][]>('list_known_hosts')
      setHosts(list)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function doDelete(hostPort: string) {
    setDeleting(hostPort)
    try {
      await invoke('delete_known_host', { hostPort })
      setHosts(h => h.filter(([k]) => k !== hostPort))
    } catch { /* ignore */ }
    finally {
      setDeleting(null)
      setConfirm(null)
    }
  }

  return createPortal(
    <div className="modal-overlay">
      <div className="modal-box" style={{ width: 560 }}>
        <div className="modal-header">
          <span className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldCheck size={16} style={{ color: 'var(--accent)' }} />
            已信任主机（known_hosts）
          </span>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="modal-body" style={{ padding: '0', gap: 0, minHeight: 200, maxHeight: 420 }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 160, color: 'var(--text-muted)', fontSize: 13 }}>
              <RefreshCw size={14} className="spin" style={{ marginRight: 8 }} />加载中…
            </div>
          ) : hosts.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 160, color: 'var(--text-muted)', fontSize: 13 }}>
              暂无已信任主机
            </div>
          ) : (
            <div style={{ overflowY: 'auto', maxHeight: 420 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                    <th style={{ padding: '8px 16px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border-subtle)' }}>主机 : 端口</th>
                    <th style={{ padding: '8px 16px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border-subtle)' }}>密钥指纹</th>
                    <th style={{ width: 48, borderBottom: '1px solid var(--border-subtle)' }} />
                  </tr>
                </thead>
                <tbody>
                  {hosts.map(([hostPort, fingerprint]) => (
                    <tr key={hostPort} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '9px 16px', color: 'var(--text)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                        {hostPort}
                      </td>
                      <td style={{ padding: '9px 16px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11, wordBreak: 'break-all' }}>
                        {fingerprint}
                      </td>
                      <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                        <button
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', borderRadius: 5, padding: '3px 5px', transition: 'color 0.1s, background 0.1s' }}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#dc2626'; (e.currentTarget as HTMLElement).style.background = '#fef2f2' }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'; (e.currentTarget as HTMLElement).style.background = 'none' }}
                          onClick={() => setConfirm(hostPort)}
                          title="删除该信任记录"
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-cancel" style={{ display: 'flex', alignItems: 'center', gap: 6 }} onClick={load}>
            <RefreshCw size={13} />刷新
          </button>
          <button className="btn-cancel" onClick={onClose}>关闭</button>
        </div>
      </div>

      {/* 删除确认 */}
      {confirm && (
        <div className="modal-overlay" style={{ zIndex: 1100 }}>
          <div className="modal-box" style={{ width: 380 }}>
            <div className="modal-header">
              <span className="modal-title" style={{ color: '#dc2626' }}>删除信任记录</span>
              <button className="modal-close" onClick={() => setConfirm(null)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'var(--text)', margin: 0 }}>
                删除 <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 4 }}>{confirm}</code> 的信任记录后，下次连接该主机时需要重新验证指纹。
              </p>
            </div>
            <div className="modal-footer" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn-cancel" onClick={() => setConfirm(null)}>取消</button>
              <button
                className="btn-danger"
                disabled={deleting === confirm}
                onClick={() => doDelete(confirm)}
              >
                {deleting === confirm ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  )
}
