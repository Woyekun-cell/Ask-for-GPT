'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {createHash} = require('node:crypto');
const {create} = require('../content/paper-html-appearance.js');
const DOM = require('./fake-dom.cjs');

const html = '<!doctype html><html style="color-scheme: light"><p>Paper reader</p></html>';
const digest = value => createHash('sha256').update(value).digest('hex');
const filename = 'askgpt-paper-SOURCE01-' + digest(html) + '.html';
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const listeners = new Map(), observers = new Map(), calls = [];
  const initial = {'reader.lightTheme': 'custom1', 'reader.darkTheme': 'black'};
  const win = new DOM.Window(), browser = [], native = [];
  function item(id, libraryID, parentID, name) {
    return {id, libraryID, parentID, attachmentFilename: name, attachmentContentType: 'text/html', attachmentReaderType: 'snapshot',
      isSnapshotAttachment: () => true, getDisplayTitle: () => id === 3 ? 'HTML Reading Version' : 'Website',
      getFilePathAsync: async () => '/storage/' + name};
  }
  function reader(attachment, type = 'snapshot') {
    const native = {
      _type: type,
      _primaryView: {initializedPromise: Promise.resolve()},
      _state: {lightTheme: {id: 'custom1'}, darkTheme: {id: 'black'}},
      setLightTheme(value) { calls.push([attachment.id, 'light', value]); this._state.lightTheme = value ? {id: value} : null; },
      setDarkTheme(value) { calls.push([attachment.id, 'dark', value]); this._state.darkTheme = value ? {id: value} : null; }
    };
    return {type, itemID: attachment.id, _item: attachment, _internalReader: native};
  }
  const source = {id: 1, libraryID: 2, parentID: 2, key: 'SOURCE01', isPDFAttachment: () => true};
  const parent = {id: 2, libraryID: 2, isRegularItem: () => true, getAttachments: () => [1, 3, 4]};
  const snapshot = item(3, 2, 2, filename), web = item(4, 2, 2, 'ordinary-site.html');
  const items = new Map([source, parent, snapshot, web].map(value => [value.id, value]));
  const paperReader = reader(snapshot), webReader = reader(web), pdfReader = reader(source, 'pdf');
  pdfReader._iframeWindow = new DOM.Window();
  const behavior = {hashes: 0, html, symlink: false};
  const handlers = {open(...args) { assert.equal(this, handlers); native.push(args); return Promise.resolve('native-file-handler'); }};
  const manager = {
    async open(...args) { native.push(args); return 'native-reader'; },
    _readers: [paperReader, webReader, pdfReader],
    registerEventListener(type, callback, id) { assert.equal(id, 'test'); listeners.set(type, callback); },
    unregisterEventListener(type, callback) { assert.equal(listeners.get(type), callback); listeners.delete(type); }
  };
  const appearance = create({Zotero: {
    Reader: manager, FileHandlers: handlers, getMainWindows: () => [win], isMac: true,
    Utilities: {Internal: {
      async subprocess(cmd, args) {
        assert.equal(cmd, '/usr/bin/osascript'); assert.equal(args[1], 'JavaScript'); behavior.afterLookup?.();
        return '/Applications/Default Browser.app\n';
      },
      async exec(cmd, args) { browser.push([cmd, ...args]); }
    }},
    Items: {get: id => items.get(id), getByLibraryAndKey: (libraryID, key) =>
      libraryID === source.libraryID && key === source.key ? source : null},
    File: {pathToFile: path => ({path, leafName: path.split('/').pop(), get fileSize() { return behavior.html.length; },
      exists: () => true, isFile: () => true, isSymlink: () => behavior.symlink, lastModifiedTime: 1})},
    Prefs: {
      get: key => initial[key],
      registerObserver(key, callback) { observers.set(key, callback); return key; },
      unregisterObserver: key => observers.delete(key)
    }
  }, pluginID: 'test', hashFile: async () => {
    behavior.hashes++;
    await behavior.hashGate;
    return digest(behavior.html);
  }});
  t.after(() => appearance.shutdown());
  return {appearance, manager, handlers, native, browser, listeners, observers, calls, paperReader, pdfReader, snapshot, web, source, initial, behavior, win,
    render(reader) { listeners.get('renderToolbar')?.({reader}); }};
}

test('applies the stock palette only to the verified generated snapshot and restores preferences on shutdown', async t => {
  const f = fixture(t);
  f.appearance.start();
  await tick();
  assert.equal(f.behavior.hashes, 1);
  assert.deepEqual(f.calls, [[3, 'light', null], [3, 'dark', null]]);
  f.render(f.paperReader);
  await tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.behavior.hashes, 1);
  f.paperReader._internalReader.setLightTheme('sepia');
  f.initial['reader.lightTheme'] = 'sepia';
  f.observers.get('reader.lightTheme')();
  await tick();
  assert.deepEqual(f.calls.slice(-2), [[3, 'light', 'sepia'], [3, 'light', null]]);
  f.appearance.shutdown();
  assert.deepEqual(f.calls.slice(-2), [[3, 'light', 'sepia'], [3, 'dark', 'black']]);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.observers.size, 0);
  assert.equal(f.behavior.hashes, 1);
});

test('checks the source paper, physical file name, symlink status and digest before changing any appearance', async t => {
  for (const change of [
    f => { f.source.parentID = 99; },
    f => { f.snapshot.getFilePathAsync = async () => '/storage/some-other-file.html'; },
    f => { f.behavior.symlink = true; },
    f => { f.behavior.html += 'tampered'; }
  ]) {
    const f = fixture(t);
    change(f);
    f.appearance.start();
    f.render(f.paperReader);
    await tick();
    assert.deepEqual(f.calls, []);
  }
});

test('handles render events for new readers and guards against a view replacement during verification', async t => {
  const f = fixture(t);
  f.manager._readers = [];
  let resume;
  f.behavior.hashGate = new Promise(resolve => { resume = resolve; });
  f.appearance.start();
  f.render(f.paperReader);
  await tick();
  assert.equal(f.behavior.hashes, 1);
  f.paperReader._internalReader._primaryView = {initializedPromise: Promise.resolve()};
  resume();
  await tick();
  assert.deepEqual(f.calls, []);
  f.render(f.paperReader);
  await tick();
  assert.equal(f.behavior.hashes, 2);
  assert.deepEqual(f.calls, [[3, 'light', null], [3, 'dark', null]]);
});

function versionPopup(f, {anchorID = 'pdf-version-button', foreign = false, duplicate = false} = {}) {
  const anchor = new DOM.Element(foreign ? new DOM.Document() : f.pdfReader._iframeWindow.document, 'button');
  anchor.id = anchorID;
  const popup = new DOM.Element(f.win.document, 'menupopup');
  popup.id = 'zoterostyle-menupopup'; popup.anchorNode = anchor;
  function row(label, type) {
    const item = new DOM.Element(f.win.document, 'menuitem');
    item.setAttribute('label', label); item.setAttribute('type', 'checkbox');
    item.setAttribute('tooltiptext', type + '\n' + label);
    return popup.appendChild(item);
  }
  const htmlRow = row(f.snapshot.getDisplayTitle(), 'snapshot'), pdfRow = row('Original PDF', 'pdf');
  if (duplicate) row(f.snapshot.getDisplayTitle(), 'snapshot');
  f.win.emit('popupshowing', {target: popup});
  return {htmlRow, pdfRow};
}

const browserCall = ['/usr/bin/open', '-a', '/Applications/Default Browser.app', '/storage/' + filename];

test('the normal attachment action opens verified PaperLens files in the system browser only', async t => {
  const f = fixture(t), nativeOpen = f.handlers.open, readerOpen = f.manager.open;
  f.manager._readers = [];
  f.appearance.start();
  await tick();
  assert.equal(f.manager.open, readerOpen);
  assert.equal(await f.handlers.open(f.snapshot), true);
  assert.deepEqual(f.browser, [browserCall]);
  assert.equal(f.behavior.hashes, 1);
  for (const item of [f.web, f.source]) assert.equal(await f.handlers.open(item, {openInWindow: true}), 'native-file-handler');
  assert.equal(await f.handlers.open(f.snapshot, {location: {annotationID: 'annotation'}}), 'native-file-handler');
  assert.deepEqual(f.native.map(args => args[0].id), [4, 1, 3]);
  f.appearance.shutdown();
  assert.equal(f.handlers.open, nativeOpen);
  assert.equal(f.win.listenerCount(), 0);
});

test('a digest mismatch or newer wrapper remains in the normal Zotero route', async t => {
  const f = fixture(t); f.manager._readers = [];
  f.appearance.start();
  f.behavior.html += 'tampered';
  assert.equal(await f.handlers.open(f.snapshot), 'native-file-handler');
  assert.deepEqual(f.browser, []);
  const earlier = f.handlers.open;
  const newer = function (...args) { return earlier.apply(this, args); };
  f.handlers.open = newer;
  f.appearance.shutdown();
  assert.equal(f.handlers.open, newer);
});

test('does not launch a file changed during the browser lookup', async t => {
  const f = fixture(t); f.manager._readers = [];
  f.appearance.start();
  f.behavior.afterLookup = () => { f.behavior.html += 'changed during lookup'; };
  assert.equal(await f.handlers.open(f.snapshot), 'native-file-handler');
  assert.deepEqual(f.browser, []);
});

test('only the uniquely identified Ethereal Style HTML row is intercepted before tab switching', async t => {
  const f = fixture(t);
  f.appearance.start();
  await tick();
  for (const options of [{anchorID: 'another-menu'}, {foreign: true}, {duplicate: true}]) {
    const {htmlRow} = versionPopup(f, options);
    assert.equal(htmlRow.emit('command', {target: htmlRow}).immediateStopped, undefined);
  }
  const {htmlRow, pdfRow} = versionPopup(f);
  assert.equal(pdfRow.emit('command', {target: pdfRow}).immediateStopped, undefined);
  assert.equal(htmlRow.emit('command', {target: htmlRow}).immediateStopped, true);
  await tick();
  assert.deepEqual(f.browser, [browserCall]);
  assert.deepEqual(f.native, []);
});

test('a legacy version popup falls back to Zotero without closing the original reader when integrity fails', async t => {
  const f = fixture(t);
  f.appearance.start();
  await tick();
  f.behavior.symlink = true;
  const {htmlRow} = versionPopup(f);
  assert.equal(htmlRow.emit('command', {target: htmlRow}).immediateStopped, true);
  await tick();
  assert.deepEqual(f.browser, []);
  assert.deepEqual(f.native, [[3]]);
});
