export interface CancellableBatchItem {
  result: unknown | null
  error: string
  cancelled?: boolean
  skipped?: boolean
}

export function markBatchSkippedFrom<T extends CancellableBatchItem>(
  items: T[],
  startIndex: number,
  message = '前序语句执行失败，后续语句未执行',
): T[] {
  return items.map((item, index) => {
    if (index < startIndex || item.result || item.error || item.cancelled || item.skipped) return item
    return {
      ...item,
      skipped: true,
      error: index === startIndex ? message : item.error,
    }
  })
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
