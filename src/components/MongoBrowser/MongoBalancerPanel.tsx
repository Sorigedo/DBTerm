// MO11.1 分片 Balancer 活动窗口
import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, Scale, Loader2, Save, RotateCcw } from 'lucide-react'

interface Props {
  connectionId: string
  onClose: () => void
}

interface BalancerWindow {
  enabled: boolean
  hasWindow: boolean
  start: string
  stop: string
}

export default function MongoBalancerPanel({ connectionId, onClose }: Props) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [win, setWin] = useState<BalancerWindow | null>(null)
  const [start, setStart] = useState('')
  const [stop, setStop] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(''); setOk('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const w = await invoke<BalancerWindow>('mongo_balancer_window_get', { id: connectionId })
      setWin(w); setStart(w.start); setStop(w.stop)
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }, [connectionId])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const apply = async (clear: boolean) => {
    setSaving(true); setError(''); setOk('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const w = await invoke<BalancerWindow>('mongo_balancer_window_set', {
        id: connectionId,
        start: clear ? '' : start.trim(),
        stop: clear ? '' : stop.trim(),
      })
      setWin(w); setStart(w.start); setStop(w.stop)
      setOk(clear ? '已清除活动窗口（恢复 7x24 平衡）' : `已设置活动窗口 ${w.start} – ${w.stop}`)
    } catch (e) { setError(String(e)) } finally { setSaving(false) }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 520, display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <Scale size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>Balancer 活动窗口</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            限定分片均衡器（Balancer）仅在指定时间段内运行，避开业务高峰。仅分片集群（mongos）有效。
          </div>

          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
              <Loader2 size={13} className="spin" /> 读取中…
            </div>
          ) : win && (
            <>
              <div style={{ fontSize: 12, color: 'var(--text)' }}>
                Balancer 状态：<span style={{ color: win.enabled ? 'var(--success)' : '#ea580c', fontWeight: 600 }}>{win.enabled ? '已启用' : '已停用'}</span>
                <span style={{ marginLeft: 14 }}>当前窗口：</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{win.hasWindow ? `${win.start} – ${win.stop}` : '未设置（全天平衡）'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 64 }}>开始</span>
                <input value={start} onChange={e => setStart(e.target.value)} placeholder="HH:MM 如 01:00"
                  style={{ width: 120, padding: '5px 8px', fontSize: 12, fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 12 }}>结束</span>
                <input value={stop} onChange={e => setStop(e.target.value)} placeholder="HH:MM 如 06:00"
                  style={{ width: 120, padding: '5px 8px', fontSize: 12, fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
              </div>
            </>
          )}

          {error && <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6 }}>{error}</div>}
          {ok && <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--success)', background: 'rgba(22,163,74,0.08)', borderRadius: 6 }}>✓ {ok}</div>}
        </div>

        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-subtle)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={() => apply(true)} disabled={saving || loading}
            style={{ padding: '6px 14px', fontSize: 12, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, cursor: (saving || loading) ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            <RotateCcw size={13} /> 清除窗口
          </button>
          <button onClick={() => apply(false)} disabled={saving || loading}
            style={{ padding: '6px 16px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: (saving || loading) ? 'not-allowed' : 'pointer', opacity: (saving || loading) ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            {saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />} 保存窗口
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
