// MO2 GridFS 文件管理
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, FileBox, RefreshCw, Upload, Download, Trash2 } from 'lucide-react'
import ConfirmDialog from '../shared/ConfirmDialog'

interface Props {
  connectionId: string
  db: string
  onClose: () => void
}

interface GridFsFile { id: string; filename: string; length: number; chunkSize: number; uploadDate: string }

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1073741824) return `${(b / 1048576).toFixed(2)} MB`
  return `${(b / 1073741824).toFixed(2)} GB`
}

export default function MongoGridFsPanel({ connectionId, db, onClose }: Props) {
  const [files, setFiles] = useState<GridFsFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [delTarget, setDelTarget] = useState<GridFsFile | null>(null)

  const load = async () => {
    setLoading(true); setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<GridFsFile[]>('mongo_gridfs_list', { id: connectionId, db })
      setFiles(res)
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [connectionId, db])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const upload = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const picked = await open({ multiple: false, title: '选择上传文件' })
      if (typeof picked !== 'string') return
      const filename = picked.replace(/\\/g, '/').split('/').pop() || 'upload.bin'
      setBusy('上传中…')
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('mongo_gridfs_upload', { id: connectionId, db, localPath: picked, filename })
      await load()
    } catch (e) { setError(String(e)) } finally { setBusy('') }
  }

  const download = async (f: GridFsFile) => {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const dest = await save({ title: '下载到', defaultPath: f.filename })
      if (!dest) return
      setBusy('下载中…')
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('mongo_gridfs_download', { id: connectionId, db, fileId: f.id, destPath: dest })
    } catch (e) { setError(String(e)) } finally { setBusy('') }
  }

  const doDelete = async () => {
    if (!delTarget) return
    try {
      setBusy('删除中…')
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('mongo_gridfs_delete', { id: connectionId, db, fileId: delTarget.id })
      setDelTarget(null)
      await load()
    } catch (e) { setError(String(e)) } finally { setBusy('') }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 760, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <FileBox size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>GridFS 文件管理 · {db}</span>
          {busy && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{busy}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={upload} data-tip="上传" style={{ color: 'var(--accent)', lineHeight: 0, padding: 4 }}><Upload size={15} /></button>
            <button onClick={load} data-tip="刷新" style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4 }}><RefreshCw size={14} /></button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: loading || error ? 16 : 0 }}>
          {loading ? <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 24 }}>加载中…</div>
          : error ? <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6 }}>{error}</div>
          : files.length === 0 ? <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 24 }}>无 GridFS 文件（点右上角上传）</div>
          : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                <tr>
                  <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>文件名</th>
                  <th style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', width: 90 }}>大小</th>
                  <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', width: 170 }}>上传时间</th>
                  <th style={{ padding: '7px 12px', width: 70 }}></th>
                </tr>
              </thead>
              <tbody>
                {files.map(f => (
                  <tr key={f.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '5px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{f.filename}</td>
                    <td style={{ padding: '5px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>{fmtBytes(f.length)}</td>
                    <td style={{ padding: '5px 12px', color: 'var(--text-muted)' }}>{f.uploadDate.slice(0, 19).replace('T', ' ')}</td>
                    <td style={{ padding: '5px 12px', display: 'flex', gap: 8 }}>
                      <button onClick={() => download(f)} title="下载" style={{ color: 'var(--accent)', lineHeight: 0 }}><Download size={14} /></button>
                      <button onClick={() => setDelTarget(f)} title="删除" style={{ color: '#dc2626', lineHeight: 0 }}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {delTarget && (
        <ConfirmDialog
          open
          title="删除 GridFS 文件"
          desc={`确定删除文件 "${delTarget.filename}"？此操作不可恢复。`}
          okText="删除"
          danger
          onOk={doDelete}
          onCancel={() => setDelTarget(null)}
        />
      )}
    </div>,
    document.body
  )
}
