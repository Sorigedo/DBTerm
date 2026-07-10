import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConnType } from '../../types/index.ts'
import { affectedRowsDisplay } from './affectedRowsDisplay.ts'

test('mysql family explains the affected-row value for a single-row upsert update', () => {
  const sql = `INSERT INTO config (config_key, config_value) VALUES ('payment', '{}')
    ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`
  const dialects: ConnType[] = ['mysql', 'mariadb', 'tidb', 'oceanBase']

  for (const dialect of dialects) {
    const display = affectedRowsDisplay(dialect, sql, 2)
    assert.equal(display.summary, '更新 1 行（数据库计数 2）')
    assert.match(display.detail, /冲突更新的影响行计数为 2/)
  }
})

test('mysql upsert distinguishes insert, unchanged and multi-row input', () => {
  const one = `INSERT INTO t (id, value) VALUES (1, 'x') ON DUPLICATE KEY UPDATE value = VALUES(value)`
  assert.equal(affectedRowsDisplay('mysql', one, 1).summary, '插入 1 行')
  assert.equal(affectedRowsDisplay('mysql', one, 0).summary, '数据未变化（数据库计数 0）')

  const many = `INSERT INTO t (id, value) VALUES (1, 'x'), (2, 'ON DUPLICATE KEY UPDATE')
    ON DUPLICATE KEY UPDATE value = VALUES(value)`
  assert.equal(affectedRowsDisplay('mysql', many, 3).summary, '处理 2 行（数据库计数 3）')
})

test('mysql replace explains delete plus insert counting', () => {
  const display = affectedRowsDisplay('mysql', `REPLACE INTO t (id, value) VALUES (1, 'x')`, 2)
  assert.equal(display.summary, '替换 1 行（数据库计数 2）')
  assert.match(display.detail, /删除旧行和插入新行各计 1/)
})

test('all other SQL dialects use operation-specific wording without changing the count', () => {
  const cases: Array<[ConnType, string, number, string]> = [
    ['postgres', 'INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET value = 1', 1, '写入 1 行（插入或冲突更新）'],
    ['kingBase', 'UPDATE t SET value = 1', 3, '更新 3 行'],
    ['openGauss', 'DELETE FROM t WHERE id = 1', 1, '删除 1 行'],
    ['sqlite', 'INSERT OR REPLACE INTO t VALUES (1)', 1, '写入 1 行（插入或替换）'],
    ['duckdb', 'WITH changed AS (SELECT 1) UPDATE t SET value = 1', 2, '更新 2 行'],
    ['sqlServer', 'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET t.v = s.v;', 4, '变更 4 行'],
    ['oracle', 'MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET t.v = s.v', 4, '变更 4 行'],
    ['clickHouse', 'INSERT INTO t VALUES (1)', 1, '插入 1 行'],
  ]

  for (const [dialect, sql, affected, expected] of cases) {
    assert.equal(affectedRowsDisplay(dialect, sql, affected).summary, expected)
  }
})

test('keywords inside comments and strings do not trigger mysql special counting', () => {
  const sql = `UPDATE t SET value = 'ON DUPLICATE KEY UPDATE' /* REPLACE INTO x VALUES (1) */`
  assert.equal(affectedRowsDisplay('mysql', sql, 2).summary, '更新 2 行')
})

test('postgres json operators are not treated as mysql hash comments', () => {
  const sql = `WITH changed AS (SELECT data #>> '{path}' FROM source) UPDATE t SET value = 1`
  assert.equal(affectedRowsDisplay('postgres', sql, 2).summary, '更新 2 行')
})

test('transaction controls use state wording instead of zero affected rows', () => {
  assert.equal(affectedRowsDisplay('mysql', 'START TRANSACTION', 0).summary, '事务已开始')
  assert.equal(affectedRowsDisplay('postgres', 'COMMIT', 0).summary, '事务已提交')
  assert.equal(affectedRowsDisplay('oracle', 'ROLLBACK', 0).summary, '事务已回滚')
})
