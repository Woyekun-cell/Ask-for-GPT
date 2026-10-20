const assert = require('node:assert/strict');
const PDF = require('../content/inline.js');
const DOM = require('./fake-dom.cjs');
let checks = 0;
const tick = () => new Promise(setImmediate);
async function until(test) { for (let i=0;i<200;i++) { if (test()) return; await tick(); } assert(test(), 'background work did not reach the expected state'); }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return {promise,resolve}; };
const bytes = name => new TextEncoder().encode('%PDF-1.7\n'+name+'\n');
const complete = name => ({id:'task_'+name,state:'complete',sourcePages:[0,1,2],pageCount:3});
const json = value => ({status:200,responseText:JSON.stringify(value)});
async function check(name,test) { await test(); checks++; process.stdout.write('PASS '+name+'\n'); }
function fixture({separateWindows=false,slowData=false,slowDelete=false}={}) {
  const main=new DOM.Window(),other=separateWindows?new DOM.Window():main;
  main.Zotero_Tabs={selectedID:'a'}; if(separateWindows)other.Zotero_Tabs={selectedID:'b'};
  const documents={},requests=[],readers=[],post={a:deferred(),b:deferred()},data=deferred(),deletion=deferred(); let observer;
  const create=DOM.Document.prototype.createElementNS;
  DOM.Document.prototype.createElementNS=function(ns,name) {const n=create.call(this,ns,name);if(name==='canvas')n.getContext=()=>({canvas:n});return n;};
  for (const [name,owner] of [['a',main],['b',other]]) {
    const {win,viewer}=DOM.pdfWindow(),loaded=[]; viewer.style.setProperty('visibility','visible');
    win.pdfjsLib={PDFWorker:class {destroy(){}},getDocument(options){loaded.push(new TextDecoder().decode(options.data));return {promise:Promise.resolve({numPages:3,destroy(){},async getPage(){return {getViewport:({scale})=>({width:600*scale,height:800*scale,scale}),render:()=>({promise:Promise.resolve(),cancel(){}})};}}),destroy(){}};}};
    const pdf={getPageData:async()=>[],getData:()=>name==='a'&&slowData?data.promise:Promise.resolve(bytes('source-'+name))};
    win.PDFViewerApplication={pdfDocument:pdf,pdfViewer:{currentPageNumber:1,pagesCount:3},eventBus:{on(){},off(){}}};
    const reader={type:'pdf',tabID:name,_window:owner,_iframeWindow:new DOM.Window(),_internalReader:{_primaryView:{_iframeWindow:win}}};readers.push(reader);documents[name]={reader,win,viewer,pdf,loaded};
  }
  const file={permissions:0o600,fileSize:200,clone(){return {...this};},append(){},exists:()=>true,isFile:()=>true,isSymlink:()=>false};
  const plugin=PDF.create({css:'',pluginID:'fixture',setTimer:fn=>setTimeout(fn,0),clearTimer:clearTimeout,
    Components:{interfaces:{nsIFile:{}},utils:{cloneInto:value=>value}},Services:{dirsvc:{get:()=>file}},
    readText:async()=>JSON.stringify({version:1,endpoint:'http://127.0.0.1:43792',token:'t'.repeat(64)}),
    Zotero:{getMainWindow:()=>main,getMainWindows:()=>separateWindows?[main,other]:[main],Reader:{_readers:readers,getByTabID:id=>readers.find(r=>r.tabID===id),registerEventListener(){},_unregisterEventListenerByPluginID(){}},
      Notifier:{registerObserver(value){observer=value;return 1;},unregisterObserver(){}},
      HTTP:{async request(method,url,options){const input={method,url,options};requests.push(input);
        if(method==='POST'){const name=new TextDecoder().decode(options.body).includes('source-a')?'a':'b';return post[name].promise;}
        if(method==='DELETE'){if(slowDelete&&url.endsWith('task_a'))return deletion.promise;return {status:204};}
        if(url.endsWith('.pdf'))return {status:200,response:bytes(url.includes('task_a/')?'output-a':'output-b').buffer};
        throw Error('Unexpected request '+method+' '+url);
      }}
    }});
  plugin.start();
  function select(name) {const entry=documents[name];entry.reader._window.Zotero_Tabs.selectedID=name;observer.notify('select','tab',[name]);entry.reader._window.emit('focus');entry.win.emit('focus');}
  return {plugin,documents,requests,post,data,deletion,select,observer,
    start:name=>plugin.translate(documents[name].reader,{whole:true,mode:'mono',direction:'en-zh'}),
    state:name=>plugin.state(documents[name].reader),
    finish(name){post[name].resolve(json(complete(name)));},
    async close(){for(const name of ['a','b'])post[name].resolve(json(complete(name)));data.resolve(bytes('source-a'));deletion.resolve({status:204});plugin.shutdown();await tick();await tick();DOM.Document.prototype.createElementNS=create;}
  };
}
(async()=>{
 await check('switching tabs retains each running translation and returns output to its document',async()=>{
  const f=fixture();try {
    await f.start('a');await until(()=>f.requests.filter(r=>r.method==='POST').length===1);
    f.select('b');assert.equal(f.state('a').busy,true);assert.equal(f.state('a').open,true);
    await f.start('b');await until(()=>f.requests.filter(r=>r.method==='POST').length===2);
    assert.equal(f.state('a').busy,true);assert.equal(f.state('b').busy,true);assert(!f.requests.some(r=>r.method==='DELETE'));
    f.finish('a');await until(()=>!f.state('a').busy);assert.equal(f.state('b').busy,true);
    assert.equal(f.documents.b.loaded.length,0);f.select('a');await until(()=>f.documents.a.loaded.length===1);
    assert(f.documents.a.loaded[0].includes('output-a'));assert.equal(f.state('b').open,true);
    f.select('b');f.finish('b');await until(()=>!f.state('b').busy);assert(f.documents.b.loaded[0].includes('output-b'));
    assert.equal(f.state('a').open,true);assert(!f.requests.some(r=>r.method==='DELETE'));
  } finally {await f.close();}
 });
 await check('focusing a different reader window never cancels another document',async()=>{
  const f=fixture({separateWindows:true});try {
    await f.start('a');await until(()=>f.requests.filter(r=>r.method==='POST').length===1);
    f.select('b');await f.start('b');await until(()=>f.requests.filter(r=>r.method==='POST').length===2);
    f.documents.a.win.emit('focus');f.documents.b.win.emit('focus');
    assert.equal(f.state('a').busy,true);assert.equal(f.state('b').busy,true);
    f.finish('b');f.finish('a');await until(()=>!f.state('a').busy&&!f.state('b').busy);
    assert(!f.requests.some(r=>r.method==='DELETE'));assert(f.documents.a.loaded[0].includes('output-a'));assert(f.documents.b.loaded[0].includes('output-b'));
  } finally {await f.close();}
 });
 await check('a tab switch while reading source bytes does not abandon its authorized task',async()=>{
  const f=fixture({slowData:true});try {
    await f.start('a');f.select('b');await f.start('b');await until(()=>f.requests.filter(r=>r.method==='POST').length===1);
    f.data.resolve(bytes('source-a'));await until(()=>f.requests.filter(r=>r.method==='POST').length===2);
    f.finish('a');f.finish('b');await until(()=>!f.state('a').busy&&!f.state('b').busy);
    assert.equal(f.state('a').open,true);assert(!f.requests.some(r=>r.method==='DELETE'));
  } finally {await f.close();}
 });
 await check('retiring one running document cannot hold up starting a different one',async()=>{
  const f=fixture({slowDelete:true});try {
    await f.start('a');await until(()=>f.requests.filter(r=>r.method==='POST').length===1);f.plugin.restore(f.documents.a.reader);
    f.post.a.resolve(json({...complete('a'),state:'running'}));
    await until(()=>f.requests.some(r=>r.method==='DELETE'));
    f.select('b');await f.start('b');await until(()=>f.requests.filter(r=>r.method==='POST').length===2);
    assert.equal(f.state('b').busy,true);f.finish('b');await until(()=>!f.state('b').busy);
  } finally {await f.close();}
 });
 await check('explicit cancellation affects only its own running document',async()=>{
  const f=fixture();try {
    await f.start('a');f.select('b');await f.start('b');await until(()=>f.requests.filter(r=>r.method==='POST').length===2);
    f.select('a');f.plugin.restore(f.documents.a.reader);f.finish('a');await until(()=>f.requests.some(r=>r.method==='DELETE'&&r.url.endsWith('task_a')));
    assert.equal(f.state('a').open,false);assert.equal(f.state('b').busy,true);
    f.select('b');f.finish('b');await until(()=>!f.state('b').busy);
    assert(!f.requests.some(r=>r.method==='DELETE'&&r.url.endsWith('task_b')));
  } finally {await f.close();}
 });
 await check('replacing a background source retires only its stale job',async()=>{
  const f=fixture();try {
    await f.start('a');f.select('b');await f.start('b');await until(()=>f.requests.filter(r=>r.method==='POST').length===2);
    f.documents.a.win.PDFViewerApplication.pdfDocument={getData:async()=>bytes('replacement')};f.finish('a');
    await until(()=>!f.state('a').open);assert.equal(f.state('b').busy,true);assert.equal(f.documents.a.loaded.length,0);
    f.finish('b');await until(()=>!f.state('b').busy);assert(f.documents.b.loaded[0].includes('output-b'));
  } finally {await f.close();}
 });
 process.stdout.write(JSON.stringify({status:'PASS',checks})+'\n');
})().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
