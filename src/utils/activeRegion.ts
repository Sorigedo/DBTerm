/**
 * 当前激活区域追踪：用于让"重复的快捷键"（如搜索 Mod+F / Ctrl+F）只作用在
 * 用户最近交互的区域——侧栏连接列表 vs 工作区标签页。
 *
 * 以最近一次 mousedown 落点判定：落在 .asset-panel 内 → 'sidebar'，否则 'workspace'。
 * 用 capture 阶段监听，保证在任何业务 handler 之前就已更新。
 */
export type Region = 'sidebar' | 'workspace'

let current: Region = 'workspace'

let inited = false
function ensureInit() {
  if (inited || typeof document === 'undefined') return
  inited = true
  document.addEventListener('mousedown', (e) => {
    const t = e.target as HTMLElement | null
    current = t?.closest('.asset-panel') ? 'sidebar' : 'workspace'
  }, true)
}
ensureInit()

export const getActiveRegion = (): Region => current
