import test from 'node:test'
import assert from 'node:assert/strict'
import { createDiffRequestOwner, diffCell, equalDiffCells, comparisonSampleSummary, isBinaryDiffType, diffEncodingLabel } from './dataDiffState.ts'

test('SET bitmap and ENUM internal index have explicit distinct Chinese labels', () => {
  assert.equal(diffEncodingLabel('set-bitmask'), 'SET 位图')
  assert.equal(diffEncodingLabel('enum-index'), 'ENUM 序号')
  assert.equal(diffEncodingLabel(undefined), null)
  assert.equal(diffEncodingLabel(''), null)
})

test('backend type disambiguates binary hex from literal hex-looking text', () => {
  for (const type of ['binary', 'varbinary', 'blob', 'bit', 'geometry', 'point']) assert.equal(isBinaryDiffType(type), true)
  for (const type of ['varchar', 'text', 'float', 'double', undefined]) assert.equal(isBinaryDiffType(type), false)
})

test('comparison owner rejects duplicate run and stale finalizer cannot release new run', () => {
  const owner = createDiffRequestOwner()
  const a = owner.begin()!
  assert.equal(owner.begin(), null)
  owner.invalidate()
  assert.equal(owner.current(a), false)
  assert.equal(owner.begin(), null)
  assert.equal(owner.finish(a), true)
  const b = owner.begin()!
  assert.equal(owner.finish(a), false)
  assert.equal(owner.current(b), true)
  assert.equal(owner.busy, true)
})

test('missing null empty text and binary-looking text remain distinct', () => {
  const missing = diffCell({}, 'v', false)
  const nil = diffCell({ v: null }, 'v', false)
  const empty = diffCell({ v: '' }, 'v', false)
  const text = diffCell({ v: '0x4142' }, 'v', false)
  const binary = diffCell({ v: '0x4142' }, 'v', true)
  assert.deepEqual([missing.kind, nil.kind, empty.kind, text.kind, binary.kind], ['missing', 'null', 'text', 'text', 'binary'])
  assert.equal(equalDiffCells(nil, empty), false)
  assert.equal(equalDiffCells(text, binary), false)
  assert.equal(equalDiffCells(empty, diffCell({ v: '' }, 'v', false)), true)
})

test('sample summary never claims an empty bounded sample has zero total differences', () => {
  assert.match(comparisonSampleSummary(17, 0, true), /17.*0.*样本/)
  assert.match(comparisonSampleSummary(300, 200, true), /300.*200.*样本/)
  assert.match(comparisonSampleSummary(3, 3, false), /3.*3.*样本/)
})
