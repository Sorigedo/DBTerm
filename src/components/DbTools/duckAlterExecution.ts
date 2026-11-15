type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>
export class DuckAlterOutcomeUnknown extends Error {}

/** Preserve the preview SQL; the backend owns an isolated transaction. */
export async function executeDuckAlter(invoke: Invoke, id: string, statements: string[]): Promise<void> {
  if (!statements.length) return
  try { await invoke('duckdb_alter_table_atomic', { id, statements }) }
  catch (error) {
    // Transport failures cannot prove whether COMMIT reached the engine.
    throw new DuckAlterOutcomeUnknown(`${String(error)}；执行未获成功确认，请核查数据库，勿重复执行`)
  }
}
