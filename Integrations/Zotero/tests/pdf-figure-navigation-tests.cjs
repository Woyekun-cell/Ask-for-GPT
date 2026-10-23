const assert=require('node:assert/strict'),vm=require('node:vm'),Figures=require('../content/pdf-figure-navigation.js');
let checks=0;
async function check(name,test){await test();checks++;process.stdout.write('PASS '+name+'\n');}
const tick=()=>new Promise(setImmediate);
function item(str,x=40,y=700,options={}){return {str,transform:[10,0,0,10,x,y],height:10,width:str.length*5,...options};}
function fixture(pages){
  const reads=[],texts=[],document={numPages:pages.length,async getPage(number){reads.push(number);return {async getTextContent(){texts.push(number);return {items:pages[number-1]};}};}};
  return {document,reads,texts};
}
async function entries(pages,options={}){const f=fixture(pages),result=await Figures.create(f.document,{yield:async()=>{},...options}).scan();return {f,result};}
(async()=>{
  await check('caption anchors use real source PDF coordinates and never rewrite the opened document',async()=>{
    const source=item('Fig. 1 | Human genome diversity.',52,612),{f,result}=await entries([[source,item('Table 1: Variant classes.',52,300)]]);
    assert.deepEqual(result.map(value=>({kind:value.kind,label:value.label,pageIndex:value.pageIndex,top:value.top,left:value.left})),[{kind:'figure',label:'Fig. 1',pageIndex:0,top:612,left:52},{kind:'table',label:'Table 1',pageIndex:0,top:300,left:52}]);assert.equal(result[0].caption,source.str);assert.deepEqual(Object.keys(result[0]),['id','kind','label','pageIndex','top','left','caption']);assert.deepEqual(f.reads,[1]);assert.deepEqual(f.texts,[1]);assert.equal(source.transform[5],612);
  });
  await check('ordinary inline and line-initial prose references do not become figure destinations',async()=>{
    const {result}=await entries([[item('The data are shown in Fig. 1 and Table 2.',40,740),item('Fig. 1 shows the human genotype distribution.',40,726),item('Figure 2 illustrates the same result.',40,712),item('Table 2 summarizes the variants.',40,698),item('Figs. 1 and 2 contain all experiments.',40,684),item('如图 3 所示，基因组含有结构变异。',40,670),item('图 4 显示了相同结果。',40,656),item('表 5 中列出了结果。',40,642),item('Fig. 1 | Genotype distribution.',40,400)]]);
    assert.equal(result.length,1);assert.equal(result[0].label,'Fig. 1');assert.equal(result[0].top,400);
  });
  await check('first-line captions and independent unpunctuated Chinese and English titles are recognized',async()=>{
    const {result}=await entries([[item('Table 1 Genomic variant classes.',40,760),item('图 2 人类泛基因组构建示意图',40,400),item('表3 样本分组及测序信息',40,180)]]);
    assert.deepEqual(result.map(value=>value.label),['Table 1','图 2','表 3']);
  });
  await check('same-baseline PDF fragments assemble a caption label without fabricating its anchor',async()=>{
    const {result}=await entries([[item('Fig.',41,650,{width:18}),item('1',64,650,{width:5}),item(' | ',72,650,{width:5}),item('Genome diversity',80,650,{width:100}),item('across populations.',41,638)]]);
    assert.equal(result.length,1);assert.equal(result[0].top,650);assert.equal(result[0].left,41);assert.match(result[0].caption,/Genome diversity across populations/);
  });
  await check('two-column captions are not joined to an adjacent column or an adjacent prose reference',async()=>{
    const {result}=await entries([[item('Fig. 1 | Left genome panel.',40,700,{width:190}),item('Figure 2 shows a prose reference.',340,700,{width:190}),item('Left caption continuation.',40,688,{width:190}),item('Prose continuing in the right column.',340,688,{width:190}),item('Unrelated body paragraph.',40,500,{width:190}),item('Table 2 | Right table title.',340,500,{width:190}),item('Right caption continuation.',340,488,{width:190})]]);
    assert.equal(result.length,2);assert.equal(result[0].left,40);assert(!result[0].caption.includes('right column'));assert.equal(result[1].left,340);assert(!result[1].caption.includes('Unrelated'));assert.match(result[1].caption,/Right caption continuation/);
  });
  await check('PDF text-flow endings separate a nearby sidebar from a caption at nearly the same baseline',async()=>{
    const {result}=await entries([[
      item('b',42.5196991,401.74020385,{height:6.5,width:4.212}),
      item('locks of DN',46.6666991,401.74020385,{height:6.5,width:32.448}),
      item('a',79.0496991,401.74020385,{height:6.5,width:4.3355}),
      item('that are greater',84.8801991,401.74020385,{height:6.5,width:44.0375,hasEOL:true}),
      item('Fig. 1 |',142.29919433,400.43560791,{height:8.5,width:21.105500085,hasEOL:false}),
      item('Overview of short-read sequencing technologies.',164.713694415,400.43560791,{height:8.5,width:177.52249949,hasEOL:false})
    ]]);assert.equal(result.length,1);assert.equal(result[0].label,'Fig. 1');assert.equal(result[0].left,142.29919433);assert.equal(result[0].top,400.43560791);assert(!result[0].caption.includes('greater'));
  });
  await check('flow-separated gutters work across caption wording, numbering and supplementary namespaces without promoting prose references',async()=>{
    for(const [title,label] of [['Table 27 | Metabolic response groups.','Table 27'],['Supplementary Fig. S12 | Ocean depth profiles.','Supplementary Fig. S12'],['Extended Data Fig. 8 | Cell state transitions.','Extended Data Fig. 8']]){
      const {result}=await entries([[item('A separate side note.',20,701,{width:80,height:10,hasEOL:true}),item(title,108,700,{width:250,height:10,hasEOL:true})]]);assert.equal(result.length,1);assert.equal(result[0].label,label);assert.equal(result[0].left,108);assert.equal(result[0].top,700);assert.equal(Object.hasOwn(result[0],'captionPageIndex'),false);
    }
    const {result}=await entries([[item('A separate side note.',20,701,{width:80,height:10,hasEOL:true}),item('Figure 7 shows a separate prose reference.',108,700,{width:250,height:10,hasEOL:true})]]);assert.deepEqual(result,[]);
  });
  await check('a text-flow ending alone does not detach a tightly spaced caption title or create a marker from a body arrow',async()=>{
    const {result}=await entries([[item('Fig. 9 |',40,700,{width:40,hasEOL:true}),item('Sequence assembly metrics.',82,700,{width:130,hasEOL:true}),item('A side note.',20,501,{width:80,hasEOL:true}),item('◀ See Fig. 9 for details.',108,500,{width:150,hasEOL:true})]]);
    assert.equal(result.length,1);assert.equal(result[0].label,'Fig. 9');assert.match(result[0].caption,/Sequence assembly metrics/);assert.equal(Object.hasOwn(result[0],'captionPageIndex'),false);
  });
  await check('wrapped labels, prefix lines and wrapped titles retain the first real caption baseline',async()=>{
    const {result}=await entries([[item('Fig.1',40,740),item('A map of structural variation.',40,728),item('in all sampled populations.',40,716),item('Supplementary',40,500),item('Fig. S1 | Genome assembly.',40,488),item('Pipeline description.',40,476)]]);
    assert.equal(result.length,2);assert.equal(result[0].top,740);assert.match(result[0].caption,/Fig.1 A map/);assert.equal(result[1].top,500);assert.equal(result[1].label,'Supplementary Fig. S1');
  });
  await check('the real Logsdon left-triangle caption glyph links only to the preceding physical page using its actual page box',async()=>{
    const captions=new Map([[4,2],[6,3],[12,5]]),reads=[],height=790.8660278320312;
    const document={numPages:14,async getPage(number){reads.push(number);return {view:[0,0,595.2760009765625,height],getTextContent:async()=>({items:captions.has(number-1)?[
      item('◀',34.605,height-68.148,{height:11,width:6.666,transform:[11,0,0,11,34.605,height-68.148]}),
      item('Fig.'+captions.get(number-1)+' | Long-read sequencing applications.',42.520,height-68.403,{height:8.5,width:250,transform:[8.5,0,0,8.5,42.520,height-68.403]})
    ]:[]})};}};
    const result=await Figures.create(document,{yield:async()=>{}}).scan();
    assert.deepEqual(result.map(entry=>({id:entry.id,pageIndex:entry.pageIndex,captionPageIndex:entry.captionPageIndex,top:entry.top,left:entry.left})),[
      {id:'figure-main-2',pageIndex:3,captionPageIndex:4,top:height,left:0},
      {id:'figure-main-3',pageIndex:5,captionPageIndex:6,top:height,left:0},
      {id:'figure-main-5',pageIndex:11,captionPageIndex:12,top:height,left:0}
    ]);assert.deepEqual(reads,Array.from({length:14},(_,index)=>index+1));assert(result.every(entry=>!entry.caption.startsWith('◀')&&entry.pageTop===height&&entry.pageHeight===height));
  });
  await check('a first-page triangle cannot navigate before page zero and unmarked captions retain their original location',async()=>{
    const pages=[[item('◀Fig. 1 | First-page genome overview.',40,650)],[item('Fig. 2 | Same-page genome overview.',50,500)]];
    const document={numPages:2,getPage:async number=>({view:[0,0,600,800],getTextContent:async()=>({items:pages[number-1]})})};
    const result=await Figures.create(document).scan();assert.equal(result[0].pageIndex,0);assert.equal(result[0].captionPageIndex,0);assert.equal(result[0].top,650);assert.equal(result[0].left,40);
    assert.equal(result[1].pageIndex,1);assert.equal(result[1].top,500);assert.equal(result[1].left,50);assert.equal(Object.hasOwn(result[1],'captionPageIndex'),false);
  });
  await check('previous-page markers require a real preceding page box and never invent its top or left',async()=>{
    for(const view of [undefined,[0,0,600,0],[-10,20,590,820]]){
      const document={numPages:2,getPage:async number=>({view:number===1?view:[0,0,600,800],getTextContent:async()=>({items:number===2?[item('◀Table 1 | Variant classes.',45,600)]:[]})})};
      const [entry]=await Figures.create(document).scan();assert.equal(entry.captionPageIndex,1);
      if(view?.[0]===-10){assert.equal(entry.pageIndex,0);assert.equal(entry.top,820);assert.equal(entry.left,-10);assert.equal(entry.pageTop,820);assert.equal(entry.pageLeft,-10);assert.equal(entry.pageHeight,800);}
      else{assert.equal(entry.pageIndex,1);assert.equal(entry.top,600);assert.equal(entry.left,45);}
    }
  });
  await check('body arrows, repeated triangles and isolated arrow lines do not become previous-page figure anchors',async()=>{
    const {result}=await entries([[],[item('◀Fig. 1 shows the genome diversity.',40,740),item('Text ◀Fig. 2 | A prose reference.',40,680),item('◀◀Fig. 3 | Repeated markers.',40,620),item('◀',40,560),item('Fig. 4 | An independent caption.',40,548),item('◀ See Table 5 for all values.',40,480)]]);
    assert.deepEqual(result.map(entry=>entry.label),['Fig. 4']);assert.equal(result[0].pageIndex,1);assert.equal(result[0].top,548);assert.equal(Object.hasOwn(result[0],'captionPageIndex'),false);
  });
  await check('explicit previous-page markers apply to generic figure, table and supplementary captions independently of their wording',async()=>{
    for(const [caption,label] of [['◀Figure 27: Ocean current measurements.','Fig. 27'],['◀Supplementary Fig. S12 | Cellular response map.','Supplementary Fig. S12'],['◀表 8：样本分组及采样信息','表 8']]){
      const document={numPages:2,getPage:async number=>({view:[-5,10,595,810],getTextContent:async()=>({items:number===2?[item(caption,50,650)]:[]})})};
      const [entry]=await Figures.create(document).scan();assert.equal(entry.label,label);assert.equal(entry.pageIndex,0);assert.equal(entry.captionPageIndex,1);assert.equal(entry.left,-5);assert.equal(entry.top,810);
    }
  });
  await check('an isolated label never borrows the following independent caption as its own title',async()=>{
    const {result}=await entries([[item('Fig. 1',40,700),item('Table 2 | Real variant classes.',40,688)]]);
    assert.deepEqual(result.map(value=>value.label),['Table 2']);assert.equal(result[0].top,688);
  });
  await check('main, supplementary and Extended Data numbering remain distinct while repeated captions and references are deduplicated',async()=>{
    const {result}=await entries([[item('Fig. 1 | Main overview.'),item('Supplementary Fig. S1 | Additional overview.',40,500),item('Extended Data Fig. 1 | Extended overview.',40,300)],[item('Fig. 1 shows a reference.'),item('Fig. 1 | Main overview continued.',40,500),item('Fig. S1 | Additional overview continued.',40,300),item('Supplementary Table S2: Additional variant classes.',40,100)]]);
    assert.deepEqual(result.map(value=>value.id),['figure-main-1','figure-supplementary-s1','figure-extended-data-1','table-supplementary-s2']);assert.equal(result[0].pageIndex,0);assert.equal(result[1].pageIndex,0);
  });
  await check('contents lists, dot leaders, bare labels without title and invalid positions produce an explicit empty index',async()=>{
    for(const page of [[item('Contents'),item('Fig. 1 | Genome overview ........ 12',40,500)],[item('Fig. 2 | Gene overview ........ 15')],[item('Figure 1')],[item('Fig. 1 | Gene overview',{bad:true},700)],[item('Fig. 1 | Gene overview',40,700,{transform:[10,0,0,10,NaN,700]})],[item('图1 | 基因组图谱',40,700,{dir:'ttb'})],[]]){const {result}=await entries([page]);assert.deepEqual(result,[]);}
  });
  await check('ambiguous prose-wrapped unpunctuated labels are excluded rather than guessed as titles',async()=>{
    const {result}=await entries([[item('The following comparison uses all genome samples.',40,712),item('Figure 1 The genotype distribution is described below.',40,700),item('Fig. 2 | A distinct figure caption.',40,400)]]);
    assert.deepEqual(result.map(value=>value.label),['Fig. 2']);
  });
  await check('document-instance caching avoids every repeated page extraction and returns independent result copies',async()=>{
    const f=fixture([[item('Fig. 1 | Genome overview.')],[item('Table 1 | Variant classes.')]]),first=await Figures.create(f.document,{yield:async()=>{}}).scan();first[0].caption='changed';const second=await Figures.create(f.document).scan();assert.equal(second[0].caption,'Fig. 1 | Genome overview.');assert.deepEqual(f.reads,[1,2]);assert.deepEqual(f.texts,[1,2]);const other=fixture([[item('Fig. 1 | Genome overview.')]]);await Figures.create(other.document).scan();assert.deepEqual(other.reads,[1]);
  });
  await check('batch callbacks expose copied local results and yield between batches without invoking any model or network',async()=>{
    const events=[],f=fixture([[item('Fig. 1 | First caption.')],[item('Fig. 2 | Second caption.')],[item('Fig. 3 | Third caption.')]]);let yields=0;
    const result=await Figures.create(f.document,{batchSize:2,yield:async()=>{yields++;assert.deepEqual(f.reads,[1,2]);},onBatch:value=>{events.push(value);if(!value.done)value.entries[0].caption='changed callback';}}).scan();
    assert.equal(yields,1);assert.deepEqual(events.map(value=>[value.completed,value.total,value.done]),[[2,3,false],[3,3,true]]);assert.equal(result[0].caption,'Fig. 1 | First caption.');assert.equal(result.length,3);
  });
  await check('cancellation after a batch stops later pages but preserves completed page cache for a new consumer',async()=>{
    const f=fixture([[item('Fig. 1 | First caption.')],[item('Fig. 2 | Second caption.')],[item('Fig. 3 | Third caption.')]]),events=[];let scanner;
    scanner=Figures.create(f.document,{batchSize:1,yield:async()=>{},onBatch:value=>{events.push(value);scanner.cancel();}});await assert.rejects(scanner.scan(),{name:'AbortError',code:'cancelled'});assert.deepEqual(f.reads,[1]);assert.equal(events.length,1);
    const result=await Figures.create(f.document,{yield:async()=>{}}).scan();assert.equal(result.length,3);assert.deepEqual(f.reads,[1,2,3]);
  });
  await check('stale guards reject before work and after awaited extraction without publishing obsolete results',async()=>{
    const f=fixture([[item('Fig. 1 | Genome overview.')]]);await assert.rejects(Figures.create(f.document,{isCurrent:()=>false}).scan(),{name:'AbortError'});assert.equal(f.reads.length,0);
    let release,current=true,published=0;const document={numPages:1,getPage:async()=>({getTextContent:()=>new Promise(resolve=>{release=()=>resolve({items:[item('Fig. 1 | Genome overview.')]});})})},scanner=Figures.create(document,{isCurrent:()=>current,onBatch:()=>published++}),pending=scanner.scan();await tick();current=false;release();await assert.rejects(pending,{name:'AbortError'});assert.equal(published,0);
  });
  await check('concurrent consumers share page promises while cancelling one leaves the other complete',async()=>{
    let release,reads=0,texts=0;const document={numPages:1,async getPage(){reads++;return {getTextContent(){texts++;return new Promise(resolve=>{release=()=>resolve({items:[item('Fig. 1 | Genome overview.')]});});}};}},a=Figures.create(document),b=Figures.create(document),first=a.scan(),second=b.scan();await tick();a.cancel();release();await assert.rejects(first,{name:'AbortError'});assert.equal((await second).length,1);assert.equal(reads,1);assert.equal(texts,1);
  });
  await check('a failed text page is retryable and is never stored as a completed empty result',async()=>{
    let calls=0;const document={numPages:1,getPage(){calls++;if(calls===1)throw Error('PRIVATE_DOCUMENT_TEXT');return Promise.resolve({getTextContent:async()=>({items:[item('Table 1 | Genome classes.')]})});}},scanner=Figures.create(document);
    await assert.rejects(scanner.scan(),error=>error.code==='figure_text_unavailable'&&!error.message.includes('PRIVATE_DOCUMENT_TEXT'));assert.equal((await scanner.scan()).length,1);assert.equal(calls,2);
    let attempts=0;const malformed={numPages:1,getPage:async()=>({getTextContent:async()=>++attempts===1?{items:null}:{items:[item('Fig. 1 | Genome overview.')]}})},retry=Figures.create(malformed);await assert.rejects(retry.scan(),{code:'figure_text_unavailable'});assert.equal((await retry.scan()).length,1);assert.equal(attempts,2);
  });
  await check('native calls receive only primitive page numbers and returned foreign arrays lose hidden prototype boundaries locally',async()=>{
    const foreign=values=>new Proxy(vm.runInNewContext(JSON.stringify(values)),{get(target,key,receiver){return ['map','filter','every','slice'].includes(key)?undefined:Reflect.get(target,key,receiver);}}),nativeItems=foreign([item('Fig. 1 | Genome overview.')]);nativeItems[0].transform=foreign(nativeItems[0].transform);
    const opaque={},page={getTextContent:async()=>({items:nativeItems})},document={numPages:1,getPage:async()=>opaque},seen=[];
    const result=await Figures.create(document,{unwrapPage:value=>{assert.equal(value,opaque);return page;},invoke(target,name,...args){seen.push(name);assert(args.every(value=>typeof value==='number'));if(name==='getPage')assert.deepEqual(args,[1]);else assert.equal(args.length,0);return Reflect.apply(target[name],target,args);}}).scan();assert.equal(result.length,1);assert.equal(Object.getPrototypeOf(result),Array.prototype);assert.equal(result[0].top,700);assert.deepEqual(seen,['getPage','getTextContent']);
  });
  await check('valid native page boxes add optional navigation context while missing, inaccessible or invalid boxes never invent geometry',async()=>{
    const foreign=new Proxy(vm.runInNewContext('[-10,20,590,820]'),{get(target,key,receiver){return ['map','every','slice'].includes(key)?undefined:Reflect.get(target,key,receiver);}});
    for(const view of [[-10,20,590,820],foreign,undefined,[0,0,600,0],[0,0,NaN,800],[0,0,600,Infinity],[0,0,600]]){const page={view,getTextContent:async()=>({items:[item('Fig. 1 | Genome overview.',40,650)]})},document={numPages:1,getPage:async()=>page},[entry]=await Figures.create(document).scan();assert.equal(entry.top,650);assert.equal(entry.left,40);if(view===foreign||view?.length===4&&view[0]===-10){assert.equal(entry.pageTop,820);assert.equal(entry.pageHeight,800);}else{assert.equal(Object.hasOwn(entry,'pageTop'),false);assert.equal(Object.hasOwn(entry,'pageHeight'),false);}}
    const page={get view(){throw Error('PRIVATE_PAGE_PATH');},getTextContent:async()=>({items:[item('Table 1 | Variant classes.')]})},[entry]=await Figures.create({numPages:1,getPage:async()=>page}).scan();assert.equal(Object.hasOwn(entry,'pageTop'),false);assert.equal(entry.top,700);
  });
  await check('first captions publish before a slow second page and partial cache publishes synchronously on reopen',async()=>{
    let release;const seen=[],document={numPages:2,async getPage(number){return {getTextContent:async()=>{if(number===2)await new Promise(resolve=>release=resolve);return {items:[item('Fig. '+number+' | Genome overview.')]};}};}};
    const scanner=Figures.create(document,{eagerFirstBatch:true,onBatch:value=>seen.push(value)}),pending=scanner.scan();await tick();assert.equal(seen.length,1);assert.equal(seen[0].entries[0].label,'Fig. 1');
    const reopened=[];const next=Figures.create(document,{onBatch:value=>reopened.push(value)}).scan();assert.equal(reopened[0].entries[0].label,'Fig. 1');release();await Promise.all([pending,next]);assert.equal(seen.at(-1).done,true);
  });
  console.log(checks+' local PDF figure navigation tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
