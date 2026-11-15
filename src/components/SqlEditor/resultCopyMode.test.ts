import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveResultCopyMode } from './resultCopyMode.ts'

test('Mod+C prefers real text selection over structured result selections', () => {
  assert.equal(
    resolveResultCopyMode({
      inputSelection: false,
      editorOrInput: false,
      textSelection: true,
      selectedRows: true,
      cellSelection: true,
      focusedCell: true,
    }),
    'text-selection',
  )
})

test('Mod+C falls back to result table structure when no text is selected', () => {
  assert.equal(
    resolveResultCopyMode({
      inputSelection: false,
      editorOrInput: false,
      textSelection: false,
      selectedRows: true,
      cellSelection: true,
      focusedCell: true,
    }),
    'rows',
  )
  assert.equal(
    resolveResultCopyMode({
      inputSelection: false,
      editorOrInput: false,
      textSelection: false,
      selectedRows: false,
      cellSelection: true,
      focusedCell: true,
    }),
    'cells',
  )
})
