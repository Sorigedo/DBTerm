// Actual component; simulated IPC and clipboard; disposable browser profile.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(process.env.DBTERM_PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../../',import.meta.url));
const entry="import React from 'react';import {createRoot} from 'react-dom/client';import TableBrowser from '/src/components/DbTools/TableBrowser.tsx';import '/src/index.css';createRoot(document.getElementById('grid')).render(React.createElement(TableBrowser,{connectionId:'isolated',connType:'mysql',schema:'fixture',table:'sample',embedded:true,active:true}));";
const html='<html><body><div id=grid></div><script type=module src=/__grid.tsx></script></body></html>';
const server=await createServer({root,configFile:false,plugins:[react(),{name:'isolated-grid',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url==='/__grid'){res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__grid',html));}else next();});},resolveId(id){if(id==='/__grid.tsx')return '\0isolated-grid.tsx';},load(id){if(id==='\0isolated-grid.tsx')return entry;}}],server:{host:'127.0.0.1',port:0}});
let browser;
try {
 await server.listen();
 browser=await chromium.launch({executablePath:process.env.DBTERM_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.fixtureRows=new URLSearchParams(location.hash.slice(1)).has('empty')?[]:[['1','alpha','one'],['2','beta','two'],['3','gamma','three']];window.calls=[];window.fixtureClipboard='';
  const result=rows=>({columns:['id','a','b'],rows,rowsAffected:0,executionTimeMs:1});
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'fixture'},currentWebview:{label:'fixture'}},invoke:async(cmd,args={})=>{
   window.calls.push({cmd,args});
   if(cmd==='plugin:clipboard-manager|write_text'){window.fixtureClipboard=args.text;return;}
   if(cmd==='plugin:clipboard-manager|read_text')return window.fixtureClipboard;
   if(cmd==='execute_query'){
    if(args.sql.includes('information_schema.COLUMNS'))return result([['id','int','PRI','','NO',null,''],['a','varchar(128)','','','NO',null,''],['b','varchar(128)','','','NO',null,'']]);
    if(args.sql.startsWith('SELECT COUNT'))return result([[String(window.fixtureRows.length)]]);
    if(args.sql.startsWith('SELECT *'))return result(window.fixtureRows.map(r=>[...r]));
    throw Error('unexpected isolated SQL: '+args.sql);
   }
   if(cmd==='plugin:event|listen')return 1;if(cmd==='plugin:event|unlisten')return;
   throw Error('unexpected isolated IPC: '+cmd);
  }};
 });
 for(const empty of [true,false]) {
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__grid'+(empty?'#empty=1':''));
 await page.getByLabel('选择 id 列',{exact:true}).waitFor();
 await page.locator('[data-tip="新增行"]').click();
 await page.locator('.tb-tr--draft').waitFor();
 for(const width of [1280,640]) {
 await page.setViewportSize({width,height:800});
 const layout=await page.evaluate(()=>{
  const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right};};
  return {headers:[...document.querySelectorAll('.tb-table thead th')].map(rect),rows:[...document.querySelectorAll('.tb-table tbody tr')].map(row=>[...row.children].map(rect)),inputs:[...document.querySelectorAll('.tb-tr--draft input')].map(e=>({input:rect(e),cell:rect(e.parentElement)}))};
 });
 for(const cells of layout.rows){
  assert.equal(cells.length,layout.headers.length,'draft and existing rows must have the same cells as the header');
  cells.forEach((cell,i)=>assert.ok(Math.abs(cell.left-layout.headers[i].left)<1&&Math.abs(cell.right-layout.headers[i].right)<1,'each cell aligns with its header'));
 }
 for(const {input,cell} of layout.inputs)assert.ok(input.left>=cell.left&&input.right<=cell.right,'draft inputs remain inside their column');
 }
 await page.locator('.tb-tr--draft input').nth(1).fill('中文新数据');
 assert.equal(await page.locator('.tb-tr--draft input').nth(1).inputValue(),'中文新数据');
 await page.locator('[data-tip="移除此行"]').click();
 assert.equal(await page.locator('.tb-tr--draft').count(),0);
 assert.equal(await page.locator('.tb-table thead th').count(),4);
 }
 assert.deepEqual(errors,[]);
 console.log('PASS empty/populated table draft alignment at desktop/narrow widths, input containment, typing and removal; mocked IPC only.');
}finally{await browser?.close();await server.close();}
