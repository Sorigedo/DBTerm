import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { terminateExportDdl } from './schemaExportSql.ts'

test('表 DDL 与 INSERT 之间有语句终止符且保留定义原文', () => {
  const ddl = "CREATE TABLE `t` (\n  `v` varchar(8) DEFAULT 'utf8mb4_0900_ai_ci'\n) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci"
  assert.equal(terminateExportDdl(ddl, 'mysql'), `${ddl};\n`)
})

test('已有终止符不重复添加，SQL Server 使用 GO', () => {
  assert.equal(terminateExportDdl('CREATE TABLE `t` (`id` int);', 'mysql'), 'CREATE TABLE `t` (`id` int);\n')
  assert.equal(terminateExportDdl('CREATE TABLE [t] ([id] int)', 'sqlServer'), 'CREATE TABLE [t] ([id] int)\nGO\n')
})
