import test from 'node:test'
import assert from 'node:assert/strict'
import { insertTableDrafts } from './tableDrafts.ts'

test('draft insertion sends one batch preserving omitted defaults, text NULL and leading zeros',async()=>{
 const calls:unknown[]=[]
 await insertTableDrafts({columns:['id','v','w'],drafts:[{id:'001',v:'NULL',w:''},{id:'002',v:'',w:'x'}],submit:async rows=>{calls.push(rows);return rows.length}})
 assert.deepEqual(calls,[[{columns:['id','v'],values:['001','NULL']},{columns:['id','w'],values:['002','x']}]])
})
test('all draft rows validate before any write and empty later row cancels whole batch',async()=>{
 let writes=0
 await assert.rejects(insertTableDrafts({columns:['v'],drafts:[{v:'first'},{v:''}],submit:async()=>{writes++;return 1}}),/第 2 行/)
 assert.equal(writes,0)
 await assert.rejects(insertTableDrafts({columns:['v'],drafts:[{unexpected:'x'}],submit:async()=>{writes++;return 1}}),/字段/)
 assert.equal(writes,0)
})
test('draft payload bounds reject before dispatch and propagate unknown commit without retries',async()=>{
 let writes=0
 await assert.rejects(insertTableDrafts({columns:['v'],drafts:[{v:'a'.repeat(3*1024*1024)}],submit:async()=>{writes++;return 1}}),/预算/)
 assert.equal(writes,0)
 await assert.rejects(insertTableDrafts({columns:['v'],drafts:[{v:'ok'}],submit:async()=>{writes++;throw new Error('commit uncertain')}}),/commit uncertain/)
 assert.equal(writes,1)
})
