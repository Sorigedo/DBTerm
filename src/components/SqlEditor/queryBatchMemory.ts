interface RetainedResult {
  columns: string[]
  rows: (string | null)[][]
}

/** Logical retained size, not a browser heap/RSS ceiling. The result that crosses
 * the budget is preserved; stop before issuing another SQL statement. */
export class BatchResultBudget {
  private bytes = 0
  private rows = 0
  private readonly maxBytes: number
  private readonly maxRows: number

  constructor(maxBytes = 32 * 1024 * 1024, maxRows = 100_000) {
    this.maxBytes = maxBytes
    this.maxRows = maxRows
  }

  retain(result: RetainedResult): void {
    for (const column of result.columns) this.bytes += 24 + column.length * 2
    for (const row of result.rows) {
      this.rows++
      this.bytes += 24 + row.length * 8
      for (const value of row) if (value !== null) this.bytes += 24 + value.length * 2
    }
  }

  beforeNextStatement(): string | null {
    return this.rows >= this.maxRows || this.bytes >= this.maxBytes
      ? '批次累计结果已达到内存保护上限，已保留已执行结果，后续语句未执行。请关闭结果区释放内存，或分批查询/使用流式导出。'
      : null
  }
}
