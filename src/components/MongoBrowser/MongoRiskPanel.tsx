// MO10.2 配置风险扫描
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, ShieldAlert, RefreshCw, AlertTriangle, AlertCircle, Info } from 'lucide-react'

interface Props {
  connectionId: string
  onClose: () => void
}

interface RiskItem { level: string; item: string; detail: string; suggestion: string }

const LEVEL: Record<string, { color: string; label: string; Icon: typeof AlertTriangle }> = {
  high:   { color: '#dc2626', label: '高危', Icon: AlertTriangle },
  medium: { color: '#ea580c', label: '中', Icon: AlertCircle },
  low:    { color: '#ca8a04', label: '低', Icon: Info },
  info:   { color: 'var(--text-muted)', label: '信息', Icon: Info },
}

export default function MongoRiskPanel({ connectionId, onClose }: Props) {
  const [risks, setRisks] = useState<RiskItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true); setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<RiskItem[]>('mongo_config_risks', { id: connectionId })
      setRisks(res)
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [connectionId])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 640, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <ShieldAlert size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>配置风险扫描</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={load} style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4 }}><RefreshCw size={14} /></button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {loading ? <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 24 }}>扫描中…</div>
          : error ? <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6 }}>{error}</div>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {risks.map((r, i) => {
                const lv = LEVEL[r.level] ?? LEVEL.info
                const Icon = lv.Icon
                return (
                  <div key={i} style={{ display: 'flex', gap: 10, padding: '10px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10 }}>
                    <Icon size={16} color={lv.color} style={{ flexShrink: 0, marginTop: 1 }} />
                    <div style={{ flex: 1, fontSize: 12 }}>
                      <div style={{ fontWeight: 600, color: 'var(--text-bright)' }}>
                        <span style={{ color: lv.color, marginRight: 6 }}>[{lv.label}]</span>{r.item}
                      </div>
                      <div style={{ color: 'var(--text-muted)', marginTop: 3 }}>{r.detail}</div>
                      {r.suggestion && <div style={{ color: 'var(--accent)', marginTop: 3 }}>建议：{r.suggestion}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
