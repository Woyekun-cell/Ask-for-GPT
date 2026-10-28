(function(root){
  'use strict';
  const Layout=root.AskGPTPDFLayout||(typeof require==='function'?require('./pdf-layout.js'):null);
  const PaneGestures=root.AskGPTPDFPaneGestures||(typeof require==='function'?require('./pdf-pane-gestures.js'):null);
  const ScrollSync=root.AskGPTPDFScrollSync||(typeof require==='function'?require('./pdf-scroll-sync.js'):null);
  const ReadingTools=root.AskGPTPDFReadingTools||(typeof require==='function'?(()=>{try{return require('./pdf-reading-tools.js');}catch(_){return null;}})():null);
  const Hover=root.AskGPTPDFHoverGloss||(typeof require==='function'?require('./pdf-hover-gloss.js'):null);
  const SelectionLink=root.AskGPTPDFSelectionLink||(typeof require==='function'?require('./pdf-selection-link.js'):null);
  const FigureNavigation=root.AskGPTPDFFigureNavigation||(typeof require==='function'?require('./pdf-figure-navigation.js'):null);
  const FigurePanel=root.AskGPTPDFFigurePanel||(typeof require==='function'?require('./pdf-figure-panel.js'):null);
  const XHTML='http://www.w3.org/1999/xhtml',ORIGINAL_SUFFIX='__askgptOriginal';
  let controlsSequence=0,alignmentPageSequence=0;
  const copy=value=>value==null?value:JSON.parse(JSON.stringify(value));
  function failure(){const error=new Error('PDF annotation alignment is unavailable');error.code='compatibility';return error;}
  const finite=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=10000000;
  function mappingFailure(){const error=failure();error.code='annotation_mapping';return error;}
  function sentenceFailure(detail,numbers){const error=failure();error.code='annotation_sentence';error.mappingDetail=detail;error.mappingNumbers=numbers;return error;}
  const rect=value=>Array.isArray(value)&&value.length===4&&value.every(finite)&&value[2]>value[0]&&value[3]>value[1];
  const matrix=value=>Array.isArray(value)&&value.length===6&&value.every(finite)&&Math.abs(value[0]*value[3]-value[1]*value[2])>1e-8;
  const geometry=value=>value&&rect(value.mediaBox)&&rect(value.cropBox)&&[0,90,180,270].includes(value.rotation);
  const unchangedGlyphs=(source,target)=>source.text===target.text&&source.rects.length===target.rects.length&&source.rects.every((r,i)=>r.every((n,j)=>Math.abs(n-target.rects[i][j])<=.01+1e-9));

  const glyphText=text=>text.normalize('NFKC').replace(/[\s\u00ad\u200b-\u200d\ufeff]/gu,'').replace(/\u2010/g,'-');
  const meaningful=glyph=>glyph&&glyphText(glyph.text).length>0;
  const glyphKey=glyph=>glyphText(glyph.text)+'|'+(glyph.rect?glyph.rect.map(n=>Math.round(n*10000)).join(','):'space');
  const centerIn=(r,box,tolerance=.05)=>(r[0]+r[2])/2>=box[0]-tolerance&&(r[0]+r[2])/2<=box[2]+tolerance&&(r[1]+r[3])/2>=box[1]-tolerance&&(r[1]+r[3])/2<=box[3]+tolerance;
  function paragraphOwnsGlyphs(paragraph,side,glyphs){
    const part=paragraph?.[side],selected=glyphs.filter(meaningful);
    // Paragraph IR uses line metrics, not full font bboxes. Prove text and
    // glyph-center ownership without enlarging the paragraph's geometry.
    return selected.length>0&&typeof part?.text==='string'&&Array.isArray(part.rects)&&selected.every(g=>rect(g.rect)&&part.rects.some(r=>centerIn(g.rect,r)))&&glyphText(part.text).includes(glyphText(glyphs.map(g=>g.text).join('')));
  }
  function validatePhraseData(sentence,page,fail){
    if(Array.isArray(sentence.phrases)&&!sentence.phrases.length&&sentence.source.glyphs===undefined&&sentence.target.glyphs===undefined)return;
    const pools={},positions={};
    for(const side of ['source','target']){
      const part=sentence[side],glyphs=part.glyphs;
      if(!Array.isArray(glyphs)||glyphs.length>100000||glyphs.some(g=>!g||typeof g.text!=='string'||!g.text.length||g.text.length>256||!(g.line==null||Number.isInteger(g.line)&&g.line>=0)||!(g.rect===null?!meaningful(g):rect(g.rect))))return fail();
      if(glyphText(glyphs.map(g=>g.text).join(''))!==glyphText(part.text))return fail();
      const map=new Map();for(const g of glyphs){if(!meaningful(g))continue;const key=glyphKey(g);if(map.has(key))return fail();map.set(key,g);}pools[side]=map;positions[side]=new Map([...map.keys()].map((key,index)=>[key,index]));
    }
    if(!Array.isArray(sentence.phrases)||sentence.phrases.length>10000)return fail();
    const ids=new Set(),claimed={source:new Set(),target:new Set()};
    for(const phrase of sentence.phrases){
      if(!phrase||typeof phrase.id!=='string'||!phrase.id||phrase.id.length>320||ids.has(phrase.id)||!['semantic-phrase-model','glyph-identity'].includes(phrase.method)||!['sourceTokenCount','targetTokenCount'].every(key=>Number.isInteger(phrase[key])&&phrase[key]>0&&phrase[key]<=10000))return fail();ids.add(phrase.id);
      for(const side of ['source','target']){
        const part=phrase[side],glyphs=part?.glyphs;
        if(!part||typeof part.text!=='string'||!Array.isArray(part.rects)||!part.rects.length||!part.rects.every(rect)||!Array.isArray(glyphs)||!glyphs.length||glyphs.length>100000||glyphText(part.text)!==glyphText(glyphs.map(g=>g?.text||'').join('')))return fail();
        const keys=new Set();for(const glyph of glyphs){if(!glyph||typeof glyph.text!=='string'||!(glyph.line==null||Number.isInteger(glyph.line)&&glyph.line>=0)||!(glyph.rect===null?!meaningful(glyph):rect(glyph.rect)))return fail();if(!meaningful(glyph))continue;const key=glyphKey(glyph);if(!pools[side].has(key)||keys.has(key)||claimed[side].has(key))return fail();keys.add(key);claimed[side].add(key);if(!part.rects.some(r=>centerIn(glyph.rect,r,.01)))return fail();}
        if(!keys.size)return fail();
        // Kerning can put the next punctuation glyph's center inside a
        // word's genuine font bbox. Prove ownership from contiguous glyph IDs
        // and reconstruct its actual runs instead of forbidding such overlap.
        const indices=glyphs.filter(meaningful).map(g=>positions[side].get(glyphKey(g)));
        if(indices.some((index,i)=>index!==indices[0]+i))return fail();
        const runs=[];for(const glyph of glyphs){if(!glyph.rect)continue;const previous=runs.at(-1);if(previous&&previous.line===glyph.line){const r=previous.rect;r[0]=Math.min(r[0],glyph.rect[0]);r[1]=Math.min(r[1],glyph.rect[1]);r[2]=Math.max(r[2],glyph.rect[2]);r[3]=Math.max(r[3],glyph.rect[3]);}else runs.push({line:glyph.line,rect:glyph.rect.slice()});}
        if(runs.length!==part.rects.length||runs.some((run,i)=>run.rect.some((n,j)=>Math.abs(n-part.rects[i][j])>.02+1e-9)))return fail();
        const dual=phrase[side==='source'?'dualSource':'dualTarget'];if(!dual||!Array.isArray(dual.rects)||dual.rects.length!==part.rects.length||!dual.rects.every(rect))return fail();
        const matrix=side==='source'?page.sourceToDual:page.targetToDual;if(!part.rects.every((r,i)=>transformRect(matrix,r).every((n,j)=>Math.abs(n-dual.rects[i][j])<=.02+1e-9)))return fail();
      }
      if(phrase.method==='glyph-identity'&&!unchangedGlyphs(phrase.source,phrase.target))return fail();
    }
  }
  function validateAlignment(value,sourcePages,cache=null){
    if(value?.schema!==1||value.coordinateSpace!=='pdf'||!['paragraph','sentence'].includes(value.granularity)||!Array.isArray(value.pages)||!value.pages.length||value.pages.length>2000||!Array.isArray(sourcePages)||value.pages.length!==sourcePages.length)throw failure();
    const candidate=value.provenance==='pdf-glyph-candidates';
    if(value.provenance!==undefined&&value.provenance!=='babeldoc-ir'&&!candidate||candidate&&(value.recoveryRevision!=='pdf-glyph-candidates-v1'||![value.sourceSHA256,value.targetSHA256].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)))||!candidate&&value.recoveryRevision!==undefined)throw failure();
    const semantic=value.sentenceAlignmentRevision==='pdf-sentence-semantic-v1',sentencePages=value.sentencePages??[];
    if(value.sentenceAlignmentRevision!==undefined&&!semantic)throw failure();
    if(!Array.isArray(sentencePages)||sentencePages.length>sourcePages.length||new Set(sentencePages).size!==sentencePages.length||sentencePages.some(page=>!Number.isInteger(page)||!sourcePages.includes(page))||(!semantic&&(sentencePages.length||value.granularity==='sentence')))throw failure();
    const partialPages=value.sentencePartialPages??[];
    if(!Array.isArray(partialPages)||partialPages.length>sourcePages.length||new Set(partialPages).size!==partialPages.length||partialPages.some(page=>!Number.isInteger(page)||!sourcePages.includes(page)||sentencePages.includes(page))||!semantic&&partialPages.length)throw failure();
    const presentPages=[...sentencePages,...partialPages];
    if(value.phraseExtractedPages!==undefined&&(!Array.isArray(value.phraseExtractedPages)||value.phraseExtractedPages.some(page=>!sentencePages.includes(page))))throw failure();
    const precise=value.phraseAlignmentRevision==='pdf-phrase-semantic-v1',phrasePages=value.phrasePages??[];
    if(value.phraseAlignmentRevision!==undefined&&!precise||!Array.isArray(phrasePages)||new Set(phrasePages).size!==phrasePages.length||phrasePages.some(page=>!presentPages.includes(page))||!precise&&phrasePages.length)throw failure();
    let paragraphs=0,sentences=0,characters=0,rectangles=0;
    function validateParts(row){for(const key of ['source','target','dualSource','dualTarget']){
      const part=row[key];if(!part||!Array.isArray(part.rects)||!part.rects.length||part.rects.length>5000||!part.rects.every(rect))throw failure();rectangles+=part.rects.length;if(rectangles>500000)throw failure();
      if(key==='source'||key==='target'){if(typeof part.text!=='string')throw failure();characters+=part.text.length;if(characters>10000000)throw failure();}
    }}
    const seen=new Set(),next=new Map(),validatedPages=[];
    for(let index=0;index<value.pages.length;index++){
      const page=value.pages[index];
      if(!Number.isInteger(page?.sourcePage)||page.sourcePage<0||page.sourcePage>1999||page.sourcePage!==sourcePages[index]||page.outputPage!==index||seen.has(page.sourcePage)||![page.source,page.mono,page.dual].every(geometry)||!matrix(page.sourceToDual)||!matrix(page.targetToDual)||!Array.isArray(page.paragraphs))throw failure();
      if(page.candidateTextUnavailable!==undefined&&(!candidate||page.candidateTextUnavailable!==true||page.paragraphs.length))throw failure();
      seen.add(page.sourcePage);const hasSentences=page.paragraphs.some(p=>p?.sentences!==undefined),hasPhrases=hasSentences&&page.paragraphs.some(p=>Array.isArray(p?.sentences)&&p.sentences.some(s=>s?.phrases!==undefined)),context=[value.sourceSHA256,value.targetSHA256,value.provenance,value.recoveryRevision,hasSentences&&semantic,hasPhrases&&precise,presentPages.includes(page.sourcePage),phrasePages.includes(page.sourcePage)].join('|'),serialized=cache?JSON.stringify(page,function(key,part){if(typeof part==='number'&&!Number.isFinite(part)||['function','symbol','bigint'].includes(typeof part)||typeof this[key]?.toJSON==='function')throw failure();return part;}):null,cached=cache?.get(page.sourcePage);
      if(cached&&cached.context===context&&cached.serialized===serialized){paragraphs+=cached.counts[0];sentences+=cached.counts[1];characters+=cached.counts[2];rectangles+=cached.counts[3];if(paragraphs>50000||sentences>200000||characters>10000000||rectangles>500000)throw failure();next.set(page.sourcePage,cached);validatedPages.push(cached.value);continue;}
      const before=[paragraphs,sentences,characters,rectangles];paragraphs+=page.paragraphs.length;if(paragraphs>50000)throw failure();
      const ids=new Set();
      for(const paragraph of page.paragraphs){
        if(typeof paragraph?.id!=='string'||!paragraph.id||paragraph.id.length>160||ids.has(paragraph.id))throw failure();ids.add(paragraph.id);
        validateParts(paragraph);
        if(paragraph.sentences!==undefined){if(!semantic||!presentPages.includes(page.sourcePage)||!Array.isArray(paragraph.sentences)||paragraph.sentences.length>1000)throw failure();sentences+=paragraph.sentences.length;if(sentences>200000)throw failure();const sentenceIDs=new Set();for(const sentence of paragraph.sentences){if(typeof sentence?.id!=='string'||!sentence.id||sentence.id.length>256||sentenceIDs.has(sentence.id)||!['semantic-model','glyph-identity'].includes(sentence.method))throw failure();sentenceIDs.add(sentence.id);validateParts(sentence);if(sentence.method==='glyph-identity'&&!unchangedGlyphs(sentence.source,sentence.target))throw failure();if(sentence.phrases!==undefined){if(!precise||!phrasePages.includes(page.sourcePage))throw failure();validatePhraseData(sentence,page,()=>{throw failure();});}}}
      }
      const validated=serialized===null?copy(page):JSON.parse(serialized),layoutKey=cache?JSON.stringify([value.sourceSHA256,value.targetSHA256,value.provenance,value.recoveryRevision,{...validated,paragraphs:validated.paragraphs.map(({sentences,...row})=>row)}]):null;validatedPages.push(validated);next.set(page.sourcePage,{context,serialized,layoutKey,value:validated,stamp:++alignmentPageSequence,counts:[paragraphs-before[0],sentences-before[1],characters-before[2],rectangles-before[3]]});
    }
    const result={...copy({...value,pages:undefined}),pages:validatedPages};if(cache){cache.clear();for(const [key,entry] of next)cache.set(key,entry);}return result;
  }
  function invert(m){const determinant=m[0]*m[3]-m[1]*m[2];return [m[3]/determinant,-m[1]/determinant,-m[2]/determinant,m[0]/determinant,(m[2]*m[5]-m[3]*m[4])/determinant,(m[1]*m[4]-m[0]*m[5])/determinant];}
  function point(m,x,y){return [m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];}
  function transformRect(m,r){const corners=[point(m,r[0],r[1]),point(m,r[2],r[1]),point(m,r[0],r[3]),point(m,r[2],r[3])];return [Math.min(...corners.map(p=>p[0])),Math.min(...corners.map(p=>p[1])),Math.max(...corners.map(p=>p[0])),Math.max(...corners.map(p=>p[1]))];}
  function transformPosition(position,m){
    const result=copy(position);if(result.rects)result.rects=result.rects.map(r=>transformRect(m,r));
    if(result.paths)result.paths=result.paths.map(path=>{if(!Array.isArray(path)||path.length%2||!path.every(finite))throw failure();const output=[];for(let i=0;i<path.length;i+=2)output.push(...point(m,path[i],path[i+1]));return output;});
    if(finite(result.width))result.width*=Math.sqrt(Math.abs(m[0]*m[3]-m[1]*m[2]));
    if(finite(result.fontSize))result.fontSize*=Math.sqrt(Math.abs(m[0]*m[3]-m[1]*m[2]));
    if(finite(result.rotation))result.rotation=((result.rotation+Math.atan2(m[1],m[0])*180/Math.PI)%360+360)%360;
    return result;
  }
  const intersects=(a,b)=>Math.min(a[2],b[2])-Math.max(a[0],b[0])>0.05&&Math.min(a[3],b[3])-Math.max(a[1],b[1])>0.05;
  function coveredByRects(selected,values){
    // Native selections use inline font bounds; sidecars use selectable glyph
    // bounds. Allow only a fixed one-PDF-point edge tolerance, never a ratio of
    // sentence lengths. Test the complete 2D union, including gaps within a line.
    const tolerance=1,epsilon=1e-7,covers=values.map(r=>[r[0]-tolerance,r[1]-tolerance,r[2]+tolerance,r[3]+tolerance]).filter(r=>intersects(selected,r));
    if(!covers.length)return false;
    const cuts=[selected[1],selected[3],...covers.flatMap(r=>[Math.max(selected[1],r[1]),Math.min(selected[3],r[3])])].sort((a,b)=>a-b);
    for(let i=1;i<cuts.length;i++){
      if(cuts[i]-cuts[i-1]<=epsilon)continue;
      const y=(cuts[i-1]+cuts[i])/2,intervals=covers.filter(r=>r[1]<=y&&r[3]>=y).map(r=>[r[0],r[2]]).sort((a,b)=>a[0]-b[0]);let right=selected[0];
      for(const interval of intervals){if(interval[0]>right+epsilon)break;right=Math.max(right,interval[1]);if(right>=selected[2]-epsilon)break;}
      if(right<selected[2]-epsilon)return false;
    }
    return true;
  }
  const contains=(outer,inner,tolerance=1)=>inner[0]>=outer[0]-tolerance&&inner[1]>=outer[1]-tolerance&&inner[2]<=outer[2]+tolerance&&inner[3]<=outer[3]+tolerance;
  const identity=[1,0,0,1,0,0];
  function bounds(values){return [Math.min(...values.map(r=>r[0])),Math.min(...values.map(r=>r[1])),Math.max(...values.map(r=>r[2])),Math.max(...values.map(r=>r[3]))];}
  function paragraphMatrix(paragraph,from,to){const a=bounds(paragraph[from].rects),b=bounds(paragraph[to].rects),x=(b[2]-b[0])/(a[2]-a[0]),y=(b[3]-b[1])/(a[3]-a[1]);return [x,0,0,y,b[0]-a[0]*x,b[1]-a[1]*y];}
  function equalGeometry(a,b){return a.rotation===b.rotation&&['cropBox','mediaBox'].every(key=>a[key].every((v,i)=>Math.abs(v-b[key][i])<0.05));}
  function canonicalID(id){return typeof id==='string'&&id.endsWith(ORIGINAL_SUFFIX)?id.slice(0,-ORIGINAL_SUFFIX.length):id;}
  const equalRects=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((r,i)=>rect(r)&&rect(b[i])&&r.every((n,j)=>Math.abs(n-b[i][j])<=.02));
  function sourceBinding(position){return {pageIndex:position.pageIndex,rects:copy(position.rects),...(position.nextPageRects?{nextPageRects:copy(position.nextPageRects)}:{})};}
  function equalBinding(a,b){return a&&b&&a.pageIndex===b.pageIndex&&equalRects(a.rects,b.rects)&&(!a.nextPageRects&&!b.nextPageRects||equalRects(a.nextPageRects,b.nextPageRects));}
  // Synchronous, realm-independent SHA-256: annotation mapping must return
  // immediately to Zotero's native callback, where WebCrypto is asynchronous.
  function sha256(text){
    const bytes=[];for(const c of text){let n=c.codePointAt(0);if(n>=0xd800&&n<=0xdfff)n=0xfffd;if(n<128)bytes.push(n);else if(n<2048)bytes.push(192|(n>>6),128|(n&63));else if(n<65536)bytes.push(224|(n>>12),128|((n>>6)&63),128|(n&63));else bytes.push(240|(n>>18),128|((n>>12)&63),128|((n>>6)&63),128|(n&63));}
    const bits=bytes.length*8;bytes.push(128);while(bytes.length%64!==56)bytes.push(0);const high=Math.floor(bits/4294967296),low=bits>>>0;for(const n of [high,low])bytes.push((n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255);
    const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2],w=new Uint32Array(64),r=(n,b)=>(n>>>b)|(n<<(32-b));
    for(let offset=0;offset<bytes.length;offset+=64){for(let i=0;i<16;i++)w[i]=(bytes[offset+4*i]<<24)|(bytes[offset+4*i+1]<<16)|(bytes[offset+4*i+2]<<8)|bytes[offset+4*i+3];for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];w[i]=(w[i-16]+(r(a,7)^r(a,18)^(a>>>3))+w[i-7]+(r(b,17)^r(b,19)^(b>>>10)))>>>0;}let [a,b,c,d,e,f,g,j]=h;for(let i=0;i<64;i++){const t=(j+(r(e,6)^r(e,11)^r(e,25))+((e&f)^((~e)&g))+k[i]+w[i])>>>0,u=((r(a,2)^r(a,13)^r(a,22))+((a&b)^(a&c)^(b&c)))>>>0;j=g;g=f;f=e;e=(d+t)>>>0;d=c;c=b;b=a;a=(t+u)>>>0;}for(const [i,n] of [a,b,c,d,e,f,g,j].entries())h[i]=(h[i]+n)>>>0;}
    return h.map(n=>n.toString(16).padStart(8,'0')).join('');
  }
  const signature=value=>sha256(JSON.stringify(value));
  const mappingSignature=mapped=>signature({rects:mapped.rects,text:mapped.text,identity:!!mapped.identity});
  const glyphSignature=mapped=>signature((mapped.selectedGlyphs||[]).map(g=>[glyphKey(g),g.text]));
  function createMapper(alignment,mode,sourceView,targetView,selectionLinks=()=>[],options={}){
    const pages=alignment.pages,bySource=new Map(pages.map(page=>[page.sourcePage,page]));
    const candidate=alignment.provenance==='pdf-glyph-candidates',physical=candidate&&mode==='mono'?createGeometryMapper(pages.map(page=>page.sourcePage),sourceView,targetView,options):null;
    const sentences=page=>page.paragraphs.flatMap(paragraph=>paragraph.sentences||[]);
    const nativeGlyphRect=value=>{if(!Array.isArray(value)||value.length!==4)return null;const local=[value[0],value[1],value[2],value[3]];return rect(local)?local:null;};
    // PDF.js publishes whole page-data arrays; copy their cross-compartment fields once.
    const nativeSnapshots=new Map();
    function nativeChars(native,index){
      const physical=native===sourceView?index:pages[index]?.sourcePage,key=(native===sourceView?'source:':'target:')+physical,chars=native?._pdfPages?.[index]?.chars;
      if(!chars?.length){nativeSnapshots.delete(key);return chars;}if(!Array.isArray(chars)||chars.length>200000)return chars;
      const cached=nativeSnapshots.get(key);if(cached?.native===native&&cached.chars===chars&&cached.length===chars.length){nativeSnapshots.delete(key);nativeSnapshots.set(key,cached);return cached.values;}
      const values=[];for(let i=0;i<chars.length;i++){const char=chars[i],r=nativeGlyphRect(char.rect);values.push({c:char.c,rect:r,index:i});}
      nativeSnapshots.delete(key);nativeSnapshots.set(key,{native,chars,length:chars.length,physical,values});while(nativeSnapshots.size>4)nativeSnapshots.delete(nativeSnapshots.keys().next().value);return values;
    }
    function invalidateNativePages(physicalPages){for(const [key,entry] of nativeSnapshots)if(!physicalPages||physicalPages.includes(entry.physical))nativeSnapshots.delete(key);}
    const spatial=page=>{if(!equalGeometry(page.source,page.mono))throw failure();};
    function spatialMapping(page,position,type,from,to){
      if(candidate)throw mappingFailure();
      const positionBounds=position.rects?.length?position.rects:position.paths?.flatMap(path=>path.length>=2?[[Math.min(...path.filter((_,i)=>i%2===0)),Math.min(...path.filter((_,i)=>i%2===1)),Math.max(...path.filter((_,i)=>i%2===0))+0.001,Math.max(...path.filter((_,i)=>i%2===1))+0.001]]:[])||[];
      const matched=page.paragraphs.filter(paragraph=>positionBounds.some(r=>paragraph[from].rects.some(p=>intersects(r,p))));
      if(!matched.length)return position;
      if(!['note','text'].includes(type)||matched.length!==1||!position.rects?.length)throw mappingFailure();
      // A note/text box is anchored to the paragraph. Preserve its physical
      // dimensions instead of distorting handwriting or guessing word offsets.
      const first=position.rects[0],anchor=[(first[0]+first[2])/2,(first[1]+first[3])/2],mapped=point(paragraphMatrix(matched[0],from,to),...anchor);
      return transformPosition(position,[1,0,0,1,mapped[0]-anchor[0],mapped[1]-anchor[1]]);
    }
    function lane(page,position){
      if(mode!=='dual')return 'target';
      const boxes=position.rects?.length?position.rects:position.paths?.flatMap(path=>path.length>=2?[[Math.min(...path.filter((_,i)=>i%2===0)),Math.min(...path.filter((_,i)=>i%2===1)),Math.max(...path.filter((_,i)=>i%2===0))+0.001,Math.max(...path.filter((_,i)=>i%2===1))+0.001]]:[])||[];
      const sourceBox=transformRect(page.sourceToDual,page.source.cropBox),targetBox=transformRect(page.targetToDual,page.mono.cropBox);
      if(boxes.length&&boxes.every(r=>contains(sourceBox,r)))return 'source';
      if(boxes.length&&boxes.every(r=>contains(targetBox,r)))return 'target';
      throw failure();
    }
    function sortIndex(position){
      const page=bySource.get(position.pageIndex),topRect=position.rects?.slice().sort((a,b)=>b[3]-a[3])[0];
      let offset=0,best=Infinity;
      const chars=nativeChars(sourceView,position.pageIndex)||[];
      if(topRect)for(let index=0;index<chars.length;index++){const r=chars[index].rect;if(!Array.isArray(r))continue;const distance=Math.max(r[0]-topRect[2],topRect[0]-r[2],0)**2+Math.max(r[1]-topRect[3],topRect[1]-r[3],0)**2;if(distance<best){best=distance;offset=index;}}
      const top=topRect&&page?Math.max(0,page.source.mediaBox[3]-page.source.mediaBox[1]-topRect[3]):0;
      return [String(position.pageIndex).padStart(5,'0'),String(offset).padStart(6,'0'),String(Math.floor(top)).padStart(5,'0')].join('|');
    }
    function singleLatinWord(part,count){
      const lexical=/^[\p{Script=Latin}\p{M}\p{N}]+(?:[-'’][\p{Script=Latin}\p{M}\p{N}]+)*$/u,text=part?.text?.trim();if(!text||!/\p{Script=Latin}/u.test(text))return false;
      if(count===1&&lexical.test(text))return true;
      if(!Array.isArray(part.glyphs)||!part.glyphs.length)return false;
      const sequence=part.glyphs.flatMap(g=>Array.from(g.text.normalize('NFKC')).filter(c=>!/^\s$/u.test(c)).map(text=>({text,glyph:g}))),letters=Array.from(text.normalize('NFKC'));let cursor=0,proof='',wrapped=false;
      const wrap=(before,after)=>before&&after&&/^[-\u00ad]$/u.test(before.text)&&rect(before.glyph.rect)&&Number.isInteger(before.glyph.line)&&rect(after.glyph.rect)&&Number.isInteger(after.glyph.line)&&before.glyph.line!==after.glyph.line&&/^\p{Script=Latin}$/u.test(after.text);
      for(const letter of letters){if(/^\s$/u.test(letter)){if(!wrap(sequence[cursor-1],sequence[cursor]))return false;wrapped=true;continue;}const actual=sequence[cursor];if(!actual||actual.text!==letter)return false;proof+=letter==='\u00ad'?'-':letter;if(wrap(actual,sequence[cursor+1]))wrapped=true;cursor++;}
      return cursor===sequence.length&&wrapped&&lexical.test(proof);
    }
    function directText(page,position,from,interactive=false){
      const independent=selectionLinks(page.sourcePage)||[],to=from==='source'?'target':'source';if(!independent.length)return null;const links=[...independent,...sentences(page).flatMap(row=>row.phrases||[])];
      const candidates=links.filter(link=>link[from]?.rects?.some(r=>position.rects.some(s=>intersects(r,s))));if(!candidates.length)return null;
      const pool=[...new Map(candidates.flatMap(link=>link[from].glyphs.filter(meaningful)).map(g=>[glyphKey(g),g])).values()].sort((a,b)=>(a.line??0)-(b.line??0)||b.rect[3]-a.rect[3]||a.rect[0]-b.rect[0]),selected=new Map();
      const active=typeof targetView==='function'?targetView():targetView,native=from==='source'?sourceView:active,chars=nativeChars(native,from==='source'?page.sourcePage:page.outputPage);
      if(chars?.length){for(let i=0;i<chars.length;i++){const char=chars[i],local=nativeGlyphRect(char.rect),r=from==='target'&&mode==='dual'&&local?transformRect(invert(page.targetToDual),local):local;if(typeof char.c!=='string'||!glyphText(char.c)||!r||!position.rects.some(s=>centerIn(r,s)))continue;const matches=pool.filter(g=>position.rects.some(s=>centerIn(r,s)&&centerIn(g.rect,s))&&glyphText(g.text)===glyphText(char.c)&&Math.abs((g.rect[0]+g.rect[2]-r[0]-r[2])/2)<=1&&intersects(g.rect,r));if(matches.length!==1)return null;selected.set(glyphKey(matches[0]),matches[0]);}}
      else for(const glyph of pool)if(position.rects.some(r=>centerIn(glyph.rect,r)))selected.set(glyphKey(glyph),glyph);
      if(!selected.size)return null;
      const atomic=link=>link.sourceTokenCount<=16&&link.targetTokenCount<=16&&(singleLatinWord(link.source,link.sourceTokenCount)||singleLatinWord(link.target,link.targetTokenCount));
      const eligible=candidates.filter(link=>{const keys=link[from].glyphs.filter(meaningful).map(glyphKey),lexical=atomic(link)&&(!interactive||link[from].glyphs.some(g=>selected.has(glyphKey(g))&&/\p{Script=Han}/u.test(g.text))&&link[from].glyphs.filter(g=>/\p{Script=Latin}/u.test(g.text)).every(g=>selected.has(glyphKey(g))));return keys.some(key=>selected.has(key))&&(keys.every(key=>selected.has(key))||lexical);});
      if(!eligible.length)return null;
      const exact=eligible.filter(link=>{const keys=link[from].glyphs.filter(meaningful).map(glyphKey);return keys.length===selected.size&&keys.every(key=>selected.has(key));});
      let chosen=exact.length?exact:eligible;
      const unique=new Map();for(const link of chosen){const binding=JSON.stringify([link[from].glyphs.filter(meaningful).map(glyphKey),link[to].glyphs.filter(meaningful).map(glyphKey)]);if(!unique.has(binding))unique.set(binding,link);}chosen=[...unique.values()];
      const ownership=new Map(chosen.map(link=>[link,{from:new Set(link[from].glyphs.filter(meaningful).map(glyphKey)),to:new Set(link[to].glyphs.filter(meaningful).map(glyphKey))}]));
      chosen=chosen.filter(child=>!chosen.some(parent=>{if(parent===child)return false;const a=ownership.get(parent),b=ownership.get(child);return a.from.size>b.from.size&&[...a.from].every(key=>selected.has(key))&&[...b.from].every(key=>a.from.has(key))&&[...b.to].every(key=>a.to.has(key));}));
      const owners=new Map();for(const link of chosen)for(const g of link[from].glyphs.filter(meaningful)){const key=glyphKey(g);if(!selected.has(key))continue;if(owners.has(key))throw sentenceFailure('unowned_glyph',{outputPage:page.outputPage,sourcePage:page.sourcePage,selectionRects:position.rects.length,matchedSentences:0,uncoveredRects:1});owners.set(key,link);}
      if([...selected.keys()].some(key=>!owners.has(key))||position.rects.some(r=>!coveredByRects(r,chosen.flatMap(link=>link[from].rects))))return null;
      const ordered=chosen.sort((a,b)=>a[to].glyphs.find(meaningful).line-b[to].glyphs.find(meaningful).line||b[to].rects[0][3]-a[to].rects[0][3]||a[to].rects[0][0]-b[to].rects[0][0]);
      return {rects:ordered.flatMap(link=>copy(link[to].rects)),text:ordered.map(link=>link[to].text).join(' '),partial:chosen.some(link=>!link[from].glyphs.filter(meaningful).every(g=>selected.has(glyphKey(g)))),selectedGlyphs:copy(pool.filter(g=>selected.has(glyphKey(g))))};
    }
    function wholeSelection(page,position,from,text){
      if(typeof text!=='string'||!glyphText(text))return null;
      if(!sentences(page).length&&(candidate||!page.paragraphs.some(p=>glyphText(p[from].text)===glyphText(text))))return null;
      const active=typeof targetView==='function'?targetView():targetView,native=from==='source'?sourceView:active,index=from==='source'?page.sourcePage:page.outputPage,chars=nativeChars(native,index);
      if(!chars?.length)return null;
      const collect=(values,side)=>{const result=[];for(const char of values){const local=nativeGlyphRect(char.rect),r=side==='target'&&mode==='dual'&&local?transformRect(invert(page.targetToDual),local):local;if(typeof char.c==='string'&&r)result.push({text:char.c,rect:r});}return result;};
      const inside=(values,rects)=>values.filter(g=>rects.some(r=>centerIn(g.rect,r))),nativeGlyphs=collect(chars,from),glyphs=inside(nativeGlyphs,position.rects),selected=new Set(glyphs.filter(meaningful).map(glyphKey));
      if(!selected.size||glyphText(glyphs.map(g=>g.text).join(''))!==glyphText(text))return null;
      const owners=page.paragraphs.filter(p=>paragraphOwnsGlyphs(p,from,glyphs));
      if(owners.length!==1||page.paragraphs.some(p=>p!==owners[0]&&glyphs.filter(meaningful).some(g=>p[from].rects.some(r=>centerIn(g.rect,r)))))return null;
      const parent=owners[0],to=from==='source'?'target':'source',candidates=[...(parent.sentences||[]),...(!candidate?[parent]:[])],matched=candidates.filter(row=>glyphText(row[from].text)===glyphText(text)&&position.rects.every(r=>coveredByRects(r,row[from].rects)));
      if(matched.length&&new Set(matched.map(row=>JSON.stringify([row[to].text,row[to].rects]))).size!==1){
        // IR rectangles and font glyph bounds may describe the same complete
        // text. Collapse candidates only after both native footprints agree.
        const other=from==='source'?active:sourceView,otherIndex=from==='source'?page.outputPage:page.sourcePage,otherChars=nativeChars(other,otherIndex);if(!otherChars?.length)return null;
        const otherGlyphs=collect(otherChars,to),signatures=[];
        for(const row of matched){
          const input=inside(nativeGlyphs,row[from].rects),output=inside(otherGlyphs,row[to].rects),inputKeys=input.filter(meaningful).map(glyphKey),outputKeys=output.filter(meaningful).map(glyphKey);
          if(glyphText(input.map(g=>g.text).join(''))!==glyphText(row[from].text)||glyphText(output.map(g=>g.text).join(''))!==glyphText(row[to].text)||inputKeys.length!==selected.size||inputKeys.some(key=>!selected.has(key)))return null;
          signatures.push(JSON.stringify([glyphText(row[from].text),glyphText(row[to].text),inputKeys,outputKeys]));
        }
        if(new Set(signatures).size!==1)return null;
      }
      // Only complete verified sentences may compose a longer local selection.
      // A partial boundary never borrows the rest of its containing sentence.
      const chosen=matched.length?[matched[0]]:(parent.sentences||[]).filter(row=>['semantic-model','glyph-identity'].includes(row.method)&&glyphs.filter(meaningful).some(g=>row[from].rects.some(r=>centerIn(g.rect,r))));
      if(!chosen.length||glyphText(chosen.map(row=>row[from].text).join('')).length!==glyphText(text).length||position.rects.some(r=>!coveredByRects(r,chosen.flatMap(row=>row[from].rects))))return null;
      const claimed=new Set();for(const row of chosen){const actual=inside(nativeGlyphs,row[from].rects);if(glyphText(actual.map(g=>g.text).join(''))!==glyphText(row[from].text))return null;for(const g of actual.filter(meaningful)){const key=glyphKey(g);if(!selected.has(key)||claimed.has(key))return null;claimed.add(key);}}
      if(claimed.size!==selected.size)return null;
      const contiguous=(values,keys)=>{const ordered=values.filter(meaningful).map(glyphKey),indices=ordered.map((key,i)=>keys.has(key)?i:-1).filter(i=>i>=0);return indices.length===keys.size&&ordered.slice(indices[0],indices.at(-1)+1).every(key=>keys.has(key));};
      if(!contiguous(inside(nativeGlyphs,parent[from].rects),selected))return null;
      const peer=from==='source'?active:sourceView,peerIndex=from==='source'?page.outputPage:page.sourcePage,peerChars=nativeChars(peer,peerIndex);if(!peerChars?.length)return null;
      const peerNative=collect(peerChars,to),peerClaimed=new Set(),rank=new Map(peerNative.filter(meaningful).map((g,i)=>[glyphKey(g),i]));
      for(const row of chosen){const actual=inside(peerNative,row[to].rects);if(glyphText(actual.map(g=>g.text).join(''))!==glyphText(row[to].text))return null;for(const g of actual.filter(meaningful)){const key=glyphKey(g);if(peerClaimed.has(key))return null;peerClaimed.add(key);}}
      const peerGlyphs=inside(peerNative,chosen.flatMap(row=>row[to].rects));
      if(!paragraphOwnsGlyphs(parent,to,peerGlyphs)||!contiguous(inside(peerNative,parent[to].rects),peerClaimed)||page.paragraphs.some(p=>p!==parent&&peerGlyphs.filter(meaningful).some(g=>p[to].rects.some(r=>centerIn(g.rect,r)))))return null;
      chosen.sort((a,b)=>Math.min(...inside(peerNative,a[to].rects).filter(meaningful).map(g=>rank.get(glyphKey(g))))-Math.min(...inside(peerNative,b[to].rects).filter(meaningful).map(g=>rank.get(glyphKey(g)))));
      if(glyphText(chosen.map(row=>row[to].text).join(''))!==glyphText(peerGlyphs.map(g=>g.text).join('')))return null;
      return {rects:chosen.flatMap(row=>copy(row[to].rects)),text:chosen.map(row=>row[to].text).join('\n'),partial:false,whole:true,selectedGlyphs:glyphs};
    }
    function exactText(page,position,from,knownOnly=false,selection=null){
      const whole=selection?wholeSelection(page,position,from,selection.text):null;if(whole)return whole;
      const direct=directText(page,position,from,Boolean(selection));if(direct)return direct;
      // Projection of an existing original mark can show its proven words
      // while missing correspondence is prepared. Saving a new target mark
      // always uses the strict, whole-selection path.
      knownOnly=knownOnly&&from==='source';
      const rows=sentences(page),matched=rows.filter(row=>position.rects.some(r=>row[from].rects.some(p=>intersects(r,p))));
      const reject=(detail='coverage',count=1)=>{throw sentenceFailure(detail,{outputPage:page.outputPage,sourcePage:page.sourcePage,selectionRects:position.rects.length,matchedSentences:matched.length,uncoveredRects:count});};
      if(!matched.length)reject('unmatched',position.rects.length);
      const identityRows=matched.filter(row=>row.method==='glyph-identity');
      if(identityRows.length&&position.rects.every(r=>coveredByRects(r,identityRows.flatMap(row=>row[from].rects))))return {identity:true,rects:copy(position.rects),text:null};
      const uncovered=position.rects.filter(r=>!coveredByRects(r,matched.flatMap(row=>row[from].rects))).length;if(uncovered&&!knownOnly)reject('coverage',uncovered);
      const pool=matched.flatMap(row=>(row[from].glyphs||[]).filter(meaningful)),selected=new Map(),units=matched.flatMap(row=>row.phrases||[]);
      if(!pool.length||!units.length)reject('no_phrases');
      const lookup=new Map();for(const glyph of pool){const key=glyphKey(glyph);if(lookup.has(key))reject('native_glyph');lookup.set(key,glyph);}
      const active=typeof targetView==='function'?targetView():targetView,native=from==='source'?sourceView:active,chars=nativeChars(native,from==='source'?page.sourcePage:page.outputPage);
      if(chars&&chars.length){
        for(let i=0;i<chars.length;i++){
          const char=chars[i],localRect=nativeGlyphRect(char.rect),nativeRect=from==='target'&&mode==='dual'&&localRect?transformRect(invert(page.targetToDual),localRect):localRect;
          if(typeof char.c!=='string'||!glyphText(char.c)||!rect(nativeRect)||!position.rects.some(r=>centerIn(nativeRect,r)))continue;
          const candidates=pool.filter(g=>position.rects.some(s=>centerIn(nativeRect,s)&&centerIn(g.rect,s))&&glyphText(g.text)===glyphText(char.c)&&Math.abs((g.rect[0]+g.rect[2]-nativeRect[0]-nativeRect[2])/2)<=1&&intersects(g.rect,nativeRect));
          if(candidates.length!==1){if(knownOnly)continue;reject('native_glyph');}selected.set(glyphKey(candidates[0]),candidates[0]);
        }
      }else {if(!knownOnly&&matched.some(row=>!row[from].glyphs?.length))reject('no_phrases');for(const glyph of pool)if(position.rects.some(r=>centerIn(glyph.rect,r)))selected.set(glyphKey(glyph),glyph);}
      if(!selected.size)reject('native_glyph');
      const owners=new Map();for(const unit of units)for(const glyph of unit[from].glyphs.filter(meaningful)){const key=glyphKey(glyph);if(owners.has(key))reject('unowned_glyph');owners.set(key,unit);}
      const chosen=new Set();for(const key of selected.keys()){const unit=owners.get(key);if(!unit){if(knownOnly)continue;reject('unowned_glyph');}chosen.add(unit);}
      const to=from==='source'?'target':'source';
      let partial=false;
      for(const unit of chosen){const all=unit[from].glyphs.filter(meaningful).every(g=>selected.has(glyphKey(g))),atomic=unit.sourceTokenCount<=16&&unit.targetTokenCount<=16&&(singleLatinWord(unit.source,unit.sourceTokenCount)||singleLatinWord(unit.target,unit.targetTokenCount))&&(!selection||unit[from].glyphs.some(g=>selected.has(glyphKey(g))&&/\p{Script=Han}/u.test(g.text))&&unit[from].glyphs.filter(g=>/\p{Script=Latin}/u.test(g.text)).every(g=>selected.has(glyphKey(g))));if(!all&&!atomic){if(knownOnly){chosen.delete(unit);continue;}reject('partial_phrase');}partial||=!all;}
      if(!chosen.size)reject('unowned_glyph');
      const ordered=[...chosen].sort((a,b)=>{const at=pool.findIndex(g=>glyphKey(g)===glyphKey(a[from].glyphs.find(meaningful))),bt=pool.findIndex(g=>glyphKey(g)===glyphKey(b[from].glyphs.find(meaningful)));return at-bt;});
      // Preserve original reading order even when the translated clauses reorder.
      const destinationPool=rows.flatMap(row=>row[to].glyphs||[]),rank=unit=>destinationPool.findIndex(g=>glyphKey(g)===glyphKey(unit[to].glyphs.find(meaningful)));ordered.sort((a,b)=>rank(a)-rank(b));
      let text='';for(let i=0;i<ordered.length;i++){const unit=ordered[i];if(i){const previous=ordered[i-1],end=destinationPool.findIndex(g=>glyphKey(g)===glyphKey(previous[to].glyphs.filter(meaningful).at(-1))),start=rank(unit),between=destinationPool.slice(end+1,start);text+=rows.find(row=>row.phrases?.includes(previous))!==rows.find(row=>row.phrases?.includes(unit))?'\n':start>end&&between.every(g=>!meaningful(g))?between.map(g=>g.text).join(''):' ';}text+=unit[to].text;}
      return {rects:ordered.flatMap(unit=>copy(unit[to].rects)),text,partial,selectedGlyphs:copy(pool.filter(glyph=>selected.has(glyphKey(glyph))))};
    }
    function mapPart(position,type,selection=null){
      const page=pages[position.pageIndex];if(!page)throw failure();
      const side=lane(page,position),m=mode==='dual'?invert(side==='source'?page.sourceToDual:page.targetToDual):identity;
      if(side==='source'){const mapped=transformPosition(position,m);mapped.pageIndex=page.sourcePage;return {position:mapped,text:null,translated:false};}
      if(['highlight','underline'].includes(type)){
        if(!Array.isArray(position.rects)||!position.rects.length||!position.rects.every(rect))throw failure();
        const mono=transformPosition(position,m),mapped=exactText(page,mono,'target',false,selection);
        return {position:{pageIndex:page.sourcePage,rects:mapped.rects},text:mapped.text,translated:!mapped.identity,
          selection:{sourcePage:page.sourcePage,rects:copy(mono.rects),mapped}};
      }
      if(candidate)throw mappingFailure();
      spatial(page);let mapped=transformPosition(position,m);mapped=spatialMapping(page,mapped,type,'target','source');mapped.pageIndex=page.sourcePage;return {position:mapped,text:null,translated:false};
    }
    function toSourceAnnotation(annotation,selection=null,evidence=null){
      annotation=copy(annotation);
      if(!annotation?.position||!Number.isInteger(annotation.position.pageIndex))throw failure();
      const result=copy(annotation);result.id=canonicalID(result.id);
      const first=mapPart({...annotation.position,nextPageRects:undefined},annotation.type,selection);result.position=first.position;
      delete result.position._askgptSelection;
      if(evidence){evidence.expanded=Boolean(first.selection?.mapped.partial);evidence.whole=Boolean(first.selection?.mapped.whole);}const selectedParts=[first.selection];
      let translated=first.translated,text=first.text;
      if(annotation.position.nextPageRects){
        const next=mapPart({pageIndex:annotation.position.pageIndex+1,rects:annotation.position.nextPageRects},annotation.type,selection?{}:null);if(evidence){evidence.expanded||=Boolean(next.selection?.mapped.partial);evidence.whole||=Boolean(next.selection?.mapped.whole);}
        selectedParts.push(next.selection);
        if(next.position.pageIndex!==first.position.pageIndex+1)throw failure();result.position.nextPageRects=next.position.rects;translated||=next.translated;if(next.text)text=[text,next.text].filter(Boolean).join('\n');
      }
      result.sortIndex=sortIndex(result.position);
      const page=bySource.get(result.position.pageIndex);result.pageLabel=sourceView?._getPageLabel?.(result.position.pageIndex,true)||String(page.sourcePage+1);
      if(translated){
        result.text=text||'';
        if(annotation.text){const excerpt='译文摘录：'+annotation.text;result.comment=annotation.comment?annotation.comment.includes(excerpt)?annotation.comment:annotation.comment+'\n\n'+excerpt:excerpt;}
        if(/^[a-f0-9]{64}$/.test(alignment.sourceSHA256||'')&&selectedParts.every(Boolean)&&selectedParts.some(part=>part.mapped.partial)){
          const selectedText=selectedParts.map(part=>(part.mapped.selectedGlyphs||[]).map(g=>g.text).join('')),rawText=typeof annotation.text==='string'?annotation.text:selectedText.join('\n');
          if(selectedParts.every(part=>!part.mapped.identity)&&glyphText(rawText)!==glyphText(selectedText.join('')))throw mappingFailure();
          const saved={version:2,sourceSHA256:alignment.sourceSHA256,canonicalSHA256:signature(sourceBinding(result.position)),text:rawText,parts:selectedParts.map(part=>({sourcePage:part.sourcePage,rects:part.rects,identity:!!part.mapped.identity,mappingSHA256:mappingSignature(part.mapped),glyphSHA256:glyphSignature(part.mapped)}))};
          // Custom evidence must never force a native annotation to split or
          // fail saving. Extreme native selections retain the complete-unit
          // mapping path; ordinary partial words fit far below this bound.
          if(JSON.stringify({...result.position,_askgptSelection:saved}).length<=65000)result.position._askgptSelection=saved;
        }
      }
      return result;
    }
    function restoreAuthoredSelection(annotation){
      const saved=annotation.position?._askgptSelection;
      const compact=saved?.version===2;
      if(!saved||![1,2].includes(saved.version)||!/^[a-f0-9]{64}$/.test(saved.sourceSHA256||'')||saved.sourceSHA256!==alignment.sourceSHA256
        ||(compact?saved.canonicalSHA256!==signature(sourceBinding(annotation.position)):!equalBinding(saved.canonical,annotation.position))||typeof saved.text!=='string'||saved.text.length>100000
        ||!Array.isArray(saved.parts)||saved.parts.length!==(annotation.position.nextPageRects?2:1))return null;
      const restored=[];let selectedText='';
      for(let i=0;i<saved.parts.length;i++){
        const part=saved.parts[i],page=bySource.get(annotation.position.pageIndex+i),canonical=i?annotation.position.nextPageRects:annotation.position.rects;
        if(!page||!part||part.sourcePage!==page.sourcePage||!Array.isArray(part.rects)||!part.rects.length||part.rects.length>5000||!part.rects.every(rect))return null;
        if(compact){if(!/^[a-f0-9]{64}$/.test(part.mappingSHA256||'')||!/^[a-f0-9]{64}$/.test(part.glyphSHA256||''))return null;}
        else if(!equalRects(part.sourceRects,canonical)||!Array.isArray(part.glyphKeys)||part.glyphKeys.length>100000||part.glyphKeys.some(key=>typeof key!=='string'||key.length>512)||typeof part.glyphText!=='string'||part.glyphText.length>100000)return null;
        let mapped;try{mapped=exactText(page,{pageIndex:page.outputPage,rects:part.rects},'target');}catch(_){return null;}
        if(!equalRects(mapped.rects,canonical)||!!mapped.identity!==part.identity)return null;
        const text=(mapped.selectedGlyphs||[]).map(g=>g.text).join('');
        if(compact){if(mappingSignature(mapped)!==part.mappingSHA256||glyphSignature(mapped)!==part.glyphSHA256)return null;}
        else {const keys=(mapped.selectedGlyphs||[]).map(glyphKey);if(mapped.text!==part.sourceText||keys.length!==part.glyphKeys.length||keys.some((key,index)=>key!==part.glyphKeys[index])||text!==part.glyphText)return null;}
        selectedText+=text;
        restored.push({pageIndex:page.outputPage,rects:part.rects.map(r=>mode==='dual'?transformRect(page.targetToDual,r):copy(r))});
      }
      if(saved.parts.every(part=>!part.identity)&&glyphText(saved.text)!==glyphText(selectedText))return null;
      if(restored.some((part,index)=>index&&part.pageIndex!==restored[0].pageIndex+index))return null;
      const position={...copy(annotation.position),pageIndex:restored[0].pageIndex,rects:restored[0].rects};delete position.nextPageRects;
      if(restored[1])position.nextPageRects=restored[1].rects;
      return {position,text:saved.text};
    }
    function hasExactSourceSelection(annotation){
      try{
        annotation=copy(annotation);const position=annotation?.position;
        if(!['highlight','underline'].includes(annotation?.type)||!Number.isInteger(position?.pageIndex))return false;
        const parts=[{pageIndex:position.pageIndex,rects:position.rects}];
        if(position.nextPageRects!==undefined)parts.push({pageIndex:position.pageIndex+1,rects:position.nextPageRects});
        for(const part of parts){const page=bySource.get(part.pageIndex);if(!page||!Array.isArray(part.rects)||!part.rects.length||!part.rects.every(rect))return false;exactText(page,part,'source');}
        return true;
      }catch(_){return false;}
    }
    function selectionUnits(annotation,side='source'){
      try{
        annotation=copy(annotation);const position=annotation?.position;
        if(!['source','target'].includes(side)||!['highlight','underline'].includes(annotation?.type)||!Number.isInteger(position?.pageIndex)||!Array.isArray(position.rects)||!position.rects.length||!position.rects.every(rect))return [];
        const page=side==='source'?bySource.get(position.pageIndex):pages[position.pageIndex];if(!page)return [];
        function candidates(rows,semantic){
          const matched=rows.filter(row=>(!semantic||['semantic-model','glyph-identity'].includes(row.method))&&Array.isArray(row[side]?.rects)&&row[side].rects.every(rect)&&position.rects.some(r=>row[side].rects.some(s=>intersects(r,s))));
          if(!matched.length||matched.length>8||matched.some(row=>typeof row.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(row.id)||rows.filter(other=>other.id===row.id).length!==1))return [];
          if(position.rects.some(r=>!coveredByRects(r,matched.flatMap(row=>row[side].rects))))return [];
          for(let i=0;i<matched.length;i++)for(let j=i+1;j<matched.length;j++)for(const a of matched[i][side].rects)for(const b of matched[j][side].rects){const overlap=[Math.max(a[0],b[0]),Math.max(a[1],b[1]),Math.min(a[2],b[2]),Math.min(a[3],b[3])];if(position.rects.some(r=>intersects(r,overlap)))return [];}
          return matched.map(row=>row.id);
        }
        // A verified partial page may already contain the selected sentence.
        // Otherwise a paragraph is only a work-priority hint. It never enters
        // the strict glyph correspondence or annotation-save path.
        if(alignment.sentenceAlignmentRevision==='pdf-sentence-semantic-v1'){
          const rows=sentences(page),touches=rows.some(row=>position.rects.some(r=>row[side]?.rects?.some(s=>intersects(r,s))));
          if(touches)return candidates(rows,true);
        }
        return candidates(page.paragraphs,false);
      }catch(_){return [];}
    }
    function selectionRequest(annotation,side='source'){
      try{
        annotation=copy(annotation);const position=annotation?.position;if(!['source','target'].includes(side)||!['highlight','underline'].includes(annotation?.type)||!Number.isInteger(position?.pageIndex)||position.nextPageRects!==undefined||!Array.isArray(position.rects)||!position.rects.length||position.rects.length>32||!position.rects.every(rect)||typeof annotation.text!=='string'||!glyphText(annotation.text)||[...annotation.text].length>2048)return null;
        const page=side==='source'?bySource.get(position.pageIndex):pages[position.pageIndex];if(!page)return null;
        const active=typeof targetView==='function'?targetView():targetView,native=side==='source'?sourceView:active,chars=nativeChars(native,side==='source'?page.sourcePage:page.outputPage);if(!chars?.length)return null;
        const glyphs=[];for(let i=0;i<chars.length;i++){const char=chars[i],local=nativeGlyphRect(char.rect),r=side==='target'&&mode==='dual'&&local?transformRect(invert(page.targetToDual),local):local;if(typeof char.c==='string'&&r&&position.rects.some(s=>centerIn(r,s)))glyphs.push({text:char.c,rect:r});}
        if(glyphText(glyphs.map(g=>g.text).join(''))!==glyphText(annotation.text)||position.rects.some(r=>!coveredByRects(r,glyphs.map(g=>g.rect))))return null;
        const matches=page.paragraphs.filter(p=>paragraphOwnsGlyphs(p,side,glyphs));if(matches.length!==1||!/^[A-Za-z0-9_-]{1,64}$/.test(matches[0].id)||page.paragraphs.some(p=>p!==matches[0]&&glyphs.filter(meaningful).some(g=>p[side].rects.some(r=>centerIn(g.rect,r)))))return null;
        return {page:page.sourcePage,paragraph:matches[0].id,side,rects:copy(position.rects),text:annotation.text};
      }catch(_){return null;}
    }
    function selectionParts(annotation,side){
      try{
        const position=annotation?.position;if(!['source','target'].includes(side)||!['highlight','underline'].includes(annotation?.type)||position?.nextPageRects!==undefined||!Array.isArray(position?.rects)||!position.rects.length||position.rects.length>32||!position.rects.every(rect)||typeof annotation.text!=='string')return null;
        const page=side==='source'?bySource.get(position.pageIndex):pages[position.pageIndex];if(!page||!page.paragraphs.some(p=>(p.sentences||[]).filter(row=>['semantic-model','glyph-identity'].includes(row.method)).length>=2))return null;
        const active=typeof targetView==='function'?targetView():targetView,native=side==='source'?sourceView:active,chars=nativeChars(native,side==='source'?page.sourcePage:page.outputPage);if(!chars?.length)return null;
        const mono=side==='target'&&mode==='dual'?position.rects.map(r=>transformRect(invert(page.targetToDual),r)):position.rects,all=[];
        for(const char of chars){const local=nativeGlyphRect(char.rect),r=side==='target'&&mode==='dual'&&local?transformRect(invert(page.targetToDual),local):local;if(typeof char.c==='string'&&glyphText(char.c)&&r)all.push({text:char.c,rect:r});}
        const selected=all.filter(g=>mono.some(r=>centerIn(g.rect,r)));if(!selected.length||glyphText(selected.map(g=>g.text).join(''))!==glyphText(annotation.text)||mono.some(r=>!coveredByRects(r,selected.map(g=>g.rect))))return null;
        const parents=page.paragraphs.filter(p=>paragraphOwnsGlyphs(p,side,selected));if(parents.length!==1||page.paragraphs.some(p=>p!==parents[0]&&selected.some(g=>p[side].rects.some(r=>centerIn(g.rect,r)))))return null;
        const parent=parents[0],rows=(parent.sentences||[]).filter(row=>['semantic-model','glyph-identity'].includes(row.method)&&selected.some(g=>row[side].rects.some(r=>centerIn(g.rect,r))));if(rows.length<2||rows.length>8)return null;
        const owner=new Map(),selectedKeys=new Set(selected.map(glyphKey));for(const row of rows){const actual=all.filter(g=>row[side].rects.some(r=>centerIn(g.rect,r)));if(glyphText(actual.map(g=>g.text).join(''))!==glyphText(row[side].text))return null;for(const g of actual){const key=glyphKey(g);if(!selectedKeys.has(key))continue;if(owner.has(key))return null;owner.set(key,row);}}
        if(owner.size!==selectedKeys.size)return null;
        const parts=[];for(const row of rows){const own=selected.filter(g=>owner.get(glyphKey(g))===row),keys=new Set(own.map(glyphKey)),rects=[];
          for(const r of mono){const picked=own.filter(g=>centerIn(g.rect,r));if(!picked.length)continue;const box=bounds(picked.map(g=>g.rect)),clipped=[Math.max(r[0],box[0]),Math.max(r[1],box[1]),Math.min(r[2],box[2]),Math.min(r[3],box[3])];if(!rect(clipped))return null;rects.push(clipped);}
          const actual=all.filter(g=>rects.some(r=>centerIn(g.rect,r)));if(actual.length!==keys.size||actual.some(g=>!keys.has(glyphKey(g))))return null;
          const value=copy(annotation);value.text=own.map(g=>g.text).join('');value.position={...copy(position),rects:rects.map(r=>side==='target'&&mode==='dual'?transformRect(page.targetToDual,r):r)};parts.push({value,rank:selected.findIndex(g=>keys.has(glyphKey(g)))});
        }
        return parts.sort((a,b)=>a.rank-b.rank).map(part=>part.value);
      }catch(_){return null;}
    }
    function selectionRequests(annotation,side='source'){
      const parts=selectionParts(annotation,side);if(parts){const queries=[];for(const part of parts){let mapped=null;try{mapped=selectionMapping(part,side,{fragments:false});}catch(_){}if(mapped)continue;const query=selectionRequest(part,side);if(!query){const fallback=selectionRequest(annotation,side);return fallback?[fallback]:[];}queries.push(query);}return queries;}
      const query=selectionRequest(annotation,side);return query?[query]:[];
    }
    function projectPart(position,type,side,evidence,selection=null){
      const page=bySource.get(position.pageIndex);if(!page)return null;
      if(side==='source'){const result={...transformPosition(position,page.sourceToDual),pageIndex:page.outputPage};delete result.nextPageRects;return result;}
      let result;
      if(['highlight','underline'].includes(type)){
        let mapped;try{mapped=exactText(page,position,'source',!selection,selection);}catch(_){return null;}if(evidence)evidence.mapped=mapped;
        result={...copy(position),pageIndex:page.outputPage,rects:mapped.rects.map(r=>mode==='dual'?transformRect(page.targetToDual,r):r)};delete result.nextPageRects;
      }else{
        try{spatial(page);const mapped=spatialMapping(page,position,type,'source','target');result={...transformPosition(mapped,mode==='dual'?page.targetToDual:identity),pageIndex:page.outputPage};delete result.nextPageRects;}catch(_){return null;}
      }
      return result;
    }
    function projectAnnotation(annotation,side='target',selection=null,evidence={}){
      annotation=copy(annotation);
      if(side==='target'&&['highlight','underline'].includes(annotation?.type)&&annotation.position?._askgptSelection!==undefined){
        const restored=restoreAuthoredSelection(annotation);if(!restored)return null;
        return {...copy(annotation),position:restored.position,text:restored.text,id:canonicalID(annotation.id)};
      }
      if(!annotation?.position)return null;const result=copy(annotation),position=projectPart(annotation.position,annotation.type,side,evidence,selection);if(!position)return null;
      result.position=position;result.id=canonicalID(result.id)+(side==='source'?ORIGINAL_SUFFIX:'');
      if(annotation.position.nextPageRects){const nextEvidence={};const next=projectPart({pageIndex:annotation.position.pageIndex+1,rects:annotation.position.nextPageRects},annotation.type,side,nextEvidence,selection?{}:null);if(selection&&next?.pageIndex!==position.pageIndex+1)return null;if(next?.pageIndex===position.pageIndex+1){position.nextPageRects=next.rects;if(selection)evidence.nextMapped=nextEvidence.mapped;}}
      if(side==='target'&&['highlight','underline'].includes(annotation.type)){
        const page=bySource.get(annotation.position.pageIndex),mapped=evidence.mapped||exactText(page,annotation.position,'source',!selection,selection);evidence.expanded=Boolean(mapped.partial||evidence.nextMapped?.partial);evidence.whole=Boolean(mapped.whole||evidence.nextMapped?.whole);if(!mapped.identity)result.text=[mapped.text,evidence.nextMapped?.text].filter(Boolean).join('\n');
      }
      return result;
    }
    function selectionMapping(annotation,side,options={}){
      const evidence={},selection=annotation.position?.nextPageRects||options.whole===false?{}:{text:annotation.text};let result=null,error=null;
      try{result=side==='source'?projectAnnotation(annotation,'target',selection,evidence):toSourceAnnotation(annotation,selection,evidence);}catch(value){error=value;}
      if(result)return {annotation:result,expanded:Boolean(evidence.expanded),whole:Boolean(evidence.whole)};
      const parts=options.fragments===false?null:selectionParts(annotation,side);if(parts){
        const mapped=[];for(const part of parts){let value;try{value=selectionMapping(part,side,{...options,fragments:false});}catch(_){value=null;}if(!value){if(error)throw error;return null;}mapped.push(value);}
        const index=mapped[0].annotation.position.pageIndex;if(mapped.some(value=>value.annotation.position.pageIndex!==index||value.annotation.position.nextPageRects)){if(error)throw error;return null;}
        const active=typeof targetView==='function'?targetView():targetView,peer=side==='source'?active:sourceView,chars=nativeChars(peer,index);if(!chars?.length){if(error)throw error;return null;}
        const native=[];for(const char of chars){const r=nativeGlyphRect(char.rect);if(typeof char.c==='string'&&glyphText(char.c)&&r)native.push({text:char.c,rect:r});}
        const claimed=new Set();for(const value of mapped){const actual=native.filter(g=>value.annotation.position.rects.some(r=>centerIn(g.rect,r)));if(!actual.length||glyphText(actual.map(g=>g.text).join(''))!==glyphText(value.annotation.text||'')){if(error)throw error;return null;}for(const g of actual){const key=glyphKey(g);if(claimed.has(key)){if(error)throw error;return null;}claimed.add(key);}value.rank=native.findIndex(g=>value.annotation.position.rects.some(r=>centerIn(g.rect,r)));}
        mapped.sort((a,b)=>a.rank-b.rank);const text=mapped.map(value=>value.annotation.text).join('\n'),actual=native.filter(g=>claimed.has(glyphKey(g)));if(glyphText(text)!==glyphText(actual.map(g=>g.text).join(''))){if(error)throw error;return null;}
        const annotation=copy(mapped[0].annotation);annotation.text=text;annotation.position.rects=mapped.flatMap(value=>copy(value.annotation.position.rects));delete annotation.position._askgptSelection;
        return {annotation,expanded:mapped.some(value=>value.expanded),whole:mapped.some(value=>value.whole),composite:true};
      }
      if(error)throw error;return null;
    }
    function projectAnnotations(annotations){return (annotations||[]).filter(annotation=>!annotation._hidden).flatMap(annotation=>[projectAnnotation(annotation),mode==='dual'?projectAnnotation(annotation,'source'):null].filter(Boolean));}
    function mapPoint(page,side,x,y,toSource){
      const key=mode==='dual'?(side==='source'?'dualSource':'dualTarget'):'target';
      if(side==='target'&&!candidate){
        const from=toSource?key:'source',to=toSource?'source':key;
        const paragraph=page.paragraphs.find(paragraph=>paragraph[from].rects.some(r=>x>=r[0]&&x<=r[2]&&y>=r[1]&&y<=r[3]));
        if(paragraph)return point(paragraphMatrix(paragraph,from,to),x,y);
      }
      if(mode==='dual')return point(toSource?invert(side==='source'?page.sourceToDual:page.targetToDual):side==='source'?page.sourceToDual:page.targetToDual,x,y);
      spatial(page);return [x,y];
    }
    function toSourceState(state,previous={}){
      if(physical)return physical.toSourceState(state,previous);
      const page=pages[state?.pageIndex];if(!page)throw failure();
      const x=finite(state.left)?state.left:page.mono.cropBox[0],y=finite(state.top)?state.top:page.mono.cropBox[3];
      let side='target';if(mode==='dual'){const sourceBox=transformRect(page.sourceToDual,page.source.cropBox);if(x<=sourceBox[2]&&x>=sourceBox[0])side='source';}
      const [left,top]=mapPoint(page,side,x,y,true);
      // Keep the source's zoom/mode. A wider bilingual page has another scale.
      return {...copy(previous),pageIndex:page.sourcePage,left,top};
    }
    function toOutputLocation(location){
      if(physical)return physical.toOutputLocation(location);
      if(!location)return location;const result=copy(location);
      if(result.annotationID)result.annotationID=canonicalID(result.annotationID);
      if(result.position){result.position=projectPart(result.position,'note','target');if(!result.position)return null;}
      else if(Number.isInteger(result.pageIndex)){const page=bySource.get(result.pageIndex);if(!page)return null;result.pageIndex=page.outputPage;}
      else if(Array.isArray(result.dest)&&Number.isInteger(result.dest[0])){const page=bySource.get(result.dest[0]);if(!page)return null;result.dest[0]=page.outputPage;}
      return result;
    }
    function toOutputState(state){if(physical)return physical.toOutputState(state);const page=bySource.get(state.pageIndex)||pages[0],x=finite(state.left)?state.left:page.source.cropBox[0],y=finite(state.top)?state.top:page.source.cropBox[3],[left,top]=mapPoint(page,'target',x,y,false);return {...copy(state),pageIndex:page.outputPage,left,top,scale:mode==='dual'?'page-width':state.scale};}
    // Scrolling follows physical page geometry continuously. Paragraph anchors
    // are for explicit semantic navigation, never for a moving viewport edge.
    function viewportState(state,toSource){
      if(physical)return toSource?physical.toSourceViewportState(state):physical.toOutputViewportState(state);
      const page=toSource?pages[state?.pageIndex]:bySource.get(state?.pageIndex);if(!page)return null;
      const box=toSource?(mode==='dual'?page.dual:page.mono).cropBox:page.source.cropBox,x=finite(state.left)?state.left:box[0],y=finite(state.top)?state.top:box[3];
      let coordinates;if(mode==='dual')coordinates=point(toSource?invert(page.targetToDual):page.targetToDual,x,y);else{spatial(page);coordinates=[x,y];}
      return {pageIndex:toSource?page.sourcePage:page.outputPage,left:coordinates[0],top:coordinates[1]};
    }
    const toSourceViewportState=state=>viewportState(state,true),toOutputViewportState=state=>viewportState(state,false);
    return {toSourceAnnotation,projectAnnotation,projectAnnotations,selectionMapping,hasExactSourceSelection,selectionUnits,selectionRequest,selectionRequests,invalidateNativePages,toSourceState,toSourceViewportState,toOutputViewportState,toOutputLocation,toOutputState,canonicalID,annotationSide:annotation=>lane(pages[annotation.position.pageIndex],annotation.position)};
  }
  function createGeometryMapper(sourcePages,sourceView,targetView,options={}){
    if(!Array.isArray(sourcePages)||!sourcePages.length||sourcePages.length>2000||sourcePages.some(page=>!Number.isInteger(page)||page<0||page>1999)||new Set(sourcePages).size!==sourcePages.length)throw failure();
    const pages=copy(sourcePages),indices=new Map(pages.map((page,index)=>[page,index]));
    const resolve=value=>typeof value==='function'?value():value,invoke=(object,name,...args)=>typeof object?.[name]==='function'?(options.invoke?options.invoke(object,name,...args):Reflect.apply(object[name],object,args)):undefined;
    function ready(candidate,index){
      try{
        const app=candidate?._iframeWindow?.PDFViewerApplication;if(!Number.isInteger(app?.pdfDocument?.numPages)||index<0||index>=app.pdfDocument.numPages)return null;
        if(candidate===resolve(targetView)&&app.pdfDocument.numPages!==pages.length)return null;
        const page=invoke(app.pdfViewer,'getPageView',index),raw=page?.pdfPage,pdf=raw&&(options.unwrapPage?options.unwrapPage(raw):raw),viewport=page?.viewport;
        if(!pdf||!viewport)return null;const box=copy(pdf.view||pdf._pageInfo?.view),viewBox=copy(viewport.viewBox),rotation=pdf.rotate??pdf._pageInfo?.rotate;
        if(!rect(box)||!rect(viewBox)||box.some((n,i)=>Math.abs(n-viewBox[i])>.05)||!finite(rotation)||rotation%90!==0||!finite(viewport.rotation)||viewport.rotation%90!==0||![viewport.width,viewport.height].every(n=>finite(n)&&n>0))return null;
        return viewport;
      }catch(_){return null;}
    }
    function mapped(state,toSource){
      const index=toSource?state?.pageIndex:indices.get(state?.pageIndex),physical=pages[index];if(!Number.isInteger(index)||!Number.isInteger(physical)||![state?.left,state?.top].every(finite))return null;
      const source=resolve(sourceView),target=resolve(targetView),from=ready(toSource?target:source,toSource?index:physical),to=ready(toSource?source:target,toSource?physical:index);if(!from||!to)return null;
      try{const value=copy(invoke(from,'convertToViewportPoint',state.left,state.top));if(!Array.isArray(value)||value.length!==2||!value.every(finite))return null;
        const point=copy(invoke(to,'convertToPdfPoint',value[0]/from.width*to.width,value[1]/from.height*to.height));if(!Array.isArray(point)||point.length!==2||!point.every(finite))return null;
        return {pageIndex:toSource?physical:index,left:point[0],top:point[1]};
      }catch(_){return null;}
    }
    const denied=()=>{throw mappingFailure();},none=()=>null,empty=()=>[];
    function pageState(state,toSource){const pageIndex=toSource?pages[state?.pageIndex]:indices.get(state?.pageIndex);if(!Number.isInteger(pageIndex))return null;return {...(mapped(state,toSource)||{pageIndex}),...(state?.scale!==undefined?{scale:copy(state.scale)}:{})};}
    function sourceState(state,previous={}){const pageIndex=pages[state?.pageIndex];if(!Number.isInteger(pageIndex))return null;const result={...copy(previous),pageIndex},point=mapped(state,true);if(point)Object.assign(result,point);else{delete result.left;delete result.top;}return result;}
    return {toOutputState:state=>pageState(state,false),toSourceState:sourceState,toOutputViewportState:state=>mapped(state,false),toSourceViewportState:state=>mapped(state,true),
      toOutputLocation:value=>Number.isInteger(value?.pageIndex)&&!value.annotationID&&!value.position?pageState(value,false):null,
      toSourceAnnotation:denied,projectAnnotation:none,projectAnnotations:empty,selectionMapping:denied,hasExactSourceSelection:()=>false,selectionUnits:empty,selectionRequest:none,selectionRequests:empty,invalidateNativePages(){},canonicalID,annotationSide:()=> 'target'};
  }
  function element(doc,name,className,text){const node=doc.createElementNS(XHTML,name);if(className)node.className=className;if(text!=null)node.textContent=text;return node;}
  function canMount(context){const source=context?.sourceView,reader=context?.reader?._internalReader||context?.reader;return Boolean(source&&reader&&source._iframe&&source._options?.container?.ownerDocument?.body&&typeof source.constructor==='function'&&source.constructor!==Object&&typeof source._onAddAnnotation==='function'&&typeof source._onChangeViewState==='function'&&typeof source.setAnnotations==='function');}
  async function mount(context,css,actions={},appearance={}){
    const source=context.sourceView,reader=context.reader?._internalReader||context.reader,container=source?._options?.container,doc=container?.ownerDocument,win=doc?.defaultView||context.win;
    if(!canMount(context))throw failure();
    // Native PDFView/React run in the reader content compartment. Every object
    // entering that compartment must be cloned there, including callback return
    // values and method hooks installed after createReader() has initialized.
    const components=appearance.Components,readerWindow=doc.defaultView||win;
    function readerFunction(value){
      if(!components?.utils)return value;
      let exported;
      if(typeof components.utils.exportFunction==='function')exported=components.utils.exportFunction(value,readerWindow);
      else if(typeof components.utils.cloneInto==='function'){
        const holder=components.utils.cloneInto({value},readerWindow,{cloneFunctions:true,wrapReflectors:true});
        // Reading a function-valued property from the returned Xray holder can
        // produce undefined. Only this freshly owned holder may be waived.
        const readable=typeof components.utils.waiveXrays==='function'?components.utils.waiveXrays(holder):holder;exported=readable?.value;
      }else exported=value;
      if(typeof exported!=='function')throw failure();return exported;
    }
    const readerRealm=value=>typeof value==='function'?readerFunction(value):value===null||value===undefined||typeof value!=='object'||typeof value.then==='function'||!components?.utils?.cloneInto?value:components.utils.cloneInto(value,readerWindow,{cloneFunctions:true,wrapReflectors:true});
    const callReader=(target,name,...args)=>typeof target?.[name]==='function'?Reflect.apply(target[name],target,args.map(readerRealm)):undefined;
    const mapperOptions={invoke:callReader,unwrapPage:page=>components?.utils?.waiveXrays?components.utils.waiveXrays(page):page};
    const host=element(doc,'div','askgpt-native-pdf'),header=element(doc,'header','askgpt-native-controls'),viewport=element(doc,'div','askgpt-native-viewport'),status=element(doc,'span','askgpt-native-status'),progress=element(doc,'span','askgpt-native-progress'),label=element(doc,'span'),bar=element(doc,'progress'),menu=element(doc,'div','askgpt-native-menu'),statusBar=element(doc,'div','askgpt-native-bottom-status'),menuItems=[];let moreButton;
    const selectionNotice=element(doc,'span','askgpt-native-selection-notice');selectionNotice.setAttribute('role','status');selectionNotice.setAttribute('aria-live','polite');selectionNotice.hidden=true;
    const selectionRetry=element(doc,'button','askgpt-native-selection-retry','重试');selectionRetry.setAttribute('type','button');selectionRetry.setAttribute('aria-label','Retry current selection · 重试当前选区');selectionRetry.hidden=true;selectionRetry.addEventListener('click',readerFunction(()=>actions.resume?.()));
    const alignmentProgress=element(doc,'span','askgpt-native-progress askgpt-native-alignment-progress'),alignmentLabel=element(doc,'span'),alignmentBar=element(doc,'progress');let alignmentValue=null;alignmentProgress.setAttribute('role','status');alignmentProgress.setAttribute('aria-live','polite');alignmentProgress.hidden=true;alignmentProgress.append(alignmentLabel,alignmentBar);
    header.setAttribute('role','toolbar');header.setAttribute('aria-label','Translation controls');header.style.setProperty('max-width','160px');menu.setAttribute('role','menu');menu.setAttribute('aria-label','Translation options');menu.setAttribute('id','askgpt-native-menu-'+(++controlsSequence));menu.hidden=true;status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const annotationSlot=element(doc,'div','askgpt-native-annotation-state'),annotationIndicator=element(doc,'span','askgpt-native-annotation-indicator'),annotationHint=element(doc,'span','askgpt-native-annotation-hint');
    annotationIndicator.setAttribute('role','status');annotationIndicator.setAttribute('aria-live','polite');annotationIndicator.setAttribute('tabindex','0');annotationHint.setAttribute('role','status');annotationHint.hidden=true;annotationSlot.append(annotationIndicator,annotationHint);
    host.setAttribute('style','position:absolute;inset:0;z-index:10;visibility:hidden;background:Canvas');viewport.setAttribute('style','position:absolute;inset:0');host.style.setProperty('visibility','hidden');
    const style=element(doc,'style',null,`.askgpt-native-pdf{color-scheme:light dark}.askgpt-native-viewport>iframe{width:100%;height:100%;border:0}.askgpt-native-controls{position:static;display:inline-flex;align-items:center;gap:2px;flex:none;height:28px;max-width:100%;min-width:0;white-space:nowrap;color:var(--fill-secondary,CanvasText);font:12px -apple-system,sans-serif;-moz-window-dragging:no-drag}.askgpt-native-controls button,.askgpt-native-menu button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:auto;min-width:28px;height:26px;padding:3px 6px;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;cursor:default;-moz-window-dragging:no-drag}.askgpt-native-controls button[aria-pressed=true]{background:var(--fill-quarternary,#8882);color:var(--fill-primary,CanvasText)}.askgpt-native-controls button:focus-visible,.askgpt-native-menu button:focus-visible{outline:2px solid var(--accent-blue,#007aff);outline-offset:-2px}.askgpt-native-controls button:hover,.askgpt-native-menu button:hover{background:var(--fill-quinary,#8882)}.askgpt-native-group{display:flex;align-items:center;gap:2px}.askgpt-native-controls>.askgpt-native-group{gap:0;border:1px solid var(--fill-quinary,#8883);border-radius:6px}.askgpt-native-more{font-size:20px!important;padding:0!important}.askgpt-native-menu{position:fixed;z-index:90;box-sizing:border-box;min-width:180px;max-width:calc(100vw - 16px);padding:5px;border:var(--material-panedivider,1px solid #8883);border-radius:7px;background:var(--material-toolbar,Canvas);color:var(--fill-primary,CanvasText);font:12px -apple-system,sans-serif;box-shadow:0 3px 16px #0003}.askgpt-native-menu>.askgpt-native-group{justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--fill-quinary,#8883)}.askgpt-native-menu>button{width:100%;margin-top:3px}.askgpt-native-menu button{flex:1}.askgpt-native-progress{display:inline-flex;align-items:center;gap:4px;max-width:125px;margin-inline:3px;font:11px -apple-system,sans-serif}.askgpt-native-progress span{max-width:70px;overflow:hidden;text-overflow:ellipsis}.askgpt-native-progress progress{display:block;width:44px;height:3px;border:0;border-radius:3px;accent-color:var(--accent-blue,#007aff)}.askgpt-native-status{max-width:110px;overflow:hidden;text-overflow:ellipsis;margin-inline:3px;font:11px -apple-system,sans-serif}.askgpt-native-progress[hidden],.askgpt-native-status[hidden],.askgpt-native-menu[hidden]{display:none!important}`);
    style.textContent+=`.askgpt-native-annotation-state{padding:6px 7px 3px;border-top:1px solid var(--fill-quinary,#8883);font:11px/1.4 -apple-system,sans-serif;white-space:normal;color:var(--fill-secondary,CanvasText)}.askgpt-native-annotation-indicator,.askgpt-native-annotation-hint{display:block}.askgpt-native-annotation-indicator:focus-visible{outline:2px solid #007aff;outline-offset:2px}.askgpt-native-annotation-hint{margin-top:4px;color:var(--fill-primary,CanvasText)}.askgpt-native-annotation-hint[hidden]{display:none!important}.askgpt-native-menu button{white-space:nowrap}`;
    style.textContent+='.askgpt-native-controls{overflow-x:auto;overflow-y:hidden;scrollbar-width:none}.askgpt-native-controls>.askgpt-native-group{flex:1 1 auto;min-width:0;overflow-x:auto;scrollbar-width:none}.askgpt-native-controls>button{flex:none}.askgpt-native-controls[data-compact=true] button{padding-inline:2px}.askgpt-native-controls[data-tight=true] button{min-width:24px;padding-inline:0}.askgpt-native-controls[data-tight=true] .askgpt-native-more{min-width:20px}.askgpt-native-menu{max-height:calc(100vh - 16px);overflow-y:auto}.askgpt-native-controls button:disabled,.askgpt-native-menu button:disabled{opacity:.35;cursor:default}';
    style.textContent+='.askgpt-native-selection-retry{pointer-events:auto;border:0;border-radius:4px;padding:3px 8px;background:var(--fill-quinary,#8882);color:inherit;font:inherit}.askgpt-native-selection-retry[hidden]{display:none!important}.askgpt-native-selection-retry:focus-visible{outline:2px solid var(--accent-blue,#007aff)}';
    style.textContent+='.askgpt-native-options{display:inline-flex;align-items:center;gap:3px;flex:none}.askgpt-native-bottom-status{position:absolute;left:16px;bottom:12px;z-index:25;display:flex;align-items:center;flex-wrap:wrap;gap:8px;box-sizing:border-box;width:max-content;max-width:calc(100% - 32px);padding:7px 10px;border:1px solid var(--fill-quinary,#8883);border-radius:6px;background:var(--material-toolbar,Canvas);color:var(--fill-primary,CanvasText);box-shadow:0 2px 8px #0001;pointer-events:none;font:12px -apple-system,sans-serif}.askgpt-native-bottom-status[hidden]{display:none!important}.askgpt-native-bottom-status .askgpt-native-progress{flex:0 1 auto;min-width:0;max-width:100%;margin-inline:0;font:inherit}.askgpt-native-bottom-status .askgpt-native-progress span{min-width:0;max-width:none;flex:0 1 auto;white-space:nowrap}.askgpt-native-bottom-status .askgpt-native-progress progress{flex:0 1 100px;min-width:40px;max-width:100px;width:100px;height:4px}.askgpt-native-bottom-status .askgpt-native-status{min-width:0;max-width:none;font:inherit}.askgpt-native-bottom-status .askgpt-native-selection-retry{flex:none;white-space:nowrap}';
    doc.head.appendChild(style);host.append(viewport);container.appendChild(host);doc.body.appendChild(menu);progress.append(label,bar);statusBar.append(progress,alignmentProgress,status,selectionNotice,selectionRetry);container.appendChild(statusBar);progress.hidden=true;status.hidden=true;statusBar.hidden=true;
    const enteringTool=copy(reader._state?.tool||source._tool||{type:'pointer'}),legacyAutoTool=['highlight','underline'].includes(enteringTool.type),originalTool=legacyAutoTool?{type:'pointer'}:enteringTool;
    const removers=[],viewRemovers=[],hooks=[],initializers=new Set(),embedded=new Map(),embeddedPending=new Set(),sourceFrame=source._iframe;let disposed=false,visible=false,view=null,mapper=null,rawSelectionPopup=null,rawSourceSelectionPopup=null,rawAnnotationPopup=null,rawOverlayPopup=null,displayedAlignment=null,displayedGeometryOnly=false,geometryPending=null,geometryOpening=null,displayedSourcePages=[],requestedAlignmentPages=new Set(),lastPassiveAlignment=null,annotationStatus=null,annotationHintTimer=null,epoch=0,forwarding=false,mappedUpdate=false,toolOverride=false,sourceState=copy(reader._state?.primaryViewState||{}),direction='en-zh',mode='mono';
    const validatedPages=new Map(),pageEvidenceKeys=new Map(),loadClock=()=>win.performance?.now?.()??Date.now();let loadTiming=null;
    function timedLoad(name,fn){const start=loadClock();try{return fn();}finally{if(loadTiming)loadTiming[name]+=Math.max(0,loadClock()-start);}}
    function beginLoad(){return loadTiming={validateMilliseconds:0,projectionMilliseconds:0,mirrorMilliseconds:0,start:loadClock()};}
    function finishLoad(value){if(loadTiming===value)loadTiming=null;const {start,...numbers}=value;for(const key of Object.keys(numbers))numbers[key]=Math.round(numbers[key]);appearance.reportDiagnostic?.('nativeLoadTiming',{name:'RenderSnapshot',code:'rendered',loadNumbers:{...numbers,totalMilliseconds:Math.round(Math.max(0,loadClock()-start)),pageCount:displayedSourcePages.length,semanticPages:new Set([...(displayedAlignment?.sentencePages||[]),...(displayedAlignment?.sentencePartialPages||[])]).size}});}
    const acceptAlignment=(value,pages,retained=false)=>timedLoad('validateMilliseconds',()=>{
      if(retained&&displayedAlignment?.provenance==='pdf-glyph-candidates'&&['sourceSHA256','targetSHA256','provenance','recoveryRevision'].some(key=>value?.[key]!==displayedAlignment[key]))throw failure();
      return validateAlignment(value,pages,validatedPages);
    });
    let desiredMode='mono',activeLane='target',scrollLeader='target',displayedBytes=null,sourceMoved=false,syncing=false,applyingScale=false,panSession=null,independentZoomUntil=0,dualFitDone=false,dualFitPending=null,toolbarTarget=null,toolbarReason='missingProperty',toolbarReportKey='',scrollLinked=true,figurePanel=null,figureScanner=null,figureScanning=null;const sourceStyles=new Map(['position','top','left','right','width','height','flex','max-width','visibility','z-index'].map(name=>[name,[sourceFrame?.style?.getPropertyValue(name)||'',sourceFrame?.style?.getPropertyPriority(name)||'']]));
    const sourceScroll=source._iframeWindow?.document?.getElementById('viewerContainer'),sourceScrollbar=[sourceScroll?.style?.getPropertyValue('scrollbar-width')||'',sourceScroll?.style?.getPropertyPriority('scrollbar-width')||''],sourcePopupSetter=source.setSelectionPopup;
    const selectionLinks=SelectionLink?.create({sourceView:source,targetView:()=>view,exportCallback:readerFunction}),annotationMirrors=SelectionLink?.create({sourceView:source,targetView:()=>view,exportCallback:readerFunction});let presentingTargetSelection=false;
    removers.push(()=>selectionLinks?.dispose(),()=>annotationMirrors?.dispose());
    let linkedSelection=null,selectionLane='target',selectionIntent=null;
    function selectionChanged(){actions.selectionChanged?.();linkedSelection=null;pendingSelection=null;setAnnotationStatus(null);}
    function clearSelectionIntent(){const previous=selectionIntent;selectionIntent=null;if(previous)win.clearTimeout(previous.timer);}
    function recordSelectionIntent(lane,event){
      const pointer=event.type==='pointerdown'&&event.button===0&&event.isPrimary!==false,key=event.type==='keydown'&&(event.shiftKey&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.code)||!event.altKey&&(event.ctrlKey||event.metaKey)&&event.code==='KeyA');
      if(!visible||mode!=='dual'||event.defaultPrevented||!pointer&&!key)return;clearSelectionIntent();const intent={lane,epoch,timer:null};selectionIntent=intent;
      // Native mouse selection follows pointerdown with mousedown in this task.
      // A retained range may replay once; later scroll tasks get no permission.
      intent.timer=win.setTimeout(()=>{if(selectionIntent===intent)clearSelectionIntent();},0);
    }
    function takeSelectionIntent(lane){if(selectionIntent?.lane!==lane||selectionIntent.epoch!==epoch)return false;clearSelectionIntent();return true;}
    function linkSelection(popup,side){
      if(!visible||!mapper||!popup?.annotation){linkedSelection=null;selectionLinks?.clear();return null;}
      try{
        const input=popup.annotation,position=input.position,physical=side==='source'?position?.pageIndex:displayedSourcePages[position?.pageIndex],related=[physical,...(position?.nextPageRects?[side==='source'?physical+1:displayedSourcePages[position.pageIndex+1]]:[])],refs=[];for(const page of related)refs.push(source._pdfPages?.[page]?.chars,view?._pdfPages?.[displayedSourcePages.indexOf(page)]?.chars);const key=side+'|'+JSON.stringify(input),cached=linkedSelection;
        let linked;if(cached?.mapper===mapper&&cached.key===key&&refs.every((value,i)=>value===cached.refs[i]&&(value?.length||0)===cached.lengths[i]))linked=cached.linked;
        else{let mapped=null,error=null;try{mapped=mapper.selectionMapping(copy(input),side);}catch(value){error=value;}linked=mapped?.annotation||null;linkedSelection={mapper,key,refs,lengths:refs.map(value=>value?.length||0),linked:linked?copy(linked):null,expanded:Boolean(mapped?.expanded),whole:Boolean(mapped?.whole),composite:Boolean(mapped?.composite),error};}
        if(linked)setAnnotationStatus(null);if(mode==='dual'&&linked){selectionLinks?.clear(side);selectionLinks?.show(side==='source'?'target':'source',linked);}else selectionLinks?.clear();return linked?copy(linked):null;
      }catch(_){linkedSelection=null;selectionLinks?.clear();return null;/* Missing exact links never block native selection or guess a sentence. */}
    }
    const initialVisibility=sourceFrame?.style?.getPropertyValue('visibility')||'',initialPriority=sourceFrame?.style?.getPropertyPriority('visibility')||'',initialZIndex=sourceFrame?.style?.getPropertyValue('z-index')||'',initialZPriority=sourceFrame?.style?.getPropertyPriority('z-index')||'';
    function listen(node,type,callback,options){node.addEventListener(type,callback,options);removers.push(()=>node.removeEventListener(type,callback,options));}
    function current(value){return !disposed&&value===epoch&&(appearance.isCurrent?.()??true);}
    function refreshStatusBar(){alignmentProgress.hidden=disposed||!visible||mode==='original'||!alignmentValue||['complete','partial'].includes(alignmentValue.state)&&alignmentValue.completed===alignmentValue.total||!progress.hidden;statusBar.hidden=progress.hidden&&alignmentProgress.hidden&&status.hidden&&selectionNotice.hidden;}
    function setStatus(text){status.textContent=text||'';status.setAttribute('title',text||'');status.hidden=!text;refreshStatusBar();}
    const hoverHandles=[];let hoverButton=null;
    function clearHover(){for(const handle of hoverHandles)handle.clear();}
    function refreshHover(){if(!hoverButton)return;const on=appearance.hoverEnabled?.()!==false;hoverButton.textContent=(on?'✓ ':'')+'悬停释义';hoverButton.setAttribute('aria-checked',String(on));}
    function closeMenu(){menu.hidden=true;moreButton?.setAttribute('aria-expanded','false');}
    function positionMenu(){const anchor=moreButton?.getBoundingClientRect?.(),bounds=menu.getBoundingClientRect?.(),width=win.innerWidth||doc.documentElement?.clientWidth||1024,height=win.innerHeight||doc.documentElement?.clientHeight||768,menuWidth=bounds?.width||200,menuHeight=bounds?.height||190;menu.style.setProperty('left',Math.max(8,Math.min(width-menuWidth-8,(anchor?.right||width-8)-menuWidth))+'px');menu.style.setProperty('top',Math.max(8,Math.min(height-menuHeight-8,(anchor?.bottom||0)+4))+'px');}
    function openMenu(last=false){if(disposed)return;refreshHover();figurePanel?.close();menu.hidden=false;moreButton?.setAttribute('aria-expanded','true');positionMenu();const items=menuItems.filter(node=>!node.disabled);(last?items.at(-1):items[0])?.focus?.();}
    function toggleMenu(){if(menu.hidden)openMenu();else closeMenu();}
    function closePanels(){closeMenu();figurePanel?.close();}
    function sameDOMNode(expected,value){if(expected===value)return true;if(!expected||!value||typeof expected.isSameNode!=='function')return false;try{return Reflect.apply(expected.isSameNode,expected,[value])===true;}catch(_){return false;}}
    function toolbarSnapshot(){
      let box=null,targetBox=null,attached=false,connected=false,targetConnected=false,childCount=0;try{box=header.getBoundingClientRect?.();targetBox=toolbarTarget?.getBoundingClientRect?.();attached=Boolean(toolbarTarget&&sameDOMNode(toolbarTarget,header.parentNode));connected=header.isConnected===true;targetConnected=toolbarTarget?.isConnected===true;childCount=toolbarTarget?.childElementCount??toolbarTarget?.children?.length??0;}catch(_){}
      return {name:'RenderSnapshot',code:toolbarReason?'compatibility':'rendered',...(toolbarReason?{errorDetail:toolbarReason}:{}),renderNumbers:{width:finite(box?.width)?Math.max(0,Math.round(box.width)):0,height:finite(box?.height)?Math.max(0,Math.round(box.height)):0,holderChildCount:Number.isInteger(childCount)?childCount:0,textItemsCount:menuItems.length,renderedCount:attached&&connected?6+(menu.hidden?0:menuItems.length):0},layoutNumbers:{canvasConnected:connected?1:0,holderConnected:targetConnected?1:0,canvasLeft:box?.left,canvasTop:box?.top,canvasRectWidth:box?.width,canvasRectHeight:box?.height,holderRectWidth:targetBox?.width,holderRectHeight:targetBox?.height,holderChildCount:Number.isInteger(childCount)?childCount:0}};
    }
    function reportToolbar(){const snapshot=toolbarSnapshot(),key=JSON.stringify(snapshot);if(key!==toolbarReportKey){toolbarReportKey=key;try{appearance.reportDiagnostic?.('toolbar',snapshot);}catch(_){}}}
    let toolbarWidthObserver=null,centerPlacement=null;
    function restoreToolbarCenter(){
      const saved=centerPlacement;centerPlacement=null;if(!saved||saved.node.style.getPropertyValue('translate')!==saved.applied)return;
      if(saved.value)saved.node.style.setProperty('translate',saved.value,saved.priority);else saved.node.style.removeProperty('translate');
    }
    function layoutToolbarWidth(){
      if(disposed||!toolbarTarget||!sameDOMNode(toolbarTarget,header.parentNode))return null;
      restoreToolbarCenter();let width=160,nodes=null,placement=null;
      try{
        const toolbar=doc.querySelector?.('.toolbar'),start=doc.querySelector?.('.toolbar .start'),center=doc.querySelector?.('.toolbar .center'),end=doc.querySelector?.('.toolbar .end');
        const box=node=>{const r=node?.getBoundingClientRect?.();return r&&[r.left,r.right,r.width].every(finite)&&r.width>0&&r.right>r.left?{left:r.left,right:r.right}:null;},visibleBox=node=>{const r=box(node),children=node?.querySelectorAll?.('*');if(!r)return null;if(children&&Number.isInteger(children.length)&&children.length<=256)for(let i=0;i<children.length;i++){const child=box(children[i]);if(child){r.left=Math.min(r.left,child.left);r.right=Math.max(r.right,child.right);}}return r;};
        if(box(toolbar)&&box(start)&&box(center)&&box(end)){
          // Measure the native three-column flex layout without our width;
          // absolute page-count text must count toward its visible left gap.
          header.style.setProperty('max-width','0px');const startBox=visibleBox(start),centerBox=visibleBox(center),endBox=box(end),rtl=win.getComputedStyle?.(toolbar)?.direction==='rtl'||doc.documentElement?.getAttribute?.('dir')==='rtl';
          if(startBox&&centerBox&&endBox){const first=rtl?startBox.left-centerBox.right:centerBox.left-startBox.right,second=rtl?centerBox.left-endBox.right:endBox.left-centerBox.right;width=Math.max(0,Math.floor(2*(Math.min(first,second)-8)));
            // Use spare space between both native groups before compressing text.
            // A bounded center offset keeps page-count and annotation tools apart.
            if(!center.style.getPropertyValue('translate')){width=Math.max(width,Math.min(232,Math.floor(first+second-16)));placement={node:center,first,second,rtl};}}
          nodes=[toolbar,start,center,end,header];
        }
      }catch(_){}
      header.setAttribute('data-compact',String(width<216));header.setAttribute('data-tight',String(width<176));const value=width+'px';if(header.style.getPropertyValue('max-width')!==value)header.style.setProperty('max-width',value);
      if(placement&&width>0){const measured=header.getBoundingClientRect?.()?.width;if(finite(measured)&&measured>0){const lower=8-placement.first+measured/2,upper=placement.second-measured/2-8,shift=lower<=upper?Math.max(lower,Math.min(upper,0)):0;if(Math.abs(shift)>.25){const node=placement.node,applied=(placement.rtl?-shift:shift)+'px';centerPlacement={node,value:node.style.getPropertyValue('translate'),priority:node.style.getPropertyPriority('translate'),applied};node.style.setProperty('translate',applied);}}}
      if(!menu.hidden)positionMenu();return nodes;
    }
    function observeToolbarWidth(){
      try{toolbarWidthObserver?.disconnect();}catch(_){}toolbarWidthObserver=null;
      const nodes=layoutToolbarWidth();if(!nodes||typeof win.ResizeObserver!=='function')return;
      try{toolbarWidthObserver=new win.ResizeObserver(readerFunction(layoutToolbarWidth));for(const node of nodes)toolbarWidthObserver.observe(node);}catch(_){try{toolbarWidthObserver?.disconnect();}catch(_){}toolbarWidthObserver=null;}
    }
    listen(win,'resize',layoutToolbarWidth);removers.push(()=>{try{toolbarWidthObserver?.disconnect();}catch(_){}toolbarWidthObserver=null;restoreToolbarCenter();});
    function attachToolbar(value=appearance.toolbarHost){
      if(disposed)return false;
      try{
        const provided=typeof value==='function'?value():value,target=provided||doc.querySelector?.('.toolbar .end > .custom-sections')||doc.querySelector?.('.toolbar .end');toolbarTarget=target||null;
        if(!target)toolbarReason='missingProperty';
        // Keep our controls in Zotero's original toolbar slot. Its
        // native controls and fixed reading-area geometry remain owned by it.
        else if(!sameDOMNode(doc,target.ownerDocument))toolbarReason='id';
        else if(typeof target.appendChild!=='function')toolbarReason='notFunction';
        else {if(!sameDOMNode(target,header.parentNode))target.appendChild(header);toolbarReason=sameDOMNode(target,header.parentNode)?null:'other';if(!toolbarReason)observeToolbarWidth();}
      }catch(_){toolbarReason='permission';}
      reportToolbar();return toolbarReason===null;
    }
    function setAnnotationStatus(value){
      const labels={idle:'选词时准备对应',preparing:'正在准备词语对应，可继续阅读',failed:'词语对应暂不可用，可重新划词或点重试',retry_wait:'请稍候 3 秒再重试词语对应',retry_limited:'本页已多次重试，请稍后再试',unavailable:'未找到精确对应，请选完整词组；译文仍可标注',busy:'对应服务正忙，请稍后重试',timeout:'本次对应超时，请重试或缩短选区'};
      annotationStatus=Object.hasOwn(labels,value)?value:null;const text=labels[annotationStatus]||'译文标注已就绪';annotationIndicator.textContent=text;annotationIndicator.setAttribute('data-state',annotationStatus||'ready');annotationIndicator.setAttribute('title',text);annotationIndicator.setAttribute('aria-label',text);annotationIndicator.setAttribute('aria-busy',String(annotationStatus==='preparing'));
      const selected=selectionLane==='source'?rawSourceSelectionPopup?.annotation:rawSelectionPopup?.annotation;selectionNotice.hidden=!visible||!selected||!['preparing','failed','unavailable','busy','timeout','retry_wait','retry_limited'].includes(annotationStatus)&&!linkedSelection?.expanded;selectionNotice.textContent=selectionNotice.hidden?'':annotationStatus?text:'按完整词组对应';selectionRetry.hidden=selectionNotice.hidden||!['failed','unavailable','busy','timeout'].includes(annotationStatus);refreshStatusBar();
      if(annotationStatus==='retry_wait'||annotationStatus==='retry_limited')showAnnotationHint(text);else if(annotationStatus===null||annotationStatus==='preparing')clearAnnotationHint();
    }
    function clearAnnotationHint(){if(annotationHintTimer!==null)win.clearTimeout(annotationHintTimer);annotationHintTimer=null;annotationHint.hidden=true;annotationHint.textContent='';}
    function showAnnotationHint(text){clearAnnotationHint();annotationHint.textContent=text;annotationHint.hidden=false;annotationHintTimer=win.setTimeout(clearAnnotationHint,2600);}
    setAnnotationStatus(null);
    function diagnosticError(error){
      let message='',stack='';try{if(typeof error?.message==='string')message=error.message;if(typeof error?.stack==='string')stack=error.stack;}catch(_){}
      const errorDetail=/permission|denied|not allowed|insecure|security/i.test(message)?'permission':/not (?:a )?function|not callable/i.test(message)?'notFunction':/undefined|null|can't access property|cannot (?:read|access|set) propert|missing property/i.test(message)?'missingProperty':'other';
      const properties=['map','flatMap','some','apply','cloneInto','setSelectedAnnotationIDs','_onSelectAnnotations','setAnnotations','_onAddAnnotation','_onUpdateAnnotations','_onDeleteAnnotations','_getPageLabel','getAnnotations','then','slice','filter','find','every'];
      const errorProperty=properties.find(property=>new RegExp('(?:^|[^A-Za-z0-9_])'+property+'(?:[^A-Za-z0-9_]|$)').test(message))||'other';
      // Gecko exceptions can lose their content-compartment stack when exported.
      // This fallback contains only our call chain; the reporter extracts fixed
      // module names and line numbers and never receives the original message.
      if(!/(?:^|[/\\])pdf-native-view\.js:\d+/m.test(stack))stack+='\n'+(new Error().stack||'');
      return {name:typeof error?.name==='string'?error.name:'Error',code:typeof error?.code==='string'?error.code:undefined,errorDetail,errorProperty,stack};
    }
    function handleError(error,stage='nativeAnnotation'){if(['annotation_mapping','annotation_sentence'].includes(error?.code)){if(stage==='nativeAnnotation')showAnnotationHint(annotationStatus==='retry_wait'?'请稍候 3 秒再重试':annotationStatus==='retry_limited'?'本页已多次重试，请稍后再试':annotationStatus==='preparing'?'词语对应准备中，请稍后标注':error.code==='annotation_mapping'?'此处版式已变化，请在原文标注':'当前词语尚无精确对应，可重新划词或点重试');appearance.reportDiagnostic?.('nativeSelection',error);return;}appearance.reportDiagnostic?.(stage,diagnosticError(error));actions.failure?.(error);}
    const button=(label,title,callback,parent=header)=>{const node=element(doc,'button','toolbar-button',label);node.setAttribute('type','button');node.setAttribute('title',title);node.setAttribute('aria-label',title);node.setAttribute('tabindex','-1');if(parent===menu||parent.parentNode===menu){node.setAttribute('role','menuitem');menuItems.push(node);}listen(node,'click',()=>{if(callback!==toggleMenu)closeMenu();if(callback!==toggleFigures)figurePanel?.close();void Promise.resolve().then(callback).catch(handleError);});parent.appendChild(node);return node;};
    const group=(parent=header)=>{const node=element(doc,'div','askgpt-native-group');node.setAttribute('role','group');parent.appendChild(node);return node;};
    const modes=group();const originalButton=button('原文','Original PDF · 原文',()=>actions.original?actions.original():showOriginal(),modes);const monoButton=button('译文','Translated PDF · 译文',()=>actions.mode?.('mono'),modes),dualButton=button('对照','Side by side PDF · 对照',()=>actions.mode?.('dual'),modes);
    originalButton.setAttribute('aria-pressed','true');monoButton.setAttribute('aria-pressed','false');dualButton.setAttribute('aria-pressed','false');
    const linkedButton=button('联动','Linked scrolling · 同步滚动；点击可独立移动一侧',()=>setScrollLinked(!scrollLinked));linkedButton.setAttribute('aria-pressed','true');linkedButton.disabled=true;
    const figureButton=button('图表','Figure and table navigation · 图表定位',toggleFigures);figureButton.setAttribute('aria-haspopup','dialog');figureButton.setAttribute('aria-expanded','false');
    moreButton=button('⋯','More translation controls · 翻译选项',toggleMenu);moreButton.className+=' askgpt-native-more';moreButton.setAttribute('aria-haspopup','menu');moreButton.setAttribute('aria-expanded','false');moreButton.setAttribute('aria-controls',menu.getAttribute('id'));moreButton.setAttribute('tabindex','0');
    const scope=group(menu);button('本页翻译','Translate current page · 本页',()=>actions.current?.(),scope);button('整篇翻译','Translate whole PDF · 整份',()=>actions.whole?.(),scope);
    const playback=group(menu);button('■','Stop · 停止',()=>actions.stop?.(),playback);button('▶','Retry · 重试',()=>actions.resume?.(),playback);
    const zoom=group(menu),activeView=()=>mode==='original'||mode==='dual'&&activeLane==='source'?source:view;button('−','Zoom out · 缩小',()=>activeView()?.zoomOut?.(),zoom);button('↔','Fit width · 适合宽度',()=>fitPaneWidth(),zoom);button('+','Zoom in · 放大',()=>activeView()?.zoomIn?.(),zoom);
    const matchZoomButton=button('同步大小','Match pane zoom · 同步大小',()=>matchPaneZoom(),menu);matchZoomButton.disabled=true;
    const directionButton=button('EN→中','Translation direction · 翻译方向',()=>{direction=direction==='en-zh'?'zh-en':'en-zh';directionButton.textContent=direction==='en-zh'?'EN→中':'中→EN';actions.direction?.(direction);},menu);
    if(typeof appearance.lookupWord==='function'){hoverButton=button('悬停释义','Hover dictionary · 悬停释义',()=>actions.toggleHover?.(),menu);hoverButton.setAttribute('role','menuitemcheckbox');refreshHover();}
    menu.append(annotationSlot);
    listen(doc,'pointerdown',event=>{if(menu.hidden&&!figurePanel?.open)return;const inside=node=>{for(let target=event.target,i=0;node&&target&&i<32;i++,target=target.parentNode)if(sameDOMNode(node,target))return true;return false;};if(!inside(header)&&!inside(menu)&&!inside(figurePanel?.element))closePanels();},true);
    listen(moreButton,'keydown',event=>{if(!['ArrowDown','ArrowUp','Enter',' '].includes(event.key))return;event.preventDefault();event.stopImmediatePropagation?.();if(event.key==='Enter'||event.key===' ')toggleMenu();else openMenu(event.key==='ArrowUp');});
    listen(menu,'keydown',event=>{if(menu.hidden)return;if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation?.();closeMenu();moreButton.focus?.();return;}if(event.key==='Tab'){closeMenu();return;}if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();event.stopImmediatePropagation?.();const items=menuItems.filter(node=>!node.disabled),index=items.indexOf(doc.activeElement),next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus?.();},true);
    listen(win,'blur',closePanels);
    function toggleFigures(){closeMenu();figurePanel?.toggle();}
    function scanFigures(){
      if(figureScanning)return figureScanning;
      const pdf=source._iframeWindow?.PDFViewerApplication?.pdfDocument;
      if(!FigureNavigation||!pdf)throw failure();
      figureScanner=FigureNavigation.create(pdf,{invoke:callReader,eagerFirstBatch:true,yield:()=>new Promise(resolve=>win.setTimeout(resolve,0)),unwrapPage:page=>components?.utils?.waiveXrays?components.utils.waiveXrays(page):page,isCurrent:()=>!disposed&&source._iframeWindow?.PDFViewerApplication?.pdfDocument===pdf,
        onBatch:batch=>{if(!disposed)figurePanel?.setEntries(batch.entries,batch);}});
      figureScanning=figureScanner.scan().catch(error=>{figureScanning=null;if(error?.name!=='AbortError')figurePanel?.setEntries([],{done:true,failed:true});throw error;});return figureScanning;
    }
    function warmFigures(){
      const pdf=source._iframeWindow?.PDFViewerApplication?.pdfDocument;if(!Number.isInteger(pdf?.numPages)||typeof pdf?.getPage!=='function')return;
      void scanFigures().catch(error=>{if(!disposed&&error?.name!=='AbortError')appearance.reportDiagnostic?.('nativeFigures',diagnosticError(error));});
    }
    function jumpFigure(entry,lane){
      if(disposed||!Number.isInteger(entry?.pageIndex)||!finite(entry.top)||!finite(entry.left))return false;
      const candidate=lane==='source'?source:view,index=displayedSourcePages.indexOf(entry.pageIndex);
      if(!candidate||lane==='source'&&mode==='mono'||lane==='target'&&(!visible||index<0))return false;
      closePanels();setScrollLinked(false);cancelInitialDualFit();for(const handle of gestureHandles)handle.reset?.();
      independentZoomUntil=Infinity;activeLane=lane;leadScroll(lane);scrollSync?.reset();const top=finite(entry.pageTop)&&finite(entry.pageHeight)?Math.min(entry.pageTop,entry.top+entry.pageHeight*.6):entry.top,canonical={...sourceState,pageIndex:entry.pageIndex,left:entry.left,top};
      const previousForwarding=forwarding,previousSyncing=syncing;forwarding=true;syncing=true;
      try{const destination=lane==='source'?canonical:mapper.toOutputState(canonical);navigateNative(candidate,destination);sourceState=canonical;sourceMoved=false;return true;}finally{forwarding=previousForwarding;syncing=previousSyncing;}
    }
    const translatedSuffix='__askgptTranslated',isTranslatedID=id=>typeof id==='string'&&id.endsWith(translatedSuffix),targetID=id=>isTranslatedID(id)?id.slice(0,-translatedSuffix.length):id;
    let translatedStore=null,translatedManager=null,translatedValues=[],translatedFailed=false;
    const canonicalAnnotations=()=>copy(reader._state?.annotations||source._annotations||[]).filter(a=>!isTranslatedID(a.id));
    function targetDisplay(annotation){
      const value=copy(annotation),index=displayedSourcePages.indexOf(value.position?.pageIndex);if(index<0)return null;
      value.id+=translatedSuffix;value.position.pageIndex=index;if(translatedFailed||translatedStore?.readOnly)value.readOnly=true;return value;
    }
    const targetAnnotations=()=>translatedValues.map(targetDisplay).filter(Boolean);
    function targetInput(annotation){
      const value=copy(annotation),physical=displayedSourcePages[value.position?.pageIndex];
      if(!Number.isInteger(physical)||value.position.nextPageRects&&displayedSourcePages[value.position.pageIndex+1]!==physical+1)throw mappingFailure();
      value.id=targetID(value.id);value.position.pageIndex=physical;delete value[pendingKey];return value;
    }
    function publishTargetAnnotations(){
      if(disposed)return;
      exposeTranslatedLookup();
      if(view&&mapper){callReader(view,'setAnnotations',projectForDisplay());refreshAnnotationMirrors();}
      if(!visible&&reader._state?.selectedAnnotationIDs?.some(isTranslatedID))callReader(reader,'_updateState',{selectedAnnotationIDs:reader._state.selectedAnnotationIDs.filter(id=>!isTranslatedID(id)),primaryViewAnnotationPopup:null});
      if(typeof reader._updateState==='function')callReader(reader,'_updateState',{annotations:canonicalAnnotations()});
    }
    let sourceLookupArray=null,sourceLookupFind=null;
    function exposeTranslatedLookup(){
      const manager=reader._annotationManager;if(!manager||!Array.isArray(manager._annotations)||!translatedValues.length)return;
      // ReaderUI captured setSelectedAnnotations before the addon mounted.
      // Its original method calls manager._annotations.find directly. Keep the
      // source array's contents canonical; supplement only that read lookup.
      if(manager._annotations===sourceLookupArray)return;
      const owned=readerRealm(copy(manager._annotations)),array=components?.utils?.waiveXrays?components.utils.waiveXrays(owned):owned,find=array.find;
      sourceLookupFind=readerFunction(function(predicate,...rest){const found=Reflect.apply(find,this,[predicate,...rest]);if(found!==undefined||!visible)return found;const translated=Reflect.apply(find,readerRealm(targetAnnotations()),[predicate,...rest]);if(translated)activeLane='target';return translated;});
      Object.defineProperty(array,'find',{configurable:true,writable:true,value:sourceLookupFind});manager._annotations=owned;sourceLookupArray=owned;
    }
    function targetSaveFailure(error,store,manager){
      appearance.reportDiagnostic?.('nativeAnnotation',error);if(translatedStore!==store)return;
      translatedFailed=true;translatedValues=copy(store.annotations);callReader(manager,'setReadOnly',true);if(manager){manager._unsavedAnnotations?.clear?.();manager._undoStack?.splice?.(0);manager._redoStack?.splice?.(0);}rawAnnotationPopup=null;callReader(source,'_onSetAnnotationPopup',null);callReader(view,'setSelectedAnnotationIDs',[]);if(typeof reader._updateState==='function')callReader(reader,'_updateState',{selectedAnnotationIDs:[]});
      if(manager)manager._annotations=readerRealm(copy(translatedValues));publishTargetAnnotations();setStatus('译文标注保存失败，请重新打开后重试');
    }
    function saveTarget(store,manager,values,deleted=Promise.resolve()){
      // Native AnnotationManager awaits this in the reader compartment. A
      // chrome Promise cannot be awaited there, so finish a reader Promise.
      const executor=readerFunction(resolve=>{
        try{Promise.resolve(deleted).then(()=>store.save(copy(values))).then(()=>{resolve();},error=>{targetSaveFailure(error,store,manager);resolve();});}
        catch(error){targetSaveFailure(error,store,manager);resolve();}
      });
      return Reflect.construct(readerWindow.Promise||Promise,[executor]);
    }
    function ensureTranslatedManager(){
      const store=actions.translatedAnnotations?.()||null;if(store===translatedStore)return;
      flushTranslated();translatedStore=store;translatedManager=null;translatedValues=copy(store?.annotations||[]);translatedFailed=false;
      const Constructor=reader._annotationManager?.constructor;if(!store||typeof Constructor!=='function'||Constructor===Object)return;
      let manager,deleted=Promise.resolve();const options={readOnly:store.readOnly,authorName:reader._authorName||'',annotations:copy(translatedValues),tools:toolSnapshot(),
        onRender:values=>{if(translatedStore!==store)return;translatedValues=copy(values);publishTargetAnnotations();},
        onChangeFilter:()=>{},adjustTextAnnotationPosition:()=>{},
        onSave:values=>saveTarget(store,manager,values,deleted),
        onDelete:ids=>{try{deleted=Promise.resolve(store.remove(copy(ids)));deleted.catch(error=>targetSaveFailure(error,store,manager));}catch(error){deleted=Promise.reject(error);deleted.catch(()=>{});targetSaveFailure(error,store,manager);}}
      };
      manager=Reflect.construct(Constructor,[readerRealm(options)]);manager._skipAnnotationSavingDebounce=true;translatedManager=manager;
    }
    function flushTranslated(){if(translatedManager)callReader(translatedManager,'_triggerSaving');}
    function addTranslated(annotation){
      if(!translatedManager||translatedFailed||translatedStore?.readOnly)throw mappingFailure();
      const saved=callReader(translatedManager,'addAnnotation',targetInput(annotation));if(!saved)throw mappingFailure();return targetDisplay(saved);
    }
    function updateTranslated(updates){
      if(!translatedManager||translatedFailed)throw mappingFailure();
      const values=copy(updates).map(value=>{
        const id=targetID(value.id),existing=translatedValues.find(a=>a.id===id);if(!existing||existing.readOnly)throw mappingFailure();
        return value.position?{...targetInput({...targetDisplay(existing),...value}),id}:{...value,id};
      });return callReader(translatedManager,'updateAnnotations',values);
    }
    function deleteTranslated(ids){if(!translatedManager||translatedFailed)throw mappingFailure();return callReader(translatedManager,'deleteAnnotations',ids.map(targetID));}

    function sameAnnotation(a,b){if(a.type!==b.type||a.position?.pageIndex!==b.position?.pageIndex||!a.position?.rects?.length||!b.position?.rects?.length)return false;const x=bounds(a.position.rects),y=bounds(b.position.rects);return x.every((value,index)=>Math.abs(value-y[index])<1);}
    const withEmbedded=values=>[...values,...[...embedded.values()].flat().filter(annotation=>!values.some(value=>sameAnnotation(value,annotation)))];
    const annotations=()=>withEmbedded(canonicalAnnotations());
    const canonical=annotation=>{if(isTranslatedID(annotation?.id))return copy(annotation);const id=canonicalID(annotation?.id),existing=annotations().find(item=>item.id===id);return existing||mapper.toSourceAnnotation(annotation);};
    function setReaderTool(tool){if(typeof reader.setTool==='function')callReader(reader,'setTool',copy(tool));else callReader(source,'setTool',copy(tool));}
    function toolSnapshot(tool){const current=copy(reader._tools||source._tools||source._options?.tools||{});if(tool&&['pointer','hand','highlight','underline','note','image','text','ink','eraser'].includes(tool.type))current[tool.type]={...current[tool.type],...copy(tool)};return current;}
    function syncTools(candidate,tool){if(!candidate)return;const tools=readerRealm(toolSnapshot(tool));candidate._tools=tools;candidate._options.tools=tools;}
    function popupCoordinates(popup,toParent=true){
      if(!popup||!Array.isArray(popup.rect))return popup;const values=copy(popup.rect);if(values.length!==4||!values.every(finite))return popup;
      const frame=view?._iframe?.getBoundingClientRect?.(),parent=container.getBoundingClientRect?.(),offset=(key,alternate)=>finite(frame?.[key]??frame?.[alternate])&&finite(parent?.[key]??parent?.[alternate])?(frame[key]??frame[alternate])-(parent[key]??parent[alternate]):0,sign=toParent?1:-1,dx=offset('left','x')*sign,dy=offset('top','y')*sign;
      // PDFView rects are local to its iframe; ReaderUI's primary popup layer
      // covers the original container. Native context-menu x/y already include
      // their iframe bounding box and must never pass through this conversion.
      return {...popup,rect:values.map((value,index)=>value+(index%2?dy:dx))};
    }
    function restoreSourceScrollbar(){if(sourceScrollbar[0])sourceScroll?.style?.setProperty('scrollbar-width',...sourceScrollbar);else sourceScroll?.style?.removeProperty('scrollbar-width');}
    const scrollSync=ScrollSync?.create({win,getView:lane=>lane==='source'?source:view,isEnabled:()=>visible&&mode==='dual'&&scrollLinked&&Date.now()>independentZoomUntil,
      isLeader:lane=>scrollLeader===lane,mapState:(lane,state)=>lane==='source'?mapper?.toOutputViewportState(state):mapper?.toSourceViewportState(state),invoke:callReader,onError:error=>appearance.reportDiagnostic?.('nativeState',diagnosticError(error))});
    const physicalMapping=()=>displayedGeometryOnly||displayedAlignment?.provenance==='pdf-glyph-candidates';
    function leadScroll(lane,initial=false){if(!initial)geometryOpening=null;if(scrollLeader!==lane){geometryPending=null;scrollSync?.reset();}scrollLeader=lane;}
    function restoreGeometryOpening(candidate,generation){
      const opening=geometryOpening;if(!opening||opening.epoch!==generation||!current(generation)||view!==candidate||!physicalMapping())return;
      const state=opening.state,mapped=mapper?.toOutputViewportState(state);
      if(finite(state.left)&&finite(state.top)&&!mapped)return;
      const previousForwarding=forwarding,previousSyncing=syncing;forwarding=true;syncing=true;
      try{sourceState=copy(state);if(mapped)navigateNative(candidate,mapped);sourceMoved=false;}finally{forwarding=previousForwarding;syncing=previousSyncing;}
      geometryOpening=null;activeLane=opening.sourceChanged?'source':'target';leadScroll(activeLane,true);
    }
    function scheduleScroll(lane,state){
      if(!physicalMapping()){scrollSync?.schedule(lane,state);return;}
      if(!visible||mode!=='dual'||!scrollLinked||scrollLeader!==lane||Date.now()<=independentZoomUntil)return;
      const mapped=lane==='source'?mapper?.toOutputViewportState(state):mapper?.toSourceViewportState(state);
      if(mapped){geometryPending=null;scrollSync?.schedule(lane,state);return;}
      const pageIndex=lane==='source'?displayedSourcePages.indexOf(state?.pageIndex):displayedSourcePages[state?.pageIndex];if(!Number.isInteger(pageIndex)||pageIndex<0)return;
      const key=epoch+':'+lane+':'+pageIndex,previous=geometryPending;geometryPending={key,lane,state:copy(state),view,epoch};
      // Only page identity is known before PDF.js loads its real viewport.
      if(previous?.key!==key)navigateNative(lane==='source'?view:source,{pageIndex});
    }
    function installGeometrySync(candidate,generation){
      if(!physicalMapping())return;
      const retry=()=>{if(current(generation)&&view===candidate&&visible&&mode!=='original')restoreGeometryOpening(candidate,generation);const pending=geometryPending;if(!pending||!current(generation)||view!==candidate||pending.view!==candidate||pending.epoch!==epoch||!visible||mode!=='dual'||!scrollLinked||scrollLeader!==pending.lane)return;
        const mapped=pending.lane==='source'?mapper?.toOutputViewportState(pending.state):mapper?.toSourceViewportState(pending.state);if(!mapped)return;geometryPending=null;
        if(pending.lane==='target'){sourceState={...sourceState,...mapped};sourceMoved=false;syncing=true;try{callReader(source,'_onChangeViewState',copy(sourceState));}finally{syncing=false;}}
        scrollSync?.schedule(pending.lane,pending.state);
      };
      for(const own of [source,candidate]){const bus=own._iframeWindow?.PDFViewerApplication?.eventBus;if(!bus?.on||!bus?.off)continue;const callback=readerFunction(retry);bus.on('pagerendered',callback);viewRemovers.push(()=>bus.off('pagerendered',callback));}
      viewRemovers.push(()=>{if(geometryPending?.view===candidate)geometryPending=null;});retry();
    }
    let annotationProjectionCache=new Map();const selectionLinkPages=new Map();let selectionBinding=null;
    const emptySelectionWords=[],selectionWords=physical=>selectionLinkPages.get(physical)||emptySelectionWords;
    function updateSelectionLinks(value){
      if(disposed||!view||displayedGeometryOnly||!displayedAlignment)return false;
      const page=displayedAlignment.pages.find(page=>page.sourcePage===value?.page);if(!page)throw mappingFailure();
      const checked=Layout.validateSelectionLinks(value,value.jobID,page.sourcePage,displayedAlignment.sourceSHA256);
      if(displayedAlignment.targetSHA256!==undefined&&checked.targetSHA256!==displayedAlignment.targetSHA256)throw mappingFailure();
      const binding=[checked.jobID,checked.sourceSHA256,checked.targetSHA256,checked.revision].join('|');if(selectionBinding!==null&&selectionBinding!==binding)throw mappingFailure();
      const incoming=checked.links||[checked.link].filter(Boolean);
      // An empty per-page cache still establishes the document binding, but
      // adds no geometry and must not repaint every existing annotation.
      if(!incoming.length){selectionBinding=binding;return true;}
      for(const link of incoming){
        const parent=page.paragraphs.find(p=>p.id===link.paragraph);if(!parent||!/^[a-f0-9]{64}$/.test(link.key||'')||link.id!=='sel_'+link.key)throw mappingFailure();
        for(const side of ['source','target']){
          if(!paragraphOwnsGlyphs(parent,side,link[side].glyphs)||page.paragraphs.some(p=>p!==parent&&link[side].glyphs.filter(meaningful).some(g=>p[side].rects.some(r=>centerIn(g.rect,r)))))throw mappingFailure();
          const paired=link[side==='source'?'dualSource':'dualTarget'].rects,matrix=page[side==='source'?'sourceToDual':'targetToDual'];if(link[side].rects.some((r,i)=>transformRect(matrix,r).some((n,j)=>Math.abs(n-paired[i][j])>.02+1e-9)))throw mappingFailure();
        }
      }
      const merged=new Map((selectionLinkPages.get(page.sourcePage)||[]).map(link=>[link.id,link]));for(const link of incoming)merged.set(link.id,copy(link));selectionBinding=binding;selectionLinkPages.set(page.sourcePage,[...merged.values()]);mapper.invalidateNativePages([page.sourcePage]);
      for(const [key,cached] of annotationProjectionCache)if(cached.related?.includes(page.sourcePage))annotationProjectionCache.delete(key);linkedSelection=null;callReader(view,'setAnnotations',projectForDisplay(annotations(),[page.sourcePage]));refreshAnnotationMirrors([page.sourcePage]);if(selectionLane==='target')linkSelection(rawSelectionPopup,'target');else linkSelection(rawSourceSelectionPopup,'source');return true;
    }
    function projectForDisplay(values=annotations(),changedPages=null){
      return timedLoad('projectionMilliseconds',()=>{
      if(displayedGeometryOnly){annotationProjectionCache.clear();projectedSourceIDs=new Set();return copy(targetAnnotations());}
      const next=new Map(),pageKeys=new Map(),byPhysical=new Map((displayedAlignment?.pages||[]).map(page=>[page.sourcePage,page]));
      const revision=displayedAlignment?.sourceSHA256||'';
      const pageKey=physical=>{if(!pageKeys.has(physical))pageKeys.set(physical,pageEvidenceKeys.get(physical)??validatedPages.get(physical)?.stamp??null);return pageKeys.get(physical);};
      const result=[],projectedIDs=new Set();
      for(const annotation of values){
        if(isTranslatedID(annotation.id))continue;const physical=annotation.position?.pageIndex,related=[physical,...(annotation.position?.nextPageRects?[physical+1]:[])],key=String(annotation.id??JSON.stringify(annotation)),binding=JSON.stringify(annotation),cached=annotationProjectionCache.get(key);if(annotation._hidden){if(cached)next.set(key,cached);continue;}
        if(changedPages&&!related.some(page=>changedPages.includes(page))&&cached&&cached.revision===revision&&cached.binding===binding){next.set(key,cached);if(cached.projected){result.push(cached.projected);projectedIDs.add(String(annotation.id));}continue;}
        const refs=[];for(const page of related){const index=byPhysical.get(page)?.outputPage;refs.push(source._pdfPages?.[page]?.chars,view?._pdfPages?.[index]?.chars);}
        const lengths=refs.map(chars=>chars?.length||0),ready=lengths.every(length=>length>0),pages=related.map(pageKey),geometryBinding=JSON.stringify({text:annotation.text,position:annotation.position}),sameEvidence=cached&&cached.revision===revision&&pages.every((value,i)=>value===cached.pages[i])&&pages.length===cached.pages.length&&refs.every((value,i)=>value===cached.refs[i]&&lengths[i]===cached.lengths[i]||cached.projected&&!byPhysical.get(related[Math.floor(i/2)])?.paragraphs.some(row=>row.sentences!==undefined));
        let projected,exact=false;if(sameEvidence&&(cached.binding===binding||cached.geometryBinding===geometryBinding&&['highlight','underline'].includes(annotation.type)&&['highlight','underline'].includes(cached.type))){projected=cached.projected?{...copy(annotation),id:cached.projected.id,text:cached.projected.text,position:copy(cached.projected.position)}:null;exact=cached.exact===true;}
        else{if(ready&&['highlight','underline'].includes(annotation.type))try{projected=mapper.selectionMapping(copy(annotation),'source')?.annotation;exact=Boolean(projected);}catch(_){}if(!projected)projected=mapper.projectAnnotation(annotation);}
        if(projected){result.push(projected);projectedIDs.add(String(annotation.id));}
        if(next.size<4096)next.set(key,{revision,binding,geometryBinding,type:annotation.type,pages,refs,lengths,related,exact,projected:projected?copy(projected):null});
      }
      annotationProjectionCache=next;projectedSourceIDs=projectedIDs;return copy([...result,...targetAnnotations()]);});
    }
    let mirrorCache=new Map(),mirrorPageRefs=new Map(),mirrorCandidatePages=new Set(),mirrorSourcePages=new Set(),mirrorWarmCurrent=null,mirrorRefreshCancel=null,mirrorRefreshActivity=null,projectedSourceIDs=new Set(),mirrorAnnotationsVisible=source._showAnnotations!==false&&source._options?.showAnnotations!==false&&reader._state?.showAnnotations!==false;
    const mirrorRefs=physical=>[source._pdfPages?.[physical]?.chars,view?._pdfPages?.[displayedSourcePages.indexOf(physical)]?.chars];
    function clearAnnotationMirrors(retain=false){mirrorRefreshCancel?.();annotationMirrors?.clear();if(!retain){mirrorCache.clear();mirrorPageRefs.clear();}mirrorCandidatePages.clear();mirrorSourcePages.clear();}
    function refreshAnnotationMirrors(changedPages=null,sourceValues=null){
      return timedLoad('mirrorMilliseconds',()=>{
      if(disposed||!visible||mode!=='dual'||!view||!mapper||displayedGeometryOnly||!mirrorAnnotationsVisible){clearAnnotationMirrors(!disposed&&Boolean(view));return;}
      const entries=[],keys=new Set(),pages=new Set(),pageKeys=new Map(),byPhysical=new Map((displayedAlignment?.pages||[]).map(page=>[page.sourcePage,page]));
      for(const [origin,values] of [['source',sourceValues||annotations()],['target',targetAnnotations()]])for(const annotation of values){
        if(!['highlight','underline'].includes(annotation.type)||origin==='source'&&isTranslatedID(annotation.id))continue;if(annotation._hidden){const key=origin+':'+String(annotation.id);if(mirrorCache.has(key))keys.add(key);continue;}
        const physical=origin==='source'?annotation.position?.pageIndex:displayedSourcePages[annotation.position?.pageIndex],related=[physical,...(annotation.position?.nextPageRects?[physical+1]:[])];if(related.some(page=>!byPhysical.has(page)))continue;for(const page of related)pages.add(page);
        const key=origin+':'+String(annotation.id),entry={origin,annotation,key,related};keys.add(key);entries.push(entry);
        if(origin==='source'&&projectedSourceIDs.has(String(annotation.id))){mirrorCache.delete(key);continue;}
        if(changedPages&&!related.some(page=>changedPages.includes(page)))continue;
        const refs=related.flatMap(mirrorRefs),lengths=refs.map(chars=>chars?.length||0),geometryBinding=JSON.stringify({text:annotation.text,position:annotation.position}),binding=JSON.stringify({type:annotation.type,color:annotation.color,text:annotation.text,position:annotation.position}),links=related.map(selectionWords),signatures=related.map(page=>{if(!pageKeys.has(page))pageKeys.set(page,pageEvidenceKeys.get(page)??validatedPages.get(page)?.stamp??null);return pageKeys.get(page);}),cached=mirrorCache.get(key),sameEvidence=cached&&cached.epoch===epoch&&cached.view===view&&refs.every((ref,i)=>ref===cached.refs[i]&&lengths[i]===cached.lengths[i]||cached.projected&&!byPhysical.get(related[Math.floor(i/2)])?.paragraphs.some(row=>row.sentences!==undefined))&&links.every((value,i)=>value===cached.links[i])&&signatures.every((value,i)=>value===cached.signatures[i]);
        if(sameEvidence&&cached.binding===binding){mirrorCache.set(key,{...cached,refs,lengths});continue;}
        if(sameEvidence&&cached.geometryBinding===geometryBinding){mirrorCache.set(key,{...cached,binding,refs,lengths,projected:cached.projected?{...cached.projected,type:annotation.type,color:annotation.color}:null});continue;}
        let projected=null;if(lengths.some(Boolean))try{const mapped=mapper.selectionMapping(copy(annotation),origin)?.annotation;if(mapped)projected={id:'askgpt-mirror:'+key,type:annotation.type,color:annotation.color,position:copy(mapped.position)};}catch(_){/* Missing exact evidence never starts alignment or guesses a sentence. */}
        mirrorCache.set(key,{epoch,view,binding,geometryBinding,refs,lengths,links,signatures,projected});
      }
      for(const key of mirrorCache.keys())if(!keys.has(key))mirrorCache.delete(key);mirrorCandidatePages=pages;mirrorSourcePages=new Set(entries.filter(entry=>entry.origin==='target'?!mirrorCache.get(entry.key)?.projected:!annotationProjectionCache.get(String(entry.annotation.id))?.exact).flatMap(entry=>entry.related));
      for(const page of changedPages||pages){const refs=mirrorRefs(page);mirrorPageRefs.set(page,{view,refs,lengths:refs.map(value=>value?.length||0)});}
      annotationMirrors?.showMany('source',entries.filter(entry=>entry.origin==='target').map(entry=>mirrorCache.get(entry.key)?.projected).filter(Boolean));
      annotationMirrors?.showMany('target',entries.filter(entry=>entry.origin==='source'&&!projectedSourceIDs.has(String(entry.annotation.id))).map(entry=>mirrorCache.get(entry.key)?.projected).filter(Boolean));mirrorWarmCurrent?.();});
    }
    function refreshMirrorPage(physical){
      if(disposed||!visible||mode!=='dual'||!mirrorCandidatePages.has(physical))return;const refs=mirrorRefs(physical),lengths=refs.map(value=>value?.length||0),previous=mirrorPageRefs.get(physical);if(previous?.view===view&&refs.every((value,i)=>value===previous.refs[i]&&lengths[i]===previous.lengths[i]))return;
      const values=annotations();callReader(view,'setAnnotations',projectForDisplay(values,[physical]));refreshAnnotationMirrors([physical],values);
    }
    function installMirrorPages(candidate,generation){
      const target=candidate._iframeWindow,pending=new Set(),exported=fn=>components?.utils?.exportFunction?components.utils.exportFunction(fn,target):fn;let timer=null,idle=null;
      const ready=()=>current(generation)&&view===candidate&&visible&&mode==='dual';
      const cancel=()=>{if(timer!==null)target.clearTimeout(timer);if(idle!==null){if(typeof target.requestIdleCallback==='function')target.cancelIdleCallback?.(idle);else target.clearTimeout(idle);}timer=idle=null;};
      const clear=()=>{cancel();pending.clear();};
      const schedule=()=>{cancel();if(!ready()||!pending.size)return;timer=target.setTimeout(exported(()=>{timer=null;if(!ready())return;const run=exported(()=>{idle=null;if(!ready())return;const pages=[...pending];pending.clear();for(const physical of pages)refreshMirrorPage(physical);});idle=typeof target.requestIdleCallback==='function'?target.requestIdleCallback(run):target.setTimeout(run,0);}),600);};
      mirrorRefreshCancel=clear;mirrorRefreshActivity=schedule;viewRemovers.push(()=>{clear();if(mirrorRefreshCancel===clear)mirrorRefreshCancel=null;if(mirrorRefreshActivity===schedule)mirrorRefreshActivity=null;});
      for(const [native,lane] of [[source,'source'],[candidate,'target']]){const bus=native?._iframeWindow?.PDFViewerApplication?.eventBus;if(!bus?.on||!bus?.off)continue;const callback=readerFunction(event=>{if(!ready())return;const index=event?.pageNumber-1,physical=lane==='source'?index:displayedSourcePages[index];if(Number.isInteger(physical)&&mirrorCandidatePages.has(physical)){const refs=mirrorRefs(physical),previous=mirrorPageRefs.get(physical);if(previous?.view===view&&refs.every((ref,i)=>ref===previous.refs[i]&&(ref?.length||0)===previous.lengths[i]))return;pending.add(physical);schedule();}});for(const name of ['pagerendered','textlayerrendered']){bus.on(name,callback);viewRemovers.push(()=>bus.off(name,callback));}const scroll=native._iframeWindow.document?.getElementById('viewerContainer');if(scroll){const onScroll=readerFunction(schedule);scroll.addEventListener('scroll',onScroll,true);viewRemovers.push(()=>scroll.removeEventListener('scroll',onScroll,true));}}
    }
    function restoreSourceStyles(){restoreSourceScrollbar();for(const [name,[value,priority]] of sourceStyles){if(value)sourceFrame?.style?.setProperty(name,value,priority);else sourceFrame?.style?.removeProperty(name);}}
    function showSource(){geometryOpening=null;geometryPending=null;clearAnnotationMirrors(true);selectionChanged();selectionNotice.hidden=true;refreshStatusBar();clearSelectionIntent();scrollSync?.reset();closePanels();cancelInitialDualFit();selectionLinks?.clear();host.style.setProperty('visibility','hidden');visible=false;refreshStatusBar();publishTargetAnnotations();restoreSourceStyles();if(toolOverride){toolOverride=false;setReaderTool(originalTool);}}
    function navigateNative(candidate,state){const viewer=candidate?._iframeWindow?.PDFViewerApplication?.pdfViewer;if(!viewer||!Number.isInteger(state?.pageIndex))return;callReader(viewer,'scrollPageIntoView',{pageNumber:state.pageIndex+1,destArray:[null,{name:'XYZ'},state.left??null,state.top??null,null],allowNegativeOffset:true});}
    function snapshotSourceState(){
      const viewer=source._iframeWindow?.PDFViewerApplication?.pdfViewer,location=viewer?._location,parent=copy(reader._state?.primaryViewState||{}),previous=copy(sourceState||{}),validPage=value=>Number.isInteger(value)&&value>=1;
      const page=validPage(viewer?.currentPageNumber)?viewer.currentPageNumber:validPage(location?.pageNumber)?location.pageNumber:Number.isInteger(parent.pageIndex)&&parent.pageIndex>=0?parent.pageIndex+1:Number.isInteger(previous.pageIndex)&&previous.pageIndex>=0?previous.pageIndex+1:1,index=page-1;
      const matching=previous.pageIndex===index?previous:parent.pageIndex===index?parent:null,result={...parent,...(previous.pageIndex===index?previous:{}),pageIndex:index};
      for(const name of ['left','top'])if(finite(matching?.[name]))result[name]=matching[name];else delete result[name];
      // PDF.js updates currentPageNumber before its next animation-frame
      // location event. Coordinates from the prior page are never applicable.
      if(location?.pageNumber===page){if(finite(location.left))result.left=location.left;if(finite(location.top))result.top=location.top;if(finite(location.scale)||typeof location.scale==='string')result.scale=location.scale;}
      const scale=viewer?.currentScale,value=viewer?.currentScaleValue;
      if(typeof value==='string'&&['auto','page-width','page-fit','page-actual'].includes(value))result.scale=value;
      else if(finite(scale)&&scale>0&&(value==null||parseFloat(value)===scale))result.scale=Math.round(scale*10000)/100;
      for(const name of ['scrollMode','spreadMode'])if(Number.isInteger(viewer?.[name]))result[name]=viewer[name];
      return result;
    }
    function setScrollLinked(value){
      geometryPending=null;scrollSync?.reset();leadScroll(activeLane);
      const unavailable=value!==false&&visible&&mode==='dual'&&activeLane==='source'&&!displayedSourcePages.includes(snapshotSourceState().pageIndex);
      scrollLinked=value!==false&&!unavailable;if(unavailable)setStatus('本页尚无译文');linkedButton.textContent=scrollLinked?'联动':'独立';linkedButton.setAttribute('aria-pressed',String(scrollLinked));
      linkedButton.setAttribute('title',scrollLinked?'同步滚动；点击可独立移动一侧':'独立滚动；点击以当前侧重新对齐');
      if(!scrollLinked||disposed||!visible||mode!=='dual'||!view||!mapper)return scrollLinked;
      for(const handle of gestureHandles)handle.reset?.();cancelInitialDualFit();independentZoomUntil=Infinity;
      let state;if(activeLane==='source')state=snapshotSourceState();else{const viewer=view._iframeWindow?.PDFViewerApplication?.pdfViewer,number=viewer?.currentPageNumber,location=viewer?._location,output={pageIndex:Number.isInteger(number)?number-1:displayedSourcePages.indexOf(sourceState.pageIndex)};if(location?.pageNumber===number)for(const key of ['left','top'])if(finite(location[key]))output[key]=location[key];state={...sourceState,...mapper.toSourceViewportState(output)};if(location?.pageNumber!==number&&displayedSourcePages[output.pageIndex]===sourceState.pageIndex)state={...state,left:sourceState.left,top:sourceState.top};}
      const previousForwarding=forwarding,previousSyncing=syncing;forwarding=true;syncing=true;
      try{navigateNative(activeLane==='source'?view:source,activeLane==='source'?mapper.toOutputViewportState(state):state);sourceState=state;sourceMoved=false;}finally{forwarding=previousForwarding;syncing=previousSyncing;}
      return scrollLinked;
    }
    function cancelInitialDualFit(){const pending=dualFitPending;dualFitPending=null;if(!pending)return;if(pending.frame)pending.win.cancelAnimationFrame?.(pending.id);else pending.win.clearTimeout?.(pending.id);}
    function scheduleInitialDualFit(){
      if(dualFitDone||disposed||mode!=='dual'||!visible||!view||!view._iframeWindow?.PDFViewerApplication?.pdfDocument)return;
      if(dualFitPending?.candidate===view)return;cancelInitialDualFit();const candidate=view,generation=epoch,timing=typeof win.requestAnimationFrame==='function'?win:candidate._iframeWindow,pending={candidate,win:timing,frame:typeof timing.requestAnimationFrame==='function',id:null};dualFitPending=pending;
      const fit=()=>{if(dualFitPending!==pending)return;dualFitPending=null;if(!current(generation)||view!==candidate||mode!=='dual'||!visible||typeof source.zoomPageWidth!=='function'||typeof candidate.zoomPageWidth!=='function')return;
        const previousForwarding=forwarding,previousSyncing=syncing;independentZoomUntil=Date.now()+220;forwarding=true;syncing=true;
        try{callReader(source,'zoomPageWidth');callReader(candidate,'zoomPageWidth');
          // Both panes display the same physical page box. Their independent
          // fit-width values differ because PDF.js reserves scrollbar space.
          // Fit to the smaller scale, then align the same PDF coordinate.
          const scales=[actualScale(source),actualScale(candidate)];
          if(scales.every(value=>finite(value)&&value>0)){
            const scale=Math.max(.01,Math.floor(Math.min(...scales)*100)/100);
            for(const [index,pane] of [source,candidate].entries()){
              const viewer=pane._iframeWindow?.PDFViewerApplication?.pdfViewer;
              if(typeof viewer?.updateScale==='function')callReader(viewer,'updateScale',{scaleFactor:scale/scales[index],drawingDelay:0});
            }
            navigateNative(source,sourceState);navigateNative(candidate,mapper.toOutputViewportState(sourceState));
          }
          const fitted=snapshotSourceState();if(fitted.scale!==undefined)sourceState.scale=fitted.scale;dualFitDone=true;}catch(error){appearance.reportDiagnostic?.('nativeState',diagnosticError(error));}finally{forwarding=previousForwarding;syncing=previousSyncing;}
      };
      pending.id=pending.frame?timing.requestAnimationFrame(fit):timing.setTimeout(fit,0);
    }
    function fitPaneWidth(){
      if(mode!=='dual'||!visible||!view)return activeView()?.zoomPageWidth?.();
      cancelInitialDualFit();dualFitDone=true;independentZoomUntil=Date.now()+220;
      const previousForwarding=forwarding,previousSyncing=syncing;forwarding=true;syncing=true;
      try{callReader(source,'zoomPageWidth');callReader(view,'zoomPageWidth');const fitted=snapshotSourceState();if(fitted.scale!==undefined)sourceState.scale=fitted.scale;}
      finally{forwarding=previousForwarding;syncing=previousSyncing;}
    }
    function actualScale(candidate){const viewer=candidate?._iframeWindow?.PDFViewerApplication?.pdfViewer,value=viewer?.currentScale;if(finite(value)&&value>0)return value;const parsed=parseFloat(viewer?.currentScaleValue);return finite(parsed)&&parsed>0?parsed:null;}
    function pageGeometry(candidate,index){
      const viewer=candidate?._iframeWindow?.PDFViewerApplication?.pdfViewer,page=callReader(viewer,'getPageView',index),viewport=page?.viewport,canvas=page?.canvas||page?.div?.querySelector?.('.canvasWrapper')||page?.div,box=canvas?.getBoundingClientRect?.();
      if(!viewport||!box||![box.left,box.top,box.width,box.height,viewport.width,viewport.height].every(finite)||box.width<=0||box.height<=0||viewport.width<=0||viewport.height<=0)return null;
      return {viewport,box,x:box.width/viewport.width,y:box.height/viewport.height};
    }
    function pointerPDFState(candidate,origin,pageIndex){
      if(!Array.isArray(origin)||!origin.every(finite))return null;const viewer=candidate?._iframeWindow?.PDFViewerApplication?.pdfViewer,index=Number.isInteger(pageIndex)?pageIndex:(viewer?.currentPageNumber||1)-1,geometry=pageGeometry(candidate,index);
      if(!geometry||typeof geometry.viewport.convertToPdfPoint!=='function')return null;const {viewport,box,x,y}=geometry,point=copy(callReader(viewport,'convertToPdfPoint',(origin[0]-box.left)/x,(origin[1]-box.top)/y));
      return Array.isArray(point)&&point.length===2&&point.every(finite)?{pageIndex:index,left:point[0],top:point[1]}:null;
    }
    function pdfClientOrigin(candidate,state){
      const geometry=pageGeometry(candidate,state.pageIndex);if(!geometry||typeof geometry.viewport.convertToViewportPoint!=='function')return undefined;const {viewport,box,x,y}=geometry,point=copy(callReader(viewport,'convertToViewportPoint',state.left,state.top));
      return Array.isArray(point)&&point.length===2&&point.every(finite)?[box.left+point[0]*x,box.top+point[1]*y]:undefined;
    }
    function zoomPanes(candidate,lane,{scaleFactor,steps,origin,pageIndex,linked}){
      const stepped=Number.isInteger(steps)&&steps!==0;if(disposed||!stepped&&(!finite(scaleFactor)||scaleFactor<=0||scaleFactor===1)||lane==='source'&&mode!=='dual'&&mode!=='original'||lane==='target'&&!visible)return;
      const viewer=candidate?._iframeWindow?.PDFViewerApplication?.pdfViewer;if(typeof viewer?.updateScale!=='function')return;
      const other=linked&&mode==='dual'?(candidate===source?view:source):null,otherViewer=other?._iframeWindow?.PDFViewerApplication?.pdfViewer,state=candidate===source?snapshotSourceState():copy(sourceState),anchor=other?pointerPDFState(candidate,origin,pageIndex):null,previousScale=actualScale(candidate);
      const peer=anchor?(candidate===source?mapper.toOutputViewportState(anchor):mapper.toSourceViewportState(anchor)):null,peerOrigin=peer?pdfClientOrigin(other,peer):undefined,previousForwarding=forwarding,previousSyncing=syncing;
      forwarding=true;syncing=true;applyingScale=true;
      try{
        callReader(viewer,'updateScale',{...(stepped?{steps}:{scaleFactor}),origin:Array.isArray(origin)&&origin.every(finite)?origin:undefined,drawingDelay:400});
        const actual=actualScale(candidate),ratio=previousScale&&actual?actual/previousScale:scaleFactor;
        if(typeof otherViewer?.updateScale==='function'&&finite(ratio)&&ratio>0&&ratio!==1)callReader(otherViewer,'updateScale',{scaleFactor:ratio,origin:peerOrigin,drawingDelay:400});
        const scale=candidate===source||other===source?actualScale(source):null;sourceState={...state,...(scale?{scale:Math.round(scale*10000)/100}:{})};sourceMoved=false;
      }finally{applyingScale=false;forwarding=previousForwarding;syncing=previousSyncing;}
    }
    function panPanes(candidate,lane,{delta,linked,sequence}){
      if(disposed||!finite(delta)||delta===0||lane==='source'&&mode!=='dual'&&mode!=='original'||lane==='target'&&!visible)return;
      const scroll=candidate?._iframeWindow?.document?.getElementById('viewerContainer');if(!scroll||!finite(scroll.scrollLeft))return;
      const other=linked&&mode==='dual'?(candidate===source?view:source):null,peer=other?._iframeWindow?.document?.getElementById('viewerContainer'),scale=actualScale(candidate),peerScale=actualScale(other),previous=scroll.scrollLeft,limit=Math.max(0,(scroll.scrollWidth||0)-(scroll.clientWidth||0));
      // Only horizontal offsets change. In particular, do not navigate a PDF
      // destination here: that would also move the counterpart's vertical view.
      scroll.scrollLeft=Math.max(0,Math.min(limit,previous+delta));const moved=scroll.scrollLeft-previous;
      if(peer&&finite(peer.scrollLeft)){const ratio=scale&&peerScale?peerScale/scale:1,peerLimit=Math.max(0,(peer.scrollWidth||0)-(peer.clientWidth||0));if(!panSession||panSession.candidate!==candidate||panSession.sequence!==sequence||panSession.applied!==peer.scrollLeft)panSession={candidate,sequence,desired:peer.scrollLeft,applied:peer.scrollLeft};panSession.desired=Math.max(0,Math.min(peerLimit,panSession.desired+moved*ratio));peer.scrollLeft=panSession.desired;panSession.applied=peer.scrollLeft;}else panSession=null;
    }
    function matchPaneZoom(){
      if(disposed||!visible||mode!=='dual'||!view)return false;const active=activeLane==='source'?source:view,other=active===source?view:source,viewer=other._iframeWindow?.PDFViewerApplication?.pdfViewer,scale=actualScale(active),previousScale=actualScale(other);
      if(!scale||!previousScale||typeof viewer?.updateScale!=='function')return false;
      const state=active===source?snapshotSourceState():copy(sourceState),destination=other===source?state:mapper.toOutputState(state),previousForwarding=forwarding,previousSyncing=syncing;cancelInitialDualFit();independentZoomUntil=Date.now()+220;forwarding=true;syncing=true;
      try{callReader(viewer,'updateScale',{scaleFactor:scale/previousScale,drawingDelay:0});navigateNative(other,destination);sourceState={...state,...(other===source?{scale:Math.round(scale*10000)/100}:{})};sourceMoved=false;dualFitDone=true;return true;}finally{forwarding=previousForwarding;syncing=previousSyncing;}
    }
    function showOriginal(){
      clearHover();
      if(disposed)return;const moveSource=Boolean(view&&visible&&mode!=='original');
      if(!moveSource){
        // A failed/unfinished translated view never owned the reading position.
        // Preserve the real original page rather than replaying the mount-time
        // snapshot, including when its debounced parent state is still stale.
        sourceState=snapshotSourceState();
      }
      desiredMode='original';
      // A hidden unfinished iframe cannot paint. Retire only its local viewer;
      // the controller keeps the generated PDF bytes for a later local reopen.
      if(initializers.size){epoch++;removeView();}
      rawSelectionPopup=null;rawAnnotationPopup=null;rawOverlayPopup=null;pendingSelection=null;for(const name of ['setSelectionPopup','setAnnotationPopup','setOverlayPopup'])callReader(view,name,null);for(const name of ['_onSetSelectionPopup','_onSetAnnotationPopup','_onSetOverlayPopup'])callReader(source,name,null);for(const handle of readingHandles)handle.clear?.(false);showSource();mode='original';activeLane='source';leadScroll('source');matchZoomButton.disabled=true;linkedButton.disabled=true;figurePanel?.refresh();host.style.setProperty('visibility','visible');host.style.setProperty('pointer-events','none');viewport.style.setProperty('display','none');header.style.setProperty('pointer-events','auto');originalButton.setAttribute('aria-pressed','true');monoButton.setAttribute('aria-pressed','false');dualButton.setAttribute('aria-pressed','false');if(moveSource)navigateNative(source,sourceState);setProgress(null);setStatus('');
    }
    function layoutViewport(nextMode){
      restoreSourceStyles();host.style.setProperty('background','transparent');host.style.setProperty('visibility','visible');host.style.setProperty('pointer-events','none');host.style.setProperty('z-index','0');header.style.setProperty('pointer-events','auto');viewport.style.setProperty('pointer-events','auto');viewport.style.removeProperty('display');viewport.style.setProperty('left',nextMode==='dual'?'50%':'0');viewport.style.setProperty('background','Canvas');
      if(nextMode==='dual'){sourceScroll?.style?.setProperty('scrollbar-width','none');for(const [name,value] of Object.entries({position:'absolute',top:'0',left:'0',width:'50%',height:'100%',visibility:'visible','z-index':'0'}))sourceFrame?.style?.setProperty(name,value);}
      else sourceFrame?.style?.setProperty('visibility','hidden');
    }
    function layoutPanes(nextMode){geometryPending=null;scrollSync?.reset();if(nextMode!=='dual')cancelInitialDualFit();selectionLinks?.clear();for(const handle of readingHandles)handle.clear?.(false);mode=nextMode;visible=true;refreshStatusBar();publishTargetAnnotations();layoutViewport(nextMode);
      originalButton.setAttribute('aria-pressed','false');monoButton.setAttribute('aria-pressed',String(mode==='mono'));dualButton.setAttribute('aria-pressed',String(mode==='dual'));matchZoomButton.disabled=mode!=='dual';linkedButton.disabled=mode!=='dual';figurePanel?.refresh();if(mode==='dual'){if(scrollLinked)navigateNative(source,sourceState);scheduleInitialDualFit();}
    }
    function setAlignmentProgress(value){
      if(disposed)return false;
      const labels={running:'正在准备中英对应',paused:'中英对应已暂停',partial:'中英对应部分就绪',complete:'中英对应已就绪',failed:'中英对应暂不可用'};
      if(value!==null&&(!value||typeof value!=='object'||!Object.hasOwn(labels,value.state)||!Number.isInteger(value.completed)||!Number.isInteger(value.total)||value.total<1||value.total>2000||value.completed<0||value.completed>value.total||value.state==='complete'&&value.completed!==value.total))return false;
      alignmentValue=value===null?null:{state:value.state,completed:value.completed,total:value.total};
      const text=alignmentValue?labels[alignmentValue.state]+' · '+alignmentValue.completed+' / '+alignmentValue.total:'';alignmentLabel.textContent=text;alignmentProgress.setAttribute('title',text);alignmentProgress.setAttribute('data-state',alignmentValue?.state||'idle');alignmentProgress.setAttribute('aria-busy',String(alignmentValue?.state==='running'));alignmentBar.setAttribute('aria-label',text||'中英对应');
      if(alignmentValue){alignmentBar.setAttribute('max',String(alignmentValue.total));alignmentBar.setAttribute('value',String(alignmentValue.completed));}else{alignmentBar.removeAttribute('max');alignmentBar.removeAttribute('value');}
      refreshStatusBar();return true;
    }
    function setProgress(value){
      const valid=value&&['preparing','translating','layout','loading'].includes(value.stage);progress.hidden=!valid;refreshStatusBar();if(!valid)return;
      const labels={preparing:'准备翻译',translating:'翻译',layout:'整理版式',loading:'载入译文'},count=Number.isInteger(value.total)&&value.total>1&&Number.isInteger(value.completed)&&value.completed>=0&&value.completed<=value.total;
      label.textContent=labels[value.stage]+(count?' · '+value.completed+' / '+value.total:'');progress.setAttribute('title',label.textContent);bar.setAttribute('aria-label',label.textContent);if(count){bar.setAttribute('max',String(value.total));bar.setAttribute('value',String(value.completed));}else {bar.removeAttribute('max');bar.removeAttribute('value');}
    }
    const nativeResources=new WeakMap();
    function resourceError(){try{appearance.reportDiagnostic?.('nativeDispose',{name:'NativeResourceDiagnostic',code:'compatibility',errorDetail:'other'});}catch(_){}}
    function resourceReport(life,stage){try{appearance.reportDiagnostic?.(stage,{name:'NativeResourceDiagnostic',code:'rendered',resourceNumbers:{...life.counts}});}catch(_){}}
    function replaceMethod(target,name,create){
      let descriptor,original,replacement,installed;try{descriptor=Object.getOwnPropertyDescriptor(target,name);original=target[name];if(typeof original!=='function')return ()=>{};replacement=readerFunction(create(original));Object.defineProperty(target,name,{configurable:descriptor?.configurable??true,enumerable:descriptor?.enumerable??false,writable:true,value:replacement});installed=replacement;try{installed=Object.getOwnPropertyDescriptor(target,name)?.value||replacement;}catch(_){} }
      catch(_){resourceError();return ()=>{};}
      // Xray property/descriptor reads can expose another wrapper than the
      // export return. Compare the identity actually installed in this slot.
      return ()=>{try{const current=Object.getOwnPropertyDescriptor(target,name);if(current?.value!==installed&&current?.value!==replacement&&target[name]!==replacement)return;if(descriptor)Object.defineProperty(target,name,descriptor);else delete target[name];}catch(_){resourceError();}};
    }
    function removeResourceListeners(life,kind){
      for(const [target,type,listener,settings] of life[kind].splice(0))try{Reflect.apply(target.removeEventListener,target,[type,listener,settings]);life.counts[kind==='parent'?'parentListeners':'mediaListeners']++;}catch(_){resourceError();}
    }
    function restoreResourceGlobal(life,name,owner){if(!owner||readerWindow[name]!==owner)return;const previous=life.globals[name];if(previous)Object.defineProperty(readerWindow,name,previous);else delete readerWindow[name];}
    function guardNativeLoad(life,frame){
      if(!frame||frame===source._iframe||life.frame)return;life.frame=frame;
      let restoreTimerMethod=null;
      const finish=()=>{restoreTimerMethod?.();restoreTimerMethod=null;};life.finishLoad=finish;
      const begin=readerFunction(event=>{
        if(life.retired){event.stopImmediatePropagation?.();return;}finish();
        restoreTimerMethod=replaceMethod(readerWindow,'setTimeout',original=>function(callback,delay,...args){
          if(typeof callback!=='function'||!(delay===undefined||delay===0))return Reflect.apply(original,this,[callback,delay,...args]);
          let id;const guarded=readerFunction(function(...values){life.timers.delete(id);if(!life.retired)return Reflect.apply(callback,this,values);});
          id=Reflect.apply(original,this,[guarded,delay,...args]);life.timers.add(id);return id;
        });
        // The final bubble listener normally restores synchronously. The
        // microtask also covers a native load callback stopping propagation.
        Promise.resolve().then(finish);
      });
      frame.addEventListener('load',begin,true);frame.addEventListener('load',readerFunction(finish),false);
      // Retired-frame guards stay with that detached frame. They form no
      // parent root and prevent already queued native loads reopening a PDF.
    }
    function releaseNative(life){
      if(!life||life.retired)return;life.retired=true;life.finishLoad?.();removeResourceListeners(life,'parent');removeResourceListeners(life,'media');
      for(const id of life.timers){try{readerWindow.clearTimeout(id);life.counts.pendingTimers++;}catch(_){resourceError();}}life.timers.clear();
      const candidate=life.candidate,frame=life.frame||candidate?._iframe;
      try{
        const candidateWindow=candidate?._iframeWindow,frameWindow=frame?.contentWindow,target=candidateWindow?.PDFViewerApplication?candidateWindow:frameWindow,application=target?.PDFViewerApplication,originalWindow=source._iframeWindow,original=originalWindow?.PDFViewerApplication,task=application?.pdfLoadingTask,pdf=application?.pdfDocument;
        // Public PDF.js destroy terminates the owned worker. Application.close
        // may save form edits, so it must not be used for this cleanup.
        if(application&&application!==original&&(!task||task!==original?.pdfLoadingTask)&&(!pdf||pdf!==original?.pdfDocument)){
          const owner=typeof task?.destroy==='function'?task:pdf&&pdf!==original?.pdfDocument&&typeof pdf.destroy==='function'?pdf:null;
          if(owner){life.counts.destroyRequests++;try{Promise.resolve(Reflect.apply(owner.destroy,owner,[])).catch(resourceError);}catch(_){resourceError();}}
        }
        restoreResourceGlobal(life,'if',target);restoreResourceGlobal(life,'PDFViewerApplication',application);
      }catch(_){resourceError();}
      try{candidate?.destroy?.();}catch(_){resourceError();}
      try{frame?.remove?.();}catch(_){resourceError();}
      resourceReport(life,'nativeResourcesReleased');
    }
    function constructNative(options){
      const life={candidate:null,frame:null,parent:[],media:[],timers:new Set(),retired:false,globals:{if:Object.getOwnPropertyDescriptor(readerWindow,'if'),PDFViewerApplication:Object.getOwnPropertyDescriptor(readerWindow,'PDFViewerApplication')},counts:{parentListeners:0,mediaListeners:0,pendingTimers:0,destroyRequests:0}},restores=[];
      try{
        restores.push(replaceMethod(readerWindow,'addEventListener',original=>function(type,listener,settings){
          const result=Reflect.apply(original,this,[type,listener,settings]);if(type==='webviewerloaded'&&typeof listener==='function')life.parent.push([this,type,listener,settings]);return result;
        }));
        restores.push(replaceMethod(readerWindow,'matchMedia',original=>function(query){
          const media=Reflect.apply(original,this,[query]);if(query==='(prefers-color-scheme: dark)')restores.push(replaceMethod(media,'addEventListener',add=>function(type,listener,settings){const result=Reflect.apply(add,this,[type,listener,settings]);if(type==='change'&&typeof listener==='function')life.media.push([this,type,listener,settings]);return result;}));return media;
        }));
        const candidate=new source.constructor(options);life.candidate=candidate;nativeResources.set(candidate,life);guardNativeLoad(life,candidate._iframe);
        resourceReport({...life,counts:{parentListeners:life.parent.length,mediaListeners:life.media.length,pendingTimers:life.timers.size,destroyRequests:0}},'nativeResourcesAttached');return candidate;
      }catch(error){guardNativeLoad(life,viewport.firstElementChild||viewport.children?.[0]);releaseNative(life);throw error;}
      finally{for(const restore of restores.reverse())restore();}
    }
    function retireNative(candidate){if(!candidate||candidate===source)return;releaseNative(nativeResources.get(candidate));}
    function removeView(){clearAnnotationMirrors();mirrorWarmCurrent=null;selectionChanged();flushTranslated();annotationProjectionCache.clear();clearAnnotationHint();pendingSelection=null;rawSourceSelectionPopup=null;panSession=null;for(const cancel of [...initializers])cancel();for(const remove of viewRemovers.splice(0))remove();const old=view;view=null;displayedBytes=null;try{if(rawSelectionPopup){rawSelectionPopup=null;callReader(source,'_onSetSelectionPopup',null);}if(rawAnnotationPopup){rawAnnotationPopup=null;callReader(source,'_onSetAnnotationPopup',null);}if(rawOverlayPopup){rawOverlayPopup=null;callReader(source,'_onSetOverlayPopup',null);}}catch(_){resourceError();}retireNative(old);viewport.textContent='';}
    function nativePaintState(candidate,phase,invoked={}){
      const numbers={iframeWidth:0,iframeHeight:0,containerWidth:0,containerHeight:0,visiblePages:0,renderingState:-1,canvasWidth:0,canvasHeight:0,documentHidden:0,readerFocused:1,updateInvoked:invoked.updateInvoked||0,forceInvoked:invoked.forceInvoked||0,loadingTaskPresent:0,documentPresent:0,documentPages:0,viewerPages:0,currentPage:0,frameReadyState:0},count=value=>Number.isInteger(value)&&value>=0&&value<=100000?value:0;
      try{const box=candidate?._iframe?.getBoundingClientRect?.();numbers.iframeWidth=count(Math.round(box?.width??candidate?._iframe?.clientWidth));numbers.iframeHeight=count(Math.round(box?.height??candidate?._iframe?.clientHeight));}catch(_){}
      try{const target=candidate?._iframeWindow,app=target?.PDFViewerApplication;numbers.loadingTaskPresent=Number(Boolean(app?.pdfLoadingTask));numbers.documentPresent=Number(Boolean(app?.pdfDocument));numbers.documentPages=count(app?.pdfDocument?.numPages);numbers.viewerPages=count(app?.pdfViewer?.pagesCount);numbers.currentPage=count(app?.pdfViewer?.currentPageNumber);numbers.frameReadyState=({loading:1,interactive:2,complete:3})[target?.document?.readyState]||0;}catch(_){}
      try{const target=candidate?._iframeWindow,app=target?.PDFViewerApplication,pdfViewer=app?.pdfViewer,container=target?.document?.getElementById('viewerContainer');numbers.containerWidth=count(container?.clientWidth);numbers.containerHeight=count(container?.clientHeight);numbers.documentHidden=Number(target?.document?.hidden===true||target?.document?.visibilityState==='hidden');try{const page=typeof pdfViewer?.getPageView==='function'?Reflect.apply(pdfViewer.getPageView,pdfViewer,[(pdfViewer.currentPageNumber||1)-1]):null;numbers.renderingState=Number.isInteger(page?.renderingState)&&page.renderingState>=0&&page.renderingState<=3?page.renderingState:-1;numbers.canvasWidth=count(page?.canvas?.width);numbers.canvasHeight=count(page?.canvas?.height);}catch(_){}try{const visible=typeof pdfViewer?._getVisiblePages==='function'?Reflect.apply(pdfViewer._getVisiblePages,pdfViewer,[]):null;numbers.visiblePages=count(visible?.views?.length);}catch(_){}}catch(_){}
      try{if(typeof readerWindow.document?.hasFocus==='function')numbers.readerFocused=Number(readerWindow.document.hasFocus());}catch(_){}
      try{appearance.reportDiagnostic?.('nativeState',{name:'RenderSnapshot',code:'rendered',errorDetail:phase,paintNumbers:numbers});}catch(_){}
    }
    function queueNativePaint(candidate){
      const app=candidate?._iframeWindow?.PDFViewerApplication,invoked={updateInvoked:0,forceInvoked:0};
      try{if(typeof app?.pdfViewer?.update==='function'){Reflect.apply(app.pdfViewer.update,app.pdfViewer,[]);invoked.updateInvoked=1;}}catch(_){}
      try{if(typeof app?.forceRendering==='function'){Reflect.apply(app.forceRendering,app,[]);invoked.forceInvoked=1;}}catch(_){}
      nativePaintState(candidate,'nativePaint',invoked);
    }
    function initialized(promise,phase,realm=readerWindow,wake=null){return new Promise((resolve,reject)=>{
      let finished=false,timer=null;const listeners=[],Cu=components?.utils;
      const background=()=>{try{return readerWindow.document?.hidden===true||readerWindow.document?.visibilityState==='hidden'||realm?.document?.hidden===true||realm?.document?.visibilityState==='hidden'||typeof readerWindow.document?.hasFocus==='function'&&readerWindow.document.hasFocus()===false;}catch(_){return false;}};
      const finish=error=>{if(finished)return;finished=true;if(timer!==null)win.clearTimeout(timer);timer=null;for(const [target,type,callback] of listeners)try{target.removeEventListener(type,callback,true);}catch(_){}listeners.length=0;initializers.delete(cancel);if(error)reject(error);else resolve();},cancel=()=>finish();
      let wasBackground=background();
      const arm=()=>{if(timer!==null)win.clearTimeout(timer);timer=win.setTimeout(()=>{timer=null;nativePaintState(view,phase);if(background()){wasBackground=true;return;}const error=failure();error.errorDetail=phase;finish(error);},30000);};
      const activate=event=>{if(finished||['focus','blur'].includes(event?.type)&&event.target&&event.target!==readerWindow&&event.target!==realm)return;const hidden=background(),foreground=wasBackground&&!hidden;wasBackground=hidden;if(hidden||timer!==null&&!foreground)return;try{wake?.();}catch(_){}if(!finished)arm();};
      initializers.add(cancel);
      try{
        const targets=[[readerWindow,'focus'],[readerWindow,'blur'],[readerWindow.document,'visibilitychange'],...(realm!==readerWindow?[[realm,'focus'],[realm,'blur'],[realm?.document,'visibilitychange']]:[])];
        for(const [target,type] of targets)if(target?.addEventListener){const owner=type==='visibilitychange'?target.defaultView||realm:target,callback=typeof Cu?.exportFunction==='function'?Cu.exportFunction(activate,owner):activate;if(typeof callback!=='function')throw failure();target.addEventListener(type,callback,true);listeners.push([target,type,callback]);}
        arm();let native=promise;if(typeof Cu?.waiveXrays==='function')try{native=Cu.waiveXrays(promise);}catch(_){}
        const done=typeof Cu?.exportFunction==='function'?Cu.exportFunction(()=>finish(),realm):()=>finish(),failed=typeof Cu?.exportFunction==='function'?Cu.exportFunction(error=>finish(error),realm):error=>finish(error);
        if(typeof done!=='function'||typeof failed!=='function')throw failure();if(native&&typeof native.then==='function')Reflect.apply(native.then,native,[done,failed]);else if(native==null)finish();else throw failure();
      }catch(error){finish(error);}
    });}
    function requestAlignment(outputPage,options={}){
      if(displayedGeometryOnly)return options.explicit===true?'unavailable':'idle';
      const physical=displayedSourcePages[outputPage];if(!visible||!view||!Number.isInteger(physical))return 'unavailable';
      const explicit=options.explicit===true;
      // View stats arrive on every scroll frame. Page-level restoration and
      // coverage checks only need to run after a page or mapping changes.
      if(!explicit){
        if(lastPassiveAlignment?.page===physical&&lastPassiveAlignment.alignment===displayedAlignment&&lastPassiveAlignment.view===view&&lastPassiveAlignment.lane===scrollLeader)return 'pending';
        lastPassiveAlignment={page:physical,alignment:displayedAlignment,view,lane:scrollLeader};actions.page?.(physical);
      }
      const precise=displayedAlignment?.phraseExtractionRevision==='pdf-glyph-boundary-v2'&&displayedAlignment?.phraseExtractedPages?.includes(physical)&&displayedAlignment?.phrasePages?.includes(physical)&&Layout?.sentenceCoverage(displayedAlignment.pages.find(page=>page.sourcePage===physical))===true;
      if(precise&&!options.hydrationOnly&&!options.selection&&!options.selections?.length)return 'ready';if(typeof actions.align!=='function'||!explicit&&requestedAlignmentPages.has(physical))return 'pending';
      const requestEpoch=epoch;requestedAlignmentPages.add(physical);
      try{
        const result=actions.align(physical,{explicit,...(options.retry===true?{retry:true}:{}),...(options.pages?.length?{pages:options.pages}:{}),...(options.hydrationOnly?{hydrationOnly:true}:{}),...(options.units?.length?{units:options.units}:{}),...(options.selection?{selection:options.selection}:{}),...(options.selections?.length?{selections:options.selections}:{})});
        if(['idle','retry_wait','retry_limited','failed','unavailable','busy','timeout'].includes(result))setAnnotationStatus(result);
        else if(!['ready','started','pending','queued'].includes(result))setAnnotationStatus('preparing');
        if(result&&typeof result.then==='function')void Promise.resolve(result).catch(()=>{if(current(requestEpoch))setAnnotationStatus('failed');});return result;
      }catch(error){if(current(requestEpoch))setAnnotationStatus('failed');appearance.reportDiagnostic?.('nativeSelection',error);return 'failed';}
    }
    const glyphRequests=new Map();
    function requestSelectionAlignment(annotation,side,options={}){
      if(displayedGeometryOnly){setAnnotationStatus('unavailable');return;}
      const candidate=side==='source'?source:view,index=annotation?.position?.pageIndex,output=side==='source'?displayedSourcePages.indexOf(index):index;
      if(!candidate||!Number.isInteger(index)||output<0)return;
      const physical=displayedSourcePages[output],pages=[physical];if(annotation.position?.nextPageRects&&displayedSourcePages[output+1]===physical+1)pages.push(physical+1);
      const queries=mapper.selectionRequests(copy(annotation),side);
      if(queries.length)return requestAlignment(output,{explicit:true,...options,pages,units:mapper.selectionUnits(copy(annotation),side),...(queries.length===1&&glyphText(queries[0].text)===glyphText(annotation.text)?{selection:queries[0]}:{selections:queries})});
      if(pages.length===2&&pages.some(page=>!displayedAlignment.pages.find(p=>p.sourcePage===page)?.paragraphs.some(p=>p.sentences!==undefined)))return requestAlignment(output,{explicit:true,...options,pages,hydrationOnly:true});
      if(candidate._pdfPages?.[index]?.chars?.length||typeof candidate._ensureBasicPageData!=='function'){setAnnotationStatus('unavailable');return;}
      const token=epoch,key=side+':'+index,selection=copy(annotation),binding=JSON.stringify(selection);setAnnotationStatus('preparing');
      let request=glyphRequests.get(key);if(!request){request=Promise.resolve(callReader(candidate,'_ensureBasicPageData',index));glyphRequests.set(key,request);request.finally(()=>{if(glyphRequests.get(key)===request)glyphRequests.delete(key);}).catch(()=>{});}
      void request.then(()=>{
        const popup=side==='source'?rawSourceSelectionPopup:rawSelectionPopup;
        if(!current(token)||!visible||selectionLane!==side||JSON.stringify(popup?.annotation)!==binding)return;
        if(linkSelection(popup,side)){setAnnotationStatus(null);return;}
        const ready=mapper.selectionRequests(selection,side);if(ready.length)requestAlignment(output,{explicit:true,pages,units:mapper.selectionUnits(selection,side),...(ready.length===1&&glyphText(ready[0].text)===glyphText(selection.text)?{selection:ready[0]}:{selections:ready}),...options});else setAnnotationStatus('unavailable');
      }).catch(()=>{if(current(token)&&visible&&selectionLane===side&&JSON.stringify((side==='source'?rawSourceSelectionPopup:rawSelectionPopup)?.annotation)===binding)setAnnotationStatus('failed');});
    }
    const changedSelection=(previous,popup)=>Boolean(popup?.annotation&&(!previous?.annotation||!equalBinding(previous.annotation.position,popup.annotation.position)||previous.annotation.text!==popup.annotation.text));
    function mapForExplicitSave(annotation){
      const mapped=mapper.selectionMapping(annotation,'target',{whole:false,fragments:false});if(!mapped?.annotation)throw sentenceFailure('unmatched');return mapped.annotation;
    }
    function hook(name,forward){if(typeof source[name]!=='function')return;const own=Object.prototype.hasOwnProperty.call(source,name),original=source[name];const wrapper=readerRealm(function(...args){
      // The native callback persists parent state before our forward handler.
      // Ignore a delayed follower event at that boundary; intentional canonical
      // target-to-source publications enter with syncing/forwarding enabled.
      if(name==='_onChangeViewState'&&(applyingScale||mode==='dual'&&scrollLeader==='target'&&!syncing&&!forwarding))return;
      // A genuine source selection must own synchronous ReaderUI popup setters.
      // Target selections use this callback only while presentingTargetSelection.
      // Ignore an inactive saved range's scroll repositioning before ReaderUI.
      if(name==='_onSetSelectionPopup'&&!presentingTargetSelection){
        const popup=args[0],intent=takeSelectionIntent('source');if(!popup?.annotation){
          if(selectionLane==='source'&&rawSourceSelectionPopup)selectionChanged();rawSourceSelectionPopup=null;if(typeof sourcePopupSetter==='function')Reflect.apply(sourcePopupSetter,source,[null]);if(selectionLane==='target'&&rawSelectionPopup?.annotation)return;
        }else{if(selectionLane==='target'&&!intent&&!changedSelection(rawSourceSelectionPopup,popup))return;activeLane='source';}
      }
      const value=Reflect.apply(original,this,args.map(readerRealm));if(view&&(visible||name==='_onChangeViewState')&&!forwarding){forwarding=true;try{forward(...args);}finally{forwarding=false;}}return readerRealm(value);
    });source[name]=wrapper;hooks.push(()=>{if(source[name]===wrapper){if(own)source[name]=original;else delete source[name];}});}
    function redirect(name,convert){if(typeof source[name]!=='function')return;const own=Object.prototype.hasOwnProperty.call(source,name),original=source[name];const wrapper=readerRealm(function(...args){if(!forwarding&&!syncing&&(name.startsWith('navigate')||name==='findNext'||name==='findPrevious')){independentZoomUntil=0;leadScroll(activeLane);scrollSync?.reset();for(const handle of gestureHandles)handle.reset?.();}if(view&&visible&&!forwarding&&(mode!=='dual'||activeLane==='target')){const values=convert?convert(args):args;if(values===null)return;return readerRealm(callReader(view,name,...values));}return readerRealm(Reflect.apply(original,this,args.map(readerRealm)));});source[name]=wrapper;hooks.push(()=>{if(source[name]===wrapper){if(own)source[name]=original;else delete source[name];}});}
    // ReaderUI's color buttons call AnnotationManager directly, bypassing the
    // PDFView add callback. A pending native palette therefore carries an
    // opaque, short-lived credential. Its raw translated coordinates can enter
    // canonical storage only after exact glyph mapping succeeds at save time.
    const pendingKey='_askgptNativeSelection';let pendingSequence=0,pendingSelection=null,pendingSaveGuard=false;
    function pendingAnnotation(annotation){
      const retained=pendingSelection&&pendingSelection.epoch===epoch&&pendingSelection.annotation.type===annotation.type&&pendingSelection.annotation.text===annotation.text&&equalBinding(pendingSelection.annotation.position,annotation.position);const token=retained?pendingSelection.token:String(epoch)+':'+String(++pendingSequence);if(!retained)pendingSelection={token,epoch,annotation:copy(annotation)};
      return {...copy(annotation),[pendingKey]:token};
    }
    function resolvePendingAnnotation(annotation){
      const token=annotation?.[pendingKey];if(token===undefined)return annotation;
      const pending=pendingSelection;
      if(!visible||!view||!pending||pending.epoch!==epoch||token!==pending.token||!['highlight','underline'].includes(annotation.type)||!equalBinding(annotation.position,pending.annotation.position)||annotation.text!==pending.annotation.text)throw mappingFailure();
      const clean=copy(annotation);delete clean[pendingKey];return clean;
    }
    try{
      if(source._iframeWindow?.addEventListener){const listener=readerFunction(closePanels);Reflect.apply(source._iframeWindow.addEventListener,source._iframeWindow,['pointerdown',listener,true]);removers.push(()=>Reflect.apply(source._iframeWindow.removeEventListener,source._iframeWindow,['pointerdown',listener,true]));}
      const manager=reader._annotationManager;
      if(typeof manager?.addAnnotation==='function'){
        const own=Object.prototype.hasOwnProperty.call(manager,'addAnnotation'),original=manager.addAnnotation;
        const wrapper=readerFunction(function(annotation,...rest){
          let canonical;try{
            const pending=annotation?.[pendingKey]!==undefined;canonical=resolvePendingAnnotation(annotation);
            if(pending){try{canonical=mapForExplicitSave(canonical);}catch(error){if(!['annotation_mapping','annotation_sentence'].includes(error?.code)||!translatedManager)throw error;return readerRealm(addTranslated(canonical));}}
          }catch(error){handleError(error);throw error;}
          return readerRealm(Reflect.apply(original,this,[readerRealm(canonical),...rest.map(readerRealm)]));
        });
        manager.addAnnotation=wrapper;pendingSaveGuard=true;hooks.push(()=>{if(manager.addAnnotation===wrapper){if(own)manager.addAnnotation=original;else delete manager.addAnnotation;}});
      }
      // Parent React owns the native palette, comment popup and color menu.
      // Expose target marks to UI only; filter them before the source PDF sees
      // them, and route every persistence operation to its own native manager.
      function override(target,name,convert){
        if(typeof target?.[name]!=='function')return;const own=Object.hasOwn(target,name),original=target[name],wrapper=readerFunction(function(...args){try{return readerRealm(convert.call(this,original,args));}catch(error){handleError(error);throw error;}});target[name]=wrapper;hooks.push(()=>{if(target[name]===wrapper){if(own)target[name]=original;else delete target[name];}});
      }
      override(reader,'_updateState',function(original,args){if(!args[0]||!Object.hasOwn(args[0],'annotations'))return Reflect.apply(original,this,args);const state={...args[0],annotations:[...copy(args[0].annotations).filter(a=>!isTranslatedID(a.id)),...(visible?targetAnnotations():[])]};return Reflect.apply(original,this,[readerRealm(state),...args.slice(1).map(readerRealm)]);});
      override(source,'setAnnotations',function(original,args){return Reflect.apply(original,this,[readerRealm(copy(args[0]).filter(a=>!isTranslatedID(a.id))),...args.slice(1).map(readerRealm)]);});
      override(manager,'render',function(original,args){const result=Reflect.apply(original,this,args.map(readerRealm));exposeTranslatedLookup();return result;});
      override(manager,'_applyChanges',function(original,[changes]){
        const own=[],other=[];Reflect.apply(changes.forEach,changes,[readerFunction((value,id)=>{(isTranslatedID(id)?own:other).push([id,value]);})]);
        for(const [id,value] of own){if(value)updateTranslated([{...copy(value),id}]);else deleteTranslated([id]);}
        if(other.length){const values=Reflect.construct(readerWindow.Map||Map,[readerRealm(other)]);return Reflect.apply(original,this,[values]);}
      });
      override(manager,'updateAnnotations',function(original,[updates,...rest]){const own=copy(updates).filter(a=>isTranslatedID(a.id)),other=copy(updates).filter(a=>!isTranslatedID(a.id));appearance.reportDiagnostic?.('nativeAnnotation',{name:'RenderSnapshot',code:'rendered',renderNumbers:{textItemsCount:own.length,renderedCount:other.length}});if(own.length)updateTranslated(own);if(other.length)return Reflect.apply(original,this,[readerRealm(other),...rest.map(readerRealm)]);});
      override(manager,'deleteAnnotations',function(original,[ids,...rest]){const own=copy(ids).filter(isTranslatedID),other=copy(ids).filter(id=>!isTranslatedID(id));const removed=own.length?deleteTranslated(own):0;return (other.length?Reflect.apply(original,this,[readerRealm(other),...rest.map(readerRealm)]):0)+(removed||0);});
      override(manager,'_getAnnotationByID',function(original,[id,...rest]){return isTranslatedID(id)?readerRealm(targetAnnotations().find(a=>a.id===id)):Reflect.apply(original,this,[id,...rest.map(readerRealm)]);});
      override(manager,'convertAnnotations',function(original,[ids,type]){const own=copy(ids).filter(isTranslatedID),other=copy(ids).filter(id=>!isTranslatedID(id));if(own.length)callReader(translatedManager,'convertAnnotations',own.map(targetID),type);if(other.length)return Reflect.apply(original,this,[readerRealm(other),type]);});
      override(reader,'setSelectedAnnotations',function(original,args){
        if(!copy(args[0]).some(isTranslatedID))return Reflect.apply(original,this,args.map(readerRealm));
        manager._annotations=readerRealm([...copy(manager._annotations),...targetAnnotations()]);
        try{return Reflect.apply(original,this,args.map(readerRealm));}finally{manager._annotations=readerRealm(copy(manager._annotations).filter(a=>!isTranslatedID(a.id)));}
      });
      for(const name of ['undo','redo'])override(manager,name,function(original,args){if(visible&&activeLane==='target'&&translatedManager&&!translatedFailed)return callReader(translatedManager,name,...args);return Reflect.apply(original,this,args.map(readerRealm));});
      override(manager,'setFilter',function(original,[filter]){if(translatedManager){const own={...copy(filter),...(filter.hiddenIDs?{hiddenIDs:copy(filter.hiddenIDs).filter(isTranslatedID).map(targetID)}:{})};callReader(translatedManager,'setFilter',own);}return Reflect.apply(original,this,[readerRealm(filter)]);});
      override(reader,'_onOpenTagsPopup',function(original,[id,...rest]){return Reflect.apply(original,this,[targetID(id),...rest.map(readerRealm)]);});
      override(reader,'_handleOpenPageLabelPopup',function(original,args){if(!visible||!translatedManager)return Reflect.apply(original,this,args.map(readerRealm));manager._annotations=readerRealm([...copy(manager._annotations),...targetAnnotations()]);try{return Reflect.apply(original,this,args.map(readerRealm));}finally{manager._annotations=readerRealm(copy(manager._annotations).filter(a=>!isTranslatedID(a.id)));}});
      // Zotero's Add to Note action also receives the unsaved popup object.
      // It must never attach translated PDF coordinates to the original item.
      if(typeof reader._onAddToNote==='function'){
        const own=Object.prototype.hasOwnProperty.call(reader,'_onAddToNote'),original=reader._onAddToNote;
        const wrapper=readerFunction(function(values,...rest){let canonical;try{canonical=copy(values).map(value=>{if(isTranslatedID(value.id))throw mappingFailure();const pending=value[pendingKey]!==undefined,clean=resolvePendingAnnotation(value);return pending?mapForExplicitSave(clean):clean;});}catch(error){handleError(error);throw error;}return readerRealm(Reflect.apply(original,this,[readerRealm(canonical),...rest.map(readerRealm)]));});
        reader._onAddToNote=wrapper;hooks.push(()=>{if(reader._onAddToNote===wrapper){if(own)reader._onAddToNote=original;else delete reader._onAddToNote;}});
      }
      if(typeof source._onUpdateAnnotations==='function'){
        const name='_onUpdateAnnotations',own=Object.prototype.hasOwnProperty.call(source,name),original=source[name];
        const wrapper=readerRealm(function(updates,...rest){const ownValues=copy(updates).filter(a=>isTranslatedID(a.id));if(ownValues.length)updateTranslated(ownValues);const values=copy(updates).filter(a=>!isTranslatedID(a.id)).map(update=>{
          if(!mappedUpdate&&update.position){
            const existing=canonicalAnnotations().find(annotation=>annotation.id===canonicalID(update.id));
            if(existing?.position?._askgptSelection&&equalBinding(existing.position,update.position))update.position._askgptSelection=copy(existing.position._askgptSelection);
            else delete update.position._askgptSelection;
          }return update;
        });return values.length?readerRealm(Reflect.apply(original,this,[readerRealm(values),...rest.map(readerRealm)])):undefined;});
        source[name]=wrapper;hooks.push(()=>{if(source[name]===wrapper){if(own)source[name]=original;else delete source[name];}});
      }
      hook('_onChangeViewState',state=>{if(!syncing&&physicalMapping()&&geometryOpening&&!visible){sourceState=copy(state);geometryOpening.state=copy(state);geometryOpening.sourceChanged=true;return;}if(syncing||mode==='mono'||mode==='dual'&&scrollLeader!=='source')return;sourceState=copy(state);sourceMoved=true;if(scrollLinked&&mode==='dual'&&Date.now()>independentZoomUntil){if(!displayedSourcePages.includes(state.pageIndex)){setScrollLinked(false);setStatus('本页尚无译文');return;}scheduleScroll('source',state);sourceMoved=false;}});
      hook('_onSetSelectionPopup',popup=>{if(presentingTargetSelection||!popup?.annotation&&selectionLane!=='source')return;const changed=changedSelection(rawSourceSelectionPopup,popup)||!popup&&Boolean(rawSourceSelectionPopup);rawSourceSelectionPopup=popup?copy(popup):null;if(popup?.annotation)selectionLane='source';if(changed)selectionChanged();const mapped=linkSelection(popup,'source');if(changed&&popup?.annotation&&!mapped)requestSelectionAlignment(popup.annotation,'source');});
      hook('_onChangeViewStats',stats=>{if(mode!=='dual'||scrollLeader!=='source')return;const number=source._iframeWindow?.PDFViewerApplication?.pdfViewer?.currentPageNumber,physical=Number.isInteger(number)&&number>=1?number-1:stats.pageIndex;requestAlignment(displayedSourcePages.indexOf(physical));});
      hook('setAnnotations',value=>{const values=withEmbedded(copy(value));callReader(view,'setAnnotations',projectForDisplay(values));refreshAnnotationMirrors(null,values);});
      hook('setSelectedAnnotationIDs',ids=>callReader(view,'setSelectedAnnotationIDs',copy(ids)));
      hook('setTool',tool=>{syncTools(view,tool);callReader(view,'setTool',tool);});
      for(const name of ['setShowAnnotations','setLightTheme','setDarkTheme','setColorScheme','setReadOnly','setSidebarOpen'])hook(name,(...args)=>{callReader(view,name,...args);if(name==='setShowAnnotations'){mirrorAnnotationsVisible=args[0]!==false;refreshAnnotationMirrors();}});
      for(const name of ['zoomIn','zoomOut','zoomReset','zoomPageWidth','zoomPageHeight','zoomAuto','navigateBack','navigateForward','navigateToFirstPage','navigateToLastPage','navigateToPreviousPage','navigateToNextPage','findNext','findPrevious','focus','setScrollMode','setSpreadMode','setSelection','cancel'])redirect(name);
      redirect('navigate',([location,options])=>{const mapped=mapper.toOutputLocation(location);return mapped?[mapped,options]:null;});
      redirect('setFindState',([state])=>{if(!state?.result?.annotation)return [state];return [{...state,result:{...state.result,annotation:mapper.projectAnnotation(state.result.annotation)}}];});
      // ReaderUI owns the native popup and its explicit color/mode save action.
      // Parent state carries canonical English coordinates. PDFView only stores
      // these setters for scroll repositioning, so the visible view must retain
      // its raw selection rather than feeding English coordinates through the
      // target-to-source mapper again. Keep the hidden original out of this loop.
      redirect('setSelectionPopup',([popup])=>{if(!popup){rawSelectionPopup=null;pendingSelection=null;return [popup];}return [rawSelectionPopup?{...popupCoordinates(popup,false),...copy(rawSelectionPopup)}:null];});
      redirect('setAnnotationPopup',([popup])=>{if(!popup){rawAnnotationPopup=null;return [popup];}const annotation=rawAnnotationPopup?.annotation||mapper.projectAnnotation(popup.annotation);return [annotation?{...popupCoordinates(popup,false),...(rawAnnotationPopup?copy(rawAnnotationPopup):{}),annotation:copy(annotation)}:null];});
      redirect('setOverlayPopup',([popup])=>{if(!popup){rawOverlayPopup=null;return [popup];}return [{...popupCoordinates(popup,false),...(rawOverlayPopup||{})}];});
      // Reader.setTool mutates the active entry in _tools. When only its color
      // changes, _updateState sees the same object and does not call PDFView's
      // setter. A cloned native view cannot observe that shared-object update.
      if(typeof reader.setTool==='function'){
        const own=Object.prototype.hasOwnProperty.call(reader,'setTool'),original=reader.setTool,wrapper=readerFunction(function(...args){const result=Reflect.apply(original,this,args.map(readerRealm));if(view&&visible){const tool=copy(reader._state?.tool||args[0]);syncTools(view,tool);callReader(view,'setTool',tool);}return readerRealm(result);});reader.setTool=wrapper;hooks.push(()=>{if(reader.setTool===wrapper){if(own)reader.setTool=original;else delete reader.setTool;}});
      }
      if(legacyAutoTool)setReaderTool({type:'pointer'});
    if(FigurePanel)figurePanel=FigurePanel.create({doc,win,anchor:figureButton,exportCallback:readerFunction,onOpen:scanFigures,onJump:jumpFigure,
      getState:()=>({source:mode!=='mono',target:visible&&mode!=='original',side:mode==='mono'?'target':activeLane,pages:displayedSourcePages})});

    }catch(error){for(const restore of hooks.reverse())restore();for(const remove of removers.splice(0))remove();figureScanner?.cancel();figurePanel?.dispose();host.remove();header.remove();menu.remove();statusBar.remove();style.remove();throw error;}
    function makeOptions(bytes,sourcePages){
      // PDFView passes data.buf from the outer reader into another iframe.
      // PDF.js uses instanceof ArrayBuffer there, which fails for an outer-
      // window ArrayBuffer. ArrayBuffer.isView is cross-realm and accepts this
      // byte view. Own the bytes so PDF.js worker transfer cannot detach cache.
      let nativeBytes;if(ArrayBuffer.isView(bytes)&&bytes.BYTES_PER_ELEMENT===1)nativeBytes=new Uint8Array(new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength));else if(Object.prototype.toString.call(bytes)==='[object ArrayBuffer]')nativeBytes=new Uint8Array(new Uint8Array(bytes));else throw failure();
      const pageLabels=sourcePages.map(index=>source._pageLabels?.[index]||reader._state?.pageLabels?.[index]||source._getPageLabel?.(index,false)||String(index+1));
      const callbackEpoch=epoch,options={...source._options,primary:false,container:viewport,data:{buf:nativeBytes},annotations:projectForDisplay(),tool:{type:'pointer'},tools:toolSnapshot(),selectedAnnotationIDs:[],pageLabels,viewState:mapper.toOutputState(sourceState),location:undefined};
      // Native setters update current reader state, not the constructor options.
      for(const key of ['lightTheme','darkTheme','colorScheme'])if(Object.hasOwn(reader._state||{},key))options[key]=copy(reader._state[key]);
      const protect=(callback,fallback,stage='nativeAnnotation')=>function(...args){if(!current(callbackEpoch)||!mapper)return fallback;try{return readerRealm(callback(...args));}catch(error){handleError(error,stage);return fallback;}};
      options.onAddAnnotation=protect((annotation,select)=>{
        const side=mapper.annotationSide(annotation);let canonical;
        try{canonical=mapForExplicitSave(annotation);}catch(error){if(!['annotation_mapping','annotation_sentence'].includes(error?.code)||!translatedManager)throw error;const saved=addTranslated(annotation);if(select)callReader(reader,'setSelectedAnnotations',[saved.id],true);return saved;}
        const saved=callReader(source,'_onAddAnnotation',canonical,select);return saved?mapper.projectAnnotation(saved,side):saved;
      },null);
      options.onUpdateAnnotations=protect(updates=>{const ownValues=copy(updates).filter(a=>isTranslatedID(a.id));if(ownValues.length)updateTranslated(ownValues);const values=copy(updates).filter(a=>!isTranslatedID(a.id)).map(update=>{const id=canonicalID(update.id),existing=canonicalAnnotations().find(annotation=>annotation.id===id);if(!existing||existing.readOnly)throw mappingFailure();const projected=update.id!==id?mapper.projectAnnotation(existing,'source'):annotationProjectionCache.get(String(existing.id))?.projected||mapper.projectAnnotation(existing);if(update.position&&projected&&['highlight','underline'].includes(existing.type)&&equalBinding(update.position,projected.position)){const metadata={...copy(update),id,type:['highlight','underline'].includes(update.type)?update.type:existing.type};for(const name of ['position','text','sortIndex','pageLabel'])delete metadata[name];return metadata;}if(!update.position&&['highlight','underline'].includes(existing.type)){const metadata={...copy(update),id};if(update.type!==undefined)metadata.type=['highlight','underline'].includes(update.type)?update.type:existing.type;for(const name of ['text','sortIndex','pageLabel'])delete metadata[name];return metadata;}return update.position?mapper.toSourceAnnotation({...projected,...update,id,type:existing.type}):{...copy(update),id};});mappedUpdate=true;try{return callReader(source,'_onUpdateAnnotations',values);}finally{mappedUpdate=false;}});
      options.onDeleteAnnotations=protect(ids=>{const ownIDs=copy(ids).filter(isTranslatedID);if(ownIDs.length)deleteTranslated(ownIDs);const permitted=[...new Set(copy(ids).map(canonicalID))].filter(id=>canonicalAnnotations().some(annotation=>annotation.id===id&&!annotation.readOnly));if(permitted.length)return callReader(source,'_onDeleteAnnotations',permitted);});
      options.onSelectAnnotations=protect((value,event)=>{const ids=copy(value);if(ids.some(isTranslatedID))return callReader(reader,'setSelectedAnnotations',ids,true,event);const canonicalIDs=[...new Set(copy(ids).map(canonicalID))].filter(id=>canonicalAnnotations().some(annotation=>annotation.id===id));if(canonicalIDs.length||!ids.length)return callReader(source,'_onSelectAnnotations',canonicalIDs,event);callReader(view,'setSelectedAnnotationIDs',ids);},undefined,'nativeSelection');
      options.onSetSelectionPopup=protect(popup=>{
        // A follower's old popup cannot take over the active selection palette.
        const intent=takeSelectionIntent('target');
        if(!popup?.annotation){if(selectionLane==='target'&&rawSelectionPopup)selectionChanged();rawSelectionPopup=null;if(selectionLane==='target'){selectionNotice.hidden=true;refreshStatusBar();}pendingSelection=null;callReader(view,'setSelectionPopup',null);if(selectionLane==='source'&&rawSourceSelectionPopup?.annotation)return;}
        else if(selectionLane==='source'&&!intent&&!changedSelection(rawSelectionPopup,popup))return;
        const changed=changedSelection(rawSelectionPopup,popup);if(popup?.annotation){activeLane='target';selectionLane='target';}if(changed)selectionChanged();rawSelectionPopup=popup?copy(popup):null;const linked=linkSelection(popup,'target');
        const present=value=>{presentingTargetSelection=true;try{return callReader(source,'_onSetSelectionPopup',value);}finally{presentingTargetSelection=false;}};
        if(!popup){rawSelectionPopup=null;pendingSelection=null;return present(popup);}
        let annotation;try{annotation=linked;if(!annotation)throw linkedSelection?.error||sentenceFailure('unmatched');if(linkedSelection?.whole||linkedSelection?.composite)annotation=pendingAnnotation(popup.annotation);else pendingSelection=null;}
        catch(error){
          if(!pendingSaveGuard||!['annotation_mapping','annotation_sentence'].includes(error?.code)){const previous=rawSelectionPopup||reader._state?.primaryViewSelectionPopup;rawSelectionPopup=null;pendingSelection=null;if(previous)callReader(source,'_onSetSelectionPopup',null);throw error;}
          // Selecting and copying translated text never waits for a model.
          // Keep Zotero's own palette; only its explicit save action needs the
          // semantic mapping. No annotation is created by this callback.
          if(changed){appearance.reportDiagnostic?.('nativeSelection',error);requestSelectionAlignment(popup.annotation,'target');}annotation=pendingAnnotation(popup.annotation);
        }
        rawSelectionPopup=copy(popup);return present({...popupCoordinates(popup),annotation});
      },undefined,'nativePopup');
      options.onSetAnnotationPopup=protect(popup=>{const annotation=popup?canonical(popup.annotation):null;rawAnnotationPopup=popup?copy(popup):null;return callReader(source,'_onSetAnnotationPopup',popup?{...popupCoordinates(popup),annotation}:popup);},undefined,'nativePopup');
      options.onSetOverlayPopup=protect(popup=>{rawOverlayPopup=popup?{...popup,rect:copy(popup.rect)}:null;return callReader(source,'_onSetOverlayPopup',popupCoordinates(popup));},undefined,'nativePopup');
      options.onSetDataTransferAnnotations=protect((transfer,annotation,...rest)=>{
        let mapped;try{if(isTranslatedID(annotation?.id))throw mappingFailure();mapped=canonical(annotation);}catch(error){
          if(rest[0]!==true||!['annotation_mapping','annotation_sentence'].includes(error?.code)||typeof annotation?.text!=='string'||typeof transfer?.setData!=='function')throw error;
          // Plain text copying remains native and immediate even before the
          // semantic sidecar is ready. Do not emit a false source citation.
          return Reflect.apply(transfer.setData,transfer,['text/plain',annotation.text]);
        }
        if(rest[0]===true&&typeof annotation?.text==='string')mapped={...copy(mapped),text:annotation.text};
        return callReader(source,'_onSetDataTransferAnnotations',transfer,mapped,...rest);
      },undefined,'nativeCopy');
      options.onOpenViewContextMenu=protect(params=>callReader(source,'_onOpenViewContextMenu',params),undefined,'nativeMenu');
      options.onOpenAnnotationContextMenu=protect(params=>{const ids=copy(params.ids)?.map(canonicalID);if(ids?.some(id=>!isTranslatedID(id)&&!canonicalAnnotations().some(annotation=>annotation.id===id)))return;callReader(source,'_onOpenAnnotationContextMenu',{...params,ids,annotation:params.annotation?canonical(params.annotation):params.annotation,annotations:copy(params.annotations)?.map(canonical)});},undefined,'nativeMenu');
      options.onChangeViewState=protect(state=>{if(physicalMapping()&&geometryOpening)return;if(applyingScale||mode==='original'||mode==='dual'&&scrollLeader==='source')return;const mapped=mapper.toSourceViewportState(state);if(!mapped){if(physicalMapping()&&Number.isInteger(displayedSourcePages[state?.pageIndex])){sourceState={...sourceState,pageIndex:displayedSourcePages[state.pageIndex]};delete sourceState.left;delete sourceState.top;syncing=true;try{callReader(source,'_onChangeViewState',copy(sourceState));}finally{syncing=false;}scheduleScroll('target',state);}return;}sourceState={...sourceState,...mapped};sourceMoved=false;syncing=true;try{callReader(source,'_onChangeViewState',copy(sourceState));}finally{syncing=false;}if(scrollLinked&&mode==='dual'&&Date.now()>independentZoomUntil)scheduleScroll('target',state);},undefined,'nativeState');
      options.onChangeViewStats=protect(stats=>{if(mode==='original'||mode==='dual'&&scrollLeader==='source')return;const number=view?._iframeWindow?.PDFViewerApplication?.pdfViewer?.currentPageNumber,index=Number.isInteger(number)&&number>=1&&number<=sourcePages.length?number-1:stats.pageIndex,page=sourcePages[index];if(Number.isInteger(page))callReader(source,'_onChangeViewStats',{...stats,pageIndex:page,pagesCount:context.pageCount||context.viewer?.pagesCount||stats.pagesCount});requestAlignment(index);},undefined,'nativeState');
      options.onSetFindState=protect(params=>{
        if(!params?.result)return callReader(source,'_onSetFindState',params);
        // PDF.js fills this annotation after emitting the result. A normal
        // structured clone would freeze the initial undefined value.
        const clonedResult=readerRealm({...params.result});
        // Gecko forbids defining an accessor through a content-object Xray.
        // Waive only this freshly cloned, owned result; never the native result,
        // its parent window, or annotations arriving from the PDF iframe.
        const result=typeof components?.utils?.waiveXrays==='function'?components.utils.waiveXrays(clonedResult):clonedResult;
        Object.defineProperty(result,'annotation',{enumerable:true,get:readerFunction(()=>{
          if(!current(callbackEpoch)||!params.result.annotation)return undefined;
          try{return readerRealm(mapper.toSourceAnnotation(params.result.annotation));}
          // React reads this accessor after the callback's protect() returned.
          // Search must work before precise annotation mapping is available;
          // the explicit save callback keeps its existing strict mapping check.
          catch(error){if(['annotation_mapping','annotation_sentence'].includes(error?.code))return undefined;throw error;}
        })});
        const mapped=readerRealm({...params,result:undefined});mapped.result=result;return source._onSetFindState?.(mapped);
      },undefined,'nativeSearch');
      // Native focusView would focus the hidden original iframe. Keep the parent
      // reader's command target while letting this native iframe retain focus.
      options.onFocus=protect(()=>{activeLane='target';reader._lastViewPrimary=true;},undefined,'nativeFocus');
      options.onSetThumbnails=()=>{};options.onSetOutline=()=>{};
      // Parent Reader updates only _primaryView/_secondaryView after this
      // callback. This additional native view needs its own page-label setter,
      // while its physical source labels must not overwrite the parent array.
      options.onSetPageLabels=protect(()=>callReader(view,'setPageLabels',pageLabels),undefined,'nativeState');
      return options;
    }
    const gestureHandles=new Set();
    function installWheel(candidate){
      const target=candidate._iframeWindow;if(!target?.addEventListener)return;
      const onKey=event=>{if(!visible||view!==candidate||event.defaultPrevented||event.repeat)return;if(event.altKey&&event.shiftKey&&!event.ctrlKey&&!event.metaKey&&event.code==='KeyX'){event.preventDefault();event.stopImmediatePropagation();if(actions.original)actions.original();else showOriginal();}else if(event.key==='Escape'&&!event.ctrlKey&&!event.metaKey){if(readingHandles.some(handle=>handle.clear?.())){event.preventDefault();event.stopImmediatePropagation();return;}event.preventDefault();event.stopImmediatePropagation();actions.exit?.();}};
      target.addEventListener('keydown',onKey,true);viewRemovers.push(()=>target.removeEventListener('keydown',onKey,true));
      const nativeListen=(target,type,callback,settings)=>{const listener=readerFunction(callback),options=readerRealm(settings);Reflect.apply(target.addEventListener,target,[type,listener,options]);return ()=>Reflect.apply(target.removeEventListener,target,[type,listener,options]);};
      viewRemovers.push(nativeListen(target,'pointerdown',closePanels,true));
      const isolateViewport=()=>{if(mode==='dual'&&dualFitPending){cancelInitialDualFit();dualFitDone=true;}independentZoomUntil=Infinity;};
      for(const [candidateView,lane] of [[source,'source'],[candidate,'target']]){for(const type of ['pointerdown','keydown'])viewRemovers.push(nativeListen(candidateView._iframeWindow,type,event=>recordSelectionIntent(lane,event),true));const gestures=PaneGestures?.install(candidateView,{enabled:()=>lane==='source'?(mode==='dual'||mode==='original'):visible,activate:()=>{activeLane=lane;},onZoom:()=>{leadScroll(lane);scrollSync?.reset();isolateViewport();},onPan:()=>{leadScroll(lane);scrollSync?.reset();isolateViewport();},onNormalInput:()=>{mirrorRefreshActivity?.();if(visible)actions.alignmentActivity?.(lane);leadScroll(lane);independentZoomUntil=0;if(lane==='target'&&mode==='dual'&&scrollLinked)actions.readingInput?.();},zoom:payload=>zoomPanes(candidateView,lane,payload),pan:payload=>panPanes(candidateView,lane,payload),listen:nativeListen,invoke:callReader});if(gestures){gestureHandles.add(gestures);viewRemovers.push(()=>{gestures.dispose();gestureHandles.delete(gestures);});}}
    }
    const readingHandles=[];let currentFigureHandle=null;
    function installReading(candidate){
      for(const [candidateView,lane] of [[source,'source'],[candidate,'target']]){
        const handle=ReadingTools?.install(candidateView,{exportCallback:readerFunction,onError:error=>appearance.reportDiagnostic?.('nativeSelection',diagnosticError(error)),getAlignment:()=>displayedAlignment,getLane:()=>lane,getOutputPage:page=>lane==='target'?page:displayedSourcePages.indexOf(page),enabled:()=>lane==='target'?visible:mode==='dual'||mode==='original',onFocus:value=>{if(mode==='dual')for(const other of readingHandles)if(other!==handle){if(value)other.focus?.(value);else other.clear?.(false);}}});
        if(handle){readingHandles.push(handle);viewRemovers.push(()=>{handle.dispose();const index=readingHandles.indexOf(handle);if(index>=0)readingHandles.splice(index,1);});}
      }
      const figureHandle=appearance.installFigureView?.(candidate,()=>!disposed&&visible&&view===candidate&&mode!=='original');
      if(figureHandle){currentFigureHandle=figureHandle;viewRemovers.push(()=>{figureHandle.dispose();if(currentFigureHandle===figureHandle)currentFigureHandle=null;});}
      // The outer inline controller already owns the original pane's hover.
      if(Hover&&typeof appearance.lookupWord==='function'){
        const handle=Hover.install(candidate,{lookup:appearance.lookupWord,reportDiagnostic:appearance.reportDiagnostic,exportCallback:readerFunction,enabled:()=>!disposed&&visible&&view===candidate&&mode!=='original'&&appearance.hoverEnabled?.()!==false});
        hoverHandles.push(handle);viewRemovers.push(()=>{handle.dispose();const index=hoverHandles.indexOf(handle);if(index>=0)hoverHandles.splice(index,1);});
      }
    }
    function warmPages(candidate){
      const target=candidate._iframeWindow,application=target?.PDFViewerApplication,document=application?.pdfDocument,bus=application?.eventBus;
      if(typeof candidate._ensureBasicPageData!=='function'||!Number.isInteger(document?.numPages))return;
      let stopped=false,loading=false,wanted=(application.pdfViewer?.currentPageNumber||1)-1,timer=null,idle=null;const done=new Set();
      const exported=fn=>components?.utils?.exportFunction?components.utils.exportFunction(fn,target):fn;
      const ready=()=>!stopped&&visible&&view===candidate&&mode!=='original'&&target.document?.hidden!==true;
      const cancel=()=>{if(timer!==null)target.clearTimeout(timer);if(idle!==null){if(typeof target.requestIdleCallback==='function')target.cancelIdleCallback?.(idle);else target.clearTimeout(idle);}timer=idle=null;};
      const warm=async()=>{idle=null;if(!ready()||loading||wanted<0||wanted>=document.numPages||done.has(wanted)&&!(mirrorSourcePages.has(displayedSourcePages[wanted])&&!source._pdfPages?.[displayedSourcePages[wanted]]?.chars?.length))return;loading=true;const page=wanted;
        try{
          // Native PDF.js owns drawing/text parsing. Only prepare the current
          // page's selection data after scrolling has stopped.
          if(!done.has(page))await candidate._ensureBasicPageData(page);if(!stopped)done.add(page);const physical=displayedSourcePages[page];if(ready()&&mirrorSourcePages.has(physical)&&!source._pdfPages?.[physical]?.chars?.length&&typeof source._ensureBasicPageData==='function')await callReader(source,'_ensureBasicPageData',physical);if(ready())refreshMirrorPage(physical);
        }catch(_){}finally{loading=false;if(ready()&&wanted!==page)schedule();}
      };
      const schedule=()=>{cancel();if(!ready())return;timer=target.setTimeout(exported(()=>{timer=null;if(!ready())return;const run=exported(()=>{void warm();});idle=typeof target.requestIdleCallback==='function'?target.requestIdleCallback(run):target.setTimeout(run,0);}),600);};
      const onInput=exported(()=>{wanted=(application.pdfViewer?.currentPageNumber||1)-1;schedule();}),onPage=readerFunction(event=>{const page=event?.pageNumber;if(Number.isInteger(page)&&page>=1&&page<=document.numPages){wanted=page-1;schedule();}}),scroll=target.document?.getElementById('viewerContainer');
      target.addEventListener('wheel',onInput,true);scroll?.addEventListener('scroll',onInput,true);
      if(bus?.on&&bus?.off)bus.on('pagechanging',onPage);
      const mirrorSchedule=()=>{const index=(application.pdfViewer?.currentPageNumber||1)-1,physical=displayedSourcePages[index];if(ready()&&mirrorSourcePages.has(physical)&&!source._pdfPages?.[physical]?.chars?.length){wanted=index;schedule();}};mirrorWarmCurrent=mirrorSchedule;viewRemovers.push(()=>{if(mirrorWarmCurrent===mirrorSchedule)mirrorWarmCurrent=null;stopped=true;cancel();target.removeEventListener('wheel',onInput,true);scroll?.removeEventListener('scroll',onInput,true);if(bus?.on&&bus?.off)bus.off('pagechanging',onPage);});
      schedule();
    }
    function installEmbedded(candidate,sourcePages,generation){
      const originalDocument=context.pdfDocument||source._iframeWindow?.PDFViewerApplication?.pdfDocument,bus=candidate._iframeWindow?.PDFViewerApplication?.eventBus;
      if(typeof originalDocument?.getPage!=='function')return;
      async function load(outputPage){
        const physical=sourcePages[outputPage];if(!Number.isInteger(physical)||embedded.has(physical)||embeddedPending.has(physical)||!current(generation))return;
        embeddedPending.add(physical);
        try{
          // Awaiting a reader Promise re-wraps its PDFPageProxy in an Xray.
          // Its JS prototype methods can then appear undefined to the generic
          // callReader helper. Waive only this explicitly requested page proxy
          // and its annotation result, never a reader Window or document.
          const returnedPage=await originalDocument.getPage(physical+1),pdfPage=components?.utils?.waiveXrays?components.utils.waiveXrays(returnedPage):returnedPage;
          if(typeof pdfPage?.getAnnotations!=='function')throw failure();
          const returnedAnnotations=await pdfPage.getAnnotations(readerRealm({intent:'display'})),values=components?.utils?.waiveXrays?components.utils.waiveXrays(returnedAnnotations):returnedAnnotations;
          if(!Array.isArray(values)||values.length>100000)throw failure();if(!current(generation)||view!==candidate)return;
          const result=[];
          for(let index=0;index<values.length;index++){
            const annotation=values[index],type=annotation.subtype==='Highlight'?'highlight':annotation.subtype==='Underline'?'underline':null;if(!type)continue;
            const points=Array.from(annotation.quadPoints||[]),rects=[];
            if(points.length&&points.length%8===0)for(let offset=0;offset<points.length;offset+=8){const chunk=points.slice(offset,offset+8);rects.push([Math.min(chunk[0],chunk[2],chunk[4],chunk[6]),Math.min(chunk[1],chunk[3],chunk[5],chunk[7]),Math.max(chunk[0],chunk[2],chunk[4],chunk[6]),Math.max(chunk[1],chunk[3],chunk[5],chunk[7])]);}
            else if(rect(annotation.rect))rects.push(Array.from(annotation.rect));
            if(!rects.length||!rects.every(rect))continue;
            const color=Array.from(annotation.color||[255,212,0]).slice(0,3),rgb=color.map(value=>Math.max(0,Math.min(255,Math.round(value)))).map(value=>value.toString(16).padStart(2,'0')).join('');
            const sourceParagraph=mapper&&mapper.toOutputLocation({pageIndex:physical});if(!sourceParagraph)continue;
            result.push({id:'ASKGPT_EMBED_'+physical+'_'+index,type,color:'#'+rgb,text:'',comment:typeof annotation.contentsObj?.str==='string'?annotation.contentsObj.str:'',tags:[],authorName:typeof annotation.titleObj?.str==='string'?annotation.titleObj.str:'',pageLabel:source._getPageLabel?.(physical,true)||String(physical+1),position:{pageIndex:physical,rects},sortIndex:String(physical).padStart(5,'0')+'|000000|00000',readOnly:true,isExternal:true});
          }
          embedded.set(physical,result);if(result.length){callReader(candidate,'setAnnotations',projectForDisplay(annotations(),[physical]));refreshAnnotationMirrors([physical]);}
        }catch(error){if(current(generation)){setStatus('原 PDF 标注未载入，可切回原文查看');appearance.reportDiagnostic?.('nativeEmbedded',error);}}finally{embeddedPending.delete(physical);}
      }
      const onPage=event=>{if(Number.isInteger(event?.pageNumber))void load(event.pageNumber-1);};
      if(bus?.on&&bus?.off){bus.on('pagerendered',onPage);viewRemovers.push(()=>bus.off('pagerendered',onPage));}
      void load((candidate._iframeWindow?.PDFViewerApplication?.pdfViewer?.currentPageNumber||1)-1);
    }
    async function showOutput(bytes,sourcePages,nextMode,alignment,options={}){
      clearHover();
      if(disposed||!['mono','dual'].includes(nextMode))throw failure();desiredMode=nextMode;
      const timing=beginLoad(),previousLayouts=new Map([...validatedPages].map(([page,entry])=>[page,entry.layoutKey]));const geometryOnly=alignment===null&&options?.geometryOnly===true;let validated;try{if(geometryOnly)createGeometryMapper(sourcePages,source,()=>view);validated=geometryOnly?null:acceptAlignment(alignment,sourcePages,Boolean(view&&displayedBytes===bytes));}catch(error){finishLoad(timing);throw error;}const physicalOnly=geometryOnly||validated?.provenance==='pdf-glyph-candidates',previousPages=new Map((displayedAlignment?.pages||[]).map(page=>[page.sourcePage,page])),sameOutput=view&&displayedBytes===bytes&&JSON.stringify(sourcePages)===JSON.stringify(displayedSourcePages)&&(displayedGeometryOnly||geometryOnly||validated?.targetSHA256===displayedAlignment?.targetSHA256&&validated?.provenance===displayedAlignment?.provenance&&validated?.recoveryRevision===displayedAlignment?.recoveryRevision);for(const page of validated?.pages||[])if(!sameOutput||previousPages.get(page.sourcePage)!==page&&(validated.sourceSHA256!==displayedAlignment?.sourceSHA256||validated.targetSHA256!==displayedAlignment?.targetSHA256||validated.provenance!==displayedAlignment?.provenance||page.paragraphs.some(row=>row.sentences!==undefined)||previousLayouts.get(page.sourcePage)!==validatedPages.get(page.sourcePage).layoutKey))pageEvidenceKeys.set(page.sourcePage,validatedPages.get(page.sourcePage).stamp);displayedGeometryOnly=geometryOnly;ensureTranslatedManager();
      // Capture before removing/restyling either iframe. A mono translation
      // owns its mapped reading position while the hidden original stays put.
      const sourceOwns=!view||!visible||mode==='original'||mode==='dual'&&activeLane==='source',readingState=sourceOwns?snapshotSourceState():copy(sourceState);
      if(sameOutput){
        geometryOpening=null;mapper=geometryOnly?createGeometryMapper(sourcePages,source,()=>view,{invoke:callReader,unwrapPage:page=>components?.utils?.waiveXrays?components.utils.waiveXrays(page):page}):createMapper(validated,'mono',source,()=>view,selectionWords,mapperOptions);displayedAlignment=validated;const moved=mode==='original'||sourceMoved;sourceState=readingState;layoutPanes(nextMode);if(moved){navigateNative(view,mapper.toOutputState(sourceState));sourceMoved=false;}setProgress(null);setStatus('');finishLoad(timing);appearance.reportDiagnostic?.('nativeReused');requestAlignment((view._iframeWindow?.PDFViewerApplication?.pdfViewer?.currentPageNumber||1)-1);return;
      }
      const generation=++epoch;showSource();removeView();selectionLinkPages.clear();selectionBinding=null;mapper=geometryOnly?createGeometryMapper(sourcePages,source,()=>view,{invoke:callReader,unwrapPage:page=>components?.utils?.waiveXrays?components.utils.waiveXrays(page):page}):createMapper(validated,'mono',source,()=>view,selectionWords,mapperOptions);mode=nextMode;displayedAlignment=validated;displayedSourcePages=sourcePages.slice();requestedAlignmentPages=new Set();setAnnotationStatus(null);sourceState=readingState;if(physicalOnly){geometryOpening={epoch:generation,state:copy(readingState),sourceChanged:false};activeLane='source';leadScroll('source',true);}
      // Gecko may suspend painting a fully occluded iframe. Establish its real
      // mono/dual viewport before construction, without navigating or fitting.
      layoutViewport(nextMode);
      let candidate;
      try{const options=readerRealm(makeOptions(bytes,sourcePages));candidate=constructNative(options);view=candidate;appearance.reportDiagnostic?.('nativeConstructed');await initialized(candidate.initializedPromise,'nativeInitialize',readerWindow,()=>queueNativePaint(candidate));if(!current(generation)){if(view===candidate)removeView();else retireNative(candidate);return;}removeResourceListeners(nativeResources.get(candidate),'parent');appearance.reportDiagnostic?.('nativeInitialized');if(!candidate._iframeWindow?.PDFViewerApplication?.pdfDocument||physicalOnly&&candidate._iframeWindow.PDFViewerApplication.pdfDocument.numPages!==sourcePages.length)throw failure();
        queueNativePaint(candidate);const rendered=candidate._iframeWindow.PDFViewerApplication.pdfViewer?.onePageRendered;if(rendered)await initialized(rendered,'nativePaint',candidate._iframeWindow,()=>queueNativePaint(candidate));if(!current(generation))return;appearance.reportDiagnostic?.('nativePainted');
        setReaderTool({type:'pointer'});toolOverride=true;syncTools(candidate,{type:'pointer'});callReader(candidate,'setAnnotations',projectForDisplay());callReader(candidate,'setTool',{type:'pointer'});callReader(candidate,'setSelectedAnnotationIDs',copy(reader._state?.selectedAnnotationIDs||[]));displayedBytes=bytes;if(physicalOnly)restoreGeometryOpening(candidate,generation);else{activeLane='target';leadScroll('target');}layoutPanes(desiredMode==='original'?nextMode:desiredMode);installWheel(candidate);installReading(candidate);installMirrorPages(candidate,generation);installEmbedded(candidate,sourcePages,generation);installGeometrySync(candidate,generation);warmPages(candidate);if(desiredMode==='original')showOriginal();setProgress(null);setStatus('');finishLoad(timing);appearance.reportDiagnostic?.('nativeReady',toolbarSnapshot());requestAlignment((candidate._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber||1)-1);
      }catch(error){finishLoad(timing);if(current(generation)){showSource();removeView();}throw error;}
    }
    const result={host,frame:host,doc,body:viewport,header,menu,statusBar,figurePanel,setScrollLinked,jumpFigure,get scrollLinked(){return scrollLinked;},attachToolbar,get visible(){return visible;},get nativeView(){return view;},get figureHandle(){return currentFigureHandle;},get currentSourcePage(){const candidate=mode==='dual'&&activeLane==='source'||!visible?source:view,number=candidate?._iframeWindow?.PDFViewerApplication?.pdfViewer?.currentPageNumber;return Number.isInteger(number)?candidate===source?number-1:displayedSourcePages[number-1]:sourceState.pageIndex;},setStatus,setProgress,setAlignmentProgress,setAnnotationStatus,
      updateSelectionLinks,
      hasExactSelection(){const popup=selectionLane==='source'?rawSourceSelectionPopup:rawSelectionPopup;return Boolean(popup?.annotation&&linkSelection(popup,selectionLane));},
      retrySelection(options={}){const popup=selectionLane==='source'?rawSourceSelectionPopup:rawSelectionPopup;if(!visible||!popup?.annotation)return false;if(options.retry!==false){const position=popup.annotation.position,physical=selectionLane==='source'?position.pageIndex:displayedSourcePages[position.pageIndex];mapper.invalidateNativePages([physical,...(position.nextPageRects?[physical+1]:[])]);linkedSelection=null;if(linkSelection(popup,selectionLane)){setAnnotationStatus(null);return true;}}requestSelectionAlignment(popup.annotation,selectionLane,{retry:options.retry!==false});return true;},
      updateAlignment(value,options={}){if(disposed||!view||displayedGeometryOnly||!displayedSourcePages.length)return false;const timing=beginLoad();try{if(options.pages!==undefined&&(!Array.isArray(options.pages)||options.pages.some(page=>!Number.isInteger(page)||!displayedSourcePages.includes(page))))throw failure();const previous=new Map(displayedAlignment.pages.map(page=>[page.sourcePage,page])),previousLayouts=new Map([...validatedPages].map(([page,entry])=>[page,entry.layoutKey])),validated=acceptAlignment(value,displayedSourcePages,true),differentDocument=validated.sourceSHA256!==displayedAlignment.sourceSHA256||validated.targetSHA256!==displayedAlignment.targetSHA256||validated.provenance!==displayedAlignment.provenance||validated.recoveryRevision!==displayedAlignment.recoveryRevision,changed=validated.pages.filter(page=>previous.get(page.sourcePage)!==page&&(differentDocument||!options.pages||options.pages.includes(page.sourcePage)||page.paragraphs.some(row=>row.sentences!==undefined)||previousLayouts.get(page.sourcePage)!==validatedPages.get(page.sourcePage).layoutKey)).map(page=>page.sourcePage),sameMetadata=JSON.stringify({...validated,pages:undefined})===JSON.stringify({...displayedAlignment,pages:undefined});for(const page of changed)pageEvidenceKeys.set(page,validatedPages.get(page).stamp);if(changed.length||!sameMetadata){mapper=createMapper(validated,'mono',source,()=>view,selectionWords,mapperOptions);displayedAlignment=validated;}const projected=projectForDisplay(annotations(),changed.length?changed:null);if(JSON.stringify(projected)!==JSON.stringify(view._annotations))callReader(view,'setAnnotations',projected);refreshAnnotationMirrors(changed.length?changed:null);setAnnotationStatus(null);if(selectionLane==='target')linkSelection(rawSelectionPopup,'target');else linkSelection(rawSourceSelectionPopup,'source');return true;}finally{finishLoad(timing);}},
      clearHover,refreshHover,prepareOutput(){clearHover();setStatus('');warmFigures();},showOutput,showOriginal,
      restoreOriginal(){epoch++;showSource();removeView();setProgress(null);},
      dispose(){if(disposed)return;setAlignmentProgress(null);disposed=true;epoch++;showSource();scrollSync?.dispose();removeView();validatedPages.clear();pageEvidenceKeys.clear();loadTiming=null;figureScanner?.cancel();figurePanel?.dispose();for(const remove of removers.splice(0))remove();for(const restore of hooks.reverse())restore();if(sourceLookupArray&&reader._annotationManager?._annotations===sourceLookupArray){const array=components?.utils?.waiveXrays?components.utils.waiveXrays(sourceLookupArray):sourceLookupArray;if(array.find===sourceLookupFind)delete array.find;}host.remove();header.remove();menu.remove();statusBar.remove();style.remove();}
    };
    attachToolbar();
    appearance.setCancel?.(()=>result.dispose());return result;
  }
  const api={validateAlignment,createMapper,createGeometryMapper,canMount,mount,canonicalID};root.AskGPTPDFNativeView=api;if(typeof module!=='undefined')module.exports=api;
})(this);
