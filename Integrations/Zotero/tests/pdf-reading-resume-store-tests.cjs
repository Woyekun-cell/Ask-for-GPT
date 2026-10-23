// Pure storage-boundary checks; no live Zotero preferences are read or written.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const modulePath=path.join(__dirname,'../content/pdf-reading-resume-store.js');
const Store=fs.existsSync(modulePath)?require(modulePath):{};
const {validateAnchor}=require('../content/pdf-reading-resume.js');
let checks=0,failures=0;
function check(name,run){try{run();checks++;process.stdout.write('PASS '+name+'\n');}catch(error){failures++;process.stderr.write('FAIL '+name+'\n'+error.stack+'\n');}}
const anchor=(extra={})=>({schema:1,fingerprint:'a'.repeat(32),pageCount:18,pageIndex:8,start:10,end:22,rects:[[20,30,80,40],[20,45,70,55]],signature:'b'.repeat(64),capturedAt:1700000000100,...extra});
const reader=(libraryID=1,key='88RIH6NL')=>({_item:{libraryID,key,isAttachment:()=>true},itemID:17});
function fixture(options={}){
  assert.equal(typeof Store.create,'function','reading resume store installer is missing');
  const values=new Map(),accesses=[];
  const Zotero={Prefs:{get(key,global){accesses.push({method:'get',key,global});return values.get(key);},set(key,value,global){accesses.push({method:'set',key,value,global});values.set(key,value);}},Items:{get:id=>id===(options.itemID??23)?options.item||null:null}};
  const store=Store.create({Zotero,validateAnchor:options.validator||validateAnchor});
  return {store,Zotero,values,accesses};
}
const key='extensions.askgpt-inline.readingResume.1.88RIH6NL';
check('saving stores one allowlisted anchor in its attachment preference and restores it',()=>{
  const f=fixture(),value=anchor({body:'PRIVATE_BODY',path:'/PRIVATE/PATH',parentID:99});
  assert.equal(f.store.save(reader(),value),true);
  assert.deepEqual(JSON.parse(f.values.get(key)),{schema:1,fingerprint:'a'.repeat(32),pageCount:18,pageIndex:8,start:10,end:22,rects:[[20,30,80,40],[20,45,70,55]],signature:'b'.repeat(64),capturedAt:1700000000100});
  assert.equal(f.values.size,1);assert.equal(f.store.load(reader()).pageIndex,8);
  assert(f.accesses.every(value=>value.key===key&&value.global===true));
});
check('missing private item resolves only the exact attachment item ID',()=>{
  const f=fixture({item:{libraryID:7,key:'I223HQFX',isAttachment:()=>true}});
  assert.equal(f.store.save({itemID:23},anchor()),true);
  assert.equal(f.values.has('extensions.askgpt-inline.readingResume.7.I223HQFX'),true);
  assert.equal(f.store.load({itemID:23}).pageIndex,8);
  assert.equal(f.store.load({itemID:24,parentItemID:23}),null);
});
check('unknown identities and parent items cannot access or overwrite preferences',()=>{
  const f=fixture();
  for(const value of [null,{},reader(-1),reader(1.5),reader(NaN),reader(1,'short'),reader(1,'88rih6nl'),reader(1,'../ABCDE'),{_item:{libraryID:1,key:'88RIH6NL',isAttachment:()=>false},itemID:0},{_item:{libraryID:1,key:'88RIH6NL'}},{itemID:'17'}]){
    assert.equal(f.store.load(value),null);assert.equal(f.store.save(value,anchor()),false);
  }
  assert.equal(f.accesses.length,0);assert.equal(f.values.size,0);
});
check('library zero and separate attachment keys retain isolated progress',()=>{
  const f=fixture();assert.equal(f.store.save(reader(0),anchor({pageIndex:1})),true);assert.equal(f.store.save(reader(2),anchor({pageIndex:2})),true);assert.equal(f.store.save(reader(2,'I223HQFX'),anchor({pageIndex:3})),true);
  assert.equal(f.store.load(reader(0)).pageIndex,1);assert.equal(f.store.load(reader(2)).pageIndex,2);assert.equal(f.store.load(reader(2,'I223HQFX')).pageIndex,3);assert.equal(f.store.load(reader(1)),null);assert.equal(f.values.size,3);
});
check('loaded progress and nested rectangles are independent of subsequent reads',()=>{
  const f=fixture();f.store.save(reader(),anchor());const first=f.store.load(reader());first.pageIndex=3;first.rects[0][0]=999;first.rects.push([1,2,3,4]);
  assert.equal(f.store.load(reader()).pageIndex,8);assert.deepEqual(f.store.load(reader()).rects,[[20,30,80,40],[20,45,70,55]]);
});
check('caller mutations after save cannot alter persisted sentence geometry',()=>{
  const f=fixture(),value=anchor();assert.equal(f.store.save(reader(),value),true);value.rects[0][0]=777;value.fingerprint='changed';
  assert.equal(f.store.load(reader()).fingerprint,'a'.repeat(32));assert.deepEqual(f.store.load(reader()).rects[0],[20,30,80,40]);
});
check('invalid existing JSON remains unchanged and never becomes restored progress',()=>{
  const f=fixture();f.values.set(key,'{"schema":1,broken');assert.equal(f.store.load(reader()),null);assert.equal(f.store.save(reader(),anchor()),false);assert.equal(f.values.get(key),'{"schema":1,broken');
});
check('oversized existing preference values are preserved without restoration',()=>{
  const f=fixture();const large='x'.repeat(16385);f.values.set(key,large);assert.equal(f.store.load(reader()),null);assert.equal(f.store.save(reader(),anchor()),false);assert.equal(f.values.get(key),large);
});
check('anchors over sixteen KiB cannot replace valid saved progress',()=>{
  const f=fixture({validator:value=>value});assert.equal(f.store.save(reader(),anchor()),true);
  assert.equal(f.store.save(reader(),anchor({fingerprint:'字'.repeat(6000),capturedAt:1700000000300})),false);
  assert.equal(f.store.load(reader()).capturedAt,1700000000100);assert.equal(f.values.size,1);
});
check('semantic validation rejection and exceptions silently preserve prior state',()=>{
  for(const validator of [()=>null,()=>false,()=>{throw Error('native geometry unavailable');}]){
    const f=fixture({validator});assert.equal(f.store.save(reader(),anchor()),false);assert.equal(f.store.load(reader()),null);assert.equal(f.values.size,0);
  }
});
check('malformed persisted shape fails closed even with a permissive collaborator',()=>{
  const f=fixture({validator:()=>true});
  for(const extra of [{schema:2},{capturedAt:NaN},{capturedAt:-1},{pageCount:0},{pageIndex:1.5},{start:-1},{end:9},{rects:[[1,2,'PRIVATE_TEXT',4]]},{rects:[]},{signature:{text:'PRIVATE_TEXT'}},{fingerprint:null}])assert.equal(f.store.save(reader(),anchor(extra)),false);
  assert.equal(f.values.size,0);
});
check('preference read and write failures degrade without throwing',()=>{
  const f=fixture();f.Zotero.Prefs.get=()=>{throw Error('preferences unavailable');};assert.equal(f.store.load(reader()),null);assert.equal(f.store.save(reader(),anchor()),false);
  const g=fixture();g.Zotero.Prefs.set=()=>{throw Error('preferences read only');};assert.equal(g.store.save(reader(),anchor()),false);assert.equal(g.values.size,0);
  const h=Store.create({Zotero:{},validateAnchor});assert.equal(h.load(reader()),null);assert.equal(h.save(reader(),anchor()),false);
});
check('a delayed close from an older reader cannot overwrite a newer sentence',()=>{
  const f=fixture(),other=Store.create({Zotero:f.Zotero,validateAnchor});assert.equal(f.store.save(reader(),anchor({pageIndex:4,capturedAt:1700000000100})),true);assert.equal(other.save(reader(),anchor({pageIndex:9,capturedAt:1700000000900})),true);assert.equal(f.store.save(reader(),anchor({pageIndex:5,capturedAt:1700000000400})),false);
  assert.equal(f.store.load(reader()).pageIndex,9);assert.equal(f.store.load(reader()).capturedAt,1700000000900);
});
check('an equal timestamp does not replace existing progress with another window',()=>{
  const f=fixture();assert.equal(f.store.save(reader(),anchor({pageIndex:4})),true);assert.equal(f.store.save(reader(),anchor({pageIndex:9})),false);assert.equal(f.store.load(reader()).pageIndex,4);
});
check('validator normalization is allowlisted before persistence',()=>{
  const f=fixture({validator:value=>({...value,signature:'c'.repeat(64),body:'PRIVATE_NORMALIZED_BODY'})});assert.equal(f.store.save(reader(),anchor()),true);
  const parsed=JSON.parse(f.values.get(key));assert.equal(parsed.signature,'c'.repeat(64));assert.equal(Object.hasOwn(parsed,'body'),false);assert.equal(parsed.rects[0][0],20);
});
check('a missing validator cannot save or restore unchecked anchors',()=>{
  const f=fixture(),store=Store.create({Zotero:f.Zotero});f.values.set(key,JSON.stringify(anchor()));assert.equal(store.load(reader()),null);assert.equal(store.save(reader(),anchor({capturedAt:1700000000900})),false);assert.equal(JSON.parse(f.values.get(key)).capturedAt,1700000000100);
});
if(failures){process.stderr.write(failures+' reading resume store tests failed\n');process.exitCode=1;}else process.stdout.write(checks+' reading resume store tests passed\n');
