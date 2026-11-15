import type { ConnType } from '../../types'
import { qid } from '../../utils/sqlDialect.ts'

interface ColumnSnapshot {
  name: string
  dataType: string
  nullable: boolean
  defaultValue: string
  comment: string
}

const UNSAFE_EDIT = '现有字段的完整定义无法从列摘要还原，请在 SQL 编辑器中修改原始 DDL'

/** MySQL 的 RENAME COLUMN 不重写定义；其余属性只有完整 DDL 才能安全修改。 */
export function mysqlExistingColumnAlter(
  connType: ConnType, original: ColumnSnapshot, current: ColumnSnapshot, invisibleChanged: boolean,
): { sql?: string; error?: string } {
  if (invisibleChanged || current.dataType !== original.dataType || current.nullable !== original.nullable
    || current.defaultValue !== original.defaultValue || current.comment !== original.comment) {
    return { error: UNSAFE_EDIT }
  }
  return current.name !== original.name
    ? { sql: `RENAME COLUMN ${qid(connType, original.name)} TO ${qid(connType, current.name)}` }
    : {}
}
