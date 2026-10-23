(function(root){
 'use strict';
 const failure=()=>Object.assign(new Error('Figure native bridge unavailable'),{name:'AbortError',code:'figure_native'});
 const nodeTest=typeof module==='object'&&module?.exports&&typeof process==='object'&&Boolean(process.versions?.node);
 function create({view,Services,Components,rootURI,reportDiagnostic,lookupFigure,enabled}={}){
  if(typeof Services?.scriptloader?.loadSubScriptWithOptions!=='function'||typeof rootURI!=='string')return null;
  const win=view?._iframeWindow,document=win?.document,uri=document?.documentURI||document?.URL;
  if(uri!=='resource://zotero/reader/pdf/web/viewer.html'||!/^(?:jar:file:|file:|resource:)/.test(rootURI))throw failure();
  const Cu=Components?.utils;let sandbox=null,api=null,ownsSandbox=false,phase=1;
  const ownAPI=()=>sandbox&&Object.prototype.hasOwnProperty.call(sandbox,'AskGPTPDFFigureNative')?sandbox.AskGPTPDFFigureNative:null;
  function retireSandbox(){
   try{const raw=api||ownAPI(),owner=raw&&Cu?.waiveXrays?Cu.waiveXrays(raw):raw;if(typeof owner?.dispose==='function')Reflect.apply(owner.dispose,owner,[]);}catch(_){}
   finally{const owner=sandbox;sandbox=null;api=null;if(ownsSandbox&&owner)try{Cu.nukeSandbox(owner);}catch(_){}}
  }
  try{
   if(typeof Cu?.Sandbox==='function'){
    if(typeof Cu.nukeSandbox!=='function')throw failure();
    phase=2;sandbox=new Cu.Sandbox(win,{sandboxPrototype:win,sameZoneAs:win,wantXrays:false,wantComponents:false,sandboxName:'AskGPT PDF figure helper'});ownsSandbox=true;
   }else if(nodeTest)sandbox=Object.create(win);else throw failure();
   phase=3;Services.scriptloader.loadSubScriptWithOptions(rootURI+'content/pdf-figure-region.js',{target:sandbox,ignoreCache:true});
   phase=4;Services.scriptloader.loadSubScriptWithOptions(rootURI+'content/pdf-figure-native.js',{target:sandbox,ignoreCache:true});
   if(win.document!==document)throw failure();
   phase=5;const owned=ownAPI();api=owned&&Cu?.waiveXrays?Cu.waiveXrays(owned):owned;
   phase=6;
   if(!api||typeof api.detect!=='function'||typeof api.render!=='function'||typeof api.cancel!=='function'||typeof api.dispose!=='function')throw failure();
  }catch(_){retireSandbox();const error=failure();error.figurePhase=phase;throw error;}
  const pending=new Set();let disposed=false,detectionID=0;
  const exported=fn=>Cu?.exportFunction?Cu.exportFunction(fn,sandbox):fn;
  const sameDocument=()=>{try{return win.document===document;}catch(_){return false;}};
  const releaseCanvas=value=>{try{if(value)value.width=value.height=0;}catch(_){}};
  const invoke=(name,args,retiring=false)=>{if(!retiring&&win.document!==document)throw failure();return Reflect.apply(api[name],api,args);};
  function glyphJSON(chars){
   const rows=[];if(chars&&Number.isInteger(chars.length)&&chars.length<=100000)for(let i=0;i<chars.length;i++){
    const value=chars[i],r=value?.rect,rect=r&&[r[0],r[1],r[2],r[3]];if(!rect?.every(Number.isFinite))continue;
    const length=typeof value.c==='string'?Math.min(32,value.c.trim().length):0;
    rows.push({c:'x'.repeat(length),rect,rotation:Number.isFinite(value.rotation)?value.rotation:0,ignorable:Boolean(value.ignorable),lineBreakAfter:Boolean(value.lineBreakAfter),paragraphBreakAfter:Boolean(value.paragraphBreakAfter)});
   }
   const text=JSON.stringify(rows);return text.length<=1024*1024?text:'[]';
  }
  function detect(index,chars){
   if(disposed)return Promise.reject(failure());
   const id=++detectionID;let settled=false,rejectDetection,modelCancel=null,modelReady=null;const request={reject:()=>cancel()};
   const active=()=>!disposed&&!settled&&pending.has(request)&&sameDocument()&&(enabled?.()??true);
   const lookup=typeof lookupFigure==='function'?exported((canvas,complete)=>{
    let bytes=null;
    const unwrap=value=>Cu?.waiveXrays?Cu.waiveXrays(value):value,reply=text=>{try{const callback=unwrap(complete);if(typeof callback==='function')Reflect.apply(callback,null,[text]);}catch(_){}};
    void Promise.resolve().then(async()=>{
      if(!active()||!canvas||!Number.isInteger(canvas.width)||!Number.isInteger(canvas.height)||canvas.width<1||canvas.height<1||canvas.width>1024||canvas.height>1024||canvas.width*canvas.height>1048576)throw failure();
      try{bytes=await new Promise((resolve,reject)=>{try{canvas.toBlob(exported(blob=>{try{const owned=unwrap(blob),promise=unwrap(owned.arrayBuffer());Promise.resolve(promise).then(buffer=>{try{const value=unwrap(buffer),size=value.byteLength;if(!Number.isInteger(size)||size<1||size>4*1024*1024)throw failure();resolve(new Uint8Array(new Uint8Array(value)));}catch(error){reject(error);}},reject);}catch(error){reject(error);}}),'image/png');}catch(error){reject(error);}});}finally{releaseCanvas(canvas);}
      if(!active())throw failure();const value=await lookupFigure(bytes,{isCurrent:active,setCancel:cancel=>{modelCancel=cancel;}});if(!active())throw failure();bytes.fill(0);bytes=null;reply(JSON.stringify(value));
    }).catch(()=>reply('null')).finally(()=>{releaseCanvas(canvas);bytes?.fill(0);modelCancel=null;});
   }):null;
   const promise=new Promise((resolve,reject)=>{
    rejectDetection=reject;pending.add(request);
    const finish=(error,text,details)=>{if(!pending.delete(request))return;settled=true;if(typeof details==='string'&&details.length<=2048){try{const raw=JSON.parse(details),numbers={};if([60,61].includes(raw?.fieldsReady))modelReady=raw.fieldsReady===61;for(const name of ['opsCount','argsCount','opsReady','viewBoxReady','regions','fieldsReady','detectionMilliseconds','modelMilliseconds','operatorsMilliseconds','geometryMilliseconds','glyphCount','glyphSource','modelCached'])if(Number.isInteger(raw?.[name])&&raw[name]>=-1&&raw[name]<=(['opsCount','argsCount'].includes(name)?500000:name.endsWith('Milliseconds')?60000:100000))numbers[name]=raw[name];reportDiagnostic?.(numbers);}catch(_){}}if(disposed||error||!sameDocument()){reject(failure());return;}try{
      if(typeof text!=='string'||text.length>65536)throw failure();const values=JSON.parse(text);if(!Array.isArray(values)||values.length>64)throw failure();

      const regions=values.map(v=>{const rect=v?.rect;if(!Array.isArray(rect)||rect.length!==4||!rect.every(Number.isFinite)||rect[2]<=rect[0]||rect[3]<=rect[1])throw failure();return {rect:rect.slice(),...(typeof v.label==='string'?{label:v.label.slice(0,80)}:{})};});resolve(regions);
     }catch(_){reject(failure());}};
    try{invoke('detect',[index,glyphJSON(chars),exported((text,details)=>{finish(false,text,details);}),exported((code,details)=>{finish(true,undefined,details||JSON.stringify({fieldsReady:({figure_native:11,figure_input:12,figure_busy:13,figure_stale:14,figure_detect:15})[code]||19}));}),lookup,id]);}catch(_){finish(true);}
   });
   function cancel(){if(settled)return;settled=true;pending.delete(request);try{modelCancel?.();}catch(_){}modelCancel=null;try{if(typeof api.cancelDetection==='function')invoke('cancelDetection',[id],true);}catch(_){}rejectDetection?.(failure());}
   promise.cancel=cancel;Object.defineProperty(promise,'modelReady',{get:()=>modelReady});return promise;
  }
  function render(index,rect,options={}){
   let id=0,canvas=null,settled=false,cancelled=false,rejectRequest,snapshot=false,renderMilliseconds=null;
   const request={reject:()=>cancel()};
   const promise=new Promise((resolve,reject)=>{
    rejectRequest=reject;if(disposed){settled=true;reject(failure());return;}pending.add(request);
    const done=exported((value,metadata)=>{if(cancelled||disposed||settled){releaseCanvas(value);return;}if(!sameDocument()){releaseCanvas(value);fail();return;}
     if(typeof metadata==='string'&&metadata.length<=256)try{const numbers=JSON.parse(metadata);if(numbers&&Object.keys(numbers).length===2&&[0,1].includes(numbers.snapshot)&&Number.isInteger(numbers.renderMilliseconds)&&numbers.renderMilliseconds>=0&&numbers.renderMilliseconds<=3600000){snapshot=numbers.snapshot===1;renderMilliseconds=numbers.renderMilliseconds;}}catch(_){}
     settled=true;pending.delete(request);canvas=value;resolve(value);});
    const fail=exported((code,details)=>{if(settled)return;settled=true;pending.delete(request);try{const value=typeof details==='string'&&details.length<=2048?JSON.parse(details):null;reportDiagnostic?.({fieldsReady:Number.isInteger(value?.fieldsReady)?value.fieldsReady:({figure_native:31,figure_input:32,figure_busy:33})[code]||39});}catch(_){}reject(failure());});
    try{id=invoke('render',[index,rect[0],rect[1],rect[2],rect[3],done,fail,options?.snapshot!==false]);if(!Number.isInteger(id)||id<1)fail();}catch(_){fail();}
   });
   function cancel(){if(cancelled)return;cancelled=true;if(id)try{invoke('cancel',[id],true);}catch(_){}if(canvas)canvas.width=canvas.height=0;if(!settled){settled=true;pending.delete(request);rejectRequest(failure());}}
   return {promise,cancel,get snapshot(){return snapshot;},get renderMilliseconds(){return renderMilliseconds;}};
  }
  return {detect,render,dispose(){if(disposed)return;disposed=true;for(const request of [...pending]){try{request.reject(failure());}catch(_){}}pending.clear();retireSandbox();}};
 }
 const api={create};root.AskGPTPDFFigureBridge=api;if(typeof module!=='undefined')module.exports=api;
})(this);
