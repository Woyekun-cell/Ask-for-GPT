import {WritingHostAdapter, HostContractError, SCOPES, createSnapshot, sha256, assertIssueEnvelope, assertUTF16Range, overlaps} from '../shared/host-contract.js';

const uid = () => globalThis.crypto.randomUUID();
const fail = (code, message = code) => {throw new HostContractError(code, message);};
// requestID changes at the transport boundary. Every source/permission boundary remains immutable.
const anchorKey = s => JSON.stringify([s?.documentSessionID,s?.blockID,s?.revision,s?.rawText,s?.snapshotHash,s?.contextHash,s?.contextBefore,s?.contextAfter,s?.targetRange,s?.protectedRanges,s?.scope]);
const safeXML = xml => typeof xml === 'string' && (xml.match(/<w:p(?=[\s/>])/g) || []).length === 1 &&
  (xml.match(/<w:r(?=[\s/>])/g) || []).length === 1 && (xml.match(/<w:t(?=[\s/>])/g) || []).length === 1 &&
  !/<(?:w:(?:fldChar|fldSimple|instrText|sdt|hyperlink|drawing|pict|object|footnoteReference|endnoteReference|commentReference|ins|del|moveFrom|moveTo|vertAlign|vanish|webHidden|sym|br|tab|softHyphen|noBreakHyphen|permStart|permEnd|tbl)|m:)/.test(xml);
function bounded(text, side) {
  if (text.length <= 1000) return text;
  const pieces = globalThis.Intl?.Segmenter ? Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text), part => part.segment) : Array.from(text);
  let result = '';
  for (const piece of side === 'before' ? pieces.reverse() : pieces) {if (result.length + piece.length > 1000) break; result = side === 'before' ? piece + result : result + piece;}
  return result;
}

/** WPS desktop adapter. API existence is not Mac compatibility or undo certification. */
export class WPSHostAdapter extends WritingHostAdapter {
  constructor({Application = globalThis.Application || globalThis.wps, onStatus = () => {}} = {}) {
    super(); this.Application = Application; this.onStatus = onStatus; this.documentSessionID = uid(); this.anchors = new Map(); this.callback = null; this.registrations = []; this.disposed = false; this.applying = false;
    this.capabilities = {visiblePages:false,cursorPage:false,annotations:false,suggestionPopup:false,safeReplace:true,paragraphEvents:false,automaticCheck:false,
      message:'侧栏检查；文内彩色下划线不可用。WPS Mac 内容事件尚未实测，使用主动检查。替换与原生撤销仍需实机验证。'};
  }
  async initialize() {
    this.app = typeof this.Application?.WpsApplication === 'function' ? this.Application.WpsApplication() : this.Application;
    if (!this.app?.ActiveDocument || !this.app.Selection?.Range || typeof this.app.ActiveDocument.Range !== 'function') fail('wpsUnavailable','请在 WPS 文字加载项任务窗内打开写作助手。');
    this.document = this.app.ActiveDocument; this.documentName = this.document.FullName || this.document.Name;
    this.events = this.Application?.ApiEvent || this.app.ApiEvent;
    this.onStatus({...this.capabilities}); return {...this.capabilities};
  }
  assertDocument() {
    if (this.disposed) fail('disposed');
    if (this.app?.ActiveDocument !== this.document || (this.document.FullName || this.document.Name) !== this.documentName) fail('documentChanged','Document identity changed; capture again.');
  }
  readParagraph(paragraph) {
    const range = paragraph.Range, text = range.Text;
    if (range.StoryType !== 1) fail('unsupportedStory','当前仅支持正文选区。');
    if (typeof text !== 'string' || !Number.isSafeInteger(range.Start) || range.End - range.Start !== text.length) fail('coordinateMismatch','WPS range 与 UTF-16 不一致，仅支持核验后检查。');
    const previous = range.Start > 0 ? paragraph.Previous() : null;
    const next = range.End < this.document.Content.End ? paragraph.Next() : null;
    if ((range.Start > 0 && !previous) || (range.End < this.document.Content.End && !next)) fail('contextUnavailable','邻段上下文不可读取，请重新检查。');
    return {range,text,before:bounded(previous ? previous.Range.Text : '','before'),after:bounded(next ? next.Range.Text : '','after')};
  }
  protection(range, text) {
    try {
      const fields = range.Fields;
      if (!Number.isSafeInteger(fields?.Count) || fields.Count < 0) return {known:false,ranges:[]};
      const ranges = [];
      for (let i=1;i<=fields.Count;i++) {
        const result = fields.Item(i).Result, field = {start:result.Start-range.Start,length:result.End-result.Start};
        assertUTF16Range(text,field);
        if (text.slice(field.start,field.start+field.length) !== result.Text) return {known:false,ranges:[]};
        if (field.length) ranges.push(field);
      }
      return {known:true,ranges};
    } catch {return {known:false,ranges:[]};}
  }
  async captureScope(mode = 'activeParagraph') {
    this.assertDocument(); if (!SCOPES.includes(mode)) fail('invalidScope');
    const scope = mode === 'selection' ? 'selection' : 'activeParagraph';
    const selected = this.app.Selection.Range;
    if (scope === 'selection' && selected.Start === selected.End) fail('emptySelection','请先选择文本。');
    if (scope === 'selection' && selected.Paragraphs.Count !== 1) fail('invalidSelection','请在单个段落内选择文本。');
    const paragraph = selected.Paragraphs.Item(1), data = this.readParagraph(paragraph);
    const targetRange = scope === 'selection' ? {start:selected.Start-data.range.Start,length:selected.End-selected.Start} : {start:0,length:data.text.endsWith('\r') ? data.text.length-1 : data.text.length};
    assertUTF16Range(data.text,targetRange);
    if (scope === 'selection' && data.text.slice(targetRange.start,targetRange.start+targetRange.length) !== selected.Text) fail('coordinateMismatch','Selection 与 UTF-16 不一致。');
    if (data.text.length > 4000) fail('scopeTooLarge','段落超出检查范围，请选择较短段落。');
    const protection = this.protection(data.range,data.text);
    const fingerprint = await sha256(JSON.stringify([data.text,data.before,data.after,protection]));
    this.assertDocument();
    const sameBlock = [...this.anchors.entries()].filter(([,anchor]) => anchor.range.Start === data.range.Start && anchor.range.End === data.range.End);
    const old = sameBlock.at(-1)?.[1];
    const blockID = old?.snapshot.blockID || uid(), revision = old ? Number(old.snapshot.revision)+(old.fingerprint !== fingerprint ? 1 : 0) : 0;
    const snapshot = await createSnapshot({requestID:uid(),documentSessionID:this.documentSessionID,blockID,revision:String(revision),rawText:data.text,contextBefore:data.before,contextAfter:data.after,targetRange,protectedRanges:protection.ranges,pageIndices:[],scope});
    this.assertDocument();
    // A WPS capture contains one manual paragraph. Retire the previous scope even
    // when native ranges changed length and can no longer identify that paragraph.
    this.anchors.clear();
    this.anchors.set(anchorKey(snapshot),{snapshot,range:data.range.Duplicate,fingerprint});
    return {scope,pageIndices:[],snapshots:[snapshot]};
  }
  fresh(envelope, anchor, write) {
    this.assertDocument(); const {snapshot,issue} = envelope;
    const stored = anchor.range, paragraph = this.document.Range(stored.Start,stored.End).Paragraphs.Item(1), data = this.readParagraph(paragraph);
    if (data.range.Start !== stored.Start || data.range.End !== stored.End || data.text !== snapshot.rawText || data.before !== snapshot.contextBefore || data.after !== snapshot.contextAfter) fail('staleSnapshot','Stale paragraph or context; check again.');
    const range = this.document.Range(data.range.Start+issue.range.start,data.range.Start+issue.range.start+issue.range.length);
    if (range.StoryType !== 1 || range.End-range.Start !== issue.original.length || range.Text !== issue.original) fail('staleSnapshot','Stale minimal range or WPS coordinate mismatch.');
    if (write) {
      const protection = this.protection(data.range,data.text);
      if (!protection.known || protection.ranges.length || snapshot.protectedRanges.some(p => overlaps(p,issue.range))) fail('previewOnly','Fields cannot be safely replaced: preview only.');
      try {
        if (this.document.ReadOnly !== false || this.document.ProtectionType !== -1 || range.ParentContentControl !== null || range.ContentControls?.Count !== 0 || !safeXML(data.range.WordOpenXML) || !safeXML(range.WordOpenXML)) fail('previewOnly','权限或格式无法确认，preview only.');
      } catch (error) {if(error instanceof HostContractError)throw error;fail('previewOnly','权限或格式不可读取，preview only.');}
    }
    // All XML/permission getters ran first. No async gap remains before caller's native text assignment.
    this.assertDocument(); const final = this.readParagraph(paragraph);
    if (final.text !== snapshot.rawText || final.before !== snapshot.contextBefore || final.after !== snapshot.contextAfter || range.Text !== issue.original) fail('staleSnapshot','Stale source at final verification.');
    if(write && (this.document.ReadOnly !== false || this.document.ProtectionType !== -1)) fail('previewOnly','权限发生变化，preview only.');
    return range;
  }
  async verified(envelope,write=false) {
    assertIssueEnvelope(envelope); this.assertDocument();
    const {snapshot,issue} = envelope, anchor = this.anchors.get(anchorKey(snapshot));
    if (!anchor || snapshot.documentSessionID !== this.documentSessionID) fail('staleSnapshot','Stale or altered source anchor.');
    if (write && issue.original === issue.replacement) fail('reviewOnly','Review-only issue: preview and focus.');
    if (write && (/[\u0000-\u001f\u007f]/.test(issue.replacement) || /[\u0000-\u001f\u007f]/.test(issue.original))) fail('invalidReplacement','Replacement cannot add control characters or paragraph boundaries.');
    if (await sha256(snapshot.rawText) !== snapshot.snapshotHash || await sha256(snapshot.contextBefore+'\u0000'+snapshot.contextAfter) !== snapshot.contextHash) fail('staleSnapshot','Stale snapshot hash.');
    if (this.anchors.get(anchorKey(snapshot)) !== anchor) fail('staleSnapshot','Stale event generation.');
    return {anchor,range:this.fresh(envelope,anchor,write)};
  }
  async focusIssue(envelope) {const {anchor} = await this.verified(envelope); this.fresh(envelope,anchor,false).Select();}
  async getIssueActions(envelope) {try{await this.verified(envelope,true);return {canApply:true,reason:''};}catch(error){return {canApply:false,reason:error.message||'仅预览'};}}
  async getIssuePageIndices(_envelope) {return [];}
  async applyIssue(envelope) {
    if (this.applying) fail('staleSnapshot','Another issue is being applied.'); this.applying=true;
    try {const {anchor} = await this.verified(envelope,true); const range = this.fresh(envelope,anchor,true); range.Text=envelope.issue.replacement; this.anchors.clear();}
    finally {this.applying=false;}
  }
  async showIssues(_envelopes) { /* Sidebar owns colors. No persistent typography API is used. */ }
  async clear() { /* No native annotations to remove. */ }
  async watch(onChange) {
    this.assertDocument(); if(this.unsubscribe)await this.unsubscribe();this.callback=onChange;
    const add = (name,callback) => {try{if(typeof this.events?.AddApiEventListener!=='function'||typeof this.events.RemoveApiEventListener!=='function')return;this.events.AddApiEventListener(name,callback);this.registrations.push(name);}catch{/* Explicit manual mode remains in force. */}};
    add('ContentChange',()=>{this.anchors.clear();return this.callback?.({type:'invalidated'});});
    add('WindowSelectionChange',()=>this.callback?.({type:'scopeChanged'}));
    add('DocumentChange',()=>{this.anchors.clear();return this.callback?.({type:'invalidated'});});
    const stop = async()=>{if(this.unsubscribe!==stop)return;this.callback=null;this.unsubscribe=null;const errors=[];for(const name of this.registrations.splice(0)){try{this.events.RemoveApiEventListener(name);}catch(error){errors.push(error);}}if(errors.length)throw new AggregateError(errors,'WPS listener cleanup failed.');};
    this.unsubscribe=stop;return stop;
  }
  async dispose() {if(this.disposed)return;try{await this.unsubscribe?.();}finally{this.anchors.clear();this.callback=null;this.disposed=true;}}
}
export function createWPSHost(options) {return new WPSHostAdapter(options);}
