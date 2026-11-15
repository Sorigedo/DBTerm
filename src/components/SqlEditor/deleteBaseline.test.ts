import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
test('both grid deletion surfaces submit unchanged selected values with column identity',()=>{
 const grid=readFileSync(new URL('./ResultTable.tsx',import.meta.url),'utf8')
 const browse=readFileSync(new URL('../DbTools/TableBrowser.tsx',import.meta.url),'utf8')
 assert.ok(grid.includes('baseline: { columns, rows: deletes.map(del => result!.rows[del.absRow]) }'))
 assert.ok(browse.includes('baseline: { columns: delRows.columns, rows: delRows.rows }'))
 assert.ok(browse.includes('rows: ris.map(ri => [...rows[ri]])'))
 assert.ok(browse.includes('id: delRows.connectionId, schema: delRows.schema, table: delRows.table'))
 assert.ok(browse.includes('expectedValues: [orig]'))
})
