/** COMMIT may have reached the server even when its acknowledgement is lost. */
export function shouldRollbackAfterControlFailure(control: string | null | undefined): boolean {
  return control !== 'commit'
}

export async function rollbackOwnedTransaction(
  owned: boolean, active: boolean, rollback: () => Promise<unknown>,
): Promise<{ attempted: boolean; confirmed: boolean; error: string }> {
  if (!owned || !active) return { attempted: false, confirmed: false, error: '' }
  try {
    await rollback()
    return { attempted: true, confirmed: true, error: '' }
  } catch (error) {
    return { attempted: true, confirmed: false, error: `回滚未确认：${String(error)}；请核查数据库，勿重复写入。` }
  }
}
