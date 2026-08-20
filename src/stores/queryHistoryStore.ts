import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface QueryHistoryEntry {
  id: string
  connId: string
  sql: string
  success: boolean
  at: number            // 执行时间戳
  pinned: boolean       // 收藏：置顶且不过期
  executionTimeMs?: number
  rowsAffected?: number
  error?: string
}

const MAX_ENTRIES = 500
const MAX_SQL_CHARS = 100_000
const MAX_TOTAL_SQL_CHARS = 1_000_000
const EXPIRE_MS = 30 * 24 * 60 * 60 * 1000 // 未收藏的 30 天过期

interface AddQueryOpts {
  executionTimeMs?: number
  rowsAffected?: number
  error?: string
}

interface QueryHistoryState {
  entries: QueryHistoryEntry[]
  addQuery: (connId: string, sql: string, success: boolean, opts?: AddQueryOpts) => void
  togglePin: (id: string) => void
  remove: (id: string) => void
  clear: (connId: string) => void
}

function prune(entries: QueryHistoryEntry[]): QueryHistoryEntry[] {
  const now = Date.now()
  const kept = entries.filter(e => (e.pinned || now - e.at < EXPIRE_MS) && e.sql.length <= MAX_SQL_CHARS)
  const trimBySize = (list: QueryHistoryEntry[]) => {
    let total = 0
    return list.filter(e => {
      total += e.sql.length
      return e.pinned || total <= MAX_TOTAL_SQL_CHARS
    })
  }
  if (kept.length <= MAX_ENTRIES) return trimBySize(kept)
  const pinned = kept.filter(e => e.pinned)
  const rest = kept.filter(e => !e.pinned)
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(0, MAX_ENTRIES - pinned.length))
  return trimBySize([...pinned, ...rest])
}

export const useQueryHistoryStore = create<QueryHistoryState>()(
  persist(
    (set) => ({
      entries: [],
      addQuery: (connId, sql, success, opts) => set((s) => {
        const trimmed = sql.trim()
        if (!trimmed) return s
        // 超长脚本仍正常执行，但不写入 localStorage 历史，避免触发 QuotaExceededError。
        if (trimmed.length > MAX_SQL_CHARS) return s
        const dup = s.entries.find(e => e.connId === connId && e.sql === trimmed)
        const rest = s.entries.filter(e => e !== dup)
        const entry: QueryHistoryEntry = {
          id: dup?.id ?? `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          connId,
          sql: trimmed,
          success,
          at: Date.now(),
          pinned: dup?.pinned ?? false,
          executionTimeMs: opts?.executionTimeMs,
          rowsAffected: opts?.rowsAffected,
          error: opts?.error,
        }
        return { entries: prune([entry, ...rest]) }
      }),
      togglePin: (id) => set((s) => ({
        entries: s.entries.map(e => e.id === id ? { ...e, pinned: !e.pinned } : e),
      })),
      remove: (id) => set((s) => ({ entries: s.entries.filter(e => e.id !== id) })),
      clear: (connId) => set((s) => ({
        entries: s.entries.filter(e => e.connId !== connId || e.pinned),
      })),
    }),
    { name: 'dbterm-query-history' }
  )
)
