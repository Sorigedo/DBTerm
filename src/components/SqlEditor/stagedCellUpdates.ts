export interface CellUpdate {
  type: 'update'
  absRow: number
  col: number
  oldVal: string | null
  newVal: string | null
  pkValues: (string | null)[]
}

export function stageCellUpdate<T extends { type: string }>(
  changes: readonly T[], absRow: number, col: number, oldVal: string | null,
  newVal: string | null, pkValues: (string | null)[],
): (T | CellUpdate)[] {
  const isUpdate = (change: T): change is T & CellUpdate => change.type === 'update'
  const original = changes.find(change => isUpdate(change) && change.absRow === absRow)
  const existing = changes.find(change => isUpdate(change) && change.absRow === absRow && change.col === col)
  const baseline = existing && isUpdate(existing) ? existing.oldVal : oldVal
  const rest = changes.filter(change => !(isUpdate(change) && change.absRow === absRow && change.col === col))
  if (baseline === newVal) return rest
  return [...rest, { type: 'update', absRow, col, oldVal: baseline, newVal, pkValues: original && isUpdate(original) ? original.pkValues : pkValues }]
}
