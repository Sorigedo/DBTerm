import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkTableSql,
  dialectFamily,
  previewSelect,
  qid,
  sqlStr,
  supportsMyMaintenance,
  supportsOptimizeTable,
  supportsShowStatements,
  tableRef,
} from './sqlDialect.ts'

test('identifier quoting is dialect aware and escapes delimiters', () => {
  assert.equal(qid('mysql', 'a`b'), '`a``b`')
  assert.equal(qid('mariadb', 'a`b'), '`a``b`')
  assert.equal(qid('tidb', 'a`b'), '`a``b`')
  assert.equal(qid('oceanBase', 'a`b'), '`a``b`')
  assert.equal(qid('clickHouse', 'a`b'), '`a``b`')
  assert.equal(qid('postgres', 'a"b'), '"a""b"')
  assert.equal(qid('kingBase', 'a"b'), '"a""b"')
  assert.equal(qid('openGauss', 'a"b'), '"a""b"')
  assert.equal(qid('sqlite', 'a"b'), '"a""b"')
  assert.equal(qid('duckdb', 'a"b'), '"a""b"')
  assert.equal(qid('oracle', 'a"b'), '"a""b"')
  assert.equal(qid('sqlServer', 'a]b'), '[a]]b]')
})

test('tableRef builds schema-qualified names for major dialects', () => {
  assert.equal(tableRef('mysql', 'test', 'users'), '`test`.`users`')
  assert.equal(tableRef('postgres', 'public', 'users'), '"public"."users"')
  assert.equal(tableRef('oracle', 'HR', 'EMP'), '"HR"."EMP"')
  assert.equal(tableRef('sqlite', null, 'users'), '"users"')
  assert.equal(tableRef('duckdb', 'main', 'users'), '"main"."users"')
  assert.equal(tableRef('sqlServer', 'appdb', 'users'), '[appdb]..[users]')
  assert.equal(tableRef('sqlServer', 'appdb', 'users', 'dbo'), '[appdb].[dbo].[users]')
})

test('previewSelect uses dialect-specific limit syntax', () => {
  assert.equal(previewSelect('sqlServer', '[dbo].[users]', 50), 'SELECT TOP 50 * FROM [dbo].[users]')
  assert.equal(previewSelect('oracle', '"HR"."EMP"', 50), 'SELECT * FROM "HR"."EMP" FETCH FIRST 50 ROWS ONLY')
  assert.equal(previewSelect('postgres', '"public"."users"', 50), 'SELECT * FROM "public"."users" LIMIT 50')
  assert.equal(previewSelect('mysql', '`test`.`users`', 50), 'SELECT * FROM `test`.`users` LIMIT 50')
})

test('dialect families group compatible engines', () => {
  assert.equal(dialectFamily('mysql'), 'mysql')
  assert.equal(dialectFamily('mariadb'), 'mysql')
  assert.equal(dialectFamily('tidb'), 'mysql')
  assert.equal(dialectFamily('oceanBase'), 'mysql')
  assert.equal(dialectFamily('postgres'), 'postgres')
  assert.equal(dialectFamily('kingBase'), 'postgres')
  assert.equal(dialectFamily('openGauss'), 'postgres')
  assert.equal(dialectFamily('sqlite'), 'sqlite')
  assert.equal(dialectFamily('duckdb'), 'duckdb')
  assert.equal(dialectFamily('sqlServer'), 'mssql')
  assert.equal(dialectFamily('clickHouse'), 'clickhouse')
})

test('capability helpers encode MySQL-family maintenance differences', () => {
  for (const t of ['mysql', 'mariadb', 'tidb', 'oceanBase']) {
    assert.equal(supportsShowStatements(t), true)
    assert.equal(supportsMyMaintenance(t), true)
  }
  assert.equal(supportsShowStatements('postgres'), false)
  assert.equal(supportsMyMaintenance('sqlite'), false)
  assert.equal(supportsOptimizeTable('mysql'), true)
  assert.equal(supportsOptimizeTable('mariadb'), true)
  assert.equal(supportsOptimizeTable('oceanBase'), true)
  assert.equal(supportsOptimizeTable('tidb'), false)
  assert.equal(checkTableSql('tidb', '`test`.`users`'), 'ADMIN CHECK TABLE `test`.`users`')
  assert.equal(checkTableSql('mysql', '`test`.`users`'), 'CHECK TABLE `test`.`users`')
})

test('sqlStr escapes SQL string literals', () => {
  assert.equal(sqlStr("O'Reilly"), "'O''Reilly'")
})
