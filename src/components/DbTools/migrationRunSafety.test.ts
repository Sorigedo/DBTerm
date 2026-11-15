import test from 'node:test'
import assert from 'node:assert/strict'
import { migrationResultFailure, migrationResultNotices, markMigrationUnexecuted, migrationVerificationLabel } from './migrationRunSafety.ts'

test('migration nonzero failures and reported errors halt the batch', () => {
  assert.match(migrationResultFailure({ failedRows: 2, errors: ['duplicate'] }, 'replace') ?? '', /2/)
  assert.equal(migrationResultFailure({ failedRows: 0, errors: ['unexpected'] }, 'replace'), 'unexpected')
  assert.equal(migrationResultFailure({ failedRows: 0, errors: [] }, 'replace'), null)
})

test('only intentional skip strategy can treat legacy table skip note as non-failure', () => {
  const result = { failedRows: 0, migratedRows: 0, totalRows: 0, errors: ['目标表已存在，按「跳过」策略未迁移'] }
  assert.equal(migrationResultFailure(result, 'skip'), null)
  assert.match(migrationResultFailure(result, 'replace') ?? '', /目标表已存在/)
})

test('fail-stop marks remaining objects unexecuted and preserves prior results', () => {
  const result = markMigrationUnexecuted([
    { table: 'a', stage: '完成', done: true },
    { table: 'b', stage: '失败', done: true, error: 'network' },
    { table: 'c', stage: '等待中', done: false },
  ], 2)
  assert.equal(result[0].stage, '完成')
  assert.equal(result[1].error, 'network')
  assert.equal(result[2].done, false)
  assert.equal(result[2].stage, '未执行')
  assert.equal(result[2].unexecuted, true)
})

test('equal row counts never claim complete content equality', () => {
  assert.equal(migrationVerificationLabel({ countMatch: true }), '行数相同，内容未校验')
  assert.equal(migrationVerificationLabel({ countMatch: false }), '行数不同')
  assert.equal(migrationVerificationLabel({ countMatch: true, error: 'denied' }), '校验失败')
  assert.equal(migrationVerificationLabel({ countMatch: true, error: '仅完成行数比较；未执行内容校验，不能据此确认数据一致' }), '行数相同，内容未校验')
  assert.equal(migrationVerificationLabel({ countMatch: true, contentChecked: true, contentMatch: false, structureMatch: true }), '内容不同')
  assert.equal(migrationVerificationLabel({ countMatch: true, contentChecked: true, contentMatch: true, structureMatch: false }), '结构不同')
  assert.equal(migrationVerificationLabel({ countMatch: true, contentChecked: true, contentMatch: true, structureMatch: true }), '结构及全量内容指纹一致')
})

test('only complete retained-backup notice is informational and remains available for display', () => {
  const notice = '旧目标完整保留为备份 `b`.`old_backup`；确认业务数据后再手动清理'
  const result = { failedRows: 0, errors: [notice] }
  assert.equal(migrationResultFailure(result, 'replace'), null)
  assert.deepEqual(migrationResultNotices(result), [notice])
  assert.equal(migrationResultFailure({ failedRows: 0, errors: [notice, 'commit failed'] }, 'replace'), 'commit failed')
  assert.match(migrationResultFailure({ failedRows: 0, errors: ['旧目标完整保留为备份 invalid'] }, 'replace') ?? '', /invalid/)
})
