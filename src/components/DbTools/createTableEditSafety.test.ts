import assert from 'node:assert/strict'
import test from 'node:test'
import { existingMysqlColumnEdit, validateExistingTableTarget } from './createTableEditSafety.ts'

const original = { name: 'plan_code', baseType: 'VARCHAR', length: '64', unsigned: false, nullable: false, primaryKey: false, autoIncrement: false, defaultType: 'empty', defaultValue: '', comment: '编码' }

test('editing an existing table cannot redirect ALTER to another table', () => {
  assert.match(validateExistingTableTarget('other_table', 'mc_pos_settlement_company') ?? '', /原表/)
  assert.equal(validateExistingTableTarget('mc_pos_settlement_company', 'mc_pos_settlement_company'), null)
})

test('renaming an existing MySQL column emits RENAME COLUMN without rebuilding its definition', () => {
  assert.deepEqual(existingMysqlColumnEdit('mysql', original, { ...original, name: 'code' }),
    { sql: 'RENAME COLUMN `plan_code` TO `code`' })
})

test('changing an existing column attribute fails closed when original DDL is not fully represented', () => {
  assert.deepEqual(existingMysqlColumnEdit('mysql', original, { ...original, length: '128' }),
    { error: '现有字段的完整定义无法从列摘要还原，请在 SQL 编辑器中修改原始 DDL' })
})

test('unchanged existing column emits no clause', () => {
  assert.deepEqual(existingMysqlColumnEdit('mysql', original, original), {})
})
