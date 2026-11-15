export interface TableDraftInsert { columns: string[]; values: (string | null)[] }

/** Validate the complete user action before the only transactional IPC call. */
export async function insertTableDrafts(input: {
  columns: string[]
  drafts: Record<string, string>[]
  submit: (rows: TableDraftInsert[]) => Promise<number>
}): Promise<number> {
  if (!input.drafts.length || input.drafts.length > 10000) throw new Error('新增行数必须介于 1 和 10000')
  const known = new Set(input.columns)
  if (!known.size || known.size !== input.columns.length) throw new Error('无法确定唯一字段列表，请刷新表结构')
  let bytes = 0
  const rows = input.drafts.map((draft, index) => {
    if (Object.keys(draft).some(column => !known.has(column))) throw new Error('新增数据含未知字段，请刷新表结构')
    const columns = input.columns.filter(column => draft[column] !== undefined && draft[column] !== '')
    if (!columns.length) throw new Error('第 ' + (index + 1) + ' 行未填写任何字段，整批未提交')
    const row = { columns, values: columns.map(column => draft[column]) }
    bytes += JSON.stringify(row).length * 3
    if (bytes > 8 * 1024 * 1024) throw new Error('新增数据超过 8 MiB 安全预算，请分批操作')
    return row
  })
  return input.submit(rows)
}
