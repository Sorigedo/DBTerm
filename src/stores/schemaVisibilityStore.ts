import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface SchemaVisibilityState {
  // connId → array of HIDDEN schema names (empty = all visible)
  hidden: Record<string, string[]>
  setHidden: (connId: string, schemas: string[]) => void
  getHidden: (connId: string) => string[]
}

export const useSchemaVisibilityStore = create<SchemaVisibilityState>()(
  persist(
    (set, get) => ({
      hidden: {},
      setHidden: (connId, schemas) =>
        set(s => ({ hidden: { ...s.hidden, [connId]: schemas } })),
      getHidden: (connId) => get().hidden[connId] ?? [],
    }),
    { name: 'dbterm-schema-visibility' }
  )
)
