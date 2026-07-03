import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileCode2, X, Copy, Loader2, HardDrive } from 'lucide-react'
import type { ConnType } from '../../types'
import SqlCodeView from '../common/SqlCodeView'
import { formatBytes } from '../../utils/format'

interface Props {
  schema: string
  table: string
  ddl: string
  loading: boolean
  error: string
  connType?: ConnType | string
  /** 传入连接 ID 后，弹窗自动拉取并在标题旁展示该表的占用大小 + 行数 */
  connectionId?: string
  onClose: () => void
}

export default function DdlModal({ schema, table, ddl, loading, error, connType, connectionId, onClose }: Props) {
  const [size, setSize] = useState<string>('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!connectionId) return
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<{ name: string; rowCount: number; dataLength: number; indexLength: number }[]>(
          'list_tables_meta', { id: connectionId, schema })
        const m = list.find(t => t.name === table)
        if (alive && m && (m.dataLength + m.indexLength) > 0) {
          setSize(`${formatBytes(m.dataLength + m.indexLength)} · ${m.rowCount.toLocaleString()} 行`)
        }
      } catch { /* 大小展示为可选信息，失败忽略 */ }
    })()
    return () => { alive = false }
  }, [connectionId, schema, table])

  return createPortal(
    <div className="modal-overlay">
      <div className="modal-box ddl-modal">
        <div className="modal-header">
          <span className="modal-title">
            <FileCode2 size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
            {schema ? `${schema}.` : ''}{table} — DDL
            {size && (
              <span style={{ marginLeft: 10, fontSize: 11, color: 'var(--text-muted)', fontWeight: 'normal', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <HardDrive size={11} style={{ color: 'var(--accent)' }} />{size}
              </span>
            )}
          </span>
          <button className="modal-close" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="ddl-modal__body">
          {loading && (
            <div className="result-placeholder" style={{ padding: 40 }}>
              <Loader2 size={16} className="spin" /><span>获取 DDL…</span>
            </div>
          )}
          {error && <div className="result-error" style={{ margin: 16 }}>{error}</div>}
          {!loading && !error && (
            ddl
              ? <SqlCodeView code={ddl} connType={connType} className="ddl-modal__code-cm" />
              : <pre className="ddl-modal__code">（无 DDL）</pre>
          )}
        </div>
        {!loading && !error && ddl && (
          <div className="ddl-modal__footer">
            <button
              className="ddl-modal__copy-btn"
              onClick={() => navigator.clipboard.writeText(ddl).catch(() => {})}
            >
              <Copy size={12} />复制
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
