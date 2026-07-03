// G2/K8 — 定时任务调度器（localStorage 持久化 + setInterval 执行）
import { create } from 'zustand'

export type ScheduleType = 'backup' | 'query'
export type ScheduleStatus = 'idle' | 'running' | 'ok' | 'error'

export interface ScheduleRun {
  at: number
  success: boolean
  message: string
}

export interface ScheduleTask {
  id: string
  type: ScheduleType
  name: string
  connId: string
  // backup fields
  schema?: string
  destDir?: string
  keepN?: number
  // query fields
  sql?: string
  exportPath?: string
  // schedule
  intervalMinutes: number
  enabled: boolean
  lastRun?: number
  nextRun?: number
  lastStatus: ScheduleStatus
  lastMessage: string
  runs: ScheduleRun[]    // last 20 runs
}

const STORAGE_KEY = 'dbterm_schedule_tasks'

function load(): ScheduleTask[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch { return [] }
}

function save(tasks: ScheduleTask[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))
}

interface SchedulerState {
  tasks: ScheduleTask[]
  addTask: (t: Omit<ScheduleTask, 'id' | 'lastStatus' | 'lastMessage' | 'runs'>) => string
  updateTask: (id: string, patch: Partial<ScheduleTask>) => void
  removeTask: (id: string) => void
  recordRun: (id: string, success: boolean, message: string) => void
  reload: () => void
}

export const useSchedulerStore = create<SchedulerState>((set) => ({
  tasks: load(),

  addTask: (t) => {
    const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const task: ScheduleTask = {
      ...t,
      id,
      lastStatus: 'idle',
      lastMessage: '',
      runs: [],
      nextRun: Date.now() + t.intervalMinutes * 60 * 1000,
    }
    set(s => {
      const tasks = [...s.tasks, task]
      save(tasks)
      return { tasks }
    })
    return id
  },

  updateTask: (id, patch) => {
    set(s => {
      const tasks = s.tasks.map(t => t.id === id ? { ...t, ...patch } : t)
      save(tasks)
      return { tasks }
    })
  },

  removeTask: (id) => {
    set(s => {
      const tasks = s.tasks.filter(t => t.id !== id)
      save(tasks)
      return { tasks }
    })
  },

  recordRun: (id, success, message) => {
    set(s => {
      const tasks: ScheduleTask[] = s.tasks.map(t => {
        if (t.id !== id) return t
        const run: ScheduleRun = { at: Date.now(), success, message }
        const runs = [run, ...t.runs].slice(0, 20)
        return {
          ...t,
          lastRun: Date.now(),
          nextRun: Date.now() + t.intervalMinutes * 60 * 1000,
          lastStatus: (success ? 'ok' : 'error') as ScheduleStatus,
          lastMessage: message,
          runs,
        }
      })
      save(tasks)
      return { tasks }
    })
  },

  reload: () => set({ tasks: load() }),
}))
