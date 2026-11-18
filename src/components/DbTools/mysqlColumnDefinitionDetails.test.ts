import assert from 'node:assert/strict'
import test from 'node:test'
import { mysqlColumnDefinition, mysqlColumnDefinitionDetails, setMysqlColumnCollation, setMysqlColumnUnsigned } from './mysqlColumnDefinitionDetails.ts'

test('SQL words inside defaults and comments are not charset attributes', () => {
  const definition = "`name` varchar(24) NOT NULL DEFAULT 'COLLATE utf8mb4_bin' COMMENT 'CHARACTER SET latin1 COLLATE latin1_bin'"
  assert.deepEqual(mysqlColumnDefinitionDetails(definition), { charset: null, collation: null })
  assert.equal(setMysqlColumnCollation(definition, ''), definition)
})

test('shows charset and collation differences from complete MySQL column definitions', () => {
  assert.deepEqual(mysqlColumnDefinitionDetails('`pos_no` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL'), {
    charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci',
  })
  assert.deepEqual(mysqlColumnDefinitionDetails('`pos_no` varchar(24) COLLATE utf8mb4_bin NOT NULL'), {
    charset: null, collation: 'utf8mb4_bin',
  })
})

test('returns empty details when a definition has no explicit charset or collation', () => {
  assert.deepEqual(mysqlColumnDefinitionDetails('`id` bigint NOT NULL AUTO_INCREMENT'), {
    charset: null, collation: null,
  })
})

test('table-level default collation is not treated as an explicit column override', () => {
  const ddl = "CREATE TABLE `mc_order_payment` (`operation_no` VARCHAR(24) NOT NULL DEFAULT '', `id` BIGINT NOT NULL) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci"
  const definition = mysqlColumnDefinition(ddl, 'operation_no')!
  assert.deepEqual(mysqlColumnDefinitionDetails(definition), { charset: null, collation: null })
})

test('can remove explicit charset and collation while retaining the rest of a column definition', () => {
  const ddl = "CREATE TABLE `t` (\n  `resolution` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT '' COMMENT 'size',\n  `id` bigint NOT NULL\n)"
  const definition = mysqlColumnDefinition(ddl, 'resolution')!
  assert.equal(setMysqlColumnCollation(definition, ''), "`resolution` varchar(64) NOT NULL DEFAULT '' COMMENT 'size'")
})

test('can set a different explicit collation and rejects invalid names', () => {
  assert.equal(setMysqlColumnCollation('`name` varchar(24) NOT NULL', 'utf8mb4_bin'), '`name` varchar(24) NOT NULL COLLATE utf8mb4_bin')
  assert.equal(setMysqlColumnCollation('`name` varchar(24)', 'utf8mb4; DROP TABLE t'), null)
})

test('can remove UNSIGNED from an existing column definition without changing other attributes', () => {
  assert.equal(setMysqlColumnUnsigned('`enabled` tinyint unsigned NOT NULL DEFAULT 1 COMMENT \'flag\'', false),
    '`enabled` tinyint NOT NULL DEFAULT 1 COMMENT \'flag\'')
})
