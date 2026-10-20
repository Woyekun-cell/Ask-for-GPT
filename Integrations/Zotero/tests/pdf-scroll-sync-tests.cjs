const assert=require('node:assert/strict'),vm=require('node:vm'),Sync=require('../content/pdf-scroll-sync.js');
let checks=0;const check=(name,test)=>{test();checks++;console.log('PASS '+name);};
function nativeView({scale=1,rotation=0,left=0,top=0,boxLeft=10,boxTop=20,preview=1,pages=[0],kind='canvas'}={}){
  let x=left,y=top;const writes=[],navigations=[],reads=[];
  const scroll={clientLeft:0,clientTop:0,get scrollLeft(){return x;},set scrollLeft(value){writes.push(['left',value]);x=value;},get scrollTop(){return y;},set scrollTop(value){writes.push(['top',value]);y=value;},getBoundingClientRect:()=>({left:boxLeft,top:boxTop,width:400,height:600})};
  const viewport={width:(rotation%180?800:600)*scale,height:(rotation%180?600:800)*scale,
    convertToPdfPoint(a,b){return rotation===90?[b/scale,800-a/scale]:rotation===180?[600-a/scale,b/scale]:[a/scale,800-b/scale];},
    convertToViewportPoint(a,b){return rotation===90?[(800-b)*scale,a*scale]:rotation===180?[(600-a)*scale,b*scale]:[a*scale,(800-b)*scale];}};
  const viewer={currentScale:scale,getPageView(index){reads.push(index);if(!pages.includes(index))return null;const canvas={getBoundingClientRect:()=>({left:boxLeft-scroll.scrollLeft,top:boxTop+index*(viewport.height*preview+10)-scroll.scrollTop,width:viewport.width*preview,height:viewport.height*preview})},div={querySelector:()=>kind==='wrapper'?canvas:null,getBoundingClientRect:canvas.getBoundingClientRect};return {viewport,...(kind==='canvas'?{canvas}:{}),div};},scrollPageIntoView:value=>navigations.push(value)};
  return {_iframeWindow:{PDFViewerApplication:{pdfViewer:viewer},document:{getElementById:id=>id==='viewerContainer'?scroll:null}},scroll,viewer,viewport,writes,navigations,reads};
}
function fixture({source={},target={},mapState=(lane,state)=>state}={}){
  let enabled=true,leader='source',id=0;const frames=new Map(),views={source:nativeView(source),target:nativeView(target)},mapped=[],errors=[];
  const win={requestAnimationFrame:callback=>{frames.set(++id,callback);return id;},cancelAnimationFrame:id=>frames.delete(id)};
  const sync=Sync.create({win,getView:lane=>views[lane],isEnabled:()=>enabled,isLeader:lane=>lane===leader,mapState:(lane,state)=>{mapped.push({lane,state});return mapState(lane,state);},invoke:(object,name,...args)=>Reflect.apply(object[name],object,args),onError:error=>errors.push(error)});
  return {views,sync,win,frames,mapped,errors,setLeader:value=>leader=value,setEnabled:value=>enabled=value,flush(){const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks)callback();}};
}
check('a frame coalesces every input into one fractional physical-origin update',()=>{
  const f=fixture({source:{top:0},target:{top:0}});for(let i=0;i<100;i++){f.views.source.scroll.scrollTop=i*.125;assert(f.sync.schedule('source',{pageIndex:0,left:0,top:Math.round(800-i*.125)}));}
  assert.equal(f.frames.size,1);assert.equal(f.mapped.length,0);f.flush();assert.equal(f.mapped.length,1);assert.equal(f.mapped[0].state.top,787.625);assert.equal(f.views.target.scroll.scrollTop,12.375);assert.equal(f.views.target.navigations.length,0);assert.deepEqual(f.errors,[]);f.sync.dispose();
});
check('fractional native offsets remain continuous rather than snapping to integer PDF coordinates',()=>{
  const f=fixture({source:{scale:2},target:{scale:3}});for(const top of [10.5,11,11.5,12]){f.views.source.scroll.scrollTop=top;f.sync.schedule('source',{pageIndex:0,left:0,top:Math.round(800-top/2)});f.flush();assert(Math.abs(f.views.target.scroll.scrollTop-top*1.5)<1e-10);}
  assert.equal(f.views.target.navigations.length,0);assert.equal(f.views.source.viewer.currentScale,2);assert.equal(f.views.target.viewer.currentScale,3);f.sync.dispose();
});
check('both leader directions respect independent native scales and a real mapped page index',()=>{
  const f=fixture({source:{scale:1.25,pages:[0,5],top:5*(800*1.25+10)+100,left:25},target:{scale:2,pages:[0,1]},mapState:(lane,state)=>({...state,pageIndex:lane==='source'?1:5})});f.sync.schedule('source',{pageIndex:5,left:0,top:0});f.flush();assert.equal(f.views.target.scroll.scrollTop,1*(800*2+10)+160);assert.equal(f.views.target.scroll.scrollLeft,40);assert.equal(f.views.target.reads.at(-1),1);
  f.setLeader('target');f.views.target.scroll.scrollTop+=.8;f.sync.schedule('target',{pageIndex:1,left:0,top:0});f.flush();assert(Math.abs(f.views.source.scroll.scrollTop-(5*(800*1.25+10)+100.5))<1e-9);assert.equal(f.views.source.reads.at(-1),5);f.sync.dispose();
});
check('native viewport rotations and an in-flight CSS preview transform determine both axes without changing scale',()=>{
  const f=fixture({source:{rotation:90,scale:2,preview:1.5,top:36,left:264},target:{scale:1.25}});f.sync.schedule('source',{pageIndex:0,left:0,top:0});f.flush();assert.equal(f.mapped[0].state.left,12);assert.equal(f.mapped[0].state.top,712);assert.equal(f.views.target.scroll.scrollLeft,15);assert.equal(f.views.target.scroll.scrollTop,110);assert.equal(f.views.source.viewer.currentScale,2);assert.equal(f.views.target.viewer.currentScale,1.25);f.sync.dispose();
});
check('hover does not override the externally owned input leader and a real leader change discards old pending work',()=>{
  const f=fixture({source:{top:20},target:{top:30}});f.views.target.hovered=true;assert.equal(f.sync.schedule('target',{pageIndex:0,left:0,top:500}),false);f.sync.schedule('source',{pageIndex:0,left:0,top:700});f.setLeader('target');f.flush();assert.equal(f.mapped.length,0);assert.equal(f.views.target.scroll.scrollTop,30);f.sync.schedule('target',{pageIndex:0,left:0,top:700});f.flush();assert.equal(f.views.source.scroll.scrollTop,30);f.sync.dispose();
});
check('disabling the link between input and frame execution never moves either native view',()=>{
  const f=fixture({source:{top:20},target:{top:30}});f.sync.schedule('source',{pageIndex:0,left:0,top:700});f.setEnabled(false);f.flush();assert.equal(f.mapped.length,0);assert.equal(f.sync.schedule('source',{pageIndex:0,left:0,top:700}),false);assert.equal(f.views.target.scroll.scrollTop,30);f.sync.dispose();
});
check('missing geometry uses one realm-safe XYZ fallback per frame and deduplicates the same destination',()=>{
  const f=fixture({source:{pages:[]},target:{pages:[]},mapState:(lane,state)=>({...state,pageIndex:3})});for(let i=0;i<100;i++)f.sync.schedule('source',{pageIndex:0,left:12.5,top:712.25});f.flush();assert.equal(f.views.target.navigations.length,1);assert.deepEqual(f.views.target.navigations[0],{pageNumber:4,destArray:[null,{name:'XYZ'},12.5,712.25,null],allowNegativeOffset:true});
  for(let i=0;i<10;i++){f.sync.schedule('source',{pageIndex:0,left:12.5,top:712.25});f.flush();}assert.equal(f.views.target.navigations.length,1);f.sync.schedule('source',{pageIndex:0,left:12.5,top:712.75});f.flush();assert.equal(f.views.target.navigations.length,2);f.sync.dispose();
});
check('a missing peer viewport still receives a precise origin from the available leader geometry',()=>{
  const f=fixture({source:{scale:2,top:17.75,left:21.5},target:{pages:[]}});f.sync.schedule('source',{pageIndex:0,left:11,top:791});f.flush();assert.deepEqual(f.views.target.navigations[0].destArray,[null,{name:'XYZ'},10.75,791.125,null]);f.sync.dispose();
});
check('an unavailable native coordinate converter uses the bounded fallback instead of pretending rounded input is fractional geometry',()=>{
  const f=fixture({source:{top:17.75},target:{}});delete f.views.source.viewport.convertToPdfPoint;f.sync.schedule('source',{pageIndex:0,left:11,top:782});f.flush();assert.deepEqual(f.views.target.writes,[]);assert.deepEqual(f.views.target.navigations[0].destArray,[null,{name:'XYZ'},11,782,null]);f.sync.dispose();
});
check('sub-quarter-pixel differences do not assign offsets and repeated identical geometry performs no extra writes',()=>{
  const f=fixture({source:{top:10.1,left:20.1},target:{top:10,left:20}});f.sync.schedule('source',{pageIndex:0,left:0,top:700});f.flush();assert.deepEqual(f.views.target.writes,[]);f.views.source.scroll.scrollTop=10.5;f.sync.schedule('source',{pageIndex:0,left:0,top:700});f.flush();assert.deepEqual(f.views.target.writes,[['top',10.5]]);f.sync.schedule('source',{pageIndex:0,left:0,top:700});f.flush();assert.equal(f.views.target.writes.length,1);f.sync.dispose();
});
check('reset and disposal cancel queued frames and reset only the owned fallback history',()=>{
  const f=fixture({source:{pages:[]},target:{pages:[]}});f.sync.schedule('source',{pageIndex:0,left:0,top:700});f.sync.reset();assert.equal(f.frames.size,0);f.flush();assert.equal(f.mapped.length,0);f.sync.schedule('source',{pageIndex:0,left:0,top:700});f.flush();assert.equal(f.views.target.navigations.length,1);f.sync.reset();f.sync.schedule('source',{pageIndex:0,left:0,top:700});f.flush();assert.equal(f.views.target.navigations.length,2);f.sync.schedule('source',{pageIndex:0,left:0,top:500});f.sync.dispose();assert.equal(f.frames.size,0);f.flush();assert.equal(f.views.target.navigations.length,2);assert.equal(f.sync.schedule('source',{pageIndex:0,left:0,top:500}),false);
});
check('a retired animation callback cannot consume a newly scheduled request after reset',()=>{
  const f=fixture({source:{top:20}});f.sync.schedule('source',{pageIndex:0,left:0,top:700});const retired=[...f.frames.values()][0];f.sync.reset();f.views.source.scroll.scrollTop=40;f.sync.schedule('source',{pageIndex:0,left:0,top:600});retired();assert.equal(f.mapped.length,0);assert.equal(f.views.target.scroll.scrollTop,0);f.flush();assert.equal(f.mapped.length,1);assert.equal(f.views.target.scroll.scrollTop,40);f.sync.dispose();
});
check('foreign native point arrays are normalized locally and wrapper/div geometry remains supported',()=>{
  for(const kind of ['wrapper','div']){const f=fixture({source:{kind,top:17.5},target:{kind}}),method=f.views.source.viewport.convertToPdfPoint;f.views.source.viewport.convertToPdfPoint=function(...args){return new Proxy(vm.runInNewContext(JSON.stringify(method(...args))),{get:(object,key,receiver)=>['map','every','slice'].includes(key)?undefined:Reflect.get(object,key,receiver)});};f.sync.schedule('source',{pageIndex:0,left:0,top:700});f.flush();assert.equal(f.views.target.scroll.scrollTop,17.5);assert.equal(f.errors.length,0);f.sync.dispose();}
});
check('nonfinite input or mapped output cannot enter native navigation and failures do not leave a running frame',()=>{
  const f=fixture({source:{pages:[]},target:{pages:[]},mapState:(lane,state)=>state});for(const pageIndex of [-1,NaN,Infinity,1e8])assert.equal(f.sync.schedule('source',{pageIndex,left:0,top:700}),false);for(const top of [NaN,Infinity,1e8]){f.sync.schedule('source',{pageIndex:0,left:0,top});f.flush();}assert.equal(f.views.target.navigations.length,0);assert.equal(f.frames.size,0);f.sync.dispose();
  const g=fixture({mapState:()=>{throw Error('mapping failed');}});g.sync.schedule('source',{pageIndex:0,left:0,top:700});g.flush();assert.equal(g.errors.length,1);assert.equal(g.frames.size,0);assert.deepEqual(g.views.target.writes,[]);g.sync.dispose();
});
check('a failed animation or timer scheduling attempt reports once and leaves the next input free to retry',()=>{
  for(const timer of [false,true]){const f=fixture({source:{top:35}});let attempts=0;const schedule=callback=>{if(++attempts===1)throw Object.assign(Error('native scheduler denied'),{name:'SecurityError'});f.frames.set(attempts,callback);return attempts;};if(timer){delete f.win.requestAnimationFrame;f.win.setTimeout=(callback,delay)=>{assert.equal(delay,16);return schedule(callback);};f.win.clearTimeout=id=>f.frames.delete(id);}else f.win.requestAnimationFrame=schedule;
    assert.equal(f.sync.schedule('source',{pageIndex:0,left:0,top:700}),false);assert.equal(f.errors.length,1);assert.equal(f.errors[0].name,'SecurityError');assert.equal(f.frames.size,0);assert.equal(f.sync.schedule('source',{pageIndex:0,left:0,top:600}),true);assert.equal(attempts,2);f.flush();assert.equal(f.mapped.length,1);assert.equal(f.views.target.scroll.scrollTop,35);assert.equal(f.errors.length,1);f.sync.dispose();
  }
});
check('cancellation errors cannot preserve a retired generation, consume its replacement, or block disposal',()=>{
  for(const timer of [false,true]){const f=fixture({source:{top:20}});if(timer){delete f.win.requestAnimationFrame;let id=0;f.win.setTimeout=callback=>{f.frames.set(++id,callback);return id;};f.win.clearTimeout=()=>{throw Error('retired timer window');};}else f.win.cancelAnimationFrame=()=>{throw Error('retired animation window');};
    f.sync.schedule('source',{pageIndex:0,left:0,top:700});const retired=[...f.frames.values()][0];assert.doesNotThrow(()=>f.sync.reset());assert.equal(f.errors.length,1);f.views.source.scroll.scrollTop=40;assert.equal(f.sync.schedule('source',{pageIndex:0,left:0,top:600}),true);retired();assert.equal(f.mapped.length,0);f.flush();assert.equal(f.mapped.length,1);assert.equal(f.views.target.scroll.scrollTop,40);f.sync.schedule('source',{pageIndex:0,left:0,top:500});const disposing=[...f.frames.values()];assert.doesNotThrow(()=>f.sync.dispose());for(const callback of disposing)callback();assert.equal(f.mapped.length,1);assert.equal(f.errors.length,2);assert.equal(f.sync.schedule('source',{pageIndex:0,left:0,top:400}),false);
  }
});
check('animation and timer callbacks enter the supplied native realm bridge before scheduling and cancellation',()=>{
  for(const timer of [false,true]){const context=vm.createContext({}),win=vm.runInContext(`({callbacks:[],cancelled:[],
    requestAnimationFrame(callback){if(!(callback instanceof Function))throw Error('foreign callback');this.callbacks.push(callback);return this.callbacks.length;},
    setTimeout(callback,delay){if(!(callback instanceof Function)||delay!==16)throw Error('foreign timer callback');this.callbacks.push(callback);return this.callbacks.length;},
    cancelAnimationFrame(id){this.cancelled.push(id);},clearTimeout(id){this.cancelled.push(id);}})`,context);if(timer)delete win.requestAnimationFrame;
    const wrap=vm.runInContext('(callback=>function(...values){return callback(...values);})',context),calls=[],views={source:nativeView({top:23.5}),target:nativeView()},errors=[];const sync=Sync.create({win,getView:lane=>views[lane],mapState:(_,state)=>state,invoke(object,name,...args){calls.push(name);return Reflect.apply(object[name],object,args.map(value=>typeof value==='function'?wrap(value):value));},onError:error=>errors.push(error)});
    assert.equal(sync.schedule('source',{pageIndex:0,left:0,top:700}),true);assert(calls.includes(timer?'setTimeout':'requestAnimationFrame'));win.callbacks[0]();assert.equal(views.target.scroll.scrollTop,23.5);assert.deepEqual(errors,[]);sync.schedule('source',{pageIndex:0,left:0,top:600});sync.reset();assert(calls.includes(timer?'clearTimeout':'cancelAnimationFrame'));assert.deepEqual(Array.from(win.cancelled),[2]);sync.dispose();
  }
});
console.log(checks+' native PDF scroll synchronization tests passed');
