import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeMysqlDdlForDisplay } from './mysqlDdlDisplay.ts'

test('displays implicit InnoDB BTREE methods explicitly without changing DDL semantics', () => {
  const ddl = `CREATE TABLE \`t\` (\n  PRIMARY KEY (\`id\`),\n  UNIQUE KEY \`uk\` (\`code\`),\n  KEY \`idx\` (\`name\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  assert.equal(normalizeMysqlDdlForDisplay(ddl), `CREATE TABLE \`t\` (\n  PRIMARY KEY (\`id\`) USING BTREE,\n  UNIQUE KEY \`uk\` (\`code\`) USING BTREE,\n  KEY \`idx\` (\`name\`) USING BTREE\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
})

test('preserves explicit methods and non-BTREE index kinds', () => {
  const ddl = `CREATE TABLE t (\n  KEY h (v) USING HASH,\n  FULLTEXT KEY ft (body),\n  SPATIAL KEY geo (shape),\n  KEY already (x) USING BTREE\n) ENGINE=InnoDB`
  assert.equal(normalizeMysqlDdlForDisplay(ddl), ddl)
})

test('does not rewrite non-InnoDB or non-index lines', () => {
  const ddl = `CREATE TABLE t (\n  KEY idx (v),\n  id int\n) ENGINE=MEMORY`
  assert.equal(normalizeMysqlDdlForDisplay(ddl), ddl)
})
