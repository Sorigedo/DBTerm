import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface QueryStoreState {
  sqls: Record<string, string>          // tabId → sql text
  setSql: (tabId: string, sql: string) => void
  removeSql: (tabId: string) => void
}

export const useQueryStore = create<QueryStoreState>()(
  persist(
    (set) => ({
      sqls: {},
      setSql: (tabId, sql) =>
        set((s) => ({ sqls: { ...s.sqls, [tabId]: sql } })),
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
    }
  )
)
