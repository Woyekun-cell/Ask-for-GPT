// Office.js boundary fake: only documented APIs used by the Word adapter.
function createFakeWord(options = {}) {
  const state = { viewport: [1, 2], active: 0, selection: null, viewportReads: 0, panePagesReads: 0, pageRangeLocations: [], bodyLoads:[],paragraphTextLoads:[],paragraphPageReads:[],replacements: [], selected: [], annotations: new Map(), annotationFailure: false, pageFailure: false, handlers: {}, runs: 0, maxRuns: 0, pendingRuns: 0, syncs: 0, xmlReads: 0, tracked: new Set(), ...options };
  let context;
  const collection = (items,kind) => { let loaded=items;const result={ _clientObject:true, context, get items() { for(const item of loaded) if(item._kind==='paragraph') item._sourceParent=result; return loaded; }, load(options) { if(kind==='body'){state.bodyLoads.push(structuredClone(options));if(state.bodyMetadataFailure)throw Object.assign(Error('Body metadata failed'),{code:'NotSupported'});if(typeof options==='object'){const skip=options.skip??options.$skip??0;loaded=items.slice(skip,skip+(options.top??options.$top??items.length));}if(state.invalidateBodyMembersOnReload||state.bodyMemberRangesUnavailable){const generation=state.bodyMemberGeneration=(state.bodyMemberGeneration||0)+1;loaded=loaded.map(p=>{const member=Object.create(p);member.getRange=()=>{if(state.bodyMemberRangesUnavailable)throw Object.assign(Error('Collection member range path unavailable'),{code:'ItemNotFound'});if(generation!==state.bodyMemberGeneration)throw Object.assign(Error('Stale collection member path'),{code:'GeneralException'});return p.getRange();};return member;});}}const select=typeof options==='object'?options.select:options;if(typeof select==='string'&&/(^|[,\/\s])text($|[,\/\s])/.test(select))for(const p of loaded)if(p._kind==='paragraph')state.paragraphTextLoads.push(p.uniqueLocalId);return this; }, track() { state.tracked.add(this); return this; }, untrack() { state.tracked.delete(this); return this; }, getFirst() { return result.items[0]; } }; return result; };
  const xmlEscape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function rangeXML(p, start, end) {
    state.xmlReads++;
    const finish = xml => state.wrapOOXML ? state.wrapOOXML(xml,{start,end,paragraph:p}) : xml.replace(/^(<[^\s>]+)/, '$1 xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"');
    if (p.xml) return finish(p.xml);
    const runs = p.runs || [{start:0,end:p.text.length}];
    const body = runs.filter(run => run.start < end && start < run.end).map(run => {
      const a=Math.max(start,run.start), b=Math.min(end,run.end);
      const boundaries=[a,b,...(p.fieldRanges||[]).flatMap(field=>[field.start,field.start+field.length]).filter(value=>value>a&&value<b)].sort((x,y)=>x-y);
      return boundaries.slice(0,-1).map((left,index)=>{ const right=boundaries[index+1]; const content=`<w:r>${run.properties?`<w:rPr>${run.properties}</w:rPr>`:''}<w:t>${xmlEscape(p.text.slice(left,right))}</w:t></w:r>`; return (p.fieldRanges||[]).some(field=>left>=field.start&&right<=field.start+field.length)?`<w:fldSimple>${content}</w:fldSimple>`:content; }).join('');
    }).join('');
    return finish(`<w:document><w:body><w:p>${body}</w:p></w:body></w:document>`);
  }
  function paragraph(data, index) {
    const p = { _clientObject: true, _kind:'paragraph', ...data, uniqueLocalId: data.id || `p${index}`, isNullObject: false, load(properties) { if (properties === 'uniqueLocalId' && state.identityFailure) throw Error('NotLicensed');if(typeof properties==='string'&&properties.split(',').includes('text'))state.paragraphTextLoads.push(this.uniqueLocalId);return this; }, track() { if(state.strictParentTracking) { state.parentTrackChecks=(state.parentTrackChecks||0)+1; if(!state.tracked.has(this._sourceParent||context.document)) throw Error('Paragraph parent collection or UID document is not tracked'); } state.tracked.add(this); return this; }, untrack() { state.tracked.delete(this); return this; }, context: null };
    p.getRange = () => range(p, 0, p.text.length);
    p.getOoxml = () => ({ value: rangeXML(p, 0, p.text.length) });
    p.getPreviousOrNullObject = () => doc.paragraphs[index - 1] || { isNullObject: true, load() { return this; } };
    p.getNextOrNullObject = () => doc.paragraphs[index + 1] || { isNullObject: true, load() { return this; } };
    p.insertAnnotations = ({ critiques }) => {
      if (state.annotationFailure) throw Object.assign(new Error('ServiceNotAvailable'), { code: 'ServiceNotAvailable' });
      const ids = critiques.map(critique => { const id = `annotation-${state.annotations.size}`; state.annotations.set(id, { p, critique }); return id; });
      return { value: ids };
    };
    return p;
  }
  function range(p, start, end) {
    const r = { _clientObject: true, context, get text() { return p.text.slice(start, end); }, get isEmpty() { return start === end; }, load() { return this; }, track() { return this; }, untrack() { return this; }, paragraphs: collection([p]), contentControls: collection([]), parentContentControlOrNullObject: { isNullObject: !p.parentControl, load() { return this; } }, getOoxml: () => ({value:rangeXML(p,start,end)}), getRange(location) { return location === 'Start' ? range(p,start,start) : location === 'End' ? range(p,end,end) : r; }, expandTo(other) { if (other._p !== p) throw Error('No range union'); return range(p, Math.min(start, other._start), Math.max(end, other._end)); }, insertText(text, location) { if (location !== 'Replace') throw Error('Expected minimal Replace'); state.replacements.push({ id: p.uniqueLocalId, start, end, text }); p.text = p.text.slice(0, start) + text + p.text.slice(end); }, select() { state.selected.push({ id: p.uniqueLocalId, start, end }); }, compareLocationWith(other) { return { value: other._p === p && other._start === start && other._end === end ? 'Equal' : 'Unrelated' }; }, _p: p, _start: start, _end: end };
    Object.defineProperty(r, 'fields', { get() { if(state.fieldsFailure) throw Error('FieldsNotAvailable'); return collection((p.fieldRanges||[]).filter(field=>field.start<end&&start<field.start+field.length).map(field=>({result:range(p,field.start,field.start+field.length)}))); } });
    Object.defineProperty(r, 'pages', { get() { state.paragraphPageReads.push(p.uniqueLocalId);if(state.paragraphPagesFailure)throw Object.assign(Error('Range pages failed'),{code:'NotSupported'});return collection((p.pages || [1]).filter(page => !p.pageSplit || (page === 1 && start < p.pageSplit) || (page === 2 && end > p.pageSplit)).map(page)); } });
    r.search = (text, opts) => { if (text.length > 255) throw Error('Search exceeds Word 255 character limit'); if (!opts.matchCase || opts.matchWildcards) throw Error('Unsafe search options'); const hits = []; let position = start; while ((position = p.text.indexOf(text, position)) !== -1 && position + text.length <= end) { hits.push(range(p, position, position + text.length)); position += text.length || 1; } if (state.mutateOnSearch) { state.mutateOnSearch(); state.mutateOnSearch = null; } return collection(hits); };
    return r;
  }
  function page(index) { return { index, load() { return this; }, getRange(location) { state.pageRangeLocations.push(location); if(state.pageRangeFailure||state.requireExplicitPageRange&&location!=='Whole')throw Object.assign(new Error('Explicit page range required'),{code:'InvalidArgument'}); const items=doc.paragraphs.filter(p => (p.pages || [1]).includes(index)); return { isEmpty:items.length===0, load() { return this; }, paragraphs:collection(items) }; } }; }
  const events = ['onParagraphAdded', 'onParagraphChanged', 'onParagraphDeleted', 'onAnnotationClicked', 'onAnnotationHovered', 'onAnnotationPopupAction'];
  let doc = {};
  function makeDocument(inputs) {
    doc = { _clientObject: true, context, track() { state.tracked.add(this); return this; }, untrack() { state.tracked.delete(this); return this; }, paragraphs: inputs.map(paragraph), changeTrackingMode: 'TrackAll', load() { return this; }, getSelection() { const p = doc.paragraphs[state.active]; return state.selection ? range(p, ...state.selection) : range(p, 0, 0); }, getParagraphByUniqueLocalId(id) { const p = doc.paragraphs.find(p => p.uniqueLocalId === id); if (!p) throw Error('ItemNotFound'); return p; }, getAnnotationById(id) { return { delete() { state.annotations.delete(id); if (state.annotationDeleteFailure) state.syncFailure = true; } }; } };
    for (const name of events) doc[name] = { add(handler) { (state.handlers[name] ||= new Set()).add(handler); return { context, remove() { state.handlers[name].delete(handler); } }; } };
    const navigation=object=>Object.assign(object,{_clientObject:true,context,track(){state.tracked.add(this);return this;},untrack(){state.tracked.delete(this);return this;}});
    doc.activeWindow = navigation({ activePane: navigation({}) });
    doc.body=navigation({paragraphs:collection(doc.paragraphs,'body')});
    Object.defineProperty(doc.activeWindow.activePane, 'pagesEnclosingViewport', { get() { state.viewportReads++; if (state.pageFailure) throw Error('NotSupported'); return collection(state.viewport.map(page)); } });
    Object.defineProperty(doc.activeWindow.activePane, 'pages', { get() { state.panePagesReads++; throw Error('pane.pages is not a viewport'); } });
    context.document = doc;
    doc.paragraphs.forEach(p => { p.context = context; });
  }
  context = { document: null, async sync() { state.syncs++; if (state.syncFailure) { state.syncFailure = false; throw Error('Annotation cleanup failed'); } }, trackedObjects: { add() {}, remove() {} } };
  makeDocument(options.paragraphs || [{ id: 'p1', text: 'The result are clear. ', pages: [1] }, { id: 'p2', text: 'Second page. ', pages: [2] }]);
  const Office = { context: { document: { url: '', mode: options.readOnly ? 'readOnly' : 'readWrite' }, requirements: { isSetSupported(name, version) { const support = options.support || { WordApi: '1.8', WordApiDesktop: '1.2' }; return Number(support[name] || 0) >= Number(version); } } }, async onReady() {}, addin: { onVisibilityModeChanged() {} } };
  const Word = { async run(arg, callback) { if (callback && !(arg?._clientObject === true || (Array.isArray(arg) && arg.every(object => object?._clientObject === true)))) throw Error('Word.run expects ClientObject, not RequestContext'); if (callback) state.boundRuns = (state.boundRuns || 0) + 1; const cb = callback || arg; state.runs++; state.pendingRuns++; state.maxRuns = Math.max(state.maxRuns, state.pendingRuns); try { return await cb(context); } finally { state.pendingRuns--; } } };
  return { Word, Office, XMLParser:require('./word-xml-dom.cjs').XMLParser, state, get document() { return doc; }, switchDocument(paragraphs) { Office.context.document = { url: '' }; makeDocument(paragraphs); }, async emit(name, args = {}) { for (const h of [...state.handlers[name] || []]) await h(args); } };
}
module.exports = { createFakeWord };
