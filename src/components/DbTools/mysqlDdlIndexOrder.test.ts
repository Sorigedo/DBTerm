import assert from 'node:assert/strict'
import test from 'node:test'
import { mysqlDdlIndexOrder } from './mysqlDdlIndexOrder.ts'

test('keeps index rows in CREATE TABLE clause order, including the primary key', () => {
  const ddl = `CREATE TABLE \`mc_sys_notice_tenant\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  \`notice_id\` bigint unsigned DEFAULT NULL COMMENT '关联 mc_sys_notice.id',
  PRIMARY KEY (\`id\`) USING BTREE,
  UNIQUE KEY \`uk_notice_tenant\` (\`notice_id\`,\`tenant_id\`) USING BTREE,
  KEY \`idx_notice_tenant_visible\` (\`tenant_id\`,\`delete_time\`,\`read_at\`,\`notice_id\`) USING BTREE,
  KEY \`create_time\` (\`create_time\`) USING BTREE,
  KEY \`idx_notice_tenant_unread\` (\`tenant_id\`,\`read_at\`,\`notice_id\`) USING BTREE,
  KEY \`notice_id\` (\`notice_id\`) USING BTREE,
  KEY \`read_at\` (\`read_at\`) USING BTREE,
  KEY \`tenant_id\` (\`tenant_id\`) USING BTREE
) ENGINE=InnoDB`

  assert.deepEqual(mysqlDdlIndexOrder(ddl), [
    'PRIMARY', 'uk_notice_tenant', 'idx_notice_tenant_visible', 'create_time',
    'idx_notice_tenant_unread', 'notice_id', 'read_at', 'tenant_id',
  ])
})

test('does not treat key-like text, commas, or nested expressions as separate DDL clauses', () => {
  const ddl = `CREATE TABLE \`t\` (
  \`note\` varchar(80) DEFAULT 'KEY \`fake\` (x,y)',
  KEY \`real\` ((lower(concat(\`note\`, ',', \`note\`))))
)`
  assert.deepEqual(mysqlDdlIndexOrder(ddl), ['real'])
})
