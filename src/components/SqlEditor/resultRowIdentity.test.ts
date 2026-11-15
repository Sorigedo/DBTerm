import test from 'node:test'
import assert from 'node:assert/strict'
import { projectResultRows, rowRangeSourceIndices } from './resultRowIdentity.ts'

test('sort filter and virtual window retain original row IDs and exact keys', () => {
  const source = [['9007199254740993', 'z'], ['0002', 'a'], ['3', 'b']]
  const visible = projectResultRows(source, row => row[1] !== 'z', (a, b) => b[1].localeCompare(a[1]))
  assert.deepEqual(visible.map(r => r.sourceIndex), [2, 1])
  const window = visible.slice(1, 2)
  assert.equal(source[window[0].sourceIndex][0], '0002')
  assert.equal(window[0].row, source[1])
  assert.deepEqual(rowRangeSourceIndices(visible, 2, 1), [2, 1])
  assert.deepEqual(source, [['9007199254740993', 'z'], ['0002', 'a'], ['3', 'b']])
})

test('identical values and reused array references still retain distinct source positions', () => {
  const same = ['1', 'a']
  const visible = projectResultRows([same, same, ['1', 'a']], () => true)
  assert.deepEqual(visible.map(r => r.sourceIndex), [0, 1, 2])
})

test('changing result creates a fresh projection without old source identities', () => {
  const old = projectResultRows([['A'], ['B']], () => true).reverse()
  const fresh = projectResultRows([['C']], () => true)
  assert.equal(old[0].sourceIndex, 1)
  assert.equal(fresh[0].sourceIndex, 0)
  assert.deepEqual(rowRangeSourceIndices(fresh, 9, 0), [])
})
