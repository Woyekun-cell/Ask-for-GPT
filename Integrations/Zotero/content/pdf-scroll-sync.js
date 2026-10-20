(function(root){
  'use strict';
  const finite=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=10000000;
  const page=value=>Number.isInteger(value)&&value>=0&&value<=10000000;
  const location=value=>page(value?.pageIndex)?{pageIndex:value.pageIndex,left:value.left,top:value.top}:null;
  function create(options){
    const {win}=options;let disposed=false,pending=null,frame=null;const fallbacks=new Map();
    const invoke=(object,name,...args)=>typeof object?.[name]==='function'?(options.invoke?options.invoke(object,name,...args):Reflect.apply(object[name],object,args)):undefined;
    const report=error=>{try{options.onError?.(error);}catch(_){/* A diagnostic callback cannot retain or revive pending scroll work. */}};
    const active=lane=>!disposed&&(options.isEnabled?.()??true)&&(options.isLeader?.(lane)??true);
    function point(value){try{const local=JSON.parse(JSON.stringify(value));return Array.isArray(local)&&local.length===2&&local.every(finite)?local:null;}catch(_){return null;}}
    function geometry(candidate,index){
      try{
        const target=candidate?._iframeWindow,viewer=target?.PDFViewerApplication?.pdfViewer,scroll=target?.document?.getElementById('viewerContainer'),view=invoke(viewer,'getPageView',index),viewport=view?.viewport;
        const canvas=view?.canvas||view?.div?.querySelector?.('.canvasWrapper')||view?.div,box=invoke(canvas,'getBoundingClientRect'),holder=invoke(scroll,'getBoundingClientRect');
        if(!viewport||!scroll||![box?.left,box?.top,box?.width,box?.height,holder?.left,holder?.top,viewport.width,viewport.height,scroll.scrollTop,scroll.scrollLeft].every(finite)||box.width<=0||box.height<=0||viewport.width<=0||viewport.height<=0)return null;
        const x=box.width/viewport.width,y=box.height/viewport.height;if(!finite(x)||!finite(y)||x<=0||y<=0)return null;
        return {viewport,scroll,box,x,y,left:holder.left+(finite(scroll.clientLeft)?scroll.clientLeft:0),top:holder.top+(finite(scroll.clientTop)?scroll.clientTop:0)};
      }catch(_){return null;}
    }
    function sameFallback(previous,candidate,viewer,state){return previous?.candidate===candidate&&previous.viewer===viewer&&previous.pageIndex===state.pageIndex&&Math.abs(previous.left-state.left)<1e-7&&Math.abs(previous.top-state.top)<1e-7;}
    function fallback(candidate,lane,state){
      const viewer=candidate?._iframeWindow?.PDFViewerApplication?.pdfViewer;
      if(typeof viewer?.scrollPageIntoView!=='function'||!finite(state.left)||!finite(state.top)||sameFallback(fallbacks.get(lane),candidate,viewer,state))return;
      invoke(viewer,'scrollPageIntoView',{pageNumber:state.pageIndex+1,destArray:[null,{name:'XYZ'},state.left,state.top,null],allowNegativeOffset:true});
      fallbacks.set(lane,{candidate,viewer,...state});
    }
    function flush(){
      frame=null;const request=pending;pending=null;if(!request||!active(request.lane))return;
      try{
        const lane=request.lane,peerLane=lane==='source'?'target':'source',candidate=options.getView(lane),peer=options.getView(peerLane);if(!candidate||!peer||candidate===peer)return;
        const sourceGeometry=geometry(candidate,request.state.pageIndex),sourcePoint=sourceGeometry&&point(invoke(sourceGeometry.viewport,'convertToPdfPoint',(sourceGeometry.left-sourceGeometry.box.left)/sourceGeometry.x,(sourceGeometry.top-sourceGeometry.box.top)/sourceGeometry.y));
        const state=sourcePoint?{...request.state,left:sourcePoint[0],top:sourcePoint[1]}:request.state;
        const mapped=location(options.mapState(lane,state));if(!mapped||!finite(mapped.left)||!finite(mapped.top)||!active(lane))return;
        const peerGeometry=geometry(peer,mapped.pageIndex),value=peerGeometry&&point(invoke(peerGeometry.viewport,'convertToViewportPoint',mapped.left,mapped.top));
        if(!sourcePoint||!peerGeometry||!value){fallback(peer,peerLane,mapped);return;}
        const dx=peerGeometry.box.left+value[0]*peerGeometry.x-peerGeometry.left,dy=peerGeometry.box.top+value[1]*peerGeometry.y-peerGeometry.top;
        if(!finite(dx)||!finite(dy))return;
        // The browser owns scrolling and momentum. Preserve fractional CSS
        // offsets instead of replaying rounded PDF.js navigation destinations.
        if(Math.abs(dx)>=.25){const left=peerGeometry.scroll.scrollLeft+dx;if(finite(left))peerGeometry.scroll.scrollLeft=left;}
        if(Math.abs(dy)>=.25){const top=peerGeometry.scroll.scrollTop+dy;if(finite(top))peerGeometry.scroll.scrollTop=top;}
        fallbacks.delete(peerLane);
      }catch(error){report(error);}
    }
    function reset(){const retired=frame;pending=null;frame=null;fallbacks.clear();if(retired)try{invoke(win,retired.raf?'cancelAnimationFrame':'clearTimeout',retired.id);}catch(error){report(error);}}
    return {
      schedule(lane,state){
        if(!['source','target'].includes(lane)||!active(lane))return false;const value=location(state);if(!value)return false;pending={lane,state:value};
        if(frame!==null)return true;const request={raf:false,id:null};frame=request;const run=()=>{if(frame===request)flush();};
        try{
          request.raf=typeof win?.requestAnimationFrame==='function';
          if(request.raf)request.id=invoke(win,'requestAnimationFrame',run);else if(typeof win?.setTimeout==='function')request.id=invoke(win,'setTimeout',run,16);else{frame=null;pending=null;return false;}return true;
        }catch(error){if(frame===request){frame=null;pending=null;}report(error);return false;}
      },reset,
      dispose(){if(disposed)return;disposed=true;reset();}
    };
  }
  const api={create};root.AskGPTPDFScrollSync=api;if(typeof module!=='undefined')module.exports=api;
})(this);
