/** 只补 SQL 文件的语句边界，不解析或重写源端定义。 */
export function terminateExportDdl(ddl: string, connType: string): string {
  const sql = ddl.trimEnd()
  if (!sql) return ''
  if (connType === 'sqlServer') return `${sql}\nGO\n`
  return `${sql}${sql.endsWith(';') ? '' : ';'}\n`
}
