// Isolated WKWebView acceptance. Requires grid fixture at 127.0.0.1:1437.
// Clipboard uses a native NSPasteboard bridge; database save and Tauri transport
// are simulated. This does not certify the real Tauri clipboard plugin.
// Restores saved pasteboard formats when no intervening clipboard change occurred.
import Cocoa
import WebKit

final class Probe: NSObject, WKScriptMessageHandler {
 let view: WKWebView
 let window: NSWindow
 let original: [[NSPasteboard.PasteboardType:Data]]
 var latestChange = -1
 var finished = false
 override init() {
  original = NSPasteboard.general.pasteboardItems?.map { item in
   var value: [NSPasteboard.PasteboardType:Data] = [:]
   for type in item.types { if let data = item.data(forType:type) { value[type] = data } }
   return value
  } ?? []
  let config = WKWebViewConfiguration()
  view = WKWebView(frame:NSRect(x:0,y:0,width:1200,height:800),configuration:config)
  window = NSWindow(contentRect:NSRect(x:100,y:100,width:1200,height:800),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
  super.init()
  config.userContentController.add(self,name:"nativeClipboard")
  window.contentView=view
  window.title="DBTerm isolated clipboard acceptance"
  window.makeKeyAndOrderFront(nil)
  view.load(URLRequest(url:URL(string:"http://127.0.0.1:1437/__grid")!))
  DispatchQueue.main.asyncAfter(deadline:.now()+2){self.start()}
  DispatchQueue.main.asyncAfter(deadline:.now()+25){self.finish(false,"native clipboard probe timed out")}
 }
 func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage) {
  guard let body=message.body as? [String:Any],let id=body["id"] as? String,let op=body["op"] as? String else{return}
  if op=="result" {finish(body["ok"] as? Bool ?? false,body["message"] as? String ?? "");return}
  var result:Any=NSNull()
  if op=="write" {
   NSPasteboard.general.clearContents()
   NSPasteboard.general.setString(body["text"] as? String ?? "",forType:.string)
   latestChange=NSPasteboard.general.changeCount
  } else if op=="read" {result=NSPasteboard.general.string(forType:.string) ?? NSNull() as Any}
  let data=try! JSONSerialization.data(withJSONObject:["id":id,"result":result])
  view.evaluateJavaScript("window.nativeReply("+String(data:data,encoding:.utf8)!+")",completionHandler:nil)
 }
 func start(){
 let js=#"""
 (async()=>{
 try{
 if(!window.fixture||!document.querySelector('.tb-table tbody tr'))throw Error('fixture not ready');
 const pending=new Map();let seq=0;
 window.nativeReply=({id,result})=>{pending.get(id)(result);pending.delete(id)};
 const call=(op,text)=>new Promise(resolve=>{const id=String(++seq);pending.set(id,resolve);webkit.messageHandlers.nativeClipboard.postMessage({id,op,text})});
 const original=window.__TAURI_INTERNALS__.invoke;
 window.__TAURI_INTERNALS__.invoke=(cmd,args)=>cmd==='plugin:clipboard-manager|write_text'?call('write',args.text):cmd==='plugin:clipboard-manager|read_text'?call('read'):original(cmd,args);
 const tick=()=>new Promise(resolve=>setTimeout(resolve,100));
 const select=async(row)=>{document.querySelectorAll('.tb-table tbody tr')[row].querySelectorAll('td')[2].dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,buttons:1}));document.dispatchEvent(new MouseEvent('mouseup',{button:0,buttons:0}));await tick()};
 const key=k=>document.querySelector('.tb-table-wrap').dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:k,metaKey:true}));
 await select(0);key('c');await tick();
 if(await call('read')!=='alpha')throw Error('native copy mismatch');
 await select(1);key('v');await tick();
 if(window.calls.some(c=>c.cmd==='update_cells'))throw Error('paste wrote before explicit save');
 const save=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='保存修改');
 if(!save)throw Error('paste did not stage');save.click();await tick();
 if(window.fixture[1][1]!=='alpha')throw Error('saved cell mismatch');
 webkit.messageHandlers.nativeClipboard.postMessage({id:'done',op:'result',ok:true,message:'WKWebView actual grid -> native macOS pasteboard -> staged paste -> explicit mocked save passed'});
 }catch(e){webkit.messageHandlers.nativeClipboard.postMessage({id:'done',op:'result',ok:false,message:String(e)})}
 })()
 """#
 view.evaluateJavaScript("void " + js){_,error in if let error=error{self.finish(false,String(describing:error))}}
 }
 func finish(_ ok:Bool,_ message:String){
  guard !finished else{return};finished=true
  if latestChange >= 0 && NSPasteboard.general.changeCount==latestChange {
   NSPasteboard.general.clearContents()
   let items=original.map{entry -> NSPasteboardItem in let item=NSPasteboardItem();for(type,data)in entry{item.setData(data,forType:type)};return item}
   if !items.isEmpty{NSPasteboard.general.writeObjects(items)}
  }
  print((ok ? "PASS " : "FAIL ")+message)
  fflush(stdout)
  exit(ok ? 0:1)
 }
}
let app=NSApplication.shared
app.setActivationPolicy(.accessory)
let probe=Probe()
app.run()
