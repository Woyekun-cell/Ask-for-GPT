import { assertUTF16Range, WritingHostAdapter, HostContractError, SCOPES, createSnapshot, sha256, assertIssueEnvelope, overlaps } from '../shared/host-contract.js';

// Sidebar and hidden service use separate adapters in one Office runtime.
// Serialize only raw Word.run calls; each adapter retains its own bound objects.
const wordRunQueues=new WeakMap();
function sharedWordRun(Word,args){
  const result=(wordRunQueues.get(Word)||Promise.resolve()).then(()=>Word.run(...args));
  wordRunQueues.set(Word,result.catch(()=>{}));return result;
}
const uid = () => globalThis.crypto.randomUUID();
const anchorKey = snapshot => JSON.stringify([snapshot?.documentSessionID,snapshot?.blockID,snapshot?.revision,snapshot?.rawText,snapshot?.snapshotHash,snapshot?.contextHash,snapshot?.contextBefore,snapshot?.contextAfter,snapshot?.targetRange,snapshot?.protectedRanges,snapshot?.scope]);
const uniquePages = pages => [...new Set(pages.items.map(page => page.index))].sort((a, b) => a - b);
function verifiedPageIndices(pages) {
  if(!Array.isArray(pages?.items)||!pages.items.length||pages.items.length>256||pages.items.some(page=>!Number.isSafeInteger(page.index)||page.index<1))fail('invalidPageMetadata');
  return uniquePages(pages);
}
function boundedContext(text, side, limit = 1000) {
  if (text.length <= limit) return text;
  const pieces = globalThis.Intl?.Segmenter ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.segment) : Array.from(text);
  let result = '';
  for (const piece of side === 'before' ? pieces.reverse() : pieces) { if (result.length + piece.length > limit) break; result = side === 'before' ? piece + result : result + piece; }
  return result;
}
const fail = (code, message = code) => { throw new HostContractError(code, message); };
function graphemeChange(original,replacement) {
  if(!globalThis.Intl?.Segmenter)fail('previewOnly','Unicode grapheme verification is unavailable: preview only.');
  const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'}),parts=text=>Array.from(segmenter.segment(text),part=>part.segment);
  const before=parts(original),after=parts(replacement);let prefix=0,oldEnd=before.length,newEnd=after.length;
  while(prefix<oldEnd&&prefix<newEnd&&before[prefix]===after[prefix])prefix++;
  while(oldEnd>prefix&&newEnd>prefix&&before[oldEnd-1]===after[newEnd-1]){oldEnd--;newEnd--;}
  let offset=before.slice(0,prefix).join('').length,oldText=before.slice(prefix,oldEnd).join(''),newText=after.slice(prefix,newEnd).join('');
  if(!oldText&&!newText)fail('reviewOnly');
  // Pure insertion must still replace a nonempty, verifiable range inside the
  // original issue. Its neighboring grapheme supplies the existing formatting.
  if(!oldText){if(prefix>0){oldText=before[prefix-1];offset-=oldText.length;newText=oldText+newText;}else{oldText=before[0];newText+=oldText;}}
  assertUTF16Range(original,{start:offset,length:oldText.length});assertUTF16Range(replacement,{start:offset,length:newText.length});
  if(original.slice(0,offset)+newText+original.slice(offset+oldText.length)!==replacement)fail('previewOnly','Change cannot be verified: preview only.');
  return {offset,original:oldText,replacement:newText};
}
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const PKG = 'http://schemas.microsoft.com/office/2006/xmlPackage';
const elements = node => Array.from(node?.children || []);
const isElement = (node, namespace, name) => node?.namespaceURI === namespace && node.localName === name;
// Temporary live-host diagnostics: only fixed API identifiers, never native messages.
const fixedPageOperations=text=>['getRange','paragraphs','load','track','untrack','pages','uniqueLocalId','_KeepReference','_RemoveReference','trace'].filter(name=>new RegExp('\\b'+name+'\\b').test(text)).join('+')||'other';
const fixedPageTraceIDs=new Set(['wf0','wf1','wf2','wf3','wf4','wf5','wf6']);
function pageTrace(context,id,enabled){if(enabled===true&&fixedPageTraceIDs.has(id)&&typeof context.trace==='function'){try{context.trace(id);}catch{}}}
function pageReadDiagnostic(stage,error,pageCount) {
  const codes=new Set(['InvalidObjectPath','InvalidArgument','InvalidOperation','NotSupported','NotImplemented','ItemNotFound','AccessDenied','GeneralException','PropertyNotLoaded','InternalError','ApiNotFound','ActivityLimitReached','Timeout','TypeError','metadataParagraphLimit','invalidPageMetadata','metadataUnavailable']);
  const locations=new Set(['Document.activeWindow','Window.activePane','Pane.pagesEnclosingViewport','Range.pages','PageCollection.load','Page.getRange','Range.paragraphs','ParagraphCollection.load','RequestContext.sync']);
  const code=codes.has(error?.code)?error.code:'other',location=typeof error?.debugInfo?.errorLocation==='string'?error.debugInfo.errorLocation.replace(/^Word\./,''):'';
  const statement=typeof error?.debugInfo?.statement==='string'?error.debugInfo.statement.slice(0,16000):'';
  const surrounding=Array.isArray(error?.debugInfo?.surroundingStatements)?error.debugInfo.surroundingStatements.slice(0,8).filter(value=>typeof value==='string').map(value=>value.slice(0,2000)).join(' '):'';
  const traces=Array.isArray(error?.traceMessages)?error.traceMessages.filter(id=>fixedPageTraceIDs.has(id)).slice(0,7):[];
  const extra=Array.isArray(error?.debugInfo?.surroundingStatements)||Array.isArray(error?.traceMessages)?';near_'+fixedPageOperations(surrounding)+';trace_'+(traces.join('+')||'none'):'';
  return 'stage_'+stage+';code_'+code+';loc_'+(locations.has(location)?location:'other')+';stmt_'+fixedPageOperations(statement)+';n_'+Math.min(Number.isSafeInteger(pageCount)?Math.max(0,pageCount):0,999)+extra;
}
// Temporary host observation only: round-trip through the fixed vocabulary
// before changing the DOM title. Native error prose and source text are rejected.
function observePageFailure(diagnostic){
  try{
    const document=globalThis.document;if(typeof document?.createElement!=='function'||typeof document.title!=='string'||typeof diagnostic!=='string'||diagnostic.length>1024)return;
    const stages=new Set(['viewport','pageRange','pageParagraphs','paragraphIndex','paragraphPages','matchedParagraphText','viewportFinal']),parts=diagnostic.split('|');if(parts.length>2)return;
    for(const part of parts){const match=part.match(/^stage_([A-Za-z]+);code_([A-Za-z_]+);loc_([A-Za-z.]+);stmt_([A-Za-z_+]+);n_(\d{1,3})(?:;near_([A-Za-z_+]+);trace_([A-Za-z0-9+]+))?$/);if(!match||!stages.has(match[1]))return;const error={code:match[2],debugInfo:{errorLocation:match[3],statement:match[4].replaceAll('+',' ')}};if(match[6]!==undefined){error.debugInfo.surroundingStatements=[match[6].replaceAll('+',' ')];error.traceMessages=match[7]==='none'?[]:match[7].split('+');}if(pageReadDiagnostic(match[1],error,Number(match[5]))!==part)return;}
    document.title='写作 ['+diagnostic+']';
  }catch{}
}
function mainParagraph(xml, Parser) {
  if (typeof xml !== 'string' || xml.length > 2_000_000 || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) || typeof Parser !== 'function') return null;
  try {
    const parsed = new Parser().parseFromString(xml, 'application/xml');
    if (parsed.getElementsByTagNameNS('*','parsererror').length) return null;
    let root = parsed.documentElement;
    if (isElement(root,PKG,'package')) {
      const parts=elements(root);
      if (parts.some(part=>!isElement(part,PKG,'part'))) return null;
      const main=parts.filter(part=>part.getAttributeNS(PKG,'name')==='/word/document.xml');
      if(main.length!==1) return null;
      const data=elements(main[0]);
      if(data.length!==1||!isElement(data[0],PKG,'xmlData')||elements(data[0]).length!==1) return null;
      root=elements(data[0])[0];
    }
    if(isElement(root,W,'p')) return root;
    if(!isElement(root,W,'document')) return null;
    const documentChildren=elements(root);
    if(documentChildren.length!==1||!isElement(documentChildren[0],W,'body')) return null;
    const body=elements(documentChildren[0]);
    if(!isElement(body[0],W,'p')) return null;
    let cursor=1;
    // Word range exports may append a paragraph with identity attributes only.
    // Accept exactly that empty node; any text, element or other child is unsafe.
    if(isElement(body[cursor],W,'p')) {
      const tail=body[cursor];
      if(!tail.childNodes||tail.childNodes.length!==0||tail.textContent!=='') return null;
      cursor++;
    }
    if(isElement(body[cursor],W,'sectPr')) cursor++;
    return cursor===body.length?body[0]:null;
  } catch { return null; }
}
function fieldMarkup(xml, Parser) {
  const paragraph=mainParagraph(xml,Parser);
  return !paragraph || ['fldChar','fldSimple','instrText'].some(name=>paragraph.getElementsByTagNameNS(W,name).length>0);
}
const RUN_PROPERTIES = new Set(['rFonts','b','bCs','i','iCs','caps','smallCaps','strike','dStrike','noProof','snapToGrid','color','spacing','w','kern','sz','szCs','highlight','shd','u','rtl','cs','lang']);
const PARAGRAPH_PROPERTIES = new Set(['keepNext','keepLines','pageBreakBefore','widowControl','suppressLineNumbers','suppressAutoHyphens','bidi','adjustRightInd','snapToGrid','spacing','ind','contextualSpacing','jc','textDirection','textAlignment','outlineLvl']);
function plainParagraphXML(xml, original, Parser, allowUnchangedRuns=false) {
  const paragraph=mainParagraph(xml,Parser);
  if(!paragraph) return false;
  const cleanText=node=>Array.from(node.childNodes||[]).every(child=>child.nodeType===1||child.nodeType===3&&!child.textContent.trim());
  const properties=(node,allowed)=>cleanText(node)&&elements(node).every(child=>child.namespaceURI===W&&allowed.has(child.localName)&&elements(child).length===0&&cleanText(child));
  const proofMarker=node=>{
    if(!isElement(node,W,'proofErr')||node.childNodes?.length!==0)return false;
    const attributes=Array.from(node.attributes||[]);
    return attributes.length===1&&attributes[0].namespaceURI===W&&attributes[0].localName==='type'&&['spellStart','spellEnd','gramStart','gramEnd'].includes(attributes[0].value);
  };
  const children=elements(paragraph), runs=children.filter(node=>isElement(node,W,'r'));
  if(!cleanText(paragraph)||runs.length<1||!allowUnchangedRuns&&runs.length!==1||children.some(node=>!isElement(node,W,'r')&&!isElement(node,W,'pPr')&&!proofMarker(node))||children.filter(node=>isElement(node,W,'pPr')).length>1) return false;
  for(const pPr of children.filter(node=>isElement(node,W,'pPr'))) {
    if(!cleanText(pPr)||elements(pPr).some(child=>isElement(child,W,'rPr')?!properties(child,RUN_PROPERTIES):child.namespaceURI!==W||!PARAGRAPH_PROPERTIES.has(child.localName)||elements(child).length>0||!cleanText(child))||elements(pPr).filter(child=>isElement(child,W,'rPr')).length>1) return false;
  }
  let text='';
  for(const run of runs){
    const content=elements(run),texts=content.filter(node=>isElement(node,W,'t'));
    if(!cleanText(run)||texts.length!==1||content.some(node=>!isElement(node,W,'t')&&!isElement(node,W,'rPr'))||content.filter(node=>isElement(node,W,'rPr')).length>1) return false;
    for(const rPr of content.filter(node=>isElement(node,W,'rPr'))) if(!properties(rPr,RUN_PROPERTIES)) return false;
    if(elements(texts[0]).length) return false;text+=texts[0].textContent;
  }
  return text===original;
}

/** Word task pane adapter. All source text stays in memory; no document metadata writes. */
export class WordHostAdapter extends WritingHostAdapter {
  #uidMatrixAttempted=false;
  #diagnostics=false;
  constructor(options = {}) {
    super();
    const {Word = globalThis.Word, Office = globalThis.Office, XMLParser = globalThis.DOMParser, timers = globalThis, onStatus = () => {}, requireActiveWindow = false, diagnostics = false} = options;
    this.Word = Word; this.Office = Office; this.timers = timers; this.onStatus = onStatus;
    this.XMLParser = XMLParser;
    this.requireActiveWindow = requireActiveWindow === true;
    this.#diagnostics = diagnostics === true;
    this.injectedWord = Object.hasOwn(options,'Word'); this.injectedOffice = Object.hasOwn(options,'Office');
    this.documentSessionID = uid(); this.blockStates = new Map(); this.anchors = new Map(); this.annotations = new Map();this.trackedReferences=new Map();this.navigationOwners=new Set();
    this.operations = Promise.resolve(); this.captures = Promise.resolve(); this.applying = false;
    this.eventRegistrations = []; this.callback = null; this.polling = false; this.disposed = false; this.mode = 'visiblePages'; this.lastSignature = null;
    this.pageReadFailureDiagnostic = ''; // Temporary API-only diagnostic, retained across later capability failures.
    this.pageMetadataFallback=false;this.pageMetadataAnnounced=false;
    this.capabilities = { visiblePages: false, annotations: false, suggestionPopup: false, safeReplace: false, paragraphEvents: false, pageNumbering: 'physical-1-based', message: '' };
  }
  run(...args) {
    const result = this.operations.then(() => sharedWordRun(this.Word,args.length===1&&this.documentProxy?[this.documentProxy,args[0]]:args));
    this.operations = result.catch(() => {}); return result;
  }
  runForEnvelope(envelope, callback) {
    const anchor = this.anchors.get(anchorKey(envelope?.snapshot));
    return anchor ? this.run(anchor.paragraph, callback) : this.run(callback);
  }
  supports(name, version) { return this.Office?.context?.requirements?.isSetSupported(name, version) === true; }
  async initialize() {
    const office = this.injectedOffice ? this.Office : globalThis.Office;
    if (typeof office?.onReady !== 'function') fail('wordUnavailable', '请在 Word 任务窗内打开写作助手。');
    const timers = typeof this.timers.setTimeout === 'function' ? this.timers : globalThis;
    let timeout, ready;
    try {
      ready = await Promise.race([Promise.resolve().then(() => office.onReady()), new Promise((_, reject) => {
        timeout = timers.setTimeout(() => reject(new HostContractError('officeReadyTimeout','Word 加载超时，请重新打开任务窗。')),10000);
      })]);
    } finally {timers.clearTimeout(timeout);}
    if (!this.injectedOffice) this.Office = globalThis.Office;
    if (!this.injectedWord) this.Word = globalThis.Word;
    if (this.disposed || !this.Word?.run || !this.Office?.context?.document || (ready?.host && ready.host !== (this.Office.HostType?.Word || 'Word'))) fail('wordUnavailable', '请在 Word 任务窗内打开写作助手。');
    this.documentIdentity = this.Office.context.document; this.documentURL = this.documentIdentity.url || '';
    this.capabilities.visiblePages = this.supports('WordApiDesktop', '1.2');
    this.annotationCandidate = this.supports('WordApi', '1.7');
    this.capabilities.annotations = false; // Service availability is proved by a successful temporary insertion, never the requirement set alone.
    this.capabilities.paragraphEvents = this.supports('WordApi', '1.6');
    this.capabilities.safeReplace = this.supports('WordApi', '1.6');
    this.capabilities.message = this.capabilities.visiblePages ? '物理页序从 1 开始，可能与文档显示页码不同。' : '可见页 API 不可用，使用活动段模式。';
    this.capabilities.message += this.annotationCandidate ? ' 文内下划线尚未验证，需要 Microsoft 365；当前保留侧栏定位。' : ' 无文内下划线；保留侧栏定位。';
    // Native popup acceptance occurs inside Word before its notification event.
    // Never offer native suggestions that can bypass our fresh verification.
    this.capabilities.suggestionPopup = false;
    await this.run(async context => {
      this.documentProxy = context.document.track();
      // Office.js caches these navigation proxies. Automatic run cleanup or
      // untracking retires a proxy permanently, so pin this fixed owner chain
      // before its first sync, including failed and empty capture batches.
      const body=context.document.body;this.retainNavigation(body);this.retainNavigation(body.paragraphs);
      if(this.capabilities.visiblePages||this.requireActiveWindow)this.retainNavigation(context.document.activeWindow);
      await context.sync();
    });
    this.onStatus(this.capabilities); return { ...this.capabilities };
  }
  assertDocument() {
    if (this.disposed) fail('disposed');
    const current = this.Office?.context?.document;
    if (current !== this.documentIdentity || (current?.url || '') !== this.documentURL) fail('documentChanged', 'Document identity changed; capture again in this document.');
  }
  notify(event) { this.callback?.(event); }
  degrade(feature, message) {
    this.capabilities[feature] = false; this.capabilities.message = message;
    this.onStatus(this.capabilities); this.notify({ type: 'capabilitiesChanged', capabilities: { ...this.capabilities } });
  }
  captureScope(mode='visiblePages') {
    const result=this.captures.then(()=>this.captureScopeNow(mode)); this.captures=result.catch(()=>{}); return result;
  }
  async captureScopeNow(mode = 'visiblePages') {
    if (!SCOPES.includes(mode)) fail('invalidScope');
    this.assertDocument(); // capture mode is one-shot; automatic watch always follows visiblePages.
    const result=await this.readScopeRecovering(mode);
    const snapshots = [], release = [], activeKeys = new Set();
    for (const item of result.items) {
      const fingerprint = await sha256(JSON.stringify([item.text,item.before,item.after,item.protectedRanges]));
      const previous = this.blockStates.get(item.id);
      const revision = previous ? previous.revision + (previous.fingerprint !== fingerprint ? 1 : 0) : 0;
      this.blockStates.set(item.id,{fingerprint,revision});
      const snapshot = await createSnapshot({ requestID: uid(), documentSessionID: this.documentSessionID, blockID: item.id, revision: String(revision), rawText: item.text,
        contextBefore: item.before, contextAfter: item.after, targetRange: item.targetRange, protectedRanges: item.protectedRanges || [], pageIndices: item.pageIndices, scope: result.scope });
      snapshots.push(snapshot);
      const key=anchorKey(snapshot); activeKeys.add(key);
      if(this.anchors.has(key)) release.push(item);
      else this.anchors.set(key,{...item,snapshot:key});
    }
    // Current scope is protected regardless of its size. Only historical
    // immutable anchors are capped; duplicate captures reuse current anchors.
    const historical=[...this.anchors.entries()].filter(([key])=>!activeKeys.has(key));
    for(const [key,anchor] of historical.slice(0,Math.max(0,historical.length-64))) { this.anchors.delete(key); release.push(anchor); }
    await this.releaseAnchors(release);
    const liveBlocks=new Set([...this.anchors.values()].map(anchor=>anchor.id));
    for(const id of this.blockStates.keys()) if(!liveBlocks.has(id)) this.blockStates.delete(id);
    if(mode!=='selection') this.lastSignature=await this.scopeSignature(result);
    return { scope: result.scope, pageIndices: result.pageIndices, snapshots };
  }
  async discardFallbackHistory() {
    const anchors=[...this.anchors.values()]; this.anchors.clear(); this.blockStates.clear(); this.lastSignature=null;
    try { await this.releaseAnchors(anchors); }
    catch(error) { if(error.code!=='InvalidObjectPath') throw error; }
  }
  async readScopeRecovering(mode,lightweight=false) {
    const attempted=new Set();
    while(true) {
      try { return await this.run(context=>this.readScope(context,mode,lightweight)); }
      catch(error) {
        if(attempted.has(error.code)) throw error;
        attempted.add(error.code);
        if(error.code==='historyAnchorUnavailable') { await this.discardFallbackHistory(); continue; }
        if(error.code==='identityUnavailable') { this.degrade('safeReplace','Microsoft 365 段落身份 API 不可用，仅预览与侧栏定位。'); this.capabilities.paragraphEvents=false; continue; }
        if(error.code==='pageRangeUnavailable'&&this.capabilities.visiblePages&&!this.pageMetadataFallback) { this.pageReadFailureDiagnostic=error.message;if(this.#diagnostics)observePageFailure(this.pageReadFailureDiagnostic);this.pageMetadataFallback=true;continue; }
        if(error.code==='pageReadUnavailable'&&this.capabilities.visiblePages) { this.pageReadFailureDiagnostic=this.pageReadFailureDiagnostic?this.pageReadFailureDiagnostic+'|'+error.message:error.message;if(this.#diagnostics)observePageFailure(this.pageReadFailureDiagnostic); this.degrade('visiblePages','可见页 API 运行失败，使用活动段模式。'); if(this.#diagnostics&&/^stage_paragraphIndex;code_GeneralException;/.test(error.message))await this.#probeUIDMatrixOnce();mode='activeParagraph'; continue; }
        throw error;
      }
    }
  }
  // Temporary one-shot host diagnostic. Returns only fixed codes/counts/booleans.
  // Fresh and cached contexts share the existing FIFO; no API objects escape.
  async #probeUIDMatrixOnce() {
    if(!this.#diagnostics||this.#uidMatrixAttempted)return;this.#uidMatrixAttempted=true;
    const codes=new Set(['InvalidObjectPath','InvalidArgument','InvalidOperation','NotSupported','NotImplemented','ItemNotFound','AccessDenied','GeneralException','PropertyNotLoaded','InternalError','ApiNotFound','ActivityLimitReached','Timeout','TypeError','documentChanged','disposed','cachedUnavailable','over_limit']);
    const sameDocument=()=>!this.disposed&&this.Office?.context?.document===this.documentIdentity;
    const cases=[['fs',true,'single'],['cs',false,'single'],['fl',true,'legacy'],['cl',false,'legacy'],['ft',true,'typed'],['ct',false,'typed']],rows=[];
    for(const [label,fresh,kind]of cases){
      let code='ok',count=0,guid=false;
      try{
        if(!sameDocument())fail(this.disposed?'disposed':'documentChanged');
        if(!fresh&&!this.documentProxy)fail('cachedUnavailable');
        const callback=async context=>{
          if(!sameDocument())fail(this.disposed?'disposed':'documentChanged');
          let collection,paragraph;
          if(kind==='single'){paragraph=context.document.getSelection().paragraphs.getFirst();paragraph.load('uniqueLocalId');}
          else{collection=context.document.body.paragraphs;collection.load(kind==='legacy'?{select:'uniqueLocalId',top:1,skip:0}:{uniqueLocalId:true,$top:1,$skip:0});}
          await context.sync();if(!sameDocument())fail(this.disposed?'disposed':'documentChanged');
          const items=paragraph?[paragraph]:collection.items;if(!Array.isArray(items)||items.length>1)fail('over_limit');
          return {count:items.length,guid:items.length===1&&typeof items[0].uniqueLocalId==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(items[0].uniqueLocalId)};
        };
        const result=this.operations.then(()=>sharedWordRun(this.Word,fresh?[callback]:[this.documentProxy,callback]));this.operations=result.catch(()=>{});
        const value=await result;count=value.count;guid=value.guid;if(count===0)code='empty';
      }catch(error){code=codes.has(error?.code)?error.code:'other';}
      rows.push(label+'_'+code+'_n'+count+'_g'+(guid?'1':'0'));
    }
    try{const document=globalThis.document;if(sameDocument()&&typeof document?.createElement==='function'&&typeof document.title==='string')document.title='写作 uidmatrix['+rows.join(';')+']';}catch{}
  }
  async paragraphsByPageMetadata(context,document,viewportPages) {
    let stage='paragraphIndex';
    try {
      if(!this.capabilities.safeReplace)fail('metadataUnavailable');
      const collection=document.body.paragraphs;
      collection.load({select:'uniqueLocalId',top:1001,skip:0});await context.sync();
      const paragraphs=collection.items;if(paragraphs.length>1000)fail('metadataParagraphLimit');if(!paragraphs.length)fail('metadataUnavailable');
      const ids=new Set();for(const paragraph of paragraphs){const id=paragraph.uniqueLocalId;if(typeof id!=='string'||!id.trim()||ids.has(id))fail('identityUnavailable');ids.add(id);}
      // Use independent UID paths for initial metadata, as for the final barrier.
      stage='paragraphPages';const records=[...ids].map(id=>{const paragraph=document.getParagraphByUniqueLocalId(id);paragraph.load('uniqueLocalId');const pages=paragraph.getRange().pages;pages.load('items/index');return {id,paragraph,pages};});await context.sync();
      for(const record of records)if(record.paragraph.uniqueLocalId!==record.id)fail('identityUnavailable');
      const viewport=new Set(viewportPages),matched=[];
      for(const item of records){item.initialPages=verifiedPageIndices(item.pages);if(item.initialPages.some(index=>viewport.has(index)))matched.push(item.paragraph);}
      if(!matched.length)fail('invalidPageMetadata');
      stage='matchedParagraphText';for(const paragraph of matched)paragraph.load('text');await context.sync();
      return {collection,paragraphs:matched,records,ids:[...ids]};
    }catch(error){if(error.code==='identityUnavailable')throw error;throw new HostContractError('pageReadUnavailable',pageReadDiagnostic(stage,error,viewportPages.length));}
  }
  async readScope(context, mode, lightweight = false) {
    this.assertDocument(); const document = context.document;
    let scope=mode, pages=null, selection=null,visibleParagraphs=null,initialPageIndices=null,pageMetadata=null;
    const collections=[];
    if ((scope==='visiblePages'||scope==='cursorPage')&&!this.capabilities.visiblePages) scope='activeParagraph';
    if (scope==='cursorPage') { const cursor=document.getSelection(); cursor.load('isEmpty'); await context.sync(); if(!cursor.isEmpty) fail('cursorPageRequiresCursor','请取消选区后使用光标页模式。'); }
    if (scope==='visiblePages'||scope==='cursorPage') {
      let stage='viewport',pageCount=0,viewportKnown=false;
      try {
        if(scope==='visiblePages'){
          const pane=document.activeWindow.activePane;this.retainNavigation(pane);
          pages=pane.pagesEnclosingViewport;this.retainNavigation(pages);
        }else pages=document.getSelection().pages;
        pages.load('items/index'); await context.sync();
        const viewportPages=verifiedPageIndices(pages);initialPageIndices=[...viewportPages];viewportKnown=true;
        if(this.pageMetadataFallback){
          const result=await this.paragraphsByPageMetadata(context,document,viewportPages);collections.push(result.collection);visibleParagraphs=result.paragraphs;pageMetadata=result;
          if(!this.pageMetadataAnnounced){this.pageMetadataAnnounced=true;this.capabilities.message='使用段落页码兼容模式。';this.onStatus(this.capabilities);this.notify({type:'capabilitiesChanged',capabilities:{...this.capabilities}});}
        }else{
        stage='pageRange';pageCount=pages.items.length;
        const ranges=pages.items.map(page=>{const range=page.getRange('Whole');range.load('isEmpty');return range;});
        await context.sync();
        stage='pageParagraphs';
        for(const range of ranges) { const collection=range.paragraphs; collection.load('items/text'); collections.push(collection); }
        await context.sync();
        }
      } catch(error) { if(['pageReadUnavailable','identityUnavailable'].includes(error.code))throw error;throw new HostContractError(viewportKnown&&!this.pageMetadataFallback?'pageRangeUnavailable':'pageReadUnavailable',pageReadDiagnostic(stage,error,pageCount)); }
    } else { selection=document.getSelection(); selection.load('text'); const collection=selection.paragraphs; collection.load('items/text'); collections.push(collection); await context.sync(); }
    let paragraphs=visibleParagraphs||collections.flatMap(collection=>collection.items);
    if(scope==='activeParagraph') paragraphs=paragraphs.slice(0,1);
    if(scope==='selection'&&paragraphs.length!==1) fail('crossParagraphSelection','请在一个段落内选择文本。');
    const candidates=paragraphs.map(paragraph=>({paragraph,range:paragraph.getRange()}));
    let selected=[];
    if(this.capabilities.safeReplace) {
      try { for(const item of candidates) item.paragraph.load('uniqueLocalId'); await context.sync(); }
      catch { fail('identityUnavailable'); }
      const ids=new Set();
      for(const item of candidates) { const id=item.paragraph.uniqueLocalId; if(!ids.has(id)) { ids.add(id); selected.push({...item,id}); } }
    } else {
      // The persistent, tracked Document keeps these ClientObjects in one
      // RequestContext. Queue fallback comparisons, then synchronize once.
      const pairs=[];
      for(let i=0;i<candidates.length;i++) for(let j=0;j<i;j++) {
        if(candidates[i].paragraph.text===candidates[j].paragraph.text) pairs.push({i,j,result:candidates[i].range.compareLocationWith(candidates[j].range)});
      }
      const existing=[...new Map([...this.anchors.values()].map(anchor=>[anchor.id,anchor])).values()];
      const oldPairs=[];
      try {
        for(let i=0;i<candidates.length;i++) for(const anchor of existing) oldPairs.push({i,anchor,result:candidates[i].range.compareLocationWith(anchor.paragraph.getRange())});
        if(pairs.length||oldPairs.length) await context.sync();
      } catch(error) {
        if(existing.length&&error.code==='InvalidObjectPath') throw new HostContractError('historyAnchorUnavailable','Stale fallback history; capture with fresh identities.');
        throw error;
      }
      const duplicates=new Set(pairs.filter(pair=>pair.result.value==='Equal').map(pair=>pair.i));
      for(let i=0;i<candidates.length;i++) if(!duplicates.has(i)) selected.push({...candidates[i],id:oldPairs.find(pair=>pair.i===i&&pair.result.value==='Equal')?.anchor.id||uid()});
    }
    const descriptors=selected.map(item=>{
      const previous=item.paragraph.getPreviousOrNullObject(),next=item.paragraph.getNextOrNullObject(); previous.load('text,isNullObject'); next.load('text,isNullObject');
      const paragraphPages=this.capabilities.visiblePages?item.range.pages:null; paragraphPages?.load('items/index');
      const xml=lightweight?null:item.paragraph.getOoxml();
      return {...item,previous,next,paragraphPages,xml};
    });
    await context.sync();
    const items=[];
    for(const item of descriptors) {
      const text=item.paragraph.text;
      if(scope!=='selection'&&!/\S/u.test(text)) continue;
      let targetRange={start:0,length:text.length};
      if(scope==='selection') {
        if(!/\S/u.test(selection.text)) fail('emptySelection','请先选择文本。');
        if(/[\r\n\u0007\u2028\u2029]/.test(selection.text)) fail('selectionParagraphMark','选区包含段落标记，请只选择正文文字后重试。');
        const range=await this.literalRange(context,item.range,selection.text),comparison=range.compareLocationWith(selection); await context.sync();
        const start=text.indexOf(selection.text);
        if(comparison.value!=='Equal'||start<0||text.indexOf(selection.text,start+1)>=0) fail('ambiguousSelection','选区在段落中重复，请选择唯一文本。');
        targetRange={start,length:selection.text.length};
      }
      assertUTF16Range(text,targetRange);
      const before=boundedContext(item.previous.isNullObject?'':item.previous.text,'before'),after=boundedContext(item.next.isNullObject?'':item.next.text,'after');
      if(targetRange.length>4000||text.length+before.length+after.length>6000) fail('scopeTooLarge','检查范围过长，请缩小范围。');
      let pageIndices=item.paragraphPages?uniquePages(item.paragraphPages):[];
      if(this.pageMetadataFallback&&pages){try{pageIndices=verifiedPageIndices(item.paragraphPages);if(!pageIndices.some(index=>verifiedPageIndices(pages).includes(index)))fail('invalidPageMetadata');}catch(error){throw new HostContractError('pageReadUnavailable',pageReadDiagnostic('paragraphPages',error,pages.items.length));}}
      items.push({...item,text,before,after,targetRange,pageIndices});
    }
    let group=null;
    if(!lightweight) {
      const protections=await this.fieldProtections(context,items.map(item=>({range:item.range,text:item.text,xml:item.xml.value})));
      items.forEach((item,index)=>Object.assign(item,protections[index]));
      group={collections,remaining:items.length};
      if(items.length) {
        if(this.pageMetadataFallback&&pages)pageTrace(context,'wf0',this.#diagnostics);
        for(const collection of collections)this.retainTracked(collection);
        if(this.pageMetadataFallback&&pages)pageTrace(context,'wf1',this.#diagnostics);
        for(const item of items) { this.retainTracked(item.paragraph); item.group=group; }
        if(this.pageMetadataFallback&&pages)pageTrace(context,'wf2',this.#diagnostics);
        if(!this.pageMetadataFallback||!pages)await context.sync();
      }
    }
    if(this.pageMetadataFallback&&pages){
      try{
        const latest=scope==='visiblePages'?document.activeWindow.activePane.pagesEnclosingViewport:document.getSelection().pages;
        pageTrace(context,'wf3',this.#diagnostics);
        pageMetadata.collection.load({select:'uniqueLocalId',top:1001,skip:0});
        pageTrace(context,'wf4',this.#diagnostics);
        for(const record of pageMetadata.records){record.latestPages=document.getParagraphByUniqueLocalId(record.id).getRange().pages;record.latestPages.load('items/index');}
        pageTrace(context,'wf5',this.#diagnostics);latest.load('items/index');pageTrace(context,'wf6',this.#diagnostics);await context.sync();this.assertDocument();
        if(JSON.stringify(verifiedPageIndices(latest))!==JSON.stringify(initialPageIndices))fail('invalidPageMetadata');
        if(JSON.stringify(pageMetadata.collection.items.map(paragraph=>paragraph.uniqueLocalId))!==JSON.stringify(pageMetadata.ids))fail('invalidPageMetadata');
        for(const record of pageMetadata.records)if(JSON.stringify(verifiedPageIndices(record.latestPages))!==JSON.stringify(record.initialPages))fail('invalidPageMetadata');
      }catch(error){
        if(group&&items.length){try{for(const item of items)this.releaseTracked(item.paragraph);for(const collection of collections)this.releaseTracked(collection);await context.sync();}catch{}}
        if(['documentChanged','disposed'].includes(error.code))throw error;
        throw new HostContractError('pageReadUnavailable',pageReadDiagnostic('viewportFinal',error,initialPageIndices.length));
      }
    }
    return {scope,pageIndices:pages?uniquePages(pages):[],items};
  }
  async fieldProtections(context, items) {
    const containsFields=items.map(item=>fieldMarkup(item.xml,this.XMLParser));
    const results=items.map((item,index)=>({protectedRanges:[],fieldsKnown:!containsFields[index]}));
    const pending=[];
    if(!this.supports('WordApi','1.4')) return results;
    try {
      items.forEach((item,index)=>{ if(containsFields[index]) { const fields=item.range.fields; fields.load('items'); pending.push({item,index,fields}); } });
      if(!pending.length) return results;
      await context.sync();
      for(const entry of pending) entry.parts=entry.fields.items.map(field=>{
        const result=field.result; result.load('text'); const prefix=entry.item.range.getRange('Start').expandTo(result.getRange('Start')); prefix.load('text'); return {result,prefix};
      });
      await context.sync();
      for(const entry of pending) {
        if(!entry.parts.length) continue;
        const ranges=entry.parts.map(({result,prefix})=>{ const range={start:prefix.text.length,length:result.text.length}; assertUTF16Range(entry.item.text,range); if(entry.item.text.slice(range.start,range.start+range.length)!==result.text) fail('fieldMappingUnavailable'); return range; }).filter(range=>range.length>0);
        results[entry.index]={protectedRanges:ranges,fieldsKnown:true};
      }
    } catch { /* Unknown field positions remain preview-only, never blanket semantic protection. */ }
    return results;
  }
  async fieldProtection(context, paragraphRange, text, xml) {
    return (await this.fieldProtections(context,[{range:paragraphRange,text,xml}]))[0];
  }
  async literalRange(context, paragraphRange, text) {
    const options = { matchCase: true, matchWildcards: false, matchWholeWord: false };
    if (text.length <= 255) {
      const hits = paragraphRange.search(text, options); hits.load('items/text'); await context.sync();
      if (hits.items.length !== 1) fail('ambiguousRange', 'Ambiguous host search range; preview only.');
      if (hits.items[0].text !== text) fail('staleSnapshot', 'Stale search range text.');
      return hits.items[0];
    }
    // Office literal searches are limited to 255 characters. Resolve two unique
    // bounded anchors, then verify the expanded range equals the entire source.
    const prefix = boundedContext(text, 'after', 255), suffix = boundedContext(text, 'before', 255);
    if (!prefix || !suffix) fail('ambiguousRange', 'No safe bounded search anchor.');
    const starts = paragraphRange.search(prefix, options), ends = paragraphRange.search(suffix, options);
    starts.load('items/text'); ends.load('items/text'); await context.sync();
    if (starts.items.length !== 1 || ends.items.length !== 1) fail('ambiguousRange', 'Ambiguous long-text anchor; preview only.');
    const range = starts.items[0].expandTo(ends.items[0]); range.load('text'); await context.sync();
    if (range.text !== text) fail('ambiguousRange', 'Expanded host range differs from original.');
    return range;
  }
  async literalRangeAt(context, paragraphRange, text, start, rawText, paragraph, searchRange=paragraphRange) {
    assertUTF16Range(rawText,{start,length:text.length});
    if(rawText.slice(start,start+text.length)!==text) fail('staleSnapshot','目标文字已变化，请重新检查。');
    let ranges;
    if(text.length<=255) {
      const hits=searchRange.search(text,{matchCase:true,matchWildcards:false,matchWholeWord:false});
      hits.load('items/text'); await context.sync(); ranges=hits.items;
    } else ranges=[await this.literalRange(context,searchRange,text)];
    if(!ranges.length||ranges.length>64) fail('ambiguousRange','目标片段重复过多或无法定位；仅预览，请选择较长片段。');
    // Never trust the first literal hit or a numeric offset alone. Ask Word for
    // each physical prefix and match its exact UTF-16 text to the fresh snapshot.
    const positions=ranges.map(range=>{const prefix=paragraphRange.getRange('Start').expandTo(range.getRange('Start'));prefix.load('text');return {range,prefix};});
    paragraph.load('text');
    await context.sync();
    if(paragraph.text!==rawText) fail('staleSnapshot','Stale paragraph while locating target; capture again.');
    const expected=rawText.slice(0,start),matches=positions.filter(({range,prefix})=>range.text===text&&prefix.text.length===start&&prefix.text===expected);
    if(matches.length!==1) fail('ambiguousRange','无法唯一核对目标位置；仅预览，请重新选择文本。');
    return matches[0].range;
  }
  async scopeSignature(result) { return sha256(JSON.stringify([result.scope, result.pageIndices, result.items.map(item => [item.text, item.before, item.after, item.targetRange, item.pageIndices])])); }
  async verifiedRange(context, envelope, write = false, finalActiveWindow = false) {
    this.assertDocument(); assertIssueEnvelope(envelope);
    if (write && /[\u0000-\u001F\u007F\u2028\u2029]/.test(envelope.issue.replacement)) fail('invalidReplacement', 'Replacement contains control or paragraph boundaries.');
    const { snapshot, issue } = envelope;
    const anchor = this.anchors.get(anchorKey(snapshot));
    if (!anchor || snapshot.documentSessionID !== this.documentSessionID || snapshot.revision !== String(this.blockStates.get(snapshot.blockID)?.revision) || anchorKey(snapshot) !== anchor.snapshot) fail('staleSnapshot', 'Stale snapshot; capture again.');
    if (await sha256(snapshot.rawText) !== snapshot.snapshotHash || await sha256(snapshot.contextBefore + '\u0000' + snapshot.contextAfter) !== snapshot.contextHash) fail('snapshotMismatch');
    if (write && !this.capabilities.safeReplace) fail('previewOnly', '此 Word 要求集无法核验段落身份，仅预览。');
    const paragraph = this.capabilities.safeReplace ? context.document.getParagraphByUniqueLocalId(snapshot.blockID) : anchor.paragraph;
    paragraph.load('text');
    const previous = paragraph.getPreviousOrNullObject(), next = paragraph.getNextOrNullObject(); previous.load('text,isNullObject'); next.load('text,isNullObject');
    const parentControl = paragraph.getRange().parentContentControlOrNullObject; parentControl.load('isNullObject');
    const xml = paragraph.getOoxml(); await context.sync();
    const before = boundedContext(previous.isNullObject ? '' : previous.text, 'before'), after = boundedContext(next.isNullObject ? '' : next.text, 'after');
    if (paragraph.text !== snapshot.rawText || await sha256(before + '\u0000' + after) !== snapshot.contextHash) fail('staleSnapshot', 'Stale paragraph or context; capture again.');
    if (write && (this.documentIdentity.mode === 'readOnly' || !parentControl.isNullObject || snapshot.protectedRanges.some(range => overlaps(range, issue.range)))) fail('protectedRange', 'Protected range: preview only.');
    const fullRange = await this.literalRangeAt(context, paragraph.getRange(), issue.original,issue.range.start,snapshot.rawText,paragraph);
    const change=write?graphemeChange(issue.original,issue.replacement):{offset:0,original:issue.original,replacement:issue.replacement};
    const range=change.offset===0&&change.original===issue.original?fullRange:await this.literalRangeAt(context,paragraph.getRange(),change.original,issue.range.start+change.offset,snapshot.rawText,paragraph,fullRange);
    if (write) await this.assertRangeWritable(context, envelope, paragraph, range, xml.value,change,fullRange);
    let window=null;
    if(finalActiveWindow){
      if(!this.supports('WordApiDesktop','1.4'))fail('active_window_unavailable','Word cannot verify the active document window.');
      window=context.document.activeWindow;window.load('isActive');
    }
    // One common final batch verifies the latest source, neighbors, physical
    // target and (for native acceptance) active window immediately before Replace.
    paragraph.load('text');previous.load('text,isNullObject');next.load('text,isNullObject');range.load('text');await context.sync();
    if (paragraph.text !== snapshot.rawText || boundedContext(previous.isNullObject ? '' : previous.text, 'before') !== snapshot.contextBefore || boundedContext(next.isNullObject ? '' : next.text, 'after') !== snapshot.contextAfter || snapshot.revision !== String(this.blockStates.get(snapshot.blockID)?.revision)) fail('staleSnapshot', 'Stale text at final verification.');
    if(range.text!==change.original)fail('staleSnapshot','Stale text at minimal range.');
    if(window&&window.isActive!==true)fail('document_inactive','The document window is no longer active.');
    if(window&&this.documentIdentity.mode==='readOnly')fail('protectedRange','Document is now read-only.');
    this.assertDocument(); return { range, paragraph, change };
  }
  async assertRangeWritable(context, envelope, paragraph, range, paragraphXML,change,fullRange) {
    const {snapshot,issue} = envelope;
    const protection = await this.fieldProtection(context, paragraph.getRange(), paragraph.text, paragraphXML);
    if (!protection.fieldsKnown) fail('previewOnly', 'Field positions cannot be verified: preview only.');
    if (protection.protectedRanges.some(protectedRange => overlaps(protectedRange, issue.range))) fail('protectedRange', 'Field result is protected: preview only.');
    const xml = range.getOoxml();
    const fullXML=range===fullRange?xml:fullRange.getOoxml();
    const parent = range.parentContentControlOrNullObject; parent.load('isNullObject');
    const children = range.contentControls; children.load('items');
    const fullParent=range===fullRange?parent:fullRange.parentContentControlOrNullObject;fullParent.load('isNullObject');
    const fullChildren=range===fullRange?children:fullRange.contentControls;fullChildren.load('items');
    await context.sync();
    // Multiple untouched runs are verified only as the original issue context;
    // the actual replacement range must still be exactly one plain run/text.
    const fullSafe=plainParagraphXML(fullXML.value,issue.original,this.XMLParser,true),changeSafe=plainParagraphXML(xml.value,change.original,this.XMLParser);
    if (this.documentIdentity.mode === 'readOnly' || !parent.isNullObject || children.items.length || !fullParent.isNullObject || fullChildren.items.length || !fullSafe || !changeSafe) fail('protectedRange', 'Target formatting cannot be safely replaced: preview only.');
    if (range.text !== change.original || paragraph.text !== snapshot.rawText) fail('staleSnapshot', 'Stale target range.');
  }
  async getIssueActions(envelope) {
    try {
      assertIssueEnvelope(envelope);
      if (envelope.issue.original === envelope.issue.replacement) return {canApply:false,reason:'Review-only issue: preview and focus without document writes.'};
      await this.runForEnvelope(envelope, context => this.verifiedRange(context,envelope,true));
      return {canApply:true,reason:''};
    } catch (error) { return {canApply:false,reason:error.message || 'Preview only.'}; }
  }
  async focusIssue(envelope) { await this.runForEnvelope(envelope, async context => { const { range } = await this.verifiedRange(context, envelope); range.select('Select'); await context.sync(); }); }
  async getIssuePageIndices(envelope) {
    if (!this.capabilities.visiblePages) return [];
    return this.runForEnvelope(envelope, async context => { const { range } = await this.verifiedRange(context, envelope); const pages = range.pages; pages.load('items/index'); await context.sync(); return uniquePages(pages); });
  }
  async applyIssue(envelope,{onCommit}={}) {
    assertIssueEnvelope(envelope);
    if (envelope.issue.original === envelope.issue.replacement) fail('reviewOnly', 'Review-only issue: preview and focus without document writes.');
    if (this.applying) fail('staleSnapshot', 'Another suggestion is being applied.');
    this.applying = true;
    try {
      await this.runForEnvelope(envelope, async context => {
        const {range,change}=await this.verifiedRange(context,envelope,true,this.requireActiveWindow);
        // Do not set changeTrackingMode. Word owns tracking and native undo.
        range.insertText(change.replacement, 'Replace'); await context.sync();
        this.blockStates.get(envelope.snapshot.blockID).revision++;
        if(typeof onCommit==='function'){try{onCommit();}catch{/* Observation cannot change an already committed Word edit. */}}
      });
    } finally { this.applying = false; }
    this.lastSignature = null; await this.clear(); if (this.callback) await this.publishAutomaticScope();
  }
  async showIssues(envelopes) {
    await this.clearAnnotations(); if (!this.annotationCandidate || !envelopes.length) return;
    const previouslyAvailable = this.capabilities.annotations;
    try {
      for (const envelope of envelopes) {
        await this.runForEnvelope(envelope, async context => {
          const { paragraph } = await this.verifiedRange(context, envelope);
          const { range, category } = envelope.issue;
          const result = paragraph.insertAnnotations({ critiques: [{ start: range.start, length: range.length, colorScheme: category === 'spelling' || category === 'grammar' ? 'Red' : category === 'expression' ? 'Blue' : 'Lavender' }] });
          await context.sync();
          for (const id of result.value) this.annotations.set(id, envelope);
          if (result.value.length) this.capabilities.annotations = true;
        });
      }
      if (!previouslyAvailable && this.capabilities.annotations) {
        this.capabilities.message = this.capabilities.message.replace(' 文内下划线尚未验证，需要 Microsoft 365；当前保留侧栏定位。','');
        this.onStatus(this.capabilities); this.notify({type:'capabilitiesChanged',capabilities:{...this.capabilities}});
      }
    } catch (error) {
      if (error instanceof HostContractError) throw error;
      await this.clearAnnotations(); this.annotationCandidate = false; this.degrade('annotations', 'Microsoft 365 文内标注服务不可用；保留侧栏定位与接受。');
    }
  }
  async clearAnnotations() {
    if (!this.annotations.size) return;
    const ids = [...this.annotations.keys()];
    await this.run(async context => { for (const id of ids) { try { context.document.getAnnotationById(id).delete(); } catch { /* Already removed by Word. */ } } await context.sync(); });
    ids.forEach(id => this.annotations.delete(id));
  }
  retainNavigation(object){if(!this.navigationOwners.has(object)){this.retainTracked(object);this.navigationOwners.add(object);}}
  retainTracked(object){const count=this.trackedReferences.get(object)||0;if(!count)object.track();this.trackedReferences.set(object,count+1);}
  releaseTracked(object){const count=this.trackedReferences.get(object)||0;if(!count)return;if(count>1)this.trackedReferences.set(object,count-1);else{this.trackedReferences.delete(object);object.untrack();}}
  async releaseAnchors(anchors) {
    if(!anchors.length) return;
    await this.run(this.documentProxy||anchors[0].paragraph,async context=>{
      for(const anchor of anchors) { this.releaseTracked(anchor.paragraph); if(anchor.group&&--anchor.group.remaining===0) for(const collection of anchor.group.collections)this.releaseTracked(collection); }
      await context.sync();
    });
  }
  async releaseAnchor(anchor) { await this.releaseAnchors([anchor]); }
  async clear() { await this.clearAnnotations(); }
  async publishAutomaticScope() { const scope = await this.captureScope('visiblePages'); this.notify({ type: 'scopeChanged', scope }); }
  async invalidate() { this.lastSignature = null; await this.clear(); await this.publishAutomaticScope(); }
  async watch(onChange) {
    if (this.unsubscribe) await this.unsubscribe();
    this.assertDocument(); this.callback = onChange; let active = true;
    const changed = () => { if (active) return this.invalidate(); };
    let eventOwner;
    await this.run(async context => {
      eventOwner = this.documentProxy || context.document.track();
      if (this.capabilities.paragraphEvents) {
        try { for (const name of ['onParagraphAdded', 'onParagraphChanged', 'onParagraphDeleted']) this.eventRegistrations.push(context.document[name].add(changed)); await context.sync(); }
        catch { this.degrade('paragraphEvents', '段落事件不可用；750 ms 有界复核当前范围。'); this.capabilities.safeReplace = false; }
      }
      if (this.annotationCandidate) {
        try {
          for (const name of ['onAnnotationClicked', 'onAnnotationHovered']) this.eventRegistrations.push(context.document[name].add(args => { const envelope = this.annotations.get(args.id); if (active && envelope) this.notify({ type: 'annotationFocus', envelope }); }));
          await context.sync();
        } catch { this.annotationCandidate = false; this.degrade('annotations', '文内标注事件不可用；保留侧栏定位。'); }
      }
    });
    const poll = async () => {
      if (!active || this.polling || this.disposed || globalThis.document?.visibilityState === 'hidden') return;
      this.polling = true;
      try {
        const result=await this.readScopeRecovering('visiblePages',true);
        const signature = await this.scopeSignature(result);
        if (this.lastSignature !== signature) { const scope = await this.captureScope('visiblePages'); if (active) this.notify({ type: 'scopeChanged', scope }); }
      } catch (error) { if (active) this.notify({ type: 'invalidated', code: error.code || 'hostError' }); }
      finally { this.polling = false; }
    };
    const timer = this.timers.setInterval(poll, 750);
    this.unsubscribe = async () => {
      if (!active) return; active = false; this.timers.clearInterval(timer);
      this.callback = null; this.unsubscribe = null;
      const errors = [];
      for (const registration of this.eventRegistrations.splice(0)) {
        try { await this.run(eventOwner, async context => { registration.remove(); await context.sync(); }); }
        catch (error) { errors.push(error); }
      }
      try { if(eventOwner!==this.documentProxy) await this.run(eventOwner, async context => { eventOwner.untrack(); await context.sync(); }); } catch (error) { errors.push(error); }
      try { await this.clearAnnotations(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Word watcher cleanup failed.');
    };
    return this.unsubscribe;
  }
  async dispose() {
    if (this.disposed) return;
    const errors = [];
    try { if (this.unsubscribe) await this.unsubscribe(); } catch (error) { errors.push(error); }
    this.callback = null;
    try { await this.clear(); } catch (error) { errors.push(error); }
    try { await this.releaseAnchors([...this.anchors.values()]); } catch(error) { errors.push(error); }
    this.anchors.clear();
    if(this.trackedReferences.size){try{await this.run(this.documentProxy,async context=>{for(const object of this.trackedReferences.keys())object.untrack();await context.sync();});}catch(error){errors.push(error);}finally{this.trackedReferences.clear();}}
    this.navigationOwners.clear();
    try { if(this.documentProxy) await this.run(this.documentProxy,async context=>{this.documentProxy.untrack();await context.sync();}); } catch(error) { errors.push(error); }
    this.documentProxy=null; this.disposed = true;
    if (errors.length) throw new AggregateError(errors, 'Word host cleanup failed.');
  }
}
export function createWordHost(options) { return new WordHostAdapter(options); }
