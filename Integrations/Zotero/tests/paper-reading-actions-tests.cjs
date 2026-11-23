const assert = require('node:assert/strict');
const test = require('node:test');
const {createHmac, randomBytes, randomUUID, webcrypto} = require('node:crypto');
const {Window, Element} = require('./fake-dom.cjs');
const Actions = require('../content/paper-reading-actions.js');
const route = '/askgpt/reading-action', token = 'fixture-' + 't'.repeat(56);

function fixture({text = 'One exact quote on the source page.', holdSave = false} = {}) {
  let now = 1783500000000, reads = 0, lookups = 0, constructed = 0, saved = 0, release;
  const stored = new Map(), timers = new Map(), endpoints = {}, opened = [], navigated = [], positions = [], events = [];
  const win = new Window();
  win.crypto = webcrypto;
  win.setTimeout = (callback, delay) => { const id = randomUUID(); timers.set(id, {callback, at: now + delay}); return id; };
  win.clearTimeout = id => timers.delete(id);
  const pageNode = new Element(win.document, 'div');
  win.document.body.appendChild(pageNode);
  const viewport = {width: 600, height: 800, convertToViewportPoint: (x, y) => [x, 800 - y]};
  const pdf = {numPages: 2}, viewer = {pagesCount: 2, currentPageNumber: 1,
    getPageView: index => index >= 0 && index < 2 ? {div: pageNode, viewport} : null};
  win.PDFViewerApplication = {pdfDocument: pdf, pdfViewer: viewer};
  const chars = [...text].map((c, index) => ({c, rect: [20 + index * 5, 740, 25 + index * 5, 750]}));
  const view = {_iframeWindow: win, _pdfPages: {1: {chars}},
    async navigate(location) { events.push('navigate'); navigated.push(structuredClone(location)); viewer.currentPageNumber = location.pageIndex + 1; },
    navigateToPosition(position, options) {
      positions.push(structuredClone(position));
      this.lastNavigationOptions = options;
    }};
  const attachment = {id: 12, key: 'ATTACH01', libraryID: 1, parentID: 10, deleted: false,
    isAttachment: () => true, isPDFAttachment: () => true};
  const parent = {id: 10, key: 'PARENT01', libraryID: 1, deleted: false,
    isRegularItem: () => true, isEditable: () => true};
  const reader = {itemID: 12, type: 'pdf', _initPromise: Promise.resolve(), _internalReader: {_primaryView: view}};
  const saveGate = holdSave ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  class Note {
    constructor(type) { assert.equal(type, 'note'); constructed++; this.html = ''; }
    setNote(value) { this.html = value; }
    async saveTx() {
      await saveGate;
      saved++;
      this.id = 100 + saved;
      this.key = 'NOTE000' + saved;
      stored.set(this.key, structuredClone({id: this.id, key: this.key, libraryID: this.libraryID,
        parentID: this.parentID, html: this.html}));
      return this.id;
    }
  }
  const Zotero = {Server: {Endpoints: endpoints}, getMainWindow: () => win, Item: Note,
    Items: {async getByLibraryAndKeyAsync(libraryID, key) {
      lookups++; return libraryID === 1 && key === attachment.key ? attachment : null;
    }, async getAsync(id) { return id === parent.id ? parent : null; }},
    Reader: {async open(id) { events.push('open'); opened.push(id); return reader; }, _readers: [reader]},
    Libraries: {get: () => ({editable: true})}, Promise: {delay: async () => {}}};
  const deps = {Zotero, Services: {focus: {activeWindow: win}}, Components: {utils: {cloneInto: structuredClone}},
    now: () => now, readConnection: async () => { reads++; return {token}; },
    revealOriginal: async target => { assert.equal(target, reader); await Promise.resolve(); events.push('revealOriginal'); }};
  const dispose = Actions.register(deps), Endpoint = endpoints[route];
  function request(body, {nonce = randomBytes(16).toString('hex'), timestamp = String(now)} = {}) {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    return {method: 'POST', pathname: route, searchParams: new URLSearchParams(), data,
      headers: {host: '127.0.0.1:23119', 'content-type': 'text/plain; charset=utf-8',
        'content-length': String(Buffer.byteLength(data)), 'x-askgpt-timestamp': timestamp,
        'x-askgpt-nonce': nonce, 'x-askgpt-proof': createHmac('sha256', token)
          .update('askgpt-reading-v1\n' + timestamp + '\n' + nonce + '\n' + data).digest('hex')}};
  }
  return {Zotero, deps, endpoints, dispose, win, pageNode, view, attachment, parent, reader,
    timers, stored, opened, navigated, positions, events, request, release: () => release?.(),
    call: async request => new Endpoint().init(request),
    advance(milliseconds) { now += milliseconds; for (const [id, timer] of timers) if (timer.at <= now) {
      timers.delete(id); timer.callback();
    } },
    get counts() { return {reads, lookups, constructed, saved}; }};
}
const jump = quote => ({action: 'jump', attachmentID: '1:ATTACH01', page: 2, quote});
const note = (sections = {}) => ({action: 'saveNote', attachmentID: '1:ATTACH01', requestID: randomUUID(),
  sections: {findings: '主要发现 <script>alert(1)</script> & 数值 12', design: '研究设计\n配对实验',
    limitations: '局限：样本有限', sources: '原文第 2 页：One exact quote.', ...sections}});
const decoded = response => JSON.parse(response[2]);

test('signed exact source quote navigates only the requested attachment and highlights for three seconds', async () => {
  const f = fixture();
  const response = await f.call(f.request(jump('exact quote')));
  assert.equal(response[0], 200);
  assert.deepEqual(decoded(response), {ok: true, precision: 'quote'});
  assert.deepEqual(f.opened, [12]);
  assert.deepEqual(f.events, ['open', 'revealOriginal', 'navigate'], 'hidden original is revealed before source navigation');
  assert.deepEqual(f.navigated, [{pageIndex: 1}]);
  assert.equal(f.positions[0].pageIndex, 1);
  assert(f.positions[0].rects.every(rect => rect[0] >= 40 && rect[2] <= 95));
  const overlay = f.pageNode.children[0];
  assert(overlay && overlay.children.length > 0);
  assert.match(overlay.children[0].getAttribute('style'), /background/);
  f.advance(2999);
  assert.equal(f.pageNode.children.length, 1);
  f.advance(1);
  assert.equal(f.pageNode.children.length, 0);
  assert.equal(f.counts.constructed, 0, 'jump never creates a persistent annotation or note');
  f.dispose();
});

test('missing, duplicated or changed quotes visibly mark the page without claiming a quote match', async () => {
  for (const [text, quote] of [['exact quote then exact quote', 'exact quote'], ['Different value 13', 'value 12'],
    ['The statistic was x².', 'The statistic was x2.'], ['The statistic was −12.', 'The statistic was 12.'], ['', '']]) {
    const f = fixture({text});
    const response = await f.call(f.request(jump(quote)));
    assert.deepEqual(decoded(response), {ok: true, precision: 'page'});
    assert.deepEqual(f.positions, []);
    assert.equal(f.pageNode.children.length, 1);
    assert.match(f.pageNode.children[0].textContent, /第 2 页/);
    f.dispose();
    assert.equal(f.pageNode.children.length, 0);
  }
});

test('a ligature and a discretionary PDF line-wrap still jump to the exact text', async () => {
  const f = fixture();
  const lines = ['The classiﬁ-', 'cation was verified.'];
  f.view._pdfPages[1].chars = lines.flatMap((line, row) => [...line].map((c, i) => ({
    c, lineBreakAfter: i === line.length - 1,
    rect: [20 + i * 5, 740 - row * 14, 25 + i * 5, 750 - row * 14]
  })));
  const response = await f.call(f.request(jump('The classification was verified.')));
  assert.deepEqual(decoded(response), {ok: true, precision: 'quote'});
  assert.deepEqual(f.positions[0].rects, [[20, 740, 80, 750], [20, 726, 120, 736]]);
  assert.deepEqual(f.view.lastNavigationOptions, {block: 'center', inline: 'nearest', behavior: 'instant'});
  assert.equal(f.pageNode.children[0].children.length, 2);
  f.dispose();
});

test('a native quote click keeps the existing PDF tab even when another instance of the attachment is open', async () => {
  const f = fixture();
  f.reader.tabID = 'kept';
  f.reader._window = f.win;
  f.win.Zotero_Tabs = {selectedID: 'kept'};
  f.Zotero.Reader._readers.unshift({...f.reader, tabID: 'other'});
  f.Zotero.Reader.getByTabID = id => f.Zotero.Reader._readers.find(reader => reader.tabID === id);
  assert.equal(decoded(await f.call(f.request(jump('exact quote')))).precision, 'quote');
  assert.deepEqual(f.opened, [], 'opening the attachment again can focus or select a different tab');
  f.dispose();
});

test('a physical page with a PDF.js viewport that becomes ready after navigation still highlights its quote', async () => {
  const f = fixture();
  const viewer = f.win.PDFViewerApplication.pdfViewer;
  const getPage = viewer.getPageView;
  viewer.getPageView = () => null;
  f.Zotero.Promise.delay = async () => { viewer.getPageView = getPage; };
  const response = await f.call(f.request(jump('exact quote')));
  assert.deepEqual(decoded(response), {ok: true, precision: 'quote'});
  assert.equal(f.pageNode.children.length, 1);
  f.dispose();
});

test('the original document supplies exact glyph geometry if the visible reader cache has no page data', async () => {
  const f = fixture();
  const pdf = f.win.PDFViewerApplication.pdfDocument;
  const chars = f.view._pdfPages[1].chars;
  f.view._pdfPages = {};
  pdf.getPageData = async options => {
    assert.deepEqual(options, {pageIndex: 1});
    return {chars};
  };
  assert.equal(decoded(await f.call(f.request(jump('exact quote')))).precision, 'quote');
  assert.deepEqual(f.positions[0].rects, [[40, 740, 95, 750]]);
  f.dispose();
});

test('leaving the originating reader while glyphs load prevents a late jump or highlight', async () => {
  const f = fixture();
  f.reader.tabID = 'kept';
  f.reader._window = f.win;
  f.win.Zotero_Tabs = {selectedID: 'kept'};
  f.Zotero.Reader.getByTabID = () => f.reader;
  delete f.view._pdfPages[1];
  f.view._ensureBasicPageData = async () => { f.win.Zotero_Tabs.selectedID = 'different-paper'; };
  assert.equal((await f.call(f.request(jump('exact quote'))))[0], 503);
  assert.equal(f.positions.length, 0);
  assert.equal(f.pageNode.children.length, 0);
  f.dispose();
});

test('when matching the whole source fails, a sufficiently long exact sentence has its own highlight', async () => {
  const f = fixture({text: 'The sample description. All paired samples were independently validated.'});
  const response = await f.call(f.request(jump('This heading came from a separate column. All paired samples were independently validated.')));
  assert.equal(response[0], 200);
  assert.equal(decoded(response).precision, 'quote');
  assert(f.positions[0].rects.every(rect => rect[0] >= 140));
  f.dispose();
});

test('a fresh signature authenticates the complete raw UTF-8 body and rejects replay before side effects', async () => {
  const f = fixture({text: '这是原文证据。'}), request = f.request(jump('原文证据'));
  const responses = await Promise.all([f.call(request), f.call(request)]);
  assert.deepEqual(responses.map(value => value[0]).sort(), [200, 409]);
  assert.equal(f.opened.length, 1);
  const changed = f.request(jump('原文证据'));
  changed.data = changed.data.replace('原文证据', '伪造证据');
  assert.equal((await f.call(changed))[0], 403);
  assert.equal(f.opened.length, 1);
  assert(!JSON.stringify(responses).includes(token));
  f.dispose();
});

test('browser, foreign host, malformed and oversized requests never touch library data', async () => {
  const f = fixture();
  const requests = [];
  for (const [header, value] of [['origin', 'null'], ['referer', 'https://example.test/'],
    ['host', 'localhost:23119'], ['authorization', 'Bearer ' + token], ['content-type', 'application/json'],
    ['content-length', '1'], ['x-askgpt-proof', 'f'.repeat(64)], ['sec-fetch-site', 'none']]) {
    const request = f.request(jump('quote')); request.headers[header] = value; requests.push(request);
  }
  const expired = f.request(jump('quote'), {timestamp: '1783499980000'}); requests.push(expired);
  const query = f.request(jump('quote')); query.searchParams.set('extra', 'x'); requests.push(query);
  requests.push(f.request('x'.repeat(128 * 1024 + 1)));
  for (const request of requests) assert.notEqual((await f.call(request))[0], 200);
  assert.equal(f.counts.lookups, 0);
  assert.equal(f.counts.constructed, 0);
  assert.equal(f.opened.length, 0);
  f.dispose();
});

test('strict authenticated schemas reject extra fields, invalid IDs, pages, text and note sections', async () => {
  const f = fixture();
  const invalid = [null, [], {}, {...jump('quote'), filePath: '/private/file'}, {...jump('quote'), page: 0},
    {...jump('quote'), page: 2.1}, {...jump('quote'), page: 2001}, {...jump('quote'), attachmentID: '01:ATTACH01'},
    {...jump('quote'), quote: '字'.repeat(2001)}, {...jump('quote'), quote: '\u0000'},
    {...note(), requestID: 'not-a-uuid'}, {...note(), sections: {findings: 'only one section'}},
    {...note(), sections: {...note().sections, extra: 'x'}}, note({findings: 'x'.repeat(24001)}),
    note({findings: '', design: '', limitations: '', sources: ''})];
  for (const value of invalid) assert.equal((await f.call(f.request(value)))[0], 400);
  assert.equal(f.counts.lookups, 0);
  assert.equal(f.counts.constructed, 0);
  f.dispose();
});

test('saveNote writes an escaped editable child note and reads back all four sections from independent storage', async () => {
  const f = fixture({holdSave: true}), body = note();
  const first = f.call(f.request(body)), second = f.call(f.request(body));
  while (!f.counts.constructed) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.counts.constructed, 1);
  f.release();
  const responses = await Promise.all([first, second]);
  for (const response of responses) { assert.equal(response[0], 200); assert.deepEqual(decoded(response), {ok: true, noteKey: 'NOTE0001'}); }
  const stored = structuredClone(f.stored.get('NOTE0001'));
  assert.equal(stored.parentID, f.parent.id);
  assert.equal(stored.libraryID, f.attachment.libraryID);
  assert.equal(f.counts.saved, 1);
  assert.match(stored.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp;/);
  assert(!stored.html.includes('<script>'));
  const text = stored.html.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]*>/g, '')
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
  for (const value of Object.values(body.sections)) assert(text.includes(value));
  const again = await f.call(f.request(body));
  assert.deepEqual(decoded(again), {ok: true, noteKey: stored.key});
  assert.equal(f.counts.saved, 1);
  const conflict = await f.call(f.request({...body, sections: {...body.sections, findings: 'changed'}}));
  assert.equal(conflict[0], 409);
  assert.equal(f.counts.saved, 1);
  f.dispose();
});

test('invalid attachment, absent or wrong parent and read-only library never create a note', async () => {
  for (const change of [f => { f.attachment.deleted = true; }, f => { f.attachment.parentID = null; },
    f => { f.parent.libraryID = 2; }, f => { f.parent.deleted = true; },
    f => { f.parent.isRegularItem = () => false; }, f => { f.parent.isEditable = () => false; },
    f => { f.Zotero.Libraries.get = () => ({editable: false}); }]) {
    const f = fixture(); change(f);
    assert.notEqual((await f.call(f.request(note())))[0], 200);
    assert.equal(f.counts.constructed, 0);
    assert.equal(f.stored.size, 0);
    f.dispose();
  }
  const f = fixture();
  assert.notEqual((await f.call(f.request({...jump('quote'), page: 3})))[0], 200);
  f.dispose();
});

test('a failed note transaction can retry the same request without retaining a false successful note', async () => {
  const f = fixture(), body = note(), original = f.Zotero.Item.prototype.saveTx;
  let attempts = 0;
  f.Zotero.Item.prototype.saveTx = async function () {
    if (++attempts === 1) throw new Error('Synthetic private storage error');
    return original.call(this);
  };
  const failure = await f.call(f.request(body));
  assert.equal(failure[0], 503);
  assert.equal(f.stored.size, 0);
  assert(!failure[2].includes('Synthetic private storage error'));
  assert.equal((await f.call(f.request(body)))[0], 200);
  assert.equal(f.stored.size, 1);
  assert.equal(f.counts.saved, 1);
  f.dispose();
});

test('closing a reader removes its temporary mark and timer without changing native annotations', async () => {
  const f = fixture();
  await f.call(f.request(jump('exact quote')));
  assert.equal(f.pageNode.children.length, 1);
  f.win.emit('pagehide');
  assert.equal(f.pageNode.children.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.counts.constructed, 0);
  f.dispose();
});

test('disposal cancels pending authenticated work and unregisters only its own endpoint', async () => {
  const f = fixture();
  let release;
  f.deps.readConnection = () => new Promise(resolve => { release = () => resolve({token}); });
  f.dispose();
  const dispose = Actions.register(f.deps), Endpoint = f.endpoints[route];
  const pending = new Endpoint().init(f.request(note()));
  dispose(); release();
  assert.equal((await pending)[0], 503);
  assert.equal(f.counts.constructed, 0);
  assert.equal(f.endpoints[route], undefined);
  const other = function () {};
  f.endpoints[route] = other;
  Actions.register(f.deps)();
  assert.equal(f.endpoints[route], other);
});
