import test from 'node:test'
import assert from 'node:assert/strict'
import { structureDiffSelectionKey, isCurrentStructureDiff, currentStructureDiffResult } from './structureDiffSafety.ts'

test('schema diff results remain bound to original source and target selection', () => {
  const original = ['table', 'src', 'a', 'one', 'dst', 'b', 'two']
  const key = structureDiffSelectionKey(original)
  assert.equal(isCurrentStructureDiff(key, original), true)
  for (let i = 0; i < original.length; i++) {
    const changed = [...original]; changed[i] += '-changed'
    assert.equal(isCurrentStructureDiff(key, changed), false)
  }
  assert.equal(isCurrentStructureDiff(null, original), false)
})

test('selection keys preserve identifier boundaries and cannot alias', () => {
  assert.notEqual(structureDiffSelectionKey(['a:b', 'c']), structureDiffSelectionKey(['a', 'b:c']))
})

test('old compare results never display under a newly selected source or target', () => {
  const original = ['table', 'src', 'db_a', 'old', 'dst', 'db_b', 'target']
  const result = { added: [], removed: [], modified: [] }
  const key = structureDiffSelectionKey(original)
  assert.equal(currentStructureDiffResult(key, original, result), result)
  assert.equal(currentStructureDiffResult(key, [...original.slice(0, 3), 'new', ...original.slice(4)], result), null)
  assert.equal(currentStructureDiffResult(null, original, result), null)
})

test('whole schema compare uses one backend snapshot instead of releasing each table lock independently', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('./StructureDiffPanel.tsx', import.meta.url), 'utf8')
  assert.ok(source.includes("'db_diff_schema_snapshot'"))
  assert.ok(!source.includes('const worker = async () =>'))
})
