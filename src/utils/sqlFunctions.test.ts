import test from 'node:test'
import assert from 'node:assert/strict'
import { sqlFunctionsForDialect } from './sqlFunctions.ts'

test('mysql-family completion includes SUBDATE', () => {
  for (const dialect of ['mysql', 'mariadb', 'tidb', 'oceanBase'] as const) {
    assert.ok(sqlFunctionsForDialect(dialect).includes('SUBDATE'))
  }
})

test('dialect completion does not mix unrelated date functions', () => {
  assert.ok(sqlFunctionsForDialect('sqlServer').includes('DATEADD'))
  assert.ok(!sqlFunctionsForDialect('sqlServer').includes('SUBDATE'))
  assert.ok(sqlFunctionsForDialect('postgres').includes('DATE_TRUNC'))
  assert.ok(!sqlFunctionsForDialect('postgres').includes('DATEADD'))
})
