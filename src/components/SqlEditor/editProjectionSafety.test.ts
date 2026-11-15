import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
test('inline saves carry old values and projection safety is checked',()=>{
 const grid=readFileSync(new URL('./ResultTable.tsx',import.meta.url),'utf8')
 const editor=readFileSync(new URL('./index.tsx',import.meta.url),'utf8')
 assert.ok(grid.includes('expectedValues'))
 assert.ok(editor.includes('parseEditableProjection'))
})
import { parseEditableProjection, editableProjectionColumns } from './editProjectionSafety.ts'
test('expressions disguised as primary keys and duplicate names cannot enable editing',()=>{
 for(const sql of ['SELECT 42 AS id,value FROM t','SELECT id+1 AS id,value FROM t','SELECT value AS id,value FROM t','SELECT id,id FROM t','SELECT id,(SELECT value FROM other) AS value FROM t','SELECT id,value FROM t JOIN other ON t.id=other.id']) assert.equal(parseEditableProjection(sql),null,sql)
})
test('plain qualified columns, aliases and wildcard retain normal editing',()=>{
 for(const sql of ['SELECT id,value FROM db.t','SELECT t.id,t.value FROM db.t AS t','SELECT * FROM db.t WHERE id=1','SELECT t.* FROM db.t t ORDER BY id']){
 const target=parseEditableProjection(sql);assert.ok(target,sql);assert.equal(editableProjectionColumns(target,['id','value'],['id','value'],['id']),true)
 }
 assert.equal(editableProjectionColumns(parseEditableProjection('SELECT * FROM t'),['id','id'],['id'],['id']),false)
})
