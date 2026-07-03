// 把固定定位（position:fixed）的浮层夹进视口：右/下溢出时左移/上移，避免被窗口边缘裁剪。
// 在浮层挂载后调用（ref 回调或 useLayoutEffect），读取实际尺寸再校正 left/top。
export function clampIntoViewport(el: HTMLElement | null, margin = 8): void {
  if (!el) return
  const r = el.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  let nx = r.left
  let ny = r.top
  if (r.right > vw - margin) nx = vw - margin - r.width
  if (nx < margin) nx = margin
  if (r.bottom > vh - margin) ny = vh - margin - r.height
  if (ny < margin) ny = margin
  if (nx !== r.left || ny !== r.top) {
    el.style.left = `${nx}px`
    el.style.top = `${ny}px`
    el.style.right = 'auto'
    el.style.bottom = 'auto'
  }
}
