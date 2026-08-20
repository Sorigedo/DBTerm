import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const MAX_PERSISTED_SQL_CHARS = 300_000
const MAX_TOTAL_PERSISTED_SQL_CHARS = 1_500_000

interface QueryStoreState {
  sqls: Record<string, string>          // tabId → sql text
  setSql: (tabId: string, sql: string) => void
  removeSql: (tabId: string) => void
}

function trimDrafts(sqls: Record<string, string>): Record<string, string> {
  const entries = Object.entries(sqls).filter(([, sql]) => sql.length <= MAX_PERSISTED_SQL_CHARS)
  let total = 0
  const kept: Record<string, string> = {}
  for (let i = entries.length - 1; i >= 0; i--) {
    const [tabId, sql] = entries[i]
    total += sql.length
    if (total <= MAX_TOTAL_PERSISTED_SQL_CHARS) kept[tabId] = sql
  }
  return kept
}

export const useQueryStore = create<QueryStoreState>()(
  persist(
    (set) => ({
      sqls: {},
      setSql: (tabId, sql) =>
        set((s) => ({ sqls: trimDrafts({ ...s.sqls, [tabId]: sql }) })),
      removeSql: (tabId) =>
        set((s) => {
          const next = { ...s.sqls }
          delete next[tabId]
          return { sqls: next }
        }),
    }),
    {
      name: 'dbterm-query-sqls',
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
    }
  )
)
