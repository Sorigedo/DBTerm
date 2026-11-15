import assert from 'node:assert/strict'
import test from 'node:test'
import { supportedMigrationStrategies } from './migrationChoices.ts'

test('structure migrations offer only safe whole-definition strategies', () => {
  assert.deepEqual(supportedMigrationStrategies('both'), ['replace', 'skip'])
  assert.deepEqual(supportedMigrationStrategies('structure'), ['replace', 'skip'])
})

test('data-only migrations allow strategies backed by the safe server path', () => {
  assert.deepEqual(supportedMigrationStrategies('data'), ['replace', 'truncate', 'append', 'skip'])
})
