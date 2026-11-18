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
const entry="import React from 'react';import {createRoot} from 'react-dom/client';import Tree from '/src/components/AssetPanel/DbSchemaTree.tsx';import Browser from '/src/components/SchemaBrowser/index.tsx';import Migration from '/src/components/DbTools/MigrationWizard.tsx';import {useAppStore} from '/src/stores/appStore.ts';import {useDbClipboard} from '/src/stores/dbClipboardStore.ts';import '/src/index.css';window.clipboardStore=useDbClipboard;const connections=[{id:'fixture',name:'fixture',type:'mysql',createdAt:0,updatedAt:0}];useAppStore.setState({connections});window.openMigration=p=>{const host=document.createElement('div');document.body.appendChild(host);const modal=createRoot(host);modal.render(React.createElement(Migration,{connections,defaultSrcId:p.srcId,defaultSrcSchema:p.srcSchema,defaultDstId:p.dstId,defaultDstSchema:p.dstSchema,defaultTable:p.srcTable,defaultTables:p.srcTables,onClose:()=>{modal.unmount();host.remove()}}));};createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,React.createElement('div',{style:{visibility:'hidden',position:'absolute'}},React.createElement(Browser,{connectionId:'fixture',connType:'mysql',schema:'hidden_db',category:'tables',active:false})),React.createElement('aside',{className:'asset-panel'},React.createElement(Tree,{connectionId:'fixture',connType:'mysql',onOpenTable:()=>{},onMigrate:p=>{window.pasted=p;if(window.showMigrationOnPaste)window.openMigration(p)}})),React.createElement(Browser,{connectionId:'fixture',connType:'mysql',schema:'fixture_db',category:'tables'})));";
const html='<html><body><div id=root style="display:flex;width:1400px;height:900px"></div><script type=module src=/__tree.tsx></script></body></html>';
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
   if(command==='list_schemas')return ['fixture_db','target_db'];
   if(command==='list_ss_db_schemas')return ['dbo',"ops'.]中文"];
   if(command==='list_ss_schema_tables')return [{name:"same'.]table",isView:false},{name:'same_view',isView:true}];
   if(command==='list_tables')return [{name:'source_table',isView:false},{name:'preview_table',isView:false}];
   if(command==='list_routines')return [];
   if(command==='list_tables_meta')return [{name:args.schema==='hidden_db'?'hidden_table':'preview_table',comment:'',rowCount:0,dataLength:0,indexLength:0,autoIncrement:null,engine:'InnoDB',charset:'utf8mb4',updatedAt:null,createdAt:null,tableType:'BASE TABLE'}];
   if(command==='plugin:clipboard-manager|write_text'){window.systemClipboard=args.text;return;}
   if(command==='db_copy_table')return;
   if(command==='execute_query')return {columns:[],rows:[],rowsAffected:0,executionTimeMs:0};
   window.unexpected.push(command);throw new Error('unexpected isolated IPC '+command);
  }};
 });
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__tree');
 await page.locator('.dbt-schema-row').filter({hasText:'fixture_db'}).click();
 await page.locator('.dbt-cat-expand-btn').first().click();
 await page.getByText('source_table',{exact:true}).click();
 await page.keyboard.press('Meta+c');
 await page.waitForFunction(()=>window.clipboardStore.getState().clipboard?.name==='source_table');
 await page.getByRole('button',{name:'target_db',exact:true}).click();
 await page.keyboard.press('Meta+v');
 await page.waitForFunction(()=>window.pasted,null,{timeout:2000});
 assert.equal(await page.evaluate(()=>window.pasted.dstSchema),'target_db');
 assert.equal(await page.evaluate(()=>window.systemClipboard),'source_table','system clipboard must receive the plain table name');
 // The preview's capture listener must not steal a paste addressed to the sidebar.
 await page.locator('.sb-root').last().getByText('preview_table',{exact:true}).click();
 await page.keyboard.press('Meta+c');
 await page.waitForFunction(()=>window.systemClipboard==='preview_table');
 await page.evaluate(()=>window.pasted=null);
 await page.locator('.dbt-schema-row').filter({hasText:'target_db'}).click();
 await page.keyboard.press('Meta+v');
 await page.waitForFunction(()=>window.pasted,null,{timeout:2000});
 assert.equal(await page.evaluate(()=>window.pasted.srcTable),'preview_table');
 assert.equal(await page.evaluate(()=>window.pasted.dstSchema),'target_db');
 // List rows are divs: clicking them may leave keyboard focus on a sidebar button.
 await page.locator('[data-tip="列表视图"]').last().click();
 await page.getByText('source_table',{exact:true}).click();
 await page.locator('.dbt-schema-row').filter({hasText:'target_db'}).focus();
 await page.evaluate(()=>{window.systemClipboard='';window.clipboardStore.getState().clear()});
 await page.locator('.sb-tr').filter({hasText:'preview_table'}).click();
 await page.keyboard.press('Meta+c');
 await page.waitForFunction(()=>window.systemClipboard==='preview_table',null,{timeout:2000});
 assert.equal(await page.evaluate(()=>window.clipboardStore.getState().clipboard.name),'preview_table');
 // Hidden keep-alive tabs must not claim the native key event.
 await page.locator('.sb-root').last().locator('.sb-toolbar').click({position:{x:2,y:2}});
 await page.keyboard.press('Meta+v');
 await page.waitForFunction(()=>window.calls.some(c=>c.command==='db_copy_table'),null,{timeout:2000});
 await page.evaluate(()=>{window.pasted=null;window.showMigrationOnPaste=true});
 await page.locator('.dbt-schema-row').filter({hasText:'target_db'}).click();
 await page.keyboard.press('Meta+v');
 await page.waitForFunction(()=>window.pasted?.dstSchema==='target_db');
 await page.getByText('数据迁移向导',{exact:true}).waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('input[type=checkbox]')].some(input=>input.checked && input.parentElement?.textContent.includes('preview_table')));
 await page.getByRole('button',{name:'下一步',exact:true}).click();
 assert.ok((await page.locator('body').innerText()).includes('target_db'),'migration wizard must preselect the destination');
 assert.deepEqual(errors,[]);
 console.log('PASS actual tree + list/grid browser: Mod+C writes plain names; cross-schema Mod+V opens preselected migration wizard; hidden tabs cannot steal shortcuts; simulated IPC.');
}finally{await browser?.close();await server.close();await rm(fixture,{recursive:true,force:true});}
