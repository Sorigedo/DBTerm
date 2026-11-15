import test from 'node:test'
import assert from 'node:assert/strict'
import { stageCellUpdate, type CellUpdate } from './stagedCellUpdates.ts'

test('staging edits leaves database result immutable and preserves original key', () => {
  const source = Object.freeze([Object.freeze(['001', 'old'])])
  const first = stageCellUpdate([], 0, 0, source[0][0], '002', ['001'])
  const next = stageCellUpdate(first, 0, 1, source[0][1], 'new', ['002'])
  assert.deepEqual(source, [['001', 'old']])
  assert.deepEqual(next.map(c => c.pkValues), [['001'], ['001']])
  assert.equal(next[1].oldVal, 'old')
})

test('reediting a cell preserves undo baseline and reverting removes staged write', () => {
  let changes: CellUpdate[] = stageCellUpdate([], 0, 1, 'old', 'middle', ['001'])
  changes = stageCellUpdate(changes, 0, 1, 'old', 'last', ['001'])
  assert.equal(changes[0].oldVal, 'old')
  assert.equal(changes[0].newVal, 'last')
  assert.deepEqual(stageCellUpdate(changes, 0, 1, 'old', 'old', ['001']), [])
})

test('NULL and empty string remain distinct staged values', () => {
  assert.equal(stageCellUpdate([], 0, 1, null, '', ['001'])[0].newVal, '')
  assert.equal(stageCellUpdate([], 0, 1, '', null, ['001'])[0].newVal, null)
})
