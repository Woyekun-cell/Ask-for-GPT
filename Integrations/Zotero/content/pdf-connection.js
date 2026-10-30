(function(root){
  'use strict';
  const PDF=root.AskGPTPDFLayout||(typeof require==='function'?require('./pdf-layout.js'):null);
  const HEALTH='http://127.0.0.1:43795/v1/pdf/health',UNREACHABLE=Symbol('unreachable');
  function create(dependencies){
    const {Zotero,Services,Components}=dependencies;
    const setTimer=dependencies.setTimer||((fn,ms)=>Zotero.getMainWindow().setTimeout(fn,ms));
    const clearTimer=dependencies.clearTimer||(id=>Zotero.getMainWindow()?.clearTimeout(id));
    let disposed=false,pending=null;
    const error=code=>new PDF.PDFError(code);
    function current(batch){return !disposed&&!batch.stopped&&[...batch.clients].some(check=>{try{return check();}catch(_){return false;}});}
    function check(batch){if(!current(batch))throw batch.error||error('stopped');}
    async function health(batch){
      check(batch);let reply;
      try{
        reply=await Zotero.HTTP.request('GET',HEALTH,{
          headers:{Authorization:'Bearer '+batch.token},responseType:'text',timeout:1000,
          followRedirects:false,anon:true,noCache:true,debug:false,logBodyLength:0,errorDelayMax:0,
          successCodes:[200,400,401,403,404,408,429,500,502,503,504],
          cancellerReceiver(cancel){batch.cancelHTTP=cancel;if(!current(batch))cancel();}
        });
      }catch(cause){
        check(batch);reply=cause?.xmlhttp||cause;
        // Only a failed connection can wake the app; an HTTP reply must retain its error.
        if(!(reply?.status>0))throw UNREACHABLE;
      }finally{batch.cancelHTTP=null;}
      check(batch);
      if(reply.status===401||reply.status===403)throw error('connection');
      if(typeof reply.responseText!=='string'||reply.responseText.length>4096)throw error('bridge');
      let value;try{value=JSON.parse(reply.responseText);}catch(_){throw error('bridge');}
      if((reply.status===200||reply.status===503)&&(value?.status==='runtime_missing'||value?.error==='runtime_missing'))throw error('runtime_missing');
      if(reply.status!==200||value?.status!=='ready'||value?.protocolVersion!==1)throw error('bridge');
    }
    function launch(batch){
      check(batch);
      if(Services?.appinfo?.OS!=='Darwin'&&Zotero.isMac!==true)throw error('bridge');
      try{
        const {classes,interfaces}=Components;
        const home=Services.dirsvc.get('Home',interfaces.nsIFile).clone();
        home.append('Applications');home.append('Ask for GPT.app');
        const system=classes['@mozilla.org/file/local;1'].createInstance(interfaces.nsIFile);
        system.initWithPath('/Applications/Ask for GPT.app');
        const app=[home,system].find(file=>file.exists());
        if(!app||app.isSymlink()||!app.isDirectory())throw error('connection');
        for(let parent=app.parent;parent;parent=parent.parent)if(parent.isSymlink())throw error('connection');
        const executable=classes['@mozilla.org/file/local;1'].createInstance(interfaces.nsIFile);
        executable.initWithPath('/usr/bin/open');
        const process=classes['@mozilla.org/process/util;1'].createInstance(interfaces.nsIProcess);
        process.init(executable);check(batch);
        const args=['-g','-a',app.path,'askgpt://connect','--args','--background'];
        process.runwAsync(args,args.length,{observe(subject,topic){
          if(topic!=='process-finished'||process.exitValue!==0)batch.stop(error('connection'));
        }},false);
      }catch(cause){if(cause?.code==='stopped')throw cause;throw error('connection');}
    }
    function sleep(batch){return new Promise(resolve=>{batch.resume=resolve;batch.timer=setTimer(()=>{batch.timer=null;batch.resume=null;resolve();},250);});}
    async function connect(batch){
      try{await health(batch);return;}catch(cause){if(cause!==UNREACHABLE)throw cause;}
      check(batch);launch(batch);
      for(;;){
        check(batch);await sleep(batch);check(batch);
        try{await health(batch);return;}catch(cause){if(cause!==UNREACHABLE)throw cause;}
      }
    }
    function ensure(connection,isCurrent=()=>true){
      if(disposed||!isCurrent())return Promise.reject(error('stopped'));
      if(pending&&pending.token!==connection.token)return Promise.reject(error('connection'));
      if(!pending){
        const batch={token:connection.token,clients:new Set([isCurrent]),stopped:false,timer:null,cancelHTTP:null,resume:null};
        let rejectStop;
        const stopped=new Promise((resolve,reject)=>{rejectStop=reject;});
        const cleanup=()=>{
          clearTimer(batch.deadline);if(batch.timer!==null)clearTimer(batch.timer);batch.timer=null;
          const resume=batch.resume;batch.resume=null;resume?.();
        };
        batch.stop=cause=>{
          if(batch.stopped)return;batch.stopped=true;batch.error=cause;cleanup();
          try{batch.cancelHTTP?.();}catch(_){}batch.cancelHTTP=null;rejectStop(cause);
        };
        batch.deadline=setTimer(()=>batch.stop(error('bridge')),25000);
        pending=batch;
        batch.promise=Promise.race([connect(batch),stopped]).finally(()=>{cleanup();if(pending===batch)pending=null;});
      }else pending.clients.add(isCurrent);
      return pending.promise.then(()=>{if(disposed||!isCurrent())throw error('stopped');});
    }
    function dispose(){if(disposed)return;disposed=true;pending?.stop(error('stopped'));}
    return {ensure,dispose};
  }
  const api={create};root.AskGPTPDFConnection=api;if(typeof module!=='undefined')module.exports=api;
})(this);
