// Actual component; simulated IPC and clipboard; disposable browser profile.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {writeFile} from 'node:fs/promises';
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
  window.fixtureRows=[['1','alpha','one'],['2','beta','two'],['3','gamma','three']];window.calls=[];window.fixtureClipboard='';
  const result=rows=>({columns:['id','a','b'],rows,rowsAffected:0,executionTimeMs:1});
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'fixture'},currentWebview:{label:'fixture'}},invoke:async(cmd,args={})=>{
   window.calls.push({cmd,args});
   if(cmd==='plugin:clipboard-manager|write_text'){window.fixtureClipboard=args.text;return;}
   if(cmd==='plugin:clipboard-manager|read_text')return window.fixtureClipboard;
   if(cmd==='execute_query'){
    if(args.sql.includes('information_schema.COLUMNS'))return result([['id','int','PRI','','NO',null,''],['a','varchar(128)','','','NO',null,''],['b','varchar(128)','','','NO',null,'']]);
    if(args.sql.startsWith('SELECT COUNT'))return result([['3']]);
    if(args.sql.startsWith('SELECT *'))return result(window.fixtureRows.map(r=>[...r]));
    throw Error('unexpected isolated SQL: '+args.sql);
   }
   if(cmd==='update_cells'){
    if(window.failSave)throw Error('提交未获确认，结果未知，禁止自动重试');
    const next=window.fixtureRows.map(r=>[...r]);
    for(const c of args.changes){const row=next.find(r=>r[0]===c.pkValues[0]);c.columns.forEach((column,i)=>{const ci=['id','a','b'].indexOf(column);if(row[ci]!==c.expectedValues[i])throw Error('stale baseline');row[ci]=c.values[i];});}
    window.fixtureRows=next;return;
   }
   if(cmd==='plugin:event|listen')return 1;if(cmd==='plugin:event|unlisten')return;
   throw Error('unexpected isolated IPC: '+cmd);
  }};
 });
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__grid');
 await page.waitForFunction(()=>document.querySelectorAll('.tb-table tbody tr[data-ri]').length===3);
 const select=(row,col,shift=false)=>page.evaluate(({row,col,shift})=>{document.querySelectorAll('.tb-table tbody tr[data-ri]')[row].querySelectorAll('td')[col+1].dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,buttons:1,shiftKey:shift}));window.dispatchEvent(new MouseEvent('mouseup',{button:0,buttons:0}));},{row,col,shift});
 const key=k=>page.locator('.tb-table-wrap').dispatchEvent('keydown',{key:k,metaKey:true});
 const values=()=>page.evaluate(()=>window.fixtureRows);const initial=await values();
 await select(0,1);await key('c');await page.waitForFunction(()=>window.fixtureClipboard==='alpha');
 await select(1,1);await key('v');const save=page.getByRole('button',{name:'保存修改',exact:true});await save.waitFor();
 assert.deepEqual(await values(),initial,'paste must remain staged');
 await save.click();await page.waitForFunction(()=>window.fixtureRows[1][1]==='alpha');await save.waitFor({state:'hidden'});
 await page.getByLabel('选择 a 列',{exact:true}).click();await page.getByLabel('选择 b 列',{exact:true}).dispatchEvent('click',{metaKey:true});await key('c');
 await page.waitForFunction(()=>window.fixtureClipboard==='alpha\tone\nalpha\ttwo\ngamma\tthree');
 await page.evaluate(()=>window.fixtureClipboard='');
 await page.getByLabel('选择 a 列',{exact:true}).click();await page.getByLabel('选择 b 列',{exact:true}).dispatchEvent('click',{shiftKey:true});await key('c');
 await page.waitForFunction(()=>window.fixtureClipboard==='alpha\tone\nalpha\ttwo\ngamma\tthree');
 await page.evaluate(()=>window.fixtureClipboard='fill');await key('v');await save.waitFor();assert.equal((await values())[2][2],'three');
 await save.click();await page.waitForFunction(()=>window.fixtureRows.every(r=>r[1]==='fill'&&r[2]==='fill'));await save.waitFor({state:'hidden'});
 await select(0,1);await select(1,2,true);await page.evaluate(()=>window.fixtureClipboard='A1\tB1\nA2\tB2');await key('v');await save.waitFor();await save.click();
 await page.waitForFunction(()=>window.fixtureRows[1][2]==='B2');await save.waitFor({state:'hidden'});
 assert.deepEqual(await values(),[['1','A1','B1'],['2','A2','B2'],['3','fill','fill']]);
 const saves=await page.evaluate(()=>window.calls.filter(c=>c.cmd==='update_cells'));assert.equal(saves.length,3);assert.equal(saves[0].args.changes[0].expectedValues[0],'beta');
 await select(0,1);await page.evaluate(()=>{window.fixtureClipboard='uncertain';window.failSave=true;});await key('v');await save.waitFor();await save.evaluate(b=>{b.click();b.click();});
 await page.waitForFunction(()=>window.calls.filter(c=>c.cmd==='update_cells').length===4);
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='保存修改'&&b.disabled));
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.cmd==='update_cells').length),4);assert.equal((await values())[0][1],'A1');assert.deepEqual(errors,[]);
 if(process.env.DBTERM_GRID_PAYLOAD_OUTPUT)await writeFile(process.env.DBTERM_GRID_PAYLOAD_OUTPUT,JSON.stringify({initial,saves:saves.map(call=>call.args.changes),expected:await values()},null,2)+'\n');
 console.log('PASS actual TableBrowser: single cell, Shift columns, rectangle, staged saves, baseline values, unknown-outcome block and double-submit guard; simulated IPC/clipboard only.');
}finally{await browser?.close();await server.close();}
