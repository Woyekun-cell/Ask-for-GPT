const {test}=require('node:test');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const {createFakeWord}=require('./fake-word.cjs');

// Model the official Office.js navigation cache and run cleanup boundary:
// explicit track removes a proxy from automatic cleanup; untrack permanently
// retires that proxy. The real SDK then rejects tracking it again.
function navigationLifetimeWord(options={}){
  const fake=createFakeWord(options),doc=fake.document,context=doc.context;
  const retired=new Set(),explicit=new Set();let used=null;
  const observe=object=>{used?.add(object);return object;};
  const invalid=()=>Object.assign(Error('Navigation proxy has an invalid object path'),{code:'InvalidObjectPath'});
  const install=(object,parent=null)=>{
    object._clientObject=true;object.context=context;
    const assertLive=()=>{for(let current=object;current;current=current._lifetimeParent)if(retired.has(current))throw invalid();};
    object._lifetimeParent=parent;
    const load=object.load?.bind(object);
    object.load=(...args)=>{observe(object);assertLive();load?.(...args);return object;};
    object.track=()=>{if(retired.has(object))throw Object.assign(Error('The object is untracked.'),{code:'GeneralException'});explicit.add(object);fake.state.tracked.add(object);return object;};
    object.untrack=()=>{retired.add(object);explicit.delete(object);fake.state.tracked.delete(object);return object;};
    return object;
  };
  const body=install(doc.body),paragraphs=install(body.paragraphs,body);
  const originalWindow=doc.activeWindow,originalPane=originalWindow.activePane;
  const originalViewport=Object.getOwnPropertyDescriptor(originalPane,'pagesEnclosingViewport').get;
  const window=install(Object.create(originalWindow)),pane=install(Object.create(originalPane),window);
  let pageItems=[];const pages=install({get items(){observe(pages);return pageItems;},load(){pageItems=originalViewport.call(originalPane).items;return this;}},pane);
  Object.defineProperty(doc,'body',{get(){return observe(body);}});
  Object.defineProperty(body,'paragraphs',{get(){return observe(paragraphs);}});
  Object.defineProperty(doc,'activeWindow',{get(){return observe(window);}});
  Object.defineProperty(window,'activePane',{get(){return observe(pane);}});
  Object.defineProperty(pane,'pagesEnclosingViewport',{get(){return observe(pages);}});
  window.isActive=true;
  const run=fake.Word.run.bind(fake.Word);
  fake.Word.run=(...args)=>run(...args.slice(0,-1),async ctx=>{
    used=new Set();
    try{return await args.at(-1)(ctx);}
    finally{const cleanup=used;used=null;for(const object of cleanup)if(!explicit.has(object))object.untrack();}
  });
  return fake;
}
async function setup(options){
  const fake=navigationLifetimeWord(options);
  const {createWordHost}=await import(pathToFileURL(path.join(__dirname,'../word/word-host.js')).href);
  const host=createWordHost({...fake,requireActiveWindow:true});await host.initialize();return {host,fake};
}

test('cached navigation survives the native activity probe and failed page range metadata recovery',async()=>{
  const {host,fake}=await setup({pageRangeFailure:true});
  try{
    await host.run(async context=>{const window=context.document.activeWindow;window.load('isActive');await context.sync();assert.equal(window.isActive,true);});
    const scope=await host.captureScope('visiblePages');
    assert.equal(scope.scope,'visiblePages');assert.ok(scope.snapshots.length>0);assert.equal(fake.state.replacements.length,0);
  }finally{await host.dispose();}
  assert.equal(fake.state.tracked.size,0);
});

test('empty repeated page captures preserve cached navigation for a later spelling issue with bounded owners',async()=>{
  const {host,fake}=await setup({paragraphs:[{id:'empty',text:'   ',pages:[1]}],viewport:[1]});
  try{
    for(let index=0;index<12;index++){
      const scope=await host.captureScope('visiblePages');assert.equal(scope.scope,'visiblePages');assert.equal(scope.snapshots.length,0);
      assert.ok(fake.state.tracked.size<=6,'empty polling must not accumulate navigation owners');
    }
    fake.document.paragraphs[0].text='The resuts are clear.';
    const scope=await host.captureScope('visiblePages');assert.equal(scope.scope,'visiblePages');assert.equal(scope.snapshots[0].rawText,'The resuts are clear.');
    assert.equal(fake.state.replacements.length,0);
  }finally{await host.dispose();}
  assert.equal(fake.state.tracked.size,0);
});

test('a failed metadata batch cannot retire cached navigation needed by explicit reinitialization',async()=>{
  const {host,fake}=await setup({pageRangeFailure:true,bodyMetadataFailure:true});
  try{
    const fallback=await host.captureScope('visiblePages');assert.equal(fallback.scope,'activeParagraph');
    fake.state.bodyMetadataFailure=false;await host.initialize();
    const recovered=await host.captureScope('visiblePages');assert.equal(recovered.scope,'visiblePages');assert.ok(recovered.snapshots.length>0);
    assert.equal(fake.state.replacements.length,0);
  }finally{await host.dispose();}
  assert.equal(fake.state.tracked.size,0);
});
