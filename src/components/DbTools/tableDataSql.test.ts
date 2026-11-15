import test from 'node:test'
import assert from 'node:assert/strict'
import { tableDataLiteral } from './tableDataSql.ts'
test('copied row SQL preserves string NULL, leading zeros, booleans and apostrophes',()=>{
 assert.equal(tableDataLiteral(null),'NULL')
 for(const [input,expected] of [['NULL',"'NULL'"],['001',"'001'"],['true',"'true'"],["O'Reilly","'O''Reilly'"],['',"''"]])assert.equal(tableDataLiteral(input),expected)
})
test('copied values use dialect-safe backslash Unicode and NUL representations',()=>{
 const text=String.fromCharCode(92)+"'; SELECT '中文"
 assert.equal(tableDataLiteral(text,'mysql'),"CONVERT(X'"+Buffer.from(text).toString('hex')+"' USING utf8mb4)")
 assert.equal(tableDataLiteral(text,'postgres'),"E'"+String.fromCharCode(92,92)+"''; SELECT ''中文'")
 assert.equal(tableDataLiteral('中文','sqlServer'),"N'中文'")
 assert.equal(tableDataLiteral('a'+String.fromCharCode(0)+'b','sqlite'),"CAST(X'610062' AS TEXT)")
})
