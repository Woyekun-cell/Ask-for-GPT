const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createFakeWord} = require('./fake-word.cjs');
const {createFakeWPS} = require('./fake-wps.cjs');
const {makeDOM, Clock, texts, find, flush} = require('./taskpane-dom-helper.cjs');
const modules = Promise.all([import('../word/word-host.js'), import('../wps/wps-host.js'), import('../shared/taskpane.js')]);
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const settle = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {for(let i=0;i<250;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,1));}assert.fail('asynchronous host state did not settle');}
const result = (snapshot, issues = []) => ({requestID:snapshot.requestID,snapshotHash:snapshot.snapshotHash,skillVersion:'local-1',status:'completed',issues});
const issue = (id='offpage',original='teh',start=15) => ({id,category:'spelling',original,replacement:'the',reason:'spelling',range:{start,length:original.length},requiresAuthorConfirmation:false});

test('F1 Word cold startup waits for Office readiness before resolving default Word and context', async () => {
  const [{WordHostAdapter}] = await modules;
  const previousOffice = globalThis.Office, previousWord = globalThis.Word, fake = createFakeWord();
  let readyCalls = 0, ready;
  try {
    delete globalThis.Word;
    globalThis.Office = {onReady() {readyCalls++; return new Promise(resolve => {ready = () => {globalThis.Word=fake.Word; globalThis.Office.context=fake.Office.context; resolve({host:'Word'});};});}};
    const host = new WordHostAdapter();
    const initializing = host.initialize(); initializing.catch(()=>{});
    await flush();
    assert.equal(readyCalls,1);
    ready(); await initializing;
    assert.equal((await host.captureScope()).scope,'visiblePages');
    await host.dispose();
  } finally {if(previousOffice===undefined)delete globalThis.Office;else globalThis.Office=previousOffice;if(previousWord===undefined)delete globalThis.Word;else globalThis.Word=previousWord;}
});

test('F1 missing, wrong and never-ready Office hosts fail explicitly within a bound', async () => {
  const [{WordHostAdapter}] = await modules;
  const fake=createFakeWord();
  await assert.rejects(new WordHostAdapter({Office:null,Word:fake.Word}).initialize(),{code:'wordUnavailable'});
  await assert.rejects(new WordHostAdapter({Office:{...fake.Office,onReady:async()=>({host:'Excel'})},Word:fake.Word}).initialize(),{code:'wordUnavailable'});
  const clock=new Clock(),host=new WordHostAdapter({Office:{onReady:()=>new Promise(()=>{})},Word:fake.Word,timers:clock});
  const waiting=assert.rejects(host.initialize(),{code:'officeReadyTimeout'});
  await clock.tick(10000); await waiting;
  assert.equal(fake.state.runs,0);
  assert.equal(clock.jobs.length,0);
});

async function controllerFor(host,{check}={}) {
  const [,,{TaskpaneController}]=await modules,dom=makeDOM(),clock=new Clock(),calls=[];
  const client={check:async(snapshot,mode)=>{calls.push({snapshot,mode});return check?check(snapshot,mode):result(snapshot);},cancel:async()=>{},dispose:async()=>{}};
  let serial=0;
  const controller=new TaskpaneController({root:dom.root,host,client,timers:clock,requestID:()=>`integration-${++serial}`});
  await controller.start();
  return {controller,dom,clock,calls};
}

test('F2 real Word/controller hides offpage issues during lookup and restores cached results on scrolling', async () => {
  const [{WordHostAdapter}]=await modules;
  const fake=createFakeWord({viewport:[1],paragraphs:[{id:'p1',text:'Good sentence. teh next page.',pages:[1,2],pageSplit:15}]}),host=new WordHostAdapter({...fake,timers:{setInterval:()=>1,clearInterval:()=>{}}});
  const lookup=host.getIssuePageIndices.bind(host),initial=deferred();let gate=initial.promise;
  host.getIssuePageIndices=async envelope=>{await gate;return lookup(envelope);};
  const shown=[],show=host.showIssues.bind(host);host.showIssues=async envelopes=>{shown.push(envelopes.map(e=>e.issue.id));return show(envelopes);};
  const env=await controllerFor(host,{check:(s,mode)=>result(s,mode==='spelling'?[issue()]:[])});
  await env.clock.tick(300);await settle();
  assert.equal(env.controller.queue.issues.length,0);
  assert.equal(env.controller.queue.current,null);
  assert.equal(env.dom.elements['issue-list'].children.length,0);
  assert.notEqual(env.controller.queue.state.status,'clean');
  assert.notEqual(env.dom.elements.status.textContent,'未发现问题');
  initial.resolve();await waitFor(()=>env.controller.queue.state.status==='clean');await env.clock.tick(900);await settle();
  assert.equal(env.controller.queue.issues.length,0);assert.equal(fake.state.annotations.size,0);
  assert.ok(shown.every(ids=>ids.length===0));
  const checked=env.calls.length;
  fake.state.viewport=[2];await env.controller.onHostChange({type:'scopeChanged',scope:await host.captureScope()});await waitFor(()=>env.controller.queue.issues.length===1&&fake.state.annotations.size===1);
  assert.deepEqual(env.controller.queue.issues.map(e=>e.issue.id),['offpage']);
  assert.equal(env.dom.elements['issue-list'].children.length,1);assert.equal(fake.state.annotations.size,1);
  assert.equal(env.controller.capabilities.annotations,true);
  assert.doesNotMatch(env.dom.elements['scope-label'].textContent,/侧栏检查/);
  assert.equal(env.calls.length,checked);
  const leaving=deferred();gate=leaving.promise;fake.state.viewport=[1];
  await env.controller.onHostChange({type:'scopeChanged',scope:await host.captureScope()});await waitFor(()=>fake.state.annotations.size===0);
  assert.equal(env.controller.queue.issues.length,0);assert.equal(env.controller.queue.current,null);assert.equal(fake.state.annotations.size,0);
  assert.notEqual(env.controller.queue.state.status,'clean');
  leaving.resolve();await waitFor(()=>env.controller.queue.state.status==='clean');
  // Repagination moves this minimal issue while the raw paragraph and its enclosing pages stay the same.
  fake.document.paragraphs[0].pageSplit=16;fake.state.viewport=[1,2];
  await env.controller.onHostChange({type:'scopeChanged',scope:await host.captureScope()});await waitFor(()=>env.controller.queue.current&&env.controller.queue.pagesFor(env.controller.queue.current).length===2&&fake.state.annotations.size===1);
  assert.equal(env.controller.queue.issues.length,1);assert.deepEqual(env.controller.queue.pagesFor(env.controller.queue.current),[1,2]);
  assert.equal(env.calls.length,checked);
  fake.document.paragraphs[0].text='Good sentence. the next page.';
  await env.controller.onHostChange({type:'scopeChanged',scope:await host.captureScope()});await waitFor(()=>fake.state.annotations.size===0);
  assert.equal(env.controller.queue.issues.length,0);assert.equal(fake.state.annotations.size,0);
  await env.controller.dispose();
});

test('M1 only current card expands; click and Enter select and focus while buttons remain single actions', async () => {
  let focused=0,applied=0;
  const snapshot={requestID:'r',documentSessionID:'doc',blockID:'p1',revision:'0',rawText:'teh are unclear.',snapshotHash:'hash',contextHash:'context',contextBefore:'',contextAfter:'',targetRange:{start:0,length:16},protectedRanges:[],pageIndices:[1],scope:'visiblePages'};
  const host={initialize:async()=>({annotations:false,safeReplace:true}),watch:async()=>()=>{},captureScope:async()=>({scope:'visiblePages',pageIndices:[1],snapshots:[snapshot]}),getIssueActions:async()=>({canApply:true,reason:''}),focusIssue:async()=>{focused++;},applyIssue:async()=>{applied++;},clear:async()=>{},dispose:async()=>{}};
  const suggestions=[{...issue('spell','teh',0),reason:'spelling reason'},{...issue('grammar','are',4),category:'grammar',replacement:'is',reason:'grammar reason'},{...issue('context','unclear',8),category:'context',replacement:'unclear',reason:'context reason'}];
  const env=await controllerFor(host,{check:(s,mode)=>result(s,mode==='spelling'?suggestions:[])});await env.clock.tick(300);
  let cards=env.dom.elements['issue-list'].children;
  assert.deepEqual(cards.map(card=>card.getAttribute('aria-expanded')),['true','false','false']);
  assert.ok(texts(cards[0]).includes('spelling reason'));assert.ok(!texts(cards[1]).includes('grammar reason'));
  await cards[1].fire('click');assert.equal(env.controller.queue.current.issue.id,'grammar');assert.equal(focused,1);
  cards=env.dom.elements['issue-list'].children;
  assert.ok(texts(cards[1]).includes('grammar reason'));assert.ok(!texts(cards[0]).includes('spelling reason'));
  await cards[2].fire('keydown',{key:'Enter'});assert.equal(env.controller.queue.current.issue.id,'context');assert.equal(focused,2);assert.equal(applied,0);
  await find(env.dom.elements['issue-list'],'定位').fire('click');assert.equal(focused,3);
  await find(env.dom.elements['issue-list'],'定位').fire('keydown',{key:'Enter'});assert.equal(focused,3);
  await env.dom.elements['issue-list'].children[1].fire('click');assert.equal(focused,4);
  await find(env.dom.elements['issue-list'],'接受').fire('click');assert.equal(applied,1);assert.equal(focused,4);
  await env.controller.dispose();
});

test('M2 Word annotation capability is announced once after successful service insertion', async () => {
  const [{WordHostAdapter}]=await modules,fake=createFakeWord(),host=new WordHostAdapter({...fake,timers:{setInterval:()=>1,clearInterval:()=>{}}});
  await host.initialize();const snapshot=(await host.captureScope()).snapshots[0],events=[];await host.watch(event=>events.push(event));
  const envelope={snapshot,issue:{...issue('grammar','are',11),category:'grammar',replacement:'is'}};
  await host.showIssues([envelope]);await host.showIssues([envelope]);
  const changes=events.filter(event=>event.type==='capabilitiesChanged');
  assert.equal(changes.length,1);assert.equal(changes[0].capabilities.annotations,true);assert.doesNotMatch(changes[0].capabilities.message,/尚未验证/);
  await host.dispose();
});

test('F2 selection and hosts without page capability keep suggestions available', async () => {
  const [{WordHostAdapter}]=await modules;
  for(const fallback of [false,true]) {
    const fake=createFakeWord({viewport:[1],selection:[15,18],paragraphs:[{id:'p1',text:'Good sentence. teh next page.',pages:[1,2],pageSplit:15}],...(fallback?{support:{WordApi:'1.8'}}:{})});
    const host=new WordHostAdapter({...fake,timers:{setInterval:()=>1,clearInterval:()=>{}}}),env=await controllerFor(host,{check:(s,mode)=>result(s,mode==='spelling'?[issue()]:[])});
    if(!fallback)await env.controller.checkSelection();
    await env.clock.tick(300);await waitFor(()=>env.controller.queue.issues.length===1);
    assert.equal(env.controller.scope.scope,fallback?'activeParagraph':'selection');
    assert.equal(env.controller.queue.issues.length,1);
    await env.controller.dispose();
  }
});

test('F3 WPS empty selection context button reaches manual active paragraph while selection and cross-paragraph guards remain', async () => {
  const [,{WPSHostAdapter}]=await modules;
  const fake=createFakeWPS(),host=new WPSHostAdapter({Application:fake.Application});
  const env=await controllerFor(host,{check:(s,mode)=>result(s,mode==='polish'?[{...issue('wps','are',11),category:'grammar',replacement:'is'}]:[])});
  assert.equal(env.controller.auto,false);assert.equal(env.calls.length,0);
  await env.controller.checkContext();await env.clock.tick(0);await settle();
  assert.equal(env.controller.scope.scope,'activeParagraph');assert.equal(env.controller.queue.issues.length,1);assert.deepEqual(env.calls.map(call=>call.mode),['polish']);
  assert.equal(env.controller.auto,false);assert.equal(fake.state.listeners.size,0);
  await assert.rejects(env.controller.checkSelection(),{code:'emptySelection'});
  fake.state.selection=[0,25];const count=env.calls.length;
  await assert.rejects(env.controller.checkContext(),{code:'invalidSelection'});await env.clock.tick(2000);
  assert.equal(env.calls.length,count);assert.equal(fake.state.replacements.length,0);
  await env.controller.dispose();
});
