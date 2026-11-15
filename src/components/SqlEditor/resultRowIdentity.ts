export interface ResultRowIdentity<T> { row: T; sourceIndex: number }

export function projectResultRows<T>(
  rows: readonly T[], include: (row: T) => boolean, compare?: (left: T, right: T) => number,
): ResultRowIdentity<T>[] {
  const projected: ResultRowIdentity<T>[] = []
  rows.forEach((row, sourceIndex) => { if (include(row)) projected.push({ row, sourceIndex }) })
  if (compare) projected.sort((left, right) => compare(left.row, right.row))
  return projected
}

export function rowRangeSourceIndices<T>(rows: readonly ResultRowIdentity<T>[], first: number, last: number): number[] {
  const a = rows.findIndex(row => row.sourceIndex === first)
  const b = rows.findIndex(row => row.sourceIndex === last)
  if (a < 0 || b < 0) return []
  return rows.slice(Math.min(a, b), Math.max(a, b) + 1).map(row => row.sourceIndex)
}
