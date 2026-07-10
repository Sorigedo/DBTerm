import test from 'node:test'
import assert from 'node:assert/strict'
import { findSqlVariables, applySqlVariables, inferSqlVariableMode } from './sqlVariables.ts'

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

test('findSqlVariables detects wrapped cross-dialect variable forms', () => {
  const sql = `
    select * from orders
    where created_at >= #{monthdate}
      and user_id = ${'${userId}'}
      and region = @{region}
      and flag = ?{flag}
      and tenant_id = {{tenantId}}
  `
  assert.deepEqual(
    findSqlVariables(sql).map(v => v.name),
    ['monthdate', 'userId', 'region', 'flag', 'tenantId'],
  )
})

test('findSqlVariables does not treat native parameter markers as DBTerm variables', () => {
  const sql = `
    select @session_var, $1, ?
    from t
    where payload ? 'key'
      and id = :id
  `
  assert.deepEqual(findSqlVariables(sql).map(v => v.name), ['id'])
})

test('findSqlVariables skips quoted identifiers and dialect-specific quoted strings', () => {
  const sql = `
    select [schema:name], \`col:name\`, "alias:name", 'http://host/:path/#{x}/${'${y}'}/@{z}/{{w}}'
    from t
    where a = :a and b = :b
    /* ignored :c */
  `
  assert.deepEqual(findSqlVariables(sql).map(v => v.name), ['a', 'b'])
})

test('applySqlVariables replaces with escaped SQL string literals', () => {
  const sql = `select * from users where id = #{id} and name = ${'${name}'}`
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

test('applySqlVariables replaces date mode with dialect-aware date expressions', () => {
  const sql = `select * from orders where created_at >= :monthdate`
  const vars = findSqlVariables(sql)
  const values = { monthdate: '2026-06-01' }
  const modes = { monthdate: 'date' as const }

  assert.equal(
    applySqlVariables(sql, vars, values, modes, 'mysql'),
    `select * from orders where created_at >= '2026-06-01'`,
  )
  assert.equal(
    applySqlVariables(sql, vars, values, modes, 'sqlServer'),
    `select * from orders where created_at >= CONVERT(date, '2026-06-01', 23)`,
  )
  assert.equal(
    applySqlVariables(sql, vars, values, modes, 'oracle'),
    `select * from orders where created_at >= DATE '2026-06-01'`,
  )
  assert.equal(
    applySqlVariables(sql, vars, values, modes, 'clickHouse'),
    `select * from orders where created_at >= toDate('2026-06-01')`,
  )
})

test('inferSqlVariableMode defaults date-like variables to date mode', () => {
  assert.equal(inferSqlVariableMode('monthdate'), 'date')
  assert.equal(inferSqlVariableMode('order_day'), 'date')
  assert.equal(inferSqlVariableMode('userId'), 'literal')
})
