import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface TipState { text: string; shortcut: string; x: number; y: number }

export default function GlobalTooltip() {
  const [tip, setTip] = useState<TipState | null>(null)
  const posRef   = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const timerRef = useRef<number | null>(null)
  const curElRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    // Only respond to elements that explicitly opt in with data-tip
    const getTipped = (t: EventTarget | null): HTMLElement | null =>
      (t as HTMLElement | null)?.closest<HTMLElement>('[data-tip]') ?? null

    const clear = () => {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
      curElRef.current = null
      setTip(null)
    }

    const onOver = (e: MouseEvent) => {
      const el = getTipped(e.target)
      if (!el) { clear(); return }
      // 防御：若 data-tip 元素自身或子节点还带原生 title，移除它，避免和自定义浮窗同时出现（一大一小）
      if (el.hasAttribute('title')) el.removeAttribute('title')
      const titledChild = el.querySelector('[title]')
      if (titledChild) titledChild.removeAttribute('title')
      if (curElRef.current === el) return
      clear()
      curElRef.current = el
      posRef.current = { x: e.clientX, y: e.clientY }
      timerRef.current = window.setTimeout(() => {
        const live = curElRef.current
        if (!live) return
        const text = live.getAttribute('data-tip') ?? ''
        if (!text) return
        const shortcut = live.getAttribute('data-shortcut') ?? ''
        setTip({ text, shortcut, ...posRef.current })
      }, 60)
    }

    const onOut = (e: MouseEvent) => {
      const from = getTipped(e.target)
      const to   = getTipped(e.relatedTarget as EventTarget | null)
      if (from && from !== to && !from.contains(to as Node)) clear()
    }

    const onMove = (e: MouseEvent) => {
      posRef.current = { x: e.clientX, y: e.clientY }
      setTip(t => t ? { ...t, x: e.clientX, y: e.clientY } : null)
    }

    // 任意点击立即消失：避免点开下拉/菜单后浮窗仍盖在上面造成遮挡
    const onDown = () => clear()

    document.addEventListener('mouseover', onOver)
    document.addEventListener('mouseout', onOut)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mouseout', onOut)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [])

  if (!tip) return null

  const vpW = window.innerWidth
  const vpH = window.innerHeight
  const top = (tip.y > vpH - 56) ? tip.y - (tip.shortcut ? 52 : 36) : tip.y + 20
  // 靠近右边界时改用 right 锚定（向左生长），避免浮窗被裁切/遮挡
  const nearRight = tip.x > vpW - 320
  const horiz = nearRight
    ? { right: Math.max(8, vpW - tip.x + 12) }
    : { left: tip.x + 12 }

  return createPortal(
    <div style={{
      position:      'fixed',
      ...horiz,
      top,
      pointerEvents: 'none',
      zIndex:        99999,
      background:    'var(--surface-2)',
      color:         'var(--text)',
      border:        '1px solid var(--border)',
      borderRadius:  7,
      padding:       '6px 10px',
      fontSize:      12.5,
      fontWeight:    500,
      lineHeight:    1.5,
      letterSpacing: 0.1,
      boxShadow:     '0 4px 20px rgba(0,0,0,0.22)',
      maxWidth:      320,
      whiteSpace:    'pre-wrap',
      wordBreak:     'break-word',
      userSelect:    'none',
    }}>
      {tip.text}
      {tip.shortcut && (
        <span style={{
          display:       'block',
          marginTop:     3,
          fontSize:      11,
          color:         'var(--text-muted)',
          fontWeight:    400,
          letterSpacing: 0.5,
        }}>
          {tip.shortcut}
        </span>
      )}
    </div>,
    document.body
  )
}
