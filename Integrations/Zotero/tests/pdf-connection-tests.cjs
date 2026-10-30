const assert=require('node:assert/strict');
const Connection=require('../content/pdf-connection.js');
const connection={url:'http://127.0.0.1:43792/v1/inline/translate',token:'a'.repeat(64)};
const ready={status:200,responseText:'{"status":"ready","protocolVersion":1}'};
const unavailable=()=>Object.assign(new Error('connection refused'),{status:0});
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(options={}){
  let time=0,serial=0;
  const timers=new Map(),requests=[],launches=[],cancelled=[],queue=(options.queue||[ready]).slice();
  const entries=new Map([['/Users/test/Applications/Ask for GPT.app',{directory:true}],...(options.files||[])]);
  if(options.noUserApp)entries.delete('/Users/test/Applications/Ask for GPT.app');
  function file(path='') {return {path,clone(){return file(this.path);},append(part){this.path+='/'+part;},initWithPath(value){this.path=value;},exists(){return entries.has(this.path);},isDirectory(){return entries.get(this.path)?.directory===true;},isSymlink(){return entries.get(this.path)?.symlink===true;},get parent(){return this.path==='/'?null:file(this.path.slice(0,this.path.lastIndexOf('/'))||'/');}};}
  const deps={
    Zotero:{isMac:options.mac!==false,HTTP:{async request(method,url,settings){
      const request={method,url,settings};requests.push(request);
      settings.cancellerReceiver?.(()=>cancelled.push(request));
      const next=queue.length?queue.shift():(options.keepUnavailable?unavailable():ready);
      if(typeof next==='function')return next(request);
      if(next instanceof Error)throw next;
      return next;
    }}},
    Services:{appinfo:{OS:options.mac===false?'WINNT':'Darwin'},dirsvc:{get(key){assert.equal(key,'Home');return file('/Users/test');}}},
    Components:{interfaces:{nsIFile:{},nsIProcess:{}},classes:{
      '@mozilla.org/file/local;1':{createInstance(){return file();}},
      '@mozilla.org/process/util;1':{createInstance(){let executable;return {init(value){executable=value.path;},runwAsync(args,length,observer){assert.equal(length,args.length);launches.push({executable,args});observer.observe(null,options.launchFails?'process-failed':'process-finished');},get exitValue(){return options.launchFails?1:0;}};}}
    }},
    setTimer(fn,milliseconds){const id=++serial;timers.set(id,{at:time+milliseconds,fn});return id;},
    clearTimer(id){timers.delete(id);}
  };
  const owner=Connection.create(deps);
  async function settle(promise){
    let done=false;promise.then(()=>{done=true;},()=>{done=true;});
    for(let i=0;i<200&&!done;i++){
      await flush();if(done)break;
      const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
      assert(next,'pending operation has no bounded timer');
      time=next[1].at;timers.delete(next[0]);next[1].fn();
    }
    assert(done,'operation did not settle');return promise;
  }
  return {owner,deps,requests,launches,cancelled,timers,settle,queue,get time(){return time;}};
}
let count=0;
async function test(name,run){await run();count++;console.log('PASS '+name);}
(async()=>{
  await test('ready service needs only authenticated health and never launches the app',async()=>{
    const f=fixture();await f.settle(f.owner.ensure(connection));assert.equal(f.launches.length,0);assert.equal(f.requests.length,1);
    const {method,url,settings}=f.requests[0];assert.equal(method,'GET');assert.equal(url,'http://127.0.0.1:43795/v1/pdf/health');
    assert.equal(settings.headers.Authorization,'Bearer '+connection.token);assert.equal(settings.followRedirects,false);assert.equal(settings.debug,false);assert.equal(settings.logBodyLength,0);assert.equal(settings.body,undefined);assert.equal(f.timers.size,0);
  });
  await test('closed service launches the fixed user app in the background then waits for ready',async()=>{
    const f=fixture({queue:[unavailable(),unavailable(),ready]});await f.settle(f.owner.ensure(connection));
    assert.deepEqual(f.launches,[{executable:'/usr/bin/open',args:['-g','-a','/Users/test/Applications/Ask for GPT.app','askgpt://connect','--args','--background']}]);assert.equal(f.requests.length,3);assert(f.time<25000);assert.equal(f.timers.size,0);
  });
  await test('concurrent explicit actions share one recovery and one launch',async()=>{
    const f=fixture({queue:[unavailable(),ready]});const first=f.owner.ensure(connection),second=f.owner.ensure(connection);await f.settle(Promise.all([first,second]));assert.equal(f.launches.length,1);assert.equal(f.requests.length,2);
  });
  await test('later action probes again so a restarted or stopped service is not hidden by cached ready',async()=>{
    const f=fixture({queue:[ready,unavailable(),ready]});await f.settle(f.owner.ensure(connection));await f.settle(f.owner.ensure(connection));assert.equal(f.requests.length,3);assert.equal(f.launches.length,1);
  });
  await test('system installation is used only when user installation is absent',async()=>{
    const f=fixture({noUserApp:true,files:[['/Applications/Ask for GPT.app',{directory:true}]],queue:[unavailable(),ready]});await f.settle(f.owner.ensure(connection));assert.equal(f.launches[0].args[2],'/Applications/Ask for GPT.app');
  });
  await test('missing app and symlink app are rejected without executing a process',async()=>{
    for(const options of [{noUserApp:true},{files:[['/Users/test/Applications/Ask for GPT.app',{directory:true,symlink:true}]]}]){
      const f=fixture({...options,queue:[unavailable()]});await assert.rejects(f.settle(f.owner.ensure(connection)),{code:'connection'});assert.equal(f.launches.length,0);
    }
  });
  await test('symlink parent cannot redirect the fixed user installation path',async()=>{
    const f=fixture({files:[['/Users/test/Applications',{directory:true,symlink:true}]],queue:[unavailable()]});await assert.rejects(f.settle(f.owner.ensure(connection)),{code:'connection'});assert.equal(f.launches.length,0);
  });
  await test('Windows does not attempt a macOS wake command',async()=>{
    const f=fixture({mac:false,queue:[unavailable()]});await assert.rejects(f.settle(f.owner.ensure(connection)),{code:'bridge'});assert.equal(f.launches.length,0);assert.equal(f.requests.length,1);
  });
  await test('unauthorized health is reported without app launch for resolved and thrown HTTP responses',async()=>{
    for(const status of [401,403])for(const thrown of [false,true]){
      const reply={status,responseText:'{}'},f=fixture({queue:[thrown?()=>Promise.reject({xmlhttp:reply}):reply]});await assert.rejects(f.settle(f.owner.ensure(connection)),{code:'connection'});assert.equal(f.launches.length,0);
    }
  });
  await test('missing runtime is preserved as a distinct non-recoverable error',async()=>{
    for(const reply of [{status:200,responseText:'{"status":"runtime_missing","protocolVersion":1}'},{status:503,responseText:'{"error":"runtime_missing"}'}]){
      const f=fixture({queue:[reply]});await assert.rejects(f.settle(f.owner.ensure(connection)),{code:'runtime_missing'});assert.equal(f.launches.length,0);
    }
  });
  await test('unexpected protocol, non-ready body, malformed or excessive health and redirects never launch',async()=>{
    for(const reply of [{status:200,responseText:'{"status":"ready","protocolVersion":2}'},{status:200,responseText:'{"status":"starting","protocolVersion":1}'},{status:200,responseText:'{'},{status:200,responseText:' '.repeat(4097)},{status:302,responseText:'{}'},{status:503,responseText:'{}'}]){
      const f=fixture({queue:[reply]});await assert.rejects(f.settle(f.owner.ensure(connection)),{code:'bridge'});assert.equal(f.launches.length,0);
    }
  });
  await test('cancelled action does not probe or launch',async()=>{
    const f=fixture({queue:[unavailable()]});await assert.rejects(f.settle(f.owner.ensure(connection,()=>false)),{code:'stopped'});assert.equal(f.requests.length,0);assert.equal(f.launches.length,0);
  });
  await test('cancellation during initial health prevents wake',async()=>{
    let current=true;const f=fixture({queue:[()=>{current=false;throw unavailable();}]});await assert.rejects(f.settle(f.owner.ensure(connection,()=>current)),{code:'stopped'});assert.equal(f.launches.length,0);
  });
  await test('one cancelled caller cannot stop another current caller sharing recovery',async()=>{
    let current=true;const f=fixture({queue:[unavailable(),ready]});const first=f.owner.ensure(connection,()=>current),second=f.owner.ensure(connection);current=false;
    const stopped=assert.rejects(first,{code:'stopped'});await f.settle(Promise.all([stopped,second]));assert.equal(f.launches.length,1);
  });
  await test('cancellation after wake prevents publishing ready and clears pending timers',async()=>{
    let current=true;const f=fixture({queue:[unavailable(),()=>{current=false;return ready;}]});await assert.rejects(f.settle(f.owner.ensure(connection,()=>current)),{code:'stopped'});assert.equal(f.launches.length,1);assert.equal(f.timers.size,0);
  });
  await test('permanently closed helper stops at the bounded recovery deadline',async()=>{
    const f=fixture({queue:[unavailable()],keepUnavailable:true});await assert.rejects(f.settle(f.owner.ensure(connection)),{code:'bridge'});assert.equal(f.time,25000);assert.equal(f.launches.length,1);assert.equal(f.timers.size,0);
  });
  await test('a hanging health request obeys the same deadline and aborts without launching',async()=>{
    const f=fixture({queue:[()=>new Promise(()=>{})]});await assert.rejects(f.settle(f.owner.ensure(connection)),{code:'bridge'});assert.equal(f.time,25000);assert.equal(f.cancelled.length,1);assert.equal(f.launches.length,0);assert.equal(f.timers.size,0);
  });
  await test('failed native open reports connection error instead of waiting the full deadline',async()=>{
    const f=fixture({queue:[unavailable()],launchFails:true});await assert.rejects(f.settle(f.owner.ensure(connection)),{code:'connection'});assert(f.time<25000);assert.equal(f.launches.length,1);
  });
  await test('dispose rejects an in-flight health request immediately and aborts HTTP',async()=>{
    const f=fixture({queue:[()=>new Promise(()=>{})]});const pending=f.owner.ensure(connection);await flush();f.owner.dispose();await assert.rejects(pending,{code:'stopped'});assert.equal(f.cancelled.length,1);assert.equal(f.launches.length,0);assert.equal(f.timers.size,0);
    await assert.rejects(f.owner.ensure(connection),{code:'stopped'});f.owner.dispose();
  });
  await test('dispose during wake polling clears the sleep timer and prevents further requests',async()=>{
    const f=fixture({queue:[unavailable()],keepUnavailable:true});const pending=f.owner.ensure(connection);await flush();assert.equal(f.launches.length,1);const count=f.requests.length;f.owner.dispose();await assert.rejects(pending,{code:'stopped'});await flush();assert.equal(f.requests.length,count);assert.equal(f.timers.size,0);
  });
  await test('late health success after dispose cannot revive the owner or launch',async()=>{
    let release;const f=fixture({queue:[()=>new Promise(resolve=>{release=resolve;})]});const pending=f.owner.ensure(connection);await flush();f.owner.dispose();await assert.rejects(pending,{code:'stopped'});release(ready);await flush();assert.equal(f.launches.length,0);assert.equal(f.timers.size,0);
  });
  console.log(count+' PDF connection checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
