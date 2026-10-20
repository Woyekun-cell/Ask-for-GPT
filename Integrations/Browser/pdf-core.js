'use strict';

// Shared only by the extension worker and its private PDF page. No content
// script can access this database, and it contains no pairing credentials.
(() => {
  const MAX_PDF = 150 * 1024 * 1024;
  const MAX_OUTPUT = 450 * 1024 * 1024;
  const MAX_CACHE = 1536 * 1024 * 1024;
  const MAX_AGE = 24 * 60 * 60 * 1000;
  const ID = /^[0-9a-f]{32}$/;
  function validID(id) { return typeof id === 'string' && ID.test(id); }
  function sourceURL(raw) {
    try {
      const url = new URL(raw);
      if (!['https:', 'http:', 'file:'].includes(url.protocol) || url.username || url.password ||
          (url.protocol === 'file:' && url.hostname && url.hostname !== 'localhost')) return null;
      return url;
    } catch { return null; }
  }
  function pdfCandidate(raw) {
    const url = sourceURL(raw);
    return !!url && /\.pdf$/i.test(url.pathname);
  }
  function pageFromURL(raw) {
    const match = /(?:^|[&#])page=(\d+)(?:&|$)/i.exec(new URL(raw).hash);
    return match && Number(match[1]) >= 1 && Number(match[1]) <= 2000 ? Number(match[1]) : null;
  }
  function validDirection(source, target) {
    return (source === 'en' && target === 'zh-Hans') || (source === 'zh-Hans' && target === 'en');
  }
  function viewerURL(extensionURL, id) { return extensionURL('pdf-reader.html') + '?doc=' + id; }
  function isViewerURL(raw, extensionURL, id) {
    if (!validID(id)) return false;
    return raw === viewerURL(extensionURL, id);
  }
  function validStatus(value, expectedID) {
    return value && validID(value.id) && (!expectedID || value.id === expectedID) &&
      ['running', 'complete', 'failed', 'cancelled'].includes(value.state) &&
      Number.isInteger(value.pageCount) && value.pageCount >= 1 && value.pageCount <= 2000 &&
      Array.isArray(value.sourcePages) && value.sourcePages.length > 0 && value.sourcePages.length <= value.pageCount &&
      value.sourcePages.every((page, i, all) => Number.isInteger(page) && page >= 0 && page < value.pageCount &&
        (i === 0 || page > all[i - 1]));
  }
  function safeProgress(value, expectedTotal) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const keys = Object.keys(value);
    if (['preparing', 'layout'].includes(value.stage) && keys.length === 1 && keys[0] === 'stage') {
      return { stage: value.stage };
    }
    if (value.stage !== 'translating' || keys.length !== 3 ||
        !keys.every(key => ['stage', 'completed', 'total'].includes(key)) ||
        !Number.isInteger(value.completed) || !Number.isInteger(value.total) ||
        value.total < 1 || value.total > 2000 || value.completed < 0 || value.completed > value.total ||
        (expectedTotal !== undefined && value.total !== expectedTotal)) return undefined;
    return { stage: 'translating', completed: value.completed, total: value.total };
  }
  async function pdfBlob(response, maximum, signal) {
    if (!response.ok) throw new Error(response.status === 401 ? 'UNPAIRED' : 'PDF_SOURCE');
    const declared = Number(response.headers.get('content-length'));
    if (declared > maximum) { await response.body?.cancel().catch(() => {}); throw new Error('PDF_TOO_LARGE'); }
    const chunks = [];
    let bytes = 0;
    if (!response.body?.getReader) throw new Error('PDF_SOURCE');
    const reader = response.body.getReader();
    try {
      for (;;) {
        if (signal?.aborted) throw new Error('CANCELLED');
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maximum) throw new Error('PDF_TOO_LARGE');
        chunks.push(next.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    const blob = new Blob(chunks, { type: 'application/pdf' });
    const prefix = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
    // The PDF header may legally follow a short binary prefix.
    let header = false;
    for (let i = 0; i <= prefix.length - 5; i += 1) {
      if (prefix[i] === 37 && prefix[i + 1] === 80 && prefix[i + 2] === 68 && prefix[i + 3] === 70 && prefix[i + 4] === 45) { header = true; break; }
    }
    if (!header || bytes < 8) throw new Error('PDF_SOURCE');
    return blob;
  }
  function recordBytes(record) {
    return (record.source?.size || 0) + Object.values(record.outputs || {}).reduce((sum, value) => sum + (value?.size || 0), 0);
  }
  function retained(records, preserveID, now = Date.now()) {
    const sorted = records.slice().sort((a, b) => (b.id === preserveID) - (a.id === preserveID) || b.updated - a.updated);
    const keep = new Set();
    let bytes = 0;
    for (const record of sorted) {
      const size = recordBytes(record);
      if (!validID(record.id) || size > MAX_CACHE || now - record.updated > MAX_AGE || keep.size >= 4 || bytes + size > MAX_CACHE) continue;
      keep.add(record.id); bytes += size;
    }
    return keep;
  }
  class Cache {
    constructor(indexedDB) { this.indexedDB = indexedDB; }
    async database() {
      if (!this.promise) this.promise = new Promise((resolve, reject) => {
        const request = this.indexedDB.open('askgpt-pdf-reader-v1', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('documents', { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('PDF_CACHE'));
      }).catch(error => { this.promise = undefined; throw error; });
      return this.promise;
    }
    async run(mode, operation) {
      const db = await this.database();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('documents', mode);
        let result;
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = transaction.onabort = () => reject(new Error('PDF_CACHE'));
        operation(transaction.objectStore('documents'), value => { result = value; });
      });
    }
    get(id) { return this.run('readonly', (store, done) => { const r = store.get(id); r.onsuccess = () => done(r.result); }); }
    all() { return this.run('readonly', (store, done) => { const r = store.getAll(); r.onsuccess = () => done(r.result); }); }
    remove(id) { return this.run('readwrite', store => store.delete(id)); }
    async put(record) {
      if (!validID(record.id) || recordBytes(record) > MAX_CACHE) throw new Error('PDF_CACHE');
      const records = (await this.all()).filter(value => value.id !== record.id).concat(record);
      const keep = retained(records, record.id);
      if (!keep.has(record.id)) throw new Error('PDF_CACHE');
      const removed = records.filter(previous => !keep.has(previous.id));
      await this.run('readwrite', store => {
        for (const previous of removed) store.delete(previous.id);
        store.put(record);
      });
      return removed;
    }
    async prune() {
      const records = await this.all(), keep = retained(records);
      const removed = records.filter(record => !keep.has(record.id));
      await this.run('readwrite', store => { for (const record of removed) store.delete(record.id); });
      return removed;
    }
  }
  globalThis.AskGPTPDF = { MAX_PDF, MAX_OUTPUT, MAX_CACHE, MAX_AGE, validID, sourceURL, pdfCandidate,
    pageFromURL, validDirection, viewerURL, isViewerURL, validStatus, safeProgress, pdfBlob, recordBytes, retained, Cache };
})();
