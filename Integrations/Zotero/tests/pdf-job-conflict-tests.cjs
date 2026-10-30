const assert=require('node:assert/strict');
const PDF=require('../content/pdf-layout.js');
(async()=>{
  for(const resolved of [false,true])for(const abort of [false,true]){
    const calls=[];let release,notify,cancel;
    const entered=new Promise(resolve=>{notify=resolve;});
    const transport=PDF.createTransport({Zotero:{HTTP:{async request(method,url,options){
      calls.push({method,url});assert.equal(method,'POST','refused duplicate must never DELETE original job');
      notify();await new Promise(resolve=>{release=resolve;});
      const reply={status:409,responseText:JSON.stringify({error:'job_conflict'})};if(resolved)return reply;throw {xmlhttp:reply};
    }}}},async()=>({token:'a'.repeat(64)}));
    const value=transport.start(new TextEncoder().encode('%PDF-1.7\nfixture'),{source:'en',target:'zh-Hans',pages:'all'},value=>{if(value)cancel=value;});
    const refusal=assert.rejects(value,{code:abort?'stopped':'job_conflict'});await entered;
    const retired=abort?cancel():null;release();await refusal;if(retired)await retired;
    assert.equal(calls.length,1);assert.deepEqual(calls.map(call=>call.method),['POST']);
  }
  for(const [status,body] of [[400,JSON.stringify({error:'job_conflict'})],[409,'x'.repeat(65537)]]){
    const transport=PDF.createTransport({Zotero:{HTTP:{async request(){throw {xmlhttp:{status,responseText:body}};}}}},async()=>({token:'a'.repeat(64)}));
    await assert.rejects(transport.start(new TextEncoder().encode('%PDF-1.7\nfixture'),{source:'en',target:'zh-Hans',pages:'all'}),{code:status===400?'response':'bridge'});
  }
  const message=PDF.errorMessage(new PDF.PDFError('job_conflict'));
  assert.match(message,/进行中|数量.*上限/);assert(!message.includes('无法连接'));assert(!message.includes('失败'));
  assert.equal(PDF.diagnostic('start',new PDF.PDFError('job_conflict')).code,'job_conflict');
  console.log('PASS 409 refusal, cancellation ownership and accurate busy message');
})().catch(error=>{console.error(error);process.exitCode=1;});
