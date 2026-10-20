'use strict';

(() => {
  const doc = new URL(location.href).searchParams.get('doc');
  const core = AskGPTPDF, cache = new core.Cache(indexedDB);
  const ui = Object.fromEntries(['title', 'mode', 'scope', 'page', 'page-count', 'direction', 'translate', 'cancel', 'restore', 'error', 'document',
    'progress', 'progress-label', 'progress-bar']
    .map(id => [id, document.getElementById(id)]));
  let generation = 0, running = false, source = 'en', target = 'zh-Hans', currentJob, currentBlobURL;
  let renderedKey, interval, closed = false, displaySequence = 0;
  function showProgress(value) {
    const bar = ui['progress-bar'], label = ui['progress-label'];
    ui.progress.hidden = !value;
    if (!value) { bar.removeAttribute('value'); bar.removeAttribute('max'); label.textContent = ''; return; }
    const progress = core.safeProgress(value) || { stage: 'preparing' };
    const text = progress.stage === 'translating' ? 'Translating · ' + progress.completed + ' / ' + progress.total +
      (progress.total === 1 ? ' page' : ' pages') : progress.stage === 'layout' ? 'Finishing layout…' : 'Preparing…';
    if (label.textContent !== text) label.textContent = text;
    if (progress.stage === 'translating') { bar.max = progress.total; bar.value = progress.completed; }
    else { bar.removeAttribute('value'); bar.removeAttribute('max'); }
  }
  function showError(message = '') {
    ui.error.textContent = message; ui.error.hidden = !message;
    if (message) showProgress(null);
  }
  function busy(value) {
    running = value;
    for (const control of [ui.scope, ui.page, ui.direction, ui.translate]) control.disabled = value;
    ui.cancel.hidden = !value;
    ui.document.setAttribute('aria-busy', String(value));
    if (!value) showProgress(null);
    else if (ui.progress.hidden) showProgress({ stage: 'preparing' });
  }
  async function request(action, extra = {}) {
    const response = await chrome.runtime.sendMessage({ type: 'PDF_READER', doc, action, ...extra });
    if (!response?.ok) throw new Error(response?.error || 'Open Ask for GPT and retry.');
    return response;
  }
  function pageInput() {
    if (ui.scope.value === 'all' && !ui.page.value) return 1;
    const page = Number(ui.page.value);
    if (!Number.isInteger(page) || page < 1 || page > Number(ui.page.max)) throw new Error('Choose a valid PDF page number.');
    return page;
  }
  async function display(mode, expected = generation) {
    const sequence = ++displaySequence;
    const stale = () => expected !== generation || sequence !== displaySequence || closed;
    const record = await cache.get(doc);
    if (stale()) return;
    if (!record) throw new Error('This translation has expired. Open the original PDF again.');
    let blob, page = !ui.page.value && (mode === 'original' || record.state !== 'complete') ? 1 : pageInput(), key;
    if (mode === 'original' || record.state !== 'complete') {
      blob = record.source; key = 'original:' + page;
    } else {
      await request('output', { mode });
      if (stale()) return;
      const output = await cache.get(doc);
      if (stale() || !output || output.job !== record.job || output.state !== 'complete' || !output.outputs[mode]) return;
      blob = output.outputs[mode];
      page = record.whole ? record.sourcePages.indexOf(page - 1) + 1 : 1;
      if (page < 1) page = 1;
      key = record.job + ':' + mode + ':' + page;
    }
    if (stale() || renderedKey === key || !(blob instanceof Blob)) return;
    const nextURL = URL.createObjectURL(blob);
    const frame = document.createElement('iframe');
    frame.src = nextURL + '#page=' + page;
    frame.title = mode === 'original' ? 'Original PDF' : mode === 'dual' ? 'Original and translated PDF' : 'Translated PDF';
    ui.document.replaceChildren(frame);
    // The prior native PDF frame is removed before its object URL is revoked.
    if (currentBlobURL) URL.revokeObjectURL(currentBlobURL);
    currentBlobURL = nextURL; renderedKey = key;
  }
  function applyInfo(info) {
    if (info.pageCount) { ui.page.max = String(info.pageCount); ui['page-count'].textContent = '/ ' + info.pageCount; }
    currentJob = info.job;
    showProgress(info.state === 'running' ? core.safeProgress(info.progress) || { stage: 'preparing' } : null);
  }
  async function poll(expected) {
    if (expected !== generation || closed) return;
    try {
      const info = await request('status');
      if (expected !== generation || closed) return;
      applyInfo(info);
      if (info.state === 'running') { interval = setTimeout(() => poll(expected), 750); return; }
      busy(false);
      if (info.state === 'complete') await display(ui.mode.value, expected);
    } catch (error) {
      if (expected === generation && !closed) { busy(false); showError(error.message); }
    }
  }
  async function start() {
    const expected = ++generation;
    clearTimeout(interval); showError();
    try {
      const page = pageInput();
      busy(true);
      const info = await request('start', { page, whole: ui.scope.value === 'all', source, target });
      if (expected !== generation || closed) return;
      applyInfo(info);
      await poll(expected);
    } catch (error) {
      if (expected === generation && !closed) { busy(false); showError(error.message); }
    }
  }
  ui.translate.addEventListener('click', start);
  ui.mode.addEventListener('change', () => display(ui.mode.value).catch(error => showError(error.message)));
  ui.scope.addEventListener('change', () => { ui.page.hidden = ui['page-count'].hidden = ui.scope.value === 'all'; });
  ui.direction.addEventListener('click', () => {
    [source, target] = [target, source]; ui.direction.textContent = source === 'en' ? 'EN → 中' : '中 → EN';
  });
  ui.cancel.addEventListener('click', async () => {
    ++generation; clearTimeout(interval); busy(false);
    try { await request('cancel'); } catch (error) { showError(error.message); }
  });
  ui.restore.addEventListener('click', () => request('restore').catch(error => showError(error.message)));
  window.addEventListener('pagehide', () => {
    closed = true; ++generation; clearTimeout(interval);
    showProgress(null);
    if (currentBlobURL) URL.revokeObjectURL(currentBlobURL);
  }, { once: true });
  async function initialize() {
    if (!core.validID(doc)) throw new Error('Open a PDF, then use ⌥⇧X.');
    const info = await request('info');
    if (closed) return;
    document.title = info.title + ' · PDF'; ui.title.textContent = info.title;
    ui.page.value = Number.isInteger(info.page) ? String(info.page) : ''; ui.scope.value = info.whole ? 'all' : 'page';
    ui.page.hidden = ui['page-count'].hidden = info.whole;
    source = info.source; target = info.target; ui.direction.textContent = source === 'en' ? 'EN → 中' : '中 → EN';
    applyInfo(info);
    await display(info.state === 'complete' ? ui.mode.value : 'original');
    if (info.state === 'running') { busy(true); await poll(generation); }
    else if (info.state === 'idle' && Number.isInteger(info.page)) await start();
  }
  initialize().catch(error => { busy(false); showError(error.message); });
})();
