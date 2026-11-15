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
const entry="import React from 'react';import {createRoot} from 'react-dom/client';import Tree from '/src/components/AssetPanel/DbSchemaTree.tsx';import {useAppStore} from '/src/stores/appStore.ts';import '/src/index.css';useAppStore.setState({connections:[{id:'fixture',name:'fixture',type:'sqlServer',createdAt:0,updatedAt:0}]});createRoot(document.getElementById('root')).render(React.createElement(Tree,{connectionId:'fixture',connType:'sqlServer',onOpenTable:()=>{}}));";
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
   if(command==='list_schemas')return ['fixture_db'];
   if(command==='list_ss_db_schemas')return ['dbo',"ops'.]中文"];
   if(command==='list_ss_schema_tables')return [{name:"same'.]table",isView:false},{name:'same_view',isView:true}];
   if(command==='list_tables'||command==='list_routines')return [];
   if(command==='execute_query')return {columns:[],rows:[],rowsAffected:0,executionTimeMs:0};
   window.unexpected.push(command);throw new Error('unexpected isolated IPC '+command);
  }};
 });
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__tree');
 await page.getByRole('button',{name:'fixture_db',exact:true}).click();
 for(const schema of ['dbo',"ops'.]中文"]){
  await page.getByRole('button',{name:schema,exact:true}).click();
 }
 const selected=page.locator('.dbt-cat-node').filter({has:page.locator('.dbt-cat-label',{hasText:"ops'.]中文"})});
 const q=s=>'['+s.replaceAll(']',']]')+']';
 const path=[q("ops'.]中文"),q("same'.]table")].join('.');
 const ref=q('fixture_db')+'.'+path;
 const cases=[
  {menu:'重命名…',input:'新名称',value:'renamed',confirm:'重命名',expected:"EXEC [fixture_db].sys.sp_rename N'"+path.replaceAll("'","''")+"', N'renamed', N'OBJECT';"},
  {menu:'清空表',input:"same'.]table",value:"same'.]table",confirm:'确认清空',expected:'TRUNCATE TABLE '+ref},
  {menu:'删除表',input:"same'.]table",value:"same'.]table",confirm:'永久删除',expected:'DROP TABLE '+ref},
  {view:true,menu:'删除视图',input:'same_view',value:'same_view',confirm:'永久删除',expected:'DROP VIEW '+q('fixture_db')+'.'+q("ops'.]中文")+'.'+q('same_view')},
 ];
 const observed=[];
 for(const action of cases){
  const row=selected.locator('.dbt-table-row').filter({hasText:action.view?'same_view':"same'.]table"});
  await row.click({button:'right'});
  await page.getByRole('button',{name:action.menu,exact:false}).click();
  await page.getByPlaceholder(action.input,{exact:true}).fill(action.value);
  await page.getByRole('button',{name:action.confirm,exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.modal-overlay'));
  const call=await page.evaluate(()=>window.calls.filter(c=>c.command==='execute_query').at(-1));
  observed.push(call.args);
 }
 assert.deepEqual(observed,cases.map(action=>({id:'fixture',sql:action.expected})),'rename, truncate and drop must retain exact selected database and schema');
 await page.waitForFunction(()=>window.calls.filter(c=>c.command==='list_ss_schema_tables'&&c.args.ssSchema==="ops'.]中文").length===5);
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='list_ss_schema_tables'&&c.args.ssSchema==='dbo').length),1,'mutations must not reload the other schema branch');
 assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.unexpected),[]);
 console.log('PASS actual SQL Server tree: rename, truncate and drop retain selected schema with same-name objects in dbo and a quoted Unicode schema; simulated IPC only, no SQL Server service.');
}finally{await browser?.close();await server.close();await rm(fixture,{recursive:true,force:true});}
