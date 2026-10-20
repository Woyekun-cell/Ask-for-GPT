// Synchronous WPS JS API boundary double. Native coordinate/undo fidelity needs Mac verification.
function createFakeWPS(options = {}) {
  const state = { paragraphs: options.paragraphs || ['The result are clear.\r', 'More evidence.\r'], selection: options.selection || [0, 0], active: options.active || 0, replacements: [], selected: [], listeners: new Map(), rangeReads: 0, styleWrites: 0, panes: [] };
  const count = value => ({Count: value});
  const xmlText = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  const startAt = index => state.paragraphs.slice(0, index).reduce((n, text) => n + text.length, 0);
  const indexAt = offset => { let i = 0; while (i + 1 < state.paragraphs.length && startAt(i + 1) <= offset) i++; return i; };
  function paragraph(index) {
    return {get Range() {return range(startAt(index), startAt(index) + state.paragraphs[index].length);}, Previous() {return index ? paragraph(index - 1) : null;}, Next() {return index + 1 < state.paragraphs.length ? paragraph(index + 1) : null;}};
  }
  function range(start, end) {
    return {
      get Start() {return start;}, get End() {return end;}, get StoryType() {return options.storyType ?? 1;},
      get Text() {return state.paragraphs.join('').slice(start, end);},
      set Text(value) {const i = indexAt(start), local = start - startAt(i); state.replacements.push({start, end, text: value}); state.paragraphs[i] = state.paragraphs[i].slice(0, local) + value + state.paragraphs[i].slice(local + end - start); end = start + value.length;},
      get Duplicate() {return range(start, end);},
      get Paragraphs() {const first = indexAt(start), last = indexAt(Math.max(start, end - 1)); return {Count: last - first + 1, Item(n) {return paragraph(first + n - 1);}};},
      get Fields() {if (options.fieldsUnknown) throw new Error('Fields unavailable'); const fields = options.fields || []; return {Count: fields.length, Item(n) {const f = fields[n - 1]; return {Result: range(f.start, f.start + f.length)};}};},
      get ParentContentControl() {return options.parentControl ? {LockContents: true} : null;},
      get ContentControls() {return count(options.controls || 0);},
      get WordOpenXML() {state.onXML?.(); return options.xml === undefined ? `<w:p><w:r><w:t>${xmlText(this.Text)}</w:t></w:r></w:p>` : options.xml;},
      get Font() {return new Proxy({}, {set() {state.styleWrites++; throw new Error('Persistent font write forbidden');}});},
      set HighlightColorIndex(_) {state.styleWrites++; throw new Error('Persistent highlight forbidden');},
      Select() {state.selected.push({start, end});}
    };
  }
  const document = {Name: 'Synthetic.docx', FullName: '', ReadOnly: options.readOnly ?? false, ProtectionType: options.protectionType ?? -1, TrackRevisions: true,
    Range(start, end) {state.rangeReads++; state.onRange?.(); return range(start, end);},
    get Content() {return range(0, state.paragraphs.join('').length);}, get Paragraphs() {return {Count: state.paragraphs.length, Item: n => paragraph(n - 1)};}
  };
  const Application = {ActiveDocument: document,
    get Selection() {const offset = startAt(state.active); return {Range: range(offset + state.selection[0], offset + state.selection[1])};},
    ApiEvent: {AddApiEventListener(name, callback) {if (options.missingContentChange && name === 'ContentChange') throw new Error('ContentChange unsupported'); state.listeners.set(name, callback);}, RemoveApiEventListener(name) {state.listeners.delete(name);}},
    CreateTaskPane(url, title) {const pane = {URL: url, Title: title, Visible: false}; state.panes.push(pane); return pane;}
  };
  return {Application, document, state, async emit(name) {return state.listeners.get(name)?.();}, switchDocument() {Application.ActiveDocument = {...document};}};
}
module.exports = {createFakeWPS};
