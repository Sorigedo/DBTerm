import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface CommandEntry {
  id: string
  command: string
  label: string
  addedAt: number
  /** 所属连接 ID；为空表示旧版全局记录 */
  connId?: string
  /** 置顶的常用命令，不参与过期清理 */
  pinned?: boolean
}

/** 历史保留时长：6 天 */
const MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000
const MAX_ENTRIES = 1000

function prune(commands: CommandEntry[]): CommandEntry[] {
  const cutoff = Date.now() - MAX_AGE_MS
  // 置顶项永久保留；其余按 6 天过期，丢弃旧版无 connId 的孤儿记录
  return commands
    .filter((c) => c.pinned || (c.connId && c.addedAt >= cutoff))
    .slice(0, MAX_ENTRIES)
}

interface CommandHistoryState {
  commands: CommandEntry[]
  addCommand: (command: string, connId?: string, label?: string, pinned?: boolean) => void
  removeCommand: (id: string) => void
  clearConn: (connId: string) => void
  clearAll: () => void
  updateLabel: (id: string, label: string) => void
  togglePin: (id: string) => void
}

export const useCommandHistoryStore = create<CommandHistoryState>()(
  persist(
    (set) => ({
      commands: [],
      addCommand: (command, connId, label, pinned) => {
        const trimmed = command.trim()
        if (!trimmed) return
        set((s) => {
          // 同一连接内避免连续重复
          const last = s.commands.find((c) => c.connId === connId)
          if (last?.command === trimmed) return { commands: prune(s.commands) }
          const entry: CommandEntry = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            command: trimmed,
            label: label ?? trimmed.slice(0, 40),
            addedAt: Date.now(),
            connId,
            pinned,
          }
          return { commands: prune([entry, ...s.commands]) }
        })
      },
      removeCommand: (id) =>
        set((s) => ({ commands: s.commands.filter((c) => c.id !== id) })),
      clearConn: (connId) =>
        set((s) => ({ commands: s.commands.filter((c) => c.connId !== connId) })),
      clearAll: () => set({ commands: [] }),
      updateLabel: (id, label) =>
        set((s) => ({
          commands: s.commands.map((c) => (c.id === id ? { ...c, label } : c)),
        })),
      togglePin: (id) =>
        set((s) => ({
          commands: s.commands.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)),
        })),
    }),
    {
      name: 'dbterm-cmd-history',
      onRehydrateStorage: () => (state) => {
        // 启动时清理过期记录（仅过期才清，不会清空全部）
        if (state) state.commands = prune(state.commands)
      },
    }
  )
)
