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
   if(command==='list_tables_meta')return [{name:"same'.]table",comment:'fixture',rowCount:args.ssSchema==="ops'.]中文"?222:111,dataLength:0,indexLength:0,autoIncrement:null,engine:'',charset:'',updatedAt:null,createdAt:null,tableType:'BASE TABLE'}];
   if(command==='get_table_ddl'){
    window.ddlCount=(window.ddlCount||0)+1;
    if(window.ddlCount===1)return new Promise(resolve=>{window.resolveOld=resolve;});
    return 'NEW_DBO_DDL';
   }
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
 const failures=[];
 const check=(actual,expected,label)=>{try{assert.deepEqual(actual,expected,label);}catch(e){failures.push(e.message);}};
 const show=async(schema,menu)=>{
  const node=page.locator('.dbt-cat-node').filter({has:page.locator('.dbt-cat-label',{hasText:schema})});
  await node.locator('.dbt-table-row').filter({hasText:"same'.]table"}).click({button:'right'});
  await page.getByRole('button',{name:menu,exact:false}).click();
 };
 await show("ops'.]中文",'表信息');
 await page.waitForFunction(()=>document.querySelector('.tbl-info__grid'));
 check(await page.evaluate(()=>window.calls.filter(c=>c.command==='list_tables_meta').at(-1).args.ssSchema),"ops'.]中文",'table info must retain selected schema');
 check(await page.locator('.tbl-info__grid').innerText().then(s=>s.includes('222')),true,'table info must display selected schema statistics');
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 await show("ops'.]中文",'查看 DDL');
 await page.waitForFunction(()=>window.calls.some(c=>c.command==='get_table_ddl'));
 check(await page.evaluate(()=>window.calls.filter(c=>c.command==='get_table_ddl').at(-1).args.ssSchema),"ops'.]中文",'DDL must retain selected schema');
 check(await page.evaluate(()=>window.calls.filter(c=>c.command==='list_tables_meta').at(-1).args.ssSchema),"ops'.]中文",'DDL statistics must retain selected schema');
 await page.keyboard.press('Escape');
 await show('dbo','查看 DDL');
 await page.waitForFunction(()=>document.querySelector('.ddl-modal__body')?.textContent.includes('NEW_DBO_DDL'));
 await page.evaluate(()=>window.resolveOld('OLD_OPS_DDL'));
 await page.waitForTimeout(120);
 check(await page.locator('.ddl-modal__body').innerText().then(s=>s.includes('NEW_DBO_DDL')),true,'old DDL response must not overwrite newly opened object');
 check(errors,[],'no browser errors');
 check(await page.evaluate(()=>window.unexpected),[],'no unexpected IPC');
 assert.deepEqual(failures,[]);
 console.log('PASS actual tree info/DDL schema routing and stale DDL response isolation; simulated IPC only.');
}finally{await browser?.close();await server.close();await rm(fixture,{recursive:true,force:true});}
