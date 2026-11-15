import type { ConnType } from '../../types'
import { qid } from '../../utils/sqlDialect.ts'

interface ColumnSummary {
  name: string
  baseType: string
  length: string
  unsigned: boolean
  nullable: boolean
  primaryKey: boolean
  autoIncrement: boolean
  defaultType: string
  defaultValue: string
  comment: string
}

export function validateExistingTableTarget(current: string, original: string): string | null {
  return current === original ? null : '修改表结构不能更改原表名称，请返回原表或使用单独的重命名功能'
}

export function existingMysqlColumnEdit(connType: ConnType, original: ColumnSummary, current: ColumnSummary): { sql?: string; error?: string } {
  const fields: (keyof ColumnSummary)[] = [
    'baseType', 'length', 'unsigned', 'nullable', 'primaryKey', 'autoIncrement', 'defaultType', 'defaultValue', 'comment',
  ]
  if (fields.some(field => original[field] !== current[field])) {
    return { error: '现有字段的完整定义无法从列摘要还原，请在 SQL 编辑器中修改原始 DDL' }
  }
  return original.name !== current.name
    ? { sql: `RENAME COLUMN ${qid(connType, original.name)} TO ${qid(connType, current.name)}` }
    : {}
}
