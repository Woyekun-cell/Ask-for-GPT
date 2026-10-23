(function(root){
  'use strict';
  // This trusted helper runs in a sandbox bound to the exact PDF viewer.
  // PDF.js objects stay here; only primitive bounds and an owned canvas leave.
  const URI='resource://zotero/reader/pdf/web/viewer.html',MAX_JSON=2097152;
  const app=root.PDFViewerApplication,pdf=app?.pdfDocument,doc=root.document,Region=root.AskGPTPDFFigureRegion;
  const detections=new Set(),jobs=new Map(),layouts=new Map();let disposed=false,nextID=0;
  const finite=n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=10000000;
  function rectangle(value){
    if(!Array.isArray(value)||value.length!==4)return null;const r=[];
    for(let i=0;i<4;i++){if(!finite(value[i]))return null;r.push(value[i]);}
    return r[2]>r[0]&&r[3]>r[1]?r:null;
  }
  function failure(index){
    if(disposed)return 'figure_cancelled';
    if(doc?.documentURI!==URI||root.PDFViewerApplication!==app||!pdf||app?.pdfDocument!==pdf||typeof pdf.getPage!=='function'||typeof Region?.detectRegions!=='function'||typeof Region?.renderCrop!=='function'||!root.pdfjsLib?.OPS)return 'figure_native';
    return !Number.isInteger(index)||!Number.isInteger(pdf.numPages)||pdf.numPages<1||pdf.numPages>2000||index<0||index>=pdf.numPages?'figure_input':null;
  }
  const current=()=>!disposed&&root.PDFViewerApplication===app&&app?.pdfDocument===pdf;
  function call(callback,value,metadata){try{if(typeof callback==='function'){if(metadata===undefined)callback(value);else callback(value,metadata);}}catch(_){} }
  function notify(entry,kind,value,metadata){if(entry.notified)return;entry.notified=true;const callback=entry[kind];entry.done=null;entry.fail=null;call(callback,value,metadata);}
  function glyphs(json){
    if(typeof json!=='string'||json.length>MAX_JSON||/[^\x00-\x7f]/.test(json))return null;
    let values;try{values=JSON.parse(json);}catch(_){return null;}
    if(!Array.isArray(values)||values.length>100000)return null;const result=[];
    for(const value of values){
      if(!value||typeof value.c!=='string'||!/^x{0,32}$/.test(value.c))return null;
      const r=rectangle(value.rect);if(!r)return null;const c={c:value.c,rect:r};
      for(const flag of ['lineBreakAfter','paragraphBreakAfter','ignorable'])if(value[flag]!==undefined){if(typeof value[flag]!=='boolean')return null;c[flag]=value[flag];}
      if(value.rotation!==undefined){if(!finite(value.rotation))return null;c.rotation=value.rotation;}
      result.push(c);
    }
    return result;
  }
  function regionsJSON(values){
    if(!Array.isArray(values)||values.length>64)throw Error('invalid');const result=[];
    for(const value of values){
      const r=rectangle(value?.rect);if(!r)throw Error('invalid');const item={rect:r};
      if(value.label!==undefined){if(typeof value.label!=='string'||value.label.length>80||/[\x00-\x1f]/.test(value.label))throw Error('invalid');item.label=value.label;}
      result.push(item);
    }
    return JSON.stringify(result);
  }
  async function textGlyphs(page){
    if(typeof page.getTextContent!=='function')return [];
    const text=await page.getTextContent(),items=text?.items;if(!items||!Number.isInteger(items.length)||items.length>100000)throw Error('glyphInput');
    const result=[];
    for(let i=0;i<items.length;i++){
      const item=items[i];if(typeof item?.str!=='string'||!item.str)continue;
      const m=item.transform;if(!m||m.length!==6||!Array.from(m).every(finite)||!finite(item.width)||!finite(item.height))throw Error('glyphInput');
      const length=Math.hypot(m[0],m[1]),height=Math.abs(item.height);if(length<1e-8||height<1e-8||item.width<=0)continue;
      const letters=Array.from(item.str);if(result.length+letters.length>100000)throw Error('glyphInput');
      const ux=m[0]/length,uy=m[1]/length,advance=item.width/letters.length;
      for(let k=0;k<letters.length;k++){
        const corners=[];for(const along of [k*advance,(k+1)*advance])for(const across of [0,height])corners.push([m[4]+ux*along-uy*across,m[5]+uy*along+ux*across]);
        const r=rectangle([Math.min(...corners.map(p=>p[0])),Math.min(...corners.map(p=>p[1])),Math.max(...corners.map(p=>p[0])),Math.max(...corners.map(p=>p[1]))]);
        if(r)result.push({c:letters[k].trim()?'x':'',rect:r,rotation:Math.round(Math.atan2(uy,ux)*180/Math.PI),lineBreakAfter:k===letters.length-1});
      }
    }
    return result;
  }
  async function modelLayout(page,index,entry,lookup){
    if(typeof lookup!=='function'||typeof page.getViewport!=='function')return null;
    let timer=null;
    try{
      const box=rectangle(page.view),viewport=page.getViewport({scale:1,rotation:page.rotate??0}),m=viewport?.transform;
      if(!box||!m||m.length!==6||!Array.from(m).every(finite))return null;const matrix=Array.from(m),[a,b,c,d,e,f]=matrix,det=a*d-b*c;if(Math.abs(det)<1e-10)return null;
      const points=[];for(const x of [box[0],box[2]])for(const y of [box[1],box[3]])points.push([a*x+c*y+e,b*x+d*y+f]);
      const bounds=[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
      let pageView;try{pageView=app.pdfViewer?.getPageView?.(index);}catch(_){}
      if(pageView?.renderingState===3&&Math.max(pageView.canvas?.width||0,pageView.canvas?.height||0)>=768)try{entry.canvas=Region.snapshotCrop?.({pageView,rect:box,doc,maxEdge:1024,maxPixels:1048576});if(entry.canvas===pageView.canvas)entry.canvas=null;}catch(_){}
      if(!entry.canvas){entry.task=Region.renderCrop({page,rect:box,doc,maxEdge:1024,maxPixels:1048576});entry.canvas=await entry.task.promise;entry.task=null;}
      if(entry.notified||!current())return null;const canvas=entry.canvas;if(!canvas||canvas.width<1||canvas.height<1||canvas.width>1024||canvas.height>1024||canvas.width*canvas.height>1048576)return null;
      const text=await new Promise(resolve=>{entry.modelDone=resolve;if(typeof root.setTimeout==='function')timer=root.setTimeout(()=>resolve('null'),16000);try{lookup(canvas,value=>{if(entry.notified)return;resolve(typeof value==='string'&&value.length<=65536?value:'null');});}catch(_){resolve('null');}});entry.modelDone=null;
      if(entry.notified||!current())return null;let value;try{value=JSON.parse(text);}catch(_){return null;}if(!value||Object.keys(value).sort().join(',')!=='exclusions,figures'||!Array.isArray(value.figures)||value.figures.length>64||!Array.isArray(value.exclusions)||value.exclusions.length>256)return null;
      const convert=(values,excluded)=>values.map(row=>{const r=rectangle(row?.rect);if(!r||r.some(n=>n<0||n>1)||!finite(row.confidence)||row.confidence<0||row.confidence>1||excluded&&!['caption','text','header'].includes(row.kind))throw Error('invalid');const corners=[];for(const x of [r[0],r[2]])for(const y of [r[1],r[3]]){const vx=bounds[0]+x*(bounds[2]-bounds[0])-e,vy=bounds[1]+y*(bounds[3]-bounds[1])-f;corners.push([(d*vx-c*vy)/det,(-b*vx+a*vy)/det]);}return {rect:[Math.min(...corners.map(p=>p[0])),Math.min(...corners.map(p=>p[1])),Math.max(...corners.map(p=>p[0])),Math.max(...corners.map(p=>p[1]))],confidence:row.confidence,...(excluded?{kind:row.kind}:{})};});
      return {layoutRegions:convert(value.figures,false),excludedRegions:convert(value.exclusions,true)};
    }catch(_){return null;}finally{if(timer!==null)try{root.clearTimeout(timer);}catch(_){}dropCanvas(entry.canvas);entry.canvas=null;if(entry.task)try{entry.task.cancel();}catch(_){}entry.task=null;}
  }
  function detect(index,charsJSON,done,fail,lookup=null,requestID=0){
    const code=failure(index),chars=code?null:glyphs(charsJSON);
    if(code||!chars||typeof done!=='function'||typeof fail!=='function'){call(fail,code||'figure_input');return false;}
    if(detections.size>=4){call(fail,'figure_busy');return false;}
    const entry={done,fail,notified:false,id:requestID,canvas:null,task:null,modelDone:null},started=Date.now(),elapsed=time=>Math.max(0,Math.min(60000,Date.now()-time));let phase=0,stats={};detections.add(entry);
    void Promise.resolve().then(async()=>{
      if(entry.notified)return;
      if(!current()){detections.delete(entry);notify(entry,'fail','figure_stale');return;}
      phase=1;const page=await pdf.getPage(index+1);if(entry.notified)return;phase=2;
      if(!current()){detections.delete(entry);notify(entry,'fail','figure_stale');return;}
      // Both inputs belong to PDF.js/the short-lived model request. Load them
      // together so a complex vector page does not add its worker delay after
      // inference has already finished; neither result is published early.
      const operatorStarted=Date.now(),operatorTask=Promise.resolve().then(()=>page.getOperatorList({annotationMode:0})).then(list=>{stats.operatorsMilliseconds=elapsed(operatorStarted);return {list};},()=>({failed:true})),glyphTask=chars.length?Promise.resolve({chars}):textGlyphs(page).then(chars=>({chars}),()=>({failed:true})),modelStarted=Date.now();
      let layout=layouts.get(index);stats.modelCached=Number(Boolean(layout));
      if(layout){layouts.delete(index);layouts.set(index,layout);}else{layout=await modelLayout(page,index,entry,lookup);if(layout&&!entry.notified&&current()){layouts.set(index,layout);while(layouts.size>2)layouts.delete(layouts.keys().next().value);}}
      stats.modelMilliseconds=elapsed(modelStarted);if(entry.notified)return;if(!current()){detections.delete(entry);notify(entry,'fail','figure_stale');return;}
      phase=3;const loaded=await operatorTask;if(loaded.failed)throw Error('operatorRead');const list=loaded.list;if(entry.notified)return;phase=4;
      const text=await glyphTask;if(entry.notified)return;if(text.failed)throw Error('glyphRead');const readyChars=text.chars;stats.glyphCount=readyChars.length;stats.glyphSource=chars.length?2:1;
      if(!current()){detections.delete(entry);notify(entry,'fail','figure_stale');return;}
      const fnCount=list?.fnArray?.length,argCount=list?.argsArray?.length;stats={...stats,opsCount:Number.isInteger(fnCount)?fnCount:-1,argsCount:Number.isInteger(argCount)?argCount:-1};phase=5;
      if(!Number.isInteger(fnCount)||!Number.isInteger(argCount)||fnCount<0||fnCount>500000||fnCount!==argCount)throw Error('invalid');
      phase=6;const geometryStarted=Date.now(),ops=root.pdfjsLib.OPS,viewBox=page.view,values=Region.detectRegions(list,ops,{viewBox,chars:readyChars,...(layout||{})}),json=regionsJSON(values);stats.geometryMilliseconds=elapsed(geometryStarted);stats.detectionMilliseconds=elapsed(started);
      const count=value=>Number.isInteger(value)&&value>=0?value:-1;
      const metadata=JSON.stringify({...stats,opsCount:count(list?.fnArray?.length),argsCount:count(list?.argsArray?.length),opsReady:Number(Number.isInteger(ops?.save)&&Number.isInteger(ops?.constructPath)),viewBoxReady:Number(Boolean(rectangle(viewBox))),regions:values.length,...(typeof lookup==='function'?{fieldsReady:layout?61:60}:{})});
      detections.delete(entry);notify(entry,'done',json,metadata);
    }).catch(()=>{detections.delete(entry);notify(entry,'fail','figure_detect',JSON.stringify({...stats,fieldsReady:phase}));});
    return true;
  }
  function dropCanvas(canvas){try{if(canvas){canvas.width=0;canvas.height=0;}}catch(_){} }
  function release(entry){
    if(entry.task&&!entry.taskCancelled){entry.taskCancelled=true;try{entry.task.cancel();}catch(_){} }
    entry.task=null;dropCanvas(entry.canvas);entry.canvas=null;
  }
  function retire(id,entry,code,phase){jobs.delete(id);release(entry);notify(entry,'fail',code,JSON.stringify({fieldsReady:Number.isInteger(phase)?phase:19}));}
  function render(index,x0,y0,x1,y1,done,fail,preferSnapshot=true){
    const code=failure(index),rect=rectangle([x0,y0,x1,y1]);
    if(code||!rect||typeof done!=='function'||typeof fail!=='function'||typeof preferSnapshot!=='boolean'){call(fail,code||'figure_input');return 0;}
    // Only pending native jobs count toward the allocation limit.
    if(jobs.size>=2){call(fail,'figure_busy');return 0;}
    do{nextID=nextID>=2147483647?1:nextID+1;}while(jobs.has(nextID));
    const id=nextID,started=Date.now(),entry={done,fail,notified:false,task:null,canvas:null,taskCancelled:false};jobs.set(id,entry);
    const active=()=>jobs.get(id)===entry&&current();
    function publish(canvas,snapshot){
      if(jobs.get(id)!==entry){dropCanvas(canvas);return;}
      entry.canvas=canvas;
      if(!active()){retire(id,entry,'figure_stale');return;}
      if(!canvas||!Number.isInteger(canvas.width)||!Number.isInteger(canvas.height)||canvas.width<1||canvas.height<1||canvas.width>4096||canvas.height>4096||canvas.width*canvas.height>12000000){retire(id,entry,'figure_render');return;}
      // Transfer ownership before the callback; native disposal must not erase
      // pixels already handed to a Preview window.
      jobs.delete(id);entry.task=null;entry.canvas=null;
      notify(entry,'done',canvas,JSON.stringify({snapshot:Number(snapshot),renderMilliseconds:Math.max(0,Math.min(3600000,Date.now()-started))}));
    }
    void Promise.resolve().then(async()=>{
      if(jobs.get(id)!==entry)return;
      if(!active()){retire(id,entry,'figure_stale');return;}
      let pageView;try{pageView=app.pdfViewer?.getPageView?.(index);}catch(_){}
      if(preferSnapshot&&typeof Region.snapshotCrop==='function'){
        let canvas=null;try{canvas=Region.snapshotCrop({pageView,rect,doc});}catch(_){}
        if(canvas&&canvas!==pageView?.canvas){publish(canvas,true);return;}
      }
      const page=await pdf.getPage(index+1);if(jobs.get(id)!==entry)return;
      if(!active()){retire(id,entry,'figure_stale');return;}
      entry.task=Region.renderCrop({page,pageView,rect,doc});
      const canvas=await entry.task.promise;
      publish(canvas,false);
    }).catch(error=>{if(jobs.get(id)===entry)retire(id,entry,'figure_render',error?.figurePhase);});
    return id;
  }
  function cancel(id){const entry=jobs.get(id);if(!entry)return false;retire(id,entry,'figure_cancelled');return true;}
  function cancelDetection(id){for(const entry of detections)if(entry.id===id){detections.delete(entry);entry.modelDone?.('null');entry.modelDone=null;release(entry);notify(entry,'fail','figure_cancelled');return true;}return false;}
  function dispose(){
    if(disposed)return;disposed=true;layouts.clear();
    for(const entry of detections){detections.delete(entry);entry.modelDone?.('null');entry.modelDone=null;release(entry);notify(entry,'fail','figure_cancelled');}
    for(const [id,entry] of jobs)retire(id,entry,'figure_cancelled');
    try{if(root.AskGPTPDFFigureNative===api)delete root.AskGPTPDFFigureNative;}catch(_){}
  }
  const api={detect,render,cancel,cancelDetection,dispose};root.AskGPTPDFFigureNative=api;
})(this);
