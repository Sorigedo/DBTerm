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
const entry="import React from 'react';import {createRoot} from 'react-dom/client';import ImportDialog from '/src/components/DbTools/ImportDialog.tsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(ImportDialog,{connectionId:'fixture',schema:'fixture_db',table:'fixture_table',columns:['id,part','value\\nlabel'],onClose:()=>{},onDone:()=>{}}));";
const html='<html><body><div id=root style="width:450px"></div><script type=module src=/__tree.tsx></script></body></html>';
const server=await createServer({root,configFile:false,cacheDir:join(fixture,'cache'),plugins:[react(),{name:'isolated-tree-target',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url==='/__tree'){res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__tree',html));}else next();});},resolveId(id){if(id==='/__tree.tsx')return '\0isolated-tree-target.tsx';},load(id){if(id==='\0isolated-tree-target.tsx')return entry;}}],server:{host:'127.0.0.1',port:0}});
let browser;
try {
 await server.listen();
 browser=await chromium.launch({executablePath:process.env.DBTERM_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.calls=[];window.unexpected=[];
  window.__TAURI_INTERNALS__={invoke:async(command,args={})=>{
   window.calls.push({command,args});
   if(command==='plugin:dialog|open')return '/isolated/quoted.csv';
   if(command==='read_delimited_file_header')return ['id,part','value\nlabel'];
   window.unexpected.push(command);throw new Error('unexpected '+command);
  }};
 });
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__tree');
 await page.getByRole('button',{name:'数据文件',exact:false}).click();
 await page.getByRole('button',{name:'选择 CSV 文件',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.imp-map-table__src').length===2);
 assert.deepEqual(await page.locator('.imp-map-table__src').allTextContents(),['id,part','value\nlabel']);
 const calls=await page.evaluate(()=>window.calls);
 assert.deepEqual(calls.find(c=>c.command==='read_delimited_file_header').args,{path:'/isolated/quoted.csv',format:'csv'});
 assert.equal(calls.some(c=>c.command==='read_file_first_line'||c.command==='db_import_csv'),false);
 assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.unexpected),[]);
 console.log('PASS actual ImportDialog uses logical quoted CSV headers and preserves comma/newline names; simulated dialog/IPC, no database writes.');
}finally{await browser?.close();await server.close();await rm(fixture,{recursive:true,force:true});}
