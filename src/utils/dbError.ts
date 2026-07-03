// 把后端返回的原始数据库错误映射为面向用户的友好提示。
// 主要处理「权限不足」（MySQL 1142 / PG 42501 / access denied 等），避免直接甩裸 SQL 错误。
export function friendlyDbError(e: unknown): string {
  const s = String(e)
  const low = s.toLowerCase()
  if (
    low.includes('command denied') || low.includes('1142') ||
    low.includes('access denied') || low.includes('42501') ||
    low.includes('permission denied') || low.includes('insufficient privilege')
  ) {
    const m = /for table '([^']+)'/i.exec(s)
    const tbl = m ? `「${m[1]}」` : '该系统视图'
    return `当前账号权限不足：无法读取${tbl}。该功能需要 performance_schema / information_schema 等系统库的 SELECT 权限，请改用更高权限的账号。`
  }
  return s
}
