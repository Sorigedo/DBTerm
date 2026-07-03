import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Info } from 'lucide-react'

interface Props {
  open: boolean
  title: string
  desc: string
  danger?: boolean
  okText?: string
  onOk: () => void
  onCancel: () => void
}

export default function ConfirmDialog({ open, title, desc, danger, okText = '确认', onOk, onCancel }: Props) {
  const okRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    setTimeout(() => okRef.current?.focus(), 30)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onCancel}>
      <div className="cdlg-box" onMouseDown={(e) => e.stopPropagation()}>
        {/* 标题行 */}
        <div className="cdlg-head">
          {danger
            ? <AlertTriangle size={15} className="cdlg-head__icon cdlg-head__icon--danger" />
            : <Info          size={15} className="cdlg-head__icon cdlg-head__icon--info" />
          }
          <span className="cdlg-head__title">{title}</span>
        </div>

        {/* 描述 */}
        <p className="cdlg-desc">{desc}</p>

        {/* 按钮区 */}
        <div className="cdlg-foot">
          <button className="cdlg-btn cdlg-btn--cancel" onClick={onCancel}>取消</button>
          <button
            ref={okRef}
            className={`cdlg-btn ${danger ? 'cdlg-btn--danger' : 'cdlg-btn--ok'}`}
            onClick={onOk}
          >
            {okText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
