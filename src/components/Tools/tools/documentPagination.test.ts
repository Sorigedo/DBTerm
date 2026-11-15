import test from 'node:test'
import assert from 'node:assert/strict'
import { paginateMeasuredItems } from './documentPagination.ts'

test('pagination keeps the previous accepted chunk when the next item overflows', () => {
  const result = paginateMeasuredItems([1, 2, 3, 4, 5], chunk => chunk.reduce((sum, n) => sum + n, 0) <= 5)

  assert.deepEqual(result.pages, [[1, 2], [3], [4], [5]])
  assert.deepEqual(result.dropped, [])
})
