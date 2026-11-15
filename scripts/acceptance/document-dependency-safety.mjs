// Production document renderer functions; temporary browser; no native IPC.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import ts from 'typescript';
const {chromium}=await import(process.env.DBTERM_PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../../',import.meta.url));
const fixture=await mkdtemp(join(tmpdir(),'dbterm-tree-target-'));
const production=await readFile(join(root,'src/components/Tools/tools/DocumentTools.tsx'),'utf8');
const functions=production.slice(production.indexOf('const markdown ='),production.indexOf('type ConvertResult'));
const source="import MarkdownIt from 'markdown-it';\n"+functions+"\nwindow.renderFixture=async (source)=>await renderMermaidBlocks(markdown.render(source));";

const entry=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const html='<html><body><div id=root style="width:450px"></div><script type=module src=/__tree.tsx></script></body></html>';
const server=await createServer({root,configFile:false,cacheDir:join(fixture,'cache'),plugins:[react(),{name:'isolated-tree-target',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url==='/__tree'){res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__tree',html));}else next();});},resolveId(id){if(id==='/__tree.tsx')return '\0isolated-tree-target.tsx';},load(id){if(id==='\0isolated-tree-target.tsx')return entry;}}],server:{host:'127.0.0.1',port:0}});
let browser;
try {
 await server.listen();
 browser=await chromium.launch({executablePath:process.env.DBTERM_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__tree');
 await page.waitForFunction(()=>typeof window.renderFixture==='function',{},{timeout:5000}).catch(e=>{console.log(JSON.stringify(errors));throw e;});
 const result=await page.evaluate(async()=>{
   const plain=await window.renderFixture('# 标题\n\n<script>window.pwned=1</script>\n\n[危险](javascript:alert(1))\n\n**中文** https://example.com');
   const diagram=await window.renderFixture('\x60\x60\x60mermaid\ngraph TD; A[开始] --> B[完成]\n\x60\x60\x60');
   const fence=String.fromCharCode(96).repeat(3);
   const sources=[
     'sequenceDiagram\n participant A as 客户端\n participant B as 服务端\n A->>B: 查询\n B-->>A: 返回',
     'classDiagram\n class Connection {\n +connect()\n }',
     'erDiagram\n USER ||--o{ ORDER : owns',
     'stateDiagram-v2\n [*] --> Ready\n Ready --> Done',
     'graph LR; A["$$x^2+1$$"] --> B[完成]',
   ];
   const diagrams=[];
   for(const source of sources){const html=await window.renderFixture(fence+'mermaid\n'+source+'\n'+fence);const div=document.createElement('div');div.innerHTML=html;diagrams.push({svg:div.querySelectorAll('svg').length,error:!!div.querySelector('.is-error'),math:div.querySelectorAll('.katex').length});}
   const invalid=await window.renderFixture(fence+'mermaid\nnot_a_valid_diagram @@@\n'+fence);
   const holder=document.createElement('div');holder.innerHTML=plain+diagram;document.body.append(holder);
   return {plain,diagrams,fallback:invalid.includes('is-error')&&invalid.includes('not_a_valid_diagram'),svg:holder.querySelectorAll('svg').length,unsafe:holder.querySelectorAll('script,[onload],[onerror],a[href^="javascript:"]').length,pwned:window.pwned||0};
 });
 assert.ok(result.plain.includes('<h1>标题</h1>'));assert.ok(result.plain.includes('<strong>中文</strong>'));
 assert.ok(result.plain.includes('&lt;script&gt;'));assert.equal(result.svg,1);assert.equal(result.unsafe,0);assert.equal(result.pwned,0);assert.equal(result.fallback,true);assert.equal(result.diagrams.length,5);for(const diagram of result.diagrams){assert.equal(diagram.svg,1);assert.equal(diagram.error,false);}assert.ok(result.diagrams[4].math>0,'formula must use KaTeX');assert.deepEqual(errors,[]);
 console.log('PASS production Markdown/Mermaid rendering keeps flow, sequence, class, ER, state and KaTeX diagrams plus invalid-source fallback; raw HTML and javascript links stay inactive.');
}finally{await browser?.close();await server.close();await rm(fixture,{recursive:true,force:true});}
