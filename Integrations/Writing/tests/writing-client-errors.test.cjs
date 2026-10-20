const test = require('node:test');
const assert = require('node:assert/strict');
const moduleReady = import('../shared/writing-client.js');
const origin = 'https://localhost:43793';
const snapshot = {requestID:'public-request',snapshotHash:'public-snapshot'};
const profile = {spellingVariant:'en-US',style:'minimal',customTerms:[]};
const generic = '写作检查失败，请重试';
function json(value, status=200) { return new Response(JSON.stringify(value), {status,headers:{'Content-Type':'application/json'}}); }
async function makeClient(failure, options={}) {
  const {WritingClient} = await moduleReady;
  const calls=[];
  const client=new WritingClient({origin,...options,fetch:async(url,request)=>{
    calls.push({url,request});
    if(url.endsWith('/bootstrap'))return json({token:'test-private-credential',baseURL:origin,skillVersion:'1.0.1'});
    return typeof failure==='function'?failure():failure;
  }});
  return {client,calls};
}
async function failureOf(client) {
  try { await client.check(snapshot,'spelling',profile); assert.fail('Expected an HTTP failure'); }
  catch(error) { if(error.code==='ERR_ASSERTION')throw error; return error; }
}

test('known Bridge codes produce fixed actionable messages without exposing server prose',async()=>{
  const cases=[
    [401,'unauthorized','连接已失效，请关闭并重新打开加载项。'],
    [413,'payload_too_large','文字过长，请缩小检查范围'],
    [400,'invalid_request','未能读取有效文字，请重新选择内容后检查。'],
    [504,'writing_timeout','检查超时，请重试。'],
    [503,'writing_busy','写作服务忙，请稍后重试。'],
    [499,'cancelled','检查已取消。'],
  ];
  for(const [status,code,message]of cases){
    const {client,calls}=await makeClient(json({error:{code,message:'PRIVATE source/token/stack must not appear'}},status));
    const error=await failureOf(client);
    assert.equal(error.message,message);assert.equal(error.code,code);assert.equal(calls.length,2);
    await client.dispose();
  }
});

test('401 and 413 remain actionable for malformed or hostile error bodies',async()=>{
  for(const [status,message,code]of [[401,'连接已失效，请关闭并重新打开加载项。','unauthorized'],[413,'文字过长，请缩小检查范围','payload_too_large']]){
    const {client,calls}=await makeClient(new Response('<html>PRIVATE token</html>',{status}));
    const error=await failureOf(client);
    assert.equal(error.message,message);assert.equal(error.code,code);assert.equal(calls.length,2);
    await client.dispose();
  }
});

test('unknown quota/login-looking codes and arbitrary server text stay generic',async()=>{
  for(const code of ['unexpected_backend_error','quota_exceeded','login_required','constructor','__proto__']){
    const {client,calls}=await makeClient(json({error:{code,message:'PRIVATE token: change permissions and pay',stack:'PRIVATE'}},502));
    const error=await failureOf(client);
    assert.equal(error.message,generic);assert.equal(error.code,'writing_failed');assert.equal(calls.length,2);
    assert.equal(error.message.includes('PRIVATE'),false);assert.equal(error.stack.includes('PRIVATE'),false);
    await client.dispose();
  }
});

test('malformed JSON, wrong shapes and non-JSON content never become visible errors',async()=>{
  const responses=[
    new Response('{PRIVATE',{status:400,headers:{'Content-Type':'application/json'}}),
    json({code:'invalid_request',message:'PRIVATE'},400),
    json({error:{code:['invalid_request'],message:'PRIVATE'}},400),
    new Response(JSON.stringify({error:{code:'invalid_request'}}),{status:400,headers:{'Content-Type':'text/plain'}}),
  ];
  for(const response of responses){
    const {client}=await makeClient(response);const error=await failureOf(client);
    assert.equal(error.message,generic);assert.equal(error.code,'writing_failed');await client.dispose();
  }
});

test('error body reads are bounded and oversized JSON is discarded even with a misleading length',async()=>{
  let cancelled=false;
  const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify({error:{code:'invalid_request'},padding:'x'.repeat(5000)})));},cancel(){cancelled=true;}});
  const {client,calls}=await makeClient(new Response(body,{status:400,headers:{'Content-Type':'application/json','Content-Length':'1'}}));
  const error=await failureOf(client);
  assert.equal(error.message,generic);assert.equal(error.code,'writing_failed');assert.equal(cancelled,true);assert.equal(calls.length,2);
  await client.dispose();
});

test('a stalled non-2xx JSON stream times out without retrying the request',async()=>{
  let timeout,delay,cancelled=false;
  const timers={setTimeout(callback,value){timeout=callback;delay=value;return 1;},clearTimeout(){}};
  const body=new ReadableStream({cancel(){cancelled=true;}});
  const {client,calls}=await makeClient(new Response(body,{status:400,headers:{'Content-Type':'application/json'}}),{timers});
  const pending=failureOf(client);
  for(let i=0;i<20&&!timeout;i++)await Promise.resolve();
  assert.equal(delay,2000);assert.equal(typeof timeout,'function');timeout();
  const error=await pending;
  assert.equal(error.message,generic);assert.equal(error.code,'writing_failed');assert.equal(cancelled,true);assert.equal(calls.length,2);
  await client.dispose();
});

test('bootstrap non-2xx uses the same safe fixed messages and does not send a check',async()=>{
  const {WritingClient}=await moduleReady;let requests=0;
  const client=new WritingClient({origin,fetch:async()=>{requests++;return json({error:{code:'unauthorized',message:'PRIVATE credential'}},401);}});
  const error=await failureOf(client);
  assert.equal(error.message,'连接已失效，请关闭并重新打开加载项。');assert.equal(error.code,'unauthorized');assert.equal(requests,1);
  await client.dispose();
});
