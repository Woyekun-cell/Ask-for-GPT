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
 await check('hover lookup uses only the authenticated local dictionary route',async()=>{
  const entry={query:'binds',headword:'bind',phonetic:'baɪnd',senses:[{partOfSpeech:'v.',meanings:['结合','绑定']}]};
  const f=transportFixture(async()=>json({entry}));
  assert.equal(typeof adapter.createWordLookup,'function');
  assert.deepEqual(await adapter.createWordLookup(f.deps)('binds'),entry);
  const request=f.requests[0];assert.equal(f.requests.length,1);assert.equal(request.method,'POST');
  assert.equal(request.url,'http://127.0.0.1:43792/v1/inline/lookup');
  assert.deepEqual(JSON.parse(request.options.body),{word:'binds'});
  assert.equal(request.options.headers.Authorization,'Bearer '+'t'.repeat(64));
  assert.equal(request.options.headers.Origin,undefined);assert.equal(request.options.followRedirects,false);
  assert.equal(request.options.debug,false);assert.equal(request.options.logBodyLength,0);
 });
 await check('hover dictionary rejects passages and IDs without making requests',async()=>{
  const f=transportFixture(async()=>{throw Error('invalid hover input reached server');});
  for(const word of ['two words','EPRS1','<script>','a'.repeat(97),''])await assert.rejects(adapter.createWordLookup(f.deps)(word));
  assert.equal(f.requests.length,0);
 });
 await check('hover misses stay empty and malformed or mismatched entries are rejected',async()=>{
  const miss=transportFixture(async()=>json({entry:null}));assert.equal(await adapter.createWordLookup(miss.deps)('polymerase'),null);
  for(const entry of [{query:'other',headword:'other',senses:[]},{query:'table',headword:'table',senses:[{partOfSpeech:'n.',meanings:[{}]}]}]){
   const f=transportFixture(async()=>json({entry}));await assert.rejects(adapter.createWordLookup(f.deps)('table'));
  }
 });
 await check('hover dictionary obeys owner-only connection checks before sending a word',async()=>{
  const f=transportFixture(async()=>{throw Error('unsafe hover reached server');});f.file.permissions=0o644;
  await assert.rejects(adapter.createWordLookup(f.deps)('table'),{code:'permissions'});assert.equal(f.requests.length,0);
 });
 function figurePNG(width=768,height=1024){const value=new Uint8Array(32);value.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);const view=new DataView(value.buffer);view.setUint32(16,width);view.setUint32(20,height);return value;}
 await check('figure model sends bounded PNG only to the authenticated local layout route and returns numeric boxes',async()=>{
  let uploaded;const model={figures:[{rect:[.1,.2,.8,.7],confidence:.95}],exclusions:[{rect:[.1,.7,.8,.8],kind:'caption',confidence:.9}]},f=transportFixture(async(method,url,options)=>{uploaded=new Uint8Array(options.body);return json(model);});
  const input=figurePNG(),actual=await adapter.createFigureLookup(f.deps)(input);assert.deepEqual(actual,model);assert.deepEqual(uploaded,input);const request=f.requests[0];assert.equal(request.method,'POST');assert.equal(request.url,'http://127.0.0.1:43795/v1/pdf/figure-regions');assert.equal(request.options.headers['Content-Type'],'image/png');assert.equal(request.options.headers.Authorization,'Bearer '+'t'.repeat(64));assert.equal(request.options.headers.Origin,undefined);assert.equal(request.options.followRedirects,false);assert.equal(request.options.debug,false);assert.equal(request.options.logBodyLength,0);assert(input.some(Boolean));assert(new Uint8Array(request.options.body).every(value=>value===0),'the request owns and retires its own byte copy');
 });
 await check('figure model rejects unsafe connection, oversize PNG and untrusted layout fields',async()=>{
  const unsafe=transportFixture(async()=>assert.fail());unsafe.file.permissions=0o644;await assert.rejects(adapter.createFigureLookup(unsafe.deps)(figurePNG()),{code:'permissions'});assert.equal(unsafe.requests.length,0);
  const invalid=transportFixture(async()=>assert.fail());for(const input of [new Uint8Array(32),figurePNG(1025,100),new Uint8Array(4*1024*1024+1)])await assert.rejects(adapter.createFigureLookup(invalid.deps)(input));assert.equal(invalid.requests.length,0);
  for(const model of [{figures:[],exclusions:[],text:'private'},{figures:[{rect:[0,0,2,1],confidence:.9}],exclusions:[]},{figures:[],exclusions:[{rect:[0,0,1,1],kind:'body',confidence:.9}]},{figures:[{rect:[0,0,1,1],confidence:2}],exclusions:[]}]){const f=transportFixture(async()=>json(model));await assert.rejects(adapter.createFigureLookup(f.deps)(figurePNG()),{code:'response'});}
 });
 await check('figure model busy retries are bounded and cancellation prevents later retries',async()=>{
  let attempts=0;const f=transportFixture(async()=>++attempts<3?json({error:'figure_busy'},429):json({figures:[],exclusions:[]}));assert.deepEqual(await adapter.createFigureLookup(f.deps)(figurePNG()),{figures:[],exclusions:[]});assert.equal(attempts,3);
  const busy=transportFixture(async()=>json({error:'figure_busy'},429));await assert.rejects(adapter.createFigureLookup(busy.deps)(figurePNG()),{code:'figure_busy'});assert.equal(busy.requests.length,3);
  let cancel;const stopped=transportFixture(async()=>{cancel();return json({error:'figure_busy'},429);});await assert.rejects(adapter.createFigureLookup(stopped.deps)(figurePNG(),{setCancel:value=>{cancel=value;}}),{code:'stopped'});assert.equal(stopped.requests.length,1);
 });
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
 function controllerFixture(request,{preferences=null,controllerAdapter=adapter}={}){
  const transport=transportFixture(request),layout=layoutFixture(),main=new DOM.Window(),events=new Map(),readerEvents=new Map(),reads=[],diagnostics=[];
  main.Zotero_Tabs={selectedID:'public-fixture'};
  const pdf={async getData(){reads.push('data');return bytes();},async getPageData(){throw Error('pure-text extraction must never run');}};
  const application=layout.win.PDFViewerApplication;application.pdfDocument=pdf;application.eventBus={on(name,fn){events.set(name,fn);},off(name,fn){if(events.get(name)===fn)events.delete(name);}};
  const reader={type:'pdf',tabID:'public-fixture',_window:main,_iframeWindow:new DOM.Window(),_internalReader:{_primaryView:{_iframeWindow:layout.win}}};
  let unregister=0,observer=null;const alerts=[];
  const deps={...transport.deps,css:'',pluginID:'fixture',reportDiagnostic:(stage,error)=>diagnostics.push({stage,error}),Services:{...transport.deps.Services,prompt:{alert:(...args)=>alerts.push(args)}},Zotero:{...transport.deps.Zotero,getMainWindow:()=>main,getMainWindows:()=>[main],Reader:{_readers:[reader],getByTabID:()=>reader,registerEventListener(type,callback){readerEvents.set(type,callback);},_unregisterEventListenerByPluginID(){unregister++;readerEvents.clear();}},Notifier:{registerObserver(value){observer=value;return 1;},unregisterObserver(){observer=null;}}}};
  if(preferences)deps.Zotero.Prefs=preferences;
  const plugin=controllerAdapter.create(deps);return {...layout,transport,plugin,reader,events,readerEvents,reads,pdf,alerts,diagnostics,tabEvent:(event,ids=[reader.tabID])=>observer?.notify(event,'tab',ids),get unregister(){return unregister;}};
 }
 function retainedInputFixture(request,options={}){
  // Observe the real controller's retained graph without a production debug API.
  const vm=require('node:vm'),moduleFile=path.join(__dirname,'../content/inline.js');let contexts=null;
  class ObservedMap extends Map{set(key,value){if(value?.reader===key&&Object.hasOwn(value,'session'))contexts=this;return super.set(key,value);}}
  const sandbox={module:{exports:{}},require:require('node:module').createRequire(moduleFile),Map:ObservedMap};
  vm.runInNewContext(fs.readFileSync(moduleFile,'utf8'),sandbox,{filename:moduleFile});
  const f=controllerFixture(request,{...options,controllerAdapter:sandbox.module.exports});
  return {...f,context:()=>contexts?.get(f.reader)||null,contextCount:()=>contexts?.size||0,restart(whole=false){
   const frame=f.win.document.body.children.find(node=>node.tagName==='iframe'),title=whole?'Translate whole PDF · 整份':'Translate current page · 本页';
   const button=frame?.contentDocument.body.allNodes().find(node=>node.getAttribute('title')===title);assert(button,'translation toolbar remains usable');button.emit('click');
  }};
 }
 function localVersionFixture(request,load,find=async()=>({id:42})){
  const vm=require('node:vm'),moduleFile=path.join(__dirname,'../content/inline.js'),opened=[];
  const sandbox={module:{exports:{}},require:require('node:module').createRequire(moduleFile),AskGPTPDFLocalVersion:{create:({Zotero})=>{Zotero.Reader.open=async(id,location)=>opened.push({id,location});return {find,load};}}};
  vm.runInNewContext(fs.readFileSync(moduleFile,'utf8'),sandbox,{filename:moduleFile});
  return {...controllerFixture(request,{controllerAdapter:sandbox.module.exports}),opened};
 }
 const storedVersion=()=>({job:job('complete',[0,1,2]),output:bytes(),item:{id:42}});
 await check('saved Chinese version loads in the existing side by side session without a new tab or translation job',async()=>{
  const f=localVersionFixture(async()=>{throw Error('local PDF must not use transport');},async()=>storedVersion());
  f.output.numPages=3;f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);
  assert.equal(f.plugin.state(f.reader).mode,'dual');assert.equal(f.plugin.state(f.reader).whole,true);assert.equal(f.plugin.state(f.reader).open,true);
  assert.equal(f.opened.length,0);assert.equal(f.transport.requests.length,0);assert.equal(f.viewer.style.getPropertyValue('visibility'),'hidden');
  f.plugin.shutdown();f.restore();
 });
 await check('local native split keeps toolbar mounted and reuses version bytes across mode changes without PDF downloads',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},shows=[],frames=[];
  const layout={...precisionAlignment(),sourceSHA256:'a'.repeat(64)};layout.pages=[0,1,2].map(i=>({...layout.pages[0],sourcePage:i,outputPage:i,paragraphs:[]}));
  const f=localVersionFixture(async(method,url)=>{assert.equal(method,'GET');assert(!url.endsWith('.pdf'));if(url.endsWith('/alignment-layout.json'))return json(layout);return json({jobID:job().id,page:1,sourceSHA256:layout.sourceSHA256,targetSHA256:'b'.repeat(64),links:[]});},async()=>storedVersion());
  const toolbar=toolbarFixture(f),controls=toolbar.doc.createElementNS('http://www.w3.org/1999/xhtml','span');let disposals=0;
  const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(){},attachToolbar(host){host.appendChild(controls);return true;},async showOutput(data,pages,mode,mapping){shows.push({data,pages,mode,mapping});this.visible=true;},showOriginal(){this.visible=false;},restoreOriginal(){this.visible=false;},dispose(){disposals++;controls.remove();}};
  native.canMount=()=>true;native.mount=async()=>layer;f.reader._iframeWindow.requestAnimationFrame=fn=>{frames.push(fn);return frames.length;};f.reader._iframeWindow.cancelAnimationFrame=()=>{};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(shows[0].mode,'dual');assert.deepEqual([...shows[0].data],[...bytes()]);assert.equal(controls.parentNode,toolbar.host.children[0]);assert.equal(disposals,0);assert.equal(f.opened.length,0);assert.equal(frames.length,1);
   await f.plugin.setMode(f.reader,'original');assert.equal(controls.parentNode,toolbar.host.children[0]);await f.plugin.setMode(f.reader,'dual');assert.equal(shows[1].data,shows[0].data);assert.equal(f.transport.requests.filter(r=>r.method==='POST'||r.url.endsWith('.pdf')).length,0);
  }finally{native.canMount=original.canMount;native.mount=original.mount;f.plugin.shutdown();f.restore();}
 });
 await check('a new whole translation saves its Chinese version while keeping the existing reading session',async()=>{
  let saves=0;const f=localVersionFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job('complete',[0,1,2])),async()=>null,async()=>{saves++;return {id:43};});
  f.output.numPages=3;f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);
  assert.equal(saves,1);assert.equal(f.opened.length,0);assert.equal(f.plugin.state(f.reader).mode,'dual');assert.equal(f.plugin.state(f.reader).open,true);
  assert.equal(f.transport.requests.filter(r=>r.method==='POST').length,1);f.plugin.shutdown();f.restore();
 });
 await check('background local loading waits for its own selected tab and never opens another tab',async()=>{
  const pending=deferred();const f=localVersionFixture(async()=>{throw Error('no translation');},()=>pending.promise);f.output.numPages=3;
  f.plugin.start();await f.plugin.toggle(f.reader);f.reader._window.Zotero_Tabs.selectedID='other';pending.resolve(storedVersion());await settle(()=>!f.plugin.state(f.reader).busy);
  assert.equal(f.opened.length,0);assert.notEqual(f.viewer.style.getPropertyValue('visibility'),'hidden');
  f.reader._window.Zotero_Tabs.selectedID=f.reader.tabID;f.win.emit('focus');await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(f.viewer.style.getPropertyValue('visibility'),'hidden');f.plugin.shutdown();f.restore();
 });
 await check('closed reader cannot publish a late local version or create another translation',async()=>{
  const pending=deferred();const f=localVersionFixture(async()=>{throw Error('closed reader');},()=>pending.promise);
  f.plugin.start();await f.plugin.toggle(f.reader);f.plugin.shutdown();pending.resolve(storedVersion());await new Promise(setImmediate);
  assert.equal(f.opened.length,0);assert.equal(f.transport.requests.length,0);f.restore();
 });
 await check('local version read failure reports an error without replacing it by another translation',async()=>{
  const f=localVersionFixture(async()=>{throw Error('no replacement');},async()=>{throw Error('unreadable version');});
  f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(f.transport.requests.length,0);assert.equal(f.opened.length,0);
  assert(f.win.document.body.allNodes().some(n=>n.className==='askgpt-pdf-error'));f.plugin.shutdown();f.restore();
 });
 await check('failure to save a new translation leaves its completed side by side output readable',async()=>{
  const f=localVersionFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job('complete',[0,1,2])),async()=>null,async()=>{throw Error('disk full');});
  f.output.numPages=3;f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);
  assert.equal(f.viewer.style.getPropertyValue('visibility'),'hidden');assert.equal(f.opened.length,0);assert.equal(f.plugin.state(f.reader).mode,'dual');f.plugin.shutdown();f.restore();
 });
 await check('already translated attachment does not retranslate itself or redirect to another tab',async()=>{
  const f=localVersionFixture(async()=>{throw Error('must not translate');},async()=>({alreadyTranslated:true}));
  f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(f.transport.requests.length,0);assert.equal(f.opened.length,0);assert.equal(f.plugin.state(f.reader).open,false);f.plugin.shutdown();f.restore();
 });
 await check('owned PDF input releases the fulfilled source promise and is reused across later starts',async()=>{
  const vm=require('node:vm'),foreign=vm.runInNewContext('new Uint8Array([37,80,68,70,45,49,10])');
  const wrapped=new Proxy(foreign,{get(target,key){if(key==='0'||key==='buffer')throw Error('returned Xray must be scoped before copying');return Reflect.get(target,key,target);}});
  const f=retainedInputFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()));let reads=0,copies=0;
  f.pdf.getData=async()=>{reads++;return wrapped;};f.transport.deps.Components.utils.waiveXrays=value=>{if(value===wrapped){copies++;return foreign;}return value;};
  try{
   f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);
   const session=f.context().session,owned=session.data;assert(owned instanceof Uint8Array);assert.notEqual(owned,foreign);assert.deepEqual([...owned],[37,80,68,70,45,49,10]);
   assert.equal(session.dataPromise,null,'the fulfilled getData promise must not retain another whole PDF after an owned copy exists');
   foreign[0]=0;f.restart();await settle(()=>f.transport.requests.filter(value=>value.method==='POST').length===2&&!f.plugin.state(f.reader).busy);
   f.restart(true);await settle(()=>f.transport.requests.filter(value=>value.method==='POST').length===3&&!f.plugin.state(f.reader).busy);
   assert.equal(reads,1);assert.equal(copies,1);assert.equal(session.data,owned);assert.equal(session.dataPromise,null);
   for(const request of f.transport.requests.filter(value=>value.method==='POST'))assert.deepEqual([...new Uint8Array(request.options.body)],[37,80,68,70,45,49,10]);
  }finally{f.plugin.shutdown();f.restore();}
 });
 await check('concurrent starts share pending getData but only the newest start copies and uploads it',async()=>{
  const ready=deferred(),f=retainedInputFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()));let reads=0,copies=0;
  const source=bytes();f.pdf.getData=()=>{reads++;return ready.promise;};f.transport.deps.Components.utils.waiveXrays=value=>{if(value===source)copies++;return value;};
  try{
   f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>reads===1);f.restart(true);await new Promise(setImmediate);assert.equal(reads,1);assert.equal(f.transport.requests.length,0);
   ready.resolve(source);await settle(()=>!f.plugin.state(f.reader).busy&&f.transport.requests.some(value=>value.method==='POST'));
   assert.equal(copies,1);assert.equal(reads,1);assert.equal(f.transport.requests.filter(value=>value.method==='POST').length,1);assert.equal(f.transport.requests.find(value=>value.method==='POST').options.headers['X-AskGPT-Pages'],'all');assert.equal(f.context().session.dataPromise,null);
  }finally{ready.resolve(source);f.plugin.shutdown();f.restore();}
 });
 await check('failed PDF reads and copies release pending input so a later start can read a fresh source',async()=>{
  for(const failure of ['read','copy']){
   const f=retainedInputFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()));let reads=0;
   f.pdf.getData=async()=>{if(++reads===1){if(failure==='read')throw Error('temporary PDF read failure');return new Uint8Array([1,2]);}return bytes();};
   try{
    f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(f.transport.requests.length,0);assert.equal(f.context().session.data,null);assert.equal(f.context().session.dataPromise,null,failure+' failure must not remain a retained rejected or unusable source');
    f.restart();await settle(()=>!f.plugin.state(f.reader).busy&&f.transport.requests.some(value=>value.method==='POST'));assert.equal(reads,2);assert.equal(f.transport.requests.filter(value=>value.method==='POST').length,1);assert.equal(f.context().session.dataPromise,null);
   }finally{f.plugin.shutdown();f.restore();}
  }
 });
 await check('closing a pending input cannot copy or upload it into a replacement session',async()=>{
  const ready=deferred(),source=bytes('%PDF-old\n'),replacement=bytes('%PDF-new\n'),f=retainedInputFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()));let reads=0,copies=0;
  f.pdf.getData=()=>{reads++;return reads===1?ready.promise:Promise.resolve(replacement);};f.transport.deps.Components.utils.waiveXrays=value=>{if(value===source||value===replacement)copies++;return value;};
  try{
   f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>reads===1);const previous=f.context().session;f.plugin.restore(f.reader);await f.plugin.toggle(f.reader);
   await settle(()=>!f.plugin.state(f.reader).busy&&f.transport.requests.some(value=>value.method==='POST'));const current=f.context().session,owned=current.data;assert.notEqual(current,previous);ready.resolve(source);await new Promise(setImmediate);
   assert.equal(previous.data,null);assert.equal(current.data,owned);assert.deepEqual([...owned],[...replacement]);assert.equal(copies,1);assert.equal(reads,2);assert.equal(f.transport.requests.filter(value=>value.method==='POST').length,1);assert.equal(current.dataPromise,null);
  }finally{ready.resolve(source);f.plugin.shutdown();f.restore();}
 });
 await check('figure controller cancels its crop and rejects retired output without sharing PDF ownership',async()=>{
  const modules={reader:require('../content/pdf-figure-reader.js'),region:require('../content/pdf-figure-region.js'),preview:require('../content/pdf-figure-preview.js'),store:require('../content/pdf-figure-markup-store.js')},original={install:modules.reader.install,render:modules.region.renderCrop,preview:modules.preview.create,store:modules.store.create};
  const renders=[],installed=[],opened=[],late=deferred();let cancellations=0,released=0;
  modules.reader.install=(view,options)=>{const handle={clear(){},dispose(){released++;},message(){},selectRegion(){}};installed.push({view,options,handle});return handle;};
  modules.region.renderCrop=options=>{renders.push(options);return {promise:late.promise,cancel(){cancellations++;}};};modules.preview.create=()=>({async open(value){opened.push(value);return true;},close(){},dispose(){}});modules.store.create=()=>({load:async()=>null,save:async()=>true});
  let f;try{f=controllerFixture(async()=>{throw Error('figure must not contact translation server');});f.reader._item={libraryID:1,key:'ABCDEFGH'};f.pdf.fingerprints=['a'.repeat(32)];f.reader._internalReader._primaryView._options={container:{ownerDocument:f.reader._iframeWindow.document}};f.reader._iframeWindow.document.defaultView=f.reader._iframeWindow;
   f.plugin.start();assert.equal(installed.length,1);assert(installed[0].options.enabled());const task=installed[0].options.onOpen({index:0,rect:[10,10,200,200],page:{},pageView:{},label:'Figure'});await settle(()=>renders.length===1);f.plugin.shutdown();assert.equal(cancellations,1);assert.equal(released,1);assert.equal(installed[0].options.enabled(),false);
   const canvas={width:400,height:400};late.resolve(canvas);await task;assert.equal(opened.length,0);assert.equal(canvas.width,0);assert.equal(canvas.height,0);assert.equal(f.transport.requests.length,0);
  }finally{modules.reader.install=original.install;modules.region.renderCrop=original.render;modules.preview.create=original.preview;modules.store.create=original.store;f?.plugin.shutdown();f?.restore();}
 });
 await check('native snapshot opens before detail rendering and retired detail work cannot revive a closed preview',async()=>{
  const names=['reader','bridge','preview','store','window'],modules=Object.fromEntries(names.map(n=>[n,require('../content/pdf-figure-'+(n==='store'?'markup-store':n)+'.js')])),original={reader:modules.reader.install,bridge:modules.bridge.create,preview:modules.preview.create,store:modules.store.create,window:modules.window.open};
  try{for(const mode of ['before-frame','during-detail','complete']){
   const installed=[],renders=[],opened=[],upgrades=[],frames=new Map(),detail=deferred();let nextFrame=0,cancels=0,preview,hostOptions;
   modules.reader.install=(view,options)=>{installed.push(options);return{clear(){},dispose(){},message(){}};};
   modules.bridge.create=()=>({render(index,rect,options){renders.push(options);return options?.snapshot===false?{promise:detail.promise,cancel(){cancels++;}}:{snapshot:true,renderMilliseconds:2,promise:Promise.resolve({width:400,height:200}),cancel(){}};},dispose(){}});
   modules.store.create=()=>({});modules.preview.create=options=>preview={isOpen:false,async open(value){opened.push(value);this.isOpen=true;return true;},upgradeCanvas(value){upgrades.push(value);return true;},close(){this.isOpen=false;options.onClosed();},dispose(){this.close();}};
   let f;try{
    f=controllerFixture(async()=>{throw Error('image preview never sends a translation request');},{controllerAdapter:{create(deps){deps.Services.scriptloader={};deps.rootURI='file:///fixture/';return adapter.create(deps);}}});
    const win=f.reader._iframeWindow;win.requestAnimationFrame=fn=>{const id=++nextFrame;frames.set(id,fn);return id;};win.cancelAnimationFrame=id=>frames.delete(id);win.document.defaultView=win;
    modules.window.open=async options=>{hostOptions=options;return{doc:win.document,win,close(){}};};
    f.reader._item={libraryID:1,key:'ABCDEFGH'};f.pdf.fingerprints=['a'.repeat(32)];f.reader._internalReader._primaryView._options={container:{ownerDocument:win.document}};
    f.plugin.start();await installed[0].onOpen({index:0,rect:[10,10,200,100],pageView:{},displayWidth:380,displayHeight:180});
    assert.equal(opened.length,1);assert.equal(renders.length,1,'HQ cannot delay the first mounted preview');assert.equal(frames.size,1);assert.equal(hostOptions.displayWidth,380);assert.equal(hostOptions.displayHeight,180);
    if(mode==='before-frame'){preview.close();assert.equal(frames.size,0);assert.equal(renders.length,1);continue;}
    const callbacks=[...frames.values()];frames.clear();callbacks.forEach(fn=>fn());await settle(()=>renders.length===2);assert.equal(renders[1].snapshot,false);
    if(mode==='during-detail')preview.close();const sharp={width:800,height:400};detail.resolve(sharp);await new Promise(setImmediate);
    assert.equal(upgrades.length,mode==='complete'?1:0);assert.equal(sharp.width,mode==='complete'?800:0);assert.equal(cancels,mode==='complete'?0:1);assert.equal(f.transport.requests.length,0);
   }finally{f?.plugin.shutdown();f?.restore();}
  }}finally{modules.reader.install=original.reader;modules.bridge.create=original.bridge;modules.preview.create=original.preview;modules.store.create=original.store;modules.window.open=original.window;}
 });
 await check('missing or partial CSS bounds use PDF points rather than high resolution bitmap pixels',async()=>{
  const names=['reader','bridge','preview','store','window'],modules=Object.fromEntries(names.map(n=>[n,require('../content/pdf-figure-'+(n==='store'?'markup-store':n)+'.js')])),original={reader:modules.reader.install,bridge:modules.bridge.create,preview:modules.preview.create,store:modules.store.create,window:modules.window.open};
  try{for(const value of [
   {canvas:[400,200],expected:[200,100]},
   {canvas:[800,400],expected:[200,100]},
   {canvas:[400,800],rotation:90,expected:[100,200]},
   {canvas:[400,800],rotation:270,expected:[100,200]},
   {canvas:[800,400],displayWidth:900,expected:[200,100]},
   {canvas:[800,400],displayHeight:900,expected:[200,100]},
   {canvas:[800,400],displayWidth:900,displayHeight:-1,expected:[200,100]},
   {canvas:[800,400],displayWidth:450,displayHeight:225,expected:[450,225]}
  ]){
   let installed,hostOptions;modules.reader.install=(_view,options)=>{installed=options;return{clear(){},dispose(){},message(){}};};
   modules.bridge.create=()=>({render(){return {snapshot:false,promise:Promise.resolve({width:value.canvas[0],height:value.canvas[1]}),cancel(){}};},dispose(){}});
   modules.store.create=()=>({});modules.preview.create=options=>({isOpen:false,async open(){this.isOpen=true;return true;},close(){this.isOpen=false;options.onClosed();},dispose(){this.close();}});
   let f;try{
    f=controllerFixture(async()=>{throw Error('image preview never sends a translation request');},{controllerAdapter:{create(deps){deps.Services.scriptloader={};deps.rootURI='file:///fixture/';return adapter.create(deps);}}});
    const win=f.reader._iframeWindow;win.document.defaultView=win;modules.window.open=async options=>{hostOptions=options;return{doc:win.document,win,close(){}};};
    f.reader._item={libraryID:1,key:'ABCDEFGH'};f.pdf.fingerprints=['a'.repeat(32)];f.reader._internalReader._primaryView._options={container:{ownerDocument:win.document}};
    f.plugin.start();await installed.onOpen({index:0,rect:[10,10,210,110],pageView:{viewport:{rotation:value.rotation||0}},...value});
    assert.deepEqual([hostOptions.displayWidth,hostOptions.displayHeight],value.expected);assert.equal(hostOptions.displayWidth/hostOptions.displayHeight,value.canvas[0]/value.canvas[1]);assert.equal(f.transport.requests.length,0);
   }finally{f?.plugin.shutdown();f?.restore();}
  }}finally{modules.reader.install=original.reader;modules.bridge.create=original.bridge;modules.preview.create=original.preview;modules.store.create=original.store;modules.window.open=original.window;}
 });
 await check('untranslated native PDF installs one local hover handle and persists its independent switch',async()=>{
  const hover=require('../content/pdf-hover-gloss.js'),original=hover.install,installs=[],prefs=new Map();
  const preferences={get:key=>prefs.get(key),set:(key,value)=>prefs.set(key,value)};
  hover.install=(view,options)=>{const handle={clears:0,disposed:0,clear(){this.clears++;},dispose(){this.disposed++;}};installs.push({view,options,handle});return handle;};
  const f=controllerFixture(async()=>{throw Error('opening a reader must not send lookup or PDF data');},{preferences});
  try{
   f.plugin.start();assert.equal(installs.length,1);assert.equal(installs[0].view,f.reader._internalReader._primaryView);
   assert.equal(installs[0].options.enabled(),true);assert.equal(f.transport.requests.length,0);
   f.plugin.setHoverEnabled(false);assert.equal(installs[0].options.enabled(),false);assert(installs[0].handle.clears>0);
   f.plugin.shutdown();assert.equal(installs[0].handle.disposed,1);f.restore();
   const next=controllerFixture(async()=>{throw Error('disabled hover must remain local');},{preferences});
   try{next.plugin.start();assert.equal(next.plugin.hoverEnabled(),false);assert.equal(installs.at(-1).options.enabled(),false);next.plugin.shutdown();}finally{next.restore();}
  }finally{hover.install=original;f.plugin.shutdown();f.restore();}
 });
 await check('PDF reader initialized after startup attaches hover when its toolbar becomes available exactly once',async()=>{
  const hover=require('../content/pdf-hover-gloss.js'),original=hover.install,installs=[];
  hover.install=(view,options)=>{const handle={clear(){},dispose(){}};installs.push({view,options,handle});return handle;};
  const f=controllerFixture(async()=>{throw Error('initializing a late reader must not send lookup or PDF data');});
  const internal=f.reader._internalReader;delete f.reader._internalReader;
  try{
   f.plugin.start();assert.equal(installs.length,0,'restored reader has not created its native view yet');
   internal._primaryView.initializedPromise=Promise.resolve();f.reader._internalReader=internal;
   const render=f.readerEvents.get('renderToolbar'),event={reader:f.reader,doc:f.reader._iframeWindow.document,append(){}};
   render(event);await Promise.resolve();await Promise.resolve();
   assert.equal(installs.length,1,'a later toolbar render must retry attachment for the now initialized native view');
   assert.equal(installs[0].view,internal._primaryView);assert.equal(installs[0].options.enabled(),true);
   render(event);await Promise.resolve();assert.equal(installs.length,1,'repeated toolbar renders must retain the same hover handle');
   assert.equal(f.transport.requests.length,0);
  }finally{hover.install=original;f.plugin.shutdown();f.restore();}
 });
 await check('a pending native PDF document retries hover on initialization with one promise subscription and one handle',async()=>{
  const hover=require('../content/pdf-hover-gloss.js'),original=hover.install,installs=[],ready=deferred();let subscriptions=0;
  hover.install=(view,options)=>{const handle={clear(){},dispose(){}};installs.push({view,options,handle});return handle;};
  const f=controllerFixture(async()=>{throw Error('waiting for a native document must not send lookup or PDF data');});
  const view=f.reader._internalReader._primaryView;view.initializedPromise={then(resolve,reject){subscriptions++;return ready.promise.then(resolve,reject);}};
  delete f.win.PDFViewerApplication.pdfDocument;
  try{
   f.plugin.start();assert.equal(installs.length,0);assert.equal(subscriptions,1);
   const render=f.readerEvents.get('renderToolbar'),event={reader:f.reader,doc:f.reader._iframeWindow.document,append(){}};
   render(event);render(event);assert.equal(subscriptions,1,'toolbar rerenders must not add promise callbacks for the same view');
   f.win.PDFViewerApplication.pdfDocument=f.pdf;ready.resolve();await settle(()=>installs.length===1);
   assert.equal(installs[0].view,view);render(event);await Promise.resolve();assert.equal(installs.length,1);
   assert.equal(subscriptions,1);assert.equal(f.transport.requests.length,0);
  }finally{hover.install=original;f.plugin.shutdown();f.restore();}
 });
 await check('a failed hover attachment retries on the next toolbar render without retaining a duplicate handle',async()=>{
  const hover=require('../content/pdf-hover-gloss.js'),original=hover.install,installs=[];let attempts=0;
  hover.install=(view,options)=>{attempts++;if(attempts===1)throw Error('synthetic transient attachment failure');const handle={disposals:0,clear(){},dispose(){this.disposals++;}};installs.push({view,options,handle});return handle;};
  const f=controllerFixture(async()=>{throw Error('retrying attachment must not send lookup or PDF data');});
  try{
   f.plugin.start();assert.equal(attempts,1);assert.equal(installs.length,0);
   const render=f.readerEvents.get('renderToolbar'),event={reader:f.reader,doc:f.reader._iframeWindow.document,append(){}};
   render(event);assert.equal(attempts,2);assert.equal(installs.length,1);assert.equal(installs[0].view,f.reader._internalReader._primaryView);
   render(event);render(event);await Promise.resolve();assert.equal(attempts,2);assert.equal(installs.length,1);
   assert.equal(f.transport.requests.length,0);f.plugin.shutdown();assert.equal(installs[0].handle.disposals,1);
  }finally{hover.install=original;f.plugin.shutdown();f.restore();}
 });
 await check('reading resumption preference survives a new controller without changing hover or translation state',()=>{
  const saved=new Map(),preferences={get:key=>saved.get(key),set:(key,value)=>saved.set(key,value)};
  const f=controllerFixture(async()=>{throw Error('reader preferences must stay local');},{preferences});
  try{f.plugin.start();const before=f.plugin.state(f.reader);assert.equal(f.plugin.resumeEnabled(),true);f.plugin.setResumeEnabled(false);assert.equal(f.plugin.resumeEnabled(),false);assert.equal(f.plugin.hoverEnabled(),true);assert.deepEqual(f.plugin.state(f.reader),before);assert.equal(saved.get('extensions.askgpt-inline.readingResume'),false);assert.equal(f.transport.requests.length,0);}finally{f.plugin.shutdown();f.restore();}
  const second=controllerFixture(async()=>{throw Error('reader preferences must stay local');},{preferences});try{second.plugin.start();assert.equal(second.plugin.resumeEnabled(),false);assert.equal(second.plugin.hoverEnabled(),true);}finally{second.plugin.shutdown();second.restore();}
 });
 // The native observer is replaced only to exercise its controller boundary.
 // Attachment identity, anchor validation and Prefs persistence stay real.
 const resumeAnchor=(extra={})=>({schema:1,fingerprint:'a'.repeat(32),pageCount:3,pageIndex:1,start:10,end:22,rects:[[20,30,80,40]],signature:'b'.repeat(64),capturedAt:1700000000100,...extra});
 function resumeWiringProbe(){
  const module=require('../content/pdf-reading-resume.js'),original=module.install,installs=[];
  module.install=(view,options)=>{const handle={clears:0,refreshes:0,disposals:0,inputs:0,stable:null,
   noteInput(){this.inputs++;},
   clear(){this.clears++;this.stable=null;},refresh(){this.refreshes++;},
   flush(){if(!this.stable)return false;const value=this.stable;this.stable=null;return options.save(value);},
   dispose(){this.disposals++;this.enabledAtDispose=options.enabled();this.flush();}};
   installs.push({view,options,handle});return handle;};
  return {installs,restore(){module.install=original;}};
 }
 await check('reading resumption wires real allowlisted attachment storage with independent switch and active-tab gates',()=>{
  const probe=resumeWiringProbe(),values=new Map(),accesses=[],key='extensions.askgpt-inline.readingResume.1.88RIH6NL';
  const other='extensions.askgpt-inline.readingResume.2.88RIH6NL',otherValue=JSON.stringify(resumeAnchor({pageIndex:2}));values.set(other,otherValue);
  const preferences={get(name,global){accesses.push({method:'get',name,global});return values.get(name);},set(name,value,global){accesses.push({method:'set',name,global});values.set(name,value);}};
  const f=controllerFixture(async()=>{throw Error('reading resumption must not use HTTP');},{preferences});
  f.reader._item={libraryID:1,key:'88RIH6NL',isAttachment:()=>true};let annotations=0;f.reader._internalReader._primaryView._onAddAnnotation=()=>{annotations++;};
  try{
   f.plugin.start();assert.equal(probe.installs.length,1,'an untranslated PDF must receive reading resumption');const installed=probe.installs[0];
   assert.equal(installed.options.load(),null);assert.equal(installed.options.enabled(),true);
   f.reader._window.document.hasFocus=()=>false;assert.equal(installed.options.enabled(),false,'a timed cue waits until its reader window has focus');f.reader._window.document.hasFocus=()=>true;assert.equal(installed.options.enabled(),true);
   assert.equal(installed.options.save(resumeAnchor({text:'PRIVATE_SOURCE_PROSE',path:'/PRIVATE/PDF',token:'PRIVATE_TOKEN'})),true);
   const stored=JSON.parse(values.get(key));assert.deepEqual(stored,resumeAnchor());assert(!values.get(key).includes('PRIVATE'));
   const loaded=installed.options.load();assert.deepEqual(loaded,resumeAnchor());loaded.rects[0][0]=999;assert.equal(installed.options.load().rects[0][0],20);
   f.plugin.setResumeEnabled(false);assert.equal(installed.options.enabled(),false);assert.equal(f.plugin.hoverEnabled(),true);assert(installed.handle.clears>0);assert(installed.handle.refreshes>0);
   f.plugin.setResumeEnabled(true);assert.equal(installed.options.enabled(),true);
   f.reader._window.Zotero_Tabs.selectedID='another-tab';assert.equal(installed.options.enabled(),false);
   f.reader._window.Zotero_Tabs.selectedID=f.reader.tabID;assert.equal(installed.options.enabled(),true);
   assert.equal(values.get(other),otherValue,'a matching attachment key in another library must remain independent');
   assert(accesses.filter(value=>value.name===key).every(value=>value.global===true));assert.equal(f.transport.requests.length,0);assert.equal(annotations,0);
  }finally{f.plugin.shutdown();probe.restore();f.restore();}
 });
 await check('reading resumption late-view wiring installs once and shutdown persists its last stable anchor through the real store',async()=>{
  const probe=resumeWiringProbe(),values=new Map(),key='extensions.askgpt-inline.readingResume.1.88RIH6NL';
  const preferences={get:name=>values.get(name),set:(name,value)=>values.set(name,value)};
  const f=controllerFixture(async()=>{throw Error('late attachment or shutdown must not use HTTP');},{preferences});
  f.reader._item={libraryID:1,key:'88RIH6NL',isAttachment:()=>true};const internal=f.reader._internalReader;delete f.reader._internalReader;
  try{
   f.plugin.start();assert.equal(probe.installs.length,0);internal._primaryView.initializedPromise=Promise.resolve();f.reader._internalReader=internal;
   const render=f.readerEvents.get('renderToolbar'),event={reader:f.reader,doc:f.reader._iframeWindow.document,append(){}};
   render(event);await Promise.resolve();await Promise.resolve();render(event);assert.equal(probe.installs.length,1);
   const installed=probe.installs[0];assert.equal(installed.view,internal._primaryView);installed.handle.stable=resumeAnchor({capturedAt:1700000000200,rawText:'PRIVATE_STABLE_SENTENCE'});
   f.plugin.shutdown();assert.equal(installed.handle.disposals,1);assert.equal(installed.handle.enabledAtDispose,false,'shutdown disables new capture before disposing the existing native observer');
   assert.deepEqual(JSON.parse(values.get(key)),resumeAnchor({capturedAt:1700000000200}));assert(!values.get(key).includes('PRIVATE'));assert.equal(f.transport.requests.length,0);
  }finally{f.plugin.shutdown();f.restore();}
  const next=controllerFixture(async()=>{throw Error('restoring progress must not use HTTP');},{preferences});next.reader._item={libraryID:1,key:'88RIH6NL',isAttachment:()=>true};
  try{next.plugin.start();assert.deepEqual(probe.installs.at(-1).options.load(),resumeAnchor({capturedAt:1700000000200}));assert.equal(next.transport.requests.length,0);}finally{next.plugin.shutdown();probe.restore();next.restore();}
 });
 await check('reading resumption records visible original and linked dual progress while translated-only and independent target input remain isolated',async()=>{
  const probe=resumeWiringProbe(),native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},values=new Map(),data=deferred();let actions;
  const f=controllerFixture(async()=>{throw Error('source-only mode gates must settle before any upload');},{preferences:{get:key=>values.get(key),set:(key,value)=>values.set(key,value)}});
  f.reader._item={libraryID:1,key:'88RIH6NL',isAttachment:()=>true};f.pdf.getData=()=>data.promise;let annotationWrites=0;f.reader._internalReader._primaryView._onAddAnnotation=()=>{annotationWrites++;};
  const layer={visible:false,scrollLinked:true,currentSourcePage:1,prepareOutput(){},setProgress(){},showOriginal(){this.visible=false;},restoreOriginal(){this.visible=false;},dispose(){}};
  native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};
  try{
   f.plugin.start();assert.equal(probe.installs.length,1);const installed=probe.installs[0];assert.equal(installed.options.enabled(),true);
   await f.plugin.toggle(f.reader);assert.equal(installed.options.enabled(),false,'original progress pauses as soon as a translated session starts');
   await f.plugin.setMode(f.reader,'original');assert.equal(installed.options.enabled(),true);
   await f.plugin.setMode(f.reader,'dual');assert.equal(installed.options.enabled(),true,'the original remains visible while paired reading is active');actions.readingInput();assert.equal(installed.handle.inputs,1);layer.scrollLinked=false;actions.readingInput();assert.equal(installed.handle.inputs,1,'independent translated motion cannot record an unrelated source sentence');layer.scrollLinked=true;
   await f.plugin.setMode(f.reader,'original');assert.equal(installed.options.enabled(),true);
   await f.plugin.setMode(f.reader,'mono');assert.equal(installed.options.enabled(),false);actions.readingInput();assert.equal(installed.handle.inputs,1);assert.equal(f.transport.requests.length,0);assert.equal(annotationWrites,0);
  }finally{f.plugin.shutdown();data.resolve(bytes());await Promise.resolve();native.canMount=original.canMount;native.mount=original.mount;probe.restore();f.restore();}
 });
 await check('a throwing observer disposal cannot retain a closed context and stable resume data flushes first',()=>{
  const probe=resumeWiringProbe(),values=new Map(),key='extensions.askgpt-inline.readingResume.1.88RIH6NL';
  const f=retainedInputFixture(async()=>{throw Error('unloading a reader cannot require HTTP');},{preferences:{get:name=>values.get(name),set:(name,value)=>values.set(name,value)}});f.reader._item={libraryID:1,key:'88RIH6NL',isAttachment:()=>true};
  try{
   f.plugin.start();const context=f.context(),installed=probe.installs[0],handle=installed.handle;handle.stable=resumeAnchor({capturedAt:1700000000700});
   let enabledAtFlush=null;const flush=handle.flush.bind(handle);handle.flush=()=>{if(handle.stable)enabledAtFlush=installed.options.enabled();return flush();};
   handle.dispose=()=>{handle.disposals++;throw Error('PRIVATE_RESUME_DISPOSE_FAILURE');};
   const hover=context.hover,disposeHover=hover.dispose.bind(hover);let hoverDisposals=0;hover.dispose=()=>{hoverDisposals++;disposeHover();throw Error('PRIVATE_HOVER_DISPOSE_FAILURE');};
   assert.doesNotThrow(()=>f.tabEvent('close'));assert.equal(enabledAtFlush,true,'stable data must flush before its context identity is retired');assert.deepEqual(JSON.parse(values.get(key)),resumeAnchor({capturedAt:1700000000700}));
   assert.equal(f.contextCount(),0);assert.equal(f.context(),null);assert.equal(f.win.listenerCount(),0);assert.equal(f.reader._iframeWindow.listenerCount(),0);assert.equal(f.reader._window.listenerCount(),1,'the app-wide shortcut belongs to the still-open main window');
   assert.doesNotThrow(()=>f.tabEvent('close'));assert.doesNotThrow(()=>f.win.emit('unload'));assert.equal(handle.disposals,1);assert.equal(hoverDisposals,1);
   const failures=f.diagnostics.filter(value=>value.stage==='nativeDispose');assert(failures.length>0);for(const value of failures)assert.deepEqual(JSON.parse(JSON.stringify(value.error)),{name:'Error',code:'compatibility'});assert(!JSON.stringify(f.diagnostics).includes('PRIVATE_'));
  }finally{try{f.plugin.shutdown();}catch(_){}probe.restore();f.restore();}
 });
 await check('resume cleanup and cancellation failures do not block remaining translation session disposal',async()=>{
  const f=retainedInputFixture(async(method)=>method==='DELETE'?{status:204}:json(job()));
  try{
   f.plugin.start();const context=f.context(),calls=[];context.resume.flush=()=>{calls.push('flush');throw Error('PRIVATE_FLUSH_FAILURE');};context.resume.clear=()=>{calls.push('clear');throw Error('PRIVATE_CLEAR_FAILURE');};
   context.hover.clear=()=>{calls.push('hover');throw Error('PRIVATE_HOVER_CLEAR_FAILURE');};
   context.session={epoch:0,outputEpoch:0,cancel(){calls.push('cancel');throw Error('PRIVATE_CANCEL_FAILURE');},job:{id:'job_cleanup_fixture',state:'running'},precision:{cancel(){calls.push('precision');throw Error('PRIVATE_PRECISION_FAILURE');}},cancelMount(){calls.push('mount');throw Error('PRIVATE_MOUNT_FAILURE');},removers:[()=>{calls.push('remove1');throw Error('PRIVATE_REMOVE_FAILURE');},()=>calls.push('remove2')],layer:{clearHover(){calls.push('layerHover');throw Error('PRIVATE_LAYER_HOVER_FAILURE');},dispose(){calls.push('dispose');}}};
   assert.doesNotThrow(()=>f.plugin.restore(f.reader));assert.equal(context.session,null);for(const action of ['flush','clear','hover','layerHover','cancel','precision','mount','remove1','remove2','dispose'])assert(calls.includes(action),action+' cleanup still runs');
   await settle(()=>f.transport.requests.some(value=>value.method==='DELETE'));assert.equal(f.transport.requests.filter(value=>value.method==='DELETE').length,1);assert.equal(f.plugin.state(f.reader).open,false);
   assert(!JSON.stringify(f.diagnostics).includes('PRIVATE_'));for(const value of f.diagnostics.filter(value=>value.stage==='nativeDispose'))assert.deepEqual(JSON.parse(JSON.stringify(value.error)),{name:'Error',code:'compatibility'});
  }finally{try{f.plugin.shutdown();}catch(_){}f.restore();}
 });
 await check('a PDF initialization completing after native tab unload cannot resurrect its controller',async()=>{
  const ready=deferred(),f=retainedInputFixture(async()=>{throw Error('late initialization cannot use HTTP');}),toolbar=toolbarFixture(f);f.reader._internalReader._primaryView.initializedPromise=ready.promise;
  try{
   f.plugin.start();assert.equal(f.contextCount(),1);f.tabEvent('close');assert.equal(f.contextCount(),0);assert.equal(toolbar.host.children.length,0);
   ready.resolve();await new Promise(setImmediate);assert.equal(f.contextCount(),0);assert.equal(toolbar.host.children.length,0);assert.equal(f.win.listenerCount(),0);assert.equal(f.reader._iframeWindow.listenerCount(),0);assert.equal(f.transport.requests.length,0);
  }finally{ready.resolve();f.plugin.shutdown();f.restore();}
 });
 await check('native unload removes focus and unload listeners using their original capture identity',()=>{
  const f=retainedInputFixture(async()=>{throw Error('listener cleanup cannot use HTTP');});
  // DOM listener identity includes capture; the small shared fake omits that rule.
  function nativeCaptureIdentity(target){
   const add=target.addEventListener.bind(target),remove=target.removeEventListener.bind(target),records=new Map(),capture=value=>value===true||value?.capture===true;
   target.addEventListener=(type,handler,options)=>{if(!records.has(type))records.set(type,new Map());records.get(type).set(handler,capture(options));add(type,handler,options);};
   target.removeEventListener=(type,handler,options)=>{const values=records.get(type);if(values?.has(handler)&&values.get(handler)===capture(options)){values.delete(handler);remove(type,handler,options);}};
  }
  for(const target of [f.win,f.reader._iframeWindow,f.reader._window])nativeCaptureIdentity(target);
  try{
   f.plugin.start();f.win.emit('unload');assert.equal(f.contextCount(),0);assert.equal(f.win.listenerCount(),0);assert.equal(f.reader._iframeWindow.listenerCount(),0);assert.equal(f.reader._window.listenerCount(),1);
   f.plugin.shutdown();assert.equal(f.reader._window.listenerCount(),0);
  }finally{f.plugin.shutdown();f.restore();}
 });
 await check('retired initialization and unload callbacks cannot modify a newer context for the same reader',async()=>{
  const oldReady=deferred(),newReady=deferred(),f=retainedInputFixture(async()=>{throw Error('context generations cannot use HTTP');}),toolbar=toolbarFixture(f),firstView=f.reader._internalReader._primaryView;firstView.initializedPromise=oldReady.promise;
  try{
   f.plugin.start();const previous=f.context(),oldUnload=previous.keyWindows.get(f.win).onUnload;f.tabEvent('close');assert.equal(f.contextCount(),0);
   f.reader._internalReader._primaryView={_iframeWindow:f.win,initializedPromise:newReady.promise};toolbar.render();const current=f.context(),listeners=f.win.listenerCount();assert.notEqual(current,previous);
   oldReady.resolve();await new Promise(setImmediate);assert.equal(f.context(),current);assert.equal(f.contextCount(),1);assert.equal(f.win.listenerCount(),listeners,'old initialization must not attach duplicate observers');
   oldUnload();assert.equal(f.context(),current,'a retired unload handler must not remove its replacement');assert.equal(f.win.listenerCount(),listeners);
   f.win.emit('unload');f.win.emit('unload');newReady.resolve();await new Promise(setImmediate);assert.equal(f.contextCount(),0);assert.equal(f.win.listenerCount(),0);assert.equal(f.reader._iframeWindow.listenerCount(),0);
  }finally{oldReady.resolve();newReady.resolve();f.plugin.shutdown();f.restore();}
 });
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
   f.plugin.restore(f.reader);assert.equal(disposed,1);assert.equal(entry.hidden,false);assert.equal(entry.style.getPropertyValue('display'),'');assert.equal(controls.parentNode,null);assert.equal(slot.children.length,1);assert.equal(slot.children[0].textContent,'翻译');assert(!slot.allNodes().some(node=>/预览本页图片|框选图片预览/.test(node.getAttribute?.('aria-label')||'')));
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
  return {get nativeZooms(){return nativeZooms;},get pluginListeners(){return wheelListeners.filter(x=>x.capture&&x.options?.passive===false);},
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
 await check('already translated attachment stays native without a failed translation session',async()=>{
  const f=controllerFixture(async()=>{throw {xmlhttp:{status:400,responseText:JSON.stringify({error:'already_translated'})}};});
  f.plugin.start();await f.plugin.toggle(f.reader);
  await settle(()=>f.win.document.body.allNodes().some(n=>n.className==='askgpt-pdf-error'));
  assert.equal(f.plugin.state(f.reader).open,false);
  assert.equal(f.plugin.state(f.reader).busy,false);
  assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');
  assert.equal(f.win.PDFViewerApplication.pdfDocument,f.pdf);
  const text=f.win.document.body.allNodes().find(n=>n.className==='askgpt-pdf-error').textContent;
  assert.match(text,/已是译文/);assert(!text.includes('失败'));
  assert.equal(f.transport.requests.filter(r=>r.method==='POST').length,1);
  assert.equal(f.transport.requests.filter(r=>r.url.endsWith('.pdf')).length,0);
  f.plugin.shutdown();f.restore();
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
  const toolbar=toolbarFixture(f);
  try{
   f.plugin.start();await f.plugin.translate(f.reader,{whole:true,mode:'mono'});await settle(()=>views.length===1&&!f.plugin.state(f.reader).busy);
   const menuFor=()=>outer.body.children.find(node=>node.getAttribute('role')==='menu');
   const wholeAction=()=>menuFor().allNodes().find(node=>node.getAttribute('title')==='Translate whole PDF · 整份');
   const menuButton=toolbar.host.allNodes().find(node=>node.getAttribute('aria-haspopup')==='menu');
   menuButton.emit('click');await Promise.resolve();assert(wholeAction());wholeAction().emit('click');await new Promise(setImmediate);
   assert.equal(f.transport.requests.filter(request=>request.method==='POST').length,1,'the whole-PDF toolbar action must reuse the completed session');
   assert.equal(f.transport.requests.filter(request=>request.url.endsWith('/mono.pdf')).length,1,'the loaded cached PDF must not download again');assert.equal(views.length,1);
   await f.plugin.original(f.reader);menuButton.emit('click');await Promise.resolve();wholeAction().emit('click');await settle(()=>!f.plugin.state(f.reader).original&&!f.plugin.state(f.reader).busy);
   assert.equal(f.transport.requests.filter(request=>request.method==='POST').length,1,'returning from original through the whole action must retain its completed job');assert.equal(views.length,1);
   const target=views[0];target._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber=3;target._options.onChangeViewState({pageIndex:2,left:20,top:650,scale:100});
   assert.equal(f.win.PDFViewerApplication.pdfViewer.currentPageNumber,2,'mono reading must leave the hidden source native viewer on its original page');assert.equal(f.reader._internalReader._state.primaryViewState.pageIndex,2);
   const more=toolbar.host.allNodes().find(node=>node.getAttribute('aria-haspopup')==='menu');assert(more);more.emit('click');await Promise.resolve();
   const menu=outer.body.children.find(node=>node.getAttribute('role')==='menu');assert(menu);assert.equal(menu.hidden,false);
   const current=menu.allNodes().find(node=>node.getAttribute('title')==='Translate current page · 本页');assert(current);assert.equal(menu.parentNode,outer.body,'auxiliary menu avoids toolbar overflow clipping');current.emit('click');
   await settle(()=>f.transport.requests.filter(request=>request.method==='POST').length===2&&!f.plugin.state(f.reader).busy);
   assert.deepEqual(f.transport.requests.filter(request=>request.method==='POST').map(request=>request.options.headers['X-AskGPT-Pages']),['all','3']);assert.equal(views.length,2);assert.equal(f.win.PDFViewerApplication.pdfViewer.currentPageNumber,2);
   await f.plugin.translate(f.reader,{whole:false,mode:'dual',direction:'en-zh'});
   assert.equal(f.plugin.state(f.reader).mode,'dual');assert.equal(f.transport.requests.filter(request=>request.method==='POST').length,2,'the current translated physical page is already cached even though the hidden source viewer has another page');assert.equal(views.length,2,'cached mode selection must retain the existing local native PDFView');
   f.win.PDFViewerApplication.pdfViewer.currentPageNumber=3;await f.plugin.original(f.reader);
   f.win.PDFViewerApplication.pdfDocument={...f.pdf};current.emit('click');await new Promise(setImmediate);
   assert.equal(f.plugin.state(f.reader).original,true,'a retired toolbar callback must not switch a replacement PDF to the old cached session');assert.equal(f.transport.requests.filter(request=>request.method==='POST').length,2);assert.equal(views.length,2);
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
 await check('cached PDF paints with layout before full metadata and hydrates once across display modes without GPT',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},paint=deferred(),full=deferred(),entered=deferred();let actions;const shows=[],updates=[],frames=[];
  const layout={...precisionAlignment(),sourceSHA256:'a'.repeat(64)},precise={...precisionAlignment(true),sourceSHA256:layout.sourceSHA256};
  const f=controllerFixture(async(method,url)=>{if(url.endsWith('/alignment-layout.json'))return json(layout);if(url.endsWith('/alignment.json')){entered.resolve();return full.promise;}if(url.endsWith('.pdf'))return {status:200,response:bytes().buffer};if(url.endsWith('/selection-alignment?page=1'))return json({jobID:job().id,page:1,sourceSHA256:layout.sourceSHA256,targetSHA256:'b'.repeat(64),links:[]});if(url.endsWith('/alignment-upgrade')||url.endsWith('/selection-alignment'))assert.fail('pending cached metadata must not trigger GPT');return json(job());});
  f.reader._iframeWindow.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};f.reader._iframeWindow.cancelAnimationFrame=()=>{};
  const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(){},updateAlignment(value){updates.push(value);return true;},async showOutput(data,pages,mode,mapping){shows.push({data,mode,mapping});this.visible=true;assert.equal(actions.align(1,{selection:{page:1}}),'pending');assert.equal(actions.page(1),'pending');await paint.promise;},showOriginal(){this.visible=false;},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
  native.canMount=()=>true;native.mount=async(context,css,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>shows.length===1);assert.equal(shows[0].mapping.granularity,'paragraph');assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment.json')).length,0);paint.resolve();await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(frames.length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment.json')).length,0);
   await f.plugin.setMode(f.reader,'dual');assert.equal(frames.length,1);assert.equal(shows[1].data,shows[0].data);frames[0]();await entered.promise;assert.equal(layer.visible,true);full.resolve(json(precise));await settle(()=>updates.length===1);assert.equal(updates[0].sourceSHA256,layout.sourceSHA256);assert.equal(updates[0].granularity,'sentence');assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment.json')).length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);assert.equal(shows.length,2);assert.equal(f.transport.requests.filter(r=>r.method==='POST').length,1);
  }finally{paint.resolve();full.resolve(json(precise));native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('cached metadata failures keep the PDF visible and explicit retry only reloads metadata',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};let actions,reads=0,restores=0;const updates=[],statuses=[],layout={...precisionAlignment(),sourceSHA256:'a'.repeat(64)},precise={...precisionAlignment(true),sourceSHA256:layout.sourceSHA256};
  const f=controllerFixture(async(method,url)=>{if(url.endsWith('/alignment-layout.json'))return json(layout);if(url.endsWith('/alignment.json'))return ++reads===1?{status:404,responseText:'{"error":"alignment_unavailable"}'}:json(precise);if(url.endsWith('.pdf'))return {status:200,response:bytes().buffer};if(url.endsWith('/alignment-upgrade')||url.endsWith('/selection-alignment'))assert.fail('metadata retry must remain read-only');return json(job());});
  const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(value){statuses.push(value);},updateAlignment(value){updates.push(value);return true;},async showOutput(){this.visible=true;actions.page(1);},restoreOriginal(){restores++;this.visible=false;},dispose(){this.visible=false;}};
  native.canMount=()=>true;native.mount=async(context,css,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>statuses.includes('failed'));assert.equal(layer.visible,true);assert.equal(restores,0);assert.equal(f.plugin.state(f.reader).busy,false);assert.equal(actions.align(1),'failed');assert.equal(actions.align(1,{explicit:true,selection:{page:1}}),'pending');await settle(()=>updates.length===1);assert.equal(reads,2);assert.equal(f.transport.requests.filter(r=>r.method==='POST').length,1);assert.equal(restores,0);
  }finally{native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('late or mismatched cached metadata cannot update another PDF or replace a readable layout',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};
  for(const change of ['sha','geometry','replace','close']){const full=deferred(),entered=deferred(),layout={...precisionAlignment(),sourceSHA256:'a'.repeat(64)};let actions,updates=0;const statuses=[];
   const f=controllerFixture(async(method,url)=>{if(url.endsWith('/alignment-layout.json'))return json(layout);if(url.endsWith('/alignment.json')){entered.resolve();return full.promise;}return url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(value){statuses.push(value);},updateAlignment(){updates++;},async showOutput(){this.visible=true;actions.page(1);},restoreOriginal(){this.visible=false;},dispose(){this.visible=false;}};
   native.canMount=()=>true;native.mount=async(context,css,value)=>{actions=value;return layer;};
   try{f.plugin.start();await f.plugin.toggle(f.reader);await entered.promise;if(change==='replace')f.win.PDFViewerApplication.pdfDocument={...f.pdf};if(change==='close')f.plugin.restore(f.reader);const value={...precisionAlignment(true),sourceSHA256:(change==='sha'?'c':'a').repeat(64)};if(change==='geometry')value.pages[0].paragraphs[0].target.rects[0][0]++;full.resolve(json(value));await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(updates,0);assert.equal(layer.visible,change!=='close');assert.equal(f.transport.requests.filter(r=>r.method==='POST').length,1);if(['sha','geometry'].includes(change))assert(statuses.includes('failed'));
   }finally{full.resolve(json(layout));native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
  }
 });
 await check('opening an intact legacy translation skips speculative precision but explicit alignment remains available',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};let actions,upgraded=false,shows=0;const updates=[],automatic=[];
  const f=controllerFixture(async(method,url)=>{
   if(url.endsWith('/alignment-upgrade')){if(method==='POST')upgraded=true;return json({id:job().id,state:upgraded?'complete':'idle',sourcePages:[1],completedPages:upgraded?[1]:[],mappedSentences:upgraded?1:0},method==='POST'?202:200);}
   return url.endsWith('/alignment.json')?json(precisionAlignment(upgraded)):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json({...job(),reusedLegacy:true,translationRevision:'pdf-layout-gpt-v5-aligned-visual'});
  });
  const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(){},async updateAlignment(value){updates.push(value);},async showOutput(){shows++;this.visible=true;automatic.push(actions.page(1));},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
  native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);await new Promise(setImmediate);assert.equal(shows,1);assert.deepEqual(automatic,['idle']);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-upgrade')).length,0);actions.align(1,{explicit:true});await settle(()=>updates.length===1);assert.equal(upgraded,true);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);assert.equal(shows,1);}finally{native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('cached page scrolling never upgrades or reloads the full mapping; explicit alignment remains available',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};let actions,upgraded=false;const updates=[],shows=[];
  const mapping=()=>{const value=precisionAlignment(upgraded);value.pages=[0,1,2].map((sourcePage,outputPage)=>{const page={...structuredClone(value.pages[0]),sourcePage,outputPage};if(sourcePage!==1)for(const row of page.paragraphs)delete row.sentences;return page;});return value;};
  const f=controllerFixture(async(method,url)=>{
   if(url.endsWith('/alignment-upgrade')){if(method==='POST')upgraded=true;return json({id:job().id,state:upgraded?'complete':'idle',sourcePages:[1],completedPages:upgraded?[1]:[],mappedSentences:upgraded?1:0},method==='POST'?202:200);}
   return url.endsWith('/alignment.json')?json(mapping()):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job('complete',[0,1,2]));
  });
  const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(){},updateAlignment(value){updates.push(value);},async showOutput(data){shows.push(data);this.visible=true;},restoreOriginal(){this.visible=false;},dispose(){this.visible=false;}};
  native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};
  try{
   f.plugin.start();await f.plugin.toggle(f.reader,{whole:true});await settle(()=>!f.plugin.state(f.reader).busy);
   const reads=f.transport.requests.filter(r=>r.url.endsWith('/alignment.json')).length;
   for(let i=0;i<30;i++){const page=i%3;actions.page(page);actions.align(page);}
   await new Promise(setImmediate);await new Promise(setImmediate);
   assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-upgrade')).length,0,'ordinary cross-page scrolling must not start alignment work');
   assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment.json')).length,reads,'scrolling must not parse another whole-document sidecar');assert.equal(updates.length,0);
   actions.align(1,{explicit:true});await settle(()=>updates.length===1);assert.equal(upgraded,true);assert.equal(shows.length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);assert.equal(f.transport.requests.filter(r=>r.method==='DELETE').length,0);
  }finally{native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('a cached false-full page repairs metadata on explicit alignment while a covered page needs no upgrade',async()=>{
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
    f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);await new Promise(setImmediate);
    assert.equal(results[0],stale?'idle':'ready');assert.equal(updates.length,0);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-upgrade')).length,0);actions.align(1,{explicit:true});if(stale)await settle(()=>updates.length===1);
    assert.equal(mounts,1);assert.equal(shows.length,1);assert.equal(f.renders.length,0);assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-upgrade')).length,1,'opening the completed cache must not start another PDF translation');assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);
    const metadata=f.transport.requests.filter(r=>r.url.endsWith('/alignment-upgrade'));assert.deepEqual(metadata.map(r=>r.method),stale?['GET','POST']:[]);assert.equal(updates.length,stale?1:0);assert.deepEqual(statuses,stale?['preparing',null]:[null]);
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
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus(value){statuses.push(value);},async updateAlignment(value){updates.push(value);},async showOutput(data,pages,mode,mapping){shows.push(mapping);this.visible=true;actions.align(1,{explicit:true});},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
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
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus(){},async updateAlignment(){updates++;},async showOutput(){this.visible=true;actions.align(1,{explicit:true});},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
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
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus(value){statuses.push(value);},async updateAlignment(value){updates.push(value);},async showOutput(data,pages,mode,mapping){shows.push({data,mode,mapping});this.visible=true;actions.align(1,shows.length===1?{explicit:true}:{});},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
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
 await check('explicit precision prepares only the selected page and probes its existing cache',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};let actions,posted=false,nextReady=false;const updates=[],shows=[];
  function mapping(){const value=precisionAlignment();value.pages=[0,1,2].map((sourcePage,outputPage)=>({...structuredClone(value.pages[0]),sourcePage,outputPage}));if(posted){value.granularity='sentence';value.sentenceAlignmentRevision='pdf-sentence-semantic-v1';value.sentencePages=nextReady?[1,2]:[1];value.phraseAlignmentRevision='pdf-phrase-semantic-v1';value.phrasePages=value.sentencePages.slice();for(const page of value.pages)if(value.sentencePages.includes(page.sourcePage))page.paragraphs[0].sentences=precisionAlignment(true).pages[0].paragraphs[0].sentences;}return markExtracted(value);}
  const f=controllerFixture(async(method,url)=>{
   if(url.endsWith('/alignment-upgrade')){if(method==='POST')posted=true;return json({id:job().id,state:posted?'running':'idle',sourcePages:[0,1,2],completedPages:posted?(nextReady?[1,2]:[1]):[],mappedSentences:posted?1:0},method==='POST'?202:200);}
   return url.endsWith('/alignment.json')?json(mapping()):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job('complete',[0,1,2]));
  });
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus(){},async updateAlignment(value){updates.push(value);},async showOutput(data,pages,mode,value){shows.push(value);this.visible=true;actions.page(1);actions.align(1,{explicit:true});},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
  native.canMount=()=>true;native.mount=async(context,css,value)=>{actions=value;return layer;};
  try{
   f.plugin.start();await f.plugin.toggle(f.reader,{whole:true});await settle(()=>updates.length===1&&!f.plugin.state(f.reader).busy);
   let posts=f.transport.requests.filter(r=>r.method==='POST'&&r.url.endsWith('/alignment-upgrade')&&r.options.headers['Content-Type']==='application/pdf');assert.equal(posts.length,1);assert.equal(posts[0].options.headers['X-AskGPT-Pages'],'2');assert.deepEqual(updates[0].sentencePages,[1]);
   nextReady=true;actions.page(2);actions.align(2,{explicit:true});await settle(()=>updates.length===2);assert.deepEqual(updates[1].sentencePages,[1,2]);
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
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus(){},async updateAlignment(value){updates.push(value);},async showOutput(){this.visible=true;actions.page(1);actions.align(1,{explicit:true});},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
  native.canMount=()=>true;native.mount=async(context,css,value)=>{actions=value;return layer;};
  try{
   f.plugin.start();await f.plugin.toggle(f.reader,{whole:true});await entered.promise;await settle(()=>!f.plugin.state(f.reader).busy);actions.page(2);actions.align(2,{explicit:true});
   await settle(()=>statusReads>=2);assert.equal(f.transport.requests.filter(r=>r.method==='DELETE').length,0);assert.equal(updates.length,0,'an old page cannot publish after the visible page changes');
   const posts=f.transport.requests.filter(r=>r.method==='POST'&&r.url.endsWith('/alignment-upgrade')&&r.options.headers['Content-Type']==='application/pdf');assert.equal(posts[0].options.headers['X-AskGPT-Pages'],'2');
  }finally{release.resolve();native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('failed precision stays quiet on stats, recovers from explicit retry and never retranslates or rebuilds',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},realNow=Date.now;let clock=10000,actions,posts=0,ready=false,mounts=0;const updates=[],statuses=[];Date.now=()=>clock;
  const f=controllerFixture(async(method,url)=>{if(url.endsWith('/alignment-upgrade')){if(method==='POST'){posts++;if(posts>1)ready=true;}return json({id:job().id,state:ready?'complete':method==='POST'?'failed':'idle',sourcePages:[1],completedPages:ready?[1]:[],mappedSentences:ready?1:0,...(!ready&&method==='POST'?{error:'alignment_timeout'}:{})},method==='POST'?202:200);}return url.endsWith('/alignment.json')?json(precisionAlignment(ready)):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus:value=>statuses.push(value),async updateAlignment(value){updates.push(value);},async showOutput(){this.visible=true;actions.align(1,{explicit:true});},restoreOriginal(){this.visible=false;},dispose(){},currentSourcePage:1};native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;mounts++;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>statuses.includes('failed')&&!f.plugin.state(f.reader).busy);for(let i=0;i<20;i++){actions.page(1);actions.align(1);}await new Promise(setImmediate);assert.equal(posts,1);assert(updates.length>=1,'a failed model turn must still reload successful partial sidecar checkpoints');actions.align(1,{explicit:true});assert.equal(statuses.at(-1),'retry_wait');assert.equal(posts,1);clock+=3000;actions.align(1,{explicit:true});await settle(()=>ready&&updates.at(-1)?.phraseExtractedPages?.includes(1));assert.equal(statuses.at(-1),null);assert.equal(posts,2);assert.equal(mounts,1);assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-upgrade')).length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);actions.align(1,{explicit:true});await new Promise(setImmediate);assert.equal(posts,2);
  }finally{Date.now=realNow;native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('successful partial word batches reach the native reader while the page is still preparing and survive a later timeout',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},release=deferred();let actions,step=0;const updates=[],statuses=[];
  const partial=precisionAlignment(true);partial.phraseExtractedPages=[];
  const f=controllerFixture(async(method,url)=>{if(url.endsWith('/alignment-upgrade')){if(step===0&&method==='GET')return json({id:job().id,state:'idle',sourcePages:[],completedPages:[],mappedSentences:0});if(method==='POST'){step=1;return json({id:job().id,state:'running',sourcePages:[1],completedPages:[],mappedSentences:0,alignmentVersion:'a'.repeat(64)},202);}if(step===1){step=2;return json({id:job().id,state:'running',sourcePages:[1],completedPages:[],mappedSentences:1,alignmentVersion:'b'.repeat(64)});}await release.promise;return json({id:job().id,state:'failed',sourcePages:[1],completedPages:[],mappedSentences:1,error:'alignment_timeout',alignmentVersion:'b'.repeat(64)});}return url.endsWith('/alignment.json')?json(step>=2?partial:precisionAlignment()):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus:value=>statuses.push(value),async updateAlignment(value){updates.push(value);},async showOutput(){this.visible=true;actions.align(1,{explicit:true});},restoreOriginal(){this.visible=false;},dispose(){},currentSourcePage:1};native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>updates.some(value=>value.phrasePages?.includes(1)));assert.equal(statuses.at(-1),'preparing');assert.equal(f.plugin.state(f.reader).busy,false);assert.equal(updates.at(-1).phraseExtractedPages.length,0,'partial exact links must never claim the entire page is ready');release.resolve();await settle(()=>statuses.at(-1)==='failed');assert(updates.at(-1).phrasePages.includes(1));assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-upgrade')).length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);
  }finally{release.resolve();native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('explicit precision retries have a bounded budget and retry only probes a cache completed elsewhere',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},realNow=Date.now;let clock=10000,actions,posts=0,externalReady=false;const statuses=[];Date.now=()=>clock;
  const f=controllerFixture(async(method,url)=>{if(url.endsWith('/alignment-upgrade')){if(method==='POST')posts++;return json({id:job().id,state:externalReady?'complete':method==='POST'?'failed':'idle',sourcePages:[1],completedPages:externalReady?[1]:[],mappedSentences:externalReady?1:0,...(!externalReady&&method==='POST'?{error:'alignment_timeout'}:{})},method==='POST'?202:200);}return url.endsWith('/alignment.json')?json(precisionAlignment(externalReady)):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus:value=>statuses.push(value),async updateAlignment(){},async showOutput(){this.visible=true;actions.align(1,{explicit:true});},restoreOriginal(){this.visible=false;},dispose(){},currentSourcePage:1};native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};
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
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus(){},async updateAlignment(value){updates.push(value);},async showOutput(){this.visible=true;actions.align(1,{explicit:true});},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
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
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy&&applied.length>0);actions.align(1,{explicit:true,selection:query});await entered.promise;actions.align(1,{explicit:true,selection:{...query,text:'文',rects:[[45,30,80,40]]}});assert.equal(actions.align(1,{explicit:true,selection:query}),'pending');late.resolve();await settle(()=>applied.some(value=>value.link?.id===link.id));assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/selection-alignment')).length,2);actions.page(1);actions.align(1,{explicit:true});await settle(()=>updates.length===1);assert.equal(applied.some(value=>value.link?.id===link.id),true);assert.equal(actions.align(1,{explicit:true,selection:query}),'ready');assert.equal(applied.at(-1).link.id,link.id);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/selection-alignment')).length,2);assert.equal(f.transport.requests.filter(r=>r.method==='DELETE').length,0);}
  finally{late.resolve();native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../manifest.json'),'utf8'));
 await check('Zotero 9 manifest and bootstrap load PDF layout before adapter',()=>{
  assert.equal(manifest.manifest_version,2);assert.equal(manifest.applications.zotero.id,'askgpt-inline@local.askgpt.reader');assert.equal(manifest.applications.zotero.strict_min_version,'9.0');assert.equal(manifest.applications.zotero.strict_max_version,'9.*');assert(new URL(manifest.applications.zotero.update_url).hostname==='127.0.0.1');
  const boot=fs.readFileSync(path.join(__dirname,'../bootstrap.js'),'utf8');assert(boot.indexOf("'content/pdf-layout.js'")<boot.indexOf("'content/inline.js'"));
 });
 clearTimeout(watchdog);process.stdout.write(JSON.stringify({status:'PASS',checks})+'\n');
})().catch(error=>{clearTimeout(watchdog);process.stderr.write(error.stack+'\n');process.exitCode=1;});
