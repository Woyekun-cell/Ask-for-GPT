(function(root){
 'use strict';
 const DefaultRegion=root.AskGPTPDFFigureRegion;
 const finite=n=>typeof n==='number'&&Number.isFinite(n);
 const rectangle=r=>r&&[r[0],r[1],r[2],r[3]].every(finite)&&r[2]>r[0]&&r[3]>r[1]?[r[0],r[1],r[2],r[3]]:null;
 const contains=(r,p)=>r&&p&&p[0]>=r[0]&&p[0]<=r[2]&&p[1]>=r[1]&&p[1]<=r[3];
 const keyboardGroups=new WeakMap(),isSpace=event=>event?.key===' '||event?.code==='Space';
 function drainNative(group){
  if(!group)return;
  for(let i=group.nativeQueue.length-1;i>=0;i--){const job=group.nativeQueue[i];if(job.cancelled||!job.valid()){group.nativeQueue.splice(i,1);job.reject(Error('warmStale'));}}
  if(group.nativeActive)return;
  group.nativeQueue.sort((a,b)=>Number(a.warm)-Number(b.warm));const job=group.nativeQueue.shift();
  if(!job){if(!group.members.size)keyboardGroups.delete(group.rootWindow);return;}
  group.nativeActive=job;
  void Promise.resolve().then(()=>{if(job.cancelled||!job.valid())throw Error('warmStale');return job.run();}).then(job.resolve,job.reject).finally(()=>{if(group.nativeActive===job)group.nativeActive=null;drainNative(group);});
 }
 function install(view,options={}){
  const win=view?._iframeWindow,doc=win?.document,app=win?.PDFViewerApplication,viewer=app?.pdfViewer,Region=options.region||DefaultRegion,removers=[],cache=new Map(),glyphIDs=new WeakMap();let glyphSequence=0;
  let lastReport='';let disposed=false,epoch=0,pointer=null,pointerRevision=0,spaceHeld=false,spaceRequest=null,down=null,selector=null,selectionStart=null,pending=null,toast=null,toastTimer=null,warmTimer=null,warmRetries=0,keyboard=null,keyboardMember=null,cacheDocument=app?.pdfDocument;
  function report(stage,detail,figureNumbers){const key=stage+':'+(detail||'');if(key===lastReport)return;lastReport=key;try{options.reportDiagnostic?.(stage,{name:'FigureDiagnostic',code:'rendered',errorDetail:detail,figureNumbers});}catch(_){}}
  const enabled=()=>!disposed&&(typeof options.enabled!=='function'||options.enabled());
  const wrap=fn=>{const handler=(...args)=>{try{return fn(...args);}catch(_){report('figureEventError');return null;}};return options.exportCallback?options.exportCallback(handler):handler;};
  function listen(target,type,fn,capture=false){if(!target?.addEventListener)return;const handler=wrap(fn);target.addEventListener(type,handler,capture);removers.push(()=>target.removeEventListener(type,handler,capture));}
  function node(tag,kind){const n=doc.createElementNS('http://www.w3.org/1999/xhtml',tag);n.setAttribute('data-askgpt-figure-reader',kind);return n;}
  function message(text){toast?.remove();if(toastTimer!==null)win.clearTimeout(toastTimer);toast=node('div','status');toast.textContent=text;toast.setAttribute('role','status');toast.setAttribute('style','position:fixed;bottom:30px;left:50%;transform:translateX(-50%);z-index:2147482800;padding:9px 14px;border-radius:9px;background:Canvas;color:CanvasText;border:1px solid #8886;box-shadow:0 3px 15px #0002;font:13px -apple-system,sans-serif;pointer-events:none');doc.body.appendChild(toast);toastTimer=win.setTimeout(wrap(()=>{toast?.remove();toast=null;toastTimer=null;}),2600);}
  function nativeSelection(){const ranges=view._selectionRanges;if(!ranges)return false;if(!Number.isInteger(ranges.length)||ranges.length>1000)return true;for(let i=0;i<ranges.length;i++)if(ranges[i]?.collapsed!==true)return true;return false;}
  function blocked(event,forClick=false,allowTextSelection=false,fromKeyboard=false){
   if(!enabled()){report('figureBlocked','figureInactive');return true;}if(event?.altKey||event?.ctrlKey||event?.metaKey||event?.shiftKey||event?.buttons||event?.pointerType&&event.pointerType!=='mouse'){report('figureBlocked','figureInput');return true;}
   try{
    const selection=win.getSelection?.();if(!allowTextSelection&&(selection?.isCollapsed===false||nativeSelection())||view._selectionPopup?.annotation||view._annotationPopup?.annotation||view._overlayPopup||view._focusedObject){report('figureBlocked','figureSelection');return true;}
    if(view._tool?.type&&!['pointer','hand','highlight','underline'].includes(view._tool.type)){report('figureBlocked','figureTool');return true;}
    const target=event?.target||doc.activeElement;let toolbar=false;if(fromKeyboard&&target?.ownerDocument&&target.ownerDocument!==doc)for(let n=target,i=0;n&&i<24;i++,n=n.parentNode)if(n.getAttribute?.('role')==='toolbar'||/toolbar/.test(String(n.className||'')))toolbar=true;
    let n=target;for(let i=0;n&&i<24;i++,n=n.parentNode){const tag=String(n.localName||n.tagName||'').toLowerCase();if(['input','textarea','select'].includes(tag)||!toolbar&&['button','a'].includes(tag)||n.isContentEditable||n.getAttribute?.('role')==='textbox'||/annotation|popup|overlay/.test(String(n.className||''))){report('figureBlocked','figureTarget');return true;}}
    return Boolean(forClick&&(event?.button!==0||event?.detail>1));
   }catch(_){return true;}
  }
  function geometry(index){
   const pageView=viewer?.getPageView?.(index),viewport=pageView?.viewport,canvas=pageView?.canvas||pageView?.div,box=canvas?.getBoundingClientRect?.();
   if(!viewport||!box||![box.left,box.top,box.width,box.height,viewport.width,viewport.height].every(finite)||box.width<=0||box.height<=0||viewport.width<=0||viewport.height<=0)return null;
   return {pageView,viewport,box,x:box.width/viewport.width,y:box.height/viewport.height};
  }
  function at(event,indexOverride){
   if(!finite(event?.clientX)||!finite(event?.clientY))return null;
   let n=event.target;for(let i=0;n&&i<30;i++,n=n.parentNode)if(n.getAttribute?.('data-page-number'))break;
   const index=indexOverride??(Number(n?.getAttribute?.('data-page-number'))-1);if(!Number.isInteger(index)||index<0||index>1999)return null;
   const g=geometry(index);if(!g)return null;
   const x=(event.clientX-g.box.left)/g.x,y=(event.clientY-g.box.top)/g.y;if(x<0||y<0||x>g.viewport.width||y>g.viewport.height)return null;
   const raw=g.viewport.convertToPdfPoint(x,y),point=raw&&[raw[0],raw[1]];return point?.every(finite)?{index,point,document:app.pdfDocument,...g}:null;
  }
  function glyphHit(hit){const chars=view._pdfPages?.[hit.index]?.chars;if(!chars||chars.length>100000)return false;let left=null,right=null;for(let i=0;i<chars.length;i++){if(!String(chars[i]?.c||'').trim())continue;const r=rectangle(chars[i]?.rect);if(!r)continue;if(contains(r,hit.point))return true;if(hit.point[1]<r[1]-1||hit.point[1]>r[3]+1)continue;if(r[2]<hit.point[0]&&(!left||r[2]>left[2]))left=r;if(r[0]>hit.point[0]&&(!right||r[0]<right[0]))right=r;}return Boolean(left&&right&&right[0]-left[2]<=Math.min(18,Math.max(3,Math.min(left[3]-left[1],right[3]-right[1])*.9)));}
  function numericOperators(value,ops,Cu){
   const unwrap=v=>v&&Cu?.waiveXrays?Cu.waiveXrays(v):v,raw=unwrap(value),functions=unwrap(raw?.fnArray),argumentsList=unwrap(raw?.argsArray);
   if(!Number.isInteger(functions?.length)||functions.length>500000||argumentsList?.length!==functions.length){report('figureOperatorShape',undefined,{opsCount:functions?.length,argsCount:argumentsList?.length,thenReady:Number(typeof raw?.then==='function'),fieldsReady:Number(Boolean(raw&&Object.prototype.hasOwnProperty.call(raw,'fnArray')))});throw Error('operatorShape');}
   const fnArray=[],argsArray=[],copy=(v,count)=>{v=unwrap(v);if(!v||v.length!==count)return null;const out=[];for(let k=0;k<count;k++){if(!finite(v[k]))return null;out.push(v[k]);}return out;};
   for(let i=0;i<functions.length;i++){
    const code=functions[i],a=unwrap(argumentsList[i]);if(!Number.isInteger(code))throw Error('operatorShape');fnArray.push(code);
    if(code===ops.transform)argsArray.push(copy(a,6)||[]);
    else if(code===ops.constructPath)argsArray.push([a?.[0],null,copy(a?.[2],4)]);
    else if(code===ops.paintFormXObjectBegin)argsArray.push([a?.[0]==null?null:copy(a[0],6),a?.[1]==null?null:copy(a[1],4)]);
    else if(code===ops.beginGroup)argsArray.push([{matrix:a?.[0]?.matrix==null?null:copy(a[0].matrix,6),bbox:copy(a?.[0]?.bbox,4)}]);
    else if([ops.paintImageXObject,ops.paintInlineImageXObject,ops.paintImageMaskXObject].includes(code))argsArray.push([true]);else argsArray.push([]);
   }
   return {fnArray,argsArray};
  }
  function operatorResult(pending,ops,Cu){
   return new Promise((resolve,reject)=>{
    const done=value=>{try{resolve(numericOperators(value,ops,Cu));}catch(error){reject(error);}},fail=()=>reject(Error('operatorRead'));
    try{const native=Cu?.waiveXrays?Cu.waiveXrays(pending):pending;if(typeof native?.then==='function')Reflect.apply(native.then,native,[options.exportCallback?options.exportCallback(done):done,options.exportCallback?options.exportCallback(fail):fail]);else done(native);}catch(_){fail();}
   });
  }
  const inputCount=chars=>chars&&Number.isInteger(chars.length)&&chars.length<=100000?chars.length:0;
  function glyphIdentity(chars){if(!chars||typeof chars!=='object')return 0;let id=glyphIDs.get(chars);if(!id){id=++glyphSequence;glyphIDs.set(chars,id);}return id;}
  function changedGlyphs(index,item){const chars=view._pdfPages?.[index]?.chars,count=inputCount(chars);return count>0&&(glyphIdentity(chars)!==item.glyphIdentity||count!==item.glyphCount);}
  function warmAllowed(index){
   if(!keyboard||!enabled()||win.document!==doc||doc.hidden===true||(viewer.currentPageNumber||1)-1!==index||Date.now()<keyboard.quietUntil)return false;
   if(!keyboard.warmOwner?.available())keyboard.warmOwner=[...keyboard.members].find(member=>member.available());
   return keyboard.warmOwner===keyboardMember;
  }
  function nativeOperators(index,item,current,warm=false){
   item.regions=null;item.nativePending=true;
   const group=keyboard,job={warm,cancelled:false,valid:()=>current()&&(!job.warm||warmAllowed(index))};
   const task=new Promise((resolve,reject)=>{job.resolve=resolve;job.reject=reject;});
   // Retiring cached input does not abort an already started CPU model. Keep
   // its queue slot until it settles, while current() prevents late publication.
   task.cancel=()=>{job.cancelled=true;drainNative(group);};item.task=task;item.nativeJob=job;
   job.run=async()=>{
    for(let attempt=0;attempt<3;attempt++){
     if(!current())return item;
     const chars=view._pdfPages?.[index]?.chars;item.glyphIdentity=glyphIdentity(chars);item.glyphCount=inputCount(chars);
     const request=options.nativeBridge.detect(index,chars),regions=await request;if(!current())return item;
     // Prewarming can finish before Zotero publishes its real glyph array.
     // Refine with that late input before publishing any first-frame crop.
     if(changedGlyphs(index,item))continue;
     if(!Array.isArray(regions))throw Error('regions');item.regions=regions;item.retryAt=request?.modelReady===false?Date.now()+5000:null;report(regions.length?'figureDetected':'figureNoRegions',undefined,{regions:regions.length});return item;
    }
    throw Error('glyphChanged');
   };
   item.promise=task.catch(error=>{if(current()){item.regions=[];item.failed=true;if(error?.message!=='warmStale')report('figureOperatorError');cache.delete(index);}return item;}).finally(()=>{item.nativePending=false;item.task=null;item.nativeJob=null;if(item.regions===null&&cache.get(index)===item)cache.delete(index);});
   group.nativeQueue.push(job);drainNative(group);return item;
  }
  function operators(index,warm=false){
   if(cacheDocument!==app.pdfDocument){resetCache();cacheDocument=app.pdfDocument;}
   const cached=cache.get(index);if(cached?.document===app.pdfDocument&&(!cached.retryAt||Date.now()<cached.retryAt)){cache.delete(index);cache.set(index,cached);if(!warm&&cached.nativeJob){cached.nativeJob.warm=false;drainNative(keyboard);}if(options.nativeBridge&&!cached.nativePending&&changedGlyphs(index,cached)){const generation=epoch;return nativeOperators(index,cached,()=>!disposed&&generation===epoch&&cache.get(index)===cached&&app.pdfDocument===cached.document,warm);}return cached;}if(cached)cache.delete(index);const generation=epoch,item={regions:null,page:null,promise:null,task:null,retryAt:null,document:app.pdfDocument};cache.set(index,item);
   // Only two pages' numeric bounds are retained; operator lists stay with PDF.js.
   while(cache.size>2){const key=cache.keys().next().value;try{cache.get(key)?.task?.cancel?.();}catch(_){}cache.delete(key);}
   const current=()=>!disposed&&generation===epoch&&cache.get(index)===item&&app.pdfDocument===item.document;
   if(options.nativeBridge){
    return nativeOperators(index,item,current,warm);
   }
   item.promise=Promise.resolve().then(()=>current()?item.document.getPage(index+1):null).then(async page=>{
    if(!page||!current())return item;
    const c=options.Components,local=c?.utils?.waiveXrays?c.utils.waiveXrays(page):page;
    const args={annotationMode:0},settings=c?.utils?.cloneInto?c.utils.cloneInto(args,win):args;
    const namespace=win.pdfjsLib,library=namespace&&c?.utils?.waiveXrays?c.utils.waiveXrays(namespace):namespace,ops=library?.OPS;
    if(!ops)throw Error('operatorCodes');const list=await operatorResult(local.getOperatorList(settings),ops,c?.utils);if(!current())return item;
    const data=view._pdfPages?.[index],box=rectangle(data?.viewBox)||rectangle(local.view);item.page=page;
    item.regions=Region?.detectRegions(list,ops,{viewBox:box,chars:data?.chars})||[];
    report(item.regions.length?'figureDetected':'figureNoRegions',undefined,{opsCount:list?.fnArray?.length,argsCount:list?.argsArray?.length,opsReady:Number(Number.isInteger(ops?.save)&&Number.isInteger(ops?.constructPath)),viewBoxReady:Number(Boolean(box)),regions:item.regions.length});
    return item;
   }).catch(()=>{item.regions=[];item.failed=true;if(!lastReport.startsWith('figureOperatorShape'))report('figureOperatorError');return item;});return item;
  }
  function displaySize(hit,rect){
   try{
    const rotation=hit.viewport?.rotation,intrinsic=hit.pageView?.pdfPage?.rotate;if(!finite(rotation)||!finite(intrinsic)||rotation%90||intrinsic%90||!finite(hit.x)||!finite(hit.y))return {};
    const points=[[rect[0],rect[1]],[rect[2],rect[1]],[rect[0],rect[3]],[rect[2],rect[3]]].map(p=>hit.viewport.convertToViewportPoint(p[0],p[1]));if(points.some(p=>!p||!finite(p[0])||!finite(p[1])))return {};
    let width=(Math.max(...points.map(p=>p[0]))-Math.min(...points.map(p=>p[0])))*hit.x,height=(Math.max(...points.map(p=>p[1]))-Math.min(...points.map(p=>p[1])))*hit.y;
    if(((rotation-intrinsic)%180+180)%180===90)[width,height]=[height,width];return finite(width)&&finite(height)&&width>0&&height>0?{displayWidth:width,displayHeight:height}:{};
   }catch(_){return {};}
  }
  function invoke(hit,item,region,requestedAt=Date.now(),inputKind=0,cacheReady=0){if(!enabled()||!region||win.document!==doc||app.pdfDocument!==item.document)return false;const rect=rectangle(region.rect);if(!rect)return false;const size=displaySize(hit,rect);try{options.reportDiagnostic?.('figureInputTiming',{name:'FigureDiagnostic',code:'rendered',figureNumbers:{waitMilliseconds:Math.max(0,Math.min(60000,Date.now()-requestedAt)),inputKind,cacheReady}});options.reportDiagnostic?.('figureOpened',{name:'FigureDiagnostic',code:'rendered',figureNumbers:{width:Math.round(size.displayWidth||0),height:Math.round(size.displayHeight||0)}});}catch(_){}void Promise.resolve(options.onOpen?.({page:item.page,pageView:hit.pageView,index:hit.index,rect,label:region.label||'图片预览',view,requestedAt,...size})).catch(()=>{if(enabled())message('图片暂时无法打开，请重试');});return true;}
  async function click(event){
   const requestedAt=Date.now();report('figureClick');if(event.defaultPrevented){report('figureBlocked','figurePrevented');return;}if(blocked(event,true))return;const hit=at(event);if(!hit){report('figureBlocked','figurePoint');return;}if(glyphHit(hit)){report('figureBlocked','figureGlyph');return;}if(down&&Math.hypot(event.clientX-down.x,event.clientY-down.y)>5){report('figureBlocked','figureDrag');return;}
   const request={hit,x:event.clientX,y:event.clientY};pending=request;const item=operators(hit.index),cacheReady=Number(Array.isArray(item.regions));await item.promise;if(!enabled()||pending!==request||blocked(event,true)||glyphHit(hit)||!Array.isArray(item.regions))return;pending=null;
   const region=Region?.hitRegion(item.regions,hit.point);if(region)invoke(hit,item,region,requestedAt,1,cacheReady);else report('figureMiss');
  }
  function setPointer(hit){if(!pointer||!hit||pointer.document!==hit.document||pointer.index!==hit.index||pointer.point[0]!==hit.point[0]||pointer.point[1]!==hit.point[1]){pointerRevision++;spaceRequest=null;}pointer=hit;if(keyboard){if(hit)keyboard.owner=keyboardMember;else if(keyboard.owner===keyboardMember)keyboard.owner=null;}}
  function preferPane(){if(keyboard&&keyboard.warmOwner!==keyboardMember){keyboard.warmOwner=keyboardMember;scheduleWarm();}}
  function move(event){if(keyboard)keyboard.owner=null;if(blocked(event,false,true)){setPointer(null);return;}const hit=at(event);setPointer(hit);if(hit)preferPane();}
  function key(event){
   const requestedAt=Date.now();
   if(selector&&event.key==='Escape'){cancelSelect();event.preventDefault();event.stopImmediatePropagation();return;}
   if(event.defaultPrevented||!isSpace(event)||blocked(event,false,true,true)||!pointer||win.document!==doc||pointer.document!==app.pdfDocument)return false;
   const hit=pointer;if(glyphHit(hit))return;const item=operators(hit.index),region=item.regions&&Region?.hitRegion(item.regions,hit.point);if(!region&&item.regions!==null)return;
   // Detection can still be pending on a first hover. Claim Space synchronously
   // so PDF.js cannot scroll away before the image bounds arrive.
   event.preventDefault();event.stopImmediatePropagation();if(spaceHeld||event.repeat)return true;spaceHeld=true;
   if(region){invoke(hit,item,region,requestedAt,2,1);return true;}if(spaceRequest?.item===item&&spaceRequest?.revision===pointerRevision)return true;
   const request={hit,item,revision:pointerRevision};spaceRequest=request;
   void item.promise.then(()=>{if(spaceRequest!==request||!enabled()||win.document!==doc||pointerRevision!==request.revision||app.pdfDocument!==item.document||blocked(event,false,true,true)||glyphHit(hit))return;spaceRequest=null;const ready=Region?.hitRegion(item.regions,hit.point);if(ready)invoke(hit,item,ready,requestedAt,2,0);}).catch(()=>{if(spaceRequest===request)spaceRequest=null;});return true;
  }
  async function previewCurrent(){
   const requestedAt=Date.now();if(!enabled())return false;report('figureToolbar');const index=(viewer.currentPageNumber||1)-1,g=geometry(index);if(!g)return false;const generation=epoch,item=operators(index);await item.promise;
   if(!enabled()||generation!==epoch||app.pdfDocument!==item.document)return false;const region=item.regions?.[0];if(!region){message(item.failed?'图形读取失败，请稍后重试':'本页未识别到可预览的图片');if(!item.failed)report('figureNoRegions');return false;}
   return invoke({index,...g},item,region,requestedAt);
  }
  function cancelSelect(){const old=selector;selector=null;selectionStart=null;try{old?.remove();}catch(_){}}
  function selectRegion(){
   if(!enabled()||!doc?.body)return false;cancelSelect();setPointer(null);spaceHeld=false;down=null;
   selector=node('div','selector');selector.setAttribute('tabindex','-1');selector.setAttribute('aria-label','框选图片范围');selector.setAttribute('style','position:fixed;inset:0;z-index:2147482700;cursor:crosshair;background:rgb(0 0 0 / 8%);touch-action:none;');
   const tip=node('div','hint');tip.textContent='拖出图片范围 · Esc 取消';tip.setAttribute('style','position:absolute;left:50%;top:12px;transform:translateX(-50%);padding:7px 12px;border-radius:8px;background:Canvas;color:CanvasText;font:13px -apple-system,sans-serif;pointer-events:none;');selector.appendChild(tip);
   const box=node('div','box');box.setAttribute('style','position:fixed;display:none;border:2px solid #007aff;background:rgb(0 122 255 / 8%);pointer-events:none;box-sizing:border-box');selector.appendChild(box);
   const selectDown=wrap(event=>{if(event.button!==0)return;let target;selector.style.setProperty('pointer-events','none');try{target=doc.elementFromPoint?.(event.clientX,event.clientY);}finally{selector.style.removeProperty('pointer-events');}let hit=target&&at({target,clientX:event.clientX,clientY:event.clientY});if(!hit){const index=(viewer.currentPageNumber||1)-1;for(let n=Math.max(0,index-3);n<=Math.min(1999,index+3);n++){hit=at(event,n);if(hit)break;}}if(!hit)return;selectionStart={hit,x:event.clientX,y:event.clientY};selector.setPointerCapture?.(event.pointerId);event.preventDefault();event.stopImmediatePropagation();});
   const selectMove=wrap(event=>{if(!selectionStart)return;for(const [name,value] of [['left',Math.min(selectionStart.x,event.clientX)],['top',Math.min(selectionStart.y,event.clientY)],['width',Math.abs(selectionStart.x-event.clientX)],['height',Math.abs(selectionStart.y-event.clientY)]])box.style.setProperty(name,value+'px');box.style.setProperty('display','block');event.preventDefault();});
   const selectUp=wrap(event=>{const start=selectionStart,hit=start&&at(event,start.hit.index);cancelSelect();if(!start||!hit||Math.hypot(event.clientX-start.x,event.clientY-start.y)<12)return;event.preventDefault();const a=start.hit.point,b=hit.point,rect=[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])].map(n=>Math.round(n*4)/4);if(!rectangle(rect))return;const generation=epoch,item=operators(hit.index);void item.promise.then(()=>{if(enabled()&&generation===epoch)invoke(hit,item,{rect,label:'框选图片'});});});
   selector.addEventListener('pointerdown',selectDown,true);selector.addEventListener('pointermove',selectMove,true);selector.addEventListener('pointerup',selectUp,true);
   doc.body.appendChild(selector);selector.focus?.({preventScroll:true});return true;
  }
  function resetCache(){epoch++;for(const item of cache.values())try{item.task?.cancel?.();}catch(_){}cache.clear();}
  function clear(){setPointer(null);spaceHeld=false;spaceRequest=null;down=null;pending=null;cancelSelect();}
  function installKeyboard(){
   let owner;try{owner=view._options?.container?.ownerDocument?.defaultView||win.parent||win;}catch(_){owner=win;}if(!owner?.addEventListener)owner=win;
   let group=keyboardGroups.get(owner);if(!group){group={rootWindow:owner,owner:null,claimed:false,members:new Set(),surfaces:new Map(),nativeActive:null,nativeQueue:[],warmOwner:null,quietUntil:Date.now()+600};keyboardGroups.set(owner,group);}keyboard=group;keyboardMember={key,release:()=>{spaceHeld=false;},available:()=>enabled()&&win.document===doc&&doc.hidden!==true,scheduleWarm};group.members.add(keyboardMember);if(!group.warmOwner?.available())group.warmOwner=keyboardMember;
   // Keyboard focus and hover can belong to different PDF iframes. Route the
   // original event synchronously; redispatching a synthetic key is too late.
   const surfaces=new Set([win,owner]);try{let parent=win.parent;for(let i=0;parent&&i<8;i++){surfaces.add(parent);if(parent===owner||parent===parent.parent)break;parent=parent.parent;}}catch(_){}
   for(const surface of surfaces){if(!surface?.addEventListener)continue;let entry=group.surfaces.get(surface);if(!entry){entry={refs:0,handlers:[]};group.surfaces.set(surface,entry);for(const type of ['keydown','keypress','keyup']){let handler=event=>{if(!isSpace(event))return;if(type==='keydown'){if(!event.repeat&&group.claimed){group.claimed=false;for(const member of group.members)member.release();}if(group.claimed&&event.repeat){event.preventDefault();event.stopImmediatePropagation();return;}try{if(group.owner?.key(event))group.claimed=true;}catch(_){}}else if(group.claimed){event.preventDefault();event.stopImmediatePropagation();if(type==='keyup'){group.claimed=false;for(const member of group.members)member.release();}}};try{if(options.Components?.utils?.exportFunction)handler=options.Components.utils.exportFunction(handler,surface);}catch(_){}surface.addEventListener(type,handler,true);entry.handlers.push([type,handler]);}if(surface===owner&&surface!==win){let handler=()=>{group.owner=null;};try{if(options.Components?.utils?.exportFunction)handler=options.Components.utils.exportFunction(handler,surface);}catch(_){}surface.addEventListener('pointermove',handler,true);entry.handlers.push(['pointermove',handler]);}}entry.refs++;}
   removers.push(()=>{if(group.owner===keyboardMember)group.owner=null;if(group.warmOwner===keyboardMember)group.warmOwner=null;group.members.delete(keyboardMember);for(const surface of surfaces){const entry=group.surfaces.get(surface);if(!entry||--entry.refs>0)continue;for(const [type,handler] of entry.handlers)try{surface.removeEventListener(type,handler,true);}catch(_){}group.surfaces.delete(surface);}if(!group.members.size)group.claimed=false;drainNative(group);keyboard=null;keyboardMember=null;});
  }
  function deferWarm(){
   clear();if(!keyboard)return;keyboard.quietUntil=Date.now()+600;for(const member of keyboard.members)member.scheduleWarm();drainNative(keyboard);
  }
  function scheduleWarm(retry=false){
   if(!options.prewarm||!options.nativeBridge||disposed)return;if(warmTimer!==null)win.clearTimeout(warmTimer);
   if(retry!==true)warmRetries=0;
   warmTimer=win.setTimeout(wrap(()=>{warmTimer=null;const index=(viewer.currentPageNumber||1)-1;if(!warmAllowed(index))return;const g=geometry(index),height=win.innerHeight||doc.documentElement?.clientHeight;if(!g||g.pageView?.renderingState!==3){if(warmRetries++<8)scheduleWarm(true);return;}if(finite(height)&&height>0&&(g.box.top>=height||g.box.top+g.box.height<=0))return;warmRetries=0;operators(index,true);}),Math.max(retry===true?240:120,(keyboard?.quietUntil||0)-Date.now()));
  }
  if(win&&doc&&viewer&&Region){installKeyboard();listen(win,'pointerdown',event=>{preferPane();pending=null;spaceRequest=null;down={x:event.clientX,y:event.clientY};},true);listen(win,'click',click,false);listen(win,'pointermove',move,true);listen(win,'keydown',event=>{if(event.key==='Escape')key(event);},true);listen(win,'wheel',()=>{preferPane();deferWarm();},true);listen(win,'resize',deferWarm,true);for(const type of ['blur','pointerleave'])listen(win,type,event=>{if(event.target===win||event.target===doc||event.target===doc.documentElement)clear();},true);listen(doc,'selectionchange',()=>{if(win.getSelection?.()?.isCollapsed===false)setPointer(null);},true);const scroll=doc.getElementById?.('viewerContainer');listen(scroll,'scroll',deferWarm,true);listen(win,'focus',()=>{preferPane();scheduleWarm();},true);listen(doc,'visibilitychange',scheduleWarm);const bus=app.eventBus,on=bus?.on||bus?._on,off=bus?.off||bus?._off;if(typeof on==='function'&&typeof off==='function')for(const type of ['pagerendered','pagechanging']){const handler=wrap(type==='pagechanging'?deferWarm:scheduleWarm);Reflect.apply(on,bus,[type,handler]);removers.push(()=>Reflect.apply(off,bus,[type,handler]));}scheduleWarm();}
  report('figureAttached');return {selectRegion,previewCurrent,clear,message,dispose(){if(disposed)return;disposed=true;clear();resetCache();if(warmTimer!==null){win.clearTimeout(warmTimer);warmTimer=null;}for(const remove of removers.splice(0)){try{remove();}catch(_){}}try{if(toastTimer!==null)win.clearTimeout(toastTimer);}catch(_){}try{toast?.remove();}catch(_){}toast=null;}};
 }
 const api={install};root.AskGPTPDFFigureReader=api;if(typeof module!=='undefined')module.exports=api;
})(this);
