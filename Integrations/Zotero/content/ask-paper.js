(function (root) {
  'use strict';
  const Core = root.AskGPTInlineCore || (typeof require === 'function' ? require('./inline-core.js') : null);
  const MAX_PAGES = 32, MAX_PAGE_BYTES = 75000, MAX_BODY_BYTES = 128 * 1024;
  const timeout = Symbol('paper extraction deadline');
  const bytes = text => fit(text, Infinity).bytes;
  const failure = code => new Core.InlineError(code);
  const messages = {
    attachment: ['无法确认当前 PDF 附件。', 'The current PDF attachment could not be confirmed.'],
    compatibility: ['当前 PDF 尚未就绪，请重试。', 'The current PDF is not ready. Try again.'],
    connection: ['请打开 Ask for GPT 并检查原页连接。', 'Open Ask for GPT and check the inline connection.'],
    permissions: ['本机连接权限异常，请重新配对。', 'The local connection permissions are invalid. Pair again.'],
    update_app: ['请更新 Ask for GPT 后重试。', 'Update Ask for GPT and try again.'],
    limit: ['论文上下文超过本机传输限制。', 'The paper context exceeds the local transfer limit.'],
    response: ['Ask for GPT 未能接收论文，请重试。', 'Ask for GPT could not accept the paper. Try again.']
  };
  function errorMessage(error, locale) {
    return (messages[error?.code] || messages.connection)[String(locale || '').startsWith('zh') ? 0 : 1];
  }
  function clean(value) {
    return typeof value === 'string'
      ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\p{Surrogate}/gu, '\uFFFD').trim()
      : '';
  }
  function fit(text, limit) {
    let written = 0, read = 0;
    for (const scalar of text) {
      const point = scalar.codePointAt(0);
      const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
      if (written + size > limit) break;
      written += size;
      read += scalar.length;
    }
    return {text: text.slice(0, read), bytes: written, clipped: read < text.length};
  }
  function attachmentFor(Zotero, reader) {
    const item = reader._item || Zotero.Items?.get?.(reader.itemID);
    if (item?.id !== reader.itemID || item?.isAttachment?.() !== true
        || !Number.isSafeInteger(item.libraryID) || item.libraryID < 1 || item.libraryID > 999999999999
        || typeof item.key !== 'string' || !/^[A-Z0-9]{8}$/.test(item.key)) return null;
    return {item, id: item.libraryID + ':' + item.key};
  }
  function field(item, name) {
    try { return clean(item?.getField?.(name)); } catch (_) { return ''; }
  }
  function pageOrder(current, total) {
    const selected = new Set([current, current - 1, current + 1].filter(page => page >= 0 && page < total));
    for (let page = 0; selected.size < Math.min(total, MAX_PAGES); page++) selected.add(page);
    return selected;
  }
  async function readPage(pdf, index, current, Components) {
    const unwrap = value => Components?.utils?.waiveXrays?.(value) ?? value;
    if (typeof pdf.pdfDocument.getPageData === 'function') {
      try {
        const options = Components?.utils?.cloneInto?.({pageIndex: index}, pdf.win) ?? {pageIndex: index};
        const value = unwrap(await pdf.pdfDocument.getPageData(options));
        if (!current()) throw failure('stopped');
        if (Array.isArray(value?.chars)) return Core.paragraphsFromChars(value.chars).join('\n\n');
      } catch (_) {
        if (!current()) throw failure('stopped');
      }
    }
    if (typeof pdf.pdfDocument.getPage !== 'function') return null;
    const page = unwrap(await pdf.pdfDocument.getPage(index + 1));
    if (!current()) throw failure('stopped');
    const value = unwrap(await page.getTextContent());
    if (!current()) throw failure('stopped');
    return Array.isArray(value?.items) ? Core.paragraphsFromPDFJSItems(value.items).join('\n\n') : null;
  }
  function sourceSelection(reader) {
    const native = reader._internalReader;
    const view = native?._lastView || native?._primaryView;
    const ranges = view?._selectionRanges;
    if (Array.isArray(ranges)) {
      const selected = ranges.slice(0, 2).filter(range => !range?.collapsed && typeof range?.text === 'string');
      if (selected.length) return {text: selected.map(range => range.text).join(' '),
        pageIndex: selected[0].position?.pageIndex ?? selected[0].pageIndex};
      return null;
    }
    const key = native?._lastViewPrimary === false ? 'secondaryViewSelectionPopup' : 'primaryViewSelectionPopup';
    const annotation = native?._state?.[key]?.annotation;
    return typeof annotation?.text === 'string'
      ? {text: annotation.text, pageIndex: annotation.position?.pageIndex} : null;
  }
  function create({Zotero, Components, readConnection, ensureReady, setTimer, clearTimer}) {
    return async (reader, {isActive, selection, currentPage, shortcut} = {}) => {
      if (!isActive?.()) throw failure('stopped');
      const pdf = Core.resolvePDFContext(reader);
      if (pdf.pageCount > 2000) throw failure('limit');
      const attachment = attachmentFor(Zotero, reader);
      if (!attachment) throw failure('attachment');
      const current = () => {
        try {
          return isActive() && Core.resolvePDFContext(reader).pdfDocument === pdf.pdfDocument
            && attachmentFor(Zotero, reader)?.id === attachment.id;
        } catch (_) { return false; }
      };
      const check = () => { if (!current()) throw failure('stopped'); };
      const connection = shortcut?.connection ?? await readConnection();
      check();
      if (!shortcut) await ensureReady?.(connection, current);
      check();
      const parent = attachment.item.parentID ? Zotero.Items?.get?.(attachment.item.parentID) : null;
      const page = [selection?.pageIndex, currentPage, pdf.pageIndex]
        .find(value => Number.isInteger(value) && value >= 0 && value < pdf.pageCount);
      const quote = clean(selection?.text);
      const payload = {
        attachmentID: attachment.id,
        title: fit(field(parent, 'title') || field(attachment.item, 'title') || 'PDF', 1024).text,
        abstract: fit(field(parent, 'abstractNote'), 6000).text,
        doi: fit(field(parent, 'DOI'), 256).text,
        selection: fit(quote && selection.translated ? '[译文选段]\n' + quote : quote, 6000).text,
        currentPage: page + 1, pageCount: pdf.pageCount, pages: [], complete: false
      };
      let remainingText = MAX_PAGE_BYTES, remainingBody = MAX_BODY_BYTES - bytes(JSON.stringify(payload));
      let fullText = true, expired = false, timer;
      const deadline = new Promise(resolve => {
        timer = setTimer(() => { expired = true; resolve(timeout); }, 12000);
      });
      try {
        for (const index of pageOrder(page, pdf.pageCount)) {
          check();
          if (remainingText <= 0) break;
          let raw;
          try { raw = await Promise.race([readPage(pdf, index, () => !expired && current(), Components), deadline]); }
          catch (_) { raw = null; }
          check();
          if (raw === timeout || expired) break;
          if (raw === null) { fullText = false; continue; }
          const text = clean(raw), entry = {number: index + 1, text: ''};
          const overhead = bytes(JSON.stringify(entry)) + 1;
          if (remainingBody < overhead) break;
          let excerpt = fit(text, Math.min(remainingText, remainingBody - overhead));
          entry.text = excerpt.text;
          if (bytes(JSON.stringify(entry)) + 1 > remainingBody) {
            // JSON doubles quotes, backslashes, and the remaining ASCII whitespace.
            excerpt = fit(text, Math.min(remainingText, Math.floor((remainingBody - overhead) / 2)));
            entry.text = excerpt.text;
          }
          payload.pages.push(entry);
          remainingText -= excerpt.bytes;
          remainingBody -= bytes(JSON.stringify(entry)) + 1;
          fullText &&= !!text && !excerpt.clipped;
        }
      } finally { clearTimer(timer); }
      payload.pages.sort((a, b) => a.number - b.number);
      payload.complete = fullText && payload.pages.length === pdf.pageCount;
      const body = JSON.stringify(payload);
      if (bytes(body) > MAX_BODY_BYTES) throw failure('limit');
      check();
      let response;
      try {
        const headers = {'Content-Type': 'application/json', Authorization: 'Bearer ' + connection.token};
        if (shortcut) headers['X-AskGPT-Shortcut'] = shortcut.nonce;
        response = await Zotero.HTTP.request('POST', 'http://127.0.0.1:43792/v1/inline/ask-paper', {
          body, headers,
          responseType: 'text', timeout: shortcut ? 2500 : 8000, followRedirects: false, anon: true, noCache: true,
          debug: false, logBodyLength: 0, errorDelayMax: 0, successCodes: [200, 400, 401, 403, 404, 413, 503]
        });
      } catch (_) { throw failure('connection'); }
      if (response.status === 404) throw failure('update_app');
      if ([401, 403].includes(response.status)) throw failure('connection');
      if (response.status === 413) throw failure('limit');
      let value;
      try {
        if (typeof response.responseText === 'string' && response.responseText.length <= 1024)
          value = JSON.parse(response.responseText);
      } catch (_) {}
      if (response.status !== 200 || value?.ok !== true || Object.keys(value).length !== 1) throw failure('response');
    };
  }
  const api = {create, sourceSelection, errorMessage};
  root.AskGPTPaper = api;
  if (typeof module !== 'undefined') module.exports = api;
})(this);
