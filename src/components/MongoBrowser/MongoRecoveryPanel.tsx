// MO11.3 误删恢复引导（只读诊断，不执行恢复）
import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, LifeBuoy, Loader2, AlertTriangle } from 'lucide-react'

interface Props {
  connectionId: string
  onClose: () => void
}

interface RecoveryGuide {
  isReplicaSet: boolean
  setName: string
  oplogAvailable: boolean
  oplogFirstTs: string
  oplogLastTs: string
  oplogWindowHint: string
  steps: string[]
  warnings: string[]
}

function fmtTs(s: string): string {
  const n = parseInt(s, 10)
  if (!n) return '—'
  try { return new Date(n * 1000).toLocaleString() } catch { return s }
}

export default function MongoRecoveryPanel({ connectionId, onClose }: Props) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [guide, setGuide] = useState<RecoveryGuide | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const g = await invoke<RecoveryGuide>('mongo_recovery_guide', { id: connectionId })
      setGuide(g)
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }, [connectionId])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 640, maxHeight: '80vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <LifeBuoy size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>误删恢复引导</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
              <Loader2 size={13} className="spin" /> 诊断中…
            </div>
          ) : error ? (
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6 }}>{error}</div>
          ) : guide && (
            <>
              <div style={{ fontSize: 12, color: 'var(--text)', display: 'flex', flexWrap: 'wrap', gap: '6px 18px' }}>
                <span>部署：<b style={{ color: 'var(--text-bright)' }}>{guide.isReplicaSet ? `副本集 ${guide.setName}` : '单机'}</b></span>
                <span>oplog：<b style={{ color: guide.oplogAvailable ? 'var(--success)' : '#ea580c' }}>{guide.oplogAvailable ? '可用' : '不可用'}</b></span>
                {guide.oplogAvailable && <span>{guide.oplogWindowHint}</span>}
              </div>
              {guide.oplogAvailable && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  oplog 范围：{fmtTs(guide.oplogFirstTs)} ~ {fmtTs(guide.oplogLastTs)}
                </div>
              )}

              {guide.warnings.map((w, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, padding: '8px 12px', fontSize: 12, color: '#ea580c', background: 'rgba(234,88,12,0.08)', borderRadius: 6 }}>
                  <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /> <span>{w}</span>
                </div>
              ))}

              <div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>推荐恢复步骤</div>
                <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {guide.steps.map((s, i) => (
                    <li key={i} style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.6 }}>{s}</li>
                  ))}
                </ol>
              </div>
            </>
          )}
        </div>

        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose}
            style={{ padding: '6px 16px', fontSize: 12, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer' }}>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
