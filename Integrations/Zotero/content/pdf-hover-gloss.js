(function(root){
  'use strict';
  const XHTML='http://www.w3.org/1999/xhtml';
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  const normalize=value=>value.normalize('NFKC').replace(/[\u2010\u2011]/g,'-').replace(/\u2019/g,"'");
  const lexical=value=>typeof value==='string'&&value.length>0&&/^[\p{L}\p{N}\p{M}\p{Pc}'\u2019.\-\u2010\u2011]+$/u.test(value);
  function rectangle(value){if(!value)return null;const r=[value[0],value[1],value[2],value[3]];return r.every(finite)&&r[2]>r[0]&&r[3]>r[1]?r:null;}
  function pair(value){if(!value)return null;const result=[value[0],value[1]];return result.every(finite)?result:null;}
  function glyph(value){const text=value?.c,rect=rectangle(value?.rect);if(value?.ignorable||finite(value?.rotation)&&value.rotation%360!==0)return null;return typeof text==='string'&&rect?{text,rect,breakAfter:Boolean(value.spaceAfter||value.wordBreakAfter||value.lineBreakAfter||value.paragraphBreakAfter)}:null;}
  function adjacent(a,b){
    const x=a.rect,y=b.rect,ha=x[3]-x[1],hb=y[3]-y[1],height=Math.max(ha,hb),overlap=Math.min(x[3],y[3])-Math.max(x[1],y[1]);
    const gap=y[0]-x[2],width=Math.min((x[2]-x[0])/Math.max(1,a.text.length),(y[2]-y[0])/Math.max(1,b.text.length));
    return !a.breakAfter&&Math.abs((x[1]+x[3]-y[1]-y[3])/2)<=height*.35&&overlap>=Math.min(ha,hb)*.5&&gap>=-width*.6&&gap<=Math.max(1.25,width*.4);
  }
  // Read native glyph geometry only. No DOM Range, selection or annotation calls.
  function wordAt(view,event,onError){
    try{
      if(!finite(event?.clientX)||!finite(event?.clientY))return null;
      const win=view?._iframeWindow,viewer=win?.PDFViewerApplication?.pdfViewer;
      let pageNode=event.target;for(let depth=0;pageNode&&depth<30;depth++,pageNode=pageNode.parentNode)if(pageNode.getAttribute?.('data-page-number'))break;
      const index=Number(pageNode?.getAttribute?.('data-page-number'))-1;if(!Number.isInteger(index)||index<0)return null;
      const page=viewer?.getPageView?.(index),viewport=page?.viewport,canvas=page?.canvas||page?.div?.querySelector?.('.canvasWrapper')||page?.div,box=canvas?.getBoundingClientRect?.();
      if(!viewport||typeof viewport.convertToPdfPoint!=='function'||typeof viewport.convertToViewportPoint!=='function'||!box||![box.left,box.top,box.width,box.height,viewport.width,viewport.height].every(finite)||box.width<=0||box.height<=0||viewport.width<=0||viewport.height<=0)return null;
      const scaleX=box.width/viewport.width,scaleY=box.height/viewport.height;
      // Native viewport functions receive primitive arguments; returned arrays
      // are copied by index so their Xray-hidden Array methods are unnecessary.
      const point=pair(viewport.convertToPdfPoint((event.clientX-box.left)/scaleX,(event.clientY-box.top)/scaleY));if(!point)return null;
      const chars=view?._pdfPages?.[index]?.chars;if(!chars||!Number.isInteger(chars.length)||chars.length<1||chars.length>100000)return null;
      let hit=-1;
      for(let i=0;i<chars.length;i++){const r=rectangle(chars[i]?.rect);if(r&&point[0]>=r[0]&&point[0]<=r[2]&&point[1]>=r[1]&&point[1]<=r[3]){hit=i;break;}}
      const center=hit>=0?glyph(chars[hit]):null;if(!center||!lexical(center.text))return null;
      let start=hit,end=hit,count=center.text.length;
      while(start>0){const prior=glyph(chars[start-1]),next=glyph(chars[start]);if(!prior||!next||!lexical(prior.text)||!adjacent(prior,next))break;start--;count+=prior.text.length;if(count>100)return null;}
      while(end+1<chars.length){const prior=glyph(chars[end]),next=glyph(chars[end+1]);if(!prior||!next||!lexical(next.text)||!adjacent(prior,next))break;end++;count+=next.text.length;if(count>100)return null;}
      const items=[];for(let i=start;i<=end;i++)items.push(glyph(chars[i]));
      let word=normalize(items.map(value=>value.text).join(''));
      // A sentence's final period is punctuation; e.g. and U.S. retain theirs.
      if(word.endsWith('.')&&!/^(?:[A-Za-z]\.){2,}$/.test(word)){
        word=word.slice(0,-1);if(items.at(-1)?.text==='.'){if(hit===end)return null;items.pop();end--;}
      }
      if(word.length<1||word.length>96||!/[A-Za-z]/.test(word)||!/^[A-Za-z]+(?:['.\-][A-Za-z]+)*\.?$/.test(word))return null;
      const pdfRect=[Math.min(...items.map(value=>value.rect[0])),Math.min(...items.map(value=>value.rect[1])),Math.max(...items.map(value=>value.rect[2])),Math.max(...items.map(value=>value.rect[3]))];
      const a=pair(viewport.convertToViewportPoint(pdfRect[0],pdfRect[1])),b=pair(viewport.convertToViewportPoint(pdfRect[2],pdfRect[3]));if(!a||!b)return null;
      const rect=[box.left+Math.min(a[0],b[0])*scaleX,box.top+Math.min(a[1],b[1])*scaleY,box.left+Math.max(a[0],b[0])*scaleX,box.top+Math.max(a[1],b[1])*scaleY];if(!rectangle(rect))return null;
      return {word,pageIndex:index,rect,key:index+':'+start+':'+end+':'+word+':'+rect.map(value=>Math.round(value*10)).join(',')};
    }catch(_){try{onError?.();}catch(_){}return null;}
  }
  function entryValue(value,query){
    if(!value||typeof value!=='object'||!Array.isArray(value.senses))return null;
    const senses=[];for(let i=0;i<Math.min(2,value.senses.length);i++){
      const sense=value.senses[i];if(!sense||!Array.isArray(sense.meanings))continue;
      const meanings=sense.meanings.filter(item=>typeof item==='string'&&item.trim()).slice(0,2).map(item=>item.trim().slice(0,240));
      if(meanings.length)senses.push({partOfSpeech:typeof sense.partOfSpeech==='string'?sense.partOfSpeech.slice(0,20):typeof sense.pos==='string'?sense.pos.slice(0,20):'',meanings});
    }
    return senses.length?{headword:typeof value.headword==='string'&&value.headword.trim()?value.headword.trim().slice(0,96):query,phonetic:typeof value.phonetic==='string'?value.phonetic.trim().slice(0,80):'',senses}:null;
  }
  function install(view,options={}){
    const win=view?._iframeWindow,doc=win?.document,scroll=doc?.getElementById?.('viewerContainer'),removers=[],cache=new Map(),misses=new Map(),reported=new Set();
    let disposed=false,current=null,timer=null,card=null,style=null,inFlight=null;
    const enabled=()=>{try{return !disposed&&(typeof options.enabled==='function'?options.enabled():options.enabled!==false);}catch(_){return false;}};
    // Diagnostics contain fixed categories only; never pass native errors,
    // dictionary queries, document text, geometry or event objects to the sink.
    function report(stage,errorDetail){if(reported.has(stage))return;reported.add(stage);try{options.reportDiagnostic?.(stage,{name:'HoverDiagnostic',code:stage==='hoverError'?'compatibility':'rendered',errorDetail});}catch(_){}}
    const callback=fn=>{const safe=function(...args){try{return fn(...args);}catch(_){report('hoverError','hoverEvent');clear();}};return typeof options.exportCallback==='function'?options.exportCallback(safe):safe;};
    const node=name=>doc.createElementNS(XHTML,name);
    function hide(){card?.remove?.();card=null;}
    function clear(){if(timer!==null)win?.clearTimeout?.(timer);timer=null;current=null;hide();}
    function blocked(event){
      if(!enabled()){report('hoverBlocked','hoverDisabled');return true;}
      if(event?.buttons||event?.altKey||event?.ctrlKey||event?.metaKey||event?.shiftKey||event?.pointerType&&event.pointerType!=='mouse'){report('hoverBlocked','hoverInput');return true;}
      try{const selected=win?.getSelection?.(),range=view?._selectionRanges?.[0],blocked=Boolean(selected&&selected.isCollapsed===false||range&&range.collapsed!==true||view?._selectionPopup?.annotation||view?._annotationPopup?.annotation);if(blocked)report('hoverBlocked','hoverSelection');return blocked;}catch(_){report('hoverError','hoverSelection');return true;}
    }
    function remember(map,key,value,limit){map.delete(key);map.set(key,value);while(map.size>limit)map.delete(map.keys().next().value);}
    function render(candidate,value){
      if(current!==candidate||blocked())return;hide();card=node('div');card.setAttribute('data-askgpt-hover-gloss','card');card.setAttribute('role','tooltip');
      card.className='askgpt-hover-gloss';for(const [name,value] of [['position','fixed'],['pointer-events','none'],['z-index','2147482500']])card.style.setProperty(name,value);
      let remaining=240;
      const take=(text,maximum)=>{const limit=Math.max(0,Math.min(maximum,remaining)),value=String(text||'');const result=value.length>limit&&limit>1?value.slice(0,limit-1)+'…':value.slice(0,limit);remaining-=result.length;return result;};
      const title=node('div');title.className='askgpt-hover-gloss-word';title.textContent=take(value.headword,96);card.appendChild(title);
      if(value.phonetic){const phonetic=node('div');phonetic.className='askgpt-hover-gloss-phonetic';phonetic.textContent=take(value.phonetic,64);card.appendChild(phonetic);}
      for(const sense of value.senses){if(remaining<2)break;const row=node('div');row.className='askgpt-hover-gloss-sense';const pos=sense.partOfSpeech?take(sense.partOfSpeech+' ',21):'';let meaning='';for(const item of sense.meanings){if(!remaining)break;if(meaning)meaning+=take('；',1);meaning+=take(item,remaining);}row.textContent=pos+meaning;card.appendChild(row);}
      const width=win.innerWidth||doc.documentElement?.clientWidth||scroll?.clientWidth||640,height=win.innerHeight||doc.documentElement?.clientHeight||scroll?.clientHeight||480,available=Math.max(1,width-16),cardWidth=Math.min(280,available),maxHeight=Math.max(1,height-16);
      card.style.setProperty('width',cardWidth+'px');card.style.setProperty('max-height',maxHeight+'px');card.style.setProperty('left',Math.max(8,Math.min(candidate.hit.rect[0],width-cardWidth-8))+'px');
      doc.body.appendChild(card);const measured=card.getBoundingClientRect?.()?.height||card.offsetHeight||110,cardHeight=Math.min(maxHeight,measured);let top=candidate.hit.rect[3]+8;
      if(top+cardHeight>height-8)top=candidate.hit.rect[1]-cardHeight-8;card.style.setProperty('top',Math.max(8,Math.min(top,height-cardHeight-8))+'px');
      report('hoverRendered','hoverRender');
    }
    function launch(candidate){
      if(current!==candidate||!candidate.ready||blocked()){if(blocked())clear();return;}
      const key=candidate.hit.word;if(cache.has(key)){const value=cache.get(key);remember(cache,key,value,256);render(candidate,value);return;}
      const miss=misses.get(key);if(miss&&miss>Date.now())return;if(miss)misses.delete(key);if(inFlight||typeof options.lookup!=='function')return;
      const task={key,candidate};inFlight=task;
      report('hoverLookup','hoverLookup');
      Promise.resolve().then(()=>options.lookup(key)).then(result=>{
        const value=entryValue(result,key);if(value)remember(cache,key,value,256);else remember(misses,key,Date.now()+30000,64);
        if(current===candidate&&!blocked()&&value)render(candidate,value);
      }).catch(()=>{report('hoverError','hoverLookup');}).finally(()=>{if(inFlight===task)inFlight=null;if(current?.ready&&current!==candidate)launch(current);});
    }
    function onMove(event){
      report('hoverMove','hoverEvent');if(blocked(event)){clear();return;}const hit=wordAt(view,event,()=>report('hoverError','hoverGeometry'));if(!hit){report('hoverMiss','hoverGeometry');clear();return;}report('hoverHit','hoverGeometry');
      if(current?.hit.key===hit.key){if(current.ready||Math.hypot(event.clientX-current.x,event.clientY-current.y)<=3)return;}
      clear();const candidate={hit,x:event.clientX,y:event.clientY,ready:false};current=candidate;
      timer=win.setTimeout(callback(()=>{timer=null;if(current!==candidate)return;candidate.ready=true;launch(candidate);}),450);
    }
    function listen(target,type,fn,capture=false){if(!target?.addEventListener)return;const exported=callback(fn);target.addEventListener(type,exported,capture);removers.push(()=>target.removeEventListener(type,exported,capture));}
    if(win&&doc?.body&&typeof win.setTimeout==='function'){
      style=node('style');style.setAttribute('data-askgpt-hover-gloss','style');style.textContent='.askgpt-hover-gloss{box-sizing:border-box;overflow:hidden;padding:10px 12px;border:1px solid light-dark(#0003,#fff4);border-radius:9px;background:light-dark(rgb(255 255 255 / 96%),rgb(38 38 40 / 97%));color:CanvasText;color-scheme:light dark;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 4px 18px #0002;backdrop-filter:blur(14px);overflow-wrap:anywhere;user-select:none}.askgpt-hover-gloss-word{font-size:14px;font-weight:650;line-height:1.3}.askgpt-hover-gloss-phonetic{font-size:11px;opacity:.7;margin-top:2px}.askgpt-hover-gloss-sense{margin-top:4px}@media(prefers-reduced-transparency:reduce){.askgpt-hover-gloss{background:Canvas;backdrop-filter:none}}@media(prefers-contrast:more){.askgpt-hover-gloss{background:Canvas;border:2px solid CanvasText;box-shadow:none;backdrop-filter:none}}@media(forced-colors:active){.askgpt-hover-gloss{background:Canvas;color:CanvasText;border:2px solid CanvasText;box-shadow:none;backdrop-filter:none}}';
      (doc.head||doc.body).appendChild(style);
      listen(win,'pointermove',onMove,true);
      for(const name of ['pointerdown','pointercancel','pointerleave','mouseleave','wheel','blur','keydown','resize','dragstart','drop','contextmenu'])listen(win,name,clear,true);
      listen(win,'pointerout',event=>{if(!event.relatedTarget||event.relatedTarget.ownerDocument!==doc)clear();},true);
      listen(scroll,'scroll',clear,true);listen(win,'scroll',clear,true);listen(doc,'selectionchange',clear,true);
      const bus=win.PDFViewerApplication?.eventBus;if(bus?.on&&bus?.off)for(const name of ['scalechanging','rotationchanging','pagerendered']){const handler=callback(clear);bus.on(name,handler);removers.push(()=>bus.off(name,handler));}
      report('hoverAttached','hoverAttach');
    }else report('hoverError','hoverAttach');
    return {clear,dispose(){if(disposed)return;disposed=true;clear();for(const remove of removers.splice(0)){try{remove();}catch(_){}}style?.remove?.();style=null;cache.clear();misses.clear();}};
  }
  const api={install,wordAt};root.AskGPTPDFHoverGloss=api;if(typeof module!=='undefined')module.exports=api;
})(this);
