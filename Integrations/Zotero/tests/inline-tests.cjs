const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const adapter = require('../content/inline.js');
const DOM = require('./fake-dom.cjs');
let checks = 0;
const watchdog=setTimeout(()=>{process.stderr.write('PDF inline suite stalled before its completion marker\n');process.exitCode=1;},10000);
async function check(name, fn) { await fn(); checks++; process.stdout.write(`PASS ${name}\n`); }
function deferred() { let resolve; const promise = new Promise(a => { resolve = a; }); return {promise, resolve}; }
function bytes(value = '%PDF-1.7\nsynthetic\n') { return new TextEncoder().encode(value); }
function json(value, status = 200) { return {status, responseText: JSON.stringify(value)}; }
const job = (state = 'complete', pages = [1]) => ({id:'job_fixture-1', state, sourcePages: pages, pageCount: 3});
function transportFixture(request) {
 const requests=[], fixtureFile={path:'/fixture/Home',permissions:0o600,fileSize:240,clone(){return {...this};},append(part){this.path+='/'+part;},exists:()=>true,isFile:()=>true,isSymlink:()=>false};
 const deps={Services:{dirsvc:{get:()=>fixtureFile}},Components:{interfaces:{nsIFile:{}},utils:{cloneInto:value=>value}}, readText:async()=>JSON.stringify({version:1,endpoint:'http://127.0.0.1:43792',token:'t'.repeat(64)}), Zotero:{HTTP:{async request(method,url,options){requests.push({method,url,options});return request(method,url,options);}}}, setTimer:fn=>setTimeout(fn,0),clearTimer:clearTimeout};
 return {deps,requests,file:fixtureFile};
}
(async()=>{
 await check('production adapter exposes only real PDF job path',()=>{
  assert.equal(typeof adapter.createPDFTransport,'function','PDF full translation must use the PDF job transport');
  assert.equal(typeof adapter.mountPDFView,'function');
  assert.equal(adapter.mountReflow,undefined,'pure text PDF reflow must be removed');
 });
 await check('current-page request uploads exact open PDF bytes with local auth and explicit direction',async()=>{
  const source=bytes(); const f=transportFixture(async(method,url)=>url.endsWith('/mono.pdf')?{status:200,response:source.buffer}:json(job()));
  const t=adapter.createPDFTransport(f.deps); const result=await t.start(source,{pages:'2',source:'en',target:'zh-Hans'},()=>{});
  assert.equal(result.state,'complete'); assert.deepEqual(result.sourcePages,[1]);
  const req=f.requests[0]; assert.equal(req.method,'POST'); assert.equal(req.url,'http://127.0.0.1:43795/v1/pdf/jobs');
  assert.deepEqual(new Uint8Array(req.options.body),source); assert.equal(req.options.headers['Content-Type'],'application/pdf');
  assert.equal(req.options.headers.Authorization,'Bearer '+'t'.repeat(64)); assert.equal(req.options.headers['X-AskGPT-Pages'],'2');
  assert.equal(req.options.headers['X-AskGPT-Source'],'en');assert.equal(req.options.headers['X-AskGPT-Target'],'zh-Hans');
  assert.equal(req.options.headers.Origin,undefined);assert.equal(req.options.followRedirects,false);assert.equal(req.options.debug,false);
  assert.equal(req.options.logBodyLength,0);
  const output=await t.output(result.id,'mono');assert.deepEqual(new Uint8Array(output),source);
 });
 await check('whole PDF waits for ready and uses all without paragraph extraction',async()=>{
  let polls=0;const f=transportFixture(async(method,url)=>method==='POST'?json(job('running',[0,1,2]),202):json(job(++polls===1?'running':'complete',[0,1,2])));
  const result=await adapter.createPDFTransport(f.deps).start(bytes(),{pages:'all',source:'zh-Hans',target:'en'},()=>{});
  assert.equal(result.state,'complete');assert.equal(polls,2);assert.equal(f.requests[0].options.headers['X-AskGPT-Pages'],'all');
  assert(f.requests.every(r=>r.url.startsWith('http://127.0.0.1:43795/v1/pdf/jobs')));
 });
 await check('cancellation after late create deletes only its own job',async()=>{
  const entered=deferred(),late=deferred();const f=transportFixture(async(method)=>{if(method==='POST'){entered.resolve();return late.promise;}return {status:200,responseText:'{}'};});
  let cancel;const pending=adapter.createPDFTransport(f.deps).start(bytes(),{pages:'1',source:'en',target:'zh-Hans'},value=>{cancel=value;});
  await entered.promise;cancel();late.resolve(json(job('running',[0]),202));await assert.rejects(pending,{code:'stopped'});
  await new Promise(setImmediate);assert.equal(f.requests.filter(r=>r.method==='DELETE').length,1);
  assert.equal(f.requests.find(r=>r.method==='DELETE').url,'http://127.0.0.1:43795/v1/pdf/jobs/job_fixture-1');
 });
 await check('cancellation waits for a delayed DELETE before retirement resolves',async()=>{
  const entered=deferred(),finish=deferred();let cancel,retired=false;
  const f=transportFixture(async(method)=>{if(method==='POST')return json(job('running',[0]),202);if(method==='DELETE'){entered.resolve();return finish.promise;}return json(job('running',[0]));});
  const pending=adapter.createPDFTransport(f.deps).start(bytes(),{pages:'1',source:'en',target:'zh-Hans'},value=>{cancel=value;});
  const stopped=assert.rejects(pending,{code:'stopped'});await settle(()=>f.requests.length>0);const retiring=Promise.resolve(cancel()).then(()=>{retired=true;});await entered.promise;await new Promise(setImmediate);
  assert.equal(retired,false,'retirement must wait for DELETE');finish.resolve({status:204});await retiring;await stopped;
 });
 await check('untrusted job IDs and mismatched output are rejected before URL construction',async()=>{
  const f=transportFixture(async()=>json({...job(),id:'../escape'}));const t=adapter.createPDFTransport(f.deps);
  await assert.rejects(t.start(bytes(),{pages:'1',source:'en',target:'zh-Hans'},()=>{}),{code:'response'});
  await assert.rejects(t.output('../escape','mono'),{code:'response'});await assert.rejects(t.output('safe','other'),{code:'response'});
  assert.equal(f.requests.length,1);
 });
 await check('runtime, invalid PDF and direction errors have short fixed messages',async()=>{
  const f=transportFixture(async()=>json({...job('failed',[0]),error:'runtime_missing'}));const t=adapter.createPDFTransport(f.deps);
  await assert.rejects(t.start(bytes(),{pages:'1',source:'en',target:'zh-Hans'},()=>{}),{code:'runtime_missing'});
  await assert.rejects(t.start(bytes('not PDF'),{pages:'1',source:'en',target:'zh-Hans'},()=>{}),{code:'pdf'});
  await assert.rejects(t.start(bytes(),{pages:'1',source:'en',target:'fr'},()=>{}),{code:'direction'});
  assert(!adapter.pdfErrorMessage({code:'runtime_missing'}).includes('undefined'));
 });
 await check('owner-only connection checks prevent any PDF request when connection file is unsafe',async()=>{
  const f=transportFixture(async()=>{throw Error('must not request');});f.file.permissions=0o644;
  await assert.rejects(adapter.createPDFTransport(f.deps).start(bytes(),{pages:'1',source:'en',target:'zh-Hans'},()=>{}),{code:'permissions'});assert.equal(f.requests.length,0);
 });
 function layoutFixture({count=1,loading=null,renderFailure=false}={}) {
  const {win,viewer}=DOM.pdfWindow(), outputReads=[],renders=[],destroyed=[],textRenders=[];
  viewer.style.setProperty('visibility','visible','important');
  const originalCreate=DOM.Document.prototype.createElementNS;
  DOM.Document.prototype.createElementNS=function(ns,name){const n=originalCreate.call(this,ns,name);if(name==='canvas'){n.width=0;n.height=0;n.getContext=()=>({canvas:n});}return n;};
  const output={numPages:count,destroy(){destroyed.push('output');},async getPage(number){outputReads.push(number);return {getViewport({scale}){return {width:600*scale,height:800*scale,scale};},render(options){renders.push(options);return {promise:renderFailure?Promise.reject(Error('render failed')):Promise.resolve(),cancel(){}};},getTextContent:async()=>({items:[{str:'可选择译文'}]})};}};
  win.pdfjsLib={PDFWorker:class {destroy(){destroyed.push('worker');}},getDocument(options){assert.equal(options.isEvalSupported,false);assert(options.worker,'output uses a dedicated worker');assert.equal(options.ownerDocument.URL,'about:srcdoc');return {promise:loading?loading.promise:Promise.resolve(output),destroy(){destroyed.push('loading');}};},TextLayer:class {constructor(options){this.options=options;}render(){textRenders.push(this.options);return Promise.resolve();}cancel(){}}};
  const source={untouched:true};win.PDFViewerApplication={pdfDocument:source,pdfViewer:{currentPageNumber:2,pagesCount:3}};
  return {win,viewer,source,output,outputReads,renders,destroyed,textRenders,context:{win,viewer:win.PDFViewerApplication.pdfViewer},restore(){DOM.Document.prototype.createElementNS=originalCreate;}};
 }
 await check('translated PDF renders original PDF graphics through PDF.js without replacing original document',async()=>{
  const f=layoutFixture();const layer=await adapter.mountPDFView(f.context,'',{},{});
  assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');
  await layer.showOutput(bytes(),[1],'mono');
  assert.equal(layer.visible,true);assert.equal(f.viewer.style.getPropertyValue('visibility'),'hidden');
  assert.equal(f.win.PDFViewerApplication.pdfDocument,f.source);assert.equal(f.win.PDFViewerApplication.pdfViewer.currentPageNumber,2);
  assert.equal(f.renders.length,1);assert.equal(f.textRenders.length,1);assert.equal(f.textRenders[0].viewport,f.renders[0].viewport,'do not clone away PageViewport methods');assert.equal(layer.body.getAttribute('data-mode'),'mono');
  assert.equal(layer.body.children[0].getAttribute('data-source-page'),'1');
  assert.equal(layer.body.children[0].children[0].tagName,'canvas');assert.equal(layer.body.children[0].children[1].className,'textLayer');
  assert(!layer.doc.body.textContent.includes('等待'));layer.dispose();
  assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');assert.equal(f.viewer.style.getPropertyPriority('visibility'),'important');
  assert.equal(f.viewer.scrollTop,160);assert.equal(f.viewer.scrollLeft,20);assert.equal(f.win.PDFViewerApplication.pdfDocument,f.source);f.restore();
 });
 await check('switching PDF output restores original while new PDF loads and rejects mismatched page mapping',async()=>{
  const f=layoutFixture(),layer=await adapter.mountPDFView(f.context,'',{},{});await layer.showOutput(bytes(),[1],'mono');
  const late=deferred();f.win.pdfjsLib.getDocument=()=>({promise:late.promise,destroy(){}});
  const pending=layer.showOutput(bytes(),[1],'dual');assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible','keep original readable while fetching another PDF');
  late.resolve(f.output);await pending;assert.equal(layer.body.getAttribute('data-mode'),'dual');
  await assert.rejects(layer.showOutput(bytes(),[0,1],'mono'),{code:'response'});assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');layer.dispose();f.restore();
 });
 await check('PDF viewer provides zoom and fit-width without reloading the PDF or changing source',async()=>{
  const f=layoutFixture(),layer=await adapter.mountPDFView(f.context,'',{},{});await layer.showOutput(bytes(),[1],'mono');
  const originalWidth=f.renders[0].viewport.width;
  const plus=layer.doc.body.allNodes().find(n=>n.getAttribute('title')==='Zoom in · 放大');assert(plus,'PDF has its own zoom control');plus.emit('click');await settle(()=>f.renders.length===2);
  assert(f.renders[1].viewport.width>originalWidth);const fit=layer.doc.body.allNodes().find(n=>n.getAttribute('title')==='Fit width · 适合宽度');assert(fit);fit.emit('click');await settle(()=>f.renders.length===3);
  assert.equal(f.renders[2].viewport.width,originalWidth);assert.equal(f.win.PDFViewerApplication.pdfDocument,f.source);layer.dispose();f.restore();
 });
 await check('whole PDF creates page placeholders but renders only needed page, not 2000 canvases',async()=>{
  const f=layoutFixture({count:2000}),layer=await adapter.mountPDFView(f.context,'',{},{});
  await layer.showOutput(bytes(),Array.from({length:2000},(_,i)=>i),'mono');
  assert.equal(layer.body.children.length,2000);assert.deepEqual(f.outputReads,[2]);assert.equal(f.renders.length,1);layer.dispose();f.restore();
 });
 await check('PDF render failure leaves original visible and reports a short fixed error',async()=>{
  const f=layoutFixture({renderFailure:true}),failures=[];const layer=await adapter.mountPDFView(f.context,'',{failure:e=>failures.push(e)},{});
  await layer.showOutput(bytes(),[1],'mono');assert.equal(layer.visible,false);assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');assert.equal(failures.length,1);layer.dispose();f.restore();
 });
 await check('disposing pending PDF output rejects late load and never hides original',async()=>{
  const late=deferred(),f=layoutFixture({loading:late}),layer=await adapter.mountPDFView(f.context,'',{},{});
  const pending=layer.showOutput(bytes(),[1],'mono');layer.dispose();late.resolve(f.output);await pending;
  assert.equal(layer.frame.parentNode,null);assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');assert.equal(f.renders.length,0);assert(f.destroyed.includes('output'));f.restore();
 });
 async function settle(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('PDF fixture did not settle');}
 function controllerFixture(request){
  const transport=transportFixture(request),layout=layoutFixture(),main=new DOM.Window(),events=new Map(),readerEvents=new Map(),reads=[],diagnostics=[];
  main.Zotero_Tabs={selectedID:'public-fixture'};
  const pdf={async getData(){reads.push('data');return bytes();},async getPageData(){throw Error('pure-text extraction must never run');}};
  const application=layout.win.PDFViewerApplication;application.pdfDocument=pdf;application.eventBus={on(name,fn){events.set(name,fn);},off(name,fn){if(events.get(name)===fn)events.delete(name);}};
  const reader={type:'pdf',tabID:'public-fixture',_window:main,_iframeWindow:new DOM.Window(),_internalReader:{_primaryView:{_iframeWindow:layout.win}}};
  let unregister=0;const alerts=[];
  const deps={...transport.deps,css:'',pluginID:'fixture',reportDiagnostic:(stage,error)=>diagnostics.push({stage,error}),Services:{...transport.deps.Services,prompt:{alert:(...args)=>alerts.push(args)}},Zotero:{...transport.deps.Zotero,getMainWindow:()=>main,getMainWindows:()=>[main],Reader:{_readers:[reader],getByTabID:()=>reader,registerEventListener(type,callback){readerEvents.set(type,callback);},_unregisterEventListenerByPluginID(){unregister++;readerEvents.clear();}},Notifier:{registerObserver:()=>1,unregisterObserver(){}}}};
  const plugin=adapter.create(deps);return {...layout,transport,plugin,reader,events,readerEvents,reads,pdf,alerts,diagnostics,get unregister(){return unregister;}};
 }
 await check('PDF identity replaced during getData releases busy state without uploading the stale source',async()=>{
  const entered=deferred(),ready=deferred(),f=controllerFixture(async()=>{throw Error('stale source must not be uploaded');});
  f.pdf.getData=async()=>{entered.resolve();return ready.promise;};f.plugin.start();await f.plugin.toggle(f.reader);await entered.promise;
  f.win.PDFViewerApplication.pdfDocument={getData:async()=>bytes(),getPageData:async()=>[]};ready.resolve(bytes());await settle(()=>!f.plugin.state(f.reader).busy);
  assert.equal(f.plugin.state(f.reader).open,false);assert.equal(f.transport.requests.length,0);assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');
  assert(!f.win.document.body.children.some(n=>n.tagName==='iframe'));f.plugin.shutdown();f.restore();
 });
 await check('PDF identity replaced during a running job retires old output and releases native controls',async()=>{
  const entered=deferred(),ready=deferred(),f=controllerFixture(async(method,url)=>{if(method==='POST'){entered.resolve();return ready.promise;}return {status:204};});
  f.plugin.start();await f.plugin.toggle(f.reader);await entered.promise;f.win.PDFViewerApplication.pdfDocument={getData:async()=>bytes(),getPageData:async()=>[]};ready.resolve(json(job()));
  await settle(()=>!f.plugin.state(f.reader).busy);await settle(()=>f.transport.requests.some(r=>r.method==='DELETE'));
  assert.equal(f.plugin.state(f.reader).open,false);assert.equal(f.renders.length,0);assert(!f.transport.requests.some(r=>r.url.endsWith('.pdf')));
  f.plugin.shutdown();f.restore();
 });
 await check('a stale source completion does not close the replacement translation session',async()=>{
  const entered=deferred(),ready=deferred(),f=controllerFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()));
  f.pdf.getData=async()=>{entered.resolve();return ready.promise;};f.plugin.start();await f.plugin.toggle(f.reader);await entered.promise;
  f.plugin.restore(f.reader);f.win.PDFViewerApplication.pdfDocument={getData:async()=>bytes(),getPageData:async()=>[]};await f.plugin.toggle(f.reader);
  await settle(()=>f.viewer.style.getPropertyValue('visibility')==='hidden');ready.resolve(bytes());await new Promise(setImmediate);
  assert.equal(f.plugin.state(f.reader).open,true);assert.equal(f.viewer.style.getPropertyValue('visibility'),'hidden');assert.equal(f.transport.requests.filter(r=>r.method==='POST').length,1);
  f.plugin.shutdown();f.restore();
 });
 await check('controller stage diagnostics are fixed markers without source or connection contents',async()=>{
  const f=controllerFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()));f.plugin.start();await f.plugin.toggle(f.reader);
  await settle(()=>!f.plugin.state(f.reader).busy);
  const stages=['startBegin','retired','jobReady','outputBegin','outputReady'];
  assert.deepEqual(f.diagnostics.filter(x=>stages.includes(x.stage)).map(x=>x.stage),stages);
  for(const item of f.diagnostics.filter(x=>stages.includes(x.stage)))assert.equal(item.error,undefined);
  f.plugin.shutdown();f.restore();
 });
 await check('real backend page progress reaches native state and clears after output loads',async()=>{
  const entered=deferred(),ready=deferred(),observed=[];let polls=0;
  const f=controllerFixture(async(method,url)=>{
   if(method==='POST')return json({...job('running'),progress:{stage:'translating',completed:0,total:1}},202);
   if(url.endsWith('.pdf'))return {status:200,response:bytes().buffer};
   if(method==='GET'){if(++polls===1){entered.resolve();return ready.promise;}return json(job());}return {status:204};
  });f.plugin.start();f.plugin.subscribe((reader,value)=>observed.push(value.progress));await f.plugin.toggle(f.reader);await entered.promise;
  assert.equal(f.plugin.state(f.reader).busy,true);assert.deepEqual(f.plugin.state(f.reader).progress,{stage:'translating',completed:0,total:1});
  ready.resolve(json({...job('running'),progress:{stage:'layout'}}));await settle(()=>!f.plugin.state(f.reader).busy);
  assert(observed.some(p=>p?.stage==='preparing'));assert(observed.some(p=>p?.stage==='layout'));assert(observed.some(p=>p?.stage==='loading'));
  assert.equal(f.plugin.state(f.reader).progress,null);f.plugin.shutdown();f.restore();
 });
 await check('mode-only output loading exposes busy progress and drains the latest requested mode',async()=>{
  const entered=deferred(),ready=deferred(),f=controllerFixture(async(method,url)=>{
   if(url.endsWith('/dual.pdf')){entered.resolve();return ready.promise;}
   return url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());
  });f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);
  const switching=f.plugin.setMode(f.reader,'dual');await entered.promise;assert.equal(f.plugin.state(f.reader).busy,true);assert.deepEqual(f.plugin.state(f.reader).progress,{stage:'loading'});
  await f.plugin.setMode(f.reader,'mono');ready.resolve({status:200,response:bytes().buffer});await switching;
  const frame=f.win.document.body.children.find(n=>n.tagName==='iframe');assert(frame.contentDocument.body.allNodes().some(n=>n.getAttribute('data-mode')==='mono'));
  assert.equal(f.plugin.state(f.reader).busy,false);assert.equal(f.plugin.state(f.reader).progress,null);assert.equal(f.transport.requests.filter(r=>r.method==='POST').length,1);
  f.plugin.shutdown();f.restore();
 });
 function toolbarFixture(f){
  const doc=f.reader._iframeWindow.document,create=doc.createElementNS.bind(doc);let host=new DOM.Element(doc,'div');doc.body.appendChild(host);
  doc.querySelector=selector=>selector==='.toolbar .end'?host:null;
  doc.createElementNS=(...args)=>{const node=create(...args);Object.defineProperty(node,'isConnected',{get(){let item=node;while(item){if(item===doc.body)return true;item=item.parentNode;}return false;}});return node;};
  return {doc,get host(){return host;},render(){f.readerEvents.get('renderToolbar')({reader:f.reader,doc,append:node=>host.appendChild(node)});},replace(){host.remove();host=new DOM.Element(doc,'div');doc.body.appendChild(host);return host;}};
 }
 await check('restored PDF toolbar and repeated render events share one connected Translate button',()=>{
  const f=controllerFixture(async()=>{throw Error('toolbar render must not translate');}),toolbar=toolbarFixture(f);f.plugin.start();
  assert.equal(toolbar.host.children.length,1);toolbar.render();toolbar.render();assert.equal(toolbar.host.children.length,1);
  assert.equal(toolbar.host.children[0].isConnected,true);assert.equal(f.transport.requests.length,0);f.plugin.shutdown();f.restore();
 });
 await check('a replaced toolbar subtree reconnects the same owned slot without duplicating controls',()=>{
  const f=controllerFixture(async()=>{throw Error('toolbar render must not translate');}),toolbar=toolbarFixture(f);f.plugin.start();const first=toolbar.host.children[0];
  toolbar.replace();assert.equal(first.isConnected,false);toolbar.render();toolbar.render();assert.equal(toolbar.host.children.length,1);
  assert.equal(toolbar.host.children[0],first);assert.equal(toolbar.host.children[0].isConnected,true);f.plugin.shutdown();assert.equal(toolbar.host.children.length,0);f.restore();
 });
 await check('native controls use the synchronous toolbar slot across remounts and release it on restore',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};
  const f=controllerFixture(async(method,url)=>url.endsWith('/alignment.json')?json(precisionAlignment(true)):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job())),toolbar=toolbarFixture(f),controls=toolbar.doc.createElementNS('http://www.w3.org/1999/xhtml','span'),attached=[];let appearance,disposed=0;
  const layer={visible:false,setProgress(){},prepareOutput(){},attachToolbar(host){attached.push(host);host.appendChild(controls);return true;},async showOutput(){this.visible=true;},showOriginal(){this.visible=false;},dispose(){disposed++;controls.remove();}};
  native.canMount=()=>true;native.mount=async(context,css,actions,value)=>{appearance=value;return layer;};
  try{
   f.plugin.start();const slot=toolbar.host.children[0],entry=slot.children[0];await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);
   assert.equal(appearance.toolbarHost(),slot);assert.equal(controls.parentNode,slot);assert.equal(entry.hidden,true);assert.equal(entry.style.getPropertyValue('display'),'none');assert.equal(entry.style.getPropertyPriority('display'),'important','native toolbar display:flex must not override the hidden entry');const uploads=f.transport.requests.filter(x=>x.method==='POST').length;
   toolbar.replace();let appended=false;const result=f.readerEvents.get('renderToolbar')({reader:f.reader,doc:toolbar.doc,append(node){appended=true;toolbar.host.appendChild(node);}});
   assert.equal(result,undefined,'renderToolbar must append synchronously');assert.equal(appended,true);assert.equal(toolbar.host.children[0],slot);assert.equal(controls.parentNode,slot);assert.equal(slot.children.filter(x=>x===controls).length,1);assert.equal(attached.at(-1),slot);assert.equal(f.transport.requests.filter(x=>x.method==='POST').length,uploads,'toolbar recreation must never restart translation');
   f.plugin.restore(f.reader);assert.equal(disposed,1);assert.equal(entry.hidden,false);assert.equal(entry.style.getPropertyValue('display'),'');assert.equal(controls.parentNode,null);assert.equal(slot.children.length,1);
   f.plugin.shutdown();assert.equal(slot.parentNode,null);
  }finally{native.canMount=original.canMount;native.mount=original.mount;f.plugin.shutdown();f.restore();}
 });
 function originalWheelFixture(f){
  const wheelListeners=[],add=f.win.addEventListener.bind(f.win),remove=f.win.removeEventListener.bind(f.win);let nativeZooms=0;
  f.viewer.clientWidth=800;f.viewer.clientHeight=600;f.viewer.scrollWidth=2000;
  f.viewer.contains=node=>f.viewer.allNodes().includes(node);
  // Model DOM phases: Zotero's existing window bubble listener was registered
  // before the plugin's window capture listener. Registration order must not
  // let the native Meta-wheel zoom run before our session-local capture.
  wheelListeners.push({capture:false,handler:event=>{if(event.ctrlKey||event.metaKey){nativeZooms++;event.nativeReceived=true;event.preventDefault();}}});
  f.win.addEventListener=(type,handler,options)=>{if(type==='wheel')wheelListeners.push({handler,capture:options===true||Boolean(options?.capture),options});else add(type,handler,options);};
  f.win.removeEventListener=(type,handler,options)=>{if(type==='wheel'){const at=wheelListeners.findIndex(x=>x.handler===handler&&x.capture===(options===true||Boolean(options?.capture)));if(at>=0)wheelListeners.splice(at,1);}else remove(type,handler,options);};
  return {get nativeZooms(){return nativeZooms;},get pluginListeners(){return wheelListeners.filter(x=>x.capture);},
   fire(values={}){const event={target:f.viewer,deltaX:0,deltaY:48,deltaMode:0,ctrlKey:false,metaKey:true,
    preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){this.immediateStopped=true;},...values};
    for(const capture of [true,false]){for(const item of [...wheelListeners].filter(x=>x.capture===capture)){item.handler(event);if(event.immediateStopped)break;}if(event.immediateStopped)break;}return event;}
  };
 }
 await check('Command-wheel pans the wide original while translation waits and removes capture on restore',async()=>{
  const entered=deferred(),ready=deferred(),f=controllerFixture(async(method,url)=>{if(method==='POST'){entered.resolve();return ready.promise;}return {status:204};});
  const wheel=originalWheelFixture(f);f.plugin.start();await f.plugin.toggle(f.reader);await entered.promise;
  const top=f.viewer.scrollTop,left=f.viewer.scrollLeft,event=wheel.fire();
  assert.equal(event.immediateStopped,true,'preventDefault alone does not stop native PDF.js zoom');assert.equal(wheel.nativeZooms,0);
  assert.equal(f.viewer.scrollLeft,left+48);assert.equal(f.viewer.scrollTop,top);assert.equal(wheel.pluginListeners[0]?.options.passive,false);
  f.plugin.restore(f.reader);assert.equal(wheel.pluginListeners.length,0);assert.equal(wheel.fire().nativeReceived,true);
  ready.resolve(json(job('running')));f.plugin.shutdown();f.restore();
 });
 await check('failed translation keeps Command panning scoped to the original PDF and leaves Control native',async()=>{
  const f=controllerFixture(async()=>json({...job('failed'),error:'translation_failed'})),wheel=originalWheelFixture(f);f.plugin.start();await f.plugin.toggle(f.reader);
  await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');
  const event=wheel.fire({deltaY:2,deltaMode:1});assert.equal(event.immediateStopped,true);assert.equal(f.viewer.scrollLeft,52);assert.equal(wheel.nativeZooms,0);
  const outside=wheel.fire({target:new DOM.Element(f.win.document,'button')});assert(!outside.immediateStopped);assert.equal(outside.nativeReceived,true);
  const control=wheel.fire({metaKey:false,ctrlKey:true});assert(!control.immediateStopped);assert.equal(control.nativeReceived,true);assert.equal(wheel.nativeZooms,2);
  f.plugin.shutdown();assert.equal(wheel.pluginListeners.length,0);f.restore();
 });
 await check('Command-wheel at fit width stays still and never falls back to native zoom',async()=>{
  const f=controllerFixture(async()=>json({...job('failed'),error:'translation_failed'})),wheel=originalWheelFixture(f);f.plugin.start();await f.plugin.toggle(f.reader);
  await settle(()=>!f.plugin.state(f.reader).busy);f.viewer.scrollWidth=f.viewer.clientWidth;f.viewer.scrollLeft=0;
  const event=wheel.fire();assert.equal(event.immediateStopped,true);assert.equal(f.viewer.scrollLeft,0);assert.equal(wheel.nativeZooms,0);
  f.plugin.shutdown();f.restore();
 });
 await check('original PDF Command takes precedence over the synthetic pinch Control bit',async()=>{
  const f=controllerFixture(async()=>json({...job('failed'),error:'translation_failed'})),wheel=originalWheelFixture(f);f.plugin.start();await f.plugin.toggle(f.reader);
  await settle(()=>!f.plugin.state(f.reader).busy);const top=f.viewer.scrollTop,left=f.viewer.scrollLeft;
  const event=wheel.fire({metaKey:true,ctrlKey:true,deltaY:40});
  assert.equal(event.immediateStopped,true);assert.equal(wheel.nativeZooms,0);assert.equal(f.viewer.scrollLeft,left+40);assert.equal(f.viewer.scrollTop,top);
  f.plugin.shutdown();f.restore();
 });
 await check('visible translated output keeps its own Command-wheel and original capture does not interfere',async()=>{
  const f=controllerFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job())),wheel=originalWheelFixture(f);f.plugin.start();await f.plugin.toggle(f.reader);
  await settle(()=>f.viewer.style.getPropertyValue('visibility')==='hidden');const frame=f.win.document.body.children.find(n=>n.tagName==='iframe'),doc=frame.contentDocument;
  doc.scrollingElement={scrollLeft:0,scrollTop:200,scrollWidth:2000,clientWidth:800};const event=doc.emit('wheel',{deltaX:0,deltaY:48,deltaMode:0,metaKey:true,ctrlKey:false});
  assert.equal(event.defaultPrevented,true);await new Promise(resolve=>setTimeout(resolve,200));assert.equal(doc.scrollingElement.scrollLeft,48);assert.equal(doc.scrollingElement.scrollTop,200);assert.equal(wheel.nativeZooms,0);
  const hiddenOriginal=wheel.fire();assert(!hiddenOriginal.immediateStopped,'only visible original PDF belongs to this capture path');
  f.plugin.shutdown();f.restore();
 });
 await check('native controls expose immediate busy state and do not duplicate a running page job',async()=>{
  const ready=deferred(),entered=deferred();
  const f=controllerFixture(async(method,url)=>{if(method==='POST'){entered.resolve();return ready.promise;}return url.endsWith('.pdf')?{status:200,response:bytes().buffer}:{status:204};});
  f.plugin.start();assert.equal(typeof f.plugin.translate,'function');assert.equal(typeof f.plugin.subscribe,'function');
  const states=[],unsubscribe=f.plugin.subscribe((reader,state)=>{assert.equal(reader,f.reader);states.push(state);});
  const opened=f.plugin.translate(f.reader,{whole:false,mode:'dual',direction:'en-zh'});
  assert.equal(f.plugin.state(f.reader).busy,true,'busy must be synchronous, before iframe load');
  await entered.promise;await f.plugin.translate(f.reader,{whole:true});assert.equal(f.transport.requests.filter(r=>r.method==='POST').length,1);
  ready.resolve(json(job()));await opened;await settle(()=>f.plugin.state(f.reader).busy===false);
  assert(states.some(s=>s.busy));assert.equal(f.plugin.state(f.reader).mode,'dual');
  f.plugin.restore(f.reader);assert.equal(f.plugin.state(f.reader).open,false);assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');
  unsubscribe();f.plugin.shutdown();f.restore();
 });
 await check('native mode changes during translation select the result without a second job',async()=>{
  const ready=deferred(),entered=deferred();
  const f=controllerFixture(async(method,url)=>{if(method==='POST'){entered.resolve();return ready.promise;}return url.endsWith('.pdf')?{status:200,response:bytes().buffer}:{status:204};});
  f.plugin.start();await f.plugin.translate(f.reader,{whole:false,mode:'mono',direction:'en-zh'});await entered.promise;
  await f.plugin.setMode(f.reader,'dual');ready.resolve(json(job()));await settle(()=>f.viewer.style.getPropertyValue('visibility')==='hidden');
  assert.equal(f.transport.requests.filter(r=>r.method==='POST').length,1);assert(f.transport.requests.some(r=>r.url.endsWith('/dual.pdf')));
  await f.plugin.setMode(f.reader,'mono');assert.equal(f.transport.requests.filter(r=>r.method==='POST').length,1);
  f.plugin.shutdown();f.restore();
 });
 await check('actual keydown events in the main and PDF windows each toggle once',async()=>{
  const f=controllerFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()));f.plugin.start();
  const chord={code:'KeyX',altKey:true,shiftKey:true,ctrlKey:false,metaKey:false,repeat:false};
  const opened=f.reader._window.emit('keydown',chord);assert.equal(opened.defaultPrevented,true);await settle(()=>f.viewer.style.getPropertyValue('visibility')==='hidden');
  const closed=f.win.emit('keydown',chord);assert.equal(closed.defaultPrevented,true);assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');
  assert.equal(f.transport.requests.filter(r=>r.method==='POST').length,1);f.plugin.shutdown();f.restore();
 });
 await check('switching mode while the first output is downloading ends on the latest choice',async()=>{
  const ready=deferred(),entered=deferred();
  const f=controllerFixture(async(method,url)=>{if(url.endsWith('/mono.pdf')){entered.resolve();return ready.promise;}return url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});
  f.plugin.start();await f.plugin.translate(f.reader,{whole:false,mode:'mono'});await entered.promise;
  await f.plugin.setMode(f.reader,'dual');ready.resolve({status:200,response:bytes().buffer});
  await settle(()=>f.plugin.state(f.reader).busy===false);
  const frame=f.win.document.body.children.find(n=>n.tagName==='iframe');
  assert(frame.contentDocument.body.allNodes().some(n=>n.getAttribute('data-mode')==='dual'),'latest mode must be rendered, not only stored');
  assert.equal(f.transport.requests.filter(r=>r.method==='POST').length,1);f.plugin.shutdown();f.restore();
 });
 await check('stopping from the page toolbar releases native controls and page mode updates sidebar state',async()=>{
  const entered=deferred(),ready=deferred();const f=controllerFixture(async(method,url)=>{if(method==='POST'){entered.resolve();return ready.promise;}return url.endsWith('.pdf')?{status:200,response:bytes().buffer}:{status:204};});
  f.plugin.start();await f.plugin.translate(f.reader,{whole:false,mode:'mono'});await entered.promise;
  const frame=f.win.document.body.children.find(n=>n.tagName==='iframe'),doc=frame.contentDocument;
  doc.body.allNodes().find(n=>n.getAttribute('title')==='Stop · 停止').emit('click');
  assert.equal(f.plugin.state(f.reader).busy,false);ready.resolve(json(job('running')));f.plugin.shutdown();f.restore();
 });
 await check('real controller reads only active open PDF bytes and restores original on shortcut',async()=>{
  const f=controllerFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()));f.plugin.start();
  assert.deepEqual(f.reads,[]);assert.equal(f.transport.requests.length,0);
  await f.plugin.toggle(f.reader);await settle(()=>f.viewer.style.getPropertyValue('visibility')==='hidden');
  assert.deepEqual(f.reads,['data']);assert.equal(f.win.PDFViewerApplication.pdfDocument,f.pdf);
  assert.equal(f.transport.requests[0].options.headers['X-AskGPT-Pages'],'2');
  await f.plugin.toggle(f.reader);assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');assert.equal(f.viewer.scrollTop,160);
  f.plugin.shutdown();assert.equal(f.unregister,1);assert.equal(f.events.size,0);f.restore();
 });
 await check('changing current page and iframe scrolling do not close whole-PDF session',async()=>{
  const f=controllerFixture(async(method,url,options)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job('complete',options?.headers?.['X-AskGPT-Pages']==='all'?[0,1,2]:[1])));f.plugin.start();
  await f.plugin.toggle(f.reader);await settle(()=>f.viewer.style.getPropertyValue('visibility')==='hidden');
  const frame=f.win.document.body.children.find(n=>n.tagName==='iframe'),doc=frame.contentDocument;
  const whole=doc.body.allNodes().find(n=>n.getAttribute('title')==='Translate whole PDF · 整份');
  f.output.numPages=3;whole.emit('click');await settle(()=>f.transport.requests.filter(r=>r.method==='POST').length===2);await settle(()=>f.viewer.style.getPropertyValue('visibility')==='hidden');
  f.win.PDFViewerApplication.pdfViewer.currentPageNumber=3;f.events.get('pagechanging')();doc.emit('scroll');
  assert.equal(frame.parentNode,f.win.document.body);assert.equal(f.viewer.style.getPropertyValue('visibility'),'hidden');assert.equal(f.win.PDFViewerApplication.pdfDocument,f.pdf);
  assert.deepEqual(f.reads,['data']);f.plugin.shutdown();f.restore();
 });
 await check('failed job retains original PDF and never creates a text-only fallback',async()=>{
  const f=controllerFixture(async()=>json({...job('failed'),error:'runtime_missing'}));f.plugin.start();await f.plugin.toggle(f.reader);
  await settle(()=>f.win.document.body.allNodes().some(n=>n.className==='askgpt-pdf-error'));
  assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');assert.equal(f.renders.length,0);assert.equal(f.win.PDFViewerApplication.pdfDocument,f.pdf);
  assert(!f.win.document.body.allNodes().some(n=>n.className==='askgpt-paragraph'));f.plugin.shutdown();f.restore();
 });
 await check('closing during getData prevents upload and late PDF does not hide original',async()=>{
  const f=controllerFixture(async()=>{throw Error('must not request');}),entered=deferred(),late=deferred();
  f.pdf.getData=async()=>{entered.resolve();return late.promise;};f.plugin.start();await f.plugin.toggle(f.reader);await entered.promise;
  await f.plugin.toggle(f.reader);late.resolve(bytes());await new Promise(setImmediate);
  assert.equal(f.transport.requests.length,0);assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');f.plugin.shutdown();f.restore();
 });
 await check('reopen waits for late job ID and delayed DELETE before a second POST',async()=>{
  const created=deferred(),late=deferred(),deleting=deferred(),deleted=deferred();let posts=0;
  const f=controllerFixture(async(method,url)=>{
   if(method==='POST'){posts++;if(posts===1){created.resolve();return late.promise;}return json({...job(),id:'replacement'});}
   if(method==='DELETE'&&url.endsWith('job_fixture-1')){deleting.resolve();return deleted.promise;}
   if(url.endsWith('.pdf'))return {status:200,response:bytes().buffer};return {status:204};
  });f.plugin.start();await f.plugin.toggle(f.reader);await created.promise;await f.plugin.toggle(f.reader);await f.plugin.toggle(f.reader);
  await new Promise(setImmediate);assert.equal(posts,1);late.resolve(json(job('running'),202));await deleting.promise;await new Promise(setImmediate);assert.equal(posts,1,'single-active engine must see DELETE complete before new POST');
  deleted.resolve({status:204});await settle(()=>posts===2);await settle(()=>f.viewer.style.getPropertyValue('visibility')==='hidden');f.plugin.shutdown();f.restore();
 });
 await check('mono and dual switch uses cached PDF bytes without starting another translation',async()=>{
  const f=controllerFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()));f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>f.viewer.style.getPropertyValue('visibility')==='hidden');
  const frame=f.win.document.body.children.find(n=>n.tagName==='iframe'),doc=frame.contentDocument;
  const dual=doc.body.allNodes().find(n=>n.getAttribute('title')==='Side by side PDF · 对照'),mono=doc.body.allNodes().find(n=>n.getAttribute('title')==='Translated PDF · 译文');
  dual.emit('click');await settle(()=>doc.body.allNodes().some(n=>n.getAttribute('data-mode')==='dual'));mono.emit('click');await settle(()=>doc.body.allNodes().some(n=>n.getAttribute('data-mode')==='mono'));
  assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/dual.pdf')).length,1);assert.equal(f.transport.requests.filter(r=>r.method==='POST').length,1);f.plugin.shutdown();f.restore();
 });
 await check('reopening a completed translation skips DELETE and can reuse the completed backend result',async()=>{
  const f=controllerFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()));
  try{
   f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy&&f.viewer.style.getPropertyValue('visibility')==='hidden');
   f.plugin.restore(f.reader);await f.plugin.toggle(f.reader);await settle(()=>f.transport.requests.filter(value=>value.method==='POST').length===2&&!f.plugin.state(f.reader).busy);
   assert.equal(f.transport.requests.filter(value=>value.method==='DELETE').length,0,'completed results do not own a running worker and must not add cancellation round trips');
   assert.equal(f.viewer.style.getPropertyValue('visibility'),'hidden');assert.equal(f.win.PDFViewerApplication.pdfDocument,f.pdf);
  }finally{try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('a hidden completed translation still renders its current mode when the reader regains focus',async()=>{
  const entered=deferred(),ready=deferred(),f=controllerFixture(async(method,url)=>{if(method==='POST'){entered.resolve();return ready.promise;}return url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});
  try{
   f.plugin.start();await f.plugin.toggle(f.reader);await entered.promise;f.reader._window.Zotero_Tabs.selectedID='another-reader';ready.resolve(json(job()));
   await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(f.renders.length,0);assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');
   f.reader._window.Zotero_Tabs.selectedID=f.reader.tabID;f.reader._window.emit('focus');await settle(()=>f.renders.length===1&&!f.plugin.state(f.reader).busy);
   assert.equal(f.viewer.style.getPropertyValue('visibility'),'hidden');assert.equal(f.transport.requests.filter(value=>value.method==='POST').length,1);
  }finally{try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('input limit is 150 MiB while generated output can exceed it up to 450 MiB',()=>{
  const pdf=require('../content/pdf-layout.js'),large=new Uint8Array(151*1024*1024);large.set(bytes('%PDF-'));
  assert.equal(pdf.MAX_INPUT_BYTES,150*1024*1024);assert.equal(pdf.MAX_OUTPUT_BYTES,450*1024*1024);
  assert.throws(()=>pdf.validPDF(large),{code:'limit'});assert.equal(pdf.validPDF(large,pdf.MAX_OUTPUT_BYTES).length,large.length);
 });
 await check('structured diagnostics exclude raw message, stack, URL, token and untrusted fields',()=>{
  const pdf=require('../content/pdf-layout.js');assert.equal(typeof pdf.diagnostic,'function');
  const secret='PRIVATE_TEXT_TOKEN_URL';const value=pdf.diagnostic('mount',{name:'TypeError',code:secret,message:secret,stack:'fn@file:///private/'+secret+'/inline.js:77:2\nfn@https://'+secret+'/pdf-layout.js:9:4'});
  assert.deepEqual(value,{stage:'mount',exception:'TypeError',code:'unknown',locations:[{file:'inline.js',line:77},{file:'pdf-layout.js',line:9}]});assert(!JSON.stringify(value).includes(secret));
  for(const stage of ['nativeConstructed','nativeInitialized','nativePainted','nativeReady','nativeState','nativeSearch','nativeAnnotation']){
    const native=pdf.diagnostic(stage,{name:'TypeError',message:secret,stack:'callback@file:///private/'+secret+'/pdf-native-view.js:213:1'});
    assert.deepEqual(native,{stage,exception:'TypeError',code:'unknown',locations:[{file:'pdf-native-view.js',line:213}]});assert(!JSON.stringify(native).includes(secret));
  }
 });
 await check('selection mapping diagnostics retain only fixed reasons and bounded counts',()=>{
  const pdf=require('../content/pdf-layout.js'),secret='PRIVATE_SELECTION_TEXT';
  const result=pdf.diagnostic('nativeSelection',{name:'Error',code:'annotation_sentence',mappingDetail:'coverage',mappingNumbers:{outputPage:0,sourcePage:3,selectionRects:2,matchedSentences:1,uncoveredRects:1,text:secret,token:secret},message:secret});
  assert.equal(result.code,'annotation_sentence');assert.equal(result.mappingDetail,'coverage');assert.deepEqual(result.mappingNumbers,{outputPage:0,sourcePage:3,selectionRects:2,matchedSentences:1,uncoveredRects:1});assert(!JSON.stringify(result).includes(secret));
  const rejected=pdf.diagnostic('nativeSelection',{mappingDetail:secret,mappingNumbers:{outputPage:Infinity,sourcePage:-4,selectionRects:999999999,matchedSentences:NaN,uncoveredRects:0}});
  assert.equal(rejected.mappingDetail,undefined);assert.deepEqual(rejected.mappingNumbers,{outputPage:-1,sourcePage:-1,selectionRects:-1,matchedSentences:-1,uncoveredRects:0});
 });
 await check('current PDF bytes are copied from only the returned Xray view into module-owned memory',()=>{
  const vm=require('node:vm'),pdf=require('../content/pdf-layout.js'),foreign=vm.runInNewContext('new Uint8Array([37,80,68,70,45,49])');
  const wrapped=new Proxy(foreign,{get(target,key){if(key==='0'||key==='buffer')throw Error('permission denied');return Reflect.get(target,key,target);}});
  let waived=0;assert.equal(typeof pdf.copyOpenPDFData,'function');
  const copied=pdf.copyOpenPDFData(wrapped,{utils:{waiveXrays(value){assert.equal(value,wrapped);waived++;return foreign;}}});
  assert(copied instanceof Uint8Array);assert.deepEqual([...copied],[37,80,68,70,45,49]);assert.equal(waived,1);foreign[0]=0;assert.equal(copied[0],37);
 });
 await check('self-owned output PDF proxies expose page-count and page prototypes through scoped Xray unwrap',async()=>{
  const f=layoutFixture(),wrappers=new WeakMap(),masked=new Proxy(f.output,{get(target,key){if(key==='numPages')return undefined;return Reflect.get(target,key);}});wrappers.set(masked,f.output);let waived=0;
  f.win.pdfjsLib.getDocument=()=>({promise:Promise.resolve(masked),destroy(){}});
  const layer=await adapter.mountPDFView(f.context,'',{}, {Components:{utils:{cloneInto:value=>value,waiveXrays(value){waived++;return wrappers.get(value)||value;}}}});
  await layer.showOutput(bytes(),[1],'mono');assert.equal(layer.visible,true);assert(waived>=2);assert.equal(f.win.PDFViewerApplication.pdfDocument,f.source);layer.dispose();f.restore();
 });
 await check('late initial offscreen observer notification cannot erase the preferred first page',async()=>{
  const f=layoutFixture();let notify;f.win.IntersectionObserver=class{constructor(callback){notify=callback;}observe(){}disconnect(){}};
  const layer=await adapter.mountPDFView(f.context,'',{},{});await layer.showOutput(bytes(),[1],'mono');const holder=layer.body.children[0],canvas=holder.children[0];
  notify([{target:holder,isIntersecting:false}]);assert(canvas.width>0);assert.equal(holder.children.length,2);layer.dispose();f.restore();
 });
 await check('missing render completion promise cannot be accepted as a completed PDF page',async()=>{
  const f=layoutFixture(),diagnostics=[];f.output.getPage=async()=>({getViewport:({scale})=>({width:600*scale,height:800*scale,scale}),render:()=>({promise:undefined,cancel(){}})});
  const layer=await adapter.mountPDFView(f.context,'',{failure(){}},{reportDiagnostic:(stage,error)=>diagnostics.push({stage,error})});await layer.showOutput(bytes(),[1],'mono');
  assert.equal(layer.visible,false);assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');assert(diagnostics.some(d=>d.stage==='render'));layer.dispose();f.restore();
 });
 await check('skipBlender is set on only the self-owned content canvas context rather than its Xray expando',async()=>{
  const f=layoutFixture(),create=DOM.Document.prototype.createElementNS,wrappers=new WeakMap();let context;
  DOM.Document.prototype.createElementNS=function(ns,name){const node=create.call(this,ns,name);if(name==='canvas'){context={canvas:node};const wrapper=new Proxy(context,{set(target,key,value){if(key==='skipBlender')return true;target[key]=value;return true;}});wrappers.set(wrapper,context);node.getContext=()=>wrapper;}return node;};
  const layer=await adapter.mountPDFView(f.context,'',{}, {Components:{utils:{cloneInto:value=>value,waiveXrays:value=>wrappers.get(value)||value}}});await layer.showOutput(bytes(),[1],'mono');
  assert.equal(context.skipBlender,true,'Zotero content renderer must see the skipBlender flag');assert.equal(f.renders[0].canvasContext,context);assert.equal(f.win.PDFViewerApplication.pdfDocument,f.source);layer.dispose();f.restore();
 });
 await check('layout diagnostics accept only bounded numeric layout fields and alpha counts',()=>{
  const pdf=require('../content/pdf-layout.js');const result=pdf.diagnostic('layout',{name:'RenderSnapshot',code:'layout',layoutNumbers:{canvasWidth:800,canvasHeight:1000,canvasDisplay:1,canvasVisibility:1,canvasOpacity:1000,alphaZero:64,opaque:0,raw:'SECRET',url:'SECRET',canvasLeft:Infinity}});
  assert.equal(result.stage,'layout');assert.equal(result.layoutNumbers.alphaZero,64);assert.equal(result.layoutNumbers.opaque,0);assert.equal(result.layoutNumbers.canvasLeft,-1);assert(!JSON.stringify(result).includes('SECRET'));assert(!('raw' in result.layoutNumbers));
 });
 await check('canvas frame enables bitmap rendering while CSP forbids embedded or remote scripts',async()=>{
  const f=layoutFixture(),layer=await adapter.mountPDFView(f.context,'',{},{});
  assert(layer.frame.getAttribute('sandbox').split(/\s+/).includes('allow-scripts'),'a script-disabled canvas only represents fallback content');
  const policy=layer.doc.head.children.find(n=>n.tagName==='meta').getAttribute('content');assert(policy.includes("script-src 'none'"));assert(policy.includes("connect-src 'none'"));assert(!layer.frame.getAttribute('srcdoc').includes('<script'));layer.dispose();f.restore();
 });
 await check('root controller passes the inner native reader and caches validated alignment across mono and dual',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};
  const geometry={mediaBox:[0,0,600,800],cropBox:[0,0,600,800],rotation:0};
  const alignment={schema:1,coordinateSpace:'pdf',granularity:'paragraph',untrusted:'strip me',pages:[{
   sourcePage:1,outputPage:0,source:geometry,mono:geometry,dual:{mediaBox:[0,0,1200,800],cropBox:[0,0,1200,800],rotation:0},sourceToDual:[1,0,0,1,0,0],targetToDual:[1,0,0,1,600,0],paragraphs:[{
    id:'p1_0',untrusted:'strip me too',source:{text:'A source paragraph.',rects:[[10,10,110,20]]},target:{text:'原段落的译文。',rects:[[10,30,80,40]]},dualSource:{rects:[[10,10,110,20]]},dualTarget:{rects:[[610,30,680,40]]}
   }]
  }]};
  const shows=[],contexts=[],f=controllerFixture(async(method,url)=>url.endsWith('/alignment.json')?json(alignment):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()));let actions,disposals=0,originals=0;
  const layer={visible:false,prepareOutput(){},setProgress(){},async showOutput(data,pages,mode,mapping){shows.push({data,pages,mode,mapping});this.visible=true;f.viewer.style.setProperty('visibility','hidden');},showOriginal(){originals++;this.restoreOriginal();},restoreOriginal(){this.visible=false;f.viewer.style.setProperty('visibility','visible','important');},dispose(){disposals++;this.restoreOriginal();}};
  native.canMount=context=>{contexts.push(context);return true;};
  native.mount=async(context,css,value)=>{actions=value;assert.equal(context.reader,f.reader._internalReader);assert.equal(context.outerReader,f.reader);assert.equal(context.sourceView,f.reader._internalReader._primaryView);assert.equal(context.win,f.win);assert.equal(context.pdfDocument,f.pdf);return layer;};
  try{
   f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>shows.length===1&&!f.plugin.state(f.reader).busy);
   assert.equal(contexts.length,1);assert.equal(contexts[0].reader,f.reader._internalReader);assert.equal(contexts[0].sourceView,f.reader._internalReader._primaryView);
   assert.equal(shows[0].mode,'mono');assert.deepEqual(shows[0].pages,[1]);assert.deepEqual(new Uint8Array(shows[0].data),bytes());
   assert.equal(shows[0].mapping.pages[0].paragraphs[0].target.text,'原段落的译文。');
   assert.equal(shows[0].mapping.untrusted,undefined);assert.equal(shows[0].mapping.pages[0].paragraphs[0].untrusted,undefined,'root must use transport-validated alignment');
   assert.equal(shows[0].mapping.pages[0].paragraphs[0].dualTarget.text,'原段落的译文。');
   await f.plugin.setMode(f.reader,'mono');assert.equal(shows.length,1,'selecting the currently visible mode must preserve its native PDFView');
   await f.plugin.setMode(f.reader,'dual');await f.plugin.setMode(f.reader,'mono');
   assert.deepEqual(shows.map(value=>value.mode),['mono','dual','mono']);assert.equal(shows[1].mapping,shows[0].mapping);assert.equal(shows[2].mapping,shows[0].mapping);
   assert.equal(f.transport.requests.filter(value=>value.url.endsWith('/alignment.json')).length,1);assert.equal(f.transport.requests.filter(value=>value.url.endsWith('/mono.pdf')).length,1);assert.equal(f.transport.requests.filter(value=>value.url.endsWith('/dual.pdf')).length,0,'native dual shares the exact cached mono PDF');assert.equal(f.transport.requests.filter(value=>value.method==='POST').length,1);
   await f.plugin.setMode(f.reader,'dual');const cached=shows.at(-1).data;
   await actions.original();assert.equal(originals,1);assert.equal(f.plugin.state(f.reader).open,true);assert.equal(f.plugin.state(f.reader).original,true);assert.equal(disposals,0);
   f.win.PDFViewerApplication.pdfViewer.currentPageNumber=3;
   await f.plugin.toggle(f.reader);assert.equal(f.plugin.state(f.reader).original,false);assert.equal(shows.at(-1).mode,'dual');assert.equal(shows.at(-1).data,cached);
   await f.plugin.original(f.reader);assert.equal(f.plugin.state(f.reader).original,true);
   f.win.PDFViewerApplication.pdfViewer.currentPageNumber=2;
   await f.plugin.translate(f.reader,{whole:false,mode:'mono',direction:'en-zh'});assert.equal(shows.at(-1).mode,'mono');assert.equal(f.plugin.state(f.reader).original,false);
   assert.equal(f.transport.requests.filter(value=>value.method==='POST').length,1,'returning to the same local translation never creates a new job');assert.equal(f.transport.requests.filter(value=>value.url.endsWith('/mono.pdf')).length,1);assert.equal(disposals,0);
   assert.equal(f.renders.length,0,'native root path must not fall back to the separate canvas renderer');assert.equal(f.win.PDFViewerApplication.pdfDocument,f.pdf);
  }finally{native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('mono current-page action and cached mode selection use the translated physical page while its hidden source stays put',async()=>{
  const jobs=new Map(),views=[];let created=0;
  function mapping(pages){const value=precisionAlignment(true),template=value.pages[0];value.pages=pages.map((sourcePage,outputPage)=>({...structuredClone(template),sourcePage,outputPage}));value.sentencePages=pages.slice();value.phrasePages=pages.slice();value.phraseExtractedPages=pages.slice();value.phraseCoverage=Object.fromEntries(pages.map(page=>[page,precisionAlignment(true).phraseCoverage[1]]));return value;}
  const f=controllerFixture(async(method,url,options)=>{
   if(method==='POST'){const selected=options.headers['X-AskGPT-Pages'],pages=selected==='all'?[0,1,2]:[Number(selected)-1],value={...job('complete',pages),id:'job_current_page_'+(++created)};jobs.set(value.id,pages);return json(value);}
   if(url.endsWith('/alignment.json'))return json(mapping(jobs.get(url.split('/').at(-2))));
   if(url.endsWith('.pdf'))return {status:200,response:bytes().buffer};
   throw Error('Unexpected current-page fixture request '+method+' '+url);
  });
  const outer=f.reader._iframeWindow.document,container=new DOM.Element(outer,'div'),source=f.reader._internalReader._primaryView;
  outer.body.appendChild(container);
  class NativeView{
   constructor(options){this._options=options;this._iframe=new DOM.Element(outer,'iframe');options.container.appendChild(this._iframe);this._iframeWindow=new DOM.Window();this._iframeWindow.PDFViewerApplication={pdfDocument:{native:true,numPages:options.pageLabels.length},pdfViewer:{currentPageNumber:(options.viewState?.pageIndex||0)+1}};this.initializedPromise=Promise.resolve();this._annotations=options.annotations;views.push(this);}
   setAnnotations(value){this._annotations=value;}setSelectedAnnotationIDs(){}setTool(value){this._tool=value;}setPageLabels(value){this._pageLabels=value;}destroy(){this._iframe.remove();}
  }
  f.reader._internalReader._state={annotations:[],tool:{type:'pointer'},primaryViewState:{pageIndex:1,left:10,top:700,scale:100},selectedAnnotationIDs:[]};
  Object.assign(source,{constructor:NativeView,_iframe:new DOM.Element(outer,'iframe'),_options:{container},_pageLabels:['1','2','3'],_onAddAnnotation:value=>value,_onChangeViewState:value=>{f.reader._internalReader._state.primaryViewState=value;},setAnnotations(){},setSelectedAnnotationIDs(){},setTool(){}});
  container.appendChild(source._iframe);
  try{
   f.plugin.start();await f.plugin.translate(f.reader,{whole:true,mode:'mono'});await settle(()=>views.length===1&&!f.plugin.state(f.reader).busy);
   const target=views[0];target._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber=3;target._options.onChangeViewState({pageIndex:2,left:20,top:650,scale:100});
   assert.equal(f.win.PDFViewerApplication.pdfViewer.currentPageNumber,2,'mono reading must leave the hidden source native viewer on its original page');assert.equal(f.reader._internalReader._state.primaryViewState.pageIndex,2);
   const current=outer.body.allNodes().find(node=>node.getAttribute('title')==='Translate current page · 本页');assert(current);current.emit('click');
   await settle(()=>f.transport.requests.filter(request=>request.method==='POST').length===2&&!f.plugin.state(f.reader).busy);
   assert.deepEqual(f.transport.requests.filter(request=>request.method==='POST').map(request=>request.options.headers['X-AskGPT-Pages']),['all','3']);assert.equal(views.length,2);assert.equal(f.win.PDFViewerApplication.pdfViewer.currentPageNumber,2);
   await f.plugin.translate(f.reader,{whole:false,mode:'dual',direction:'en-zh'});
   assert.equal(f.plugin.state(f.reader).mode,'dual');assert.equal(f.transport.requests.filter(request=>request.method==='POST').length,2,'the current translated physical page is already cached even though the hidden source viewer has another page');assert.equal(views.length,2,'cached mode selection must retain the existing local native PDFView');
  }finally{try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('showing original during a native translation retains its task and local result for one-click return',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},entered=deferred(),finished=deferred();let originals=0,shows=0,disposals=0;
  const f=controllerFixture(async(method,url)=>{if(method==='POST'){entered.resolve();return finished.promise;}return url.endsWith('/alignment.json')?json(precisionAlignment(true)):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});
  const layer={visible:false,prepareOutput(){},setProgress(){},showOriginal(){originals++;this.visible=false;},async showOutput(){shows++;this.visible=true;},restoreOriginal(){this.visible=false;},dispose(){disposals++;}};
  native.canMount=()=>true;native.mount=async()=>layer;
  try{
   f.plugin.start();await f.plugin.toggle(f.reader);await entered.promise;await f.plugin.original(f.reader);
   assert.equal(f.plugin.state(f.reader).busy,true);assert.equal(f.plugin.state(f.reader).original,true);assert.equal(originals,1);assert.equal(disposals,0);
   finished.resolve(json(job()));await settle(()=>!f.plugin.state(f.reader).busy);
   assert.equal(shows,0);assert.equal(f.plugin.state(f.reader).open,true);assert(!f.transport.requests.some(value=>value.method==='DELETE'));
   await f.plugin.toggle(f.reader);assert.equal(shows,1);assert.equal(f.plugin.state(f.reader).original,false);assert.equal(f.transport.requests.filter(value=>value.method==='POST').length,1);
  }finally{native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('explicit page and whole toolbar requests leave original mode and present the translation after a failed native load',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};
  for(const scope of ['current','whole']){
   let actions,posts=0,restores=0;const shows=[];
   const f=controllerFixture(async(method,url,options)=>{
    if(method==='POST'){posts++;return json(job('complete',options.headers['X-AskGPT-Pages']==='all'?[0,1,2]:[Number(options.headers['X-AskGPT-Pages'])-1]));}
    if(url.endsWith('/alignment.json')){
     if(posts===1)return {status:404,responseText:'{"error":"alignment_unavailable"}'};
     const pages=scope==='whole'?[0,1,2]:[0],value=precisionAlignment(true);value.pages=pages.map((sourcePage,outputPage)=>({...structuredClone(value.pages[0]),sourcePage,outputPage}));value.sentencePages=pages.slice();value.phrasePages=pages.slice();return json(markExtracted(value));
    }
    return url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());
   });
   const layer={visible:false,prepareOutput(){},setProgress(){},showOriginal(){this.visible=false;},async showOutput(data,pages,mode){shows.push({pages,mode});this.visible=true;},restoreOriginal(){restores++;this.visible=false;},dispose(){},get currentSourcePage(){return f.win.PDFViewerApplication.pdfViewer.currentPageNumber-1;}};
   native.canMount=()=>true;native.mount=async(context,css,value)=>{actions=value;return layer;};
   try{
    f.plugin.start();await f.plugin.toggle(f.reader,{whole:true,mode:'dual'});await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(restores,1);assert.equal(shows.length,0);
    await f.plugin.original(f.reader);f.win.PDFViewerApplication.pdfViewer.currentPageNumber=1;await actions[scope]();
    assert.equal(f.plugin.state(f.reader).original,false);assert.deepEqual(shows,[{pages:scope==='whole'?[0,1,2]:[0],mode:'dual'}]);
    const requests=f.transport.requests.filter(value=>value.method==='POST');assert.equal(requests.at(-1).options.headers['X-AskGPT-Pages'],scope==='whole'?'all':'1');assert.equal(posts,2);
   }finally{native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
  }
 });
 await check('root native controller keeps the original and reports an error when alignment is missing',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};let shows=0,restores=0;
  const f=controllerFixture(async(method,url)=>url.endsWith('/alignment.json')?{status:404,responseText:'{"error":"not_found"}'}:url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()));
  const layer={visible:false,prepareOutput(){},setProgress(){},async showOutput(){shows++;this.visible=true;f.viewer.style.setProperty('visibility','hidden');},restoreOriginal(){restores++;this.visible=false;f.viewer.style.setProperty('visibility','visible','important');},dispose(){this.restoreOriginal();}};
  native.canMount=()=>true;native.mount=async context=>{assert.equal(context.sourceView,f.reader._internalReader._primaryView);return layer;};
  try{
   f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy&&f.win.document.body.allNodes().some(node=>node.className==='askgpt-pdf-error'));
   assert.equal(shows,0,'unmapped translation must never be presented as a native annotatable PDF');assert(restores>=1);assert.equal(layer.visible,false);
   assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');assert.equal(f.viewer.style.getPropertyPriority('visibility'),'important');assert.equal(f.win.PDFViewerApplication.pdfDocument,f.pdf);assert.equal(f.renders.length,0);
   assert.equal(f.transport.requests.filter(value=>value.url.endsWith('/alignment.json')).length,1);assert.equal(f.transport.requests.filter(value=>value.url.endsWith('/mono.pdf')).length,1);assert(f.diagnostics.some(value=>value.stage==='output'&&value.error));
  }finally{native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 function precisionAlignment(sentence=false){
  const geometry={mediaBox:[0,0,600,800],cropBox:[0,0,600,800],rotation:0};
  const part={source:{text:'original',rects:[[10,10,110,20]]},target:{text:'译文',rects:[[10,30,80,40]]},dualSource:{rects:[[10,10,110,20]]},dualTarget:{rects:[[610,30,680,40]]}};
  // Synthetic fixture glyphs only. Production uses actual PDF font geometry.
  const glyphs=side=>Array.from(side.text).map((text,index)=>{const r=side.rects[0],width=(r[2]-r[0])/Array.from(side.text).length;return {text,rect:[r[0]+index*width,r[1],r[0]+(index+1)*width,r[3]],line:0};});
  const precise={...part,source:{...part.source,glyphs:glyphs(part.source)},target:{...part.target,glyphs:glyphs(part.target)}};
  const atomic={id:'s1_0_p0',method:'semantic-phrase-model',...precise,sourceTokenCount:1,targetTokenCount:2};
  return {schema:1,coordinateSpace:'pdf',granularity:sentence?'sentence':'paragraph',...(sentence?{sentenceAlignmentRevision:'pdf-sentence-semantic-v1',sentencePages:[1],phraseAlignmentRevision:'pdf-phrase-semantic-v1',phrasePages:[1],phraseExtractionRevision:'pdf-glyph-boundary-v2',phraseExtractedPages:[1],phraseCoverage:{1:{sentences:1,extractable:1,aligned:1,unavailable:0,sourceTokens:1,targetTokens:2,mappedSourceTokens:1,mappedTargetTokens:2}}}:{}),pages:[{sourcePage:1,outputPage:0,source:geometry,mono:geometry,dual:{mediaBox:[0,0,1200,800],cropBox:[0,0,1200,800],rotation:0},sourceToDual:[1,0,0,1,0,0],targetToDual:[1,0,0,1,600,0],paragraphs:[{id:'p1_0',...part,...(sentence?{sentences:[{id:'s1_0',method:'semantic-model',...precise,phrases:[atomic]}]}:{})}]}]};
 }
 function markExtracted(value){if(value.phrasePages?.length){value.phraseExtractionRevision='pdf-glyph-boundary-v2';value.phraseExtractedPages=value.phrasePages.slice();value.phraseCoverage=Object.fromEntries(value.phrasePages.map(page=>[page,precisionAlignment(true).phraseCoverage[1]]));}return value;}
 await check('a cached false-full page probes and repairs only its metadata while a truly covered page needs no upgrade',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};
  for(const stale of [true,false]){
   const complete=precisionAlignment(true),second=structuredClone(complete.pages[0].paragraphs[0]);second.id='p1_1';second.sentences[0].id='s1_1';second.sentences[0].phrases[0].id='s1_1_p0';complete.pages[0].paragraphs.push(second);complete.phraseCoverage[1]={sentences:2,extractable:2,aligned:2,unavailable:0,sourceTokens:2,targetTokens:4,mappedSourceTokens:2,mappedTargetTokens:4};
   const cached=structuredClone(complete);if(stale)cached.pages[0].paragraphs[1].sentences=[];
   let actions,upgraded=false,mounts=0;const shows=[],updates=[],statuses=[],results=[];
   const f=controllerFixture(async(method,url,options)=>{
    if(url.endsWith('/alignment-upgrade')){
     if(method==='POST'){assert.equal(options.headers['Content-Type'],'application/pdf');assert.equal(options.headers['X-AskGPT-Pages'],'2');assert.deepEqual(new Uint8Array(options.body),bytes());upgraded=true;}
     return json({id:job().id,state:upgraded?'complete':'idle',sourcePages:[1],completedPages:upgraded?[1]:[],mappedSentences:upgraded?2:0},method==='POST'?202:200);
    }
    return url.endsWith('/alignment.json')?json(upgraded?complete:cached):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());
   });
   const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(value){statuses.push(value);},async updateAlignment(value){updates.push(value);},async showOutput(data,pages,mode,mapping){shows.push({data,mapping});this.visible=true;results.push(actions.page(1));},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
   native.canMount=()=>true;native.mount=async(_context,_css,value)=>{mounts++;actions=value;return layer;};
   try{
    f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy&&(stale?updates.length===1:true));await new Promise(setImmediate);
    assert.equal(results[0],stale?'started':'ready');assert.equal(mounts,1);assert.equal(shows.length,1);assert.equal(f.renders.length,0);assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-upgrade')).length,1,'opening the completed cache must not start another PDF translation');assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);
    const metadata=f.transport.requests.filter(r=>r.url.endsWith('/alignment-upgrade'));assert.deepEqual(metadata.map(r=>r.method),stale?['GET','POST']:[]);assert.equal(updates.length,stale?1:0);assert.deepEqual(statuses,stale?['preparing',null]:[]);
    actions.align(1,{explicit:true});await f.plugin.setMode(f.reader,'dual');await new Promise(setImmediate);assert.equal(results.at(-1),'ready');assert.equal(mounts,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-upgrade')).length,metadata.length);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);assert.equal(shows[1].data,shows[0].data,'mode switching keeps the same local translated PDF bytes');
   }finally{native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
  }
 });
 await check('sentence precision upgrades in place once without another translation or PDF render',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};let actions,upgraded=false,mounts=0;const shows=[],updates=[],statuses=[];
  const f=controllerFixture(async(method,url)=>{
   if(url.endsWith('/alignment-upgrade')){upgraded=true;return json({id:job().id,state:'complete',sourcePages:[1],completedPages:[1],mappedSentences:1},202);}
   return url.endsWith('/alignment.json')?json(precisionAlignment(upgraded)):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());
  });
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus(value){statuses.push(value);},async updateAlignment(value){updates.push(value);},async showOutput(data,pages,mode,mapping){shows.push(mapping);this.visible=true;actions.align(1);},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
  native.canMount=()=>true;native.mount=async(context,css,value)=>{mounts++;actions=value;return layer;};
  try{
   f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>updates.length===1&&!f.plugin.state(f.reader).busy);
   actions.align(1);actions.align(1);await new Promise(setImmediate);
   assert.equal(mounts,1);assert.equal(shows.length,1);assert.equal(updates[0].granularity,'sentence');assert.deepEqual(statuses,['preparing',null]);
   assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-upgrade')).length,1);
   assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-upgrade')).length,1);assert.equal(f.renders.length,0);
   await f.plugin.setMode(f.reader,'dual');assert.equal(shows[1].granularity,'sentence');assert.equal(updates.length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-upgrade')).length,1);
  }finally{native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('closing a precision listener rejects late mapping without deleting the completed translation',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},entered=deferred(),late=deferred();let actions,updates=0;
  const f=controllerFixture(async(method,url)=>{
   if(url.endsWith('/alignment-upgrade')){entered.resolve();return late.promise;}
   return url.endsWith('/alignment.json')?json(precisionAlignment()):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());
  });
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus(){},async updateAlignment(){updates++;},async showOutput(){this.visible=true;actions.align(1);},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
  native.canMount=()=>true;native.mount=async(context,css,value)=>{actions=value;return layer;};
  try{
   f.plugin.start();await f.plugin.toggle(f.reader);await entered.promise;await settle(()=>!f.plugin.state(f.reader).busy);f.plugin.restore(f.reader);
   late.resolve(json({id:job().id,state:'complete',sourcePages:[1],completedPages:[1],mappedSentences:1},202));await new Promise(setImmediate);await new Promise(setImmediate);
   assert.equal(updates,0);assert.equal(f.plugin.state(f.reader).open,false);assert.equal(f.transport.requests.filter(r=>r.method==='DELETE').length,0);
  }finally{native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('cached native layout switches immediately while its pending precise mapping upgrades in place',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},upgradeEntered=deferred(),upgradeReady=deferred();let actions,upgraded=false;const shows=[],updates=[],statuses=[];
  const f=controllerFixture(async(method,url)=>{
   if(url.endsWith('/alignment-upgrade')){upgradeEntered.resolve();await upgradeReady.promise;upgraded=true;return json({id:job().id,state:'complete',sourcePages:[1],completedPages:[1],mappedSentences:1},202);}
   if(url.endsWith('/dual.pdf'))throw Error('native paired layout must reuse the translated local PDF');
   return url.endsWith('/alignment.json')?json(precisionAlignment(upgraded)):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());
  });
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus(value){statuses.push(value);},async updateAlignment(value){updates.push(value);},async showOutput(data,pages,mode,mapping){shows.push({data,mode,mapping});this.visible=true;actions.align(1);},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
  native.canMount=()=>true;native.mount=async(context,css,value)=>{actions=value;return layer;};
  try{
   f.plugin.start();await f.plugin.toggle(f.reader);await upgradeEntered.promise;await settle(()=>!f.plugin.state(f.reader).busy);
   await f.plugin.setMode(f.reader,'dual');assert.equal(f.plugin.state(f.reader).busy,false);assert.equal(shows.length,2);assert.equal(shows[1].mode,'dual');assert.equal(shows[1].data,shows[0].data);assert.equal(shows[1].mapping.granularity,'paragraph');assert.deepEqual(statuses,['preparing']);
   upgradeReady.resolve();await settle(()=>updates.length===1);assert.equal(updates[0].granularity,'sentence');assert.deepEqual(statuses,['preparing',null]);
   await f.plugin.setMode(f.reader,'mono');assert.equal(shows[2].mapping,updates[0],'the next mode sees the exact newly upgraded mapping');await new Promise(setImmediate);
   assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-upgrade')).length,1,'mode completion must not upload the original PDF for an already completed sentence page');
   assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-upgrade')).length,1);assert.equal(f.renders.length,0);
  }finally{upgradeReady.resolve();native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('whole-document precision prepares only the visible page and probes cached pages on arrival',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};let actions,posted=false,nextReady=false;const updates=[],shows=[];
  function mapping(){const value=precisionAlignment();value.pages=[0,1,2].map((sourcePage,outputPage)=>({...structuredClone(value.pages[0]),sourcePage,outputPage}));if(posted){value.granularity='sentence';value.sentenceAlignmentRevision='pdf-sentence-semantic-v1';value.sentencePages=nextReady?[1,2]:[1];value.phraseAlignmentRevision='pdf-phrase-semantic-v1';value.phrasePages=value.sentencePages.slice();for(const page of value.pages)if(value.sentencePages.includes(page.sourcePage))page.paragraphs[0].sentences=precisionAlignment(true).pages[0].paragraphs[0].sentences;}return markExtracted(value);}
  const f=controllerFixture(async(method,url)=>{
   if(url.endsWith('/alignment-upgrade')){if(method==='POST')posted=true;return json({id:job().id,state:posted?'running':'idle',sourcePages:[0,1,2],completedPages:posted?(nextReady?[1,2]:[1]):[],mappedSentences:posted?1:0},method==='POST'?202:200);}
   return url.endsWith('/alignment.json')?json(mapping()):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job('complete',[0,1,2]));
  });
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus(){},async updateAlignment(value){updates.push(value);},async showOutput(data,pages,mode,value){shows.push(value);this.visible=true;actions.page(1);actions.align(1);},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
  native.canMount=()=>true;native.mount=async(context,css,value)=>{actions=value;return layer;};
  try{
   f.plugin.start();await f.plugin.toggle(f.reader,{whole:true});await settle(()=>updates.length===1&&!f.plugin.state(f.reader).busy);
   let posts=f.transport.requests.filter(r=>r.method==='POST'&&r.url.endsWith('/alignment-upgrade')&&r.options.headers['Content-Type']==='application/pdf');assert.equal(posts.length,1);assert.equal(posts[0].options.headers['X-AskGPT-Pages'],'2');assert.deepEqual(updates[0].sentencePages,[1]);
   nextReady=true;actions.page(2);await settle(()=>updates.length===2);assert.deepEqual(updates[1].sentencePages,[1,2]);
   posts=f.transport.requests.filter(r=>r.method==='POST'&&r.url.endsWith('/alignment-upgrade')&&r.options.headers['Content-Type']==='application/pdf');assert.equal(posts.length,1,'cached visible pages must avoid reuploading the original');assert.equal(shows.length,1);assert.equal(f.renders.length,0);
   assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-upgrade')).length,1);
  }finally{native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('page changes immediately detach an obsolete listener without cancelling the service task',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},entered=deferred(),release=deferred();let actions,posted=false,statusReads=0;const updates=[];
  const mapping=()=>{const value=precisionAlignment();value.pages=[0,1,2].map((sourcePage,outputPage)=>({...structuredClone(value.pages[0]),sourcePage,outputPage}));return value;};
  const f=controllerFixture(async(method,url,options)=>{
   if(url.endsWith('/alignment-upgrade')){
    if(method==='POST'&&options.headers['Content-Type']==='application/json')return json({id:job().id,state:'running',sourcePages:[1,2],completedPages:[],currentPage:2,pendingPages:[1],mappedSentences:0});
    if(method==='POST'){posted=true;entered.resolve();return json({id:job().id,state:'running',sourcePages:[1],completedPages:[],currentPage:1,pendingPages:[],mappedSentences:0},202);}
    statusReads++;if(posted){await release.promise;return json({id:job().id,state:'running',sourcePages:[1,2],completedPages:[],currentPage:2,pendingPages:[1],mappedSentences:0});}
    return json({id:job().id,state:'idle',sourcePages:[],completedPages:[],mappedSentences:0});
   }
   return url.endsWith('/alignment.json')?json(mapping()):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job('complete',[0,1,2]));
  });
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus(){},async updateAlignment(value){updates.push(value);},async showOutput(){this.visible=true;actions.page(1);},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
  native.canMount=()=>true;native.mount=async(context,css,value)=>{actions=value;return layer;};
  try{
   f.plugin.start();await f.plugin.toggle(f.reader,{whole:true});await entered.promise;await settle(()=>!f.plugin.state(f.reader).busy);actions.page(2);
   await settle(()=>statusReads>=2);assert.equal(f.transport.requests.filter(r=>r.method==='DELETE').length,0);assert.equal(updates.length,0,'an old page cannot publish after the visible page changes');
   const posts=f.transport.requests.filter(r=>r.method==='POST'&&r.url.endsWith('/alignment-upgrade')&&r.options.headers['Content-Type']==='application/pdf');assert.equal(posts[0].options.headers['X-AskGPT-Pages'],'2');
  }finally{release.resolve();native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('failed precision stays quiet on stats, recovers from explicit retry and never retranslates or rebuilds',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},realNow=Date.now;let clock=10000,actions,posts=0,ready=false,mounts=0;const updates=[],statuses=[];Date.now=()=>clock;
  const f=controllerFixture(async(method,url)=>{if(url.endsWith('/alignment-upgrade')){if(method==='POST'){posts++;if(posts>1)ready=true;}return json({id:job().id,state:ready?'complete':method==='POST'?'failed':'idle',sourcePages:[1],completedPages:ready?[1]:[],mappedSentences:ready?1:0,...(!ready&&method==='POST'?{error:'alignment_timeout'}:{})},method==='POST'?202:200);}return url.endsWith('/alignment.json')?json(precisionAlignment(ready)):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus:value=>statuses.push(value),async updateAlignment(value){updates.push(value);},async showOutput(){this.visible=true;actions.align(1);},restoreOriginal(){this.visible=false;},dispose(){},currentSourcePage:1};native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;mounts++;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>statuses.includes('failed')&&!f.plugin.state(f.reader).busy);for(let i=0;i<20;i++){actions.page(1);actions.align(1);}await new Promise(setImmediate);assert.equal(posts,1);assert(updates.length>=1,'a failed model turn must still reload successful partial sidecar checkpoints');actions.align(1,{explicit:true});assert.equal(statuses.at(-1),'retry_wait');assert.equal(posts,1);clock+=3000;actions.align(1,{explicit:true});await settle(()=>ready&&updates.at(-1)?.phraseExtractedPages?.includes(1));assert.equal(statuses.at(-1),null);assert.equal(posts,2);assert.equal(mounts,1);assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-upgrade')).length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);actions.align(1,{explicit:true});await new Promise(setImmediate);assert.equal(posts,2);
  }finally{Date.now=realNow;native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('successful partial word batches reach the native reader while the page is still preparing and survive a later timeout',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},release=deferred();let actions,step=0;const updates=[],statuses=[];
  const partial=precisionAlignment(true);partial.phraseExtractedPages=[];
  const f=controllerFixture(async(method,url)=>{if(url.endsWith('/alignment-upgrade')){if(step===0&&method==='GET')return json({id:job().id,state:'idle',sourcePages:[],completedPages:[],mappedSentences:0});if(method==='POST'){step=1;return json({id:job().id,state:'running',sourcePages:[1],completedPages:[],mappedSentences:0,alignmentVersion:'a'.repeat(64)},202);}if(step===1){step=2;return json({id:job().id,state:'running',sourcePages:[1],completedPages:[],mappedSentences:1,alignmentVersion:'b'.repeat(64)});}await release.promise;return json({id:job().id,state:'failed',sourcePages:[1],completedPages:[],mappedSentences:1,error:'alignment_timeout',alignmentVersion:'b'.repeat(64)});}return url.endsWith('/alignment.json')?json(step>=2?partial:precisionAlignment()):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus:value=>statuses.push(value),async updateAlignment(value){updates.push(value);},async showOutput(){this.visible=true;actions.align(1);},restoreOriginal(){this.visible=false;},dispose(){},currentSourcePage:1};native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>updates.some(value=>value.phrasePages?.includes(1)));assert.equal(statuses.at(-1),'preparing');assert.equal(f.plugin.state(f.reader).busy,false);assert.equal(updates.at(-1).phraseExtractedPages.length,0,'partial exact links must never claim the entire page is ready');release.resolve();await settle(()=>statuses.at(-1)==='failed');assert(updates.at(-1).phrasePages.includes(1));assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-upgrade')).length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);
  }finally{release.resolve();native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('explicit precision retries have a bounded budget and retry only probes a cache completed elsewhere',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},realNow=Date.now;let clock=10000,actions,posts=0,externalReady=false;const statuses=[];Date.now=()=>clock;
  const f=controllerFixture(async(method,url)=>{if(url.endsWith('/alignment-upgrade')){if(method==='POST')posts++;return json({id:job().id,state:externalReady?'complete':method==='POST'?'failed':'idle',sourcePages:[1],completedPages:externalReady?[1]:[],mappedSentences:externalReady?1:0,...(!externalReady&&method==='POST'?{error:'alignment_timeout'}:{})},method==='POST'?202:200);}return url.endsWith('/alignment.json')?json(precisionAlignment(externalReady)):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus:value=>statuses.push(value),async updateAlignment(){},async showOutput(){this.visible=true;actions.align(1);},restoreOriginal(){this.visible=false;},dispose(){},currentSourcePage:1};native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>statuses.at(-1)==='failed'&&!f.plugin.state(f.reader).busy);for(let n=2;n<=3;n++){clock+=3000;actions.resume();await settle(()=>posts===n&&statuses.at(-1)==='failed');}clock+=3000;actions.align(1,{explicit:true});assert.equal(statuses.at(-1),'retry_limited');assert.equal(posts,3);clock+=60000;externalReady=true;actions.resume();await settle(()=>statuses.at(-1)===null);assert.equal(posts,3,'a completed server cache must be probed without another model POST');assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-upgrade')).length,1);assert.equal(f.transport.requests.filter(r=>r.method==='DELETE').length,0);
  }finally{Date.now=realNow;native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('a new selection prioritizes its sentence on the running page without another PDF upload',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},entered=deferred(),release=deferred();let actions,started=false,priority=false;const updates=[];
  const f=controllerFixture(async(method,url,options)=>{
   if(url.endsWith('/alignment-upgrade')){
    if(method==='POST'&&options.headers['Content-Type']==='application/json'){assert.deepEqual(JSON.parse(options.body),{page:1,units:['s0']});priority=true;release.resolve();return json({id:job().id,state:'running',sourcePages:[1],completedPages:[],currentPage:1,pendingPages:[],mappedSentences:0});}
    if(method==='POST'){started=true;entered.resolve();return json({id:job().id,state:'running',sourcePages:[1],completedPages:[],mappedSentences:0},202);}
    if(!started)return json({id:job().id,state:'idle',sourcePages:[1],completedPages:[],mappedSentences:0});await release.promise;return json({id:job().id,state:'complete',sourcePages:[1],completedPages:[1],mappedSentences:1});
   }
   return url.endsWith('/alignment.json')?json(precisionAlignment(priority)):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());
  });
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus(){},async updateAlignment(value){updates.push(value);},async showOutput(){this.visible=true;actions.align(1);},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
  native.canMount=()=>true;native.mount=async(context,css,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await entered.promise;actions.align(1,{explicit:true,units:['s0']});actions.align(1,{explicit:true,units:['s0']});await settle(()=>updates.length===1);assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&r.url.endsWith('/alignment-upgrade')&&r.options.headers['Content-Type']==='application/pdf').length,1);assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&r.options.headers['Content-Type']==='application/json').length,1);assert.equal(f.renders.length,0);}
  finally{release.resolve();native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('an explicit cold selection uses the small independent endpoint, caches late results and restores permanent page links without a PDF rebuild',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},late=deferred(),entered=deferred(),mapping=precisionAlignment(),full=precisionAlignment(true),key='c'.repeat(64);mapping.sourceSHA256='a'.repeat(64);
  const link={...structuredClone(full.pages[0].paragraphs[0].sentences[0].phrases[0]),id:'sel_'+key,key,paragraph:'p1_0'},binding={jobID:job().id,page:1,sourceSHA256:'a'.repeat(64),targetSHA256:'b'.repeat(64),revision:'pdf-selection-semantic-v1'},query={page:1,paragraph:'p1_0',side:'target',rects:[[10,30,80,40]],text:'译文'};let actions,mounts=0;const updates=[],shows=[];
  const f=controllerFixture(async(method,url,options)=>{
   if(url.endsWith('/selection-alignment?page=1'))return json({...binding,links:[]});
   if(url.endsWith('/selection-alignment')){const value=JSON.parse(options.body);if(value.text==='译文'){entered.resolve();await late.promise;return json({...binding,key,link,cached:false});}return json({...binding,key:'d'.repeat(64),link:null,cached:false});}
   if(url.endsWith('/alignment-upgrade'))throw Error('an interactive word must not wait for whole-page readiness');
   return url.endsWith('/alignment.json')?json(mapping):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());
  });
  const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(){},async updateAlignment(){throw Error('selection must not reload the sentence sidecar');},updateSelectionLinks(value){updates.push(value);},async showOutput(data){this.visible=true;shows.push(data);},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
  native.canMount=()=>true;native.mount=async(_context,_css,value)=>{mounts++;actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy&&updates.some(value=>value.links));assert.equal(actions.align(1,{explicit:true,selection:query}),'started');await entered.promise;assert.equal(actions.align(1,{explicit:true,selection:query}),'pending');actions.align(1,{explicit:true,selection:{...query,text:'文',rects:[[45,30,80,40]]}});await settle(()=>updates.some(value=>value.link===null));late.resolve();await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(updates.some(value=>value.link?.id===link.id),false,'a superseded selection response may populate cache but must not replace current UI');assert.equal(actions.align(1,{explicit:true,selection:query}),'ready');assert.equal(updates.at(-1).link.id,link.id);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/selection-alignment')).length,2);assert.equal(f.transport.requests.filter(r=>r.method==='DELETE').length,0);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment.json')).length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);assert.equal(mounts,1);assert.equal(shows.length,1);assert.equal(f.renders.length,0);}
  finally{late.resolve();native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('returning to the same pending selection adopts its result and later background alignment keeps the independent links',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},late=deferred(),entered=deferred(),mapping=precisionAlignment(),precise=precisionAlignment(true),key='e'.repeat(64);mapping.sourceSHA256='a'.repeat(64);precise.sourceSHA256=mapping.sourceSHA256;const link={...structuredClone(precise.pages[0].paragraphs[0].sentences[0].phrases[0]),id:'sel_'+key,key,paragraph:'p1_0'},binding={jobID:job().id,page:1,sourceSHA256:mapping.sourceSHA256,targetSHA256:'b'.repeat(64),revision:'pdf-selection-semantic-v1'},query={page:1,paragraph:'p1_0',side:'target',rects:[[10,30,80,40]],text:'译文'};let actions,background=false;const applied=[],updates=[];
  const f=controllerFixture(async(method,url,options)=>{if(url.endsWith('/selection-alignment?page=1'))return json({...binding,links:[]});if(url.endsWith('/selection-alignment')){if(JSON.parse(options.body).text==='译文'){entered.resolve();await late.promise;return json({...binding,key,link,cached:false});}return json({...binding,key:'f'.repeat(64),link:null,cached:false});}if(url.endsWith('/alignment-upgrade')){if(method==='POST')background=true;return json({id:job().id,state:background?'complete':'idle',sourcePages:[1],completedPages:background?[1]:[],mappedSentences:background?1:0},method==='POST'?202:200);}return url.endsWith('/alignment.json')?json(background?precise:mapping):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});
  const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(){},updateSelectionLinks(value){applied.push(value);},async updateAlignment(value){updates.push(value);},async showOutput(){this.visible=true;},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy&&applied.length>0);actions.align(1,{explicit:true,selection:query});await entered.promise;actions.align(1,{explicit:true,selection:{...query,text:'文',rects:[[45,30,80,40]]}});assert.equal(actions.align(1,{explicit:true,selection:query}),'pending');late.resolve();await settle(()=>applied.some(value=>value.link?.id===link.id));assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/selection-alignment')).length,2);actions.page(1);await settle(()=>updates.length===1);assert.equal(applied.some(value=>value.link?.id===link.id),true);assert.equal(actions.align(1,{explicit:true,selection:query}),'ready');assert.equal(applied.at(-1).link.id,link.id);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/selection-alignment')).length,2);assert.equal(f.transport.requests.filter(r=>r.method==='DELETE').length,0);}
  finally{late.resolve();native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../manifest.json'),'utf8'));
 await check('Zotero 9 manifest and bootstrap load PDF layout before adapter',()=>{
  assert.equal(manifest.manifest_version,2);assert.equal(manifest.applications.zotero.id,'askgpt-inline@local.askgpt.reader');assert.equal(manifest.applications.zotero.strict_min_version,'9.0');assert.equal(manifest.applications.zotero.strict_max_version,'9.*');assert(new URL(manifest.applications.zotero.update_url).hostname==='127.0.0.1');
  const boot=fs.readFileSync(path.join(__dirname,'../bootstrap.js'),'utf8');assert(boot.indexOf("'content/pdf-layout.js'")<boot.indexOf("'content/inline.js'"));
 });
 clearTimeout(watchdog);process.stdout.write(JSON.stringify({status:'PASS',checks})+'\n');
})().catch(error=>{clearTimeout(watchdog);process.stderr.write(error.stack+'\n');process.exitCode=1;});
