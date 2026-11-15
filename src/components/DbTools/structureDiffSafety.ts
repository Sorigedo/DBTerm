export function structureDiffSelectionKey(selection: readonly string[]): string {
  return JSON.stringify(selection)
}

export function isCurrentStructureDiff(resultKey: string | null, selection: readonly string[]): boolean {
  return resultKey !== null && resultKey === structureDiffSelectionKey(selection)
}

export function currentStructureDiffResult<T>(resultKey: string | null, selection: readonly string[], result: T | null): T | null {
  return isCurrentStructureDiff(resultKey, selection) ? result : null
}
