import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMysqlTableOptionClauses, shouldFetchMysqlCollations } from './createTableSql.ts'

test('does not fetch collations using the edit form default before original metadata arrives', () => {
  assert.equal(shouldFetchMysqlCollations(true, true, false, 'utf8mb4'), false)
  assert.equal(shouldFetchMysqlCollations(true, true, true, 'latin1'), true)
  assert.equal(shouldFetchMysqlCollations(true, false, true, 'utf8mb4'), true)
})

test('does not append default table charset when table options were not loaded', () => {
  assert.deepEqual(buildMysqlTableOptionClauses({
    loaded: false,
    engine: 'InnoDB',
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
    originalEngine: '',
    originalCharset: '',
    originalCollation: '',
  }), [])
})

test('includes changed table charset only after options were loaded', () => {
  assert.deepEqual(buildMysqlTableOptionClauses({
    loaded: true,
    engine: 'InnoDB',
    charset: 'latin1',
    collation: 'latin1_bin',
    originalEngine: 'InnoDB',
    originalCharset: 'utf8mb4',
    originalCollation: 'utf8mb4_unicode_ci',
  }), ['  DEFAULT CHARSET=latin1', '  COLLATE=latin1_bin'])
})

test('does not append the UI default charset when loaded table metadata has no charset snapshot', () => {
  assert.deepEqual(buildMysqlTableOptionClauses({
    loaded: true,
    engine: 'InnoDB',
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
    originalEngine: 'InnoDB',
    originalCharset: '',
    originalCollation: '',
  }), [])
})
