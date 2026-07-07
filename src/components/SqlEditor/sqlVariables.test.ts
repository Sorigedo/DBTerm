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

test('findSqlVariables detects variables adjacent to operators and function punctuation', () => {
  const sql = `
    select count(1)
    from xmg_dynamic_sn_order b
    where b.order_callback_time>=:monthdate
      and b.order_callback_time<adddate(:monthdate,interval 1 month)
  `
  assert.deepEqual(findSqlVariables(sql).map(v => v.name), ['monthdate', 'monthdate'])
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

test('applySqlVariables can replace raw SQL expressions', () => {
  const sql = `select * from orders where id = :id and created_at >= :fromDate`
  const vars = findSqlVariables(sql)
  assert.equal(
    applySqlVariables(sql, vars, { id: '42', fromDate: "DATE '2026-06-01'" }, { id: 'raw', fromDate: 'raw' }),
    `select * from orders where id = 42 and created_at >= DATE '2026-06-01'`,
  )
})
