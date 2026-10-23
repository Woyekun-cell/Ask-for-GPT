const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=path.join(__dirname,'../content/pdf-figure-markup.js'),Markup=fs.existsSync(source)?require(source):{};
let checks=0;function check(name,fn){fn();checks++;console.log('PASS '+name);}
const binding=()=>({libraryID:1,itemKey:'88RIH6NL',fingerprint:'a'.repeat(32),pageIndex:8,rect:[10,20,300,400]});
const mark=(extra={})=>({type:'pen',color:'#ff3b30',width:.005,points:[[.1,.2],[.3,.4]],...extra});
function context(){const calls=[],ctx={calls};for(const name of ['save','restore','beginPath','moveTo','lineTo','stroke','strokeRect','arc','fill','fillText'])ctx[name]=(...args)=>calls.push({name,args});return ctx;}
check('binding validation owns only a strict PDF attachment and crop identity',()=>{
 assert.equal(typeof Markup.validateBinding,'function');const value={...binding(),path:'/PRIVATE/PDF',text:'PRIVATE'},checked=Markup.validateBinding(value);assert.deepEqual(checked,binding());value.rect[0]=999;assert.equal(checked.rect[0],10);
 for(const change of [{libraryID:-1},{libraryID:1.1},{itemKey:'../ABCDE'},{itemKey:'abcd1234'},{fingerprint:'not a hash'},{pageIndex:-1},{pageIndex:2000},{rect:[1,2,1,3]},{rect:[1,2,Infinity,4]}])assert.equal(Markup.validateBinding({...binding(),...change}),null);
});
check('records return allowlisted deeply owned annotation values without HTML interpretation',()=>{
 const input={schema:1,binding:binding(),marks:[mark({type:'text',points:[[.2,.3]],text:'<img src=x onerror=bad()>',html:'PRIVATE'})],token:'PRIVATE'};
 const record=Markup.validateRecord(input);assert.deepEqual(Object.keys(record),['schema','binding','marks']);assert.deepEqual(record.marks[0],{type:'text',color:'#FF3B30',width:.005,points:[[.2,.3]],text:'<img src=x onerror=bad()>'});input.marks[0].points[0][0]=.9;assert.equal(record.marks[0].points[0][0],.2);
});
check('malformed marks cannot enter records or modify history',()=>{
 for(const change of [{type:'html'},{color:'red'},{color:'#11223344'},{width:.0009},{width:.051},{width:NaN},{points:[[0,1.01]]},{points:[[NaN,0]]},{type:'rect',points:[[.1,.1],[.1,.4]]},{type:'arrow',points:[[.1,.1],[.1,.1]]},{type:'text',points:[[0,0]],text:' '},{type:'text',points:[[0,0]],text:'字'.repeat(501)}]){
  assert.equal(Markup.validateRecord({schema:1,binding:binding(),marks:[mark(change)]}),null);const history=Markup.createHistory();assert.equal(history.commit(mark(change)),false);assert.deepEqual(history.marks,[]);
 }
 assert.equal(Markup.validateRecord({schema:2,binding:binding(),marks:[]}),null);assert.equal(Markup.validateRecord({schema:1,binding:binding(),marks:[mark({points:Array.from({length:4097},()=>[.1,.2])})]}),null);
});
check('pen rectangle arrow and Unicode text remain normalized across all four tool types',()=>{
 for(const value of [mark(),mark({type:'rect'}),mark({type:'arrow'}),mark({type:'text',points:[[.2,.3]],text:'🧬'.repeat(500)})]){const result=Markup.validateRecord({schema:1,binding:binding(),marks:[value]});assert(result);assert.equal(result.marks[0].color,'#FF3B30');}
 const history=Markup.createHistory();for(let i=0;i<256;i++)assert.equal(history.commit(mark({type:'rect'})),true);assert.equal(history.commit(mark()),false);assert.equal(history.marks.length,256);
});
check('history clones reads and caller input while undo redo and clear retain correct editable states',()=>{
 const first=mark(),history=Markup.createHistory([first]);first.points[0][0]=.9;const read=history.marks;read[0].points[0][0]=.8;assert.equal(history.marks[0].points[0][0],.1);
 assert.equal(history.canUndo,false);assert.equal(history.commit(mark({type:'arrow'})),true);assert.equal(history.canUndo,true);assert.equal(history.undo(),true);assert.equal(history.marks.length,1);assert.equal(history.canRedo,true);assert.equal(history.redo(),true);assert.equal(history.marks.length,2);
 assert.equal(history.clear(),true);assert.deepEqual(history.marks,[]);assert.equal(history.undo(),true);assert.equal(history.marks.length,2);assert.equal(history.commit(mark({type:'rect'})),true);assert.equal(history.canRedo,false);
});
check('history bounds undo to one hundred steps without dropping the current marks',()=>{
 const history=Markup.createHistory();for(let i=0;i<120;i++)assert(history.commit(mark({type:'rect'})));assert.equal(history.marks.length,120);let undos=0;while(history.undo())undos++;assert.equal(undos,100);assert.equal(history.marks.length,20);assert.equal(history.undo(),false);
});
check('large pen histories shed old snapshots within the two MiB budget',()=>{
 const history=Markup.createHistory(),points=Array.from({length:200},(_,i)=>[i/200,.4]);for(let i=0;i<120;i++)assert(history.commit(mark({points})));assert.equal(history.marks.length,120);let undos=0;while(history.undo())undos++;assert(undos<100&&undos>0);assert.equal(history.marks.length,120-undos);
});
check('invalid initialization and empty history operations fail closed',()=>{
 const history=Markup.createHistory([mark({color:'invalid'})]);assert.deepEqual(history.marks,[]);assert.equal(history.undo(),false);assert.equal(history.redo(),false);assert.equal(history.clear(),false);assert.equal(history.canUndo,false);assert.equal(history.canRedo,false);
});
check('oversized editable records fail closed before becoming a history state',()=>{
 const points=Array.from({length:4096},()=>[.12345678,.23456789]),marks=Array.from({length:256},()=>mark({points}));assert.equal(Markup.validateRecord({schema:1,binding:binding(),marks}),null);assert.deepEqual(Markup.createHistory(marks).marks,[]);
});
check('painting preserves the base image and draws normalized lines boxes arrows and literal text',()=>{
 const ctx=context();assert.equal(Markup.paint(ctx,400,200,[mark(),mark({type:'rect'}),mark({type:'arrow'}),mark({type:'text',points:[[.5,.5]],text:'<script>literal</script>\n第二行'})]),true);
 assert(ctx.calls.some(c=>c.name==='moveTo'&&c.args[0]===40&&c.args[1]===40));assert(ctx.calls.some(c=>c.name==='strokeRect'&&c.args[0]===40&&c.args[1]===40&&Math.abs(c.args[2]-80)<1e-8&&c.args[3]===40));assert(ctx.calls.some(c=>c.name==='fillText'&&c.args[0]==='<script>literal</script>'));assert(ctx.calls.some(c=>c.name==='fillText'&&c.args[0]==='第二行'));assert.equal(ctx.calls.filter(c=>c.name==='save').length,ctx.calls.filter(c=>c.name==='restore').length);
});
check('bad paint inputs never touch the canvas and drawing errors restore its state',()=>{
 const ctx=context();assert.equal(Markup.paint(ctx,400,200,[mark({width:Infinity})]),false);assert.equal(ctx.calls.length,0);assert.equal(Markup.paint(ctx,0,200,[]),false);
 ctx.stroke=()=>{throw Error('canvas unavailable');};assert.equal(Markup.paint(ctx,400,200,[mark()]),false);assert.equal(ctx.calls.at(-1).name,'restore');
});
console.log(checks+' figure markup model tests passed');
