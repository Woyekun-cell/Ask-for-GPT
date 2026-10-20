import {createWordHost} from './word-host.js';
import {assertIssueEnvelope, assertUTF16Range, overlaps, HostContractError} from '../shared/host-contract.js';
import {snapshotIdentity} from '../shared/page-issue-queue.js';
import {WritingClient} from '../shared/writing-client.js';
import {taskpaneReady} from '../shared/taskpane.js';

const copy = value => JSON.parse(JSON.stringify(value));
const fail = code => {throw new HostContractError(code);};
const safeCode = error => /^[a-z][a-zA-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'document_service_failed';
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
const DEFAULT_PROFILE = {spellingVariant:'en-US',style:'minimal',customTerms:[]};
const signature = scope => JSON.stringify([scope.scope,scope.pageIndices,scope.snapshots.map(snapshotIdentity)]);

/** Same-origin authenticated transport. No document source or credentials are persisted. */
export class NativeDocumentTransport {
  #origin; #fetch; #timers; #token = null; #controllers = new Set(); #disposed = false;
  constructor({origin=globalThis.location?.origin,fetch=globalThis.fetch?.bind(globalThis),timers=globalThis}={}) {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== 'https:' || url.hostname !== 'localhost' || url.username || url.password || typeof fetch !== 'function') fail('invalid_origin');
    this.#origin=origin;this.#fetch=fetch;this.#timers=timers;
  }
  async #request(path,payload) {
    if(this.#disposed)fail('disposed');
    const controller=new AbortController();this.#controllers.add(controller);
    const timeout=this.#timers.setTimeout(()=>controller.abort(),4000);
    try {
      const body=payload===undefined?undefined:JSON.stringify(payload);
      if(body && new TextEncoder().encode(body).length>65536)fail('payload_too_large');
      const response=await this.#fetch(this.#origin+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{'X-AskGPT-Writing':'1'}:{'Content-Type':'application/json',Authorization:`Bearer ${this.#token}`},body,signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
      if(!response.ok)fail('document_bridge_unavailable');
      return await response.json();
    } finally {this.#timers.clearTimeout(timeout);this.#controllers.delete(controller);}
  }
  async register(payload) {
    if(!this.#token){const configuration=await this.#request('/v1/writing/bootstrap');if(this.#disposed)fail('disposed');if(configuration.baseURL!==this.#origin||typeof configuration.token!=='string'||!/^[a-f0-9]{64}$/.test(configuration.token))fail('invalid_bootstrap');this.#token=configuration.token;}
    return this.#request('/v1/writing/document/register',payload);
  }
  exchange(payload){return this.#request('/v1/writing/document/exchange',payload);}
  close(payload){return this.#request('/v1/writing/document/close',payload);}
  dispose(){this.#disposed=true;this.#token=null;for(const controller of this.#controllers)controller.abort();this.#controllers.clear();}
}

/** A single loaded Word document. Never uses AX writes, document paths or full-document ranges. */
export class NativeWordDocumentService {
  #host; #Office; #timers; #client; #transport; #fallback; #profile; #clock;
  #lease=null; #sequence=0; #publishedEpoch=1; #publishedState=null; #commandBaseState=null; #commandAction=null; #result=null; #interval=null; #exchangeTimer=null; #visibilityRemove=null; #hiddenWaiter=null;
  #eventRegistrations=[]; #watching=null; #watchVersion=0; #visibilityVersion=0; #operations=Promise.resolve(); #polling=null; #pollAgain=false; #exchanging=false; #immediateExchangePending=false; #immediateExchangeScheduled=false; #starting=false; #stopped=false; #enabled=false; #applying=false; #userPaused=false; #resuming=false;
  #handles=new Map(); #preparedHandles=new Set(); #selected=new Map(); #requests=new Map(); #seenCommands=new Set(); #lastSignature=null;
  #state={epoch:1,active:false,visibility:'Taskpane',status:'preview',scope:null,issues:[],errorCode:null};
  constructor({host,hostOptions={},Office=globalThis.Office,timers=globalThis,client,transport,fallback,origin=globalThis.location?.origin,clock=()=>typeof globalThis.performance?.now==='function'?globalThis.performance.now():Date.now()}={}) {
    this.#Office=Office;this.#timers=timers;this.#fallback=fallback;
    this.#host=host||createWordHost({...hostOptions,Office,requireActiveWindow:true});
    this.#client=client||new WritingClient({origin});this.#transport=transport||new NativeDocumentTransport({origin,timers});
    this.#profile={...DEFAULT_PROFILE,...fallback?.profile,customTerms:[...(fallback?.profile?.customTerms||[])]};
    this.#clock=clock;
  }
  get state(){return copy(this.#state);}
  #syncProfile(){this.#profile={...DEFAULT_PROFILE,...this.#fallback?.profile,customTerms:[...(this.#fallback?.profile?.customTerms||[])]};this.#state.profile=copy(this.#profile);}
  #enqueue(work){const result=this.#operations.then(work);this.#operations=result.catch(()=>{});return result;}
  #readClock(){try{const value=this.#clock();return Number.isFinite(value)&&value>=0?value:null;}catch{return null;}}
  #applyTiming(measurement){
    if(!measurement)return null;
    const values=[measurement.received,measurement.executed,measurement.committed,this.#readClock()];
    if(values.some((value,index)=>!Number.isFinite(value)||value===null||(index>0&&value<values[index-1]))||values[3]-values[0]>60000)return null;
    const elapsed=values.slice(1).map(value=>Math.round(value-values[0]));
    return {queueMilliseconds:elapsed[0],editMilliseconds:elapsed[1],resultMilliseconds:elapsed[2]};
  }
  #supports(name,version){return this.#Office?.context?.requirements?.isSetSupported(name,version)===true;}
  async #assertActive(){this.#host.assertDocument();try{await this.#host.run(async context=>{const window=context.document.activeWindow;window.load('isActive');await context.sync();if(window.isActive!==true)fail('document_inactive');});}catch(error){if(error.code==='document_inactive')throw error;fail('active_window_unavailable');}this.#host.assertDocument();}
  #clearState(){this.#state.scope=null;this.#state.issues=[];this.#handles.clear();this.#preparedHandles.clear();this.#selected.clear();this.#lastSignature=null;}
  #invalidate(){this.#state.epoch++;this.#clearState();for(const [id,controller]of this.#requests){controller.abort();void Promise.resolve(this.#client.cancel(id)).catch(()=>{});}this.#requests.clear();}
  #fallbackMessage(code){if(this.#fallback&&!this.#fallback.disposed){const messages={document_inactive:'回到 Word 文档后，再点文内检查。',shared_runtime_unavailable:'此版本 Word 无法在隐藏侧栏后检查；可继续使用侧栏。',active_window_unavailable:'Word 无法确认当前活动文档；可继续使用侧栏。',hidden_runtime_unverified:'隐藏检查未能启动；可继续使用侧栏。'};this.#fallback.capabilities.message=messages[code]||'文内检查暂不可用，可继续使用侧栏。';this.#fallback.render();}}

  async start(){
    if(this.#starting||this.#lease||this.#stopped)return false;
    this.#starting=true;
    try {
      if(!this.#supports('SharedRuntime','1.1')||!['hide','showAsTaskpane','onVisibilityModeChanged'].every(name=>typeof this.#Office?.addin?.[name]==='function'))fail('shared_runtime_unavailable');
      if(!this.#supports('WordApiDesktop','1.4'))fail('active_window_unavailable');
      await this.#host.initialize();await this.#assertActive();this.#syncProfile();
      this.#visibilityRemove=await this.#Office.addin.onVisibilityModeChanged(args=>this.#onVisibility(args));
      if(typeof this.#visibilityRemove!=='function')fail('visibility_unavailable');
      await this.#fallback?.pause();
      let timeout;
      const hidden=new Promise((resolve,reject)=>{this.#hiddenWaiter=resolve;timeout=this.#timers.setTimeout(()=>reject(new HostContractError('hidden_runtime_unverified')),2000);});
      try{await this.#Office.addin.hide();await hidden;}finally{this.#timers.clearTimeout(timeout);this.#hiddenWaiter=null;}
      const visibility=this.#visibilityVersion;
      const assertHidden=()=>{if(this.#stopped||this.#state.visibility!=='Hidden'||visibility!==this.#visibilityVersion)fail('hidden_runtime_unverified');};
      assertHidden();await this.#assertActive();assertHidden();
      const lease=await this.#transport.register({version:1,documentSessionID:this.#host.documentSessionID,capabilities:{sharedRuntime:true,activeWindow:true,hiddenRuntime:true,safeReplace:this.#host.capabilities.safeReplace===true}});
      if(!opaque(lease?.leaseID)||lease.epoch!==1||lease.leaseTTLMilliseconds!==5000||lease.pollAfterMilliseconds!==750)fail('invalid_lease');
      this.#lease=lease.leaseID;assertHidden();this.#sequence=0;this.#publishedEpoch=1;this.#publishedState=null;this.#state.epoch=1;this.#state.active=false;this.#enabled=true;this.#state.status='preview';this.#state.errorCode=null;
      this.#requestImmediateExchange();
      await this.#startWatch();assertHidden();await this.pollOnce();assertHidden();return true;
    } catch(error){
      this.#state.status=this.#stopped?'paused':'preview';this.#state.active=false;this.#state.errorCode=safeCode(error);this.#clearState();
      await Promise.allSettled([this.#stopWatch(),this.#removeVisibility()]);
      if(this.#lease){try{await this.#transport.close({version:1,leaseID:this.#lease});}catch{}this.#lease=null;}
      if(this.#exchangeTimer!==null)this.#timers.clearTimeout(this.#exchangeTimer);this.#exchangeTimer=null;this.#publishedState=null;this.#commandBaseState=null;this.#commandAction=null;this.#result=null;
      this.#enabled=false;
      if(!this.#stopped){
        try{await this.#Office?.addin?.showAsTaskpane?.();}catch{}
        try{if(!this.#fallback?.disposed)await this.#fallback?.resume();}catch{}
        this.#fallbackMessage(this.#state.errorCode);
      }
      return false;
    } finally{this.#starting=false;}
  }
  async #onVisibility(args){
    const mode=args?.visibilityMode;if(!['Hidden','Taskpane'].includes(mode))return;
    const version=++this.#visibilityVersion,lease=this.#lease;
    this.#state.visibility=mode;
    if(mode==='Taskpane')this.#state.active=false;
    if(mode==='Hidden'&&this.#hiddenWaiter){this.#hiddenWaiter();return;}
    if(!this.#lease||this.#stopped)return;
    const current=()=>version===this.#visibilityVersion&&lease===this.#lease&&!this.#stopped&&this.#state.visibility===mode;
    if(mode==='Taskpane'){
      this.#enabled=false;this.#invalidate();this.#state.status='paused';await this.#stopWatch();
      if(current()&&!this.#fallback?.disposed)await this.#fallback?.resume();
    } else if(this.#userPaused&&!this.#resuming) {
      // An explicit pause keeps its mailbox available for resume, but only
      // after the hidden document's active window has been freshly proved.
      try{await this.#assertActive();if(!current())return;this.#invalidate();this.#state.active=true;}
      catch(error){if(!current())return;this.#invalidate();this.#state.active=false;this.#state.errorCode=safeCode(error);}
    } else if(!this.#resuming) {
      try{
        await this.#fallback?.pause();if(!current()||this.#userPaused)return;
        // Keep the Hidden checking intent even when Word is momentarily inactive.
        // Each poll still proves activity before it reads or checks any source.
        this.#syncProfile();this.#invalidate();this.#state.active=false;this.#state.status='preview';this.#enabled=true;this.#state.errorCode=null;
        await this.#startWatch();if(current()&&!this.#userPaused)await this.pollOnce();
      }catch(error){if(!current())return;this.#state.status='preview';this.#state.errorCode=safeCode(error);this.#clearState();this.#fallbackMessage(this.#state.errorCode);}
    }
  }
  async #removeVisibility(){const remove=this.#visibilityRemove;this.#visibilityRemove=null;if(remove)await remove();}
  async #startWatch(){
    if(this.#interval!==null)return;
    if(this.#watching){const pending=this.#watching;await pending;if(this.#watching===pending)this.#watching=null;if(this.#enabled&&!this.#stopped&&this.#state.visibility==='Hidden')return this.#startWatch();return;}
    const version=this.#watchVersion,visibility=this.#visibilityVersion,registrations=[];
    const current=()=>version===this.#watchVersion&&visibility===this.#visibilityVersion&&this.#enabled&&!this.#stopped&&this.#state.visibility==='Hidden';
    const work=(async()=>{
      if(!current())return;
      if(this.#host.capabilities.paragraphEvents){
        try{await this.#host.run(async context=>{for(const name of ['onParagraphAdded','onParagraphChanged','onParagraphDeleted'])registrations.push(context.document[name].add(()=>{if(!this.#enabled||this.#applying||this.#stopped)return;this.#pollAgain=true;this.#invalidate();void this.pollOnce();}));await context.sync();});}
        catch{await this.#removeRegistrations(registrations.splice(0));}
      }
      if(!current()){await this.#removeRegistrations(registrations);return;}
      this.#eventRegistrations.push(...registrations);this.#interval=this.#timers.setInterval(()=>{void this.pollOnce();},750);
    })();
    this.#watching=work;try{await work;}finally{if(this.#watching===work)this.#watching=null;}
  }
  async #removeRegistrations(registrations){for(const registration of registrations){try{await this.#host.run(async context=>{registration.remove();await context.sync();});}catch{}}
  }
  async #stopWatch(){this.#watchVersion++;if(this.#interval!==null)this.#timers.clearInterval(this.#interval);this.#interval=null;await this.#removeRegistrations(this.#eventRegistrations.splice(0));const pending=this.#watching;if(pending){await pending;if(this.#watching===pending)this.#watching=null;}}
  #validateScope(scope){
    if(!scope||!Array.isArray(scope.snapshots)||scope.snapshots.length>64||scope.snapshots.reduce((sum,s)=>sum+s.rawText.length+s.contextBefore.length+s.contextAfter.length,0)>16000)fail('scope_too_large');
    if(scope.snapshots.some(snapshot=>snapshot.documentSessionID!==this.#host.documentSessionID))fail('documentChanged');
    return scope;
  }
  #validateIssue(snapshot,issue){
    if(!issue||!['spelling','grammar','expression','context'].includes(issue.category)||typeof issue.id!=='string'||!issue.id.length||issue.id.length>256||!['original','replacement','reason'].every(key=>typeof issue[key]==='string')||issue.original.length>4000||issue.replacement.length>4000||issue.reason.length>512||typeof issue.requiresAuthorConfirmation!=='boolean')fail('invalid_issue');
    assertIssueEnvelope({snapshot,issue});return {snapshot,issue:copy(issue)};
  }
  async #prepare(snapshot,issue,remember=true){
    const envelope=this.#validateIssue(snapshot,issue);const actions=await this.#host.getIssueActions(envelope);
    const item={handle:crypto.randomUUID(),envelope,canApply:actions.canApply===true,reason:typeof actions.reason==='string'?actions.reason.slice(0,512):''};
    if(remember)this.#handles.set(item.handle,item);return item;
  }
  #automaticItem(snapshot,issue){
    const envelope=this.#validateIssue(snapshot,issue),protectedRanges=snapshot.protectedRanges||[];
    const end=issue.range.start+issue.range.length;
    let reason='';
    if(issue.original===issue.replacement)reason='暂无替换候选。';
    else if(protectedRanges.some(range=>overlaps(range,issue.range)))reason='受保护内容，仅预览。';
    else if(/[\u0000-\u001F\u007F\u2028\u2029]/.test(issue.replacement))reason='此候选包含段落或控制字符，仅预览。';
    else {
      const edited=snapshot.rawText.slice(0,issue.range.start)+issue.replacement+snapshot.rawText.slice(end);
      const delta=issue.replacement.length-issue.range.length;
      try{
        assertUTF16Range(edited,{start:issue.range.start,length:issue.replacement.length});
        for(const range of protectedRanges)assertUTF16Range(edited,{start:range.start+(range.start>=end?delta:0),length:range.length});
      }catch{reason='此候选会拆分字符，仅预览。';}
      const count=(text,term)=>{let total=0;for(let index=text.indexOf(term);index!==-1;index=text.indexOf(term,index+1))total++;return total;};
      if(!reason&&this.#profile.customTerms.some(term=>term.length>0&&count(snapshot.rawText,term)!==count(edited,term)))reason='保留词典术语，仅预览。';
    }
    // This permits an explicit attempt. Only applyIssue's fresh Word proof
    // can authorize a real document edit; automatic checks never run it.
    return {handle:crypto.randomUUID(),envelope,canApply:reason==='',reason};
  }
  #yieldToApply(){
    if(this.#commandAction!=='apply')return false;
    // Only discard unfinished readonly work. The delivered target's handles
    // and epoch remain intact until the explicit command validates them.
    this.#lastSignature=null;this.#pollAgain=true;return true;
  }
  #abortCurrentSpelling(){
    for(const [id,controller]of this.#requests){
      controller.abort();
      try{void Promise.resolve(this.#client.cancel(id)).catch(()=>{});}catch{}
    }
  }
  pollOnce(){
    if(this.#polling)return this.#polling;
    if(!this.#enabled||this.#stopped||!this.#lease||this.#commandBaseState||this.#result)return Promise.resolve();
    this.#pollAgain=false;
    const work=this.#enqueue(async()=>{
      if(!this.#enabled||this.#stopped||this.#commandBaseState||this.#result)return;
      const visibility=this.#visibilityVersion,lease=this.#lease,captureEpoch=this.#state.epoch;
      const current=()=>this.#enabled&&!this.#stopped&&lease===this.#lease&&visibility===this.#visibilityVersion&&this.#state.visibility==='Hidden';
      try{
        await this.#assertActive();if(!current()||captureEpoch!==this.#state.epoch||this.#yieldToApply())return;
        const scope=this.#validateScope(await this.#host.captureScope('visiblePages'));if(!current()||captureEpoch!==this.#state.epoch||this.#yieldToApply())return;
        await this.#assertActive();if(!current()||captureEpoch!==this.#state.epoch||this.#yieldToApply())return;
        const scopeSignature=signature(scope);if(scopeSignature===this.#lastSignature)return;
        this.#invalidate();this.#state.active=false;this.#state.status='preview';this.#state.errorCode=null;
        let epoch=this.#state.epoch,published=false;const items=[];
        const publish=async additions=>{
          await this.#assertActive();if(epoch!==this.#state.epoch||!current()||this.#yieldToApply())return false;
          // The full captured scope is immutable from the first publication.
          // Local spelling supplies a candidate; explicit Word acceptance proves a write.
          const verified={...this.#state,epoch:published?epoch:epoch+1,active:true,status:'ready',scope,issues:[...items,...additions],errorCode:null};
          if(new TextEncoder().encode(JSON.stringify(verified)).length>48000)fail('payload_too_large');
          this.#state=verified;epoch=verified.epoch;published=true;items.push(...additions);this.#lastSignature=scopeSignature;
          for(const item of additions)this.#handles.set(item.handle,item);
          this.#requestImmediateExchange();return true;
        };
        for(const snapshot of scope.snapshots){
          // A delivered explicit edit owns the next Word operation. Remember
          // that this whole-scope scan is unfinished, then refill after its ACK.
          if(this.#yieldToApply())return;
          const controller=new AbortController();this.#requests.set(snapshot.requestID,controller);
          let result;
          try{result=await this.#client.check(snapshot,'spelling',copy(this.#profile),{signal:controller.signal});}finally{this.#requests.delete(snapshot.requestID);}
          if(this.#yieldToApply()||controller.signal.aborted||epoch!==this.#state.epoch||!current())return;
          if(result.status!=='completed'||result.requestID!==snapshot.requestID||result.snapshotHash!==snapshot.snapshotHash||!Array.isArray(result.issues)||result.issues.some(issue=>issue.category!=='spelling'))fail('spelling_failed');
          if(items.length+result.issues.length>128)fail('issues_too_large');
          const additions=result.issues.map(issue=>this.#automaticItem(snapshot,issue));
          if(!await publish(additions))return;
        }
        if(!published)await publish([]);
      }catch(error){
        if(this.#yieldToApply())return;
        if(!current())return;
        this.#invalidate();this.#state.active=false;this.#state.status=error.code==='document_inactive'?'paused':'preview';this.#state.errorCode=safeCode(error);this.#requestImmediateExchange();
      }
    });
    this.#polling=work;return work.finally(()=>{if(this.#polling===work)this.#polling=null;if(this.#pollAgain&&this.#enabled&&!this.#stopped)void this.pollOnce();});
  }
  #scheduleExchange(delay=750){if(!this.#lease||this.#stopped)return;if(this.#exchangeTimer!==null)this.#timers.clearTimeout(this.#exchangeTimer);this.#exchangeTimer=this.#timers.setTimeout(()=>{this.#exchangeTimer=null;void this.exchangeOnce();},delay);}
  #requestImmediateExchange(){
    if(!this.#lease||this.#stopped)return;
    this.#immediateExchangePending=true;this.#flushImmediateExchange();
  }
  #flushImmediateExchange(){
    if(!this.#immediateExchangePending||this.#immediateExchangeScheduled||this.#exchanging||!this.#lease||this.#stopped)return;
    const lease=this.#lease;this.#immediateExchangeScheduled=true;
    void Promise.resolve().then(()=>{
      this.#immediateExchangeScheduled=false;
      if(lease!==this.#lease||this.#stopped||!this.#immediateExchangePending)return;
      if(this.#exchanging)return;
      this.#immediateExchangePending=false;
      if(this.#exchangeTimer!==null)this.#timers.clearTimeout(this.#exchangeTimer);this.#exchangeTimer=null;
      void this.exchangeOnce();
    });
  }
  #startCommand(command){
    if(this.#commandBaseState||this.#result||!this.#publishedState)fail('invalid_exchange');
    const measurement=command?.action==='apply'?{received:this.#readClock()}:null;
    this.#commandBaseState=copy(this.#publishedState);this.#commandAction=command?.action;const lease=this.#lease;
    if(this.#yieldToApply())this.#abortCurrentSpelling();
    void this.#enqueue(()=>this.#execute(command,measurement)).then(result=>{if(lease===this.#lease&&!this.#stopped){this.#result=result;this.#requestImmediateExchange();}},error=>{if(lease===this.#lease&&!this.#stopped){this.#result={commandID:command?.id,status:'failed',code:safeCode(error)};this.#requestImmediateExchange();}});
  }
  async exchangeOnce(){
    if(!this.#lease||this.#stopped||this.#exchanging)return false;
    const lease=this.#lease;this.#exchanging=true;this.#immediateExchangePending=false;
    try{
      const submittedResult=this.#result,pending=this.#commandBaseState&&!submittedResult;
      const state=pending?{...copy(this.#commandBaseState),visibility:this.#state.visibility,status:'preview',issues:[]}:this.state;
      const payload={version:1,leaseID:this.#lease,sequence:++this.#sequence,state};if(submittedResult)payload.result=submittedResult;
      if(new TextEncoder().encode(JSON.stringify(payload)).length>65536&&payload.result){
        // The broker already retains this unchanged state. Publish the result
        // alone instead of duplicating the same paragraph in both envelopes.
        if(payload.state.epoch===this.#publishedEpoch)delete payload.state;
        else payload.result={commandID:payload.result.commandID,status:'rejected',code:'stale_epoch'};
      }
      if(new TextEncoder().encode(JSON.stringify(payload)).length>65536)fail('payload_too_large');
      const response=await this.#transport.exchange(payload);if(this.#stopped||lease!==this.#lease)return false;
      if(payload.state){this.#publishedEpoch=payload.state.epoch;this.#publishedState=copy(payload.state);}
      if(submittedResult&&this.#result===submittedResult){this.#result=null;this.#commandBaseState=null;this.#commandAction=null;}
      if(!response||!Array.isArray(response.commands)||response.commands.length>1)fail('invalid_exchange');
      if(response.commands.length)this.#startCommand(response.commands[0]);
      if(!this.#commandBaseState)void this.pollOnce();
      // Only a response from this server's actual idle wait permits direct continuation.
      // Busy commands keep a timer heartbeat independent of the Word.run queue.
      if(response.idleWaitMilliseconds===1000&&!this.#commandBaseState&&!this.#result)this.#requestImmediateExchange();
      else this.#scheduleExchange();
      return true;
    }catch(error){
      if(this.#stopped||lease!==this.#lease)return false;
      this.#immediateExchangePending=false;this.#enabled=false;this.#invalidate();this.#state.status='failed';this.#state.errorCode=safeCode(error);await this.#stopWatch();
      const failedLease=this.#lease;this.#lease=null;if(this.#exchangeTimer!==null)this.#timers.clearTimeout(this.#exchangeTimer);this.#exchangeTimer=null;
      this.#publishedState=null;this.#commandBaseState=null;this.#commandAction=null;this.#result=null;
      try{await this.#transport.close({version:1,leaseID:failedLease});}catch{}
      try{await this.#Office.addin.showAsTaskpane();if(!this.#fallback?.disposed)await this.#fallback?.resume();}catch{}
      this.#fallbackMessage(this.#state.errorCode);return false;
    }finally{this.#exchanging=false;this.#flushImmediateExchange();}
  }
  async #execute(command,measurement=null){
    if(measurement)measurement.executed=this.#readClock();
    const result={commandID:command?.id,status:'rejected',code:'invalid_command'};
    try{
      if(!command||typeof command.id!=='string'||command.id.length>128||this.#seenCommands.has(command.id))fail('invalid_command');
      this.#seenCommands.add(command.id);if(this.#seenCommands.size>256)this.#seenCommands.delete(this.#seenCommands.values().next().value);
      if(command.epoch!==this.#state.epoch)fail('stale_epoch');
      if(command.action==='pause'){this.#userPaused=true;this.#enabled=false;this.#invalidate();this.#state.status='paused';await this.#stopWatch();return {...result,status:'completed',code:'paused'};}
      if(command.action==='resume'){
        await this.#assertActive();await this.#fallback?.pause();this.#syncProfile();this.#enabled=true;
        this.#userPaused=false;this.#resuming=true;
        try{if(this.#state.visibility!=='Hidden')await this.#Office.addin.hide();}finally{this.#resuming=false;}
        if(this.#state.visibility!=='Hidden')fail('hidden_runtime_unverified');
        this.#state.status='ready';this.#state.errorCode=null;await this.#startWatch();return {...result,status:'completed',code:'resumed'};
      }
      // Apply keeps its activity check beside the final handle/epoch guard
      // below. The intervening apply branches are synchronous validation only.
      if(command.action!=='apply')await this.#assertActive();
      if(!this.#enabled||this.#state.visibility!=='Hidden')fail('document_service_paused');
      if(command.action==='captureSelection'){
        const scope=this.#validateScope(await this.#host.captureScope('selection'));await this.#assertActive();
        if(this.#stopped||!this.#enabled||command.epoch!==this.#state.epoch)fail('stale_epoch');
        if(scope.scope!=='selection'||scope.snapshots.length!==1)fail('invalid_selection');
        const snapshot=scope.snapshots[0];this.#selected.set(snapshot.requestID,snapshot);while(this.#selected.size>2)this.#selected.delete(this.#selected.keys().next().value);
        return {...result,status:'completed',code:'captured',scope};
      }
      if(command.action==='prepareSuggestions'){
        const snapshot=this.#selected.get(command.snapshotRequestID);
        if(!snapshot||!Array.isArray(command.issues)||command.issues.length>128)fail('stale_selection');
        for(const issue of command.issues)this.#validateIssue(snapshot,issue);
        const prepared=[];
        for(const issue of command.issues)prepared.push(await this.#prepare(snapshot,issue,false));
        await this.#assertActive();if(this.#stopped||!this.#enabled||command.epoch!==this.#state.epoch)fail('stale_epoch');
        if(new TextEncoder().encode(JSON.stringify(prepared)).length>48000)fail('payload_too_large');
        for(const handle of this.#preparedHandles)this.#handles.delete(handle);this.#preparedHandles.clear();
        for(const item of prepared){this.#handles.set(item.handle,item);this.#preparedHandles.add(item.handle);}
        return {...result,status:'completed',code:'prepared',prepared};
      }
      if(!['apply','ignore','addTerm'].includes(command.action))fail('invalid_command');
      const item=this.#handles.get(command.handle);if(!item)fail('unknown_handle');
      if(command.action==='ignore'){this.#handles.delete(item.handle);this.#state.issues=this.#state.issues.filter(issue=>issue.handle!==item.handle);return {...result,status:'completed',code:'ignored'};}
      if(command.action==='addTerm'){
        if(item.envelope.issue.category!=='spelling')fail('invalid_term');
        const terms=[...new Set([...this.#profile.customTerms,item.envelope.issue.original])];
        if(terms.length>128||terms.some(term=>term.length>256)||terms.reduce((sum,term)=>sum+term.length,0)>4096)fail('dictionary_full');
        this.#profile.customTerms=terms;this.#state.profile=copy(this.#profile);if(this.#fallback)this.#fallback.profile={...this.#fallback.profile,customTerms:[...terms]};this.#invalidate();return {...result,status:'completed',code:'term_added'};
      }
      if(item.canApply!==true)fail('preview_only');
      await this.#assertActive();if(this.#stopped||!this.#enabled||command.epoch!==this.#state.epoch||this.#handles.get(command.handle)!==item)fail('stale_epoch');
      this.#invalidate();this.#applying=true;
      try{await this.#host.applyIssue(item.envelope,{onCommit:()=>{if(measurement&&measurement.committed===undefined)measurement.committed=this.#readClock();}});}finally{this.#applying=false;}
      const timing=this.#applyTiming(measurement);
      return {...result,status:'completed',code:'applied',...(timing?{timing}:{})};
    }catch(error){
      if(error.code==='document_inactive'){this.#invalidate();this.#state.active=false;this.#state.status='paused';}
      return {...result,status:'rejected',code:safeCode(error)};
    }
  }
  async stop(){
    if(this.#stopped)return;this.#stopped=true;this.#immediateExchangePending=false;this.#visibilityVersion++;this.#enabled=false;this.#invalidate();this.#state.status='paused';this.#state.active=false;
    if(this.#exchangeTimer!==null)this.#timers.clearTimeout(this.#exchangeTimer);this.#exchangeTimer=null;
    await Promise.allSettled([this.#stopWatch(),this.#removeVisibility()]);await this.#operations;
    const lease=this.#lease;this.#lease=null;if(lease){try{await this.#transport.close({version:1,leaseID:lease});}catch{}}
    await Promise.allSettled([this.#client.dispose(),this.#host.dispose()]);this.#transport.dispose?.();this.#seenCommands.clear();this.#result=null;this.#commandBaseState=null;this.#commandAction=null;this.#publishedState=null;
  }
}

/** Document-scoped startup settings only. This cannot enable never-opened documents. */
export class WordDocumentStartupPreference {
  #Office; #document; #allowLoad; #version=0; #desired; #pending=null; #queue=Promise.resolve(); #status='unavailable';
  constructor({Office=globalThis.Office,allowLoad=()=>true}={}) {
    this.#Office=Office;this.#document=Office?.context?.document;this.#allowLoad=allowLoad;
  }
  get status(){return this.#status;}
  #sameDocument(){try{return !!this.#document&&this.#Office?.context?.document===this.#document;}catch{return false;}}
  #canLoad(){try{return this.#allowLoad()===true;}catch{return false;}}
  request(enabled) {
    const desired=enabled===true;
    if(this.#desired===desired&&this.#pending&&this.#sameDocument()&&(!desired||this.#canLoad()))return this.#pending;
    this.#desired=desired;const version=++this.#version;this.#status='pending';
    const current=()=>version===this.#version&&this.#sameDocument()&&(!desired||this.#canLoad());
    const work=this.#queue.then(async()=>{
      if(!current())return 'superseded';
      const Office=this.#Office,addin=Office?.addin,behavior=Office?.StartupBehavior;
      try {
        if(Office?.context?.requirements?.isSetSupported('SharedRuntime','1.1')!==true
            ||typeof addin?.setStartupBehavior!=='function'||typeof addin?.getStartupBehavior!=='function'
            ||behavior?.load!=='Load'||behavior?.none!=='None')return 'unavailable';
        const mode=desired?behavior.load:behavior.none;
        // Serialize writes: an explicit disable must run after an in-flight enable settles.
        await addin.setStartupBehavior(mode);if(!current())return 'superseded';
        const actual=await addin.getStartupBehavior();if(!current())return 'superseded';
        return actual===mode?(desired?'enabled':'disabled'):'failed';
      } catch {return current()?'failed':'superseded';}
    }).then(status=>{if(version===this.#version)this.#status=status;return status;});
    this.#pending=work;this.#queue=work.then(()=>{},()=>{});return work;
  }
}

export async function mountNativeWordService({controller,document=globalThis.document,location=globalThis.location}={}){
  if(!controller||controller.closing||controller.disposed||new URL(location.href).searchParams.get('host')!=='word')return null;
  let service=null;
  const startup=new WordDocumentStartupPreference({Office:controller.host?.Office||globalThis.Office,allowLoad:()=>!controller.closing&&!controller.disposed&&controller.auto!==false});
  let startupVersion=0;
  const requestStartup=enabled=>{const version=++startupVersion;controller.documentStartupStatus='pending';return startup.request(enabled).then(status=>{if(version===startupVersion)controller.documentStartupStatus=status;return status;});};
  const stopCurrent=()=>Promise.resolve(service?.stop()).catch(()=>{});
  const button=document.createElement('button');button.type='button';button.textContent='文内检查';button.id='inline-writing';
  const start=async()=>{if(controller.closing||controller.disposed){button.disabled=true;return;}button.disabled=true;try{await service?.stop();if(controller.closing||controller.disposed)return;service=new NativeWordDocumentService({fallback:controller,origin:location.origin});await service.start();if(controller.closing||controller.disposed)await service.stop();}catch{if(!controller.closing&&!controller.disposed){controller.capabilities.message='文内检查暂不可用，可继续使用侧栏。';controller.render();}}finally{button.disabled=controller.closing||controller.disposed;}};
  button.addEventListener('click',()=>{if(!controller.closing&&!controller.disposed)void requestStartup(controller.auto!==false);return start();});document.querySelector('.check-actions')?.append(button);
  document.querySelector('#auto-check')?.addEventListener('change',event=>{const enabled=event.target?.checked===true&&controller.auto!==false&&!controller.closing&&!controller.disposed;return requestStartup(enabled);});
  document.querySelector('#close')?.addEventListener('click',()=>{button.disabled=true;const pending=requestStartup(false);void stopCurrent();return pending;});
  globalThis.addEventListener?.('pagehide',()=>{void service?.stop();},{once:true});
  const startupReady=requestStartup(controller.auto!==false);
  await start();return {get service(){return service;},startupReady,stop:()=>service?.stop()};
}

if(globalThis.document&&globalThis.location&&new URL(globalThis.location.href).searchParams.get('host')==='word'){
  void taskpaneReady.then(controller=>mountNativeWordService({controller})).catch(()=>{});
}
