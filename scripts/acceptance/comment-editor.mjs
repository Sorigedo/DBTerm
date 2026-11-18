import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {execFileSync} from 'node:child_process';
const {chromium}=await import(process.env.DBTERM_PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../../',import.meta.url));
const entry="import React from 'react';import {createRoot} from 'react-dom/client';import Wizard from '/src/components/DbTools/CreateTableWizard.tsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(Wizard,{connectionId:'fixture',connType:'mysql',schema:'test',editTable:'sample',onClose:()=>window.closedWizard=true,onDone:()=>window.savedWizard=true}));";
const server=await createServer({root,configFile:false,optimizeDeps:{entries:[],include:['react','react-dom/client','react-dom','react/jsx-runtime','lucide-react','zustand']},plugins:[react(),{name:'comment-fixture',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url==='/__comment'){res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__comment','<html><body><div id="root"></div><script type="module" src="/__comment.tsx"></script></body></html>'));}else next();});},resolveId(id){if(id==='/__comment.tsx')return '\0comment.tsx';},load(id){if(id==='\0comment.tsx')return entry;}}],server:{host:'127.0.0.1',port:0}});
let browser;
try {
 await server.listen();
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE',e.message)});page.on('console',m=>{if(m.type()==='error')console.error(m.text())});
 await page.addInitScript(()=>{
  const q=s=>String.fromCharCode(96)+s+String.fromCharCode(96);
  window.__TAURI_INTERNALS__={invoke:async(command,args={})=>{
   if(command==='get_table_ddl')return 'CREATE TABLE '+q('sample')+' (\n  '+q('id')+' bigint unsigned NOT NULL AUTO_INCREMENT,\n  '+q('title')+" varchar(64) DEFAULT NULL COMMENT '原始长注释：设备编码 BOARD 与 PAX'"+',\n  PRIMARY KEY ('+q('id')+')) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
   if(command==='execute_query'){
    const sql=args.sql;
    if(sql.includes('information_schema.STATISTICS'))return {rows:[]};
    if(sql.includes('information_schema.COLUMNS'))return {rows:[['id','bigint unsigned','NO','PRI',null,'auto_increment','',null],['title','varchar(64)','YES','',null,'','原始长注释：设备编码 BOARD 与 PAX','utf8mb4_0900_ai_ci']]};
    if(sql.includes('information_schema.TABLES'))return {rows:[['InnoDB','utf8mb4_0900_ai_ci','Dynamic','1','']]};
    if(sql.startsWith('SHOW COLLATION'))return {rows:[['utf8mb4_0900_ai_ci']]};
    if(sql==='SHOW CHARACTER SET')return {rows:[['utf8mb4']]};
    if(sql==='SHOW ENGINES')return {rows:[['InnoDB','DEFAULT']]};
    if(sql.startsWith('ALTER TABLE')){window.submittedSql=sql;return {rows:[]};}
   }
   throw new Error('unexpected IPC '+command);
  }};
 });
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__comment');
 const input=page.getByRole('textbox',{name:'title 注释',exact:true});
 await input.waitFor();
 const save=page.getByRole('button',{name:'保存修改',exact:true});
 assert.equal(await save.isDisabled(),true);
 await page.getByRole('button',{name:'编辑 title 的注释',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'编辑注释：title',exact:true});
 const textarea=dialog.getByRole('textbox',{name:'完整注释'});
 assert.equal(await textarea.inputValue(),'原始长注释：设备编码 BOARD 与 PAX');
 await textarea.fill('取消的草稿');
 await dialog.getByRole('button',{name:'取消',exact:true}).click();
 assert.equal(await input.inputValue(),'原始长注释：设备编码 BOARD 与 PAX');
 assert.equal(await save.isDisabled(),true);
 await input.dblclick();
 await textarea.fill('第一行：设备编码\n第二行：BOARD / PAX，完整长注释🙂');
 await dialog.evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));
 await page.screenshot({path:'/tmp/dbterm-comment-editor.png'});
 await dialog.getByRole('button',{name:'确认',exact:true}).click();
 assert.ok((await input.inputValue()).includes('第一行'));
 assert.equal(await save.isEnabled(),true);
 await page.getByRole('button',{name:'SQL 预览',exact:true}).click();
 assert.match(await page.locator('.ctw-sql').innerText(),/COMMENT '第一行：设备编码\n第二行/);
 await page.getByRole('button',{name:'字段',exact:true}).click();
 await page.locator('.ctw-grid--row').nth(1).locator('[data-tip="上移"]').click();
 await page.getByRole('button',{name:'SQL 预览',exact:true}).click();
 assert.match(await page.locator('.ctw-sql').innerText(),/FIRST/);
 await save.click();
 await page.waitForFunction(()=>!!window.submittedSql);
 assert.match(await page.evaluate(()=>window.submittedSql),/MODIFY COLUMN/);
 await page.getByText(/字段名称或顺序未达到预期/).waitFor();
 assert.equal(await page.evaluate(()=>!!window.savedWizard),false,'unchanged metadata must not report success');
 if(process.env.DBTERM_MYSQL_SOCKET){
  const mysql=sql=>execFileSync('/opt/homebrew/bin/mysql',['--no-defaults','--socket='+process.env.DBTERM_MYSQL_SOCKET,'-uroot','--default-character-set=utf8mb4','--batch','--raw'],{input:sql,encoding:'utf8'});
  const q=s=>String.fromCharCode(96)+s+String.fromCharCode(96);
  mysql('CREATE DATABASE IF NOT EXISTS test; DROP TABLE IF EXISTS test.sample; CREATE TABLE test.sample (id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,title varchar(64) DEFAULT NULL COMMENT '+"'原始长注释：设备编码 BOARD 与 PAX'"+') DEFAULT CHARSET=utf8mb4;');
  const real=await browser.newPage({viewport:{width:1440,height:1000}});
  await real.exposeFunction('dbInvoke',({command,args})=>{
   if(command==='get_table_ddl')return mysql('SHOW CREATE TABLE test.sample').split('\n').slice(1).join('\n').split('\t').slice(1).join('\t').trimEnd();
   if(command==='execute_query'){
    const text=mysql(args.sql);
    return {rows:text.trimEnd().split('\n').slice(1).map(r=>r.split('\t').map(v=>v==='NULL'?null:v))};
   }
   throw new Error(command);
  });
  await real.addInitScript(()=>window.__TAURI_INTERNALS__={invoke:(command,args)=>window.dbInvoke({command,args})});
  await real.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__comment');
  await real.getByRole('textbox',{name:'title 注释',exact:true}).waitFor();
  await real.getByRole('button',{name:'编辑 title 的注释',exact:true}).click();
  const popup=real.getByRole('dialog');
  await popup.getByRole('textbox',{name:'完整注释'}).fill('完整设备注释');
  await popup.getByRole('button',{name:'确认',exact:true}).click();
  await real.locator('.ctw-grid--row').nth(1).locator('[data-tip="上移"]').click();
  await real.locator('.ctw-grid--row').first().locator('input').nth(1).fill('128');
  await real.getByRole('button',{name:'保存修改',exact:true}).click();
  await real.waitForFunction(()=>window.savedWizard&&window.closedWizard);
  const ddl=mysql('SHOW CREATE TABLE test.sample');
  assert.ok(ddl.includes("varchar(128)")&&ddl.includes('完整设备注释'));
  await real.reload();
  await real.getByRole('textbox',{name:'title 注释',exact:true}).waitFor();
  assert.equal(await real.locator('.ctw-grid--row').first().locator('input').first().inputValue(),'title');
  assert.equal(await real.getByRole('textbox',{name:'title 注释',exact:true}).inputValue(),'完整设备注释');
  mysql('DROP DATABASE test;');
  await real.close();
  console.log('PASS real MySQL + React: popup edit + reorder + length -> save -> verify -> reopen.');
 }
 assert.deepEqual(errors,[]);
 console.log('PASS real React UI: long comment popup, cancel, multiline confirmation, enabled save, reorder and submitted SQL (simulated IPC).');
}finally{await browser?.close();await server.close();}
