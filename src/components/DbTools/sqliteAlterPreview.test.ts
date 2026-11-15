import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('SQLite ALTER confirmation is invalidated by any edit and target change', () => {
  const source = readFileSync(new URL('./AlterTableWizard.tsx', import.meta.url), 'utf8')
  assert.ok(source.includes('sqlitePreviewKey === sqliteChangeKey'))
  assert.ok(source.includes('sqliteChangeRef.current === requestedKey'))
  assert.ok(source.includes('setSqlitePreviewKey(requestedKey)'))
  assert.ok(source.includes('!currentSqlitePreview'))
})
