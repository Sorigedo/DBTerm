export interface CancellableBatchItem {
  result: unknown | null
  error: string
  cancelled?: boolean
}

export function markBatchCancelledFrom<T extends CancellableBatchItem>(
  items: T[],
  startIndex: number,
  message = '查询已取消',
): T[] {
  return items.map((item, index) => {
    if (index < startIndex || item.result || item.error || item.cancelled) return item
    return {
      ...item,
      cancelled: true,
      error: index === startIndex ? message : item.error,
    }
  })
}
