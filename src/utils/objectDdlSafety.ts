/** Editing and saving must never silently rewrite security clauses or add DROP. */
export function preserveObjectDdl(raw: string): string { return raw }
export function objectSaveSql(edited: string): string { return edited }
