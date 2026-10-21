(function(root){
  'use strict';
  const Layout=root.AskGPTPDFLayout||(typeof require==='function'?require('./pdf-layout.js'):null);
  const PaneGestures=root.AskGPTPDFPaneGestures||(typeof require==='function'?require('./pdf-pane-gestures.js'):null);
  const ScrollSync=root.AskGPTPDFScrollSync||(typeof require==='function'?require('./pdf-scroll-sync.js'):null);
  const ReadingTools=root.AskGPTPDFReadingTools||(typeof require==='function'?(()=>{try{return require('./pdf-reading-tools.js');}catch(_){return null;}})():null);
  const SelectionLink=root.AskGPTPDFSelectionLink||(typeof require==='function'?require('./pdf-selection-link.js'):null);
  const FigureNavigation=root.AskGPTPDFFigureNavigation||(typeof require==='function'?require('./pdf-figure-navigation.js'):null);
  const FigurePanel=root.AskGPTPDFFigurePanel||(typeof require==='function'?require('./pdf-figure-panel.js'):null);
  const XHTML='http://www.w3.org/1999/xhtml',ORIGINAL_SUFFIX='__askgptOriginal';
  let controlsSequence=0;
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
  function validatePhraseData(sentence,page,fail){
    if(Array.isArray(sentence.phrases)&&!sentence.phrases.length&&sentence.source.glyphs===undefined&&sentence.target.glyphs===undefined)return;
    const pools={};
    for(const side of ['source','target']){
      const part=sentence[side],glyphs=part.glyphs;
      if(!Array.isArray(glyphs)||glyphs.length>100000||glyphs.some(g=>!g||typeof g.text!=='string'||!g.text.length||g.text.length>256||!(g.line==null||Number.isInteger(g.line)&&g.line>=0)||!(g.rect===null?!meaningful(g):rect(g.rect))))return fail();
      if(glyphText(glyphs.map(g=>g.text).join(''))!==glyphText(part.text))return fail();
      const map=new Map();for(const g of glyphs){if(!meaningful(g))continue;const key=glyphKey(g);if(map.has(key))return fail();map.set(key,g);}pools[side]=map;
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
        const positions=new Map([...pools[side].keys()].map((key,index)=>[key,index])),indices=glyphs.filter(meaningful).map(g=>positions.get(glyphKey(g)));
        if(indices.some((index,i)=>index!==indices[0]+i))return fail();
        const runs=[];for(const glyph of glyphs){if(!glyph.rect)continue;const previous=runs.at(-1);if(previous&&previous.line===glyph.line){const r=previous.rect;r[0]=Math.min(r[0],glyph.rect[0]);r[1]=Math.min(r[1],glyph.rect[1]);r[2]=Math.max(r[2],glyph.rect[2]);r[3]=Math.max(r[3],glyph.rect[3]);}else runs.push({line:glyph.line,rect:glyph.rect.slice()});}
        if(runs.length!==part.rects.length||runs.some((run,i)=>run.rect.some((n,j)=>Math.abs(n-part.rects[i][j])>.02+1e-9)))return fail();
        const dual=phrase[side==='source'?'dualSource':'dualTarget'];if(!dual||!Array.isArray(dual.rects)||dual.rects.length!==part.rects.length||!dual.rects.every(rect))return fail();
        const matrix=side==='source'?page.sourceToDual:page.targetToDual;if(!part.rects.every((r,i)=>transformRect(matrix,r).every((n,j)=>Math.abs(n-dual.rects[i][j])<=.02+1e-9)))return fail();
      }
      if(phrase.method==='glyph-identity'&&!unchangedGlyphs(phrase.source,phrase.target))return fail();
    }
  }
  function validateAlignment(value,sourcePages){
    if(value?.schema!==1||value.coordinateSpace!=='pdf'||!['paragraph','sentence'].includes(value.granularity)||!Array.isArray(value.pages)||!value.pages.length||value.pages.length>2000||!Array.isArray(sourcePages)||value.pages.length!==sourcePages.length)throw failure();
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
    const seen=new Set();
    for(let index=0;index<value.pages.length;index++){
      const page=value.pages[index];
      if(!Number.isInteger(page?.sourcePage)||page.sourcePage<0||page.sourcePage>1999||page.sourcePage!==sourcePages[index]||page.outputPage!==index||seen.has(page.sourcePage)||![page.source,page.mono,page.dual].every(geometry)||!matrix(page.sourceToDual)||!matrix(page.targetToDual)||!Array.isArray(page.paragraphs))throw failure();
      seen.add(page.sourcePage);paragraphs+=page.paragraphs.length;if(paragraphs>50000)throw failure();
      const ids=new Set();
      for(const paragraph of page.paragraphs){
        if(typeof paragraph?.id!=='string'||!paragraph.id||paragraph.id.length>160||ids.has(paragraph.id))throw failure();ids.add(paragraph.id);
        validateParts(paragraph);
        if(paragraph.sentences!==undefined){if(!semantic||!presentPages.includes(page.sourcePage)||!Array.isArray(paragraph.sentences)||paragraph.sentences.length>1000)throw failure();sentences+=paragraph.sentences.length;if(sentences>200000)throw failure();const sentenceIDs=new Set();for(const sentence of paragraph.sentences){if(typeof sentence?.id!=='string'||!sentence.id||sentence.id.length>256||sentenceIDs.has(sentence.id)||!['semantic-model','glyph-identity'].includes(sentence.method))throw failure();sentenceIDs.add(sentence.id);validateParts(sentence);if(sentence.method==='glyph-identity'&&!unchangedGlyphs(sentence.source,sentence.target))throw failure();if(sentence.phrases!==undefined){if(!precise||!phrasePages.includes(page.sourcePage))throw failure();validatePhraseData(sentence,page,()=>{throw failure();});}}}
      }
    }
    return copy(value);
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
  function createMapper(alignment,mode,sourceView,targetView,selectionLinks=()=>[]){
    const pages=alignment.pages,bySource=new Map(pages.map(page=>[page.sourcePage,page]));
    const sentences=page=>page.paragraphs.flatMap(paragraph=>paragraph.sentences||[]);
    const nativeGlyphRect=value=>{if(!Array.isArray(value)||value.length!==4)return null;const local=[value[0],value[1],value[2],value[3]];return rect(local)?local:null;};
    const spatial=page=>{if(!equalGeometry(page.source,page.mono))throw failure();};
    function spatialMapping(page,position,type,from,to){
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
      const chars=sourceView?._pdfPages?.[position.pageIndex]?.chars||[];
      if(topRect)for(let index=0;index<chars.length;index++){const r=chars[index].rect;if(!Array.isArray(r))continue;const distance=Math.max(r[0]-topRect[2],topRect[0]-r[2],0)**2+Math.max(r[1]-topRect[3],topRect[1]-r[3],0)**2;if(distance<best){best=distance;offset=index;}}
      const top=topRect&&page?Math.max(0,page.source.mediaBox[3]-page.source.mediaBox[1]-topRect[3]):0;
      return [String(position.pageIndex).padStart(5,'0'),String(offset).padStart(6,'0'),String(Math.floor(top)).padStart(5,'0')].join('|');
    }
    function directText(page,position,from){
      const independent=selectionLinks(page.sourcePage)||[],to=from==='source'?'target':'source';if(!independent.length)return null;const links=[...independent,...sentences(page).flatMap(row=>row.phrases||[])];
      const candidates=links.filter(link=>link[from]?.rects?.some(r=>position.rects.some(s=>intersects(r,s))));if(!candidates.length)return null;
      const pool=[...new Map(candidates.flatMap(link=>link[from].glyphs.filter(meaningful)).map(g=>[glyphKey(g),g])).values()].sort((a,b)=>(a.line??0)-(b.line??0)||b.rect[3]-a.rect[3]||a.rect[0]-b.rect[0]),selected=new Map();
      const active=typeof targetView==='function'?targetView():targetView,native=from==='source'?sourceView:active,chars=native?._pdfPages?.[from==='source'?page.sourcePage:page.outputPage]?.chars;
      if(chars?.length){for(let i=0;i<chars.length;i++){const char=chars[i],local=nativeGlyphRect(char.rect),r=from==='target'&&mode==='dual'&&local?transformRect(invert(page.targetToDual),local):local;if(typeof char.c!=='string'||!glyphText(char.c)||!r||!position.rects.some(s=>centerIn(r,s)))continue;const matches=pool.filter(g=>glyphText(g.text)===glyphText(char.c)&&Math.abs((g.rect[0]+g.rect[2]-r[0]-r[2])/2)<=1&&intersects(g.rect,r));if(matches.length!==1)return null;selected.set(glyphKey(matches[0]),matches[0]);}}
      else for(const glyph of pool)if(position.rects.some(r=>centerIn(glyph.rect,r)))selected.set(glyphKey(glyph),glyph);
      if(!selected.size)return null;
      const lexical=/^[\p{Script=Latin}\p{M}\p{N}]+(?:[-'’][\p{Script=Latin}\p{M}\p{N}]+)*$/u,atomic=link=>link.sourceTokenCount<=16&&link.targetTokenCount<=16&&(link.sourceTokenCount===1&&/\p{Script=Latin}/u.test(link.source.text)&&lexical.test(link.source.text.trim())||link.targetTokenCount===1&&/\p{Script=Latin}/u.test(link.target.text)&&lexical.test(link.target.text.trim()));
      const eligible=candidates.filter(link=>{const keys=link[from].glyphs.filter(meaningful).map(glyphKey);return keys.some(key=>selected.has(key))&&(keys.every(key=>selected.has(key))||atomic(link));});
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
    function exactText(page,position,from,knownOnly=false){
      const direct=directText(page,position,from);if(direct)return direct;
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
      const active=typeof targetView==='function'?targetView():targetView,native=from==='source'?sourceView:active,chars=native?._pdfPages?.[from==='source'?page.sourcePage:page.outputPage]?.chars;
      if(chars&&chars.length){
        for(let i=0;i<chars.length;i++){
          const char=chars[i],localRect=nativeGlyphRect(char.rect),nativeRect=from==='target'&&mode==='dual'&&localRect?transformRect(invert(page.targetToDual),localRect):localRect;
          if(typeof char.c!=='string'||!glyphText(char.c)||!rect(nativeRect)||!position.rects.some(r=>centerIn(nativeRect,r)))continue;
          const candidates=pool.filter(g=>glyphText(g.text)===glyphText(char.c)&&Math.abs((g.rect[0]+g.rect[2]-nativeRect[0]-nativeRect[2])/2)<=1&&intersects(g.rect,nativeRect));
          if(candidates.length!==1){if(knownOnly)continue;reject('native_glyph');}selected.set(glyphKey(candidates[0]),candidates[0]);
        }
      }else {if(!knownOnly&&matched.some(row=>!row[from].glyphs?.length))reject('no_phrases');for(const glyph of pool)if(position.rects.some(r=>centerIn(glyph.rect,r)))selected.set(glyphKey(glyph),glyph);}
      if(!selected.size)reject('native_glyph');
      const owners=new Map();for(const unit of units)for(const glyph of unit[from].glyphs.filter(meaningful)){const key=glyphKey(glyph);if(owners.has(key))reject('unowned_glyph');owners.set(key,unit);}
      const chosen=new Set();for(const key of selected.keys()){const unit=owners.get(key);if(!unit){if(knownOnly)continue;reject('unowned_glyph');}chosen.add(unit);}
      const to=from==='source'?'target':'source',lexical=/^[\p{Script=Latin}\p{M}\p{N}]+(?:[-'’][\p{Script=Latin}\p{M}\p{N}]+)*$/u,latinWord=text=>/\p{Script=Latin}/u.test(text)&&lexical.test(text.trim());
      let partial=false;
      for(const unit of chosen){const all=unit[from].glyphs.filter(meaningful).every(g=>selected.has(glyphKey(g))),atomic=unit.sourceTokenCount<=16&&unit.targetTokenCount<=16&&(unit.sourceTokenCount===1&&latinWord(unit.source.text)||unit.targetTokenCount===1&&latinWord(unit.target.text));if(!all&&!atomic){if(knownOnly){chosen.delete(unit);continue;}reject('partial_phrase');}partial||=!all;}
      if(!chosen.size)reject('unowned_glyph');
      const ordered=[...chosen].sort((a,b)=>{const at=pool.findIndex(g=>glyphKey(g)===glyphKey(a[from].glyphs.find(meaningful))),bt=pool.findIndex(g=>glyphKey(g)===glyphKey(b[from].glyphs.find(meaningful)));return at-bt;});
      // Preserve original reading order even when the translated clauses reorder.
      const destinationPool=rows.flatMap(row=>row[to].glyphs||[]),rank=unit=>destinationPool.findIndex(g=>glyphKey(g)===glyphKey(unit[to].glyphs.find(meaningful)));ordered.sort((a,b)=>rank(a)-rank(b));
      let text='';for(let i=0;i<ordered.length;i++){const unit=ordered[i];if(i){const previous=ordered[i-1],end=destinationPool.findIndex(g=>glyphKey(g)===glyphKey(previous[to].glyphs.filter(meaningful).at(-1))),start=rank(unit),between=destinationPool.slice(end+1,start);text+=rows.find(row=>row.phrases?.includes(previous))!==rows.find(row=>row.phrases?.includes(unit))?'\n':start>end&&between.every(g=>!meaningful(g))?between.map(g=>g.text).join(''):' ';}text+=unit[to].text;}
      return {rects:ordered.flatMap(unit=>copy(unit[to].rects)),text,partial,selectedGlyphs:copy(pool.filter(glyph=>selected.has(glyphKey(glyph))))};
    }
    function mapPart(position,type){
      const page=pages[position.pageIndex];if(!page)throw failure();
      const side=lane(page,position),m=mode==='dual'?invert(side==='source'?page.sourceToDual:page.targetToDual):identity;
      if(side==='source'){const mapped=transformPosition(position,m);mapped.pageIndex=page.sourcePage;return {position:mapped,text:null,translated:false};}
      if(['highlight','underline'].includes(type)){
        if(!Array.isArray(position.rects)||!position.rects.length||!position.rects.every(rect))throw failure();
        const mono=transformPosition(position,m),mapped=exactText(page,mono,'target');
        return {position:{pageIndex:page.sourcePage,rects:mapped.rects},text:mapped.text,translated:!mapped.identity,
          selection:{sourcePage:page.sourcePage,rects:copy(mono.rects),mapped}};
      }
      spatial(page);let mapped=transformPosition(position,m);mapped=spatialMapping(page,mapped,type,'target','source');mapped.pageIndex=page.sourcePage;return {position:mapped,text:null,translated:false};
    }
    function toSourceAnnotation(annotation){
      annotation=copy(annotation);
      if(!annotation?.position||!Number.isInteger(annotation.position.pageIndex))throw failure();
      const result=copy(annotation);result.id=canonicalID(result.id);
      const first=mapPart({...annotation.position,nextPageRects:undefined},annotation.type);result.position=first.position;
      delete result.position._askgptSelection;
      const selectedParts=[first.selection];
      let translated=first.translated,text=first.text;
      if(annotation.position.nextPageRects){
        const next=mapPart({pageIndex:annotation.position.pageIndex+1,rects:annotation.position.nextPageRects},annotation.type);
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
        const matches=page.paragraphs.filter(p=>p[side].rects.some(r=>position.rects.some(s=>intersects(r,s))));if(matches.length!==1||!/^[A-Za-z0-9_-]{1,64}$/.test(matches[0].id)||position.rects.some(r=>!coveredByRects(r,matches[0][side].rects)))return null;
        const active=typeof targetView==='function'?targetView():targetView,native=side==='source'?sourceView:active,chars=native?._pdfPages?.[side==='source'?page.sourcePage:page.outputPage]?.chars;if(!chars?.length)return null;
        let text='';for(let i=0;i<chars.length;i++){const char=chars[i],local=nativeGlyphRect(char.rect),r=side==='target'&&mode==='dual'&&local?transformRect(invert(page.targetToDual),local):local;if(typeof char.c==='string'&&r&&position.rects.some(s=>centerIn(r,s)))text+=char.c;}
        if(glyphText(text)!==glyphText(annotation.text))return null;
        return {page:page.sourcePage,paragraph:matches[0].id,side,rects:copy(position.rects),text:annotation.text};
      }catch(_){return null;}
    }
    function projectPart(position,type,side,evidence){
      const page=bySource.get(position.pageIndex);if(!page)return null;
      if(side==='source'){const result={...transformPosition(position,page.sourceToDual),pageIndex:page.outputPage};delete result.nextPageRects;return result;}
      let result;
      if(['highlight','underline'].includes(type)){
        let mapped;try{mapped=exactText(page,position,'source',true);}catch(_){return null;}if(evidence)evidence.mapped=mapped;
        result={...copy(position),pageIndex:page.outputPage,rects:mapped.rects.map(r=>mode==='dual'?transformRect(page.targetToDual,r):r)};delete result.nextPageRects;
      }else{
        try{spatial(page);const mapped=spatialMapping(page,position,type,'source','target');result={...transformPosition(mapped,mode==='dual'?page.targetToDual:identity),pageIndex:page.outputPage};delete result.nextPageRects;}catch(_){return null;}
      }
      return result;
    }
    function projectAnnotation(annotation,side='target'){
      annotation=copy(annotation);
      if(side==='target'&&['highlight','underline'].includes(annotation?.type)&&annotation.position?._askgptSelection!==undefined){
        const restored=restoreAuthoredSelection(annotation);if(!restored)return null;
        return {...copy(annotation),position:restored.position,text:restored.text,id:canonicalID(annotation.id)};
      }
      if(!annotation?.position)return null;const result=copy(annotation),evidence={},position=projectPart(annotation.position,annotation.type,side,evidence);if(!position)return null;
      result.position=position;result.id=canonicalID(result.id)+(side==='source'?ORIGINAL_SUFFIX:'');
      if(annotation.position.nextPageRects){const next=projectPart({pageIndex:annotation.position.pageIndex+1,rects:annotation.position.nextPageRects},annotation.type,side);if(next?.pageIndex===position.pageIndex+1)position.nextPageRects=next.rects;}
      if(side==='target'&&['highlight','underline'].includes(annotation.type)){
        const page=bySource.get(annotation.position.pageIndex),mapped=evidence.mapped||exactText(page,annotation.position,'source',true);if(!mapped.identity)result.text=mapped.text;
      }
      return result;
    }
    function projectAnnotations(annotations){return (annotations||[]).filter(annotation=>!annotation._hidden).flatMap(annotation=>[projectAnnotation(annotation),mode==='dual'?projectAnnotation(annotation,'source'):null].filter(Boolean));}
    function mapPoint(page,side,x,y,toSource){
      const key=mode==='dual'?(side==='source'?'dualSource':'dualTarget'):'target';
      if(side==='target'){
        const from=toSource?key:'source',to=toSource?'source':key;
        const paragraph=page.paragraphs.find(paragraph=>paragraph[from].rects.some(r=>x>=r[0]&&x<=r[2]&&y>=r[1]&&y<=r[3]));
        if(paragraph)return point(paragraphMatrix(paragraph,from,to),x,y);
      }
      if(mode==='dual')return point(toSource?invert(side==='source'?page.sourceToDual:page.targetToDual):side==='source'?page.sourceToDual:page.targetToDual,x,y);
      spatial(page);return [x,y];
    }
    function toSourceState(state,previous={}){
      const page=pages[state?.pageIndex];if(!page)throw failure();
      const x=finite(state.left)?state.left:page.mono.cropBox[0],y=finite(state.top)?state.top:page.mono.cropBox[3];
      let side='target';if(mode==='dual'){const sourceBox=transformRect(page.sourceToDual,page.source.cropBox);if(x<=sourceBox[2]&&x>=sourceBox[0])side='source';}
      const [left,top]=mapPoint(page,side,x,y,true);
      // Keep the source's zoom/mode. A wider bilingual page has another scale.
      return {...copy(previous),pageIndex:page.sourcePage,left,top};
    }
    function toOutputLocation(location){
      if(!location)return location;const result=copy(location);
      if(result.annotationID)result.annotationID=canonicalID(result.annotationID);
      if(result.position){result.position=projectPart(result.position,'note','target');if(!result.position)return null;}
      else if(Number.isInteger(result.pageIndex)){const page=bySource.get(result.pageIndex);if(!page)return null;result.pageIndex=page.outputPage;}
      else if(Array.isArray(result.dest)&&Number.isInteger(result.dest[0])){const page=bySource.get(result.dest[0]);if(!page)return null;result.dest[0]=page.outputPage;}
      return result;
    }
    function toOutputState(state){const page=bySource.get(state.pageIndex)||pages[0],x=finite(state.left)?state.left:page.source.cropBox[0],y=finite(state.top)?state.top:page.source.cropBox[3],[left,top]=mapPoint(page,'target',x,y,false);return {...copy(state),pageIndex:page.outputPage,left,top,scale:mode==='dual'?'page-width':state.scale};}
    // Scrolling follows physical page geometry continuously. Paragraph anchors
    // are for explicit semantic navigation, never for a moving viewport edge.
    function viewportState(state,toSource){
      const page=toSource?pages[state?.pageIndex]:bySource.get(state?.pageIndex);if(!page)return null;
      const box=toSource?(mode==='dual'?page.dual:page.mono).cropBox:page.source.cropBox,x=finite(state.left)?state.left:box[0],y=finite(state.top)?state.top:box[3];
      let coordinates;if(mode==='dual')coordinates=point(toSource?invert(page.targetToDual):page.targetToDual,x,y);else{spatial(page);coordinates=[x,y];}
      return {pageIndex:toSource?page.sourcePage:page.outputPage,left:coordinates[0],top:coordinates[1]};
    }
    const toSourceViewportState=state=>viewportState(state,true),toOutputViewportState=state=>viewportState(state,false);
    return {toSourceAnnotation,projectAnnotation,projectAnnotations,hasExactSourceSelection,selectionUnits,selectionRequest,toSourceState,toSourceViewportState,toOutputViewportState,toOutputLocation,toOutputState,canonicalID,annotationSide:annotation=>lane(pages[annotation.position.pageIndex],annotation.position)};
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
    const host=element(doc,'div','askgpt-native-pdf'),header=element(doc,'header','askgpt-native-controls'),viewport=element(doc,'div','askgpt-native-viewport'),status=element(doc,'span','askgpt-native-status'),progress=element(doc,'span','askgpt-native-progress'),label=element(doc,'span'),bar=element(doc,'progress'),menu=element(doc,'div','askgpt-native-menu'),menuItems=[];let moreButton;
    header.setAttribute('role','toolbar');header.setAttribute('aria-label','Translation controls');menu.setAttribute('role','menu');menu.setAttribute('aria-label','Translation options');menu.setAttribute('id','askgpt-native-menu-'+(++controlsSequence));menu.hidden=true;status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const annotationSlot=element(doc,'span','askgpt-native-annotation-state'),annotationIndicator=element(doc,'span','askgpt-native-annotation-indicator'),annotationSpinner=element(doc,'span','askgpt-native-annotation-spinner'),annotationHint=element(doc,'span','askgpt-native-annotation-hint'),annotationIcon=doc.createElementNS('http://www.w3.org/2000/svg','svg'),annotationPath=doc.createElementNS('http://www.w3.org/2000/svg','path');
    annotationIcon.setAttribute('class','askgpt-native-annotation-icon');annotationIcon.setAttribute('viewBox','0 0 16 16');annotationIcon.setAttribute('aria-hidden','true');annotationPath.setAttribute('d','M5 2.5h6A1.5 1.5 0 0 1 12.5 4v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 12V4A1.5 1.5 0 0 1 5 2.5ZM6 6h4M6 8.5h4M6 11h2');annotationIcon.appendChild(annotationPath);annotationSpinner.setAttribute('aria-hidden','true');annotationIndicator.setAttribute('role','status');annotationIndicator.setAttribute('aria-live','polite');annotationIndicator.setAttribute('tabindex','0');annotationHint.setAttribute('role','status');annotationHint.hidden=true;annotationIndicator.append(annotationIcon,annotationSpinner);annotationSlot.append(annotationIndicator,annotationHint);
    host.setAttribute('style','position:absolute;inset:0;z-index:10;visibility:hidden;background:Canvas');viewport.setAttribute('style','position:absolute;inset:0');host.style.setProperty('visibility','hidden');
    const style=element(doc,'style',null,`.askgpt-native-pdf{color-scheme:light dark}.askgpt-native-viewport>iframe{width:100%;height:100%;border:0}.askgpt-native-controls{position:static;display:inline-flex;align-items:center;gap:2px;flex:none;height:28px;max-width:100%;min-width:0;white-space:nowrap;color:var(--fill-secondary,CanvasText);font:12px -apple-system,sans-serif;-moz-window-dragging:no-drag}.askgpt-native-controls button,.askgpt-native-menu button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:auto;min-width:28px;height:26px;padding:3px 6px;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;cursor:default;-moz-window-dragging:no-drag}.askgpt-native-controls button[aria-pressed=true]{background:var(--fill-quarternary,#8882);color:var(--fill-primary,CanvasText)}.askgpt-native-controls button:focus-visible,.askgpt-native-menu button:focus-visible{outline:2px solid var(--accent-blue,#007aff);outline-offset:-2px}.askgpt-native-controls button:hover,.askgpt-native-menu button:hover{background:var(--fill-quinary,#8882)}.askgpt-native-group{display:flex;align-items:center;gap:2px}.askgpt-native-controls>.askgpt-native-group{gap:0;border:1px solid var(--fill-quinary,#8883);border-radius:6px}.askgpt-native-more{font-size:20px!important;padding:0!important}.askgpt-native-menu{position:fixed;z-index:90;box-sizing:border-box;min-width:180px;max-width:calc(100vw - 16px);padding:5px;border:var(--material-panedivider,1px solid #8883);border-radius:7px;background:var(--material-toolbar,Canvas);color:var(--fill-primary,CanvasText);font:12px -apple-system,sans-serif;box-shadow:0 3px 16px #0003}.askgpt-native-menu>.askgpt-native-group{justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--fill-quinary,#8883)}.askgpt-native-menu>button{width:100%;margin-top:3px}.askgpt-native-menu button{flex:1}.askgpt-native-progress{display:inline-flex;align-items:center;gap:4px;max-width:125px;margin-inline:3px;font:11px -apple-system,sans-serif}.askgpt-native-progress span{max-width:70px;overflow:hidden;text-overflow:ellipsis}.askgpt-native-progress progress{display:block;width:44px;height:3px;border:0;border-radius:3px;accent-color:var(--accent-blue,#007aff)}.askgpt-native-status{max-width:110px;overflow:hidden;text-overflow:ellipsis;margin-inline:3px;font:11px -apple-system,sans-serif}.askgpt-native-progress[hidden],.askgpt-native-status[hidden],.askgpt-native-menu[hidden]{display:none!important}`);
    style.textContent+=`.askgpt-native-annotation-state{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:24px;margin:0 2px}.askgpt-native-annotation-indicator{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;color:CanvasText;opacity:.6}.askgpt-native-annotation-indicator:focus-visible{outline:2px solid #007aff;outline-offset:2px}.askgpt-native-annotation-icon{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.2;stroke-linecap:round;stroke-linejoin:round}.askgpt-native-annotation-spinner{display:none;box-sizing:border-box;width:12px;height:12px;border:1.3px solid currentColor;border-right-color:transparent;border-bottom-color:transparent;border-radius:50%;animation:askgpt-native-spin .85s linear infinite}.askgpt-native-annotation-indicator[data-state=preparing] .askgpt-native-annotation-icon{display:none}.askgpt-native-annotation-indicator[data-state=preparing] .askgpt-native-annotation-spinner{display:block}.askgpt-native-annotation-hint{position:absolute;right:-4px;top:calc(100% + 7px);z-index:1;box-sizing:border-box;width:180px;padding:7px 10px;border:1px solid #8883;border-radius:9px;background:Canvas;color:CanvasText;box-shadow:0 2px 10px #0002;font:11px -apple-system,sans-serif;line-height:1.4;white-space:normal;pointer-events:none}.askgpt-native-annotation-hint[hidden]{display:none!important}@keyframes askgpt-native-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.askgpt-native-annotation-spinner{animation:none}}`;
    style.textContent+='.askgpt-native-controls button:disabled,.askgpt-native-menu button:disabled{opacity:.35;cursor:default}';
    doc.head.appendChild(style);host.append(viewport);container.appendChild(host);progress.append(label,bar);doc.body.appendChild(menu);progress.hidden=true;status.hidden=true;
    const enteringTool=copy(reader._state?.tool||source._tool||{type:'pointer'}),legacyAutoTool=['highlight','underline'].includes(enteringTool.type),originalTool=legacyAutoTool?{type:'pointer'}:enteringTool;
    const removers=[],viewRemovers=[],hooks=[],initializers=new Set(),embedded=new Map(),embeddedPending=new Set(),sourceFrame=source._iframe;let disposed=false,visible=false,view=null,mapper=null,rawSelectionPopup=null,rawSourceSelectionPopup=null,rawAnnotationPopup=null,rawOverlayPopup=null,displayedAlignment=null,displayedSourcePages=[],requestedAlignmentPages=new Set(),annotationStatus=null,annotationHintTimer=null,epoch=0,forwarding=false,mappedUpdate=false,toolOverride=false,sourceState=copy(reader._state?.primaryViewState||{}),direction='en-zh',mode='mono';
    let desiredMode='mono',activeLane='target',scrollLeader='target',displayedBytes=null,sourceMoved=false,syncing=false,applyingScale=false,panSession=null,independentZoomUntil=0,dualFitDone=false,dualFitPending=null,toolbarTarget=null,toolbarReason='missingProperty',toolbarReportKey='',scrollLinked=true,figurePanel=null,figureScanner=null,figureScanning=null;const sourceStyles=new Map(['position','top','left','right','width','height','flex','max-width','visibility','z-index'].map(name=>[name,[sourceFrame?.style?.getPropertyValue(name)||'',sourceFrame?.style?.getPropertyPriority(name)||'']]));
    const sourceScroll=source._iframeWindow?.document?.getElementById('viewerContainer'),sourceScrollbar=[sourceScroll?.style?.getPropertyValue('scrollbar-width')||'',sourceScroll?.style?.getPropertyPriority('scrollbar-width')||''],sourcePopupSetter=source.setSelectionPopup;
    const selectionLinks=SelectionLink?.create({sourceView:source,targetView:()=>view,exportCallback:readerFunction});let presentingTargetSelection=false;
    removers.push(()=>selectionLinks?.dispose());
    let linkedSelection=null,selectionLane='target',selectionIntent=null;
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
        else{linked=side==='source'?mapper.projectAnnotation(copy(input)):mapper.toSourceAnnotation(input);linkedSelection=linked?{mapper,key,refs,lengths:refs.map(value=>value?.length||0),linked:copy(linked)}:null;}
        if(mode==='dual'&&linked){selectionLinks?.clear(side);selectionLinks?.show(side==='source'?'target':'source',linked);}else selectionLinks?.clear();return linked?copy(linked):null;
      }catch(_){linkedSelection=null;selectionLinks?.clear();return null;/* Missing exact links never block native selection or guess a sentence. */}
    }
    const initialVisibility=sourceFrame?.style?.getPropertyValue('visibility')||'',initialPriority=sourceFrame?.style?.getPropertyPriority('visibility')||'',initialZIndex=sourceFrame?.style?.getPropertyValue('z-index')||'',initialZPriority=sourceFrame?.style?.getPropertyPriority('z-index')||'';
    function listen(node,type,callback,options){node.addEventListener(type,callback,options);removers.push(()=>node.removeEventListener(type,callback,options));}
    function current(value){return !disposed&&value===epoch&&(appearance.isCurrent?.()??true);}
    function setStatus(text){status.textContent=text||'';status.setAttribute('title',text||'');status.hidden=!text;}
    function closeMenu(){menu.hidden=true;moreButton?.setAttribute('aria-expanded','false');}
    function positionMenu(){const anchor=moreButton?.getBoundingClientRect?.(),bounds=menu.getBoundingClientRect?.(),width=win.innerWidth||doc.documentElement?.clientWidth||1024,height=win.innerHeight||doc.documentElement?.clientHeight||768,menuWidth=bounds?.width||200,menuHeight=bounds?.height||190;menu.style.setProperty('left',Math.max(8,Math.min(width-menuWidth-8,(anchor?.right||width-8)-menuWidth))+'px');menu.style.setProperty('top',Math.max(8,Math.min(height-menuHeight-8,(anchor?.bottom||0)+4))+'px');}
    function closePanels(){closeMenu();figurePanel?.close();}
    function toggleMenu(){figurePanel?.close();if(!menu.hidden){closeMenu();return;}menu.hidden=false;moreButton.setAttribute('aria-expanded','true');positionMenu();menuItems.find(item=>!item.disabled)?.focus?.();}
    function sameDOMNode(expected,value){if(expected===value)return true;if(!expected||!value||typeof expected.isSameNode!=='function')return false;try{return Reflect.apply(expected.isSameNode,expected,[value])===true;}catch(_){return false;}}
    function toolbarSnapshot(){
      let box=null,targetBox=null,attached=false,connected=false,targetConnected=false,childCount=0;try{box=header.getBoundingClientRect?.();targetBox=toolbarTarget?.getBoundingClientRect?.();attached=Boolean(toolbarTarget&&sameDOMNode(toolbarTarget,header.parentNode));connected=header.isConnected===true;targetConnected=toolbarTarget?.isConnected===true;childCount=toolbarTarget?.childElementCount??toolbarTarget?.children?.length??0;}catch(_){}
      return {name:'RenderSnapshot',code:toolbarReason?'compatibility':'rendered',...(toolbarReason?{errorDetail:toolbarReason}:{}),renderNumbers:{width:finite(box?.width)?Math.max(0,Math.round(box.width)):0,height:finite(box?.height)?Math.max(0,Math.round(box.height)):0,holderChildCount:Number.isInteger(childCount)?childCount:0,textItemsCount:menuItems.length,renderedCount:attached&&connected?6:0},layoutNumbers:{canvasConnected:connected?1:0,holderConnected:targetConnected?1:0,canvasLeft:box?.left,canvasTop:box?.top,canvasRectWidth:box?.width,canvasRectHeight:box?.height,holderRectWidth:targetBox?.width,holderRectHeight:targetBox?.height,holderChildCount:Number.isInteger(childCount)?childCount:0}};
    }
    function reportToolbar(){const snapshot=toolbarSnapshot(),key=JSON.stringify(snapshot);if(key!==toolbarReportKey){toolbarReportKey=key;try{appearance.reportDiagnostic?.('toolbar',snapshot);}catch(_){}}}
    function attachToolbar(value=appearance.toolbarHost){
      if(disposed)return false;
      try{
        const provided=typeof value==='function'?value():value,target=provided||doc.querySelector?.('.toolbar .end > .custom-sections')||doc.querySelector?.('.toolbar .end');toolbarTarget=target||null;
        if(!target)toolbarReason='missingProperty';
        // Different Xray wrappers can name the same native Document. Verify
        // with the known reader document, never a URL or a broad Xray waiver.
        else if(!sameDOMNode(doc,target.ownerDocument))toolbarReason='id';
        else if(typeof target.appendChild!=='function')toolbarReason='notFunction';
        else {if(!sameDOMNode(target,header.parentNode)){closeMenu();target.appendChild(header);}else if(!menu.hidden)positionMenu();toolbarReason=sameDOMNode(target,header.parentNode)?null:'other';}
      }catch(_){toolbarReason='permission';}
      reportToolbar();return toolbarReason===null;
    }
    function setAnnotationStatus(value){
      const labels={preparing:'正在准备词语对应，可继续阅读',failed:'词语对应暂不可用，可重新划词或点重试',retry_wait:'请稍候 3 秒再重试词语对应',retry_limited:'本页已多次重试，请稍后再试'};
      annotationStatus=Object.hasOwn(labels,value)?value:null;const text=labels[annotationStatus]||'译文标注';annotationIndicator.setAttribute('data-state',annotationStatus||'ready');annotationIndicator.setAttribute('title',text);annotationIndicator.setAttribute('aria-label',text);annotationIndicator.setAttribute('aria-busy',String(annotationStatus==='preparing'));
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
    moreButton=button('⋯','More translation controls · 翻译选项',toggleMenu);moreButton.className+=' askgpt-native-more';moreButton.setAttribute('aria-haspopup','menu');moreButton.setAttribute('aria-expanded','false');moreButton.setAttribute('aria-controls',menu.getAttribute('id'));
    const scope=group(menu);button('本页','Translate current page · 本页',()=>actions.current?.(),scope);button('整份','Translate whole PDF · 整份',()=>actions.whole?.(),scope);
    const playback=group(menu);button('■','Stop · 停止',()=>actions.stop?.(),playback);button('▶','Retry · 重试',()=>actions.resume?.(),playback);
    const zoom=group(menu),activeView=()=>mode==='original'||mode==='dual'&&activeLane==='source'?source:view;button('−','Zoom out · 缩小',()=>activeView()?.zoomOut?.(),zoom);button('↔','Fit width · 适合宽度',()=>activeView()?.zoomPageWidth?.(),zoom);button('+','Zoom in · 放大',()=>activeView()?.zoomIn?.(),zoom);
    const matchZoomButton=button('同步大小','Match pane zoom · 同步大小',()=>matchPaneZoom(),zoom);matchZoomButton.disabled=true;
    const directionButton=button('EN→中','Translation direction · 翻译方向',()=>{direction=direction==='en-zh'?'zh-en':'en-zh';directionButton.textContent=direction==='en-zh'?'EN→中':'中→EN';actions.direction?.(direction);},menu);
    header.append(annotationSlot,progress,status);
    listen(doc,'pointerdown',event=>{if(menu.hidden&&!figurePanel?.open)return;const inside=node=>node&&(node===event.target||node.contains?.(event.target));if(!inside(header)&&!inside(menu)&&!inside(figurePanel?.element))closePanels();},true);
    listen(menu,'keydown',event=>{if(menu.hidden)return;if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeMenu();moreButton.focus?.();return;}if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();event.stopImmediatePropagation();const items=menuItems.filter(item=>!item.disabled),index=items.indexOf(doc.activeElement),next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus?.();},true);
    listen(win,'resize',()=>{if(!menu.hidden)positionMenu();});
    listen(win,'blur',closePanels);
    function toggleFigures(){closeMenu();figurePanel?.toggle();}
    function scanFigures(){
      if(figureScanning)return figureScanning;
      const pdf=source._iframeWindow?.PDFViewerApplication?.pdfDocument;
      if(!FigureNavigation||!pdf)throw failure();
      figureScanner=FigureNavigation.create(pdf,{invoke:callReader,yield:()=>new Promise(resolve=>win.setTimeout(resolve,0)),unwrapPage:page=>components?.utils?.waiveXrays?components.utils.waiveXrays(page):page,isCurrent:()=>!disposed&&source._iframeWindow?.PDFViewerApplication?.pdfDocument===pdf,
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
    const canonicalAnnotations=()=>copy(reader._state?.annotations||source._annotations||[]);
    function sameAnnotation(a,b){if(a.type!==b.type||a.position?.pageIndex!==b.position?.pageIndex||!a.position?.rects?.length||!b.position?.rects?.length)return false;const x=bounds(a.position.rects),y=bounds(b.position.rects);return x.every((value,index)=>Math.abs(value-y[index])<1);}
    const withEmbedded=values=>[...values,...[...embedded.values()].flat().filter(annotation=>!values.some(value=>sameAnnotation(value,annotation)))];
    const annotations=()=>withEmbedded(canonicalAnnotations());
    const canonical=annotation=>{const id=canonicalID(annotation?.id),existing=annotations().find(item=>item.id===id);return existing||mapper.toSourceAnnotation(annotation);};
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
    function leadScroll(lane){if(scrollLeader!==lane)scrollSync?.reset();scrollLeader=lane;}
    let annotationProjectionCache=new Map();const selectionLinkPages=new Map();let selectionBinding=null;
    const selectionWords=physical=>selectionLinkPages.get(physical)||[];
    function updateSelectionLinks(value){
      if(disposed||!view||!displayedAlignment)return false;
      const page=displayedAlignment.pages.find(page=>page.sourcePage===value?.page);if(!page)throw mappingFailure();
      const checked=Layout.validateSelectionLinks(value,value.jobID,page.sourcePage,displayedAlignment.sourceSHA256);
      const binding=[checked.jobID,checked.sourceSHA256,checked.targetSHA256,checked.revision].join('|');if(selectionBinding!==null&&selectionBinding!==binding)throw mappingFailure();
      const incoming=checked.links||[checked.link].filter(Boolean);
      for(const link of incoming){
        const parent=page.paragraphs.find(p=>p.id===link.paragraph);if(!parent||!/^[a-f0-9]{64}$/.test(link.key||'')||link.id!=='sel_'+link.key)throw mappingFailure();
        for(const side of ['source','target']){
          if(link[side].rects.some(r=>!coveredByRects(r,parent[side].rects))||page.paragraphs.some(p=>p!==parent&&link[side].glyphs.filter(meaningful).some(g=>p[side].rects.some(r=>centerIn(g.rect,r)))))throw mappingFailure();
          const paired=link[side==='source'?'dualSource':'dualTarget'].rects,matrix=page[side==='source'?'sourceToDual':'targetToDual'];if(link[side].rects.some((r,i)=>transformRect(matrix,r).some((n,j)=>Math.abs(n-paired[i][j])>.02+1e-9)))throw mappingFailure();
        }
      }
      const merged=new Map((selectionLinkPages.get(page.sourcePage)||[]).map(link=>[link.id,link]));for(const link of incoming)merged.set(link.id,copy(link));selectionBinding=binding;selectionLinkPages.set(page.sourcePage,[...merged.values()]);
      annotationProjectionCache.clear();linkedSelection=null;callReader(view,'setAnnotations',projectForDisplay());if(selectionLane==='target')linkSelection(rawSelectionPopup,'target');else linkSelection(rawSourceSelectionPopup,'source');return true;
    }
    function projectForDisplay(values=annotations()){
      const next=new Map(),pageKeys=new Map(),byPhysical=new Map((displayedAlignment?.pages||[]).map(page=>[page.sourcePage,page]));
      const revision=[displayedAlignment?.sourceSHA256,displayedAlignment?.sentenceAlignmentRevision,displayedAlignment?.phraseAlignmentRevision,displayedAlignment?.phraseExtractionRevision].join('|');
      const pageKey=physical=>{if(!pageKeys.has(physical))pageKeys.set(physical,JSON.stringify(byPhysical.get(physical)||null));return pageKeys.get(physical);};
      const result=[];
      for(const annotation of values){
        if(annotation._hidden)continue;const physical=annotation.position?.pageIndex,related=[physical,...(annotation.position?.nextPageRects?[physical+1]:[])],refs=[];
        for(const page of related){const index=byPhysical.get(page)?.outputPage;refs.push(source._pdfPages?.[page]?.chars,view?._pdfPages?.[index]?.chars);}
        const lengths=refs.map(chars=>chars?.length||0),ready=lengths.every(length=>length>0),key=String(annotation.id??JSON.stringify(annotation)),binding=JSON.stringify(annotation),pages=related.map(pageKey),cached=annotationProjectionCache.get(key);
        let projected;if(ready&&cached&&cached.revision===revision&&cached.binding===binding&&pages.every((value,i)=>value===cached.pages[i])&&pages.length===cached.pages.length&&refs.every((value,i)=>value===cached.refs[i]&&lengths[i]===cached.lengths[i]))projected=cached.projected;
        else projected=mapper.projectAnnotation(annotation);
        if(!projected)continue;result.push(projected);
        if(ready&&next.size<4096)next.set(key,{revision,binding,pages,refs,lengths,projected:copy(projected)});
      }
      annotationProjectionCache=next;return copy(result);
    }
    function restoreSourceStyles(){restoreSourceScrollbar();for(const [name,[value,priority]] of sourceStyles){if(value)sourceFrame?.style?.setProperty(name,value,priority);else sourceFrame?.style?.removeProperty(name);}}
    function showSource(){clearSelectionIntent();scrollSync?.reset();closePanels();cancelInitialDualFit();selectionLinks?.clear();host.style.setProperty('visibility','hidden');visible=false;restoreSourceStyles();if(toolOverride){toolOverride=false;setReaderTool(originalTool);}}
    function navigateNative(candidate,state){const viewer=candidate?._iframeWindow?.PDFViewerApplication?.pdfViewer;if(!viewer||!Number.isInteger(state?.pageIndex))return;callReader(viewer,'scrollPageIntoView',{pageNumber:state.pageIndex+1,destArray:[null,{name:'XYZ'},state.left,state.top,null],allowNegativeOffset:true});}
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
      scrollSync?.reset();leadScroll(activeLane);
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
        try{callReader(source,'zoomPageWidth');callReader(candidate,'zoomPageWidth');const fitted=snapshotSourceState();if(fitted.scale!==undefined)sourceState.scale=fitted.scale;dualFitDone=true;}catch(error){appearance.reportDiagnostic?.('nativeState',diagnosticError(error));}finally{forwarding=previousForwarding;syncing=previousSyncing;}
      };
      pending.id=pending.frame?timing.requestAnimationFrame(fit):timing.setTimeout(fit,0);
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
      if(disposed)return;const moveSource=Boolean(view&&visible&&mode!=='original');
      if(!moveSource){
        // A failed/unfinished translated view never owned the reading position.
        // Preserve the real original page rather than replaying the mount-time
        // snapshot, including when its debounced parent state is still stale.
        sourceState=snapshotSourceState();
      }
      desiredMode='original';rawSelectionPopup=null;rawAnnotationPopup=null;rawOverlayPopup=null;pendingSelection=null;for(const name of ['setSelectionPopup','setAnnotationPopup','setOverlayPopup'])callReader(view,name,null);for(const name of ['_onSetSelectionPopup','_onSetAnnotationPopup','_onSetOverlayPopup'])callReader(source,name,null);for(const handle of readingHandles)handle.clear?.(false);showSource();mode='original';activeLane='source';leadScroll('source');matchZoomButton.disabled=true;linkedButton.disabled=true;figurePanel?.refresh();host.style.setProperty('visibility','visible');host.style.setProperty('pointer-events','none');viewport.style.setProperty('display','none');header.style.setProperty('pointer-events','auto');originalButton.setAttribute('aria-pressed','true');monoButton.setAttribute('aria-pressed','false');dualButton.setAttribute('aria-pressed','false');if(moveSource)navigateNative(source,sourceState);setProgress(null);setStatus('');
    }
    function layoutViewport(nextMode){
      restoreSourceStyles();host.style.setProperty('background','transparent');host.style.setProperty('visibility','visible');host.style.setProperty('pointer-events','none');host.style.setProperty('z-index','0');header.style.setProperty('pointer-events','auto');viewport.style.setProperty('pointer-events','auto');viewport.style.removeProperty('display');viewport.style.setProperty('left',nextMode==='dual'?'50%':'0');viewport.style.setProperty('background','Canvas');
      if(nextMode==='dual'){sourceScroll?.style?.setProperty('scrollbar-width','none');for(const [name,value] of Object.entries({position:'absolute',top:'0',left:'0',width:'50%',height:'100%',visibility:'visible','z-index':'0'}))sourceFrame?.style?.setProperty(name,value);}
      else sourceFrame?.style?.setProperty('visibility','hidden');
    }
    function layoutPanes(nextMode){scrollSync?.reset();if(nextMode!=='dual')cancelInitialDualFit();selectionLinks?.clear();for(const handle of readingHandles)handle.clear?.(false);mode=nextMode;visible=true;layoutViewport(nextMode);
      originalButton.setAttribute('aria-pressed','false');monoButton.setAttribute('aria-pressed',String(mode==='mono'));dualButton.setAttribute('aria-pressed',String(mode==='dual'));matchZoomButton.disabled=mode!=='dual';linkedButton.disabled=mode!=='dual';figurePanel?.refresh();if(mode==='dual'){if(scrollLinked)navigateNative(source,sourceState);scheduleInitialDualFit();}
    }
    function setProgress(value){
      const valid=value&&['preparing','translating','layout','loading'].includes(value.stage);progress.hidden=!valid;if(!valid)return;
      const labels={preparing:'准备翻译',translating:'翻译',layout:'整理版式',loading:'载入译文'},count=Number.isInteger(value.total)&&value.total>1&&Number.isInteger(value.completed)&&value.completed>=0&&value.completed<=value.total;
      label.textContent=labels[value.stage]+(count?' · '+value.completed+' / '+value.total:'');progress.setAttribute('title',label.textContent);bar.setAttribute('aria-label',label.textContent);if(count){bar.setAttribute('max',String(value.total));bar.setAttribute('value',String(value.completed));}else {bar.removeAttribute('max');bar.removeAttribute('value');}
    }
    function removeView(){annotationProjectionCache.clear();clearAnnotationHint();pendingSelection=null;rawSourceSelectionPopup=null;panSession=null;for(const cancel of [...initializers])cancel();for(const remove of viewRemovers.splice(0))remove();const old=view;view=null;displayedBytes=null;try{if(rawSelectionPopup){rawSelectionPopup=null;callReader(source,'_onSetSelectionPopup',null);}if(rawAnnotationPopup){rawAnnotationPopup=null;callReader(source,'_onSetAnnotationPopup',null);}if(rawOverlayPopup){rawOverlayPopup=null;callReader(source,'_onSetOverlayPopup',null);}old?.destroy?.();old?._iframe?.remove?.();}catch(error){appearance.reportDiagnostic?.('nativeDispose',error);}viewport.textContent='';}
    function initialized(promise){return new Promise((resolve,reject)=>{let finished=false,timer;const finish=error=>{if(finished)return;finished=true;win.clearTimeout(timer);initializers.delete(cancel);if(error)reject(error);else resolve();},cancel=()=>finish();initializers.add(cancel);timer=win.setTimeout(()=>finish(failure()),30000);Promise.resolve(promise).then(()=>finish(),finish);});}
    function requestAlignment(outputPage,options={}){
      const physical=displayedSourcePages[outputPage];if(!visible||!view||!Number.isInteger(physical))return 'unavailable';
      const explicit=options.explicit===true;if(!explicit)actions.page?.(physical);
      const precise=displayedAlignment?.phraseExtractionRevision==='pdf-glyph-boundary-v2'&&displayedAlignment?.phraseExtractedPages?.includes(physical)&&displayedAlignment?.phrasePages?.includes(physical)&&Layout?.sentenceCoverage(displayedAlignment.pages.find(page=>page.sourcePage===physical))===true;
      if(precise&&!options.selection)return 'ready';if(typeof actions.align!=='function'||!explicit&&requestedAlignmentPages.has(physical))return 'pending';
      const requestEpoch=epoch;requestedAlignmentPages.add(physical);
      try{
        const result=actions.align(physical,{explicit,...(options.units?.length?{units:options.units}:{}),...(options.selection?{selection:options.selection}:{})});
        if(['retry_wait','retry_limited','failed'].includes(result))setAnnotationStatus(result);
        else if(!['ready','started','pending','queued'].includes(result))setAnnotationStatus('preparing');
        if(result&&typeof result.then==='function')void Promise.resolve(result).catch(()=>{if(current(requestEpoch))setAnnotationStatus('failed');});return result;
      }catch(error){if(current(requestEpoch))setAnnotationStatus('failed');appearance.reportDiagnostic?.('nativeSelection',error);return 'failed';}
    }
    const changedSelection=(previous,popup)=>Boolean(popup?.annotation&&(!previous?.annotation||!equalBinding(previous.annotation.position,popup.annotation.position)||previous.annotation.text!==popup.annotation.text));
    function mapForExplicitSave(annotation){
      try{return mapper.toSourceAnnotation(annotation);}catch(error){if(['annotation_mapping','annotation_sentence'].includes(error?.code))requestAlignment(annotation?.position?.pageIndex,{explicit:true});throw error;}
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
          rawSourceSelectionPopup=null;if(typeof sourcePopupSetter==='function')Reflect.apply(sourcePopupSetter,source,[null]);if(selectionLane==='target'&&rawSelectionPopup?.annotation)return;
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
      const token=String(epoch)+':'+String(++pendingSequence);pendingSelection={token,epoch,annotation:copy(annotation)};
      return {...copy(annotation),[pendingKey]:token};
    }
    function resolvePendingAnnotation(annotation){
      const token=annotation?.[pendingKey];if(token===undefined)return annotation;
      const pending=pendingSelection;
      if(!visible||!view||!pending||pending.epoch!==epoch||token!==pending.token||!['highlight','underline'].includes(annotation.type)||!equalBinding(annotation.position,pending.annotation.position)||annotation.text!==pending.annotation.text)throw mappingFailure();
      const clean=copy(annotation);delete clean[pendingKey];return mapForExplicitSave(clean);
    }
    try{
      if(source._iframeWindow?.addEventListener){const listener=readerFunction(closePanels);Reflect.apply(source._iframeWindow.addEventListener,source._iframeWindow,['pointerdown',listener,true]);removers.push(()=>Reflect.apply(source._iframeWindow.removeEventListener,source._iframeWindow,['pointerdown',listener,true]));}
      const manager=reader._annotationManager;
      if(typeof manager?.addAnnotation==='function'){
        const own=Object.prototype.hasOwnProperty.call(manager,'addAnnotation'),original=manager.addAnnotation;
        const wrapper=readerFunction(function(annotation,...rest){
          let canonical;try{canonical=resolvePendingAnnotation(annotation);}catch(error){handleError(error);throw error;}
          return readerRealm(Reflect.apply(original,this,[readerRealm(canonical),...rest.map(readerRealm)]));
        });
        manager.addAnnotation=wrapper;pendingSaveGuard=true;hooks.push(()=>{if(manager.addAnnotation===wrapper){if(own)manager.addAnnotation=original;else delete manager.addAnnotation;}});
      }
      // Zotero's Add to Note action also receives the unsaved popup object.
      // It must never attach translated PDF coordinates to the original item.
      if(typeof reader._onAddToNote==='function'){
        const own=Object.prototype.hasOwnProperty.call(reader,'_onAddToNote'),original=reader._onAddToNote;
        const wrapper=readerFunction(function(values,...rest){let canonical;try{canonical=copy(values).map(resolvePendingAnnotation);}catch(error){handleError(error);throw error;}return readerRealm(Reflect.apply(original,this,[readerRealm(canonical),...rest.map(readerRealm)]));});
        reader._onAddToNote=wrapper;hooks.push(()=>{if(reader._onAddToNote===wrapper){if(own)reader._onAddToNote=original;else delete reader._onAddToNote;}});
      }
      if(typeof source._onUpdateAnnotations==='function'){
        const name='_onUpdateAnnotations',own=Object.prototype.hasOwnProperty.call(source,name),original=source[name];
        const wrapper=readerRealm(function(updates,...rest){const values=copy(updates).map(update=>{
          if(!mappedUpdate&&update.position){
            const existing=canonicalAnnotations().find(annotation=>annotation.id===canonicalID(update.id));
            if(existing?.position?._askgptSelection&&equalBinding(existing.position,update.position))update.position._askgptSelection=copy(existing.position._askgptSelection);
            else delete update.position._askgptSelection;
          }return update;
        });return readerRealm(Reflect.apply(original,this,[readerRealm(values),...rest.map(readerRealm)]));});
        source[name]=wrapper;hooks.push(()=>{if(source[name]===wrapper){if(own)source[name]=original;else delete source[name];}});
      }
      hook('_onChangeViewState',state=>{if(syncing||mode==='mono'||mode==='dual'&&scrollLeader!=='source')return;sourceState=copy(state);sourceMoved=true;if(scrollLinked&&mode==='dual'&&Date.now()>independentZoomUntil){if(!displayedSourcePages.includes(state.pageIndex)){setScrollLinked(false);setStatus('本页尚无译文');return;}scrollSync?.schedule('source',state);sourceMoved=false;}});
      hook('_onSetSelectionPopup',popup=>{if(presentingTargetSelection||!popup?.annotation&&selectionLane!=='source')return;const changed=changedSelection(rawSourceSelectionPopup,popup);rawSourceSelectionPopup=popup?copy(popup):null;if(popup?.annotation)selectionLane='source';linkSelection(popup,'source');if(changed&&popup?.annotation&&!mapper.hasExactSourceSelection(copy(popup.annotation)))requestAlignment(displayedSourcePages.indexOf(popup.annotation.position.pageIndex),{explicit:true,units:mapper.selectionUnits(copy(popup.annotation),'source'),selection:mapper.selectionRequest(copy(popup.annotation),'source')});});
      hook('_onChangeViewStats',stats=>{if(mode!=='dual'||scrollLeader!=='source')return;const number=source._iframeWindow?.PDFViewerApplication?.pdfViewer?.currentPageNumber,physical=Number.isInteger(number)&&number>=1?number-1:stats.pageIndex;requestAlignment(displayedSourcePages.indexOf(physical));});
      hook('setAnnotations',value=>callReader(view,'setAnnotations',projectForDisplay(withEmbedded(copy(value)))));
      hook('setSelectedAnnotationIDs',ids=>callReader(view,'setSelectedAnnotationIDs',copy(ids)));
      hook('setTool',tool=>{syncTools(view,tool);callReader(view,'setTool',tool);});
      for(const name of ['setShowAnnotations','setLightTheme','setDarkTheme','setColorScheme','setReadOnly','setSidebarOpen'])hook(name,(...args)=>callReader(view,name,...args));
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

    }catch(error){for(const restore of hooks.reverse())restore();for(const remove of removers.splice(0))remove();figureScanner?.cancel();figurePanel?.dispose();host.remove();header.remove();menu.remove();style.remove();throw error;}
    function makeOptions(bytes,sourcePages){
      // PDFView passes data.buf from the outer reader into another iframe.
      // PDF.js uses instanceof ArrayBuffer there, which fails for an outer-
      // window ArrayBuffer. ArrayBuffer.isView is cross-realm and accepts this
      // byte view. Own the bytes so PDF.js worker transfer cannot detach cache.
      let nativeBytes;if(ArrayBuffer.isView(bytes)&&bytes.BYTES_PER_ELEMENT===1)nativeBytes=new Uint8Array(new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength));else if(Object.prototype.toString.call(bytes)==='[object ArrayBuffer]')nativeBytes=new Uint8Array(new Uint8Array(bytes));else throw failure();
      const pageLabels=sourcePages.map(index=>source._pageLabels?.[index]||reader._state?.pageLabels?.[index]||source._getPageLabel?.(index,false)||String(index+1));
      const callbackEpoch=epoch,options={...source._options,primary:false,container:viewport,data:{buf:nativeBytes},annotations:projectForDisplay(),tool:{type:'pointer'},tools:toolSnapshot(),selectedAnnotationIDs:[],pageLabels,viewState:mapper.toOutputState(sourceState),location:undefined};
      const protect=(callback,fallback,stage='nativeAnnotation')=>function(...args){if(!current(callbackEpoch)||!mapper)return fallback;try{return readerRealm(callback(...args));}catch(error){handleError(error,stage);return fallback;}};
      options.onAddAnnotation=protect((annotation,select)=>{const side=mapper.annotationSide(annotation),saved=callReader(source,'_onAddAnnotation',mapForExplicitSave(annotation),select);return saved?mapper.projectAnnotation(saved,side):saved;},null);
      options.onUpdateAnnotations=protect(updates=>{const values=copy(updates).map(update=>{const id=canonicalID(update.id),existing=canonicalAnnotations().find(annotation=>annotation.id===id);if(!existing||existing.readOnly)throw mappingFailure();const projected=mapper.projectAnnotation(existing,update.id!==id?'source':'target');return update.position?mapper.toSourceAnnotation({...projected,...update,id,type:existing.type}):{...copy(update),id};});mappedUpdate=true;try{return callReader(source,'_onUpdateAnnotations',values);}finally{mappedUpdate=false;}});
      options.onDeleteAnnotations=protect(ids=>{const permitted=[...new Set(copy(ids).map(canonicalID))].filter(id=>canonicalAnnotations().some(annotation=>annotation.id===id&&!annotation.readOnly));if(permitted.length)return callReader(source,'_onDeleteAnnotations',permitted);});
      options.onSelectAnnotations=protect((value,event)=>{const ids=copy(value),canonicalIDs=[...new Set(copy(ids).map(canonicalID))].filter(id=>canonicalAnnotations().some(annotation=>annotation.id===id));if(canonicalIDs.length||!ids.length)return callReader(source,'_onSelectAnnotations',canonicalIDs,event);callReader(view,'setSelectedAnnotationIDs',ids);},undefined,'nativeSelection');
      options.onSetSelectionPopup=protect(popup=>{
        // A follower's old popup cannot take over the active selection palette.
        const intent=takeSelectionIntent('target');
        if(!popup?.annotation){rawSelectionPopup=null;pendingSelection=null;callReader(view,'setSelectionPopup',null);if(selectionLane==='source'&&rawSourceSelectionPopup?.annotation)return;}
        else if(selectionLane==='source'&&!intent&&!changedSelection(rawSelectionPopup,popup))return;
        const changed=changedSelection(rawSelectionPopup,popup);if(popup?.annotation){activeLane='target';selectionLane='target';}const linked=linkSelection(popup,'target');
        const present=value=>{presentingTargetSelection=true;try{return callReader(source,'_onSetSelectionPopup',value);}finally{presentingTargetSelection=false;}};
        if(!popup){rawSelectionPopup=null;pendingSelection=null;return present(popup);}
        let annotation;try{annotation=linked||mapper.toSourceAnnotation(popup.annotation);pendingSelection=null;}
        catch(error){
          if(!pendingSaveGuard||!['annotation_mapping','annotation_sentence'].includes(error?.code)){const previous=rawSelectionPopup||reader._state?.primaryViewSelectionPopup;rawSelectionPopup=null;pendingSelection=null;if(previous)callReader(source,'_onSetSelectionPopup',null);throw error;}
          // Selecting and copying translated text never waits for a model.
          // Keep Zotero's own palette; only its explicit save action needs the
          // semantic mapping. No annotation is created by this callback.
          appearance.reportDiagnostic?.('nativeSelection',error);if(changed)requestAlignment(popup.annotation.position.pageIndex,{explicit:true,units:mapper.selectionUnits(copy(popup.annotation),'target'),selection:mapper.selectionRequest(copy(popup.annotation),'target')});annotation=pendingAnnotation(popup.annotation);
        }
        rawSelectionPopup=copy(popup);return present({...popupCoordinates(popup),annotation});
      },undefined,'nativePopup');
      options.onSetAnnotationPopup=protect(popup=>{const annotation=popup?canonical(popup.annotation):null;rawAnnotationPopup=popup?copy(popup):null;return callReader(source,'_onSetAnnotationPopup',popup?{...popupCoordinates(popup),annotation}:popup);},undefined,'nativePopup');
      options.onSetOverlayPopup=protect(popup=>{rawOverlayPopup=popup?{...popup,rect:copy(popup.rect)}:null;return callReader(source,'_onSetOverlayPopup',popupCoordinates(popup));},undefined,'nativePopup');
      options.onSetDataTransferAnnotations=protect((transfer,annotation,...rest)=>{
        let mapped;try{mapped=canonical(annotation);}catch(error){
          if(rest[0]!==true||!['annotation_mapping','annotation_sentence'].includes(error?.code)||typeof annotation?.text!=='string'||typeof transfer?.setData!=='function')throw error;
          // Plain text copying remains native and immediate even before the
          // semantic sidecar is ready. Do not emit a false source citation.
          return Reflect.apply(transfer.setData,transfer,['text/plain',annotation.text]);
        }
        if(rest[0]===true&&typeof annotation?.text==='string')mapped={...copy(mapped),text:annotation.text};
        return callReader(source,'_onSetDataTransferAnnotations',transfer,mapped,...rest);
      },undefined,'nativeCopy');
      options.onOpenViewContextMenu=protect(params=>callReader(source,'_onOpenViewContextMenu',params),undefined,'nativeMenu');
      options.onOpenAnnotationContextMenu=protect(params=>{const ids=copy(params.ids)?.map(canonicalID);if(ids?.some(id=>!canonicalAnnotations().some(annotation=>annotation.id===id)))return;callReader(source,'_onOpenAnnotationContextMenu',{...params,ids,annotation:params.annotation?canonical(params.annotation):params.annotation,annotations:copy(params.annotations)?.map(canonical)});},undefined,'nativeMenu');
      options.onChangeViewState=protect(state=>{if(applyingScale||mode==='original'||mode==='dual'&&scrollLeader==='source')return;const mapped=mapper.toSourceViewportState(state);if(!mapped)return;sourceState={...sourceState,...mapped};sourceMoved=false;syncing=true;try{callReader(source,'_onChangeViewState',copy(sourceState));}finally{syncing=false;}if(scrollLinked&&mode==='dual'&&Date.now()>independentZoomUntil)scrollSync?.schedule('target',state);},undefined,'nativeState');
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
      for(const [candidateView,lane] of [[source,'source'],[candidate,'target']]){for(const type of ['pointerdown','keydown'])viewRemovers.push(nativeListen(candidateView._iframeWindow,type,event=>recordSelectionIntent(lane,event),true));const gestures=PaneGestures?.install(candidateView,{enabled:()=>lane==='source'?(mode==='dual'||mode==='original'):visible,activate:()=>{activeLane=lane;},onZoom:()=>{leadScroll(lane);scrollSync?.reset();isolateViewport();},onPan:()=>{leadScroll(lane);scrollSync?.reset();isolateViewport();},onNormalInput:()=>{leadScroll(lane);independentZoomUntil=0;},zoom:payload=>zoomPanes(candidateView,lane,payload),pan:payload=>panPanes(candidateView,lane,payload),listen:nativeListen,invoke:callReader});if(gestures){gestureHandles.add(gestures);viewRemovers.push(()=>{gestures.dispose();gestureHandles.delete(gestures);});}}
    }
    const readingHandles=[];
    function installReading(candidate){
      for(const [candidateView,lane] of [[source,'source'],[candidate,'target']]){
        const handle=ReadingTools?.install(candidateView,{exportCallback:readerFunction,onError:error=>appearance.reportDiagnostic?.('nativeSelection',diagnosticError(error)),getAlignment:()=>displayedAlignment,getLane:()=>lane,getOutputPage:page=>lane==='target'?page:displayedSourcePages.indexOf(page),enabled:()=>lane==='target'?visible:mode==='dual'||mode==='original',onFocus:value=>{if(mode==='dual')for(const other of readingHandles)if(other!==handle){if(value)other.focus?.(value);else other.clear?.(false);}}});
        if(handle){readingHandles.push(handle);viewRemovers.push(()=>{handle.dispose();const index=readingHandles.indexOf(handle);if(index>=0)readingHandles.splice(index,1);});}
      }
    }
    function warmPages(candidate){
      const target=candidate._iframeWindow,application=target?.PDFViewerApplication,document=application?.pdfDocument,bus=application?.eventBus;if(typeof document?.getPage!=='function')return;let stopped=false,loading=false,wanted=0,scheduled=null,idle=false;const done=new Set();
      const schedule=()=>{if(stopped||loading||scheduled!==null)return;const run=()=>{scheduled=null;void warm();};idle=typeof target.requestIdleCallback==='function';scheduled=idle?target.requestIdleCallback(run,{timeout:200}):target.setTimeout(run,0);};
      const warm=async()=>{if(loading||stopped)return;loading=true;const page=wanted,current=()=>!stopped&&wanted===page;
        try{for(const index of [page,page+1,page+2,page-1]){
          if(!current())break;if(index<0||index>=document.numPages||done.has(index))continue;
          try{
            if(typeof candidate._ensureBasicPageData==='function')await candidate._ensureBasicPageData(index);if(!current())break;
            const returned=await document.getPage(index+1);if(!current())break;
            const proxy=components?.utils?.waiveXrays?components.utils.waiveXrays(returned):returned;
            await proxy.getOperatorList?.();if(!current())break;await proxy.getTextContent?.();if(!current())break;done.add(index);
          }catch(_){done.delete(index);}
        }}finally{loading=false;if(!stopped&&wanted!==page)schedule();}
      };
      const onPage=event=>{const page=event?.pageNumber;if(Number.isInteger(page)&&page>=1&&page<=document.numPages){wanted=page-1;schedule();}};
      if(bus?.on&&bus?.off){bus.on('pagechanging',onPage);viewRemovers.push(()=>bus.off('pagechanging',onPage));}
      viewRemovers.push(()=>{stopped=true;if(scheduled!==null){if(idle)target.cancelIdleCallback?.(scheduled);else target.clearTimeout(scheduled);scheduled=null;}});
      wanted=(application.pdfViewer?.currentPageNumber||1)-1;schedule();
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
          embedded.set(physical,result);callReader(candidate,'setAnnotations',projectForDisplay());
        }catch(error){if(current(generation)){setStatus('原 PDF 标注未载入，可切回原文查看');appearance.reportDiagnostic?.('nativeEmbedded',error);}}finally{embeddedPending.delete(physical);}
      }
      const onPage=event=>{if(Number.isInteger(event?.pageNumber))void load(event.pageNumber-1);};
      if(bus?.on&&bus?.off){bus.on('pagerendered',onPage);viewRemovers.push(()=>bus.off('pagerendered',onPage));}
      void load((candidate._iframeWindow?.PDFViewerApplication?.pdfViewer?.currentPageNumber||1)-1);
    }
    async function showOutput(bytes,sourcePages,nextMode,alignment){
      if(disposed||!['mono','dual'].includes(nextMode))throw failure();desiredMode=nextMode;
      const validated=validateAlignment(alignment,sourcePages);
      // Capture before removing/restyling either iframe. A mono translation
      // owns its mapped reading position while the hidden original stays put.
      const sourceOwns=!view||!visible||mode==='original'||mode==='dual'&&activeLane==='source',readingState=sourceOwns?snapshotSourceState():copy(sourceState);
      if(view&&displayedBytes===bytes&&JSON.stringify(sourcePages)===JSON.stringify(displayedSourcePages)){
        mapper=createMapper(validated,'mono',source,()=>view,selectionWords);displayedAlignment=validated;const moved=mode==='original'||sourceMoved;sourceState=readingState;layoutPanes(nextMode);if(moved){navigateNative(view,mapper.toOutputState(sourceState));sourceMoved=false;}callReader(view,'setAnnotations',projectForDisplay());setProgress(null);setStatus('');appearance.reportDiagnostic?.('nativeReused');requestAlignment((view._iframeWindow?.PDFViewerApplication?.pdfViewer?.currentPageNumber||1)-1);return;
      }
      const generation=++epoch;showSource();removeView();selectionLinkPages.clear();selectionBinding=null;mapper=createMapper(validated,'mono',source,()=>view,selectionWords);mode=nextMode;displayedAlignment=validated;displayedSourcePages=sourcePages.slice();requestedAlignmentPages=new Set();setAnnotationStatus(null);sourceState=readingState;
      // Gecko may suspend painting a fully occluded iframe. Establish its real
      // mono/dual viewport before construction, without navigating or fitting.
      layoutViewport(nextMode);
      let candidate;
      try{const options=readerRealm(makeOptions(bytes,sourcePages));candidate=new source.constructor(options);view=candidate;appearance.reportDiagnostic?.('nativeConstructed');await initialized(candidate.initializedPromise);if(!current(generation)){if(view===candidate)removeView();else {candidate.destroy?.();candidate._iframe?.remove?.();}return;}appearance.reportDiagnostic?.('nativeInitialized');if(!candidate._iframeWindow?.PDFViewerApplication?.pdfDocument)throw failure();
        const rendered=candidate._iframeWindow.PDFViewerApplication.pdfViewer?.onePageRendered;if(rendered&&typeof rendered.then==='function')await initialized(rendered);if(!current(generation))return;appearance.reportDiagnostic?.('nativePainted');
        setReaderTool({type:'pointer'});toolOverride=true;syncTools(candidate,{type:'pointer'});callReader(candidate,'setAnnotations',projectForDisplay());callReader(candidate,'setTool',{type:'pointer'});callReader(candidate,'setSelectedAnnotationIDs',copy(reader._state?.selectedAnnotationIDs||[]));displayedBytes=bytes;activeLane='target';leadScroll('target');layoutPanes(desiredMode==='original'?nextMode:desiredMode);installWheel(candidate);installReading(candidate);installEmbedded(candidate,sourcePages,generation);warmPages(candidate);if(desiredMode==='original')showOriginal();setProgress(null);setStatus('');appearance.reportDiagnostic?.('nativeReady',toolbarSnapshot());requestAlignment((candidate._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber||1)-1);
      }catch(error){if(current(generation)){showSource();removeView();}throw error;}
    }
    const result={host,frame:host,doc,body:viewport,header,menu,figurePanel,setScrollLinked,jumpFigure,get scrollLinked(){return scrollLinked;},attachToolbar,get visible(){return visible;},get nativeView(){return view;},get currentSourcePage(){const candidate=mode==='dual'&&activeLane==='source'||!visible?source:view,number=candidate?._iframeWindow?.PDFViewerApplication?.pdfViewer?.currentPageNumber;return Number.isInteger(number)?candidate===source?number-1:displayedSourcePages[number-1]:sourceState.pageIndex;},setStatus,setProgress,setAnnotationStatus,
      updateSelectionLinks,
      updateAlignment(value){if(disposed||!view||!displayedSourcePages.length)return false;const validated=validateAlignment(value,displayedSourcePages);mapper=createMapper(validated,'mono',source,()=>view,selectionWords);displayedAlignment=validated;callReader(view,'setAnnotations',projectForDisplay());setAnnotationStatus(null);if(selectionLane==='target')linkSelection(rawSelectionPopup,'target');else linkSelection(rawSourceSelectionPopup,'source');return true;},
      prepareOutput(){setStatus('');warmFigures();},showOutput,showOriginal,
      restoreOriginal(){epoch++;showSource();removeView();setProgress(null);},
      dispose(){if(disposed)return;disposed=true;epoch++;showSource();scrollSync?.dispose();removeView();figureScanner?.cancel();figurePanel?.dispose();for(const remove of removers.splice(0))remove();for(const restore of hooks.reverse())restore();host.remove();header.remove();menu.remove();style.remove();}
    };
    attachToolbar();
    appearance.setCancel?.(()=>result.dispose());return result;
  }
  const api={validateAlignment,createMapper,canMount,mount,canonicalID};root.AskGPTPDFNativeView=api;if(typeof module!=='undefined')module.exports=api;
})(this);
