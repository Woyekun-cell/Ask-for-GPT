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
 await check('PDF submission waits for the authenticated service before sending document bytes',async()=>{
  const gate=deferred(),entered=deferred(),f=transportFixture(async()=>json(job()));let probes=0;
  f.deps.ensurePDFReady=async(connection,current)=>{probes++;assert.equal(connection.token,'t'.repeat(64));assert.equal(current(),true);entered.resolve();await gate.promise;};
  const pending=adapter.createPDFTransport(f.deps).start(bytes(),{pages:'2',source:'en',target:'zh-Hans'});
  await Promise.race([entered.promise,new Promise(resolve=>setImmediate(resolve))]);
  assert.equal(probes,1);assert.equal(f.requests.length,0,'cold-start recovery cannot upload before ready');
  gate.resolve();assert.equal((await pending).state,'complete');assert.equal(f.requests.length,1);
 });
 await check('cancelling service recovery prevents a PDF submission after it becomes ready',async()=>{
  const gate=deferred(),entered=deferred(),f=transportFixture(async()=>json(job()));let cancel,current;
  f.deps.ensurePDFReady=async(_connection,isCurrent)=>{current=isCurrent;entered.resolve();await gate.promise;};
  const pending=adapter.createPDFTransport(f.deps).start(bytes(),{pages:'2',source:'en',target:'zh-Hans'},value=>{cancel=value;});
  const stopped=assert.rejects(pending,{code:'stopped'});await entered.promise;const retired=cancel();assert.equal(current(),false);gate.resolve();await retired;await stopped;assert.equal(f.requests.length,0);
 });
 await check('cached PDF opening has a cancellable connection gate without creating a translation job',async()=>{
  const gate=deferred(),entered=deferred(),f=transportFixture(async()=>assert.fail('connection gate cannot submit a job'));let cancel,current;
  f.deps.ensurePDFReady=async(_connection,isCurrent)=>{current=isCurrent;entered.resolve();await gate.promise;};
  const t=adapter.createPDFTransport(f.deps);assert.equal(typeof t.connect,'function');const pending=t.connect(value=>{cancel=value;});
  const stopped=assert.rejects(pending,{code:'stopped'});await entered.promise;cancel();assert.equal(current(),false);gate.resolve();await stopped;assert.equal(f.requests.length,0);
 });
 await check('unsafe configuration cannot launch recovery and an accepted POST is never replayed after disconnection',async()=>{
  const f=transportFixture(async()=>{throw {xmlhttp:{status:0}};});let probes=0;f.deps.ensurePDFReady=async()=>{probes++;};
  f.file.permissions=0o644;const t=adapter.createPDFTransport(f.deps);await assert.rejects(t.start(bytes(),{pages:'2',source:'en',target:'zh-Hans'}),{code:'permissions'});assert.equal(probes,0);
  f.file.permissions=0o600;await assert.rejects(t.start(bytes(),{pages:'2',source:'en',target:'zh-Hans'}),{code:'bridge'});assert.equal(probes,1);assert.equal(f.requests.length,1);
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
 function controllerFixture(request,{preferences=null,controllerAdapter=adapter,scheduler=null,readText=null,alignmentWork=false,ensurePDFReady=null}={}){
  // Historical controller fixtures predate the layout route. Make their
  // old-service behavior an explicit 404 rather than malformed modern JSON.
  const transport=transportFixture(async(method,url,options)=>{if(url.endsWith('/alignment-work')&&!alignmentWork)return json({error:'not_found'},404);if(!url.endsWith('/alignment-layout.json'))return request(method,url,options);let response;try{response=await request(method,url,options);}catch(error){if(!String(error.message).startsWith('Unexpected'))throw error;return {status:404,responseText:'{"error":"not_found"}'};}let value;try{value=JSON.parse(response.responseText);}catch(_){}return value?.id&&value?.state&&!value.schema?{status:404,responseText:'{"error":"not_found"}'}:response;}),layout=layoutFixture(),main=new DOM.Window(),events=new Map(),readerEvents=new Map(),reads=[],diagnostics=[];
  main.Zotero_Tabs={selectedID:'public-fixture'};
  const pdf={async getData(){reads.push('data');return bytes();},async getPageData(){throw Error('pure-text extraction must never run');}};
  const application=layout.win.PDFViewerApplication;application.pdfDocument=pdf;application.eventBus={on(name,fn){events.set(name,fn);},off(name,fn){if(events.get(name)===fn)events.delete(name);}};
  const reader={type:'pdf',tabID:'public-fixture',_window:main,_iframeWindow:new DOM.Window(),_internalReader:{_primaryView:{_iframeWindow:layout.win}}};
  let unregister=0,observer=null;const alerts=[];
  const deps={...transport.deps,css:'',pluginID:'fixture',reportDiagnostic:(stage,error)=>diagnostics.push({stage,error}),Services:{...transport.deps.Services,prompt:{alert:(...args)=>alerts.push(args)}},Zotero:{...transport.deps.Zotero,getMainWindow:()=>main,getMainWindows:()=>[main],Reader:{_readers:[reader],getByTabID:()=>reader,registerEventListener(type,callback){readerEvents.set(type,callback);},_unregisterEventListenerByPluginID(){unregister++;readerEvents.clear();}},Notifier:{registerObserver(value){observer=value;return 1;},unregisterObserver(){observer=null;}}}};
  if(preferences)deps.Zotero.Prefs=preferences;
  if(scheduler){deps.setTimer=scheduler.set;deps.clearTimer=scheduler.clear;}
  if(readText)deps.readText=readText;
  if(ensurePDFReady)deps.ensurePDFReady=ensurePDFReady;
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
 function localVersionFixture(request,load,find=async()=>({id:42}),translatedCreate=null,fixtureOptions={}){
  const vm=require('node:vm'),moduleFile=path.join(__dirname,'../content/inline.js'),opened=[];
  const sandbox={module:{exports:{}},require:require('node:module').createRequire(moduleFile),AskGPTPDFLocalVersion:{create:({Zotero})=>{Zotero.Reader.open=async(id,location)=>opened.push({id,location});return {find,load};}}};
  if(translatedCreate)sandbox.AskGPTPDFTranslatedAnnotations={create:translatedCreate};
  vm.runInNewContext(fs.readFileSync(moduleFile,'utf8'),sandbox,{filename:moduleFile});
  return {...controllerFixture(request,{...fixtureOptions,controllerAdapter:sandbox.module.exports}),opened};
 }
 const storedVersion=()=>({job:job('complete',[0,1,2]),output:bytes(),item:{id:42}});
 await check('an explicit translated-mode retry recovers a session whose connection failed before it had a job',async()=>{
  let probes=0;const f=controllerFixture(async(_method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()),{ensurePDFReady:async()=>{if(++probes===1)throw adapterPDFError('bridge');}});
  function adapterPDFError(code){return new (require('../content/pdf-layout.js').PDFError)(code);}
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(f.transport.requests.length,0);assert.equal(probes,1);await f.plugin.setMode(f.reader,'dual');await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(f.transport.requests.filter(r=>r.method==='POST').length,1);assert(probes>=2);assert(!f.win.document.body.allNodes().some(node=>node.className==='askgpt-pdf-error'));}finally{f.plugin.shutdown();f.restore();}
 });
 await check('opening a saved version waits for service recovery and closing it fences the pending load',async()=>{
  const gate=deferred(),entered=deferred();let loads=0,current;
  const f=localVersionFixture(async()=>assert.fail('cached opening cannot submit a translation'),async()=>{loads++;return storedVersion();},undefined,null,{ensurePDFReady:async(_connection,isCurrent)=>{current=isCurrent;entered.resolve();await gate.promise;}});
  try{f.plugin.start();await f.plugin.toggle(f.reader);await entered.promise;assert.equal(loads,0);assert.equal(f.plugin.state(f.reader).busy,true);f.plugin.restore(f.reader);assert.equal(current(),false);gate.resolve();await new Promise(setImmediate);assert.equal(loads,0);assert.equal(f.plugin.state(f.reader).open,false);assert.equal(f.transport.requests.length,0);}finally{gate.resolve();f.plugin.shutdown();f.restore();}
 });
 await check('saved Chinese version loads in the existing side by side session without a new tab or translation job',async()=>{
  const f=localVersionFixture(async()=>{throw Error('local PDF must not use transport');},async()=>storedVersion());
  f.output.numPages=3;f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);
  assert.equal(f.plugin.state(f.reader).mode,'dual');assert.equal(f.plugin.state(f.reader).whole,true);assert.equal(f.plugin.state(f.reader).open,true);
  assert.equal(f.opened.length,0);assert.equal(f.transport.requests.length,0);assert.equal(f.viewer.style.getPropertyValue('visibility'),'hidden');
  f.plugin.shutdown();f.restore();
 });
 await check('local native split keeps toolbar mounted and reuses version bytes across mode changes without PDF downloads',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},shows=[],frames=[];let probes=0;
  const layout={...precisionAlignment(),sourceSHA256:'a'.repeat(64)};layout.pages=[0,1,2].map(i=>({...layout.pages[0],sourcePage:i,outputPage:i,paragraphs:[]}));
  const f=localVersionFixture(async(method,url)=>{assert.equal(method,'GET');assert(!url.endsWith('.pdf'));if(url.endsWith('/alignment-layout.json'))return json(layout);return json({jobID:job().id,page:1,sourceSHA256:layout.sourceSHA256,targetSHA256:'b'.repeat(64),links:[]});},async()=>storedVersion(),undefined,null,{ensurePDFReady:async()=>{probes++;}});
  const toolbar=toolbarFixture(f),controls=toolbar.doc.createElementNS('http://www.w3.org/1999/xhtml','span');let disposals=0;
  const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(){},attachToolbar(host){host.appendChild(controls);return true;},async showOutput(data,pages,mode,mapping){shows.push({data,pages,mode,mapping});this.visible=true;},showOriginal(){this.visible=false;},restoreOriginal(){this.visible=false;},dispose(){disposals++;controls.remove();}};
  native.canMount=()=>true;native.mount=async()=>layer;f.reader._iframeWindow.requestAnimationFrame=fn=>{frames.push(fn);return frames.length;};f.reader._iframeWindow.cancelAnimationFrame=()=>{};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(shows[0].mode,'dual');assert.deepEqual([...shows[0].data],[...bytes()]);assert.equal(controls.parentNode,toolbar.host.children[0]);assert.equal(disposals,0);assert.equal(f.opened.length,0);assert.equal(frames.length,1);
   await f.plugin.setMode(f.reader,'original');assert.equal(controls.parentNode,toolbar.host.children[0]);await f.plugin.setMode(f.reader,'dual');assert.equal(shows[1].data,shows[0].data);assert.equal(probes,2,'explicit cached-mode opening rechecks the helper after an update');assert.equal(f.transport.requests.filter(r=>r.method==='POST'||r.url.endsWith('.pdf')).length,0);
  }finally{native.canMount=original.canMount;native.mount=original.mount;f.plugin.shutdown();f.restore();}
 });
 await check('passive legacy local Chinese PDF opens native dual with no missing-job request or model and keeps its own annotations',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},shows=[],progress=[],store={key:'owned-chinese-store'};let actions;
  const f=localVersionFixture(async()=>assert.fail('legacy local PDF cannot use backend'),async()=>({...storedVersion(),alignmentKnownMissing:true}),async()=>({id:42}),async()=>store),toolbar=toolbarFixture(f),control=toolbar.doc.createElementNS('http://www.w3.org/1999/xhtml','span');
  const layer={visible:false,currentSourcePage:1,nativeView:{},scrollLinked:true,prepareOutput(){},setProgress(){},setAnnotationStatus(){},setAlignmentProgress(value){progress.push(value);},attachToolbar(host){host.appendChild(control);return true;},async showOutput(data,pages,mode,mapping,options){shows.push({data,pages,mode,mapping,options});this.visible=true;},showOriginal(){this.visible=false;},restoreOriginal(){this.visible=false;},dispose(){this.visible=false;control.remove();},retrySelection(){return false;}};
  native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(shows.length,1,'legacy local bytes must reach the native dual reader');assert.equal(shows[0].mode,'dual');assert.equal(shows[0].mapping,null);assert.deepEqual({...shows[0].options},{geometryOnly:true});assert.equal(actions.translatedAnnotations(),store);assert.equal(control.parentNode,toolbar.host.children[0]);assert.equal(actions.align(1,{explicit:true,selection:{page:1,paragraph:'p',side:'source',text:'text',rects:[[0,0,10,10]]}}),'unavailable');actions.page(2);await actions.resume();await f.plugin.setMode(f.reader,'original');await f.plugin.setMode(f.reader,'mono');await f.plugin.setMode(f.reader,'dual');assert.equal(f.transport.requests.length,0);assert.equal(f.opened.length,0);assert(shows.every(value=>value.mapping===null&&value.options?.geometryOnly===true));assert(shows.every(value=>value.data===shows[0].data));assert(progress.every(value=>value===null),'legacy has no invented background progress');assert.equal(control.parentNode,toolbar.host.children[0]);}finally{native.canMount=original.canMount;native.mount=original.mount;f.plugin.shutdown();f.restore();}
 });
 await check('closing a legacy local load fences its late result without a reader or server side effect',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},gate=deferred(),entered=deferred(),shows=[];
  const f=localVersionFixture(async()=>assert.fail('late legacy load cannot reach backend'),async()=>{entered.resolve();return gate.promise;});const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},async showOutput(...args){shows.push(args);this.visible=true;},restoreOriginal(){},showOriginal(){},dispose(){}};native.canMount=()=>true;native.mount=async()=>layer;
  try{f.plugin.start();await f.plugin.toggle(f.reader);await entered.promise;f.plugin.restore(f.reader);gate.resolve({...storedVersion(),alignmentKnownMissing:true});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(shows.length,0);assert.equal(f.transport.requests.length,0);assert.equal(f.plugin.state(f.reader).open,false);}finally{native.canMount=original.canMount;native.mount=original.mount;f.plugin.shutdown();f.restore();}
 });
 await check('a local PDF with alignment metadata reports missing job without silently borrowing proof or retranslating',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},shows=[];
  const f=localVersionFixture(async(method,url)=>{assert.equal(method,'GET');assert(url.endsWith('/alignment-layout.json'));throw {xmlhttp:{status:404,responseText:'{"error":"job_not_found"}'}};},async()=>storedVersion());const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},async showOutput(...args){shows.push(args);this.visible=true;},restoreOriginal(){},showOriginal(){},dispose(){}};native.canMount=()=>true;native.mount=async()=>layer;
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(shows.length,0);assert.equal(f.transport.requests.length,1);assert(f.diagnostics.some(value=>value.stage==='output'&&value.error?.code==='job_missing'));assert(!f.diagnostics.some(value=>value.error?.code==='bridge'));}finally{native.canMount=original.canMount;native.mount=original.mount;f.plugin.shutdown();f.restore();}
 });
 async function legacyEnrollmentFixture(options={}){
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},sourceSHA='a'.repeat(64),targetSHA='b'.repeat(64),store={key:'legacy-own-store'},shows=[],statuses=[],progress=[],events=[],postGate=deferred(),layoutGate=deferred();let actions,fail=options.failPost===true,mounts=0,layoutCalls=0;
  const candidate={...precisionAlignment(),provenance:'pdf-glyph-candidates',recoveryRevision:options.badMapping==='revision'?'wrong':'pdf-glyph-candidates-v1',sourceSHA256:options.badMapping==='source'?'c'.repeat(64):sourceSHA,targetSHA256:options.badMapping==='target'?'c'.repeat(64):targetSHA};candidate.pages=[0,1,2].map((sourcePage,outputPage)=>({...candidate.pages[0],sourcePage,outputPage,paragraphs:[]}));
  const state={id:job().id,state:'complete',sourcePages:[0,1,2],completedPages:[],preparedPages:[0,1,2],partialPages:[0,1,2],mappedSentences:0,currentPage:null,pendingPages:[],durable:true,eligible:true,workState:'partial',alignmentVersion:'d'.repeat(64)};
  const local={...storedVersion(),sourceSHA256:sourceSHA,alignmentKnownMissing:true,alignmentBinding:{sourceLanguage:'en',targetLanguage:'zh-Hans',targetSHA256:targetSHA,targetBytes:bytes().byteLength}};
  const f=localVersionFixture(async(method,url,request)=>{events.push({method,url,headers:request.headers});if(url.endsWith('/alignment-work')){if(method==='POST'){if(options.holdPost)await postGate.promise;if(fail)throw {xmlhttp:{status:503,responseText:'{"error":"runtime_missing"}'}};}return json(state,method==='POST'?202:200);}if(url.endsWith('/alignment-layout.json')){const ordinal=++layoutCalls;if(options.holdLayout||options.holdFirstLayout&&ordinal===1){await layoutGate.promise;if(options.failFirstLayout&&ordinal===1)throw {xmlhttp:{status:503,responseText:'{"error":"runtime_missing"}'}};}return json(candidate);}if(url.includes('/alignment-page.json?'))return json(candidate);if(url.includes('/selection-alignment?'))return json({jobID:job().id,page:Number(url.split('=').at(-1)),sourceSHA256:sourceSHA,targetSHA256:targetSHA,revision:'pdf-selection-semantic-v1',links:[]});assert.fail('legacy enrollment cannot translate or download another PDF: '+method+' '+url);},async()=>local,undefined,async()=>store,{alignmentWork:true});
  const layer={visible:false,currentSourcePage:1,nativeView:{},prepareOutput(){},setProgress(){},setStatus(value){statuses.push(value);},setAnnotationStatus(){},setAlignmentProgress(value){progress.push(value);},updateAlignment(){},updateSelectionLinks(){},async showOutput(data,pages,mode,mapping,settings){shows.push({data,pages,mode,mapping,settings});if(options.rejectCandidate&&mapping?.provenance==='pdf-glyph-candidates'){this.visible=false;throw {code:'compatibility'};}this.visible=mode!=='original';this.setStatus('');},showOriginal(){this.visible=false;},restoreOriginal(){this.visible=false;},dispose(){this.visible=false;}};
  native.canMount=()=>true;native.mount=async(_c,_css,value)=>{mounts++;actions=value;return layer;};
  try{f.plugin.start();await f.plugin.translate(f.reader,{whole:true});await settle(()=>!f.plugin.state(f.reader).busy);}catch(error){native.canMount=original.canMount;native.mount=original.mount;f.plugin.shutdown();f.restore();throw error;}
  return {...f,local,layer,shows,statuses,progress,events,get actions(){return actions;},get mounts(){return mounts;},releasePost(){postGate.resolve();},releaseLayout(){layoutGate.resolve();},retryAllowed(){fail=false;},done(){postGate.resolve();layoutGate.resolve();native.canMount=original.canMount;native.mount=original.mount;f.plugin.shutdown();f.restore();}};
 }
 await check('explicit whole legacy cache enrolls exact mono binding then adopts candidate metadata in the same PDF and own store',async()=>{const f=await legacyEnrollmentFixture();try{await settle(()=>f.shows.some(value=>value.mapping?.provenance==='pdf-glyph-candidates'));assert.equal(f.events.filter(e=>e.method==='POST').length,1);const posted=f.events.find(e=>e.method==='POST');assert.equal(posted.headers['X-AskGPT-Source-Language'],'en');assert.equal(posted.headers['X-AskGPT-Target-Language'],'zh-Hans');assert.equal(posted.headers['X-AskGPT-Target-SHA256'],f.local.alignmentBinding.targetSHA256);assert.equal(posted.headers['X-AskGPT-Target-Bytes'],String(f.local.output.byteLength));assert.equal(f.shows[0].mapping,null);assert.equal(f.shows[0].settings.geometryOnly,true);assert(f.shows.every(value=>value.data===f.shows[0].data));assert(f.shows.every(value=>value.mode==='dual'));assert.equal(f.mounts,1);assert.equal(f.actions.translatedAnnotations().key,'legacy-own-store');assert.equal(f.opened.length,0);await settle(()=>f.progress.some(value=>value?.state==='partial'));}finally{f.done();}});
 await check('legacy enrollment or candidate binding failures stay readable and show a bottom notice without false correspondence',async()=>{for(const options of [{failPost:true},{badMapping:'target'},{badMapping:'source'},{badMapping:'revision'}]){const f=await legacyEnrollmentFixture(options);try{await settle(()=>f.statuses.some(value=>typeof value==='string'&&value.includes('对应')));assert.equal(f.layer.visible,true);assert(f.shows.every(value=>value.mapping===null&&value.settings?.geometryOnly===true));assert(!f.win.document.body.allNodes().some(node=>node.className==='askgpt-pdf-error'));assert(!f.events.some(e=>e.method==='POST'&&!e.url.endsWith('/alignment-work')));await f.plugin.setMode(f.reader,'original');await f.plugin.setMode(f.reader,'dual');assert.equal(f.layer.visible,true);assert(f.statuses.at(-1).includes('对应'));}finally{f.done();}}});
 await check('native rejection of adopted candidates restores the same readable geometry PDF and its independent notes',async()=>{const f=await legacyEnrollmentFixture({rejectCandidate:true});try{await settle(()=>f.shows.some(value=>value.mapping?.provenance==='pdf-glyph-candidates')&&!f.plugin.state(f.reader).busy);assert.equal(f.layer.visible,true);assert.equal(f.shows.at(-1).mapping,null);assert.equal(f.shows.at(-1).settings.geometryOnly,true);assert(f.shows.every(value=>value.data===f.shows[0].data));assert.equal(f.actions.translatedAnnotations().key,'legacy-own-store');assert.equal(f.mounts,1);assert(f.statuses.at(-1).includes('对应'));assert(!f.win.document.body.allNodes().some(node=>node.className==='askgpt-pdf-error'));assert.equal(f.events.filter(e=>e.method==='POST').length,1);assert(!f.events.some(e=>e.method==='DELETE'));}finally{f.done();}});
 await check('closing an accepted legacy registration cannot load or apply its late candidate view',async()=>{const f=await legacyEnrollmentFixture({holdPost:true});try{await settle(()=>f.events.some(e=>e.method==='POST'));f.plugin.restore(f.reader);f.releasePost();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.shows.length,1);assert(!f.events.some(e=>e.url.endsWith('/alignment-layout.json')));assert(!f.events.some(e=>e.method==='DELETE'));assert.equal(f.plugin.state(f.reader).open,false);}finally{f.done();}});
 await check('a retired registration metadata failure cannot overwrite a later successful full action on the same cached job',async()=>{const f=await legacyEnrollmentFixture({holdFirstLayout:true,failFirstLayout:true});try{await settle(()=>f.events.some(e=>e.url.endsWith('/alignment-layout.json')));await f.plugin.translate(f.reader,{whole:true});await settle(()=>f.shows.some(value=>value.mapping?.provenance==='pdf-glyph-candidates'));const count=f.statuses.length;f.releaseLayout();await new Promise(resolve=>setTimeout(resolve,5));assert(!f.statuses.slice(count).some(value=>value.includes('未能')||value.includes('暂未')));assert.equal(f.layer.visible,true);}finally{f.done();}});
 await check('a candidate response arriving in original mode waits for a later translated presentation',async()=>{const f=await legacyEnrollmentFixture({holdLayout:true});try{await settle(()=>f.events.some(e=>e.url.endsWith('/alignment-layout.json')));await f.plugin.setMode(f.reader,'original');f.releaseLayout();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.layer.visible,false);assert.equal(f.shows.length,1);await f.plugin.setMode(f.reader,'dual');await settle(()=>f.shows.some(value=>value.mapping?.provenance==='pdf-glyph-candidates'));assert(f.shows.every(value=>value.data===f.shows[0].data));}finally{f.done();}});
 await check('a new whole translation saves its Chinese version while keeping the existing reading session',async()=>{
  let saves=0;const f=localVersionFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job('complete',[0,1,2])),async()=>null,async()=>{saves++;return {id:43};});
  f.output.numPages=3;f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);
  assert.equal(saves,1);assert.equal(f.opened.length,0);assert.equal(f.plugin.state(f.reader).mode,'dual');assert.equal(f.plugin.state(f.reader).open,true);
  assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-work')).length,1);f.plugin.shutdown();f.restore();
 });
 await check('translated annotations bind to the saved translated attachment before its native output opens',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};
  for(const saved of [true,false]){
   let actions,bound=null;const manager={annotations:[]},shown=[];
   const layout={...precisionAlignment(),sourceSHA256:'a'.repeat(64)};layout.pages=[0,1,2].map(i=>({...layout.pages[0],sourcePage:i,outputPage:i,paragraphs:[]}));
   const f=localVersionFixture(async(method,url)=>url.endsWith('/alignment-layout.json')?json(layout):url.endsWith('/alignment.json')?json(layout):url.includes('/selection-alignment?')?json({jobID:job().id,page:1,sourceSHA256:layout.sourceSHA256,targetSHA256:'b'.repeat(64),links:[]}):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job('complete',[0,1,2])),async()=>saved?storedVersion():null,async()=>({id:43}),async({Zotero,item})=>{assert.equal(typeof Zotero.HTTP.request,'function');bound=item;return manager;});
   const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(){},setStatus(){},async showOutput(){assert.equal(actions.translatedAnnotations(),manager);shown.push(true);this.visible=true;},showOriginal(){this.visible=false;},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
   native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;assert.equal(actions.translatedAnnotations(),null);return layer;};
   try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(bound.id,saved?42:43);assert.equal(shown.length,1);assert.equal(actions.translatedAnnotations(),manager);await f.plugin.setMode(f.reader,'original');await f.plugin.setMode(f.reader,'dual');assert.equal(actions.translatedAnnotations(),manager);assert.equal(shown.length,2);}
   finally{native.canMount=original.canMount;native.mount=original.mount;f.plugin.shutdown();f.restore();}
  }
 });
 await check('translated annotation load failures leave the completed PDF readable and explicitly disable saving',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};
  for(const create of [async()=>{throw Error('private storage failure');},async()=>null]){
   let actions,restored=0;const statuses=[],layout={...precisionAlignment(),sourceSHA256:'a'.repeat(64)};layout.pages=[0,1,2].map(i=>({...layout.pages[0],sourcePage:i,outputPage:i,paragraphs:[]}));
   const f=localVersionFixture(async(method,url)=>url.endsWith('/alignment-layout.json')||url.endsWith('/alignment.json')?json(layout):json({jobID:job().id,page:1,sourceSHA256:layout.sourceSHA256,targetSHA256:'b'.repeat(64),links:[]}),async()=>storedVersion(),undefined,create);
   const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(){},setStatus(value){statuses.push(value);},async showOutput(){this.visible=true;},restoreOriginal(){restored++;this.visible=false;},dispose(){}};
   native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};
   try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(layer.visible,true);assert.equal(restored,0);assert.equal(actions.translatedAnnotations(),null);assert.equal(statuses.at(-1),'译文标注保存暂不可用');assert(f.diagnostics.some(value=>value.stage==='translatedAnnotations'&&value.error?.code==='local_version_save'));assert(!JSON.stringify(f.diagnostics).includes('private storage failure'));}
   finally{native.canMount=original.canMount;native.mount=original.mount;f.plugin.shutdown();f.restore();}
  }
 });
 await check('a superseded annotation-store load cannot publish into the replacement translated session',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},entered=deferred(),late=deferred(),first={annotations:[]},second={annotations:[]},shown=[];let actions,disposals=0;
  first.dispose=second.dispose=()=>{disposals++;};const layout={...precisionAlignment(),sourceSHA256:'a'.repeat(64)};layout.pages=[0,1,2].map(i=>({...layout.pages[0],sourcePage:i,outputPage:i,paragraphs:[]}));
  const f=localVersionFixture(async(method,url)=>url.endsWith('/alignment-layout.json')||url.endsWith('/alignment.json')?json(layout):json({jobID:job().id,page:1,sourceSHA256:layout.sourceSHA256,targetSHA256:'b'.repeat(64),links:[]}),async(_reader,direction)=>({...storedVersion(),item:{id:direction==='en-zh'?42:43}}),undefined,async({item})=>{if(item.id===42){entered.resolve();await late.promise;return first;}return second;});
  const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(){},setStatus(){},async showOutput(){shown.push(actions.translatedAnnotations());this.visible=true;},restoreOriginal(){this.visible=false;},dispose(){}};
  native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await entered.promise;assert.equal(actions.translatedAnnotations(),null);actions.direction('zh-en');assert.equal(actions.translatedAnnotations(),null);await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(actions.translatedAnnotations(),second);late.resolve();await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(actions.translatedAnnotations(),second);assert.deepEqual(shown,[second]);assert.equal(disposals,0);f.plugin.shutdown();assert.equal(disposals,0);}
  finally{late.resolve();native.canMount=original.canMount;native.mount=original.mount;f.plugin.shutdown();f.restore();}
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
   foreign[0]=0;f.restart();await settle(()=>f.transport.requests.filter(value=>value.method==='POST'&&!value.url.endsWith('/alignment-work')).length===2&&!f.plugin.state(f.reader).busy);
   f.restart(true);await settle(()=>f.transport.requests.filter(value=>value.method==='POST'&&!value.url.endsWith('/alignment-work')).length===3&&!f.plugin.state(f.reader).busy);
   assert.equal(reads,1);assert.equal(copies,1);assert.equal(session.data,owned);assert.equal(session.dataPromise,null);
   for(const request of f.transport.requests.filter(value=>value.method==='POST'&&!value.url.endsWith('/alignment-work')))assert.deepEqual([...new Uint8Array(request.options.body)],[37,80,68,70,45,49,10]);
  }finally{f.plugin.shutdown();f.restore();}
 });
 await check('concurrent starts share pending getData but only the newest start copies and uploads it',async()=>{
  const ready=deferred(),f=retainedInputFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()));let reads=0,copies=0;
  const source=bytes();f.pdf.getData=()=>{reads++;return ready.promise;};f.transport.deps.Components.utils.waiveXrays=value=>{if(value===source)copies++;return value;};
  try{
   f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>reads===1);f.restart(true);await new Promise(setImmediate);assert.equal(reads,1);assert.equal(f.transport.requests.length,0);
   ready.resolve(source);await settle(()=>!f.plugin.state(f.reader).busy&&f.transport.requests.some(value=>value.method==='POST'));
   assert.equal(copies,1);assert.equal(reads,1);assert.equal(f.transport.requests.filter(value=>value.method==='POST'&&!value.url.endsWith('/alignment-work')).length,1);assert.equal(f.transport.requests.find(value=>value.method==='POST').options.headers['X-AskGPT-Pages'],'all');assert.equal(f.context().session.dataPromise,null);
  }finally{ready.resolve(source);f.plugin.shutdown();f.restore();}
 });
 await check('failed PDF reads and copies release pending input so a later start can read a fresh source',async()=>{
  for(const failure of ['read','copy']){
   const f=retainedInputFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()));let reads=0;
   f.pdf.getData=async()=>{if(++reads===1){if(failure==='read')throw Error('temporary PDF read failure');return new Uint8Array([1,2]);}return bytes();};
   try{
    f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(f.transport.requests.length,0);assert.equal(f.context().session.data,null);assert.equal(f.context().session.dataPromise,null,failure+' failure must not remain a retained rejected or unusable source');
    f.restart();await settle(()=>!f.plugin.state(f.reader).busy&&f.transport.requests.some(value=>value.method==='POST'));assert.equal(reads,2);assert.equal(f.transport.requests.filter(value=>value.method==='POST'&&!value.url.endsWith('/alignment-work')).length,1);assert.equal(f.context().session.dataPromise,null);
   }finally{f.plugin.shutdown();f.restore();}
  }
 });
 await check('closing a pending input cannot copy or upload it into a replacement session',async()=>{
  const ready=deferred(),source=bytes('%PDF-old\n'),replacement=bytes('%PDF-new\n'),f=retainedInputFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()));let reads=0,copies=0;
  f.pdf.getData=()=>{reads++;return reads===1?ready.promise:Promise.resolve(replacement);};f.transport.deps.Components.utils.waiveXrays=value=>{if(value===source||value===replacement)copies++;return value;};
  try{
   f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>reads===1);const previous=f.context().session;f.plugin.restore(f.reader);await f.plugin.toggle(f.reader);
   await settle(()=>!f.plugin.state(f.reader).busy&&f.transport.requests.some(value=>value.method==='POST'));const current=f.context().session,owned=current.data;assert.notEqual(current,previous);ready.resolve(source);await new Promise(setImmediate);
   assert.equal(previous.data,null);assert.equal(current.data,owned);assert.deepEqual([...owned],[...replacement]);assert.equal(copies,1);assert.equal(reads,2);assert.equal(f.transport.requests.filter(value=>value.method==='POST'&&!value.url.endsWith('/alignment-work')).length,1);assert.equal(current.dataPromise,null);
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
  assert.equal(f.plugin.state(f.reader).open,true);assert.equal(f.viewer.style.getPropertyValue('visibility'),'hidden');assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-work')).length,1);
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
  assert.equal(f.plugin.state(f.reader).busy,false);assert.equal(f.plugin.state(f.reader).progress,null);assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-work')).length,1);
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
   assert.equal(appearance.toolbarHost(),slot);assert.equal(controls.parentNode,slot);assert.equal(entry.hidden,true);assert.equal(entry.style.getPropertyValue('display'),'none');assert.equal(entry.style.getPropertyPriority('display'),'important','native toolbar display:flex must not override the hidden entry');const uploads=f.transport.requests.filter(x=>x.method==='POST'&&!x.url.endsWith('/alignment-work')).length;
   toolbar.replace();let appended=false;const result=f.readerEvents.get('renderToolbar')({reader:f.reader,doc:toolbar.doc,append(node){appended=true;toolbar.host.appendChild(node);}});
   assert.equal(result,undefined,'renderToolbar must append synchronously');assert.equal(appended,true);assert.equal(toolbar.host.children[0],slot);assert.equal(controls.parentNode,slot);assert.equal(slot.children.filter(x=>x===controls).length,1);assert.equal(attached.at(-1),slot);assert.equal(f.transport.requests.filter(x=>x.method==='POST'&&!x.url.endsWith('/alignment-work')).length,uploads,'toolbar recreation must never restart translation');
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
  await entered.promise;await f.plugin.translate(f.reader,{whole:true});assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-work')).length,1);
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
  assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-work')).length,1);assert(f.transport.requests.some(r=>r.url.endsWith('/dual.pdf')));
  await f.plugin.setMode(f.reader,'mono');assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-work')).length,1);
  f.plugin.shutdown();f.restore();
 });
 await check('actual keydown events in the main and PDF windows each toggle once',async()=>{
  const f=controllerFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()));f.plugin.start();
  const chord={code:'KeyX',altKey:true,shiftKey:true,ctrlKey:false,metaKey:false,repeat:false};
  const opened=f.reader._window.emit('keydown',chord);assert.equal(opened.defaultPrevented,true);await settle(()=>f.viewer.style.getPropertyValue('visibility')==='hidden');
  const closed=f.win.emit('keydown',chord);assert.equal(closed.defaultPrevented,true);assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');
  assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-work')).length,1);f.plugin.shutdown();f.restore();
 });
 await check('switching mode while the first output is downloading ends on the latest choice',async()=>{
  const ready=deferred(),entered=deferred();
  const f=controllerFixture(async(method,url)=>{if(url.endsWith('/mono.pdf')){entered.resolve();return ready.promise;}return url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});
  f.plugin.start();await f.plugin.translate(f.reader,{whole:false,mode:'mono'});await entered.promise;
  await f.plugin.setMode(f.reader,'dual');ready.resolve({status:200,response:bytes().buffer});
  await settle(()=>f.plugin.state(f.reader).busy===false);
  const frame=f.win.document.body.children.find(n=>n.tagName==='iframe');
  assert(frame.contentDocument.body.allNodes().some(n=>n.getAttribute('data-mode')==='dual'),'latest mode must be rendered, not only stored');
  assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-work')).length,1);f.plugin.shutdown();f.restore();
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
  f.output.numPages=3;whole.emit('click');await settle(()=>f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-work')).length===2);await settle(()=>f.viewer.style.getPropertyValue('visibility')==='hidden');
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
  assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-work')).length,1);
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
  assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/dual.pdf')).length,1);assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-work')).length,1);f.plugin.shutdown();f.restore();
 });
 await check('reopening a completed translation skips DELETE and can reuse the completed backend result',async()=>{
  const f=controllerFixture(async(method,url)=>url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job()));
  try{
   f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy&&f.viewer.style.getPropertyValue('visibility')==='hidden');
   f.plugin.restore(f.reader);await f.plugin.toggle(f.reader);await settle(()=>f.transport.requests.filter(value=>value.method==='POST'&&!value.url.endsWith('/alignment-work')).length===2&&!f.plugin.state(f.reader).busy);
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
   assert.equal(f.viewer.style.getPropertyValue('visibility'),'hidden');assert.equal(f.transport.requests.filter(value=>value.method==='POST'&&!value.url.endsWith('/alignment-work')).length,1);
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
   assert.equal(f.transport.requests.filter(value=>value.url.endsWith('/alignment.json')).length,1);assert.equal(f.transport.requests.filter(value=>value.url.endsWith('/mono.pdf')).length,1);assert.equal(f.transport.requests.filter(value=>value.url.endsWith('/dual.pdf')).length,0,'native dual shares the exact cached mono PDF');assert.equal(f.transport.requests.filter(value=>value.method==='POST'&&!value.url.endsWith('/alignment-work')).length,1);
   await f.plugin.setMode(f.reader,'dual');const cached=shows.at(-1).data;
   await actions.original();assert.equal(originals,1);assert.equal(f.plugin.state(f.reader).open,true);assert.equal(f.plugin.state(f.reader).original,true);assert.equal(disposals,0);
   f.win.PDFViewerApplication.pdfViewer.currentPageNumber=3;
   await f.plugin.toggle(f.reader);assert.equal(f.plugin.state(f.reader).original,false);assert.equal(shows.at(-1).mode,'dual');assert.equal(shows.at(-1).data,cached);
   await f.plugin.original(f.reader);assert.equal(f.plugin.state(f.reader).original,true);
   f.win.PDFViewerApplication.pdfViewer.currentPageNumber=2;
   await f.plugin.translate(f.reader,{whole:false,mode:'mono',direction:'en-zh'});assert.equal(shows.at(-1).mode,'mono');assert.equal(f.plugin.state(f.reader).original,false);
   assert.equal(f.transport.requests.filter(value=>value.method==='POST'&&!value.url.endsWith('/alignment-work')).length,1,'returning to the same local translation never creates a new job');assert.equal(f.transport.requests.filter(value=>value.url.endsWith('/mono.pdf')).length,1);assert.equal(disposals,0);
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
   assert.equal(f.transport.requests.filter(request=>request.method==='POST'&&!request.url.endsWith('/alignment-work')).length,1,'the whole-PDF toolbar action must reuse the completed session');
   assert.equal(f.transport.requests.filter(request=>request.url.endsWith('/mono.pdf')).length,1,'the loaded cached PDF must not download again');assert.equal(views.length,1);
   await f.plugin.original(f.reader);menuButton.emit('click');await Promise.resolve();wholeAction().emit('click');await settle(()=>!f.plugin.state(f.reader).original&&!f.plugin.state(f.reader).busy);
   assert.equal(f.transport.requests.filter(request=>request.method==='POST'&&!request.url.endsWith('/alignment-work')).length,1,'returning from original through the whole action must retain its completed job');assert.equal(views.length,1);
   const target=views[0];target._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber=3;target._options.onChangeViewState({pageIndex:2,left:20,top:650,scale:100});
   assert.equal(f.win.PDFViewerApplication.pdfViewer.currentPageNumber,2,'mono reading must leave the hidden source native viewer on its original page');assert.equal(f.reader._internalReader._state.primaryViewState.pageIndex,2);
   const more=toolbar.host.allNodes().find(node=>node.getAttribute('aria-haspopup')==='menu');assert(more);more.emit('click');await Promise.resolve();
   const menu=outer.body.children.find(node=>node.getAttribute('role')==='menu');assert(menu);assert.equal(menu.hidden,false);
   const current=menu.allNodes().find(node=>node.getAttribute('title')==='Translate current page · 本页');assert(current);assert.equal(menu.parentNode,outer.body,'auxiliary menu avoids toolbar overflow clipping');current.emit('click');
   await settle(()=>f.transport.requests.filter(request=>request.method==='POST'&&!request.url.endsWith('/alignment-work')).length===2&&!f.plugin.state(f.reader).busy);
   assert.deepEqual(f.transport.requests.filter(request=>request.method==='POST'&&!request.url.endsWith('/alignment-work')).map(request=>request.options.headers['X-AskGPT-Pages']),['all','3']);assert.equal(views.length,2);assert.equal(f.win.PDFViewerApplication.pdfViewer.currentPageNumber,2);
   await f.plugin.translate(f.reader,{whole:false,mode:'dual',direction:'en-zh'});
   assert.equal(f.plugin.state(f.reader).mode,'dual');assert.equal(f.transport.requests.filter(request=>request.method==='POST'&&!request.url.endsWith('/alignment-work')).length,2,'the current translated physical page is already cached even though the hidden source viewer has another page');assert.equal(views.length,2,'cached mode selection must retain the existing local native PDFView');
   f.win.PDFViewerApplication.pdfViewer.currentPageNumber=3;await f.plugin.original(f.reader);
   f.win.PDFViewerApplication.pdfDocument={...f.pdf};current.emit('click');await new Promise(setImmediate);
   assert.equal(f.plugin.state(f.reader).original,true,'a retired toolbar callback must not switch a replacement PDF to the old cached session');assert.equal(f.transport.requests.filter(request=>request.method==='POST'&&!request.url.endsWith('/alignment-work')).length,2);assert.equal(views.length,2);
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
   await f.plugin.toggle(f.reader);assert.equal(shows,1);assert.equal(f.plugin.state(f.reader).original,false);assert.equal(f.transport.requests.filter(value=>value.method==='POST'&&!value.url.endsWith('/alignment-work')).length,1);
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
    const requests=f.transport.requests.filter(value=>value.method==='POST'&&!value.url.endsWith('/alignment-work'));assert.equal(requests.at(-1).options.headers['X-AskGPT-Pages'],scope==='whole'?'all':'1');assert.equal(posts,2);
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
 async function warmSemanticFixture(){
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},shows=[],updates=[];
  const layout={...precisionAlignment(),sourceSHA256:'a'.repeat(64)};layout.pages=[0,1,2].map((sourcePage,outputPage)=>({...structuredClone(layout.pages[0]),sourcePage,outputPage}));
  const pageValue=page=>{const precise=precisionAlignment(true),value={...precise,sourceSHA256:layout.sourceSHA256,pages:layout.pages.map(p=>p.sourcePage===page?{...structuredClone(precise.pages[0]),sourcePage:page,outputPage:p.outputPage}:structuredClone(p)),sentencePages:[page],phrasePages:[page],phraseExtractedPages:[page],phraseCoverage:{[page]:precise.phraseCoverage[1]}};return value;};
  const f=retainedInputFixture(async(method,url)=>{if(url.endsWith('/alignment-layout.json'))return json(layout);if(url.includes('/alignment-page.json?page='))return json(pageValue(Number(url.split('=').at(-1))));if(url.includes('/selection-alignment?'))return json({jobID:job().id,page:Number(url.split('=').at(-1)),sourceSHA256:layout.sourceSHA256,targetSHA256:'b'.repeat(64),links:[]});if(url.endsWith('/alignment.json')||url.endsWith('/alignment-upgrade')||url.endsWith('/selection-alignment'))assert.fail('warm presentation must not use whole IR or a model');return url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job('complete',[0,1,2]));});
  const layer={nativeView:{fixture:'retained native view'},visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(){},updateAlignment(value){updates.push(value);},updateSelectionLinks(){},async showOutput(data,pages,mode,mapping){shows.push({data,pages,mode,mapping});this.visible=true;},showOriginal(){this.visible=false;},restoreOriginal(){this.visible=false;},dispose(){this.visible=false;}};
  native.canMount=()=>true;native.mount=async()=>layer;
  try{f.plugin.start();await f.plugin.toggle(f.reader,{whole:true,mode:'dual'});await settle(()=>!f.plugin.state(f.reader).busy&&updates.length===1);}catch(error){native.canMount=original.canMount;native.mount=original.mount;f.plugin.shutdown();f.restore();throw error;}
  return {...f,layer,shows,updates,done(){native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}};
 }
 await check('warm original translated and dual restores preserve the already loaded current-page semantics without metadata work',async()=>{
  const f=await warmSemanticFixture();try{const session=f.context().session,semantic=session.alignment,view=f.layer.nativeView;assert.equal(f.shows[0].mapping.granularity,'paragraph','cold first paint remains layout-only');assert(session.semanticPages.has(1));const reads=f.transport.requests.filter(r=>r.url.includes('/alignment-page.json?')).length;await f.plugin.original(f.reader);await f.plugin.setMode(f.reader,'dual');assert.equal(f.shows.at(-1).mapping,semantic,'warm native validation receives the retained semantic payload');assert(session.semanticPages.has(1));await f.plugin.setMode(f.reader,'mono');assert.equal(f.shows.at(-1).mapping,semantic);await f.plugin.setMode(f.reader,'dual');assert.equal(f.shows.at(-1).mapping,semantic);await new Promise(resolve=>setTimeout(resolve,15));assert.equal(f.updates.length,1,'warm switches never strip and reapply semantic data');assert.equal(f.transport.requests.filter(r=>r.url.includes('/alignment-page.json?')).length,reads);assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-work')).length,1);assert.equal(f.layer.nativeView,view);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);}finally{f.done();}
 });
 await check('a warm semantic shortcut rejects different view page job source hash or layout ownership',async()=>{
  for(const change of ['view','page','job','hash','layout','signature','missingSHA']){const f=await warmSemanticFixture();try{const session=f.context().session;await f.plugin.original(f.reader);if(change==='view')f.layer.nativeView={fixture:'new view'};if(change==='page')f.layer.currentSourcePage=2;if(change==='job')session.job={...session.job,id:'replacement_job'};if(change==='hash')session.layoutAlignment={...session.layoutAlignment,sourceSHA256:'c'.repeat(64)};if(change==='layout')session.layoutAlignment={...session.layoutAlignment};if(change==='signature')session.layoutSignature='changed-layout-binding';if(change==='missingSHA')session.alignment={...session.alignment,sourceSHA256:undefined};await f.plugin.setMode(f.reader,'dual');assert.equal(f.shows.at(-1).mapping,session.layoutAlignment,change+' retains the layout-first gate');assert.equal(session.semanticPages.size,0,change+' waits for bounded idle metadata rather than trusting stale semantics');assert(!f.transport.requests.some(r=>r.url.endsWith('/alignment.json')));}finally{f.done();}}
 });
 await check('warm presentation checks the fresh viewport after output preparation instead of a stale display-start page',async()=>{
  const f=await warmSemanticFixture();try{const session=f.context().session,pending=session.display('mono');f.layer.currentSourcePage=2;await pending;assert.equal(f.shows.at(-1).mapping,session.layoutAlignment);assert.equal(session.semanticPages.size,0);assert(!f.transport.requests.some(r=>r.url.endsWith('/alignment.json')));}finally{f.done();}
 });
 async function staleBannerFixture(){
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};let offline=true,actions,hold=null;
  const layout={...precisionAlignment(),sourceSHA256:'a'.repeat(64)};
  const f=retainedInputFixture(async(method,url)=>{if(url.endsWith('/mono.pdf')){if(offline){offline=false;throw Error('local helper not yet ready');}return {status:200,response:bytes().buffer};}if(url.endsWith('/alignment-layout.json')||url.endsWith('/alignment-page.json?page=1'))return json(layout);if(url.includes('/selection-alignment?'))return json({jobID:job().id,page:1,sourceSHA256:layout.sourceSHA256,targetSHA256:'b'.repeat(64),links:[]});return json(job());});
  const layer={visible:false,currentSourcePage:1,failPaint:false,prepareOutput(){},setProgress(){},setAnnotationStatus(){},updateAlignment(){},updateSelectionLinks(){},async showOutput(){if(this.failPaint)throw {code:'compatibility'};this.visible=true;const gate=hold;hold=null;if(gate){gate.entered.resolve();await gate.done.promise;}},showOriginal(){this.visible=false;},restoreOriginal(){this.visible=false;},dispose(){this.visible=false;}};
  native.canMount=()=>true;native.mount=async(_c,_s,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader,{mode:'dual'});await settle(()=>!f.plugin.state(f.reader).busy&&f.context()?.error);}catch(error){native.canMount=original.canMount;native.mount=original.mount;f.plugin.shutdown();f.restore();throw error;}
  return {...f,layer,get actions(){return actions;},offlineOnce(){offline=true;},holdPaint(){hold={entered:deferred(),done:deferred()};return hold;},done(){hold?.done.resolve();native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}};
 }
 await check('a current cached PDF retry clears its previous helper error only after native first paint is ready',async()=>{
  const f=await staleBannerFixture();try{const previous=f.context().error;assert.match(previous.textContent,/无法连接本机 PDF 翻译服务/);const gate=f.holdPaint(),pending=f.plugin.setMode(f.reader,'dual');await gate.entered.promise;assert.equal(f.context().error,previous);assert(previous.parentNode,'the existing error stays visible until PDF readiness');gate.done.resolve();await pending;assert.equal(f.context().error,null);assert.equal(previous.parentNode,null);assert(!f.win.document.body.allNodes().some(node=>node.className==='askgpt-pdf-error'));assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-work')).length,1,'successful cached retry never retranslates');}finally{f.done();}
 });
 await check('a failed cached PDF retry keeps its new visible error rather than treating output download as success',async()=>{
  const f=await staleBannerFixture();try{const previous=f.context().error;f.layer.failPaint=true;await f.plugin.setMode(f.reader,'dual');assert(f.context().error);assert.notEqual(f.context().error,previous);assert(f.context().error.parentNode);assert.match(f.context().error.textContent,/PDF 阅读接口暂不可用/);assert.equal(f.layer.visible,false);}finally{f.done();}
 });
 await check('a late successful paint cannot clear a newer error or an error owned by a replacement output or session',async()=>{
  for(const change of ['newError','newOutput','newSession']){const f=await staleBannerFixture();try{const session=f.context().session,gate=f.holdPaint(),pending=session.display('dual');await gate.entered.promise;if(change==='newSession'){f.plugin.restore(f.reader);f.offlineOnce();await f.plugin.toggle(f.reader,{mode:'dual'});await settle(()=>f.context()?.session&&f.context().session!==session&&!f.plugin.state(f.reader).busy&&f.context().error);}else{if(change==='newOutput')session.outputEpoch++;f.actions.failure({code:'runtime_missing'});}const latest=f.context().error;assert(latest);gate.done.resolve();await pending;assert.equal(f.context().error,latest,change);assert(latest.parentNode,change+' must retain its latest visible error');}finally{f.done();}}
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
 async function hydrationSelectionFixture(){
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},full=deferred(),entered=deferred(),frames=[],queries=[],statuses=[],updates=[];let actions,exact=false;
  const layout={...precisionAlignment(),sourceSHA256:'a'.repeat(64)},precise={...precisionAlignment(true),sourceSHA256:layout.sourceSHA256},binding={jobID:job().id,page:1,sourceSHA256:layout.sourceSHA256,targetSHA256:'b'.repeat(64),revision:'pdf-selection-semantic-v1'};
  const f=controllerFixture(async(method,url,options)=>{
   if(url.endsWith('/alignment-layout.json'))return json(layout);
   if(url.endsWith('/alignment-page.json?page=1')){entered.resolve();return full.promise;}
   if(url.endsWith('/selection-alignment?page=1'))return json({...binding,links:[]});
   if(url.endsWith('/selection-alignment')){queries.push(JSON.parse(options.body));return json({...binding,key:'c'.repeat(64),link:null,cached:false});}
   if(url.endsWith('/alignment-upgrade'))assert.fail('hydration replay must never fall back to a whole-page model upgrade');
   return url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());
  });
  const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(value){statuses.push(value);},updateAlignment(value){updates.push(value);},updateSelectionLinks(){},hasExactSelection:()=>exact,async showOutput(){this.visible=true;},showOriginal(){this.visible=false;},restoreOriginal(){this.visible=false;},dispose(){this.visible=false;}};
  native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};f.reader._iframeWindow.requestAnimationFrame=fn=>{frames.push(fn);return frames.length;};f.reader._iframeWindow.cancelAnimationFrame=()=>{};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(frames.length,1);frames[0]();await entered.promise;}
  catch(error){native.canMount=original.canMount;native.mount=original.mount;f.plugin.shutdown();f.restore();throw error;}
  const query={page:1,paragraph:'p1_0',side:'target',rects:[[10,30,80,40]],text:'译文'};
  return {...f,actions,layer,queries,statuses,updates,query,resolve(){full.resolve(json(precise));},exact(){exact=true;},done(){full.resolve(json(precise));native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}};
 }
 await check('an explicit selection made during metadata hydration is replayed once with its original query after cached mapping arrives',async()=>{
  const f=await hydrationSelectionFixture();try{
   assert.equal(f.actions.align(1,{explicit:true,selection:f.query}),'pending');assert.equal(f.queries.length,0);f.resolve();await settle(()=>f.updates.length===1);await new Promise(setImmediate);await new Promise(setImmediate);
   assert.deepEqual(f.queries,[f.query]);assert.equal(f.statuses.at(-1),'unavailable');assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-page.json?page=1')).length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-upgrade')).length,0);
  }finally{f.done();}
 });
 await check('hydration retains only the current explicit selection and drops clear page mode document and session changes',async()=>{
  for(const change of ['newQuery','clear','page','original','close','replace','exactReady']){
   const f=await hydrationSelectionFixture();try{
    f.actions.selectionChanged();assert.equal(f.actions.align(1,{explicit:true,selection:f.query}),'pending');const latest={...f.query,text:'文',rects:[[45,30,80,40]]};
    if(change==='newQuery'){f.actions.selectionChanged();f.actions.align(1,{explicit:true,selection:latest});}
    if(change==='clear')f.actions.selectionChanged();
    if(change==='page'){f.layer.currentSourcePage=2;f.actions.page(2);}
    if(change==='original')await f.plugin.setMode(f.reader,'original');
    if(change==='close')f.plugin.restore(f.reader);
    if(change==='replace')f.win.PDFViewerApplication.pdfDocument={...f.pdf};
    if(change==='exactReady')f.exact();
    f.resolve();await new Promise(setImmediate);await new Promise(setImmediate);await new Promise(setImmediate);
    assert.deepEqual(f.queries,change==='newQuery'?[latest]:[],change+' must never send the retired selection or speculative page upgrade');
    assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-upgrade')).length,0);
    if(change==='exactReady')assert.equal(f.statuses.at(-1),null,'hydrated native exact cache must finish without another endpoint call');
   }finally{f.done();}
  }
 });
 await check('hydration replays a current fragment array and retires old arrays when cleared or replaced',async()=>{
  for(const change of ['same','newGroup','clear','original']){
   const f=await hydrationSelectionFixture();try{const selections=[f.query,{...f.query,text:'文',rects:[[45,30,80,40]]}],latest={...f.query,text:'新片',rects:[[10,30,45,40]]};f.actions.align(1,{explicit:true,selections});if(change==='newGroup'){f.actions.selectionChanged();f.actions.align(1,{explicit:true,selections:[latest]});}if(change==='clear')f.actions.selectionChanged();if(change==='original')await f.plugin.setMode(f.reader,'original');f.resolve();await new Promise(setImmediate);await new Promise(setImmediate);await new Promise(setImmediate);assert.deepEqual(f.queries,change==='same'?[f.query]:change==='newGroup'?[latest]:[]);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-upgrade')).length,0);}finally{f.done();}
  }
 });
 await check('hydration asks native to replan the same current selection without implicitly retrying a negative cache',async()=>{
  for(const retry of [false,true]){
   const f=await hydrationSelectionFixture();try{const fragment={...f.query,text:'新片',rects:[[10,30,45,40]]},calls=[];f.layer.retrySelection=options=>{calls.push(options);f.actions.align(1,{explicit:true,selections:[fragment],retry:options.retry});return true;};f.actions.align(1,{explicit:true,selection:f.query,...(retry?{retry:true}:{})});f.resolve();await settle(()=>calls.length===1);await new Promise(setImmediate);assert.deepEqual(calls,[{retry}]);assert.deepEqual(f.queries,[fragment],'hydrated native fragments replace obsolete whole-passage query');assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-upgrade')).length,0);}finally{f.done();}
  }
 });
 await check('cached PDF paints with layout before full metadata and hydrates once across display modes without GPT',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},paint=deferred(),full=deferred(),entered=deferred();let actions;const shows=[],updates=[],frames=[];
  const layout={...precisionAlignment(),sourceSHA256:'a'.repeat(64)},precise={...precisionAlignment(true),sourceSHA256:layout.sourceSHA256};
  const f=controllerFixture(async(method,url)=>{if(url.endsWith('/alignment-layout.json'))return json(layout);if(url.endsWith('/alignment-page.json?page=1')){entered.resolve();return full.promise;}if(url.endsWith('.pdf'))return {status:200,response:bytes().buffer};if(url.endsWith('/selection-alignment?page=1'))return json({jobID:job().id,page:1,sourceSHA256:layout.sourceSHA256,targetSHA256:'b'.repeat(64),links:[]});if(url.endsWith('/alignment-upgrade')||url.endsWith('/selection-alignment'))assert.fail('pending cached metadata must not trigger GPT');return json(job());});
  f.reader._iframeWindow.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};f.reader._iframeWindow.cancelAnimationFrame=()=>{};
  const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(){},updateAlignment(value){updates.push(value);return true;},async showOutput(data,pages,mode,mapping){shows.push({data,mode,mapping});this.visible=true;assert.equal(actions.align(1,{selection:{page:1}}),'pending');assert.equal(actions.page(1),'pending');await paint.promise;},showOriginal(){this.visible=false;},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
  native.canMount=()=>true;native.mount=async(context,css,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>shows.length===1);assert.equal(shows[0].mapping.granularity,'paragraph');assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-page.json?page=1')).length,0);assert.equal(frames.length,0,'metadata must not even schedule before native first paint resolves');paint.resolve();await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(frames.length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-page.json?page=1')).length,0);
   await f.plugin.setMode(f.reader,'dual');assert.equal(frames.length,1);assert.equal(shows[1].data,shows[0].data);frames[0]();await entered.promise;assert.equal(layer.visible,true);full.resolve(json(precise));await settle(()=>updates.length===1);assert.equal(updates[0].sourceSHA256,layout.sourceSHA256);assert.equal(updates[0].granularity,'sentence');assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-page.json?page=1')).length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);assert.equal(shows.length,2);assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-work')).length,1);
  }finally{paint.resolve();full.resolve(json(precise));native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('cached metadata failures keep the PDF visible and explicit retry only reloads metadata',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};let actions,reads=0,restores=0;const updates=[],statuses=[],layout={...precisionAlignment(),sourceSHA256:'a'.repeat(64)},precise={...precisionAlignment(true),sourceSHA256:layout.sourceSHA256};
  const f=controllerFixture(async(method,url)=>{if(url.endsWith('/alignment-layout.json'))return json(layout);if(url.endsWith('/alignment-page.json?page=1'))return ++reads===1?{status:404,responseText:'{"error":"alignment_unavailable"}'}:json(precise);if(url.endsWith('.pdf'))return {status:200,response:bytes().buffer};if(url.endsWith('/alignment-upgrade')||url.endsWith('/selection-alignment'))assert.fail('metadata retry must remain read-only');return json(job());});
  const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(value){statuses.push(value);},updateAlignment(value){updates.push(value);return true;},async showOutput(){this.visible=true;actions.page(1);},restoreOriginal(){restores++;this.visible=false;},dispose(){this.visible=false;}};
  native.canMount=()=>true;native.mount=async(context,css,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>statuses.includes('failed'));assert.equal(layer.visible,true);assert.equal(restores,0);assert.equal(f.plugin.state(f.reader).busy,false);assert.equal(actions.align(1),'failed');assert.equal(actions.align(1,{explicit:true,selection:{page:1}}),'pending');await settle(()=>updates.length===1);assert.equal(reads,2);assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-work')).length,1);assert.equal(restores,0);
  }finally{native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('late or mismatched cached metadata cannot update another PDF or replace a readable layout',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};
  for(const change of ['sha','geometry','replace','close']){const full=deferred(),entered=deferred(),layout={...precisionAlignment(),sourceSHA256:'a'.repeat(64)};let actions,updates=0;const statuses=[];
   const f=controllerFixture(async(method,url)=>{if(url.endsWith('/alignment-layout.json'))return json(layout);if(url.endsWith('/alignment-page.json?page=1')){entered.resolve();return full.promise;}return url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(value){statuses.push(value);},updateAlignment(){updates++;},async showOutput(){this.visible=true;actions.page(1);},restoreOriginal(){this.visible=false;},dispose(){this.visible=false;}};
   native.canMount=()=>true;native.mount=async(context,css,value)=>{actions=value;return layer;};
   try{f.plugin.start();await f.plugin.toggle(f.reader);await entered.promise;if(change==='replace')f.win.PDFViewerApplication.pdfDocument={...f.pdf};if(change==='close')f.plugin.restore(f.reader);const value={...precisionAlignment(true),sourceSHA256:(change==='sha'?'c':'a').repeat(64)};if(change==='geometry')value.pages[0].paragraphs[0].target.rects[0][0]++;full.resolve(json(value));await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(updates,0);assert.equal(layer.visible,change!=='close');assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-work')).length,1);if(['sha','geometry'].includes(change))assert(statuses.includes('failed'));
   }finally{full.resolve(json(layout));native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
  }
 });
 await check('modern explicit precision success and failure refresh only page metadata and never the whole sidecar',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};
  for(const fail of [false,true]){let actions,submitted=false;const updates=[],statuses=[],base={...precisionAlignment(),sourceSHA256:'a'.repeat(64)},ready={...precisionAlignment(true),sourceSHA256:base.sourceSHA256};
   const f=controllerFixture(async(method,url)=>{if(url.endsWith('/alignment-layout.json'))return json(base);if(url.endsWith('/alignment-page.json?page=1'))return json(submitted?ready:base);if(url.endsWith('/alignment.json'))assert.fail('modern retry/error must never read full IR');if(url.endsWith('/alignment-upgrade')){if(method==='POST')submitted=true;return json({id:job().id,state:submitted?(fail?'failed':'complete'):'idle',sourcePages:[1],completedPages:submitted&&!fail?[1]:[],mappedSentences:submitted?1:0,...(submitted&&fail?{error:'alignment_timeout'}:{})});}if(url.includes('/selection-alignment?'))return json({jobID:job().id,page:1,sourceSHA256:base.sourceSHA256,targetSHA256:'b'.repeat(64),links:[]});return url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});
   const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus:value=>statuses.push(value),updateAlignment:value=>updates.push(value),updateSelectionLinks(){},async showOutput(){this.visible=true;},restoreOriginal(){this.visible=false;},dispose(){this.visible=false;}};native.canMount=()=>true;native.mount=async(_c,_s,value)=>{actions=value;return layer;};
   try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>updates.length===1);assert.equal(actions.align(1,{explicit:true}),'started');await settle(()=>updates.length===2);assert(submitted);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-page.json?page=1')).length,2);assert(!f.transport.requests.some(r=>r.url.endsWith('/alignment.json')));assert.equal(updates[1].phrasePages[0],1);assert.equal(f.plugin.state(f.reader).busy,false);}finally{native.canMount=original.canMount;native.mount=original.mount;f.plugin.shutdown();f.restore();}
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
    assert.equal(mounts,1);assert.equal(shows.length,1);assert.equal(f.renders.length,0);assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-upgrade')&&!r.url.endsWith('/alignment-work')).length,1,'opening the completed cache must not start another PDF translation');assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);
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
   assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-upgrade')&&!r.url.endsWith('/alignment-work')).length,1);
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
   assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-upgrade')&&!r.url.endsWith('/alignment-work')).length,1);assert.equal(f.renders.length,0);
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
   assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-upgrade')&&!r.url.endsWith('/alignment-work')).length,1);
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
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>statuses.includes('failed')&&!f.plugin.state(f.reader).busy);for(let i=0;i<20;i++){actions.page(1);actions.align(1);}await new Promise(setImmediate);assert.equal(posts,1);assert(updates.length>=1,'a failed model turn must still reload successful partial sidecar checkpoints');actions.align(1,{explicit:true});assert.equal(statuses.at(-1),'retry_wait');assert.equal(posts,1);clock+=3000;actions.align(1,{explicit:true});await settle(()=>ready&&updates.at(-1)?.phraseExtractedPages?.includes(1));assert.equal(statuses.at(-1),null);assert.equal(posts,2);assert.equal(mounts,1);assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-upgrade')&&!r.url.endsWith('/alignment-work')).length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);actions.align(1,{explicit:true});await new Promise(setImmediate);assert.equal(posts,2);
  }finally{Date.now=realNow;native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('successful partial word batches reach the native reader while the page is still preparing and survive a later timeout',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},release=deferred();let actions,step=0;const updates=[],statuses=[];
  const partial=precisionAlignment(true);partial.phraseExtractedPages=[];
  const f=controllerFixture(async(method,url)=>{if(url.endsWith('/alignment-upgrade')){if(step===0&&method==='GET')return json({id:job().id,state:'idle',sourcePages:[],completedPages:[],mappedSentences:0});if(method==='POST'){step=1;return json({id:job().id,state:'running',sourcePages:[1],completedPages:[],mappedSentences:0,alignmentVersion:'a'.repeat(64)},202);}if(step===1){step=2;return json({id:job().id,state:'running',sourcePages:[1],completedPages:[],mappedSentences:1,alignmentVersion:'b'.repeat(64)});}await release.promise;return json({id:job().id,state:'failed',sourcePages:[1],completedPages:[],mappedSentences:1,error:'alignment_timeout',alignmentVersion:'b'.repeat(64)});}return url.endsWith('/alignment.json')?json(step>=2?partial:precisionAlignment()):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus:value=>statuses.push(value),async updateAlignment(value){updates.push(value);},async showOutput(){this.visible=true;actions.align(1,{explicit:true});},restoreOriginal(){this.visible=false;},dispose(){},currentSourcePage:1};native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>updates.some(value=>value.phrasePages?.includes(1)));assert.equal(statuses.at(-1),'preparing');assert.equal(f.plugin.state(f.reader).busy,false);assert.equal(updates.at(-1).phraseExtractedPages.length,0,'partial exact links must never claim the entire page is ready');release.resolve();await settle(()=>statuses.at(-1)==='failed');assert(updates.at(-1).phrasePages.includes(1));assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-upgrade')&&!r.url.endsWith('/alignment-work')).length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);
  }finally{release.resolve();native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('explicit precision retries have a bounded budget and retry only probes a cache completed elsewhere',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},realNow=Date.now;let clock=10000,actions,posts=0,externalReady=false;const statuses=[];Date.now=()=>clock;
  const f=controllerFixture(async(method,url)=>{if(url.endsWith('/alignment-upgrade')){if(method==='POST')posts++;return json({id:job().id,state:externalReady?'complete':method==='POST'?'failed':'idle',sourcePages:[1],completedPages:externalReady?[1]:[],mappedSentences:externalReady?1:0,...(!externalReady&&method==='POST'?{error:'alignment_timeout'}:{})},method==='POST'?202:200);}return url.endsWith('/alignment.json')?json(precisionAlignment(externalReady)):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});
  const layer={visible:false,prepareOutput(){},setProgress(){},setAnnotationStatus:value=>statuses.push(value),async updateAlignment(){},async showOutput(){this.visible=true;actions.align(1,{explicit:true});},restoreOriginal(){this.visible=false;},dispose(){},currentSourcePage:1};native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>statuses.at(-1)==='failed'&&!f.plugin.state(f.reader).busy);for(let n=2;n<=3;n++){clock+=3000;actions.resume();await settle(()=>posts===n&&statuses.at(-1)==='failed');}clock+=3000;actions.align(1,{explicit:true});assert.equal(statuses.at(-1),'retry_limited');assert.equal(posts,3);clock+=60000;externalReady=true;actions.resume();await settle(()=>statuses.at(-1)===null);assert.equal(posts,3,'a completed server cache must be probed without another model POST');assert.equal(f.transport.requests.filter(r=>r.method==='POST'&&!r.url.endsWith('/alignment-upgrade')&&!r.url.endsWith('/alignment-work')).length,1);assert.equal(f.transport.requests.filter(r=>r.method==='DELETE').length,0);
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
 await check('selection retries use the current native selection endpoint and positive links do not claim readiness before native geometry accepts them',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},mapping={...precisionAlignment(),sourceSHA256:'a'.repeat(64)},full=precisionAlignment(true),key='c'.repeat(64),link={...structuredClone(full.pages[0].paragraphs[0].sentences[0].phrases[0]),id:'sel_'+key,key,paragraph:'p1_0'},binding={jobID:job().id,page:1,sourceSHA256:mapping.sourceSHA256,targetSHA256:'b'.repeat(64),revision:'pdf-selection-semantic-v1'},query={page:1,paragraph:'p1_0',side:'target',rects:[[10,30,80,40]],text:'译文'},miss={...query,text:'文',rects:[[45,30,80,40]]},statuses=[];let actions,usable=false,retried=0;
  const f=controllerFixture(async(method,url,options)=>{
   if(url.endsWith('/selection-alignment?page=1'))return json({...binding,links:[]});
   if(url.endsWith('/selection-alignment')){const selected=JSON.parse(options.body);if(['busy','timeout','invalid'].includes(selected.text)){const response=json({error:'selection_'+selected.text},selected.text==='busy'?409:selected.text==='timeout'?504:400);if(response.status!==409)throw {xmlhttp:response};return response;}return json({...binding,key,link:selected.text==='译文'?link:null,cached:false});}
   if(url.endsWith('/alignment-upgrade'))assert.fail('retrying a selected word must not upgrade the whole page');
   return url.endsWith('/alignment.json')?json(mapping):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());
  });
  const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(value){statuses.push(value);},updateAlignment(){},updateSelectionLinks(){},hasExactSelection:()=>usable,retrySelection(){retried++;actions.align(1,{explicit:true,retry:true,selection:miss});return true;},async showOutput(){this.visible=true;},showOriginal(){this.visible=false;},restoreOriginal(){this.visible=false;},dispose(){this.visible=false;}};native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);assert.equal(actions.align(1,{explicit:true,selection:query}),'started');await settle(()=>statuses.at(-1)==='unavailable');assert.equal(actions.align(1,{explicit:true,selection:query}),'unavailable');usable=true;assert.equal(actions.align(1,{explicit:true,retry:true,selection:query}),'ready');assert.equal(statuses.at(-1),null);usable=false;
   actions.align(1,{explicit:true,selection:miss});await settle(()=>statuses.at(-1)==='unavailable');actions.resume();await settle(()=>retried===1&&f.transport.requests.filter(r=>r.url.endsWith('/selection-alignment')).length===3&&statuses.at(-1)==='unavailable');
   const calls=f.transport.requests.filter(r=>r.url.endsWith('/selection-alignment'));assert(calls.slice(0,2).every(r=>r.options.headers['X-AskGPT-Selection-Retry']===undefined));assert.equal(calls[2].options.headers['X-AskGPT-Selection-Retry'],'1');assert.deepEqual(JSON.parse(calls[2].options.body),miss);
   for(const [text,status] of [['busy','busy'],['timeout','timeout'],['invalid','unavailable']]){actions.align(1,{explicit:true,selection:{...query,text}});await settle(()=>statuses.at(-1)===status);}
   assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-upgrade')).length,0);
  }finally{native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 async function fragmentSelectionFixture(options={}){
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},mapping={...precisionAlignment(),sourceSHA256:'a'.repeat(64)},precise=precisionAlignment(true),queries=[],statuses=[],updates=[],seen=new Set();let actions,active=0,maxActive=0,exact=options.exact;
  if(options.crossPage){const base=mapping.pages[0];mapping.pages=[0,1,2].map(i=>{const page=structuredClone(base);page.sourcePage=i;page.outputPage=i;page.paragraphs[0].id='p'+i+'_0';return page;});}
  const binding={jobID:job().id,page:1,sourceSHA256:mapping.sourceSHA256,targetSHA256:'b'.repeat(64),revision:'pdf-selection-semantic-v1'},query=text=>({page:1,paragraph:'p1_0',side:'target',rects:[[10,30,80,40]],text}),keys=new Map();
  const reply=(selected,positive=true)=>{if(!keys.has(selected.text))keys.set(selected.text,(keys.size+1).toString(16).repeat(64));const key=keys.get(selected.text),link={...structuredClone(precise.pages[0].paragraphs[0].sentences[0].phrases[0]),id:'sel_'+key,key,paragraph:selected.paragraph};return {...binding,page:selected.page,key,link:positive?link:null,cached:false};};
  const f=controllerFixture(async(method,url,request)=>{
   if(url.endsWith('/selection-alignment?page=1'))return json({...binding,links:[]});
   if(url.endsWith('/selection-alignment')){const selected=JSON.parse(request.body),index=queries.length;queries.push({query:selected,request});active++;maxActive=Math.max(maxActive,active);try{return options.handle?await options.handle(selected,index,reply):json(reply(selected));}finally{active--;}}
   if(url.endsWith('/alignment-upgrade'))assert.fail('fragment selection groups must never start whole-page alignment');
   return url.endsWith('/alignment.json')?json(mapping):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job('complete',options.crossPage?[0,1,2]:[1]));
  });
  const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(value){statuses.push(value);},updateAlignment(){},updateSelectionLinks(value){updates.push(value);if(value.link)seen.add(value.link.key);if(options.clearStatusOnUpdate&&value.link)statuses.push(null);},hasExactSelection:()=>typeof exact==='function'?exact(seen):exact===undefined?seen.size>=2:exact,async showOutput(){this.visible=true;},showOriginal(){this.visible=false;},restoreOriginal(){this.visible=false;},dispose(){this.visible=false;}};
  native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader,options.crossPage?{whole:true}:{});await settle(()=>!f.plugin.state(f.reader).busy);await new Promise(setImmediate);}
  catch(error){native.canMount=original.canMount;native.mount=original.mount;f.plugin.shutdown();f.restore();throw error;}
  return {...f,actions,layer,queries,statuses,updates,seen,query,reply,maxActive:()=>maxActive,setExact:value=>{exact=value;},done(){native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}};
 }

 await check('cross-page fragment groups preserve physical pages and retry only the missing fragment',async()=>{
  let positive=false;const f=await fragmentSelectionFixture({crossPage:true,handle:async(q,_i,reply)=>json(reply(q,q.page===1||positive))});try{
   const selections=[f.query('片一'),{...f.query('片二'),page:2}];assert.equal(f.actions.align(1,{explicit:true,pages:[1,2],selections}),'started');await settle(()=>f.statuses.at(-1)==='unavailable');assert.deepEqual(f.queries.map(q=>q.query.page),[1,2]);
   positive=true;f.actions.align(1,{explicit:true,pages:[1,2],selections,retry:true});await settle(()=>f.statuses.at(-1)===null);assert.deepEqual(f.queries.map(q=>q.query.page),[1,2,2]);assert.equal(f.queries[2].request.headers['X-AskGPT-Selection-Retry'],'1');
   f.actions.selectionChanged();f.setExact(true);assert.equal(f.actions.align(1,{explicit:true,pages:[1,2],selections:[selections[1]]}),'ready');
  }finally{f.done();}
 });
 await check('cross-page fragments retain generation ownership after selection clear or replacement',async()=>{
  for(const change of ['clear','original','page']){const late=deferred(),f=await fragmentSelectionFixture({crossPage:true,handle:async(q,_i,reply)=>{await late.promise;return json(reply(q));}});try{
   assert.equal(f.actions.align(1,{explicit:true,pages:[1,2],selections:[f.query('片一'),{...f.query('片二'),page:2}]}),'started');await settle(()=>f.queries.length===1);
   if(change==='clear')f.actions.selectionChanged();if(change==='original')await f.plugin.setMode(f.reader,'original');if(change==='page'){f.layer.currentSourcePage=2;f.actions.page(2);}const before=f.statuses.length;late.resolve();await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(f.queries.length,1);assert.equal(f.statuses.length,before);
  }finally{late.resolve();f.done();}}
 });
 await check('selection fragments run serially, deduplicate the active group and reuse positive cache immediately',async()=>{
  const first=deferred(),second=deferred(),f=await fragmentSelectionFixture({clearStatusOnUpdate:true,handle:async(q,index,reply)=>{await (index===0?first:second).promise;return json(reply(q));}});try{
   const selections=[f.query('片一'),f.query('片二')];assert.equal(f.actions.align(1,{explicit:true,selections}),'started');await settle(()=>f.queries.length===1);assert.equal(f.actions.align(1,{explicit:true,selections}),'pending');assert.equal(f.statuses.at(-1),'preparing');first.resolve();await settle(()=>f.queries.length===2);assert.equal(f.statuses.at(-1),'preparing');assert.equal(f.maxActive(),1);second.resolve();await settle(()=>f.statuses.at(-1)===null);assert.deepEqual(f.queries.map(q=>q.query),selections);f.actions.selectionChanged();assert.equal(f.actions.align(1,{explicit:true,selections}),'ready');assert.equal(f.queries.length,2);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-upgrade')).length,0);
  }finally{first.resolve();second.resolve();f.done();}
 });
 await check('fragment null stops the group, negative cache only retries explicitly and missing native coverage never claims ready',async()=>{
  let positive=false;const f=await fragmentSelectionFixture({handle:async(q,_index,reply)=>json(reply(q,q.text!=='片二'||positive))});try{
   const selections=[f.query('片一'),f.query('片二'),f.query('片三')];f.actions.align(1,{explicit:true,selections});await settle(()=>f.statuses.at(-1)==='unavailable');assert.equal(f.queries.length,2);assert.equal(f.actions.align(1,{explicit:true,selections}),'unavailable');assert.equal(f.queries.length,2);positive=true;f.actions.align(1,{explicit:true,selections,retry:true});await settle(()=>f.queries.length===4&&f.statuses.at(-1)===null);assert.deepEqual(f.queries.slice(2).map(q=>q.query.text),['片二','片三']);assert(f.queries.slice(2).every(q=>q.request.headers['X-AskGPT-Selection-Retry']==='1'));f.setExact(false);assert.equal(f.actions.align(1,{explicit:true,selections}),'unavailable');assert.equal(f.statuses.at(-1),'unavailable');delete f.layer.hasExactSelection;assert.equal(f.actions.align(1,{explicit:true,selections}),'unavailable','group readiness always requires a native exact-selection getter');assert.equal(f.queries.length,4);
  }finally{f.done();}
 });
 await check('fragment errors stop at the failing member and retain exact bounded failure status',async()=>{
  for(const [code,status,http] of [['selection_busy','busy',409],['selection_timeout','timeout',504],['selection_invalid','unavailable',400],['gpt_unavailable','failed',503]]){
   const f=await fragmentSelectionFixture({handle:async(q,index,reply)=>{if(index===1)throw {xmlhttp:json({error:code},http)};return json(reply(q));}});try{f.actions.align(1,{explicit:true,selections:[f.query('片一'),f.query('片二'),f.query('片三')]});await settle(()=>f.statuses.at(-1)===status);assert.equal(f.queries.length,2);assert.equal(f.maxActive(),1);}finally{f.done();}
  }
 });
 await check('retiring a fragment group stops unsubmitted members and cannot publish stale status',async()=>{
  for(const change of ['clear','page','original','close','replace']){
   const late=deferred(),f=await fragmentSelectionFixture({handle:async(q,_index,reply)=>{await late.promise;return json(reply(q));}});try{f.actions.align(1,{explicit:true,selections:[f.query('片一'),f.query('片二')]});await settle(()=>f.queries.length===1);if(change==='clear')f.actions.selectionChanged();if(change==='page'){f.layer.currentSourcePage=2;f.actions.page(2);}if(change==='original')await f.plugin.setMode(f.reader,'original');if(change==='close')f.plugin.restore(f.reader);if(change==='replace')f.win.PDFViewerApplication.pdfDocument={...f.pdf};const before=f.statuses.length;late.resolve();await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(f.queries.length,1,change);assert.equal(f.statuses.length,before,change);}finally{late.resolve();f.done();}
  }
 });
 await check('an old group response cannot clear a new group while its positive cache remains reusable',async()=>{
  const old=deferred(),current=deferred(),f=await fragmentSelectionFixture({clearStatusOnUpdate:true,handle:async(q,_index,reply)=>{if(q.text==='旧一')await old.promise;if(q.text==='新一')await current.promise;return json(reply(q));}});try{
   const previous=[f.query('旧一'),f.query('旧二')],latest=[f.query('新一'),f.query('新二')];f.actions.align(1,{explicit:true,selections:previous});await settle(()=>f.queries.length===1);f.actions.selectionChanged();f.actions.align(1,{explicit:true,selections:latest});await settle(()=>f.queries.length===2);const before=f.statuses.length,updates=f.updates.length;old.resolve();await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(f.queries.length,2);assert.equal(f.statuses.length,before);assert.equal(f.updates.length,updates,'retired response must not indirectly clear current group through native link repaint');current.resolve();await settle(()=>f.queries.length===3&&f.statuses.at(-1)===null);assert.deepEqual(f.queries.map(q=>q.query.text),['旧一','新一','新二']);f.actions.selectionChanged();f.setExact(true);assert.equal(f.actions.align(1,{explicit:true,selections:[previous[0]]}),'ready');assert.equal(f.queries.length,3,'late positive was cached despite withheld UI repaint');
  }finally{old.resolve();current.resolve();f.done();}
 });
 await check('an old single positive response cannot repaint or clear the current fragment group',async()=>{
  const old=deferred(),current=deferred(),f=await fragmentSelectionFixture({clearStatusOnUpdate:true,handle:async(q,_index,reply)=>{if(q.text==='旧词')await old.promise;if(q.text==='新一')await current.promise;return json(reply(q));}});try{
   f.actions.align(1,{explicit:true,selection:f.query('旧词')});await settle(()=>f.queries.length===1);f.actions.selectionChanged();f.actions.align(1,{explicit:true,selections:[f.query('新一'),f.query('新二')]});await settle(()=>f.queries.length===2);const statusCount=f.statuses.length,updateCount=f.updates.length;old.resolve();await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(f.statuses.length,statusCount);assert.equal(f.updates.length,updateCount);assert.equal(f.statuses.at(-1),'preparing');current.resolve();await settle(()=>f.statuses.at(-1)===null);assert.deepEqual(f.queries.map(q=>q.query.text),['旧词','新一','新二']);
  }finally{old.resolve();current.resolve();f.done();}
 });
 await check('native callbacks that clear a group while applying one fragment cannot restore preparing or submit the next fragment',async()=>{
  const late=deferred(),f=await fragmentSelectionFixture({handle:async(q,_index,reply)=>{await late.promise;return json(reply(q));}});try{
   const apply=f.layer.updateSelectionLinks;f.layer.updateSelectionLinks=value=>{apply(value);if(value.link)f.actions.selectionChanged();};f.actions.align(1,{explicit:true,selections:[f.query('片一'),f.query('片二')]});await settle(()=>f.queries.length===1);const before=f.statuses.length;late.resolve();await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(f.queries.length,1);assert.equal(f.statuses.length,before);
  }finally{late.resolve();f.done();}
 });
 await check('a new single selection retires a group and a group can join the same single pending query without another model turn',async()=>{
  for(const change of ['singleTakesOver','singleAdoptsFragment','groupJoinsSingle']){
   const late=deferred(),f=await fragmentSelectionFixture({handle:async(q,_index,reply)=>{if(q.text==='片一')await late.promise;return json(reply(q));}});try{const selections=[f.query('片一'),f.query('片二')];if(change==='groupJoinsSingle'){f.actions.align(1,{explicit:true,selection:selections[0]});await settle(()=>f.queries.length===1);f.actions.align(1,{explicit:true,selections});}else{f.actions.align(1,{explicit:true,selections});await settle(()=>f.queries.length===1);f.actions.selectionChanged();f.actions.align(1,{explicit:true,selection:change==='singleAdoptsFragment'?selections[0]:f.query('新选区')});if(change==='singleTakesOver')await settle(()=>f.queries.length===2);f.setExact(true);}late.resolve();await new Promise(setImmediate);await new Promise(setImmediate);if(change==='groupJoinsSingle'){await settle(()=>f.statuses.at(-1)===null);assert.deepEqual(f.queries.map(q=>q.query.text),['片一','片二']);}else if(change==='singleAdoptsFragment'){assert.deepEqual(f.queries.map(q=>q.query.text),['片一']);assert.equal(f.statuses.at(-1),null,'single selection adopts the pending fragment completion');}else{assert.deepEqual(f.queries.map(q=>q.query.text),['片一','新选区']);}assert.equal(f.queries.filter(q=>q.query.text==='片一').length,1);}finally{late.resolve();f.done();}
  }
 });
 await check('fragment group validates every member before submission and rejects empty oversized mixed or malformed evidence',async()=>{
  const f=await fragmentSelectionFixture();try{const q=f.query('片一');for(const selections of [[],Array(2),Array(9).fill(q),[q,{...q,page:2}],[q,{...q,side:'source'}],[q,{...q,rects:[[1,1,1,2]]}],[q,{...q,rects:Array(1)}],[q,{...q,text:''}]]){assert.equal(f.actions.align(1,{explicit:true,selections}),'unavailable');}assert.equal(f.queries.length,0);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment-upgrade')).length,0);}finally{f.done();}
 });
 await check('cleared pending selection responses cannot restore stale status while reselecting the same query reuses its result',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount};
  for(const change of ['clear','reselect','page','original']){
   const late=deferred(),entered=deferred(),mapping={...precisionAlignment(),sourceSHA256:'a'.repeat(64)},binding={jobID:job().id,page:1,sourceSHA256:mapping.sourceSHA256,targetSHA256:'b'.repeat(64),revision:'pdf-selection-semantic-v1'},query={page:1,paragraph:'p1_0',side:'target',rects:[[10,30,80,40]],text:'译文'},statuses=[];let actions;
   const f=controllerFixture(async(method,url)=>{if(url.endsWith('/selection-alignment?page=1'))return json({...binding,links:[]});if(url.endsWith('/selection-alignment')){entered.resolve();await late.promise;return json({...binding,key:'e'.repeat(64),link:null,cached:false});}return url.endsWith('/alignment.json')?json(mapping):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});
   const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(value){statuses.push(value);},updateAlignment(){},updateSelectionLinks(){},async showOutput(){this.visible=true;},showOriginal(){this.visible=false;},restoreOriginal(){this.visible=false;},dispose(){this.visible=false;}};native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};
   try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy);actions.selectionChanged();assert.equal(actions.align(1,{explicit:true,selection:query}),'started');await entered.promise;
    if(change==='clear'||change==='reselect')actions.selectionChanged();
    if(change==='page'){layer.currentSourcePage=2;actions.page(2);}
    if(change==='original')await f.plugin.setMode(f.reader,'original');
    if(change==='reselect')assert.equal(actions.align(1,{explicit:true,selection:query}),'pending');const count=statuses.length;late.resolve();await new Promise(setImmediate);await new Promise(setImmediate);
    if(change==='reselect')assert.equal(statuses.at(-1),'unavailable','the current same-query owner must receive completion instead of remaining preparing');else assert.equal(statuses.length,count,change+' must not be changed by its retired response');
    assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/selection-alignment')).length,1,'same pending query is never submitted twice');
   }finally{late.resolve();native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
  }
 });
 await check('an explicit cold selection uses the small independent endpoint, caches late results and restores permanent page links without a PDF rebuild',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},late=deferred(),entered=deferred(),mapping=precisionAlignment(),full=precisionAlignment(true),key='c'.repeat(64);mapping.sourceSHA256='a'.repeat(64);
  const link={...structuredClone(full.pages[0].paragraphs[0].sentences[0].phrases[0]),id:'sel_'+key,key,paragraph:'p1_0'},binding={jobID:job().id,page:1,sourceSHA256:'a'.repeat(64),targetSHA256:'b'.repeat(64),revision:'pdf-selection-semantic-v1'},query={page:1,paragraph:'p1_0',side:'target',rects:[[10,30,80,40]],text:'译文'},miss={...query,text:'文',rects:[[45,30,80,40]]};let actions,mounts=0;const updates=[],shows=[],statuses=[];
  const f=controllerFixture(async(method,url,options)=>{
   if(url.endsWith('/selection-alignment?page=1'))return json({...binding,links:[]});
   if(url.endsWith('/selection-alignment')){const value=JSON.parse(options.body);if(value.text==='译文'){entered.resolve();await late.promise;return json({...binding,key,link,cached:false});}return json({...binding,key:'d'.repeat(64),link:null,cached:false});}
   if(url.endsWith('/alignment-upgrade'))throw Error('an interactive word must not wait for whole-page readiness');
   return url.endsWith('/alignment.json')?json(mapping):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());
  });
  const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(value){statuses.push(value);},async updateAlignment(){throw Error('selection must not reload the sentence sidecar');},updateSelectionLinks(value){updates.push(value);},async showOutput(data){this.visible=true;shows.push(data);},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};
  native.canMount=()=>true;native.mount=async(_context,_css,value)=>{mounts++;actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy&&updates.some(value=>value.links));assert.equal(actions.align(1,{explicit:true,selection:query}),'started');await entered.promise;assert.equal(actions.align(1,{explicit:true,selection:query}),'pending');actions.align(1,{explicit:true,selection:miss});await settle(()=>updates.some(value=>value.link===null));assert.equal(statuses.at(-1),'unavailable');const settledStatuses=statuses.length;late.resolve();await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(updates.some(value=>value.link?.id===link.id),true,'a validated superseded result must enter the reusable selection store');assert.equal(statuses.length,settledStatuses,'a superseded response must not overwrite the current selection status');assert.equal(actions.align(1,{explicit:true,selection:miss}),'unavailable');assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/selection-alignment')).length,2);assert.equal(actions.align(1,{explicit:true,selection:query}),'ready');assert.equal(updates.at(-1).link.id,link.id);assert.equal(actions.align(1,{explicit:true,retry:true,selection:miss}),'started');await settle(()=>statuses.at(-1)==='unavailable');assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/selection-alignment')).length,3);assert.equal(f.transport.requests.filter(r=>r.method==='DELETE').length,0);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/alignment.json')).length,1);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/mono.pdf')).length,1);assert.equal(mounts,1);assert.equal(shows.length,1);assert.equal(f.renders.length,0);}
  finally{late.resolve();native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 await check('returning to the same pending selection adopts its result and later background alignment keeps the independent links',async()=>{
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},late=deferred(),entered=deferred(),mapping=precisionAlignment(),precise=precisionAlignment(true),key='e'.repeat(64);mapping.sourceSHA256='a'.repeat(64);precise.sourceSHA256=mapping.sourceSHA256;const link={...structuredClone(precise.pages[0].paragraphs[0].sentences[0].phrases[0]),id:'sel_'+key,key,paragraph:'p1_0'},binding={jobID:job().id,page:1,sourceSHA256:mapping.sourceSHA256,targetSHA256:'b'.repeat(64),revision:'pdf-selection-semantic-v1'},query={page:1,paragraph:'p1_0',side:'target',rects:[[10,30,80,40]],text:'译文'};let actions,background=false;const applied=[],updates=[];
  const f=controllerFixture(async(method,url,options)=>{if(url.endsWith('/selection-alignment?page=1'))return json({...binding,links:[]});if(url.endsWith('/selection-alignment')){if(JSON.parse(options.body).text==='译文'){entered.resolve();await late.promise;return json({...binding,key,link,cached:false});}return json({...binding,key:'f'.repeat(64),link:null,cached:false});}if(url.endsWith('/alignment-upgrade')){if(method==='POST')background=true;return json({id:job().id,state:background?'complete':'idle',sourcePages:[1],completedPages:background?[1]:[],mappedSentences:background?1:0},method==='POST'?202:200);}return url.endsWith('/alignment.json')?json(background?precise:mapping):url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json(job());});
  const layer={visible:false,currentSourcePage:1,prepareOutput(){},setProgress(){},setAnnotationStatus(){},updateSelectionLinks(value){applied.push(value);},async updateAlignment(value){updates.push(value);},async showOutput(){this.visible=true;},restoreOriginal(){this.visible=false;},dispose(){this.restoreOriginal();}};native.canMount=()=>true;native.mount=async(_context,_css,value)=>{actions=value;return layer;};
  try{f.plugin.start();await f.plugin.toggle(f.reader);await settle(()=>!f.plugin.state(f.reader).busy&&applied.length>0);actions.align(1,{explicit:true,selection:query});await entered.promise;actions.align(1,{explicit:true,selection:{...query,text:'文',rects:[[45,30,80,40]]}});assert.equal(actions.align(1,{explicit:true,selection:query}),'pending');late.resolve();await settle(()=>applied.some(value=>value.link?.id===link.id));assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/selection-alignment')).length,2);actions.page(1);actions.align(1,{explicit:true});await settle(()=>updates.length===1);assert.equal(applied.some(value=>value.link?.id===link.id),true);assert.equal(actions.align(1,{explicit:true,selection:query}),'ready');assert.equal(applied.at(-1).link.id,link.id);assert.equal(f.transport.requests.filter(r=>r.url.endsWith('/selection-alignment')).length,2);assert.equal(f.transport.requests.filter(r=>r.method==='DELETE').length,0);}
  finally{late.resolve();native.canMount=original.canMount;native.mount=original.mount;try{f.plugin.shutdown();}finally{f.restore();}}
 });
 async function backgroundFixture(options={}){
  const allPages=Array.from({length:options.pageCount||3},(_,i)=>i);
  const native=require('../content/pdf-native-view.js'),original={canMount:native.canMount,mount:native.mount},realNow=Date.now,tasks=new Map(),mounts=new Map(),completed=new Set(options.cached||[]),prepared=new Set(options.prepared||[]),partial=new Set(options.partial||[]),failed=new Set(options.fail||[]),posts=[],controls=[],controlFrames=[],scopes=[],priorities=[],ignoredControls=[],cancelledScopes=new Set(),events=[],gates=new Map(),workPosts=[];let eligible=options.existingIntent===true,blocked=options.blocked===true,clock=10000,sequence=0,current=null,activeScope=null,paused=false,reads=0,heldSelection=null,heldMetadata=null,connectionHold=null,heldWorkStatus=null,holdWorkStatus=options.holdWorkStatus===true;
  Date.now=()=>clock;const scheduler={set(fn,ms=0){const id=++sequence;tasks.set(id,{fn,at:clock+ms});return id;},clear(id){tasks.delete(id);}};
  const mapping=()=>{const ready=[...completed],data={...precisionAlignment(ready.length>0),sourceSHA256:'a'.repeat(64)};data.pages=allPages.map((sourcePage,outputPage)=>({...structuredClone(precisionAlignment(completed.has(sourcePage)).pages[0]),sourcePage,outputPage}));if(ready.length){data.sentencePages=ready;data.phrasePages=ready;data.phraseExtractedPages=ready;data.phraseCoverage=Object.fromEntries(ready.map(page=>[page,precisionAlignment(true).phraseCoverage[1]]));}return data;};
  const state=(kind=current===null?'idle':'running')=>({id:job().id,state:kind,sourcePages:allPages,completedPages:[...completed],preparedPages:[...prepared],partialPages:[...partial],mappedSentences:completed.size,currentPage:current,pendingPages:[],background:current!==null,paused,...(activeScope?{scope:activeScope}:{}),alignmentVersion:'a'.repeat(64),...(kind==='failed'?{error:'alignment_unavailable'}:{})});
  const binding={jobID:job().id,page:1,sourceSHA256:'a'.repeat(64),targetSHA256:'b'.repeat(64),revision:'pdf-selection-semantic-v1'};
  const workStatus=()=>({...state(blocked?'failed':eligible?(current!==null?'running':'complete'):'idle'),durable:eligible,eligible,workState:!eligible?'unregistered':blocked?'blocked':current!==null?'running':partial.size?'partial':'complete'});
  const controller=options.local||options.localMissing?((request,settings)=>localVersionFixture(request,async()=>options.localMissing?null:({...storedVersion(),job:{...job('complete',allPages),pageCount:allPages.length}}),undefined,null,settings)):controllerFixture;
  const f=controller(async(method,url,request)=>{
   events.push({method,url});
   if(url.endsWith('/alignment-work')){
    if(options.oldWorkRoute)return json({error:'not_found'},404);
    if(method==='POST'){assert.equal(request.headers['Content-Type'],'application/pdf');assert.equal(request.headers['X-AskGPT-Full-Translation'],'1');workPosts.push(new Uint8Array(request.body));eligible=true;blocked=failed.size>0;
     if(options.holdPage!==undefined){current=options.holdPage;gates.set(current,deferred());}
     else for(const page of allPages)if(!prepared.has(page)&&!failed.has(page))completed.add(page);
     if(options.holdWorkPost)await gates.get(current)?.promise;
    }
    const response=workStatus();if(method==='GET'&&holdWorkStatus){holdWorkStatus=false;heldWorkStatus=deferred();await heldWorkStatus.promise;if(options.failHeldWorkStatus)throw {xmlhttp:{status:404,responseText:'{"error":"not_found"}'}};}return json(response,method==='POST'?202:200);
   }if(url.endsWith('/alignment-layout.json'))return json({...mapping(),granularity:'paragraph',pages:mapping().pages.map(p=>({...p,paragraphs:p.paragraphs.map(({sentences,...r})=>r)})),sentencePages:undefined,phrasePages:undefined,phraseExtractedPages:undefined,phraseCoverage:undefined,sentenceAlignmentRevision:undefined,phraseAlignmentRevision:undefined,phraseExtractionRevision:undefined});
   if(url.endsWith('/alignment.json')){reads++;return json(mapping());}
   if(url.includes('/alignment-page.json?page=')){reads++;const page=Number(url.split('=').at(-1)),value=mapping();value.pages=value.pages.map(p=>p.sourcePage===page?p:{...p,paragraphs:p.paragraphs.map(({sentences,...row})=>row)});for(const key of ['sentencePages','sentencePartialPages','phrasePages','phraseExtractedPages'])if(value[key])value[key]=value[key].filter(p=>p===page);if(value.phraseCoverage)value.phraseCoverage=Object.fromEntries(Object.entries(value.phraseCoverage).filter(([p])=>Number(p)===page));if(options.holdMetadataPage===page){heldMetadata=deferred();await heldMetadata.promise;}return json(value);}

   if(url.includes('/selection-alignment?'))return json({...binding,page:Number(url.split('=').at(-1)),links:[]});
   if(url.endsWith('/selection-alignment')){if(options.holdSelection){heldSelection=deferred();await heldSelection.promise;}return json({...binding,page:JSON.parse(request.body).page,key:'c'.repeat(64),link:null,cached:false});}
   if(url.endsWith('/alignment-upgrade')){
    if(method==='POST'&&request.headers['Content-Type']==='application/json'){const body=JSON.parse(request.body);if(body.action){controls.push(body.action);controlFrames.push(body);if(body.action==='cancel'&&body.scope)cancelledScopes.add(body.scope);if(activeScope&&body.scope!==activeScope){ignoredControls.push(body);return json(state());}if(body.action==='pause')paused=true;if(body.action==='resume')paused=false;if(body.action==='cancel'){current=null;paused=false;return json({...state('failed'),error:'alignment_cancelled'});}return json(state());}priorities.push(body.page);paused=false;return json(state());}
    if(method==='POST'){assert.equal(request.headers['X-AskGPT-Background'],'1');const scope=request.headers['X-AskGPT-Background-Scope'];if(cancelledScopes.has(scope))return json({...state('failed'),error:'alignment_cancelled'},202);activeScope=scope;scopes.push(scope);current=Number(request.headers['X-AskGPT-Pages'])-1;posts.push(current);if(options.holdPage===current||options.holdPages?.includes(current)){const gate=deferred();gates.set(current,gate);if(options.holdPost)await gate.promise;else return json(state(),202);}if(failed.has(current)){current=null;return json(state('failed'),202);}completed.add(current);current=null;return json(state('complete'),202);}
    return json(state(completed.size===allPages.length?'complete':undefined));
   }
   return url.endsWith('.pdf')?{status:200,response:bytes().buffer}:json({...job(options.failTranslation?'failed':'complete',allPages),...(options.failTranslation?{error:'translation_failed'}:{}),pageCount:allPages.length,...(options.legacy?{reusedLegacy:true,translationRevision:'pdf-layout-gpt-v6-paragraph-isolated'}:{})});
  },{scheduler,alignmentWork:true,readText:async()=>{const gate=connectionHold;connectionHold=null;if(gate)await gate.promise;return JSON.stringify({version:1,endpoint:'http://127.0.0.1:43792',token:'t'.repeat(64)});}});
  native.canMount=()=>true;native.mount=async(context,_css,actions)=>{const alignment=[],updates=[],annotationStatuses=[],layer={visible:false,currentSourcePage:Math.min(1,allPages.length-1),prepareOutput(){},setProgress(){},setAnnotationStatus(value){annotationStatuses.push(value);},setAlignmentProgress(value){alignment.push(value);},updateAlignment(value){updates.push(value);},updateSelectionLinks(){},hasExactSelection:()=>options.exact===true,async showOutput(){this.visible=true;},showOriginal(){this.visible=false;},restoreOriginal(){this.visible=false;},dispose(){this.visible=false;}};mounts.set(context.outerReader,{actions,layer,alignment,updates,annotationStatuses});return layer;};
  async function advance(ms){const end=clock+ms;for(let i=0;i<500;i++){await new Promise(setImmediate);const due=[...tasks].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due){clock=end;await new Promise(setImmediate);if(![...tasks.values()].some(t=>t.at<=end))return;continue;}clock=due[1].at;tasks.delete(due[0]);due[1].fn();}assert.fail('background scheduler did not become idle');}
  f.pdf.numPages=allPages.length;f.win.PDFViewerApplication.pdfViewer.pagesCount=allPages.length;f.win.PDFViewerApplication.pdfViewer.currentPageNumber=Math.min(f.win.PDFViewerApplication.pdfViewer.currentPageNumber,allPages.length);
  try{const toolbar=options.defaultAction==='toolbar'?toolbarFixture(f):null;f.plugin.start();if(toolbar){const button=toolbar.host.allNodes().find(node=>node.tagName==='button'&&node.className?.includes('askgpt-inline-toolbar'));assert(button);button.emit('click');}else if(options.defaultAction==='translate')await f.plugin.translate(f.reader);else if(!options.noAction)await f.plugin.toggle(f.reader,(options.local||options.localMissing)&&!options.explicitWhole?{}:{whole:options.whole!==false});await settle(()=>!f.plugin.state(f.reader).busy);await new Promise(setImmediate);}
  catch(error){native.canMount=original.canMount;native.mount=original.mount;Date.now=realNow;f.plugin.shutdown();f.restore();throw error;}
  return {...f,mounts,posts,workPosts,controls,controlFrames,scopes,priorities,ignoredControls,events,completed,advance,reads:()=>reads,tasks,holdNextConnection(){connectionHold=deferred();return connectionHold.resolve;},releasePage(page){for(const p of allPages)if(!failed.has(p)&&!prepared.has(p))completed.add(p);current=null;gates.get(page)?.resolve();},releaseWorkStatus(){heldWorkStatus?.resolve();},releaseSelection(){heldSelection?.resolve();},releaseMetadata(){heldMetadata?.resolve();},get current(){return mounts.get(f.reader);},async done(){heldWorkStatus?.resolve();connectionHold?.resolve();for(const gate of gates.values())gate.resolve();heldSelection?.resolve();heldMetadata?.resolve();f.plugin.shutdown();await new Promise(setImmediate);native.canMount=original.canMount;native.mount=original.mount;Date.now=realNow;f.restore();}};
 }
 await check('successful explicit whole translation registers one durable task after output without legacy page uploads',async()=>{
  const f=await backgroundFixture();try{await f.advance(700);assert(f.current.layer.visible);assert.equal(f.workPosts.length,1);assert.deepEqual([...f.workPosts[0]],[...bytes()]);assert.deepEqual(f.posts,[]);assert(!f.events.some(e=>e.method==='POST'&&e.url.endsWith('/alignment-upgrade')));}finally{await f.done();}
 });
 await check('opening an old local whole version only probes intent and never starts automatic model work',async()=>{
  const f=await backgroundFixture({local:true});try{await f.advance(2000);assert(f.current.layer.visible);assert.equal(f.workPosts.length,0);assert.deepEqual(f.posts,[]);assert(f.events.some(e=>e.method==='GET'&&e.url.endsWith('/alignment-work')));assert(!f.events.some(e=>e.method==='POST'));}finally{await f.done();}
 });
 await check('the default translation action registers only when it actually completes a new whole translation',async()=>{
  const f=await backgroundFixture({localMissing:true});try{await f.advance(700);assert.equal(f.workPosts.length,1);assert.equal(f.events.filter(e=>e.method==='POST'&&e.url.endsWith('/v1/pdf/jobs')).length,1);f.current.actions.direction('zh-en');await settle(()=>!f.plugin.state(f.reader).busy);await f.advance(700);assert.equal(f.workPosts.length,1,'direction reuse alone is not a new full-work authorization');}finally{await f.done();}
 });
 await check('default user whole actions register cached modern versions including single-page documents without retranslating',async()=>{for(const defaultAction of ['toolbar','translate'])for(const pageCount of [1,3]){const f=await backgroundFixture({local:true,defaultAction,pageCount});try{await f.advance(700);assert.equal(f.workPosts.length,1,defaultAction+' pageCount '+pageCount+' '+JSON.stringify({events:f.events,diagnostics:f.diagnostics,state:f.plugin.state(f.reader)}));assert(!f.events.some(e=>e.method==='POST'&&!e.url.endsWith('/alignment-work')));assert(!f.events.some(e=>e.url.endsWith('.pdf')));await f.plugin.setMode(f.reader,'original');await f.plugin.setMode(f.reader,'dual');await f.advance(700);assert.equal(f.workPosts.length,1,'mode presentation is not another full action');}finally{await f.done();}}});
 await check('opening a reader without a translation action never registers even when a full one-page cache exists',async()=>{const f=await backgroundFixture({local:true,noAction:true,pageCount:1});try{await f.advance(2000);assert.equal(f.workPosts.length,0);assert.equal(f.events.length,0);assert.equal(f.plugin.state(f.reader).open,false);}finally{await f.done();}});
 await check('a default explicit whole action on a retained modern session registers its existing cached version',async()=>{const f=await backgroundFixture({local:true});try{await f.advance(700);assert.equal(f.workPosts.length,0);await f.plugin.translate(f.reader);await f.advance(700);assert.equal(f.workPosts.length,1);assert(!f.events.some(e=>e.method==='POST'&&!e.url.endsWith('/alignment-work')));}finally{await f.done();}});
 await check('a delayed unregistered status or old route failure cannot erase a later explicit whole registration',async()=>{
  for(const failHeldWorkStatus of [false,true]){const f=await backgroundFixture({local:true,holdWorkStatus:true,failHeldWorkStatus});try{await f.advance(700);await f.plugin.translate(f.reader,{whole:true,mode:'dual'});await f.advance(0);assert.equal(f.workPosts.length,1);assert.equal(f.current.alignment.at(-1)?.state,'complete');f.releaseWorkStatus();await f.advance(2000);assert.equal(f.current.alignment.at(-1)?.state,'complete');assert.deepEqual(f.posts,[]);}finally{await f.done();}}
 });
 await check('current-page semantics are lazy cached with an LRU of three while all modern paths avoid full IR',async()=>{
  const f=await backgroundFixture({pageCount:5,cached:[0,1,2,3,4]});try{await f.advance(700);const visit=async page=>{f.current.layer.currentSourcePage=page;f.current.actions.page(page);await f.advance(700);};assert.equal(f.reads(),1,JSON.stringify({events:f.events,diagnostics:f.diagnostics}));await visit(0);await visit(2);assert.equal(f.reads(),3);await visit(0);assert.equal(f.reads(),3,'recent page reuses metadata');await visit(3);await visit(4);await visit(1);assert.equal(f.reads(),6,'evicted oldest semantic page must reload');assert.equal(f.posts.length,0);assert(!f.events.some(e=>e.url.endsWith('/alignment.json')));assert.equal(f.current.updates.at(-1).pages.length,5);assert(f.current.updates.at(-1).pages.every(p=>p.sourcePage===1||p.paragraphs.every(row=>row.sentences===undefined)));}finally{await f.done();}
 });
 await check('cross-page explicit evidence combines exactly its two physical pages from the bounded cache',async()=>{
  const f=await backgroundFixture({pageCount:5,cached:[0,1,2,3,4]});try{await f.advance(700);const query={page:1,paragraph:'p1_0',side:'target',rects:[[10,30,80,40]],text:'译文'};assert.equal(f.current.actions.align(1,{explicit:true,pages:[1,2],selection:query}),'pending');await f.advance(0);const value=f.current.updates.at(-1);assert.deepEqual(value.sentencePages,[1,2]);assert.deepEqual(value.phraseExtractedPages,[1,2]);assert(value.pages.filter(p=>[1,2].includes(p.sourcePage)).every(p=>p.paragraphs[0].sentences.length===1));assert(value.pages.filter(p=>![1,2].includes(p.sourcePage)).every(p=>p.paragraphs.every(row=>row.sentences===undefined)));assert.equal(f.reads(),2);assert(!f.events.some(e=>e.url.endsWith('/alignment.json')));}finally{await f.done();}
 });
 await check('prepared partial cache reports processed pages without claiming strict completion',async()=>{
  const f=await backgroundFixture({prepared:[0,1,2],partial:[0,1,2]});try{await f.advance(700);assert.equal(f.posts.length,0);assert.equal(f.current.alignment.at(-1).state,'partial');assert.equal(f.current.alignment.at(-1).completed,3);assert.equal(f.completed.size,0);assert.equal(f.current.alignment.at(-1).total,3);assert(!f.events.some(e=>e.url.endsWith('/alignment.json')));}finally{await f.done();}
 });
 await check('cold cross-page hydration-only requests never invoke a model and report only strict local correspondence',async()=>{
  for(const exact of [false,true]){const f=await backgroundFixture({cached:[0,1,2],exact});try{await f.advance(700);assert.equal(f.current.actions.align(1,{explicit:true,pages:[1,2],hydrationOnly:true}),'pending');await f.advance(0);assert.equal(f.current.annotationStatuses.at(-1),exact?null:'unavailable');assert.deepEqual(f.posts,[]);assert(!f.events.some(e=>e.method==='POST'&&e.url.endsWith('/selection-alignment')));assert(!f.events.some(e=>e.url.endsWith('/alignment.json')));}finally{await f.done();}}
 });
 await check('LRU hits defer native metadata application until the last reading activity is idle',async()=>{
  const f=await backgroundFixture({cached:[0,1,2]});try{await f.advance(700);f.current.layer.currentSourcePage=0;f.current.actions.page(0);await f.advance(700);f.current.layer.currentSourcePage=1;f.current.actions.page(1);await f.advance(700);const before=f.current.updates.length,reads=f.reads();f.current.actions.alignmentActivity('source');f.current.layer.currentSourcePage=0;f.current.actions.page(0);await f.advance(0);assert.equal(f.current.updates.length,before,'cached glyph mappings must not be validated/applied during scroll');await f.advance(699);assert.equal(f.current.updates.length,before);await f.advance(1);assert.equal(f.current.updates.length,before+1);assert.equal(f.reads(),reads);assert(!f.controls.includes('pause'));}finally{await f.done();}
 });
 await check('partial coverage remains visible even when the legacy strict completed set contains the same page',async()=>{
  const f=await backgroundFixture({cached:[0,1,2],prepared:[0,1,2],partial:[1]});try{await f.advance(700);assert.deepEqual(f.posts,[]);assert.equal(f.current.alignment.at(-1).state,'partial');assert.equal(f.current.alignment.at(-1).completed,3);await f.plugin.setMode(f.reader,'original');await f.plugin.setMode(f.reader,'dual');await f.advance(700);assert.equal(f.current.alignment.at(-1).state,'partial','same-document restart retains partial checkpoint status');assert(!f.events.some(e=>e.url.endsWith('/alignment.json')));}finally{await f.done();}
 });
 await check('explicit selection metadata follows an adjacent verified owner page instead of the dominant viewport',async()=>{
  const f=await backgroundFixture({cached:[0,1,2]});try{await f.advance(700);const query={page:0,paragraph:'p1_0',side:'target',rects:[[10,30,80,40]],text:'译文'};assert.equal(f.current.layer.currentSourcePage,1);assert.equal(f.current.actions.align(0,{explicit:true,pages:[0],selection:query}),'pending');f.current.actions.page(1);await f.advance(0);await new Promise(setImmediate);assert.equal(f.events.filter(e=>e.url.endsWith('/alignment-page.json?page=0')).length,1);assert.equal(f.events.filter(e=>e.method==='POST'&&e.url.endsWith('/selection-alignment')).length,1);assert(!f.events.some(e=>e.url.endsWith('/alignment.json')));}finally{await f.done();}
 });
 await check('cold cross-page metadata-only selections retain their owner when the viewport is already on the second page',async()=>{
  const f=await backgroundFixture({cached:[0,1,2],exact:true});try{await f.advance(700);assert.equal(f.current.actions.align(0,{explicit:true,pages:[0,1],hydrationOnly:true}),'pending');f.current.actions.page(1);await f.advance(0);assert.deepEqual(f.current.updates.at(-1).sentencePages,[0,1]);assert.equal(f.current.annotationStatuses.at(-1),null);assert(!f.events.some(e=>e.method==='POST'&&e.url.endsWith('/selection-alignment')));assert(!f.events.some(e=>e.url.endsWith('/alignment.json')));}finally{await f.done();}
 });
 await check('clearing or scrolling away retires an owner-page metadata load before a late HTTP decode or replay',async()=>{
  for(const change of ['clear','scroll']){const f=await backgroundFixture({cached:[0,1,2],holdMetadataPage:0});try{await f.advance(700);const query={page:0,paragraph:'p1_0',side:'target',rects:[[10,30,80,40]],text:'译文'},updates=f.current.updates.length;f.current.actions.align(0,{explicit:true,pages:[0],selection:query});await f.advance(0);assert.equal(f.events.filter(e=>e.url.endsWith('/alignment-page.json?page=0')).length,1);if(change==='clear')f.current.actions.selectionChanged();else{f.current.layer.currentSourcePage=2;f.current.actions.page(2);}f.releaseMetadata();await f.advance(700);assert(!f.events.some(e=>e.method==='POST'&&e.url.endsWith('/selection-alignment')));if(change==='clear')assert.equal(f.current.updates.length,updates);assert(!f.events.some(e=>e.url.endsWith('/alignment.json')));}finally{await f.done();}}
  const f=await backgroundFixture({pageCount:5,cached:[0,1,2,3,4]});try{await f.advance(700);const before=f.events.length;assert.equal(f.current.actions.align(4,{explicit:true,pages:[4],hydrationOnly:true}),'unavailable');await f.advance(0);assert.equal(f.events.length,before,'a remote page is not a verified adjacent owner');}finally{await f.done();}
 });
 await check('visible-page priority hints only reorder an already eligible running task and deduplicate processed pages',async()=>{
  const f=await backgroundFixture({holdPage:1,cached:[0]});try{await f.advance(700);assert.deepEqual(f.priorities,[1]);f.current.layer.currentSourcePage=2;f.current.actions.page(2);f.current.actions.page(2);f.current.layer.currentSourcePage=0;f.current.actions.page(0);await f.advance(700);assert.deepEqual(f.priorities,[1,2]);assert.equal(f.workPosts.length,1);assert.deepEqual(f.posts,[]);}finally{await f.done();}
  const passive=await backgroundFixture({local:true});try{await passive.advance(700);passive.current.actions.page(2);await passive.advance(700);assert.deepEqual(passive.priorities,[]);assert.equal(passive.workPosts.length,0);}finally{await passive.done();}
 });
 await check('failed whole translation and one-page current action never register durable correspondence',async()=>{
  for(const options of [{failTranslation:true},{pageCount:1,whole:false}]){const f=await backgroundFixture(options);try{await f.advance(2000);assert.equal(f.workPosts.length,0);assert.deepEqual(f.posts,[]);assert(!f.events.some(e=>e.method==='POST'&&e.url.endsWith('/alignment-upgrade')));}finally{await f.done();}}
 });
 await check('cached whole action registers intent without translating or downloading the local PDF again',async()=>{
  const f=await backgroundFixture({local:true});try{await f.advance(700);assert.equal(f.workPosts.length,0);const shows=f.transport.requests.filter(e=>e.url.endsWith('.pdf')).length;await f.plugin.translate(f.reader,{whole:true,mode:'dual'});await f.advance(700);assert.equal(f.workPosts.length,1);assert(!f.events.some(e=>e.method==='POST'&&!e.url.endsWith('/alignment-work')));assert.equal(f.transport.requests.filter(e=>e.url.endsWith('.pdf')).length,shows);await f.plugin.translate(f.reader,{whole:true,mode:'dual'});await f.advance(700);assert.equal(f.workPosts.length,2,'a later explicit whole action can retry a blocked intent idempotently');assert.deepEqual(f.posts,[]);}finally{await f.done();}
 });
 await check('a newly prepared visible page refreshes its idle metadata even when status polling skipped that active page',async()=>{
  const f=await backgroundFixture({holdPage:0});try{await f.advance(700);assert.equal(f.reads(),1);f.releasePage(0);await f.advance(1500);assert.equal(f.reads(),2);assert(f.current.updates.at(-1).pages.find(p=>p.sourcePage===1).paragraphs[0].sentences?.length);assert(!f.events.some(e=>e.url.endsWith('/alignment.json')));}finally{await f.done();}
 });
 await check('ordinary reading defers metadata while durable status remains a lightweight readonly watcher',async()=>{
  const f=await backgroundFixture({holdPage:1});try{await f.advance(700);assert.equal(f.workPosts.length,1);const reads=f.reads();for(let i=0;i<20;i++)f.current.actions.alignmentActivity('source');f.releasePage(1);await f.advance(500);assert.equal(f.reads(),reads);await f.advance(700);assert.deepEqual(f.controls,[]);assert(!f.events.some(e=>e.url.endsWith('/alignment.json')));assert.deepEqual(f.posts,[]);assert.equal(f.current.alignment.at(-1).state,'complete');}finally{await f.done();}
 });
 await check('foreground selection remains available without client-side pause or cancel of persistent work',async()=>{
  const f=await backgroundFixture({holdPage:1,holdSelection:true});try{await f.advance(700);const query={page:1,paragraph:'p1_0',side:'target',rects:[[10,30,80,40]],text:'译文'};f.current.actions.align(1,{explicit:true,selection:query});await f.advance(2000);assert.equal(f.events.filter(e=>e.method==='POST'&&e.url.endsWith('/selection-alignment')).length,1);assert.deepEqual(f.controls,[]);f.releaseSelection();await f.advance(1000);assert.deepEqual(f.controls,[]);assert.equal(f.workPosts.length,1);}finally{await f.done();}
 });
 await check('hiding closing changing tabs and shutdown retire only the watcher while accepted work continues',async()=>{
  for(const change of ['original','close','otherTab','shutdown']){const f=await backgroundFixture({holdPage:1,holdWorkPost:true});try{await f.advance(700);assert.equal(f.workPosts.length,1);if(change==='original')await f.plugin.setMode(f.reader,'original');if(change==='close')f.plugin.restore(f.reader);if(change==='shutdown')f.plugin.shutdown();if(change==='otherTab'){f.reader._window.Zotero_Tabs.selectedID='other';f.tabEvent('select',['other']);}const oldCount=f.current.alignment.length;f.releasePage(1);await f.advance(2000);assert.deepEqual(f.controls,[],change);assert.equal(f.workPosts.length,1,change);assert.deepEqual(f.posts,[],change);assert.equal(f.completed.size,3,'server-owned work finishes after the reader watcher retires');assert.equal(f.current.alignment.length,oldCount,change);assert(!f.events.some(e=>e.method==='DELETE'),change);}finally{await f.done();}}
 });
 await check('mode restoration reads an existing persistent intent without registering or resubmitting pages',async()=>{
  const f=await backgroundFixture({holdPage:1});try{await f.advance(700);await f.plugin.setMode(f.reader,'original');await f.plugin.setMode(f.reader,'dual');await f.advance(700);assert.equal(f.workPosts.length,1);assert.deepEqual(f.controls,[]);assert.deepEqual(f.posts,[]);f.releasePage(1);await f.advance(1500);assert.equal(f.current.alignment.at(-1).state,'complete');assert.equal(f.current.alignment.at(-1).completed,3);}finally{await f.done();}
 });
 await check('a blocked persistent task stays partial and cannot blindly retry during reading',async()=>{
  const f=await backgroundFixture({fail:[1]});try{await f.advance(700);assert.equal(f.current.alignment.at(-1).state,'partial');assert.equal(f.current.alignment.at(-1).completed,2);await f.advance(10000);f.current.actions.page(2);await f.advance(1000);assert.equal(f.workPosts.length,1);assert.deepEqual(f.posts,[]);assert.deepEqual(f.controls,[]);}finally{await f.done();}
 });
 await check('an old alignment-work route preserves readable cached output without legacy automatic indexing',async()=>{
  const f=await backgroundFixture({local:true,oldWorkRoute:true});try{await f.advance(3000);assert(f.current.layer.visible);assert.equal(f.workPosts.length,0);assert.deepEqual(f.posts,[]);assert.equal(f.events.filter(e=>e.url.endsWith('/alignment-work')).length,1);assert(!f.events.some(e=>e.method==='POST'));assert(f.diagnostics.some(e=>e.stage==='alignment'&&e.error.code==='alignment_unavailable'));}finally{await f.done();}
 });
 await check('changing the active reader stops its watcher without cancelling either durable task',async()=>{
  const f=await backgroundFixture({holdPage:1});try{await f.advance(700);const first=f.current,second={...f.reader,tabID:'second-fixture',_iframeWindow:new DOM.Window()};f.reader._window.Zotero_Tabs.selectedID=second.tabID;await f.plugin.toggle(second,{whole:true});await settle(()=>!f.plugin.state(second).busy);await f.advance(700);assert.deepEqual(f.controls,[]);const oldStatusCount=first.alignment.length;f.releasePage(1);await f.advance(1500);assert.equal(first.alignment.length,oldStatusCount);assert.equal(first.alignment.at(-1),null);assert(f.mounts.get(second).alignment.some(value=>value?.state==='complete'));assert(!f.events.some(e=>e.method==='DELETE'));}finally{await f.done();}
 });
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../manifest.json'),'utf8'));
 await check('Zotero 9 manifest and bootstrap load PDF layout before adapter',()=>{
  assert.equal(manifest.manifest_version,2);assert.equal(manifest.applications.zotero.id,'askgpt-inline@local.askgpt.reader');assert.equal(manifest.applications.zotero.strict_min_version,'9.0');assert.equal(manifest.applications.zotero.strict_max_version,'9.*');assert(new URL(manifest.applications.zotero.update_url).hostname==='127.0.0.1');
  const boot=fs.readFileSync(path.join(__dirname,'../bootstrap.js'),'utf8');assert(boot.indexOf("'content/pdf-layout.js'")<boot.indexOf("'content/inline.js'"));
 });
 clearTimeout(watchdog);process.stdout.write(JSON.stringify({status:'PASS',checks})+'\n');
})().catch(error=>{clearTimeout(watchdog);process.stderr.write(error.stack+'\n');process.exitCode=1;});
