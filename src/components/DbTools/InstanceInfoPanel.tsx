import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Server, RefreshCw } from 'lucide-react'

interface Props {
  connectionId: string
  schema: string
  onClose: () => void
}

interface InstanceInfo {
  version: string
  versionFull: string
  uptimeSecs: number
  charset: string
  timezone: string
  maxConn: number
  currConn: number
  dbSizeBytes: number
}

function fmtUptime(secs: number): string {
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const parts = []
  if (d > 0) parts.push(`${d} 天`)
  if (h > 0) parts.push(`${h} 小时`)
  parts.push(`${m} 分钟`)
  return parts.join(' ')
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{
      background: 'var(--surface-2)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '14px 18px',
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-bright)', wordBreak: 'break-all' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

export default function InstanceInfoPanel({ connectionId, schema, onClose }: Props) {
  const [info, setInfo] = useState<InstanceInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<InstanceInfo>('db_instance_info', { id: connectionId, schema })
      setInfo(res)
      setError('')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 580, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Server size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>实例信息</span>
          {schema && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>{schema}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={load} style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4 }}><RefreshCw size={14} /></button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
          ) : error ? (
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6 }}>{error}</div>
          ) : info ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Card label="版本" value={info.version} sub={info.versionFull} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Card label="运行时间" value={fmtUptime(info.uptimeSecs)} />
                <Card label="当前库大小" value={fmtBytes(info.dbSizeBytes)} sub={schema || '(全部)'} />
                <Card label="连接数" value={`${info.currConn} / ${info.maxConn}`} sub="当前 / 最大" />
                <Card label="字符集" value={info.charset} />
                <Card label="时区" value={info.timezone} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  )
}
