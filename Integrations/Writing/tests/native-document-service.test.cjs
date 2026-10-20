const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const {createFakeWord} = require('./fake-word.cjs');
const {makeDOM} = require('./taskpane-dom-helper.cjs');
const load = name => import(pathToFileURL(path.join(__dirname, name)).href);

async function setup(options = {}) {
  const fake = createFakeWord({support:{WordApi:'1.8',WordApiDesktop:'1.4',SharedRuntime:'1.1'},paragraphs:[{text:'The resuts are clear.',pages:[1]}],...options});
  fake.state.windowActive = options.windowActive !== false;
  fake.state.activeLoads = 0;
  const window = fake.document.activeWindow;
  window.load = properties => {assert.equal(properties,'isActive');fake.state.activeLoads++;if(options.activeFailure)throw Error('NotSupported');return window;};
  Object.defineProperty(window,'isActive',{get:()=>fake.state.windowActive});
  const visibility = new Set();
  const Office = fake.Office;
  Office.VisibilityMode = {hidden:'Hidden',taskpane:'Taskpane'};
  Office.addin.onVisibilityModeChanged = async handler => {visibility.add(handler);return async()=>visibility.delete(handler);};
  Office.addin.hide = async () => {if(options.hideFailure)throw Error('hide_failed');if(!options.noHiddenEvent)for(const handler of [...visibility])await handler({visibilityMode:'Hidden'});};
  Office.addin.showAsTaskpane = async () => {for(const handler of [...visibility])await handler({visibilityMode:'Taskpane'});};
  const timers = {next:0,intervals:new Map(),timeouts:new Map(),delays:new Map(),setInterval(fn){const id=++this.next;this.intervals.set(id,fn);return id;},clearInterval(id){this.intervals.delete(id);},setTimeout(fn,ms){const id=++this.next;this.timeouts.set(id,fn);this.delays.set(id,ms);return id;},clearTimeout(id){this.timeouts.delete(id);this.delays.delete(id);}};
  const fallback = {disposed:false,profile:{spellingVariant:'en-US',style:'minimal',customTerms:[]},capabilities:{},pauses:0,resumes:0,async pause(){this.pauses++;},async resume(){this.resumes++;},render(){}};
  const transport = {registrations:[],exchanges:[],closed:[],commands:[],async register(payload){this.registrations.push(structuredClone(payload));return {leaseID:'lease-0123456789abcdef',epoch:1,leaseTTLMilliseconds:5000,pollAfterMilliseconds:750};},async exchange(payload){this.exchanges.push(structuredClone(payload));if(options.exchangeFailure)throw Error('transport_failed');return {commands:this.commands.length?[this.commands.shift()]:[]};},async close(payload){this.closed.push(payload);},dispose(){}};
  const checks = [];
  const client = {cancelled:[],async check(snapshot,mode,profile){checks.push({snapshot,mode,profile});const start=snapshot.rawText.indexOf('resuts');return {requestID:snapshot.requestID,snapshotHash:snapshot.snapshotHash,skillVersion:'local-1',status:'completed',issues:start<0?[]:[{id:'spelling-1',category:'spelling',original:'resuts',replacement:'results',reason:'Spelling',range:{start,length:6},requiresAuthorConfirmation:false}]};},async cancel(id){this.cancelled.push(id);},async dispose(){}};
  const {NativeWordDocumentService} = await load('../word/native-document-service.js');
  const {createWordHost} = await load('../word/word-host.js');
  const host=createWordHost({...fake,Office,requireActiveWindow:true});
  const service = new NativeWordDocumentService({host,Office,timers,transport,client,fallback,clock:options.clock});
  return {fake,Office,timers,fallback,transport,client,checks,host,service,async emitVisibility(mode){for(const handler of [...visibility])await handler({visibilityMode:mode});}};
}
async function command(env,action,extra={}) {
  const value={id:crypto.randomUUID(),epoch:env.service.state.epoch,action,...extra};
  env.transport.commands.push(value);await env.service.exchangeOnce();
  const report=()=>env.transport.exchanges.find(payload=>payload.result?.commandID===value.id)?.result;
  await settleUntil(()=>report()||env.service.state.status==='failed');
  return report();
}

function startupOffice({setFailure=false,getFailure=false,readback}={}) {
  const calls=[];let mode='None';
  const Office={StartupBehavior:{load:'Load',none:'None'},context:{document:{},requirements:{isSetSupported:()=>true}},addin:{
    async setStartupBehavior(value){calls.push(['set',value]);if(setFailure)throw Error('PRIVATE_SET_ERROR');mode=value;},
    async getStartupBehavior(){calls.push(['get']);if(getFailure)throw Error('PRIVATE_GET_ERROR');return readback??mode;}
  }};
  return {Office,calls,get mode(){return mode;}};
}

test('document startup preference confirms set and readback once for each requested behavior',async()=>{
  const {WordDocumentStartupPreference}=await load('../word/native-document-service.js');assert.equal(typeof WordDocumentStartupPreference,'function');
  const fixture=startupOffice(),preference=new WordDocumentStartupPreference({Office:fixture.Office});
  const first=preference.request(true);assert.equal(preference.request(true),first);assert.equal(await first,'enabled');
  assert.equal(await preference.request(true),'enabled');assert.equal(await preference.request(false),'disabled');assert.equal(await preference.request(false),'disabled');
  assert.deepEqual(fixture.calls,[['set','Load'],['get'],['set','None'],['get']]);assert.equal(preference.status,'disabled');
});

test('document startup preference never claims enablement when APIs are missing or verification fails',async()=>{
  const {WordDocumentStartupPreference}=await load('../word/native-document-service.js');assert.equal(typeof WordDocumentStartupPreference,'function');
  for(const kind of ['missing','unsupported','set','get','mismatch']){
    const fixture=startupOffice({setFailure:kind==='set',getFailure:kind==='get',readback:kind==='mismatch'?'None':undefined});
    if(kind==='missing')delete fixture.Office.addin.getStartupBehavior;
    if(kind==='unsupported')fixture.Office.context.requirements.isSetSupported=()=>false;
    const preference=new WordDocumentStartupPreference({Office:fixture.Office}),want=['missing','unsupported'].includes(kind)?'unavailable':'failed';
    assert.equal(await preference.request(true),want);assert.equal(preference.status,want);
    const count=fixture.calls.length;assert.equal(await preference.request(true),want);assert.equal(fixture.calls.length,count,'same intent is not an automatic retry');
  }
});

test('document startup preference serializes a closing disable after an in-flight enable and skips superseded reads',async()=>{
  const {WordDocumentStartupPreference}=await load('../word/native-document-service.js');assert.equal(typeof WordDocumentStartupPreference,'function');
  const fixture=startupOffice();let allowed=true,entered,release;
  const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),set=fixture.Office.addin.setStartupBehavior;
  fixture.Office.addin.setStartupBehavior=async value=>{if(value==='Load'){entered();await gate;}return set(value);};
  const preference=new WordDocumentStartupPreference({Office:fixture.Office,allowLoad:()=>allowed});
  const enabling=preference.request(true);await inside;allowed=false;const closing=preference.request(false);assert.equal(preference.request(false),closing);release();
  assert.equal(await enabling,'superseded');assert.equal(await closing,'disabled');assert.equal(fixture.mode,'None');
  assert.deepEqual(fixture.calls,[['set','Load'],['set','None'],['get']]);assert.equal(preference.status,'disabled');
});

test('document startup preference rejects a queued enable after closing or document identity change',async()=>{
  const {WordDocumentStartupPreference}=await load('../word/native-document-service.js');assert.equal(typeof WordDocumentStartupPreference,'function');
  const fixture=startupOffice();let allowed=true;
  const preference=new WordDocumentStartupPreference({Office:fixture.Office,allowLoad:()=>allowed});
  const enabling=preference.request(true);allowed=false;const closing=preference.request(false);
  assert.equal(await enabling,'superseded');assert.equal(await closing,'disabled');assert.deepEqual(fixture.calls,[['set','None'],['get']]);
  fixture.Office.context.document={};assert.equal(await preference.request(true),'superseded');assert.equal(fixture.calls.length,2);
});

test('document startup preference cannot reuse a prior enabled claim after closure or document replacement',async()=>{
  const {WordDocumentStartupPreference}=await load('../word/native-document-service.js');
  for(const kind of ['closing','document']){
    const fixture=startupOffice();let allowed=true;
    const preference=new WordDocumentStartupPreference({Office:fixture.Office,allowLoad:()=>allowed});
    assert.equal(await preference.request(true),'enabled');
    if(kind==='closing')allowed=false;else fixture.Office.context.document={};
    assert.equal(await preference.request(true),'superseded');assert.equal(preference.status,'superseded');assert.equal(fixture.calls.length,2);
  }
});

test('document startup mount hooks existing automatic and close controls without reopening a closed controller',async()=>{
  const {mountNativeWordService}=await load('../word/native-document-service.js');
  const fixture=startupOffice(),dom=makeDOM(),actions=dom.doc.createElement('div'),query=dom.doc.querySelector;
  dom.doc.querySelector=selector=>selector==='.check-actions'?actions:query(selector);
  const controller={auto:true,closing:false,disposed:false,host:{Office:fixture.Office},profile:{},capabilities:{},async pause(){},async resume(){},render(){}};
  const mounted=await mountNativeWordService({controller,document:dom.doc,location:{href:'https://localhost:43793/shared/taskpane.html?host=word',origin:'https://localhost:43793'}});
  await mounted.startupReady;assert.equal(controller.documentStartupStatus,'enabled');
  let stops=0;const stop=mounted.service.stop.bind(mounted.service);mounted.service.stop=async()=>{stops++;return stop();};
  controller.auto=false;dom.elements['auto-check'].checked=false;await dom.elements['auto-check'].fire('change');
  assert.equal(controller.documentStartupStatus,'disabled');assert.equal(fixture.mode,'None');assert.equal(stops,0,'startup preference must not destroy the active runtime on automatic off');
  controller.auto=true;dom.elements['auto-check'].checked=true;await dom.elements['auto-check'].fire('change');assert.equal(controller.documentStartupStatus,'enabled');assert.equal(stops,0);
  controller.closing=true;await dom.elements.close.fire('click');assert.equal(fixture.mode,'None');
  assert.equal(stops,1);assert.deepEqual(fixture.calls,[['set','Load'],['get'],['set','None'],['get'],['set','Load'],['get'],['set','None'],['get']]);await mounted.stop();
});

test('registered runtime sends a heartbeat while the first Word capture is still pending',async()=>{
  const env=await setup();let entered,release;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),capture=env.host.captureScope.bind(env.host);
  env.host.captureScope=async mode=>{entered();await gate;return capture(mode);};const starting=env.service.start();await inside;
  try{await settleUntil(()=>env.transport.exchanges.length>0);assert.ok(env.timers.timeouts.size>0,'heartbeat must remain scheduled while capture is pending');assert.equal(env.transport.exchanges.length,1);assert.equal(env.transport.exchanges[0].state.active,false);assert.equal(env.transport.exchanges[0].state.status,'preview');assert.equal(env.transport.exchanges[0].state.scope,null);assert.equal(env.checks.length,0);}
  finally{release();await starting;await env.service.stop();}
});

test('slow local spelling never blocks heartbeat or publishes the candidate paragraph as ready',async()=>{
  const env=await setup();let entered,release;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),check=env.client.check.bind(env.client);
  env.client.check=async(...args)=>{entered();await gate;return check(...args);};const starting=env.service.start();await inside;
  try{await settleUntil(()=>env.transport.exchanges.length>0);assert.equal(env.transport.exchanges.length,1);const state=env.transport.exchanges[0].state;assert.equal(state.active,false);assert.equal(state.status,'preview');assert.equal(state.scope,null);assert.equal(state.issues.length,0);}
  finally{release();await starting;await env.service.stop();}
});

test('slow apply keeps heartbeats on its delivered epoch until its result and new epoch are acknowledged together',async()=>{
  const env=await setup();await env.service.start();await env.service.exchangeOnce();const epoch=env.service.state.epoch,handle=env.service.state.issues[0].handle;
  let entered,release;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),apply=env.host.applyIssue.bind(env.host);
  env.host.applyIssue=async envelope=>{entered();await gate;return apply(envelope);};env.transport.commands.push({id:crypto.randomUUID(),epoch,action:'apply',handle});const dispatch=env.service.exchangeOnce();await inside;
  try{const before=env.transport.exchanges.length;for(let i=0;i<3;i++)await env.service.exchangeOnce();const pending=env.transport.exchanges.slice(before);assert.equal(pending.length,3);assert.ok(pending.every(payload=>payload.state.epoch===epoch&&payload.state.status==='preview'&&payload.state.issues.length===0&&!payload.result));assert.ok(env.service.state.epoch>epoch);assert.equal(env.fake.state.replacements.length,0);}
  finally{release();await dispatch;}
  await settleUntil(()=>env.transport.exchanges.some(payload=>payload.result));const confirmation=env.transport.exchanges.find(payload=>payload.result);
  assert.equal(confirmation.result?.code,'applied');assert.ok(confirmation.state.epoch>epoch);assert.equal(env.fake.state.replacements.length,1);const confirmedID=confirmation.result.commandID;await env.service.exchangeOnce();assert.equal(env.transport.exchanges.at(-1).result,undefined);assert.equal(env.transport.exchanges.filter(payload=>payload.result?.commandID===confirmedID).length,1);await env.service.stop();
});

test('a command result completed during an earlier HTTP heartbeat survives that response until its own ACK',async()=>{
  const env=await setup();await env.service.start();await env.service.exchangeOnce();const epoch=env.service.state.epoch,handle=env.service.state.issues[0].handle;
  let entered,release,completed=false;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),apply=env.host.applyIssue.bind(env.host);
  env.host.applyIssue=async envelope=>{entered();await gate;await apply(envelope);completed=true;};env.transport.commands.push({id:crypto.randomUUID(),epoch,action:'apply',handle});await env.service.exchangeOnce();await inside;
  let requestEntered,requestRelease;const requestInside=new Promise(resolve=>requestEntered=resolve),requestGate=new Promise(resolve=>requestRelease=resolve),exchange=env.transport.exchange.bind(env.transport);
  env.transport.exchange=async payload=>{const response=await exchange(payload);requestEntered();await requestGate;return response;};const heartbeat=env.service.exchangeOnce();await requestInside;
  assert.equal(await env.service.exchangeOnce(),false,'HTTP exchanges stay single concurrency');assert.equal(env.transport.exchanges.at(-1).result,undefined);
  release();for(let i=0;i<100&&!completed;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(completed,true);await new Promise(resolve=>setImmediate(resolve));requestRelease();await heartbeat;
  await settleUntil(()=>env.transport.exchanges.some(payload=>payload.result));assert.equal(env.transport.exchanges.find(payload=>payload.result)?.result.code,'applied');await new Promise(resolve=>setImmediate(resolve));assert.equal(await env.service.exchangeOnce(),true);assert.equal(env.transport.exchanges.at(-1).result,undefined);assert.equal(env.fake.state.replacements.length,1);await env.service.stop();
});

async function settleUntil(predicate) {
  for(let i=0;i<100&&!predicate();i++)await new Promise(resolve=>setImmediate(resolve));
}

function longPollServer(env) {
  const exchange=env.transport.exchange.bind(env.transport),waiters=[];
  let delivered=false,inFlight=0,maximum=0;
  env.transport.exchange=async payload=>{
    inFlight++;maximum=Math.max(maximum,inFlight);
    try {
      const response=await exchange(payload);
      if(payload.result){delivered=false;return response;}
      if(response.commands.length){delivered=true;return response;}
      if(delivered)return response;
      return await new Promise(resolve=>waiters.push(resolve));
    } finally {inFlight--;}
  };
  return {
    get waiting(){return waiters.length;},get maximum(){return maximum;},
    wake(command){const resolve=waiters.shift();assert.ok(resolve,'an idle HTTP request must already be waiting');if(command)delivered=true;resolve({commands:command?[command]:[],idleWaitMilliseconds:1000});},
    releaseAll(){for(const resolve of waiters.splice(0))resolve({commands:[],idleWaitMilliseconds:1000});}
  };
}

test('idle long polling boots and receives the next command without advancing hidden WebView timers',async()=>{
  const env=await setup(),server=longPollServer(env);
  try {
    await env.service.start();await settleUntil(()=>server.waiting===1);assert.equal(server.waiting,1,'registration must start the first HTTP request without timer zero');
    server.wake();await settleUntil(()=>server.waiting===1);assert.equal(server.waiting,1,'a verified idle timeout must directly open the next HTTP request');
    assert.equal(env.transport.exchanges.length,2);
    const id=crypto.randomUUID(),item=env.service.state.issues[0];server.wake({id,epoch:env.service.state.epoch,action:'apply',handle:item.handle});
    await settleUntil(()=>env.transport.exchanges.some(payload=>payload.result?.commandID===id));
    assert.equal(env.transport.exchanges.filter(payload=>payload.result?.commandID===id).length,1);
    assert.equal(env.transport.exchanges.find(payload=>payload.result?.commandID===id).result.code,'applied');
    assert.equal(env.fake.state.replacements.length,1);assert.equal(server.maximum,1);
    assert.deepEqual(env.transport.exchanges.map(payload=>payload.sequence),Array.from({length:env.transport.exchanges.length},(_,index)=>index+1));
  } finally {await env.service.stop();server.releaseAll();await new Promise(resolve=>setImmediate(resolve));}
});

test('idle long polling falls back to a bounded timer when the response capability is absent or invalid',async()=>{
  for(const capability of [undefined,0,'1000',999]){
    const env=await setup(),exchange=env.transport.exchange.bind(env.transport);
    env.transport.exchange=async payload=>({...await exchange(payload),...(capability===undefined?{}:{idleWaitMilliseconds:capability})});
    try {
      await env.service.start();
      await new Promise(resolve=>setImmediate(resolve));const count=env.transport.exchanges.length;
      assert.ok(count>=1,'bootstrap and changed readiness are published without timers');
      for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));
      assert.equal(env.transport.exchanges.length,count,'an old or invalid-capability server must not create an empty-response busy loop');
      assert.ok([...env.timers.delays.values()].includes(750));
    } finally {await env.service.stop();}
  }
});

test('idle long polling keeps independent busy heartbeats while an authoritative Word write is pending',async()=>{
  const env=await setup(),server=longPollServer(env);let entered,release;
  const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),apply=env.host.applyIssue.bind(env.host);
  env.host.applyIssue=async envelope=>{entered();await gate;return apply(envelope);};
  try {
    await env.service.start();await settleUntil(()=>server.waiting===1);assert.equal(server.waiting,1);
    server.wake();await settleUntil(()=>server.waiting===1);assert.equal(server.waiting,1);
    const id=crypto.randomUUID(),epoch=env.service.state.epoch,handle=env.service.state.issues[0].handle;server.wake({id,epoch,action:'apply',handle});await inside;
    for(let i=0;i<2;i++){
      const scheduled=[...env.timers.delays].find(([,delay])=>delay===750);assert.ok(scheduled,'pending Word.run needs its own heartbeat timer');
      const [timer]=scheduled,callback=env.timers.timeouts.get(timer),count=env.transport.exchanges.length;env.timers.timeouts.delete(timer);env.timers.delays.delete(timer);callback();
      await settleUntil(()=>env.transport.exchanges.length>count);await new Promise(resolve=>setImmediate(resolve));
      const payload=env.transport.exchanges.at(-1);assert.equal(payload.state.status,'preview');assert.equal(payload.state.epoch,epoch);assert.equal(payload.result,undefined);
    }
    assert.equal(env.fake.state.replacements.length,0);release();await settleUntil(()=>env.transport.exchanges.some(payload=>payload.result?.commandID===id));
    assert.equal(env.transport.exchanges.filter(payload=>payload.result?.commandID===id).length,1);assert.equal(env.fake.state.replacements.length,1);assert.equal(server.maximum,1);
  } finally {release();server.releaseAll();await env.service.stop();await new Promise(resolve=>setImmediate(resolve));}
});

test('idle long polling ignores a late response or failure from a stopped lease',async()=>{
  for(const rejects of [false,true]){
    const env=await setup();await env.service.start();await settleUntil(()=>env.transport.exchanges.length===1);
    let entered,release,reject;const inside=new Promise(resolve=>entered=resolve),gate=new Promise((resolve,fail)=>{release=resolve;reject=fail;});
    const exchange=env.transport.exchange.bind(env.transport);env.transport.exchange=async payload=>{await exchange(payload);entered();return gate;};
    const pending=env.service.exchangeOnce();await inside;await env.service.stop();const resumes=env.fallback.resumes,count=env.transport.exchanges.length;
    if(rejects)reject(Error('LATE_PRIVATE_FAILURE'));else release({commands:[],idleWaitMilliseconds:1000});
    assert.equal(await pending,false);for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(env.service.state.status,'paused');assert.equal(env.transport.exchanges.length,count);assert.equal(env.fallback.resumes,resumes);assert.equal(env.timers.timeouts.size,0);assert.equal(env.fake.state.replacements.length,0);
  }
});

test('immediate completion sends the applied result without advancing hidden WebView timers',async()=>{
  const env=await setup();await env.service.start();await env.service.exchangeOnce();
  const id=crypto.randomUUID(),epoch=env.service.state.epoch,handle=env.service.state.issues[0].handle;
  try{
    env.transport.commands.push({id,epoch,action:'apply',handle});await env.service.exchangeOnce();
    await settleUntil(()=>env.transport.exchanges.some(payload=>payload.result?.commandID===id));
    const reports=env.transport.exchanges.filter(payload=>payload.result?.commandID===id);
    assert.equal(reports.length,1,'completed result must be submitted without running a timer or another manual exchange');
    assert.equal(reports[0].result.code,'applied');assert.ok(reports[0].state.epoch>epoch);
    assert.deepEqual(env.fake.state.replacements,[{id:'p0',start:7,end:8,text:'ul'}]);
  }finally{await env.service.stop();}
});

test('immediate completion waits for an in-flight heartbeat then reports once with strictly serial HTTP',async()=>{
  const env=await setup();await env.service.start();await env.service.exchangeOnce();
  const id=crypto.randomUUID(),epoch=env.service.state.epoch,handle=env.service.state.issues[0].handle;
  let entered,release,completed=false;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),apply=env.host.applyIssue.bind(env.host);
  env.host.applyIssue=async envelope=>{entered();await gate;await apply(envelope);completed=true;};
  env.transport.commands.push({id,epoch,action:'apply',handle});await env.service.exchangeOnce();await inside;
  let requestEntered,requestRelease,hold=true,inFlight=0,maximum=0;
  const requestInside=new Promise(resolve=>requestEntered=resolve),requestGate=new Promise(resolve=>requestRelease=resolve),exchange=env.transport.exchange.bind(env.transport);
  env.transport.exchange=async payload=>{inFlight++;maximum=Math.max(maximum,inFlight);try{const response=await exchange(payload);if(hold){hold=false;requestEntered();await requestGate;}return response;}finally{inFlight--;}};
  const heartbeat=env.service.exchangeOnce();await requestInside;
  try{
    release();await settleUntil(()=>completed);assert.equal(completed,true);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(env.transport.exchanges.filter(payload=>payload.result?.commandID===id).length,0,'new result cannot bypass the earlier HTTP');
    requestRelease();await heartbeat;
    await settleUntil(()=>env.transport.exchanges.some(payload=>payload.result?.commandID===id));
    const reports=env.transport.exchanges.filter(payload=>payload.result?.commandID===id);
    assert.equal(reports.length,1,'heartbeat response must trigger the pending completion without a timer');assert.equal(reports[0].result.code,'applied');
    assert.equal(maximum,1);assert.equal(env.fake.state.replacements.length,1);
    assert.deepEqual(env.transport.exchanges.map(payload=>payload.sequence),Array.from({length:env.transport.exchanges.length},(_,index)=>index+1));
    await env.service.exchangeOnce();assert.equal(env.transport.exchanges.filter(payload=>payload.result?.commandID===id).length,1,'old heartbeat ACK cannot clear or duplicate the new result');
  }finally{release();requestRelease();await heartbeat;await env.service.stop();}
});

test('immediate completion cannot revive a stopped lease or retry an apply that was already in flight',async()=>{
  const env=await setup();await env.service.start();await env.service.exchangeOnce();
  const id=crypto.randomUUID(),epoch=env.service.state.epoch,handle=env.service.state.issues[0].handle;
  let entered,release;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),apply=env.host.applyIssue.bind(env.host);
  env.host.applyIssue=async envelope=>{entered();await gate;return apply(envelope);};
  env.transport.commands.push({id,epoch,action:'apply',handle});await env.service.exchangeOnce();await inside;
  const count=env.transport.exchanges.length,stopping=env.service.stop();release();await stopping;
  await new Promise(resolve=>setImmediate(resolve));assert.equal(await env.service.exchangeOnce(),false);
  assert.equal(env.transport.exchanges.length,count);assert.equal(env.transport.closed.length,1);assert.equal(env.fake.state.replacements.length,1);
});

test('immediate completion submission failure closes the lease without retrying the applied command',async()=>{
  const env=await setup();await env.service.start();await env.service.exchangeOnce();
  const id=crypto.randomUUID(),epoch=env.service.state.epoch,handle=env.service.state.issues[0].handle,exchange=env.transport.exchange.bind(env.transport);
  env.transport.exchange=async payload=>{const response=await exchange(payload);if(payload.result)throw Error('lost_result_ack');return response;};
  try{
    env.transport.commands.push({id,epoch,action:'apply',handle});await env.service.exchangeOnce();
    await settleUntil(()=>env.service.state.status==='failed');assert.equal(env.service.state.status,'failed');
    assert.equal(env.transport.exchanges.filter(payload=>payload.result?.commandID===id).length,1);
    const count=env.transport.exchanges.length;await env.service.exchangeOnce();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(env.transport.exchanges.length,count);assert.equal(env.transport.closed.length,1);assert.equal(env.fake.state.replacements.length,1);
  }finally{await env.service.stop();}
});

test('automatic spelling offers many candidates without any background Word preflight',async()=>{
  const text=Array(32).fill('resuts').join(' ')+'.',env=await setup({paragraphs:[{id:'many',text,pages:[1]}]});
  env.client.check=async snapshot=>({requestID:snapshot.requestID,snapshotHash:snapshot.snapshotHash,skillVersion:'local-1',status:'completed',issues:Array.from({length:32},(_,index)=>({id:`spell-${index}`,category:'spelling',original:'resuts',replacement:'results',reason:'Spelling',range:{start:index*7,length:6},requiresAuthorConfirmation:false}))});
  let calls=0;env.host.getIssueActions=async()=>{calls++;return {canApply:false,reason:'This Word preflight must never start automatically.'};};
  try{
    assert.equal(await env.service.start(),true);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls,0,'automatic marking must never enqueue a Word write preflight');assert.equal(env.service.state.status,'ready');
    assert.equal(env.service.state.issues.length,32);assert.ok(env.service.state.issues.every(item=>item.canApply===true&&item.reason===''));
    await settleUntil(()=>env.transport.exchanges.some(payload=>payload.state?.issues.length===32));
    assert.ok(env.transport.exchanges.some(payload=>payload.state?.active===true&&payload.state.status==='ready'&&payload.state.issues.length===32));assert.equal(env.fake.state.replacements.length,0);
  }finally{await env.service.stop();}
});

test('automatic spelling offers the first local result before a later paragraph spelling check finishes',async()=>{
  const env=await setup({paragraphs:[{id:'first',text:'The resuts are clear.',pages:[1]},{id:'second',text:'Other resuts are clear.',pages:[1]}]});
  let entered,release;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),check=env.client.check.bind(env.client);
  env.client.check=async(...args)=>{if(args[0].blockID==='second'){entered();await gate;}return check(...args);};const starting=env.service.start();await inside;
  try{
    assert.equal(env.service.state.status,'ready');assert.equal(env.service.state.issues.length,1);assert.equal(env.service.state.issues[0].canApply,true);assert.equal(env.service.state.issues[0].reason,'');
    const initial=env.service.state;assert.equal(initial.scope.snapshots.length,2,'the first marker already binds the complete captured scope');
    await settleUntil(()=>env.transport.exchanges.some(payload=>payload.state?.issues.length===1));assert.ok(env.transport.exchanges.some(payload=>payload.state?.issues.length===1));
    release();await starting;assert.equal(env.service.state.epoch,initial.epoch);assert.deepEqual(env.service.state.scope,initial.scope);assert.equal(env.service.state.issues[0].handle,initial.issues[0].handle);assert.equal(env.service.state.issues.length,2);
    assert.equal(env.fake.state.replacements.length,0);
  }finally{release();await starting;await env.service.stop();}
});

for(const rejected of [false,true])test(`apply priority lets an explicit ${rejected?'rejected':'completed'} edit run before later paragraphs and resumes them only after ACK`,async()=>{
  const env=await setup({paragraphs:[{id:'first',text:'The resuts are clear.',pages:[1]},{id:'second',text:'Second paragraph is clear.',pages:[1]},{id:'third',text:'Third resuts remain.',pages:[1]}]});
  const order=[];let entered,release,firstSecond=true,ackEntered,ackRelease,applyCalls=0;
  const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),ackInside=new Promise(resolve=>ackEntered=resolve),ackGate=new Promise(resolve=>ackRelease=resolve);
  const check=env.client.check.bind(env.client),apply=env.host.applyIssue.bind(env.host),exchange=env.transport.exchange.bind(env.transport);
  env.client.check=async(...args)=>{order.push(`check:${args[0].blockID}`);if(args[0].blockID==='second'&&firstSecond){firstSecond=false;entered();await gate;}return check(...args);};
  env.host.applyIssue=async envelope=>{applyCalls++;order.push('apply');return apply(envelope);};
  let commandID;env.transport.exchange=async payload=>{const response=await exchange(payload);if(commandID&&payload.result?.commandID===commandID){ackEntered();await ackGate;}return response;};
  const starting=env.service.start();await inside;
  try{
    const state=env.service.state,item=state.issues[0];assert.equal(state.scope.snapshots.length,3);assert.equal(item.canApply,true);
    await settleUntil(()=>env.transport.exchanges.some(payload=>payload.state?.issues.length===1));
    if(rejected)env.Office.context.document.mode='readOnly';
    commandID=crypto.randomUUID();env.transport.commands.push({id:commandID,epoch:state.epoch,action:'apply',handle:item.handle});
    assert.equal(await env.service.exchangeOnce(),true);assert.equal(env.transport.commands.length,0,'the command is delivered while the second local check is pending');
    release();await starting;await ackInside;
    assert.equal(order.includes('check:third'),false,'the queued user edit must not wait for the remaining paragraph scan');assert.equal(applyCalls,1);
    const report=env.transport.exchanges.find(payload=>payload.result?.commandID===commandID).result;
    assert.equal(report.status,rejected?'rejected':'completed');assert.equal(env.fake.state.replacements.length,rejected?0:1);
    const before=order.length;await env.service.pollOnce();assert.equal(order.length,before,'a pending result ACK cannot enqueue another automatic capture');
    ackRelease();await settleUntil(()=>order.includes('check:third'));
    assert.equal(order.includes('check:third'),true,'ACK must resume the unsurveyed paragraphs without a WebView timer');
    assert.ok(order.indexOf('apply')<order.indexOf('check:third'));assert.equal(applyCalls,1,'rechecking after rejection never retries a write');
    assert.equal(env.transport.exchanges.filter(payload=>payload.result?.commandID===commandID).length,1);
  }finally{release();ackRelease();await starting;await env.service.stop();}
});

test('apply arriving during a poll activity check prevents that background capture from starting',async()=>{
  const env=await setup();await env.service.start();await new Promise(resolve=>setImmediate(resolve));
  const run=env.host.run.bind(env.host),capture=env.host.captureScope.bind(env.host),apply=env.host.applyIssue.bind(env.host);
  let entered,release,first=true,captures=0,capturesAtApply;
  const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  env.host.run=async(...args)=>{const result=await run(...args);if(first){first=false;entered();await gate;}return result;};
  env.host.captureScope=async(...args)=>{captures++;return capture(...args);};
  env.host.applyIssue=async envelope=>{capturesAtApply=captures;return apply(envelope);};
  const pending=env.service.pollOnce();await inside;
  const item=env.service.state.issues[0],id=crypto.randomUUID();env.transport.commands.push({id,epoch:env.service.state.epoch,action:'apply',handle:item.handle});
  try{
    await env.service.exchangeOnce();release();await pending;
    await settleUntil(()=>env.transport.exchanges.some(payload=>payload.result?.commandID===id));
    const report=env.transport.exchanges.find(payload=>payload.result?.commandID===id).result;
    assert.equal(report.code,'applied');assert.equal(capturesAtApply,0,'the delivered apply owns the next Word operation');assert.equal(env.fake.state.replacements.length,1);
  }finally{release();await pending;await env.service.stop();}
});

test('apply waits for an in-flight capture but skips the abandoned poll activity sync afterward',async()=>{
  const env=await setup();await env.service.start();await new Promise(resolve=>setImmediate(resolve));
  const capture=env.host.captureScope.bind(env.host),apply=env.host.applyIssue.bind(env.host);
  let entered,release,first=true,activeAtReturn=0,activeAtApply=0,writes=0;
  const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  env.host.captureScope=async mode=>{const scope=await capture(mode);if(first){first=false;entered();await gate;activeAtReturn=env.fake.state.activeLoads;}return scope;};
  env.host.applyIssue=async envelope=>{writes++;activeAtApply=env.fake.state.activeLoads;return apply(envelope);};
  const pending=env.service.pollOnce();await inside;
  const item=env.service.state.issues[0],id=crypto.randomUUID();env.transport.commands.push({id,epoch:env.service.state.epoch,action:'apply',handle:item.handle});
  try{
    await env.service.exchangeOnce();assert.equal(writes,0,'an actual in-flight Word batch is never run concurrently with a write');
    release();await pending;await settleUntil(()=>env.transport.exchanges.some(payload=>payload.result?.commandID===id));
    assert.equal(activeAtApply-activeAtReturn,1,'only the final explicit-command activity guard remains');assert.equal(writes,1);assert.equal(env.fake.state.replacements.length,1);
  }finally{release();await pending;await env.service.stop();}
});

test('apply aborts only the current readonly spelling check without expiring its target and refills only after ACK',async()=>{
  const env=await setup({paragraphs:[{id:'first',text:'The resuts are clear.',pages:[1]},{id:'second',text:'Second paragraph is clear.',pages:[1]}]});
  const check=env.client.check.bind(env.client),apply=env.host.applyIssue.bind(env.host),exchange=env.transport.exchange.bind(env.transport),capture=env.host.captureScope.bind(env.host);
  let entered,release,ackEntered,ackRelease,first=true,aborted=false,abortEpoch,requestID,commandID,writes=0,captures=0;
  const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),ackInside=new Promise(resolve=>ackEntered=resolve),ackGate=new Promise(resolve=>ackRelease=resolve);
  env.client.check=async(...args)=>{
    if(first&&args[0].blockID==='second'){
      first=false;requestID=args[0].requestID;entered();
      await Promise.race([gate,new Promise((_,reject)=>args[3].signal.addEventListener('abort',()=>{aborted=true;abortEpoch=env.service.state.epoch;reject(new DOMException('Aborted','AbortError'));},{once:true}))]);
    }
    return check(...args);
  };
  env.host.captureScope=async(...args)=>{captures++;return capture(...args);};
  env.host.applyIssue=async envelope=>{writes++;return apply(envelope);};
  env.transport.exchange=async payload=>{const response=await exchange(payload);if(commandID&&payload.result?.commandID===commandID){ackEntered();await ackGate;}return response;};
  const starting=env.service.start();await inside;
  try{
    const state=env.service.state,item=state.issues[0];await settleUntil(()=>env.transport.exchanges.some(payload=>payload.state?.issues.length===1));
    commandID=crypto.randomUUID();env.transport.commands.push({id:commandID,epoch:state.epoch,action:'apply',handle:item.handle});await env.service.exchangeOnce();
    await settleUntil(()=>writes>0);
    assert.equal(aborted,true,'a delivered apply cancels the pending local check instead of waiting for it');assert.equal(abortEpoch,state.epoch,'yield must not invalidate the accepted handle or epoch');
    assert.deepEqual(env.client.cancelled,[requestID]);assert.equal(writes,1);await ackInside;
    const before=captures;await env.service.pollOnce();assert.equal(captures,before,'no automatic refill may run before the result is acknowledged');
    ackRelease();await starting;await settleUntil(()=>captures>before);assert.ok(captures>before);assert.equal(writes,1);assert.equal(env.fake.state.replacements.length,1);
    assert.equal(env.transport.exchanges.filter(payload=>payload.result?.commandID===commandID).length,1);
  }finally{release();ackRelease();await starting;await env.service.stop();}
});

for(const conflict of ['paragraph','visibility','profile','lease'])test(`yielded apply still rejects a competing ${conflict} change before any Word write`,async()=>{
  const env=await setup();await env.service.start();await new Promise(resolve=>setImmediate(resolve));
  const capture=env.host.captureScope.bind(env.host),apply=env.host.applyIssue.bind(env.host);
  let entered,release,first=true,writes=0;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  env.host.captureScope=async mode=>{const scope=await capture(mode);if(first){first=false;entered();await gate;}return scope;};
  env.host.applyIssue=async envelope=>{writes++;return apply(envelope);};
  const pending=env.service.pollOnce();await inside;
  const item=env.service.state.issues[0],id=crypto.randomUUID();env.transport.commands.push({id,epoch:env.service.state.epoch,action:'apply',handle:item.handle});
  let hidden;
  try{
    await env.service.exchangeOnce();
    if(conflict==='paragraph')await env.fake.emit('onParagraphChanged');
    if(conflict==='visibility')await env.emitVisibility('Taskpane');
    if(conflict==='profile'){await env.emitVisibility('Taskpane');env.fallback.profile.spellingVariant='en-GB';hidden=env.emitVisibility('Hidden');}
    if(conflict==='lease'){env.transport.exchange=async()=>{throw Error('Closed lease');};await env.service.exchangeOnce();}
    release();await pending;if(hidden)await hidden;await settleUntil(()=>env.transport.exchanges.some(payload=>payload.result?.commandID===id)||env.service.state.status==='failed');
    assert.equal(writes,0);assert.equal(env.fake.state.replacements.length,0);
    const report=env.transport.exchanges.find(payload=>payload.result?.commandID===id)?.result;if(report)assert.notEqual(report.status,'completed');
  }finally{release();await pending;if(hidden)await hidden;await env.service.stop();}
});

test('apply timing separates queue real Word commit and result readiness without optimistic completion',async()=>{
  let now=1000;const env=await setup({clock:()=>now});await env.service.start();await new Promise(resolve=>setImmediate(resolve));
  const capture=env.host.captureScope.bind(env.host),apply=env.host.applyIssue.bind(env.host);
  let entered,release,committed,hostRelease,first=true;
  const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),didCommit=new Promise(resolve=>committed=resolve),hostGate=new Promise(resolve=>hostRelease=resolve);
  env.host.captureScope=async mode=>{const scope=await capture(mode);if(first){first=false;entered();await gate;}return scope;};
  env.host.applyIssue=async(envelope,options)=>{
    await apply(envelope,{onCommit(){now=1030;options?.onCommit?.();committed();}});
    now=1090;await hostGate;
  };
  const pending=env.service.pollOnce();await inside;
  const item=env.service.state.issues[0],id=crypto.randomUUID();env.transport.commands.push({id,epoch:env.service.state.epoch,action:'apply',handle:item.handle});
  try{
    await env.service.exchangeOnce();now=1010;release();await pending;await didCommit;
    assert.equal(env.fake.state.replacements.length,1,'the commit hook follows a real verified Word insert');
    assert.equal(env.transport.exchanges.some(payload=>payload.result?.commandID===id),false,'commit telemetry cannot declare a command completed');
    hostRelease();await settleUntil(()=>env.transport.exchanges.some(payload=>payload.result?.commandID===id));
    const report=env.transport.exchanges.find(payload=>payload.result?.commandID===id).result;
    assert.equal(report.code,'applied');assert.deepEqual(report.timing,{queueMilliseconds:10,editMilliseconds:30,resultMilliseconds:90});
    assert.equal(env.fake.state.replacements.length,1);
  }finally{release();hostRelease();await pending;await env.service.stop();}
});

test('apply timing is omitted when no real Word commit hook was received',async()=>{
  let now=100;const env=await setup({clock:()=>now++});await env.service.start();
  const apply=env.host.applyIssue.bind(env.host);env.host.applyIssue=async envelope=>apply(envelope);
  try{const result=await command(env,'apply',{handle:env.service.state.issues[0].handle});assert.equal(result.code,'applied');assert.equal(Object.hasOwn(result,'timing'),false);assert.equal(env.fake.state.replacements.length,1);}
  finally{await env.service.stop();}
});

test('apply timing rejects invalid clocks without changing a single authoritative write outcome',async()=>{
  const cases=[()=>NaN,()=>-1,()=>{throw Error('private clock failure');},[100,99,120,130],[100,110,120,115],[100,110,60101,60102]];
  for(const value of cases){
    let index=0;const clock=typeof value==='function'?value:()=>value[index++];
    const env=await setup({clock});await env.service.start();
    try{const result=await command(env,'apply',{handle:env.service.state.issues[0].handle});assert.equal(result.code,'applied');assert.equal(Object.hasOwn(result,'timing'),false);assert.equal(env.fake.state.replacements.length,1);}
    finally{await env.service.stop();}
  }
});

test('explicit apply performs one service activity sync immediately before authoritative host validation',async()=>{
  const env=await setup();await env.service.start();await new Promise(resolve=>setImmediate(resolve));
  const initial=env.fake.state.activeLoads,apply=env.host.applyIssue.bind(env.host);let activityAtHost=0,calls=0;
  env.host.applyIssue=async(...args)=>{calls++;activityAtHost=env.fake.state.activeLoads-initial;return apply(...args);};
  try{const result=await command(env,'apply',{handle:env.service.state.issues[0].handle});assert.equal(result.code,'applied');assert.equal(activityAtHost,1);assert.equal(calls,1);assert.equal(env.fake.state.replacements.length,1);}
  finally{await env.service.stop();}
});

test('the single apply activity guard still rejects inactive paused and stale commands before host writes',async()=>{
  for(const kind of ['inactive','paused','stale']){
    const env=await setup();await env.service.start();await new Promise(resolve=>setImmediate(resolve));const item=env.service.state.issues[0];
    if(kind==='inactive')env.fake.state.windowActive=false;
    if(kind==='paused')await command(env,'pause');
    let calls=0;env.host.applyIssue=async()=>{calls++;};
    try{const result=await command(env,'apply',{handle:item.handle,...(kind==='stale'?{epoch:0}:{})});assert.equal(result.status,'rejected',kind);assert.equal(calls,0,kind);assert.equal(env.fake.state.replacements.length,0,kind);}
    finally{await env.service.stop();}
  }
});

test('automatic spelling invalidates a shown candidate immediately when new input arrives',async()=>{
  const env=await setup();let calls=0;env.host.getIssueActions=async()=>{calls++;return {canApply:false,reason:'No automatic preflight.'};};
  try{
    await env.service.start();const old=env.service.state.issues[0],epoch=env.service.state.epoch;assert.equal(old.canApply,true);
    env.fake.document.paragraphs[0].text='The results are clear.';await env.fake.emit('onParagraphChanged');
    assert.equal(env.service.state.issues.length,0);assert.ok(env.service.state.epoch>epoch);
    await settleUntil(()=>env.service.state.scope?.snapshots[0]?.rawText==='The results are clear.');
    assert.equal(env.service.state.scope?.snapshots[0]?.rawText,'The results are clear.');assert.equal(env.service.state.issues.some(item=>item.handle===old.handle),false);
    assert.equal(calls,0);assert.equal(env.fake.state.replacements.length,0);
  }finally{await env.service.stop();}
});

test('early spelling input invalidation discards a completed old capture before any local result can publish',async()=>{
  const env=await setup();let entered,release,first=true;
  const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),capture=env.host.captureScope.bind(env.host);
  env.host.captureScope=async mode=>{const scope=await capture(mode);if(first){first=false;entered();await gate;}return scope;};
  const starting=env.service.start();await inside;
  try{
    env.fake.document.paragraphs[0].text='The results are clear.';await env.fake.emit('onParagraphChanged');release();await starting;
    await settleUntil(()=>env.service.state.scope?.snapshots[0]?.rawText==='The results are clear.');
    assert.equal(env.service.state.scope?.snapshots[0]?.rawText,'The results are clear.');
    assert.ok(env.checks.every(check=>check.snapshot.rawText==='The results are clear.'),'invalidated capture must not reach the local checker');
    assert.ok(env.transport.exchanges.every(payload=>!payload.state?.issues.length),'old markers cannot be briefly republished');
    assert.equal(env.fake.state.replacements.length,0);
  }finally{release();await starting;await env.service.stop();}
});

test('early spelling input invalidation schedules a fresh capture when the old local check exits without advancing timers',async()=>{
  const env=await setup();let entered,release,first=true;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),check=env.client.check.bind(env.client);
  env.client.check=async(...args)=>{const result=await check(...args);if(first){first=false;entered();await gate;}return result;};const starting=env.service.start();await inside;
  try{
    env.fake.document.paragraphs[0].text='The results are clear.';await env.fake.emit('onParagraphChanged');release();await starting;
    await settleUntil(()=>env.service.state.scope?.snapshots[0]?.rawText==='The results are clear.');
    assert.equal(env.service.state.scope?.snapshots[0]?.rawText,'The results are clear.');assert.equal(env.service.state.issues.length,0);assert.ok(env.checks.length>=2);assert.equal(env.fake.state.replacements.length,0);
  }finally{release();await starting;await env.service.stop();}
});

test('automatic spelling keeps protected ranges unchanged suggestions and custom terms read-only',async()=>{
  for(const kind of ['protected','noop','term','partialTerm']){
    const env=await setup();let calls=0;env.host.getIssueActions=async()=>{calls++;return {canApply:true,reason:''};};
    const capture=env.host.captureScope.bind(env.host);env.host.captureScope=async mode=>{const scope=await capture(mode);if(kind==='protected')scope.snapshots[0].protectedRanges=[{start:4,length:6}];return scope;};
    if(kind==='noop'){const check=env.client.check.bind(env.client);env.client.check=async(...args)=>{const result=await check(...args);result.issues[0].replacement=result.issues[0].original;return result;};}
    if(kind==='term'||kind==='partialTerm')env.fallback.profile.customTerms=[kind==='term'?'resuts':'sut'];
    try{
      await env.service.start();const item=env.service.state.issues[0];assert.equal(item.canApply,false,kind);assert.ok(item.reason.length>0&&/[\u4e00-\u9fff]/.test(item.reason),kind);
      const result=await command(env,'apply',{handle:item.handle});assert.equal(result.code,'preview_only',kind);assert.equal(calls,0,kind);assert.equal(env.fake.state.replacements.length,0,kind);
    }finally{await env.service.stop();}
  }
});

test('automatic spelling refuses static edits that break graphemes protected mappings or paragraph boundaries',async()=>{
  for(const kind of ['combining','protectedMapping','control']){
    const text=kind==='protectedMapping'?'a\u0000\u0301':kind==='combining'?'a resuts':'resuts',env=await setup({paragraphs:[{text,pages:[1]}]});let calls=0;
    env.host.getIssueActions=async()=>{calls++;return {canApply:true,reason:''};};
    const capture=env.host.captureScope.bind(env.host);env.host.captureScope=async mode=>{const scope=await capture(mode);if(kind==='protectedMapping')scope.snapshots[0].protectedRanges=[{start:2,length:1}];return scope;};
    env.client.check=async snapshot=>({requestID:snapshot.requestID,snapshotHash:snapshot.snapshotHash,skillVersion:'local-1',status:'completed',issues:[{id:'static',category:'spelling',original:kind==='protectedMapping'?'\u0000':kind==='combining'?' resuts':'resuts',replacement:kind==='combining'?'\u0301':kind==='control'?'results\n': '',reason:'Spelling',range:kind==='protectedMapping'?{start:1,length:1}:kind==='combining'?{start:1,length:7}:{start:0,length:6},requiresAuthorConfirmation:false}]});
    try{await env.service.start();const item=env.service.state.issues[0];assert.equal(item.canApply,false,kind);assert.ok(item.reason.length>0,kind);assert.equal(calls,0,kind);assert.equal((await command(env,'apply',{handle:item.handle})).code,'preview_only');assert.equal(env.fake.state.replacements.length,0);}
    finally{await env.service.stop();}
  }
});

test('early spelling marks reject malformed local envelopes before publishing any candidate',async()=>{
  const env=await setup();let qualifications=0;
  env.client.check=async snapshot=>({requestID:snapshot.requestID,snapshotHash:snapshot.snapshotHash,skillVersion:'local-1',status:'completed',issues:[{id:'bad',category:'spelling',original:'wrong',replacement:'results',reason:'Spelling',range:{start:4,length:5},requiresAuthorConfirmation:false}]});
  env.host.getIssueActions=async()=>{qualifications++;return {canApply:true,reason:''};};
  try{await env.service.start();assert.equal(env.service.state.issues.length,0);assert.notEqual(env.service.state.status,'ready');assert.equal(qualifications,0);assert.ok(env.transport.exchanges.every(payload=>!payload.state?.issues.length));assert.equal(env.fake.state.replacements.length,0);}
  finally{await env.service.stop();}
});

test('automatic spelling local completion after stop cannot publish or start Word verification',async()=>{
  const env=await setup();let entered,release,calls=0;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),check=env.client.check.bind(env.client);
  env.host.getIssueActions=async()=>{calls++;return {canApply:true,reason:''};};env.client.check=async(...args)=>{const result=await check(...args);entered();await gate;return result;};
  const starting=env.service.start();await inside;const stopping=env.service.stop(),count=env.transport.exchanges.length;release();await starting;await stopping;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(env.service.state.issues.length,0);assert.equal(env.service.state.active,false);assert.equal(env.transport.exchanges.length,count);assert.equal(calls,0);assert.equal(env.fake.state.replacements.length,0);
});

test('hidden shared runtime checks spelling locally and publishes exact opaque issue handles',async()=>{
  const env=await setup();assert.equal(await env.service.start(),true);
  assert.equal(env.transport.registrations.length,1);
  assert.deepEqual(env.transport.registrations[0].capabilities,{sharedRuntime:true,activeWindow:true,hiddenRuntime:true,safeReplace:true});
  assert.equal(env.service.state.visibility,'Hidden');assert.equal(env.service.state.active,true);assert.equal(env.service.state.status,'ready');
  assert.equal(env.service.state.issues[0].envelope.issue.original,'resuts');assert.match(env.service.state.issues[0].handle,/^[A-Za-z0-9_-]{16,128}$/);
  assert.ok(env.checks.length);assert.ok(env.checks.every(check=>check.mode==='spelling'));assert.ok(env.fake.state.activeLoads>=2);
  assert.equal(env.fallback.pauses,1);assert.equal(env.fake.state.replacements.length,0);await env.service.stop();
});

test('missing shared runtime or active-window proof preserves sidebar without registering or reading text',async()=>{
  for(const options of [{support:{WordApi:'1.8',WordApiDesktop:'1.4'}},{support:{WordApi:'1.8',WordApiDesktop:'1.2',SharedRuntime:'1.1'}},{activeFailure:true},{windowActive:false}]){
    const env=await setup(options);assert.equal(await env.service.start(),false);assert.equal(env.transport.registrations.length,0);assert.equal(env.checks.length,0);assert.equal(env.fake.state.viewportReads,0);assert.equal(env.fake.state.replacements.length,0);await env.service.stop();
  }
});

test('hide rejection restores usable sidebar and never claims a hidden runtime',async()=>{
  const env=await setup({hideFailure:true});assert.equal(await env.service.start(),false);assert.equal(env.transport.registrations.length,0);assert.ok(env.fallback.resumes>=1);assert.equal(env.service.state.status,'preview');await env.service.stop();
});

test('activity capability failures remain distinguishable from shared runtime failures',async()=>{
  for(const options of [{activeFailure:true},{support:{WordApi:'1.8',WordApiDesktop:'1.2',SharedRuntime:'1.1'}}]){const env=await setup(options);assert.equal(await env.service.start(),false);assert.equal(env.service.state.errorCode,'active_window_unavailable');await env.service.stop();}
});

test('poll remains live while browser document is hidden and notices changed visible text',async()=>{
  const env=await setup();await env.service.start();const epoch=env.service.state.epoch;
  const previous=global.document;global.document={visibilityState:'hidden'};
  try{env.fake.document.paragraphs[0].text='The results are clear.';await env.service.pollOnce();assert.ok(env.service.state.epoch>epoch);assert.equal(env.service.state.issues.length,0);assert.ok(env.checks.length>=2);}finally{global.document=previous;await env.service.stop();}
});

test('inactive document clears markers and refuses capture and replacement before Word writes',async()=>{
  const env=await setup();await env.service.start();const handle=env.service.state.issues[0].handle;env.fake.state.windowActive=false;
  const result=await command(env,'apply',{handle});assert.equal(result.status,'rejected');assert.ok(['document_inactive','stale_epoch'].includes(result.code));assert.equal(env.fake.state.replacements.length,0);assert.equal(env.service.state.issues.length,0);await env.service.stop();
});

test('apply performs one verified minimal Word range replacement and invalidates old handles',async()=>{
  const env=await setup();await env.service.start();const handle=env.service.state.issues[0].handle;const epoch=env.service.state.epoch;
  const result=await command(env,'apply',{handle});assert.equal(result.status,'completed');assert.equal(result.code,'applied');assert.deepEqual(env.fake.state.replacements,[{id:'p0',start:7,end:8,text:'ul'}]);assert.ok(env.service.state.epoch>epoch);
  const again=await command(env,'apply',{handle});assert.equal(again.status,'rejected');assert.equal(env.fake.state.replacements.length,1);await env.service.stop();
});

test('explicit apply alone performs exactly one authoritative Word validation and replacement',async()=>{
  const env=await setup(),actions=env.host.getIssueActions.bind(env.host),verify=env.host.verifiedRange.bind(env.host);let actionPreflights=0,writeValidations=0;
  env.host.getIssueActions=async(...args)=>{actionPreflights++;return actions(...args);};env.host.verifiedRange=async(...args)=>{if(args[2]===true)writeValidations++;return verify(...args);};
  await env.service.start();const handle=env.service.state.issues[0].handle;assert.equal(actionPreflights,0);assert.equal(writeValidations,0);
  const result=await command(env,'apply',{handle});
  try{assert.equal(result.code,'applied');assert.equal(actionPreflights,0);assert.equal(writeValidations,1);assert.deepEqual(env.fake.state.replacements,[{id:'p0',start:7,end:8,text:'ul'}]);}
  finally{await env.service.stop();}
});

test('authoritative apply rechecks real Word read-only fields source context and formatting after a writable suggestion was prepared',async()=>{
  for(const change of ['readOnly','field','source','context','format','control']){
    const env=await setup({paragraphs:[{text:'The resuts are clear.',pages:[1]},{text:'Neighbor.',pages:[2]}]});await env.service.start();const item=env.service.state.issues[0],paragraph=env.fake.document.paragraphs[0];assert.equal(item.canApply,true,change);
    if(change==='readOnly')env.Office.context.document.mode='readOnly';
    if(change==='field')paragraph.fieldRanges=[{start:4,length:6}];
    if(change==='source')paragraph.text='A different sentence.';
    if(change==='context')env.fake.document.paragraphs[1].text='Changed neighbor.';
    if(change==='format')paragraph.runs=[{start:0,end:paragraph.text.length,properties:'<w:vertAlign w:val="superscript"/>'}];
    if(change==='control')paragraph.parentControl=true;
    const apply=env.host.applyIssue.bind(env.host);let authoritativeCalls=0;env.host.applyIssue=async envelope=>{authoritativeCalls++;return apply(envelope);};
    const result=await command(env,'apply',{handle:item.handle});
    try{assert.equal(result.status,'rejected',change);assert.equal(authoritativeCalls,1,change);assert.equal(env.fake.state.replacements.length,0,change);}
    finally{await env.service.stop();}
  }
});

test('an explicitly prepared GPT preview remains read-only after its live formatting becomes plain',async()=>{
  const env=await setup({selection:[4,10],paragraphs:[{text:'The resuts are clear.',pages:[1],runs:[{start:0,end:21,properties:'<w:vertAlign w:val="superscript"/>'}]}]});await env.service.start();
  const capture=await command(env,'captureSelection'),snapshot=capture.scope.snapshots[0],issue={id:'preview-polish',category:'expression',original:'resuts',replacement:'results',reason:'Spelling',range:{start:4,length:6},requiresAuthorConfirmation:true};
  const prepared=await command(env,'prepareSuggestions',{snapshotRequestID:snapshot.requestID,issues:[issue]}),item=prepared.prepared[0];assert.equal(item.canApply,false);
  delete env.fake.document.paragraphs[0].runs;const apply=env.host.applyIssue.bind(env.host);let calls=0;env.host.applyIssue=async envelope=>{calls++;return apply(envelope);};
  const result=await command(env,'apply',{handle:item.handle});
  try{assert.equal(result.status,'rejected');assert.equal(result.code,'preview_only');assert.equal(calls,0);assert.equal(env.fake.state.replacements.length,0);}
  finally{await env.service.stop();}
});

test('stale epoch, unknown handle and mutated paragraph never write',async()=>{
  for(const kind of ['epoch','handle','text']){
    const env=await setup();await env.service.start();const item=env.service.state.issues[0];
    if(kind==='text')env.fake.document.paragraphs[0].text='A different sentence.';
    const result=await command(env,'apply',{handle:kind==='handle'?'unknown-0123456789abcdef':item.handle,...(kind==='epoch'?{epoch:0}:{})});
    assert.notEqual(result.status,'completed');assert.equal(env.fake.state.replacements.length,0);await env.service.stop();
  }
});

test('unsupported live formatting is rejected only by the explicit authoritative Word write gate',async()=>{
  const env=await setup({paragraphs:[{text:'The resuts are clear.',pages:[1],runs:[{start:0,end:8,properties:'<w:vertAlign w:val="superscript"/>'},{start:8,end:21}]}]});let calls=0;const apply=env.host.applyIssue.bind(env.host);env.host.applyIssue=async envelope=>{calls++;return apply(envelope);};
  try{await env.service.start();const issue=env.service.state.issues[0];assert.equal(issue.canApply,true);assert.equal(env.fake.state.replacements.length,0);const result=await command(env,'apply',{handle:issue.handle});assert.equal(result.status,'rejected');assert.equal(calls,1);assert.equal(env.fake.state.replacements.length,0);}
  finally{await env.service.stop();}
});

test('capture selection returns raw bounded context without any GPT request',async()=>{
  const env=await setup({selection:[4,10]});await env.service.start();const before=env.checks.length;
  const result=await command(env,'captureSelection');assert.equal(result.status,'completed');assert.equal(result.scope.scope,'selection');assert.deepEqual(result.scope.snapshots[0].targetRange,{start:4,length:6});assert.equal(env.checks.length,before);await env.service.stop();
});

test('prepared polishing suggestions use private captured snapshots and fresh safe preflight',async()=>{
  const env=await setup({selection:[4,10]});await env.service.start();const selected=await command(env,'captureSelection');const snapshot=selected.scope.snapshots[0];
  const issue={id:'polish-1',category:'expression',original:'resuts',replacement:'results',reason:'Correct spelling',range:{start:4,length:6},requiresAuthorConfirmation:true};
  const prepared=await command(env,'prepareSuggestions',{snapshotRequestID:snapshot.requestID,issues:[issue]});assert.equal(prepared.status,'completed');assert.equal(prepared.prepared[0].envelope.snapshot.requestID,snapshot.requestID);assert.equal(prepared.prepared[0].canApply,true);
  const result=await command(env,'apply',{handle:prepared.prepared[0].handle});assert.equal(result.status,'completed');assert.equal(env.fake.document.paragraphs[0].text,'The results are clear.');await env.service.stop();
});

test('forged, outside-selection and expired polishing input cannot become a writable handle',async()=>{
  for(const kind of ['snapshot','outside','source']){
    const env=await setup({selection:[4,10]});await env.service.start();const selected=await command(env,'captureSelection'),snapshot=selected.scope.snapshots[0];
    const issue={id:'p',category:'expression',original:kind==='source'?'wrong':'The',replacement:'A',reason:'test',range:kind==='source'?{start:4,length:5}:{start:0,length:3},requiresAuthorConfirmation:true};
    const result=await command(env,'prepareSuggestions',{snapshotRequestID:kind==='snapshot'?'forged':snapshot.requestID,issues:[issue]});assert.equal(result.status,'rejected');assert.equal(env.fake.state.replacements.length,0);await env.service.stop();
  }
});

for(const failure of ['inactive','unavailable'])test(`Hidden activity recovery retries a transient ${failure} window using the existing interval`,async()=>{
  const options={},env=await setup(options);await env.service.start();await env.emitVisibility('Taskpane');
  const beforeChecks=env.checks.length;let captures=0;const capture=env.host.captureScope.bind(env.host);
  env.host.captureScope=async(...args)=>{captures++;assert.equal(env.fake.state.windowActive,true);assert.equal(options.activeFailure===true,false);return capture(...args);};
  env.fallback.profile={spellingVariant:'en-GB',style:'clarity',customTerms:['fish']};
  if(failure==='inactive')env.fake.state.windowActive=false;else options.activeFailure=true;
  try{
    await env.emitVisibility('Hidden');assert.equal(env.service.state.active,false);assert.equal(env.service.state.visibility,'Hidden');assert.equal(env.service.state.scope,null);assert.equal(env.service.state.issues.length,0);
    assert.equal(captures,0);assert.equal(env.checks.length,beforeChecks,'no source or local check is allowed before real activity');
    const callbacks=[...env.timers.intervals.values()];assert.equal(callbacks.length,1,'the Hidden enabled intent must retain one retry watcher after activity failure');
    env.fake.state.windowActive=true;options.activeFailure=false;callbacks[0]();
    await settleUntil(()=>env.service.state.active&&env.service.state.status==='ready');
    assert.equal(env.service.state.active,true);assert.equal(env.service.state.status,'ready');assert.ok(captures>0);assert.ok(env.checks.length>beforeChecks);
    assert.deepEqual(env.checks.at(-1).profile,env.fallback.profile);assert.equal(env.fake.state.replacements.length,0);
  }finally{options.activeFailure=false;env.fake.state.windowActive=true;await env.service.stop();}
});

test('showing fallback sidebar pauses inline checks; hiding resumes the same document service',async()=>{
  const env=await setup();await env.service.start();const session=env.transport.registrations[0].documentSessionID;
  await env.emitVisibility('Taskpane');assert.equal(env.service.state.status,'paused');assert.equal(env.service.state.issues.length,0);const checks=env.checks.length;await env.service.pollOnce();assert.equal(env.checks.length,checks);
  await env.emitVisibility('Hidden');assert.equal(env.service.state.status,'ready');assert.equal(env.transport.registrations[0].documentSessionID,session);assert.equal(env.transport.registrations.length,1);assert.ok(env.fallback.resumes>=1);await env.service.stop();
});

test('Taskpane heartbeats do not claim an active hidden document after its Word window becomes inactive',async()=>{
  const env=await setup();await env.service.start();const epoch=env.service.state.epoch;
  await env.emitVisibility('Taskpane');env.fake.state.windowActive=false;const checks=env.checks.length;
  await env.service.pollOnce();await env.service.exchangeOnce();const state=env.transport.exchanges.at(-1).state;
  assert.equal(state.visibility,'Taskpane');assert.equal(state.active,false);assert.equal(state.status,'paused');assert.ok(state.epoch>epoch);assert.equal(env.checks.length,checks);await env.service.stop();
});

test('Taskpane shown while registration awaits closes the new lease and returns a usable fallback instead of ready',async()=>{
  const env=await setup();let entered,release;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),register=env.transport.register.bind(env.transport);
  env.transport.register=async payload=>{entered();await gate;return register(payload);};
  const starting=env.service.start();await inside;await env.emitVisibility('Taskpane');release();
  assert.equal(await starting,false);assert.equal(env.service.state.visibility,'Taskpane');assert.equal(env.service.state.active,false);assert.equal(env.service.state.status,'preview');assert.equal(env.service.state.errorCode,'hidden_runtime_unverified');
  assert.equal(env.checks.length,0);assert.equal(env.timers.intervals.size,0);assert.equal(env.transport.registrations.length,1);assert.equal(env.transport.closed.length,1);assert.ok(env.fallback.resumes>=1);await env.service.stop();assert.equal(env.transport.closed.length,1);
});

test('a poll awaiting Word capture cannot restore active or ready state after Taskpane appears',async()=>{
  const env=await setup();await env.service.start();let entered,release;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),capture=env.host.captureScope.bind(env.host);
  env.host.captureScope=async mode=>{entered();await gate;return capture(mode);};
  const pending=env.service.pollOnce();await inside;await env.emitVisibility('Taskpane');release();await pending;await env.service.exchangeOnce();
  const state=env.transport.exchanges.at(-1).state;assert.equal(state.active,false);assert.equal(state.status,'paused');assert.equal(state.scope,null);assert.equal(state.issues.length,0);assert.equal(env.timers.intervals.size,0);await env.service.stop();
});

test('document identity change rejects old commands even if visible words match',async()=>{
  const env=await setup();await env.service.start();const handle=env.service.state.issues[0].handle;env.fake.switchDocument([{text:'The resuts are clear.',pages:[1]}]);
  const result=await command(env,'apply',{handle});assert.notEqual(result.status,'completed');assert.equal(env.fake.state.replacements.length,0);await env.service.stop();
});

test('exchange failure terminates lease without retrying or applying an unacknowledged command',async()=>{
  const env=await setup({exchangeFailure:true});await env.service.start();assert.equal(await env.service.exchangeOnce(),false);assert.equal(env.transport.exchanges.length,1);assert.equal(env.service.state.status,'failed');assert.equal(env.service.state.issues.length,0);assert.equal(env.fake.state.replacements.length,0);await env.service.exchangeOnce();assert.equal(env.transport.exchanges.length,1);await env.service.stop();
});

test('stopping removes listeners, timers and retained source state',async()=>{
  const env=await setup();await env.service.start();await env.service.stop();assert.equal(env.service.state.scope,null);assert.equal(env.service.state.issues.length,0);assert.equal(env.timers.intervals.size,0);assert.equal(env.timers.timeouts.size,0);assert.ok(Object.values(env.fake.state.handlers).every(set=>set.size===0));assert.equal(env.fake.state.tracked.size,0);assert.equal(env.transport.closed.length,1);await env.service.pollOnce();assert.equal(env.fake.state.replacements.length,0);
});

test('paragraph invalidation during asynchronous preflight prevents the old explicit apply',async()=>{
  const env=await setup();await env.service.start();const item=env.service.state.issues[0];
  const run=env.host.run.bind(env.host);let invalidated=false;env.host.run=async(...args)=>{const result=await run(...args);if(!invalidated){invalidated=true;await env.fake.emit('onParagraphChanged');}return result;};
  const result=await command(env,'apply',{handle:item.handle});assert.equal(result.status,'rejected');assert.equal(env.fake.state.replacements.length,0);await env.service.stop();
});

test('explicit pause survives a later hide event and resumes only on the resume command',async()=>{
  const env=await setup();await env.service.start();assert.equal((await command(env,'pause')).status,'completed');
  await env.emitVisibility('Taskpane');assert.equal(env.service.state.active,false);const pausedEpoch=env.service.state.epoch;await env.emitVisibility('Hidden');assert.equal(env.service.state.status,'paused');assert.equal(env.service.state.active,true);assert.ok(env.service.state.epoch>pausedEpoch);assert.equal(env.timers.intervals.size,0);const checks=env.checks.length;await env.service.pollOnce();assert.equal(env.checks.length,checks);
  assert.equal((await command(env,'resume')).status,'completed');assert.equal(env.service.state.status,'ready');await env.service.stop();
});

test('new capture request identifiers do not invalidate a pending selected-sentence review',async()=>{
  const env=await setup({selection:[4,10]});await env.service.start();const captured=await command(env,'captureSelection'),snapshot=captured.scope.snapshots[0],epoch=env.service.state.epoch;
  await env.service.pollOnce();await env.service.pollOnce();assert.equal(env.service.state.epoch,epoch);
  const result=await command(env,'prepareSuggestions',{snapshotRequestID:snapshot.requestID,issues:[{id:'p',category:'expression',original:'resuts',replacement:'results',reason:'Spelling',range:{start:4,length:6},requiresAuthorConfirmation:true}]});assert.equal(result.status,'completed');await env.service.stop();
});

test('returning from sidebar picks up the current British spelling profile and dictionary',async()=>{
  const env=await setup();await env.service.start();await env.emitVisibility('Taskpane');
  env.fallback.profile={spellingVariant:'en-GB',style:'clarity',customTerms:['resuts']};await env.emitVisibility('Hidden');
  assert.deepEqual(env.checks.at(-1).profile,{spellingVariant:'en-GB',style:'clarity',customTerms:['resuts']});assert.deepEqual(env.service.state.profile,{spellingVariant:'en-GB',style:'clarity',customTerms:['resuts']});await env.service.stop();
});

test('native transport keeps bootstrap and document jobs on the authenticated HTTPS origin',async()=>{
  const {NativeDocumentTransport}=await load('../word/native-document-service.js');const calls=[];
  const transport=new NativeDocumentTransport({origin:'https://localhost:43793',fetch:async(url,request)=>{calls.push({url,request});return {ok:true,json:async()=>url.endsWith('/bootstrap')?{baseURL:'https://localhost:43793',token:'a'.repeat(64),skillVersion:'1.0.1'}:{leaseID:'lease-0123456789abcdef'}};}});
  await transport.register({version:1,documentSessionID:'d',capabilities:{}});await transport.exchange({version:1,leaseID:'lease-0123456789abcdef',sequence:1});
  assert.equal(calls[0].url,'https://localhost:43793/v1/writing/bootstrap');assert.equal(calls[0].request.headers['X-AskGPT-Writing'],'1');
  assert.equal(calls[1].url,'https://localhost:43793/v1/writing/document/register');assert.equal(calls[1].request.headers.Authorization,'Bearer '+'a'.repeat(64));
  assert.equal(calls[2].request.redirect,'error');assert.equal(calls[2].request.credentials,'omit');assert.equal(calls[2].request.cache,'no-store');transport.dispose();
  await assert.rejects(transport.exchange({}),/disposed/);
});

test('native transport rejects foreign bootstrap origins, HTTP and oversized payloads without retry',async()=>{
  const {NativeDocumentTransport}=await load('../word/native-document-service.js');
  for(const origin of ['http://localhost:43793','https://example.com','https://localhost:43793/','https://user@localhost:43793'])assert.throws(()=>new NativeDocumentTransport({origin,fetch:async()=>{}}));
  let calls=0;const bad=new NativeDocumentTransport({origin:'https://localhost:43793',fetch:async()=>{calls++;return {ok:true,json:async()=>({baseURL:'https://foreign.invalid',token:'a'.repeat(64)})};}});await assert.rejects(bad.register({}),/invalid_bootstrap/);assert.equal(calls,1);bad.dispose();
  const transport=new NativeDocumentTransport({origin:'https://localhost:43793',fetch:async()=>{calls++;return {ok:true,json:async()=>({baseURL:'https://localhost:43793',token:'a'.repeat(64)})};}});await transport.register({});const before=calls;await assert.rejects(transport.exchange({text:'x'.repeat(65536)}),/payload_too_large/);assert.equal(calls,before);transport.dispose();
});

test('uncertain hiding expires the compatibility gate without enabling document service',async()=>{
  const env=await setup({noHiddenEvent:true});const pending=env.service.start();
  for(let i=0;i<30&&!env.timers.timeouts.size;i++)await Promise.resolve();
  for(const fn of [...env.timers.timeouts.values()])fn();
  assert.equal(await pending,false);assert.equal(env.transport.registrations.length,0);assert.equal(env.service.state.status,'preview');assert.equal(env.service.state.errorCode,'hidden_runtime_unverified');await env.service.stop();
});

test('nineteen short visible paragraphs keep first and last spelling without checking an off-page paragraph',async()=>{
  const paragraphs=Array.from({length:19},(_,index)=>({id:`visible-${index}`,text:index===0||index===18?`Paragraph ${index} has resuts.`:`Paragraph ${index} is clear.`,pages:[index<10?1:2]}));
  paragraphs.push({id:'outside',text:'OFF_PAGE_SENTINEL resuts.',pages:[99]});
  const env=await setup({paragraphs,viewport:[1,2]});
  try{
    await env.service.start();const state=env.service.state;
    assert.equal(state.status,'ready');assert.equal(state.scope.snapshots.length,19);assert.deepEqual(state.scope.pageIndices,[1,2]);
    assert.deepEqual(state.issues.map(item=>item.envelope.snapshot.blockID),['visible-0','visible-18']);
    assert.equal(env.checks.length,19);assert.ok(env.checks.every(check=>check.snapshot.blockID!=='outside'));
    assert.ok(Buffer.byteLength(JSON.stringify(state))<=48000);assert.equal(env.fake.state.replacements.length,0);
  }finally{await env.service.stop();}
});

test('sixty-four short visible paragraphs fit the existing text and publication byte budgets',async()=>{
  const env=await setup({paragraphs:Array.from({length:64},(_,index)=>({id:`p${index}`,text:`Row ${index} clear.`,pages:[index<32?1:2]})),viewport:[1,2]});
  try{
    await env.service.start();const state=env.service.state;
    assert.equal(state.status,'ready');assert.equal(state.scope.snapshots.length,64);assert.equal(env.checks.length,64);assert.equal(state.issues.length,0);
    assert.ok(state.scope.snapshots.reduce((sum,snapshot)=>sum+snapshot.rawText.length+snapshot.contextBefore.length+snapshot.contextAfter.length,0)<=16000);
    assert.ok(Buffer.byteLength(JSON.stringify(state))<=48000);assert.equal(env.fake.state.replacements.length,0);
  }finally{await env.service.stop();}
});

test('a visible-page scope above sixty-four paragraphs is preview rather than a false clean check',async()=>{
  const env=await setup({paragraphs:Array.from({length:65},(_,index)=>({text:`Paragraph ${index} contains resuts.`,pages:[1]}))});await env.service.start();
  assert.equal(env.service.state.status,'preview');assert.equal(env.service.state.errorCode,'scope_too_large');assert.equal(env.service.state.scope,null);assert.equal(env.checks.length,0);assert.equal(env.service.state.issues.length,0);await env.service.stop();
});

test('a scope with 16001 UTF16 including bounded context is still rejected before local spelling',async()=>{
  const env=await setup();const capture=env.host.captureScope.bind(env.host),{createSnapshot}=await load('../shared/host-contract.js');
  env.host.captureScope=async mode=>{const scope=await capture(mode);scope.snapshots=await Promise.all(Array.from({length:5},(_,index)=>{const length=index===4?3201:3200;return createSnapshot({...scope.snapshots[0],requestID:crypto.randomUUID(),blockID:`p${index}`,rawText:'x'.repeat(length),contextBefore:'',contextAfter:'',targetRange:{start:0,length},protectedRanges:[]});}));return scope;};
  try{await env.service.start();assert.equal(env.service.state.errorCode,'scope_too_large');assert.equal(env.service.state.status,'preview');assert.equal(env.service.state.scope,null);assert.equal(env.checks.length,0);assert.equal(env.fake.state.replacements.length,0);}
  finally{await env.service.stop();}
});

test('too many repeated-envelope bytes fail explicitly before oversized state reaches the bridge',async()=>{
  const env=await setup({paragraphs:[{text:'resuts '.repeat(10)+'x'.repeat(3880),pages:[1]}]});
  env.client.check=async snapshot=>({requestID:snapshot.requestID,snapshotHash:snapshot.snapshotHash,skillVersion:'local-1',status:'completed',issues:Array.from({length:10},(_,index)=>({id:`s${index}`,category:'spelling',original:'resuts',replacement:'results',reason:'Spelling',range:{start:index*7,length:6},requiresAuthorConfirmation:false}))});
  await env.service.start();assert.equal(env.service.state.status,'preview');assert.equal(env.service.state.errorCode,'payload_too_large');assert.equal(env.service.state.issues.length,0);await env.service.stop();
});

test('resume can hide a visible fallback pane without reentrant service deadlock',async()=>{
  const env=await setup();await env.service.start();await env.emitVisibility('Taskpane');
  const result=await command(env,'resume');assert.equal(result.status,'completed');assert.equal(env.service.state.visibility,'Hidden');assert.equal(env.service.state.status,'ready');await env.service.stop();
});

test('Word disappearing during visibility deregistration cannot retain tracked text or polling timers',async()=>{
  const env=await setup();const register=env.Office.addin.onVisibilityModeChanged;
  env.Office.addin.onVisibilityModeChanged=async handler=>{const remove=await register(handler);return async()=>{await remove();throw Error('DocumentClosed');};};
  await env.service.start();await env.service.stop();assert.equal(env.fake.state.tracked.size,0);assert.equal(env.timers.intervals.size,0);assert.equal(env.service.state.scope,null);assert.equal(env.transport.closed.length,1);
});

test('a legal spelling state plus prepared polish response stays inside the HTTP body limit',async()=>{
  const text='resuts '.repeat(8)+'x'.repeat(3894),env=await setup({paragraphs:[{text,pages:[1]}],selection:[0,56]});
  const issues=Array.from({length:8},(_,index)=>({id:`s${index}`,category:'spelling',original:'resuts',replacement:'results',reason:'Spelling',range:{start:index*7,length:6},requiresAuthorConfirmation:false}));
  env.client.check=async snapshot=>({requestID:snapshot.requestID,snapshotHash:snapshot.snapshotHash,skillVersion:'local-1',status:'completed',issues});
  await env.service.start();const selection=await command(env,'captureSelection');
  const result=await command(env,'prepareSuggestions',{snapshotRequestID:selection.scope.snapshots[0].requestID,issues});assert.equal(result.status,'completed');assert.equal(result.prepared.length,8);
  assert.ok(Buffer.byteLength(JSON.stringify(env.transport.exchanges.at(-1)))<=65536);await env.service.stop();
});

test('an older Hidden continuation cannot restart inline checks after Taskpane becomes visible',async()=>{
  const env=await setup();await env.service.start();await env.emitVisibility('Taskpane');
  let entered,release;const paused=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  env.fallback.pause=async()=>{entered();await gate;};
  const hidden=env.emitVisibility('Hidden');await paused;await env.emitVisibility('Taskpane');release();await hidden;
  assert.equal(env.service.state.visibility,'Taskpane');assert.equal(env.service.state.status,'paused');assert.equal(env.service.state.issues.length,0);assert.equal(env.timers.intervals.size,0);await env.service.stop();
});

test('stopping while a Hidden callback awaits fallback pause cannot resurrect its watcher',async()=>{
  const env=await setup();await env.service.start();await env.emitVisibility('Taskpane');
  let entered,release;const paused=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  env.fallback.pause=async()=>{entered();await gate;};
  const hidden=env.emitVisibility('Hidden');await paused;await env.service.stop();release();await hidden;
  assert.equal(env.service.state.status,'paused');assert.equal(env.service.state.scope,null);assert.equal(env.timers.intervals.size,0);assert.equal(env.fake.state.tracked.size,0);
});

test('native apply rechecks actual document activity after the service preflight finishes',async()=>{
  const env=await setup();await env.service.start();const handle=env.service.state.issues[0].handle;
  const apply=env.host.applyIssue.bind(env.host);env.host.applyIssue=async envelope=>{env.fake.state.windowActive=false;return apply(envelope);};
  const result=await command(env,'apply',{handle});assert.equal(result.status,'rejected');assert.equal(result.code,'document_inactive');assert.equal(env.fake.state.replacements.length,0);await env.service.stop();
});
