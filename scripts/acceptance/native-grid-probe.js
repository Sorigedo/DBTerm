(async()=>{
 const cfg=CONFIG, raw=window.__TAURI_INTERNALS__.invoke;
 const checks=[];let saves=0;
 const tick=()=>new Promise(r=>setTimeout(r,60));
 const wait=async(fn,label)=>{for(let i=0;i<150;i++){if(await fn())return;await tick()}throw Error('timeout: '+label)};
 const query=sql=>raw('execute_query',{id:'native-export-disposable',database:cfg.db,sql});
 const values=async()=>JSON.stringify((await query('SELECT id,a,b FROM grid_acceptance ORDER BY id')).rows);
 const select=async(row,col,shift=false)=>{
   document.querySelectorAll('.tb-table tbody tr[data-ri]')[row].querySelectorAll('td')[col+1].dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,buttons:1,shiftKey:shift}));
   window.dispatchEvent(new MouseEvent('mouseup',{button:0,buttons:0}));await tick();
 };
 const key=k=>document.querySelector('.tb-table-wrap').dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:k,metaKey:true}));
 const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
 const save=async()=>{button('保存修改').click();await wait(()=>!button('保存修改'),'save complete');saves++};
 try{
   await raw("acceptance_progress",{message:"probe started, mount="+typeof window.mountNativeGrid});
   await wait(()=>window.mountNativeGrid,'component module');window.mountNativeGrid();await raw('acceptance_progress',{message:'component mounted'});
   await wait(()=>document.querySelectorAll('.tb-table tbody tr[data-ri]').length===3,'rows');
   await tick();await tick();
   await raw('acceptance_progress',{message:'rows loaded'});const before=await values();
   await select(0,1);key('c');
   await wait(async()=>await raw('plugin:clipboard-manager|read_text')==='alpha','native copy alpha');
   await select(1,1);key('v');await wait(()=>button('保存修改'),'single paste staged');
   if(await values()!==before)throw Error('paste wrote before explicit save');
   await save();
   if(await values()!==JSON.stringify([['1','alpha','one'],['2','alpha','two'],['3','gamma','three']]))throw Error('single save mismatch');
   checks.push('原组件单格复制→真实插件→暂存→显式保存→实库值一致');
   document.querySelector('[aria-label="选择 a 列"]').click();await tick();
   document.querySelector('[aria-label="选择 b 列"]').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}));await tick();key('c');
   const expected='alpha\tone\nalpha\ttwo\ngamma\tthree';
   await wait(async()=>await raw('plugin:clipboard-manager|read_text')===expected,'column copy');
   await raw('plugin:clipboard-manager|write_text',{text:'grid-fill-acceptance'});
   const unchanged=await values();key('v');await wait(()=>button('保存修改'),'columns staged');
   if(await values()!==unchanged)throw Error('column paste wrote early');await save();
   if(await values()!==JSON.stringify([['1','grid-fill-acceptance','grid-fill-acceptance'],['2','grid-fill-acceptance','grid-fill-acceptance'],['3','grid-fill-acceptance','grid-fill-acceptance']]))throw Error('column fill mismatch');
   checks.push('Shift连续两列复制与六格填充保存一致');
   await select(0,1);await select(1,2,true);
   await raw('plugin:clipboard-manager|write_text',{text:'A1\tB1\nA2\tB2'});key('v');
   await wait(()=>button('保存修改'),'rectangle staged');await save();
   if(await values()!==JSON.stringify([['1','A1','B1'],['2','A2','B2'],['3','grid-fill-acceptance','grid-fill-acceptance']]))throw Error('rectangle save mismatch');
   checks.push('连续矩形选区二维粘贴逐格保存一致');
   await raw('acceptance_result',{result:{ok:true,checks,saveCalls:saves}});
 }catch(error){await raw('acceptance_result',{result:{ok:false,checks,error:String(error),toasts:window.gridToasts?.()}})}
})()
