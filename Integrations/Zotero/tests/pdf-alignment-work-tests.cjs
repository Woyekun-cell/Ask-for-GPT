const assert=require('node:assert/strict');
const PDF=require('../content/pdf-layout.js');
let checks=0;async function check(name,test){await test();checks++;process.stdout.write('PASS '+name+'\n');}
const input=()=>new TextEncoder().encode('%PDF-1.7\noriginal-source\n');
const state=(extra={})=>({id:'mapping',state:'idle',sourcePages:[0,1],completedPages:[],mappedSentences:0,durable:false,eligible:false,workState:'unregistered',...extra});
function fixture(reply){const calls=[];return {calls,transport:PDF.createTransport({Zotero:{HTTP:{async request(method,url,options){calls.push({method,url,options});return reply(method,url,options);}}}},async()=>({token:'t'.repeat(64)}))};}
const json=(v,status=200)=>({status,responseText:JSON.stringify(v)});
(async()=>{
 await check('full translation registration uploads exact original PDF with explicit intent header only',async()=>{
  const f=fixture(async()=>json(state({state:'running',durable:true,eligible:true,workState:'queued'}),202)),source=input();
  const result=await f.transport.registerAlignmentWork('mapping',source,[0,1]);assert.equal(result.workState,'queued');assert.equal(f.calls.length,1);
  const {method,url,options}=f.calls[0];assert.equal(method,'POST');assert.equal(url,'http://127.0.0.1:43795/v1/pdf/jobs/mapping/alignment-work');assert.equal(options.headers['Content-Type'],'application/pdf');assert.equal(options.headers['X-AskGPT-Full-Translation'],'1');assert.deepEqual(new Uint8Array(options.body),source);assert.deepEqual(source,input());assert.equal(options.headers['X-AskGPT-Background'],undefined);assert.equal(options.logBodyLength,0);
 });
 await check('status without intent remains a single read and never submits missing work',async()=>{
  const f=fixture(async()=>json(state()));assert.equal((await f.transport.alignmentWork('mapping',[0,1])).eligible,false);assert.deepEqual(f.calls.map(x=>x.method),['GET']);assert(f.calls[0].url.endsWith('/alignment-work'));
 });
 await check('prepared partial durable status remains partial without strict completion claims',async()=>{
  const f=fixture(async()=>json(state({state:'complete',durable:true,eligible:true,workState:'partial',preparedPages:[0,1],partialPages:[1]})));const v=await f.transport.alignmentWork('mapping',[0,1]);assert.equal(v.workState,'partial');assert.deepEqual(v.completedPages,[]);assert.deepEqual(v.partialPages,[1]);
 });
 await check('malformed work intent and physical page ownership are rejected',async()=>{
  for(const changes of [{durable:true},{eligible:true},{workState:'queued'},{state:'complete',durable:true,eligible:true,workState:'running'},{state:'running',durable:true,eligible:true,workState:'queued',sourcePages:[0]},{state:'complete',durable:true,eligible:true,workState:'partial',preparedPages:[0],partialPages:[1]}]){const f=fixture(async()=>json(state(changes)));await assert.rejects(f.transport.alignmentWork('mapping',[0,1]),{code:'response'});}
 });
 await check('old service and missing jobs never fall back to automatic page indexing',async()=>{
  for(const error of ['not_found','job_not_found']){const f=fixture(async()=>{throw {xmlhttp:{status:404,responseText:JSON.stringify({error})}};});await assert.rejects(f.transport.alignmentWork('mapping',[0,1]),{code:'alignment_unavailable'});assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');}
 });
 await check('retiring a readonly status watcher only aborts its GET',async()=>{
  let cancel,aborts=0;const f=fixture((_m,_u,options)=>new Promise((_resolve,reject)=>{options.cancellerReceiver(()=>{aborts++;reject(Error('aborted'));});}));const pending=f.transport.alignmentWork('mapping',[0,1],value=>{cancel=value;});const stopped=assert.rejects(pending,{code:'stopped'});await new Promise(setImmediate);cancel();await stopped;assert.equal(aborts,1);assert.deepEqual(f.calls.map(x=>x.method),['GET']);
 });
 await check('invalid registration input cannot reach the service',async()=>{
  const f=fixture(async()=>assert.fail('invalid request'));await assert.rejects(f.transport.registerAlignmentWork('../escape',input(),[0,1]),{code:'response'});await assert.rejects(f.transport.registerAlignmentWork('mapping',new Uint8Array(2),[0,1]),{code:'pdf'});assert.equal(f.calls.length,0);
 });
 process.stdout.write(JSON.stringify({status:'PASS',checks})+'\n');
})().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
