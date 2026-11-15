import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const grid = readFileSync(new URL('./ResultTable.tsx', import.meta.url), 'utf8')
const editor = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8')

test('result grid mutates staged overlay only and dispatches original source row IDs', () => {
  assert.doesNotMatch(grid, /onCellUpdate/)
  assert.match(grid, /absRow: sourceIndex, visibleIndex/)
  assert.ok(grid.includes('onCellMouseDown(e, visibleIndex, vi)'))
  assert.ok(grid.includes('getPkValues(absRow)'))
  assert.ok(grid.includes('startCellEdit(formSourceIndex, i'))
  assert.ok(grid.includes('rowRangeSourceIndices(visibleRows, a, b)'))
})

test('SQL run entry points and transaction buttons share synchronous execution gate', () => {
  for (const name of ['runQuery', 'runQueryForced', 'runTx']) {
    const entry = editor.slice(editor.indexOf(`const ${name} = useCallback(async`))
    assert.ok(entry.slice(0, 200).includes('if (executionBusyRef.current) return'))
  }
  assert.doesNotMatch(editor, /数据库已确认取消|本地连接已断开/)
})
