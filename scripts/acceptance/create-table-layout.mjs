// Actual React and CSS in Chromium; simulated delayed IPC, no database writes.
import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {createServer} from "vite";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import react from "@vitejs/plugin-react";
const {chromium}=await import(process.env.DBTERM_PLAYWRIGHT_MODULE||"playwright");
const root=fileURLToPath(new URL("../../",import.meta.url));
const entry="import React from 'react';import {createRoot} from 'react-dom/client';import Wizard from '/src/components/DbTools/CreateTableWizard.tsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(Wizard,{connectionId:'fixture',connType:'mysql',schema:'test',editTable:'sample',onClose:()=>window.saveClosed=true,onDone:()=>window.saveDone=true}));";
const server=await createServer({root,configFile:false,plugins:[react(),{name:"layout-fixture",configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url==="/__layout"){res.setHeader("Content-Type","text/html");res.end(await s.transformIndexHtml("/__layout",'<html><body><div id=root></div><script type=module src=/__layout.tsx></script></body></html>'));}else next();});},resolveId(id){if(id==="/__layout.tsx")return "\0layout.tsx";},load(id){if(id==="\0layout.tsx")return entry;}}],server:{host:"127.0.0.1",port:0}});
let browser;
try {
 await server.listen();
 browser=await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
 page.on("pageerror",e=>errors.push(e.message));
 await page.addInitScript(()=>{
  const tick=String.fromCharCode(96), q=s=>tick+s+tick;
  window.metadataCalls=[];
  window.__TAURI_INTERNALS__={invoke:async(command,args={})=>{
   window.metadataCalls.push(command+":"+(args.sql||""));
   if(command==="get_table_ddl")return new Promise(resolve=>window.finishDdl=()=>resolve("CREATE TABLE "+q("sample")+" (\n  "+q("id")+" bigint NOT NULL,\n  "+q("title")+" varchar(64) NOT NULL DEFAULT '' COMMENT 'long comment',\n  "+q("file_size")+" int NOT NULL DEFAULT 0,\n  "+q("update_time")+" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n  PRIMARY KEY ("+q("id")+"),\n  UNIQUE KEY "+q("z_title")+" ("+q("title")+"),\n  KEY "+q("a_file")+" ("+q("file_size")+")\n) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci"));
   if(command==="db_data_dictionary")return new Promise(resolve=>window.finishIndexes=()=>resolve([{indexes:[]}]));
   if(command==="execute_query"){
    const sql=args.sql;
    if(sql.includes("information_schema.STATISTICS"))return new Promise(resolve=>window.finishIndexes=()=>resolve({rows:[["a_file","file_size","1","BTREE"],["PRIMARY","id","1","BTREE"],["z_title","title","0","BTREE"]]}));
    if(sql.includes("information_schema.COLUMNS"))return new Promise(resolve=>window.finishColumns=()=>resolve({rows:[["id","bigint","NO","PRI",null,"","",null],["title","varchar(64)","NO","","","","long comment","utf8mb4_0900_ai_ci"],["file_size","int","NO","","0","","",null],["update_time","datetime","NO","","CURRENT_TIMESTAMP","on update CURRENT_TIMESTAMP","",null]]}));
    if(sql.includes("information_schema.TABLES"))return {rows:[["InnoDB","utf8mb4_0900_ai_ci","Dynamic",null,""]]};
    if(sql.startsWith("SHOW COLLATION"))return {rows:[["utf8mb4_0900_ai_ci"],["utf8mb4_bin"]]};
    if(sql==="SHOW CHARACTER SET")return {rows:[["utf8mb4"]]};
    if(sql==="SHOW ENGINES")return {rows:[["InnoDB","DEFAULT"]]};
   }
   throw new Error("unexpected IPC "+command);
  }};
 });
 await page.goto("http://127.0.0.1:"+server.httpServer.address().port+"/__layout");
 await page.waitForFunction(()=>window.finishDdl);
 await page.waitForFunction(()=>window.finishColumns);
 const calls=await page.evaluate(()=>window.metadataCalls);
 assert.ok(calls.some(c=>c.includes("information_schema.STATISTICS")),"indexes start while columns are pending");
 assert.ok(calls.some(c=>c.includes("information_schema.TABLES")),"table options start while columns are pending");
 await page.evaluate(()=>window.finishColumns());
 await page.locator(".ctw-grid--row").first().waitFor({timeout:2000});
 assert.equal(await page.locator(".ctw-grid--row").count(),4,"fields must render without waiting for indexes or DDL");
 await page.locator(".ctw-grid--row").nth(1).locator("input").first().fill("renamed_title");
 await page.evaluate(()=>window.finishIndexes());
 await page.evaluate(()=>window.finishDdl());
 await page.waitForFunction(()=>[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="继承表默认"));
 await page.locator(".ctw-grid--row").first().waitFor();
 assert.equal(await page.locator(".ctw-grid--row").count(),4);
 assert.equal(await page.locator(".ctw-grid--row").nth(1).locator("input").first().inputValue(),"renamed_title","late DDL must preserve edits");
 assert.equal(await page.locator(".ctw-grid--row").nth(1).getByRole("button",{name:"继承表默认",exact:true}).count(),1);
 assert.equal(await page.locator(".ctw-inapplicable").count(),3);
 await page.locator(".ctw-tab").filter({hasText:"索引"}).click();
 assert.match(await page.locator(".ctw-tab.active").innerText(),/3/);
 assert.deepEqual(await page.locator(".ctw-grid--idx.ctw-grid--row").evaluateAll(rows=>rows.slice(1).map(row=>row.querySelector("input")?.value)),["z_title","a_file"]);
 await page.getByRole("button",{name:"字段",exact:true}).click();
 const modal=await page.locator(".ctw-modal").boundingBox();
 assert.ok(modal.width<=1182 && modal.height<=662,"modal stays compact on desktop");
 await page.locator(".ctw-grid--row").nth(1).locator("input").first().blur();
 await page.waitForTimeout(250); // Wait for the focus-border transition after blur.
 const borders=await page.locator(".ctw-grid--row").nth(1).evaluate(row=>[row.children[0],row.children[1].querySelector("button"),row.children[2],row.children[6].querySelector("input")].map(e=>{const c=getComputedStyle(e);return {color:c.borderTopColor,width:c.borderTopWidth};}));
 assert.ok(borders.every(b=>b.color===borders[1].color && b.width==="1px"),"editable inputs and dropdowns have matching borders");
 for(const width of [1440,1180,960]){
  await page.setViewportSize({width,height:1000});
  const layout=await page.evaluate(()=>{
   const header=[...document.querySelector(".ctw-grid--head").children].map(e=>e.getBoundingClientRect());
   return [...document.querySelectorAll(".ctw-grid--row")].map(row=>[...row.children].map((cell,i)=>{
    const r=cell.getBoundingClientRect(), br=cell.querySelector("button:not(.ctw-default-back)")?.getBoundingClientRect();
    return {i,left:r.left,header:header[i].left,width:r.width,buttonRight:br?.right,right:r.right};
   }));
  });
  for(const row of layout)for(const cell of row){
   assert.ok(Math.abs(cell.left-cell.header)<1,"header alignment at "+width+" column "+cell.i);
   if([1,5,7].includes(cell.i)&&cell.buttonRight)assert.ok(cell.buttonRight<=cell.right+1,"control overflow at "+width);
  }
  assert.equal(Math.round(layout[0][7].width),168);
 }
 const stamp=page.getByRole("button",{name:"CURRENT_TIMESTAMP ON UPDATE",exact:true});
 assert.equal(await stamp.getAttribute("title"),"CURRENT_TIMESTAMP ON UPDATE");
 await stamp.click();
 await page.waitForFunction(()=>[...document.querySelectorAll("button")].filter(b=>b.textContent.trim()==="CURRENT_TIMESTAMP ON UPDATE").length===2);
 assert.equal(await page.getByRole("button",{name:"CURRENT_TIMESTAMP ON UPDATE",exact:true}).count(),2);
 await page.keyboard.press("Escape");
 await page.setViewportSize({width:1440,height:1000});
 await page.screenshot({path:"/tmp/dbterm-create-table-layout.png",fullPage:true});

 if(process.env.DBTERM_MYSQL_SOCKET){
  const mysql=sql=>execFileSync("/opt/homebrew/bin/mysql",["--no-defaults","--socket="+process.env.DBTERM_MYSQL_SOCKET,"-uroot","--default-character-set=utf8mb4","--batch","--raw","dbterm_export_test"],{input:sql,encoding:"utf8"});
  const tick=String.fromCharCode(96), q=s=>tick+s+tick;
  const sourceDdl=readFileSync(root+"src-tauri/src/commands/fixtures/mc_pos_settlement_company.sql","utf8").replace(q("mc_pos_settlement_company"),q("sample"));
  mysql("DROP TABLE IF EXISTS sample; "+sourceDdl+"; ALTER TABLE sample MODIFY COLUMN plan_name varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'keep COLLATE latin1_bin'; INSERT INTO sample (plan_code,plan_name) VALUES ('probe','中文🙂');");
  for(const ignoreWrite of [true,false]){
   const savePage=await browser.newPage({viewport:{width:1440,height:1000}});
   await savePage.exposeFunction("dbInvoke",({command,args})=>{
    if(command==="get_table_ddl")return mysql("SHOW CREATE TABLE sample").split("\n").slice(1).join("\n").split("\t").slice(1).join("\t").trimEnd();
    if(command!=="execute_query")throw new Error(command);
    if(ignoreWrite&&args.sql.startsWith("ALTER TABLE"))return {rows:[]};
    const result=mysql(args.sql.replaceAll("TABLE_SCHEMA='test'","TABLE_SCHEMA='dbterm_export_test'").replaceAll(q("test")+".",q("dbterm_export_test")+"."));
    return {rows:result.trimEnd().split("\n").slice(1).map(line=>line.split("\t").map(v=>v==="NULL"?null:v))};
   });
   await savePage.addInitScript(()=>window.__TAURI_INTERNALS__={invoke:(command,args)=>window.dbInvoke({command,args})});
   await savePage.goto("http://127.0.0.1:"+server.httpServer.address().port+"/__layout");
   const row=savePage.locator(".ctw-grid--row").nth(1);
   await row.getByRole("button",{name:"utf8mb4_unicode_ci",exact:true}).waitFor();
   await row.getByRole("button",{name:"utf8mb4_unicode_ci",exact:true}).click();
   await savePage.waitForFunction(()=>[...document.querySelectorAll("button")].filter(b=>b.textContent.trim()==="utf8mb4_unicode_ci").length===2);
   await savePage.getByRole("button",{name:"继承表默认",exact:true}).last().click();
   if(await savePage.getByRole("button",{name:"保存修改",exact:true}).isDisabled()){
    await savePage.getByRole("button",{name:"SQL 预览",exact:true}).click();
    console.log(await savePage.locator(".ctw-body").innerText());
   }
   await savePage.getByRole("button",{name:"保存修改",exact:true}).click({timeout:3000});
   if(ignoreWrite){
    await savePage.getByText(/未达到预期/).waitFor();
    assert.equal(await savePage.evaluate(()=>!!window.saveDone),false,"unchanged server DDL must never report saved");
   }else{
    await savePage.waitForFunction(()=>window.saveDone&&window.saveClosed);
    const result=mysql("SHOW CREATE TABLE sample");
    assert.ok(!result.includes("CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"),"explicit field clauses must be gone");
    assert.ok(result.includes("keep COLLATE latin1_bin"),"comment preserved");
    assert.ok(result.includes("uk_pos_settlement_plan_code"),"functional unique index preserved");
    assert.match(mysql("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sample'"),/13/);
    assert.match(mysql("SELECT plan_name,COLLATION(plan_name) FROM sample"),/中文🙂\tutf8mb4_0900_ai_ci/);
    await savePage.reload();
    await savePage.locator(".ctw-grid--row").nth(1).getByRole("button",{name:"继承表默认",exact:true}).waitFor();
   }
   await savePage.close();
  }
  mysql("DROP TABLE sample");
  console.log("PASS real MySQL: UI select -> save ALTER -> readback -> reopen; preserved Unicode/comment; rejected no-op server response.");
 }
 assert.deepEqual(errors,[]);
 console.log("PASS delayed metadata, fields render before indexes/DDL, late DDL preserves edits, stable inherited values, grid alignment and overflow at 1440/1180/960px, fixed 168px collation, complete hover/dropdown labels, inapplicable numeric/date fields. Simulated IPC only.");
} finally {await browser?.close();await server.close();}
