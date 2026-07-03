// S4.5 schema 变更历史（DDL 类语句自动记录）
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface SchemaChangeEntry {
  id: string
  connId: string
  sql: string
  at: number
  userVersionBefore: number
  userVersionAfter: number
}

const MAX_ENTRIES = 200

interface SchemaHistoryState {
  entries: SchemaChangeEntry[]
  addEntry: (entry: Omit<SchemaChangeEntry, 'id'>) => void
  remove: (id: string) => void
  clear: (connId: string) => void
}

export const DDL_PATTERNS = [
  /^\s*CREATE\s+(TABLE|INDEX|VIEW|TRIGGER|VIRTUAL)/i,
  /^\s*ALTER\s+TABLE/i,
  /^\s*DROP\s+(TABLE|INDEX|VIEW|TRIGGER)/i,
  /^\s*RENAME\s+TABLE/i,
]

export function isDdlStatement(sql: string): boolean {
  return DDL_PATTERNS.some(p => p.test(sql.trim()))
}

export const useSchemaHistoryStore = create<SchemaHistoryState>()(
  persist(
    (set) => ({
      entries: [],

      addEntry: (entry) => set(s => {
        const newEntry: SchemaChangeEntry = { ...entry, id: `sh-${Date.now()}-${Math.random().toString(36).slice(2,7)}` }
        const entries = [newEntry, ...s.entries].slice(0, MAX_ENTRIES)
        return { entries }
      }),

      remove: (id) => set(s => ({ entries: s.entries.filter(e => e.id !== id) })),

      clear: (connId) => set(s => ({ entries: s.entries.filter(e => e.connId !== connId) })),
    }),
    { name: 'dbterm_schema_history' }
  )
)
