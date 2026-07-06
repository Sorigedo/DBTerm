import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSqlCompletionScope,
  extractSelectOutputColumns,
  memberColumnsForAlias,
  selectAliasColumnsBefore,
} from './sqlCompletion.ts'

const inventorySql = `
select
  (select xe.epid from xmg_epadmin xe where xe.agent_epid=xe.epid) agent_epid,
  t.epid,
  t.device,
  t.kind_num
from (
  select b.deviceid,
    (select xd.epid from xmg_device xd where b.deviceid=xd.deviceid) epid,
    count(distinct b.skuid) kind_num from xmg_device_viewsku b
  group by b.deviceid having kind_num >= 100 order by kind_num desc
) t
`

test('member completion resolves table aliases inside subqueries', () => {
  const dbSchema = {
    xmg_device_viewsku: ['deviceid', 'skuid', 'device'],
    xmg_device: ['deviceid', 'epid'],
  }

  assert.deepEqual(memberColumnsForAlias(inventorySql, dbSchema, 'b', 'mysql'), [
    'deviceid',
    'skuid',
    'device',
  ])
})

test('member completion resolves derived table output columns', () => {
  const dbSchema = {
    xmg_device_viewsku: ['deviceid', 'skuid', 'device'],
    xmg_device: ['deviceid', 'epid'],
  }

  assert.deepEqual(memberColumnsForAlias(inventorySql, dbSchema, 't', 'mysql'), [
    'deviceid',
    'epid',
    'kind_num',
  ])
})

test('select output completion includes computed aliases before cursor', () => {
  const pos = inventorySql.indexOf('kind_num desc')
  assert.deepEqual(selectAliasColumnsBefore(inventorySql, pos, 'mysql'), [
    'deviceid',
    'epid',
    'kind_num',
  ])
})

test('mysql-family parsing accepts backticks but not sql server brackets', () => {
  const mysqlSql = 'select `o`.`order id` as `order id` from `orders` `o`'
  assert.deepEqual(extractSelectOutputColumns(mysqlSql, 'mysql'), ['order id'])
  assert.deepEqual(buildSqlCompletionScope(mysqlSql, 'mysql').aliases, {
    orders: 'orders',
    o: 'orders',
  })

  const bracketSql = 'select [o].[order id] from [orders] [o]'
  assert.deepEqual(buildSqlCompletionScope(bracketSql, 'mysql').aliases, {})
})

test('postgres-family parsing accepts double quoted identifiers', () => {
  const pgSql = 'select "u"."user name" as "user name" from "users" as "u"'
  assert.deepEqual(extractSelectOutputColumns(pgSql, 'postgres'), ['user name'])
  assert.deepEqual(buildSqlCompletionScope(pgSql, 'postgres').aliases, {
    users: 'users',
    u: 'users',
  })
})

test('sql server parsing accepts bracket identifiers', () => {
  const ssSql = 'select [o].[order id] as [order id] from [dbo].[orders] as [o]'
  assert.deepEqual(extractSelectOutputColumns(ssSql, 'sqlServer'), ['order id'])
  assert.deepEqual(buildSqlCompletionScope(ssSql, 'sqlServer').aliases, {
    orders: 'orders',
    o: 'orders',
  })
})
