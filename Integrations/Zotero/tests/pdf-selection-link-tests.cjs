const assert=require('node:assert/strict');
const Link=require('../content/pdf-selection-link.js');
const DOM=require('./fake-dom.cjs');
const vm=require('node:vm');
const clone=value=>JSON.parse(JSON.stringify(value));
let checks=0;function check(name,callback){callback();checks++;process.stdout.write('PASS '+name+'\n');}
function fixture({controlledFrames=false,reduced=false}={}){
 const win=new DOM.Window(),events=new Map(),frames=new Map();let scale=1,rotation=0,visible=[0,1],writes=0,created=0,points=0,nextFrame=0;
 const create=win.document.createElementNS;win.document.createElementNS=function(...args){created++;return Reflect.apply(create,this,args);};
 if(controlledFrames){win.requestAnimationFrame=callback=>{const id=++nextFrame;frames.set(id,callback);return id;};win.cancelAnimationFrame=id=>frames.delete(id);win.matchMedia=()=>({matches:reduced});}
 const project=(x,y)=>{points++;return (rotation===90?[y,x]:rotation===180?[600-x,y]:rotation===270?[800-y,600-x]:[x,800-y]).map(n=>n*scale);};
 const pages=[0,1].map(()=>({div:new DOM.Element(win.document,'div'),viewport:{convertToViewportPoint:project}}));
 pages.forEach(p=>win.document.body.appendChild(p.div));
 const native={_iframeWindow:win,setAnnotations(){writes++;},_onAddAnnotation(){writes++;}};
 win.PDFViewerApplication={pdfViewer:{getPageView:i=>pages[i],_getVisiblePages:()=>({views:visible.map(i=>({id:i+1}))})},eventBus:{on(name,callback){if(!events.has(name))events.set(name,new Set());events.get(name).add(callback);},off(name,callback){events.get(name)?.delete(callback);}}};
 return {native,pages,events,frames,writes:()=>writes,created:()=>created,points:()=>points,setScale(value){scale=value;},setRotation(value){rotation=value;},setVisible(value){visible=value;},emit(name){for(const callback of [...(events.get(name)||[])])callback();},flush(){const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks)callback(16);}};
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
const mark=(id,type='highlight',color='#ffd400',pageIndex=0)=>({...selection(pageIndex),id,type,color});
check('stored highlights and underlines mirror their original colors passively in both independent panes',()=>{
 const a=fixture(),b=fixture(),mirrors=Link.create({sourceView:a.native,targetView:b.native});
 assert(mirrors.showMany('source',[mark('source:A','highlight','#5fb236')]));assert(mirrors.showMany('target',[mark('target:B','underline','#ff6666')]));
 const left=a.pages[0].div.children[0],right=b.pages[0].div.children[0];assert.equal(left.getAttribute('class'),'askgpt-annotation-mirror');assert.match(left.getAttribute('style'),/background:#5fb236/);assert.match(right.getAttribute('style'),/background:#ff6666/);assert.match(right.getAttribute('style'),/height:2px/);
 for(const node of [left,right]){assert.equal(node.getAttribute('aria-hidden'),'true');assert.match(node.getAttribute('style'),/pointer-events:none;user-select:none/);assert.equal(node.textContent,'');}assert.equal(a.writes()+b.writes(),0);mirrors.dispose();
});
check('mirror snapshots reuse node identity across reordered lists text edits recolor type geometry and deletion',()=>{
 const a=fixture(),mirrors=Link.create({sourceView:a.native,targetView:a.native}),one=mark('a'),two=mark('b','underline','#2ea8e5');mirrors.showMany('target',[one,two]);const nodes=a.pages[0].div.children.slice(),created=a.created();
 mirrors.showMany('target',[{...clone(two),text:'Changed private text',comment:'private'},clone(one)]);assert.deepEqual(a.pages[0].div.children,nodes);assert.equal(a.created(),created);
 one.color='#A28AE5';one.type='underline';one.position.rects=[[20,650,60,665]];mirrors.showMany('target',[one,two]);assert.equal(a.pages[0].div.children[0],nodes[0]);assert.match(nodes[0].getAttribute('style'),/background:#a28ae5/);assert.match(nodes[0].getAttribute('style'),/left:20px;top:149px;width:40px;height:2px/);assert.equal(a.created(),created);
 mirrors.showMany('target',[two]);assert.deepEqual(a.pages[0].div.children,[nodes[1]]);assert(mirrors.showMany('target',[]));assert.equal(a.pages[0].div.children.length,0);assert([...a.events.values()].every(s=>s.size===0));mirrors.dispose();
});
check('blue live selection and stored mirrors never clear or restyle each other',()=>{
 const a=fixture(),blue=Link.create({sourceView:a.native,targetView:a.native}),mirrors=Link.create({sourceView:a.native,targetView:a.native});blue.show('target',selection());const original=a.pages[0].div.children[0],style=original.getAttribute('style');mirrors.showMany('target',[mark('saved')]);assert.equal(a.pages[0].div.children.length,2);mirrors.clear();assert.equal(a.pages[0].div.children[0],original);assert.equal(original.getAttribute('style'),style);assert.match(style,/rgba\(0,122,255,.12\)/);
 mirrors.showMany('target',[mark('saved')]);const saved=a.pages[0].div.children[1];blue.clear();assert.deepEqual(a.pages[0].div.children,[saved]);blue.show('target',selection());mirrors.showMany('target',[mark('saved','highlight','#ff6666')]);assert(a.pages[0].div.children.includes(original)===false);assert.match(a.pages[0].div.children.find(n=>n.getAttribute('class')==='askgpt-selection-link').getAttribute('style'),/rgba\(0,122,255,.12\)/);blue.dispose();assert.deepEqual(a.pages[0].div.children,[saved]);mirrors.dispose();assert.equal(a.pages[0].div.children.length,0);assert.equal(a.writes(),0);
});
check('mirror underlines rotate with their PDF edge and preserve separate zoom geometry',()=>{
 const a=fixture(),mirrors=Link.create({sourceView:a.native,targetView:a.native});mirrors.showMany('target',[mark('underline','underline','#2ea8e5')]);const node=a.pages[0].div.children[0];
 for(const [rotation,angle] of [[0,0],[90,90],[180,180],[270,-90]]){a.setRotation(rotation);a.emit('rotationchanging');assert.match(node.getAttribute('style'),new RegExp('transform:rotate\\('+angle+'deg\\)'));assert.match(node.getAttribute('style'),/width:20px;height:2px/);}a.setScale(2);a.emit('scalechanging');assert.match(node.getAttribute('style'),/width:40px;height:2px/);assert.equal(a.created(),1);assert.equal(a.writes(),0);mirrors.dispose();
});
check('mirror frames coalesce without work for a thousand offscreen annotations and release nodes on leaving a page',()=>{
 const a=fixture({controlledFrames:true}),mirrors=Link.create({sourceView:a.native,targetView:a.native}),marks=[mark('visible'),...Array.from({length:1000},(_,i)=>mark('offscreen'+i,'highlight','#ffd400',1))];a.setVisible([0]);mirrors.showMany('target',marks);const node=a.pages[0].div.children[0];assert.equal(a.created(),1);assert.equal(a.points(),2);a.setScale(2);for(let i=0;i<100;i++)a.emit(i%2?'updateviewarea':'scalechanging');assert.equal(a.frames.size,1);assert.equal(a.points(),2);a.flush();assert.equal(a.points(),4);assert.equal(a.created(),1);assert.equal(a.pages[0].div.children[0],node);
 a.setVisible([1]);a.emit('updateviewarea');a.flush();assert.equal(a.pages[0].div.children.length,0);assert.equal(a.pages[1].div.children.length,1000);a.setVisible([0]);a.emit('updateviewarea');a.flush();assert.equal(a.pages[1].div.children.length,0);assert.equal(a.pages[0].div.children.length,1);mirrors.dispose();
});
check('pending pages repaint existing mirrors when rendered and reparent them into replacement page containers',()=>{
 const a=fixture(),mirrors=Link.create({sourceView:a.native,targetView:a.native}),viewport=a.pages[0].viewport;delete a.pages[0].viewport;assert(mirrors.showMany('target',[mark('next')]));assert.equal(a.pages[0].div.children.length,0);a.pages[0].viewport=viewport;a.emit('pagerendered');const node=a.pages[0].div.children[0],old=a.pages[0].div;a.pages[0].div=new DOM.Element(a.native._iframeWindow.document,'div');a.emit('pagerendered');assert.equal(old.children.length,0);assert.equal(a.pages[0].div.children[0],node);assert.equal(a.created(),1);mirrors.dispose();
});
check('mirror snapshots reject malformed or conflicting records without corrupting the valid snapshot or executing color text',()=>{
 const a=fixture(),mirrors=Link.create({sourceView:a.native,targetView:a.native}),good=mark('valid'),bad=mark('bad');for(const change of [m=>m.color='red;display:none',m=>m.type='note',m=>m.position.pageIndex=-1,m=>m.position.rects=[[0,0,NaN,10]],m=>m.position.nextPageRects=[]]){const value=clone(bad);change(value);mirrors.showMany('target',[good,value]);assert.equal(a.pages[0].div.children.length,1);assert.match(a.pages[0].div.children[0].getAttribute('style'),/background:#ffd400/);}
 mirrors.showMany('target',[good,clone(good)]);assert.equal(a.pages[0].div.children.length,1);mirrors.showMany('target',[good,{...clone(good),color:'#ff6666'}]);assert.equal(a.pages[0].div.children.length,0);assert.equal(mirrors.showMany('invalid',[good]),false);assert.equal(a.writes(),0);mirrors.dispose();
});
check('cleared mirror frames cannot restore deleted marks or affect a replacement native view',()=>{
 const a=fixture({controlledFrames:true}),b=fixture({controlledFrames:true});let target=a.native;const mirrors=Link.create({sourceView:null,targetView:()=>target});mirrors.showMany('target',[mark('a')]);a.emit('updateviewarea');const callbacks=[...a.frames.values()];mirrors.showMany('target',[]);assert.equal(a.frames.size,0);target=b.native;mirrors.showMany('target',[mark('b')]);const node=b.pages[0].div.children[0];for(const callback of callbacks)callback(16);assert.equal(a.pages[0].div.children.length,0);assert.equal(b.pages[0].div.children[0],node);b.emit('updateviewarea');mirrors.dispose();b.flush();assert.equal(b.pages[0].div.children.length,0);assert([...a.events.values(),...b.events.values()].every(set=>set.size===0));assert.equal(mirrors.showMany('target',[mark('late')]),false);
});
check('mirror viewport calls pass only primitives across opaque foreign arrays including underline endpoints',()=>{
 const a=fixture(),context=vm.createContext({});a.pages[0].viewport=vm.runInContext(`({convertToViewportPoint(x,y){if(typeof x!=='number'||typeof y!=='number')throw Error('nonprimitive');return new Proxy([x,800-y],{get(a,k){if(['every','map','slice'].includes(k))return undefined;return Reflect.get(a,k);}});}})`,context);const mirrors=Link.create({sourceView:a.native,targetView:a.native});assert.doesNotThrow(()=>mirrors.showMany('target',[mark('a'),mark('b','underline','#ff6666')]));assert.equal(a.pages[0].div.children.length,2);assert.match(a.pages[0].div.children[1].getAttribute('style'),/transform:rotate\(0deg\)/);mirrors.dispose();
});
check('a pending undefined native view accepts a deferred blue or mirror snapshot without accessing an absent previous state',()=>{
 const a=fixture();let target;const blue=Link.create({sourceView:null,targetView:()=>target}),mirrors=Link.create({sourceView:null,targetView:()=>target});assert.doesNotThrow(()=>blue.show('target',selection()));assert.doesNotThrow(()=>mirrors.showMany('target',[mark('waiting')]));target=a.native;blue.show('target',selection());mirrors.showMany('target',[mark('waiting')]);assert.equal(a.pages[0].div.children.length,2);blue.dispose();mirrors.dispose();
});
check('mirror snapshots own normalized two-page rectangles and export only their bounded event callbacks',()=>{
 const a=fixture(),callbacks=new Set(),mirrors=Link.create({sourceView:a.native,targetView:a.native,exportCallback(fn){const exported=(...args)=>fn(...args);callbacks.add(exported);return exported;}}),value=mark('two');value.position.nextPageRects=[[20,650,50,665]];mirrors.showMany('target',[value]);assert.equal(a.pages[0].div.children.length,1);assert.equal(a.pages[1].div.children.length,1);for(const set of a.events.values())for(const callback of set)assert(callbacks.has(callback));value.position.rects[0][0]=999;a.setScale(2);a.emit('scalechanging');assert.match(a.pages[0].div.children[0].getAttribute('style'),/left:20px/);assert.match(a.pages[1].div.children[0].getAttribute('style'),/left:40px/);mirrors.dispose();assert([...a.events.values()].every(s=>s.size===0));
});
check('switching an explicit handle between blue and many modes replaces styles without leaking event listeners',()=>{
 const a=fixture(),handle=Link.create({sourceView:a.native,targetView:a.native}),value=mark('same');handle.show('target',value);assert.equal(a.pages[0].div.children[0].getAttribute('class'),'askgpt-selection-link');handle.showMany('target',[value]);assert.equal(a.pages[0].div.children[0].getAttribute('class'),'askgpt-annotation-mirror');handle.show('target',value);assert.equal(a.pages[0].div.children[0].getAttribute('class'),'askgpt-selection-link');assert.match(a.pages[0].div.children[0].getAttribute('style'),/rgba\(0,122,255,.12\)/);assert([...a.events.values()].every(s=>s.size===1));handle.dispose();
});
check('viewport-only mirror events never reread annotation getters or rebuild their snapshot',()=>{
 const a=fixture({controlledFrames:true}),mirrors=Link.create({sourceView:a.native,targetView:a.native}),value=mark('fixed');let reads=0;const wrapped={};for(const key of ['id','type','color','position'])Object.defineProperty(wrapped,key,{get(){reads++;return value[key];}});mirrors.showMany('target',[wrapped]);const initial=reads,created=a.created();for(let i=0;i<100;i++)a.emit(i%3?'updateviewarea':'pagerendered');assert.equal(reads,initial);assert.equal(a.frames.size,1);a.flush();assert.equal(reads,initial);assert.equal(a.created(),created);assert.equal(a.writes(),0);mirrors.dispose();
});
check('recovering a temporarily unavailable visible-page API releases fallback offscreen nodes',()=>{
 const a=fixture(),viewer=a.native._iframeWindow.PDFViewerApplication.pdfViewer,visible=viewer._getVisiblePages,mirrors=Link.create({sourceView:a.native,targetView:a.native});a.setVisible([0]);mirrors.showMany('target',[mark('a'),mark('b','highlight','#ffd400',1)]);assert.equal(a.pages[1].div.children.length,0);viewer._getVisiblePages=()=>{throw Error('pending visible-page calculation');};a.emit('updateviewarea');assert.equal(a.pages[1].div.children.length,1);viewer._getVisiblePages=visible;a.emit('updateviewarea');assert.equal(a.pages[1].div.children.length,0);assert.equal(a.pages[0].div.children.length,1);mirrors.dispose();
});
process.stdout.write(checks+' selection counterpart tests passed\n');
