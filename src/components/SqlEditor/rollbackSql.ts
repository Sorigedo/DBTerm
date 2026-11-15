import type { CellUpdate } from './stagedCellUpdates.ts'
import { qid } from '../../utils/sqlDialect.ts'

export function rollbackScalarLiteral(connType: string, value: string | null): string {
  if (value === null) return 'NULL'
  if (['mysql', 'mariadb', 'tidb', 'oceanBase'].includes(connType)) {
    const hex = Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join('')
    return `CONVERT(X'${hex}' USING utf8mb4)`
  }
  const quoted = value.split("'").join("''")
  if (['postgres', 'kingBase', 'openGauss'].includes(connType)) {
    if (value.includes(String.fromCharCode(0))) throw new Error('无法生成可靠回滚 SQL：文本包含零字节')
    return `E'${quoted.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92))}'`
  }
  return `${connType === 'sqlServer' ? 'N' : ''}'${quoted}'`
}

export function requireRollbackScalarType(column: string, columnTypes: Record<string, string>) {
  const type = (columnTypes[column] ?? '').toLowerCase()
  if (!type || /(blob|binary|bytea|raw|image|geometry|geography|point|polygon|linestring|bit|array|interval)/.test(type)) {
    throw new Error(`无法生成可靠回滚 SQL：${column} 缺少标量类型或属于二进制/特殊类型`)
  }
}

export function buildRollbackUpdates(
  connType: string, table: string, columns: readonly string[], pkColumns: readonly string[],
  columnTypes: Record<string, string>, updates: readonly CellUpdate[],
): string[] {
  const grouped = new Map<number, CellUpdate[]>()
  for (const update of updates) {
    const row = grouped.get(update.absRow) ?? []
    row.push(update)
    grouped.set(update.absRow, row)
  }
  return [...grouped.values()].reverse().map(row => {
    const sets = row.map(update => {
      const column = columns[update.col]
      requireRollbackScalarType(column, columnTypes)
      return `${qid(connType, column)} = ${rollbackScalarLiteral(connType, update.oldVal)}`
    })
    if (!pkColumns.length) throw new Error('无法生成可靠回滚 SQL：缺少主键')
    const where = pkColumns.map((pk, index) => {
      requireRollbackScalarType(pk, columnTypes)
      const changed = row.find(update => columns[update.col] === pk)
      const value = changed ? changed.newVal : row[0].pkValues[index]
      if (value === undefined) throw new Error('无法生成可靠回滚 SQL：主键不完整')
      return value === null ? `${qid(connType, pk)} IS NULL` : `${qid(connType, pk)} = ${rollbackScalarLiteral(connType, value)}`
    })
    return `UPDATE ${table} SET ${sets.join(', ')} WHERE ${where.join(' AND ')};`
  })
}
