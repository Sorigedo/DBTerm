import test from 'node:test'
import assert from 'node:assert/strict'
import { parseGridText, encodeGridText, planGridPaste, mergeGridEdits, groupGridEdits, editableGridExtra, validateGridBudget } from './tableClipboard.ts'
test('TSV quotes preserve tabs newlines empty strings and literal NULL',()=>{
 const data=[['a\tb','line\nnext','say "hi"',''],['NULL','',null,'z']]
 assert.deepEqual(parseGridText(encodeGridText(data)),data.map(r=>r.map(v=>v??'NULL')))
 assert.deepEqual(parseGridText('a\tb\r\nc\td\r\n'),[['a','b'],['c','d']])
 assert.throws(()=>parseGridText('"unterminated'));assert.throws(()=>parseGridText('a\tb\nc'))
})
const base={rows:[['1','old','x'],['2',null,'y']],columns:['id','v','w'],keys:['id'],meta:{id:{nullable:false,editable:false},v:{nullable:true,editable:true},w:{nullable:false,editable:true}}}
test('scalar fills selected columns and full validation refuses partial edits',()=>{
 const edits=planGridPaste({...base,selection:{rows:[0,1],columns:[1,2]},values:[['new']]})
 assert.equal(edits.length,4);assert.deepEqual(edits[2].pkValues,['2']);assert.equal(edits[2].oldValue,null)
 assert.throws(()=>planGridPaste({...base,selection:{rows:[0],columns:[0,1]},values:[['new']]}))
 assert.throws(()=>planGridPaste({...base,selection:{rows:[0,1],columns:[1,2]},values:[['a','b','c']]}))
 assert.throws(()=>planGridPaste({...base,selection:{rows:[0],columns:[2]},values:[[null]]}))
})
test('single-cell anchor expands exact matrix and retains original optimistic baseline',()=>{
 const first=planGridPaste({...base,selection:{rows:[0],columns:[1]},values:[['a','b'],['c','d']]})
 const next=planGridPaste({...base,selection:{rows:[0],columns:[1]},values:[['final']]})
 const merged=mergeGridEdits(first,next);assert.equal(merged[0].oldValue,'old');assert.equal(merged[0].newValue,'final')
 const grouped=groupGridEdits(merged,base.columns,base.keys);assert.equal(grouped.length,2);assert.deepEqual(grouped[0].expectedValues,['old','x']);assert.deepEqual(grouped[0].pkValues,['1'])
 assert.throws(()=>planGridPaste({...base,selection:{rows:[1],columns:[2]},values:[['a','b']]}))
})
test('plain text empty is never inferred as NULL and literal NULL remains text',()=>{
 const empty=planGridPaste({...base,selection:{rows:[0],columns:[1]},values:parseGridText('')})
 const literal=planGridPaste({...base,selection:{rows:[0],columns:[1]},values:parseGridText('NULL')})
 assert.equal(empty[0].newValue,'');assert.equal(literal[0].newValue,'NULL')
 const captured={rows:[0],columns:[1]};const moved={rows:[1],columns:[2]}
 const plan=planGridPaste({...base,selection:captured,values:parseGridText('copied')})
 assert.deepEqual([plan[0].ri,plan[0].ci],[0,1]);assert.notDeepEqual(captured,moved)
})
test('generated expressions are blocked while ordinary generated defaults stay writable',()=>{
 assert.equal(editableGridExtra('DEFAULT_GENERATED on update CURRENT_TIMESTAMP'),true)
 for(const extra of ['VIRTUAL GENERATED','STORED GENERATED','GENERATED','IDENTITY','auto_increment'])assert.equal(editableGridExtra(extra),false)
})
test('delimiter bombs and scalar expansion are bounded before IPC serialization',()=>{
 assert.throws(()=>parseGridText(Array(10002).fill('').join('	')))
 const planned=planGridPaste({...base,selection:{rows:[0,1],columns:[1,2]},values:[['x'.repeat(900000)]]})
 assert.throws(()=>validateGridBudget(planned))
 assert.doesNotThrow(()=>validateGridBudget(planGridPaste({...base,selection:{rows:[0],columns:[1]},values:[['ok']]})))
})
