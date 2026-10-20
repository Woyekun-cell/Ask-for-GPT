const test = require('node:test');
const assert = require('node:assert/strict');
const {makeDOM, Clock, flush, texts, find} = require('./taskpane-dom-helper.cjs');
const modules = Promise.all([import('../shared/taskpane.js').catch(() => ({})), import('../shared/writing-client.js').catch(() => ({}))]);
const snap = (id = 'a', extra = {}) => ({requestID: `req-${id}`, documentSessionID: 'doc', blockID: id, revision: '1', rawText: 'teh word is bad.', snapshotHash: `hash-${id}`, contextHash: 'context', contextBefore: '', contextAfter: '', targetRange: {start: 0, length: 16}, protectedRanges: [], pageIndices: [1], scope: 'visiblePages', ...extra});
const suggestion = (id = 'local', category = 'spelling') => ({id, category, original: '<img src=x onerror=alert(1)>', replacement: '<script>the</script>', reason: '理由', range: {start: 0, length: 3}, requiresAuthorConfirmation: false});
const response = (s, issues = [], extra = {}) => ({requestID: s.requestID, snapshotHash: s.snapshotHash, skillVersion: 'writing-1', status: 'completed', issues, ...extra});
function deferred() { let resolve, reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; }
async function setup(options = {}) {
  const [{TaskpaneController}] = await modules;
  assert.equal(typeof TaskpaneController, 'function', 'TaskpaneController must render and schedule injected host/client');
  const dom = makeDOM(), clock = new Clock(), calls = [], cancelled = [], hostCalls = [];
  let scope = {scope: 'visiblePages', pageIndices: [1], snapshots: [snap()]}, callback, watches = 0, subscriptions = 0;
  const host = {initialize: async () => (options.capabilities || {}), captureScope: async mode => { hostCalls.push(['capture', mode]); return scope; }, watch: async cb => { callback = cb; watches++; subscriptions++; return () => { subscriptions--; }; }, focusIssue: async e => hostCalls.push(['focus', e]), getIssueActions: async()=>({canApply:true,reason:''}), applyIssue: async e => { hostCalls.push(['apply', e]); scope = {...scope, snapshots: [snap('a', {revision: '2', snapshotHash: 'new'})]}; return {status: 'applied'}; }, clear: async () => hostCalls.push(['clear']), dispose: async () => hostCalls.push(['dispose']), ...options.host};
  const client = {check: async (s, mode, profile, opts) => { calls.push({snapshot: s, mode, profile, opts}); return options.check ? options.check(s, mode) : response(s, mode === 'spelling' ? [suggestion()] : []); }, cancel: async id => cancelled.push(id), dispose: () => {}};
  const controller = new TaskpaneController({root: dom.root, host, client, timers: clock, location: options.location, requestID: (() => {let n=0; return () => `new-${++n}`;})()});
  await controller.start();
  return {controller, dom, clock, calls, cancelled, hostCalls, host, get watches() {return watches;}, get subscriptions() {return subscriptions;}, event: async e => { await callback(e); await flush(); }, setScope: s => {scope=s;}};
}

test('closing checks exposes explicit reopening without reviving a disposed controller', async () => {
  let reloads=0;
  const env=await setup({location:{href:'https://localhost:43793/shared/taskpane.html?host=word',origin:'https://localhost:43793',reload(){reloads++;}}});
  assert.equal(reloads,0);
  await env.dom.elements.close.fire('click');
  assert.equal(env.controller.disposed,true);assert.equal(env.subscriptions,0);assert.equal(env.clock.jobs.length,0);
  assert.equal(env.dom.elements.status.textContent,'已关闭');assert.equal(env.dom.elements.close.textContent,'重新开启');
  assert.equal(env.dom.elements.close.getAttribute('aria-label'),'重新开启');assert.equal(env.dom.elements.close.disabled,false);
  assert.equal(env.dom.elements['check-polish'].disabled,true);assert.equal(reloads,0);
});

test('reopening waits for disposal cleanup and a later explicit click', async () => {
  let reloads=0;const cleanup=deferred();
  const env=await setup({location:{href:'https://localhost:43793/shared/taskpane.html?host=word',origin:'https://localhost:43793',reload(){reloads++;}}});
  env.controller.client.dispose=()=>cleanup.promise;
  const closing=env.dom.elements.close.fire('click');await flush();
  assert.equal(env.dom.elements.close.disabled,true);
  await env.dom.elements.close.fire('click');assert.equal(reloads,0);
  cleanup.resolve();await closing;
  assert.equal(env.dom.elements.close.disabled,false);assert.equal(reloads,0);
  await env.dom.elements.close.fire('click');assert.equal(reloads,1);
});

test('reopening closed Word and WPS taskpanes reloads only the current page once without writing or asking GPT', async () => {
  const {bootTaskpane}=await import('../shared/taskpane.js');
  for(const kind of ['word','wps']){
    const dom=makeDOM(),query=dom.doc.querySelector;dom.doc.querySelector=selector=>selector==='#writing-taskpane'?dom.root:query(selector);
    let reloads=0,writes=0,checks=0;
    const location={href:`https://localhost:43793/shared/taskpane.html?host=${kind}`,origin:'https://localhost:43793',reload(){reloads++;}};
    const host={initialize:async()=>({automaticCheck:false}),clear:async()=>{},dispose:async()=>{},applyIssue:async()=>{writes++;}};
    const client={check:async()=>{checks++;},dispose:async()=>{}};
    const controller=await bootTaskpane({document:dom.doc,location,host,client});
    await dom.elements.close.fire('click');
    await dom.elements.close.fire('click');await dom.elements.close.fire('click');
    assert.equal(reloads,1,kind);assert.equal(writes,0);assert.equal(checks,0);assert.equal(controller.disposed,true);
    assert.equal(dom.elements.close.disabled,true);
  }
});

test('closed taskpane reopening rejects unrelated or insecure locations without navigation', async () => {
  for(const [href,origin] of [
    ['http://localhost:43793/shared/taskpane.html?host=word','http://localhost:43793'],
    ['https://evil.example/shared/taskpane.html?host=word','https://evil.example'],
    ['https://localhost:43793/other.html?host=word','https://localhost:43793'],
    ['https://localhost:43793/shared/taskpane.html?host=other','https://localhost:43793'],
    ['https://localhost:43793/shared/taskpane.html?host=word','https://different.example'],
  ]){
    let reloads=0;const env=await setup({location:{href,origin,reload(){reloads++;}}});
    await env.dom.elements.close.fire('click');await env.dom.elements.close.fire('click');
    assert.equal(reloads,0);assert.equal(env.controller.disposed,true);assert.equal(env.dom.elements.error.hidden,false);
    assert.equal(env.dom.elements.close.disabled,false);assert.equal(env.hostCalls.some(call=>call[0]==='apply'),false);
  }
});

test('a blocked taskpane reload leaves a usable reopening button and fixed local guidance', async () => {
  let reloads=0;
  const env=await setup({location:{href:'https://localhost:43793/shared/taskpane.html?host=word',origin:'https://localhost:43793',reload(){reloads++;throw Error('PRIVATE location failure');}}});
  await env.dom.elements.close.fire('click');await env.dom.elements.close.fire('click');
  assert.equal(reloads,1);assert.equal(env.dom.elements.close.disabled,false);assert.equal(env.dom.elements.error.hidden,false);
  assert.equal(env.dom.elements.error.textContent.includes('PRIVATE'),false);assert.equal(env.controller.disposed,true);
});

test('300ms local check renders safely and polish waits for an explicit click', async () => {
  let resolvePolish;
  const env = await setup({check: (s, mode) => mode === 'spelling' ? response(s, [suggestion()]) : new Promise(resolve => {resolvePolish = () => resolve(response(s, [suggestion('style', 'expression')]));})});
  assert.equal(env.dom.elements.status.textContent, '尚未检查');
  await env.clock.tick(299); assert.equal(env.calls.length, 0);
  await env.clock.tick(1);
  assert.equal(env.calls[0].mode, 'spelling');
  assert.ok(texts(env.dom.elements['issue-list']).includes('<img src=x onerror=alert(1)>'));
  await env.clock.tick(900);
  assert.deepEqual(env.calls.map(c => c.mode), ['spelling']);
  await env.controller.checkPolish();await env.clock.tick(0);
  assert.deepEqual(env.calls.map(c => c.mode), ['spelling', 'polish']);
  assert.ok(texts(env.dom.elements['issue-list']).includes('接受'));
  resolvePolish(); await flush();
  assert.ok(texts(env.dom.elements['issue-list']).includes('表达'));
  await env.controller.dispose();
});

test('polish stays single concurrency across paragraphs while spelling never waits', async () => {
  const waiting = [];
  const env = await setup({check: (s, mode) => mode === 'spelling' ? response(s) : new Promise(resolve => waiting.push(() => resolve(response(s))))});
  const scope={scope:'visiblePages',pageIndices:[1],snapshots:[snap(),snap('b')]};env.setScope(scope);
  await env.event({type: 'scopeChanged', scope});
  await env.clock.tick(300);await env.controller.checkContext();await env.clock.tick(0);
  assert.equal(env.calls.filter(c=>c.mode==='spelling').length, 2);
  assert.equal(env.calls.filter(c=>c.mode==='polish').length, 1);
  waiting.shift()(); await flush();
  assert.equal(env.calls.filter(c=>c.mode==='polish').length, 2);
  waiting.shift()(); await flush();
  await env.controller.dispose();
});

test('edits discard outstanding responses, cancellation carries request ID, and watcher is unique', async () => {
  let deliver;
  const env = await setup({check: (s, mode) => mode === 'spelling' ? response(s) : new Promise(resolve => {deliver = () => resolve(response(s, [suggestion('old')]));})});
  await env.clock.tick(300);await env.controller.checkPolish();await env.clock.tick(0);
  const old = env.calls.find(c=>c.mode==='polish').snapshot.requestID;
  env.setScope({scope:'visiblePages',pageIndices:[2],snapshots:[snap('a',{revision:'2',snapshotHash:'edited',pageIndices:[2]})]});
  await env.event({type:'contentChanged'});
  assert.ok(env.cancelled.includes(old));
  deliver(); await flush();
  assert.equal(env.controller.queue.issues.length, 0);
  assert.equal(env.watches, 1);
  await env.controller.pause();
  assert.equal(env.subscriptions, 0);
  assert.equal(env.clock.jobs.length, 0);
  assert.ok(env.hostCalls.some(c=>c[0]==='clear'));
  await env.controller.resume();
  assert.equal(env.subscriptions, 1);
  await env.controller.dispose();
  assert.equal(env.subscriptions, 0);
});

test('accept clears paragraph offsets before host modification and recaptures next revision', async () => {
  const env = await setup();
  await env.clock.tick(300);
  let oldCount;
  const originalApply = env.host.applyIssue;
  env.host.applyIssue = async e => {oldCount = env.controller.queue.issues.length; return originalApply(e);};
  await find(env.dom.elements['issue-list'], '接受').fire('click');
  assert.equal(oldCount, 0);
  assert.equal(env.controller.queue.issues.length, 0);
  assert.equal(env.hostCalls.filter(c=>c[0]==='apply').length, 1);
  await env.clock.tick(300);
  assert.equal(env.calls.at(-1).snapshot.revision, '2');
  await env.controller.dispose();
});

test('red grammar, blue expression, purple context have textual category and keyboard navigation', async () => {
  const env = await setup({check: (s, mode) => response(s, mode==='spelling' ? [suggestion('grammar','grammar')] : [suggestion('style','expression'),suggestion('context','context')])});
  await env.clock.tick(300);await env.controller.checkContext();await env.clock.tick(0);
  const list = env.dom.elements['issue-list'];
  assert.ok(texts(list).includes('语法')); assert.ok(texts(list).includes('表达')); assert.ok(texts(list).includes('上下文'));
  assert.deepEqual(list.children.map(c=>c.dataset.tone), ['red','blue','purple']);
  await env.dom.root.fire('keydown',{key:'ArrowDown',altKey:true});
  assert.equal(env.controller.queue.current.issue.id, 'style');
  await env.controller.dispose();
});

test('client bootstraps only same-origin HTTPS, sends exact JSON and private in-memory bearer, rejects missing skill', async () => {
  const [, {WritingClient}] = await modules;
  assert.equal(typeof WritingClient, 'function');
  const calls=[];
  const client = new WritingClient({origin:'https://localhost:43793',fetch:async (url,options) => {calls.push({url:String(url),options}); return {ok:true,json:async()=>String(url).endsWith('bootstrap')?{token:'secret',baseURL:'https://localhost:43793',skillVersion:'writing-1'}:String(url).endsWith('cancel')?{status:'cancelled'}:response(snap())};}});
  await client.check(snap(), 'polish', {spellingVariant:'en-US',style:'minimal',customTerms:[]});
  await client.cancel('req-a');
  assert.deepEqual(calls.map(c=>c.url), ['https://localhost:43793/v1/writing/bootstrap','https://localhost:43793/v1/writing/check','https://localhost:43793/v1/writing/cancel']);
  assert.equal(calls[1].options.headers.Authorization,'Bearer secret');
  assert.deepEqual(JSON.parse(calls[1].options.body),{snapshot:snap(),mode:'polish',profile:{spellingVariant:'en-US',style:'minimal',customTerms:[]}});
  assert.deepEqual(JSON.parse(calls[2].options.body),{requestID:'req-a'});
  assert.equal(calls[0].options.cache,'no-store');
  assert.throws(()=>new WritingClient({origin:'http://localhost:43793',fetch:async()=>{}}), /HTTPS/);
  const foreign = new WritingClient({origin:'https://localhost:43793',fetch:async()=>({ok:true,json:async()=>({token:'secret',baseURL:'https://other.example',skillVersion:'writing-1'})})});
  await assert.rejects(()=>foreign.check(snap(),'polish',{}),/同源/);
  const skillMissing = new WritingClient({origin:'https://localhost:43793',fetch:async url=>({ok:true,json:async()=>String(url).endsWith('bootstrap')?{token:'secret',baseURL:'https://localhost:43793',skillVersion:'writing-1'}:response(snap(),[],{skillVersion:''})})});
  await assert.rejects(()=>skillMissing.check(snap(),'polish',{}),/规则/);
  await client.dispose();
});

test('rapid resumes register one watcher and clear failures never leave apply locked', async () => {
  const env = await setup();
  await env.controller.pause();
  let deliverWatch, watches=0;
  env.host.watch = () => {watches++; return new Promise(resolve=>{deliverWatch=()=>resolve(()=>{});});};
  const first = env.controller.resume(), second = env.controller.resume();
  await flush();
  assert.equal(watches, 1);
  deliverWatch(); await Promise.all([first,second]);
  await env.clock.tick(300);
  env.host.clear = async()=>{throw new Error('clear failed');};
  await find(env.dom.elements['issue-list'],'接受').fire('click');
  assert.equal(env.controller.applying, false);
  env.host.clear = async()=>{};
  await env.controller.dispose();
});

test('closed client aborts pending bootstrap and cannot retain or reuse credentials', async () => {
  const [, {WritingClient}] = await modules;
  let deliver, bootstrapSignal;
  const client = new WritingClient({origin:'https://localhost:43793',fetch: (url,options) => {
    bootstrapSignal=options.signal;
    return new Promise(resolve=>{deliver=()=>resolve({ok:true,json:async()=>({token:'secret',baseURL:'https://localhost:43793',skillVersion:'writing-1'})});});
  }});
  const pending=client.check(snap(),'polish',{});
  await flush();
  const close=client.dispose();
  await flush();
  assert.equal(bootstrapSignal?.aborted,true);
  deliver();
  await assert.rejects(()=>pending,{name:'AbortError'});
  await close;
  await assert.rejects(()=>client.check(snap(),'polish',{}),{name:'AbortError'});
});

test('local clean result does not announce all checks clean while polish is still unchecked', async () => {
  const env=await setup({check:(s)=>response(s)});
  await env.clock.tick(300);
  assert.equal(env.dom.elements.status.textContent,'拼写已检查');
  await env.clock.tick(900);
  assert.equal(env.dom.elements.status.textContent,'拼写已检查');
  await env.controller.checkContext();await env.clock.tick(0);
  assert.equal(env.dom.elements.status.textContent,'润色已检查');
  await env.controller.dispose();
});

test('sidebar fallback is explicit; protected or unverified text is preview-only, confirmation remains accept-enabled', async () => {
  const env=await setup({capabilities:{annotations:false,safeReplace:false}});
  await env.clock.tick(300);
  assert.match(env.dom.elements['capability-message'].textContent,/侧栏检查/);
  assert.equal(find(env.dom.elements['issue-list'],'接受').disabled,true);
  assert.ok(texts(env.dom.elements['issue-list']).includes('仅预览'));
  await env.event({type:'capabilitiesChanged',capabilities:{annotations:false,safeReplace:true}});
  await env.clock.tick(1200);
  assert.equal(find(env.dom.elements['issue-list'],'接受').disabled,false);
  await env.event({type:'scopeChanged',scope:{scope:'activeParagraph',pageIndices:[],snapshots:[snap('a',{revision:'2',snapshotHash:'protected',scope:'activeParagraph',pageIndices:[],protectedRanges:[{start:0,length:3}]})]}});
  await env.clock.tick(300);
  assert.equal(find(env.dom.elements['issue-list'],'接受').disabled,true);
  await env.controller.dispose();
  const confirm=await setup({check:(s)=>response(s,[{...suggestion(),requiresAuthorConfirmation:true}])});
  await confirm.clock.tick(300);
  assert.equal(find(confirm.dom.elements['issue-list'],'接受').disabled,false);
  assert.ok(texts(confirm.dom.elements['issue-list']).includes('需审阅'));
  await confirm.controller.dispose();
});

test('hidden task pane releases subscriptions and resumes only when hiding interrupted running checks', async () => {
  const env=await setup();
  env.dom.doc.visibilityState='hidden'; await env.dom.doc.fire('visibilitychange');
  assert.equal(env.controller.paused,true); assert.equal(env.subscriptions,0);
  env.dom.doc.visibilityState='visible'; await env.dom.doc.fire('visibilitychange');
  assert.equal(env.controller.paused,false); assert.equal(env.subscriptions,1);
  await env.controller.pause();
  env.dom.doc.visibilityState='hidden'; await env.dom.doc.fire('visibilitychange');
  env.dom.doc.visibilityState='visible'; await env.dom.doc.fire('visibilitychange');
  assert.equal(env.controller.paused,true); assert.equal(env.subscriptions,0);
  await env.controller.dispose();
});

test('no-op author question offers focus and ignore without any replacement action', async () => {
  const env=await setup({check:s=>response(s,[{...suggestion('question','context'),original:'ambiguous',replacement:'ambiguous',requiresAuthorConfirmation:true}])});
  await env.clock.tick(300);
  const list=env.dom.elements['issue-list'];
  assert.ok(find(list,'定位')); assert.ok(find(list,'忽略'));
  assert.equal(find(list,'接受'),null); assert.equal(find(list,'加词典'),null);
  await env.controller.accept(env.controller.queue.current);
  await env.dom.root.fire('keydown',{key:'ArrowDown',altKey:true});
  assert.equal(env.hostCalls.some(call=>call[0]==='apply'),false);
  await env.controller.dispose();
});

test('host cleanup failure still disposes the client, remaining host resources and UI listeners', async () => {
  const env=await setup(); let clientDisposed=false,hostDisposed=false;
  env.host.clear=async()=>{throw new Error('clear failed');};
  env.host.dispose=async()=>{hostDisposed=true;};
  env.controller.client.dispose=async()=>{clientDisposed=true;};
  await assert.rejects(()=>env.controller.dispose(),/clear failed/);
  assert.equal(clientDisposed,true); assert.equal(hostDisposed,true);
  assert.equal(env.controller.disposed,true);
  assert.equal(env.dom.root.events.get('keydown').size,0);
});

test('client cleanup aborts text requests immediately and bounds cancellation acknowledgement waits', async () => {
  const [, {WritingClient}]=await modules;
  const clock=new Clock();let checkSignal,cancelSignal,closed=false;
  const client=new WritingClient({origin:'https://localhost:43793',timers:clock,fetch:async(url,options)=>{
    if(String(url).endsWith('bootstrap'))return {ok:true,json:async()=>({token:'secret',baseURL:'https://localhost:43793',skillVersion:'writing-1'})};
    if(String(url).endsWith('check'))checkSignal=options.signal;else cancelSignal=options.signal;
    return new Promise((resolve,reject)=>options.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
  }});
  const pending=assert.rejects(()=>client.check(snap(),'polish',{}),{name:'AbortError'});
  await flush();
  const closing=client.dispose().then(()=>{closed=true;});await flush();
  assert.equal(checkSignal.aborted,true);
  await clock.tick(1999);assert.equal(closed,false);
  await clock.tick(1);assert.equal(cancelSignal?.aborted,true);
  await closing;await pending;
});

test('I1 bootstrap identifies the same-origin Word request before any private check', async () => {
  const [, {WritingClient}]=await modules; const calls=[];
  const client=new WritingClient({origin:'https://localhost:43793',fetch:async(url,options)=>{
    calls.push({url,options});
    if(String(url).endsWith('bootstrap'))return {ok:options.headers?.['X-AskGPT-Writing']==='1',json:async()=>({token:'secret',baseURL:'https://localhost:43793',skillVersion:'writing-1'})};
    return {ok:true,json:async()=>response(snap())};
  }});
  await client.check(snap(),'polish',{});
  assert.equal(calls[0].options.headers['X-AskGPT-Writing'],'1');
  assert.equal(calls[1].options.headers.Authorization,'Bearer secret');
  await client.dispose();
});

test('I2 asynchronous per-issue validation keeps accept closed until resolved and rechecks direct accepts', async () => {
  const actions=deferred(); const env=await setup({host:{getIssueActions:()=>actions.promise}});
  await env.clock.tick(300);
  assert.equal(find(env.dom.elements['issue-list'],'接受').disabled,true);
  actions.resolve({canApply:false,reason:'目标混合格式，仅预览。'});await flush();
  assert.equal(find(env.dom.elements['issue-list'],'接受').disabled,true);
  assert.ok(texts(env.dom.elements['issue-list']).includes('目标混合格式，仅预览。'));
  assert.equal(find(env.dom.elements['issue-list'],'定位').disabled,false);
  await env.controller.accept(env.controller.queue.current);
  assert.equal(env.hostCalls.some(call=>call[0]==='apply'),false);
  await env.controller.dispose();
});

test('I2 old issue action response cannot enable the new revision card', async () => {
  const old=deferred();const env=await setup({host:{getIssueActions:e=>e.snapshot.revision==='1'?old.promise:Promise.resolve({canApply:false,reason:'新版本仅预览。'})}});
  await env.clock.tick(300);
  await env.event({type:'scopeChanged',scope:{scope:'visiblePages',pageIndices:[2],snapshots:[snap('a',{revision:'2',snapshotHash:'new',pageIndices:[2]})]}});
  await env.clock.tick(300);
  old.resolve({canApply:true,reason:''});await flush();
  assert.equal(find(env.dom.elements['issue-list'],'接受').disabled,true);
  assert.ok(texts(env.dom.elements['issue-list']).includes('新版本仅预览。'));
  await env.controller.dispose();
});

test('I3 a manual selection affects one capture and subsequent refresh and resume use visiblePages', async () => {
  const modes=[];const env=await setup({host:{captureScope:async mode=>{modes.push(mode);return {scope:mode,pageIndices:[1],snapshots:[snap('a',{scope:mode})]};}}});
  await env.controller.checkSelection();await env.clock.tick(0);
  assert.match(env.dom.elements['scope-label'].textContent,/选句/);
  await env.controller.refresh();
  assert.equal(modes.at(-1),'visiblePages');
  await env.controller.pause();await env.controller.resume();
  assert.equal(modes.at(-1),'visiblePages');
  await env.controller.dispose();
});

test('I4 automatic off allows one manual job without reviving watchers or future checks', async () => {
  const env=await setup();env.dom.elements['auto-check'].checked=false;
  await env.dom.elements['auto-check'].fire('change');
  await env.controller.checkSelection();await env.clock.tick(1200);
  assert.equal(env.calls.length,1);assert.equal(env.subscriptions,0);
  const before=env.calls.length;
  await env.controller.onHostChange({type:'scopeChanged',scope:{scope:'visiblePages',pageIndices:[2],snapshots:[snap('a',{revision:'2',snapshotHash:'new'})]}});
  await env.clock.tick(1200);assert.equal(env.calls.length,before);
  env.dom.elements['auto-check'].checked=true;await env.dom.elements['auto-check'].fire('change');
  await env.clock.tick(1200);assert.equal(env.calls.length,before+1);assert.equal(env.subscriptions,1);
  await env.controller.dispose();
});

test('I5 spelling without candidate remains red and read-only with focus ignore and dictionary', async () => {
  const env=await setup({check:s=>response(s,[{...suggestion(),original:'teh',replacement:'teh',reason:'拼写错误，暂无候选。'}])});
  await env.clock.tick(300);const list=env.dom.elements['issue-list'];
  assert.equal(list.children[0]?.dataset.tone,'red');
  assert.ok(find(list,'定位'));assert.ok(find(list,'忽略'));assert.ok(find(list,'加词典'));
  assert.equal(find(list,'接受'),null);assert.notEqual(env.dom.elements.status.textContent,'未发现问题');
  await env.controller.dispose();
});

test('I6 pushed scope invalidates earlier capture before it can restore stale text or schedule checks', async () => {
  const env=await setup();const capture=deferred();env.host.captureScope=()=>capture.promise;
  const older=env.controller.refresh();
  await env.event({type:'scopeChanged',scope:{scope:'visiblePages',pageIndices:[2],snapshots:[snap('a',{revision:'2',snapshotHash:'new'})]}});
  capture.resolve({scope:'visiblePages',pageIndices:[1],snapshots:[snap()]});await older;
  assert.equal(env.controller.scope.snapshots[0].revision,'2');
  await env.clock.tick(1200);assert.ok(env.calls.every(call=>call.snapshot.revision==='2'));
  await env.controller.dispose();
});

test('I7 late metadata cannot recreate annotations after pause', async () => {
  const pages=deferred(),shows=[];
  const env=await setup({host:{getIssuePageIndices:()=>pages.promise,showIssues:async issues=>shows.push(issues.length)}});
  await env.clock.tick(300);await env.controller.pause();
  pages.resolve([1]);await flush();
  assert.deepEqual(shows,[]);
  await env.controller.dispose();
});

test('I7 pause clears after an already-started asynchronous annotation write finishes', async () => {
  const writing=deferred(),order=[];
  const env=await setup({host:{showIssues:async()=>{order.push('show-start');await writing.promise;order.push('show-end');},clear:async()=>order.push('clear')}});
  await env.clock.tick(300);assert.ok(order.includes('show-start'));
  const pausing=env.controller.pause();await flush();writing.resolve();await pausing;
  assert.equal(order.at(-1),'clear');
  await env.controller.dispose();
});

test('I8 pause-resume during pending watch registration leaves exactly one live watcher', async () => {
  const env=await setup();await env.controller.pause();
  const registering=deferred();let registrations=0,active=0;
  env.host.watch=async()=>{const first=++registrations===1;if(first)await registering.promise;active++;return ()=>{active--;};};
  const first=env.controller.resume();await flush();await env.controller.pause();const second=env.controller.resume();await flush();
  registering.resolve();await Promise.all([first,second]);
  assert.equal(active,1);assert.equal(typeof env.controller.unwatch,'function');
  await env.controller.dispose();assert.equal(active,0);
});

test('I9 abort and cancel settle immediately while shared bootstrap stays available to a later check', async () => {
  const [, {WritingClient}]=await modules;const bootstrap=deferred();const calls=[];
  const client=new WritingClient({origin:'https://localhost:43793',fetch:async(url,options)=>{calls.push(String(url));if(String(url).endsWith('bootstrap'))return bootstrap.promise;const body=JSON.parse(options.body);return {ok:true,json:async()=>response(body.snapshot)};}});
  const abort=new AbortController();let checkSettled=false,cancelSettled=false;
  const first=client.check(snap(),'polish',{}, {signal:abort.signal}).then(()=>{throw new Error('must cancel');},error=>{assert.equal(error.name,'AbortError');checkSettled=true;});
  await flush();abort.abort();const cancel=client.cancel('req-a').then(()=>{cancelSettled=true;});await flush();
  assert.equal(checkSettled,true);assert.equal(cancelSettled,true);
  const next=client.check(snap('b'),'polish',{});
  bootstrap.resolve({ok:true,json:async()=>({token:'secret',baseURL:'https://localhost:43793',skillVersion:'writing-1'})});
  await first;await cancel;assert.equal((await next).requestID,'req-b');
  assert.equal(calls.filter(url=>url.endsWith('check')).length,1);
  await client.dispose();
});

test('M1 capability reason is safe visible text and does not replace an actual check error', async () => {
  const env=await setup({capabilities:{annotations:false,message:'无 Microsoft 365 文内标注，使用侧栏。'}});
  assert.equal(env.dom.elements['capability-message'].textContent,'无 Microsoft 365 文内标注，使用侧栏。');
  env.controller.showError(new Error('真实检查失败'));
  await env.event({type:'capabilitiesChanged',capabilities:{message:'<img src=x> 可见页不可用，使用活动段。'}});
  assert.equal(env.dom.elements['capability-message'].textContent,'<img src=x> 可见页不可用，使用活动段。');
  assert.equal(env.dom.elements.error.textContent,'真实检查失败');
  await env.controller.dispose();
});

test('settings changes with automatic off invalidate results and wait for an explicit check', async () => {
  const env=await setup({check:(s,mode)=>response(s,[suggestion('preference',mode==='polish'?'expression':'spelling')])});await env.clock.tick(300);
  env.dom.elements['auto-check'].checked=false;await env.dom.elements['auto-check'].fire('change');
  for (const [element,field,value,button] of [
    ['spelling-variant','spellingVariant','en-GB','check-selection'],
    ['spelling-variant','spellingVariant','en-US','check-context'],
    ['writing-style','style','clarity','check-selection'],
    ['writing-style','style','minimal','check-context']
  ]) {
    assert.ok(env.controller.queue.issues.length>0);
    const before=env.calls.length,clears=env.hostCalls.filter(call=>call[0]==='clear').length;
    env.dom.elements[element].value=value;await env.dom.elements[element].fire('change');
    assert.equal(env.controller.profile[field],value);
    assert.equal(env.controller.queue.issues.length,0);
    assert.equal(env.dom.elements.status.textContent,'尚未检查');
    assert.ok(env.hostCalls.filter(call=>call[0]==='clear').length>clears);
    await env.clock.tick(1200);
    assert.equal(env.calls.length,before,`${field}=${value} must wait for the user`);
    assert.equal(env.controller.auto,false);assert.equal(env.subscriptions,0);
    await env.dom.elements[button].fire('click');await env.clock.tick(0);
    assert.deepEqual(env.calls.slice(before).map(call=>call.mode),[button==='check-selection'?'spelling':'polish']);
    assert.equal(env.calls.at(-1).profile[field],value);
  }
  const count=env.calls.length;
  await env.controller.onHostChange({type:'scopeChanged',scope:{scope:'visiblePages',pageIndices:[2],snapshots:[snap('a',{revision:'3',snapshotHash:'third'})]}});
  await env.clock.tick(1200);assert.equal(env.calls.length,count);
  env.dom.elements['auto-check'].checked=true;await env.dom.elements['auto-check'].fire('change');
  await env.clock.tick(1200);assert.equal(env.calls.length,count+1);assert.equal(env.subscriptions,1);
  await env.controller.dispose();
});

test('settings changes with automatic on recheck only native spelling for both variants and styles', async () => {
  const env=await setup();await env.clock.tick(1200);
  for (const [element,field,value] of [
    ['spelling-variant','spellingVariant','en-GB'],['spelling-variant','spellingVariant','en-US'],
    ['writing-style','style','clarity'],['writing-style','style','minimal']
  ]) {
    const before=env.calls.length;
    env.dom.elements[element].value=value;await env.dom.elements[element].fire('change');
    assert.equal(env.controller.queue.issues.length,0);
    assert.equal(env.dom.elements.status.textContent,'尚未检查');
    await env.clock.tick(299);assert.equal(env.calls.length,before);
    await env.clock.tick(1);assert.deepEqual(env.calls.slice(before).map(call=>call.mode),['spelling']);
    await env.clock.tick(900);assert.deepEqual(env.calls.slice(before).map(call=>call.mode),['spelling']);
    assert.equal(env.calls.at(-1).profile[field],value);
    assert.equal(env.controller.auto,true);assert.equal(env.subscriptions,1);
  }
  await env.controller.dispose();
});

test('settings changes cancel pending manual checks and late results stay invalid with automatic off', async () => {
  const pending=[];
  const env=await setup({check:(snapshot,mode)=>new Promise(resolve=>pending.push({snapshot,mode,resolve}))});
  await env.controller.setAutomatic(false);
  for (const [element,value,mode] of [
    ['spelling-variant','en-GB','spelling'],['spelling-variant','en-US','polish'],
    ['writing-style','clarity','spelling'],['writing-style','minimal','polish']
  ]) {
    await env.dom.elements[mode==='polish'?'check-polish':'check-selection'].fire('click');await env.clock.tick(0);
    const old=env.calls.slice(-1),deliveries=pending.splice(0),before=env.calls.length;
    assert.deepEqual(old.map(call=>call.mode),[mode]);
    env.dom.elements[element].value=value;await env.dom.elements[element].fire('change');
    for (const call of old) {
      assert.equal(call.opts.signal.aborted,true);
      assert.ok(env.cancelled.includes(call.snapshot.requestID));
    }
    for (const delivery of deliveries) delivery.resolve(response(delivery.snapshot,[suggestion('old',delivery.mode==='polish'?'expression':'spelling')]));
    await flush();await env.clock.tick(1200);
    assert.equal(env.calls.length,before);
    assert.equal(env.controller.queue.issues.length,0);
    assert.equal(env.dom.elements.status.textContent,'尚未检查');
    assert.equal(env.subscriptions,0);
  }
  await env.controller.dispose();
});

test('unverified automatic host capability disables automatic checks while keeping manual checks available', async () => {
  const env=await setup({capabilities:{automaticCheck:false,message:'WPS 使用主动检查。'}});
  await env.clock.tick(1200);assert.equal(env.calls.length,0);
  assert.equal(env.dom.elements['auto-check'].disabled,true);assert.equal(env.controller.auto,false);
  await env.controller.checkSelection();await env.clock.tick(1200);assert.equal(env.calls.length,1);
  assert.equal(env.subscriptions,0);await env.controller.dispose();
});

test('automatic capability downgrade stops an existing watcher without blocking manual work', async () => {
  const env=await setup();
  await env.event({type:'capabilitiesChanged',capabilities:{automaticCheck:false,message:'实时检查不可用。'}});
  await env.clock.tick(1200);assert.equal(env.calls.length,0);assert.equal(env.subscriptions,0);assert.equal(env.controller.auto,false);
  await env.controller.checkSelection();await env.clock.tick(1200);assert.equal(env.calls.length,1);
  await env.controller.dispose();
});

test('I9 an already-aborted check does not start bootstrap or retain a pending operation', async () => {
  const [, {WritingClient}]=await modules;let fetchCalls=0;
  const client=new WritingClient({origin:'https://localhost:43793',fetch:async()=>{fetchCalls++;return new Promise(()=>{});}});
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>client.check(snap(),'polish',{}, {signal:controller.signal}),{name:'AbortError'});
  assert.equal(fetchCalls,0);await client.dispose();
});

test('context action prefers the selected target with read-only neighbors and only empty selection falls back', async () => {
  const modes=[];let empty=false;
  const env=await setup({host:{captureScope:async mode=>{modes.push(mode);if(mode==='selection'&&empty)throw Object.assign(new Error('请先选择文本。'),{code:'emptySelection'});return {scope:mode,pageIndices:[1],snapshots:[snap('a',{scope:mode,targetRange:mode==='selection'?{start:4,length:4}:{start:0,length:16},contextBefore:'Before.',contextAfter:'After.'})]};}}});
  await env.controller.checkContext();await env.clock.tick(0);
  assert.equal(modes.at(-1),'selection');
  assert.deepEqual(env.calls.at(-1).snapshot.targetRange,{start:4,length:4});
  assert.equal(env.calls.at(-1).snapshot.contextBefore,'Before.');
  empty=true;await env.controller.checkContext();await env.clock.tick(0);
  assert.deepEqual(modes.slice(-2),['selection','visiblePages']);
  await env.controller.dispose();
});

test('manual polish completes without source events and real scope change restores visiblePages', async () => {
  const polish=deferred();const env=await setup({check:(s,mode)=>mode==='polish'?polish.promise.then(()=>response(s,[suggestion('manual','expression')])):response(s),host:{captureScope:async mode=>({scope:mode,pageIndices:[1],snapshots:[snap('a',{scope:mode,targetRange:mode==='selection'?{start:4,length:4}:{start:0,length:16}})]})}});
  await env.controller.checkPolish();await env.clock.tick(0);await env.clock.tick(750);
  polish.resolve();await flush();
  assert.equal(env.controller.queue.current.issue.id,'manual');assert.equal(env.controller.scope.scope,'selection');
  await env.event({type:'scopeChanged',scope:{scope:'visiblePages',pageIndices:[2],snapshots:[snap('b',{pageIndices:[2]})]}});
  assert.equal(env.controller.scope.scope,'visiblePages');assert.equal(env.controller.scopeMode,'visiblePages');
  assert.equal(env.controller.queue.issues.length,0);await env.controller.dispose();
});

test('I2 superseded action validation for the same snapshot cannot overwrite a newer capability answer', async () => {
  const old=deferred();let checks=0;
  const env=await setup({host:{getIssueActions:()=>++checks===1?old.promise:Promise.resolve({canApply:false,reason:'最新格式仅预览。'})}});
  await env.clock.tick(300);
  await env.event({type:'capabilitiesChanged',capabilities:{safeReplace:true,message:'格式能力已更新。'}});
  old.resolve({canApply:true,reason:''});await flush();
  assert.equal(find(env.dom.elements['issue-list'],'接受').disabled,true);
  assert.ok(texts(env.dom.elements['issue-list']).includes('最新格式仅预览。'));
  await env.controller.dispose();
});

test('I2 a paused accept never applies after delayed final action validation succeeds', async () => {
  const env=await setup();await env.clock.tick(300);
  const validation=deferred();env.host.getIssueActions=()=>validation.promise;
  const accepting=env.controller.accept(env.controller.queue.current);await flush();
  await env.controller.pause();validation.resolve({canApply:true,reason:''});await accepting;
  assert.equal(env.hostCalls.some(call=>call[0]==='apply'),false);assert.equal(env.controller.paused,true);
  await env.controller.dispose();
});

test('R1 automatic spelling never starts GPT and checking a selection remains spelling-only', async () => {
  const env=await setup();await env.clock.tick(5000);
  assert.deepEqual(env.calls.map(call=>call.mode),['spelling']);
  await env.controller.checkSelection();await env.clock.tick(5000);
  assert.deepEqual(env.calls.map(call=>call.mode),['spelling','spelling']);
  await env.controller.dispose();
});

test('R2 GPT runs only after explicit polishing and remains cancelled on source edits', async () => {
  const pending=deferred();const env=await setup({check:(snapshot,mode)=>mode==='polish'?pending.promise.then(()=>response(snapshot,[suggestion('late','expression')])):response(snapshot)});
  await env.clock.tick(300);await env.dom.elements['check-polish'].fire('click');await env.clock.tick(0);
  assert.deepEqual(env.calls.map(call=>call.mode),['spelling','polish']);
  const gpt=env.calls.at(-1);
  await env.event({type:'scopeChanged',scope:{scope:'visiblePages',pageIndices:[2],snapshots:[snap('b',{pageIndices:[2]})]}});
  assert.equal(gpt.opts.signal.aborted,true);
  pending.resolve();await flush();await env.clock.tick(1200);
  assert.equal(env.controller.queue.issues.some(envelope=>envelope.issue.id==='late'),false);
  assert.equal(env.calls.filter(call=>call.mode==='polish').length,1);
  await env.controller.dispose();
});

test('R3 palette defaults to amber and preserves all fixed choices without another check', async () => {
  const marked=[];const env=await setup({host:{setMarkPalette:async palette=>marked.push(palette)}});await env.clock.tick(300);
  assert.deepEqual(marked[0],{id:'amber',start:'#FF9500',end:'#FFD60A'});assert.equal(env.dom.root.getAttribute('data-palette'),'amber');
  const before=env.calls.length;
  for(const palette of [{id:'ocean',start:'#5D83B9',end:'#7BA9BC'},{id:'mint',start:'#538E83',end:'#8EB6A1'},{id:'rose',start:'#B86D82',end:'#CC9BA1'},{id:'amber',start:'#FF9500',end:'#FFD60A'}]){
    env.dom.elements['mark-palette'].value=palette.id;await env.dom.elements['mark-palette'].fire('change');assert.deepEqual(marked.at(-1),palette);assert.equal(env.dom.root.getAttribute('data-palette'),palette.id);
  }
  assert.equal(env.calls.length,before);
  env.dom.elements['mark-palette'].value='url(javascript:alert(1))';await env.dom.elements['mark-palette'].fire('change');
  assert.equal(marked.length,5);assert.equal(env.dom.root.getAttribute('data-palette'),'amber');
  assert.match(env.dom.elements['palette-note'].textContent,/侧栏/);
  await env.controller.dispose();
});

test('R4 an old source failure disappears when automatic scope moves to a new revision', async () => {
  const env=await setup({check:s=>s.revision==='1'?Promise.reject(new Error('旧段落检查失败')):response(s)});await env.clock.tick(300);
  assert.equal(env.dom.elements.error.hidden,false);
  await env.event({type:'scopeChanged',scope:{scope:'visiblePages',pageIndices:[1],snapshots:[snap('a',{revision:'2',snapshotHash:'new'})]}});
  await env.clock.tick(300);assert.equal(env.dom.elements.error.hidden,true);assert.equal(env.dom.elements.status.textContent,'拼写已检查');
  await env.controller.dispose();
});

test('R5 a successful spelling retry clears only its matching error and never hides failed polish', async () => {
  let spellingFails=true,polishFails=true;
  const env=await setup({check:(s,mode)=>mode==='spelling'?(spellingFails?Promise.reject(new Error('拼写服务失败')):response(s)):(polishFails?response(s,[],{status:'failed'}):response(s))});
  await env.clock.tick(300);await env.controller.checkContext();await env.clock.tick(0);
  assert.match(env.dom.elements.error.textContent,/拼写/);assert.match(env.dom.elements.error.textContent,/润色/);
  spellingFails=false;await env.controller.checkSelection();await env.clock.tick(0);
  assert.equal(env.dom.elements.error.hidden,false);assert.doesNotMatch(env.dom.elements.error.textContent,/拼写服务失败/);assert.match(env.dom.elements.error.textContent,/润色/);
  assert.equal(env.dom.elements.status.textContent,'检查失败');
  polishFails=false;await env.controller.checkContext();await env.clock.tick(0);
  assert.equal(env.dom.elements.error.hidden,true);await env.controller.dispose();
});

test('R6 original issue retains the marked mistake while polished replacement stays separate', async () => {
  const env=await setup({check:s=>response(s,[{...suggestion(),original:'teh',replacement:'the'}])});await env.clock.tick(300);
  const card=env.dom.elements['issue-list'].children[0];
  assert.equal(find(card,'teh').className,'issue-mark');assert.equal(find(card,'the').className,'issue-replacement');
  assert.ok(texts(card).includes('拼写'));await env.controller.dispose();
});

test('R7 an older failed request for the same source and mode cannot replace a newer success', async () => {
  const old=deferred();let first=true;const env=await setup({check:s=>first?(first=false,old.promise.then(()=>response(s,[],{status:'failed'}))):response(s)});
  await env.clock.tick(300);
  await env.controller.runCheck(env.controller.scope.snapshots[0],'spelling');
  old.resolve();await flush();
  assert.equal(env.dom.elements.error.hidden,true);assert.equal(env.dom.elements.status.textContent,'拼写已检查');
  await env.controller.dispose();
});

test('R8 an explicit retry dismisses its previous operation error without clearing an unresolved check failure', async () => {
  const env=await setup({check:s=>Promise.reject(new Error('拼写仍失败'))});await env.clock.tick(300);
  env.controller.showError(new Error('上次定位失败'));
  await env.controller.checkSelection();await env.clock.tick(0);
  assert.doesNotMatch(env.dom.elements.error.textContent,/定位失败/);assert.match(env.dom.elements.error.textContent,/拼写仍失败/);
  await env.controller.dispose();
});
