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

test('mysql transaction preamble allows session setup, read-only inspection and temporary tables', () => {
  assert.equal(isMysqlTransactionPreamble('-- variables\nSET @parent_id := 1'), true)
  assert.equal(isMysqlTransactionPreamble('USE `app_db`'), true)
  assert.equal(isMysqlTransactionPreamble('ROLLBACK'), true)
  assert.equal(isMysqlTransactionPreamble('COMMIT WORK'), true)
  assert.equal(isMysqlTransactionPreamble('SELECT @parent_id'), true)
  assert.equal(isMysqlTransactionPreamble('DROP TEMPORARY TABLE IF EXISTS tmp_source'), true)
  assert.equal(isMysqlTransactionPreamble('CREATE TEMPORARY TABLE tmp_source LIKE mc_order_payment'), true)
  assert.equal(isMysqlTransactionPreamble('INSERT INTO tmp_payment_history_expected (id) SELECT id FROM tmp_payment_history_source'), true)
  assert.equal(isMysqlTransactionPreamble('INSERT INTO mc_order_payment (id) SELECT id FROM tmp_payment_history_expected'), false)
  assert.equal(isMysqlTransactionPreamble('CREATE TABLE permanent_table (id INT)'), false)
  assert.equal(isMysqlTransactionPreamble('INSERT INTO permanent_table VALUES (1)'), false)
  assert.equal(isMysqlTransactionPreamble('UPDATE t SET value = 1'), false)
})

test('mysql variable transaction may start with cleanup rollback before setup', () => {
  const sql = `ROLLBACK;
SET @child_config = '[{"itemIndex":"1","itemFloor":"6"}]';
SET @camera_config_3cam = CONCAT('[', '{"id":1,"title":"右上","pid":"-1"}', ']');
START TRANSACTION;
UPDATE mc_device_model SET child_config = @child_config, camera_config = @camera_config_3cam WHERE mversion = 'MZ-608CVWKT-3CAM';
COMMIT;`
  const statements = splitSqlStatements(sql, 'mysql')
  const controls = statements.map(s => transactionControlStatement(s, 'mysql'))
  const firstExplicitBegin = controls.indexOf('begin')

  assert.deepEqual(controls, ['rollback', null, null, 'begin', null, 'commit'])
  assert.equal(statements.slice(0, firstExplicitBegin).every(isMysqlTransactionPreamble), true)
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

test('payment history script preamble is all deferred onto the transaction connection', () => {
  const sql = `SET @payment_from_id = NULL;
SET @payment_to_id = NULL;
SELECT DATABASE() AS target_database, VERSION() AS mysql_version;
SELECT MIN(id) AS min_session_id, MAX(id) AS max_session_id, COUNT(*) AS historical_sessions FROM mc_order_session;
DROP TEMPORARY TABLE IF EXISTS tmp_payment_history_source;
DROP TEMPORARY TABLE IF EXISTS tmp_payment_history_expected;
CREATE TEMPORARY TABLE tmp_payment_history_expected LIKE mc_order_payment;
CREATE TEMPORARY TABLE tmp_payment_history_source ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci AS SELECT x.* FROM source x;
SET @payment_range_invalid = 1;
START TRANSACTION;
INSERT INTO mc_order_payment (operation_no) SELECT operation_no FROM tmp_payment_history_expected;
SELECT ROW_COUNT() AS inserted_rows;
ROLLBACK;`
  const statements = splitSqlStatements(sql, 'mysql')
  const controls = statements.map(s => transactionControlStatement(s, 'mysql'))
  const beginIndex = controls.indexOf('begin')

  assert.ok(beginIndex > 0)
  assert.ok(statements.slice(0, beginIndex).every(isMysqlTransactionPreamble))
  assert.deepEqual(controls.slice(beginIndex), ['begin', null, null, 'rollback'])
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
