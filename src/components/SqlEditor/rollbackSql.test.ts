import test from 'node:test'
import assert from 'node:assert/strict'
import { rollbackScalarLiteral, buildRollbackUpdates } from './rollbackSql.ts'

test('rollback scalar serialization preserves leading zeroes precision quotes and backslashes', () => {
  assert.equal(rollbackScalarLiteral('sqlite', '001'), "'001'")
  assert.equal(rollbackScalarLiteral('sqlServer', '9007199254740993'), "N'9007199254740993'")
  assert.equal(rollbackScalarLiteral('mysql', '001'), "CONVERT(X'303031' USING utf8mb4)")
  assert.equal(rollbackScalarLiteral('mysql', String.fromCharCode(39, 92, 0)), "CONVERT(X'275c00' USING utf8mb4)")
  assert.equal(rollbackScalarLiteral('mysql', null), 'NULL')
})

test('undo groups every cell of one row and locates post-update composite primary key', () => {
  const sql = buildRollbackUpdates('sqlite', '"t"', ['id', 'scope', 'name'], ['id', 'scope'], { id: 'varchar(10)', scope: 'text', name: 'text' }, [
    { type: 'update', absRow: 5, col: 0, oldVal: '001', newVal: '002', pkValues: ['001', 'a'] },
    { type: 'update', absRow: 5, col: 2, oldVal: 'old', newVal: 'new', pkValues: ['001', 'a'] },
  ])
  assert.deepEqual(sql, ["UPDATE \"t\" SET \"id\" = '001', \"name\" = 'old' WHERE \"id\" = '002' AND \"scope\" = 'a';".replaceAll('\\\"', '\"')])
})

test('binary and missing type metadata refuse fabricated restoration SQL', () => {
  for (const type of ['blob', 'varbinary(16)', 'bytea', '']) {
    assert.throws(() => buildRollbackUpdates('sqlite', '"t"', ['id', 'data'], ['id'], { id: 'int', data: type }, [
      { type: 'update', absRow: 0, col: 1, oldVal: '00FF', newVal: 'FF', pkValues: ['1'] },
    ]), /无法生成可靠回滚 SQL/)
  }
})
