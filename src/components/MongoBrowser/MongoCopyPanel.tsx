// MO8.3 跨实例集合复制
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Copy, Loader2 } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import SearchableSelect from '../DbTools/SearchableSelect'

interface Props {
  connectionId: string
  db: string
  coll: string
  onClose: () => void
}

interface CopyResult { copied: number; droppedTarget: boolean }

export default function MongoCopyPanel({ connectionId, db, coll, onClose }: Props) {
  const connections = useAppStore(s => s.connections)
  const mongoConns = connections.filter(c => c.type === 'mongodb')
  const selfName = connections.find(c => c.id === connectionId)?.name ?? connectionId

  const [dstId, setDstId] = useState('')
  const [dstDb, setDstDb] = useState(db)
  const [dstColl, setDstColl] = useState(coll)
  const [dropTarget, setDropTarget] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<CopyResult | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async () => {
    if (!dstId) { setError('请选择目标实例'); return }
    if (!dstDb.trim() || !dstColl.trim()) { setError('请填写目标库和集合'); return }
    setRunning(true); setError(''); setResult(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<CopyResult>('mongo_copy_collection', {
        srcId: connectionId, srcDb: db, srcColl: coll,
        dstId, dstDb: dstDb.trim(), dstColl: dstColl.trim(), dropTarget,
      })
      setResult(res)
    } catch (e) { setError(String(e)) } finally { setRunning(false) }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 560, display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <Copy size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>跨实例集合复制</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            源：<span style={{ color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{selfName} / {db}.{coll}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 64 }}>目标实例</span>
            <SearchableSelect value={dstId} onChange={setDstId} width={320} mono={false}
              placeholder="选择目标 MongoDB 实例…"
              items={mongoConns.map(c => ({ value: c.id, label: c.id === connectionId ? `${c.name}（本实例）` : c.name }))} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 64 }}>目标库</span>
            <input value={dstDb} onChange={e => setDstDb(e.target.value)} style={{ flex: 1, padding: '5px 8px', fontSize: 12, fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>集合</span>
            <input value={dstColl} onChange={e => setDstColl(e.target.value)} style={{ flex: 1, padding: '5px 8px', fontSize: 12, fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', color: dropTarget ? '#ea580c' : 'var(--text)' }}>
            <input type="checkbox" checked={dropTarget} onChange={e => setDropTarget(e.target.checked)} />
            复制前清空目标集合（危险，会删除目标现有数据）
          </label>
          {error && <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6 }}>{error}</div>}
          {result && <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--success)', background: 'rgba(22,163,74,0.08)', borderRadius: 6 }}>✓ 已复制 {result.copied} 个文档{result.droppedTarget ? '（已先清空目标）' : ''}</div>}
        </div>

        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={run} disabled={running}
            style={{ padding: '6px 16px', fontSize: 12, fontWeight: 600, background: dropTarget ? '#ea580c' : 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: running ? 'not-allowed' : 'pointer', opacity: running ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            {running ? <Loader2 size={13} className="spin" /> : <Copy size={13} />} 开始复制
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
