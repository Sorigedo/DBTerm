import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Eye } from 'lucide-react'
import type { ConnType } from '../../types'
import { useAppStore } from '../../stores/appStore'
import { useObjectDraftStore } from '../../stores/objectDraftStore'
import { buildNewViewDdl } from '../../utils/objectEditor'
import { wid } from '../../utils/windowTag'

interface Props {
  connectionId: string
  connType: ConnType
  schema: string
  onClose: () => void
}

let objSeq = 0

export default function ViewWizard({ connectionId, connType, schema, onClose }: Props) {
  const [name, setName] = useState('')
  const openTab = useAppStore((s) => s.openTab)
  const setDraft = useObjectDraftStore((s) => s.setDraft)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function finish() {
    const n = name.trim() || 'new_view'
    // 不带库限定：目标库由设计页的 schema 下拉 + execute_query 的 database 参数决定
    // 与「编辑视图」走同一套格式化（buildNewViewDdl），保证新建与保存后再打开样式一致
    const ddl = await buildNewViewDdl(connType, n)
    objSeq += 1
    const tabId = wid(`${connectionId}-objedit-${objSeq}`)
    setDraft(tabId, { schema, objType: 'view', name: n, ddl, mode: 'create' })
    openTab({ id: tabId, connectionId, title: `新建视图 - ${n}`, type: 'object-editor' })
    onClose()
  }

  return createPortal(
    <div className="dbtool-overlay" onMouseDown={onClose}>
      <div className="dbtool-modal" onMouseDown={(e) => e.stopPropagation()} style={{ width: 440 }}>
        <div className="dbtool-modal__header">
          <Eye size={15} color="var(--accent)" />
          <span className="dbtool-modal__title">视图向导</span>
          <button className="dbtool-modal__close" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="dbtool-modal__body">
          <div className="dbtool-field">
            <label className="dbtool-label">视图名称</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') finish() }}
              placeholder="例如：v_active_users"
              className="dbtool-input"
            />
          </div>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
            完成后将在 {schema || '当前库'} 中打开视图设计页，编写 SELECT 后保存。
          </p>
        </div>
        <div className="dbtool-modal__footer">
          <button className="dbtool-btn dbtool-btn--cancel" onClick={onClose}>取消</button>
          <button className="dbtool-btn dbtool-btn--primary" onClick={finish}>完成</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
