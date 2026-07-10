// P4 — 导出任务中心：全局任务列表，关窗不中断
import { create } from 'zustand'

export type ExportTaskStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface ExportTask {
  id: string
  connId: string
  label: string          // 显示名，e.g. "orders → /tmp/orders.csv"
  status: ExportTaskStatus
  progressRows: number
  totalRows?: number
  progressValue?: number
  progressTotal?: number
  speed?: number         // rows/s
  fileBytes?: number
  message?: string
  cancelable?: boolean
  startedAt: number
  finishedAt?: number
  filePath?: string
  error?: string
  // AbortController 不放在 state 里（不可序列化），单独 Map 管理
}

// 取消函数存在 store 外部，避免 Zustand 状态含不可序列化对象。
const cancelHandlers = new Map<string, () => void | Promise<void>>()

export function registerExportCancelHandler(id: string, handler: () => void | Promise<void>) {
  cancelHandlers.set(id, handler)
}

export function unregisterExportCancelHandler(id: string) {
  cancelHandlers.delete(id)
}

export function getExportCancelHandler(id: string) {
  return cancelHandlers.get(id)
}

interface ExportTaskState {
  tasks: ExportTask[]
  addTask: (t: Omit<ExportTask, 'id' | 'startedAt' | 'progressRows' | 'status'>) => string
  updateTask: (id: string, patch: Partial<Omit<ExportTask, 'id'>>) => void
  cancelTask: (id: string) => void
  removeTask: (id: string) => void
  clearDone: () => void
  expanded: boolean
  setExpanded: (expanded: boolean) => void
}

export const useExportTaskStore = create<ExportTaskState>((set) => ({
  tasks: [],
  expanded: true,

  addTask: (t) => {
    const id = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const task: ExportTask = { ...t, id, startedAt: Date.now(), progressRows: 0, status: 'running' }
    set(s => ({ tasks: [task, ...s.tasks], expanded: true }))
    return id
  },

  updateTask: (id, patch) => {
    set(s => ({ tasks: s.tasks.map(t => t.id === id ? { ...t, ...patch } : t) }))
  },

  cancelTask: (id) => {
    const handler = cancelHandlers.get(id)
    if (!handler) return
    void handler()
    cancelHandlers.delete(id)
    set(s => ({
      tasks: s.tasks.map(t => t.id === id
        ? { ...t, status: 'cancelled' as ExportTaskStatus, finishedAt: Date.now() }
        : t)
    }))
  },

  removeTask: (id) => {
    cancelHandlers.delete(id)
    set(s => ({ tasks: s.tasks.filter(t => t.id !== id) }))
  },

  clearDone: () => {
    set(s => {
      s.tasks.filter(t => t.status !== 'running').forEach(t => cancelHandlers.delete(t.id))
      return { tasks: s.tasks.filter(t => t.status === 'running') }
    })
  },

  setExpanded: (expanded) => set({ expanded }),
}))
