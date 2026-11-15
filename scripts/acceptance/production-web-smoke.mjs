// Built frontend only: temporary browser profile; no Tauri IPC or saved settings.
import assert from 'node:assert/strict';
import {preview} from 'vite';
const {chromium}=await import(process.env.DBTERM_PLAYWRIGHT_MODULE||'playwright');
const server=await preview({configFile:false,preview:{host:'127.0.0.1',port:0,strictPort:false}});
let browser;
try{
 browser=await chromium.launch({executablePath:process.env.DBTERM_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const context=await browser.newContext();
 const errors=[];const blocked=[];const failed=[];
 const port=server.httpServer.address().port;
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.hostname==='127.0.0.1'&&url.port===String(port))await route.continue();else {blocked.push(url.origin);await route.abort();}});
 await context.addInitScript(()=>{
   window.fixtureCalls=[];
   window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
   window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'isolated-preview'},currentWebview:{label:'isolated-preview'}},transformCallback:()=>1,invoke:async(command,args)=>{
     window.fixtureCalls.push(command);
     if(command==='plugin:event|listen')return 1;
     if(command==='plugin:event|unlisten')return;
     throw new Error('Isolated production fixture blocks native command: '+command);
   }};
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.stack||e.message));page.on('response',r=>{if(r.status()>=400)failed.push({url:r.url(),status:r.status()});});
 const response=await page.goto('http://127.0.0.1:'+port,{waitUntil:'networkidle'});
 assert.equal(response.status(),200);
 await page.waitForFunction(()=>document.getElementById('root')?.childElementCount>0);
 assert.ok((await page.locator('body').innerText()).trim().length>20,'built app must render visible content');
 assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);assert.deepEqual(blocked,[]);
 console.log('PASS production dist loads and renders in a fresh browser; no runtime errors, failed assets or external traffic; all native commands are simulated or rejected. Desktop installation and hardware remain untested.');
}finally{await browser?.close();await new Promise(resolve=>server.httpServer.close(resolve));}
