// 已存查询：保存在本地 localStorage（dbterm_saved_queries）。
// 左侧树会在每个数据库连接下挂载「保存的查询」节点（与 schema 同级）展示本连接的查询。
export interface SavedQuery {
  id: string
  name: string
  sql: string
  connId: string  // '' = 全局（所有连接可见）
  schema?: string // 保存时所在 schema（打开时回填）
  createdAt: number
}

const STORAGE_KEY = 'dbterm_saved_queries'
const EVENT = 'dbterm:saved-queries-changed'

export function loadSavedQueries(): SavedQuery[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') } catch { return [] }
}

/** 取某连接可见的查询：本连接的 + 全局的（connId===''），按时间倒序 */
export function savedQueriesForConn(connId: string): SavedQuery[] {
  return loadSavedQueries()
    .filter(q => q.connId === connId || q.connId === '')
    .sort((a, b) => b.createdAt - a.createdAt)
}

function persist(list: SavedQuery[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  window.dispatchEvent(new Event(EVENT))
}

export function addSavedQuery(p: { name: string; sql: string; connId: string; schema?: string }, now: number): SavedQuery {
  const item: SavedQuery = {
    id: `sq_${now}_${Math.floor(now % 100000)}`,
    name: p.name.trim() || '未命名查询',
    sql: p.sql,
    connId: p.connId,
    schema: p.schema,
    createdAt: now,
  }
  persist([item, ...loadSavedQueries()])
  return item
}

export function deleteSavedQuery(id: string): void {
  persist(loadSavedQueries().filter(q => q.id !== id))
}

export function renameSavedQuery(id: string, name: string): void {
  persist(loadSavedQueries().map(q => q.id === id ? { ...q, name: name.trim() || q.name } : q))
}

export function updateSavedQuery(id: string, sql: string): void {
  persist(loadSavedQueries().map(q => q.id === id ? { ...q, sql } : q))
}

/** 订阅保存查询的变更（增删改）→ 左侧树即时刷新。返回取消订阅函数 */
export function onSavedQueriesChanged(cb: () => void): () => void {
  window.addEventListener(EVENT, cb)
  return () => window.removeEventListener(EVENT, cb)
}
