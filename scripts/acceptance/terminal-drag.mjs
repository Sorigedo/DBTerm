// Isolated real-xterm fixture; no SSH connections or application user data.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.DBTERM_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const html = String.raw`<!doctype html><html><head><link rel="stylesheet" href="/node_modules/@xterm/xterm/css/xterm.css"></head>
<body><div id="terminal" style="width:800px;height:400px"></div>
<script type="module">
import { Terminal } from '/node_modules/@xterm/xterm/lib/xterm.mjs';
import { installTerminalDragRecovery } from '/src/components/Terminal/terminalDragRecovery.ts';
const terminal = new Terminal({cols:80,rows:20});
terminal.open(document.getElementById('terminal'));
await new Promise(resolve => terminal.write('abcdefghijklmnopqrstuvwxyz0123456789\r\nsecond line',resolve));
window.fixture={terminal,install(){this.dispose=installTerminalDragRecovery(terminal.element,document,window,()=>document.dispatchEvent(new MouseEvent('mouseup',{button:0,buttons:0})))}};
</script></body></html>`;
const server = await createServer({ root, configFile:false, server:{host:'127.0.0.1',port:0}, plugins:[{name:'terminal-acceptance',configureServer(s){s.middlewares.use('/__terminal_drag',(req,res)=>{res.setHeader('Content-Type','text/html');res.end(html)})}}] });
let browser;
try {
 await server.listen();
 const address=server.httpServer.address();
 browser=await chromium.launch({executablePath:process.env.DBTERM_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage(); const errors=[]; page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
 await page.goto(`http://127.0.0.1:${address.port}/__terminal_drag`);
 await page.waitForFunction(()=>window.fixture?.terminal);
 const down=()=>page.evaluate(()=>{const s=document.querySelector('.xterm-screen');const r=s.getBoundingClientRect();s.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,buttons:1,detail:1,clientX:r.left+10,clientY:r.top+8}))});
 const move=buttons=>page.evaluate(buttons=>{const r=document.querySelector('.xterm-screen').getBoundingClientRect();document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,button:0,buttons,clientX:r.left+170,clientY:r.top+8}))},buttons);
 const up=()=>page.evaluate(()=>document.dispatchEvent(new MouseEvent('mouseup',{button:0,buttons:0})));
 await down(); await move(0);
 assert.ok(await page.evaluate(()=>window.fixture.terminal.getSelection().length>0),'baseline must reproduce lost-release selection in actual xterm');
 await up(); await page.evaluate(()=>{window.fixture.terminal.clearSelection();window.fixture.install()});
 await down(); await move(0);
 assert.equal(await page.evaluate(()=>window.fixture.terminal.getSelection()),'','unpressed movement must stop selection before xterm handles it');
 await down(); await move(1);
 const selected=await page.evaluate(()=>window.fixture.terminal.getSelection());
 assert.ok(selected.length>0,'normal pressed drag must still select text');
 await up(); await move(0);
 assert.equal(await page.evaluate(()=>window.fixture.terminal.getSelection()),selected,'normal release must preserve selected text');
 await page.evaluate(()=>window.fixture.terminal.clearSelection()); await down();
 await page.evaluate(()=>window.dispatchEvent(new Event('blur'))); await move(0);
 assert.equal(await page.evaluate(()=>window.fixture.terminal.getSelection()),'','blur must end a tracked drag');
 await page.evaluate(()=>{window.fixture.dispose();window.fixture.terminal.dispose()});
 assert.deepEqual(errors,[]);
 console.log('PASS actual xterm: baseline reproduces lost-release selection; recovery stops unpressed movement; pressed drag, release and blur behave correctly');
} finally {await browser?.close();await server.close()}
