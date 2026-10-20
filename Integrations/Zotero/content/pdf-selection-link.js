(function(root){
  'use strict';
  const XHTML='http://www.w3.org/1999/xhtml';
  const finite=n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=10000000;
  const rect=r=>Array.isArray(r)&&r.length===4&&r.every(finite)&&r[2]>r[0]&&r[3]>r[1];
  function coordinates(value){
    if(!Array.isArray(value))return null;
    const local=JSON.parse(JSON.stringify(value));
    return Array.isArray(local)&&local.length===2&&local.every(finite)?local:null;
  }
  // A purely visual counterpart to the native, unsaved text selection. Every
  // rectangle has already passed the exact glyph mapper. This module never
  // touches annotations, tools, text selection, the clipboard or document data.
  function create({sourceView,targetView,exportCallback=callback=>callback}){
    let disposed=false;const states=new Map();
    const resolve=side=>side==='source'?sourceView:typeof targetView==='function'?targetView():targetView;
    const current=state=>!disposed&&states.get(state.side)===state;
    function hide(entry){if(entry.node&&entry.visible){entry.node.style.setProperty('display','none');entry.visible=false;}}
    function draw(state){
      if(!current(state))return;
      const native=resolve(state.side),app=native?._iframeWindow?.PDFViewerApplication,pdf=app?.pdfViewer,doc=native?._iframeWindow?.document;
      if(!pdf||!doc?.createElementNS){for(const entry of state.entries)hide(entry);return;}
      for(const entry of state.entries){
        const page=typeof pdf.getPageView==='function'?pdf.getPageView(entry.pageIndex):pdf._pages?.[entry.pageIndex],viewport=page?.viewport,r=entry.rect;
        if(!page?.div||typeof viewport?.convertToViewportPoint!=='function'){hide(entry);continue;}
        // Pass only primitives across the native PDF.js boundary. Its returned
        // arrays are normalized locally without touching a Window or viewport.
        const start=coordinates(viewport.convertToViewportPoint(r[0],r[1])),end=coordinates(viewport.convertToViewportPoint(r[2],r[3]));
        if(!start||!end){hide(entry);continue;}const box=[...start,...end],x=Math.min(box[0],box[2]),y=Math.min(box[1],box[3]),width=Math.abs(box[2]-box[0]),height=Math.abs(box[3]-box[1]);
        if(![x,y,width,height].every(finite)||!width||!height){hide(entry);continue;}
        if(!entry.node){entry.node=doc.createElementNS(XHTML,'div');entry.node.setAttribute('class','askgpt-selection-link');entry.node.setAttribute('aria-hidden','true');}
        if(entry.node.parentNode!==page.div)page.div.appendChild(entry.node);
        const style=`position:absolute;left:${x}px;top:${y}px;width:${width}px;height:${height}px;box-sizing:border-box;pointer-events:none;user-select:none;z-index:8;border:1px solid rgba(0,122,255,.42);border-radius:2px;background:rgba(0,122,255,.12);`;
        if(!entry.visible||entry.style!==style){entry.node.setAttribute('style',style);entry.style=style;entry.visible=true;}
      }
    }
    function schedule(state){
      if(!current(state)||state.frame!==null)return;const win=resolve(state.side)?._iframeWindow;
      if(typeof win?.requestAnimationFrame!=='function'){draw(state);return;}
      const frame={win,id:null};state.frame=frame;frame.id=win.requestAnimationFrame(exportCallback(()=>{if(state.frame!==frame)return;state.frame=null;if(current(state))draw(state);}));
    }
    function clear(side){const entries=side?[states.get(side)].filter(Boolean):[...states.values()];for(const state of entries){const frame=state.frame;state.frame=null;if(frame)try{frame.win.cancelAnimationFrame?.(frame.id);}catch(_){/* A retired window can no longer cancel; the generation guard still rejects its callback. */}for(const entry of state.entries)entry.node?.remove();for(const remove of state.removers)remove();states.delete(state.side);}}
    function show(side,annotation){
      if(disposed||!['source','target'].includes(side)||!['highlight','underline'].includes(annotation?.type)){clear(side);return false;}
      // JSON normalization also removes Gecko cross-window array prototypes.
      let position;try{const raw=annotation.position;position=JSON.parse(JSON.stringify({pageIndex:raw?.pageIndex,rects:raw?.rects,...(raw?.nextPageRects!==undefined?{nextPageRects:raw.nextPageRects}:{})}));}catch(_){clear(side);return false;}
      if(!Number.isInteger(position?.pageIndex)||position.pageIndex<0||!Array.isArray(position.rects)||!position.rects.length||!position.rects.every(rect)||position.nextPageRects!==undefined&&(!Array.isArray(position.nextPageRects)||!position.nextPageRects.length||!position.nextPageRects.every(rect))){clear(side);return false;}
      const native=resolve(side),signature=JSON.stringify(position),previous=states.get(side);if(previous?.native===native&&previous.signature===signature){schedule(previous);return true;}
      clear(side);const entries=position.rects.map(rect=>({pageIndex:position.pageIndex,rect}));if(position.nextPageRects)entries.push(...position.nextPageRects.map(rect=>({pageIndex:position.pageIndex+1,rect})));
      const state={side,native,signature,entries,frame:null,removers:[]};states.set(side,state);
      const bus=native?._iframeWindow?.PDFViewerApplication?.eventBus;
      if(typeof bus?.on==='function'&&typeof bus?.off==='function')for(const event of ['pagerendered','scalechanging','rotationchanging','updateviewarea']){const callback=exportCallback(()=>schedule(state));bus.on(event,callback);state.removers.push(()=>bus.off(event,callback));}
      draw(state);return true;
    }
    return {show,clear,dispose(){if(disposed)return;disposed=true;clear();}};
  }
  const api={create};root.AskGPTPDFSelectionLink=api;if(typeof module!=='undefined')module.exports=api;
})(this);
