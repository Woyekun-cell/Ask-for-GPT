'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
let JSDOM;
for (const folder of [path.join(root, 'work/browser-inline-test/node_modules/jsdom'), path.resolve(root, '../github-release/Ask-for-GPT/work/browser-inline-test/node_modules/jsdom')]) {
  try { ({ JSDOM } = require(folder)); break; } catch (_) { /* Existing test-only dependency. */ }
}
if (!JSDOM) throw Error('Test-only jsdom is required.');
const Panel = require('../content/paper-supplement-panel.js');
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(test) { for (let i = 0; i < 100; i++) { if (test()) return; await pause(); } throw Error('UI did not settle'); }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(overrides = {}, useTrigger = false, paperHTML = null, menuOptions = {}, panel = Panel) {
  const dom = new JSDOM('<!doctype html><html lang="zh-CN"><head></head><body><div id="toolbar"></div><div id="original">Original PDF</div></body></html>', { url: 'https://reader.invalid/' });
  const win = dom.window, doc = win.document, calls = [], revoked = [], renders = [];
  win.innerWidth = 1400; win.innerHeight = 900;
  win.URL.createObjectURL = () => { calls.push('blob'); return 'blob:https://reader.invalid/' + calls.filter(x => x === 'blob').length; };
  win.URL.revokeObjectURL = value => revoked.push(value);
  win.HTMLCanvasElement.prototype.getContext = function () { return { canvas: this }; };
  let local = [{ id: 2, title: 'Supplementary methods', fileName: 'methods.pdf', contentType: 'application/pdf' }];
  let workers = 0, documents = 0, cancelled = 0, loads = 0;
  const pdf = { numPages: 2, destroy() { documents++; return Promise.resolve(); }, async getPage(number) {
    return { getViewport({ scale }) { return { width: 600 * scale, height: 800 * scale }; }, render(options) { renders.push({ number, options }); return { promise: Promise.resolve(), cancel() { cancelled++; } }; },
      async getTextContent() { return { items: [{ str: 'Page ' + number }, { str: '<script>literal</script>' }] }; }, cleanup() {} };
  } };
  const loading = { promise: Promise.resolve(pdf), destroy() { loads++; return Promise.resolve(); } };
  const sourceWin = { pdfjsLib: { PDFWorker: class { destroy() { workers++; } }, getDocument(options) { calls.push({ load: options }); return loading; } } };
  const original = doc.getElementById('original'); original.scrollTop = 411; original.scrollLeft = 19;
  const reader = { type: 'pdf', itemID: 1, _state: { primaryViewState: { pageIndex: 4, top: 123 } }, _internalReader: { _primaryView: { _iframeWindow: sourceWin } } };
  const supplements = {
    async list(value) { assert.equal(value, reader); calls.push('list'); return local; },
    async find(value) { assert.equal(value, reader); calls.push('find'); return { status: 'ready', source: 'Europe PMC', candidates: [{ id: 's1', title: '<img src=x onerror=alert(1)>', fileName: 's1.pdf' }] }; },
    async download(value, ids) { assert.equal(value, reader); calls.push({ download: ids }); local = [...local, { id: 3, title: 'New supplement', fileName: 'new.pdf', contentType: 'application/pdf' }]; return { added: [local[1]], skipped: [], failed: [] }; },
    async chooseFiles() { calls.push('choose'); return { added: [], skipped: [], failed: [] }; },
    async preview(value, id) { assert.equal(value, reader); calls.push({ preview: id }); return { kind: 'pdf', title: 'Supplementary methods', contentType: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70, 45]) }; },
    async open(value, id) { assert.equal(value, reader); calls.push({ external: id }); }, ...overrides
  };
  const trigger = useTrigger ? doc.createElement('button') : undefined; let normalClicks = 0, appends = 0;
  if (trigger) { trigger.textContent = 'Ask GPT'; trigger.setAttribute('aria-label', 'Ask GPT'); trigger.addEventListener('click', () => normalClicks++); doc.getElementById('toolbar').appendChild(trigger); }
  const manager = panel.create({ supplements, paperHTML, chinese: true });
  const render = () => manager.render({ reader, doc, trigger, ...menuOptions, append: node => { appends++; doc.getElementById('toolbar').appendChild(node); } });
  const handle = render();
  const button = text => [...doc.querySelectorAll('button')].find(node => !node.closest('[hidden]') && (node.textContent === text || node.getAttribute('aria-label') === text));
  const click = text => { const node = button(text); assert(node, 'Missing button: ' + text); node.click(); return node; };
  return { dom, win, doc, calls, reader, original, manager, handle, render, button, click, revoked, renders, pdf, loading, trigger,
    get normalClicks() { return normalClicks; }, get appends() { return appends; },
    get resources() { return { workers, documents, cancelled, loads }; }, close() { manager.shutdown(); win.close(); } };
}

(async () => {
  let count = 0;
  {
    const f = fixture();
    assert.equal(f.calls.length, 0, 'Toolbar rendering must not read files or contact services');
    assert.equal(f.render(), f.handle, 'Re-render reuses the existing entry');
    assert.equal(f.doc.querySelectorAll('[data-askgpt-supplements-button]').length, 1);
    f.handle.button.click(); await until(() => f.button('Supplementary methods'));
    assert.deepEqual(f.calls, ['list']); assert.equal(f.handle.button.getAttribute('aria-expanded'), 'true');
    assert.equal(f.original.scrollTop, 411); assert.deepEqual(f.reader._state.primaryViewState, { pageIndex: 4, top: 123 });
    assert.equal(f.handle.element.getAttribute('aria-modal'), 'false'); assert.equal(f.doc.body.style.overflow, '');
    f.doc.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert(f.handle.element.hidden); assert.equal(f.doc.activeElement, f.handle.button); assert.equal(f.original.scrollLeft, 19);
    f.close(); count++;
  }
  {
    const f = fixture(); f.handle.button.click(); await until(() => f.button('Supplementary methods'));
    f.click('查找补充材料'); await until(() => f.doc.querySelector('input[type="checkbox"]'));
    assert.equal(f.calls.filter(x => x === 'find').length, 1); assert(!f.calls.some(x => x.download));
    const checkbox = f.doc.querySelector('input[type="checkbox"]'); assert.equal(checkbox.checked, false);
    assert(f.button('下载所选（0）').disabled); assert.equal(f.doc.querySelector('img'), null, 'Untrusted labels stay literal');
    checkbox.click(); assert.equal(f.button('下载所选（1）').disabled, false); f.click('下载所选（1）');
    await until(() => f.button('New supplement'));
    assert.deepEqual(f.calls.find(x => x.download).download, ['s1']); assert(!f.calls.some(x => x.preview), 'Download must not auto-open');
    f.click('添加本地文件'); await until(() => f.calls.includes('choose')); await pause();
    assert(f.handle.element.textContent.includes('未选择文件')); f.close(); count++;
  }
  {
    const f = fixture(); f.handle.button.click(); await until(() => f.button('Supplementary methods')); f.click('Supplementary methods');
    await until(() => f.renders.length === 1 && f.handle.element.textContent.includes('1 / 2'));
    const options = f.calls.find(x => x.load).load;
    assert.equal(options.isEvalSupported, false); assert.equal(options.enableXfa, false); assert(options.worker);
    assert.equal(f.doc.querySelector('iframe, object, embed'), null, 'PDF is not put in an untrusted navigable frame');
    assert.equal(f.original.scrollTop, 411); assert(!f.calls.some(x => x.external)); assert(f.doc.querySelector('canvas'));
    f.click('下一页'); await until(() => f.renders.length === 2); assert.equal(f.renders[1].number, 2);
    f.click('关闭补充材料'); assert(f.handle.element.hidden); assert.equal(f.resources.workers, 1); assert.equal(f.resources.documents, 1);
    assert.equal(f.original.scrollTop, 411); f.close(); count++;
  }
  {
    const pending = deferred(); const f = fixture({ preview: () => pending.promise });
    f.handle.button.click(); await until(() => f.button('Supplementary methods')); f.click('Supplementary methods');
    assert(f.button('查找补充材料').disabled); f.handle.close();
    pending.resolve({ kind: 'image', contentType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]), title: 'Late' }); await pause(); await pause();
    assert(f.handle.element.hidden); assert.equal(f.doc.querySelector('img'), null); assert(!f.calls.includes('blob'));
    f.close(); count++;
  }
  {
    const f = fixture({ preview: async () => ({ kind: 'image', title: 'A figure', contentType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) }) });
    f.handle.button.click(); await until(() => f.button('Supplementary methods')); f.click('Supplementary methods'); await until(() => f.doc.querySelector('img'));
    const image = f.doc.querySelector('img'); assert(image.src.startsWith('blob:')); assert.equal(image.alt, 'A figure');
    image.dispatchEvent(new f.win.Event('load')); f.handle.close(); assert.equal(f.revoked.length, 1); f.close(); count++;
  }
  {
    const f = fixture({ preview: async () => ({ kind: 'external', title: 'Supplementary table', contentType: 'application/vnd.ms-excel' }) });
    f.handle.button.click(); await until(() => f.button('Supplementary methods')); f.click('Supplementary methods'); await until(() => f.button('在外部应用打开'));
    assert(!f.calls.some(x => x.external)); f.click('在外部应用打开'); await until(() => f.calls.some(x => x.external));
    assert.equal(f.calls.find(x => x.external).external, 2); f.close(); count++;
  }
  {
    let attempts = 0;
    const f = fixture({ async list() { if (!attempts++) throw Object.assign(Error('secret file/path'), { code: 'missing_file' }); return [{ id: 7, title: 'Recovered', fileName: 'ok.pdf' }]; } });
    f.handle.button.click(); await until(() => f.button('重试')); assert(!f.handle.element.textContent.includes('secret'));
    f.click('重试'); await until(() => f.button('Recovered'));
    f.loading.promise = Promise.reject(Error('PDF failure')); f.click('Recovered'); await until(() => f.button('在外部应用打开'));
    assert(f.handle.element.textContent.includes('无法预览')); assert.equal(f.resources.workers, 1); assert(!f.calls.some(x => x.external));
    f.close(); count++;
  }
  {
    const pending = deferred(); const f = fixture({ find: () => pending.promise });
    f.handle.button.click(); await until(() => f.button('Supplementary methods')); f.click('查找补充材料');
    f.manager.dispose(f.reader); pending.resolve({ status: 'ready', candidates: [{ id: 'late', title: 'Late' }] }); await pause();
    assert.equal(f.handle.button.parentNode, null); assert.equal(f.handle.element.parentNode, null);
    assert.equal(f.doc.querySelector('input[type="checkbox"]'), null); assert.equal(f.doc.querySelectorAll('style').length, 0);
    const fresh = f.render(); assert.notEqual(fresh, f.handle); f.manager.shutdown(); assert.equal(fresh.button.parentNode, null);
    f.close(); count++;
  }
  {
    const pending = deferred(), f = fixture(); f.loading.promise = pending.promise;
    f.handle.button.click(); await until(() => f.button('Supplementary methods')); f.click('Supplementary methods');
    await until(() => f.calls.some(x => x.load)); f.handle.close();
    assert.equal(f.resources.loads, 1, 'Closing destroys a pending PDF loading task'); assert.equal(f.resources.workers, 1);
    f.handle.button.click(); await until(() => f.button('Supplementary methods'));
    pending.resolve(f.pdf); await pause(); await pause();
    assert.equal(f.resources.documents, 1, 'Late isolated PDF is retired'); assert.equal(f.renders.length, 0);
    assert.equal(f.doc.querySelector('canvas'), null); assert.equal(f.button('在外部应用打开'), undefined, 'Old preview cannot affect the reopened drawer');
    f.close(); count++;
  }
  {
    const pending = deferred(), f = fixture(); let cancelled = 0;
    f.pdf.getPage = async () => ({ getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }), render() { f.calls.push('render_pending'); return { promise: pending.promise, cancel() { cancelled++; } }; } });
    f.handle.button.click(); await until(() => f.button('Supplementary methods')); f.click('Supplementary methods');
    await until(() => f.calls.includes('render_pending')); f.handle.close(); assert.equal(cancelled, 1); assert.equal(f.resources.documents, 1);
    pending.reject(Error('Rendering cancelled')); await pause(); assert(f.handle.element.hidden); assert.equal(f.original.scrollTop, 411);
    f.close(); count++;
  }
  {
    const f = fixture({ preview: async () => ({ kind: 'image', contentType: 'image/svg+xml', title: 'Not a raster image', bytes: new Uint8Array([60, 115, 118, 103]) }) });
    f.handle.button.click(); await until(() => f.button('Supplementary methods')); f.click('Supplementary methods'); await until(() => f.button('在外部应用打开'));
    assert.equal(f.doc.querySelector('img'), null); assert(!f.calls.includes('blob')); assert(!f.calls.some(x => x.external));
    assert(f.handle.element.textContent.includes('无法预览')); f.close(); count++;
  }
  {
    const f = fixture({}, true); assert.equal(f.appends, 0); assert.equal(f.doc.querySelectorAll('[data-askgpt-supplements-button]').length, 0);
    f.trigger.click(); assert.equal(f.normalClicks, 1); assert(f.handle.element.hidden); assert.equal(f.calls.length, 0);
    const event = new f.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 80 });
    f.trigger.dispatchEvent(event); assert(event.defaultPrevented); assert.equal(f.calls.length, 0); assert.equal(f.normalClicks, 1);
    assert.equal(f.doc.querySelector('[role="menuitem"]'), f.doc.activeElement); assert.equal(f.doc.querySelector('[role="menu"]').hidden, false);
    assert.equal(f.doc.querySelector('[role="menu"]').getAttribute('aria-label'), 'Paper Actions');
    assert.equal(f.doc.querySelector('[role="menu"]').lang, 'en');
    f.click('Supplementary Materials'); await until(() => f.button('Supplementary methods')); assert(f.doc.querySelector('[role="menu"]').hidden);
    assert.equal(f.handle.element.querySelector('h2').textContent, '补充材料');
    f.handle.close(); assert.equal(f.doc.activeElement, f.trigger); assert.equal(f.trigger.getAttribute('aria-label'), 'Ask GPT');
    f.manager.dispose(f.reader); assert.equal(f.trigger.parentElement.id, 'toolbar'); f.trigger.click(); assert.equal(f.normalClicks, 2);
    f.close(); count++;
  }
  {
    let update;
    const paperHTML = {view: () => ({state:'idle'}), activate(_reader, {onChange}) { update = onChange; }};
    const f = fixture({}, true, paperHTML), menu = f.doc.querySelector('[role="menu"]');
    f.win.innerWidth = 280; f.win.innerHeight = 160;
    menu.getBoundingClientRect = () => ({width: 200, height: menu.querySelector('[role="status"]').hidden ? 72 : 112});
    f.trigger.dispatchEvent(new f.win.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 260, clientY: 140}));
    assert.equal(menu.style.left, '72px'); assert.equal(menu.style.top, '80px');
    f.click('Generate HTML Version');
    update({state: 'running', stage: 'reviewing'});
    assert.equal(f.button('Reviewing HTML draft…').getAttribute('aria-disabled'), 'true');
    assert(menu.querySelector('[role="status"]').hidden);
    const progress = f.doc.querySelector('#toolbar .askgpt-paper-html-progress');
    update({state: 'running', stage: 'reconnecting', elapsedSeconds: 21});
    assert.equal(f.button('Reconnecting…').getAttribute('aria-disabled'), 'true');
    assert.equal(progress.querySelector('[role="status"]').textContent, 'Reconnecting…');
    assert.equal(progress.querySelector('time').textContent, '21s');
    update({state: 'failed', code: 'html_timed_out'});
    assert(f.button('Retry HTML Generation'));
    assert.equal(progress.querySelector('[role="status"]').textContent, 'HTML conversion failed');
    assert.equal(progress.title, 'The conversion timed out before saving. You can retry.');
    assert.equal(menu.querySelector('[role="status"]').textContent, 'The conversion timed out before saving. You can retry.');
    assert.equal(menu.style.top, '40px');
    f.win.innerWidth = 235;
    f.win.dispatchEvent(new f.win.Event('resize'));
    assert.equal(menu.style.left, '27px');
    f.close(); count++;
  }
  {
    const f = fixture({}, true), menu = f.doc.querySelector('[role="menu"]');
    f.trigger.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); assert(!menu.hidden);
    f.doc.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); assert(menu.hidden); assert.equal(f.doc.activeElement, f.trigger);
    f.trigger.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true })); assert(!menu.hidden);
    f.original.dispatchEvent(new f.win.Event('pointerdown', { bubbles: true })); assert(menu.hidden); assert.equal(f.calls.length, 0);
    f.trigger.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }));
    const tab = new f.win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); f.doc.activeElement.dispatchEvent(tab); assert(menu.hidden); assert.equal(tab.defaultPrevented, false);
    f.handle.show(); await until(() => f.button('Supplementary methods')); assert(f.handle.open); f.close(); count++;
  }
  {
    const moduleFile = path.join(__dirname, '../content/paper-supplement-panel.js');
    let popup, activations = 0, opened = 0;
    const sandbox = {module: {exports: {}}, AskGPTPaperNativeMenu: {
      open(options) { popup = options; opened++; return {close: options.onClose}; }
    }};
    require('node:vm').runInNewContext(require('node:fs').readFileSync(moduleFile, 'utf8'), sandbox, {filename: moduleFile});
    const paperHTML = {view: () => ({state: 'saved'}), activate: () => { activations++; }};
    const f = fixture({}, true, paperHTML, {}, sandbox.module.exports);
    assert.equal(f.trigger.getAttribute('aria-haspopup'), null);
    f.trigger.click();
    assert.equal(f.normalClicks, 1); assert.equal(opened, 0);
    f.trigger.dispatchEvent(new f.win.MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2}));
    assert.equal(opened, 1);
    assert.deepEqual(Array.from(popup.items, item => item.label), ['Supplementary Materials', 'Open HTML in Browser']);
    popup.items[1].run();
    assert.equal(activations, 1); assert.equal(f.normalClicks, 1);
    f.trigger.dispatchEvent(new f.win.KeyboardEvent('keydown', {key: 'F10', shiftKey: true, bubbles: true, cancelable: true}));
    assert.equal(opened, 2); assert.equal(f.normalClicks, 1);
    f.close(); count++;
  }
  {
    const f = fixture({}, true, {view: () => ({state: 'idle'})}, {primaryMenu: true});
    const menu = f.doc.querySelector('[role="menu"]');
    assert.equal(f.trigger.getAttribute('aria-haspopup'), 'menu');
    f.trigger.click();
    assert.equal(f.trigger.getAttribute('aria-expanded'), 'true');
    assert.deepEqual([...menu.querySelectorAll('button')].map(item => item.textContent),
      ['Supplementary Materials', 'Generate HTML Version']);
    assert.equal(f.doc.activeElement.textContent, 'Supplementary Materials');
    assert.deepEqual(f.calls, []);
    f.click('Supplementary Materials');
    assert(menu.hidden);
    f.trigger.click();
    f.trigger.click();
    assert(menu.hidden);
    assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
    f.close(); count++;
  }
  {
    const completion = deferred(), opening = deferred();
    let value = {state: 'idle'}, conversions = 0, opens = 0, active = true;
    const paperHTML = {view: () => value, async activate(_reader, {onChange}) {
      if (value.state === 'saved') {
        opens++; onChange({state: 'running', stage: 'opening'}); await opening.promise;
        onChange({state: 'saved', opened: true}); return;
      }
      conversions++; onChange(value = {state: 'running', stage: 'reviewing', elapsedSeconds: 75}); await completion.promise;
      value = {state: 'saved'}; onChange({...value, generated: true});
    }};
    const f = fixture({}, true, paperHTML, {isCurrent: () => active});
    assert.equal(f.button('Generate HTML Version'), undefined);
    f.trigger.click(); assert.equal(f.normalClicks, 1); assert.equal(conversions, 0);
    f.trigger.dispatchEvent(new f.win.KeyboardEvent('keydown', {key: 'F10', shiftKey: true, bubbles: true, cancelable: true}));
    assert.equal(f.doc.activeElement.textContent, 'Supplementary Materials');
    f.doc.activeElement.dispatchEvent(new f.win.KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true, cancelable: true}));
    assert.equal(f.doc.activeElement.textContent, 'Generate HTML Version');
    f.doc.activeElement.click();
    assert.equal(f.doc.activeElement.textContent, 'Reviewing HTML draft…');
    assert.equal(f.doc.activeElement.getAttribute('aria-disabled'), 'true');
    f.doc.activeElement.click(); assert.equal(conversions, 1);
    const progress = f.doc.querySelector('#toolbar .askgpt-paper-html-progress');
    assert(progress && !progress.hidden);
    assert(!progress.querySelector('progress').hasAttribute('value'));
    assert.equal(progress.querySelector('[role="status"]').textContent, 'Reviewing HTML draft…');
    assert.equal(progress.querySelector('time').textContent, '1m 15s');
    active = false;
    completion.resolve();
    await until(() => f.button('Open HTML in Browser'));
    active = true;
    assert.equal(opens, 0);
    assert.equal(progress.querySelector('[role="status"]').textContent, 'HTML saved to Zotero');
    assert(progress.querySelector('progress').hidden);
    f.click('Open HTML in Browser'); assert.equal(opens, 1);
    assert.equal(progress.querySelector('[role="status"]').textContent, 'Opening HTML…');
    assert.equal(progress.querySelector('progress').hidden, false);
    opening.resolve();
    await until(() => progress.querySelector('[role="status"]').textContent === 'HTML opened');
    assert(progress.querySelector('progress').hidden);
    assert.equal(f.original.scrollTop, 411);
    assert.equal(f.doc.getElementById('toolbar').children.length, 2);
    f.handle.dispose();
    assert.equal(f.doc.getElementById('toolbar').children.length, 1);
    f.close(); count++;
  }
  console.log(`PASS ${count} supplement drawer lifecycle and interaction scenarios`);
})().catch(error => { console.error(error); process.exitCode = 1; });
