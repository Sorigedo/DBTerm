import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useQueryStore } from '../../stores/queryStore'
import { getObjectSave } from '../../utils/objectSaveRegistry'
import { addSavedQuery, renameSavedQuery, updateSavedQuery } from '../../utils/savedQueries'
import { toast } from '../../stores/toastStore'

/**
 * 通用关闭确认弹窗：
 * - 对象编辑页（视图/函数/存过）有未保存修改 → 保存并关闭 / 不保存 / 取消
 * - 查询页有 SQL → 保存到查询库 / 不保存关闭 / 取消
 */
export default function CloseConfirmModal() {
  const closeConfirm = useAppStore((s) => s.closeConfirm)
  const tabs = useAppStore((s) => s.tabs)
  const closeTab = useAppStore((s) => s.closeTab)
  const cancel = useAppStore((s) => s.cancelCloseConfirm)
  const renameTab = useAppStore((s) => s.renameTab)
  const setTabDirty = useAppStore((s) => s.setTabDirty)
  const setTabMeta = useAppStore((s) => s.setTabMeta)
  const tab = tabs.find((t) => t.id === closeConfirm)

  useEffect(() => {
    if (!closeConfirm) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [closeConfirm, cancel])

  if (!closeConfirm || !tab) return null
  const isEditor = tab.type === 'object-editor'

  async function saveAndClose() {
    if (!tab) return
    if (isEditor) {
      const fn = getObjectSave(tab.id)
      const ok = fn ? await fn() : false
      if (ok) closeTab(tab.id)   // 保存失败时保留弹窗与标签，错误已在编辑页提示
    } else {
      const sql = useQueryStore.getState().sqls[tab.id] ?? ''
      const savedId = tab.meta?.savedQueryId
      const savedName = tab.meta?.savedQueryName || tab.title
      if (savedId) {
        updateSavedQuery(savedId, sql.trim())
        renameSavedQuery(savedId, savedName)
        setTabMeta(tab.id, { savedSqlBaseline: sql, savedQueryId: savedId, savedQueryName: savedName })
        renameTab(tab.id, savedName)
        toast.success(`已更新保存的查询：${savedName}`)
      } else {
        const saved = addSavedQuery({ name: tab.title, sql: sql.trim(), connId: tab.connectionId }, Date.now())
        setTabMeta(tab.id, { savedSqlBaseline: sql, savedQueryId: saved.id, savedQueryName: saved.name })
        toast.success(`已保存到查询库：${tab.title}`)
      }
      setTabDirty(tab.id, false)
      closeTab(tab.id)
    }
  }

  return createPortal(
    <div className="modal-overlay" onMouseDown={cancel}>
      <div className="modal-box modal-box--sm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={15} style={{ color: 'var(--warning, #ea580c)' }} />
            {isEditor ? '未保存的修改' : '关闭查询'}
          </span>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>
            {isEditor
              ? <>「<strong>{tab.title}</strong>」有未保存的修改，关闭前是否保存？</>
              : <>「<strong>{tab.title}</strong>」的 SQL 关闭后将不再保留，是否保存到查询库？</>}
          </p>
        </div>
        <div className="modal-footer cf-footer">
          <div className="cf-footer-actions">
            <button className="btn-cancel" onClick={cancel}>取消</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-cancel" onClick={() => closeTab(tab.id)}>不保存</button>
              <button className="btn-save" onClick={saveAndClose}>
                {isEditor ? '保存并关闭' : '保存到查询库'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
