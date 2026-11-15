// Actual SQL editor; synthetic results, simulated IPC, disposable Chrome profile.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer,build,preview} from 'vite';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import react from '@vitejs/plugin-react';
const {chromium}=await import(process.env.DBTERM_PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../../',import.meta.url));
const entry="import React from 'react';import {createRoot} from 'react-dom/client';import Editor from '/src/components/SqlEditor/index.tsx';import {useAppStore} from '/src/stores/appStore.ts';import '/src/index.css';useAppStore.setState({connections:[{id:'fixture',name:'fixture',type:'sqlite',filePath:':memory:',useSsl:false,createdAt:0,updatedAt:0}],tabs:[{id:'query-fixture',connectionId:'fixture',type:'query',title:'test',meta:{schema:'main'}}],activeTabId:'query-fixture',activeAId:'query-fixture'});window.runFixture=(sql='SELECT payload FROM fixture_result')=>useAppStore.setState({pendingRun:{'query-fixture':sql}});const editorRoot=createRoot(document.getElementById('root'));window.closeFixture=()=>editorRoot.unmount();editorRoot.render(React.createElement(Editor,{tabId:'query-fixture',connectionId:'fixture',connType:'sqlite'}));";
const html='<html><body><div id=root style="height:900px"></div><script type=module src=/__memory.tsx></script></body></html>';
const production=process.env.DBTERM_MEMORY_PRODUCTION==='1';
const fixture=await mkdtemp(join(tmpdir(),'dbterm-editor-memory-'));
const plugin={name:'isolated-editor-memory',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url==='/__memory'){res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__memory',html));}else next();});},resolveId(id){if(id==='/__memory.tsx')return '\0isolated-memory.tsx';},load(id){if(id==='\0isolated-memory.tsx')return entry;}};
if(production){
 const output=await build({root,configFile:false,plugins:[react(),plugin],build:{outDir:fixture,minify:false,rollupOptions:{input:'/__memory.tsx',output:{entryFileNames:'entry.js'}}},logLevel:'error'});
 const css=output.output.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css')).map(item=>'<link rel="stylesheet" href="/'+item.fileName+'">').join('');
 await writeFile(join(fixture,'index.html'),html.replace('src=/__memory.tsx','src=/entry.js').replace('</head>',css+'</head>').replace('<body>',css+'<body>'));
}
const server=production?await preview({root,configFile:false,build:{outDir:fixture},preview:{host:'127.0.0.1',port:0}}):await createServer({root,configFile:false,cacheDir:join(fixture,'cache'),plugins:[react(),plugin],server:{host:'127.0.0.1',port:0}});
let browser;
try {
 if(!production)await server.listen();
 browser=await chromium.launch({executablePath:process.env.DBTERM_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.unexpected=[];window.results=[];window.rowArrays=[];window.executed=[];
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'fixture'},currentWebview:{label:'fixture'}},invoke:async(command,args={})=>{
   if(command==='plugin:window|set_theme')return;
   if(command==='db_tx_status')return false;
   if(['list_tables','list_routines','table_columns'].includes(command))return [];
   if(command==='schema_columns')return {};
   if(command==='plugin:path|resolve_directory')return '/tmp/isolated-export';
   if(command==='execute_query'){
    window.executed.push(args.sql);
    const result={auditResultMarker:'dbterm_synthetic_result_'+window.results.length,columns:['payload'],rows:Array.from({length:2000},(_,i)=>[(args.sql.includes('second_result')?'second:':'first:')+i+':'+('payload_'+i).repeat(256)]),rowsAffected:0,executionTimeMs:1,isSelect:true,truncated:false};
    window.results.push(new WeakRef(result));window.rowArrays.push(new WeakRef(result.rows));return result;
   }
   if(command==='plugin:event|listen')return 1;
   if(command==='plugin:event|unlisten')return;
   window.unexpected.push(command);throw new Error('unexpected isolated IPC '+command);
  }};
 });
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+(production?'/index.html':'/__memory'));
 await page.waitForFunction(()=>typeof window.runFixture==='function');
 const session=await page.context().newCDPSession(page);
 const heaps=[];
 for(let cycle=0;cycle<12;cycle++){
  await page.evaluate(()=>window.runFixture());
  const close=page.locator('[data-tip="关闭结果区并释放结果（再次执行自动打开）"]');
  await close.waitFor();await page.waitForFunction(()=>!document.querySelector('[data-tip="关闭结果区并释放结果（再次执行自动打开）"]').disabled);
  assert.ok((await page.locator('.result-table').innerText()).includes('first:'),'each query must render its returned rows before close');
  await close.click();
  for(let n=0;n<4;n++){await session.send('HeapProfiler.collectGarbage');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));}
  heaps.push((await session.send('Runtime.getHeapUsage')).usedSize);
 }
 await page.evaluate(()=>window.runFixture('SELECT payload FROM first_result; SELECT payload FROM second_result;'));
 await page.waitForFunction(()=>window.executed.length===14);
 const close=page.locator('[data-tip="关闭结果区并释放结果（再次执行自动打开）"]');
 await page.waitForFunction(()=>!document.querySelector('[data-tip="关闭结果区并释放结果（再次执行自动打开）"]').disabled);
 await page.getByRole('button',{name:'结果2',exact:true}).click();
 assert.ok((await page.locator('.result-table').innerText()).includes('second:'),'second tab must show second query data');
 await page.locator('[data-tip="导出（有选中则导出选中 SQL，否则整页；流式支持大结果集）"]').click();
 await page.getByRole('button',{name:'CSV（极速，逗号分隔）',exact:true}).click();
 await page.getByText('Excel（.xlsx）',{exact:true}).click();
 await page.getByText('将按 2 个查询结果写入独立 Sheet',{exact:false}).waitFor();
 await page.locator('[data-tip="关闭"]').click();
 await page.keyboard.press('F5');
 await page.waitForFunction(()=>window.executed.length===15);
 assert.ok((await page.evaluate(()=>window.executed.at(-1))).includes('second_result'),'refresh must use active result SQL');
 await page.waitForFunction(()=>!document.querySelector('[data-tip="关闭结果区并释放结果（再次执行自动打开）"]').disabled);
 await close.click();
 for(let n=0;n<4;n++){await session.send('HeapProfiler.collectGarbage');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));}
 const retained=await page.evaluate(()=>window.results.map(result=>result.deref()!==undefined));
 const retainedRowArrays=await page.evaluate(()=>window.rowArrays.map(rows=>rows.deref()!==undefined));
 if(process.env.DBTERM_MEMORY_SNAPSHOT){let chunks='';const receive=event=>{chunks+=event.chunk;};session.on('HeapProfiler.addHeapSnapshotChunk',receive);await session.send('HeapProfiler.takeHeapSnapshot',{reportProgress:false});session.off('HeapProfiler.addHeapSnapshotChunk',receive);await writeFile(process.env.DBTERM_MEMORY_SNAPSHOT,chunks);}
 if(production){assert.ok(retained.every(alive=>!alive),'production result close must release every result object');assert.ok(retainedRowArrays.every(alive=>!alive),'production result close must release every row array');}
 await page.evaluate(()=>window.closeFixture());
 for(let n=0;n<4;n++){await session.send('HeapProfiler.collectGarbage');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));}
 const retainedAfterUnmount=await page.evaluate(()=>window.results.map(result=>result.deref()!==undefined));
 console.log(JSON.stringify({production,cycles:heaps.length,usedHeapAfterClose:heaps,retainedResultObjects:retained,retainedRowArrays,retainedAfterUnmount,usedHeapAfterUnmount:(await session.send('Runtime.getHeapUsage')).usedSize,unexpectedIpc:await page.evaluate(()=>window.unexpected),errors}));
 assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.unexpected),[]);assert.ok(retained.filter(Boolean).length<=1,'more than one result retained across cycles');assert.ok(retainedAfterUnmount.every(alive=>!alive),'unmounted editor must release every result');
 console.log('PASS actual SQL editor: 12 query-close cycles, multi-result switching, two-sheet export selection, active-result refresh and result release; synthetic IPC only, no file export or desktop RSS assertion.');
}finally{await browser?.close();if(production)await new Promise(resolve=>server.httpServer.close(resolve));else await server.close();if(fixture)await rm(fixture,{recursive:true,force:true});}
