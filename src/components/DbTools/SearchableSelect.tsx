import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Search, Check } from 'lucide-react'

interface Item { value: string; label: string }

interface Props {
  value: string
  onChange: (v: string) => void
  options?: string[]            // 简单字符串选项（值=标签）
  items?: Item[]                // 值/标签不同时用（如连接 id / 名称）
  placeholder?: string
  searchPlaceholder?: string
  disabled?: boolean
  width?: number                // 固定宽度（不指定则 flex:1 撑满）
  mono?: boolean                // 用等宽字体（表名/列名等），默认 true
}

/** 自定义下拉框：选项列表用 createPortal 渲染（不被弹窗裁切、可统一美化）；选项较多时显示搜索框 */
export default function SearchableSelect({
  value, onChange, options, items, placeholder = '选择…', searchPlaceholder = '搜索…',
  disabled, width, mono = true,
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number; maxH: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const list: Item[] = items ?? (options ?? []).map(o => ({ value: o, label: o }))
  const showSearch = list.length > 7
  const selected = list.find(i => i.value === value)

  const place = () => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const margin = 8
    const belowSpace = window.innerHeight - r.bottom - margin
    const aboveSpace = r.top - margin
    // 默认向下；仅当下方空间确实很小且上方更宽裕时才向上展开
    const up = belowSpace < 180 && aboveSpace > belowSpace
    const maxH = Math.max(140, Math.min(340, up ? aboveSpace : belowSpace))
    if (up) setPos({ bottom: window.innerHeight - r.top + 4, left: r.left, width: r.width, maxH })
    else setPos({ top: r.bottom + 4, left: r.left, width: r.width, maxH })
  }

  useEffect(() => {
    if (!open) return
    place()
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node) || triggerRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    const reposition = () => place()
    // 用捕获阶段：弹窗 cdlg-box 的 onMouseDown 调了 stopPropagation，冒泡阶段收不到，
    // 捕获阶段在到达它之前先于 document 触发，才能正确"点击外部关闭"。
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const q = query.trim().toLowerCase()
  const filtered = q ? list.filter(i => i.label.toLowerCase().includes(q)) : list

  return (
    <div style={{ position: 'relative', ...(width ? { width, flexShrink: 0 } : { flex: 1 }) }}>
      <button
        ref={triggerRef} type="button" disabled={disabled}
        onClick={() => { if (!disabled) { setQuery(''); setOpen(o => !o) } }}
        style={{
          width: '100%', height: 32, boxSizing: 'border-box',
          display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 0 10px',
          background: 'var(--surface)', border: `1px solid ${open ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 7, cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: 12.5, color: selected ? 'var(--text-bright)' : 'var(--text-muted)',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: selected && mono ? 'var(--font-mono)' : undefined }}>
          {selected?.label || placeholder}
        </span>
        <ChevronDown size={13} style={{ color: 'var(--text-muted)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>

      {open && pos && createPortal(
        <div ref={panelRef} style={{
          position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, width: Math.max(pos.width, 200), zIndex: 100001,
          maxHeight: pos.maxH,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: '0 8px 28px rgba(0,0,0,0.28)', overflow: 'hidden', display: 'flex', flexDirection: 'column',
        }}>
          {showSearch && (
            <div style={{ position: 'relative', padding: 8, borderBottom: '1px solid var(--border-subtle)' }}>
              <Search size={13} style={{ position: 'absolute', left: 18, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
              <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} placeholder={searchPlaceholder} spellCheck={false}
                style={{ width: '100%', boxSizing: 'border-box', height: 30, padding: '0 8px 0 28px', fontSize: 12.5, borderRadius: 7 }} />
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 4 }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                {list.length === 0 ? '暂无可选项' : '无匹配'}
              </div>
            ) : filtered.map(it => {
              const on = it.value === value
              return (
                <button key={it.value} type="button" onClick={() => { onChange(it.value); setOpen(false) }}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', borderRadius: 6,
                    background: on ? 'var(--accent-bg)' : 'transparent', cursor: 'pointer', textAlign: 'left',
                    fontSize: 12.5, fontFamily: mono ? 'var(--font-mono)' : undefined, color: on ? 'var(--accent)' : 'var(--text)',
                  }}
                  onMouseEnter={e => { if (!on) e.currentTarget.style.background = 'var(--surface-hover)' }}
                  onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent' }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                  {on && <Check size={13} style={{ flexShrink: 0 }} />}
                </button>
              )
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
