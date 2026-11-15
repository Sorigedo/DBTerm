interface MigrationOutcome {
  failedRows: number
  errors: string[]
  migratedRows?: number
  totalRows?: number
}

export function migrationResultFailure(result: MigrationOutcome, strategy: string): string | null {
  if (result.failedRows > 0) return `${result.failedRows} 行失败${result.errors[0] ? `（${result.errors[0]}）` : ''}`
  const intendedSkip = strategy === 'skip' && result.migratedRows === 0 && result.totalRows === 0
    && result.errors.length === 1 && result.errors[0] === '目标表已存在，按「跳过」策略未迁移'
  const failures = result.errors.filter(message => !isBackupNotice(message))
  return failures.length > 0 && !intendedSkip ? failures.join('；') : null
}

function isBackupNotice(message: string): boolean {
  return message.startsWith('旧目标完整保留为备份 ') && message.endsWith('；确认业务数据后再手动清理')
}

export function migrationResultNotices(result: Pick<MigrationOutcome, 'errors'>): string[] {
  return result.errors.filter(isBackupNotice)
}

export function markMigrationUnexecuted<T extends { stage: string; done: boolean }>(items: T[], start: number): (T & { unexecuted?: boolean })[] {
  return items.map((item, index) => index < start || item.done ? item : { ...item, stage: '未执行', unexecuted: true })
}

export interface MigrationVerificationResult {
  table: string
  srcCount: number
  dstCount: number
  countMatch: boolean
  contentChecked?: boolean
  contentMatch?: boolean
  structureMatch?: boolean
  snapshotBoundary?: string
  error?: string
}

export function migrationVerificationLabel(result: Pick<MigrationVerificationResult, 'countMatch' | 'contentChecked' | 'contentMatch' | 'structureMatch' | 'error'>): string {
  const queryFailed = result.error && result.error !== '仅完成行数比较；未执行内容校验，不能据此确认数据一致'
  if (queryFailed) return '校验失败'
  if (result.structureMatch === false) return '结构不同'
  if (!result.countMatch) return '行数不同'
  if (result.contentChecked === true && result.contentMatch === false) return '内容不同'
  if (result.contentChecked === true && result.contentMatch === true && result.structureMatch === true) return '结构及全量内容指纹一致'
  return '行数相同，内容未校验'
}

export const MIGRATION_BATCH_BOUNDARY = '各对象独立执行并提交，不是整批事务，也不共享全库快照。首个错误后停止后续对象；此前已提交对象不会自动回滚。源库在迁移期间继续写入时，不能保证整库处于同一时点。'
