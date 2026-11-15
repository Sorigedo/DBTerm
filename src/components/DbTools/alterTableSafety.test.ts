import assert from 'node:assert/strict'
import test from 'node:test'
import { mysqlExistingColumnAlter } from './alterTableSafety.ts'

const original = { name: 'update_time', dataType: 'datetime', nullable: false, defaultValue: 'CURRENT_TIMESTAMP', comment: '' }

test('renaming a MySQL column uses RENAME COLUMN without rewriting its attributes', () => {
  assert.deepEqual(mysqlExistingColumnAlter('mysql', original, { ...original, name: 'updated_at' }, false),
    { sql: 'RENAME COLUMN `update_time` TO `updated_at`' })
})

test('changing a MySQL column type fails closed when original attributes are not fully known', () => {
  assert.deepEqual(mysqlExistingColumnAlter('mysql', original, { ...original, dataType: 'datetime(6)' }, false),
    { error: '现有字段的完整定义无法从列摘要还原，请在 SQL 编辑器中修改原始 DDL' })
})

test('changing MariaDB invisible status fails closed instead of rebuilding generated columns', () => {
  assert.deepEqual(mysqlExistingColumnAlter('mariadb', original, original, true),
    { error: '现有字段的完整定义无法从列摘要还原，请在 SQL 编辑器中修改原始 DDL' })
})

test('unchanged MySQL column emits no ALTER clause', () => {
  assert.deepEqual(mysqlExistingColumnAlter('mysql', original, original, false), {})
})

