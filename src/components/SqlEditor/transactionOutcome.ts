const rollbackMarker = 'DBTERM_TX_ROLLED_BACK:'
export function transactionFinishError(statement: 'BEGIN' | 'COMMIT' | 'ROLLBACK', error: unknown): string {
  const message=String(error)
  if(message.startsWith(rollbackMarker))return message.slice(rollbackMarker.length)
  return statement==='COMMIT' ? '提交结果未确认：'+message+'；请核查数据库，勿重复执行写操作。' : message
}
export function transactionCommitFailure(error: unknown) {
  return {
    message: transactionFinishError('COMMIT',error),
    skipped: String(error).startsWith(rollbackMarker) ? '事务已回滚，后续语句未执行' : '提交结果未确认，后续语句未执行；请核查数据库',
  }
}
