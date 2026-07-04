import test from 'node:test'
import assert from 'node:assert/strict'
import { findSqlVariables, applySqlVariables } from './sqlVariables.ts'

test('findSqlVariables detects named variables outside strings and comments', () => {
  const sql = `
    select * from users
    where id = :id
      and name = ':name'
      and note = :note
      -- and skipped = :skip
      and created_at::date = :day
  `
  assert.deepEqual(findSqlVariables(sql).map(v => v.name), ['id', 'note', 'day'])
})

test('findSqlVariables skips quoted identifiers and dialect-specific quoted strings', () => {
  const sql = `
    select [schema:name], \`col:name\`, "alias:name", 'http://host/:path'
    from t
    where a = :a and b = :b
    /* ignored :c */
  `
  assert.deepEqual(findSqlVariables(sql).map(v => v.name), ['a', 'b'])
})

test('applySqlVariables replaces with escaped SQL string literals', () => {
  const sql = `select * from users where id = :id and name = :name`
  const vars = findSqlVariables(sql)
  assert.equal(
    applySqlVariables(sql, vars, { id: '42', name: "O'Reilly" }),
    `select * from users where id = '42' and name = 'O''Reilly'`,
  )
})

test('applySqlVariables treats null text as SQL NULL', () => {
  const sql = `select * from users where deleted_at is :deletedAt`
  const vars = findSqlVariables(sql)
  assert.equal(
    applySqlVariables(sql, vars, { deletedAt: 'null' }),
    `select * from users where deleted_at is NULL`,
  )
})
