(function(root){
  'use strict';
  const XHTML='http://www.w3.org/1999/xhtml';
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  function rectangle(value){if(!value)return null;const result=[value[0],value[1],value[2],value[3]];return result.every(finite)&&result.every(n=>Math.abs(n)<=10000000)&&result[2]>result[0]&&result[3]>result[1]?result:null;}
  function validateAnchor(value){
    try{
      if(!value||value.schema!==1||typeof value.fingerprint!=='string'||!/^[a-f0-9]{16,128}$/.test(value.fingerprint)||!Number.isInteger(value.pageCount)||value.pageCount<1||value.pageCount>2000||!Number.isInteger(value.pageIndex)||value.pageIndex<0||value.pageIndex>=value.pageCount||!Number.isInteger(value.start)||value.start<0||!Number.isInteger(value.end)||value.end<=value.start||value.end>100000||value.end-value.start>2048||typeof value.signature!=='string'||!/^[a-f0-9]{64}$/.test(value.signature)||!finite(value.capturedAt)||value.capturedAt<0||!Array.isArray(value.rects)||!value.rects.length||value.rects.length>32)return null;
      const rects=value.rects.map(rectangle);if(rects.some(r=>!r))return null;
      return {schema:1,fingerprint:value.fingerprint,pageCount:value.pageCount,pageIndex:value.pageIndex,start:value.start,end:value.end,rects,signature:value.signature,capturedAt:value.capturedAt};
    }catch(_){return null;}
  }
  // Synchronous UTF-8 SHA-256, shared in form with the native annotation bridge.
  // The persisted value is a digest of glyphs and geometry, never PDF prose.
  function sha256(text){
    const bytes=[];for(const c of text){let n=c.codePointAt(0);if(n>=0xd800&&n<=0xdfff)n=0xfffd;if(n<128)bytes.push(n);else if(n<2048)bytes.push(192|(n>>6),128|(n&63));else if(n<65536)bytes.push(224|(n>>12),128|((n>>6)&63),128|(n&63));else bytes.push(240|(n>>18),128|((n>>12)&63),128|((n>>6)&63),128|(n&63));}
    const bits=bytes.length*8;bytes.push(128);while(bytes.length%64!==56)bytes.push(0);const high=Math.floor(bits/4294967296),low=bits>>>0;for(const n of [high,low])bytes.push((n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255);
    const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2],w=new Uint32Array(64),r=(n,b)=>(n>>>b)|(n<<(32-b));
    for(let offset=0;offset<bytes.length;offset+=64){for(let i=0;i<16;i++)w[i]=(bytes[offset+4*i]<<24)|(bytes[offset+4*i+1]<<16)|(bytes[offset+4*i+2]<<8)|bytes[offset+4*i+3];for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];w[i]=(w[i-16]+(r(a,7)^r(a,18)^(a>>>3))+w[i-7]+(r(b,17)^r(b,19)^(b>>>10)))>>>0;}let [a,b,c,d,e,f,g,j]=h;for(let i=0;i<64;i++){const t=(j+(r(e,6)^r(e,11)^r(e,25))+((e&f)^((~e)&g))+k[i]+w[i])>>>0,u=((r(a,2)^r(a,13)^r(a,22))+((a&b)^(a&c)^(b&c)))>>>0;j=g;g=f;f=e;e=(d+t)>>>0;d=c;c=b;b=a;a=(t+u)>>>0;}for(const [i,n] of [a,b,c,d,e,f,g,j].entries())h[i]=(h[i]+n)>>>0;}
    return h.map(n=>n.toString(16).padStart(8,'0')).join('');
  }
  function install(view,options={}){
    const win=view?._iframeWindow,doc=win?.document,app=win?.PDFViewerApplication,viewer=app?.pdfViewer,scroll=doc?.getElementById?.('viewerContainer'),removers=[],timers=new Set(),reported=new Set();
    let disposed=false,restoreCancelled=false,restoreStarted=false,restorePrepared=false,restoreAttempts=0,restoreTimer=null,captureTimer=null,candidate=null,stable=null,overlay=null,readingInput=false;
    let loaded=null;try{loaded=validateAnchor(options.load?.());}catch(_){diagnostic('load');}
    const enabled=()=>{try{return !disposed&&(typeof options.enabled==='function'?options.enabled():options.enabled!==false);}catch(_){return false;}};
    function diagnostic(detail){const stage=detail==='attached'?'resumeAttached':detail==='saved'?'resumeSaved':detail==='restored'?'resumeRestored':detail==='skipped'?'resumeSkipped':'resumeError';if(reported.has(stage+detail))return;reported.add(stage+detail);const details={attached:'resumeAttach',saved:'resumeSave',restored:'resumeRestore',skipped:'resumeRestore',load:'resumeLoad',save:'resumeSave',compatibility:'resumeCapture'};try{options.onDiagnostic?.(stage,{name:'ResumeDiagnostic',code:stage==='resumeError'?'compatibility':'rendered',errorDetail:details[detail]||'resumeCapture'});}catch(_){}}
    const callback=fn=>{const safe=function(...args){try{return fn(...args);}catch(_){diagnostic('compatibility');cancelRestore();cancelCapture();}};return typeof options.exportCallback==='function'?options.exportCallback(safe):safe;};
    function schedule(fn,delay){let id;id=win.setTimeout(callback(()=>{timers.delete(id);fn();}),delay);timers.add(id);return id;}
    function cancelTimer(id){if(id!==null){win?.clearTimeout?.(id);timers.delete(id);}}
    function listen(target,type,fn,capture=true){if(!target?.addEventListener)return;const handler=callback(fn);target.addEventListener(type,handler,capture);removers.push(()=>target.removeEventListener(type,handler,capture));}
    function removeOverlay(){overlay?.remove?.();overlay=null;}
    function cancelRestore(){restoreCancelled=true;cancelTimer(restoreTimer);restoreTimer=null;removeOverlay();}
    function cancelCapture(){cancelTimer(captureTimer);captureTimer=null;candidate=null;}
    function selection(){const selected=win?.getSelection?.(),range=view?._selectionRanges?.[0];return Boolean(selected&&selected.isCollapsed===false||range&&range.collapsed!==true||view?._selectionPopup?.annotation||view?._annotationPopup?.annotation);}
    function identity(){const pdf=app?.pdfDocument,fingerprint=pdf?.fingerprints?.[0],pageCount=viewer?.pagesCount;return typeof fingerprint==='string'&&/^[a-f0-9]{16,128}$/.test(fingerprint)&&Number.isInteger(pageCount)&&pageCount>0&&pageCount<=2000&&pdf.numPages===pageCount?{fingerprint,pageCount}:null;}
    function geometry(index){const page=viewer?.getPageView?.(index),viewport=page?.viewport,canvas=page?.canvas||page?.div?.querySelector?.('.canvasWrapper')||page?.div,box=canvas?.getBoundingClientRect?.();if(!viewport||typeof viewport.convertToViewportPoint!=='function'||!box||![box.left,box.top,box.width,box.height,viewport.width,viewport.height].every(finite)||box.width<=0||box.height<=0||viewport.width<=0||viewport.height<=0)return null;return {page,viewport,box,x:box.width/viewport.width,y:box.height/viewport.height};}
    function clientRect(rect,g){const a=g.viewport.convertToViewportPoint(rect[0],rect[1]),b=g.viewport.convertToViewportPoint(rect[2],rect[3]);if(!a||!b||![a[0],a[1],b[0],b[1]].every(finite))return null;return rectangle([g.box.left+Math.min(a[0],b[0])*g.x,g.box.top+Math.min(a[1],b[1])*g.y,g.box.left+Math.max(a[0],b[0])*g.x,g.box.top+Math.max(a[1],b[1])*g.y]);}
    function charsAt(index){const native=view?._pdfPages?.[index]?.chars;if(!native||!Number.isInteger(native.length)||!native.length||native.length>100000)return null;const chars=[];for(let i=0;i<native.length;i++){const ch=native[i];if(typeof ch?.c!=='string'||ch.c.length>16)return null;chars.push({c:ch.c,rect:rectangle(ch.rect),rotation:ch.rotation===undefined?0:ch.rotation,ignorable:Boolean(ch.ignorable),spaceAfter:Boolean(ch.spaceAfter),wordBreakAfter:Boolean(ch.wordBreakAfter),lineBreakAfter:Boolean(ch.lineBreakAfter),paragraphBreakAfter:Boolean(ch.paragraphBreakAfter)});}return chars;}
    function sentenceRects(chars,start,end){
      const rects=[];let line=null,previous=null;
      for(let i=start;i<end;i++){const c=chars[i];if(c.ignorable)continue;if(!c.rect||!finite(c.rotation)||c.rotation%360!==0)return null;
        if(previous&&!previous.lineBreakAfter&&!previous.paragraphBreakAfter){const p=previous.rect,r=c.rect,h=Math.max(p[3]-p[1],r[3]-r[1]);if(Math.abs((p[1]+p[3]-r[1]-r[3])/2)>h*.6||r[0]-p[2]>h*4)return null;}
        if(!line)line=c.rect.slice();else line=[Math.min(line[0],c.rect[0]),Math.min(line[1],c.rect[1]),Math.max(line[2],c.rect[2]),Math.max(line[3],c.rect[3])];previous=c;
        if(c.lineBreakAfter||c.paragraphBreakAfter||i===end-1){rects.push(line);line=null;}
      }
      if(line)rects.push(line);if(!rects.length||rects.length>32)return null;
      for(let i=1;i<rects.length;i++){const a=rects[i-1],b=rects[i],h=Math.max(a[3]-a[1],b[3]-b[1]);if(b[1]>a[1]+h*.5||a[1]-b[1]>h*4||Math.abs(a[0]-b[0])>h*8)return null;}
      return rects;
    }
    function sentences(index){
      const chars=charsAt(index);if(!chars||typeof Intl?.Segmenter!=='function')return [];
      const rows=[];let text='',map=[];
      function finish(){if(!text.trim())return;const segmenter=new Intl.Segmenter(undefined,{granularity:'sentence'});for(const segment of segmenter.segment(text)){let from=segment.index,to=from+segment.segment.length;while(from<to&&/\s/.test(text[from]))from++;while(to>from&&/\s/.test(text[to-1]))to--;const source=text.slice(from,to);if(source.length<3||source.length>2048||!/[.!?。！？][\]})"'”’»]*$/u.test(source))continue;
          while(from<to&&map[from]===undefined)from++;while(to>from&&map[to-1]===undefined)to--;const start=map[from],end=map[to-1]+1;if(!Number.isInteger(start)||!Number.isInteger(end)||end-start>2048)continue;
          // A lower-case fragment at a page edge can continue the previous page.
          if(start===0&&index>0&&/^\p{Ll}/u.test(source))continue;
          const rects=sentenceRects(chars,start,end);if(!rects)continue;const signature=sha256(JSON.stringify(chars.slice(start,end).map(c=>[c.c,c.rect,c.ignorable,c.spaceAfter,c.wordBreakAfter,c.lineBreakAfter,c.paragraphBreakAfter])));rows.push({start,end,rects,signature});
        }text='';map=[];}
      for(let i=0;i<chars.length;i++){const c=chars[i];if(!c.ignorable){for(let j=0;j<c.c.length;j++)map[text.length+j]=i;text+=c.c;if(c.spaceAfter||c.wordBreakAfter||c.lineBreakAfter||c.paragraphBreakAfter)text+=' ';}if(c.paragraphBreakAfter)finish();}
      finish();return rows;
    }
    function visible(row,index,all=true){const g=geometry(index);if(!g)return null;const width=win.innerWidth||scroll?.clientWidth||0,height=win.innerHeight||scroll?.clientHeight||0,rects=row.rects.map(r=>clientRect(r,g));if(rects.some(r=>!r))return null;const valid=r=>r[0]>=0&&r[1]>=0&&r[2]<=width&&r[3]<=height;if(all&&!rects.every(valid)||!all&&!rects.some(r=>r[2]>0&&r[0]<width&&r[3]>0&&r[1]<height))return null;return rects;}
    function build(row,index){const id=identity();return id&&validateAnchor({schema:1,...id,pageIndex:index,...row,capturedAt:Date.now()});}
    function matching(anchor){if(!anchor||anchor.pageIndex!==viewer.currentPageNumber-1)return null;const id=identity();if(!id||id.fingerprint!==anchor.fingerprint||id.pageCount!==anchor.pageCount)return null;return sentences(anchor.pageIndex).find(row=>row.start===anchor.start&&row.end===anchor.end&&row.signature===anchor.signature&&JSON.stringify(row.rects)===JSON.stringify(anchor.rects))||null;}
    function viewportCandidate(){if(!enabled()||selection())return null;const index=viewer.currentPageNumber-1;if(!Number.isInteger(index)||index<0)return null;const top=scroll?.getBoundingClientRect?.()?.top||0,height=scroll?.clientHeight||win.innerHeight||0,target=top+height/3;let best=null,distance=Infinity;for(const row of sentences(index)){const rects=visible(row,index,true);if(!rects)continue;const d=Math.min(...rects.map(r=>Math.abs((r[1]+r[3])/2-target)));if(d<distance){distance=d;best=row;}}return best&&build(best,index);}
    function clickedCandidate(event){if(!enabled()||event.defaultPrevented||event.button!==0||event.buttons||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||event.pointerType&&event.pointerType!=='mouse'||!finite(event.clientX)||!finite(event.clientY)||selection())return null;let node=event.target;for(let n=0;node&&n<30;n++,node=node.parentNode)if(node.getAttribute?.('data-page-number'))break;const index=Number(node?.getAttribute?.('data-page-number'))-1;if(index!==viewer.currentPageNumber-1)return null;for(const row of sentences(index)){const rects=visible(row,index,true);if(rects?.some(r=>event.clientX>=r[0]&&event.clientX<=r[2]&&event.clientY>=r[1]&&event.clientY<=r[3]))return build(row,index);}return null;}
    function flush(){if(!stable)return false;try{if(options.save?.(validateAnchor(stable))===false){diagnostic('save');return false;}stable=null;diagnostic('saved');return true;}catch(_){diagnostic('save');return false;}}
    function settle(value){if(!enabled()||selection())return;const current=value||viewportCandidate();if(!current||!matching(current)||!visible(current,current.pageIndex,true))return;stable=current;flush();}
    function capture(value){cancelCapture();candidate=value;captureTimer=schedule(()=>{captureTimer=null;const value=candidate;candidate=null;settle(value);},1200);}
    function onPointerUp(event){readingInput=true;cancelRestore();cancelCapture();const value=clickedCandidate(event);if(value)capture(value);}
    function onInput(event){if((event?.type==='blur'||event?.type==='resize')&&!enabled()&&!restoreStarted&&restoreTimer===null)return;if(event?.type!=='blur'&&event?.type!=='resize')readingInput=true;cancelRestore();cancelCapture();}
    function onLayoutChange(){cancelCapture();if(overlay||readingInput)cancelRestore();}
    function onScroll(){
      // Zotero restores scrollTop before resolving initialization; the resulting
      // scroll/RAF notifications can arrive afterward. Only explicit reading
      // input may turn those notifications into a new saved location.
      if(!readingInput){cancelCapture();if(overlay)cancelRestore();return;}
      onInput();if(enabled())capture(null);
    }
    function paint(anchor){
      const rects=visible(anchor,anchor.pageIndex,true);if(!rects)return false;removeOverlay();overlay=doc.createElementNS(XHTML,'div');overlay.setAttribute('data-askgpt-reading-resume','overlay');overlay.setAttribute('aria-hidden','true');for(const [key,value] of [['position','fixed'],['inset','0'],['pointer-events','none'],['z-index','2147481900'],['opacity','1']])overlay.style.setProperty(key,value);
      const reduced=win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches===true;overlay.style.setProperty('transition',reduced?'none':'opacity 500ms ease-out');
      for(const r of rects){const node=doc.createElementNS(XHTML,'div');node.setAttribute('style','position:fixed;pointer-events:none;box-sizing:border-box;background:light-dark(rgb(255 208 70 / 32%),rgb(255 208 70 / 26%));outline:1px solid light-dark(rgb(148 105 0 / 28%),rgb(255 221 130 / 36%));border-radius:2px;');for(const [key,value] of [['left',r[0]-1],['top',r[1]-1],['width',r[2]-r[0]+2],['height',r[3]-r[1]+2]])node.style.setProperty(key,value+'px');overlay.appendChild(node);}
      doc.body.appendChild(overlay);diagnostic('restored');if(!reduced)schedule(()=>{if(overlay)overlay.style.setProperty('opacity','0');},2500);schedule(removeOverlay,3000);return true;
    }
    function prepareRestore(){
      const id=identity();if(restorePrepared||view?._pdfPages?.[loaded.pageIndex]?.chars?.length||typeof view?._ensureBasicPageData!=='function'||loaded.pageIndex!==viewer.currentPageNumber-1||!id||id.fingerprint!==loaded.fingerprint||id.pageCount!==loaded.pageCount)return;
      // The native full-document processor may finish after our restore window.
      // Ask its existing local page API for only the saved page, once.
      restorePrepared=true;
      try{Promise.resolve(view._ensureBasicPageData(loaded.pageIndex)).catch(()=>{if(!disposed&&!restoreCancelled)diagnostic('compatibility');});}catch(_){diagnostic('compatibility');}
    }
    function restore(){restoreTimer=null;if(disposed||restoreCancelled||!loaded)return;if(selection()){cancelRestore();return;}if(!enabled()){if(restoreStarted)cancelRestore();return;}restoreStarted=true;prepareRestore();if(matching(loaded)&&paint(loaded)){restoreCancelled=true;return;}if(++restoreAttempts>=20){restoreCancelled=true;diagnostic('skipped');return;}restoreTimer=schedule(restore,250);}
    function refresh(){if(disposed)return;if(!enabled()){cancelTimer(restoreTimer);restoreTimer=null;if(restoreStarted)cancelRestore();cancelCapture();return;}if(!restoreCancelled&&!restoreStarted&&loaded&&restoreTimer===null)restoreTimer=schedule(restore,250);}
    function clear(){cancelRestore();cancelCapture();stable=null;}
    if(win&&doc?.body&&viewer&&typeof win.setTimeout==='function'){
      for(const type of ['pointerdown','wheel','keydown','blur','pointercancel','dragstart'])listen(win,type,onInput);
      listen(win,'pointerup',onPointerUp);listen(doc,'selectionchange',event=>{if(selection())onInput(event);});listen(scroll,'scroll',onScroll);listen(win,'resize',onLayoutChange);
      const bus=app.eventBus;if(bus?.on&&bus?.off)for(const type of ['pagerendered','scalechanging','rotationchanging']){const handler=callback(type==='pagerendered'?()=>{if(!restoreStarted)refresh();}:onLayoutChange);bus.on(type,handler);removers.push(()=>bus.off(type,handler));}
      diagnostic('attached');refresh();
    }
    return {clear,refresh,flush,noteInput(){if(enabled())onInput();},dispose(){if(disposed)return;flush();disposed=true;cancelRestore();cancelCapture();for(const id of [...timers])cancelTimer(id);for(const remove of removers.splice(0)){try{remove();}catch(_){}}}};
  }
  const api={install,validateAnchor};root.AskGPTPDFReadingResume=api;if(typeof module!=='undefined')module.exports=api;
})(this);
