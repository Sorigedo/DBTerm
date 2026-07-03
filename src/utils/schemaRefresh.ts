/**
 * 库表结构变更通知：任何 DDL / 导入操作完成后调用 notifySchemaChanged，
 * 让左侧库树与对象列表（SchemaBrowser）主动刷新，拿到最新库表/属性数据。
 */
export interface SchemaChange { connectionId: string; schema?: string }

const EVENT = 'dbterm:schema-changed'

export function notifySchemaChanged(connectionId: string, schema?: string) {
  window.dispatchEvent(new CustomEvent<SchemaChange>(EVENT, { detail: { connectionId, schema } }))
}

export function onSchemaChanged(cb: (d: SchemaChange) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent<SchemaChange>).detail)
  window.addEventListener(EVENT, h)
  return () => window.removeEventListener(EVENT, h)
}

// ── 在对象列表（SchemaBrowser）中打开某个工具面板 ──────────────────
export type DbTool = 'backup' | 'migrate' | 'structDiff' | 'dataDiff' | 'import'
export interface OpenDbTool { connectionId: string; schema: string; tool: DbTool }
const TOOL_EVENT = 'dbterm:open-db-tool'

export function openDbTool(connectionId: string, schema: string, tool: DbTool) {
  // 略延迟：等待新打开的对象列表标签挂载并注册监听
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent<OpenDbTool>(TOOL_EVENT, { detail: { connectionId, schema, tool } }))
  }, 220)
}

export function onOpenDbTool(cb: (d: OpenDbTool) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent<OpenDbTool>).detail)
  window.addEventListener(TOOL_EVENT, h)
  return () => window.removeEventListener(TOOL_EVENT, h)
}

// ── 全部折叠：通知每个库树收起内部展开的 schema / 类别节点 ──────────
const COLLAPSE_EVENT = 'dbterm:collapse-all-trees'
export function collapseAllTrees() { window.dispatchEvent(new Event(COLLAPSE_EVENT)) }
export function onCollapseAllTrees(cb: () => void): () => void {
  window.addEventListener(COLLAPSE_EVENT, cb)
  return () => window.removeEventListener(COLLAPSE_EVENT, cb)
}
