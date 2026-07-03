import assert from 'node:assert/strict'
import test from 'node:test'
import { splitSqlStatements } from './sqlSplit.ts'

test('mysql delimiter directives split routine body as one statement', () => {
  const sql = `DELIMITER //
CREATE PROCEDURE p()
BEGIN
  SELECT 1;
  SELECT 2;
END//
DELIMITER ;
SELECT 3;`

  assert.deepEqual(splitSqlStatements(sql, 'mysql'), [
    `CREATE PROCEDURE p()
BEGIN
  SELECT 1;
  SELECT 2;
END`,
    'SELECT 3',
  ])
})

test('delimiter directive is ignored outside mysql family', () => {
  const sql = `DELIMITER //
SELECT 1//`

  assert.deepEqual(splitSqlStatements(sql, 'postgres'), [
    `DELIMITER //
SELECT 1//`,
  ])
})

test('sql server go batch separator is dialect scoped', () => {
  const sql = `SELECT 1;
GO
SELECT 2;`

  assert.deepEqual(splitSqlStatements(sql, 'sqlServer'), ['SELECT 1', 'SELECT 2'])
  assert.deepEqual(splitSqlStatements(sql, 'mysql'), ['SELECT 1', 'GO\nSELECT 2'])
})

test('oracle slash on its own line ends a plsql block', () => {
  const sql = `BEGIN
  NULL;
END;
/
SELECT 1 FROM dual;`

  assert.deepEqual(splitSqlStatements(sql, 'oracle'), [
    `BEGIN
  NULL;
END;`,
    'SELECT 1 FROM dual',
  ])
})
