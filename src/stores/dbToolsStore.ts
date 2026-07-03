// DB 运维工具面板的全局开关：入口（树/对象页/高级菜单）派发「打开哪个工具」，
// 由全局 <DbToolPanels> 统一渲染对应模态。解耦入口位置与面板挂载。
import { create } from 'zustand'
import type { ConnType } from '../types'

export interface DbToolCtx {
  connectionId: string
  connType: ConnType
  schema: string
}

interface DbToolsState {
  open: { tool: string; ctx: DbToolCtx } | null
  openTool: (tool: string, ctx: DbToolCtx) => void
  closeTool: () => void
}

export const useDbToolsStore = create<DbToolsState>((set) => ({
  open: null,
  openTool: (tool, ctx) => set({ open: { tool, ctx } }),
  closeTool: () => set({ open: null }),
}))
