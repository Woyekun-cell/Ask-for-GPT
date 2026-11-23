'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const DOM = require('./fake-dom.cjs');
const {open} = require('../content/paper-native-menu.js');

function fixture() {
  const chromeWindow = new DOM.Window(), readerWindow = new DOM.Window();
  chromeWindow.navigator = {platform: 'MacIntel'};
  const popupset = chromeWindow.document.body.appendChild(new DOM.Element(chromeWindow.document, 'popupset'));
  const inactiveTab = chromeWindow.document.body.appendChild(new DOM.Element(chromeWindow.document, 'div'));
  const hiddenPopupset = inactiveTab.appendChild(new DOM.Element(chromeWindow.document, 'popupset'));
  chromeWindow.document.querySelector = selector => ({':root > popupset': popupset, popupset: hiddenPopupset})[selector] || null;
  const openCalls = [], hidden = [], behavior = {};
  chromeWindow.document.createXULElement = tag => {
    const item = new DOM.Element(chromeWindow.document, tag);
    if (tag === 'menupopup') {
      item.openPopupAtScreen = (...args) => {
        openCalls.push(args);
        if (behavior.fail) throw new Error('Native menu unavailable');
      };
      item.hidePopup = () => {
        hidden.push(item);
        item.emit('popuphidden', {target: item});
      };
    }
    return item;
  };
  readerWindow.document.defaultView = readerWindow;
  readerWindow.mozInnerScreenX = -985;
  readerWindow.mozInnerScreenY = 110;
  const anchor = readerWindow.document.body.appendChild(new DOM.Element(readerWindow.document, 'button'));
  anchor.getBoundingClientRect = () => ({left: 81, bottom: 25});
  return {chromeWindow, readerWindow, anchor, popupset, hidden, openCalls, behavior};
}

const items = [{label: 'Open chat', run() {}}];

test('Reader coordinates anchor a native XUL context menu in the owner chrome window', () => {
  const {chromeWindow, anchor, popupset, openCalls} = fixture();
  let runs = 0, closes = 0;
  const handle = open({chromeWindow, anchor, items: [
    {label: 'Ask GPT', run() { runs++; }},
    {label: 'HTML version · generating', disabled: true, run() { throw new Error('disabled action fired'); }},
  ], onClose() { closes++; }});
  assert.ok(handle);
  assert.deepEqual(openCalls, [[-904, 139, true]]);
  const [popup] = popupset.children;
  assert.equal(popup.ownerDocument, chromeWindow.document);
  assert.deepEqual(popup.children.map(row => [row.getAttribute('label'), row.getAttribute('disabled')]),
    [['Ask GPT', undefined], ['HTML version · generating', 'true']]);
  popup.children[0].emit('command');
  popup.children[1].emit('command');
  assert.equal(runs, 1);
  popup.emit('popuphidden', {target: popup});
  popup.children[0].emit('command');
  handle.close();
  assert.equal(runs, 1);
  assert.equal(closes, 1);
  assert.deepEqual(popupset.children, []);
});

test('Replacing or unloading the reader closes a single native popup once', () => {
  const {chromeWindow, readerWindow, anchor, popupset, hidden} = fixture();
  let closes = 0;
  const options = {chromeWindow, anchor, items, onClose() { closes++; }};
  const first = open(options), second = open(options);
  assert.ok(first && second);
  assert.equal(closes, 1);
  assert.equal(popupset.children.length, 1);
  assert.equal(readerWindow.listenerCount(), 1);
  readerWindow.emit('unload');
  first.close();
  second.close();
  assert.equal(closes, 2);
  assert.equal(hidden.length, 2);
  assert.equal(readerWindow.listenerCount(), 0);
  assert.deepEqual(popupset.children, []);
});

test('Zotero can dispatch the selected Cocoa command after popuphidden', () => {
  const {chromeWindow, anchor, popupset} = fixture();
  let runs = 0;
  const options = {chromeWindow, anchor, items: [{label: 'Generate HTML Version', run() { runs++; }}]};
  open(options);
  const [natural] = popupset.children;
  natural.emit('popuphidden', {target: natural});
  natural.children[0].emit('command');
  natural.children[0].emit('command');
  assert.equal(runs, 1);
  const cancelled = open(options);
  const [forced] = popupset.children;
  cancelled.close();
  forced.children[0].emit('command');
  assert.equal(runs, 1);
  open(options);
  const [older] = popupset.children;
  older.emit('popuphidden', {target: older});
  open(options);
  const [newer] = popupset.children;
  newer.emit('popuphidden', {target: newer});
  older.children[0].emit('command');
  assert.equal(runs, 1);
});

test('Other platforms, missing screen coordinates, or a failed popup return the fallback signal', () => {
  const {chromeWindow, readerWindow, anchor, popupset, openCalls, behavior} = fixture();
  let closes = 0;
  const options = {chromeWindow, anchor, items, onClose() { closes++; }};
  chromeWindow.navigator.platform = 'Win32';
  assert.equal(open(options), null);
  chromeWindow.navigator.platform = 'MacIntel';
  delete readerWindow.mozInnerScreenX;
  assert.equal(open(options), null);
  assert.deepEqual(openCalls, []);
  readerWindow.mozInnerScreenX = 5;
  behavior.fail = true;
  assert.equal(open(options), null);
  assert.equal(openCalls.length, 1);
  assert.equal(closes, 0);
  assert.equal(readerWindow.listenerCount(), 0);
  assert.deepEqual(popupset.children, []);
});

test('A disabled Gecko native-context menu preference leaves the HTML fallback available', () => {
  const source = fs.readFileSync(require.resolve('../content/paper-native-menu.js'), 'utf8');
  const result = {Services: {appinfo: {OS: 'Darwin'}, prefs: {getBoolPref(name) {
    assert.equal(name, 'widget.macos.native-context-menus');
    return false;
  }}}};
  vm.runInNewContext(source, result);
  assert.equal(result.AskGPTPaperNativeMenu.open(), null);
  const {chromeWindow, anchor, openCalls} = fixture();
  assert.equal(result.AskGPTPaperNativeMenu.open({chromeWindow, anchor, items}), null);
  assert.deepEqual(openCalls, []);
});

test('A standalone Zotero reader uses its dedicated chrome popupset', () => {
  const {chromeWindow, anchor, popupset} = fixture();
  const doc = chromeWindow.document;
  const standalone = doc.body.appendChild(new DOM.Element(doc, 'popupset'));
  doc.ids.set('zotero-reader-popupset', standalone);
  const handle = open({chromeWindow, anchor, items});
  assert.ok(handle);
  assert.equal(standalone.children.length, 1);
  assert.equal(popupset.children.length, 0);
  handle.close();
  assert.equal(standalone.children.length, 0);
});
