'use strict';

importScripts('pdf-core.js', 'pdf-worker.js');

// Only this worker reads the exported pairing token. Never forward config,
// headers, response bodies, or native errors to the content script.
const BASE = 'http://127.0.0.1:43792';
const PREFIX = 'askgpt.inline.';
const flights = new Map();
const tabTransactions = new Map();
let configuration;

function transaction(tabId, operation) {
  const previous = tabTransactions.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  tabTransactions.set(tabId, current);
  current.finally(() => { if (tabTransactions.get(tabId) === current) tabTransactions.delete(tabId); }).catch(() => {});
  return current;
}

function urlKey(raw) {
  try { const url = new URL(raw); url.hash = ''; return url.href; } catch { return ''; }
}
function webURL(raw) {
  try { return ['http:', 'https:'].includes(new URL(raw).protocol); } catch { return false; }
}
function safeError(code) {
  const errors = {
    UNPAIRED: 'Connect Ask for GPT',
    INACTIVE: 'Paused · resume',
    UNAVAILABLE: 'Ask for GPT offline',
    NATIVE_UNAVAILABLE: 'Language pack unavailable',
    BUSY: 'Busy · retry',
    TIMEOUT: 'Timed out · retry',
    FAILED: 'Translation failed · retry',
    INVALID: 'Unsupported paragraph',
    CANCELLED: ''
  };
  return { ok: false, code, error: errors[code] ?? errors.FAILED };
}
async function config() {
  if (!configuration) {
    configuration = (async () => {
      const response = await fetch(chrome.runtime.getURL('connection.local.json'), { cache: 'no-store' });
      if (!response.ok) throw new Error('UNPAIRED');
      const value = await response.json();
      if (value.version !== 1 || value.endpoint !== BASE || value.extensionID !== chrome.runtime.id ||
          typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value.token)) throw new Error('UNPAIRED');
      return { token: value.token };
    })().catch(() => { configuration = undefined; throw new Error('UNPAIRED'); });
  }
  return configuration;
}
async function session(tabId) {
  return (await chrome.storage.session.get(PREFIX + tabId))[PREFIX + tabId];
}
async function storeSession(tabId, value) { await chrome.storage.session.set({ [PREFIX + tabId]: value }); }
function abortSession(id) {
  for (const [key, request] of flights) {
    if (request.sessionId === id) { request.controller.abort(); flights.delete(key); }
  }
}
async function revoke(tabId, notify = true) {
  const current = await session(tabId);
  if (!current) return;
  abortSession(current.id);
  await chrome.storage.session.remove(PREFIX + tabId);
  if (notify) await chrome.tabs.sendMessage(tabId, { type: 'INLINE_RESTORE', sessionId: current.id },
    { documentId: current.documentId }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}
async function validated(sender, message, requireRunning = true) {
  if (sender.id !== chrome.runtime.id || !sender.tab || !Number.isInteger(sender.tab.id) || sender.frameId !== 0 ||
      typeof message.sessionId !== 'string') throw new Error('INACTIVE');
  const current = await session(sender.tab.id);
  if (!current || current.id !== message.sessionId || current.documentId !== sender.documentId ||
      (requireRunning && (current.paused || current.blocked || urlKey(sender.url) !== current.url))) throw new Error('INACTIVE');
  const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
  if (!tab || urlKey(tab.url) !== current.url) throw new Error('INACTIVE');
  return current;
}
function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('CANCELLED')); return; }
    const done = () => { signal.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(done, milliseconds);
    const cancel = () => { clearTimeout(timer); reject(new Error('CANCELLED')); };
    signal.addEventListener('abort', cancel, { once: true });
  });
}
async function translate(message, sender) {
  const current = await validated(sender, message);
  if (typeof message.id !== 'string' || !/^[\x21-\x7e]{1,80}$/.test(message.id) ||
      typeof message.text !== 'string' || !message.text.trim() || Array.from(message.text).length > 1800 ||
      !((message.source === 'en' && message.target === 'zh-Hans') ||
        (message.source === 'zh-Hans' && message.target === 'en'))) return safeError('INVALID');
  const key = current.id + ':' + message.id;
  if (flights.has(key) || [...flights.values()].some(value => value.sessionId === current.id)) return safeError('BUSY');
  const controller = new AbortController();
  flights.set(key, { sessionId: current.id, controller });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 12_000);
  try {
    const credentials = await config();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await validated(sender, message);
      if (controller.signal.aborted) throw new Error('CANCELLED');
      const response = await fetch(BASE + '/v1/inline/translate', {
        method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
        headers: { Authorization: 'Bearer ' + credentials.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: message.id, text: message.text, source: message.source, target: message.target })
      });
      if ([502, 503].includes(response.status)) {
        const failure = await response.json().catch(() => ({}));
        if (failure.error?.code === 'translation_busy') {
          if (attempt < 2) { await delay(attempt === 0 ? 150 : 400, controller.signal); continue; }
          return safeError('BUSY');
        }
        return safeError(failure.error?.code === 'native_unavailable' ? 'NATIVE_UNAVAILABLE' : 'FAILED');
      }
      if (!response.ok) return safeError(response.status === 504 ? 'TIMEOUT' : response.status === 401 ? 'UNPAIRED' : 'FAILED');
      const value = await response.json();
      if (value.id !== message.id || typeof value.translation !== 'string' || !value.translation.trim() ||
          Array.from(value.translation).length > 12_000) return safeError('INVALID');
      await validated(sender, message);
      if (controller.signal.aborted) throw new Error('CANCELLED');
      return { ok: true, id: message.id, translation: value.translation };
    }
    return safeError('BUSY');
  } catch (error) {
    if (timedOut) return safeError('TIMEOUT');
    if (controller.signal.aborted) return safeError('CANCELLED');
    return safeError(['UNPAIRED', 'INACTIVE'].includes(error.message) ? error.message : 'UNAVAILABLE');
  } finally {
    clearTimeout(timer);
    if (flights.get(key)?.controller === controller) flights.delete(key);
  }
}
async function control(message, sender) {
  const current = await validated(sender, message, false);
  if (message.action === 'restore') { await revoke(sender.tab.id, false); return { ok: true }; }
  if (message.action === 'cancel-block') {
    const request = flights.get(current.id + ':' + message.id);
    request?.controller.abort();
    return { ok: true };
  }
  if (!['pause', 'resume'].includes(message.action)) return safeError('INVALID');
  if (message.action === 'resume') {
    const tab = await chrome.tabs.get(sender.tab.id);
    if (!tab.active || urlKey(tab.url) !== current.url || current.blocked) return safeError('INACTIVE');
  } else { abortSession(current.id); }
  await storeSession(sender.tab.id, { ...current, paused: message.action === 'pause' });
  await chrome.action.setBadgeText({ tabId: sender.tab.id, text: message.action === 'pause' ? 'Ⅱ' : 'ON' }).catch(() => {});
  return { ok: true };
}
const pdf = AskGPTPDFWorker.install({ chrome, fetch, config });
pdf.prune().catch(() => {});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'PDF_READER') {
    pdf.message(message, sender).then(sendResponse, () => sendResponse(pdf.error('PDF_FAILED')));
    return true;
  }
  if (!message || !['INLINE_TRANSLATE', 'INLINE_CONTROL'].includes(message.type)) return false;
  (message.type === 'INLINE_TRANSLATE' ? translate(message, sender) :
    transaction(sender.tab?.id, () => control(message, sender)))
    .then(sendResponse, error => sendResponse(safeError(error.message === 'INACTIVE' ? 'INACTIVE' : 'FAILED')));
  return true;
});
async function toggle(tab, fileGrant) {
  if (!Number.isInteger(tab?.id)) return;
  if (await pdf.toggle(tab)) return;
  if (pdf.candidate(tab.url)) { await pdf.open(tab, fileGrant); return; }
  const authorized = await chrome.tabs.get(tab.id).catch(() => null);
  if (!authorized?.active || urlKey(authorized.url) !== urlKey(tab.url)) throw new Error('INACTIVE');
  const existing = await session(tab.id);
  if (existing) { await revoke(tab.id); return; }
  if (!webURL(tab.url)) throw new Error('Open a web page or a PDF.');
  let result;
  try { result = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] },
    world: 'ISOLATED', files: ['content.js'] }); }
  catch { await pdf.open(tab); return; }
  const documentId = result.find(value => value.frameId === 0)?.documentId;
  if (!documentId) throw new Error('This page does not allow inline translation. For PDF, use Zotero.');
  const currentTab = await chrome.tabs.get(tab.id).catch(() => null);
  if (!currentTab || urlKey(currentTab.url) !== urlKey(tab.url)) throw new Error('INACTIVE');
  const current = { id: crypto.randomUUID(), documentId, url: urlKey(tab.url), paused: false, blocked: false };
  await storeSession(tab.id, current);
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'INLINE_START', sessionId: current.id }, { documentId });
    if (!response?.ok) throw new Error('Inline translation could not start.');
    if (response.supported === false) { await revoke(tab.id); await pdf.open(tab); return; }
    await chrome.action.setBadgeText({ tabId: tab.id, text: response.supported === false ? 'PDF' : 'ON' });
  } catch (error) { await revoke(tab.id); throw error; }
}
function invoke(tab, requestFile = true) {
  const fileGrant = requestFile ? pdf.prepare(tab) : null;
  transaction(tab?.id, () => toggle(tab, fileGrant)).catch(async error => {
    if (Number.isInteger(tab?.id)) {
      await chrome.action.setBadgeText({ tabId: tab.id, text: '!' }).catch(() => {});
      await chrome.action.setTitle({ tabId: tab.id,
        title: pdf.error(error.message).error || 'Open a web page or a PDF, then retry.' }).catch(() => {});
    }
  });
}
chrome.action.onClicked.addListener(invoke);
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-inline') return;
  if (Number.isInteger(tab?.id)) invoke(tab);
  else chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => invoke(tabs[0], false));
});
chrome.tabs.onRemoved.addListener(tabId => {
  pdf.dispose(tabId).catch(() => {});
  transaction(tabId, () => revoke(tabId, false)).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  pdf.tabUpdated(tabId, change, tab).catch(() => {});
  if (change.status === 'loading') { transaction(tabId, () => revoke(tabId)).catch(() => {}); return; }
  if (change.url) transaction(tabId, async () => {
    const value = await session(tabId);
    if (value && urlKey(tab.url) !== value.url) await revoke(tabId);
  }).catch(() => {});
});
// Authorized documents own their work until stop, navigation, or close. Moving
// focus to another tab/window does not retire the first document's session.
