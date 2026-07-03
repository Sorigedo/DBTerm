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
  // 未分屏：落在内容区即新建分屏，方向按落点（右半→左右，下半→上下，默认左右）
  if (fx >= 0.5) return { kind: 'split', dir: 'h' }
  if (fy >= 0.5) return { kind: 'split', dir: 'v' }
  return { kind: 'split', dir: 'h' }
}
