(function(root){
  'use strict';
  const documents=new WeakMap(),MAX_PAGES=2000,MAX_ITEMS=100000,MAX_CHARACTERS=300000;
  const finite=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=10000000;
  const clone=value=>JSON.parse(JSON.stringify(value));
  function abort(){const error=new Error('Figure indexing was cancelled');error.name='AbortError';error.code='cancelled';return error;}
  function unavailable(){const error=new Error('The PDF text layer could not be indexed');error.code='figure_text_unavailable';return error;}
  const clean=text=>text.normalize('NFKC').replace(/[\u00ad\u200b-\u200d\ufeff]/gu,'').replace(/\s+/gu,' ').trim();
  function pageGeometry(page){
    try{const value=page?.view;if(!Array.isArray(value))return {};const box=clone(value);if(box.length===4&&box.every(finite)&&box[2]>box[0]&&box[3]>box[1])return {pageLeft:box[0],pageTop:box[3],pageHeight:box[3]-box[1]};}catch(_){}
    return {};
  }
  function linesFromContent(content){
    const items=content?.items;if(!Array.isArray(items)||items.length>MAX_ITEMS)throw unavailable();
    // Only the returned text array is normalized. No content-realm array is
    // mutated or supplied to a native PDF.js function.
    const local=clone(items),fragments=[];let characters=0;
    for(const item of local){
      if(typeof item?.str!=='string'||!item.str.trim())continue;
      characters+=item.str.length;if(characters>MAX_CHARACTERS)throw unavailable();
      const t=item.transform;if(!Array.isArray(t)||t.length!==6||!t.every(finite)||item.dir==='ttb'||Math.abs(t[1])>Math.abs(t[0])*.15)continue;
      const height=finite(item.height)&&item.height>0?item.height:Math.hypot(t[2],t[3]),width=item.width;
      if(!finite(height)||height<=0||!finite(width)||width<0)continue;
      fragments.push({text:item.str,x:t[4],y:t[5],right:t[4]+width,height,eol:item.hasEOL===true});
    }
    const rows=[];
    for(const fragment of fragments.sort((a,b)=>b.y-a.y||a.x-b.x)){
      let row=rows.at(-1);
      if(!row||Math.abs(row.y-fragment.y)>Math.max(row.height,fragment.height)*.35){row={y:fragment.y,height:fragment.height,items:[]};rows.push(row);}
      row.items.push(fragment);row.height=Math.max(row.height,fragment.height);
    }
    const lines=[];
    for(const row of rows){
      let line=null,previous=null;
      for(const item of row.items.sort((a,b)=>a.x-b.x)){
        const gap=previous?item.x-previous.right:0;
        // PDF.js can place a sidebar and caption on nearly the same baseline.
        // Its explicit text-flow ending plus a real gap is a narrower gutter
        // than two unrelated fragments without that structural evidence.
        const height=Math.max(previous?.height||row.height,item.height);
        if(!line||gap>Math.max(row.height,item.height)*2.5||previous?.eol&&gap>height*.5){line={text:'',x:item.x,y:item.y,right:item.right,height:item.height};lines.push(line);previous=null;}
        if(previous&&gap>Math.max(previous.height,item.height)*.12&&!/\s$/.test(line.text)&&!/^\s/.test(item.text)&&!(/[\p{Script=Han}]$/u.test(line.text)&&/^[\p{Script=Han}]/u.test(item.text)))line.text+=' ';
        line.text+=item.text;line.right=Math.max(line.right,item.right);line.height=Math.max(line.height,item.height);previous=item;
      }
    }
    return lines.map(line=>({...line,text:clean(line.text)})).filter(line=>line.text).sort((a,b)=>b.y-a.y||a.x-b.x);
  }
  const header=/^(?:(Supplementary|Supplemental|Suppl\.?|Supp\.?|Extended\s+Data|补充|附)\s*)?(Figure|Fig\.?|Table|图|表)\s*([Ss]?\s*\d{1,4}[A-Za-z]?|[IVXLCDM]{1,6}|[一二三四五六七八九十百]{1,5})(?![\p{L}\p{N}])(.*)$/iu;
  const prefixOnly=/^(?:(?:Supplementary|Supplemental|Suppl\.?|Supp\.?|Extended\s+Data|补充|附)\s*)?(?:Figure|Fig\.?|Table|图|表)?$/iu;
  const reference=/^(?:shows?|showing|illustrates?|illustrating|is|are|was|were|provides?|presents?|summari[sz]es?|lists?|reports?|depicts?|contains?|demonstrates?|indicates?|compares?|describes?|can|could|has|have|and|or|with|in|as|of|see)\b/iu;
  const captionStart=text=>text.startsWith('◀')?{text:text.slice(1).trimStart(),previousPage:true}:{text,previousPage:false};
  const isPrefixOnly=text=>{const value=captionStart(text).text;return Boolean(value)&&prefixOnly.test(value);};
  function parseHeader(text){
    const start=captionStart(text);text=start.text;
    if(/^(?:Figures|Figs\.?|Tables)\b/iu.test(text)||/\.{3,}\s*\d+\s*$/u.test(text)||/…+\s*\d+\s*$/u.test(text))return null;
    const match=header.exec(text);if(!match)return null;
    const number=match[3].replace(/\s+/gu,''),prefix=match[1]||'',kind=/^(?:Table|表)$/iu.test(match[2])?'table':'figure',namespace=/^Extended/iu.test(prefix)?'extended-data':prefix||/^S\d/iu.test(number)?'supplementary':'main',remainder=match[4].trim(),strong=/^[.:：|｜—–-]/u.test(remainder),title=remainder.replace(/^[.:：|｜—–-]+\s*/u,'');
    if(!strong&&(/^[,，;；(/]/u.test(title)||reference.test(title)||/^(?:所示|显示|表明|展示|描绘|说明|中|所列|列出|给出|是|为|以及|和|与|见|参见|及)/u.test(title)))return null;
    return {kind,number,prefix,namespace,strong,title,key:kind+'-'+namespace+'-'+number.toLowerCase(),token:match[2],previousPage:start.previousPage};
  }
  function nextLine(lines,line){
    let best=null;
    for(const candidate of lines){
      const gap=line.y-candidate.y,height=Math.max(line.height,candidate.height);
      if(gap<=height*.35||gap>height*1.8||Math.abs(candidate.x-line.x)>height*1.5)continue;
      if(!best||candidate.y>best.y||candidate.y===best.y&&Math.abs(candidate.x-line.x)<Math.abs(best.x-line.x))best=candidate;
    }
    return best;
  }
  function pageEntries(content,pageIndex,geometry,previousGeometry={}){
    const lines=linesFromContent(content),entries=[];
    if(lines.some(line=>/^(?:list of (?:figures|tables)|contents|目录|[图表]目录)$/iu.test(line.text)))return entries;
    for(const first of lines){
      if(entries.length>=256)break;
      let text=first.text,last=first,parsed=parseHeader(text),used=1;
      while(used<3&&(!parsed&&isPrefixOnly(text)||parsed&&!parsed.title)){
        const next=nextLine(lines,last);if(!next)break;
        if(parsed&&parseHeader(next.text))break;
        text+=' '+next.text;last=next;used++;parsed=parseHeader(text);
      }
      if(!parsed||!parsed.title||!/[\p{L}\p{Script=Han}]{3}/u.test(parsed.title.replace(/\s/gu,'')))continue;
      if(!parsed.strong){
        if(!/^[A-Z\p{Script=Han}]/u.test(parsed.title))continue;
        const above=lines.some(line=>line!==first&&line.y>first.y&&line.y-first.y<=Math.max(line.height,first.height)*1.6&&Math.abs(line.x-first.x)<first.height*1.2);
        if(above)continue;
      }
      while(used<4&&text.length<600){
        const next=nextLine(lines,last);if(!next||parseHeader(next.text)||isPrefixOnly(next.text))break;
        text+=' '+next.text;last=next;used++;
      }
      const prefix=parsed.namespace==='extended-data'?'Extended Data ':parsed.prefix?/^[补附]/u.test(parsed.prefix)?parsed.prefix:'Supplementary ':'',token=/^[图表]$/u.test(parsed.token)?parsed.token:parsed.kind==='table'?'Table':'Fig.';
      // A publisher's explicit left triangle identifies the preceding page.
      // Use only that page's actual box, never an inferred image rectangle.
      const previous=parsed.previousPage&&pageIndex>0&&finite(previousGeometry.pageLeft)&&finite(previousGeometry.pageTop),position=previous?{pageIndex:pageIndex-1,top:previousGeometry.pageTop,left:previousGeometry.pageLeft,...previousGeometry}:{pageIndex,top:first.y,left:first.x,...geometry};
      entries.push({id:parsed.key,kind:parsed.kind,label:prefix+token+' '+parsed.number,...position,...(parsed.previousPage?{captionPageIndex:pageIndex}:{}),caption:captionStart(text).text.slice(0,600),score:parsed.strong?2:1});
    }
    return entries;
  }
  function collect(record){
    const byID=new Map();
    for(const entries of record.pages.values()){
      if(!Array.isArray(entries))continue;
      for(const entry of entries){const previous=byID.get(entry.id);if(!previous||entry.score>previous.score||entry.score===previous.score&&entry.pageIndex<previous.pageIndex)byID.set(entry.id,entry);}
    }
    return [...byID.values()].sort((a,b)=>a.pageIndex-b.pageIndex||b.top-a.top||a.left-b.left).map(({score,...entry})=>entry);
  }
  function create(pdfDocument,options={}){
    const total=pdfDocument?.numPages;
    if(!pdfDocument||!Number.isInteger(total)||total<1||total>MAX_PAGES||typeof pdfDocument.getPage!=='function')throw unavailable();
    let record=documents.get(pdfDocument);if(!record){record={pages:new Map(),geometries:new Map(),entries:null};documents.set(pdfDocument,record);}
    let cancelled=false,running=null;
    const active=()=>!cancelled&&(options.isCurrent?.()??true),guard=()=>{if(!active())throw abort();};
    const invoke=(target,name,...args)=>options.invoke?options.invoke(target,name,...args):Reflect.apply(target[name],target,args);
    const pause=options.yield||(()=>new Promise(resolve=>setTimeout(resolve,0))),batchSize=Number.isInteger(options.batchSize)?Math.max(1,Math.min(16,options.batchSize)):2;
    function readPage(index){
      if(record.pages.has(index))return record.pages.get(index);
      const pending=Promise.resolve().then(async()=>{
        try{const returned=await invoke(pdfDocument,'getPage',index+1),page=options.unwrapPage?options.unwrapPage(returned):returned,geometry=pageGeometry(page),content=await invoke(page,'getTextContent');record.geometries.set(index,geometry);const entries=pageEntries(content,index,geometry,record.geometries.get(index-1));record.pages.set(index,entries);return entries;}
        catch(_){if(record.pages.get(index)===pending)record.pages.delete(index);throw unavailable();}
      });
      record.pages.set(index,pending);return pending;
    }
    function publish(completed,done){guard();options.onBatch?.({entries:clone(record.entries||collect(record)),completed,total,done});}
    async function run(){
      guard();if(record.entries){publish(total,true);return clone(record.entries);}
      const cached=[...record.pages.values()].filter(Array.isArray).length;if(cached)publish(cached,false);
      for(let index=0;index<total;index++){
        guard();await readPage(index);guard();
        const completed=index+1;if(completed===total){record.entries=collect(record);publish(completed,true);}
        else if(completed%batchSize===0){publish(completed,false);await pause();guard();}
        else if(completed===1&&options.eagerFirstBatch)publish(completed,false);
      }
      guard();return clone(record.entries);
    }
    return {scan(){if(!running)running=run().catch(error=>{running=null;throw error;});return running;},cancel(){cancelled=true;}};
  }
  const api={create};root.AskGPTPDFFigureNavigation=api;if(typeof module!=='undefined')module.exports=api;
})(this);
