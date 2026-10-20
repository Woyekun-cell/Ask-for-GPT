(function(root){
  'use strict';
  // Each native iframe owns its own PDF.js scale and pointer coordinates.
  // Never transform a canvas independently from its selectable text layer.
  function install(view,options={}){
    const win=view?._iframeWindow,application=win?.PDFViewerApplication,viewer=application?.pdfViewer,scroll=win?.document?.getElementById('viewerContainer');
    if(!win?.addEventListener||!scroll)return {dispose(){}};
    const removers=[];let frame=null,zooms=[],pan=null,panLinked=null,panSequence=0,lastTime=null,panDirection=0,disposed=false,wheelTicks=0,wheelFactor=1;
    const enabled=()=>!disposed&&(options.enabled?.()??true),activate=()=>{if(enabled())options.activate?.();};
    const listen=(target,event,callback,settings)=>{if(options.listen){removers.push(options.listen(target,event,callback,settings));return;}target.addEventListener(event,callback,settings);removers.push(()=>target.removeEventListener(event,callback,settings));};
    const cancel=()=>{if(frame!==null)win.cancelAnimationFrame?.(frame);frame=null;zooms=[];pan=null;panLinked=null;lastTime=null;panDirection=0;};
    const reduced=win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const invoke=(object,name,...values)=>options.invoke?options.invoke(object,name,...values):object?.[name]?.(...values);
    const normalInput=()=>{zooms=[];pan=null;panLinked=null;lastTime=null;panDirection=0;options.onNormalInput?.();};
    const animate=time=>{
      frame=null;if(!enabled()){cancel();return;}
      const queued=zooms;zooms=[];for(const zoom of queued){if(!zoom.steps&&(zoom.scaleFactor===undefined||zoom.scaleFactor===1))continue;if(options.zoom)options.zoom(zoom);else invoke(viewer,'updateScale',{scaleFactor:zoom.scaleFactor,steps:zoom.steps,origin:zoom.origin,drawingDelay:400});}
      if(pan!==null){const difference=pan-scroll.scrollLeft,elapsed=lastTime===null?16:Math.min(32,Math.max(1,time-lastTime));lastTime=time;
        const final=reduced||Math.abs(difference)<=1,delta=final?difference:difference*(1-Math.exp(-elapsed/26));if(options.pan)options.pan({delta,linked:panLinked,sequence:panSequence});else scroll.scrollLeft+=delta;
        if(final){pan=null;panLinked=null;lastTime=null;}
      }
      if(pan!==null)frame=win.requestAnimationFrame(animate);
    };
    const schedule=()=>{if(frame!==null)return;if(win.requestAnimationFrame)frame=win.requestAnimationFrame(animate);else animate(0);};
    const distance=event=>{const raw=event.deltaY||event.deltaX;if(!Number.isFinite(raw))return 0;return raw*(event.deltaMode===1?parseFloat(win.getComputedStyle?.(scroll)?.lineHeight)||16:event.deltaMode===2?scroll.clientHeight||800:1);};
    const nativeZoom=event=>{
      const x=event.deltaX||0,y=event.deltaY||0,mode=event.deltaMode||0,factor=Math.exp(-y/100),pinch=!application._isCtrlKeyDown&&mode===0&&x===0&&Math.abs(factor-1)<.05&&!(event.deltaZ||0);
      if(pinch&&application.supportsPinchToZoom){
        if(typeof application._accumulateFactor==='function')return {scaleFactor:invoke(application,'_accumulateFactor',viewer.currentScale,factor,'_wheelUnusedFactor')};
        const scale=viewer.currentScale||1;if(wheelFactor>1&&factor<1||wheelFactor<1&&factor>1)wheelFactor=1;const accumulated=Math.floor(scale*factor*wheelFactor*100)/(100*scale);wheelFactor=factor/accumulated;return {scaleFactor:accumulated};
      }
      let delta=Math.hypot(x,y);const angle=Math.atan2(y,x);if(-.25*Math.PI<angle&&angle<.75*Math.PI)delta=-delta;
      if(mode===1||mode===2){if(Math.abs(delta)>=1)return {steps:Math.sign(delta)};}else delta/=30;
      if(typeof application._accumulateTicks==='function')return {steps:invoke(application,'_accumulateTicks',delta,'_wheelUnusedTicks')};
      if(wheelTicks>0&&delta<0||wheelTicks<0&&delta>0)wheelTicks=0;wheelTicks+=delta;const steps=Math.trunc(wheelTicks);wheelTicks-=steps;return {steps};
    };
    listen(win,'pointerenter',activate,true);listen(win,'pointermove',activate,true);listen(win,'pointerdown',event=>{activate();if(enabled()&&!event.altKey&&!event.ctrlKey&&!event.metaKey)normalInput();},true);listen(win,'focus',activate,true);
    listen(win,'wheel',event=>{
      if(!enabled()||event.defaultPrevented)return;
      const linked=event.ctrlKey&&!event.altKey&&!event.metaKey&&!event.shiftKey,zoom=linked||event.altKey&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey,linkedPan=event.metaKey&&!event.altKey&&!event.ctrlKey&&!event.shiftKey,move=linkedPan||event.altKey&&event.shiftKey&&!event.metaKey&&!event.ctrlKey;
      if(!zoom&&!move){if(!event.ctrlKey&&!event.metaKey&&!event.altKey&&((Number.isFinite(event.deltaX)&&event.deltaX!==0)||(Number.isFinite(event.deltaY)&&event.deltaY!==0))){activate();normalInput();}return;}
      const delta=distance(event);if(!delta)return;activate();event.preventDefault();event.stopImmediatePropagation();
      if(zoom){options.onZoom?.({linked});pan=null;panLinked=null;lastTime=null;panDirection=0;if(linked&&(application._isScrolling||win.document.visibilityState==='hidden'||application.overlayManager?.active))return;const input=linked?nativeZoom(event):{scaleFactor:Math.exp(-Math.max(-300,Math.min(300,delta))*.0025)},previous=zooms.at(-1),steps=input.steps!==undefined,entry=previous?.linked===Boolean(linked)&&(previous.steps!==undefined)===steps?previous:{...(steps?{steps:0}:{scaleFactor:1}),linked:Boolean(linked)};if(entry!==previous)zooms=[entry];if(steps)entry.steps+=input.steps;else entry.scaleFactor*=input.scaleFactor;entry.origin=[event.clientX,event.clientY];const number=Number(event.target?.closest?.('.page')?.dataset?.pageNumber);entry.pageIndex=Number.isInteger(number)&&number>0?number-1:undefined;schedule();return;}
      zooms=[];
      options.onPan?.({linked:linkedPan});if(panLinked!==Boolean(linkedPan)){pan=null;lastTime=null;panDirection=0;}panLinked=Boolean(linkedPan);
      const horizontal=Number.isFinite(event.deltaX)&&event.deltaX!==0,raw=horizontal?event.deltaX:event.deltaY,unit=event.deltaMode===1?parseFloat(win.getComputedStyle?.(scroll)?.lineHeight)||16:event.deltaMode===2?(horizontal?scroll.clientWidth:scroll.clientHeight)||800:1,amount=raw*unit,sign=Math.sign(amount),start=pan===null||sign!==panDirection?scroll.scrollLeft:pan;
      if(pan===null||sign!==panDirection)panSequence++;
      pan=Math.max(0,Math.min(Math.max(0,scroll.scrollWidth-scroll.clientWidth),start+amount));panDirection=sign;schedule();
    },{capture:true,passive:false});
    listen(win,'keydown',event=>{
      if(enabled()&&!event.defaultPrevented&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End','Space'].includes(event.code)){activate();normalInput();}
      if(!enabled()||event.defaultPrevented||!event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
      const grow=['Equal','NumpadAdd'].includes(event.code)||event.key==='+',shrink=['Minus','NumpadSubtract'].includes(event.code)||event.key==='-';
      if(!grow&&!shrink)return;activate();cancel();options.onZoom?.();event.preventDefault();event.stopImmediatePropagation();invoke(view,grow?'zoomIn':'zoomOut');
    },true);
    return {reset(){cancel();},dispose(){if(disposed)return;disposed=true;cancel();for(const remove of removers.splice(0))remove();}};
  }
  const api={install};root.AskGPTPDFPaneGestures=api;if(typeof module!=='undefined')module.exports=api;
})(this);
