'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const browser = path.resolve(__dirname, '..');
const extensionID = 'ofcbkomnacejiphoifjmkmkpjcjddmfj';
const SECRET = 'synthetic_pdf_test_token_12345678901234567890';
const PDF = '%PDF-1.7\nfixture binary PDF bytes\n%%EOF';
const ID1 = 'a'.repeat(32), ID2 = 'b'.repeat(32);
function load() {
  const context = vm.createContext({ URL, Blob, Uint8Array, AbortController, crypto: crypto.webcrypto, setTimeout, clearTimeout });
  for (const name of ['pdf-core.js', 'pdf-worker.js']) vm.runInContext(fs.readFileSync(path.join(browser, name), 'utf8'), context, { filename: name });
  return context;
}
class MemoryCache {
  values = new Map();
  async get(id) { return structuredClone(this.values.get(id)); }
  async all() { return [...this.values.values()].map(value => structuredClone(value)); }
  async put(record) { this.values.set(record.id, structuredClone(record)); }
  async remove(id) { this.values.delete(id); }
  async prune() {}
}
function harness() {
  const context = load(), calls = [], session = {}, updates = [], permissionRequests = [], cache = new MemoryCache();
  const tab = { id: 17, active: true, url: 'https://fixture.test/paper.pdf#page=3', title: '<script>Paper</script>' };
  const tabs = new Map([[tab.id, tab]]);
  let allowedFile = true, grantedFile = true, fetchOverride;
  const chrome = {
    runtime: { id: extensionID, getURL: name => 'chrome-extension://' + extensionID + '/' + name },
    storage: { session: {
      async get(key) { return { [key]: structuredClone(session[key]) }; },
      async set(value) { Object.assign(session, structuredClone(value)); },
      async remove(key) { delete session[key]; }
    } },
    tabs: { async get(id) { if (!tabs.has(id)) throw new Error('No such tab'); return { ...tabs.get(id) }; },
      async update(id, value) { updates.push({ id, ...value }); Object.assign(tabs.get(id), value); } },
    permissions: { async contains() { return grantedFile; }, request(options) { permissionRequests.push(options); return Promise.resolve(grantedFile); } },
    extension: { async isAllowedFileSchemeAccess() { return allowedFile; } }
  };
  async function fetch(url, options = {}) {
    calls.push({ url, options });
    if (fetchOverride) { const output = await fetchOverride(url, options); if (output) return output; }
    if (url.startsWith('https://fixture.test/') || url.startsWith('file:')) return new Response(PDF, { headers: { 'Content-Type': 'application/pdf' } });
    if (url.endsWith('.pdf')) return new Response(PDF);
    const status = { id: ID1, pageCount: 12, sourcePages: [2], state: options.method === 'POST' ? 'running' : 'complete' };
    return new Response(JSON.stringify(status), { status: options.method === 'POST' ? 202 : 200 });
  }
  const worker = context.AskGPTPDFWorker.install({ chrome, fetch, config: async () => ({ token: SECRET }), cache });
  function sender(overrides = {}) { return { id: extensionID, tab: { id: tab.id }, frameId: 0, url: tab.url, ...overrides }; }
  function request(action, extra = {}, override = {}) {
    const current = tabs.get(override.tab?.id ?? tab.id);
    const doc = new URL(current.url).searchParams.get('doc');
    return worker.message({ type: 'PDF_READER', doc, action, ...extra }, sender({ url: current.url, ...override }));
  }
  return { context, worker, cache, calls, updates, tab, tabs, session, sender, request, permissionRequests,
    setFetch(value) { fetchOverride = value; }, setFile(granted, allowed) { grantedFile = granted; allowedFile = allowed; } };
}
test('source and viewer guards reject remote file hosts, credentials, schemes, and extra query access', () => {
  const core = load().AskGPTPDF;
  for (const value of ['javascript:alert(1)', 'chrome://settings', 'file://remote-server/paper.pdf', 'https://a:b@fixture.test/p.pdf']) assert.equal(core.sourceURL(value), null);
  assert.equal(core.pageFromURL('https://fixture.test/paper.pdf#page=19&zoom=100'), 19);
  assert.equal(core.pageFromURL('https://fixture.test/paper.pdf#page=0'), null);
  assert.equal(core.pageFromURL('https://fixture.test/paper.pdf'), null);
  const getURL = name => 'chrome-extension://' + extensionID + '/' + name;
  const viewer = core.viewerURL(getURL, ID1);
  assert(core.isViewerURL(viewer, getURL, ID1));
  for (const value of [viewer + '&url=https://attacker.test', viewer + '#fragment', viewer.replace(extensionID, 'another')]) assert(!core.isViewerURL(value, getURL, ID1));
});
test('PDF progress accepts only bounded stage data and exact selected-page counts', () => {
  const core = load().AskGPTPDF;
  for (const value of [{ stage: 'preparing' }, { stage: 'layout' },
    { stage: 'translating', completed: 0, total: 3 }, { stage: 'translating', completed: 3, total: 3 }]) {
    assert.deepEqual(JSON.parse(JSON.stringify(core.safeProgress(value, 3))), value);
    assert.notEqual(core.safeProgress(value, 3), value, 'metadata must contain a sanitized copy');
  }
  for (const value of [null, [], 'preparing', { stage: 'waiting' }, { stage: 'layout', completed: 1, total: 3 },
    { stage: 'preparing', text: SECRET }, { stage: 'translating', completed: -1, total: 3 },
    { stage: 'translating', completed: 4, total: 3 }, { stage: 'translating', completed: 1.5, total: 3 },
    { stage: 'translating', completed: 1, total: 2 }, { stage: 'translating', completed: 0, total: 0 },
    { stage: 'translating', completed: 0, total: 2001 }, { stage: 'translating', completed: 1, total: 3, token: SECRET }]) {
    assert.equal(core.safeProgress(value, 3), undefined);
  }
});
test('PDF_READER start, status and restored info expose only running validated progress', async () => {
  const h = harness(); await h.worker.open({ ...h.tab });
  const value = { id: ID1, state: 'running', pageCount: 12, sourcePages: [0, 1, 2], progress: { stage: 'preparing' } };
  h.setFetch(async (url, options) => url.includes('/v1/pdf/jobs') && options.method !== 'DELETE' ? new Response(JSON.stringify(value)) : undefined);
  const started = await h.request('start', { page: 3, whole: true, source: 'en', target: 'zh-Hans' });
  assert.deepEqual(JSON.parse(JSON.stringify(started.progress)), { stage: 'preparing' });
  for (const progress of [{ stage: 'translating', completed: 1, total: 3 }, { stage: 'layout' }]) {
    value.progress = progress;
    assert.deepEqual(JSON.parse(JSON.stringify((await h.request('status')).progress)), progress);
    assert.deepEqual(JSON.parse(JSON.stringify((await h.request('info')).progress)), progress);
  }
  for (const progress of [{ stage: 'translating', completed: 2, total: 12 }, { stage: 'preparing', text: SECRET }]) {
    value.progress = progress;
    const response = await h.request('status');
    assert.equal(response.ok, true); assert.equal(response.progress, undefined);
    assert.equal((await h.request('info')).progress, undefined);
    assert(!JSON.stringify(response).includes(SECRET));
  }
  value.state = 'complete'; value.progress = { stage: 'translating', completed: 3, total: 3 };
  assert.equal((await h.request('status')).progress, undefined);
  assert.equal((await h.request('info')).progress, undefined);
  const record = await h.cache.get(started.id);
  record.state = 'running'; record.progress = { stage: 'translating', completed: 1, total: 3 }; await h.cache.put(record);
  assert.equal((await h.request('cancel')).progress, undefined);
  assert.equal((await h.request('info')).progress, undefined);
});
test('streaming PDF reader checks header and bounds declared and chunked bodies', async () => {
  const core = load().AskGPTPDF;
  const blob = await core.pdfBlob(new Response(PDF), 1000);
  assert.equal(await blob.text(), PDF);
  await assert.rejects(core.pdfBlob(new Response('<html>Not a PDF</html>'), 1000), /PDF_SOURCE/);
  await assert.rejects(core.pdfBlob(new Response(PDF, { headers: { 'Content-Length': '9999' } }), 100), /PDF_TOO_LARGE/);
  await assert.rejects(core.pdfBlob(new Response(PDF), 12), /PDF_TOO_LARGE/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(core.pdfBlob(new Response(PDF), 1000, controller.signal), /CANCELLED/);
});
test('cache retention is bounded by age, count, bytes and preserves current output first', () => {
  const core = load().AskGPTPDF, now = Date.now();
  const records = Array.from({ length: 6 }, (_, i) => ({ id: String(i).repeat(32), updated: now - i, source: { size: 100 }, outputs: {} }));
  let keep = core.retained(records, records[5].id, now);
  assert.equal(keep.size, 4); assert(keep.has(records[5].id)); assert(!keep.has(records[4].id));
  records[5].updated = now - core.MAX_AGE - 1;
  assert(!core.retained(records, records[5].id, now).has(records[5].id));
  const big = [{ id: ID1, updated: now, source: { size: core.MAX_CACHE - 1 }, outputs: {} },
    { id: ID2, updated: now + 1, source: { size: 100 }, outputs: {} }];
  keep = core.retained(big, ID1, now); assert.equal(keep.size, 1); assert(keep.has(ID1));
});
test('action caches only current-tab bytes then changes the same tab to opaque ID; never token/URL query', async () => {
  const h = harness(), original = h.tab.url;
  await h.worker.open({ ...h.tab });
  assert.equal(h.calls[0].url, 'https://fixture.test/paper.pdf');
  assert.equal(h.calls[0].options.credentials, 'include');
  assert.equal(h.calls[0].options.redirect, 'error');
  assert(!h.calls[0].options.headers?.Authorization);
  assert.equal(h.updates.length, 1); assert.equal(h.updates[0].id, 17);
  const url = new URL(h.updates[0].url);
  assert.equal(url.protocol, 'chrome-extension:'); assert.equal(url.pathname, '/pdf-reader.html');
  assert.deepEqual([...url.searchParams.keys()], ['doc']); assert(/^[0-9a-f]{32}$/.test(url.searchParams.get('doc')));
  assert(!JSON.stringify(h.updates).includes(SECRET)); assert(!JSON.stringify(h.updates).includes(original));
  const record = await h.cache.get(url.searchParams.get('doc'));
  assert.equal(await record.source.text(), PDF); assert.equal(record.originalURL, original); assert.equal(record.page, 3);
});
test('current tab identity and actual file scheme permission are required before reading a PDF', async () => {
  const h = harness();
  await assert.rejects(h.worker.open({ ...h.tab, url: 'https://other.test/paper.pdf' }), /INACTIVE/);
  assert.equal(h.calls.length, 0);
  h.tab.url = 'file:///private/fixture.pdf'; h.setFile(true, false);
  await assert.rejects(h.worker.open({ ...h.tab }), /PDF_FILE_ACCESS/); assert.equal(h.calls.length, 0);
  h.setFile(false, true);
  await assert.rejects(h.worker.open({ ...h.tab }), /PDF_FILE_ACCESS/); assert.equal(h.calls.length, 0);
  h.setFile(true, true); await h.worker.open({ ...h.tab }); assert.equal(h.updates.length, 1);
});
test('authorized PDF import continues after a tab switch but inactive initial calls cannot read a source', async () => {
  const h = harness();
  h.tab.active = false;
  await assert.rejects(h.worker.open({ ...h.tab }), /INACTIVE/);
  assert.equal(h.calls.length, 0);
  h.tab.active = true;
  h.setFetch(async url => {
    if (url.startsWith('https://fixture.test/')) { h.tab.active = false; return new Response(PDF); }
  });
  await h.worker.open({ ...h.tab });
  assert.equal(h.updates.length, 1);
  assert.equal((await h.request('info')).ok, true);
});
test('authorized PDF start survives a tab switch while retiring its prior job', async () => {
  const h = harness(); await h.worker.open({ ...h.tab });
  const input = { page: 3, whole: true, source: 'en', target: 'zh-Hans' };
  await h.request('start', input);
  h.setFetch(async (_url, options) => { if (options.method === 'DELETE') { h.tab.active = false; return new Response('{}'); } });
  const started = await h.request('start', input);
  assert.equal(started.ok, true); assert.equal(started.state, 'running');
  const posts = h.calls.filter(call => call.options.method === 'POST').length;
  assert.equal((await h.request('start', input)).code, 'INACTIVE');
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, posts);
  assert.equal((await h.request('status')).state, 'complete');
});
test('two PDF tabs retain independent background jobs and cancelling one leaves the other usable', async () => {
  const h = harness(), second = { id: 18, active: true, url: 'https://fixture.test/second.pdf#page=2', title: 'Second PDF' };
  h.tabs.set(second.id, second);
  await h.worker.open({ ...h.tab });
  const firstDoc = new URL(h.tab.url).searchParams.get('doc');
  const input = { page: 3, whole: true, source: 'en', target: 'zh-Hans' };
  await h.request('start', input); h.tab.active = false;
  await h.worker.open({ ...second });
  h.setFetch(async (_url, options) => options.method === 'POST' ? new Response(JSON.stringify({
    id: ID2, state: 'running', sourcePages: [0, 1], pageCount: 2 }), { status: 202 }) : undefined);
  const other = { tab: { id: second.id } };
  assert.equal((await h.request('start', { ...input, page: 2 }, other)).job, ID2);
  second.active = false;
  assert.equal((await h.request('info')).job, ID1);
  assert.equal((await h.request('info', {}, other)).state, 'running');
  await h.request('cancel');
  assert.equal((await h.request('info')).state, 'cancelled');
  assert.equal((await h.request('info', {}, other)).state, 'running');
  assert.deepEqual(h.calls.filter(call => call.options.method === 'DELETE').map(call => call.url.split('/').pop()), [ID1]);
  assert.equal((await h.cache.get(firstDoc)).job, ID1);
  second.url = 'https://fixture.test/navigated';
  await h.worker.tabUpdated(second.id, { url: second.url }, second);
  assert(h.calls.some(call => call.options.method === 'DELETE' && call.url.endsWith(ID2)));
  assert.equal(Object.keys(h.session).length, 1);
});
test('optional file grant starts synchronously before any await and never runs for a web source', async () => {
  const h = harness(); assert.equal(h.worker.prepare({ ...h.tab }), null); assert.equal(h.permissionRequests.length, 0);
  h.tab.url = 'file:///private/fixture.pdf';
  const prepared = h.worker.prepare({ ...h.tab });
  assert.equal(h.permissionRequests.length, 1, 'permission request must run in the action event turn');
  assert.deepEqual(JSON.parse(JSON.stringify(h.permissionRequests[0])), { origins: ['file:///*'] });
  await h.worker.open({ ...h.tab }, prepared); assert.equal(h.updates.length, 1);
});
test('cache age/count eviction cancels a discarded running job, including startup prune', async () => {
  const h = harness(), old = { id: ID2, job: ID1, state: 'running' };
  const previous = h.cache.put.bind(h.cache);
  h.cache.put = async record => { await previous(record); return [old]; };
  await h.worker.open({ ...h.tab });
  assert(h.calls.some(call => call.url.endsWith('/' + ID1) && call.options.method === 'DELETE'));
  h.calls.length = 0;
  h.cache.prune = async () => [old];
  await h.worker.prune();
  assert(h.calls.some(call => call.url.endsWith('/' + ID1) && call.options.method === 'DELETE'));
});
test('navigation while the source is being cached cannot replace the user’s new page', async () => {
  const h = harness(), sourceTab = { ...h.tab };
  const put = h.cache.put.bind(h.cache);
  h.cache.put = async record => {
    await put(record);
    h.tab.url = 'https://fixture.test/new-page';
    await h.worker.tabUpdated(h.tab.id, { url: h.tab.url }, h.tab);
  };
  await assert.rejects(h.worker.open(sourceTab), /INACTIVE|CANCELLED/);
  assert.equal(h.updates.length, 0); assert.equal(h.cache.values.size, 0); assert.equal(Object.keys(h.session).length, 0);
});
test('hostile content scripts, wrong tabs, frames, docs and URL parameters cannot use the PDF service', async () => {
  const h = harness(); await h.worker.open({ ...h.tab });
  const doc = new URL(h.tab.url).searchParams.get('doc');
  for (const overrides of [{ id: 'other' }, { frameId: 1 }, { tab: undefined }, { tab: { id: 99 } },
    { url: 'https://fixture.test/paper.pdf' }, { url: h.tab.url + '&url=https://evil.test' }]) {
    const result = await h.worker.message({ doc, action: 'start', page: 3, whole: false, source: 'en', target: 'zh-Hans' }, h.sender(overrides));
    assert.equal(result.code, 'INACTIVE');
  }
  assert.equal((await h.request('start', { doc: ID2, page: 3, whole: false, source: 'en', target: 'zh-Hans' })).code, 'INACTIVE');
  assert.equal(h.calls.length, 1);
});
test('authenticated fixed job protocol, both modes and reverse direction never expose pairing token or source path', async () => {
  const h = harness(); await h.worker.open({ ...h.tab });
  const initial = await h.request('info'); assert.equal(initial.page, 3); assert.equal(initial.source, 'en'); assert.equal(initial.target, 'zh-Hans');
  for (const input of [{ page: 0 }, { page: 2001 }, { source: 'auto' }, { target: 'en' }, { whole: 'all' }]) {
    const result = await h.request('start', { page: 3, whole: false, source: 'en', target: 'zh-Hans', ...input });
    assert.equal(result.code, 'PDF_PAGE');
  }
  const started = await h.request('start', { page: 3, whole: false, source: 'zh-Hans', target: 'en', url: 'https://attacker.test/steal.pdf' });
  assert.equal(started.ok, true); assert.equal(started.state, 'running');
  const upload = h.calls[1]; assert.equal(upload.url, 'http://127.0.0.1:43795/v1/pdf/jobs');
  assert.equal(upload.options.headers.Authorization, 'Bearer ' + SECRET);
  assert.equal(upload.options.headers['X-AskGPT-Pages'], '3');
  assert.equal(upload.options.headers['X-AskGPT-Source'], 'zh-Hans'); assert.equal(upload.options.headers['X-AskGPT-Target'], 'en');
  assert.equal(await upload.options.body.text(), PDF);
  const complete = await h.request('status'); assert.equal(complete.state, 'complete');
  for (const mode of ['mono', 'dual']) {
    const output = await h.request('output', { mode }); assert.equal(output.ok, true); assert.equal(output.mode, mode);
    const record = await h.cache.get(initial.id); assert.equal(await record.outputs[mode].text(), PDF);
    assert(!JSON.stringify(output).includes(SECRET)); assert(!JSON.stringify(output).includes('originalURL'));
  }
  const calls = h.calls.length; assert.equal((await h.request('output', { mode: 'mono' })).ok, true); assert.equal(h.calls.length, calls);
  assert.equal((await h.request('output', { mode: '../input' })).code, 'PDF_FAILED');
  assert(!JSON.stringify(started).includes(SECRET)); assert(!JSON.stringify(complete).includes(SECRET));
});
test('restore and navigation cancel running jobs and remove private source/output bytes', async () => {
  for (const action of ['restore', 'navigate', 'close']) {
    const h = harness(), original = h.tab.url; await h.worker.open({ ...h.tab });
    const doc = new URL(h.tab.url).searchParams.get('doc');
    await h.request('start', { page: 3, whole: false, source: 'en', target: 'zh-Hans' });
    if (action === 'restore') { assert.equal((await h.request('restore')).ok, true); assert.equal(h.tab.url, original); }
    else if (action === 'navigate') { h.tab.url = 'https://fixture.test/other'; await h.worker.tabUpdated(17, { url: h.tab.url }, h.tab); }
    else await h.worker.dispose(17);
    assert.equal(await h.cache.get(doc), undefined); assert.equal(Object.keys(h.session).length, 0);
    assert(h.calls.some(call => call.options.method === 'DELETE' && call.url.endsWith('/' + ID1)));
  }
});
test('cancelled upload cannot resurrect a session/job after its late 202 response', async () => {
  const h = harness(); await h.worker.open({ ...h.tab });
  let release, ready;
  const startedFetch = new Promise(resolve => { ready = resolve; });
  h.setFetch(async (url, options) => {
    if (options.method === 'POST') { ready(); return new Promise(resolve => { release = () => resolve(new Response(JSON.stringify({ id: ID1, state: 'running', sourcePages: [2], pageCount: 12 }), { status: 202 })); }); }
  });
  const pending = h.request('start', { page: 3, whole: false, source: 'en', target: 'zh-Hans' });
  await startedFetch; await h.worker.dispose(17); release();
  const result = await pending; assert.equal(result.ok, false); assert.equal(h.cache.values.size, 0);
  assert(h.calls.some(call => call.options.method === 'DELETE'));
});
test('same-tab reload retains bytes; hotkey restores original rather than nesting PDF readers', async () => {
  const h = harness(), original = h.tab.url; await h.worker.open({ ...h.tab });
  await h.worker.tabUpdated(17, { status: 'loading' }, h.tab);
  assert.equal((await h.request('info')).ok, true);
  assert.equal(await h.worker.toggle({ ...h.tab }), true); assert.equal(h.tab.url, original); assert.equal(h.cache.values.size, 0);
});
test('late status cannot overwrite a newer job, cancel state, or cached mode output', async () => {
  for (const outcome of ['new-job', 'cancel', 'cached-output']) {
    const h = harness(); await h.worker.open({ ...h.tab });
    await h.request('start', { page: 3, whole: false, source: 'en', target: 'zh-Hans' });
    let release, ready;
    const fetched = new Promise(resolve => { ready = resolve; });
    h.setFetch(async (url, options) => {
      if (url.endsWith('/' + ID1) && !options.method) { ready(); return new Promise(resolve => { release = () => resolve(new Response(JSON.stringify({ id: ID1, state: 'complete', sourcePages: [2], pageCount: 12 }))); }); }
      if (outcome === 'new-job' && options.method === 'POST') return new Response(JSON.stringify({ id: ID2, state: 'running', sourcePages: [4], pageCount: 12 }), { status: 202 });
    });
    const pending = h.request('status'); await fetched;
    const doc = new URL(h.tab.url).searchParams.get('doc');
    if (outcome === 'new-job') await h.request('start', { page: 5, whole: false, source: 'en', target: 'zh-Hans' });
    else if (outcome === 'cancel') await h.request('cancel');
    else { const record = await h.cache.get(doc); record.outputs.mono = new Blob([PDF]); await h.cache.put(record); }
    release(); const response = await pending;
    const final = await h.cache.get(doc);
    if (outcome === 'new-job') { assert.equal(response.code, 'CANCELLED'); assert.equal(final.job, ID2); assert.equal(final.page, 5); assert.equal(final.state, 'running'); }
    else if (outcome === 'cancel') { assert.equal(response.state, 'cancelled'); assert.equal(final.state, 'cancelled'); }
    else assert.equal(await final.outputs.mono.text(), PDF);
  }
});

async function until(condition, reason) {
  const limit = Date.now() + 2000;
  while (Date.now() < limit) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  throw new Error(reason);
}
function readerDOM(handler, initialState = 'complete', initialPage = 3) {
  const { JSDOM } = require(path.resolve(browser, '../../work/browser-inline-test/node_modules/jsdom'));
  const dom = new JSDOM(fs.readFileSync(path.join(browser, 'pdf-reader.html'), 'utf8'), {
    url: 'chrome-extension://' + extensionID + '/pdf-reader.html?doc=' + ID2, runScripts: 'outside-only'
  });
  const { window } = dom, requests = [], urls = [], revoked = [], cache = new MemoryCache();
  const record = { id: ID2, title: '<script>untrusted</script>', tabId: 17, source: new Blob([PDF]),
    page: initialPage, sourcePages: [2], pageCount: 12, whole: false, outputs: { mono: new Blob([PDF + 'mono']), dual: new Blob([PDF + 'dual']) },
    job: ID1, state: initialState };
  cache.values.set(ID2, record);
  window.Blob = Blob;
  window.URL.createObjectURL = blob => { const url = 'blob:chrome-extension://' + extensionID + '/' + urls.length; urls.push({ url, blob }); return url; };
  window.URL.revokeObjectURL = url => revoked.push(url);
  window.chrome = { runtime: { async sendMessage(message) {
    requests.push(message);
    const result = await handler(message, record);
    return result || { ok: true, id: ID2, title: record.title, page: record.page, pageCount: 12, source: 'en', target: 'zh-Hans',
      whole: false, job: ID1, state: initialState };
  } } };
  window.eval(fs.readFileSync(path.join(browser, 'pdf-core.js'), 'utf8'));
  window.AskGPTPDF.Cache = class { constructor() { return cache; } };
  // The product cache constructor is injected above; this dummy is never read.
  window.indexedDB = {};
  window.eval(fs.readFileSync(path.join(browser, 'pdf-reader.js'), 'utf8'));
  return { dom, window, requests, urls, revoked, cache, record };
}
test('unknown Chrome physical page does not silently translate page one', async () => {
  const h = readerDOM(async () => {}, 'idle', null);
  try {
    await until(() => h.window.document.querySelector('iframe'), 'original PDF should remain available while choosing a page');
    assert(!h.requests.some(message => message.action === 'start'));
    assert.equal(h.window.document.getElementById('page').value, '');
    assert.equal(h.window.document.getElementById('error').hidden, true);
  } finally { h.dom.window.close(); }
});
test('rapid mode changes ignore late output and render only the latest selected PDF mode', async () => {
  let releaseMono, ready;
  const fetched = new Promise(resolve => { ready = resolve; });
  const h = readerDOM(async message => {
    if (message.action === 'output' && message.mode === 'mono') { ready(); return new Promise(resolve => { releaseMono = () => resolve({ ok: true, mode: 'mono', job: ID1 }); }); }
    if (message.action === 'output') return { ok: true, mode: message.mode, job: ID1 };
  });
  try {
    await fetched;
    const mode = h.window.document.getElementById('mode'); mode.value = 'dual'; mode.dispatchEvent(new h.window.Event('change'));
    await until(() => h.window.document.querySelector('iframe')?.title === 'Original and translated PDF', 'dual PDF not rendered');
    releaseMono(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(h.window.document.querySelector('iframe').title, 'Original and translated PDF');
    assert.equal(h.urls.length, 1); assert.equal(await h.urls[0].blob.text(), PDF + 'dual');
    assert.equal(h.window.document.getElementById('title').textContent, '<script>untrusted</script>');
    assert.equal(h.window.document.querySelectorAll('script').length, 2);
    mode.value = 'original'; mode.dispatchEvent(new h.window.Event('change'));
    await until(() => h.window.document.querySelector('iframe')?.title === 'Original PDF', 'original PDF not restored');
    assert.equal(h.revoked.length, 1); assert.equal(h.window.document.querySelector('iframe').src.endsWith('#page=3'), true);
  } finally { h.dom.window.close(); }
});
test('cancel ignores a late job-start reply and keeps original PDF visible without intermediate message', async () => {
  let releaseStart, ready;
  const fetched = new Promise(resolve => { ready = resolve; });
  const h = readerDOM(async message => {
    if (message.action === 'start') { ready(); return new Promise(resolve => { releaseStart = () => resolve({ ok: true, id: ID2, job: ID1, state: 'running', pageCount: 12 }); }); }
  }, 'idle');
  try {
    await fetched;
    assert.equal(h.window.document.querySelector('iframe').title, 'Original PDF');
    assert.equal(h.window.document.getElementById('progress').hidden, false);
    assert.equal(h.window.document.getElementById('progress-bar').hasAttribute('value'), false);
    h.window.document.getElementById('cancel').click();
    releaseStart(); await new Promise(resolve => setTimeout(resolve, 20));
    assert(h.requests.some(message => message.action === 'cancel'));
    assert(!h.requests.some(message => message.action === 'status'));
    assert.equal(h.window.document.getElementById('error').hidden, true);
    assert.equal(h.window.document.getElementById('document').getAttribute('aria-busy'), 'false');
    assert.equal(h.window.document.querySelector('iframe').title, 'Original PDF');
    assert.equal(h.window.document.getElementById('progress').hidden, true);
  } finally { h.dom.window.close(); }
});
test('reader shows genuine page progress without replacing the readable original and hides it on completion', async () => {
  const pending = [];
  const info = { ok: true, id: ID2, job: ID1, state: 'running', page: 3, whole: true, pageCount: 12,
    title: 'Synthetic PDF', source: 'en', target: 'zh-Hans', progress: { stage: 'preparing' } };
  const h = readerDOM(async (message, record) => {
    if (message.action === 'info') { record.whole = true; return { ...info }; }
    if (message.action === 'status') return new Promise(resolve => pending.push(value => {
      if (value.state === 'complete') record.state = 'complete';
      resolve({ ...info, ...value });
    }));
  }, 'running');
  try {
    const document = h.window.document;
    await until(() => pending.length, 'initial status should be requested');
    const original = document.querySelector('iframe'), progress = document.getElementById('progress');
    const label = document.getElementById('progress-label'), bar = document.getElementById('progress-bar');
    assert.equal(original.title, 'Original PDF'); assert.equal(progress.hidden, false);
    assert.equal(label.textContent, 'Preparing…'); assert.equal(bar.hasAttribute('value'), false);
    pending.shift()({ progress: { stage: 'translating', completed: 1, total: 3 } });
    await until(() => label.textContent === 'Translating · 1 / 3 pages', 'real completed-page count should be visible');
    assert.equal(bar.value, 1); assert.equal(bar.max, 3);
    assert.equal(document.querySelector('iframe'), original); assert.equal(h.urls.length, 1);
    await until(() => pending.length, 'layout status should be requested');
    pending.shift()({ progress: { stage: 'layout' } });
    await until(() => label.textContent === 'Finishing layout…', 'layout should be indeterminate');
    assert.equal(bar.hasAttribute('value'), false); assert.equal(document.querySelector('iframe'), original);
    await until(() => pending.length, 'completion should be requested');
    pending.shift()({ state: 'complete', progress: { stage: 'translating', completed: 3, total: 3 } });
    await until(() => document.querySelector('iframe')?.title === 'Translated PDF', 'translated PDF should render after completion');
    assert.equal(progress.hidden, true); assert.equal(bar.hasAttribute('value'), false);
    assert.equal(document.getElementById('error').hidden, true);
  } finally { h.dom.window.close(); }
});
test('malformed progress falls back to preparation and errors hide the bar without hiding the original', async () => {
  let rejectStatus;
  const h = readerDOM(async message => {
    if (message.action === 'info') return { ok: true, id: ID2, job: ID1, state: 'running', page: 3, whole: false, pageCount: 12,
      title: 'Synthetic PDF', source: 'en', target: 'zh-Hans', progress: { stage: 'translating', completed: 4, total: 1, text: '<img src=x>' } };
    if (message.action === 'status') return new Promise((_, reject) => { rejectStatus = reject; });
  }, 'running');
  try {
    const document = h.window.document;
    await until(() => rejectStatus, 'running job should be polled');
    assert.equal(document.getElementById('progress-label').textContent, 'Preparing…');
    assert.equal(document.getElementById('progress-bar').hasAttribute('value'), false);
    assert.equal(document.querySelector('img'), null);
    const original = document.querySelector('iframe');
    rejectStatus(new Error('Synthetic translation failure'));
    await until(() => !document.getElementById('error').hidden, 'error should be displayed');
    assert.equal(document.getElementById('progress').hidden, true);
    assert.equal(document.querySelector('iframe'), original);
    assert.equal(document.getElementById('document').getAttribute('aria-busy'), 'false');
  } finally { h.dom.window.close(); }
});
test('cancel or page exit cannot revive progress from a late status response', async () => {
  for (const action of ['cancel', 'pagehide']) {
    let releaseStatus;
    const h = readerDOM(async message => {
      if (message.action === 'status') return new Promise(resolve => { releaseStatus = () => resolve({ ok: true, id: ID2,
        job: ID1, state: 'running', pageCount: 12, progress: { stage: 'translating', completed: 1, total: 3 } }); });
    }, 'running');
    try {
      const document = h.window.document;
      await until(() => releaseStatus, 'status request should be pending');
      const original = document.querySelector('iframe');
      if (action === 'cancel') document.getElementById('cancel').click();
      else h.window.dispatchEvent(new h.window.Event('pagehide'));
      releaseStatus(); await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(document.getElementById('progress').hidden, true);
      assert.equal(document.getElementById('progress-bar').hasAttribute('value'), false);
      assert.equal(document.querySelector('iframe'), original);
      assert.equal(h.requests.filter(message => message.action === 'status').length, 1);
    } finally { h.dom.window.close(); }
  }
});
