import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source=readFileSync(new URL('./schemaArchiveExport.ts',import.meta.url),'utf8')
const backend=readFileSync(new URL('../../src-tauri/src/commands/db_extra.rs',import.meta.url),'utf8')

test('MySQL archive object SQL comes with session context from one backend request',()=>{
  assert.match(source,/get_mysql_archive_object_sql/)
  assert.match(source,/if \(mysql\)/)
  assert.match(source,/header: `\$\{context\}\$\{ddl\}`/)
})

test('table DDL header and row stream retain one backend MySQL session',()=>{
  const tableExport=backend.slice(backend.indexOf('pub async fn db_export_table('),backend.indexOf('pub async fn db_export_database('))
  assert.equal((tableExport.match(/mysql_export_session\.as_mut\(\)/g)||[]).length,4)
  assert.match(tableExport,/mysql_export_session_header\(&mut \*conn\)/)
  const ddlRead=tableExport.indexOf('format!("SHOW CREATE TABLE')
  assert.ok(tableExport.indexOf('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')<ddlRead)
  assert.ok(tableExport.indexOf('锁定导出表定义失败')<ddlRead)
})

test('routine creation database collation cannot silently change during archive replay',()=>{
  assert.ok(source.indexOf('例程归档暂不支持可靠重放创建时数据库排序规则')<source.indexOf('db_create_export_workspace'))
})
