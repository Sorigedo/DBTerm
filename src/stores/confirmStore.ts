import { create } from 'zustand'
import type { ConnConfig } from '../types'

export type ConfirmTone = 'prod' | 'danger' | 'info'

export interface ConfirmRequest {
  id: number
  title: string
  message: string
  detail?: string        // 等宽展示的 SQL / 摘要
  confirmText?: string
  tone: ConfirmTone
}

interface ConfirmState {
  pending: (ConfirmRequest & { resolve: (ok: boolean) => void }) | null
  /** 弹出确认框，返回用户是否确认 */
  ask: (req: Omit<ConfirmRequest, 'id'>) => Promise<boolean>
  answer: (ok: boolean) => void
}

let _seq = 1

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  pending: null,
  ask: (req) => new Promise<boolean>((resolve) => {
    set({ pending: { ...req, id: _seq++, resolve } })
  }),
  answer: (ok) => {
    const p = get().pending
    if (p) { p.resolve(ok); set({ pending: null }) }
  },
}))

/** 命令式确认：在任意 async 流程里 `if (!(await confirmAction({...}))) return`。 */
export function confirmAction(req: Omit<ConfirmRequest, 'id' | 'tone'> & { tone?: ConfirmTone }): Promise<boolean> {
  return useConfirmStore.getState().ask({ tone: 'info', ...req })
}

/**
 * 生产环境写操作二次确认：连接标记为 envLabel='prod' 时弹确认框，否则直接放行。
 * 任何数据变更（单元格编辑/插入/删除、视图/函数/存储过程 DDL 等）执行前调用。
 */
export function requireProdConfirm(conn: ConnConfig | null | undefined, action: string, detail?: string): Promise<boolean> {
  if (conn?.envLabel !== 'prod') return Promise.resolve(true)
  return useConfirmStore.getState().ask({
    tone: 'prod',
    title: '生产环境操作确认',
    message: `当前连接「${conn.name}」标记为生产环境，即将执行：${action}。请确认无误后继续。`,
    detail,
    confirmText: '确认执行',
  })
}
