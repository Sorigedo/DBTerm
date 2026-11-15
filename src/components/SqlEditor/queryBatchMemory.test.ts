import assert from 'node:assert/strict'
import test from 'node:test'
import { BatchResultBudget } from './queryBatchMemory.ts'

test('batch memory includes UTF-16 strings and stops before subsequent SQL', () => {
  const budget = new BatchResultBudget(86, 10)
  const result = { columns: ['x'], rows: [['中文']] }
  assert.equal(budget.beforeNextStatement(), null)
  budget.retain(result)
  assert.match(budget.beforeNextStatement() ?? '', /后续语句未执行/)
  assert.deepEqual(result.rows, [['中文']])
})

test('batch rows accumulate across result sets without discarding prior results', () => {
  const budget = new BatchResultBudget(10000, 2)
  budget.retain({ columns: ['x'], rows: [['a']] })
  assert.equal(budget.beforeNextStatement(), null)
  budget.retain({ columns: ['x'], rows: [['b']] })
  assert.match(budget.beforeNextStatement() ?? '', /后续语句未执行/)
})

test('empty write results do not consume retained row count', () => {
  const budget = new BatchResultBudget(10000, 1)
  budget.retain({ columns: [], rows: [] })
  assert.equal(budget.beforeNextStatement(), null)
  budget.retain({ columns: ['x'], rows: [[null]] })
  assert.match(budget.beforeNextStatement() ?? '', /内存/)
})
