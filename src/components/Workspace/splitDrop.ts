// 根据光标位置判定拖放目标（onDragEnd 用；WKWebView 下 onDrop 常不触发）
export type DropTarget =
  | { kind: 'split'; dir: 'h' | 'v' }   // 未分屏：拖到边缘 → 新建分屏
  | { kind: 'pane'; pane: 'a' | 'b' }   // 已分屏：拖到某半 → 移入该屏
  | null

export function resolveDropTarget(
  x: number, y: number, splitOn: boolean, splitDir: 'h' | 'v',
): DropTarget {
  const el = document.querySelector('.workspace-content') as HTMLElement | null
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null
  const fx = (x - r.left) / r.width
  const fy = (y - r.top) / r.height
  if (splitOn) {
    return splitDir === 'h'
      ? { kind: 'pane', pane: fx < 0.5 ? 'a' : 'b' }
      : { kind: 'pane', pane: fy < 0.5 ? 'a' : 'b' }
  }
  // 未分屏：只有拖到内容区边缘热区才新建分屏，避免普通标签排序误触发。
  // 右侧边缘优先左右分屏，底部边缘触发上下分屏。
  if (fx >= 0.78) return { kind: 'split', dir: 'h' }
  if (fy >= 0.78) return { kind: 'split', dir: 'v' }
  return null
}
