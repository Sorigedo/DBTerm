const KEY = 'dbterm_rollback_sql'
const MAX = 500

export interface RollbackEntry {
  id: string
  ts: number
  connId: string
  schema: string
  table: string
  sql: string
  description: string
}

export function appendRollback(entry: Omit<RollbackEntry, 'id'>) {
  try {
    const raw = localStorage.getItem(KEY)
    const list: RollbackEntry[] = raw ? JSON.parse(raw) : []
    list.unshift({ ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2)}` })
    if (list.length > MAX) list.length = MAX
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch { /* quota */ }
}

export function loadRollback(): RollbackEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export function clearRollback() {
  localStorage.removeItem(KEY)
}
