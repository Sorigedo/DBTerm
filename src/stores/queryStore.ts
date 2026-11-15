import { create } from 'zustand'
import { persist, type StateStorage } from 'zustand/middleware'
import { createDebouncedJSONStorage } from './queryStorePersistence.ts'

const MAX_PERSISTED_SQL_CHARS = 300_000
const MAX_TOTAL_PERSISTED_SQL_CHARS = 1_500_000

interface QueryStoreState {
  sqls: Record<string, string>          // tabId → sql text
  setSql: (tabId: string, sql: string) => void
  removeSql: (tabId: string) => void
}

function trimDrafts(sqls: Record<string, string>): Record<string, string> {
  const entries = Object.entries(sqls).filter(([, sql]) => typeof sql === 'string' && sql.length <= MAX_PERSISTED_SQL_CHARS)
  let total = 0
  const kept: Array<[string, string]> = []
  for (let i = entries.length - 1; i >= 0; i--) {
    const [tabId, sql] = entries[i]
    if (total + sql.length > MAX_TOTAL_PERSISTED_SQL_CHARS) continue
    total += sql.length
    kept.push([tabId, sql])
  }
  return Object.fromEntries(kept.reverse())
}

const browserStorage: StateStorage = {
  getItem: (name) => {
    if (typeof window === 'undefined') return null
    try { return window.localStorage.getItem(name) } catch { return null }
  },
  setItem: (name, value) => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(name, value)
  },
  removeItem: (name) => {
    if (typeof window === 'undefined') return
    try { window.localStorage.removeItem(name) } catch { /* ignore unavailable storage */ }
  },
}

const queryStorage = createDebouncedJSONStorage<{ sqls: Record<string, string> }>(browserStorage)

export function flushQueryStorePersistence(): void {
  queryStorage.flush()
}

export const useQueryStore = create<QueryStoreState>()(
  persist(
    (set) => ({
      sqls: {},
      setSql: (tabId, sql) =>
        set((s) => {
          if (s.sqls[tabId] === sql) return s
          const next = { ...s.sqls }
          delete next[tabId]
          return { sqls: { ...next, [tabId]: sql } }
        }),
      removeSql: (tabId) =>
        set((s) => {
          const next = { ...s.sqls }
          delete next[tabId]
          return { sqls: next }
        }),
    }),
    {
      name: 'dbterm-query-sqls',
      storage: queryStorage,
      // v1：清理旧逻辑自动注入的「纯 USE xxx;」草稿（现已不再注入 USE）
      version: 1,
      migrate: (persisted, version) => {
        const s = (persisted ?? {}) as Partial<QueryStoreState>
        if (version < 1 && s.sqls) {
          const cleaned: Record<string, string> = {}
          for (const [k, v] of Object.entries(s.sqls)) {
            if (/^\s*USE\s+[`"]?\w+[`"]?\s*;?\s*$/i.test(v)) continue
            cleaned[k] = v
          }
          return { ...s, sqls: cleaned } as QueryStoreState
        }
        return s as QueryStoreState
      },
      partialize: (s) => ({ sqls: trimDrafts(s.sqls) }),
      merge: (persisted, current) => ({
        ...current,
        sqls: trimDrafts((persisted as Partial<QueryStoreState> | undefined)?.sqls ?? {}),
      }),
    }
  )
)
