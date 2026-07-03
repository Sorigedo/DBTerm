import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Network, RefreshCw, CheckCircle2, MinusCircle } from 'lucide-react'

interface Props {
  connectionId: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface MaxScaleInfo {
  isMaxscale: boolean
  version: string
  versionComment: string
  note: string
}

export default function MaxScalePanel({ connectionId, onClose, embedded }: Props) {
  const [info, setInfo] = useState<MaxScaleInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<MaxScaleInfo>('mariadb_maxscale_detect', { id: connectionId })
      setInfo(res); setError('')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    if (embedded) return   // 嵌入时由 DBA 面板统一处理 Esc
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, embedded])

  const inner = (
    <>
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>探测中…</div>
        ) : error ? (
          <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6 }}>{error}</div>
        ) : info ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10 }}>
              {info.isMaxscale
                ? <CheckCircle2 size={22} color="#16a34a" />
                : <MinusCircle size={22} color="var(--text-muted)" />}
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: info.isMaxscale ? '#16a34a' : 'var(--text)' }}>
                  {info.isMaxscale ? '检测到 MaxScale' : '未检测到 MaxScale 特征'}
                </div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)' }}>@@version</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)', wordBreak: 'break-all' }}>{info.version || '—'}</span>
              <span style={{ color: 'var(--text-muted)' }}>@@version_comment</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)', wordBreak: 'break-all' }}>{info.versionComment || '—'}</span>
            </div>
            <div style={{ padding: '10px 12px', fontSize: 11, lineHeight: 1.6, color: 'var(--text-muted)', background: 'rgba(234,88,12,0.05)', border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
              {info.note}
            </div>
          </div>
        ) : null}
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
        style={{ width: 560, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Network size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>MaxScale 中间件探测</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={load} style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4 }}><RefreshCw size={14} /></button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}
