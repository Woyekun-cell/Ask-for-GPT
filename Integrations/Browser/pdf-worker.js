'use strict';

(() => {
  const BASE = 'http://127.0.0.1:43795';
  const PREFIX = 'askgpt.pdf.';
  const errors = {
    PDF_SOURCE: 'This PDF could not be read. Open the PDF directly and retry.',
    PDF_TOO_LARGE: 'PDF exceeds the 150 MB limit.',
    PDF_FILE_ACCESS: 'Enable “Allow access to file URLs” for Ask for GPT Inline in Chrome Extensions, then retry.',
    PDF_CACHE: 'PDF storage is full. Close an older translation and retry.',
    PDF_FAILED: 'PDF translation failed. Retry or choose another page.',
    PDF_SCANNED: 'This PDF needs OCR before translation.',
    PDF_EXPIRED: 'This translation has expired. Open the original PDF again.',
    PDF_PAGE: 'Choose a valid page number.',
    PDF_BUSY: 'Another PDF is being translated. Retry shortly.',
    PDF_RUNTIME: 'Open Ask for GPT to prepare PDF translation.',
    UNAVAILABLE: 'Open Ask for GPT, then retry.',
    UNPAIRED: 'Reconnect the Chrome extension from Ask for GPT.',
    INACTIVE: 'Return to this PDF and retry.',
    CANCELLED: ''
  };
  const failure = value => {
    const code = Object.prototype.hasOwnProperty.call(errors, value) ? value : 'PDF_FAILED';
    return { ok: false, code, error: errors[code] };
  };
  function install({ chrome, fetch, config, cache = new AskGPTPDF.Cache(globalThis.indexedDB), now = Date.now }) {
    const core = AskGPTPDF, launches = new Map(), operations = new Map();
    const extensionURL = name => chrome.runtime.getURL(name);
    let cacheQueue = Promise.resolve();
    function exclusive(operation) {
      const pending = cacheQueue.catch(() => {}).then(operation);
      cacheQueue = pending.catch(() => {});
      return pending;
    }
    async function recordFor(tabId) { return (await chrome.storage.session.get(PREFIX + tabId))[PREFIX + tabId]; }
    async function setRecord(tabId, record) { await chrome.storage.session.set({ [PREFIX + tabId]: record }); }
    async function read(id) {
      const record = await cache.get(id);
      if (!record || now() - record.updated > core.MAX_AGE) throw new Error('PDF_EXPIRED');
      return record;
    }
    async function currentSource(tab, requireActive = false) {
      const actual = await chrome.tabs.get(tab.id).catch(() => null);
      if (!actual || (requireActive && !actual.active) || actual.url !== tab.url || !core.sourceURL(actual.url)) throw new Error('INACTIVE');
      return actual;
    }
    // Must run synchronously in action/onCommand, before a transaction or await
    // loses Chrome's transient permission-request user gesture.
    function prepare(tab) {
      if (core.sourceURL(tab?.url)?.protocol !== 'file:' || !Number.isInteger(tab?.id)) return null;
      try { return chrome.permissions.request({ origins: ['file:///*'] }).catch(() => false); }
      catch { return Promise.resolve(false); }
    }
    async function filePermission(tab, grant) {
      if (core.sourceURL(tab.url)?.protocol !== 'file:') return;
      if (grant && !(await grant)) throw new Error('PDF_FILE_ACCESS');
      if (!(await chrome.permissions.contains({ origins: ['file:///*'] }))) throw new Error('PDF_FILE_ACCESS');
      if (!(await chrome.extension.isAllowedFileSchemeAccess())) throw new Error('PDF_FILE_ACCESS');
    }
    async function local(path, options = {}) {
      const credentials = await config();
      let response;
      try {
        response = await fetch(BASE + path, { ...options, credentials: 'omit', cache: 'no-store', redirect: 'error',
          headers: { ...options.headers, Authorization: 'Bearer ' + credentials.token } });
      } catch (error) { throw new Error(options.signal?.aborted ? 'CANCELLED' : 'UNAVAILABLE'); }
      if (!response.ok) {
        const code = response.status === 401 ? 'UNPAIRED' : response.status === 409 ? 'PDF_BUSY' :
          response.status === 404 ? 'PDF_EXPIRED' : response.status === 503 ? 'PDF_RUNTIME' : 'PDF_FAILED';
        await response.body?.cancel().catch(() => {});
        throw new Error(code);
      }
      return response;
    }
    async function metadata(record) {
      const progress = record.state === 'running' ? core.safeProgress(record.progress, record.sourcePages?.length) : undefined;
      return { ok: true, id: record.id, title: record.title, page: record.page, pageCount: record.pageCount || null,
        source: record.sourceLanguage || 'en', target: record.targetLanguage || 'zh-Hans', whole: !!record.whole,
        job: record.job || null, ready: Object.keys(record.outputs || {}), state: record.state || 'idle',
        ...(progress ? { progress } : {}) };
    }
    async function validate(sender, message, active = false) {
      if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0 ||
          !core.validID(message.doc) || !core.isViewerURL(sender.url, extensionURL, message.doc)) throw new Error('INACTIVE');
      const [tab, session] = await Promise.all([chrome.tabs.get(sender.tab.id).catch(() => null), recordFor(sender.tab.id)]);
      if (!tab || !session || session.id !== message.doc || !core.isViewerURL(tab.url, extensionURL, message.doc) ||
          (active && !tab.active)) throw new Error('INACTIVE');
      const record = await read(message.doc);
      if (record.tabId !== sender.tab.id) throw new Error('INACTIVE');
      return record;
    }
    async function cancelJob(record) {
      if (!core.validID(record.job) || record.state !== 'running') return;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
      try { await local('/v1/pdf/jobs/' + record.job, { method: 'DELETE', signal: controller.signal }).catch(() => {}); }
      finally { clearTimeout(timer); }
    }
    async function put(record) {
      const evicted = await cache.put(record);
      for (const previous of evicted || []) await cancelJob(previous);
    }
    async function dispose(tabId, { remove = true } = {}) {
      launches.get(tabId)?.abort(); launches.delete(tabId);
      operations.get(tabId)?.abort(); operations.delete(tabId);
      const session = await recordFor(tabId);
      if (!session) return;
      await chrome.storage.session.remove(PREFIX + tabId);
      const record = await cache.get(session.id);
      if (record) { await cancelJob(record); if (remove) await exclusive(() => cache.remove(record.id)); }
    }
    async function open(tab, grant) {
      if (!Number.isInteger(tab?.id) || !core.sourceURL(tab.url)) throw new Error('PDF_SOURCE');
      // The initial gesture authorizes this tab and URL. Focus can move while
      // importing bytes, but navigation or closing the source still retires it.
      await currentSource(tab, true);
      await filePermission(tab, grant);
      const controller = new AbortController();
      launches.get(tab.id)?.abort(); launches.set(tab.id, controller);
      const timer = setTimeout(() => controller.abort(), 30_000);
      let stagedID, handedOff = false;
      try {
        await config();
        await currentSource(tab);
        if (controller.signal.aborted) throw new Error('CANCELLED');
        const url = core.sourceURL(tab.url); url.hash = '';
        const response = await fetch(url.href, { credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal });
        const source = await core.pdfBlob(response, core.MAX_PDF, controller.signal);
        await currentSource(tab);
        if (controller.signal.aborted) throw new Error('CANCELLED');
        const id = crypto.randomUUID().replaceAll('-', '');
        stagedID = id;
        const record = { id, tabId: tab.id, source, originalURL: tab.url, title: (tab.title || 'PDF').slice(0, 300),
          updated: now(), page: core.pageFromURL(tab.url), outputs: {}, state: 'idle' };
        await exclusive(() => put(record));
        await currentSource(tab);
        if (controller.signal.aborted) throw new Error('CANCELLED');
        await setRecord(tab.id, { id });
        try {
          await currentSource(tab);
          if (controller.signal.aborted) throw new Error('CANCELLED');
          await chrome.tabs.update(tab.id, { url: core.viewerURL(extensionURL, id) });
          handedOff = true;
        }
        catch (error) { await dispose(tab.id); throw error; }
        return true;
      } finally {
        clearTimeout(timer); if (launches.get(tab.id) === controller) launches.delete(tab.id);
        if (stagedID && !handedOff) await exclusive(() => cache.remove(stagedID));
      }
    }
    async function start(record, message, sender) {
      if (!Number.isInteger(message.page) || message.page < 1 || message.page > (record.pageCount || 2000) ||
          typeof message.whole !== 'boolean' || !core.validDirection(message.source, message.target)) throw new Error('PDF_PAGE');
      operations.get(record.tabId)?.abort();
      const controller = new AbortController(); operations.set(record.tabId, controller);
      try {
        await cancelJob(record);
        // message() already checked the initiating tab was active. Retiring an
        // older job must not revoke that authorization if focus moves meanwhile.
        await validate(sender, message);
        record = { ...record, page: message.page, whole: message.whole, sourceLanguage: message.source,
          targetLanguage: message.target, outputs: {}, state: 'idle', job: null, progress: undefined, updated: now() };
        await exclusive(() => put(record));
        const response = await local('/v1/pdf/jobs', { method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/pdf', 'X-AskGPT-Pages': message.whole ? 'all' : String(message.page),
            'X-AskGPT-Source': message.source, 'X-AskGPT-Target': message.target }, body: record.source });
        const status = await response.json();
        if (!core.validStatus(status)) throw new Error('PDF_FAILED');
        record = { ...record, job: status.id, state: status.state, pageCount: status.pageCount, sourcePages: status.sourcePages,
          progress: status.state === 'running' ? core.safeProgress(status.progress, status.sourcePages.length) : undefined };
        // Navigation/close can race the upload response. Cancel the now-known
        // service job rather than leaving an orphan using the PDF engine.
        try { await validate(sender, message); if (controller.signal.aborted) throw new Error('CANCELLED'); }
        catch (error) { await cancelJob(record); throw error; }
        await exclusive(() => put(record));
        return metadata(record);
      } finally { if (operations.get(record.tabId) === controller) operations.delete(record.tabId); }
    }
    async function status(record, sender, message) {
      if (!core.validID(record.job)) return metadata(record);
      const response = await local('/v1/pdf/jobs/' + record.job);
      const value = await response.json();
      if (!core.validStatus(value, record.job)) throw new Error('PDF_FAILED');
      await validate(sender, message);
      record = await exclusive(async () => {
        const current = await read(record.id);
        if (current.job !== record.job) throw new Error('CANCELLED');
        if (current.state === 'cancelled') return current;
        const next = { ...current, state: value.state, pageCount: value.pageCount, sourcePages: value.sourcePages,
          progress: value.state === 'running' ? core.safeProgress(value.progress, value.sourcePages.length) : undefined, updated: now() };
        await put(next); return next;
      });
      if (record.state === 'cancelled') return metadata(record);
      if (value.state === 'failed') throw new Error(value.error === 'scanned_pdf_unsupported' ? 'PDF_SCANNED' : 'PDF_FAILED');
      return metadata(record);
    }
    async function output(record, sender, message) {
      if (!['mono', 'dual'].includes(message.mode) || record.state !== 'complete' || !core.validID(record.job)) throw new Error('PDF_FAILED');
      if (!record.outputs[message.mode]) {
        const response = await local('/v1/pdf/jobs/' + record.job + '/' + message.mode + '.pdf');
        const blob = await core.pdfBlob(response, core.MAX_OUTPUT);
        await validate(sender, message);
        // Read again after download so a mode request cannot overwrite another
        // output or a newly started job.
        record = await exclusive(async () => {
          const current = await read(record.id);
          if (current.job !== record.job || current.state !== 'complete') throw new Error('CANCELLED');
          const next = { ...current, outputs: { ...current.outputs, [message.mode]: blob }, updated: now() };
          await put(next); return next;
        });
      }
      return { ok: true, mode: message.mode, job: record.job };
    }
    async function message(message, sender) {
      try {
        let record = await validate(sender, message, message.action === 'start');
        switch (message.action) {
          case 'info': return metadata(record);
          case 'start': return await start(record, message, sender);
          case 'status': return await status(record, sender, message);
          case 'output': return await output(record, sender, message);
          case 'cancel':
            operations.get(record.tabId)?.abort(); await cancelJob(record);
            record = await exclusive(async () => {
              const current = await read(record.id);
              if (current.job !== record.job) throw new Error('CANCELLED');
              const next = { ...current, state: 'cancelled', progress: undefined, updated: now() };
              await put(next); return next;
            });
            return metadata(record);
          case 'restore': {
            const original = core.sourceURL(record.originalURL);
            if (!original) throw new Error('PDF_SOURCE');
            await dispose(record.tabId);
            await chrome.tabs.update(record.tabId, { url: original.href });
            return { ok: true };
          }
          default: throw new Error('INACTIVE');
        }
      } catch (error) { return failure(error.message); }
    }
    async function tabUpdated(tabId, change, tab) {
      const session = await recordFor(tabId);
      if (!session) { if (change.url || change.status === 'loading') launches.get(tabId)?.abort(); return; }
      // The source→owned page navigation is expected. Only a different URL
      // retires its job/source bytes. Reloading the owned page stays usable.
      if (change.url && !core.isViewerURL(tab.url, extensionURL, session.id)) await dispose(tabId);
    }
    async function toggle(tab) {
      const session = await recordFor(tab.id);
      if (!session || !core.isViewerURL(tab.url, extensionURL, session.id)) return false;
      const actual = await chrome.tabs.get(tab.id).catch(() => null);
      if (!actual?.active || actual.url !== tab.url) throw new Error('INACTIVE');
      const record = await read(session.id);
      await dispose(tab.id);
      await chrome.tabs.update(tab.id, { url: record.originalURL });
      return true;
    }
    return { open, prepare, toggle, message, tabUpdated, dispose, candidate: core.pdfCandidate,
      error: failure, prune: () => exclusive(async () => {
        const evicted = await cache.prune();
        for (const previous of evicted || []) await cancelJob(previous);
      }) };
  }
  globalThis.AskGPTPDFWorker = { install };
})();
