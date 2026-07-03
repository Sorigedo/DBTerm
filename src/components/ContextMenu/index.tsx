import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'

export interface MenuItem {
  label?: string            // undefined = divider
  icon?: React.ReactNode
  onClick?: () => void
  submenu?: MenuItem[]
  danger?: boolean
  disabled?: boolean
  shortcut?: string         // 右侧灰色显示，如 "⌘R"
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

function Menu({
  items, x, y, onClose, nested = false,
}: Props & { nested?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const [subPos, setSubPos] = useState({ x: 0, y: 0 })
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])

  useLayoutEffect(() => {
    if (!ref.current) return
    const w  = ref.current.offsetWidth
    const h  = ref.current.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const GAP = 6
    setPos({
      x: x + w + GAP > vw ? Math.max(GAP, x - w) : x,
      y: y + h + GAP > vh ? Math.max(GAP, vh - h - GAP) : y,
    })
  }, [x, y])

  useEffect(() => {
    if (nested) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nested, onClose])

  function handleHover(idx: number, item: MenuItem) {
    if (!item.submenu) { setOpenIdx(null); return }
    const el = itemRefs.current[idx]
    if (!el) return
    const rect = el.getBoundingClientRect()
    setOpenIdx(idx)
    setSubPos({ x: rect.right, y: rect.top })
  }

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={e => e.stopPropagation()}
    >
      {items.map((item, idx) =>
        item.label === undefined ? (
          <div key={idx} className="ctx-divider" />
        ) : (
          <div
            key={idx}
            ref={el => { itemRefs.current[idx] = el }}
            className={[
              'ctx-item',
              item.danger    ? 'ctx-item--danger'    : '',
              item.disabled  ? 'ctx-item--disabled'  : '',
              openIdx === idx ? 'ctx-item--open'     : '',
            ].filter(Boolean).join(' ')}
            onMouseEnter={() => handleHover(idx, item)}
            onClick={() => {
              if (item.disabled || item.submenu) return
              item.onClick?.()
              onClose()
            }}
          >
            {item.icon && <span className="ctx-item__icon">{item.icon}</span>}
            <span className="ctx-item__label">{item.label}</span>
            {item.shortcut && !item.submenu && (
              <span className="ctx-item__shortcut">{item.shortcut}</span>
            )}
            {item.submenu && <ChevronRight size={12} className="ctx-item__arrow" />}

            {item.submenu && openIdx === idx && (
              <Menu
                items={item.submenu}
                x={subPos.x}
                y={subPos.y}
                onClose={onClose}
                nested
              />
            )}
          </div>
        )
      )}
    </div>
  )
}

export default function ContextMenu(props: Props) {
  return createPortal(
    <div
      className="ctx-overlay"
      onMouseDown={props.onClose}
      onContextMenu={e => { e.preventDefault(); props.onClose() }}
    >
      <Menu {...props} />
    </div>,
    document.body
  )
}
