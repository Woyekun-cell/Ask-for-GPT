(function (root) {
  'use strict';
  const BASE = 'http://127.0.0.1:43795/v1/pdf/jobs';
  const MAX_INPUT_BYTES = 150 * 1024 * 1024;
  const MAX_OUTPUT_BYTES = 450 * 1024 * 1024;
  const MAX_ALIGNMENT_BYTES = 32 * 1024 * 1024;
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const knownErrors = new Set(['connection', 'permissions', 'runtime_missing', 'translation_failed', 'gpt_unavailable', 'batch_invalid', 'batch_limit', 'translation_timeout', 'formula_placeholder_mismatch', 'invalid_pdf', 'pdf', 'direction', 'response', 'stopped', 'timeout', 'compatibility', 'limit', 'bridge', 'alignment_unavailable', 'alignment_timeout', 'alignment_invalid', 'annotation_sentence', 'annotation_mapping', 'rendered', 'recycled', 'layout']);
  const validationDetails=new Set(['jsonObject','count','rowShape','id','empty','formula','content','notFunction','missingProperty','permission','other']);
  const nativeErrorProperties=new Set(['map','flatMap','some','apply','cloneInto','setSelectedAnnotationIDs','_onSelectAnnotations','setAnnotations','_onAddAnnotation','_onUpdateAnnotations','_onDeleteAnnotations','_getPageLabel','getAnnotations','then','slice','filter','find','every','other']);
  class PDFError extends Error { constructor(code) { super(code); this.code = code; } }
  function errorMessage(error) {
    const messages = { connection: '请启动 Ask for GPT 并开启页面翻译连接', permissions: '页面翻译连接权限异常',
      runtime_missing: '保版翻译组件尚未就绪', translation_failed: '保版翻译失败，请重试', invalid_pdf: '无法读取这份 PDF', pdf: '无法读取这份 PDF',
      gpt_unavailable: 'GPT 翻译连接不可用，请在 Ask for GPT 设置中测试连接', batch_invalid: '页面翻译校验失败，请重试', batch_limit: '当前页文字超出批量翻译上限', translation_timeout: 'GPT 翻译超时，请重试', formula_placeholder_mismatch:'公式标记校验失败，请重试',
      direction: '仅支持英语与中文互译', response: 'PDF 翻译结果无效，请重试', stopped: '', timeout: 'PDF 翻译连接超时，请重试',
      alignment_unavailable: '词语对应尚未就绪，可重试', alignment_timeout: '词语对应准备超时，可重试', alignment_invalid: '词语对应校验失败，可重试', compatibility: 'PDF 阅读接口暂不可用，请重新打开 PDF', limit: '这份 PDF 超出本地处理上限', bridge: '无法连接本机 PDF 翻译服务' };
    const page=Number.isInteger(error?.failedPage)&&error.failedPage>=1&&error.failedPage<=2000?'第 '+error.failedPage+' 页：':'';
    const text=error?.code==='batch_invalid'&&error?.errorDetail==='formula'?messages.formula_placeholder_mismatch:error?.code==='batch_invalid'&&error?.errorDetail==='content'?'译文数值与原文不一致，请重试':messages[error?.code] ?? messages.translation_failed;
    return text?page+text:'';
  }
  function diagnostic(stage,error){
    const stages=new Set(['context','mount','start','output','render','text','toolbar','bootstrap','rendered','recycled','layout','startBegin','retired','jobReady','outputBegin','outputReady','stale','loadBegin','loadReady','renderBegin','sentence','native','nativeState','nativeSearch','nativeAnnotation','nativeSelection','nativePopup','nativeCopy','nativeMenu','nativeFocus','nativeEmbedded','nativeDispose','nativeConstructed','nativeInitialized','nativePainted','nativeReady']);
    const names=new Set(['Error','TypeError','ReferenceError','SecurityError','NetworkError','AbortError','TimeoutException','NS_ERROR_FAILURE','NS_ERROR_XPC_BAD_OP_ON_WN_PROTO','DataCloneError','RenderSnapshot']);
    const locations=[];const stack=typeof error?.stack==='string'?error.stack.slice(0,12000):'';
    for(const match of stack.matchAll(/(?:^|[/\\])(inline\.js|pdf-layout\.js|pdf-native-view\.js|reader\.js|pdf\.mjs):(\d+)(?::\d+)?/gm)){
      const item={file:match[1],line:Number(match[2])};if(item.line>0&&item.line<100000&&!locations.some(x=>x.file===item.file&&x.line===item.line))locations.push(item);if(locations.length===8)break;
    }
    const record={stage:stages.has(stage)?stage:'unknown',exception:names.has(error?.name)?error.name:'Other',code:knownErrors.has(error?.code)?error.code:'unknown',locations};
    if(validationDetails.has(error?.errorDetail))record.errorDetail=error.errorDetail;
    if(nativeErrorProperties.has(error?.errorProperty))record.errorProperty=error.errorProperty;
    if(['unmatched','coverage','no_phrases','unowned_glyph','native_glyph','partial_phrase'].includes(error?.mappingDetail))record.mappingDetail=error.mappingDetail;
    if(error?.mappingNumbers){record.mappingNumbers={};for(const key of ['outputPage','sourcePage','selectionRects','matchedSentences','uncoveredRects']){const value=error.mappingNumbers[key];record.mappingNumbers[key]=Number.isInteger(value)&&value>=0&&value<=200000?value:-1;}}
    if(Number.isInteger(error?.failedPage)&&error.failedPage>=1&&error.failedPage<=2000)record.failedPage=error.failedPage;
    if(error?.numbers&&Number.isInteger(error.numbers.expectedPages)&&error.numbers.expectedPages>=1&&error.numbers.expectedPages<=2000){record.numbers={expectedPages:error.numbers.expectedPages,actualPages:Number.isInteger(error.numbers.actualPages)&&error.numbers.actualPages>=0&&error.numbers.actualPages<=2000?error.numbers.actualPages:-1};}
    if(error?.renderNumbers){const numbers={};for(const key of ['width','height','holderChildCount','textItemsCount','renderedCount','nonWhiteSamples']){const n=error.renderNumbers[key];numbers[key]=Number.isInteger(n)&&n>=0&&n<=100000?n:-1;}record.renderNumbers=numbers;}
    if(error?.layoutNumbers){record.layoutNumbers={};for(const key of ['canvasWidth','canvasHeight','canvasClientWidth','canvasClientHeight','canvasOffsetWidth','canvasOffsetHeight','canvasLeft','canvasTop','canvasRectWidth','canvasRectHeight','holderLeft','holderTop','holderRectWidth','holderRectHeight','frameRectWidth','frameRectHeight','canvasDisplay','canvasVisibility','canvasOpacity','holderDisplay','holderVisibility','holderOpacity','frameVisibility','styleWidth','styleHeight','canvasConnected','holderConnected','holderChildCount','textSpanCount','renderedCount','hiddenAncestors','alphaZero','opaque','nonWhiteSamples']){const value=error.layoutNumbers[key];record.layoutNumbers[key]=Number.isFinite(value)&&value>=-10000000&&value<=10000000?Math.round(value):-1;}}
    return record;
  }
  function byteArray(value) {
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(value);
    throw new PDFError('pdf');
  }
  function copyOpenPDFData(value,components){
    // Called exclusively on getData() from the still-current, explicitly
    // opened Zotero PDF. Never waive a Window, document, URL or arbitrary page.
    const source=typeof components?.utils?.waiveXrays==='function'?components.utils.waiveXrays(value):value;
    if(!ArrayBuffer.isView(source)||source.BYTES_PER_ELEMENT!==1||!Number.isInteger(source.byteLength)||source.byteLength<5)throw new PDFError('pdf');
    if(source.byteLength>MAX_INPUT_BYTES)throw new PDFError('limit');
    const copy=new Uint8Array(source.byteLength);
    copy.set(source);
    return copy;
  }
  function validPDF(value, maximum = MAX_INPUT_BYTES) {
    const data = byteArray(value);
    if (data.length < 5 || data.length > maximum) throw new PDFError(data.length > maximum ? 'limit' : 'pdf');
    if (![37,80,68,70,45].every((v,i) => data[i] === v)) throw new PDFError('pdf');
    return data;
  }
  const validID = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  function validateProgress(value){
    if(!value||!['preparing','translating','layout','loading'].includes(value.stage))return null;
    const result={stage:value.stage};
    if(value.completed!==undefined||value.total!==undefined){
      if(!Number.isInteger(value.total)||value.total<1||value.total>2000||!Number.isInteger(value.completed)||value.completed<0||value.completed>value.total)return null;
      result.completed=value.completed;result.total=value.total;
    }
    return result;
  }
  function validateStatus(value, expectedID, selection) {
    if (!value || !validID(value.id) || (expectedID && value.id !== expectedID)
      || !['running','complete','failed','cancelled'].includes(value.state)
      || !Number.isInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > 2000
      || !Array.isArray(value.sourcePages) || value.sourcePages.length < 1 || value.sourcePages.length > value.pageCount
      || value.sourcePages.some(x => !Number.isInteger(x) || x < 0 || x >= value.pageCount)
      || new Set(value.sourcePages).size !== value.sourcePages.length) throw new PDFError('response');
    if (selection === 'all' && (value.sourcePages.length !== value.pageCount || value.sourcePages.some((x,i) => x !== i))) throw new PDFError('response');
    if (selection && selection !== 'all' && (value.sourcePages.length !== 1 || value.sourcePages[0] !== Number(selection)-1)) throw new PDFError('response');
    return { id: value.id, state: value.state, sourcePages: value.sourcePages.slice(), pageCount: value.pageCount,
      error: typeof value.error === 'string' && knownErrors.has(value.error) ? value.error : 'translation_failed',
      ...(validateProgress(value.progress)?{progress:validateProgress(value.progress)}:{}),
      ...(validationDetails.has(value.errorDetail)?{errorDetail:value.errorDetail}:{}),
      ...(Number.isInteger(value.failedPage)&&value.sourcePages.includes(value.failedPage-1)?{failedPage:value.failedPage}:{}) };
  }
  function validatePhraseMetadata(sentence,page,fail){
    const rect=value=>Array.isArray(value)&&value.length===4&&value.every(n=>Number.isFinite(n)&&Math.abs(n)<=1000000)&&value[2]>value[0]&&value[3]>value[1];
    const unchangedGlyphs=(source,target)=>source.text===target.text&&source.rects.length===target.rects.length&&source.rects.every((r,i)=>r.every((n,j)=>Math.abs(n-target.rects[i][j])<=.01+1e-9));
    function transformRect(m,r){const corners=[[r[0],r[1]],[r[2],r[1]],[r[0],r[3]],[r[2],r[3]]].map(([x,y])=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]]);return [Math.min(...corners.map(p=>p[0])),Math.min(...corners.map(p=>p[1])),Math.max(...corners.map(p=>p[0])),Math.max(...corners.map(p=>p[1]))];}
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
    validatePhraseData(sentence,page,fail);
  }
  function sentenceCoverage(page){
    if(!page||!Array.isArray(page.paragraphs))return false;
    const normalize=text=>text.normalize('NFKC').toLowerCase().replace(/ß/g,'ss').replace(/ς/g,'σ').replace(/[\s\u00ad\u200b\ufeff]/gu,'').replace(/\u2010/g,'-');
    const counts=text=>{const result=new Map();for(const c of normalize(text))result.set(c,(result.get(c)||0)+1);return result;};
    return page.paragraphs.every(paragraph=>['source','target'].every(side=>{
      if(typeof paragraph[side]?.text!=='string'||!Array.isArray(paragraph.sentences))return false;
      const parts=paragraph.sentences.map(sentence=>sentence[side]?.text);if(parts.some(text=>typeof text!=='string'))return false;
      const whole=counts(paragraph[side].text),mapped=counts(parts.join(''));return whole.size===mapped.size&&[...whole].every(([c,n])=>mapped.get(c)===n);
    }));
  }
  function validateAlignment(value,sourcePages){
    const fail=()=>{throw new PDFError('response');};
    if(!value||value.schema!==1||value.coordinateSpace!=='pdf'||!['paragraph','sentence'].includes(value.granularity)
      ||!Array.isArray(sourcePages)||!sourcePages.length||sourcePages.length>2000
      ||!Array.isArray(value.pages)||value.pages.length!==sourcePages.length)return fail();
    if(value.sourceSHA256!==undefined&&(typeof value.sourceSHA256!=='string'||!/^[0-9a-f]{64}$/.test(value.sourceSHA256)))return fail();
    const rect=value=>{if(!Array.isArray(value)||value.length!==4||!value.every(x=>Number.isFinite(x)&&Math.abs(x)<=1000000)||value[2]<=value[0]||value[3]<=value[1])return fail();return value.slice();};
    const geometry=value=>{if(!value||![0,90,180,270].includes(value.rotation))return fail();return {mediaBox:rect(value.mediaBox),cropBox:rect(value.cropBox),rotation:value.rotation};};
    const part=(value,fallback)=>{if(!value||!Array.isArray(value.rects)||value.rects.length>4096)return fail();const text=value.text??fallback;
      if(typeof text!=='string'||text.length>100000)return fail();return {text,rects:value.rects.map(rect)};};
    const affine=value=>{if(!Array.isArray(value)||value.length!==6||!value.every(x=>Number.isFinite(x)&&Math.abs(x)<=1000000)||Math.abs(value[0]*value[3]-value[1]*value[2])<1e-8)return fail();return value.slice();};
    const semantic=value.sentenceAlignmentRevision==='pdf-sentence-semantic-v1';
    if(value.sentenceAlignmentRevision!==undefined&&!semantic)return fail();
    const sentencePages=value.sentencePages??[];
    if(!Array.isArray(sentencePages)||new Set(sentencePages).size!==sentencePages.length||sentencePages.some(page=>!Number.isInteger(page)||!sourcePages.includes(page))||(!semantic&&(sentencePages.length||value.granularity==='sentence')))return fail();
    const partialPages=value.sentencePartialPages??[];
    if(!Array.isArray(partialPages)||new Set(partialPages).size!==partialPages.length||partialPages.some(page=>!Number.isInteger(page)||!sourcePages.includes(page)||sentencePages.includes(page))||!semantic&&partialPages.length)return fail();
    const presentPages=[...sentencePages,...partialPages];
    const precise=value.phraseAlignmentRevision==='pdf-phrase-semantic-v1',phrasePages=value.phrasePages??[];
    if(value.phraseAlignmentRevision!==undefined&&!precise||!Array.isArray(phrasePages)||new Set(phrasePages).size!==phrasePages.length||phrasePages.some(page=>!presentPages.includes(page))||!precise&&phrasePages.length)return fail();
    let extraction={};
    if(['phraseExtractionRevision','phraseExtractedPages','phraseCoverage'].some(key=>value[key]!==undefined)){
      const pages=value.phraseExtractedPages,coverage=value.phraseCoverage,keys=['sentences','extractable','aligned','unavailable','sourceTokens','targetTokens','mappedSourceTokens','mappedTargetTokens'];
      if(!precise||value.phraseExtractionRevision!=='pdf-glyph-boundary-v2'||!Array.isArray(pages)||new Set(pages).size!==pages.length||pages.some(page=>!Number.isInteger(page)||!phrasePages.includes(page)||!sentencePages.includes(page))||!coverage||typeof coverage!=='object'||Array.isArray(coverage))return fail();
      const covered=Object.keys(coverage),allowed=phrasePages.map(String);
      if(covered.length>allowed.length||covered.some(page=>!allowed.includes(page))||pages.some(page=>!covered.includes(String(page))))return fail();
      const clean={};for(const page of covered){const row=coverage[page];if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==keys.length||keys.some(key=>!Number.isInteger(row[key])||row[key]<0||row[key]>10000000)||row.extractable>row.sentences||row.aligned>row.extractable||row.unavailable!==row.extractable-row.aligned||row.sourceTokens<row.extractable||row.targetTokens<row.extractable||row.mappedSourceTokens>row.sourceTokens||row.mappedTargetTokens>row.targetTokens)return fail();clean[page]=Object.fromEntries(keys.map(key=>[key,row[key]]));}
      extraction={phraseExtractionRevision:value.phraseExtractionRevision,phraseExtractedPages:pages.slice(),phraseCoverage:clean};
    }
    const glyphs=values=>values.map(g=>({text:g.text,rect:g.rect===null?null:rect(g.rect),line:g.line??null}));
    let total=0,totalSentences=0;
    return {schema:1,coordinateSpace:'pdf',granularity:value.granularity,...(value.sourceSHA256!==undefined?{sourceSHA256:value.sourceSHA256}:{}),...(semantic?{sentenceAlignmentRevision:value.sentenceAlignmentRevision,sentencePages:sentencePages.slice(),...(value.sentencePartialPages!==undefined?{sentencePartialPages:partialPages.slice()}:{})}:{}),...(precise?{phraseAlignmentRevision:value.phraseAlignmentRevision,phrasePages:phrasePages.slice()}:{}),...extraction,pages:value.pages.map((page,index)=>{
      if(!page||page.outputPage!==index||page.sourcePage!==sourcePages[index]||!Number.isInteger(page.sourcePage)||page.sourcePage<0||page.sourcePage>=2000
        ||!Array.isArray(page.paragraphs)||page.paragraphs.length>10000)return fail();
      total+=page.paragraphs.length;if(total>100000)return fail();const seen=new Set();
      return {sourcePage:page.sourcePage,outputPage:index,source:geometry(page.source),mono:geometry(page.mono),dual:geometry(page.dual),sourceToDual:affine(page.sourceToDual),targetToDual:affine(page.targetToDual),paragraphs:page.paragraphs.map(row=>{
        if(!row||typeof row.id!=='string'||!row.id.length||row.id.length>128||seen.has(row.id))return fail();seen.add(row.id);
        const source=part(row.source),target=part(row.target);
        const result={id:row.id,source,target,dualSource:part(row.dualSource,source.text),dualTarget:part(row.dualTarget,target.text)};
        if(row.sentences!==undefined){
          if(!semantic||!presentPages.includes(page.sourcePage)||!Array.isArray(row.sentences)||row.sentences.length>1000)return fail();
          const sentenceIDs=new Set();result.sentences=row.sentences.map(sentence=>{
            if(!sentence||typeof sentence.id!=='string'||!sentence.id||sentence.id.length>256||sentenceIDs.has(sentence.id)||!['semantic-model','glyph-identity'].includes(sentence.method)||++totalSentences>200000)return fail();sentenceIDs.add(sentence.id);
            const source=part(sentence.source),target=part(sentence.target),dualSource=part(sentence.dualSource,source.text),dualTarget=part(sentence.dualTarget,target.text);
            if(![source,target,dualSource,dualTarget].every(p=>p.rects.length))return fail();
            if(sentence.method==='glyph-identity'&&(source.text!==target.text||source.rects.length!==target.rects.length||!source.rects.every((r,i)=>r.every((n,j)=>Math.abs(n-target.rects[i][j])<=.01+1e-9))))return fail();
            let phrases;
            if(sentence.phrases!==undefined){
              if(!precise||!phrasePages.includes(page.sourcePage))return fail();validatePhraseMetadata(sentence,page,fail);
              if(sentence.source.glyphs){source.glyphs=glyphs(sentence.source.glyphs);target.glyphs=glyphs(sentence.target.glyphs);}
              phrases=sentence.phrases.map(phrase=>({id:phrase.id,method:phrase.method,source:{...part(phrase.source),glyphs:glyphs(phrase.source.glyphs)},target:{...part(phrase.target),glyphs:glyphs(phrase.target.glyphs)},dualSource:part(phrase.dualSource,phrase.source.text),dualTarget:part(phrase.dualTarget,phrase.target.text),sourceTokenCount:phrase.sourceTokenCount,targetTokenCount:phrase.targetTokenCount}));
            }
            return {id:sentence.id,source,target,dualSource,dualTarget,method:sentence.method,...(phrases?{phrases}:{})};
          });
        }
        return result;
      })};
    })};
  }
  function createTransport(dependencies, readConnection) {
    const { Zotero, setTimer, clearTimer } = dependencies;
    const alignmentMutations=new Map(),alignmentIntents=new Map();
    function acquireAlignmentIntent(id){
      const entry=alignmentIntents.get(id)||{active:0,latest:null},token={};
      entry.active++;entry.latest=token;alignmentIntents.set(id,entry);
      return {current:()=>entry.latest===token,release:()=>{if(!--entry.active)alignmentIntents.delete(id);}};
    }
    async function request(method, suffix, connection, body, headers = {}, control = null, binary = false, jsonLimit = 65536) {
      if (control?.aborted) throw new PDFError('stopped');
      if(control)control.requestMethod=method;
      try {
        const response = await Zotero.HTTP.request(method, BASE + suffix, {
          ...(body ? {body} : {}), headers: {Authorization: 'Bearer ' + connection.token, ...headers},
          timeout: binary ? 60000 : 20000, responseType: binary ? 'arraybuffer' : 'text',
          anon: true, noCache: true, debug: false, logBodyLength: 0, followRedirects: false,
          errorDelayMax: 0, successCodes: [200,202,204],
          cancellerReceiver(cancel) { if (control) { control.abortRequest = cancel; if (control.aborted && method !== 'POST') cancel(); } }
        });
        if (control?.aborted && method !== 'POST') throw new PDFError('stopped');
        if (binary) {
          if (response.status !== 200) throw new PDFError('response');
          const output = validPDF(response.response, MAX_OUTPUT_BYTES);
          return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
        }
        if (method === 'DELETE' && response.status === 204) return null;
        if (![200,202].includes(response.status) || typeof response.responseText !== 'string' || response.responseText.length > jsonLimit) throw new PDFError('response');
        try { return JSON.parse(response.responseText); } catch (_) { throw new PDFError('response'); }
      } catch (error) {
        if (control?.aborted) throw new PDFError('stopped');
        if (error instanceof PDFError) throw error;
        const xhr = error?.xmlhttp;
        if (xhr?.status === 401) throw new PDFError('connection');
        let code;
        try { const parsed = JSON.parse(xhr?.responseText || '{}'); code = typeof parsed.error === 'string' ? parsed.error : parsed.error?.code; } catch (_) {}
        if (knownErrors.has(code)) throw new PDFError(code);
        if (error?.name === 'TimeoutException') throw new PDFError('timeout');
        throw new PDFError('bridge');
      } finally { if (control) {control.abortRequest = null;control.requestMethod=null;} }
    }
    async function mutateAlignment(id,connection,body,headers,control=null){
      // Every focus change and PDF submission for one independent service job
      // commits in input order. Cancelling a watcher can skip a queued request,
      // but never lets newer focus overtake an already accepted atomic POST.
      const previous=alignmentMutations.get(id)||Promise.resolve(),pending=previous.catch(()=>{}).then(async()=>{
        if(control?.aborted)throw new PDFError('stopped');
        const resolved=typeof connection==='function'?await connection():connection;
        if(control?.aborted)throw new PDFError('stopped');
        const value=await request('POST','/'+id+'/alignment-upgrade',resolved,body,headers,control);
        if(control?.aborted)throw new PDFError('stopped');return value;
      });
      alignmentMutations.set(id,pending);
      try{return await pending;}finally{if(alignmentMutations.get(id)===pending)alignmentMutations.delete(id);}
    }
    function validSourcePages(value){
      if(!Array.isArray(value)||!value.length||value.length>2000||new Set(value).size!==value.length)return false;
      for(let index=0;index<value.length;index++)if(!Number.isInteger(value[index])||value[index]<0||value[index]>=2000)return false;
      return true;
    }
    function priorityUnits(value){
      if(!Array.isArray(value)||value.length>8||new Set(value).size!==value.length)throw new PDFError('response');
      for(let index=0;index<value.length;index++)if(typeof value[index]!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(value[index]))throw new PDFError('response');
      return value.slice();
    }
    function validateUpgradeState(value,id,sourcePages){
      if(!value||value.id!==id||!['idle','running','complete','failed'].includes(value.state)||!Array.isArray(value.sourcePages)||!value.sourcePages.every(page=>Number.isInteger(page)&&sourcePages.includes(page))||!Array.isArray(value.completedPages)||!value.completedPages.every(page=>Number.isInteger(page)&&sourcePages.includes(page))||!Number.isInteger(value.mappedSentences)||value.mappedSentences<0||value.mappedSentences>200000)throw new PDFError('response');
      if(value.sourcePages.length>sourcePages.length||new Set(value.sourcePages).size!==value.sourcePages.length||value.completedPages.length>sourcePages.length||new Set(value.completedPages).size!==value.completedPages.length)throw new PDFError('response');
      if(value.alignmentVersion!==undefined&&(typeof value.alignmentVersion!=='string'||!/^[0-9a-f]{64}$/.test(value.alignmentVersion)))throw new PDFError('response');
      if(value.currentPage!==undefined&&value.currentPage!==null&&(!Number.isInteger(value.currentPage)||!sourcePages.includes(value.currentPage)))throw new PDFError('response');
      if(value.pendingPages!==undefined&&(!Array.isArray(value.pendingPages)||value.pendingPages.length>sourcePages.length||new Set(value.pendingPages).size!==value.pendingPages.length||value.pendingPages.some(page=>!Number.isInteger(page)||!sourcePages.includes(page))))throw new PDFError('response');
      return value;
    }
    async function prioritize(id,page,sourcePages,units,connection,control=null){
      const body=JSON.stringify({page,units});
      return validateUpgradeState(await mutateAlignment(id,connection,body,{'Content-Type':'application/json'},control),id,sourcePages);
    }
    return {
      async start(value, options, setCancel = () => {}, onProgress = () => {}) {
        const data = validPDF(value);
        if (!options || !((options.source === 'en' && options.target === 'zh-Hans') || (options.source === 'zh-Hans' && options.target === 'en'))) throw new PDFError('direction');
        if (!(options.pages === 'all' || /^[1-9][0-9]{0,3}$/.test(options.pages) && Number(options.pages) <= 2000)) throw new PDFError('limit');
        const control = {aborted:false,abortRequest:null,id:null,timer:null,rejectDelay:null,deletePromise:null};
        let connection,finish;
        const finished=new Promise(resolve=>{finish=resolve;});
        const removeJob=()=>{
          if(!connection||!control.id)return Promise.resolve();
          if(!control.deletePromise)control.deletePromise=request('DELETE','/'+control.id,connection).catch(()=>{});
          return control.deletePromise;
        };
        setCancel(()=>{
          control.aborted=true;
          // Let the short POST finish so a late job ID can be retired. Aborting
          // it before its response would lose the ID of a running server job.
          if(control.id){try{control.abortRequest?.();}catch(_){}}
          if(control.timer!==null)clearTimer(control.timer);
          control.rejectDelay?.(new PDFError('stopped'));control.rejectDelay=null;
          return Promise.all([finished,removeJob()]).then(()=>{});
        });
        try{
          connection=await readConnection(dependencies);if(control.aborted)throw new PDFError('stopped');
          const input=data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);
          let response=await request('POST','',connection,input,{'Content-Type':'application/pdf',
            'X-AskGPT-Pages':options.pages,'X-AskGPT-Source':options.source,'X-AskGPT-Target':options.target},control);
          let state=validateStatus(response,null,options.pages);control.id=state.id;
          if(!control.aborted&&state.state==='running')onProgress(state.progress||{stage:'preparing'});
          if(control.aborted){await removeJob();throw new PDFError('stopped');}
          const deadline=Date.now()+30*60*1000;
          while(state.state==='running'){
            if(Date.now()>deadline){await removeJob();throw new PDFError('timeout');}
            await new Promise((resolve,reject)=>{control.rejectDelay=reject;control.timer=setTimer(()=>{control.timer=null;control.rejectDelay=null;resolve();},500);});
            if(control.aborted)throw new PDFError('stopped');
            response=await request('GET','/'+state.id,connection,null,{},control);
            state=validateStatus(response,control.id,options.pages);
            if(!control.aborted&&state.state==='running')onProgress(state.progress||{stage:'preparing'});
          }
          if(state.state==='cancelled')throw new PDFError('stopped');
          if(state.state==='failed'){const error=new PDFError(state.error);error.errorDetail=state.errorDetail;error.failedPage=state.failedPage;throw error;}
          return state;
        }finally{
          if(control.aborted)await removeJob();
          finish();
        }
      },
      async output(id, mode) {
        if (!validID(id) || !['mono','dual'].includes(mode)) throw new PDFError('response');
        const connection = await readConnection(dependencies);
        return request('GET', '/' + id + '/' + mode + '.pdf', connection, null, {}, null, true);
      },
      async alignment(id,sourcePages){
        if(!validID(id)||!Array.isArray(sourcePages)||!sourcePages.length)throw new PDFError('response');
        const connection=await readConnection(dependencies);
        return validateAlignment(await request('GET','/'+id+'/alignment.json',connection,null,{},null,false,MAX_ALIGNMENT_BYTES),sourcePages);
      },
      async prioritizeAlignment(id,page,sourcePages,units=[]){
        if(!validID(id)||!validSourcePages(sourcePages)||!Number.isInteger(page)||!sourcePages.includes(page))throw new PDFError('response');
        const selected=priorityUnits(units),intent=acquireAlignmentIntent(id);
        try{return await prioritize(id,page,sourcePages,selected,()=>readConnection(dependencies));}finally{intent.release();}
      },
      async upgradeAlignment(id,value,pages,sourcePages,setCancel=()=>{},options={}){
        if(!validID(id)||!validSourcePages(sourcePages)||!validSourcePages(pages)||pages.some(page=>!sourcePages.includes(page))||!options||typeof options!=='object'||Array.isArray(options))throw new PDFError('response');
        const ahead=options.prefetchPages??[];
        if(!Array.isArray(ahead)||ahead.length>1||ahead.length&&!validSourcePages(ahead)||ahead.some(page=>!sourcePages.includes(page)))throw new PDFError('response');
        if(options.onPartial!==undefined&&typeof options.onPartial!=='function')throw new PDFError('response');
        const prepare=[...new Set([...pages,...ahead])];
        const units=priorityUnits(options.units===undefined?[]:options.units),hasUnits=options.units!==undefined;
        if(hasUnits&&prepare.length!==1)throw new PDFError('response');
        const data=validPDF(value),control={aborted:false,abortRequest:null,timer:null,rejectDelay:null},intent=acquireAlignmentIntent(id);
        try{
        setCancel(()=>{control.aborted=true;if(control.requestMethod!=='POST')try{control.abortRequest?.();}catch(_){}if(control.timer!==null)clearTimer(control.timer);control.rejectDelay?.(new PDFError('stopped'));control.rejectDelay=null;});
        const connection=await readConnection(dependencies);if(control.aborted)throw new PDFError('stopped');
        const suffix='/'+id+'/alignment-upgrade';
        const validate=value=>validateUpgradeState(value,id,sourcePages);
        let deliveredVersion=null,deliveredAlignment=null;
        const refreshPartial=async state=>{
          if(!options.onPartial||!['running','failed'].includes(state.state)||!state.alignmentVersion||state.alignmentVersion===deliveredVersion)return;
          const alignment=validateAlignment(await request('GET','/'+id+'/alignment.json',connection,null,{},control,false,MAX_ALIGNMENT_BYTES),sourcePages);
          if(control.aborted)throw new PDFError('stopped');
          await options.onPartial(alignment);
          if(control.aborted)throw new PDFError('stopped');
          deliveredVersion=state.alignmentVersion;deliveredAlignment=alignment;
        };
        let state=options.probe===true?validate(await request('GET',suffix,connection,null,{},control)):null;
        if(state?.state==='running'&&intent.current())state=await prioritize(id,pages[0],sourcePages,units,connection,control);
        if(state)await refreshPartial(state);
        const scheduled=state?.state==='running'?[state.currentPage,...(state.pendingPages||[])]:[];
        const missing=state?prepare.filter(page=>!state.completedPages.includes(page)&&!scheduled.includes(page)):prepare;
        if(control.aborted)throw new PDFError('stopped');
        // A delayed probe must not upload an obsolete page/selection after a
        // newer focus has committed. Existing service work keeps running.
        if(missing.length&&!intent.current())throw new PDFError('stopped');
        if(missing.length)state=validate(await mutateAlignment(id,connection,data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),{'Content-Type':'application/pdf','X-AskGPT-Pages':missing.map(page=>page+1).join(','),...(hasUnits?{'X-AskGPT-Units':JSON.stringify(units)}:{})},control));
        await refreshPartial(state);
        const deadline=Date.now()+2*60*1000;
        while(!pages.every(page=>state.completedPages.includes(page))&&state.state==='running'){
          if(control.aborted)throw new PDFError('stopped');if(Date.now()>deadline)throw new PDFError('timeout');
          await new Promise((resolve,reject)=>{control.rejectDelay=reject;control.timer=setTimer(()=>{control.timer=null;control.rejectDelay=null;resolve();},500);});
          state=validate(await request('GET',suffix,connection,null,{},control));
          await refreshPartial(state);
        }
        if(control.aborted)throw new PDFError('stopped');
        if(!pages.every(page=>state.completedPages.includes(page)))throw new PDFError(knownErrors.has(state.error)?state.error:'alignment_unavailable');
        if(state.alignmentVersion&&state.alignmentVersion===deliveredVersion)return deliveredAlignment;
        return validateAlignment(await request('GET','/'+id+'/alignment.json',connection,null,{},control,false,MAX_ALIGNMENT_BYTES),sourcePages);
        }finally{intent.release();}
      },
      async cancel(id) {
        if (!validID(id)) return;
        const connection = await readConnection(dependencies);
        await request('DELETE', '/' + id, connection);
      }
    };
  }
  function element(doc,name,className,text) {
    const node = doc.createElementNS(XHTML,name); if (className) node.className = className;
    if (text != null) node.textContent = text; return node;
  }
  function transfer(value, target, components, reflectors = false) {
    return typeof components?.utils?.cloneInto === 'function'
      ? components.utils.cloneInto(value, target, reflectors ? {wrapReflectors:true} : {}) : value;
  }
  function ownedOutput(value,components){
    // Only newly created output loading tasks/documents/pages/viewports/render
    // tasks and its own freshly created canvas context pass here. Zotero's
    // original Window/document are never unwrapped.
    return value&&typeof components?.utils?.waiveXrays==='function'?components.utils.waiveXrays(value):value;
  }
  async function completed(value,components){
    const promise=ownedOutput(value,components);
    if(!promise||typeof promise.then!=='function')throw new PDFError('compatibility');
    return await new Promise((resolve,reject)=>promise.then(resolve,reject));
  }
  async function mount(context, css, actions, appearance = {}) {
    const {win, viewer:pdfViewer} = context, outer = win.document;
    const original = outer.getElementById('viewerContainer');
    if (!original || !outer.body) throw new PDFError('compatibility');
    const initial = {top:original.scrollTop,left:original.scrollLeft,visibility:original.style.getPropertyValue('visibility'),priority:original.style.getPropertyPriority('visibility')};
    const frame = element(outer,'iframe'); frame.setAttribute('title','Ask for GPT · PDF');
    // Canvas displays fallback content when the sandbox disables scripting.
    // Enable its bitmap presentation; the fixed srcdoc contains no scripts,
    // and the separate CSP below still forbids executing any page script.
    frame.setAttribute('sandbox','allow-same-origin allow-scripts');
    frame.setAttribute('style','position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483000;background:Canvas;visibility:hidden');
    frame.style.setProperty('visibility','hidden');
    frame.setAttribute('srcdoc','<!doctype html><html><head><meta charset="UTF-8"></head><body></body></html>');
    await new Promise((resolve,reject) => {
      let done=false,timer=null;
      const finish=error=>{if(done)return;done=true;frame.removeEventListener('load',loaded);frame.removeEventListener('error',failed);if(timer!==null)win.clearTimeout(timer);appearance.setCancel?.(null);if(error){frame.remove();reject(error);}else resolve();};
      const loaded=()=>{try{if(frame.contentDocument?.URL==='about:srcdoc'&&frame.contentDocument.readyState==='complete')finish();}catch(_){failed();}};
      const failed=()=>finish(new PDFError('compatibility'));
      frame.addEventListener('load',loaded);frame.addEventListener('error',failed);
      appearance.setCancel?.(()=>finish(new PDFError('stopped')));
      timer=win.setTimeout(failed,3000);outer.body.appendChild(frame);
    });
    if (appearance.isCurrent?.()===false) {frame.remove();throw new PDFError('stopped');}
    const doc=frame.contentDocument, listeners=[], tasks=new Set(), rendered=new Map(),layoutTimers=new Set(),layoutFrames=new Set();
    if(!doc?.body||!doc?.head){frame.remove();throw new PDFError('compatibility');}
    const meta=element(doc,'meta');meta.setAttribute('http-equiv','Content-Security-Policy');meta.setAttribute('content',"default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; frame-src 'none'; connect-src 'none'");doc.head.appendChild(meta);
    doc.head.appendChild(element(doc,'style',null,css));
    const header=element(doc,'header','askgpt-controls'), body=element(doc,'main','askgpt-pdf-pages'), status=element(doc,'div','askgpt-status');status.hidden=true;status.setAttribute('role','alert');
    const listen=(node,type,handler,options)=>{node.addEventListener(type,handler,options);listeners.push(()=>node.removeEventListener(type,handler,options));};
    // This belongs to the host document so preparation never hides the PDF.
    // Only this scoped material is injected into Zotero's original reader.
    const progressStyle=element(outer,'style',null,`
      .askgpt-pdf-progress{color-scheme:light dark;position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483101;width:240px;max-width:calc(100% - 28px);box-sizing:border-box;padding:11px 13px;border:1px solid rgb(128 128 128 / 18%);border-radius:13px;background:light-dark(rgb(255 255 255 / 91%),rgb(36 37 36 / 94%));color:CanvasText;backdrop-filter:blur(20px) saturate(1.2);box-shadow:0 3px 18px rgb(0 0 0 / 10%);font:12px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;}
      .askgpt-pdf-progress[hidden]{display:none!important;}
      .askgpt-pdf-progress-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;}
      .askgpt-pdf-progress button{appearance:none;display:grid;place-items:center;width:20px;height:20px;min-width:20px;padding:0;border:0;border-radius:50%;background:rgb(128 128 128 / 12%);color:inherit;font:15px/1 -apple-system,sans-serif;cursor:pointer;}
      .askgpt-pdf-progress button:active{background:rgb(128 128 128 / 24%);}
      .askgpt-pdf-progress progress{appearance:none;display:block;width:100%;height:4px;border:0;background:rgb(128 128 128 / 16%);accent-color:#007aff;border-radius:999px;overflow:hidden;}
      .askgpt-pdf-progress progress::-webkit-progress-bar{background:rgb(128 128 128 / 16%);border-radius:999px;}
      .askgpt-pdf-progress progress::-webkit-progress-value{background:#007aff;border-radius:999px;}
      .askgpt-pdf-progress progress::-moz-progress-bar{background:#007aff;border-radius:999px;}
      .askgpt-pdf-progress progress:indeterminate{background:linear-gradient(90deg,rgb(128 128 128 / 12%) 25%,#007aff 50%,rgb(128 128 128 / 12%) 75%) 100% 0 / 200% 100%;animation:askgpt-progress-pulse 1.6s linear infinite;}
      .askgpt-pdf-progress progress:indeterminate::-webkit-progress-bar{background:transparent;}
      .askgpt-pdf-progress progress:indeterminate::-moz-progress-bar{background:transparent;}
      @keyframes askgpt-progress-pulse{to{background-position:-100% 0;}}
      @media(prefers-reduced-transparency:reduce){.askgpt-pdf-progress{background:Canvas;backdrop-filter:none;}}
      @media(prefers-contrast:more){.askgpt-pdf-progress{background:Canvas;border-color:CanvasText;box-shadow:none;}}
      @media(prefers-reduced-motion:reduce){.askgpt-pdf-progress progress{animation:none;}}
    `);
    const progressHUD=element(outer,'div','askgpt-pdf-progress'),progressRow=element(outer,'div','askgpt-pdf-progress-row'),progressLabel=element(outer,'span'),progressBar=element(outer,'progress'),progressCancel=element(outer,'button',null,'×');
    progressHUD.hidden=true;progressLabel.setAttribute('role','status');progressLabel.setAttribute('aria-live','polite');
    progressBar.setAttribute('aria-label','Translation progress');progressCancel.setAttribute('aria-label','Cancel translation');progressCancel.setAttribute('type','button');
    listen(progressCancel,'click',()=>actions.exit?.());progressRow.append(progressLabel,progressCancel);progressHUD.append(progressRow,progressBar);outer.head.appendChild(progressStyle);outer.body.appendChild(progressHUD);
    function setProgress(value){
      const progress=validateProgress(value);progressHUD.hidden=!progress;
      if(!progress)return;
      const chinese=!win.navigator?.language||win.navigator.language.startsWith('zh');
      const labels=chinese?{preparing:'准备翻译',translating:'翻译',layout:'整理版式',loading:'载入译文'}:{preparing:'Preparing',translating:'Translating',layout:'Preserving layout',loading:'Opening translation'};
      const text=labels[progress.stage]+(progress.total?' · '+progress.completed+' / '+progress.total:'');progressLabel.textContent=text;
      progressBar.setAttribute('aria-valuetext',text);
      if(progress.total>1){progressBar.setAttribute('max',String(progress.total));progressBar.setAttribute('value',String(progress.completed));}
      else {progressBar.removeAttribute('value');progressBar.removeAttribute('max');}
    }
    const button=(label,title,action,parent=header)=>{const node=element(doc,'button','',label);node.setAttribute('type','button');node.setAttribute('title',title);node.setAttribute('aria-label',title);listen(node,'click',()=>{void Promise.resolve(action()).catch(error=>setStatus(errorMessage(error)));});parent.appendChild(node);return node;};
    const modes=element(doc,'div','askgpt-control-group');header.appendChild(modes);
    button('原文','Original PDF · 原文',()=>actions.exit(),modes);
    const mono=button('译文','Translated PDF · 译文',()=>actions.mode('mono'),modes), dual=button('对照','Side by side PDF · 对照',()=>actions.mode('dual'),modes);
    const scope=element(doc,'div','askgpt-control-group');header.appendChild(scope);
    button('本页','Translate current page · 本页',()=>actions.current(),scope);button('整份','Translate whole PDF · 整份',()=>actions.whole(),scope);
    const playback=element(doc,'div','askgpt-control-group');header.appendChild(playback);
    button('■','Stop · 停止',()=>actions.stop(),playback);button('▶','Retry · 重试',()=>actions.resume(),playback);
    let direction='en-zh';
    const zoomControls=element(doc,'div','askgpt-control-group');header.appendChild(zoomControls);
    button('−','Zoom out · 缩小',()=>setZoom(zoom/1.25),zoomControls);button('↔','Fit width · 适合宽度',()=>setZoom(1),zoomControls);button('+','Zoom in · 放大',()=>setZoom(zoom*1.25),zoomControls);
    const directionButton=button('EN→中','Translation direction · 翻译方向',()=>{direction=direction==='en-zh'?'zh-en':'en-zh';directionButton.textContent=direction==='en-zh'?'EN→中':'中→EN';actions.direction(direction);});
    doc.body.append(header,status,body);
    let generation=0,presentation=0,outputDocument=null,loadingTask=null,outputWorker=null,observer=null,disposed=false,visible=false,pageMap=[],rendering=new Set(),zoom=1,hasScrolled=false;
    let wheelFrame=null,wheelTimer=false,wheelDelta=0,wheelPoint=null,wheelEpoch=0,refineTimer=null,zoomActive=false;
    let panFrame=null,panTimer=false,panTarget=null,panTime=null,panDirection=0,reclaimFrame=null;
    const current=epoch=>!disposed&&generation===epoch&&(appearance.isCurrent?.()??true);
    function setStatus(text){status.textContent=text||'';status.hidden=!text;}
    function restoreOriginal(){
      presentation++;cancelWheel();
      frame.style.setProperty('visibility','hidden');visible=false;
      if(initial.visibility)original.style.setProperty('visibility',initial.visibility,initial.priority);else original.style.removeProperty('visibility');
    }
    function cancelRendering(){
      cancelWheel();
      observer?.disconnect();observer=null;
      for(const timer of layoutTimers)(doc.defaultView||win).clearTimeout(timer);layoutTimers.clear();for(const frameID of layoutFrames)(doc.defaultView||win).cancelAnimationFrame?.(frameID);layoutFrames.clear();
      for(const task of tasks){try{task.cancel?.();}catch(_){}}tasks.clear();
      for(const item of rendered.values()){item.canvas.width=0;item.canvas.height=0;item.textTask?.cancel?.();}rendered.clear();rendering.clear();
      const old=outputDocument, loading=loadingTask, worker=outputWorker;outputDocument=null;loadingTask=null;outputWorker=null;
      // This worker belongs only to the translated copy, never to Zotero's
      // original PDF. Stop its document before releasing the worker.
      try{void Promise.resolve(old?.destroy?.()||loading?.destroy?.()).catch(()=>{}).then(()=>worker?.destroy?.());}catch(_){worker?.destroy?.();}
      body.textContent='';
    }
    async function renderPage(index,epoch){
      if(!current(epoch)||rendered.get(index)?.zoom===zoom||rendering.has(index)||!outputDocument||zoomActive)return;
      const renderZoom=zoom,renderPresentation=presentation,previous=rendered.get(index),holder=body.children[index];
      rendering.add(index);let canvas=null,textLayer=null,textTask=null,failed=false;
      const fresh=()=>current(epoch)&&zoom===renderZoom&&presentation===renderPresentation;
      const release=()=>{if(textTask)tasks.delete(textTask);if(canvas){canvas.width=0;canvas.height=0;}textLayer?.remove();textTask?.cancel?.();};
      try{
        appearance.reportDiagnostic?.('renderBegin',{name:'RenderSnapshot'});
        const page=ownedOutput(await completed(outputDocument.getPage(index+1),appearance.Components),appearance.Components);if(!fresh())return;
        const available=Math.max(240,(doc.documentElement?.clientWidth||outer.documentElement?.clientWidth||800)-32);
        const base=ownedOutput(page.getViewport(transfer({scale:1},win,appearance.Components)),appearance.Components);
        const scale=Math.min(available/base.width,1.6)*renderZoom, viewport=ownedOutput(page.getViewport(transfer({scale},win,appearance.Components)),appearance.Components);
        canvas=element(doc,'canvas','askgpt-pdf-canvas');
        const ratio=Math.min(win.devicePixelRatio||1,2,Math.sqrt(16000000/(viewport.width*viewport.height)));canvas.width=Math.ceil(viewport.width*ratio);canvas.height=Math.ceil(viewport.height*ratio);
        canvas.style.setProperty('width',viewport.width+'px');canvas.style.setProperty('height',viewport.height+'px');
        const ctx=ownedOutput(canvas.getContext('2d',{alpha:false}),appearance.Components);if(!ctx)throw new PDFError('compatibility');
        // CanvasGraphics reacquires this context in the content realm. The
        // fork's flag must be set there, not on the system Xray expando.
        ctx.skipBlender=true;
        const renderOptions=transfer({canvasContext:ctx,transform:ratio===1?null:[ratio,0,0,ratio,0,0],background:'rgb(255,255,255)'},win,appearance.Components,true);
        // PageViewport carries prototype getters used by TextLayer. Assign the
        // same content-realm instance after cloning the options container.
        renderOptions.viewport=viewport;
        const render=ownedOutput(page.render(renderOptions),appearance.Components);
        tasks.add(render);await completed(render.promise,appearance.Components);tasks.delete(render);if(!fresh()){release();return;}
        let textItemsCount=-1;
        if(typeof context.win.pdfjsLib.TextLayer==='function'){
          textLayer=element(doc,'div','textLayer');textLayer.style.setProperty('width',viewport.width+'px');textLayer.style.setProperty('height',viewport.height+'px');textLayer.style.setProperty('visibility','hidden');textLayer.style.setProperty('--scale-factor',String(viewport.scale));
          textLayer.style.setProperty('--total-scale-factor',String(viewport.scale));holder.appendChild(textLayer);
          try{const content=ownedOutput(await completed(page.getTextContent(),appearance.Components),appearance.Components);if(!fresh()){release();return;}textItemsCount=Array.isArray(content.items)?content.items.length:-1;
            const textOptions=transfer({container:textLayer},win,appearance.Components,true);textOptions.viewport=viewport;textOptions.textContentSource=content;
            textTask=ownedOutput(new context.win.pdfjsLib.TextLayer(textOptions),appearance.Components);
            tasks.add(textTask);await completed(textTask.render(),appearance.Components);tasks.delete(textTask);
          }catch(error){textLayer.remove();textLayer=null;if(!fresh()){release();return;}appearance.reportDiagnostic?.('text',error);setStatus('文字选择暂不可用');}
        }
        if(!fresh()){release();return;}
        // Keep the last good bitmap/text selectable until both replacements
        // are ready. Swapping here is atomic within the same display frame.
        const viewAnchor=visible?anchorAt(wheelPoint||{x:(doc.documentElement?.clientWidth||800)/2,y:80}):null;
        holder.style.setProperty('width',`calc(${viewport.width/renderZoom}px * var(--askgpt-zoom, 1))`);
        holder.style.setProperty('height',`calc(${viewport.height/renderZoom}px * var(--askgpt-zoom, 1))`);
        holder.textContent='';holder.appendChild(canvas);if(textLayer){textLayer.style.removeProperty('visibility');holder.appendChild(textLayer);}
        rendered.set(index,{canvas,textLayer,textTask,zoom:renderZoom});
        if(previous){previous.canvas.width=0;previous.canvas.height=0;previous.textTask?.cancel?.();}
        previewPages();positionAnchor(viewAnchor);
        if(!visible){frame.style.setProperty('visibility','visible');original.style.setProperty('visibility','hidden');visible=true;}
        let nonWhiteSamples=-1;try{if(!previous&&typeof ctx.getImageData==='function'){nonWhiteSamples=0;for(let y=0;y<8;y++)for(let x=0;x<8;x++){const sample=ownedOutput(ctx.getImageData(Math.min(canvas.width-1,Math.floor((x+0.5)*canvas.width/8)),Math.min(canvas.height-1,Math.floor((y+0.5)*canvas.height/8)),1,1).data,appearance.Components);if(sample[0]<245||sample[1]<245||sample[2]<245)nonWhiteSamples++;}}}catch(_){}
        appearance.reportDiagnostic?.('rendered',{name:'RenderSnapshot',code:'rendered',renderNumbers:{width:canvas.width,height:canvas.height,holderChildCount:holder.children.length,textItemsCount,renderedCount:rendered.size,nonWhiteSamples}});
        if(!previous)scheduleLayoutSnapshot(index,canvas,holder,ctx,epoch);
      }catch(error){failed=true;release();if(current(epoch)){appearance.reportDiagnostic?.('render',error);if(!previous){restoreOriginal();actions.failure?.(error);}setStatus(errorMessage(error));}}
      finally{if(current(epoch)){rendering.delete(index);if(!failed&&visible&&!zoomActive&&rendered.get(index)?.zoom!==zoom)void renderPage(index,epoch);}}
    }
    function scheduleLayoutSnapshot(index,canvas,holder,ctx,epoch){
      const timing=doc.defaultView||win;
      const snapshot=()=>{
        if(!current(epoch)||zoomActive||rendered.get(index)?.canvas!==canvas)return;
        try{
          const computed=node=>{try{return timing.getComputedStyle?.(node)||{};}catch(_){return {};}};
          const cs=computed(canvas),hs=computed(holder),fs=win.getComputedStyle?.(frame)||{},cr=canvas.getBoundingClientRect?.()||{},hr=holder.getBoundingClientRect?.()||{},fr=frame.getBoundingClientRect?.()||{};
          const display=value=>({none:0,block:1,inline:2,'inline-block':3,flex:4,grid:5}[value]??-1);
          const visibility=value=>({hidden:0,visible:1,collapse:2}[value]??-1);
          let alphaZero=-1,opaque=-1,nonWhiteSamples=-1;
          try{if(canvas.width>0&&canvas.height>0&&typeof ctx.getImageData==='function'){alphaZero=0;opaque=0;nonWhiteSamples=0;for(let y=0;y<8;y++)for(let x=0;x<8;x++){
            const pixel=ownedOutput(ctx.getImageData(Math.min(canvas.width-1,Math.floor((x+0.5)*canvas.width/8)),Math.min(canvas.height-1,Math.floor((y+0.5)*canvas.height/8)),1,1).data,appearance.Components);
            if(pixel[3]===0)alphaZero++;if(pixel[3]===255)opaque++;if(pixel[3]>0&&(pixel[0]<245||pixel[1]<245||pixel[2]<245))nonWhiteSamples++;
          }}}catch(_){}
          let hiddenAncestors=0,node=canvas;
          for(let depth=0;node&&depth<12;depth++,node=node.parentElement){const style=computed(node);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)hiddenAncestors++;}
          appearance.reportDiagnostic?.('layout',{name:'RenderSnapshot',code:'layout',layoutNumbers:{canvasWidth:canvas.width,canvasHeight:canvas.height,
            canvasClientWidth:canvas.clientWidth,canvasClientHeight:canvas.clientHeight,canvasOffsetWidth:canvas.offsetWidth,canvasOffsetHeight:canvas.offsetHeight,
            canvasLeft:cr.left,canvasTop:cr.top,canvasRectWidth:cr.width,canvasRectHeight:cr.height,holderLeft:hr.left,holderTop:hr.top,holderRectWidth:hr.width,holderRectHeight:hr.height,
            frameRectWidth:fr.width,frameRectHeight:fr.height,canvasDisplay:display(cs.display),canvasVisibility:visibility(cs.visibility),canvasOpacity:Number(cs.opacity)*1000,
            holderDisplay:display(hs.display),holderVisibility:visibility(hs.visibility),holderOpacity:Number(hs.opacity)*1000,frameVisibility:visibility(fs.visibility),
            styleWidth:parseFloat(canvas.style.getPropertyValue('width')),styleHeight:parseFloat(canvas.style.getPropertyValue('height')),canvasConnected:canvas.isConnected?1:0,holderConnected:holder.isConnected?1:0,
            holderChildCount:holder.children.length,textSpanCount:holder.querySelectorAll?.('.textLayer span').length??-1,renderedCount:rendered.size,hiddenAncestors,alphaZero,opaque,nonWhiteSamples}});
        }catch(error){appearance.reportDiagnostic?.('render',error);}
      };
      if(typeof timing.requestAnimationFrame==='function'){let id;id=timing.requestAnimationFrame(()=>{layoutFrames.delete(id);snapshot();});layoutFrames.add(id);}
      let timer;timer=timing.setTimeout(()=>{layoutTimers.delete(timer);snapshot();},200);layoutTimers.add(timer);
    }
    function scrollElement(){return doc.scrollingElement||doc.documentElement||doc.body;}
    function anchorAt(point){
      if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))return null;
      // Pages are vertically ordered: binary search avoids a layout read for
      // every preceding page in a long document on each wheel frame.
      let low=0,high=body.children.length-1,best=null,distance=Infinity;
      while(low<=high){const index=(low+high)>>1,rect=body.children[index].getBoundingClientRect?.();
        if(!rect||rect.width<=0||rect.height<=0)break;
        const gap=Math.max(rect.top-point.y,point.y-rect.bottom,0);
        if(gap<distance){best={index,rect};distance=gap;}if(!gap)break;
        if(point.y<rect.top)high=index-1;else low=index+1;
      }
      if(!best)return null;const {index,rect}=best;
      return {index,x:point.x,y:point.y,fractionX:Math.max(0,Math.min(1,(point.x-rect.left)/rect.width)),fractionY:Math.max(0,Math.min(1,(point.y-rect.top)/rect.height))};
    }
    function positionAnchor(anchor){
      if(!anchor)return null;const rect=body.children[anchor.index]?.getBoundingClientRect?.();if(!rect)return null;
      const scroll=scrollElement();
      scroll.scrollLeft+=(rect.left+anchor.fractionX*rect.width-anchor.x);
      scroll.scrollTop+=(rect.top+anchor.fractionY*rect.height-anchor.y);
      return {left:scroll.scrollLeft,top:scroll.scrollTop};
    }
    function previewPages(){
      body.style.setProperty('--askgpt-zoom',String(zoom));
      body.setAttribute('data-zoom',String(zoom));
      for(const item of rendered.values())for(const node of [item.canvas,item.textLayer])if(node){
        node.style.setProperty('transform-origin','0 0');node.style.setProperty('transform',`scale(${zoom/item.zoom})`);
      }
    }
    function applyZoom(value,point){
      if(!outputDocument||disposed||!Number.isFinite(value))return;
      const next=Math.max(0.5,Math.min(4,value));if(next===zoom)return;
      const anchor=anchorAt(point||{x:(doc.documentElement?.clientWidth||800)/2,y:80});
      zoom=next;previewPages();positionAnchor(anchor);
    }
    async function refineZoom(){
      if(disposed||!visible||!outputDocument||zoomActive)return;
      const anchor=anchorAt(wheelPoint||{x:(doc.documentElement?.clientWidth||800)/2,y:80}),selected=anchor?.index??0;
      const nearby=new Set([selected]);
      const height=doc.documentElement?.clientHeight||800;
      // Only a bounded visible neighborhood gets a fresh bitmap. Other pages
      // keep their preview and are refreshed lazily when scrolled into view.
      for(let i=Math.max(0,selected-1);i<=Math.min(body.children.length-1,selected+2);i++){
        const rect=body.children[i].getBoundingClientRect?.();if(rect&&rect.bottom>-600&&rect.top<height+600)nearby.add(i);
      }
      await Promise.all([...nearby].map(index=>renderPage(index,generation)));
    }
    function setZoom(value){cancelWheel();applyZoom(value);return refineZoom();}
    function cancelPan(){
      const timing=doc.defaultView||win;
      if(panFrame!==null){if(panTimer)timing.clearTimeout(panFrame);else timing.cancelAnimationFrame?.(panFrame);}
      panFrame=null;panTarget=null;panTime=null;panDirection=0;
    }
    function discardQueuedZoom(){
      const timing=doc.defaultView||win;
      if(wheelFrame!==null){if(wheelTimer)timing.clearTimeout(wheelFrame);else timing.cancelAnimationFrame?.(wheelFrame);}
      wheelFrame=null;wheelDelta=0;
    }
    function cancelWheel(){
      const timing=doc.defaultView||win;
      if(wheelFrame!==null){if(wheelTimer)timing.clearTimeout(wheelFrame);else timing.cancelAnimationFrame?.(wheelFrame);}
      cancelPan();
      if(reclaimFrame!==null){timing.cancelAnimationFrame?.(reclaimFrame);reclaimFrame=null;}
      if(refineTimer!==null)timing.clearTimeout(refineTimer);
      wheelFrame=null;wheelDelta=0;wheelPoint=null;wheelEpoch++;refineTimer=null;zoomActive=false;
      panFrame=null;panTarget=null;panTime=null;panDirection=0;body.removeAttribute('data-gesture');
    }
    function scheduleWheel(){
      if(wheelFrame!==null||!wheelDelta||!visible||disposed||!outputDocument)return;
      const timing=doc.defaultView||win,token=wheelEpoch;
      const flush=()=>{wheelFrame=null;if(token!==wheelEpoch||!visible||disposed||!outputDocument)return;
        const delta=wheelDelta;wheelDelta=0;applyZoom(zoom*Math.exp(-delta*0.002),wheelPoint);
      };
      wheelTimer=typeof timing.requestAnimationFrame!=='function';
      wheelFrame=wheelTimer?timing.setTimeout(flush,16):timing.requestAnimationFrame(flush);
    }
    function queueRefinement(){
      const timing=doc.defaultView||win,token=wheelEpoch;zoomActive=true;body.setAttribute('data-gesture','zoom');
      // No pixel sampling or computed-style diagnostics in the gesture path.
      for(const timer of layoutTimers)timing.clearTimeout(timer);layoutTimers.clear();
      for(const id of layoutFrames)timing.cancelAnimationFrame?.(id);layoutFrames.clear();
      if(refineTimer!==null)timing.clearTimeout(refineTimer);
      refineTimer=timing.setTimeout(()=>{refineTimer=null;if(token!==wheelEpoch)return;zoomActive=false;body.removeAttribute('data-gesture');void refineZoom();},140);
    }
    function panBy(distance){
      const timing=doc.defaultView||win,scroll=scrollElement(),token=wheelEpoch;
      const direction=Math.sign(distance),max=Math.max(0,(scroll.scrollWidth||0)-(scroll.clientWidth||0));
      // A reversal takes control from the currently displayed position, so it
      // never finishes the old motion before responding to the new direction.
      if(panTarget===null||direction!==panDirection)panTarget=scroll.scrollLeft;
      panTarget=Math.max(0,Math.min(max,panTarget+distance));panDirection=direction;
      if(panFrame!==null)return;
      panTime=timing.performance?.now?.()??Date.now();
      const step=timestamp=>{panFrame=null;if(token!==wheelEpoch||!visible||disposed)return;
        const now=Number.isFinite(timestamp)?timestamp:(timing.performance?.now?.()??Date.now()),dt=Math.max(1,Math.min(64,now-panTime));panTime=now;
        const remaining=panTarget-scroll.scrollLeft,reduced=timing.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        if(reduced||Math.abs(remaining)<=1){scroll.scrollLeft=panTarget;panTarget=null;panTime=null;return;}
        // Short monotonic response. Input momentum already comes from macOS;
        // do not synthesize additional distance or a second inertia tail.
        scroll.scrollLeft+=remaining*(1-Math.exp(-dt/24));schedule();
      };
      const schedule=()=>{panTimer=typeof timing.requestAnimationFrame!=='function';panFrame=panTimer?timing.setTimeout(()=>step(),16):timing.requestAnimationFrame(step);};schedule();
    }
    function wheelPixels(event){
      const height=doc.documentElement?.clientHeight||doc.defaultView?.innerHeight||800,width=doc.documentElement?.clientWidth||800;
      let line=16;try{const value=parseFloat((doc.defaultView||win).getComputedStyle?.(doc.body)?.lineHeight);if(Number.isFinite(value)&&value>0)line=value;}catch(_){}
      const mode=event.deltaMode,scaleX=mode===1?line:mode===2?width:1,scaleY=mode===1?line:mode===2?height:1;
      return {x:Number.isFinite(event.deltaX)?event.deltaX*scaleX:0,y:Number.isFinite(event.deltaY)?event.deltaY*scaleY:0};
    }
    function reclaimPages(){
      if(!hasScrolled||!visible||zoomActive)return;const height=doc.documentElement?.clientHeight||doc.defaultView?.innerHeight||win.innerHeight||800,selected=anchorAt({x:0,y:80})?.index;if(selected==null)return;
      for(const [index,item] of [...rendered]){if(Math.abs(index-selected)<=2)continue;const holder=body.children[index],rect=holder?.getBoundingClientRect?.();if(!rect||!(rect.bottom < -600||rect.top>height+600))continue;item.canvas.width=0;item.canvas.height=0;item.textTask?.cancel?.();rendered.delete(index);holder.textContent='';}
    }
    listen(doc,'scroll',()=>{hasScrolled=true;if(zoomActive||reclaimFrame!==null)return;const timing=doc.defaultView||win;if(typeof timing.requestAnimationFrame==='function')reclaimFrame=timing.requestAnimationFrame(()=>{reclaimFrame=null;reclaimPages();});else reclaimPages();});
    listen(doc,'wheel',event=>{
      if(!visible||disposed||!outputDocument||event.defaultPrevented||(!event.ctrlKey&&!event.metaKey))return;
      const delta=wheelPixels(event);
      // A trackpad pinch may synthesize ctrlKey while Command is held.
      // Command always means pan; only Control without Command means zoom.
      if(event.ctrlKey&&!event.metaKey){if(!delta.y)return;event.preventDefault();cancelPan();
        wheelDelta=Math.max(-2000,Math.min(2000,wheelDelta+delta.y));wheelPoint={x:event.clientX,y:event.clientY};queueRefinement();scheduleWheel();
      }else{const distance=delta.x||delta.y;if(!distance)return;event.preventDefault();if(zoomActive){discardQueuedZoom();queueRefinement();}panBy(distance);}
    },{passive:false});
    listen(doc,'keydown',event=>{if((event.altKey&&event.shiftKey&&!event.ctrlKey&&!event.metaKey&&event.code==='KeyX')||(event.key==='Escape'&&!event.ctrlKey&&!event.metaKey)){event.preventDefault();event.stopImmediatePropagation();actions.exit();}});
    return {frame,doc,body,get visible(){return visible;},setStatus,setProgress,restoreOriginal,
      prepareOutput(){generation++;restoreOriginal();cancelRendering();},
      async showOutput(value,sourcePages,mode='mono'){
        const epoch=++generation;restoreOriginal();cancelRendering();setStatus('');hasScrolled=false;
        if(!['mono','dual'].includes(mode)||!Array.isArray(sourcePages)||!sourcePages.length)throw new PDFError('response');
        const data=validPDF(value,MAX_OUTPUT_BYTES);pageMap=sourcePages.slice();
        const lib=context.win.pdfjsLib;if(typeof lib?.getDocument!=='function')throw new PDFError('compatibility');
        if(typeof lib.PDFWorker!=='function')throw new PDFError('compatibility');
        outputWorker=ownedOutput(new lib.PDFWorker(),appearance.Components);
        const loadOptions=transfer({data:new Uint8Array(data),isEvalSupported:false,ownerDocument:doc},win,appearance.Components,true);
        loadOptions.worker=outputWorker;
        loadingTask=ownedOutput(lib.getDocument(loadOptions),appearance.Components);
        appearance.reportDiagnostic?.('loadBegin',{name:'RenderSnapshot'});
        let loaded;try{loaded=ownedOutput(await completed(loadingTask.promise,appearance.Components),appearance.Components);}catch(_){if(current(epoch))throw new PDFError('pdf');return;}
        appearance.reportDiagnostic?.('loadReady',{name:'RenderSnapshot'});
        if(!current(epoch)){void loaded.destroy?.();return;}
        if(loaded.numPages!==pageMap.length){const error=new PDFError('response');error.numbers={expectedPages:pageMap.length,actualPages:Number.isInteger(loaded.numPages)?loaded.numPages:-1};void loaded.destroy?.();throw error;}
        outputDocument=loaded;loadingTask=null;
        mono.setAttribute('aria-pressed',String(mode==='mono'));dual.setAttribute('aria-pressed',String(mode==='dual'));body.setAttribute('data-mode',mode);
        for(let i=0;i<loaded.numPages;i++){
          const holder=element(doc,'section','askgpt-pdf-page');holder.setAttribute('data-output-page',String(i));holder.setAttribute('data-source-page',String(pageMap[i]));holder.setAttribute('aria-label',`Page ${pageMap[i]+1}`);
          holder.style.setProperty('height','calc(1000px * var(--askgpt-zoom, 1))');body.appendChild(holder);
        }
        const Observer=doc.defaultView?.IntersectionObserver||win.IntersectionObserver;
        if(typeof Observer==='function'){
          let ownObserver;ownObserver=new Observer(entries=>{if(observer!==ownObserver||disposed)return;for(const entry of entries){const index=Number(entry.target.getAttribute('data-output-page'));if(entry.isIntersecting)void renderPage(index,generation);}reclaimPages();},{rootMargin:'600px'});observer=ownObserver;
          for(const holder of body.children)observer.observe(holder);
        }
        const preferred=Math.max(0,pageMap.indexOf(Math.max(0,pdfViewer.currentPageNumber-1)));
        await renderPage(preferred,epoch);
        if(current(epoch)&&body.children[preferred]?.scrollIntoView)body.children[preferred].scrollIntoView({block:'start'});
      },
      dispose(restorePosition=true){if(disposed)return;disposed=true;generation++;for(const remove of listeners.splice(0))remove();cancelRendering();restoreOriginal();frame.remove();progressHUD.remove();progressStyle.remove();if(restorePosition){original.scrollTop=initial.top;original.scrollLeft=initial.left;}}
    };
  }
  const api={PDFError,errorMessage,createTransport,mount,validPDF,validateStatus,validateProgress,transfer,diagnostic,copyOpenPDFData,MAX_INPUT_BYTES,MAX_OUTPUT_BYTES,MAX_ALIGNMENT_BYTES,validateAlignment,sentenceCoverage};
  root.AskGPTPDFLayout=api;if(typeof module!=='undefined')module.exports=api;
})(this);
