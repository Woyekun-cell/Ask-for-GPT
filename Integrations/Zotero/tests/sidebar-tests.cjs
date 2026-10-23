const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const DOM = require('./fake-dom.cjs');
const modulePath = path.join(__dirname, '../content/sidebar.js');
const Sidebar = fs.existsSync(modulePath) ? require(modulePath) : {};
let checks = 0;
async function check(name, fn) { await fn(); checks++; process.stdout.write(`PASS ${name}\n`); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise(setImmediate);

function fixture() {
  const main = new DOM.Window(), other = new DOM.Window();
  main.Zotero_Tabs = { selectedID: 'pdf-one' }; other.Zotero_Tabs = { selectedID: 'pdf-other' };
  const sections = new Map(), calls = [], readers = new Map(), states = new Map(), subscribers = new Set(), localizations = [];
  let registrations = 0, removals = 0, unsubscribed = 0;
  const reader = { type: 'pdf', tabID: 'pdf-one', _window: main }, second = { type: 'pdf', tabID: 'pdf-two', _window: main };
  readers.set(reader.tabID, reader); readers.set(second.tabID, second);
  const fresh = () => ({ open: false, busy: false, whole: false, mode: 'mono', direction: 'en-zh' });
  const state = r => states.get(r) || fresh();
  let translate = () => undefined,hover=true,resume=true;
  const actions = {
    state,
    resumeEnabled:()=>resume,
    setResumeEnabled(value){resume=value;calls.push({action:'resume',value});for(const reader of readers.values())for(const callback of subscribers)callback(reader,state(reader));},
    hoverEnabled:()=>hover,
    setHoverEnabled(value){hover=value;calls.push({action:'hover',value});for(const reader of readers.values())for(const callback of subscribers)callback(reader,state(reader));},
    translate(r, options) { calls.push({ action: 'translate', reader: r, options }); return translate(r, options); },
    setMode(r, mode) { calls.push({ action: 'mode', reader: r, mode }); },
    restore(r) { calls.push({ action: 'restore', reader: r }); },
    subscribe(callback) { subscribers.add(callback); return () => { unsubscribed++; subscribers.delete(callback); }; }
  };
  const Zotero = {
    locale: 'zh-CN', getMainWindows: () => [main],
    Reader: { getByTabID: id => readers.get(id) },
    ItemPaneManager: {
      registerSection(options) { registrations++; sections.set('namespaced-returned-id', options); return 'namespaced-returned-id'; },
      unregisterSection(id) { removals++; assert.equal(id, 'namespaced-returned-id'); sections.delete(id); }
    }
  };
  function prepare(win) {
    win.MozXULElement = { insertFTLIfNeeded: value => localizations.push([win, value]) };
    win.document.defaultView = win;
    win.document.createXULElement = name => new DOM.Element(win.document, name);
    win.document.querySelector = () => null;
  }
  prepare(main); prepare(other);
  function bodyFor(r = reader) {
    const doc = r._window.document, details = new DOM.Element(doc, 'item-details');
    details.tabID = r.tabID; details.dataset = { tabId: r.tabID };
    const body = new DOM.Element(doc, 'div'); body.closest = name => name === 'item-details' ? details : null;
    body.replaceChildren = (...nodes) => { for (const node of [...body.children]) node.remove(); body.textContent = ''; body.append(...nodes); };
    doc.body.appendChild(details); details.appendChild(body);
    return { body, doc, details };
  }
  const module = Sidebar.create({ Zotero, pluginID: 'fixture-plugin', rootURI: 'jar:file:///fixture.xpi!/', actions });
  module.start();
  const options = sections.get('namespaced-returned-id');
  function render(r = reader, tabType = 'reader') {
    const panel = bodyFor(r), enabled = [];
    const props = { ...panel, tabType, item: { id: 99 }, setEnabled: value => enabled.push(value) };
    options.onInit?.(props); options.onItemChange?.(props); options.onRender(props);
    const control = action => panel.body.allNodes().find(n => n.getAttribute('data-askgpt-control') === action);
    return { ...panel, props, enabled, control };
  }
  const notify = (r, next) => { states.set(r, next); for (const callback of [...subscribers]) callback(r, next); };
  return { module, main, other, reader, second, readers, states, state, calls, options, render, notify, localizations,
    setTranslate: value => { translate = value; },setOriginal: value => { actions.original = value; },
    get registrations() { return registrations; }, get removals() { return removals; }, get unsubscribed() { return unsubscribed; } };
}

(async () => {
  await check('reading resumption hint can be disabled without translating or changing the hover setting',()=>{
    const f=fixture(),p=f.render(),toggle=p.control('resume');
    assert(toggle,'original PDF needs a reading resumption switch');assert.equal(toggle.checked,true);
    toggle.checked=false;toggle.emit('command');assert.equal(toggle.checked,false);assert.equal(p.control('hover').checked,true);
    assert.deepEqual(f.calls,[{action:'resume',value:false}]);assert.equal(p.control('translate').disabled,false);
    f.module.shutdown();toggle.checked=true;toggle.emit('command');assert.equal(f.calls.length,1);
  });
  await check('hover dictionary can be disabled before any PDF translation starts',()=>{
    const f=fixture(),p=f.render(),toggle=p.control('hover');
    assert(toggle,'untranslated PDF needs an accessible hover switch');assert.equal(toggle.checked,true);
    toggle.checked=false;toggle.emit('command');assert.deepEqual(f.calls,[{action:'hover',value:false}]);
    assert.equal(toggle.checked,false);assert.equal(p.control('translate').disabled,false);
    f.module.shutdown();toggle.checked=true;toggle.emit('command');assert.equal(f.calls.length,1);
  });
  await check('native original action retains the reader translation instead of invoking destructive restore', () => {
    const f=fixture(),p=f.render();let originals=0;f.setOriginal(reader=>{assert.equal(reader,f.reader);originals++;});
    f.notify(f.reader,{open:true,busy:false,whole:true,mode:'dual',original:false});p.control('original').emit('command');
    assert.equal(originals,1);assert.equal(f.calls.length,0);f.module.shutdown();
  });
  await check('sidebar is exposed as its own native integration module', () => assert.equal(typeof Sidebar.create, 'function'));
  await check('registers one native section and loads Fluent once per main window', () => {
    const f = fixture(); f.module.start(); f.module.attachWindow(f.main); f.module.attachWindow(f.other);
    assert.equal(f.registrations, 1); assert.equal(f.options.pluginID, 'fixture-plugin');
    assert(f.options.header.icon.endsWith('/content/translate.svg')); assert(f.options.sidenav.icon.endsWith('/content/translate.svg'));
    assert.equal(f.localizations.filter(([win]) => win === f.main).length, 1); assert.equal(f.localizations[0][1], 'askgpt-inline.ftl');
    f.module.shutdown(); f.module.shutdown(); assert.equal(f.removals, 1); assert.equal(f.unsubscribed, 1);
  });
  await check('enables only an exact PDF reader tab instead of its shared parent item', () => {
    const f = fixture(), pdf = f.render(); assert.deepEqual(pdf.enabled, [true]);
    const library = f.render(f.reader, 'library'); assert.deepEqual(library.enabled, [false]);
    f.readers.set(f.reader.tabID, { ...f.reader, type: 'epub' }); const epub = f.render(); assert.deepEqual(epub.enabled, [false]);
    f.module.shutdown();
  });
  await check('scope and direction apply to the exact reader while mode switches without retranslation', async () => {
    const f = fixture(), p = f.render();
    for (const name of ['scope', 'mode', 'direction']) { assert.equal(p.control(name).tagName, 'menulist'); assert.equal(p.control(name).getAttribute('native'), 'true'); }
    p.control('scope').value = 'whole'; p.control('scope').emit('command');
    p.control('direction').value = 'zh-en'; p.control('direction').emit('command');
    p.control('mode').value = 'dual'; p.control('mode').emit('command');
    assert.deepEqual(f.calls, [{ action: 'mode', reader: f.reader, mode: 'dual' }]);
    p.control('translate').emit('command'); await tick();
    assert.deepEqual(f.calls[1], { action: 'translate', reader: f.reader, options: { whole: true, mode: 'dual', direction: 'zh-en' } });
    f.module.shutdown();
  });
  await check('translation disables immediately and busy original button cancels without progress text', async () => {
    const f = fixture(), pending = deferred(); f.setTranslate(() => pending.promise); const p = f.render();
    p.control('translate').emit('command'); assert.equal(p.control('translate').disabled, true); assert.equal(p.body.getAttribute('aria-busy'), 'true');
    p.control('translate').emit('command'); assert.equal(f.calls.filter(c => c.action === 'translate').length, 1);
    assert.equal(p.control('original').disabled, false); p.control('original').emit('command');
    assert.equal(f.calls.at(-1).action, 'restore');
    f.notify(f.reader, { open: false, busy: false, whole: false, mode: 'mono', direction: 'en-zh' });
    pending.resolve(); await tick(); assert.equal(p.control('translate').disabled, false); assert.equal(p.body.getAttribute('aria-busy'), 'false');
    assert(!/等待|完成|翻译中|Loading|Progress/.test(p.body.textContent)); f.module.shutdown();
  });
  await check('busy translation shows native progress and cancellation hides it immediately', async () => {
    const f = fixture(), pending = deferred(); f.setTranslate(() => pending.promise); const p = f.render();
    assert(p.control('progress'), 'native PDF controls need a progress row'); assert.equal(p.control('progress').hidden, true); p.control('translate').emit('command');
    assert.equal(p.control('progress').hidden, false); assert.equal(p.control('progress-meter').tagName, 'progress');
    assert.equal(p.control('progress-meter').namespaceURI, 'http://www.w3.org/1999/xhtml');
    assert.equal(p.control('progress-meter').getAttribute('value'), undefined); assert.equal(p.control('progress-label').getAttribute('value'), '准备中');
    p.control('original').emit('command'); assert.equal(p.control('progress').hidden, true); pending.resolve(); await tick(); f.module.shutdown();
  });
  await check('only real completed page counts produce a determinate native progress value', () => {
    const f = fixture(), p = f.render();
    f.notify(f.reader, { open: true, busy: true, progress: { stage: 'translating', completed: 3, total: 12 } });
    assert.equal(p.control('progress-meter').getAttribute('max'), '100'); assert.equal(p.control('progress-meter').getAttribute('value'), '25');
    assert.equal(p.control('progress-label').getAttribute('value'), '翻译 3 / 12 页');
    assert.deepEqual(JSON.parse(p.control('progress-label').getAttribute('data-l10n-args')), { completed: 3, total: 12 });
    for (const stage of ['preparing', 'layout', 'loading']) {
      f.notify(f.reader, { open: true, busy: true, progress: { stage } }); assert.equal(p.control('progress-meter').getAttribute('value'), undefined);
    }
    f.notify(f.reader, { open: true, busy: false, progress: null }); assert.equal(p.control('progress').hidden, true); f.module.shutdown();
  });
  await check('invalid progress counts never appear as a percentage or an untrusted status', () => {
    const f = fixture(), p = f.render();
    f.notify(f.reader, { open: true, busy: true, progress: { stage: 'translating', completed: 90, total: 12, text: 'PRIVATE_SOURCE' } });
    assert.equal(p.control('progress-meter').getAttribute('value'), undefined); assert.equal(p.control('progress-label').getAttribute('value'), '翻译中');
    assert(!JSON.stringify([...p.control('progress-label').attributes]).includes('PRIVATE_SOURCE'));
    f.notify(f.reader, { open: true, busy: false }); assert.equal(p.control('progress').hidden, true); f.module.shutdown();
  });
  await check('state events update the matching PDF panel and do not overwrite another tab', () => {
    const f = fixture(), first = f.render(), second = f.render(f.second);
    f.notify(f.second, { open: true, busy: true, whole: true, mode: 'dual', direction: 'zh-en' });
    assert.equal(second.control('translate').disabled, true); assert.equal(second.control('mode').value, 'dual');
    assert.equal(first.control('translate').disabled, false); assert.equal(first.control('mode').value, 'mono');
    f.main.Zotero_Tabs.selectedID = 'pdf-two'; first.control('translate').emit('command'); assert.equal(f.calls.length, 0);
    second.control('original').emit('command'); assert.equal(f.calls[0].reader, f.second); f.module.shutdown();
  });
  await check('a mode state notification preserves unsubmitted scope and direction choices', async () => {
    const f = fixture(), p = f.render();
    p.control('scope').value = 'whole'; p.control('scope').emit('command');
    p.control('direction').value = 'zh-en'; p.control('direction').emit('command');
    f.notify(f.reader, { open: true, busy: false, whole: false, mode: 'dual', direction: 'en-zh' });
    assert.equal(p.control('scope').value, 'whole'); assert.equal(p.control('direction').value, 'zh-en');
    p.control('translate').emit('command'); await tick();
    assert.deepEqual(f.calls.at(-1).options, { whole: true, mode: 'dual', direction: 'zh-en' }); f.module.shutdown();
  });
  await check('a chosen initial side by side mode survives unrelated state updates before translation starts',async()=>{const f=fixture(),p=f.render();p.control('mode').value='dual';p.control('mode').emit('command');f.notify(f.reader,{open:false,busy:false,whole:false,mode:'mono',direction:'en-zh'});assert.equal(p.control('mode').value,'dual');p.control('translate').emit('command');await tick();assert.equal(f.calls.at(-1).options.mode,'dual');f.module.shutdown();});
  await check('completion from a replaced render cannot clear the current panels busy state', async () => {
    const f = fixture(), pending = deferred(); f.setTranslate(() => pending.promise); const p = f.render();
    p.control('translate').emit('command'); f.options.onRender(p.props);
    const newer = deferred(); f.setTranslate(() => newer.promise); p.control('translate').emit('command');
    pending.resolve(); await tick();
    assert.equal(p.body.getAttribute('aria-busy'), 'true'); assert.equal(p.control('translate').disabled, true);
    newer.resolve(); await tick(); f.module.shutdown();
  });
  await check('rerender and destroy remove old controls and cannot run stale actions', () => {
    const f = fixture(), p = f.render(), old = p.control('translate');
    f.options.onRender(p.props); old.emit('command'); assert.equal(f.calls.length, 0);
    const current = p.control('translate'); f.options.onDestroy(p.props); current.emit('command'); assert.equal(f.calls.length, 0);
    const q = f.render(); f.module.detachWindow(f.main); q.control('translate').emit('command'); assert.equal(f.calls.length, 0); f.module.shutdown();
  });
  await check('detached or independent reader context never falls back to the selected main tab', () => {
    const f = fixture(), p = f.render(); p.details.tabID = null; p.details.dataset.tabId = null;
    p.control('translate').emit('command'); assert.equal(f.calls.length, 0);
    f.options.onItemChange(p.props); assert.equal(p.enabled.at(-1), false); f.module.shutdown();
  });
  await check('labels and line icon are packaged locally with English and Chinese Fluent resources', () => {
    const root = path.join(__dirname, '..');
    for (const locale of ['en-US', 'zh-CN']) {
      const text = fs.readFileSync(path.join(root, 'locale', locale, 'askgpt-inline.ftl'), 'utf8');
      assert(text.includes('askgpt-inline-section-header =')); assert(text.includes('.label ='));
      assert(text.includes('askgpt-inline-section-sidenav =')); assert(text.includes('.tooltiptext ='));
      for (const key of ['scope', 'current', 'whole', 'mode', 'mono', 'dual', 'direction', 'translate', 'original', 'progress-preparing', 'progress-translating', 'progress-layout', 'progress-loading', 'progress-pages']) assert(text.includes(`askgpt-inline-${key} =`));
    }
    const icon = fs.readFileSync(path.join(root, 'content/translate.svg'), 'utf8'); assert(icon.includes('viewBox="0 0 20 20"')); assert(!/https?:\/\//.test(icon.replace('http://www.w3.org/2000/svg', '')));
  });
  process.stdout.write(JSON.stringify({ status: 'PASS', checks }) + '\n');
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
