import test from 'node:test'
import assert from 'node:assert/strict'
import type { ConnType } from '../types/index.ts'
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

test('mysql-family completion covers timestamp, math, string, json and window functions', () => {
  const functions = sqlFunctionsForDialect('mysql')
  for (const name of [
    'UNIX_TIMESTAMP', 'FROM_UNIXTIME', 'JSON_TABLE', 'JSON_CONTAINS',
    'REGEXP_LIKE', 'SUBSTRING_INDEX', 'FORMAT', 'LEAD', 'LAG', 'NTILE',
  ]) assert.ok(functions.includes(name), name)
})

test('major dialects expose their native function families', () => {
  const cases = {
    postgres: ['STRING_TO_ARRAY', 'UNNEST', 'GEN_RANDOM_UUID', 'JSONB_SET', 'WIDTH_BUCKET'],
    sqlServer: ['EOMONTH', 'TRY_CONVERT', 'STRING_ESCAPE', 'HASHBYTES', 'SCOPE_IDENTITY'],
    oracle: ['DBMS_LOB', 'UTL_RAW', 'REGEXP_SUBSTR', 'SYS_EXTRACT_UTC', 'DUMP'],
    sqlite: ['UNICODE', 'CHAR', 'JSON_EACH', 'JSON_TREE', 'LAST_INSERT_ROWID'],
    duckdb: ['APPROX_COUNT_DISTINCT', 'QUANTILE_CONT', 'READ_CSV', 'UNNEST', 'EPOCH_MS'],
    clickHouse: ['TO_UNIXTIMESTAMP', 'FORMATDATETIME', 'JSONEXTRACTSTRING', 'GROUPARRAY', 'QUANTILE'],
  } as const
  for (const [dialect, names] of Object.entries(cases)) {
    const functions = sqlFunctionsForDialect(dialect as ConnType)
    for (const name of names) assert.ok(functions.includes(name), `${dialect}:${name}`)
  }
})

test('every SQL dialect keeps a broad, sorted and duplicate-free function catalog', () => {
  const minimums: Partial<Record<ConnType, number>> = {
    mysql: 400, mariadb: 225, tidb: 300, oceanBase: 400,
    postgres: 590, kingBase: 590, openGauss: 590,
    sqlServer: 280, oracle: 225, sqlite: 100, duckdb: 640, clickHouse: 1700,
  }
  for (const [dialect, minimum] of Object.entries(minimums)) {
    const functions = sqlFunctionsForDialect(dialect as ConnType)
    assert.ok(functions.length >= minimum, `${dialect}: ${functions.length} < ${minimum}`)
    assert.deepEqual(functions, [...new Set(functions)].sort(), dialect)
  }
})
