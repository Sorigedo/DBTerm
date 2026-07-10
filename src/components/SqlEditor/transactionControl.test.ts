import assert from 'node:assert/strict'
import test from 'node:test'
import { splitSqlStatements } from './sqlSplit.ts'
import { isMysqlTransactionPreamble, shouldBlockMixedAutoTransaction, transactionControlStatement } from './transactionControl.ts'

test('detects transaction controls for mysql-family scripts', () => {
  assert.equal(transactionControlStatement('-- start\nSTART TRANSACTION', 'mysql'), 'begin')
  assert.equal(transactionControlStatement('BEGIN WORK', 'mariadb'), 'begin')
  assert.equal(transactionControlStatement('COMMIT', 'tidb'), 'commit')
  assert.equal(transactionControlStatement('ROLLBACK WORK', 'oceanBase'), 'rollback')
})

test('detects transaction controls for other supported dialects', () => {
  assert.equal(transactionControlStatement('BEGIN TRANSACTION', 'postgres'), 'begin')
  assert.equal(transactionControlStatement('ABORT', 'openGauss'), 'rollback')
  assert.equal(transactionControlStatement('BEGIN IMMEDIATE TRANSACTION', 'sqlite'), 'begin')
  assert.equal(transactionControlStatement('END TRANSACTION', 'duckdb'), 'commit')
  assert.equal(transactionControlStatement('BEGIN TRAN', 'sqlServer'), 'begin')
  assert.equal(transactionControlStatement('COMMIT TRANSACTION', 'sqlServer'), 'commit')
  assert.equal(transactionControlStatement('ROLLBACK', 'oracle'), 'rollback')
})

test('does not mistake blocks, savepoints or unsupported engines for top-level controls', () => {
  assert.equal(transactionControlStatement('BEGIN NULL; END;', 'oracle'), null)
  assert.equal(transactionControlStatement('ROLLBACK TO SAVEPOINT before_update', 'postgres'), null)
  assert.equal(transactionControlStatement('BEGIN TRANSACTION', 'clickHouse'), null)
})

test('only mysql session setup statements are accepted as transaction preamble', () => {
  assert.equal(isMysqlTransactionPreamble('-- variables\nSET @parent_id := 1'), true)
  assert.equal(isMysqlTransactionPreamble('USE `app_db`'), true)
  assert.equal(isMysqlTransactionPreamble('SELECT @parent_id'), false)
  assert.equal(isMysqlTransactionPreamble('UPDATE t SET value = 1'), false)
})

test('mysql variable transaction script stays split while its setup remains on the transaction session', () => {
  const sql = `SET @parent_id := 10;
SET @child_id := 20;
START TRANSACTION;
UPDATE product SET category_id = @parent_id WHERE category_id = @child_id;
UPDATE product_store SET category_id = @parent_id WHERE category_id = @child_id;
COMMIT;`
  const statements = splitSqlStatements(sql, 'mysql')

  assert.equal(statements.length, 6)
  assert.deepEqual(statements.map(s => transactionControlStatement(s, 'mysql')), [null, null, 'begin', null, null, 'commit'])
  assert.equal(statements.slice(0, 2).every(isMysqlTransactionPreamble), true)
})

test('explicit mysql transaction may mix temporary-table DDL and DML', () => {
  const sql = `START TRANSACTION;
CREATE TEMPORARY TABLE tmp_merge (id BIGINT PRIMARY KEY);
INSERT INTO tmp_merge VALUES (1);
UPDATE product JOIN tmp_merge ON tmp_merge.id = product.id SET product.active = 1;
DROP TEMPORARY TABLE tmp_merge;
COMMIT;`
  const statements = splitSqlStatements(sql, 'mysql')
  const controls = statements.map(statement => transactionControlStatement(statement, 'mysql'))

  assert.deepEqual(controls, ['begin', null, null, null, null, 'commit'])
  assert.equal(shouldBlockMixedAutoTransaction(false, false, true, 2, 4), false)
  assert.equal(shouldBlockMixedAutoTransaction(true, false, true, 2, 4), false)
  assert.equal(shouldBlockMixedAutoTransaction(true, false, false, 2, 4), true)
})
