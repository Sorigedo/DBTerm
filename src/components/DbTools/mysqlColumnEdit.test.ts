import assert from 'node:assert/strict'
import test from 'node:test'
import { editMysqlColumnDefinition, mysqlColumnPositionClause, mysqlString } from './mysqlColumnEdit.ts'
import { mysqlColumnDefinition } from './mysqlColumnDefinitionDetails.ts'
const original = {name:'value',baseType:'VARCHAR',length:'64',unsigned:false,nullable:true,primaryKey:false,autoIncrement:false,defaultType:'null',defaultValue:'',comment:'',collation:''}
const tick = String.fromCharCode(96)
const q = (s: string) => tick + s + tick

test('disallowing NULL removes its incompatible default', () => {
  const out = editMysqlColumnDefinition(q('value') + ' varchar(64) DEFAULT NULL', original, {...original,nullable:false})
  assert.ok(!out.includes('DEFAULT NULL'))
  assert.match(out,/NOT NULL/)
})
test('comment SQL keywords and generated expression are preserved on type and comment edits', () => {
  const definition = q('value') + " varchar(64) GENERATED ALWAYS AS (concat('COMMENT DEFAULT NULL', 'a')) STORED COMMENT 'old' INVISIBLE"
  const out = editMysqlColumnDefinition(definition,{...original,comment:'old'},{...original,length:'128',comment:"owner's path \\n\n中文🙂"})
  assert.ok(out.includes("GENERATED ALWAYS AS (concat('COMMENT DEFAULT NULL', 'a')) STORED"))
  assert.ok(out.endsWith("COMMENT " + mysqlString("owner's path \\n\n中文🙂") + ' INVISIBLE'))
})
test('complete column definition can span lines inside a comment', () => {
  const definition = q('value') + " varchar(64) DEFAULT NULL COMMENT 'first\nsecond'"
  assert.equal(mysqlColumnDefinition('CREATE TABLE '+q('t')+' (\n  '+definition+',\n  '+q('other')+' int\n)','value'),definition)
})
test('combined type and unsigned changes preserve insertion offsets', () => {
  const out=editMysqlColumnDefinition(q('value')+' int NOT NULL', {...original,baseType:'INT',length:'',nullable:false}, {...original,baseType:'BIGINT',length:'',nullable:false,unsigned:true})
  assert.equal(out,q('value')+' BIGINT UNSIGNED NOT NULL')
})
test('DEFAULT NULL and comments containing NULL are opaque when editing nullable', () => {
  const out=editMysqlColumnDefinition(q('value')+" varchar(64) DEFAULT NULL COMMENT 'NOT NULL'",original,{...original,nullable:false})
  assert.ok(out.includes("COMMENT 'NOT NULL'")); assert.ok(!out.includes("DEFAULT NULL"))
})
test('datetime precision changes update timestamp defaults and on-update precision together', () => {
  const from={...original,baseType:'DATETIME',length:'6',defaultType:'timestamp_update'}
  const out=editMysqlColumnDefinition(q('value')+' datetime(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)',from,{...from,length:'3'})
  assert.match(out,/DATETIME\(3\) DEFAULT CURRENT_TIMESTAMP\(3\) ON UPDATE CURRENT_TIMESTAMP\(3\)/)
})

test('changing a character column to numeric removes incompatible charset attributes', () => {
 const from={...original,collation:'utf8mb4_bin'}
 const out=editMysqlColumnDefinition(q('value')+" varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL",from,{...from,baseType:'INT',length:''})
 assert.ok(!out.includes('CHARACTER SET')&&!out.includes('COLLATE'))
})

test('edits every structured MySQL column attribute while preserving unrepresented DDL attributes', () => {
 const definition = q('value') + " int NOT NULL DEFAULT 1 COMMENT 'old' INVISIBLE"
 const from = {...original,baseType:'INT',length:'',nullable:false,defaultType:'zero',defaultValue:'',comment:'old'}
 const cases: Array<[string, Partial<typeof from>, RegExp]> = [
  ['type', {baseType:'BIGINT'}, /`value` BIGINT NOT NULL/],
  ['length', {baseType:'DECIMAL',length:'12,3'}, /`value` DECIMAL\(12,3\) NOT NULL/],
  ['unsigned', {unsigned:true}, /int UNSIGNED NOT NULL/i],
  ['nullable', {nullable:true}, /\bNULL\b/],
  ['default', {defaultType:'custom',defaultValue:'7'}, /DEFAULT 7/],
  ['comment', {comment:'new note'}, /COMMENT 'new note'/],
  ['auto increment', {autoIncrement:true}, /AUTO_INCREMENT.*INVISIBLE$/],
 ]
 for (const [label, patch, expected] of cases) {
  const result = editMysqlColumnDefinition(definition, from, {...from,...patch})
  assert.match(result, expected, label)
  assert.match(result, /INVISIBLE$/, label)
 }
})

test('removes a column comment and renames the column without losing other attributes', () => {
 const definition = q('value') + " int UNSIGNED NOT NULL DEFAULT 1 COMMENT 'old' INVISIBLE"
 const from = {...original,baseType:'INT',length:'',unsigned:true,nullable:false,defaultType:'zero',comment:'old'}
 const renamed = editMysqlColumnDefinition(definition,from,{...from,name:'renamed',comment:''})
 assert.match(renamed,/^`renamed` int UNSIGNED NOT NULL DEFAULT 1/)
 assert.match(renamed,/COMMENT ''/)
 assert.match(renamed,/INVISIBLE$/)
})

test('column reordering emits MySQL FIRST and AFTER clauses', () => {
 assert.equal(mysqlColumnPositionClause(0, ''), ' FIRST')
 assert.equal(mysqlColumnPositionClause(2, 'price_strategy_id'), ' AFTER `price_strategy_id`')
})

test('readback accepts MySQL canonical aliases but preserves ENUM literal case', async () => {
 const { sameMysqlColumnType } = await import('./mysqlColumnEdit.ts')
 assert.equal(sameMysqlColumnType({baseType:'BOOLEAN',length:''},{baseType:'TINYINT',length:'1'}),true)
 assert.equal(sameMysqlColumnType({baseType:'INT',length:'11'},{baseType:'INT',length:''}),true)
 assert.equal(sameMysqlColumnType({baseType:'VARCHAR',length:'64'},{baseType:'VARCHAR',length:'128'}),false)
 assert.equal(sameMysqlColumnType({baseType:'ENUM',length:"'A','B'"},{baseType:'ENUM',length:"'a','b'"}),false)
})
