(function(root){
  'use strict';
  const SVG='http://www.w3.org/2000/svg';
  // Official Zotero macOS menu icon paths; local reader content cannot load chrome: images.
  const NATIVE_ICONS={"export":{"viewBox":"0 0 16 16","paths":["M12.2888 7.43708V11.2901C12.2888 12.6752 11.514 13.4448 10.1288 13.4448H5.36339C3.97821 13.4448 3.20341 12.6752 3.20341 11.2901V7.43708C3.20341 6.05189 3.97821 5.2771 5.36339 5.2771H6.24482V6.35797H5.39082C4.68394 6.35797 4.28428 6.75876 4.28428 7.46564V11.2615C4.28428 11.9684 4.68394 12.364 5.39082 12.364H10.1014C10.8083 12.364 11.2079 11.9684 11.2079 11.2615V7.46564C11.2079 6.75876 10.8083 6.35797 10.1014 6.35797H9.24219V5.2771H10.1288C11.514 5.2771 12.2888 6.05189 12.2888 7.43708Z","M7.7435 2.54053C7.46573 2.54053 7.23341 2.77221 7.23341 3.03907V7.93997L7.329 9.4615C7.34513 9.68747 7.51753 9.876 7.7435 9.876C7.97469 9.876 8.14709 9.68747 8.16321 9.4615L8.2588 7.93997V3.03907C8.2588 2.77221 8.02648 2.54053 7.7435 2.54053ZM6.03852 7.53194C5.78767 7.53194 5.58772 7.71297 5.58772 7.97297C5.58772 8.10615 5.63672 8.20301 5.73244 8.29873L7.3615 9.85277C7.4929 9.98302 7.61097 10.028 7.7435 10.028C7.88125 10.028 7.99931 9.98302 8.13071 9.85277L9.75977 8.29873C9.85029 8.20301 9.9045 8.10615 9.9045 7.97297C9.9045 7.71297 9.69934 7.53194 9.44848 7.53194C9.31937 7.53194 9.19483 7.58323 9.10432 7.68009L8.4552 8.38583L7.7435 9.25164L7.03701 8.38583L6.38269 7.68009C6.29738 7.58323 6.16764 7.53194 6.03852 7.53194Z"]},"close":{"viewBox":"0 0 16 16","paths":["M10.9917 4.12095L4.12602 10.9866C3.89903 11.2136 3.89269 11.6231 4.12945 11.8599C4.37142 12.0966 4.77805 12.0932 5.00796 11.8633L11.8684 5.00288C12.104 4.76726 12.1081 4.36229 11.865 4.12438C11.6218 3.89167 11.2273 3.88533 10.9917 4.12095ZM11.8684 10.9854L5.00796 4.11981C4.77691 3.89396 4.36736 3.88533 4.12945 4.12323C3.89675 4.36635 3.90018 4.77069 4.12602 5.00174L10.9917 11.8622C11.2221 12.0978 11.627 12.0966 11.865 11.8587C12.1029 11.6156 12.104 11.2159 11.8684 10.9854Z"]}};
  const XHTML='http://www.w3.org/1999/xhtml',TOOLS=['hand','pen','rect','arrow','text'];
  const DEFAULT_COLORS=['#FF3B30','#FF9500','#FFCC00','#34C759','#007AFF','#AF52DE','#FFFFFF','#000000'];
  // A failed forced close retains only a small JSON draft, never a raster or
  // DOM reference. Tokens prevent an older save from clearing newer edits.
  const drafts=new Map(),MAX_DRAFT_BYTES=2*1024*1024;let changeToken=0;
  function byteSize(value){let count=0;for(const c of JSON.stringify(value)){const n=c.codePointAt(0);count+=n<128?1:n<2048?2:n<65536?3:4;}return count;}
  function draftKey(binding){return JSON.stringify(binding);}
  function retainDraft(binding,record,token){
    if(!record)return;const key=draftKey(binding),previous=drafts.get(key),bytes=byteSize(record);if(bytes>MAX_DRAFT_BYTES||previous&&previous.token>token)return;
    drafts.delete(key);drafts.set(key,{record,token,bytes});let total=0;for(const value of drafts.values())total+=value.bytes;
    while(drafts.size>8||total>MAX_DRAFT_BYTES){const first=drafts.keys().next().value;total-=drafts.get(first).bytes;drafts.delete(first);}
  }
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  function create(options){
    const {doc,win,markup,store}=options,pendingCanvases=new Set(),allowMarkup=options.allowMarkup===true,nativeHost=options.nativeHost;
    let disposed=false,current=null,epoch=0,disposal=null,removeHostClose=null,hostReleased=false;
    const element=(name,text)=>{const node=doc.createElementNS(XHTML,name);if(text!=null)node.textContent=text;return node;};
    const exported=callback=>options.exportCallback?options.exportCallback(callback):callback;
    const active=session=>!disposed&&current===session&&!session.removed;
    function release(canvas){if(!canvas)return;try{canvas.width=0;canvas.height=0;canvas.remove?.();}catch(_){}}
    function releasePending(){for(const canvas of pendingCanvases)release(canvas);pendingCanvases.clear();}
    function context(canvas){const value=canvas.getContext('2d');return options.waiveCanvas?options.waiveCanvas(value):value;}
    function status(session,message){if(!allowMarkup)message=({'正在导出 PNG…':'Exporting PNG…','已导出 PNG':'PNG exported','已取消导出':'Export cancelled','导出失败，请重试':'Export failed. Try again.','操作未完成，请重试':'Please try again.'})[message]||message;if(active(session))session.status.textContent=message;}
    function consume(event){event.preventDefault?.();event.stopImmediatePropagation?.();}
    function listen(session,target,type,callback,settings=false,bucket=session.removers){
      const handler=exported(function(...args){if(!active(session))return;try{const value=callback(...args);if(value?.catch)value.catch(()=>status(session,'操作未完成，请重试'));}catch(_){status(session,'操作未完成，请重试');}});
      target.addEventListener(type,handler,settings);bucket.push(()=>target.removeEventListener(type,handler,settings));
    }
    function controlState(session){
      if(!active(session))return;const locked=session.loading||session.closing,readOnly=locked||session.loadFailed;
      for(const tool of TOOLS){const node=session.buttons[tool];if(!node)continue;node.disabled=tool==='hand'?locked:readOnly;node.setAttribute('aria-pressed',String(tool===session.tool));}
      for(const node of session.colors){node.disabled=readOnly;node.setAttribute('aria-pressed',String(node.getAttribute('data-figure-preview-color')===session.color));}
      for(const [name,disabled] of [['undo',readOnly||!session.history.canUndo],['redo',readOnly||!session.history.canRedo],['clear',readOnly||!session.history.marks.length],['save',readOnly||session.revision===session.savedRevision]])if(session.buttons[name])session.buttons[name].disabled=disabled;
      session.buttons.export.disabled=locked||session.loadFailed||session.exporting;
      if(session.buttons.close)session.buttons.close.disabled=session.closing;
    }
    function paint(session){
      session.frame=null;if(!allowMarkup||!active(session))return;const ctx=context(session.overlay);ctx.clearRect(0,0,session.width,session.height);
      if(markup.paint(ctx,session.width,session.height,session.history.marks)===false){status(session,'标注暂时无法显示');return;}
      // A shape still awaiting its second point must not invalidate old marks.
      if(session.gesture?.mark)markup.paint(ctx,session.width,session.height,[session.gesture.mark]);
    }
    function redraw(session){if(!allowMarkup||!active(session)||session.frame!==null)return;if(typeof win.requestAnimationFrame==='function')session.frame=win.requestAnimationFrame(exported(()=>{try{paint(session);}catch(_){status(session,'标注暂时无法显示');}}));else paint(session);}
    function change(session,operation){
      if(!active(session)||session.loading||session.closing||session.loadFailed)return false;const before=JSON.stringify(session.history.marks),previousToken=session.changeToken;operation();
      if(JSON.stringify(session.history.marks)===before)return false;session.revision++;session.changeToken=++changeToken;if(drafts.get(draftKey(session.binding))?.token===previousToken)retainDraft(session.binding,record(session),session.changeToken);status(session,'已修改 · 关闭时自动保存');controlState(session);redraw(session);return true;
    }
    function transform(session){if(active(session))session.plane.style.setProperty('transform','translate('+session.view.x+'px,'+session.view.y+'px) scale('+session.view.scale+')');}
    function stageSize(session){const box=session.stage.getBoundingClientRect?.();return {width:box?.width||session.stage.clientWidth||Math.max(160,(win.innerWidth||1000)-96),height:box?.height||session.stage.clientHeight||Math.max(120,(win.innerHeight||700)-210)};}
    function sizeToImage(session,initial=false){
      let width,height;
      if(nativeHost){
        const box=initial?nativeHost.fit(session.width,session.height,36):{width:win.innerWidth,height:win.innerHeight};width=box.width;height=box.height;
      }else{
        const availableWidth=Math.max(180,(win.innerWidth||1000)-32)-2,availableHeight=Math.max(100,(win.innerHeight||700)-32)-38;
        const scale=Math.min(availableWidth/session.width,availableHeight/session.height);
        width=Math.max(Math.min(180,availableWidth+2),Math.ceil(session.width*scale)+2);height=Math.ceil(session.height*scale)+38;
      }
      session.dialog.style.setProperty('width',Math.round(width)+'px');session.dialog.style.setProperty('height',Math.round(height)+'px');session.dialog.setAttribute('data-figure-preview-narrow',String(width<240));
    }
    function releaseHost(){if(hostReleased)return;hostReleased=true;try{removeHostClose?.();}catch(_){}removeHostClose=null;try{nativeHost?.close?.();}catch(_){}}
    function fit(session){const box=stageSize(session);session.view.scale=clamp(Math.min(box.width/session.width,box.height/session.height),Number.EPSILON,16);session.view.x=(box.width-session.width*session.view.scale)/2;session.view.y=(box.height-session.height*session.view.scale)/2;transform(session);}
    function zoom(session,factor,origin){
      if(!active(session))return;const box=stageSize(session),point=origin||[box.width/2,box.height/2],previous=session.view.scale,next=clamp(previous*factor,.05,16);
      session.view.x=point[0]-(point[0]-session.view.x)*next/previous;session.view.y=point[1]-(point[1]-session.view.y)*next/previous;session.view.scale=next;transform(session);
    }
    function point(session,event){const box=session.overlay.getBoundingClientRect?.();if(!box||!finite(event.clientX)||!finite(event.clientY)||!finite(box.width)||!finite(box.height)||box.width<=0||box.height<=0)return null;return [clamp((event.clientX-box.left)/box.width,0,1),clamp((event.clientY-box.top)/box.height,0,1)];}
    function removeEditor(session){for(const remove of session.editorRemovers?.splice(0)||[]){try{remove();}catch(_){}}const owned=session.editorFocusables||[];if(owned.length)session.focusables=session.focusables.filter(node=>!owned.includes(node));session.editorFocusables=[];session.editor?.remove();session.editor=null;session.textInput=null;session.textPoint=null;}
    function commitText(session){
      if(!session.textInput)return false;const text=String(session.textInput.value||'').slice(0,500),at=session.textPoint;removeEditor(session);
      return text.trim()?change(session,()=>session.history.commit({type:'text',color:session.color,width:.004,points:[at],text})):false;
    }
    function textEditor(session,at,event){
      commitText(session);const editor=element('div'),input=element('textarea'),add=element('button','添加'),cancel=element('button','取消');editor.className='askgpt-figure-preview-text';input.setAttribute('data-figure-preview-editor','text');input.setAttribute('aria-label','标注文字');input.setAttribute('maxlength','500');input.setAttribute('placeholder','输入文字');input.rows=3;
      add.setAttribute('type','button');cancel.setAttribute('type','button');add.setAttribute('data-figure-preview-action','add-text');cancel.setAttribute('data-figure-preview-action','cancel-text');editor.append(input,add,cancel);session.stage.appendChild(editor);session.editor=editor;session.textInput=input;session.textPoint=at;
      const box=session.stage.getBoundingClientRect?.()||{left:0,top:0,width:600,height:400};editor.style.setProperty('left',clamp(event.clientX-box.left,8,Math.max(8,box.width-230))+'px');editor.style.setProperty('top',clamp(event.clientY-box.top,8,Math.max(8,box.height-130))+'px');
      session.editorRemovers=[];session.editorFocusables=[input,add,cancel];session.focusables.push(...session.editorFocusables);listen(session,add,'click',()=>{commitText(session);session.buttons.text.focus?.();},false,session.editorRemovers);listen(session,cancel,'click',()=>{removeEditor(session);session.buttons.text.focus?.();},false,session.editorRemovers);
      listen(session,input,'keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){consume(event);commitText(session);session.buttons.text.focus?.();}},false,session.editorRemovers);input.focus?.();
    }
    function down(session,event){
      if(session.loading||session.closing||event.isPrimary===false||event.button!==0&&event.button!==1)return;
      const at=point(session,event);if(!at)return;
      if(session.tool==='hand'||event.button===1){session.gesture={kind:'pan',id:event.pointerId,x:event.clientX,y:event.clientY,startX:session.view.x,startY:session.view.y};}
      else {if(session.loadFailed)return;if(session.tool==='text'){consume(event);textEditor(session,at,event);return;}commitText(session);session.gesture={kind:'mark',id:event.pointerId,mark:{type:session.tool,color:session.color,width:.004,points:[at]}};}
      try{session.overlay.setPointerCapture?.(event.pointerId);}catch(_){}consume(event);
    }
    function move(session,event){
      const gesture=session.gesture;if(!gesture||gesture.id!==undefined&&event.pointerId!==undefined&&event.pointerId!==gesture.id)return;
      if(gesture.kind==='pan'){session.view.x=gesture.startX+event.clientX-gesture.x;session.view.y=gesture.startY+event.clientY-gesture.y;transform(session);}
      else {const at=point(session,event);if(!at)return;const points=gesture.mark.points;if(gesture.mark.type==='pen'){const last=points[points.length-1];if(points.length<4096&&Math.hypot((at[0]-last[0])*session.width,(at[1]-last[1])*session.height)>=.3)points.push(at);}else if(points.length===1)points.push(at);else points[1]=at;redraw(session);}consume(event);
    }
    function up(session,event,cancel=false){
      const gesture=session.gesture;if(!gesture||gesture.id!==undefined&&event.pointerId!==undefined&&event.pointerId!==gesture.id)return;if(!cancel)move(session,event);session.gesture=null;
      try{session.overlay.releasePointerCapture?.(gesture.id);}catch(_){}
      if(!cancel&&gesture.kind==='mark'){
        const mark=gesture.mark;
        if(mark.type==='pen'&&mark.points.length||mark.points.length>=2&&Math.hypot((mark.points[1][0]-mark.points[0][0])*session.width,(mark.points[1][1]-mark.points[0][1])*session.height)>=2)change(session,()=>session.history.commit(mark));
      }redraw(session);consume(event);
    }
    function record(session){try{return markup.validateRecord({schema:1,binding:session.binding,marks:session.history.marks});}catch(_){return null;}}
    function save(session){
      if(session.loadFailed)return Promise.resolve(false);const revision=session.revision;if(revision===session.savedRevision)return Promise.resolve(true);if(session.pendingSaves.has(revision))return session.pendingSaves.get(revision);
      const snapshot=record(session),token=session.changeToken;if(!snapshot){status(session,'保存失败，请重试');return Promise.resolve(false);}status(session,'保存中…');
      const pending=session.saveChain.catch(()=>{}).then(async()=>{try{return typeof store?.save==='function'&&await store.save(snapshot)===true;}catch(_){return false;}}).then(saved=>{if(saved){session.savedRevision=Math.max(session.savedRevision,revision);const key=draftKey(session.binding);if(drafts.get(key)?.token===token)drafts.delete(key);}status(session,saved?(session.revision===session.savedRevision?'已保存标注':'已保存 · 仍有新修改'):'保存失败，请重试');controlState(session);return saved;});
      session.saveChain=pending;session.pendingSaves.set(revision,pending);void pending.finally(()=>session.pendingSaves.delete(revision));return pending;
    }
    function notifyClosed(session,saved,reason){if(session.notified)return;session.notified=true;try{options.onClosed?.({saved,reason});}catch(_){}}
    function teardown(session){
      if(session.removed)return;session.removed=true;if(session.frame!==null)win.cancelAnimationFrame?.(session.frame);session.frame=null;
      if(session.gesture)try{session.overlay.releasePointerCapture?.(session.gesture.id);}catch(_){}session.gesture=null;
      for(const remove of [...session.removers.splice(0),...session.sourceRemovers.splice(0)]){try{remove();}catch(_){}}removeEditor(session);for(const canvas of session.canvases)release(canvas);session.canvases.clear();session.root.remove();session.style.remove();
      try{if(session.previousFocus?.isConnected!==false)session.previousFocus?.focus?.();}catch(_){}
    }
    function finish(session,reason){
      if(session.closePromise)return session.closePromise;commitText(session);session.gesture=null;session.closing=true;controlState(session);
      session.closePromise=(async()=>{const saved=session.revision===session.savedRevision||session.loadFailed?true:await save(session);if(!saved&&active(session)){session.closing=false;session.closePromise=null;controlState(session);status(session,'保存失败，请重试');return false;}if(current===session)current=null;teardown(session);notifyClosed(session,saved,reason);releaseHost();return saved;})();return session.closePromise;
    }
    function exportDiagnostic(phase,byteLength=0){try{options.reportExportDiagnostic?.({phase,byteLength:Number.isSafeInteger(byteLength)&&byteLength>=0&&byteLength<=32*1024*1024?byteLength:0});}catch(_){}}
    // Only values originating from this preview's owned PNG canvas cross this
    // boundary. Copy into a local typed array after unwrapping each native value.
    function pngBytes(session,canvas){return new Promise((resolve,reject)=>{
      const unwrap=value=>options.unwrapPNG?options.unwrapPNG(value):value;
      try{exportDiagnostic(102);canvas.toBlob(exported(blob=>{
        try{exportDiagnostic(103);if(!blob)throw new Error('PNG unavailable');const ownedBlob=unwrap(blob),pending=unwrap(ownedBlob.arrayBuffer());
          Promise.resolve(pending).then(buffer=>{try{const ownedBuffer=unwrap(buffer),size=ownedBuffer.byteLength;if(!Number.isSafeInteger(size)||size<=0||size>32*1024*1024)throw new Error('PNG size unavailable');const bytes=new Uint8Array(ownedBuffer);if(bytes.byteLength!==size)throw new Error('PNG bytes unavailable');exportDiagnostic(104,bytes.byteLength);resolve(bytes);}catch(error){reject(error);}},reject);
        }catch(error){reject(error);}
      }), 'image/png');}catch(error){reject(error);}
    });}
    async function exportImage(session){
      if(session.exporting||session.loading||session.closing||session.loadFailed)return false;commitText(session);const snapshot=record(session);if(!snapshot)return false;session.exporting=true;controlState(session);let canvas;
      try{
        if(!await save(session)||!active(session))return false;exportDiagnostic(100);status(session,'正在导出 PNG…');canvas=element('canvas');canvas.width=session.width;canvas.height=session.height;session.canvases.add(canvas);const ctx=context(canvas);ctx.drawImage(session.source,0,0);if(markup.paint(ctx,session.width,session.height,snapshot.marks)===false)throw new Error('Figure painting unavailable');
        exportDiagnostic(101);const bytes=await pngBytes(session,canvas);if(!active(session))return false;const base=(session.label||'figure').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').trim().slice(0,80)||'figure';const result=await store.exportPNG(bytes,snapshot,base+'.png');
        exportDiagnostic(result?.saved?106:result?.cancelled?107:108);status(session,result?.saved?'已导出 PNG':result?.cancelled?'已取消导出':'导出失败，请重试');return result?.saved===true;
      }catch(_){exportDiagnostic(109);status(session,'导出失败，请重试');return false;}finally{if(canvas){session.canvases.delete(canvas);release(canvas);}session.exporting=false;controlState(session);}
    }
    function editable(target){for(let node=target,depth=0;node&&depth<8;node=node.parentNode,depth++){const name=String(node.localName||node.tagName||'').toLowerCase();if(['textarea','input','select'].includes(name)||node.isContentEditable)return true;}return false;}
    function key(session,event){
      if(event.key==='Tab'){
        const items=session.focusables.filter(node=>!node.disabled&&!node.hidden&&node.parentNode&&session.root.contains?.(node)!==false);if(!items.length)return;const index=items.indexOf(doc.activeElement),next=event.shiftKey?(index<=0?items.length-1:index-1):(index<0||index===items.length-1?0:index+1);consume(event);items[next].focus?.();return;
      }
      if(event.key==='Escape'||(event.key===' '||event.code==='Space')&&!editable(event.target)&&!event.altKey&&!event.ctrlKey&&!event.metaKey){consume(event);if(!event.repeat)void api.close();}
    }
    function mount(session){
      const root=element('div'),dialog=element('section'),header=element('header'),title=element('strong',session.label||'图片预览'),toolbar=element('div'),stage=element('div'),plane=element('div'),notice=element('span'),style=element('style');
      root.className='askgpt-figure-preview-backdrop';if(nativeHost)root.setAttribute('data-figure-preview-native','true');root.setAttribute('data-askgpt-figure-preview','dialog');dialog.className='askgpt-figure-preview';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label',session.label||'图片预览');dialog.setAttribute('tabindex','-1');stage.className='askgpt-figure-preview-stage';stage.setAttribute('data-figure-preview-part','stage');plane.className='askgpt-figure-preview-plane';plane.setAttribute('data-figure-preview-part','plane');toolbar.className='askgpt-figure-preview-toolbar';toolbar.setAttribute('role','toolbar');toolbar.setAttribute('aria-label',allowMarkup?'图片预览工具':'Preview controls');notice.className='askgpt-figure-preview-status';notice.setAttribute('role','status');
      Object.assign(session,{root,dialog,stage,plane,status:notice,style,buttons:{},colors:[],focusables:[]});
      function button(action,label,parent=toolbar,run){const node=element('button');node.setAttribute('type','button');node.setAttribute('data-figure-preview-action',action);node.setAttribute('aria-label',label);node.setAttribute('title',label);node.className='toolbar-button';session.buttons[action]=node;session.focusables.push(node);parent.appendChild(node);listen(session,node,'click',()=>{if(!node.disabled)return run?.();});return node;}
      function iconButton(action,label,sourceID,uri,run){
        const node=button(action,label,toolbar,run);let icon;try{icon=(options.iconDocument||doc).getElementById(sourceID)?.querySelector?.('svg')?.cloneNode?.(true);}catch(_){}
        if(!icon&&NATIVE_ICONS[action]){const value=NATIVE_ICONS[action];icon=doc.createElementNS(SVG,'svg');icon.setAttribute('viewBox',value.viewBox);icon.setAttribute('fill','currentColor');for(const d of value.paths){const path=doc.createElementNS(SVG,'path');path.setAttribute('d',d);icon.appendChild(path);}}
        if(!icon&&uri){icon=element('img');icon.setAttribute('src',uri);}
        if(icon){icon.setAttribute('aria-hidden','true');icon.setAttribute('data-figure-preview-icon',action);node.appendChild(icon);}else node.textContent=action==='fit'?'↔':label;
        return node;
      }
      if(!nativeHost)header.appendChild(title);header.append(notice,toolbar);
      try{const original=options.iconDocument,computed=original?.defaultView?.getComputedStyle?.(original.documentElement||original.body);for(const key of ['--material-background','--material-toolbar','--material-panedivider','--fill-primary','--fill-secondary','--fill-quinary','--fill-quarternary','--accent-blue']){const value=computed?.getPropertyValue?.(key);if(value)root.style.setProperty(key,value);}}catch(_){}
      if(allowMarkup){
        for(const [tool,label] of [['hand','拖动'],['pen','笔'],['rect','框'],['arrow','箭头'],['text','文字']]){const node=button(tool,label,toolbar,()=>{commitText(session);session.tool=tool;controlState(session);session.overlay.style.setProperty('cursor',tool==='hand'?'grab':'crosshair');});node.textContent=label;}
        const palette=element('span');palette.className='askgpt-figure-preview-colors';palette.setAttribute('role','group');palette.setAttribute('aria-label','标注颜色');toolbar.appendChild(palette);
        for(const color of markup.COLORS||DEFAULT_COLORS){const node=element('button');node.setAttribute('type','button');node.setAttribute('data-figure-preview-color',color);node.setAttribute('aria-label','颜色 '+color);node.style.setProperty('--mark-color',color);palette.appendChild(node);session.colors.push(node);session.focusables.push(node);listen(session,node,'click',()=>{if(!node.disabled){session.color=color;controlState(session);}});}
        for(const [action,label,run] of [['undo','撤销',()=>change(session,()=>session.history.undo())],['redo','重做',()=>change(session,()=>session.history.redo())],['clear','清空',()=>change(session,()=>session.history.clear())],['save','保存标注',()=>{commitText(session);return save(session);}]]){const node=button(action,label,toolbar,run);node.textContent=label;}
      }
      iconButton('zoom-out',allowMarkup?'缩小':'Zoom Out','zoomOut','chrome://zotero/skin/16/universal/minus.svg',()=>zoom(session,1/1.2));
      iconButton('fit',allowMarkup?'适合窗口':'Fit','zoomAuto',null,()=>fit(session));
      iconButton('zoom-in',allowMarkup?'放大':'Zoom In','zoomIn','chrome://zotero/skin/16/universal/plus.svg',()=>zoom(session,1.2));
      iconButton('export',allowMarkup?'导出 PNG':'Export PNG',null,'chrome://zotero/skin/mac/menu/square.and.arrow.down.svg',()=>exportImage(session));
      if(!nativeHost)iconButton('close',allowMarkup?'关闭':'Close',null,'chrome://zotero/skin/mac/menu/xmark.svg',()=>api.close());
      session.source.setAttribute('data-figure-preview-canvas','source');session.source.style.setProperty('pointer-events',allowMarkup?'none':'auto');
      const overlay=allowMarkup?element('canvas'):session.source;if(allowMarkup){overlay.width=session.width;overlay.height=session.height;session.canvases.add(overlay);}overlay.setAttribute('data-figure-preview-canvas','overlay');overlay.style.setProperty('cursor','grab');session.overlay=overlay;
      plane.style.setProperty('width',session.width+'px');plane.style.setProperty('height',session.height+'px');plane.appendChild(session.source);if(allowMarkup)plane.appendChild(overlay);stage.appendChild(plane);dialog.append(header,stage);root.appendChild(dialog);
      style.textContent=`.askgpt-figure-preview-backdrop{position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;justify-content:center;padding:16px;background:#0003;box-sizing:border-box;color-scheme:light dark}.askgpt-figure-preview{display:flex;flex-direction:column;box-sizing:border-box;min-width:0;overflow:hidden;border:var(--material-panedivider,1px solid #8885);border-radius:8px;background:var(--material-background,Canvas);color:var(--fill-primary,CanvasText);box-shadow:0 8px 28px #0003;font:12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.askgpt-figure-preview header{box-sizing:border-box;display:flex;align-items:center;gap:8px;height:36px;flex:0 0 36px;min-width:0;padding:0 6px 0 12px;background:var(--material-toolbar,var(--material-background,Canvas));border-bottom:var(--material-panedivider,1px solid #8883)}.askgpt-figure-preview header strong{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}.askgpt-figure-preview-toolbar{display:flex;align-items:center;gap:2px;flex:none}.askgpt-figure-preview button{appearance:none;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:28px;height:28px;padding:4px;border:0;border-radius:5px;background:transparent;color:var(--fill-secondary,CanvasText);font:inherit;cursor:default;flex:none}.askgpt-figure-preview button:hover{background:var(--fill-quinary,#8882)}.askgpt-figure-preview button:active{background:var(--fill-quarternary,#8883)}.askgpt-figure-preview button[aria-pressed=true]{background:var(--fill-quarternary,#8883)}.askgpt-figure-preview button:disabled{opacity:.4}.askgpt-figure-preview button:focus-visible{outline:2px solid var(--accent-blue,Highlight);outline-offset:-2px}.askgpt-figure-preview button svg{width:20px;height:20px;pointer-events:none}.askgpt-figure-preview button img{width:16px;height:16px;pointer-events:none;-moz-context-properties:fill;fill:currentColor}.askgpt-figure-preview-status{font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.askgpt-figure-preview-status:empty{display:none}.askgpt-figure-preview-stage{position:relative;flex:1;min-height:0;overflow:hidden;background:var(--material-background,Canvas);touch-action:none}.askgpt-figure-preview-plane{position:absolute;left:0;top:0;transform-origin:0 0}.askgpt-figure-preview-plane canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none}.askgpt-figure-preview-colors{display:inline-flex;gap:3px}.askgpt-figure-preview-colors button{width:18px;height:18px;padding:0;border:1px solid #8888;border-radius:50%;background:var(--mark-color)}.askgpt-figure-preview-text{position:absolute;z-index:2;width:220px;padding:7px;border:1px solid #8886;border-radius:7px;background:Canvas}.askgpt-figure-preview-text textarea{box-sizing:border-box;display:block;width:100%;min-height:70px;margin-bottom:5px;resize:vertical;font:13px/1.4 inherit;color:inherit;background:Canvas;border:1px solid #8886}.askgpt-figure-preview[data-figure-preview-narrow=true] header{padding-left:6px;padding-right:6px;gap:0;justify-content:flex-end}.askgpt-figure-preview[data-figure-preview-narrow=true] header strong{display:none}.askgpt-figure-preview-backdrop[data-figure-preview-native=true]{padding:0;background:var(--material-background,Canvas);align-items:stretch;justify-content:stretch}.askgpt-figure-preview-backdrop[data-figure-preview-native=true] .askgpt-figure-preview{border:0;border-radius:0;box-shadow:none}.askgpt-figure-preview-backdrop[data-figure-preview-native=true] header{justify-content:flex-end}.askgpt-figure-preview-backdrop[data-figure-preview-native=true] .askgpt-figure-preview-status{margin-right:auto}@media(prefers-reduced-transparency:reduce){.askgpt-figure-preview-backdrop{background:Canvas}}@media(forced-colors:active){.askgpt-figure-preview{border:2px solid CanvasText;box-shadow:none}}`;
      doc.head.appendChild(style);doc.body.appendChild(root);listen(session,overlay,'pointerdown',event=>down(session,event),false,session.sourceRemovers);listen(session,win,'pointermove',event=>move(session,event),true);listen(session,win,'pointerup',event=>up(session,event),true);listen(session,win,'pointercancel',event=>up(session,event,true),true);listen(session,win,'keydown',event=>key(session,event),true);
      listen(session,stage,'wheel',event=>{const box=stage.getBoundingClientRect?.()||{left:0,top:0};zoom(session,Math.exp(clamp(-event.deltaY*.002,-1,1)),[event.clientX-box.left,event.clientY-box.top]);consume(event);},{passive:false});listen(session,win,'resize',()=>{sizeToImage(session);fit(session);});
      sizeToImage(session,true);controlState(session);fit(session);redraw(session);(session.buttons.close||session.buttons.fit).focus?.();
    }
    const api={
      get isOpen(){return Boolean(current&&!current.removed&&!disposed);},
      upgradeCanvas(canvas){
        const session=current;
        if(!canvas||canvas===session?.source)return false;
        if(allowMarkup||!session||!active(session)||session.closing||session.gesture||!Number.isInteger(canvas.width)||!Number.isInteger(canvas.height)||canvas.width<session.width||canvas.height<session.height||canvas.width*canvas.height>16777216||Math.abs((canvas.width/canvas.height)/(session.width/session.height)-1)>.005){release(canvas);return false;}
        const removers=[];
        try{
          canvas.setAttribute('data-figure-preview-canvas','overlay');canvas.style.setProperty('pointer-events','auto');canvas.style.setProperty('cursor','grab');
          listen(session,canvas,'pointerdown',event=>down(session,event),false,removers);
          const previous=session.source,oldWidth=session.width;
          previous.replaceWith(canvas);
          for(const remove of session.sourceRemovers.splice(0)){try{remove();}catch(_){}}
          session.sourceRemovers=removers;session.source=session.overlay=canvas;session.width=canvas.width;session.height=canvas.height;
          session.canvases.delete(previous);session.canvases.add(canvas);
          session.plane.style.setProperty('width',session.width+'px');session.plane.style.setProperty('height',session.height+'px');
          session.view.scale*=oldWidth/session.width;transform(session);release(previous);return true;
        }catch(_){for(const remove of removers){try{remove();}catch(_){}}release(canvas);return false;}
      },
      async open(input={}){
        const canvas=input.canvas;if(disposed){release(canvas);return false;}if(current?.source===canvas)return true;
        let binding;try{binding=markup.validateBinding(input.binding);}catch(_){}if(!binding||!canvas||!Number.isInteger(canvas.width)||!Number.isInteger(canvas.height)||canvas.width<1||canvas.height<1||canvas.width*canvas.height>16777216){release(canvas);return false;}
        const generation=++epoch;releasePending();pendingCanvases.add(canvas);if(current&&!await finish(current,'replace')){pendingCanvases.delete(canvas);release(canvas);return false;}
        if(disposed||epoch!==generation){pendingCanvases.delete(canvas);release(canvas);return false;}
        const session={binding,label:allowMarkup&&typeof input.label==='string'?input.label.slice(0,160):'Preview',source:canvas,width:canvas.width,height:canvas.height,history:markup.createHistory([]),tool:'hand',color:(markup.COLORS||DEFAULT_COLORS)[0],view:{scale:1,x:0,y:0},revision:0,savedRevision:0,changeToken:0,saveChain:Promise.resolve(true),pendingSaves:new Map(),loading:true,loadFailed:false,closing:false,exporting:false,frame:null,gesture:null,editor:null,removers:[],sourceRemovers:[],canvases:new Set([canvas]),previousFocus:doc.activeElement,removed:false,notified:false,closePromise:null};
        pendingCanvases.delete(canvas);current=session;try{mount(session);}catch(_){current=null;teardown(session);return false;}
        try{const recovered=allowMarkup?drafts.get(draftKey(binding)):null,loaded=allowMarkup?(recovered?recovered.record:await store?.load?.(binding)):null;if(!active(session)||epoch!==generation)return false;if(loaded!=null){const checked=markup.validateRecord(loaded);if(!checked||JSON.stringify(markup.validateBinding(checked.binding))!==JSON.stringify(binding))throw new Error('Invalid figure record');session.history=markup.createHistory(checked.marks);if(recovered){session.revision=1;session.changeToken=recovered.token;}}status(session,recovered?'上次保存失败，已恢复待保存标注':'');}
        catch(_){if(!active(session)||epoch!==generation)return false;session.loadFailed=true;status(session,'标注读取失败，暂时仅预览');}
        session.loading=false;controlState(session);redraw(session);return true;
      },
      close(){++epoch;releasePending();return current?finish(current,'close'):Promise.resolve(true);},
      dispose(){if(disposed)return disposal||Promise.resolve(true);if(current)commitText(current);disposed=true;++epoch;releasePending();const session=current;current=null;if(!session){releaseHost();return disposal=Promise.resolve(true);}session.gesture=null;const snapshot=record(session),token=session.changeToken,pending=session.revision===session.savedRevision||session.loadFailed?Promise.resolve(true):save(session);teardown(session);releaseHost();disposal=Promise.resolve(pending).then(saved=>{if(!saved)retainDraft(session.binding,snapshot,token);notifyClosed(session,saved,'dispose');return saved;});return disposal;}
    };if(nativeHost?.onClose)removeHostClose=nativeHost.onClose(()=>{void api.dispose();});return api;
  }
  const api={create};root.AskGPTPDFFigurePreview=api;if(typeof module!=='undefined')module.exports=api;
})(this);
