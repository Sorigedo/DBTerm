// 连接树里的工具入口行：点击弹出某分类（DBA/高级）下、适用于该连接类型的工具列表。
// 弹层修复：① 点击外部判定排除弹层自身（否则点项即关、onClick 不触发）② 靠近屏幕底部时向上翻转、可滚动不裁剪。
import { useState, useRef, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import type { ConnType } from '../../types'
import { useDbToolsStore } from '../../stores/dbToolsStore'
import { toolsFor, type ToolCat } from './dbToolsCatalog'
import { clampIntoViewport } from '../../utils/menuClamp'

interface Props {
  connectionId: string
  connType: ConnType
  schema: string
  cat: ToolCat
  label: string
  icon: React.ReactNode
}

export default function DbToolsEntry({ connectionId, connType, schema, cat, label, icon }: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const openTool = useDbToolsStore((s) => s.openTool)

  const items = toolsFor(cat, connType)

  // 点击外部关闭（排除按钮与弹层自身）
  useLayoutEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (items.length === 0) return null

  return (
    <div className="dbt-schema-node">
      <button ref={btnRef} className="dbt-schema-row" onClick={() => {
        const r = btnRef.current!.getBoundingClientRect()
        // 按钮在屏幕下半部 → 向上弹出，避免被裁剪
        if (r.bottom > window.innerHeight * 0.55) setPos({ left: r.left, bottom: window.innerHeight - r.top + 2 })
        else setPos({ left: r.left, top: r.bottom + 2 })
        setOpen((o) => !o)
      }}>
        <span className="dbt-schema-arrow-hit" style={{ visibility: 'hidden' }}>
          <ChevronRight size={11} strokeWidth={2.5} className="dbt-schema-arrow" />
        </span>
        <span style={{ color: 'var(--accent)', display: 'flex', flexShrink: 0 }}>{icon}</span>
        <span className="dbt-schema-name">{label}</span>
      </button>

      {open && pos && createPortal(
        <div ref={(el) => { menuRef.current = el; clampIntoViewport(el) }} style={{
          position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, zIndex: 9000,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)', overflowY: 'auto', minWidth: 200, maxHeight: '60vh', padding: '4px 0',
        }}>
          {items.map((it) => (
            <button key={it.tool}
              onClick={() => { openTool(it.tool, { connectionId, connType, schema }); setOpen(false) }}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', fontSize: 12, color: 'var(--text)', background: 'transparent', cursor: 'pointer', whiteSpace: 'nowrap' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
              <span style={{ color: 'var(--accent)', display: 'flex', flexShrink: 0 }}>{it.icon}</span>
              {it.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
