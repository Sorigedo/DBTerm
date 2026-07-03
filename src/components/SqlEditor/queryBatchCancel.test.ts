import assert from 'node:assert/strict'
import test from 'node:test'
import { markBatchCancelledFrom } from './queryBatchCancel.ts'

test('batch cancel marks current and queued statements without changing completed statements', () => {
  const rows = markBatchCancelledFrom([
    { result: { rows: [] }, error: '' },
    { result: null, error: '' },
    { result: null, error: '' },
  ], 1)

  assert.equal(rows[0].cancelled, undefined)
  assert.equal(rows[1].cancelled, true)
  assert.equal(rows[1].error, '查询已取消')
  assert.equal(rows[2].cancelled, true)
  assert.equal(rows[2].error, '')
})

test('batch cancel does not overwrite statements that already failed', () => {
  const rows = markBatchCancelledFrom([
    { result: null, error: '语法错误' },
    { result: null, error: '' },
  ], 0)

  assert.equal(rows[0].cancelled, undefined)
  assert.equal(rows[0].error, '语法错误')
  assert.equal(rows[1].cancelled, true)
})
