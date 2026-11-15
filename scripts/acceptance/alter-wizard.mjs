// Actual React wizard; disposable headless browser; simulated Tauri IPC only.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(process.env.DBTERM_PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../../',import.meta.url));
const entry="import React from 'react';import {createRoot} from 'react-dom/client';import Wizard from '/src/components/DbTools/AlterTableWizard.tsx';import '/src/index.css';const root=createRoot(document.getElementById('root'));window.renderWizard=(table='sample')=>root.render(React.createElement(Wizard,{connectionId:'fixture',connType:'duckdb',schema:'main',table,onClose:()=>{},onDone:()=>{window.done=(window.done||0)+1}}));window.renderWizard();";
const html='<html><body><div id=root></div><script type=module src=/__alter.tsx></script></body></html>';
const server=await createServer({root,configFile:false,plugins:[react(),{name:'isolated-alter',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url==='/__alter'){res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__alter',html));}else next();});},resolveId(id){if(id==='/__alter.tsx')return '\0isolated-alter.tsx';},load(id){if(id==='\0isolated-alter.tsx')return entry;}}],server:{host:'127.0.0.1',port:0}});
let browser;
try {
 await server.listen();
 browser=await chromium.launch({executablePath:process.env.DBTERM_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.calls=[];window.done=0;window.fail=false;
  window.__TAURI_INTERNALS__={invoke:async(command,args={})=>{
   window.calls.push({command,args});
   if(command==='table_columns'){
    if(window.deferMetadata)return new Promise(resolve=>{(window.metadataResolvers||={})[args.table]=()=>resolve([{name:args.table+'_field',dataType:'VARCHAR',nullable:true,key:'',defaultValue:null}]);});
    return [{name:'v',dataType:'VARCHAR',nullable:true,key:'',defaultValue:'kept'}];
   }
   if(command==='duckdb_alter_table_atomic'){if(window.fail)throw new Error('commit receipt lost');return;}
   throw new Error('unexpected IPC '+command);
  }};
 });
 const url='http://127.0.0.1:'+server.httpServer.address().port+'/__alter';
 const edit=async()=>{await page.getByPlaceholder('列名',{exact:true}).fill('renamed');await page.locator('.alter-col-row input[type=checkbox]').uncheck();};
 await page.goto(url);await edit();
 const preview=await page.locator('.alter-sql-block').innerText();
 const execute=page.getByRole('button',{name:'执行 ALTER（2 条）',exact:true});
 await execute.evaluate(button=>{button.click();button.click();});
 await page.waitForFunction(()=>window.done===1);
 let calls=await page.evaluate(()=>window.calls.filter(c=>c.command==='duckdb_alter_table_atomic'));
 assert.equal(calls.length,1,'synchronous double-click must submit once');
 assert.deepEqual(calls[0].args,{id:'fixture',statements:preview.split('\n')});
 await page.reload();await edit();await page.evaluate(()=>window.fail=true);
 await execute.click();await page.waitForFunction(()=>document.body.textContent.includes('执行未获成功确认'));
 assert.equal(await execute.isDisabled(),true);
 await execute.evaluate(button=>{button.click();button.click();});
 await page.getByPlaceholder('默认值',{exact:true}).fill('changed');
 assert.equal(await page.getByRole('button',{name:'执行 ALTER（3 条）',exact:true}).isDisabled(),true,'editing after unknown receipt must not re-enable execution');
 calls=await page.evaluate(()=>window.calls.filter(c=>c.command==='duckdb_alter_table_atomic'));
 assert.equal(calls.length,1);assert.equal(await page.evaluate(()=>window.done),0);assert.deepEqual(errors,[]);
 await page.reload();await page.getByPlaceholder('列名',{exact:true}).waitFor();
 await page.getByPlaceholder('列名',{exact:true}).fill('pending_old_edit');
 await page.evaluate(()=>{window.deferMetadata=true;window.renderWizard('older');});
 await page.waitForFunction(()=>window.metadataResolvers?.older);
 await page.evaluate(()=>window.renderWizard('current'));
 await page.waitForFunction(()=>window.metadataResolvers?.current);
 assert.equal(await page.locator('.alter-col-row').count(),0,'previous target edits must disappear while new metadata loads');
 assert.equal(await page.getByRole('button',{name:'执行 ALTER（0 条）',exact:true}).isDisabled(),true);
 await page.evaluate(()=>window.metadataResolvers.current());
 await page.waitForFunction(()=>document.querySelector('input[placeholder=列名]')?.value==='current_field');
 await page.evaluate(()=>window.metadataResolvers.older());
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.getByPlaceholder('列名',{exact:true}).inputValue(),'current_field','late metadata from old table must not overwrite current table');
 assert.equal(await page.locator('.alter-sql-block').innerText(),'-- 无变更');
 console.log('PASS actual DuckDB AlterTableWizard: preview equals IPC, double-click sends once, unknown receipt blocks repeats, target switch clears pending edits and rejects late old metadata; isolated browser and simulated IPC only.');
}finally{await browser?.close();await server.close();}
