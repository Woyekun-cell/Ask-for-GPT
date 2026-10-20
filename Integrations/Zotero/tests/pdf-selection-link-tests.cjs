const assert=require('node:assert/strict');
const Link=require('../content/pdf-selection-link.js');
const DOM=require('./fake-dom.cjs');
const vm=require('node:vm');
const clone=value=>JSON.parse(JSON.stringify(value));
let checks=0;function check(name,callback){callback();checks++;process.stdout.write('PASS '+name+'\n');}
function fixture({controlledFrames=false,reduced=false}={}){
 const win=new DOM.Window(),events=new Map(),frames=new Map();let scale=1,writes=0,created=0,points=0,nextFrame=0;
 const create=win.document.createElementNS;win.document.createElementNS=function(...args){created++;return Reflect.apply(create,this,args);};
 if(controlledFrames){win.requestAnimationFrame=callback=>{const id=++nextFrame;frames.set(id,callback);return id;};win.cancelAnimationFrame=id=>frames.delete(id);win.matchMedia=()=>({matches:reduced});}
 const pages=[0,1].map(()=>({div:new DOM.Element(win.document,'div'),viewport:{convertToViewportPoint:(x,y)=>{points++;return [x*scale,(800-y)*scale];}}}));
 pages.forEach(p=>win.document.body.appendChild(p.div));
 const native={_iframeWindow:win,setAnnotations(){writes++;},_onAddAnnotation(){writes++;}};
 win.PDFViewerApplication={pdfViewer:{getPageView:i=>pages[i]},eventBus:{on(name,callback){if(!events.has(name))events.set(name,new Set());events.get(name).add(callback);},off(name,callback){events.get(name)?.delete(callback);}}};
 return {native,pages,events,frames,writes:()=>writes,created:()=>created,points:()=>points,setScale(value){scale=value;},emit(name){for(const callback of [...(events.get(name)||[])])callback();},flush(){const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks)callback(16);}};
}
const selection=(pageIndex=0)=>({type:'highlight',text:'Private selected text',position:{pageIndex,rects:[[10,700,30,710]]}});
check('an exact counterpart is a noninteractive unsaved overlay in the requested native page',()=>{
 const a=fixture(),b=fixture(),link=Link.create({sourceView:a.native,targetView:()=>b.native});
 assert(link.show('target',selection()));assert.equal(a.pages[0].div.children.length,0);assert.equal(b.pages[0].div.children.length,1);
 const node=b.pages[0].div.children[0];assert.equal(node.getAttribute('class'),'askgpt-selection-link');assert.equal(node.getAttribute('aria-hidden'),'true');assert.match(node.getAttribute('style'),/left:10px;top:90px;width:20px;height:10px/);assert.match(node.getAttribute('style'),/pointer-events:none;user-select:none/);assert.equal(node.textContent,'');assert.equal(a.writes()+b.writes(),0);
 link.clear();assert.equal(b.pages[0].div.children.length,0);assert([...b.events.values()].every(set=>set.size===0));
});
check('source and target preserve independent native zoom and real two-page rectangles',()=>{
 const a=fixture(),b=fixture(),link=Link.create({sourceView:a.native,targetView:()=>b.native}),input=selection();input.position.nextPageRects=[[20,650,50,665]];
 link.show('source',input);link.show('target',selection(1));a.setScale(2);a.emit('scalechanging');
 assert.match(a.pages[0].div.children[0].getAttribute('style'),/left:20px;top:180px;width:40px;height:20px/);assert.equal(a.pages[1].div.children.length,1);assert.match(b.pages[1].div.children[0].getAttribute('style'),/left:10px;top:90px;width:20px;height:10px/);
 link.clear('source');assert.equal(a.pages[0].div.children.length+a.pages[1].div.children.length,0);assert.equal(b.pages[1].div.children.length,1);link.dispose();assert.equal(b.pages[1].div.children.length,0);assert.equal(a.writes()+b.writes(),0);
});
check('unrendered counterparts appear when their exact native page renders and disappear on disposal',()=>{
 const a=fixture(),b=fixture();let target=null;const link=Link.create({sourceView:a.native,targetView:()=>target});assert(link.show('target',selection()));assert.equal(b.pages[0].div.children.length,0);link.clear();target=b.native;
 const page=b.pages[0];delete page.viewport;link.show('target',selection());assert.equal(page.div.children.length,0);page.viewport={convertToViewportPoint:(x,y)=>[x,y]};b.emit('pagerendered');assert.equal(page.div.children.length,1);link.dispose();b.emit('pagerendered');assert.equal(page.div.children.length,0);assert.equal(link.show('target',selection()),false);
});
check('native viewport transforms receive primitives across a real VM realm and returned opaque arrays are normalized',()=>{
 const a=fixture(),context=vm.createContext({}),viewport=vm.runInContext(`({
   convertToViewportRectangle(rect){if(!(rect instanceof Array))throw new Error('Permission denied to access foreign rectangle');return [rect[0],800-rect[1],rect[2],800-rect[3]];},
   convertToViewportPoint(x,y){if(typeof x!=='number'||typeof y!=='number')throw new Error('Primitive coordinates required');return new Proxy([x,800-y],{get(target,key){if(['every','map','slice'].includes(key))return undefined;return Reflect.get(target,key);}});}
 })`,context);
 assert.throws(()=>viewport.convertToViewportRectangle([10,700,30,710]),/Permission denied/,'the old chrome-array call must reproduce a real foreign realm boundary');
 const native=viewport.convertToViewportPoint(10,700);assert.equal(native.every,undefined);a.pages[0].viewport=viewport;const link=Link.create({sourceView:a.native,targetView:()=>a.native});assert.doesNotThrow(()=>link.show('target',selection()));assert.equal(a.pages[0].div.children.length,1);assert.match(a.pages[0].div.children[0].getAttribute('style'),/left:10px;top:90px;width:20px;height:10px/);assert.equal(a.writes(),0);link.dispose();
});
check('invalid, broad spatial and nonfinite input never invents selection boxes',()=>{
 const a=fixture(),link=Link.create({sourceView:a.native,targetView:()=>a.native});
 for(const mutate of [s=>s.type='note',s=>s.position.pageIndex=-1,s=>s.position.rects=[[0,0,NaN,5]],s=>s.position.rects=[[2,2,1,1]],s=>s.position.nextPageRects=[]]){const value=selection();mutate(value);assert.equal(link.show('target',value),false);assert.equal(a.pages[0].div.children.length,0);}link.dispose();
});
check('one hundred viewport events coalesce into one frame and reposition fourteen existing nodes without animation or recreation',()=>{
 for(const reduced of [false,true]){const a=fixture({controlledFrames:true,reduced}),link=Link.create({sourceView:null,targetView:a.native}),input=selection();input.position.rects=Array.from({length:14},(_,i)=>[10,700-i*20,30,710-i*20]);link.show('target',input);const nodes=a.pages[0].div.children.slice();assert.equal(a.created(),14);assert.equal(a.points(),28);a.setScale(2);
  for(let i=0;i<100;i++)a.emit(i%2?'scalechanging':'updateviewarea');assert.equal(a.frames.size,1);assert.equal(a.points(),28,'events do no synchronous viewport conversion before the scheduled frame');assert.equal(a.created(),14);a.flush();assert.equal(a.points(),56,'all events share exactly one fourteen-rectangle reposition pass');assert.equal(a.created(),14);assert.deepEqual(a.pages[0].div.children,nodes);assert.match(nodes[0].getAttribute('style'),/left:20px;top:180px;width:40px;height:20px/);assert(!nodes[0].getAttribute('style').includes('transition'));
  link.show('target',clone(input));a.flush();assert.equal(a.created(),14,'re-publishing the same selection retains its nodes');assert.deepEqual(a.pages[0].div.children,nodes);assert.equal(a.writes(),0);link.dispose();
 }
});
check('clearing or disposing pending reposition frames cannot revive old selections or remove the replacement generation',()=>{
 const a=fixture({controlledFrames:true}),link=Link.create({sourceView:null,targetView:a.native});link.show('target',selection());a.emit('updateviewarea');const stale=[...a.frames.values()];assert.equal(stale.length,1);link.clear();assert.equal(a.frames.size,0);assert.equal(a.pages[0].div.children.length,0);link.show('target',selection(1));const replacement=a.pages[1].div.children[0],created=a.created();for(const callback of stale)callback(16);assert.equal(a.pages[0].div.children.length,0);assert.equal(a.pages[1].div.children[0],replacement);assert.equal(a.created(),created);
 a.emit('rotationchanging');const retired=[...a.frames.values()];assert.equal(retired.length,1);a.native._iframeWindow.cancelAnimationFrame=()=>{throw Error('retired native window');};assert.doesNotThrow(()=>link.dispose());for(const callback of retired)callback(32);assert.equal(a.pages[0].div.children.length+a.pages[1].div.children.length,0);assert([...a.events.values()].every(set=>set.size===0));assert.equal(a.created(),created);assert.equal(a.writes(),0);
});
process.stdout.write(checks+' selection counterpart tests passed\n');
