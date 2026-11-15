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
const entry="import {exportSchemaArchive} from '/src/utils/schemaArchiveExport.ts';window.runArchive=exportSchemaArchive;";
const html='<html><body><div id=root style="width:450px"></div><script type=module src=/__tree.tsx></script></body></html>';
const server=await createServer({root,configFile:false,cacheDir:join(fixture,'cache'),plugins:[react(),{name:'isolated-tree-target',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url==='/__tree'){res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__tree',html));}else next();});},resolveId(id){if(id==='/__tree.tsx')return '\0isolated-tree-target.tsx';},load(id){if(id==='\0isolated-tree-target.tsx')return entry;}}],server:{host:'127.0.0.1',port:0}});
let browser;
try {
 await server.listen();
 browser=await chromium.launch({executablePath:process.env.DBTERM_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.calls=[];
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   window.calls.push({command,args});
   if(command!=='db_logical_backup')throw new Error('unexpected '+command);
   return {tablesDone:1,totalRows:9,fileSize:123};
  }};
 });
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__tree');
 await page.waitForFunction(()=>!!window.runArchive);
 for(const content of ['structure','data','both']){
  const result=await page.evaluate(async(content)=>window.runArchive({connectionId:'fixture',connType:'sqlServer',schema:'B]库',ssSchema:"ops'.]中文",objects:{tables:['same']},content,path:'/isolated/export.zip',taskId:'fixture'}),content);
  assert.deepEqual(result,{tablesDone:1,totalRows:9,fileSize:123,workspace:''});
 }
 const calls=await page.evaluate(()=>window.calls);
 assert.equal(calls.length,3);
 for(const call of calls){assert.equal(call.command,'db_logical_backup');assert.equal(call.args.schema,'B]库');assert.equal(call.args.ssSchema,"ops'.]中文");assert.deepEqual(call.args.tables,['same']);}
 assert.deepEqual(calls.map(c=>c.args.content),['structure','data','both']);
 assert.deepEqual(errors,[]);
 console.log('PASS actual exportSchemaArchive forwards selected database/object schema for structure/data/both without starting generic table export; simulated IPC, no filesystem export.');
}finally{await browser?.close();await server.close();await rm(fixture,{recursive:true,force:true});}
