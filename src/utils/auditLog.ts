const STORAGE_KEY = 'dbterm_audit_log'
const MAX_ENTRIES = 2000

export interface AuditEntry {
  id: string
  ts: number
  connId: string
  connName: string
  sql: string
  rowsAffected: number
  success: boolean
  error?: string
}

export function appendAuditLog(entry: Omit<AuditEntry, 'id'>) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const list: AuditEntry[] = raw ? JSON.parse(raw) : []
    list.unshift({ ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2)}` })
    if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch { /* quota exceeded - silent */ }
}

export function loadAuditLog(): AuditEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export function clearAuditLog() {
  localStorage.removeItem(STORAGE_KEY)
}

export { MAX_ENTRIES }
