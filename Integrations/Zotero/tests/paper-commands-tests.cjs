'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Commands = require('../content/paper-commands.js');

const mainQuote = 'A verified original sentence shows a precise result.';
function glyphs(text) {
  return Array.from(text, (c, i) => ({c, rect: [i * 6, 100, i * 6 + 6, 110]}));
}

function fixture({pageText = mainQuote, otherText = 'Another cited sentence on a second page.'} = {}) {
  let active = true, failType = '', next = 20;
  let started = 0, rolledBack = 0, notified = 0;
  const items = new Map();
  const persisted = new Map();
  const navigation = [], openedNotes = [], unpainted = [];
  class Item {
    constructor(type) { this.type = type; this.tags = []; }
    isEditable() { return this.editable !== false; }
    isAnnotation() { return this.type === 'annotation'; }
    isNote() { return this.type === 'note'; }
    setNote(value) { this.html = value; }
    getNote() { return this.html; }
    getNoteTitle() { return this.html?.match(/<p>([^<]*)/)?.[1] || ''; }
    getTags() { return this.tags; }
    async reload() { Object.assign(this, persisted.get(this.id)); }
    async save(options) {
      assert.equal(options.skipSelect, true);
      if (this.type === failType) throw Error('fixture forced write failure');
      this.id ||= next++;
      this.key ||= String(this.id).padStart(8, 'A');
      this.dateModified = Number(this.dateModified || 0) + 1;
      if (this.type === 'note' && !this.html.startsWith('<div class="zotero-note znv1">')) {
        this.html = '<div class="zotero-note znv1">' + this.html + '</div>';
      }
      items.set(this.id, this);
      persisted.set(this.id, {...this});
      options.notifierQueue.events.push(this.id);
      return this.id;
    }
  }
  const attachment = {
    id: 1, key: 'ATTACH01', libraryID: 1, parentID: 2, isAttachment: () => true, isPDFAttachment: () => true,
    isEditable() { return this.editable !== false; },
    getAnnotations: () => [...items.values()].filter(value => value.parentID === 1 && !value.deleted),
  };
  const parent = {
    id: 2, key: 'PARENT01', libraryID: 1, isRegularItem: () => true, isEditable: () => true,
    getNotes: () => [...items.values()].filter(value => value.isNote?.() && value.parentID === 2 && !value.deleted).map(value => value.id),
  };
  items.set(1, attachment); items.set(2, parent);
  const pdf = {numPages: 2};
  const view = {
    _iframeWindow: {PDFViewerApplication: {pdfDocument: pdf, pdfViewer: {pagesCount: 2}}},
    _pdfPages: [{chars: glyphs(pageText)}, {chars: glyphs(otherText)}],
    _getPageLabel: index => String(index + 101),
    navigateToPosition(position, options) { navigation.push({position, options}); },
  };
  const reader = {itemID: 1, type: 'pdf', _internalReader: {_primaryView: view},
    async unsetAnnotations(keys) { unpainted.push(...keys); },
    _window: {ZoteroPane: {openNote: (id, options) => openedNotes.push({id, options})}}};
  const Zotero = {
    Item, Items: {get: id => items.get(id), getByLibraryAndKey: (libraryID, key) =>
      [...items.values()].find(value => value.libraryID === libraryID && value.key === key)},
    Libraries: {get: () => ({editable: true})},
    DB: {async executeTransaction(action) {
      started++;
      const before = new Map(items), savedBefore = new Map(persisted);
      try { return await action(); }
      catch (error) {
        items.clear();
        persisted.clear();
        for (const [id, item] of before) items.set(id, item);
        for (const [id, data] of savedBefore) persisted.set(id, data);
        rolledBack++;
        throw error;
      }
    }},
    Notifier: {Queue: class { constructor() { this.events = []; } },
      async commit(queue) { notified += queue.events.length; }},
  };
  return {Zotero, reader, view, pdf, attachment, parent, items, navigation, openedNotes, unpainted,
    activate: value => { active = value; }, forceFail: value => { failType = value; },
    execute: Commands.create({Zotero, reader, isCurrent: () => active}),
    counts: () => ({started, rolledBack, notified}),
  };
}
const source = (quote = mainQuote, page = 1) => ({quote, page, marker: 'p' + page + '.1', attachmentID: '1:ATTACH01'});

test('a combined chat command saves one Zotero annotation and one source-linked child note without moving the reader', async () => {
  const f = fixture();
  const result = await f.execute.execute([
    {type: 'highlight', target: 'citation', color: '#2ea8e5', comment: 'Check sample size.'}, {type: 'note'},
  ], {citations: [source()], answer: 'The result is supported. [[p1.1]] <svg>'});
  assert.equal(result.highlights, 1);
  assert.equal(result.notes, 1);
  assert.deepEqual(f.counts(), {started: 1, rolledBack: 0, notified: 2});
  const [annotation] = f.attachment.getAnnotations(), note = f.items.get(f.parent.getNotes()[0]);
  assert.equal(annotation.annotationText, mainQuote);
  assert.equal(annotation.annotationComment, 'Check sample size.');
  assert.equal(annotation.annotationColor, '#2ea8e5');
  assert.equal(annotation.annotationPageLabel, '101');
  assert.deepEqual(JSON.parse(annotation.annotationPosition), {pageIndex: 0, rects: [[0, 100, mainQuote.length * 6, 110]]});
  assert.match(note.getNote(), /\[1\] &lt;svg&gt;/);
  assert.match(note.getNote(), /PDF p\. 1/);
  assert.ok(note.getNote().includes(mainQuote));
  assert.deepEqual(f.navigation, []);
  await f.execute.reveal(result.locations[0]);
  assert.deepEqual(f.navigation[0].position, result.locations[0].position);
  f.execute.openNote(result.noteKeys[0]);
  assert.deepEqual(f.openedNotes, [{id: note.id, options: {openInWindow: true}}]);
});

test('multiple citations, duplicated wording and cross-paper citation each leave the library untouched', async () => {
  const f = fixture({pageText: mainQuote + ' ' + mainQuote});
  await assert.rejects(f.execute.execute([{type: 'highlight', target: 'citation'}, {type: 'note', text: 'do not write'}],
    {citations: [source(), source('A second citation.', 2)]}), error => error.code === 'ambiguous' &&
      error.candidates.map(x => x.citation).join() === '1,2');
  await assert.rejects(f.execute.execute([{type: 'highlight', quote: mainQuote}], {page: 1}), {code: 'ambiguous'});
  await assert.rejects(f.execute.execute([{type: 'highlight', citation: 1}], {
    citations: [{...source(), attachmentID: '1:OTHER001'}],
  }), {code: 'missing'});
  assert.deepEqual(f.counts(), {started: 0, rolledBack: 0, notified: 0});
});

test('explicit quote from a cached different page locates and saves its whole native sentence, never a fragment', async () => {
  const exact = 'An exact sentence located on the second source page.';
  const f = fixture({otherText: exact});
  const output = await f.execute.execute([{type: 'highlight', quote: exact}],
    {page: 1, pages: [{number: 2, text: exact}]});
  assert.equal(output.locations[0].page, 2);
  await assert.rejects(f.execute.execute([{type: 'highlight', quote: exact + ' Additional fabricated text.'}],
    {page: 2}), {code: 'missing'});
  assert.equal(f.attachment.getAnnotations().length, 1);
});

test('native selection geometry can pinpoint one instance of repeating wording', async () => {
  const f = fixture({pageText: mainQuote + ' ' + mainQuote});
  const secondRect = [[(mainQuote.length + 1) * 6, 100, (mainQuote.length * 2 + 1) * 6, 110]];
  const result = await f.execute.execute([{type: 'highlight', target: 'selection'}], {
    selectedText: mainQuote, page: 1, selectedPosition: {pageIndex: 0, rects: secondRect},
  });
  assert.deepEqual(result.locations[0].position.rects, secondRect);
});

test('repeat skips duplicates and recolor plus undo only touch command-owned unmodified records', async () => {
  const f = fixture(), operations = [{type: 'highlight', citation: 1}, {type: 'note', text: 'My explicit note <tag>'}];
  const context = {citations: [source()]};
  assert.equal((await f.execute.execute(operations, context)).highlights, 1);
  assert.equal((await f.execute.execute(operations, context)).skipped, 2);
  const [annotation] = f.attachment.getAnnotations(), note = f.items.get(f.parent.getNotes()[0]);
  assert.match(note.getNote(), /&lt;tag&gt;/);
  assert.equal((await f.execute.execute([{type: 'recolor', color: '#2ea8e5'}])).updated, 1);
  assert.equal(annotation.annotationColor, '#2ea8e5');
  assert.equal((await f.execute.execute([{type: 'undo'}])).undone, 1);
  assert.equal(annotation.annotationColor, '#ffd400');
  note.setNote('User edited the note after saving.');
  const result = await f.execute.execute([{type: 'undo'}]);
  assert.equal(result.undone, 1);
  assert.equal(result.skipped, 1);
  assert.equal(annotation.deleted, true);
  assert.deepEqual(f.unpainted, [annotation.key]);
  assert.equal(note.deleted, undefined);
  assert.equal(note.getNote(), 'User edited the note after saving.');
});

test('read-only items and changed tabs prevent writes, and a failed second write rolls back the first', async () => {
  const f = fixture();
  const operations = [{type: 'highlight', citation: 1}, {type: 'note', text: 'Record two'}];
  const context = {citations: [source()]};
  f.attachment.editable = false;
  await assert.rejects(f.execute.execute(operations, context), {code: 'readonly'});
  f.attachment.editable = true;
  f.activate(false);
  await assert.rejects(f.execute.execute(operations, context), {code: 'stale'});
  f.activate(true);
  f.forceFail('note');
  await assert.rejects(f.execute.execute(operations, context), {code: 'failed'});
  assert.deepEqual(f.counts(), {started: 1, rolledBack: 1, notified: 0});
  assert.equal(f.items.size, 2);
});

test('no native UI or database operation occurs when the user changes tabs during cold page extraction', async () => {
  const f = fixture();
  f.view._pdfPages = [];
  f.pdf.getPageData = async () => {
    f.activate(false);
    return {chars: glyphs(mainQuote)};
  };
  await assert.rejects(f.execute.execute([{type: 'highlight', quote: mainQuote}], {page: 1}), {code: 'stale'});
  assert.deepEqual(f.counts(), {started: 0, rolledBack: 0, notified: 0});
  assert.deepEqual(f.navigation, []);
});

test('a distinct requested comment adds a native mark without replacing an existing manual mark', async () => {
  const f = fixture(), context = {page: 1};
  await f.execute.execute([{type: 'highlight', quote: mainQuote}], context);
  const [existing] = f.attachment.getAnnotations();
  existing.annotationComment = 'My manual comment';
  const add = [{type: 'highlight', quote: mainQuote, comment: 'New requested comment'}];
  const result = await f.execute.execute(add, context);
  assert.equal(result.highlights, 1);
  assert.equal(existing.annotationComment, 'My manual comment');
  assert.equal((await f.execute.execute(add, context)).skipped, 1);
});

test('an unread candidate leaves uniqueness unresolved', async () => {
  const f = fixture();
  f.view._pdfPages[1] = undefined;
  await assert.rejects(f.execute.execute([{type: 'highlight', quote: mainQuote}], {
    page: 1, pages: [{number: 2, text: mainQuote}],
  }), {code: 'ambiguous'});
  assert.deepEqual(f.counts(), {started: 0, rolledBack: 0, notified: 0});
});

test('a unique exact publisher bookmark selects the article title over its duplicate on the cover', async () => {
  const title = 'A ligand-receptor interactome atlas of the zebrafish';
  const f = fixture({pageText: title, otherText: title.replace('fish', 'ﬁsh')});
  f.parent.getField = field => field === 'title' ? title : '';
  f.pdf.getOutline = async () => [{title, dest: 'article-start', items: [{title: 'Introduction', dest: [1]}]}];
  const ref = {num: 41, gen: 0};
  f.pdf.getDestination = async name => {
    assert.equal(name, 'article-start');
    return [ref, {name: 'XYZ'}, 57, 665, null];
  };
  f.pdf.getPageIndex = async target => {
    assert.equal(target, ref);
    return 1;
  };
  const result = await f.execute.execute([{type: 'paperTitle'}], {page: 1});
  assert.equal(result.highlights, 1);
  assert.equal(result.locations[0].page, 2);
  const [mark] = f.attachment.getAnnotations();
  assert.equal(mark.annotationText, title);
  assert.equal(mark.annotationPageLabel, '102');
  assert.equal(JSON.parse(mark.annotationPosition).pageIndex, 1);
});

test('duplicate title text stays unmarked when no unique exact bookmark resolves it', async () => {
  const f = fixture({otherText: mainQuote});
  f.parent.getField = () => mainQuote;
  f.pdf.getOutline = async () => [{title: 'Contents', items: [{title: mainQuote, dest: [1]}]}];
  await assert.rejects(f.execute.execute([{type: 'paperTitle'}], {page: 1}), {code: 'paper-title-missing'});
  f.pdf.getOutline = async () => [{title: mainQuote, dest: [0]}, {title: mainQuote, dest: [1]}];
  await assert.rejects(f.execute.execute([{type: 'paperTitle'}]), {code: 'paper-title-missing'});
  assert.equal(f.attachment.getAnnotations().length, 0);
});

test('an outline destination needs a unique exact native title and will not silently pick the cover', async () => {
  const f = fixture();
  f.parent.getField = () => mainQuote;
  f.pdf.getOutline = async () => [{title: mainQuote, dest: [1]}];
  await assert.rejects(f.execute.execute([{type: 'paperTitle'}]), {code: 'paper-title-missing'});
  f.view._pdfPages[1] = {chars: glyphs(mainQuote + ' ' + mainQuote)};
  await assert.rejects(f.execute.execute([{type: 'paperTitle'}]), {code: 'paper-title-missing'});
  f.view._pdfPages[1] = undefined;
  await assert.rejects(f.execute.execute([{type: 'paperTitle'}]), {code: 'paper-text-unread'});
  assert.equal(f.attachment.getAnnotations().length, 0);
});

test('native underline can coexist with a highlight at the same location and undo removes only the underline', async () => {
  const f = fixture(), context = {page: 1, selectedText: mainQuote};
  await f.execute.execute([{type: 'highlight', target: 'selection'}], context);
  const underline = [{type: 'highlight', mark: 'underline', target: 'selection', color: '#2ea8e5'}];
  const result = await f.execute.execute(underline, context);
  assert.equal(result.underlines, 1);
  assert.equal(result.highlights, 0);
  const [highlight, line] = f.attachment.getAnnotations();
  assert.equal(line.annotationType, 'underline');
  assert.equal(line.annotationText, mainQuote);
  assert.equal(line.annotationColor, '#2ea8e5');
  assert.equal(line.annotationPosition, highlight.annotationPosition);
  assert.equal((await f.execute.execute(underline, context)).skipped, 1);
  assert.equal((await f.execute.execute([{type: 'undo'}])).undone, 1);
  assert.deepEqual(f.attachment.getAnnotations(), [highlight]);
  assert.deepEqual(f.unpainted, [line.key]);
});

test('a comment on the verified abstract fills an empty native mark and undo restores that mark', async () => {
  const f = fixture();
  f.parent.getField = field => field === 'abstractNote' ? mainQuote : '';
  await f.execute.execute([{type: 'paperAbstract'}]);
  const [annotation] = f.attachment.getAnnotations();
  const operation = {type: 'paperAbstract', comment: '1. Study design\n2. Main findings'};
  const result = await f.execute.execute([operation]);
  assert.equal(result.comments, 1);
  assert.equal(result.highlights, 0);
  assert.equal(result.locations[0].quote, mainQuote);
  assert.deepEqual(f.attachment.getAnnotations(), [annotation]);
  assert.equal(annotation.annotationComment, operation.comment);
  assert.equal((await f.execute.execute([operation])).skipped, 1);
  await f.execute.execute([{type: 'undo'}]);
  assert.equal(annotation.annotationComment, '');
  assert.equal(annotation.deleted, undefined);
  assert.equal((await f.execute.execute([{type: 'undo'}])).undone, 1);
  assert.equal(annotation.deleted, true);
});

test('a mark and saved comment created in the same batch undo as one native annotation', async () => {
  const f = fixture();
  const selection = {type: 'highlight', target: 'selection'};
  const result = await f.execute.execute([selection, {...selection, comment: 'Read alongside Figure 1.'}],
    {page: 1, selectedText: mainQuote});
  assert.equal(result.highlights, 1);
  assert.equal(result.comments, 1);
  assert.equal(result.locations.length, 1);
  assert.equal(f.attachment.getAnnotations().length, 1);
  assert.equal((await f.execute.execute([{type: 'undo'}])).undone, 1);
  assert.deepEqual(f.attachment.getAnnotations(), []);
});

test('child notes honor explicit answer, abstract and selection sources including translated excerpts', async () => {
  const f = fixture();
  f.parent.getField = field => field === 'abstractNote' ? 'The paper abstract.' : '';
  const result = await f.execute.execute([
    {type: 'note', target: 'selection'}, {type: 'note', target: 'abstract'}, {type: 'note', target: 'answer'},
  ], {noteSelection: '选择的译文', answer: 'Prior answer. [[p1.1]]', citations: [source()]});
  const [selection, abstract, answer] = f.parent.getNotes().map(id => f.items.get(id));
  assert.equal(result.notes, 3);
  assert.match(selection.getNote(), /<p>选择的译文<\/p>/);
  assert.match(abstract.getNote(), /<p>The paper abstract\.<\/p>/);
  assert.doesNotMatch(selection.getNote() + abstract.getNote(), /Sources|Prior answer/);
  assert.match(answer.getNote(), /Prior answer\.  \[1\]/);
  assert.match(answer.getNote(), /Sources/);
  await assert.rejects(f.execute.execute([{type: 'note', target: 'selection'}], {answer: 'Do not substitute this.'}),
    {code: 'missing'});
});

test('explicit note edit stays with the uniquely named child and undo restores its exact original HTML', async () => {
  const f = fixture();
  const note = new f.Zotero.Item('note');
  note.libraryID = 1;
  note.parentID = f.parent.id;
  const original = '<div class="zotero-note znv1"><p>Titled note</p><p><strong>Keep original HTML</strong></p></div>';
  note.setNote(original);
  await note.save({skipSelect: true, notifierQueue: {events: []}});
  const append = {type: 'noteAppend', title: 'Titled note', text: 'A safe <tag>.'};
  assert.equal((await f.execute.execute([append])).updatedNotes, 1);
  assert.match(note.getNote(), /<strong>Keep original HTML<\/strong><\/p><p>A safe &lt;tag&gt;\.<\/p><\/div>$/);
  assert.equal((await f.execute.execute([append])).skipped, 1);
  const appended = note.getNote();
  const replace = await f.execute.execute([{type: 'noteReplace', title: 'Titled note', text: 'Replacement.'}]);
  assert.equal(replace.updatedNotes, 1);
  assert.deepEqual(replace.noteKeys, [note.key]);
  assert.equal(note.getNote(), '<div class="zotero-note znv1"><p>Replacement.</p></div>');
  await f.execute.execute([{type: 'undo'}]);
  assert.equal(note.getNote(), appended);
  await f.execute.execute([{type: 'undo'}]);
  assert.equal(note.getNote(), original);
  assert.equal(note.deleted, undefined);
});

test('unnamed note edits target only the last unmodified Ask GPT-created note', async () => {
  const f = fixture();
  await f.execute.execute([{type: 'note', text: 'First note'}, {type: 'note', text: 'Second note'}]);
  const [first, second] = f.parent.getNotes().map(id => f.items.get(id));
  const edit = await f.execute.execute([{type: 'noteAppend', text: 'Follow-up'}]);
  assert.deepEqual(edit.noteKeys, [second.key]);
  assert.doesNotMatch(first.getNote(), /Follow-up/);
  assert.match(second.getNote(), /Follow-up/);
  second.setNote('<p>User edited</p>');
  await assert.rejects(f.execute.execute([{type: 'noteAppend', text: 'Do not overwrite'}]), {code: 'missing-note'});
  assert.equal((await f.execute.execute([{type: 'undo'}])).skipped, 1);
  assert.equal(second.getNote(), '<p>User edited</p>');
});

test('child notes remain writable when the attached file is read only but the item metadata is editable', async () => {
  const f = fixture();
  f.attachment.editable = false;
  assert.equal((await f.execute.execute([{type: 'note', text: 'An independent note.'}])).notes, 1);
  assert.equal((await f.execute.execute([{type: 'noteAppend', text: 'Follow-up.'}])).updatedNotes, 1);
  await assert.rejects(f.execute.execute([{type: 'highlight', quote: mainQuote}], {page: 1}), {code: 'readonly'});
  assert.equal((await f.execute.execute([{type: 'undo'}])).undone, 1);
  assert.equal(f.parent.getNotes().length, 1);
});

test('ambiguous or read-only notes cannot be edited and a failed edit restores the cached note', async () => {
  const f = fixture();
  await f.execute.execute([{type: 'note', text: 'Repeated title\nFirst'}, {type: 'note', text: 'Repeated title\nSecond'}]);
  const append = {type: 'noteAppend', title: 'Repeated title', text: 'Proposed text'};
  await assert.rejects(f.execute.execute([append]), {code: 'ambiguous-note'});
  const [first, second] = f.parent.getNotes().map(id => f.items.get(id));
  second.parentID = 999;
  first.editable = false;
  await assert.rejects(f.execute.execute([append]), {code: 'readonly'});
  first.editable = true;
  const original = first.getNote();
  f.forceFail('note');
  await assert.rejects(f.execute.execute([append]), {code: 'failed'});
  assert.equal(first.getNote(), original);
  assert.equal(second.getNote(), '<div class="zotero-note znv1"><p>Repeated title<br>Second</p></div>');
});
