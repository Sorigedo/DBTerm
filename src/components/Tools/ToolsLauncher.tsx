import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { TOOLS } from './catalog'
import { openToolTab } from './openToolTab'

interface Props {
  onClose: () => void
}

export default function ToolsLauncher({ onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="tools-launcher-mask" onMouseDown={onClose}>
      <div className="tools-launcher" onMouseDown={(e) => e.stopPropagation()}>
        <div className="tools-launcher__head">
          <div>
            <div className="tools-launcher__title">工具</div>
            <div className="tools-launcher__sub">选择一个工具打开为标签</div>
          </div>
          <button className="tools-launcher__close" onClick={onClose} data-tip="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="tools-launcher__grid">
          {TOOLS.map(({ id, title, desc, Icon }) => (
            <button
              key={id}
              className="tool-card"
              onClick={() => {
                openToolTab(id, title)
                onClose()
              }}
            >
              <span className="tool-card__icon"><Icon size={22} strokeWidth={1.8} /></span>
              <span className="tool-card__body">
                <span className="tool-card__title">{title}</span>
                <span className="tool-card__desc">{desc}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
