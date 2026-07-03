// MO8.4 逻辑备份（BSON）
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Database, Loader2, FolderOpen } from 'lucide-react'

interface Props {
  connectionId: string
  db: string
  onClose: () => void
}

interface CollInfo { name: string }
interface BackupResult { collections: number; totalDocs: number; outputDir: string; files: string[] }

export default function MongoBackupPanel({ connectionId, db, onClose }: Props) {
  const [colls, setColls] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [outputDir, setOutputDir] = useState('')
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<BackupResult | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const res = await invoke<CollInfo[]>('mongo_list_collections', { id: connectionId, db })
        setColls(res.map(c => c.name))
      } catch (e) { setError(String(e)) } finally { setLoading(false) }
    })()
  }, [connectionId, db])

  const pickDir = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const dir = await open({ directory: true, title: '选择备份输出目录' })
    if (typeof dir === 'string') setOutputDir(dir)
  }

  const run = async () => {
    if (!outputDir) { setError('请选择输出目录'); return }
    setRunning(true); setError(''); setResult(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<BackupResult>('mongo_logical_backup', {
        id: connectionId, db,
        colls: selected.size ? [...selected] : [],
        outputDir,
      })
      setResult(res)
    } catch (e) { setError(String(e)) } finally { setRunning(false) }
  }

  const toggle = (c: string) => setSelected(s => { const n = new Set(s); n.has(c) ? n.delete(c) : n.add(c); return n })

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 620, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Database size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>逻辑备份（BSON）· {db}</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>输出目录</span>
          <input value={outputDir} readOnly placeholder="选择目录…" style={{ flex: 1, padding: '5px 8px', fontSize: 12, fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
          <button onClick={pickDir} style={{ padding: '5px 10px', fontSize: 12, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}><FolderOpen size={13} /> 浏览</button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          {loading ? <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 24 }}>加载集合…</div>
          : error ? <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6 }}>{error}</div>
          : result ? (
            <div style={{ fontSize: 12, color: 'var(--text)' }}>
              <div style={{ color: 'var(--success)', marginBottom: 8 }}>✓ 备份完成：{result.collections} 个集合，{result.totalDocs} 文档 → {result.outputDir}</div>
              {result.files.map((f, i) => <div key={i} style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{f}</div>)}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>选择要备份的集合（不选=全部 {colls.length} 个）</div>
              {colls.map(c => (
                <label key={c} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 0', cursor: 'pointer', color: 'var(--text)' }}>
                  <input type="checkbox" checked={selected.has(c)} onChange={() => toggle(c)} />
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{c}</span>
                </label>
              ))}
            </>
          )}
        </div>

        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-subtle)', flexShrink: 0, display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={run} disabled={running}
            style={{ padding: '6px 16px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: running ? 'not-allowed' : 'pointer', opacity: running ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            {running ? <Loader2 size={13} className="spin" /> : null} 开始备份
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
