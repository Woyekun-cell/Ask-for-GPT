const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const load = name => import(pathToFileURL(path.join(__dirname, name)).href);

test('contract keeps exact raw UTF-16 text and validates complete issue envelopes', async () => {
  const { createSnapshot, assertIssueEnvelope } = await load('../shared/host-contract.js');
  const snapshot = await createSnapshot({ requestID: 'r', documentSessionID: 'd', blockID: 'b', revision: 0, rawText: '  😀e\u0301 ', contextBefore: '', contextAfter: '', targetRange: { start: 0, length: 7 }, protectedRanges: [], pageIndices: [], scope: 'activeParagraph' });
  assert.equal(snapshot.rawText, '  😀e\u0301 ');
  assert.equal(snapshot.snapshotHash.length, 64);
  assert.throws(() => assertIssueEnvelope({ snapshot, issue: { original: '😀', replacement: 'x', range: { start: 3, length: 1 } } }), /range|boundary/);
});
const { createFakeWord } = require('./fake-word.cjs');
async function setup(options) { const fake = createFakeWord(options); const { createWordHost } = await load('../word/word-host.js'); const timers = { callback: null, setInterval(fn, ms) { assert.equal(ms, 750); this.callback = fn; return 1; }, clearInterval() { this.callback = null; } }; const host = createWordHost({ ...fake, timers, requireActiveWindow:options?.requireActiveWindow===true, diagnostics:options?.diagnostics }); await host.initialize(); return { fake, host, timers }; }
function navigationFixture(fake,pane) {
  for(const object of [pane,pane.pagesEnclosingViewport])Object.assign(object,{_clientObject:true,context:fake.document.context,track(){fake.state.tracked.add(this);return this;},untrack(){fake.state.tracked.delete(this);return this;}});
  return pane;
}
function envelope(snapshot, original = 'are', replacement = 'is', start = snapshot.rawText.indexOf(original)) { return { snapshot, issue: { id: 'issue1', category: 'grammar', original, replacement, reason: 'agreement', range: { start, length: original.length }, requiresAuthorConfirmation: false } }; }
async function sharedHosts(options) {
  const first=await setup(options),{createWordHost}=await load('../word/word-host.js');
  const timers={callback:null,setInterval(fn,ms){assert.equal(ms,750);this.callback=fn;return 1;},clearInterval(){this.callback=null;}};
  const second=createWordHost({...first.fake,timers});await second.initialize();
  return {...first,second,secondTimers:timers};
}
test('shared Word FIFO serializes captures from two distinct adapters in the same runtime',async()=>{
  const {host,second,fake}=await sharedHosts(),context=fake.document.context,sync=context.sync.bind(context);
  let release,entered,blocked=false;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  context.sync=async()=>{await sync();if(!blocked){blocked=true;entered();await gate;}};
  const first=host.captureScope();await started;const next=second.captureScope();
  for(let i=0;i<12;i++)await Promise.resolve();const concurrent=fake.state.maxRuns;
  release();const scopes=await Promise.all([first,next]);
  try{assert.equal(concurrent,1);assert.equal(fake.state.maxRuns,1);assert.ok(scopes.every(scope=>scope.scope==='visiblePages'));assert.notEqual(scopes[0].snapshots[0].documentSessionID,scopes[1].snapshots[0].documentSessionID);}
  finally{await host.dispose();await second.dispose();}
});
test('shared Word FIFO preserves each adapter queue and exact bound ClientObject arguments',async()=>{
  const {host,second,fake}=await sharedHosts(),rawRun=fake.Word.run.bind(fake.Word),bindings=[],order=[];
  fake.Word.run=(...args)=>{bindings.push(args[0]);return rawRun(...args);};
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const first=host.run(fake.document.paragraphs[0],async()=>{order.push('first-start');entered();await gate;order.push('first-end');});await started;
  const same=host.run(fake.document.paragraphs[1],async()=>{order.push('same-adapter');});
  const other=second.run(async()=>{order.push('other-adapter');});
  for(let i=0;i<12;i++)await Promise.resolve();const beforeRelease=[...order];release();await Promise.all([first,same,other]);
  try{assert.deepEqual(beforeRelease,['first-start']);assert.ok(order.indexOf('same-adapter')>order.indexOf('first-end'));assert.ok(bindings.includes(fake.document.paragraphs[0]));assert.ok(bindings.includes(fake.document.paragraphs[1]));assert.ok(bindings.includes(second.documentProxy));assert.equal(fake.state.maxRuns,1);}
  finally{await host.dispose();await second.dispose();}
});
test('shared Word FIFO recovers after a failed raw run without poisoning either adapter queue',async()=>{
  const {host,second,fake}=await sharedHosts();let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const failed=assert.rejects(host.run(async()=>{entered();await gate;throw Object.assign(Error('Expected native failure'),{code:'GeneralException'});}),error=>error.code==='GeneralException');
  await started;const other=second.run(async context=>{await context.sync();return 'other';});const same=host.run(async()=> 'same');
  for(let i=0;i<12;i++)await Promise.resolve();const concurrent=fake.state.maxRuns;release();await failed;
  try{assert.equal(await other,'other');assert.equal(await same,'same');assert.equal(concurrent,1);assert.equal(fake.state.maxRuns,1);}
  finally{await host.dispose();await second.dispose();}
});
test('shared Word FIFO leaves different Word runtime objects independent',async()=>{
  const first=await setup(),second=await setup();let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const blocked=first.host.run(async()=>{entered();await gate;});await started;let otherEntered=false;
  const other=second.host.run(async()=>{otherEntered=true;});for(let i=0;i<12;i++)await Promise.resolve();const independent=otherEntered;
  release();await Promise.all([blocked,other]);
  try{assert.equal(independent,true);assert.equal(first.fake.state.maxRuns,1);assert.equal(second.fake.state.maxRuns,1);}
  finally{await first.host.dispose();await second.host.dispose();}
});
test('shared Word FIFO drains cross-adapter events polling removal and stop without deadlock',{timeout:2000},async()=>{
  const {host,second,fake,timers,secondTimers}=await sharedHosts(),events=[];
  const stop=await host.watch(event=>events.push(event)),stopSecond=await second.watch(event=>events.push(event));
  const firstPoll=timers.callback(),secondPoll=secondTimers.callback(),changed=fake.emit('onParagraphChanged');
  await Promise.all([firstPoll,secondPoll,changed,stop(),stopSecond()]);
  await Promise.all([host.dispose(),second.dispose()]);
  assert.equal(fake.state.maxRuns,1);assert.equal(timers.callback,null);assert.equal(secondTimers.callback,null);assert.equal(fake.state.tracked.size,0);assert.ok(Object.values(fake.state.handlers).every(handlers=>handlers.size===0));
});
test('page capture explicitly requests Whole on hosts that reject an omitted range location',async()=>{
  const {host,fake}=await setup({requireExplicitPageRange:true});
  const result=await host.captureScope('visiblePages');
  assert.equal(result.scope,'visiblePages');
  assert.deepEqual(result.pageIndices,[1,2]);
  assert.ok(fake.state.pageRangeLocations.length>=2);
  assert.ok(fake.state.pageRangeLocations.every(value=>value==='Whole'));
});
test('temporary page failure title contains only fixed diagnostic tokens and never native prose or document text',async()=>{
  const previous=globalThis.document;globalThis.document={title:'写作',createElement(){return {};}};
  try{
    const {host,fake}=await setup({diagnostics:true,pageRangeFailure:true,paragraphs:[{text:'PRIVATE_SOURCE are clear.',pages:[1]}]});fake.document.body.paragraphs.load=()=>{throw Object.assign(new Error('PRIVATE_NATIVE_PROSE'),{code:'NotSupported',debugInfo:{statement:'PRIVATE_TOKEN',errorLocation:'PRIVATE_PATH'}});};
    await host.captureScope();assert.match(globalThis.document.title,/^写作 \[stage_pageRange;code_InvalidArgument;.*\|stage_paragraphIndex;code_NotSupported;/);assert.equal(globalThis.document.title.includes('PRIVATE'),false);await host.dispose();
    globalThis.document.title='写作';const env=await setup({diagnostics:true}),run=env.host.run.bind(env.host);let injected=false;const {HostContractError}=await load('../shared/host-contract.js');env.host.run=(...args)=>{if(!injected){injected=true;return Promise.reject(new HostContractError('pageReadUnavailable','PRIVATE_API_KEY'));}return run(...args);};
    await env.host.captureScope();assert.equal(globalThis.document.title,'写作');await env.host.dispose();
  }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});
test('temporary final-batch trace exposes only fixed operations and executed marker IDs without relaxing the scope gate',async()=>{
  const previous=globalThis.document;globalThis.document={title:'写作',createElement(){return {};}};
  try{
    const {host,fake}=await setup({diagnostics:true,pageRangeFailure:true,viewport:[1]}),context=fake.document.context,traces=[];context.trace=id=>traces.push(id);const sync=context.sync.bind(context);let failed=false;
    context.sync=async()=>{await sync();if(!failed&&fake.state.bodyLoads.length===2){failed=true;throw Object.assign(new Error('PRIVATE_NATIVE_MESSAGE'),{code:'GeneralException',traceMessages:['wf0','wf1','wf2','wf3','wf4','PRIVATE_TRACE'],debugInfo:{statement:'PRIVATE_PATH.getRange().pages.load("PRIVATE_TEXT")',surroundingStatements:['PRIVATE_DOCUMENT.paragraphs.track()','PRIVATE_TOKEN._KeepReference()','PRIVATE_TEXT']}});}};
    const scope=await host.captureScope();assert.equal(scope.scope,'activeParagraph');assert.equal(host.capabilities.visiblePages,false);assert.deepEqual(traces,['wf0','wf1','wf2','wf3','wf4','wf5','wf6']);assert.match(globalThis.document.title,/stage_viewportFinal;code_GeneralException;.*near_paragraphs\+track\+_KeepReference;trace_wf0\+wf1\+wf2\+wf3\+wf4/);assert.equal(globalThis.document.title.includes('PRIVATE'),false);assert.equal(fake.state.replacements.length,0);await host.dispose();assert.equal(fake.state.tracked.size,0);
  }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});
test('paragraph page metadata fallback loads only visible text and bounded neighbors while tracking the body parent',async()=>{
  const {host,fake}=await setup({pageRangeFailure:true,strictParentTracking:true,viewport:[2],paragraphs:Array.from({length:7},(_,i)=>({id:'p'+i,text:`Paragraph ${i} are clear.`,pages:i===3?[2,3]:[i<3?1:4]}))});
  const scope=await host.captureScope();assert.equal(scope.scope,'visiblePages');assert.deepEqual(scope.pageIndices,[2]);assert.deepEqual(scope.snapshots.map(s=>s.blockID),['p3']);assert.deepEqual(scope.snapshots[0].pageIndices,[2,3]);
  assert.deepEqual(fake.state.bodyLoads,Array.from({length:2},()=>({select:'uniqueLocalId',top:1001,skip:0})));assert.ok(fake.state.paragraphTextLoads.every(id=>['p2','p3','p4'].includes(id)));assert.equal(new Set(fake.state.paragraphPageReads).size,7);assert.ok(fake.state.parentTrackChecks>0);await host.focusIssue(envelope(scope.snapshots[0]));await host.dispose();assert.equal(fake.state.tracked.size,0);
});
test('paragraph page metadata fallback uses immutable UID lookup when final collection reload invalidates old member paths',async()=>{
  const {host,fake}=await setup({pageRangeFailure:true,invalidateBodyMembersOnReload:true,strictParentTracking:true,viewport:[1],paragraphs:[{id:'a',text:'First are clear.',pages:[1]},{id:'b',text:'Second are clear.',pages:[2]}]}),lookups=[],lookup=fake.document.getParagraphByUniqueLocalId.bind(fake.document);fake.document.getParagraphByUniqueLocalId=id=>{lookups.push(id);return lookup(id);};
  const scope=await host.captureScope();assert.equal(scope.scope,'visiblePages');assert.deepEqual(lookups,['a','b','a','b']);assert.equal(host.capabilities.visiblePages,true);assert.deepEqual(scope.snapshots.map(s=>s.blockID),['a']);await host.applyIssue(envelope(scope.snapshots[0]));assert.equal(fake.document.paragraphs[0].text,'First is clear.');
  const next=await host.captureScope();assert.equal(next.scope,'visiblePages');assert.equal(next.snapshots[0].rawText,'First is clear.');await host.dispose();assert.equal(fake.state.tracked.size,0);
});
test('initial metadata capture uses UID-derived paragraphs when native collection-member range paths are unavailable',async()=>{
  const {host,fake}=await setup({pageRangeFailure:true,bodyMemberRangesUnavailable:true,viewport:[1],paragraphs:[{id:'a',text:'First are clear.',pages:[1]},{id:'b',text:'Second are clear.',pages:[2]}]});
  try{
    const scope=await host.captureScope('visiblePages');assert.equal(scope.scope,'visiblePages');assert.deepEqual(scope.snapshots.map(s=>s.blockID),['a']);assert.deepEqual(scope.pageIndices,[1]);
    assert.equal(new Set(fake.state.paragraphPageReads).size,2);await host.applyIssue(envelope(scope.snapshots[0]));assert.equal(fake.document.paragraphs[0].text,'First is clear.');
  }finally{await host.dispose();assert.equal(fake.state.tracked.size,0);}
});
test('initial UID metadata refuses missing or mismatched paragraph identities without publishing a partial visible page',async()=>{
  for(const kind of ['missing','mismatch']){
    const {host,fake}=await setup({pageRangeFailure:true,viewport:[1],paragraphs:[{id:'a',text:'First are clear.',pages:[1]},{id:'b',text:'Second are clear.',pages:[2]}]}),lookup=fake.document.getParagraphByUniqueLocalId.bind(fake.document);
    fake.document.getParagraphByUniqueLocalId=id=>{if(id==='b'){if(kind==='missing')throw Object.assign(Error('Missing paragraph'),{code:'ItemNotFound'});return lookup('a');}return lookup(id);};
    try{const scope=await host.captureScope();assert.equal(scope.scope,'activeParagraph',kind);assert.equal(host.capabilities.visiblePages,false,kind);assert.equal(fake.state.replacements.length,0,kind);}
    finally{await host.dispose();assert.equal(fake.state.tracked.size,0,kind);}
  }
});
test('default Word diagnostics keep the title unchanged and perform no traces or UID matrix probes',async()=>{
  const previous=globalThis.document;globalThis.document={title:'Writing assistant',createElement(){}};
  try{
    for(const diagnostics of [undefined,false,'true',1])for(const indexFailure of [false,true]){
      globalThis.document.title='Writing assistant';const {host,fake}=await setup({diagnostics,pageRangeFailure:true,viewport:[1]}),traces=[],collection=fake.document.body.paragraphs,load=collection.load.bind(collection),run=fake.Word.run.bind(fake.Word);let freshRuns=0;
      fake.document.context.trace=id=>traces.push(id);fake.Word.run=(...args)=>{if(args.length===1)freshRuns++;return run(...args);};
      if(indexFailure)collection.load=options=>{if(options?.top===1001)throw Object.assign(Error('PRIVATE_NATIVE_PROSE'),{code:'GeneralException'});return load(options);};
      try{
        const scope=await host.captureScope();assert.equal(scope.scope,indexFailure?'activeParagraph':'visiblePages');
        assert.equal(globalThis.document.title,'Writing assistant');assert.deepEqual(traces,[]);assert.equal(freshRuns,0);assert.equal(fake.state.bodyLoads.some(options=>options?.top===1||options?.$top===1),false);
        assert.match(host.pageReadFailureDiagnostic,indexFailure?/stage_paragraphIndex;code_GeneralException;/:/stage_pageRange;code_InvalidArgument;/);assert.equal(host.pageReadFailureDiagnostic.includes('PRIVATE'),false);assert.equal(fake.state.replacements.length,0);
      }finally{await host.dispose();}
    }
  }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});
test('one-shot UID matrix runs six serial bounded metadata probes without text URL writes or identifier output',async()=>{
  const previous=globalThis.document;globalThis.document={title:'写作',createElement(){}};
  const id='01234567-89ab-cdef-0123-456789abcdef',env=await setup({diagnostics:true,viewport:[1],paragraphs:[{id,text:'PRIVATE_MANUSCRIPT are clear.',pages:[1]},{id:'11111111-1111-1111-1111-111111111111',text:'PRIVATE_SECOND.',pages:[2]}]}),{host,fake}=env;
  const collection=fake.document.body.paragraphs,load=collection.load.bind(collection);let indexFailures=0;
  collection.load=options=>{if(options?.top===1001){indexFailures++;throw Object.assign(Error('PRIVATE_NATIVE_MESSAGE'),{code:'GeneralException',debugInfo:{statement:'PRIVATE_TOKEN uniqueLocalId load'}});}return load(options);};
  const run=fake.Word.run.bind(fake.Word),runs=[];let urlReads=0;
  Object.defineProperty(fake.Office.context.document,'url',{get(){urlReads++;return '';}});
  fake.Word.run=async(...args)=>{const entry={bound:args.length===2};runs.push(entry);const start={text:fake.state.paragraphTextLoads.length,xml:fake.state.xmlReads,writes:fake.state.replacements.length,selected:fake.state.selected.length,tracked:fake.state.tracked.size,url:urlReads};try{return await run(...args);}finally{Object.assign(entry,{text:fake.state.paragraphTextLoads.length-start.text,xml:fake.state.xmlReads-start.xml,writes:fake.state.replacements.length-start.writes,selected:fake.state.selected.length-start.selected,tracked:fake.state.tracked.size-start.tracked,url:urlReads-start.url});}};
  host.pageMetadataFallback=true;
  try{
    const scope=await host.captureScope();assert.equal(scope.scope,'activeParagraph');
    assert.match(globalThis.document.title,/uidmatrix\[fs_ok_n1_g1;cs_ok_n1_g1;fl_ok_n1_g1;cl_ok_n1_g1;ft_ok_n1_g1;ct_ok_n1_g1\]/);
    assert.equal(globalThis.document.title.includes(id),false);assert.equal(globalThis.document.title.includes('PRIVATE'),false);
    const probes=runs.slice(1,7);assert.equal(probes.length,6);assert.deepEqual(probes.map(item=>item.bound),[false,true,false,true,false,true]);
    assert.ok(probes.every(item=>item.text===0&&item.xml===0&&item.writes===0&&item.selected===0&&item.tracked===0&&item.url===0));assert.equal(fake.state.maxRuns,1);
    assert.deepEqual(fake.state.bodyLoads.filter(options=>options?.top===1||options?.$top===1),[{select:'uniqueLocalId',top:1,skip:0},{select:'uniqueLocalId',top:1,skip:0},{uniqueLocalId:true,$top:1,$skip:0},{uniqueLocalId:true,$top:1,$skip:0}]);
    const firstCount=fake.state.bodyLoads.length;host.capabilities.visiblePages=true;await host.captureScope();assert.equal(indexFailures,2);assert.equal(fake.state.bodyLoads.length,firstCount,'one-shot probes must not repeat');assert.equal(host.capabilities.visiblePages,false);assert.equal(host.capabilities.safeReplace,true);
  }finally{await host.dispose();globalThis.document=previous;}
});
test('one-shot UID matrix sanitizes native failures and ignores unrelated index errors',async()=>{
  const previous=globalThis.document;globalThis.document={title:'写作',createElement(){}};
  try{
    const {host,fake}=await setup({diagnostics:true,viewport:[1]}),collection=fake.document.body.paragraphs,load=collection.load.bind(collection),run=fake.Word.run.bind(fake.Word);let runNumber=0;
    collection.load=options=>{if(options?.top===1001)throw Object.assign(Error('PRIVATE_INDEX'),{code:'GeneralException'});return load(options);};
    fake.Word.run=(...args)=>{runNumber++;if(runNumber===2&&args.length===1)return Promise.reject(Object.assign(Error('PRIVATE_TOKEN'),{code:'PRIVATE_CODE',debugInfo:{statement:'PRIVATE_SOURCE'}}));return run(...args);};
    host.pageMetadataFallback=true;await host.captureScope();assert.match(globalThis.document.title,/uidmatrix\[fs_other_n0_g0;cs_ok_n1_g0;/);assert.equal(globalThis.document.title.includes('PRIVATE'),false);await host.dispose();
    globalThis.document.title='写作';const unrelated=await setup({diagnostics:true,bodyMetadataFailure:true});unrelated.host.pageMetadataFallback=true;await unrelated.host.captureScope();assert.equal(globalThis.document.title.includes('uidmatrix'),false);await unrelated.host.dispose();
  }finally{globalThis.document=previous;}
});
test('paragraph page metadata fallback freshly follows scrolling repagination and edits without cached text or pages',async()=>{
  const {host,fake}=await setup({pageRangeFailure:true,viewport:[1],paragraphs:[{id:'a',text:'First are clear.',pages:[1]},{id:'b',text:'Second are clear.',pages:[2]}]});
  const first=await host.captureScope();assert.deepEqual(first.snapshots.map(s=>s.blockID),['a']);fake.state.viewport=[2];fake.document.paragraphs[0].pages=[2];fake.document.paragraphs[1].pages=[3];fake.document.paragraphs[0].text='First are changed.';
  const next=await host.captureScope();assert.deepEqual(next.snapshots.map(s=>s.blockID),['a']);assert.equal(next.snapshots[0].rawText,'First are changed.');assert.deepEqual(next.snapshots[0].pageIndices,[2]);assert.equal(fake.state.bodyLoads.length,4);await host.applyIssue(envelope(next.snapshots[0]));assert.equal(fake.document.paragraphs[0].text,'First is changed.');await host.dispose();
});
test('paragraph page metadata fallback retains a shared parent until every capture group releases it',async()=>{
  const {host,fake}=await setup({pageRangeFailure:true,strictParentTracking:true,viewport:[1]});await host.captureScope();await host.captureScope();
  assert.equal(fake.state.tracked.has(fake.document.body.paragraphs),true);assert.equal(fake.state.tracked.has(fake.document.paragraphs[0]),true);await host.dispose();assert.equal(fake.state.tracked.size,0);
});
test('paragraph page metadata fallback rejects a viewport changed inside the capture before publishing scope',async()=>{
  const {host,fake}=await setup({pageRangeFailure:true,viewport:[1],paragraphs:[{id:'a',text:'First are clear.',pages:[1]},{id:'b',text:'Second are clear.',pages:[2]}]});const p=fake.document.paragraphs[0],load=p.load.bind(p);p.load=properties=>{if(properties==='text')fake.state.viewport=[2];return load(properties);};
  const scope=await host.captureScope();assert.equal(scope.scope,'activeParagraph');assert.equal(host.capabilities.visiblePages,false);assert.match(host.pageReadFailureDiagnostic,/stage_viewportFinal/);assert.equal(fake.state.tracked.has(fake.document.body.paragraphs),true,'cached navigation stays owned until adapter disposal');await host.dispose();assert.equal(fake.state.tracked.size,0);
});
test('paragraph page metadata fallback rejects document identity changed inside the capture and releases unpublished tracking',async()=>{
  const {host,fake}=await setup({pageRangeFailure:true,viewport:[1]});const p=fake.document.paragraphs[0],load=p.load.bind(p);p.load=properties=>{if(properties==='text')fake.Office.context.document={url:'',mode:'readWrite'};return load(properties);};
  await assert.rejects(host.captureScope(),error=>error.code==='documentChanged');assert.equal(fake.state.tracked.has(fake.document.body.paragraphs),true,'cached navigation stays owned until adapter disposal');assert.equal(fake.state.tracked.has(p),false);await host.dispose();assert.equal(fake.state.tracked.size,0);
});
test('paragraph page metadata fallback rejects an initially offpage paragraph moved into the unchanged viewport during capture',async()=>{
  const {host,fake}=await setup({pageRangeFailure:true,viewport:[1],paragraphs:[{id:'a',text:'First are clear.',pages:[1]},{id:'b',text:'Second are clear.',pages:[2]}]});const p=fake.document.paragraphs[0],load=p.load.bind(p);p.load=properties=>{if(properties==='text')fake.document.paragraphs[1].pages=[1];return load(properties);};
  const scope=await host.captureScope();assert.equal(scope.scope,'activeParagraph');assert.equal(host.capabilities.visiblePages,false);assert.equal(fake.state.tracked.has(fake.document.body.paragraphs),true,'cached navigation stays owned until adapter disposal');await host.dispose();assert.equal(fake.state.tracked.size,0);
});
test('paragraph page metadata fallback rejects a changed body ID sequence before publishing a partial scope',async()=>{
  const {host,fake}=await setup({pageRangeFailure:true,viewport:[1],paragraphs:[{id:'a',text:'First are clear.',pages:[1]},{id:'b',text:'Second are clear.',pages:[2]}]});const p=fake.document.paragraphs[0],load=p.load.bind(p);let changed=false;p.load=properties=>{if(properties==='text'&&!changed){changed=true;const added={...fake.document.paragraphs[1],uniqueLocalId:'new-paragraph',text:'New text.'};fake.document.paragraphs.push(added);}return load(properties);};
  const scope=await host.captureScope();assert.equal(scope.scope,'activeParagraph');assert.equal(host.capabilities.visiblePages,false);assert.equal(fake.state.tracked.has(fake.document.body.paragraphs),true,'cached navigation stays owned until adapter disposal');await host.dispose();assert.equal(fake.state.tracked.size,0);
});
test('paragraph page metadata fallback bounds the body index at 1001 and refuses partial results above 1000',async()=>{
  for(const count of [1000,1001]){
    const {host,fake}=await setup({pageRangeFailure:true,viewport:[1],paragraphs:Array.from({length:count},(_,i)=>({id:'p'+i,text:i===0?'The result are clear.':'Off page.',pages:[i===0?1:2]}))});
    const scope=await host.captureScope();assert.equal(scope.scope,count===1000?'visiblePages':'activeParagraph');assert.equal(fake.state.bodyLoads[0]?.top,1001);if(count===1001){assert.equal(new Set(fake.state.paragraphPageReads).size,0);assert.match(host.pageReadFailureDiagnostic,/metadataParagraphLimit/);}await host.dispose();
  }
});
test('paragraph page metadata fallback rejects unknown empty invalid and duplicate metadata before visible text loading',async()=>{
  for(const kind of ['emptyPages','invalidPages','missingViewport','duplicateID','missingID','rangeFailure','indexFailure','emptyBody']){
    const {host,fake}=await setup({pageRangeFailure:true,viewport:[1],paragraphs:[{id:'a',text:'The result are clear.',pages:[1]},{id:'b',text:'Off page.',pages:[2]}]});
    if(kind==='emptyPages')fake.document.paragraphs[1].pages=[];if(kind==='invalidPages')fake.document.paragraphs[1].pages=[-1];if(kind==='missingViewport')fake.state.viewport=[9];if(kind==='duplicateID')fake.document.paragraphs[1].uniqueLocalId='a';if(kind==='missingID')fake.document.paragraphs[1].uniqueLocalId='';if(kind==='rangeFailure')fake.state.paragraphPagesFailure=true;if(kind==='indexFailure')fake.state.bodyMetadataFailure=true;if(kind==='emptyBody')fake.document.body.paragraphs={items:[],load(){return this;}};
    const scope=await host.captureScope();assert.equal(scope.scope,'activeParagraph',kind);assert.equal(host.capabilities.visiblePages,false);assert.ok(fake.state.bodyLoads.every(options=>options.select==='uniqueLocalId'));assert.equal(fake.state.replacements.length,0);await host.dispose();
  }
});
test('internal page range diagnostic separates range sync from paragraph sync and never reflects statements',async()=>{
  for(const [failedStage,statement,want] of [
    ['pageRange','PRIVATE_DOCUMENT getRange(Whole); load(isEmpty)','getRange+load'],
    ['pageParagraphs','PRIVATE_DOCUMENT range.paragraphs.load(items/text)','paragraphs+load'],
    ['pageParagraphs','PRIVATE_DOCUMENT load(items/text)','load'],
  ]){
    const {host,fake}=await setup();let rangeVerified=false,pending=null;
    const error=Object.assign(new Error('PRIVATE_NATIVE_MESSAGE'),{code:'InvalidArgument',debugInfo:{errorLocation:'PRIVATE_LOCATION',statement}});
    const collection={items:[],load(){assert.equal(rangeVerified,true);if(failedStage==='pageParagraphs')pending=error;return this;}};
    fake.document.activeWindow.activePane=navigationFixture(fake,{pagesEnclosingViewport:{items:[{index:1,getRange(location){assert.equal(location,'Whole');return {load(properties){assert.equal(properties,'isEmpty');if(failedStage==='pageRange')pending=error;return this;},get paragraphs(){assert.equal(rangeVerified,true);return collection;}};}}],load(){return this;}}});
    const context=fake.document.context,sync=context.sync.bind(context);context.sync=async()=>{await sync();if(pending){const failed=pending;pending=null;throw failed;}rangeVerified=true;};
    const scope=await host.captureScope();
    assert.equal(scope.scope,'visiblePages');assert.match(host.pageReadFailureDiagnostic,new RegExp('stage_'+failedStage+';code_InvalidArgument;loc_other;stmt_'+want.replace('+','\\+')+';n_1'));
    assert.equal(host.capabilities.message.includes('PRIVATE'),false);assert.equal(fake.state.replacements.length,0);await host.dispose();
  }
});
test('page range verification completes before reading page paragraphs',async()=>{
  const {host,fake}=await setup();let queued=false,verified=false,reads=0;
  const context=fake.document.context,sync=context.sync.bind(context);context.sync=async()=>{await sync();if(queued)verified=true;};
  fake.document.activeWindow.activePane=navigationFixture(fake,{pagesEnclosingViewport:{items:[{index:1,getRange(){return {load(properties){assert.equal(properties,'isEmpty');queued=true;return this;},get paragraphs(){assert.equal(verified,true);reads++;return {items:[],load(){return this;}};}};} }],load(){return this;}}});
  const scope=await host.captureScope();assert.equal(scope.scope,'visiblePages');assert.equal(reads,1);assert.equal(verified,true);await host.dispose();
});
function flatOPC(main) {
  return `<pkg:package xmlns:pkg="http://schemas.microsoft.com/office/2006/xmlPackage" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><pkg:part pkg:name="/word/document.xml" pkg:contentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"><pkg:xmlData>${main}</pkg:xmlData></pkg:part><pkg:part pkg:name="/word/settings.xml" pkg:contentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"><pkg:xmlData><w:settings><w:drawingGridVerticalSpacing w:val="156"/><m:mathPr><m:mathFont m:val="Cambria Math"/><m:brkBin m:val="before"/><m:brkBinSub m:val="--"/></m:mathPr></w:settings></pkg:xmlData></pkg:part><pkg:part pkg:name="/word/styles.xml" pkg:contentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"><pkg:xmlData><w:styles><w:style w:type="table" w:styleId="TableGrid"><w:tblPr><w:tblBorders><w:insideH w:val="single"/><w:insideV w:val="single"/></w:tblBorders></w:tblPr></w:style></w:styles></pkg:xmlData></pkg:part></pkg:package>`;
}

test('native-only activity guard checks the active window in the last text read before Replace',async()=>{
  for(const activeAtLastRead of [true,false]){
    const {host,fake}=await setup({requireActiveWindow:true,support:{WordApi:'1.8',WordApiDesktop:'1.4'}}),snapshot=(await host.captureScope()).snapshots[0];
    let queued=false,active=true;const window=fake.document.activeWindow;window.load=properties=>{assert.equal(properties,'isActive');queued=true;return window;};Object.defineProperty(window,'isActive',{get:()=>active});
    const context=fake.document.context,sync=context.sync.bind(context);context.sync=async()=>{await sync();if(queued)active=activeAtLastRead;};
    if(activeAtLastRead){await host.applyIssue(envelope(snapshot));assert.equal(fake.state.replacements.length,1);}else{await assert.rejects(host.applyIssue(envelope(snapshot)),error=>error.code==='document_inactive');assert.equal(fake.state.replacements.length,0);}
    assert.equal(queued,true);
  }
});

test('native-only last activity batch also rejects text changed during that final sync',async()=>{
  const {host,fake}=await setup({requireActiveWindow:true,support:{WordApi:'1.8',WordApiDesktop:'1.4'}}),snapshot=(await host.captureScope()).snapshots[0];
  let queued=false;const window=fake.document.activeWindow;window.load=()=>{queued=true;return window;};window.isActive=true;
  const context=fake.document.context,sync=context.sync.bind(context);context.sync=async()=>{await sync();if(queued)fake.document.paragraphs[0].text='An entirely different sentence.';};
  await assert.rejects(host.applyIssue(envelope(snapshot)),/stale/i);assert.equal(fake.state.replacements.length,0);
});

test('grapheme change replaces only the single-run changed span while unchanged word text may cross font runs',async()=>{
  for(const [original,replacement,split,start,end,text] of [
    ['Appla','Apple',1,4,5,'e'],['resuts','results',3,3,4,'ul'],['e\u0301rr','e\u0301xrr',2,0,2,'e\u0301x'],['😀ok','😀Xok',2,0,2,'😀X'],['xxa','xa',1,1,2,''],['word','sword',2,0,1,'sw'],['word','words',2,3,4,'ds'],
  ]){
    const {host,fake}=await setup({paragraphs:[{text:original,pages:[1],runs:[{start:0,end:split},{start:split,end:original.length,properties:'<w:rFonts w:hint="eastAsia"/>'}]}]}),snapshot=(await host.captureScope()).snapshots[0],item=envelope(snapshot,original,replacement,0);
    assert.equal((await host.getIssueActions(item)).canApply,true,original);await host.applyIssue(item);assert.deepEqual(fake.state.replacements,[{id:'p0',start,end,text}],original);assert.equal(fake.document.paragraphs[0].text,replacement);await host.dispose();
  }
});

// Public Word copy: work/writing-assistant/AskGPT-writing-format-inspection-41.docx.
// Its Wrting and Appla paragraphs contain these exact flat font/shading values,
// paragraph-mark rPr, and paragraph-level spellStart/spellEnd metadata.
const liveWordShading='<w:shd w:val="clear" w:color="auto" w:fill="FAFAF8"/>';
const liveWordRunProperties='<w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:cs="Segoe UI"/><w:color w:val="2D2D2B"/><w:sz w:val="20"/><w:szCs w:val="20"/>'+liveWordShading;
function liveWordProofXML(xml,proof='<w:proofErr w:type="spellStart"/>',end='<w:proofErr w:type="spellEnd"/>') {
  return flatOPC(xml.replace('<w:p>','<w:p><w:pPr><w:rPr>'+liveWordRunProperties+'</w:rPr></w:pPr>'+proof).replace('</w:p>',end+'</w:p>'));
}

test('Word flat spelling metadata permits shaded real-copy patterns with unchanged multi-run prefixes',async()=>{
  for(const [original,replacement,start,end,text]of [['Wrting','Writing',1,2,'ri'],['Appla','Apple',4,5,'e']]){
    const properties=liveWordRunProperties;
    const {host,fake}=await setup({paragraphs:[{text:original,pages:[1],runs:[{start:0,end:1,properties},{start:1,end:original.length,properties}]}],wrapOOXML:xml=>liveWordProofXML(xml)});
    const snapshot=(await host.captureScope()).snapshots[0],item=envelope(snapshot,original,replacement,0);
    try{assert.equal((await host.getIssueActions(item)).canApply,true,original);await host.applyIssue(item);assert.deepEqual(fake.state.replacements,[{id:'p0',start,end,text}],original);assert.equal(fake.document.paragraphs[0].text,replacement);assert.deepEqual(fake.document.paragraphs[0].runs.map(run=>run.properties),[properties,properties]);}
    finally{await host.dispose();}
  }
});

test('Word flat spelling metadata permits only the four empty Word proof marker types',async()=>{
  for(const type of ['spellStart','spellEnd','gramStart','gramEnd']){
    const {host,fake}=await setup({wrapOOXML:xml=>flatOPC(xml.replace('<w:p>','<w:p><w:proofErr w:type="'+type+'"/>'))}),snapshot=(await host.captureScope()).snapshots[0];
    try{assert.equal((await host.getIssueActions(envelope(snapshot))).canApply,true,type);await host.applyIssue(envelope(snapshot));assert.equal(fake.state.replacements.length,1,type);}
    finally{await host.dispose();}
  }
});

test('Word flat spelling metadata rejects unknown proof attributes namespaces children and text',async()=>{
  for(const proof of [
    '<w:proofErr/>','<w:proofErr w:type="unknown"/>','<w:proofErr type="spellStart"/>',
    '<w:proofErr w:type="spellStart" w:extra="1"/>','<w:proofErr w:type="spellStart" extra="1"/>',
    '<x:proofErr xmlns:x="urn:unknown" w:type="spellStart"/>','<w:proofErr xmlns:x="urn:unknown" x:type="spellStart"/>',
    '<w:proofErr w:type="spellStart"><w:r/></w:proofErr>',
    '<w:proofErr w:type="spellStart">x</w:proofErr>','<w:proofErr w:type="spellStart"> </w:proofErr>',
  ]){
    const {host,fake}=await setup({wrapOOXML:xml=>liveWordProofXML(xml,proof)}),snapshot=(await host.captureScope()).snapshots[0];
    try{assert.equal((await host.getIssueActions(envelope(snapshot))).canApply,false,proof);await assert.rejects(host.applyIssue(envelope(snapshot)),/protected|preview|format/i);assert.equal(fake.state.replacements.length,0,proof);}
    finally{await host.dispose();}
  }
});

test('Word flat spelling metadata keeps shading flat and dangerous neighboring structures protected',async()=>{
  for(const markup of ['<w:fldSimple/>','<w:instrText/>','<w:sdt/>','<m:oMath/>','<w:ins/>','<w:del/>','<w:unknown/>','<w:rPr><w:shd><w:color/></w:shd></w:rPr>','<w:rPr><x:shd xmlns:x="urn:unknown"/></w:rPr>']){
    const {host,fake}=await setup({paragraphs:[{text:'Appla',pages:[1],runs:[{start:0,end:1,properties:liveWordRunProperties},{start:1,end:5,properties:liveWordRunProperties}]}],wrapOOXML:xml=>liveWordProofXML(xml.replace('<w:r>','<w:r>'+markup))}),snapshot=(await host.captureScope()).snapshots[0],item=envelope(snapshot,'Appla','Apple',0);
    try{assert.equal((await host.getIssueActions(item)).canApply,false,markup);await assert.rejects(host.applyIssue(item),/protected|preview|format|field/i);assert.equal(fake.state.replacements.length,0,markup);}
    finally{await host.dispose();}
  }
  const {host,fake}=await setup({paragraphs:[{text:'Appla',pages:[1],runs:[{start:0,end:1,properties:liveWordRunProperties},{start:1,end:5,properties:liveWordRunProperties}]}],wrapOOXML:xml=>liveWordProofXML(xml)}),snapshot=(await host.captureScope()).snapshots[0],item=envelope(snapshot,'Appla','Orange',0);
  try{assert.equal((await host.getIssueActions(item)).canApply,false);await assert.rejects(host.applyIssue(item),/protected|preview|format/i);assert.equal(fake.state.replacements.length,0);}
  finally{await host.dispose();}
});

test('final apply batch co-reads active source context and minimal target once for shaded W plus rting',async()=>{
  const properties=liveWordRunProperties,{host,fake}=await setup({requireActiveWindow:true,support:{WordApi:'1.8',WordApiDesktop:'1.4'},paragraphs:[{id:'before',text:'Public preceding context.',pages:[1]},{id:'target',text:'Wrting',pages:[1],runs:[{start:0,end:1,properties},{start:1,end:6,properties}]},{id:'after',text:'Public following context.',pages:[1]}],wrapOOXML:xml=>liveWordProofXML(xml)});
  const snapshot=(await host.captureScope()).snapshots.find(item=>item.blockID==='target'),item=envelope(snapshot,'Wrting','Writing',0);
  const loads=new Set();let targetLoaded=false,windowLoaded=false,barrier=null;
  for(const paragraph of fake.document.paragraphs){const load=paragraph.load.bind(paragraph);paragraph.load=properties=>{if(properties.split(',').includes('text'))loads.add(paragraph.uniqueLocalId);return load(properties);};}
  const locate=host.literalRangeAt.bind(host);host.literalRangeAt=async(...args)=>{const range=await locate(...args),load=range.load.bind(range);range.load=properties=>{if(properties==='text')targetLoaded=true;return load(properties);};return range;};
  const window=fake.document.activeWindow;window.isActive=true;window.load=properties=>{assert.equal(properties,'isActive');windowLoaded=true;return window;};
  const sync=fake.document.context.sync.bind(fake.document.context);fake.document.context.sync=async()=>{if(windowLoaded){barrier={paragraphs:[...loads].sort(),targetLoaded};windowLoaded=false;}loads.clear();targetLoaded=false;await sync();};
  const before=fake.state.syncs,runs=fake.state.runs;
  try{
    await host.applyIssue(item);
    assert.equal(fake.state.syncs-before,8,'native minimal apply reduces three final reads to one');
    assert.equal(fake.state.runs-runs,1);
    assert.deepEqual(barrier,{paragraphs:['after','before','target'],targetLoaded:true});
    assert.deepEqual(fake.state.replacements,[{id:'target',start:1,end:2,text:'ri'}]);
    assert.equal(fake.document.paragraphs[1].text,'Writing');assert.deepEqual(fake.document.paragraphs[1].runs.map(run=>run.properties),[properties,properties]);
  }finally{await host.dispose();}
});

for(const mutation of ['source','context_before','context_after','range','active','readOnly','revision','document'])test('final apply batch rejects last-sync '+mutation+' changes without writing',async()=>{
  const {host,fake}=await setup({requireActiveWindow:true,support:{WordApi:'1.8',WordApiDesktop:'1.4'},paragraphs:[{id:'before',text:'Public preceding context.',pages:[1]},{id:'target',text:'Wrting',pages:[1],runs:[{start:0,end:1,properties:liveWordRunProperties},{start:1,end:6,properties:liveWordRunProperties}]},{id:'after',text:'Public following context.',pages:[1]}],wrapOOXML:xml=>liveWordProofXML(xml)});
  const snapshot=(await host.captureScope()).snapshots.find(item=>item.blockID==='target'),item=envelope(snapshot,'Wrting','Writing',0);
  let finalBatch=false,changed=false,targetRange;const locate=host.literalRangeAt.bind(host);host.literalRangeAt=async(...args)=>{targetRange=await locate(...args);return targetRange;};
  const window=fake.document.activeWindow;window.isActive=true;window.load=()=>{finalBatch=true;return window;};
  const sync=fake.document.context.sync.bind(fake.document.context);fake.document.context.sync=async()=>{await sync();if(!finalBatch||changed)return;changed=true;
    if(mutation==='source')fake.document.paragraphs[1].text='Different public text.';
    else if(mutation==='context_before')fake.document.paragraphs[0].text='Changed preceding context.';
    else if(mutation==='context_after')fake.document.paragraphs[2].text='Changed following context.';
    else if(mutation==='range')Object.defineProperty(targetRange,'text',{get:()=>'?'});
    else if(mutation==='active')window.isActive=false;
    else if(mutation==='readOnly')fake.Office.context.document.mode='readOnly';
    else if(mutation==='revision')host.blockStates.get(snapshot.blockID).revision++;
    else fake.Office.context.document={url:'',mode:'readWrite'};
  };
  const expected=mutation==='active'?'document_inactive':mutation==='readOnly'?'protectedRange':mutation==='document'?'documentChanged':'staleSnapshot';
  let commits=0;
  try{await assert.rejects(host.applyIssue(item,{onCommit(){commits++;}}),error=>error.code===expected,mutation);assert.equal(changed,true);assert.equal(fake.state.replacements.length,0,mutation);assert.equal(commits,0);assert.equal(host.applying,false);}
  finally{await host.dispose();}
});

test('apply commit callback fires once with no arguments after Word sync and before cleanup without awaiting its return',async()=>{
  const {host,fake}=await setup(),snapshot=(await host.captureScope()).snapshots[0],events=[];let commits=0,release,entered;
  const gate=new Promise(resolve=>release=resolve),inside=new Promise(resolve=>entered=resolve),sync=fake.document.context.sync.bind(fake.document.context);
  fake.document.context.sync=async()=>{await sync();if(fake.state.replacements.length){events.push('write_sync_started');entered();await gate;events.push('write_sync_finished');}};
  const clear=host.clear.bind(host);host.clear=async()=>{events.push('cleanup');return clear();};
  const work=host.applyIssue(envelope(snapshot),{onCommit(...args){assert.deepEqual(args,[]);commits++;events.push('commit');return new Promise(()=>{});}});
  await inside;assert.equal(commits,0,'issuing Replace is not confirmation of a committed edit');release();
  try{await work;assert.equal(commits,1);assert.deepEqual(events,['write_sync_started','write_sync_finished','commit','cleanup']);assert.equal(fake.state.replacements.length,1);}
  finally{await host.dispose();}
});

test('apply commit callback exceptions cannot change a successful edit or trigger another write',async()=>{
  const {host,fake}=await setup(),snapshot=(await host.captureScope()).snapshots[0];let commits=0;
  try{await host.applyIssue(envelope(snapshot),{onCommit(){commits++;throw Error('Callback failed');}});assert.equal(commits,1);assert.equal(fake.state.replacements.length,1);assert.equal(host.applying,false);}
  finally{await host.dispose();}
});

test('apply commit callback never confirms a failed Word Replace sync',async()=>{
  const {host,fake}=await setup(),snapshot=(await host.captureScope()).snapshots[0];let commits=0;
  const sync=fake.document.context.sync.bind(fake.document.context);fake.document.context.sync=async()=>{await sync();if(fake.state.replacements.length)throw Object.assign(Error('Commit response unavailable'),{code:'GeneralException'});};
  try{await assert.rejects(host.applyIssue(envelope(snapshot),{onCommit(){commits++;}}),error=>error.code==='GeneralException');assert.equal(commits,0);assert.equal(host.applying,false);}
  finally{fake.document.context.sync=sync;await host.dispose();}
});

test('grapheme change searches inside its full issue rather than all repeated letters in the paragraph',async()=>{
  const prefix='a '.repeat(80),original='Appla',raw=prefix+original;
  const {host,fake}=await setup({paragraphs:[{text:raw,pages:[1],runs:[{start:0,end:raw.length-1},{start:raw.length-1,end:raw.length,properties:'<w:rFonts w:ascii="Arial"/>'}]}]}),snapshot=(await host.captureScope()).snapshots[0];
  await host.applyIssue(envelope(snapshot,original,'Apple',prefix.length));assert.deepEqual(fake.state.replacements,[{id:'p0',start:raw.length-1,end:raw.length,text:'e'}]);await host.dispose();
});

test('grapheme change still refuses a truly changed span across runs and protected unchanged issue text',async()=>{
  for(const options of [
    {paragraphs:[{text:'Appla',pages:[1],runs:[{start:0,end:4},{start:4,end:5}]}],replacement:'Orange'},
    {paragraphs:[{text:'Appla',pages:[1],fieldRanges:[{start:0,length:1}]}],replacement:'Apple'},
    {paragraphs:[{text:'e\u0301rr',pages:[1],runs:[{start:0,end:1},{start:1,end:4}]}],replacement:'e\u0301xrr'},
  ]){
    const {host,fake}=await setup(options),snapshot=(await host.captureScope()).snapshots[0],item=envelope(snapshot,snapshot.rawText,options.replacement,0);
    assert.equal((await host.getIssueActions(item)).canApply,false);await assert.rejects(host.applyIssue(item),/protected|preview|format/i);assert.equal(fake.state.replacements.length,0);await host.dispose();
  }
});

test('grapheme change native final batch rejects an unchanged-prefix mutation even when the changed letter stays original',async()=>{
  const {host,fake}=await setup({requireActiveWindow:true,support:{WordApi:'1.8',WordApiDesktop:'1.4'},paragraphs:[{text:'Appla',pages:[1],runs:[{start:0,end:4},{start:4,end:5}]}]}),snapshot=(await host.captureScope()).snapshots[0];
  let queued=false;const window=fake.document.activeWindow;window.load=()=>{queued=true;return window;};window.isActive=true;
  const context=fake.document.context,sync=context.sync.bind(context);context.sync=async()=>{await sync();if(queued)fake.document.paragraphs[0].text='Zppla';};
  await assert.rejects(host.applyIssue(envelope(snapshot,'Appla','Apple',0)),/stale/i);assert.equal(fake.state.replacements.length,0);await host.dispose();
});

test('grapheme change keeps unchanged full-issue math controls revisions and unknown formats protected',async()=>{
  for(const markup of ['<m:oMath/>','<w:sdt/>','<w:ins/>','<w:del/>','<w:unknown/>','<w:rPr><w:vertAlign/></w:rPr>']){
    const {host,fake}=await setup({paragraphs:[{text:'Appla',pages:[1],runs:[{start:0,end:1},{start:1,end:5,properties:'<w:rFonts w:hint="eastAsia"/>'}]}],wrapOOXML:(xml,range)=>flatOPC(range.start===0&&range.end===5?xml.replace('<w:r>','<w:r>'+markup):xml)}),snapshot=(await host.captureScope()).snapshots[0],item=envelope(snapshot,'Appla','Apple',0);
    assert.equal((await host.getIssueActions(item)).canApply,false,markup);await assert.rejects(host.applyIssue(item),/protected|preview|format/i);assert.equal(fake.state.replacements.length,0);await host.dispose();
  }
});

test('live Word Flat OPC metadata does not make a plain target preview-only', async () => {
  const {host,fake}=await setup({wrapOOXML:flatOPC,paragraphs:[{text:'The result are clear.',pages:[1],runs:[{start:0,end:21,properties:'<w:rFonts w:ascii="Arial"/><w:sz w:val="24"/><w:color w:val="123456"/>'}]}]});
  const s=(await host.captureScope()).snapshots[0];
  assert.equal((await host.getIssueActions(envelope(s))).canApply,true);
  await host.applyIssue(envelope(s));
  assert.deepEqual(fake.state.replacements,[{id:'p0',start:11,end:14,text:'is'}]);
});
test('OOXML namespaces rather than prefix spellings identify plain targets', async () => {
  const {host}=await setup({wrapOOXML:xml=>flatOPC(xml).replaceAll('w:','q:').replace('xmlns:w=','xmlns:q=')});
  const s=(await host.captureScope()).snapshots[0];assert.equal((await host.getIssueActions(envelope(s))).canApply,true);
});
test('ordinary paragraph-mark font properties do not prevent a minimal text replacement', async () => {
  const {host,fake}=await setup({wrapOOXML:xml=>flatOPC(xml.replace('<w:p>','<w:p><w:pPr><w:spacing w:after="0"/><w:rPr><w:rFonts w:ascii="Arial"/><w:sz w:val="24"/></w:rPr></w:pPr>'))});
  const s=(await host.captureScope()).snapshots[0];await host.applyIssue(envelope(s));
  assert.deepEqual(fake.state.replacements,[{id:'p1',start:11,end:14,text:'is'}]);
});

test('Word exported empty trailing paragraphs allow the same minimal replacement in paragraph and target XML',async()=>{
  for(const section of ['', '<w:sectPr/>']){
    const {host,fake}=await setup({wrapOOXML:xml=>flatOPC(xml.replace('</w:body>','<w:p w:rsidR="00112233" w:rsidRPr="00445566"/>'+section+'</w:body>'))});
    const snapshot=(await host.captureScope()).snapshots[0];assert.equal((await host.getIssueActions(envelope(snapshot))).canApply,true);
    await host.applyIssue(envelope(snapshot));assert.deepEqual(fake.state.replacements,[{id:'p1',start:11,end:14,text:'is'}]);await host.dispose();
  }
});

test('Word exported empty tail never hides another paragraph or protected and unknown content',async()=>{
  for(const tail of ['<w:p><w:r><w:t>Other text</w:t></w:r></w:p>','<w:p> </w:p>','<w:p><w:pPr/></w:p>','<w:p><w:r/></w:p>','<w:p><w:fldChar/></w:p>','<w:p><w:fldSimple/></w:p>','<w:p><w:instrText/></w:p>','<w:p><w:sdt/></w:p>','<w:p><m:oMath/></w:p>','<w:p><w:ins/></w:p>','<w:p><w:del/></w:p>','<w:p><w:unknown/></w:p>','<w:p/><w:p/>','<w:sectPr/><w:p/>']){
    const {host,fake}=await setup({wrapOOXML:xml=>flatOPC(xml.replace('</w:body>',tail+'</w:body>'))});const snapshot=(await host.captureScope()).snapshots[0];
    assert.equal((await host.getIssueActions(envelope(snapshot))).canApply,false,tail);await assert.rejects(host.applyIssue(envelope(snapshot)),/preview|protected|field/i);assert.equal(fake.state.replacements.length,0);await host.dispose();
  }
});

test('Word exported empty tail keeps fields controls math revisions and multiple target runs protected',async()=>{
  const tail=xml=>flatOPC(xml.replace('</w:body>','<w:p/></w:body>'));
  for(const markup of ['<w:fldSimple/>','<w:sdt/>','<m:oMath/>','<w:ins/>','<w:del/>','<w:unknown/>']){
    const {host,fake}=await setup({wrapOOXML:xml=>tail(xml.replace('<w:r>','<w:r>'+markup))});const snapshot=(await host.captureScope()).snapshots[0];
    assert.equal((await host.getIssueActions(envelope(snapshot))).canApply,false,markup);await assert.rejects(host.applyIssue(envelope(snapshot)),/preview|protected|field/i);assert.equal(fake.state.replacements.length,0);await host.dispose();
  }
  const {host,fake}=await setup({wrapOOXML:tail,paragraphs:[{text:'The result are clear.',pages:[1],runs:[{start:0,end:13},{start:13,end:21}]}]});const snapshot=(await host.captureScope()).snapshots[0];
  assert.equal((await host.getIssueActions(envelope(snapshot))).canApply,false);await assert.rejects(host.applyIssue(envelope(snapshot)),/preview|protected|format/i);assert.equal(fake.state.replacements.length,0);await host.dispose();
});

test('internal page fallback diagnostics distinguish viewport and page paragraph failure without native messages',async()=>{
  const first=await setup({pageFailure:true});await first.host.captureScope();assert.match(first.host.pageReadFailureDiagnostic,/stage_viewport/);await first.host.dispose();
  const second=await setup();second.fake.document.activeWindow.activePane=navigationFixture(second.fake,{pagesEnclosingViewport:{items:[{index:1,getRange(){throw Object.assign(new Error('PRIVATE_NATIVE_MESSAGE'),{code:'InvalidObjectPath',debugInfo:{errorLocation:'Page.getRange',statement:'PRIVATE_STATEMENT'}});}}],load(){return this;}}});
  await second.host.captureScope();assert.match(second.host.pageReadFailureDiagnostic,/stage_pageRange.*code_InvalidObjectPath.*loc_Page.getRange/);assert.equal(second.host.capabilities.message.includes('PRIVATE'),false);await second.host.dispose();
});

test('internal page diagnostics survive later annotation and event degradation without duplicate suffixes',async()=>{
  const {host,fake}=await setup({pageFailure:true,annotationFailure:true}),snapshot=(await host.captureScope()).snapshots[0];
  await host.showIssues([envelope(snapshot)]);assert.equal(host.capabilities.annotations,false);assert.match(host.capabilities.message,/Microsoft 365/);assert.match(host.pageReadFailureDiagnostic,/stage_viewport/);assert.equal(host.capabilities.message.includes('stage_'),false);
  host.degrade('paragraphEvents','段落事件不可用。');host.degrade('safeReplace','段落身份不可用。');
  assert.equal(host.capabilities.message,'段落身份不可用。');assert.equal(host.pageReadFailureDiagnostic.match(/stage_viewport/g).length,1);assert.equal(fake.state.replacements.length,0);await host.dispose();
});

test('only the unique main document target is writable; unknown and unsafe main content fail closed', async () => {
  for(const wrapOOXML of [
    xml=>flatOPC(xml.replace('<w:r>','<w:r><w:vertAlign w:val="superscript"/>')),
    xml=>flatOPC(xml.replace('<w:r>','<w:r><m:oMath/>')),
    xml=>flatOPC(xml.replace('<w:r>','<w:r><w:unknown/>')),
    xml=>flatOPC(xml.replace('<w:p>','<w:p><w:ins/>')),
    xml=>flatOPC(xml).replace('</pkg:package>','<pkg:part pkg:name="/word/document.xml"><pkg:xmlData><w:document><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document></pkg:xmlData></pkg:part></pkg:package>'),
    xml=>flatOPC(xml).replace('<w:document>','<x:document xmlns:x="urn:unknown">').replace('</w:document>','</x:document>'),
    xml=>flatOPC(xml).replace('</pkg:package>','')
  ]) {
    const {host,fake}=await setup({wrapOOXML}),s=(await host.captureScope()).snapshots[0];
    assert.equal((await host.getIssueActions(envelope(s))).canApply,false);
    await assert.rejects(host.applyIssue(envelope(s)),/protected|preview|field/i);assert.equal(fake.state.replacements.length,0);
  }
});
test('short issue inside a different word does not prevent verified original-word replacement', async () => {
  const {host,fake}=await setup({wrapOOXML:flatOPC,paragraphs:[{text:'The resuts is consistent with the hypothesis.',pages:[1]}]}),s=(await host.captureScope()).snapshots[0];
  await host.focusIssue(envelope(s,'is','are',11));assert.deepEqual(fake.state.selected,[{id:'p0',start:11,end:13}]);
  await host.applyIssue(envelope(s,'is','are',11));assert.equal(fake.document.paragraphs[0].text,'The resuts are consistent with the hypothesis.');
});
test('repeated literal mapping uses UTF-16 prefix including emoji and combining characters', async () => {
  const {host,fake}=await setup({paragraphs:[{text:'😀e\u0301 is consistent with is.',pages:[1]}]}),s=(await host.captureScope()).snapshots[0];
  await host.applyIssue(envelope(s,'is','are',5));assert.deepEqual(fake.state.replacements,[{id:'p0',start:5,end:7,text:'are'}]);
});
test('selection containing a Word paragraph mark gives a specific refusal without trimming', async () => {
  const {host,fake}=await setup({paragraphs:[{text:'The result are clear.',pages:[1]}],selection:[0,21]});
  const getSelection=fake.document.getSelection.bind(fake.document);fake.document.getSelection=()=>{const range=getSelection();Object.defineProperty(range,'text',{value:'The result are clear.\r'});return range;};
  await assert.rejects(host.captureScope('selection'),error=>error.code==='selectionParagraphMark'&&/段落标记/.test(error.message));
  assert.equal(fake.state.replacements.length,0);
});

test('viewport uses pagesEnclosingViewport, keeps physical pages and full cross-page paragraphs once', async () => {
  const { host, fake } = await setup({ paragraphs: [{ id: 'p1', text: '  Crossing the page is whole. ', pages: [1, 2], pageSplit: 10 }] });
  const scope = await host.captureScope('visiblePages');
  assert.equal(scope.scope, 'visiblePages'); assert.deepEqual(scope.pageIndices, [1, 2]); assert.equal(scope.snapshots.length, 1); assert.equal(scope.snapshots[0].rawText, '  Crossing the page is whole. '); assert.ok(fake.state.viewportReads > 0); assert.equal(fake.state.panePagesReads, 0);
});

test('automatic page capture skips blank paragraphs while preserving nonblank raw text and immediate context',async()=>{
  const {host,fake}=await setup({paragraphs:[{text:'',pages:[1]},{text:' \t\u00A0 ',pages:[1]},{text:'  The resuts are clear.  ',pages:[1]},{text:'\u2003',pages:[1]},{text:'Second paragraph.',pages:[1]}]});
  const scope=await host.captureScope('visiblePages');
  assert.deepEqual(scope.snapshots.map(snapshot=>snapshot.rawText),['  The resuts are clear.  ','Second paragraph.']);
  assert.deepEqual(scope.snapshots[0].targetRange,{start:0,length:25});
  assert.equal(scope.snapshots[0].contextBefore,' \t\u00A0 ');assert.equal(scope.snapshots[0].contextAfter,'\u2003');assert.equal(scope.snapshots[1].contextBefore,'\u2003');
  assert.ok(scope.snapshots.every(snapshot=>/\S/u.test(snapshot.rawText)&&snapshot.targetRange.length>0));await host.dispose();assert.equal(fake.state.tracked.size,0);
});

test('blank automatic ranges yield no service snapshots but blank selection still reports emptySelection',async()=>{
  for(const mode of ['visiblePages','cursorPage','activeParagraph']){
    const {host,fake}=await setup({paragraphs:[{text:'',pages:[1]},{text:' \t\u00A0 ',pages:[1]}]});
    assert.equal((await host.captureScope(mode)).snapshots.length,0);await assert.rejects(host.captureScope('selection'),error=>error.code==='emptySelection');await host.dispose();assert.equal(fake.state.tracked.size,0);
  }
  const {host}=await setup({paragraphs:[{text:' \t\u00A0 ',pages:[1]}],selection:[0,4]});await assert.rejects(host.captureScope('selection'),error=>error.code==='emptySelection');await host.dispose();
});
test('no desktop pages API and runtime failure clearly fall back to activeParagraph', async () => {
  for (const options of [{ support: { WordApi: '1.6' } }, { pageFailure: true }]) { const { host } = await setup(options); const scope = await host.captureScope('visiblePages'); assert.equal(scope.scope, 'activeParagraph'); assert.deepEqual(scope.pageIndices, []); assert.equal(host.capabilities.visiblePages, false); }
});
test('selection retains full paragraph context and exact untrimmed target; cross-paragraph selection refuses guessing', async () => {
  const { host } = await setup({ paragraphs: [{ text: '  The result are clear.  ', pages: [1] }], selection: [2, 22] });
  const { snapshots: [s] } = await host.captureScope('selection'); assert.equal(s.rawText, '  The result are clear.  '); assert.deepEqual(s.targetRange, { start: 2, length: 20 }); assert.equal(s.revision, '0'); assert.equal(s.contextHash.length, 64);
});
test('minimal replacement preserves revisions and invalidates every other issue', async () => {
  const { host, fake } = await setup(); const { snapshots: [s] } = await host.captureScope('visiblePages'); await host.applyIssue(envelope(s));
  assert.equal(fake.document.paragraphs[0].text, 'The result is clear. '); assert.deepEqual(fake.state.replacements, [{ id: 'p1', start: 11, end: 14, text: 'is' }]); assert.equal(fake.document.changeTrackingMode, 'TrackAll'); await assert.rejects(host.applyIssue(envelope(s, 'clear', 'obvious')), /stale/i);
});
test('repeated literal is replaced only at the independently verified UTF-16 offset', async () => { const { host, fake } = await setup({ paragraphs: [{ text: 'are are', pages: [1] }] }); const s = (await host.captureScope()).snapshots[0]; await host.applyIssue(envelope(s,'are','is',4)); assert.equal(fake.document.paragraphs[0].text,'are is'); assert.deepEqual(fake.state.replacements,[{id:'p0',start:4,end:7,text:'is'}]); });
test('rejects original, context, revision and document changes before any write', async () => {
  for (const kind of ['text', 'context', 'document', 'snapshot']) { const { host, fake } = await setup(); const s = (await host.captureScope()).snapshots[0]; if (kind === 'text') fake.document.paragraphs[0].text = 'The result was clear. '; if (kind === 'context') fake.document.paragraphs[1].text += 'changed'; if (kind === 'document') fake.switchDocument([{ id: 'p1', text: s.rawText }]); if (kind === 'snapshot') s.rawText += ' forged'; await assert.rejects(host.applyIssue(envelope(s)), /stale|mismatch|document/i); assert.equal(fake.state.replacements.length, 0); }
});
test('Zotero fields, mixed runs, math, superscripts, locked and tracked content stay preview only', async () => {
  for (const markup of ['<w:fldChar/>', '<w:r/><w:r/>', '<m:oMath/>', '<w:vertAlign/>', '<w:sdt/>', '<w:ins/>']) { const { host, fake } = await setup({ paragraphs: [{ text: 'The result are clear. ', pages: [1], xml: `<w:p><w:r><w:t>The result are clear. </w:t>${markup}</w:r></w:p>` }] }); const s = (await host.captureScope()).snapshots[0]; assert.deepEqual(s.protectedRanges, []); await assert.rejects(host.applyIssue(envelope(s)), /protected|preview/i); assert.equal(fake.state.replacements.length, 0); }
});
test('issue pages come from minimal range, not all enclosing paragraph pages', async () => { const { host } = await setup({ paragraphs: [{ text: 'First. The result are clear.', pages: [1, 2], pageSplit: 7 }] }); const s = (await host.captureScope()).snapshots[0]; const issue = envelope(s); assert.deepEqual(await host.getIssuePageIndices(issue), [2]); });
test('temporary annotations are removed, no native auto-accept popup bypass', async () => { const { host, fake } = await setup(); const s = (await host.captureScope()).snapshots[0]; await host.showIssues([envelope(s)]); assert.equal(fake.state.annotations.size, 1); const mark = [...fake.state.annotations.values()][0]; assert.equal(mark.critique.popupOptions, undefined); assert.equal(host.capabilities.suggestionPopup, false); await host.clear(); assert.equal(fake.state.annotations.size, 0); assert.equal(fake.state.replacements.length, 0); });
test('subscription error degrades to sidebar without permanently styling document', async () => { const { host, fake } = await setup({ annotationFailure: true }); const s = (await host.captureScope()).snapshots[0]; await host.showIssues([envelope(s)]); assert.equal(host.capabilities.annotations, false); assert.match(host.capabilities.message, /Microsoft 365|侧栏/); assert.equal(fake.state.replacements.length, 0); });
test('watch covers typing/paste/undo events; viewport polling stops on pause and cannot reenter', async () => {
  const { host, fake, timers } = await setup(); const events = []; const stop = await host.watch(e => events.push(e));
  for (const name of ['onParagraphAdded', 'onParagraphChanged', 'onParagraphDeleted']) await fake.emit(name, { uniqueLocalIds: ['p1'] });
  assert.equal(events.filter(e => e.type === 'scopeChanged').length, 3); assert.ok(timers.callback); await Promise.all([timers.callback(), timers.callback()]); assert.equal(fake.state.maxRuns, 1); await stop(); assert.equal(timers.callback, null); await fake.emit('onParagraphChanged'); assert.equal(events.filter(e => e.type === 'scopeChanged').length, 3);
});

test('read-only and surrounding content controls never attempt replacement', async () => {
  for (const options of [{ readOnly: true }, { paragraphs: [{ text: 'The result are clear. ', parentControl: true, pages: [1] }] }]) {
    const { host, fake } = await setup(options); const s = (await host.captureScope()).snapshots[0]; await assert.rejects(host.applyIssue(envelope(s)), /protected|preview/i); assert.equal(fake.state.replacements.length, 0);
  }
});
test('live edit during search is rechecked immediately before replacement', async () => {
  const { host, fake } = await setup(); const s = (await host.captureScope()).snapshots[0]; fake.state.mutateOnSearch = () => { fake.document.paragraphs[0].text = 'Someone typed a completely new sentence.'; };
  await assert.rejects(host.applyIssue(envelope(s)), /stale|mismatch/i); assert.equal(fake.state.replacements.length, 0);
});
test('750 ms verifier notices scrolling without cursor movement and text changes without paragraph events', async () => {
  const { host, fake, timers } = await setup({ support: { WordApi: '1.3', WordApiDesktop: '1.2' } });
  await host.captureScope('visiblePages'); const events = []; const stop = await host.watch(event => events.push(event)); fake.state.viewport = [2]; await timers.callback();
  assert.deepEqual(events.find(e => e.type === 'scopeChanged').scope.pageIndices, [2]); fake.document.paragraphs[1].text += 'pasted'; await timers.callback();
  assert.equal(events.filter(e => e.type === 'scopeChanged').length, 2); await stop();
});
test('unsupported paragraph identity runtime downgrades to tracked preview capture', async () => {
  const { host } = await setup({ identityFailure: true }); const captured = await host.captureScope('visiblePages'); assert.equal(captured.scope, 'visiblePages'); assert.equal(captured.snapshots.length, 2); assert.equal(host.capabilities.safeReplace, false);
});
test('parallel captures are serialized and dispose releases tracked anchors', async () => {
  const { host, fake } = await setup(); await Promise.all([host.captureScope(), host.captureScope()]); assert.equal(fake.state.maxRuns, 1); await host.dispose(); assert.equal(fake.state.tracked.size, 0);
});

test('bounded neighboring context preserves source Unicode and stays within total limit', async () => {
  const { host } = await setup({ paragraphs: [{ text: '😀'.repeat(700), pages: [9] }, { text: 'The result are clear. ', pages: [1] }, { text: 'e\u0301'.repeat(700), pages: [9] }], viewport: [1], active: 1 });
  const s = (await host.captureScope()).snapshots[0]; assert.equal(s.contextBefore, '😀'.repeat(500)); assert.equal(s.contextAfter, 'e\u0301'.repeat(500)); assert.equal(s.contextBefore.length + s.contextAfter.length, 2000); await host.applyIssue(envelope(s));
});
test('preview focus binds a tracked paragraph ClientObject when paragraph IDs are unavailable', async () => {
  const { host, fake } = await setup({ support: { WordApi: '1.3' } }); const s = (await host.captureScope('activeParagraph')).snapshots[0]; const before = fake.state.boundRuns || 0; await host.focusIssue(envelope(s)); assert.equal(fake.state.boundRuns, before + 1); assert.equal(fake.state.selected.length, 1);
});
test('concurrent accept can change document only once', async () => {
  const { host, fake } = await setup(); const s = (await host.captureScope()).snapshots[0]; const results = await Promise.allSettled([host.applyIssue(envelope(s)), host.applyIssue(envelope(s))]); assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(fake.state.replacements.length, 1);
});

test('snapshot contract rejects total text plus context above 6000 UTF-16', async () => {
  const { createSnapshot } = await load('../shared/host-contract.js');
  await assert.rejects(createSnapshot({ requestID: 'r', documentSessionID: 'd', blockID: 'b', revision: '0', rawText: 'a'.repeat(5000), contextBefore: 'b'.repeat(1000), contextAfter: 'c'.repeat(1000), targetRange: { start: 0, length: 4000 }, protectedRanges: [], pageIndices: [], scope: 'selection' }), /scope|范围/i);
});
test('host refuses replacement that adds paragraph boundaries or control characters', async () => {
  const { host, fake } = await setup(); const s = (await host.captureScope()).snapshots[0]; for (const replacement of ['is\r\nnext', 'is\u0000']) await assert.rejects(host.applyIssue(envelope(s, 'are', replacement)), /replacement|control|paragraph/i); assert.equal(fake.state.replacements.length, 0);
});
test('cursorPage does not label pages from a nonempty selection as a cursor page', async () => {
  const { host } = await setup({ selection: [0, 3] }); await assert.rejects(host.captureScope('cursorPage'), /cursor|光标/i);
});

test('annotations use red for spelling/grammar, blue expression and lavender context', async () => {
  const { host, fake } = await setup(); const s = (await host.captureScope()).snapshots[0];
  for (const [category, color] of [['spelling', 'Red'], ['grammar', 'Red'], ['expression', 'Blue'], ['context', 'Lavender']]) { const e = envelope(s); e.issue.category = category; await host.showIssues([e]); assert.equal([...fake.state.annotations.values()][0].critique.colorScheme, color); }
});

test('requirement set support alone never claims Microsoft 365 annotation service availability', async () => {
  const { host } = await setup(); assert.equal(host.capabilities.annotations, false); const s = (await host.captureScope()).snapshots[0]; await host.showIssues([envelope(s)]); assert.equal(host.capabilities.annotations, true);
});

test('long selected sentence resolves through bounded host searches and exact expanded range', async () => {
  const original = 'Beginning ' + 'a'.repeat(300) + ' ending.'; const { host, fake } = await setup({ paragraphs: [{ text: '  ' + original + '  ', pages: [1] }], selection: [2, 2 + original.length] });
  const s = (await host.captureScope('selection')).snapshots[0]; await host.applyIssue(envelope(s, original, 'Shorter sentence.', 2)); assert.equal(fake.document.paragraphs[0].text, '  Shorter sentence.  '); assert.equal(fake.state.replacements.length, 1);
});

test('context review-only issue can focus but never writes even when frontend calls accept', async () => {
  const { host, fake } = await setup(); const s = (await host.captureScope()).snapshots[0]; const e = envelope(s, 'are', 'are'); e.issue.category = 'context'; e.issue.reason = '请作者核对前后逻辑。'; await host.focusIssue(e); await assert.rejects(host.applyIssue(e), /review|preview/i); assert.equal(fake.state.selected.length, 1); assert.equal(fake.state.replacements.length, 0);
});

test('dispose still disables callbacks and releases anchors when annotation cleanup fails', async () => {
  const { host, fake, timers } = await setup(); const s = (await host.captureScope()).snapshots[0]; await host.watch(() => {}); await host.showIssues([envelope(s)]); fake.state.annotationDeleteFailure = true;
  await assert.rejects(host.dispose()); assert.equal(timers.callback, null); assert.equal(fake.state.tracked.size, 0); assert.equal(host.disposed, true); await assert.rejects(host.captureScope(), /disposed/);
});

test('I1 complex formatting is preview capability, never blanket semantic protection', async () => {
  const { host, fake } = await setup({ paragraphs: [{ text: 'The result are clear. ', pages: [1], xml: '<w:p><w:r><w:t>The result </w:t></w:r><w:r><w:t>are clear. </w:t></w:r></w:p>' }] }); const s = (await host.captureScope()).snapshots[0];
  assert.deepEqual(s.protectedRanges, []); const e = envelope(s); assert.deepEqual((await host.getIssueActions(e)).canApply, false); await host.focusIssue(e); assert.equal(fake.state.selected.length, 1); await assert.rejects(host.applyIssue(e), /protected|preview/i);
});
test('I1 safe word within mixed paragraph run is minimally replaceable', async () => {
  const { host, fake } = await setup({ paragraphs: [{ text: 'The result are clear. ', pages: [1], runs: [{start:0,end:11,properties:'<w:b/>'},{start:11,end:14},{start:14,end:22,properties:'<w:i/>'}] }] }); const s = (await host.captureScope()).snapshots[0];
  assert.deepEqual(s.protectedRanges, []); assert.equal((await host.getIssueActions(envelope(s))).canApply, true); await host.applyIssue(envelope(s)); assert.deepEqual(fake.state.replacements, [{id:'p0',start:11,end:14,text:'is'}]);
});
test('I1 readable field result yields exact semantic protection while words outside field stay writable', async () => {
  const {host, fake} = await setup({paragraphs:[{text:'The result are clear. [1]',pages:[1],fieldRanges:[{start:22,length:3}]}]}); const s=(await host.captureScope()).snapshots[0];
  assert.deepEqual(s.protectedRanges,[{start:22,length:3}]); assert.equal((await host.getIssueActions(envelope(s,'[1]','[2]',22))).canApply,false); await assert.rejects(host.applyIssue(envelope(s,'[1]','[2]',22)),/protected|preview/i); assert.equal((await host.getIssueActions(envelope(s))).canApply,true); await host.applyIssue(envelope(s)); assert.equal(fake.document.paragraphs[0].text,'The result is clear. [1]');
});
test('I1 unknown field positions keep language preview but prohibit every write', async () => {
  const {host}=await setup({paragraphs:[{text:'The result are clear. ',pages:[1],xml:'<w:p><w:r><w:fldChar/><w:t>The result are clear. </w:t></w:r></w:p>'}]}); const s=(await host.captureScope()).snapshots[0]; assert.deepEqual(s.protectedRanges,[]); assert.equal((await host.getIssueActions(envelope(s))).canApply,false); await assert.rejects(host.applyIssue(envelope(s)),/preview|field/i);
});

test('I2 one-shot selection never changes automatic visible-page watcher', async () => {
  const {host,fake,timers}=await setup({selection:[0,3]}); const events=[]; const stop=await host.watch(event=>events.push(event)); await host.captureScope('selection'); fake.state.viewport=[2]; await timers.callback();
  const next=events.find(event=>event.type==='scopeChanged'); assert.equal(next.scope.scope,'visiblePages'); assert.deepEqual(next.scope.pageIndices,[2]); await stop();
});
test('I2 cancelled selection and pause/resume return to visible pages', async () => {
  const {host,fake,timers}=await setup({selection:[0,3]}); const events=[]; let stop=await host.watch(event=>events.push(event)); await host.captureScope('selection'); fake.state.selection=null; await stop(); fake.state.viewport=[2]; stop=await host.watch(event=>events.push(event)); await timers.callback(); assert.equal(events.at(-1).scope.scope,'visiblePages'); assert.deepEqual(events.at(-1).scope.pageIndices,[2]); await stop();
});

test('I3 scrolling and physical repagination preserve unchanged block revisions and anchors', async () => {
  const {host,fake,timers}=await setup({paragraphs:[{id:'p1',text:'The result are clear. ',pages:[1,2]}],viewport:[1]}); const old=(await host.captureScope()).snapshots[0]; const events=[]; const stop=await host.watch(event=>events.push(event)); fake.state.viewport=[2]; await timers.callback();
  const scope=events.find(event=>event.type==='scopeChanged').scope; assert.equal(scope.snapshots[0].revision,old.revision); assert.equal(events.some(event=>event.type==='invalidated'),false); await host.focusIssue(envelope(old));
  fake.document.paragraphs[0].pages=[4]; fake.state.viewport=[4]; await timers.callback(); assert.equal(events.at(-1).scope.snapshots[0].revision,old.revision); await host.focusIssue(envelope(old)); await stop();
});
test('I3 edits invalidate changed text and actual neighbors, retaining unrelated block versions', async () => {
  const {host,fake}=await setup({paragraphs:Array.from({length:5},(_,i)=>({id:`p${i}`,text:`Paragraph ${i} are clear.`,pages:[1]})),viewport:[1]}); const initial=await host.captureScope(); const events=[]; const stop=await host.watch(event=>events.push(event)); fake.document.paragraphs[1].text+=' changed'; await fake.emit('onParagraphChanged',{uniqueLocalIds:['p1']}); const updated=events.find(event=>event.type==='scopeChanged').scope;
  assert.notEqual(updated.snapshots[0].revision,initial.snapshots[0].revision); assert.notEqual(updated.snapshots[1].revision,initial.snapshots[1].revision); assert.notEqual(updated.snapshots[2].revision,initial.snapshots[2].revision); assert.equal(updated.snapshots[4].revision,initial.snapshots[4].revision); await host.focusIssue(envelope(initial.snapshots[4])); await stop();
});

test('I4 capture and unchanged 750 ms poll batch syncs instead of quadratic round trips', async () => {
  const {host,fake,timers}=await setup({paragraphs:Array.from({length:50},(_,i)=>({id:`p${i}`,text:`Unique paragraph ${i}.`,pages:[1]})),viewport:[1]}); let before=fake.state.syncs; await host.captureScope(); assert.ok(fake.state.syncs-before<=8,`capture syncs: ${fake.state.syncs-before}`); const stop=await host.watch(()=>{}); before=fake.state.syncs; const xmlReads=fake.state.xmlReads; await timers.callback(); assert.ok(fake.state.syncs-before<=5,`poll syncs: ${fake.state.syncs-before}`); assert.equal(fake.state.xmlReads,xmlReads); await stop();
});
test('I4 fallback de-duplicates spanning paragraphs with one batched comparison stage', async () => {
  const {host,fake}=await setup({support:{WordApi:'1.3',WordApiDesktop:'1.2'},paragraphs:Array.from({length:15},(_,i)=>({text:`Unique fallback paragraph ${i}.`,pages:[1,2]}))}); const before=fake.state.syncs; const scope=await host.captureScope(); assert.equal(scope.snapshots.length,15); assert.ok(fake.state.syncs-before<=8,`fallback syncs: ${fake.state.syncs-before}`);
});

test('I5 every current snapshot stays focusable beyond 64 paragraphs and repeated captures', async () => {
  const {host,fake}=await setup({paragraphs:Array.from({length:70},(_,i)=>({id:`p${i}`,text:`Paragraph ${i} are clear.`,pages:[1]})),viewport:[1]}); const first=await host.captureScope(); const second=await host.captureScope(); assert.equal(second.snapshots.length,70); await host.focusIssue(envelope(first.snapshots[0])); await host.focusIssue(envelope(second.snapshots[69])); assert.equal(fake.state.selected.length,2); assert.ok(host.anchors.size<=70); await host.dispose(); assert.equal(fake.state.tracked.size,0);
});
test('I5 transport request IDs and display page metadata are not document anchor identity', async () => {
  const {host,fake}=await setup(); const s=(await host.captureScope()).snapshots[0]; const transported={...s,requestID:'service-request-id',pageIndices:[99]}; await host.focusIssue(envelope(transported)); await host.applyIssue(envelope(transported)); assert.equal(fake.state.replacements.length,1);
});

test('collection parents are tracked before member paragraphs and released with the last member', async () => {
  const {host,fake}=await setup({strictParentTracking:true,paragraphs:[{id:'p1',text:'The result are clear. ',pages:[1,2]}]}); const s=(await host.captureScope()).snapshots[0]; await host.focusIssue(envelope(s)); assert.ok(fake.state.parentTrackChecks>0); await host.dispose(); assert.equal(fake.state.tracked.size,0);
});

test('F1 stale historical fallback ClientObject is discarded without poisoning visible pages', async () => {
  for(const failure of ['getRange','sync']) {
    const {host,fake}=await setup({support:{WordApi:'1.3',WordApiDesktop:'1.2'},viewport:[1],paragraphs:[{id:'old',text:'Old result are clear.',pages:[1]},{id:'new',text:'New result are clear.',pages:[2]}]}); const old=(await host.captureScope()).snapshots[0];
    const expired=Object.assign(new Error('InvalidObjectPath: deleted tracked paragraph'),{code:'InvalidObjectPath'});
    if(failure==='getRange') fake.document.paragraphs[0].getRange=()=>{throw expired;};
    else { const original=fake.document.paragraphs[0].getRange; fake.document.paragraphs[0].getRange=()=>{ fake.state.historySyncError=expired; return original(); }; const sync=fake.document.context.sync; fake.document.context.sync=async()=>{if(fake.state.historySyncError){fake.state.historySyncError=null;throw expired;}return sync();}; }
    fake.state.viewport=[2];fake.state.active=1;
    for(let i=0;i<2;i++){ const captured=await host.captureScope(); assert.equal(captured.scope,'visiblePages'); assert.deepEqual(captured.pageIndices,[2]); assert.equal(captured.snapshots[0].rawText,'New result are clear.'); }
    assert.equal(host.capabilities.visiblePages,true); await assert.rejects(host.focusIssue(envelope(old)),/stale/i); await host.dispose();
  }
});
test('manual selection preserves automatic viewport baseline until real scrolling or text change', async () => {
  const {host,fake,timers}=await setup({selection:[0,3]}); await host.captureScope('visiblePages'); const events=[];const stop=await host.watch(event=>events.push(event));await host.captureScope('selection');await timers.callback();assert.equal(events.some(event=>event.type==='scopeChanged'),false);
  fake.state.viewport=[2];await timers.callback();assert.deepEqual(events.at(-1).scope.pageIndices,[2]);await stop();
});
