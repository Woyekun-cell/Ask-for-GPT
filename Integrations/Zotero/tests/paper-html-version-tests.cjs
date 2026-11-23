'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const PDF = require('../content/pdf-layout.js');
const {create} = require('../content/paper-html-version.js');
const HTML = Buffer.from('<!doctype html><html lang="zh-CN"><p>示例阅读版</p></html>');
const SOURCE = Buffer.from('%PDF-1.7 original open reader bytes');
const BASE = 'http://127.0.0.1:43795/v1/pdf/paper-html';
const JOB = 'a'.repeat(32);
const DONE = {id: JOB, state: 'complete', sha256: crypto.createHash('sha256').update(HTML).digest('hex'), bytes: HTML.length};
const json = (value, status = 200) => ({status, responseText: JSON.stringify(value)});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'askgpt-paper-html-test-'));
  const temp = path.join(directory, 'staging');
  fs.mkdirSync(temp);
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  class File {
    constructor(value) { this.path = value; }
    clone() { return new File(this.path); }
    append(value) { this.path = path.join(this.path, value); }
    exists() { return fs.existsSync(this.path); }
    isSymlink() { return fs.lstatSync(this.path).isSymbolicLink(); }
    isFile() { return fs.statSync(this.path).isFile(); }
    get fileSize() { return fs.statSync(this.path).size; }
    get lastModifiedTime() { return fs.statSync(this.path).mtimeMs; }
    createUnique(type, permissions) {
      assert.equal(type, 1);
      assert.equal(permissions, 0o700);
      this.path = fs.mkdtempSync(this.path + '-');
      fs.chmodSync(this.path, permissions);
    }
  }
  const source = {id: 1, key: 'SOURCE01', libraryID: 1, parentID: 2, isPDFAttachment: () => true};
  const children = [1];
  const parent = {id: 2, key: 'PARENT01', libraryID: 1, isRegularItem: () => true,
    getField: field => field === 'DOI' ? '10.1371/journal.pone.0000893' : '',
    getAttachments: trashed => { assert.equal(trashed, false); return children.slice(); }};
  const items = new Map([[1, source], [2, parent]]);
  const reader = {itemID: 1, _item: source, type: 'pdf'};
  const calls = [], updates = [], imports = [], launches = [];
  let pdfReads = 0;
  const doc = {getData: async () => { pdfReads++; return Uint8Array.from(SOURCE); }};
  const behavior = {active: true, connected: true, editable: true, type: 'text/html; charset=utf-8', done: DONE};
  const manager = create({
    Zotero: {Items: {get: id => items.get(id)}, Libraries: {get: () => ({filesEditable: behavior.editable})},
      Prefs: {get: () => behavior.translation}, getTempDirectory: () => new File(temp),
      HTTP: {async request(method, url, options) {
        assert.equal(options.headers.Authorization, 'Bearer fixture-token');
        assert.equal(options.followRedirects, false);
        assert.equal(options.anon, true);
        assert.equal(options.debug, false);
        assert.equal(options.logBodyLength, 0);
        assert.equal(options.headers.Origin, undefined);
        assert.equal(options.timeout, method === 'POST' || url.endsWith('/output') ? 60000 : 10000);
        assert(url.startsWith(BASE));
        calls.push([method, url.slice(BASE.length)]);
        if (method === 'POST') {
          assert.equal(url, BASE);
          assert.equal(options.headers['Content-Type'], 'application/pdf');
          assert.equal(Object.prototype.toString.call(options.body), '[object ArrayBuffer]');
          assert.deepEqual(Buffer.from(options.body), SOURCE);
          behavior.afterUpload?.();
          return json({id: JOB, state: 'queued'}, 202);
        }
        if (url.endsWith('/output')) {
          assert.equal(options.responseType, 'arraybuffer');
          behavior.onOutput?.(options);
          const bytes = Uint8Array.from(behavior.body || HTML);
          return {status: 200, response: bytes.buffer, getResponseHeader: name => name.toLowerCase() === 'content-type' ? behavior.type : null};
        }
        behavior.onPoll?.();
        return json(behavior.done);
      }},
      File: {pathToFile: value => new File(value)},
      Attachments: {async importSnapshotFromFile(options) {
        if (process.platform !== 'win32') {
          assert.equal(fs.statSync(path.dirname(options.file)).mode & 0o777, 0o700);
          assert.equal(fs.statSync(options.file).mode & 0o777, 0o600);
        }
        assert.deepEqual(fs.readFileSync(options.file), HTML);
        imports.push(options);
        const target = path.join(directory, path.basename(options.file));
        fs.copyFileSync(options.file, target);
        const result = {id: 3, key: 'HTMLKEY1', libraryID: 1, parentID: options.parentItemID,
          attachmentContentType: 'text/html', attachmentFilename: path.basename(target),
          isSnapshotAttachment: () => true, getFilePathAsync: async () => target};
        items.set(3, result); children.push(3);
        return result;
      }},
      launchFile: value => launches.push(value)},
    IOUtils: {write: (dest, bytes, options) => {
      assert.equal(options.mode, 'create');
      assert.equal(options.permissions, 0o600);
      return fs.promises.writeFile(dest, bytes, {mode: options.permissions, flag: 'wx'});
    },
      remove: (dest, options) => fs.promises.rm(dest, {recursive: options.recursive, force: options.ignoreAbsent})},
    PDF, resolvePDF: () => ({pdfDocument: behavior.document || doc}),
    Components: {interfaces: {nsIFile: {DIRECTORY_TYPE: 1}}},
    readConnection: async () => {
      if (!behavior.connected) throw Object.assign(Error('private details'), {code: 'connection'});
      return {token: 'fixture-token'};
    },
    ensurePDFReady: async (_token, current) => assert(current()),
    setTimer: callback => {
      const timer = setTimeout(callback, 0);
      if (behavior.onWait) queueMicrotask(behavior.onWait);
      return timer;
    },
    clearTimer: clearTimeout,
    hashFile: file => crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex')
  });
  t.after(() => manager.shutdown());
  return {manager, reader, source, items, directory, temp, behavior, calls, updates, imports, launches, doc,
    get pdfReads() { return pdfReads; },
    run: () => manager.activate(reader, {isCurrent: () => behavior.active, onChange: state => updates.push(state)})};
}

test('stores the verified original-PDF result as a single native snapshot and resolves repeats locally', async t => {
  const f = fixture(t);
  assert.deepEqual(f.manager.view(f.reader), {state: 'idle'});
  assert.equal(f.calls.length, 0);
  await Promise.all([f.run(), f.run()]);
  assert.equal(f.pdfReads, 1);
  assert.deepEqual(f.calls, [['POST', ''], ['GET', '/' + JOB], ['GET', '/' + JOB + '/output']]);
  assert.equal(f.imports.length, 1);
  const [{file, ...options}] = f.imports;
  assert.match(file, /askgpt-paper-SOURCE01-[a-f0-9]{64}\.html$/);
  assert.deepEqual(options, {url: 'https://doi.org/10.1371/journal.pone.0000893', title: 'HTML 阅读版',
    contentType: 'text/html', charset: 'UTF-8', parentItemID: 2, singleFile: true});
  assert.deepEqual(fs.readdirSync(f.temp), []);
  assert.deepEqual(f.launches, [], 'Saving must preserve the reader tab');
  const beforeOpening = f.updates.length;
  await f.run();
  assert.deepEqual(f.updates.slice(beforeOpening).map(row => row.stage || row.state), ['opening', 'saved']);
  assert.equal(f.updates.at(-1).opened, true);
  assert.equal(f.calls.length, 3);
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0], path.join(f.directory, path.basename(file)));
});

test('keeps a submitted job bound to its source paper after switching tabs', async t => {
  const f = fixture(t);
  f.behavior.afterUpload = () => { f.behavior.active = false; f.reader.itemID = 42; };
  await f.run();
  assert.equal(f.imports.length, 1);
  assert.equal(f.imports[0].parentItemID, 2);
  assert.deepEqual(f.launches, []);
});

test('reports real worker progress and completion only to views for the source paper', async t => {
  const f = fixture(t);
  const reopened = {...f.reader}, unrelated = {...f.reader, itemID: 7, _item: {id: 7}};
  f.items.set(7, {...f.source, id: 7, key: 'SOURCE07'});
  const initial = [], afterSwitch = [], other = [];
  const stopWatching = f.manager.subscribe(f.reader, update => initial.push(update));
  f.manager.subscribe(unrelated, update => other.push(update));
  f.behavior.afterUpload = () => {
    stopWatching();
    f.manager.subscribe(reopened, update => afterSwitch.push(update));
    f.behavior.active = false;
    f.reader.itemID = 7;
  };
  let polls = 0;
  f.behavior.onPoll = () => {
    f.behavior.done = [
      {id: JOB, state: 'running', stage: 'extracting', elapsedSeconds: 75},
      {id: JOB, state: 'running', stage: 'reviewing', phase: 'repairing', elapsedSeconds: 93},
      DONE,
    ][polls++];
  };
  await f.run();
  assert.deepEqual(initial.map(row => row.stage || row.state), ['idle', 'starting', 'fetching']);
  assert.deepEqual(afterSwitch.map(row => row.stage || row.state), ['fetching', 'queued', 'extracting', 'repairing', 'saving', 'saved']);
  assert.equal(afterSwitch.find(row => row.stage === 'extracting').elapsedSeconds, 75);
  assert.equal(afterSwitch.at(-1).generated, true);
  assert.deepEqual(other, [{state: 'idle'}]);
  assert.equal(f.imports.length, 1);
});

test('never uploads when the active PDF changes while reading bytes', async t => {
  const f = fixture(t);
  const originalRead = f.doc.getData;
  f.doc.getData = async () => { f.behavior.document = {}; return originalRead(); };
  await f.run();
  assert.equal(f.pdfReads, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.imports.length, 0);
  assert.equal(f.manager.view(f.reader).state, 'idle');
});

test('rejects disconnected, read-only and known translated originals before the byte upload', async t => {
  const f = fixture(t);
  f.behavior.connected = false;
  await f.run();
  assert.equal(f.updates.at(-1).code, 'connection');
  f.behavior.connected = true; f.behavior.editable = false;
  await f.run();
  assert.equal(f.updates.at(-1).code, 'readonly');
  f.behavior.editable = true;
  f.behavior.translation = JSON.stringify({schema: 1, sourceSHA256: DONE.sha256, targetSHA256: DONE.sha256, targetKey: f.source.key});
  await f.run();
  assert.equal(f.updates.at(-1).code, 'translated');
  assert.equal(f.pdfReads, 0);
  assert.equal(f.calls.length, 0);
});

test('rejects wrong response MIME and digest and retries the existing completed job without a new upload', async t => {
  const f = fixture(t);
  f.behavior.type = 'application/pdf';
  await f.run();
  assert.equal(f.updates.at(-1).code, 'integrity');
  assert.equal(f.imports.length, 0);
  f.behavior.type = 'text/html';
  f.behavior.body = Buffer.from(HTML).fill('X', 18, 19);
  await f.run();
  assert.equal(f.updates.at(-1).code, 'integrity');
  assert.equal(f.imports.length, 0);
  assert.deepEqual(fs.readdirSync(f.temp), []);
  delete f.behavior.body;
  await f.run();
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 1);
  assert.equal(f.imports.length, 1);
});

test('a failed audit leaves no attachment and a retry can start a new conversion', async t => {
  const f = fixture(t);
  f.behavior.done = {id: JOB, state: 'failed', error: 'html_review_failed'};
  await f.run();
  assert.equal(f.updates.at(-1).code, 'html_review_failed');
  assert.deepEqual(f.calls, [['POST', ''], ['GET', '/' + JOB]]);
  assert.equal(f.imports.length, 0);
  f.behavior.done = DONE;
  await f.run();
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 2);
  assert.equal(f.imports.length, 1);
});

test('continues polling past the former client deadline and saves without a second upload', async t => {
  const f = fixture(t);
  let now = 0, polls = 0;
  t.mock.method(Date, 'now', () => now);
  const progress = [
    {id: JOB, state: 'running', stage: 'writing'},
    {id: JOB, state: 'running', stage: 'reviewing'},
    DONE,
  ];
  f.behavior.onPoll = () => {
    now += 60 * 60 * 1000;
    f.behavior.done = progress[polls++];
  };
  await f.run();
  assert.equal(polls, 3);
  assert.equal(f.updates.at(-1).state, 'saved');
  assert.deepEqual(f.updates.filter(row => row.stage).map(row => row.stage), ['starting', 'fetching', 'queued', 'writing', 'reviewing', 'saving']);
  assert.equal(f.updates.find(row => row.stage === 'reviewing').elapsedSeconds, 7200);
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 1);
  assert.equal(f.imports.length, 1);
});

test('recovers transient status and output reads on the same accepted job', async t => {
  const f = fixture(t);
  let now = 0, polls = 0, downloads = 0;
  t.mock.method(Date, 'now', () => now);
  f.behavior.afterUpload = () => { f.behavior.active = false; f.reader.itemID = 42; };
  f.behavior.onPoll = () => {
    now += 5000;
    if (++polls === 1) throw Error('transient status timeout');
  };
  f.behavior.onOutput = () => {
    now += 5000;
    if (++downloads === 1) throw Error('transient download timeout');
  };
  await f.run();
  assert.deepEqual(f.calls, [['POST', ''], ['GET', '/' + JOB], ['GET', '/' + JOB],
    ['GET', '/' + JOB + '/output'], ['GET', '/' + JOB + '/output']]);
  assert.deepEqual(f.updates.filter(row => row.stage === 'reconnecting').map(row => row.elapsedSeconds), [5, 15]);
  assert.equal(f.updates.at(-2).stage, 'saving');
  assert.equal(f.updates.at(-1).state, 'saved');
  assert.equal(f.imports[0].parentItemID, 2);
});

test('bounds consecutive GET failures and preserves the job ID for a later retry', async t => {
  const f = fixture(t);
  f.behavior.onPoll = () => { throw Error('service unreachable'); };
  await f.run();
  assert.equal(f.updates.at(-1).code, 'bridge');
  assert.deepEqual(f.calls, [['POST', ''], ...Array.from({length: 3}, () => ['GET', '/' + JOB])]);
  delete f.behavior.onPoll;
  await f.run();
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 1);
  assert.equal(f.imports.length, 1);
});

test('does not retry an unacknowledged POST or an oversize stopped output', async t => {
  const upload = fixture(t);
  upload.behavior.afterUpload = () => { throw Error('lost upload response'); };
  await upload.run();
  assert.equal(upload.updates.at(-1).code, 'bridge');
  assert.deepEqual(upload.calls, [['POST', '']]);

  const output = fixture(t);
  output.behavior.onOutput = options => {
    let aborted = false;
    options.requestObserver({abort() { aborted = true; }, addEventListener(_event, fn) {
      fn({loaded: 33 * 1024 * 1024});
    }});
    assert.equal(aborted, true);
    throw Error('download aborted');
  };
  await output.run();
  assert.equal(output.updates.at(-1).code, 'integrity');
  assert.deepEqual(output.calls, [['POST', ''], ['GET', '/' + JOB], ['GET', '/' + JOB + '/output']]);
  assert.equal(output.imports.length, 0);
});

test('shutdown while reconnecting prevents another GET', async t => {
  const f = fixture(t);
  let waits = 0;
  f.behavior.onPoll = () => { throw Error('service unreachable'); };
  f.behavior.onWait = () => { if (++waits === 2) f.manager.shutdown(); };
  await f.run();
  assert.equal(waits, 2);
  assert.deepEqual(f.calls, [['POST', ''], ['GET', '/' + JOB]]);
  assert.equal(f.imports.length, 0);
  assert.deepEqual(f.manager.view(f.reader), null);
});

test('shutdown releases an outstanding polling wait without probing or saving again', async t => {
  const f = fixture(t);
  f.behavior.onWait = () => f.manager.shutdown();
  await f.run();
  assert.deepEqual(f.calls, [['POST', '']]);
  assert.equal(f.imports.length, 0);
  assert.deepEqual(f.manager.view(f.reader), null);
});

test('a timed-out job reported by an older worker still permits a fresh conversion', async t => {
  const f = fixture(t);
  f.behavior.done = {id: JOB, state: 'failed', error: 'html_timed_out'};
  await f.run();
  assert.equal(f.updates.at(-1).code, 'html_timed_out');
  f.behavior.done = DONE;
  await f.run();
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 2);
  assert.equal(f.imports.length, 1);
});

test('does not save under a paper from which the captured source has been moved', async t => {
  const f = fixture(t);
  f.behavior.afterUpload = () => { f.source.parentID = 24; };
  await f.run();
  assert.equal(f.imports.length, 0);
  assert(!f.calls.some(([, value]) => value.endsWith('/output')));
});

test('does not launch a locally changed snapshot or create a duplicate', async t => {
  const f = fixture(t);
  await f.run();
  const file = await f.items.get(3).getFilePathAsync();
  fs.appendFileSync(file, '<script>changed</script>');
  await f.run();
  assert.equal(f.updates.at(-1).code, 'integrity');
  assert.equal(f.updates.at(-1).saved, true);
  assert.deepEqual(f.launches, []);
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 1);
  assert.equal(f.imports.length, 1);
});
