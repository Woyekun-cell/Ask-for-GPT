const assert=require('node:assert/strict');
const DOM=require('./fake-dom.cjs');
const vm=require('node:vm');
let Reading;try{Reading=require('../content/pdf-reading-tools.js');}catch(_){}
let checks=0;
async function check(name,test){await test();checks++;process.stdout.write('PASS '+name+'\n');}
function fixture({lane='target',rotated=false,installOptions={}}={}){
 const {win,viewer}=DOM.pdfWindow();win.innerWidth=800;win.innerHeight=600;
 const page=new DOM.Element(win.document,'div'),canvas=new DOM.Element(win.document,'canvas');page.setAttribute('data-page-number',lane==='source'?'6':'1');page.appendChild(canvas);viewer.appendChild(page);
 canvas.getBoundingClientRect=()=>({left:40,top:60,width:rotated?800:600,height:rotated?600:800});page.getBoundingClientRect=canvas.getBoundingClientRect;
 const viewport={width:rotated?800:600,height:rotated?600:800,convertToPdfPoint:(x,y)=>rotated?[y,x]:[x,800-y],convertToViewportPoint:(x,y)=>rotated?[y,x]:[x,800-y],convertToViewportRectangle:r=>rotated?[r[1],r[0],r[3],r[2]]:[r[0],800-r[1],r[2],800-r[3]]};
 const events=new Map(),pageView={div:page,canvas,viewport},nativeIndex=lane==='source'?5:0;
 win.PDFViewerApplication={pdfViewer:{getPageView:index=>index===nativeIndex?pageView:null},eventBus:{on(name,fn){events.set(name,fn);},off(name,fn){if(events.get(name)===fn)events.delete(name);}}};
 const alignment={pages:[{sourcePage:5,outputPage:0,paragraphs:[{id:'p5_0',source:{rects:[[10,700,100,720]]},target:{rects:[[20,650,130,680]]}},{id:'p5_1',source:{rects:[[10,400,100,420]]},target:{rects:[[20,350,130,380]]}}]}]};
 const focused=[],view={_iframeWindow:win},options={getAlignment:()=>alignment,getLane:()=>lane,getOutputPage:index=>index===nativeIndex?0:-1,onFocus:value=>focused.push(value),...installOptions};
 const layer=Reading.install(view,options);
 function click(x=75,y=190,extra={}){return win.emit('click',{button:0,altKey:true,clientX:x,clientY:y,target:canvas,...extra});}
 return {win,viewer,page,canvas,viewport,pageView,alignment,focused,events,layer,options,click};
}
(async()=>{
 await check('reading focus is an isolated native PDF view module',()=>assert.equal(typeof Reading?.install,'function'));
 await check('Option click finds the real translated paragraph without writing annotation state',()=>{
  const f=fixture();try{const event=f.click();assert.equal(event.defaultPrevented,true);assert.equal(f.layer.active,true);assert.deepEqual(f.focused[0],{outputPage:0,sourcePage:5,paragraphID:'p5_0',lane:'target'});
   const box=f.win.document.body.allNodes().find(n=>n.getAttribute('data-askgpt-reading-focus')==='box');assert(box);assert.equal(box.style.getPropertyValue('left'),'60px');assert.equal(box.style.getPropertyValue('top'),'180px');
  }finally{f.layer.dispose();}
 });
 await check('ordinary selection and Option wheel remain native',()=>{
  const f=fixture();try{assert.equal(f.click(75,190,{altKey:false}).defaultPrevented,undefined);assert.equal(f.win.listeners.get('wheel')?.size||0,0);assert.equal(f.layer.active,false);assert.equal(f.focused.length,0);}finally{f.layer.dispose();}
 });
 await check('repeated same paragraph, blank Option click and Escape cancel transient focus',()=>{
  const f=fixture();try{f.click();f.click();assert.equal(f.layer.active,false);f.click();f.click(500,500);assert.equal(f.layer.active,false);f.click();const event=f.win.emit('keydown',{key:'Escape'});assert.equal(event.defaultPrevented,true);assert.equal(f.layer.active,false);assert.equal(f.focused.at(-1),null);}finally{f.layer.dispose();}
 });
 await check('a source physical page resolves through its output page mapping and PDF geometry',()=>{
  const f=fixture({lane:'source'});try{f.click(70,150);assert.equal(f.layer.active,true);assert.equal(f.focused[0].sourcePage,5);assert.equal(f.focused[0].lane,'source');}finally{f.layer.dispose();}
 });
 await check('rotated native viewport is converted through PDF.js instead of guessed proportions',()=>{
  const f=fixture({rotated:true});try{f.click(705,100);assert.equal(f.layer.active,true);const box=f.win.document.body.allNodes().find(n=>n.getAttribute('data-askgpt-reading-focus')==='box');assert.equal(box.style.getPropertyValue('left'),'690px');assert.equal(box.style.getPropertyValue('top'),'80px');}finally{f.layer.dispose();}
 });
 await check('native viewport receives only numeric coordinate arguments when chrome-owned rectangle access is forbidden',()=>{
  for(const [lane,x,y,left,top] of [['target',75,190,'60px','180px'],['source',70,150,'50px','140px']]){
   const errors=[],calls=[],f=fixture({lane,installOptions:{onError:error=>errors.push(error)}});try{
    const point=f.viewport.convertToViewportPoint;f.viewport.convertToViewportRectangle=()=>{throw Error('Permission denied to access property 0');};f.viewport.convertToViewportPoint=(x,y)=>{assert.equal(typeof x,'number');assert.equal(typeof y,'number');calls.push([x,y]);return point(x,y);};
    f.click(x,y);assert.equal(f.layer.active,true);assert.equal(errors.length,0);assert.equal(calls.length,2);const box=f.win.document.body.allNodes().find(node=>node.getAttribute('data-askgpt-reading-focus')==='box');assert(box);assert.equal(box.style.getPropertyValue('left'),left);assert.equal(box.style.getPropertyValue('top'),top);
   }finally{f.layer.dispose();}
  }
 });
 await check('foreign native coordinate arrays with hidden prototype methods still focus the exact source and target paragraph',()=>{
  const foreign=values=>new Proxy(vm.runInNewContext(JSON.stringify(values)),{get(target,key,receiver){return ['every','map','filter','slice'].includes(key)?undefined:Reflect.get(target,key,receiver);}});
  for(const [lane,x,y,left,top] of [['target',75,190,'60px','180px'],['source',70,150,'50px','140px']]){
   const f=fixture({lane});try{const point=f.viewport.convertToPdfPoint,viewportPoint=f.viewport.convertToViewportPoint;f.viewport.convertToPdfPoint=(...values)=>foreign(point(...values));f.viewport.convertToViewportPoint=(...values)=>foreign(viewportPoint(...values));
    assert.equal(foreign([1,2]).every,undefined);const event=f.click(x,y);assert.equal(event.defaultPrevented,true);assert.equal(f.layer.active,true);const box=f.win.document.body.allNodes().find(node=>node.getAttribute('data-askgpt-reading-focus')==='box');assert(box);assert.equal(box.style.getPropertyValue('left'),left);assert.equal(box.style.getPropertyValue('top'),top);
   }finally{f.layer.dispose();}
  }
 });
 await check('native layout notifications enter through exported callbacks and unregister those same callbacks',()=>{
  const exported=new Set();let calls=0;
  const f=fixture({installOptions:{exportCallback(callback){const bridge=(...args)=>{calls++;return callback(...args);};exported.add(bridge);return bridge;}}});try{
   f.layer.focus({outputPage:0,paragraphID:'p5_1'});f.canvas.getBoundingClientRect=()=>({left:50,top:80,width:300,height:400});
   for(const name of ['scalechanging','pagerendered','rotationchanging']){const callback=f.events.get(name);assert(exported.has(callback),'a content event bus must receive the exported function');callback();}
   const box=f.win.document.body.allNodes().find(node=>node.getAttribute('data-askgpt-reading-focus')==='box');assert.equal(box.style.getPropertyValue('left'),'60px');assert.equal(box.style.getPropertyValue('top'),'290px');assert.equal(calls,3);f.layer.dispose();assert.equal(f.events.size,0);
  }finally{f.layer.dispose();}
 });
 await check('captured native DOM events and deferred drawing use exported callbacks and dispose the exact listener handles',()=>{
  const exported=new Set();let calls=0;
  const f=fixture({installOptions:{exportCallback(callback){const bridge=(...args)=>{calls++;return callback(...args);};exported.add(bridge);return bridge;}}});try{
   for(const [target,name] of [[f.win,'click'],[f.win,'keydown'],[f.win,'resize'],[f.viewer,'scroll']])for(const callback of target.listeners.get(name))assert(exported.has(callback),'native DOM listeners must receive exported functions');
   f.click();assert.equal(f.layer.active,true);let scheduled;f.win.requestAnimationFrame=callback=>{scheduled=callback;return 9;};f.win.cancelAnimationFrame=()=>{};f.win.emit('resize');assert(exported.has(scheduled),'the native animation frame must receive an exported function');scheduled(16);assert.equal(calls,3);f.layer.dispose();assert.equal(f.win.listenerCount(),0);assert.equal(f.viewer.listenerCount(),0);
  }finally{f.layer.dispose();}
 });
 await check('native geometry failures in captured clicks and deferred paint clear stale focus and reach the optional error callback',()=>{
  const errors=[],failure=new Error('native geometry unavailable'),f=fixture({installOptions:{onError:error=>errors.push(error)}});try{
   const point=f.viewport.convertToPdfPoint,viewportPoint=f.viewport.convertToViewportPoint;f.viewport.convertToPdfPoint=()=>{throw failure;};assert.doesNotThrow(()=>f.click());assert.deepEqual(errors,[failure]);assert.equal(f.layer.active,false);
   f.viewport.convertToPdfPoint=point;f.click();assert.equal(f.layer.active,true);let pending;f.win.requestAnimationFrame=callback=>{pending=callback;return 7;};f.win.cancelAnimationFrame=()=>{};f.viewport.convertToViewportPoint=()=>{throw failure;};f.events.get('scalechanging')();assert.equal(typeof pending,'function');assert.doesNotThrow(()=>pending());assert.deepEqual(errors,[failure,failure]);assert.equal(f.layer.active,false);assert.equal(f.win.document.body.allNodes().some(node=>node.className==='askgpt-reading-focus'),false);
   f.viewport.convertToViewportPoint=viewportPoint;f.options.onError=()=>{throw Error('reporter unavailable');};f.viewport.convertToPdfPoint=()=>{throw failure;};assert.doesNotThrow(()=>f.click());
  }finally{f.layer.dispose();}
 });
 await check('programmatic paired focus reuses the exact paragraph and refreshes with native layout',()=>{
  const f=fixture();try{assert.equal(f.layer.focus({outputPage:0,paragraphID:'p5_1'}),true);assert.equal(f.focused.length,0,'paired focus must not recurse into onFocus');f.canvas.getBoundingClientRect=()=>({left:50,top:80,width:300,height:400});f.events.get('scalechanging')();
   const box=f.win.document.body.allNodes().find(n=>n.getAttribute('data-askgpt-reading-focus')==='box');assert.equal(box.style.getPropertyValue('left'),'60px');assert.equal(box.style.getPropertyValue('top'),'290px');assert.equal(f.layer.clear(),true);assert.equal(f.layer.clear(),false);
  }finally{f.layer.dispose();}
 });
 await check('missing or invalid correspondence never turns into a whole-page focus',()=>{
  const f=fixture();try{f.alignment.pages[0].paragraphs[0].target.rects=[[NaN,1,2,3]];f.click();assert.equal(f.layer.active,false);assert.equal(f.layer.focus({outputPage:10,paragraphID:'p5_0'}),false);f.options.getAlignment=()=>null;assert.equal(f.layer.focus({outputPage:0,paragraphID:'p5_1'}),false);}finally{f.layer.dispose();}
 });
 await check('hidden or inactive panes ignore interaction, and paired null clears without a feedback callback',()=>{
  const f=fixture();try{f.layer.focus({outputPage:0,paragraphID:'p5_0'});assert.equal(f.layer.focus(null),true);assert.equal(f.layer.active,false);assert.equal(f.focused.length,0);f.options.enabled=()=>false;assert.equal(f.click().defaultPrevented,undefined);assert.equal(f.layer.focus({outputPage:0,paragraphID:'p5_0'}),false);f.options.enabled=()=>true;f.click();assert.equal(f.layer.active,true);f.options.enabled=()=>false;f.win.emit('resize');assert.equal(f.layer.active,false);}finally{f.layer.dispose();}
 });
 await check('disposing removes all native view listeners, observer hooks and transient overlay',()=>{
  const f=fixture();f.click();f.layer.dispose();f.layer.dispose();assert.equal(f.win.listenerCount(),0);assert.equal(f.viewer.listenerCount(),0);assert.equal(f.events.size,0);assert.equal(f.win.document.body.allNodes().some(n=>n.className==='askgpt-reading-focus'),false);assert.equal(f.layer.focus({outputPage:0,paragraphID:'p5_0'}),false);
 });
 process.stdout.write(JSON.stringify({status:'PASS',checks})+'\n');
})().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
