(function(root){
  'use strict';
  const XHTML='http://www.w3.org/1999/xhtml';
  const validRect=value=>Array.isArray(value)&&value.length===4&&value.every(Number.isFinite)&&value[2]>value[0]&&value[3]>value[1];
  function coordinates(value,length){
    if(!Array.isArray(value))return null;
    // Native PDF.js arrays can hide inherited methods behind a Gecko Xray.
    // Normalize only returned coordinates, never the native viewport/window.
    const local=JSON.parse(JSON.stringify(value));
    return Array.isArray(local)&&local.length===length&&local.every(Number.isFinite)?local:null;
  }
  function install(view,options={}){
    const win=view?._iframeWindow,doc=win?.document,application=win?.PDFViewerApplication,viewer=application?.pdfViewer,scroll=doc?.getElementById?.('viewerContainer');
    let disposed=false,selected=null,overlay=null,frame=null;
    const removers=[];
    const enabled=()=>!disposed&&(typeof options.enabled==='function'?options.enabled():options.enabled!==false);
    const lane=()=>options.getLane?.()==='source'?'source':'target';
    const alignment=()=>options.getAlignment?.();
    const node=(name,kind)=>{const item=doc.createElementNS(XHTML,name);if(kind)item.setAttribute('data-askgpt-reading-focus',kind);return item;};
    function report(error){try{clear(false);}catch(_){}try{options.onError?.(error);}catch(_){}}
    const safe=(callback,fallback)=>function(...args){try{return callback(...args);}catch(error){report(error);return fallback;}};
    const nativeCallback=callback=>options.exportCallback?options.exportCallback(safe(callback)):safe(callback);
    function listen(target,type,callback,capture=false){if(!target?.addEventListener)return;const handler=nativeCallback(callback);target.addEventListener(type,handler,capture);removers.push(()=>target.removeEventListener(type,handler,capture));}
    function notify(value){try{options.onFocus?.(value);}catch(error){report(error);}}
    function removeOverlay(){overlay?.remove?.();overlay=null;}
    function clear(notifyChange=true){const had=Boolean(selected);selected=null;removeOverlay();if(frame!==null)win?.cancelAnimationFrame?.(frame);frame=null;if(had&&notifyChange)notify(null);return had;}
    function resolve(value){
      if(!value||!Number.isInteger(value.outputPage)||typeof value.paragraphID!=='string')return null;
      const page=alignment()?.pages?.find(item=>item.outputPage===value.outputPage),paragraph=page?.paragraphs?.find(item=>item.id===value.paragraphID),side=lane();
      const rects=paragraph?.[side]?.rects;
      if(!page||!paragraph||!Array.isArray(rects)||!rects.length||!rects.every(validRect))return null;
      const index=side==='source'?page.sourcePage:page.outputPage,pageView=viewer?.getPageView?.(index);
      if(!pageView?.viewport||!pageView.div)return null;
      return {page,paragraph,side,pageView,rects};
    }
    function geometry(pageView){
      const viewport=pageView.viewport,canvas=pageView.canvas||pageView.div.querySelector?.('.canvasWrapper')||pageView.div,box=canvas.getBoundingClientRect?.();
      if(!box||![box.left,box.top,box.width,box.height,viewport.width,viewport.height].every(Number.isFinite)||box.width<=0||box.height<=0||viewport.width<=0||viewport.height<=0)return null;
      return {viewport,box,x:box.width/viewport.width,y:box.height/viewport.height};
    }
    function paint(){
      frame=null;if(!enabled()){clear(false);return;}if(!selected)return;const item=resolve(selected),position=item&&geometry(item.pageView);
      if(!item||!position){removeOverlay();return;}
      const {viewport,box,x,y}=position;if(typeof viewport.convertToViewportPoint!=='function'){removeOverlay();return;}
      const rectangles=item.rects.map(rect=>{
        // A native content function cannot read a chrome-owned rectangle.
        // PDF.js applies this same affine transform to its two corners; pass
        // only primitive coordinates and normalize each returned native array.
        const start=coordinates(viewport.convertToViewportPoint(rect[0],rect[1]),2),end=coordinates(viewport.convertToViewportPoint(rect[2],rect[3]),2);
        if(!start||!end)return null;const value=[...start,...end];
        return [box.left+Math.min(value[0],value[2])*x,box.top+Math.min(value[1],value[3])*y,box.left+Math.max(value[0],value[2])*x,box.top+Math.max(value[1],value[3])*y];
      });
      if(rectangles.some(value=>!validRect(value))){removeOverlay();return;}
      const width=win.innerWidth||doc.documentElement?.clientWidth||scroll?.clientWidth||0,height=win.innerHeight||doc.documentElement?.clientHeight||scroll?.clientHeight||0;
      const left=Math.max(0,Math.min(...rectangles.map(r=>r[0]))-4),top=Math.max(0,Math.min(...rectangles.map(r=>r[1]))-4),right=Math.min(width,Math.max(...rectangles.map(r=>r[2]))+4),bottom=Math.min(height,Math.max(...rectangles.map(r=>r[3]))+4);
      if(!(right>left&&bottom>top)){removeOverlay();return;}
      removeOverlay();overlay=node('div');overlay.className='askgpt-reading-focus';overlay.setAttribute('aria-hidden','true');overlay.setAttribute('style','position:fixed;inset:0;pointer-events:none;z-index:2147482000;');
      function place(item,rect){for(const [name,value] of [['left',rect[0]],['top',rect[1]],['width',Math.max(0,rect[2]-rect[0])],['height',Math.max(0,rect[3]-rect[1])]])item.style.setProperty(name,value+'px');}
      for(const rect of [[0,0,width,top],[0,bottom,width,height],[0,top,left,bottom],[right,top,width,bottom]]){const mask=node('div','shade');mask.setAttribute('style','position:fixed;pointer-events:none;background:light-dark(rgb(28 28 30 / 14%),rgb(0 0 0 / 32%));');place(mask,rect);overlay.appendChild(mask);}
      for(const rect of rectangles){const outline=node('div','box');outline.setAttribute('style','position:fixed;box-sizing:border-box;pointer-events:none;border:1px solid light-dark(rgb(36 36 38 / 35%),rgb(235 235 245 / 40%));border-radius:3px;');place(outline,rect);overlay.appendChild(outline);}
      doc.body.appendChild(overlay);
    }
    function refresh(){if(!enabled()){clear(false);return;}if(!selected||frame!==null)return;if(typeof win.requestAnimationFrame==='function')frame=win.requestAnimationFrame(nativeCallback(paint));else paint();}
    function focus(value,notifyChange=false){
      if(value==null){return clear(notifyChange);}if(!enabled()||!resolve(value))return false;const item=resolve(value);selected={outputPage:item.page.outputPage,sourcePage:item.page.sourcePage,paragraphID:item.paragraph.id,lane:item.side};paint();if(notifyChange)notify({...selected});return true;
    }
    function onClick(event){
      if(!enabled()){clear(false);return;}if(event.defaultPrevented||event.button!==0||!event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
      let pageNode=event.target;for(let depth=0;pageNode&&depth<20;depth++,pageNode=pageNode.parentNode){if(pageNode.getAttribute?.('data-page-number'))break;}
      const pageNumber=Number(pageNode?.getAttribute?.('data-page-number')),index=pageNumber-1,pageView=Number.isInteger(index)&&index>=0?viewer?.getPageView?.(index):null,position=pageView&&geometry(pageView);
      const outputPage=typeof options.getOutputPage==='function'?options.getOutputPage(index):index,page=alignment()?.pages?.find(item=>item.outputPage===outputPage);
      if(!position||!page||typeof position.viewport.convertToPdfPoint!=='function'){clear();return;}
      const {viewport,box,x,y}=position,point=coordinates(viewport.convertToPdfPoint((event.clientX-box.left)/x,(event.clientY-box.top)/y),2),side=lane();
      if(!point){clear();return;}
      const paragraph=page.paragraphs?.find(item=>Array.isArray(item[side]?.rects)&&item[side].rects.every(validRect)&&item[side].rects.some(rect=>point[0]>=rect[0]-1&&point[0]<=rect[2]+1&&point[1]>=rect[1]-1&&point[1]<=rect[3]+1));
      if(!paragraph){clear();return;}
      event.preventDefault();event.stopImmediatePropagation();
      if(selected?.outputPage===outputPage&&selected.paragraphID===paragraph.id){clear();return;}
      focus({outputPage,paragraphID:paragraph.id},true);
    }
    function onKey(event){if(!enabled()){clear(false);return;}if(event.key==='Escape'&&selected&&!event.ctrlKey&&!event.metaKey){clear();event.preventDefault();event.stopImmediatePropagation();}}
    if(win&&doc&&viewer){
      listen(win,'click',onClick,true);listen(win,'keydown',onKey,true);listen(win,'resize',refresh);listen(scroll,'scroll',refresh);
      const bus=application.eventBus;if(bus?.on&&bus?.off)for(const name of ['scalechanging','pagerendered','rotationchanging']){const callback=nativeCallback(refresh);bus.on(name,callback);removers.push(()=>bus.off(name,callback));}
    }
    return {get active(){return Boolean(selected);},clear:safe(clear,false),focus:safe(focus,false),dispose(){if(disposed)return;disposed=true;clear(false);for(const remove of removers.splice(0))remove();}};
  }
  const api={install};root.AskGPTPDFReadingTools=api;if(typeof module!=='undefined')module.exports=api;
})(this);
