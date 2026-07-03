// MO11.2 Change Streams 调试器（实时订阅集合变更流）
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, Radio, Play, Square, Trash2 } from 'lucide-react'

interface Props {
  connectionId: string
  db: string
  coll: string
  onClose: () => void
}

interface ChangeEvt {
  seq: number
  op: string
  id: string
  ts: string
  raw: string
}

const OP_COLOR: Record<string, string> = {
  insert: '#16a34a', update: '#ea580c', replace: '#ea580c',
  delete: '#dc2626', drop: '#dc2626', invalidate: '#dc2626',
}

export default function MongoStreamPanel({ connectionId, db, coll, onClose }: Props) {
  const [watching, setWatching] = useState(false)
  const [events, setEvents] = useState<ChangeEvt[]>([])
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)
  const watchIdRef = useRef(`w${Date.now()}`)
  const unlistenRef = useRef<(() => void) | null>(null)
  const seqRef = useRef(0)

  const stop = async () => {
    if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null }
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('mongo_watch_stop', { watchId: watchIdRef.current })
    } catch { /* ignore */ }
    setWatching(false)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const start = async () => {
    setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const { listen } = await import('@tauri-apps/api/event')
      const wid = watchIdRef.current
      const un = await listen<string>(`mongo-change-${wid}`, (ev) => {
        let op = '?', id = ''
        try {
          const o = JSON.parse(ev.payload)
          op = o.operationType ?? o.operation_type ?? '?'
          const dk = o.documentKey ?? o.document_key
          id = dk?._id ? (typeof dk._id === 'object' ? JSON.stringify(dk._id) : String(dk._id)) : ''
        } catch { /* keep raw */ }
        seqRef.current += 1
        const evt: ChangeEvt = { seq: seqRef.current, op, id, ts: new Date().toISOString().slice(11, 19), raw: ev.payload }
        setEvents(prev => [evt, ...prev].slice(0, 500))
      })
      const unErr = await listen<string>(`mongo-change-${wid}-error`, (ev) => { setError(String(ev.payload)); setWatching(false) })
      unlistenRef.current = () => { un(); unErr() }
      await invoke('mongo_watch_start', { id: connectionId, db, coll, watchId: wid })
      setWatching(true)
    } catch (e) {
      setError(String(e))
      if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null }
    }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 820, height: '80vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Radio size={15} color={watching ? '#16a34a' : 'var(--accent)'} />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>变更流调试器 · {db}.{coll}</span>
          {watching && <span style={{ fontSize: 11, color: '#16a34a' }}>● 监听中</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {watching
              ? <button onClick={stop} style={{ padding: '4px 10px', fontSize: 12, background: 'var(--surface-2)', color: '#dc2626', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}><Square size={12} /> 停止</button>
              : <button onClick={start} style={{ padding: '4px 10px', fontSize: 12, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}><Play size={12} /> 开始</button>}
            <button onClick={() => setEvents([])} title="清空" style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4 }}><Trash2 size={14} /></button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>

        {error && <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', flexShrink: 0 }}>{error}</div>}

        <div style={{ flex: 1, overflow: 'auto' }}>
          {events.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 32 }}>
              {watching ? '等待变更…（在该集合执行写操作触发）' : '点击「开始」订阅变更流（需 MongoDB 副本集环境）'}
            </div>
          ) : events.map(e => (
            <div key={e.seq} style={{ borderBottom: '1px solid var(--border-subtle)', padding: '6px 16px', fontSize: 12, cursor: 'pointer' }}
              onClick={() => setExpanded(expanded === e.seq ? null : e.seq)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', width: 60 }}>{e.ts}</span>
                <span style={{ color: OP_COLOR[e.op] ?? 'var(--text)', fontWeight: 600, width: 80 }}>{e.op}</span>
                <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>_id: {e.id}</span>
              </div>
              {expanded === e.seq && (
                <pre style={{ margin: '6px 0 0 70px', padding: 8, fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', borderRadius: 6, overflowX: 'auto', color: 'var(--text)' }}>
                  {(() => { try { return JSON.stringify(JSON.parse(e.raw), null, 2) } catch { return e.raw } })()}
                </pre>
              )}
            </div>
          ))}
        </div>

        <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
          共 {events.length} 条变更（最新在上，点击展开详情；最多保留 500 条）
        </div>
      </div>
    </div>,
    document.body
  )
}
