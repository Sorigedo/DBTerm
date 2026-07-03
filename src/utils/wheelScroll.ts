import { useEffect, type RefObject } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { resolveWheelAction } from './wheelScrollCore'

/**
 * 全软件统一的「滚轮驱动横向滚动条」规则。
 *
 * 约定（鼠标滚轮只有一个轴，纵向/横向无法同时用裸滚轮触发）：
 * - 触控板双指：已带横向分量，交给浏览器原生 → 两向自由；
 * - 裸鼠标滚轮：纵向滚动（浏览器原生）；
 * - 修饰键 + 滚轮（默认 Shift，可在「设置 · 外观」中改 Alt/Ctrl，或「横向优先」免修饰键）→ 纵向滚轮量转横向；
 * - 容器无纵向可滚（或纯横向容器 horizontalOnly）→ 裸滚轮直接横向。
 *
 * 必须用「原生非 passive 监听」挂载：React 合成 onWheel 默认 passive，preventDefault 会被忽略。
 */
export interface WheelScrollOpts {
  /** 纯横向容器（标签栏、横向卡片网格等，无纵向滚动）：裸滚轮即横向 */
  horizontalOnly?: boolean
  /** 实际滚动元素与监听宿主不同时（如 CodeMirror 的 .cm-scroller），返回真正的滚动容器；应为稳定函数 */
  getScroller?: (host: HTMLElement) => HTMLElement | null
}

/** CodeMirror 滚动容器解析器（宿主重建子树也始终有效，每次事件即时取） */
export const cmScroller = (host: HTMLElement) =>
  host.querySelector('.cm-scroller') as HTMLElement | null

function wheelDelta(e: WheelEvent): number {
  return Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return !!target.closest('input, textarea, select, [contenteditable="true"]')
}

function isScrollable(el: HTMLElement, axis: 'x' | 'y'): boolean {
  const style = window.getComputedStyle(el)
  const overflow = axis === 'x' ? style.overflowX : style.overflowY
  if (!/(auto|scroll|overlay)/.test(overflow)) return false
  return axis === 'x'
    ? el.scrollWidth - el.clientWidth > 1
    : el.scrollHeight - el.clientHeight > 1
}

function findHorizontalScroller(e: WheelEvent): HTMLElement | null {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : []
  for (const item of path) {
    if (!(item instanceof HTMLElement)) continue
    if (isScrollable(item, 'x')) return item
  }
  let el = e.target instanceof HTMLElement ? e.target : null
  while (el && el !== document.body) {
    if (isScrollable(el, 'x')) return el
    el = el.parentElement
  }
  return null
}

/** 给元素挂上统一滚轮规则；返回清理函数。 */
export function attachWheelScroll(host: HTMLElement, opts: WheelScrollOpts = {}): () => void {
  const onWheel = (e: WheelEvent) => {
    const scroller = opts.getScroller ? opts.getScroller(host) : host
    if (!scroller) return
    const canX = scroller.scrollWidth - scroller.clientWidth > 1
    if (!canX || (e.deltaY === 0 && e.deltaX === 0)) return
    const canY = scroller.scrollHeight - scroller.clientHeight > 1
    const mode = useSettingsStore.getState().wheelHScrollModifier
    const action = resolveWheelAction(e, mode, !!opts.horizontalOnly, canY)
    if (action === 'native') return
    if (action === 'horizontal') {
      scroller.scrollLeft += wheelDelta(e)
      e.preventDefault()
    } else {
      e.preventDefault()
    }
  }
  host.addEventListener('wheel', onWheel, { passive: false })
  return () => host.removeEventListener('wheel', onWheel)
}

/**
 * 全局兜底：对所有 CSS 上可横向滚动的容器生效，避免新表格/代码区忘记接 useWheelScroll。
 * 局部 hook 仍保留给 CodeMirror 等特殊 scroller 解析。
 */
export function attachGlobalWheelScroll(): () => void {
  const onWheel = (e: WheelEvent) => {
    if (e.defaultPrevented || (e.deltaY === 0 && e.deltaX === 0) || isEditableTarget(e.target)) return
    const scroller = findHorizontalScroller(e)
    if (!scroller) return
    const canY = isScrollable(scroller, 'y')
    const mode = useSettingsStore.getState().wheelHScrollModifier
    const action = resolveWheelAction(e, mode, false, canY)
    if (action === 'native') return
    if (action === 'horizontal') {
      scroller.scrollLeft += wheelDelta(e)
      e.preventDefault()
    } else {
      e.preventDefault()
    }
  }
  window.addEventListener('wheel', onWheel, { passive: false, capture: true })
  return () => window.removeEventListener('wheel', onWheel, { capture: true })
}

/**
 * React hook：把统一滚轮规则挂到 ref 指向的元素（getScroller 须为模块级稳定函数）。
 * 元素条件渲染（挂载时机晚于本组件）时，把决定其挂载的状态传入 deps，以便适时重挂监听。
 */
export function useWheelScroll(
  ref: RefObject<HTMLElement | null>,
  opts: WheelScrollOpts = {},
  deps: unknown[] = [],
) {
  const { horizontalOnly, getScroller } = opts
  useEffect(() => {
    const el = ref.current
    if (!el) return
    return attachWheelScroll(el, { horizontalOnly, getScroller })
    // ref 稳定；getScroller 期望稳定函数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [horizontalOnly, ...deps])
}
