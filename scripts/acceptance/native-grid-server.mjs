// Hosts the actual grid component; all database/clipboard IPC remains native.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const html=`<!doctype html><html><head><script>addEventListener("error",e=>window.__TAURI_INTERNALS__?.invoke("acceptance_progress",{message:"page error: "+e.message}));addEventListener("unhandledrejection",e=>window.__TAURI_INTERNALS__?.invoke("acceptance_progress",{message:"rejection: "+String(e.reason)}));</script></head><body><div id=grid></div><script type=module src="/__grid_entry.tsx"></script></body></html>`;
const entry=`import React from 'react';
import {createRoot} from 'react-dom/client';
import TableBrowser from '/src/components/DbTools/TableBrowser.tsx';
import '/src/index.css';
import {useToastStore} from '/src/stores/toastStore.ts';
window.gridToasts=()=>useToastStore.getState().toasts;
window.mountNativeGrid=()=>{window.gridRoot=createRoot(document.getElementById('grid'));window.gridRoot.render(React.createElement(TableBrowser,{connectionId:'native-export-disposable',connType:'mysql',schema:'dbterm_native_export',table:'grid_acceptance',embedded:true,active:true}))};`;
const server=await createServer({root,configFile:false,plugins:[react(),{name:'native-grid',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/',html))}else next()})},resolveId(id){if(id==='/__grid_entry.tsx')return '\0native-grid-entry.tsx'},load(id){if(id==='\0native-grid-entry.tsx')return entry}}],server:{host:'127.0.0.1',port:0}});
await server.listen();
process.stdout.write('GRID_URL=http://127.0.0.1:'+server.httpServer.address().port+'\n');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await server.close();process.exit(0)});
