import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Eye, X, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { requireProdConfirm } from '../../stores/confirmStore'

interface Props {
  connectionId: string
  schema: string
  table: string
  onClose: () => void
}

export default function ViewEditorModal({ connectionId, schema, table, onClose }: Props) {
  const [ddl, setDdl] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [applying, setApplying] = useState(false)
  const [success, setSuccess] = useState(false)
  const [confirm, setConfirm] = useState(false)

  useEffect(() => {
    ;(async () => {
      setLoading(true)
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const raw = await invoke<string>('get_table_ddl', { id: connectionId, schema, table })
        setDdl(raw)
      } catch (e) {
        setError(String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [connectionId, schema, table])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const apply = async () => {
    const conn = useAppStore.getState().connections.find(c => c.id === connectionId)
    if (!(await requireProdConfirm(conn, `修改视图 ${schema}.${table}`, ddl))) return
    setApplying(true)
    setError('')
    setSuccess(false)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('execute_query', { id: connectionId, schema, sql: ddl })
      setSuccess(true)
      setConfirm(false)
      setTimeout(() => setSuccess(false), 3000)
    } catch (e) {
      setError(String(e))
      setConfirm(false)
    } finally {
      setApplying(false)
    }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 720, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Eye size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>
            编辑视图 — {schema ? `${schema}.` : ''}{table}
          </span>
          <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
        </div>

        {/* Editor body */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {loading ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 12 }}>
              <Loader2 size={14} className="spin" /> 获取视图定义…
            </div>
          ) : (
            <textarea
              value={ddl}
              onChange={e => setDdl(e.target.value)}
              spellCheck={false}
              style={{
                flex: 1, resize: 'none', border: 'none', outline: 'none',
                fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7,
                background: 'var(--bg)', color: 'var(--text)',
                padding: '12px 16px',
              }}
            />
          )}
        </div>

        {/* Error / success */}
        {error && (
          <div className="dlg-alert-error" style={{ margin: '0 16px 8px', borderRadius: 7 }}>
            <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)' }}>{error}</span>
          </div>
        )}
        {success && (
          <div className="dlg-alert-success" style={{ margin: '0 16px 8px', borderRadius: 7, alignItems: 'center' }}>
            <CheckCircle size={12} style={{ flexShrink: 0 }} /> 视图已更新
          </div>
        )}

        {/* Footer */}
        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>
            编辑 DDL 后点击"应用视图"，将在数据库执行 CREATE OR REPLACE VIEW / CREATE VIEW
          </span>
          {confirm ? (
            <>
              <span style={{ fontSize: 12, color: 'var(--warning)' }}>确认替换视图定义？</span>
              <button
                onClick={() => setConfirm(false)}
                className="cdlg-btn cdlg-btn--cancel"
                style={{ padding: '5px 12px', fontSize: 12 }}
              >
                取消
              </button>
              <button
                onClick={apply}
                disabled={applying}
                className="cdlg-btn cdlg-btn--ok"
                style={{ padding: '5px 14px', fontSize: 12, opacity: applying ? 0.7 : 1 }}
              >
                {applying ? '执行中…' : '确认应用'}
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirm(true)}
              disabled={loading || applying || !ddl.trim()}
              className="cdlg-btn cdlg-btn--ok"
              style={{ padding: '5px 14px', fontSize: 12, opacity: (loading || applying || !ddl.trim()) ? 0.5 : 1 }}
            >
              应用视图
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
