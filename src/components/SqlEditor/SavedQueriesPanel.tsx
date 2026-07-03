import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Bookmark, X } from 'lucide-react'
import { addSavedQuery, updateSavedQuery, renameSavedQuery } from '../../utils/savedQueries'
import { toast } from '../../stores/toastStore'

interface Props {
  connectionId: string
  schema?: string
  /** 要保存的 SQL（整个查询标签或选中片段，由调用方决定，无需手动粘贴） */
  sql: string
  /** 是否保存的是「选中片段」（选中时必须命名；整标签默认用首行做名字） */
  isSelection: boolean
  /** 整标签保存时的默认名字（首行/标签标题） */
  defaultName?: string
  savedQueryId?: string
  onSaved?: (saved: { id: string; name: string }) => void
  onClose: () => void
}

// 简化的「保存查询」对话框：SQL 自动带入，只需确认名字与范围
export default function SavedQueriesPanel({ connectionId, schema, sql, isSelection, defaultName, savedQueryId, onSaved, onClose }: Props) {
  const [name, setName] = useState(defaultName ?? '')
  const [global, setGlobal] = useState(false)

  const trimmed = sql.trim()
  const canSave = trimmed.length > 0 && (!isSelection || name.trim().length > 0)

  const doSave = () => {
    if (!canSave) return
    if (savedQueryId && !isSelection) {
      const nextName = name.trim() || defaultName || '未命名查询'
      updateSavedQuery(savedQueryId, trimmed)
      renameSavedQuery(savedQueryId, nextName)
      onSaved?.({ id: savedQueryId, name: nextName })
      toast.success('已更新保存的查询')
      onClose()
      return
    }
    const saved = addSavedQuery({
      name: name.trim() || defaultName || '未命名查询',
      sql: trimmed,
      connId: global ? '' : connectionId,
      schema: global ? undefined : schema,
    }, Date.now())
    onSaved?.({ id: saved.id, name: saved.name })
    toast.success('已保存查询')
    onClose()
  }

  return createPortal(
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal-box modal-box--sm" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Bookmark size={15} color="var(--accent)" />保存查询
          </span>
          <button className="modal-close" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
            {savedQueryId && !isSelection ? '更新当前保存查询的 SQL' : isSelection ? '保存选中的 SQL 片段' : '保存整个查询标签的 SQL'}（打开时会还原内容）
          </p>
          <input
            className="dbtool-input" style={{ width: '100%' }}
            value={name} autoFocus
            placeholder={isSelection ? '为这段查询取个名字' : '查询名称（默认取首行）'}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && canSave) doSave() }}
          />
          {!savedQueryId && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text)', cursor: 'pointer' }}>
              <input type="checkbox" checked={global} onChange={e => setGlobal(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
              存为全局（所有连接下都显示），不勾选则挂在当前连接下
            </label>
          )}
          {/* SQL 预览（只读，便于确认） */}
          <pre style={{ margin: 0, maxHeight: 120, overflow: 'auto', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{trimmed || '（空）'}</pre>
        </div>
        <div className="modal-footer cf-footer">
          <div className="cf-footer-actions">
            <div />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-cancel" onClick={onClose}>取消</button>
              <button style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600, opacity: canSave ? 1 : 0.4 }}
                disabled={!canSave} onClick={doSave}>保存</button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
