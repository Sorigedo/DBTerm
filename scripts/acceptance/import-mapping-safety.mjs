// Actual tree and confirmation dialogs; temporary Chrome; simulated IPC only.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(process.env.DBTERM_PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../../',import.meta.url));
const fixture=await mkdtemp(join(tmpdir(),'dbterm-tree-target-'));
const entry="import React from 'react';import {createRoot} from 'react-dom/client';import ImportDialog from '/src/components/DbTools/ImportDialog.tsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(ImportDialog,{connectionId:'fixture',schema:'fixture_db',table:'fixture_table',columns:['id','value'],tables:['fixture_table','second','third'],onClose:()=>{},onDone:()=>{}}));";
const html='<html><body><div id=root style="width:450px"></div><script type=module src=/__tree.tsx></script></body></html>';
const server=await createServer({root,configFile:false,cacheDir:join(fixture,'cache'),plugins:[react(),{name:'isolated-tree-target',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url==='/__tree'){res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__tree',html));}else next();});},resolveId(id){if(id==='/__tree.tsx')return '\0isolated-tree-target.tsx';},load(id){if(id==='\0isolated-tree-target.tsx')return entry;}}],server:{host:'127.0.0.1',port:0}});
let browser;
try {
 await server.listen();
 browser=await chromium.launch({executablePath:process.env.DBTERM_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const failures=[];
 for(const scenario of ['headerless','unknown','preview-error','stale-preview','duplicate','stale-target']) {
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript((scenario)=>{
  window.calls=[];
  window.__TAURI_INTERNALS__={invoke:async(command,args={})=>{
   window.calls.push({command,args});
   if(command==='plugin:dialog|open')return '/isolated/mapping.csv';
   if(command==='table_columns')return await new Promise(resolve=>{window.targetReplies??={};window.targetReplies[args.table]=resolve;});
   if(command==='read_delimited_file_header') {
    if(scenario==='preview-error')throw new Error('bad header');
    if(scenario==='stale-preview')return await new Promise(resolve=>{window.resolvePreview=resolve;});
    return scenario==='headerless'?['001','some text']:scenario==='duplicate'?['id','id']:scenario==='stale-target'?['id','value']:['unmatched'];
   }
   if(command==='db_import_csv')return {inserted:1,skipped:0,errors:[]};
   throw new Error('unexpected '+command);
  }};
 },scenario);
 try {
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__tree');
 await page.getByRole('button',{name:'数据文件',exact:false}).click();
 await page.getByRole('button',{name:'选择 CSV 文件',exact:true}).click();
 if(scenario==='stale-target') {
   await page.waitForFunction(()=>document.querySelectorAll('.imp-map-table__src').length===2);
   await page.getByRole('button',{name:'fixture_table',exact:true}).click();
   await page.getByRole('button',{name:'second',exact:true}).click();
   await page.waitForFunction(()=>window.targetReplies?.second);
   assert.equal(await page.getByRole('button',{name:'开始导入',exact:true}).isDisabled(),true);
   await page.getByRole('button',{name:'second',exact:true}).click();
   await page.getByRole('button',{name:'third',exact:true}).click();
   await page.waitForFunction(()=>window.targetReplies?.third);
   await page.evaluate(()=>window.targetReplies.third([{name:'id'},{name:'value'}]));
   await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='开始导入'&&!b.disabled));
   await page.evaluate(()=>window.targetReplies.second([{name:'wrong'}]));
   await page.getByRole('button',{name:'开始导入',exact:true}).click();
   await page.waitForFunction(()=>window.calls.some(c=>c.command==='db_import_csv'));
   const args=await page.evaluate(()=>window.calls.find(c=>c.command==='db_import_csv').args);
   assert.equal(args.table,'third');assert.deepEqual(args.columns,['id','value']);
 }else if(scenario==='duplicate'){
   await page.waitForFunction(()=>document.querySelectorAll('.imp-map-table__src').length===2);
   assert.equal(await page.getByRole('button',{name:'开始导入',exact:true}).isDisabled(),true);
   await page.locator('.imp-map-table tbody tr').nth(1).getByRole('button').click();
   await page.getByRole('button',{name:'value',exact:true}).click();
   await page.getByRole('button',{name:'开始导入',exact:true}).click();
   await page.waitForFunction(()=>window.calls.some(c=>c.command==='db_import_csv'));
   assert.deepEqual(await page.evaluate(()=>window.calls.find(c=>c.command==='db_import_csv').args.columns),['id','value']);
 }else if(scenario==='stale-preview') {
   await page.waitForFunction(()=>typeof window.resolvePreview==='function');
   await page.getByRole('button',{name:'JSON',exact:true}).click();
   await page.evaluate(()=>window.resolvePreview(['stale']));
   await page.waitForTimeout(70);
   assert.equal(await page.locator('.imp-map-table__src').count(),0,'old preview must not modify a different format');
 }else if(scenario==='headerless'){
   await page.waitForFunction(()=>document.querySelectorAll('.imp-map-table__src').length===2);
   await page.getByText('包含表头行',{exact:true}).click();
   await page.getByRole('button',{name:'开始导入',exact:true}).click();
   await page.waitForFunction(()=>window.calls.some(c=>c.command==='db_import_csv'));
   const args=await page.evaluate(()=>window.calls.find(c=>c.command==='db_import_csv').args);
   assert.deepEqual(args.columns,['id','value'],'headerless values must map by position, never by first-row content');
   assert.equal(args.hasHeader,false);
 }else{
   await page.waitForTimeout(90);
   assert.equal(await page.getByRole('button',{name:'开始导入',exact:true}).isDisabled(),true,'unmapped or unreadable preview must not silently use the first target column');
   assert.equal(await page.evaluate(()=>window.calls.some(c=>c.command==='db_import_csv')),false);
 }
 assert.deepEqual(errors,[]);
 }catch(e){failures.push(scenario+': '+e.message);}finally{await page.close();}
 }
 assert.deepEqual(failures,[]);
 console.log('PASS actual ImportDialog preserves positional mapping, requires explicit unknown-column mapping, blocks unreadable previews, and discards stale format replies; simulated IPC only.');
}finally{await browser?.close();await server.close();await rm(fixture,{recursive:true,force:true});}
