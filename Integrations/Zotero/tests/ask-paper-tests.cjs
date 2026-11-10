const assert = require('node:assert/strict');
const test = require('node:test');
const AskPaper = require('../content/ask-paper.js');

function fixture({pageCount = 3, currentPage = 2, readPage = index => 'Paper page ' + (index + 1), reply} = {}) {
  const requests = [], reads = [];
  let active = true, probes = 0;
  const item = {id: 12, libraryID: 1, key: 'ATTACH01', parentID: 7, isAttachment: () => true,
    getField: key => ({title: 'Attachment title'}[key] || '')};
  const parent = {getField: key => ({title: 'Current paper', abstractNote: 'Local abstract', DOI: '10.1234/local'}[key] || '')};
  const pdfDocument = {async getPageData({pageIndex}) {
    reads.push(pageIndex);
    const text = await readPage(pageIndex);
    return {chars: [{c: text}]};
  }};
  const app = {pdfDocument, pdfViewer: {currentPageNumber: currentPage, pagesCount: pageCount}};
  const reader = {type: 'pdf', itemID: item.id, _item: item,
    _internalReader: {_primaryView: {_iframeWindow: {document: {}, PDFViewerApplication: app}}}};
  const connection = {token: 'a'.repeat(64), url: 'http://127.0.0.1:43792/v1/inline/translate'};
  const open = AskPaper.create({
    Zotero: {Items: {get: id => id === 7 ? parent : null}, HTTP: {async request(method, url, options) {
      requests.push({method, url, options});
      return reply ?? {status: 200, responseText: '{"ok":true}'};
    }}},
    readConnection: async () => connection,
    ensureReady: async (value, isCurrent) => { assert.equal(value, connection); assert.equal(isCurrent(), true); probes++; },
    setTimer: setTimeout, clearTimer: clearTimeout
  });
  return {open: options => open(reader, {isActive: () => active, ...options}), requests, reads, item, app,
    stop: () => { active = false; }, get probes() { return probes; }};
}

test('selected passage and source PDF pages use only the authenticated local handoff', async () => {
  const f = fixture();
  await f.open({selection: {text: 'Selected sentence', pageIndex: 1}});
  assert.equal(f.probes, 1);
  assert.deepEqual(f.reads, [1, 0, 2]);
  const [{method, url, options}] = f.requests;
  assert.equal(method, 'POST');
  assert.equal(url, 'http://127.0.0.1:43792/v1/inline/ask-paper');
  assert.equal(options.headers.Authorization, 'Bearer ' + 'a'.repeat(64));
  assert.equal(options.headers.Origin, undefined);
  assert.equal(options.headers['X-AskGPT-Shortcut'], undefined);
  assert.equal(options.followRedirects, false);
  assert.equal(options.debug, false);
  assert.equal(options.logBodyLength, 0);
  assert.deepEqual(JSON.parse(options.body), {
    attachmentID: '1:ATTACH01', title: 'Current paper', abstract: 'Local abstract', doi: '10.1234/local',
    selection: 'Selected sentence', currentPage: 2, pageCount: 3,
    pages: [1, 2, 3].map(number => ({number, text: 'Paper page ' + number})), complete: true
  });
});

test('long documents prioritize nearby pages and never overstate included coverage', async () => {
  const f = fixture({pageCount: 50, currentPage: 30});
  await f.open();
  const payload = JSON.parse(f.requests[0].options.body);
  assert.deepEqual(f.reads.slice(0, 3), [29, 28, 30]);
  assert.equal(payload.currentPage, 30);
  assert.equal(payload.selection, '');
  assert.equal(payload.pages.length, 32);
  assert.equal(payload.complete, false);
  assert.deepEqual(payload.pages.map(page => page.number), payload.pages.map(page => page.number).sort((a, b) => a - b));
  assert(payload.pages.some(page => page.number === 31));
});

test('unicode and JSON escaping cannot exceed local limits or split code points', async () => {
  const f = fixture({readPage: () => '"\\🧬'.repeat(18000)});
  await f.open({selection: {text: '🧬'.repeat(5000), pageIndex: 0, translated: true}});
  const body = f.requests[0].options.body, payload = JSON.parse(body);
  assert(Buffer.byteLength(body) <= 128 * 1024);
  assert(payload.pages.reduce((total, page) => total + Buffer.byteLength(page.text), 0) <= 75000);
  assert(Buffer.byteLength(payload.selection) <= 6000);
  assert(payload.selection.startsWith('[译文选段]'));
  assert(!body.includes('\\ud83e"'));
  assert.equal(payload.complete, false);
  const heavilyEscaped = fixture({readPage: () => '"\\'.repeat(45000)});
  await heavilyEscaped.open();
  const escapedBody = heavilyEscaped.requests[0].options.body;
  assert(Buffer.byteLength(escapedBody) <= 128 * 1024);
  assert(JSON.parse(escapedBody).pages[0].text.length < 75000);
});

test('blank scans or failed pages never claim a complete document', async () => {
  const f = fixture({readPage: index => {
    if (index === 0) throw Error('private PDF worker failure');
    return index === 1 ? '' : 'Paper page 3';
  }});
  await f.open();
  const payload = JSON.parse(f.requests[0].options.body);
  assert.equal(payload.complete, false);
  assert.deepEqual(payload.pages, [{number: 2, text: ''}, {number: 3, text: 'Paper page 3'}]);
});

test('changing the active reader, PDF object or attachment during extraction aborts before POST', async () => {
  for (const change of [f => f.stop(), f => { f.app.pdfDocument = {}; }, f => { f.item.key = 'ATTACH02'; }]) {
    const f = fixture({readPage: () => { change(f); return 'Never submit this text'; }});
    await assert.rejects(f.open(), {code: 'stopped'});
    assert.equal(f.requests.length, 0);
  }
});

test('PDF.js fallback retains text when native structured extraction is unavailable', async () => {
  const f = fixture({pageCount: 1, currentPage: 1});
  f.app.pdfDocument.getPageData = undefined;
  f.app.pdfDocument.getPage = async number => {
    assert.equal(number, 1);
    return {getTextContent: async () => ({items: [{str: 'PDF.js text'}]})};
  };
  await f.open();
  const payload = JSON.parse(f.requests[0].options.body);
  assert.deepEqual(payload.pages, [{number: 1, text: 'PDF.js text'}]);
  assert.equal(payload.complete, true);
});

test('old bridge and malformed acknowledgements produce fixed errors without retry', async () => {
  const old = fixture({reply: {status: 404, responseText: 'Private route detail'}});
  await assert.rejects(old.open(), {code: 'update_app'});
  assert.equal(old.requests.length, 1);
  const malformed = fixture({reply: {status: 200, responseText: '{"ok":true,"secret":"private"}'}});
  await assert.rejects(malformed.open(), {code: 'response'});
  assert.equal(malformed.requests.length, 1);
});
