import assert from 'node:assert/strict'
import test from 'node:test'
import { relocateMysqlObjectDdl } from './mysqlObjectDdl.ts'

test('view migration changes only its declared identifier', () => {
  const ddl = 'CREATE ALGORITHM=UNDEFINED DEFINER=`owner`@`%` SQL SECURITY DEFINER VIEW `source`.`v` AS select * from `source`.`t`'
  const actual = relocateMysqlObjectDdl(ddl, 'VIEW', 'source', 'v', '`target`.`v`')
  assert.equal(actual, ddl.replace('VIEW `source`.`v` AS', 'VIEW `target`.`v` AS'))
})

test('routine migration retains its DEFINER, body, and character clauses', () => {
  const ddl = 'CREATE DEFINER=`owner`@`localhost` FUNCTION `f`(p varchar(10)) RETURNS varchar(10) CHARSET utf8mb4 COLLATE utf8mb4_bin DETERMINISTIC RETURN p'
  const actual = relocateMysqlObjectDdl(ddl, 'FUNCTION', 'source', 'f', '`target`.`g`')
  assert.equal(actual, ddl.replace('FUNCTION `f`(', 'FUNCTION `target`.`g`('))
})

test('object migration rejects a declaration for a different source', () => {
  assert.throws(() => relocateMysqlObjectDdl('CREATE VIEW `another` AS SELECT 1', 'VIEW', 'source', 'v', '`target`.`v`'), /定义.*不匹配/)
})

test('object migration rejects replace semantics and unknown header syntax', () => {
  assert.throws(() => relocateMysqlObjectDdl('CREATE OR REPLACE VIEW `v` AS SELECT 1', 'VIEW', 'source', 'v', '`target`.`v`'), /OR REPLACE/)
  assert.throws(() => relocateMysqlObjectDdl('CREATE TEMPORARY VIEW `v` AS SELECT 1', 'VIEW', 'source', 'v', '`target`.`v`'), /无法安全解析/)
})
