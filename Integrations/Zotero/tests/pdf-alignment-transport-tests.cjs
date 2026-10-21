const assert=require('node:assert/strict');
const PDF=require('../content/pdf-layout.js');
let checks=0;async function check(name,fn){await fn();checks++;process.stdout.write('PASS '+name+'\n');}
const geometry=()=>({mediaBox:[0,0,600,800],cropBox:[0,0,600,800],rotation:0});
const part=text=>({text,rects:[[40,600,350,615]]});
const alignment=()=>({schema:1,coordinateSpace:'pdf',granularity:'paragraph',pages:[{sourcePage:2,outputPage:0,source:geometry(),mono:geometry(),sourceToDual:[1,0,0,1,0,0],targetToDual:[1,0,0,1,600,0],dual:{mediaBox:[0,0,1200,800],cropBox:[0,0,1200,800],rotation:0},paragraphs:[{id:'p0_0',source:part('Original paragraph'),target:part('中文段落'),dualSource:part('Original paragraph'),dualTarget:{text:'中文段落',rects:[[640,600,950,615]]}}]}]});
function fixture(value){const calls=[];return {calls,transport:PDF.createTransport({Zotero:{HTTP:{async request(method,url,options){calls.push({method,url,options});return {status:200,responseText:JSON.stringify(value)}}}}},async()=>({token:'t'.repeat(64)}))};}
function selectionReply(overrides={}){
 const side=(text,start,width)=>({text,rects:[[start,600,start+Array.from(text).length*width,620]],glyphs:Array.from(text,(text,i)=>({text,line:0,rect:[start+i*width,600,start+(i+1)*width,620],unsafe:'discard'}))});
 return {jobID:'mapping',page:2,sourceSHA256:'a'.repeat(64),targetSHA256:'b'.repeat(64),revision:'pdf-selection-semantic-v1',key:'selection_1',cached:false,link:{id:'selection_1',key:'selection_1',paragraph:'p2_0',method:'semantic-phrase-model',sourceTokenCount:1,targetTokenCount:2,source:side('genome',40,6),target:side('基因组',60,10),dualSource:{rects:[[40,600,76,620]]},dualTarget:{rects:[[660,600,690,620]]},unsafe:'discard'},unsafe:'discard',...overrides};
}
const selectionQuery=()=>({page:2,paragraph:'p2_0',side:'source',rects:[[40,600,76,620]],text:'genome'});
(async()=>{
 await check('selection links validate bound immutable phrase evidence and strip private or unknown properties',()=>{
  const raw=selectionReply(),parsed=PDF.validateSelectionLinks(raw,'mapping',2,'a'.repeat(64));
  assert.equal(parsed.link.source.text,'genome');assert.equal(parsed.link.target.text,'基因组');assert.equal(parsed.link.paragraph,'p2_0');assert.equal(parsed.link.key,'selection_1');assert.equal(parsed.unsafe,undefined);assert.equal(parsed.link.unsafe,undefined);assert.equal(parsed.link.source.glyphs[0].unsafe,undefined);
  raw.link.source.rects[0][0]=999;raw.link.target.glyphs[0].text='坏';assert.equal(parsed.link.source.rects[0][0],40);assert.equal(parsed.link.target.glyphs[0].text,'基');
  const empty=PDF.validateSelectionLinks(selectionReply({link:null,cached:true}),'mapping',2);assert.equal(empty.link,null);assert.equal(empty.cached,true);
  const list=selectionReply();list.links=[list.link];delete list.link;delete list.key;delete list.cached;const restored=PDF.validateSelectionLinks(list,'mapping',2);assert.equal(restored.links.length,1);assert.equal(restored.key,undefined);
 });
 await check('selection response rejects different documents, pages, revisions and ambiguous envelope shapes',()=>{
  for(const change of [v=>v.jobID='other',v=>v.page=3,v=>v.page='2',v=>v.sourceSHA256='A'.repeat(64),v=>v.targetSHA256='g'.repeat(64),v=>v.revision='length-ratio',v=>v.key='../bad',v=>delete v.key,v=>v.cached='yes',v=>delete v.link,v=>v.links=[],v=>v.link.method='length-ratio',v=>v.link.sourceTokenCount=0,v=>v.link.key='other',v=>v.link.paragraph='../bad']){const value=selectionReply();change(value);assert.throws(()=>PDF.validateSelectionLinks(value,'mapping',2),{code:'response'});}
  assert.throws(()=>PDF.validateSelectionLinks(selectionReply(),'mapping',2,'c'.repeat(64)),{code:'response'});
  assert.throws(()=>PDF.validateSelectionLinks(selectionReply(),'../bad',2),{code:'response'});
  const list=selectionReply();list.links=[list.link,structuredClone(list.link)];delete list.link;delete list.key;delete list.cached;assert.throws(()=>PDF.validateSelectionLinks(list,'mapping',2),{code:'response'});
 });
 await check('selection response rejects invented glyph text, enlarged runs and malformed dual geometry',()=>{
  for(const change of [v=>v.link.source.text='different',v=>v.link.target.glyphs[0].rect=null,v=>v.link.source.glyphs[0].rect=[60,600,40,620],v=>v.link.source.rects[0][0]=0,v=>v.link.source.glyphs[1]=structuredClone(v.link.source.glyphs[0]),v=>v.link.target.glyphs[0].line=-1,v=>v.link.dualTarget.rects=[],v=>v.link.dualSource.rects[0][2]=Infinity]){const value=selectionReply();change(value);assert.throws(()=>PDF.validateSelectionLinks(value,'mapping',2),{code:'response'});}
  const deepPage=selectionReply();for(const side of ['source','target'])for(const glyph of deepPage.link[side].glyphs)glyph.line=2900001;assert.equal(PDF.validateSelectionLinks(deepPage,'mapping',2).link.source.glyphs[0].line,2900001,'real row/run IDs are not a small paragraph-local line index');
 });
 await check('selection fast path sends only authenticated bounded JSON without opening original PDF or complete alignment',async()=>{
  const calls=[],unreadable=new Proxy({}, {get(){assert.fail('cached fast path must not touch original PDF bytes');}}),transport=PDF.createTransport({Zotero:{HTTP:{async request(method,url,options){calls.push({method,url,options});return {status:200,responseText:JSON.stringify(selectionReply({cached:true}))};}}}},async()=>({token:'t'.repeat(64)}));
  const result=await transport.selectionAlignment('mapping',unreadable,{...selectionQuery(),unsafe:'discard'},[2]);assert.equal(result.cached,true);assert.equal(calls.length,1);const call=calls[0];assert.equal(call.method,'POST');assert.equal(call.url,'http://127.0.0.1:43795/v1/pdf/jobs/mapping/selection-alignment');assert.deepEqual(JSON.parse(call.options.body),selectionQuery());assert.equal(call.options.headers['Content-Type'],'application/json');assert.equal(call.options.headers.Authorization,'Bearer '+'t'.repeat(64));assert.equal(call.options.followRedirects,false);assert.equal(call.options.logBodyLength,0);
 });
 await check('selection source handshake uploads original bytes once only after an explicit source-required conflict',async()=>{
  const calls=[],input=new TextEncoder().encode('%PDF-1.7\noriginal bytes'),transport=PDF.createTransport({Zotero:{HTTP:{async request(method,url,options){calls.push({method,url,options});return calls.length===1?{status:409,responseText:JSON.stringify({error:'selection_source_required'})}:{status:200,responseText:JSON.stringify(selectionReply({cached:calls.length>2}))};}}}},async()=>({token:'t'.repeat(64)}));
  await transport.selectionAlignment('mapping',input,selectionQuery(),[2]);await transport.selectionAlignment('mapping',input,selectionQuery(),[2]);assert.deepEqual(calls.map(c=>c.options.headers['Content-Type']),['application/json','application/pdf','application/json']);assert.deepEqual(new Uint8Array(calls[1].options.body),input);assert.deepEqual(JSON.parse(calls[1].options.headers['X-AskGPT-Selection']),selectionQuery());assert.equal(calls[0].url,calls[1].url);assert(!calls.some(c=>/alignment\.json|\.pdf$|alignment-upgrade/.test(c.url)));
 });
 await check('a thrown HTTP source-required conflict safely encodes Chinese selection evidence in its PDF header',async()=>{
  const calls=[],query={...selectionQuery(),side:'target',text:'基因组😀'},transport=PDF.createTransport({Zotero:{HTTP:{async request(method,url,options){calls.push({method,url,options});if(calls.length===1)throw {xmlhttp:{status:409,responseText:JSON.stringify({error:{code:'selection_source_required'}})}};assert.match(options.headers['X-AskGPT-Selection'],/^[\x20-\x7e]+$/,'XHR headers require byte-safe JSON, including both halves of astral characters');return {status:200,responseText:JSON.stringify(selectionReply())};}}}},async()=>({token:'t'.repeat(64)}));
  await transport.selectionAlignment('mapping',new TextEncoder().encode('%PDF-1.7'),query,[2]);assert.deepEqual(JSON.parse(calls[1].options.headers['X-AskGPT-Selection']),query);assert.equal(calls.length,2);
 });
 await check('unrelated conflicts or malformed selection requests never trigger a PDF upload',async()=>{
  const calls=[],transport=PDF.createTransport({Zotero:{HTTP:{async request(method,url,options){calls.push({method,url,options});return {status:409,responseText:JSON.stringify({error:'different_conflict'})};}}}},async()=>({token:'t'.repeat(64)}));
  await assert.rejects(transport.selectionAlignment('mapping',new TextEncoder().encode('%PDF-1.7'),selectionQuery(),[2]),{code:'response'});assert.equal(calls.length,1);
  for(const query of [{...selectionQuery(),page:3},{...selectionQuery(),side:'dual'},{...selectionQuery(),paragraph:'../bad'},{...selectionQuery(),paragraph:'p'.repeat(65)},{...selectionQuery(),rects:[[0,0,0,20]]},{...selectionQuery(),rects:Array.from({length:33},()=>[0,0,20,20])},{...selectionQuery(),text:'中'.repeat(2049)},{...selectionQuery(),text:'\ud800'}])await assert.rejects(transport.selectionAlignment('mapping',null,query,[2]),{code:'response'});assert.equal(calls.length,1);
 });
 await check('selection requests bypass a pending page-upgrade mutation and never cancel its background job',async()=>{
  const calls=[];let release,cancel,aborts=0;const transport=PDF.createTransport({Zotero:{HTTP:{request(method,url,options){calls.push({method,url,options});options.cancellerReceiver(()=>{aborts++;});if(url.endsWith('/alignment-upgrade'))return new Promise(resolve=>{release=()=>resolve({status:200,responseText:JSON.stringify({id:'mapping',state:'running',sourcePages:[2],completedPages:[],mappedSentences:0,currentPage:2,pendingPages:[]})});});return Promise.resolve({status:200,responseText:JSON.stringify(selectionReply())});}}}},async()=>({token:'t'.repeat(64)}));
  const pending=transport.prioritizeAlignment('mapping',2,[2],['p2_0']);await new Promise(setImmediate);const result=await transport.selectionAlignment('mapping',null,selectionQuery(),[2],value=>{cancel=value;});assert.equal(result.link.target.text,'基因组');assert.equal(calls.length,2);cancel();assert.equal(aborts,0);assert(!calls.some(c=>c.method==='DELETE'));release();await pending;
 });
 await check('selection restoration fetches only its physical page and rejects a foreign response before use',async()=>{
  const reply=selectionReply();reply.links=[reply.link];delete reply.link;delete reply.key;delete reply.cached;const f=fixture(reply),restored=await f.transport.selectionLinks('mapping',2,[2,3]);assert.equal(restored.links[0].source.text,'genome');assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'http://127.0.0.1:43795/v1/pdf/jobs/mapping/selection-alignment?page=2');assert.equal(f.calls[0].method,'GET');assert.equal(f.calls[0].options.headers.Authorization,'Bearer '+'t'.repeat(64));await assert.rejects(f.transport.selectionLinks('mapping',1,[2,3]),{code:'response'});assert.equal(f.calls.length,1);reply.targetSHA256='invalid';await assert.rejects(fixture(reply).transport.selectionLinks('mapping',2,[2]),{code:'response'});
 });
 await check('retiring a selected-word listener stops its delivery and source retry without deleting any service task',async()=>{
  const calls=[];let cancel,release,aborts=0;const transport=PDF.createTransport({Zotero:{HTTP:{request(method,url,options){calls.push({method,url});return new Promise(resolve=>{options.cancellerReceiver(()=>{aborts++;});release=()=>resolve({status:409,responseText:JSON.stringify({error:'selection_source_required'})});});}}}},async()=>({token:'t'.repeat(64)}));
  const pending=transport.selectionAlignment('mapping',null,selectionQuery(),[2],value=>{cancel=value;}),stopped=assert.rejects(pending,{code:'stopped'});await new Promise(setImmediate);cancel();release();await stopped;assert.equal(aborts,1);assert.deepEqual(calls,[{method:'POST',url:'http://127.0.0.1:43795/v1/pdf/jobs/mapping/selection-alignment'}]);
 });
 await check('selection service busy, timeout and unavailable responses remain distinguishable without an original upload',async()=>{
  for(const [status,code] of [[409,'selection_busy'],[504,'selection_timeout'],[400,'selection_unavailable'],[400,'selection_invalid']]){const calls=[],transport=PDF.createTransport({Zotero:{HTTP:{async request(method,url,options){calls.push(options);throw {xmlhttp:{status,responseText:JSON.stringify({error:code})}};}}}},async()=>({token:'t'.repeat(64)}));await assert.rejects(transport.selectionAlignment('mapping',null,selectionQuery(),[2]),{code});assert.equal(calls.length,1);assert.equal(calls[0].headers['Content-Type'],'application/json');}
 });
 await check('a repeated source-required conflict cannot loop or upload the same PDF a second time',async()=>{
  const calls=[],transport=PDF.createTransport({Zotero:{HTTP:{async request(method,url,options){calls.push(options);return {status:409,responseText:JSON.stringify({error:'selection_source_required'})};}}}},async()=>({token:'t'.repeat(64)}));await assert.rejects(transport.selectionAlignment('mapping',new TextEncoder().encode('%PDF-1.7'),selectionQuery(),[2]),{code:'response'});assert.deepEqual(calls.map(x=>x.headers['Content-Type']),['application/json','application/pdf']);
 });
 await check('single-selection replies and page-restoration replies cannot be substituted for each other',async()=>{
  const single=selectionReply(),list=selectionReply();list.links=[list.link];delete list.link;delete list.key;delete list.cached;await assert.rejects(fixture(list).transport.selectionAlignment('mapping',null,selectionQuery(),[2]),{code:'response'});await assert.rejects(fixture(single).transport.selectionLinks('mapping',2,[2]),{code:'response'});
 });
 await check('sentence coverage counts both languages per paragraph across normalized case, hyphens and reordered sentences',()=>{
  const value={paragraphs:[{source:{text:'READ\u2010BASED DNA. First fact!'},target:{text:'第一句。第二句！'},sentences:[
   {source:{text:'first fact!'},target:{text:'第二句！'}},{source:{text:'read-based DNA.'},target:{text:'第一句。'}}]},
   {source:{text:'Straße \u03c2 \uff21\u00ad\u200b\ufeff'},target:{text:'重复重复'},sentences:[{source:{text:'STRASSE \u03c3 A'},target:{text:'重复'}},{source:{text:''},target:{text:'重复'}}]}]};
  assert.equal(PDF.sentenceCoverage(value),true);assert.equal(PDF.sentenceCoverage({...value,paragraphs:value.paragraphs.toReversed()}),true);
  for(const side of ['source','target']){const altered=structuredClone(value);altered.paragraphs[0].sentences[0][side].text+='x';assert.equal(PDF.sentenceCoverage(altered),false,side+' must not contain extra mapped characters');}
 });
 await check('sentence coverage refuses missing or duplicated text even when all complete-page flags are present',()=>{
  const page={paragraphs:[{source:{text:'Gene Gene.'},target:{text:'基因基因。'},sentences:[{source:{text:'Gene'},target:{text:'基因'}},{source:{text:'Gene.'},target:{text:'基因。'}}]}]};
  assert.equal(PDF.sentenceCoverage(page),true);
  for(const side of ['source','target'])for(const replacement of ['',side==='source'?'Gene Gene.':'基因基因。']){const altered=structuredClone(page);altered.paragraphs[0].sentences[0][side].text=replacement;assert.equal(PDF.sentenceCoverage(altered),false,'coverage must compare multiplicity on '+side);}
  const omitted=structuredClone(page);omitted.paragraphs.push({source:{text:'Missing paragraph.'},target:{text:'遗漏段落。'},sentences:[]});assert.equal(PDF.sentenceCoverage(omitted),false);
  const borrowed=structuredClone(page);borrowed.paragraphs.push(structuredClone(borrowed.paragraphs[0]));borrowed.paragraphs[1].sentences=[];assert.equal(PDF.sentenceCoverage(borrowed),false,'another paragraph cannot supply missing coverage');
  const missing=structuredClone(page);delete missing.paragraphs[0].sentences[0].target;assert.equal(PDF.sentenceCoverage(missing),false);delete missing.paragraphs[0].sentences;assert.equal(PDF.sentenceCoverage(missing),false);assert.equal(PDF.sentenceCoverage(null),false);
 });
 await check('alignment is fetched only by validated job id and matches exact physical page map',async()=>{
  const f=fixture(alignment());assert.equal(typeof f.transport.alignment,'function');const data=await f.transport.alignment('job_mapping-1',[2]);
  assert.equal(data.pages[0].sourcePage,2);assert.equal(data.pages[0].paragraphs[0].source.text,'Original paragraph');
  assert.equal(f.calls[0].url,'http://127.0.0.1:43795/v1/pdf/jobs/job_mapping-1/alignment.json');
  assert.equal(f.calls[0].options.headers.Authorization,'Bearer '+'t'.repeat(64));assert.equal(f.calls[0].options.followRedirects,false);
  await assert.rejects(f.transport.alignment('../escape',[2]),{code:'response'});assert.equal(f.calls.length,1);
 });
 await check('validated source SHA survives transport for persistent exact annotation selections',async()=>{
  const data=alignment();data.sourceSHA256='a'.repeat(64);const parsed=await fixture(data).transport.alignment('mapping',[2]);assert.equal(parsed.sourceSHA256,data.sourceSHA256);
  for(const bad of ['', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), null, 7, {sha:'a'.repeat(64)}]){const altered=alignment();altered.sourceSHA256=bad;await assert.rejects(fixture(altered).transport.alignment('mapping',[2]),{code:'response'});}
  assert.equal((await fixture(alignment()).transport.alignment('mapping',[2])).sourceSHA256,undefined);
 });
 await check('paragraph mapping accepts a real paper sidecar larger than status response limit',async()=>{
  const data=alignment();data.pages[0].paragraphs=Array.from({length:500},(_,i)=>({...data.pages[0].paragraphs[0],id:'p0_'+i}));
  assert(JSON.stringify(data).length>65536);assert.equal((await fixture(data).transport.alignment('mapping',[2])).pages[0].paragraphs.length,500);
 });
 await check('mismatched source order or output page index is rejected before annotation use',async()=>{
  for(const change of [d=>d.pages[0].sourcePage=1,d=>d.pages[0].outputPage=2,d=>d.pages.push(d.pages[0])]){const d=alignment();change(d);await assert.rejects(fixture(d).transport.alignment('mapping',[2]),{code:'response'});}
 });
 await check('mapping rejects non-PDF coordinates, non-paragraph precision and invalid geometry',async()=>{
  for(const change of [d=>d.coordinateSpace='css',d=>d.granularity='word',d=>d.pages[0].source.rotation=45,d=>d.pages[0].sourceToDual=[0,0,0,0,0,0],d=>d.pages[0].paragraphs[0].target.rects=[[0,0,NaN,50]],d=>d.pages[0].paragraphs[0].source.rects=[[50,20,10,30]],d=>d.pages[0].paragraphs.push(d.pages[0].paragraphs[0])]){const d=alignment();change(d);await assert.rejects(fixture(d).transport.alignment('mapping',[2]),{code:'response'});}
 });
 await check('mapping fetch never falls back to nearest text or a different source page',async()=>{
  const d=alignment();d.pages[0].paragraphs=[];const v=await fixture(d).transport.alignment('mapping',[2]);assert.deepEqual(v.pages[0].paragraphs,[]);
  await assert.rejects(fixture({...d,schema:0}).transport.alignment('mapping',[2]),{code:'response'});
 });
 const sentenceAlignment=()=>{const d=alignment(),p=d.pages[0].paragraphs[0];d.granularity='sentence';d.sentenceAlignmentRevision='pdf-sentence-semantic-v1';d.sentencePages=[2];p.sentences=[{...structuredClone(p),id:'p0_0_s0',method:'semantic-model',unsafe:'discard'}];return d;};
 await check('semantic sentence mapping preserves verified sentence rectangles and strips unknown fields',async()=>{
  const d=await fixture(sentenceAlignment()).transport.alignment('mapping',[2]);
  assert.equal(d.granularity,'sentence');assert.equal(d.sentenceAlignmentRevision,'pdf-sentence-semantic-v1');assert.deepEqual(d.sentencePages,[2]);
  assert.equal(d.pages[0].paragraphs[0].sentences[0].method,'semantic-model');assert.equal(d.pages[0].paragraphs[0].sentences[0].unsafe,undefined);
  for(const change of [x=>x.sentencePages=[1],x=>x.sentenceAlignmentRevision='guessed',x=>x.pages[0].paragraphs[0].sentences[0].method='length-ratio',x=>x.pages[0].paragraphs[0].sentences[0].target.rects=[]]){const bad=sentenceAlignment();change(bad);await assert.rejects(fixture(bad).transport.alignment('mapping',[2]),{code:'response'});}
 });
 await check('glyph identity provenance survives transport only for unchanged text and rectangles',async()=>{
  const value=sentenceAlignment(),row=value.pages[0].paragraphs[0].sentences[0];row.method='glyph-identity';row.target=structuredClone(row.source);
  const result=await fixture(value).transport.alignment('mapping',[2]);assert.equal(result.pages[0].paragraphs[0].sentences[0].method,'glyph-identity');
  for(const change of [s=>s.target.text+=' altered',s=>s.target.rects[0][1]+=.02,s=>s.target.rects.push(s.target.rects[0])]){
   const bad=structuredClone(value);change(bad.pages[0].paragraphs[0].sentences[0]);await assert.rejects(fixture(bad).transport.alignment('mapping',[2]),{code:'response'});
  }
 });
 function phraseAlignment(){const value=sentenceAlignment(),row=value.pages[0].paragraphs[0].sentences[0];value.phraseAlignmentRevision='pdf-phrase-semantic-v1';value.phrasePages=[2];
  for(const [side,text] of [['source','original'],['target','译文']]){const chars=Array.from(text);row[side]={text,rects:[[40,600,80,620]],glyphs:chars.map((text,i)=>({text,line:0,rect:[40+40*i/chars.length,600,40+40*(i+1)/chars.length,620],unsafe:'discard'}))};}
  row.dualSource={rects:row.source.rects};row.dualTarget={rects:[[640,600,680,620]]};row.phrases=[{id:'word',method:'semantic-phrase-model',source:structuredClone(row.source),target:structuredClone(row.target),dualSource:structuredClone(row.dualSource),dualTarget:structuredClone(row.dualTarget),sourceTokenCount:1,targetTokenCount:2,unsafe:'discard'}];return value;}
 await check('partial sentence pages preserve verified sentences and phrases without pretending the entire page is prepared',async()=>{
  const value=phraseAlignment();value.sentencePages=[];value.sentencePartialPages=[2];value.phraseExtractionRevision='pdf-glyph-boundary-v2';value.phraseExtractedPages=[];value.phraseCoverage={'2':{sentences:1,extractable:1,aligned:1,unavailable:0,sourceTokens:1,targetTokens:2,mappedSourceTokens:1,mappedTargetTokens:2}};
  const parsed=await fixture(value).transport.alignment('mapping',[2]);assert.deepEqual(parsed.sentencePartialPages,[2]);assert.deepEqual(parsed.sentencePages,[]);assert.deepEqual(parsed.phrasePages,[2]);assert.deepEqual(parsed.phraseExtractedPages,[]);assert.equal(parsed.pages[0].paragraphs[0].sentences[0].phrases[0].source.text,'original');assert.equal(require('../content/pdf-native-view.js').validateAlignment(parsed,[2]).sentencePartialPages[0],2);
 });
 await check('partial sentence pages reject overlaps, duplicate or unknown physical pages and complete-extraction claims',async()=>{
  for(const change of [v=>v.sentencePartialPages=[2,2],v=>v.sentencePartialPages=[1],v=>v.sentencePages=[2],v=>v.sentencePartialPages=['2'],v=>{v.phraseExtractionRevision='pdf-glyph-boundary-v2';v.phraseExtractedPages=[2];v.phraseCoverage={'2':{sentences:1,extractable:1,aligned:1,unavailable:0,sourceTokens:1,targetTokens:2,mappedSourceTokens:1,mappedTargetTokens:2}};}]){const value=phraseAlignment();value.sentencePages=[];value.sentencePartialPages=[2];change(value);await assert.rejects(fixture(value).transport.alignment('mapping',[2]),{code:'response'});}
  const legacy=alignment();legacy.sentencePartialPages=[2];await assert.rejects(fixture(legacy).transport.alignment('mapping',[2]),{code:'response'});
 });
 await check('precise word metadata survives transport with complete glyph pools and only approved fields',async()=>{
  const result=await fixture(phraseAlignment()).transport.alignment('mapping',[2]),row=result.pages[0].paragraphs[0].sentences[0];assert.equal(result.phraseAlignmentRevision,'pdf-phrase-semantic-v1');assert.deepEqual(result.phrasePages,[2]);assert.equal(row.phrases[0].source.text,'original');assert.equal(row.phrases[0].sourceTokenCount,1);assert.equal(row.source.glyphs[0].unsafe,undefined);assert.equal(row.phrases[0].unsafe,undefined);assert.equal(row.source.glyphs[0].line,0);
  const empty=phraseAlignment();empty.pages[0].paragraphs[0].sentences[0].phrases=[];assert.deepEqual((await fixture(empty).transport.alignment('mapping',[2])).phrasePages,[2]);
 });
 await check('real PDF kerning overlap keeps exact identity words valid without admitting enlarged or skipped-glyph boxes',async()=>{
  const value=phraseAlignment(),row=value.pages[0].paragraphs[0].sentences[0],glyphs=[{text:'7',line:0,rect:[401.4527,598.547,405.4463,607.283]},{text:',',line:0,rect:[404.4323,598.547,406.0781,607.283]}],dual=part=>({rects:part.rects.map(r=>[r[0]+600,r[1],r[2]+600,r[3]])});
  for(const side of ['source','target'])row[side]={text:'7,',rects:[[401.4527,598.547,406.0781,607.283]],glyphs:structuredClone(glyphs)};
  row.method='glyph-identity';row.dualSource={rects:row.source.rects};row.dualTarget=dual(row.target);row.phrases=glyphs.map((g,i)=>{const part={text:g.text,rects:[g.rect],glyphs:[g]};return {id:row.id+'_w'+i,method:'glyph-identity',source:structuredClone(part),target:structuredClone(part),dualSource:{rects:part.rects},dualTarget:dual(part),sourceTokenCount:1,targetTokenCount:1};});
  assert((glyphs[1].rect[0]+glyphs[1].rect[2])/2<glyphs[0].rect[2],'the following comma genuinely overlaps the digit font bbox');
  const parsed=await fixture(value).transport.alignment('mapping',[2]);assert.equal(parsed.pages[0].paragraphs[0].sentences[0].phrases.length,2);const Native=require('../content/pdf-native-view.js');assert.equal(Native.validateAlignment(parsed,[2]).pages.length,1);
  const enlarged=structuredClone(value),large=enlarged.pages[0].paragraphs[0].sentences[0].phrases[0];for(const side of ['source','target'])large[side].rects[0][2]+=.1;large.dualSource={rects:large.source.rects};large.dualTarget=dual(large.target);await assert.rejects(fixture(enlarged).transport.alignment('mapping',[2]),{code:'response'});assert.throws(()=>Native.validateAlignment(enlarged,[2]),{code:'compatibility'});
  const skipped=structuredClone(value),s=skipped.pages[0].paragraphs[0].sentences[0],last={text:'7',line:0,rect:[408,598.547,411.9936,607.283]};for(const side of ['source','target']){s[side].text='7,7';s[side].glyphs.push(structuredClone(last));s[side].rects[0][2]=411.9936;s.phrases[0][side]={text:'77',glyphs:[s[side].glyphs[0],s[side].glyphs[2]],rects:[[401.4527,598.547,411.9936,607.283]]};}s.dualSource={rects:s.source.rects};s.dualTarget=dual(s.target);s.phrases[0].dualSource={rects:s.phrases[0].source.rects};s.phrases[0].dualTarget=dual(s.phrases[0].target);await assert.rejects(fixture(skipped).transport.alignment('mapping',[2]),{code:'response'});assert.throws(()=>Native.validateAlignment(skipped,[2]),{code:'compatibility'});
 });
 await check('boundary extraction readiness and exact coverage survive transport independently of old word links',async()=>{
  const value=phraseAlignment();value.phraseExtractionRevision='pdf-glyph-boundary-v2';value.phraseExtractedPages=[2];value.phraseCoverage={'2':{sentences:1,extractable:1,aligned:1,unavailable:0,sourceTokens:1,targetTokens:2,mappedSourceTokens:1,mappedTargetTokens:2}};
  const parsed=await fixture(value).transport.alignment('mapping',[2]);assert.equal(parsed.phraseExtractionRevision,value.phraseExtractionRevision);assert.deepEqual(parsed.phraseExtractedPages,[2]);assert.deepEqual(parsed.phraseCoverage,value.phraseCoverage);
  for(const mutate of [v=>v.phraseExtractionRevision='guessed',v=>v.phraseExtractedPages=[1],v=>v.phraseExtractedPages=[2,2],v=>delete v.phraseCoverage,v=>v.phraseCoverage['3']=v.phraseCoverage['2'],v=>v.phraseCoverage['2'].extractable=2,v=>v.phraseCoverage['2'].aligned=0,v=>v.phraseCoverage['2'].mappedSourceTokens=2,v=>v.phraseCoverage['2'].sourceTokens=true,v=>v.phraseCoverage['2'].extra=1]){const invalid=structuredClone(value);mutate(invalid);await assert.rejects(fixture(invalid).transport.alignment('mapping',[2]),{code:'response'});}
  const old=await fixture(phraseAlignment()).transport.alignment('mapping',[2]);assert.equal(old.phraseExtractionRevision,undefined);assert.deepEqual(old.phrasePages,[2]);
 });
 await check('a real partial checkpoint keeps word coverage without declaring the page extracted',async()=>{
  const value=phraseAlignment();value.phraseExtractionRevision='pdf-glyph-boundary-v2';value.phraseExtractedPages=[];value.phraseCoverage={'2':{sentences:1,extractable:1,aligned:1,unavailable:0,sourceTokens:1,targetTokens:2,mappedSourceTokens:1,mappedTargetTokens:2}};
  const parsed=await fixture(value).transport.alignment('mapping',[2]);assert.deepEqual(parsed.phraseExtractedPages,[]);assert.deepEqual(parsed.phraseCoverage,value.phraseCoverage);assert.equal(parsed.pages[0].paragraphs[0].sentences[0].phrases.length,1);
  const unknown=structuredClone(value);unknown.phraseCoverage['3']=unknown.phraseCoverage['2'];await assert.rejects(fixture(unknown).transport.alignment('mapping',[2]),{code:'response'});
  const missing=structuredClone(value);missing.phraseExtractedPages=[2];missing.phraseCoverage={};await assert.rejects(fixture(missing).transport.alignment('mapping',[2]),{code:'response'});
  const noncanonical=structuredClone(value);noncanonical.phraseCoverage={'02':noncanonical.phraseCoverage['2']};await assert.rejects(fixture(noncanonical).transport.alignment('mapping',[2]),{code:'response'});
 });
 await check('an unextractable sentence can declare no precise relations without fabricating glyph geometry',async()=>{
  const value=phraseAlignment(),row=value.pages[0].paragraphs[0].sentences[0];row.phrases=[];delete row.source.glyphs;delete row.target.glyphs;const result=await fixture(value).transport.alignment('mapping',[2]);assert.deepEqual(result.pages[0].paragraphs[0].sentences[0].phrases,[]);assert.equal(result.pages[0].paragraphs[0].sentences[0].source.glyphs,undefined);
 });
 await check('word metadata rejects guessed revisions, missing glyphs, invalid synthetic glyphs and duplicate assignments',async()=>{
  for(const change of [v=>v.phraseAlignmentRevision='length-ratio',v=>v.phrasePages=[1],v=>v.phrasePages=[],v=>v.pages[0].paragraphs[0].sentences[0].target.glyphs.pop(),v=>v.pages[0].paragraphs[0].sentences[0].source.glyphs[0].rect=null,v=>v.pages[0].paragraphs[0].sentences[0].phrases[0].sourceTokenCount=0,v=>v.pages[0].paragraphs[0].sentences[0].phrases[0].target.glyphs[0].rect[0]++,v=>v.pages[0].paragraphs[0].sentences[0].phrases[0].dualTarget.rects[0][0]++,v=>v.pages[0].paragraphs[0].sentences[0].phrases.push({...structuredClone(v.pages[0].paragraphs[0].sentences[0].phrases[0]),id:'repeated'})]){const value=phraseAlignment();change(value);await assert.rejects(fixture(value).transport.alignment('mapping',[2]),{code:'response'});}
 });
 await check('sentence upgrade reuses cached job, uploads original bytes and polls without translation or deletion',async()=>{
  const calls=[],ready=sentenceAlignment(),state={id:'mapping',state:'running',sourcePages:[2],completedPages:[],mappedSentences:0};
  const transport=PDF.createTransport({setTimer:fn=>setTimeout(fn,0),clearTimer:clearTimeout,Zotero:{HTTP:{async request(method,url,options){calls.push({method,url,options});return {status:method==='POST'?202:200,responseText:JSON.stringify(url.endsWith('/alignment.json')?ready:method==='POST'?state:{...state,state:'complete',completedPages:[2],mappedSentences:1})};}}}},async()=>({token:'t'.repeat(64)}));
  const input=new TextEncoder().encode('%PDF-1.7\noriginal bytes\n');let cancel;
  const result=await transport.upgradeAlignment('mapping',input,[2],[2],value=>{cancel=value;});assert.equal(typeof cancel,'function');assert.deepEqual(result.sentencePages,[2]);
  assert.equal(calls[0].url,'http://127.0.0.1:43795/v1/pdf/jobs/mapping/alignment-upgrade');assert.equal(calls[0].options.headers['X-AskGPT-Pages'],'3');assert.deepEqual(new Uint8Array(calls[0].options.body),input);
  assert.deepEqual(calls.map(x=>x.method),['POST','GET','GET']);assert(calls.every(x=>x.options.followRedirects===false));
  await assert.rejects(transport.upgradeAlignment('mapping',input,[1],[2]),{code:'response'});assert.equal(calls.length,3);
 });
 await check('retiring a sentence-upgrade listener never deletes the permanent translation',async()=>{
  const calls=[];const transport=PDF.createTransport({setTimer:fn=>setTimeout(fn,0),clearTimer:clearTimeout,Zotero:{HTTP:{async request(method,url){calls.push(method);return {status:202,responseText:JSON.stringify({id:'mapping',state:'running',sourcePages:[2],completedPages:[],mappedSentences:0})};}}}},async()=>({token:'t'.repeat(64)}));
  const pending=transport.upgradeAlignment('mapping',new TextEncoder().encode('%PDF-1.7\noriginal\n'),[2],[2],cancel=>cancel());await assert.rejects(pending,{code:'stopped'});assert(!calls.includes('DELETE'));
 });
 const priorityState=(extra={})=>({id:'mapping',state:'idle',sourcePages:[2],completedPages:[],mappedSentences:0,currentPage:null,pendingPages:[],...extra});
 await check('alignment priority sends only bounded JSON to the existing route and returns idle without uploading a PDF',async()=>{
  const f=fixture(priorityState());const result=await f.transport.prioritizeAlignment('mapping',2,[2],['p0_0_s0','s_2-A']);assert.equal(result.state,'idle');assert.equal(f.calls.length,1);
  const {method,url,options}=f.calls[0];assert.equal(method,'POST');assert.equal(url,'http://127.0.0.1:43795/v1/pdf/jobs/mapping/alignment-upgrade');assert.equal(options.headers['Content-Type'],'application/json');assert.equal(options.headers['X-AskGPT-Pages'],undefined);assert.equal(options.headers['X-AskGPT-Units'],undefined);assert.equal(options.headers.Authorization,'Bearer '+'t'.repeat(64));assert.equal(options.followRedirects,false);assert.deepEqual(JSON.parse(options.body),{page:2,units:['p0_0_s0','s_2-A']});assert(options.body.length<=2048);assert(!options.body.includes('%PDF'));
 });
 await check('priority rejects unsafe job/page maps and malformed or oversized units before making a request',async()=>{
  const f=fixture(priorityState());for(const [id,page,sourcePages] of [['../mapping',2,[2]],['mapping',-1,[2]],['mapping',3,[2]],['mapping','2',[2]],['mapping',2,[]],['mapping',2,[2,2]],['mapping',2,[2,2000]],['mapping',2,[2,NaN]],['mapping',2,[2,,3]]])await assert.rejects(f.transport.prioritizeAlignment(id,page,sourcePages),{code:'response'});
  for(const units of [null,'s0',{},[''],['s0','s0'],['a'.repeat(65)],['../s0'],['s0\r\nX-Test:yes'],['选区'],Array.from({length:9},(_,i)=>'s'+i),[1],[true],[undefined]])await assert.rejects(f.transport.prioritizeAlignment('mapping',2,[2],units),{code:'response'});assert.equal(f.calls.length,0);
  await f.transport.prioritizeAlignment('mapping',2,[2]);assert.deepEqual(JSON.parse(f.calls[0].options.body),{page:2,units:[]});
 });
 await check('priority responses reuse strict job, page, version and progress validation',async()=>{
  for(const change of [v=>v.id='other',v=>v.state='unknown',v=>v.sourcePages=[3],v=>v.completedPages=[2,2],v=>v.pendingPages=[3],v=>v.currentPage=3,v=>v.mappedSentences=-1,v=>v.alignmentVersion='bad']){const value=priorityState();change(value);await assert.rejects(fixture(value).transport.prioritizeAlignment('mapping',2,[2]),{code:'response'});}
 });
 await check('the first PDF upgrade carries selected safe units in one header without changing its original bytes',async()=>{
  const calls=[],ready=sentenceAlignment(),transport=PDF.createTransport({Zotero:{HTTP:{async request(method,url,options){calls.push({method,url,options});return {status:200,responseText:JSON.stringify(url.endsWith('/alignment.json')?ready:priorityState({state:'complete',completedPages:[2]}))};}}}},async()=>({token:'t'.repeat(64)})),bytes=new TextEncoder().encode('%PDF-1.7\noriginal bytes\n');
  await transport.upgradeAlignment('mapping',bytes,[2],[2],()=>{},{units:['p0_0_s0']});assert.equal(calls[0].options.headers['X-AskGPT-Units'],'["p0_0_s0"]');assert.equal(calls[0].options.headers['X-AskGPT-Pages'],'3');assert.equal(calls[0].options.headers['Content-Type'],'application/pdf');assert.deepEqual(new Uint8Array(calls[0].options.body),bytes);
  const before=calls.length;for(const units of [null,['unsafe\n'],['s0','s0'],Array.from({length:9},(_,i)=>'s'+i)])await assert.rejects(transport.upgradeAlignment('mapping',bytes,[2],[2],()=>{},{units}),{code:'response'});await assert.rejects(transport.upgradeAlignment('mapping',bytes,[2],[2,3],()=>{},{units:['s0'],prefetchPages:[3]}),{code:'response'});assert.equal(calls.length,before);
 });
 await check('probing an already scheduled page updates its selected units using JSON before polling and never uploads the PDF again',async()=>{
  const calls=[],ready=sentenceAlignment();ready.pages.unshift({...structuredClone(alignment().pages[0]),sourcePage:1,outputPage:0});ready.pages[1].outputPage=1;let focused=false;
  const transport=PDF.createTransport({setTimer:fn=>setTimeout(fn,0),clearTimer:clearTimeout,Zotero:{HTTP:{async request(method,url,options){calls.push({method,url,options});if(url.endsWith('/alignment.json'))return {status:200,responseText:JSON.stringify(ready)};if(method==='POST'){assert.equal(options.headers['Content-Type'],'application/json');assert.deepEqual(JSON.parse(options.body),{page:2,units:['p0_0_s0']});focused=true;return {status:200,responseText:JSON.stringify(priorityState({state:'running',sourcePages:[1,2],currentPage:1,pendingPages:[2]}))};}return {status:200,responseText:JSON.stringify(priorityState({state:'running',sourcePages:[1,2],currentPage:1,pendingPages:focused?[]:[2],completedPages:focused?[2]:[],mappedSentences:focused?1:0}))};}}}},async()=>({token:'t'.repeat(64)}));
  const result=await transport.upgradeAlignment('mapping',new TextEncoder().encode('%PDF-1.7\n'),[2],[1,2],()=>{},{probe:true,units:['p0_0_s0']});assert.deepEqual(result.sentencePages,[2]);assert.deepEqual(calls.map(call=>call.method),['GET','POST','GET','GET']);assert.equal(calls.filter(call=>call.options.headers['Content-Type']==='application/pdf').length,0);
 });
 await check('a running-to-idle priority race leaves the original upgrade flow responsible for the first PDF submission',async()=>{
  const calls=[],ready=sentenceAlignment(),transport=PDF.createTransport({Zotero:{HTTP:{async request(method,url,options){calls.push({method,url,options});const type=options.headers['Content-Type'];return {status:200,responseText:JSON.stringify(url.endsWith('/alignment.json')?ready:method==='GET'?priorityState({state:'running',currentPage:2}):type==='application/json'?priorityState():priorityState({state:'complete',completedPages:[2]}))};}}}},async()=>({token:'t'.repeat(64)}));
  await transport.upgradeAlignment('mapping',new TextEncoder().encode('%PDF-1.7\n'),[2],[2],()=>{},{probe:true,units:['p0_0_s0']});assert.deepEqual(calls.map(call=>call.method),['GET','POST','POST','GET']);assert.equal(calls[1].options.headers['Content-Type'],'application/json');assert.equal(calls[2].options.headers['Content-Type'],'application/pdf');assert.equal(calls[2].options.headers['X-AskGPT-Units'],'["p0_0_s0"]');
 });
 await check('same-job priority mutations wait for older in-flight requests so the latest selection owns the final focus',async()=>{
  const calls=[],applied=[];let release;
  const transport=PDF.createTransport({Zotero:{HTTP:{request(method,url,options){const body=JSON.parse(options.body);calls.push(body);const response=()=>{applied.push(body.units[0]);return {status:200,responseText:JSON.stringify(priorityState({state:'running',currentPage:2}))};};if(body.units[0]==='u1')return new Promise(resolve=>{release=()=>resolve(response());});return Promise.resolve(response());}}}},async()=>({token:'t'.repeat(64)}));
  const first=transport.prioritizeAlignment('mapping',2,[2],['u1']),second=transport.prioritizeAlignment('mapping',2,[2],['u2']);await new Promise(setImmediate);assert.equal(calls.length,1,'the newer request must not overtake the delayed older mutation');release();await Promise.all([first,second]);assert.deepEqual(calls.map(value=>value.units[0]),['u1','u2']);assert.deepEqual(applied,['u1','u2']);
 });
 await check('priority reserves input order before asynchronous connection loading can reverse it',async()=>{
  const calls=[];let reads=0,release;
  const transport=PDF.createTransport({Zotero:{HTTP:{async request(method,url,options){calls.push(JSON.parse(options.body).units[0]);return {status:200,responseText:JSON.stringify(priorityState())};}}}},()=>{reads++;return reads===1?new Promise(resolve=>{release=()=>resolve({token:'t'.repeat(64)});}):Promise.resolve({token:'t'.repeat(64)});});
  const first=transport.prioritizeAlignment('mapping',2,[2],['u1']),second=transport.prioritizeAlignment('mapping',2,[2],['u2']);await new Promise(setImmediate);assert.equal(reads,1);assert.deepEqual(calls,[]);release();await Promise.all([first,second]);assert.deepEqual(calls,['u1','u2']);
 });
 await check('a late probe cannot clear a newer selected-unit focus while its existing watcher continues polling',async()=>{
  const calls=[];let release,probed=false;
  const transport=PDF.createTransport({setTimer:fn=>setTimeout(fn,0),clearTimer:clearTimeout,Zotero:{HTTP:{request(method,url,options){calls.push({method,url,options});if(url.endsWith('/alignment.json'))return Promise.resolve({status:200,responseText:JSON.stringify(sentenceAlignment())});if(method==='POST')return Promise.resolve({status:200,responseText:JSON.stringify(priorityState({state:'running',currentPage:2}))});if(!probed){probed=true;return new Promise(resolve=>{release=()=>resolve({status:200,responseText:JSON.stringify(priorityState({state:'running',currentPage:2}))});});}return Promise.resolve({status:200,responseText:JSON.stringify(priorityState({state:'complete',completedPages:[2]}))});}}}},async()=>({token:'t'.repeat(64)}));
  const old=transport.upgradeAlignment('mapping',new TextEncoder().encode('%PDF-1.7\n'),[2],[2],()=>{},{probe:true,units:['u1']});await new Promise(setImmediate);await transport.prioritizeAlignment('mapping',2,[2],['u2']);release();await old;const posts=calls.filter(call=>call.method==='POST');assert.equal(posts.length,1);assert.deepEqual(JSON.parse(posts[0].options.body),{page:2,units:['u2']});assert.equal(calls.filter(call=>call.method==='GET'&&!call.url.endsWith('/alignment.json')).length,2);
 });
 await check('a late old-page probe cannot submit obsolete PDF work after focus moved to a different page',async()=>{
  const calls=[];let release;
  const state=priorityState({state:'running',sourcePages:[2,3],currentPage:3}),transport=PDF.createTransport({Zotero:{HTTP:{request(method,url,options){calls.push({method,url,options});if(method==='GET')return new Promise(resolve=>{release=()=>resolve({status:200,responseText:JSON.stringify(state)});});return Promise.resolve({status:200,responseText:JSON.stringify(state)});}}}},async()=>({token:'t'.repeat(64)}));
  const old=transport.upgradeAlignment('mapping',new TextEncoder().encode('%PDF-1.7\n'),[2],[2,3],()=>{},{probe:true,units:['p2_s0']}),stopped=assert.rejects(old,{code:'stopped'});await new Promise(setImmediate);await transport.prioritizeAlignment('mapping',3,[2,3],['p3_s0']);release();await stopped;assert.deepEqual(calls.map(call=>call.method),['GET','POST']);assert.deepEqual(JSON.parse(calls[1].options.body),{page:3,units:['p3_s0']});assert.equal(calls[1].options.headers['Content-Type'],'application/json');
 });
 await check('alignment mutation queues are isolated per job and never block another document',async()=>{
  const calls=[];let release;
  const transport=PDF.createTransport({Zotero:{HTTP:{request(method,url,options){const id=url.split('/').at(-2);calls.push(id);const value={status:200,responseText:JSON.stringify(priorityState({id}))};return id==='mappingA'?new Promise(resolve=>{release=()=>resolve(value);}):Promise.resolve(value);}}}},async()=>({token:'t'.repeat(64)}));
  const first=transport.prioritizeAlignment('mappingA',2,[2],['u1']),second=transport.prioritizeAlignment('mappingB',2,[2],['u2']);await second;assert.deepEqual(calls,['mappingA','mappingB']);release();await first;
 });
 await check('retiring an in-flight PDF watcher preserves its atomic POST and queues the newer-page focus after it settles',async()=>{
  const calls=[];let release,cancel,aborts=0;
  const transport=PDF.createTransport({Zotero:{HTTP:{request(method,url,options){calls.push({method,url,options});options.cancellerReceiver(()=>{aborts++;});if(options.headers['Content-Type']==='application/pdf')return new Promise(resolve=>{release=()=>resolve({status:200,responseText:JSON.stringify(priorityState({state:'running',sourcePages:[2,3],currentPage:2}))});});return Promise.resolve({status:200,responseText:JSON.stringify(priorityState({state:'running',sourcePages:[2,3],currentPage:2,pendingPages:[3]}))});}}}},async()=>({token:'t'.repeat(64)}));
  const old=transport.upgradeAlignment('mapping',new TextEncoder().encode('%PDF-1.7\n'),[2],[2,3],value=>{cancel=value;});const stopped=assert.rejects(old,{code:'stopped'});await new Promise(setImmediate);cancel();const latest=transport.prioritizeAlignment('mapping',3,[2,3],['p3_s0']);await new Promise(setImmediate);assert.equal(aborts,0,'an accepted POST is an atomic service mutation, not the polling watcher');assert.equal(calls.length,1);release();await stopped;await latest;assert.deepEqual(calls.map(call=>call.options.headers['Content-Type']),['application/pdf','application/json']);assert.deepEqual(JSON.parse(calls[1].options.body),{page:3,units:['p3_s0']});assert(!calls.some(call=>call.method==='DELETE'));
 });
 await check('a cancelled PDF mutation waiting behind another request is skipped before any original bytes are uploaded',async()=>{
  const calls=[];let release,cancel;
  const transport=PDF.createTransport({Zotero:{HTTP:{request(method,url,options){calls.push(options);return new Promise(resolve=>{release=()=>resolve({status:200,responseText:JSON.stringify(priorityState())});});}}}},async()=>({token:'t'.repeat(64)}));
  const first=transport.prioritizeAlignment('mapping',2,[2],['u1']);await new Promise(setImmediate);const old=transport.upgradeAlignment('mapping',new TextEncoder().encode('%PDF-1.7\n'),[2],[2],value=>{cancel=value;});const stopped=assert.rejects(old,{code:'stopped'});await new Promise(setImmediate);cancel();release();await first;await stopped;assert.equal(calls.length,1);assert.equal(calls[0].headers['Content-Type'],'application/json');
 });
 await check('retiring a GET watcher still aborts its poll without deleting or cancelling the independent service task',async()=>{
  const calls=[];let cancel,aborts=0;
  const transport=PDF.createTransport({Zotero:{HTTP:{request(method,url,options){calls.push(method);return new Promise((resolve,reject)=>{options.cancellerReceiver(()=>{aborts++;reject(Error('poll aborted'));});});}}}},async()=>({token:'t'.repeat(64)}));
  const pending=transport.upgradeAlignment('mapping',new TextEncoder().encode('%PDF-1.7\n'),[2],[2],value=>{cancel=value;},{probe:true}),stopped=assert.rejects(pending,{code:'stopped'});await new Promise(setImmediate);cancel();await stopped;assert.equal(aborts,1);assert.deepEqual(calls,['GET']);
 });
 await check('probing a cached sentence page skips original upload and model request',async()=>{
  const calls=[],ready=sentenceAlignment(),transport=PDF.createTransport({Zotero:{HTTP:{async request(method,url){calls.push({method,url});return {status:200,responseText:JSON.stringify(url.endsWith('/alignment.json')?ready:{id:'mapping',state:'idle',sourcePages:[2],completedPages:[2],mappedSentences:1})};}}}},async()=>({token:'t'.repeat(64)}));
  const result=await transport.upgradeAlignment('mapping',new TextEncoder().encode('%PDF-1.7\n'),[2],[2],()=>{},{probe:true});
  assert.deepEqual(result.sentencePages,[2]);assert.deepEqual(calls.map(x=>x.method),['GET','GET']);assert(!calls.some(x=>x.method==='POST'));
 });
 await check('current page returns while one adjacent page continues in the same background request',async()=>{
  const calls=[],ready=sentenceAlignment();ready.pages.push({...structuredClone(alignment().pages[0]),sourcePage:3,outputPage:1});
  let posted=false,polls=0;const transport=PDF.createTransport({setTimer:fn=>setTimeout(fn,0),clearTimer:clearTimeout,Zotero:{HTTP:{async request(method,url,options){calls.push({method,url,options});if(url.endsWith('/alignment.json'))return {status:200,responseText:JSON.stringify(ready)};if(method==='POST')posted=true;else if(posted)polls++;return {status:method==='POST'?202:200,responseText:JSON.stringify({id:'mapping',state:posted?'running':'idle',sourcePages:[2,3],completedPages:polls?[2]:[],mappedSentences:polls?1:0})};}}}},async()=>({token:'t'.repeat(64)}));
  const result=await transport.upgradeAlignment('mapping',new TextEncoder().encode('%PDF-1.7\n'),[2],[2,3],()=>{},{probe:true,prefetchPages:[3]});
  assert.deepEqual(result.sentencePages,[2]);assert.equal(polls,1,'do not wait for adjacent-page preparation');const posts=calls.filter(x=>x.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].options.headers['X-AskGPT-Pages'],'3,4');assert(!calls.some(x=>x.method==='DELETE'));
 });
 await check('an already preparing page is polled without uploading the original again',async()=>{
  const calls=[],ready=sentenceAlignment();let gets=0;
  const transport=PDF.createTransport({setTimer:fn=>setTimeout(fn,0),clearTimer:clearTimeout,Zotero:{HTTP:{async request(method,url,options){calls.push({method,url,options});if(method==='POST'){assert.equal(options.headers['Content-Type'],'application/json');assert.deepEqual(JSON.parse(options.body),{page:2,units:[]});assert.equal(options.headers['X-AskGPT-Pages'],undefined);}else if(!url.endsWith('/alignment.json'))gets++;const status={id:'mapping',state:'running',sourcePages:[2],completedPages:gets>1?[2]:[],mappedSentences:gets>1?1:0,currentPage:2,pendingPages:[]};return {status:200,responseText:JSON.stringify(url.endsWith('/alignment.json')?ready:status)};}}}},async()=>({token:'t'.repeat(64)}));
  const result=await transport.upgradeAlignment('mapping',new TextEncoder().encode('%PDF-1.7\n'),[2],[2],()=>{},{probe:true});assert.deepEqual(result.sentencePages,[2]);assert.deepEqual(calls.map(x=>x.method),['GET','POST','GET','GET']);
 });
 const versionA='a'.repeat(64),versionB='b'.repeat(64),input=new TextEncoder().encode('%PDF-1.7\n');
 function upgradeState(version,extra={}){return {id:'mapping',state:'running',sourcePages:[2],completedPages:[],mappedSentences:0,currentPage:2,pendingPages:[],alignmentVersion:version,...extra};}
 function progressiveFixture(states,onAlignment=()=>{},onStatus=()=>{}){
  const calls=[];let version=null,lastState=null;
  const transport=PDF.createTransport({setTimer:fn=>setTimeout(fn,0),clearTimer:clearTimeout,Zotero:{HTTP:{async request(method,url,options){
   calls.push({method,url,options});
   if(url.endsWith('/alignment.json')){const value=sentenceAlignment();value.pages[0].paragraphs[0].source.text=version;await onAlignment();return {status:200,responseText:JSON.stringify(value)};}
   if(method==='POST'){assert.equal(options.headers['Content-Type'],'application/json');assert.deepEqual(JSON.parse(options.body),{page:2,units:[]});assert.equal(lastState?.state,'running');return {status:200,responseText:JSON.stringify(lastState)};}
   await onStatus();assert(states.length,'unexpected extra status request');const state=states.shift();version=state.alignmentVersion;lastState=state;return {status:200,responseText:JSON.stringify(state)};
  }}}},async()=>({token:'t'.repeat(64)}));
  return {transport,calls};
 }
 await check('running checkpoints refresh only changed versions and await delivery before polling',async()=>{
  const delivered=[],events=[];let callbackPending=false;const f=progressiveFixture([upgradeState(versionA),upgradeState(versionA),upgradeState(versionB),upgradeState(versionB,{state:'complete',completedPages:[2]})],()=>events.push('fetch'),()=>assert.equal(callbackPending,false,'polling must wait for the checkpoint consumer'));
  const result=await f.transport.upgradeAlignment('mapping',input,[2],[2],()=>{},{probe:true,onPartial:async value=>{callbackPending=true;events.push('begin');await new Promise(resolve=>setTimeout(resolve,20));delivered.push(value.pages[0].paragraphs[0].source.text);events.push('end');callbackPending=false;}});
  assert.deepEqual(delivered,[versionA,versionB]);assert.deepEqual(events,['fetch','begin','end','fetch','begin','end']);
  assert.equal(result.pages[0].paragraphs[0].source.text,versionB);assert.equal(f.calls.filter(x=>x.url.endsWith('/alignment.json')).length,2);assert.equal(f.calls.filter(x=>x.method==='POST').length,1);assert(!f.calls.some(x=>x.options.headers['Content-Type']==='application/pdf'));
 });
 await check('a failed upgrade delivers its last saved checkpoint before exposing the retryable error',async()=>{
  const delivered=[],f=progressiveFixture([upgradeState(versionA),upgradeState(versionB,{state:'failed',error:'alignment_timeout'})]);
  await assert.rejects(f.transport.upgradeAlignment('mapping',input,[2],[2],()=>{},{probe:true,onPartial:async value=>delivered.push(value.pages[0].paragraphs[0].source.text)}),{code:'alignment_timeout'});
  assert.deepEqual(delivered,[versionA,versionB]);assert.equal(f.calls.filter(x=>x.url.endsWith('/alignment.json')).length,2);
 });
 await check('cancellation during checkpoint fetch prevents callbacks and preserves the permanent job',async()=>{
  let cancel,delivered=0;const f=progressiveFixture([upgradeState(versionA)],()=>cancel());
  await assert.rejects(f.transport.upgradeAlignment('mapping',input,[2],[2],value=>{cancel=value;},{probe:true,onPartial:async()=>{delivered++;}}),{code:'stopped'});
  assert.equal(delivered,0);assert(!f.calls.some(x=>x.method==='DELETE'));
 });
 await check('a status from a different job cannot deliver that job checkpoint',async()=>{
  const delivered=[],f=progressiveFixture([upgradeState(versionA),upgradeState(versionB,{id:'different_job'})]);
  await assert.rejects(f.transport.upgradeAlignment('mapping',input,[2],[2],()=>{},{probe:true,onPartial:async value=>delivered.push(value.pages[0].paragraphs[0].source.text)}),{code:'response'});
  assert.deepEqual(delivered,[versionA]);assert.equal(f.calls.filter(x=>x.url.endsWith('/alignment.json')).length,1);
 });
 await check('checkpoint versions and oversized status responses are rejected before refresh',async()=>{
  for(const bad of ['',null,7,{},'A'.repeat(64),'g'.repeat(64),'a'.repeat(63),'a'.repeat(65)]){
   const f=progressiveFixture([upgradeState(bad)]);let delivered=0;
   await assert.rejects(f.transport.upgradeAlignment('mapping',input,[2],[2],()=>{},{probe:true,onPartial:async()=>{delivered++;}}),{code:'response'});
   assert.equal(delivered,0);assert.equal(f.calls.length,1);
  }
  const f=progressiveFixture([upgradeState(versionA,{unsafe:'x'.repeat(65536)})]);
  await assert.rejects(f.transport.upgradeAlignment('mapping',input,[2],[2],()=>{},{probe:true,onPartial:async()=>assert.fail('oversized checkpoint delivered')}),{code:'response'});assert.equal(f.calls.length,1);
 });
 await check('a complete cached page fetches its alignment once without a partial callback',async()=>{
  let delivered=0;const f=progressiveFixture([upgradeState(versionA,{state:'idle',completedPages:[2]})]);
  const result=await f.transport.upgradeAlignment('mapping',input,[2],[2],()=>{},{probe:true,onPartial:async()=>{delivered++;}});
  assert.equal(result.pages[0].paragraphs[0].source.text,versionA);assert.equal(delivered,0);assert.deepEqual(f.calls.map(x=>x.method),['GET','GET']);
 });
 await check('precise mapping diagnostic reasons stay bounded and preparation failures stay retryable',async()=>{
  for(const mappingDetail of ['no_phrases','unowned_glyph','native_glyph','partial_phrase'])assert.equal(PDF.diagnostic('nativeSelection',{mappingDetail}).mappingDetail,mappingDetail);
  assert.equal(PDF.diagnostic('nativeSelection',{mappingDetail:'private selected text'}).mappingDetail,undefined);
  for(const [code,text] of [['alignment_timeout','词语对应准备超时，可重试'],['alignment_invalid','词语对应校验失败，可重试'],['alignment_unavailable','词语对应尚未就绪，可重试']]){assert.equal(PDF.errorMessage({code}),text);assert.equal(PDF.diagnostic('sentence',{code}).code,code);}
 });
 process.stdout.write(JSON.stringify({status:'PASS',checks})+'\n');
})().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
