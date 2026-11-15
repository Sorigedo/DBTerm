export function createDiffRequestOwner() {
  let epoch = 0
  let active: number | null = null
  return {
    get busy() { return active !== null },
    begin() {
      if (active !== null) return null
      active = ++epoch
      return active
    },
    invalidate() { epoch++ },
    current(token: number) { return active === token && epoch === token },
    finish(token: number) {
      if (active !== token) return false
      active = null
      return true
    },
  }
}

export type DiffCell =
  | { kind: 'missing' | 'null'; value: null }
  | { kind: 'text' | 'binary'; value: string }

export function diffCell(row: Record<string, string | null>, column: string, binary: boolean): DiffCell {
  if (!Object.prototype.hasOwnProperty.call(row, column)) return { kind: 'missing', value: null }
  if (row[column] === null) return { kind: 'null', value: null }
  return { kind: binary ? 'binary' : 'text', value: row[column] }
}

export function equalDiffCells(left: DiffCell, right: DiffCell): boolean {
  return left.kind === right.kind && left.value === right.value
}

export function isBinaryDiffType(type: string | undefined): boolean {
  return ['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit', 'geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection'].includes(type?.toLowerCase() ?? '')
}

export function diffEncodingLabel(encoding: string | undefined): string | null {
  if (encoding === 'set-bitmask') return 'SET 位图'
  if (encoding === 'enum-index') return 'ENUM 序号'
  return null
}

export function comparisonSampleSummary(total: number, retained: number, capped: boolean): string {
  return `此分类共 ${total.toLocaleString()} 处差异，显示 ${retained.toLocaleString()} 条样本${capped ? '（受条数或内存上限限制）' : ''}`
}
