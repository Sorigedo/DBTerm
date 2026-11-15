export function planAtomicSave(changes: readonly { type: 'insert' | 'delete' | 'update' }[]): 'insert' | 'delete' | 'update' {
  const kinds = new Set(changes.map(change => change.type))
  if (kinds.size !== 1) throw new Error('本次同时包含新增/修改/删除，尚不支持原子保存，请分别保存；暂存变更已保留')
  return changes[0].type
}
