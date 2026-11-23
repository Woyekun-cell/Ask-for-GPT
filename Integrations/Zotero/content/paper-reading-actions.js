(function (root) {
  'use strict';
  const ROUTE = '/askgpt/reading-action', MAX_BODY = 128 * 1024, SKEW = 10000;
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const SECTION_NAMES = ['findings', 'design', 'limitations', 'sources'];
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const ligatures = {ﬀ: 'ff', ﬁ: 'fi', ﬂ: 'fl', ﬃ: 'ffi', ﬄ: 'ffl', ﬅ: 'st', ﬆ: 'st'};
  const typography = value => value.replace(/[ﬀ-ﬆ]/gu, c => ligatures[c]).replace(/\u00ad/gu, '')
    .replace(/[\u2010\u2011]/gu, '-').replace(/[\u2018\u2019]/gu, "'").replace(/[\u201c\u201d]/gu, '"').normalize('NFD');
  const word = /[\p{Script=Latin}\p{Script=Greek}\p{M}\d]/u;
  // Native APIs: zotero/zotero reader.js (Reader.open/navigate), data/item.js
  // (setNote/saveTx); text/plain remains a raw string in server/server.js on 9/10.
  const invalid = () => Object.assign(new Error('invalid'), {status: 400});
  const unavailable = () => Object.assign(new Error('unavailable'), {status: 503});
  const missing = () => Object.assign(new Error('missing'), {status: 404});
  const conflict = () => Object.assign(new Error('conflict'), {status: 409});
  function utf8(value) {
    const result = [];
    for (const scalar of value) {
      const n = scalar.codePointAt(0);
      if (n >= 0xd800 && n <= 0xdfff) throw invalid();
      if (n < 128) result.push(n);
      else if (n < 2048) result.push(192 | n >> 6, 128 | n & 63);
      else if (n < 65536) result.push(224 | n >> 12, 128 | n >> 6 & 63, 128 | n & 63);
      else result.push(240 | n >> 18, 128 | n >> 12 & 63, 128 | n >> 6 & 63, 128 | n & 63);
    }
    return Uint8Array.from(result);
  }
  function text(value, maximum) {
    return typeof value === 'string' && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)
      && value.length <= maximum && utf8(value).length <= maximum;
  }
  function keys(value, names) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
  }
  function validate(value) {
    if (!value || typeof value.attachmentID !== 'string' || !/^[1-9][0-9]{0,11}:[A-Z0-9]{8}$/.test(value.attachmentID)) throw invalid();
    if (value.action === 'jump') {
      if (!keys(value, ['action', 'attachmentID', 'page', 'quote']) || !Number.isInteger(value.page)
          || value.page < 1 || value.page > 2000 || !text(value.quote, 6000)) throw invalid();
    } else if (value.action === 'saveNote') {
      if (!keys(value, ['action', 'attachmentID', 'requestID', 'sections']) || !UUID.test(value.requestID)
          || !keys(value.sections, SECTION_NAMES) || !SECTION_NAMES.every(name => text(value.sections[name], 24000))
          || !SECTION_NAMES.some(name => value.sections[name].trim())) throw invalid();
    } else throw invalid();
    return value;
  }
  function rect(value) {
    if (!value || value.length !== 4) return null;
    const local = [value[0], value[1], value[2], value[3]];
    return local.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10000000)
      && local[2] > local[0] && local[3] > local[1] ? local : null;
  }
  function glyphText(chars) {
    let text = '';
    const offsets = [], wraps = new Set();
    function append(value, index) {
      for (const scalar of value) {
        const character = /\s/u.test(scalar) ? ' ' : scalar;
        if (character === ' ' && (!text || /[ \u0000]$/u.test(text))) continue;
        for (let n = 0; n < character.length; n++) offsets.push(index);
        text += character;
      }
    }
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      if (char?.ignorable) continue;
      if (typeof char?.c !== 'string' || char.c.length > 16 || text.length > 300000) return null;
      const value = typography(char.c);
      append(value, i);
      if (char.paragraphBreakAfter) append('\u0000', null);
      else if (char.spaceAfter || char.lineBreakAfter) {
        if (char.lineBreakAfter && /\p{L}-$/u.test(text) && /^\p{L}/u.test(chars[i + 1]?.c || '')) {
          wraps.add(text.length - 1);
        }
        if (!/[-\s]$/u.test(text) && !char.c.endsWith('\u00ad')) append(' ', null);
      }
    }
    const variants = [{text, offsets}];
    if (wraps.size) {
      let unwrapped = '';
      const unwrappedOffsets = [];
      for (let i = 0; i < text.length; i++) {
        if (wraps.has(i)) continue;
        unwrapped += text[i];
        unwrappedOffsets.push(offsets[i]);
      }
      variants.push({text: unwrapped, offsets: unwrappedOffsets});
    }
    return variants;
  }
  function matchGlyphs(variants, needle) {
    let match = null;
    for (const {text, offsets} of variants) {
      for (let start = text.indexOf(needle); start >= 0; start = text.indexOf(needle, start + 1)) {
        const end = start + needle.length;
        const startsMidWord = word.test(needle[0]) && word.test(text[start - 1] || '');
        const endsMidWord = word.test(needle.at(-1)) && word.test(text[end] || '');
        if (startsMidWord || endsMidWord) continue;
        const first = offsets[start], last = offsets[end - 1];
        if (first === null || last === null) continue;
        if (match && (match[0] !== first || match[1] !== last)) return {ambiguous: true};
        match = [first, last];
      }
    }
    return {match};
  }
  function pageGlyphVariants(chars) {
    return chars && Number.isInteger(chars.length) && chars.length <= 100000 ? glyphText(chars) : null;
  }
  function locateInGlyphs(chars, variants, quote, allowPartial) {
    const needle = typography(quote).trim().replace(/\s+/gu, ' ');
    if (!needle) return null;
    let {match, ambiguous} = matchGlyphs(variants, needle);
    if (ambiguous) return {ambiguous: true};
    if (!match && allowPartial && typeof Intl.Segmenter === 'function') {
      // Only use a complete, sufficiently distinctive sentence from the supplied source.
      const sentences = Array.from(new Intl.Segmenter(undefined, {granularity: 'sentence'}).segment(needle), row => row.segment.trim())
        .filter(sentence => /[.!?。！？]$/u.test(sentence)
          && ((sentence.length >= 35 && sentence.split(' ').length >= 5) || sentence.match(/\p{Script=Han}/gu)?.length >= 24))
        .sort((a, b) => b.length - a.length);
      for (const sentence of sentences.slice(0, 8)) {
        const partial = matchGlyphs(variants, sentence);
        if (partial.match) { match = partial.match; break; }
      }
    }
    if (!match) return null;
    const result = [];
    for (let index = match[0]; index <= match[1]; index++) {
      const char = chars[index], current = rect(char.rect);
      if (char.ignorable || !typography(char.c).trim()) continue;
      if (!current) return {unresolved: true};
      const previous = result.at(-1), height = current[3] - current[1];
      if (previous && Math.abs(previous[1] - current[1]) <= height * .3
          && Math.abs(previous[3] - current[3]) <= height * .3 && current[0] >= previous[0]
          && current[0] - previous[2] <= height * 2) {
        previous[0] = Math.min(previous[0], current[0]); previous[1] = Math.min(previous[1], current[1]);
        previous[2] = Math.max(previous[2], current[2]); previous[3] = Math.max(previous[3], current[3]);
      } else result.push(current);
      if (result.length > 256) return {unresolved: true};
    }
    return result.length ? {rects: result, offset: match[0]} : {unresolved: true};
  }
  function locateQuote(chars, quote, {allowPartial = false} = {}) {
    const variants = pageGlyphVariants(chars);
    const match = variants ? locateInGlyphs(chars, variants, quote, allowPartial) : null;
    return match?.unresolved ? null : match;
  }
  function locateQuotes(chars, quotes) {
    const variants = pageGlyphVariants(chars);
    return variants ? quotes.map(quote => locateInGlyphs(chars, variants, quote, false)) : null;
  }
  const escaped = value => value.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  function reply(status, value) {
    return [status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
      JSON.stringify(value || {ok: false, error: status === 403 ? 'forbidden' : status === 400 ? 'invalid_request'
        : status === 404 ? 'paper_unavailable' : status === 409 ? 'request_conflict' : 'reading_action_unavailable'})];
  }
  async function pageChars({view, pdf, index, win, current, Components,
    setTimer = setTimeout, clearTimer = clearTimeout, timeout = 1500}) {
    const realm = value => Components?.utils?.cloneInto ? Components.utils.cloneInto(value, win) : value;
    const cached = () => view._pdfPages?.[index]?.chars;
    if (cached()?.length) return cached();
    const load = async () => {
      if (typeof view._ensureBasicPageData === 'function') {
        try { await view._ensureBasicPageData(index); } catch (_) { /* Try the actual page data below. */ }
        current();
        if (cached()?.length) return cached();
      }
      if (typeof pdf.getPageData === 'function') {
        const data = await pdf.getPageData(realm({pageIndex: index}));
        current();
        return (Components?.utils?.waiveXrays?.(data) ?? data)?.chars ?? null;
      }
      return null;
    };
    let timer;
    try {
      return await Promise.race([load(), new Promise(resolve => { timer = setTimer(() => resolve(null), timeout); })]);
    } catch (_) { current(); return null; }
    finally { clearTimer(timer); }
  }
  function register({Zotero, Services, Components, readConnection, revealOriginal, setTimer = setTimeout,
    clearTimer = clearTimeout, now = Date.now}) {
    const endpoints = Zotero.Server?.Endpoints;
    if (!endpoints || Object.hasOwn(endpoints, ROUTE)) return () => {};
    const used = new Map(), notes = new Map(), overlays = new Map();
    let closed = false, jumpGeneration = 0;
    const check = () => { if (closed) throw unavailable(); };
    const realm = (value, win) => Components?.utils?.cloneInto ? Components.utils.cloneInto(value, win) : value;
    async function attachment(id) {
      const [library, key] = id.split(':');
      const item = await Zotero.Items.getByLibraryAndKeyAsync(Number(library), key);
      check();
      if (!item || item.libraryID !== Number(library) || item.key !== key || item.deleted
          || item.isAttachment?.() !== true || item.isPDFAttachment?.() !== true) throw missing();
      return item;
    }
    async function waitFor(read, current) {
      for (let attempt = 0; attempt < 30; attempt++) {
        current();
        const value = read();
        if (value) return value;
        await Zotero.Promise.delay(40);
      }
      current();
      return read();
    }
    function paint(view, page, rects, pageNumber) {
      const win = view._iframeWindow, doc = win?.document, viewport = page?.viewport;
      if (!doc || !page?.div || typeof win.setTimeout !== 'function') throw unavailable();
      overlays.get(view)?.();
      const overlay = doc.createElementNS(XHTML, 'div');
      overlay.setAttribute('data-askgpt-reading-action', rects ? 'quote' : 'page');
      overlay.setAttribute('role', 'status');
      overlay.setAttribute('aria-label', rects ? '已定位原文选段' : '第 ' + pageNumber + ' 页，未精确定位选段');
      overlay.setAttribute('style', 'position:absolute;inset:0;pointer-events:none;z-index:2147481900;');
      if (rects) {
        if (!viewport || viewport.width <= 0 || viewport.height <= 0) return false;
        for (const r of rects) {
          // Pass primitives to PDF.js to avoid crossing Gecko's native array wrappers.
          if (typeof viewport.convertToViewportPoint !== 'function') return false;
          const start = viewport.convertToViewportPoint(r[0], r[1]), end = viewport.convertToViewportPoint(r[2], r[3]);
          const box = rect([Math.min(start[0], end[0]), Math.min(start[1], end[1]),
            Math.max(start[0], end[0]), Math.max(start[1], end[1])]);
          if (!box) return false;
          const marker = doc.createElementNS(XHTML, 'div');
          marker.setAttribute('style', 'position:absolute;pointer-events:none;background:rgb(255 208 70 / 38%);outline:1px solid #946900;border-radius:2px;');
          for (const [name, value] of [['left', box[0] / viewport.width * 100], ['top', box[1] / viewport.height * 100],
            ['width', (box[2] - box[0]) / viewport.width * 100], ['height', (box[3] - box[1]) / viewport.height * 100]]) marker.style.setProperty(name, value + '%');
          overlay.appendChild(marker);
        }
      } else {
        overlay.setAttribute('style', 'position:absolute;inset:2px;pointer-events:none;z-index:2147481900;outline:3px solid #c78c00;background:rgb(255 208 70 / 5%);');
        const label = doc.createElementNS(XHTML, 'span');
        label.textContent = '第 ' + pageNumber + ' 页 · 未精确定位选段';
        label.setAttribute('style', 'position:absolute;top:8px;left:8px;padding:4px 8px;background:#fff3c4;color:#493200;font:13px sans-serif;');
        overlay.appendChild(label);
      }
      let timer, callback;
      const bus = win.PDFViewerApplication?.eventBus;
      const clear = () => {
        win.clearTimeout?.(timer); overlay.remove();
        win.removeEventListener?.('pagehide', callback);
        if (bus?.on && bus?.off) bus.off('rotationchanging', callback);
        if (overlays.get(view) === clear) overlays.delete(view);
      };
      overlays.set(view, clear);
      page.div.appendChild(overlay);
      callback = Components?.utils?.exportFunction ? Components.utils.exportFunction(clear, win) : clear;
      win.addEventListener?.('pagehide', callback);
      if (bus?.on && bus?.off) bus.on('rotationchanging', callback);
      timer = win.setTimeout(callback, 3000);
      return true;
    }
    async function jump(value) {
      const generation = ++jumpGeneration;
      const latest = () => { check(); if (jumpGeneration !== generation) throw unavailable(); };
      const item = await attachment(value.attachmentID);
      latest();
      const focused = Services.focus?.activeWindow || Zotero.getMainWindow?.();
      const tab = focused?.Zotero_Tabs?.selectedID;
      const selected = (tab && Zotero.Reader.getByTabID?.(tab))
        || Zotero.Reader._readers?.find(candidate => candidate._window === focused && !candidate.tabID && !candidate._isTabClosed);
      const selectedReader = selected?.itemID === item.id && !selected._isTabClosed ? selected : null;
      // A link clicked inside the current reader should not focus or reselect the tab.
      let reader = selectedReader || await Zotero.Reader.open(item.id);
      latest();
      reader ||= await waitFor(() => Zotero.Reader._readers?.find(candidate => candidate.itemID === item.id && !candidate._isTabClosed), latest);
      if (!reader || reader.itemID !== item.id || reader.type !== 'pdf') throw unavailable();
      const sameReader = () => {
        latest();
        if (reader.itemID !== item.id || reader._isTabClosed
          || reader.tabID && reader._window?.Zotero_Tabs?.selectedID && reader._window.Zotero_Tabs.selectedID !== reader.tabID) {
          throw unavailable();
        }
      };
      await reader._initPromise;
      sameReader();
      await revealOriginal?.(reader);
      const app = await waitFor(() => {
        const candidate = reader._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication;
        return candidate?.pdfDocument && candidate.pdfViewer?.pagesCount === candidate.pdfDocument.numPages ? candidate : null;
      }, sameReader);
      const view = reader._internalReader?._primaryView, win = view?._iframeWindow;
      const viewer = app?.pdfViewer, pdf = app?.pdfDocument, index = value.page - 1;
      if (!view || !pdf || !Number.isInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > 2000
          || viewer?.pagesCount !== pdf.numPages || index >= pdf.numPages) throw invalid();
      const current = () => {
        sameReader();
        if (view._iframeWindow?.PDFViewerApplication?.pdfDocument !== pdf
          || reader._internalReader?._primaryView !== view || view._destroyed) throw unavailable();
      };
      const readerWindow = reader._iframeWindow || win;
      if (typeof view.navigate !== 'function') throw unavailable();
      await view.navigate(realm({pageIndex: index}, readerWindow));
      current();
      const chars = value.quote.trim() ? await pageChars({view, pdf, index, win, current, Components, setTimer, clearTimer}) : null;
      current();
      const rects = locateQuote(chars, value.quote, {allowPartial: true})?.rects;
      const page = await waitFor(() => {
        const candidate = viewer.getPageView?.(index) ?? viewer._pages?.[index];
        return candidate?.div && candidate.viewport ? candidate : null;
      }, current);
      let precise = false;
      if (rects && typeof view.navigateToPosition === 'function') {
        try {
          await view.navigateToPosition(realm({pageIndex: index, rects}, readerWindow),
            realm({block: 'center', inline: 'nearest', behavior: 'instant'}, readerWindow));
          current();
          if (page) precise = paint(view, page, rects, value.page);
        } catch (_) { current(); }
      }
      if (!precise && page) paint(view, page, null, value.page);
      return {ok: true, precision: precise ? 'quote' : 'page'};
    }
    async function saveNote(value) {
      const requestID = value.requestID.toLowerCase();
      const fingerprint = JSON.stringify([value.attachmentID, ...SECTION_NAMES.map(name => value.sections[name])]);
      const previous = notes.get(requestID);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw conflict();
        return previous.promise;
      }
      if ([...notes.values()].filter(entry => !entry.done).length >= 4) throw conflict();
      while (notes.size >= 64) {
        const oldest = [...notes].find(([, entry]) => entry.done);
        if (!oldest) throw conflict();
        notes.delete(oldest[0]);
      }
      const entry = {fingerprint, done: false};
      entry.promise = (async () => {
        const item = await attachment(value.attachmentID);
        if (!item.parentID) throw missing();
        const parent = await Zotero.Items.getAsync(item.parentID);
        check();
        if (!parent || parent.id !== item.parentID || parent.libraryID !== item.libraryID || parent.deleted
            || parent.isRegularItem?.() !== true) throw missing();
        if (parent.isEditable?.() !== true || Zotero.Libraries.get(item.libraryID)?.editable === false) throw unavailable();
        const labels = ['主要发现', '研究设计', '局限与疑问', '原文依据'];
        const html = '<h1>论文阅读笔记</h1>' + SECTION_NAMES.map((name, i) => '<h2>' + labels[i] + '</h2><p>'
          + escaped(value.sections[name]).replace(/\r\n?|\n/g, '<br>') + '</p>').join('');
        check();
        const note = new Zotero.Item('note');
        note.libraryID = item.libraryID; note.parentID = parent.id; note.setNote(html);
        await note.saveTx();
        if (typeof note.key !== 'string' || !/^[A-Z0-9]{8}$/.test(note.key)) throw unavailable();
        return {ok: true, noteKey: note.key};
      })();
      notes.set(requestID, entry);
      try { const result = await entry.promise; entry.done = true; return result; }
      catch (error) { if (notes.get(requestID) === entry) notes.delete(requestID); throw error; }
    }
    async function handle(request) {
      try {
        check();
        const {headers, data} = request;
        if (request.method !== 'POST' || request.pathname !== ROUTE || request.searchParams?.toString()
            || !headers || headers.host !== '127.0.0.1:23119' || ['origin', 'referer', 'authorization', 'sec-fetch-site', 'transfer-encoding'].some(name => name in headers)
            || headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'text/plain'
            || typeof data !== 'string' || data.length > MAX_BODY) return reply(403);
        const body = utf8(data);
        if (!body.length || body.length > MAX_BODY || headers['content-length'] !== String(body.length)) return reply(403);
        const timestamp = headers['x-askgpt-timestamp'], nonce = headers['x-askgpt-nonce'], proof = headers['x-askgpt-proof'];
        if (!/^[0-9]{13}$/.test(timestamp) || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(proof)
            || Math.abs(now() - Number(timestamp)) > SKEW) return reply(403);
        const connection = await readConnection();
        check();
        const subtle = Services.focus?.activeWindow?.crypto?.subtle || Zotero.getMainWindow?.()?.crypto?.subtle;
        if (!subtle || !text(connection?.token, 256) || connection.token.length < 32) throw unavailable();
        // Zotero logs incoming headers; the reusable token never crosses its HTTP server.
        const key = await subtle.importKey('raw', utf8(connection.token), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
        const signature = Uint8Array.from(proof.match(/../g), pair => parseInt(pair, 16));
        if (!await subtle.verify('HMAC', key, signature, utf8('askgpt-reading-v1\n' + timestamp + '\n' + nonce + '\n' + data))) return reply(403);
        check();
        const time = now();
        if (Math.abs(time - Number(timestamp)) > SKEW) return reply(403);
        for (const [previous, expiry] of used) if (expiry < time) used.delete(previous);
        if (used.has(nonce)) return reply(409);
        if (used.size >= 128) throw unavailable();
        used.set(nonce, Number(timestamp) + SKEW);
        let value;
        try { value = validate(JSON.parse(data)); } catch (_) { return reply(400); }
        return reply(200, await (value.action === 'jump' ? jump(value) : saveNote(value)));
      } catch (error) { return reply([400, 404, 409].includes(error?.status) ? error.status : 503); }
    }
    function Endpoint() {}
    Endpoint.prototype = {supportedMethods: ['POST'], supportedDataTypes: ['text/plain'], init: handle};
    endpoints[ROUTE] = Endpoint;
    return () => {
      closed = true;
      used.clear(); notes.clear();
      for (const clear of [...overlays.values()]) clear();
      if (endpoints[ROUTE] === Endpoint) delete endpoints[ROUTE];
    };
  }
  const api = {register, locateQuote, locateQuotes, pageChars};
  root.AskGPTPaperReadingActions = api;
  if (typeof module !== 'undefined') module.exports = api;
})(this);
