(function(root) {
  'use strict';
  const BASE = 'http://127.0.0.1:43795/v1/pdf/paper-html';
  const MAX_PDF = 100 * 1024 * 1024;
  const MAX_HTML = 32 * 1024 * 1024;
  const POLL_INTERVAL_MS = 1800, MAX_GET_RETRIES = 2;
  const TITLE = 'HTML 阅读版';
  const JOB_ID = /^[a-f0-9]{32}$/;
  const SHA256 = /^[a-f0-9]{64}$/;
  const STATES = ['queued', 'running', 'complete', 'failed'];
  const STAGES = ['extracting', 'writing', 'reviewing', 'rendering', 'checking'];
  const ERRORS = ['html_runtime_missing', 'html_workflow_incompatible', 'html_model_unavailable', 'html_extract_failed', 'html_review_failed',
    'html_verify_failed', 'html_timed_out', 'html_failed', 'job_conflict'];
  const fail = code => Object.assign(Error(code), {code});
  const itemKey = item => item && !item.deleted && Number.isSafeInteger(item.id) &&
    Number.isSafeInteger(item.libraryID) && /^[A-Z0-9]{8}$/.test(item.key);

  function status(response, id) {
    const text = response.responseText;
    if (typeof text !== 'string' || text.length > 4096) throw fail('response');
    let value;
    try { value = JSON.parse(text); } catch (_) { throw fail('response'); }
    if (typeof value?.id !== 'string' || !JOB_ID.test(value.id) || id && value.id !== id || !STATES.includes(value.state) ||
        value.stage != null && !STAGES.includes(value.stage)) throw fail('response');
    if (value.state === 'complete' && (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256) ||
        !Number.isSafeInteger(value.bytes) || value.bytes < 32 || value.bytes > MAX_HTML)) throw fail('response');
    return value;
  }

  async function verifyFile({Components, hashFile}, file, sha256, bytes = null) {
    if (!file.exists() || !file.isFile() || file.isSymlink()) throw fail('integrity');
    const size = file.fileSize, modified = file.lastModifiedTime;
    if (size < 32 || size > MAX_HTML ||
        bytes !== null && size !== bytes) throw fail('integrity');
    let checksum;
    if (hashFile) checksum = await hashFile(file);
    else {
      const stream = Components.classes['@mozilla.org/network/file-input-stream;1'].createInstance(Components.interfaces.nsIFileInputStream);
      try {
        stream.init(file, 0x01, 0o444, 0);
        const hash = Components.classes['@mozilla.org/security/hash;1'].createInstance(Components.interfaces.nsICryptoHash);
        hash.init(hash.SHA256); hash.updateFromStream(stream, 0xffffffff);
        checksum = Array.from(hash.finish(false), char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
      } finally { stream.close(); }
    }
    if (checksum !== sha256 || file.fileSize !== size || file.lastModifiedTime !== modified || file.isSymlink()) throw fail('integrity');
    return file;
  }

  async function openInBrowser({Zotero}, file, isCurrent) {
    if (!isCurrent()) throw fail('stopped');
    const internal = Zotero.Utilities?.Internal;
    if (!Zotero.isMac || !internal?.subprocess || !internal.exec) return Zotero.launchFile(file.path);
    // Ask Launch Services which application handles HTTPS without sending a request.
    const lookup = 'ObjC.import("AppKit"); const url = $.NSURL.URLWithString("https://example.invalid/"); ' +
      'ObjC.unwrap($.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(url).path);';
    const size = file.fileSize, modified = file.lastModifiedTime;
    let app;
    try { app = (await internal.subprocess('/usr/bin/osascript', ['-l', 'JavaScript', '-e', lookup])).trim(); }
    catch (_) { throw fail('browser'); }
    if (!isCurrent()) throw fail('stopped');
    if (!/^\/[^\x00-\x1f]{1,4095}\.app$/.test(app)) throw fail('browser');
    if (!file.exists() || file.isSymlink() || !file.isFile() || file.fileSize !== size || file.lastModifiedTime !== modified) throw fail('integrity');
    try { await internal.exec('/usr/bin/open', ['-a', app, file.path]); } catch (_) { throw fail('browser'); }
  }

  function create(deps = {}) {
    const {Zotero, Components, IOUtils, PDF, resolvePDF, readConnection, ensurePDFReady, setTimer, clearTimer} = deps;
    if (!Zotero.Items?.get || !Zotero.Attachments?.importSnapshotFromFile || !Zotero.File?.pathToFile ||
        !IOUtils?.write || !PDF || !ensurePDFReady) return null;
    const running = new Map(), views = new Map(), jobs = new Map(), subscribers = new Map();
    let stopped = false;

    function binding(reader) {
      const source = Zotero.Items.get(reader?.itemID);
      if (reader?.type !== 'pdf' || !itemKey(source) || source.isPDFAttachment?.() !== true ||
          reader._item && reader._item.id !== source.id || !Number.isSafeInteger(source.parentID)) throw fail('source');
      const parent = Zotero.Items.get(source.parentID);
      if (!itemKey(parent) || parent.isRegularItem?.() !== true || parent.libraryID !== source.libraryID) throw fail('source');
      return {source: {id: source.id, key: source.key, libraryID: source.libraryID},
        parent: {id: parent.id, key: parent.key}, identity: parent.libraryID + '.' + parent.key + '.' + source.key};
    }

    function check(ctx, writing = false) {
      if (stopped) throw fail('stopped');
      const source = Zotero.Items.get(ctx.source.id), parent = Zotero.Items.get(ctx.parent.id);
      if (!itemKey(source) || source.key !== ctx.source.key || source.libraryID !== ctx.source.libraryID ||
          source.parentID !== ctx.parent.id || source.isPDFAttachment?.() !== true || !itemKey(parent) ||
          parent.key !== ctx.parent.key || parent.libraryID !== source.libraryID || parent.isRegularItem?.() !== true) throw fail('source');
      const library = Zotero.Libraries?.get?.(parent.libraryID);
      if (writing && (library?.editable === false || library?.filesEditable === false)) throw fail('readonly');
      return parent;
    }

    function sibling(ctx) {
      const parent = check(ctx), marker = new RegExp('^askgpt-paper-' + ctx.source.key + '-([a-f0-9]{64})\\.html$');
      for (const id of parent.getAttachments(false)) {
        const item = Zotero.Items.get(id);
        if (!itemKey(item) || item.parentID !== parent.id || item.libraryID !== parent.libraryID ||
            item.attachmentContentType !== 'text/html' || item.isSnapshotAttachment?.() !== true) continue;
        const match = marker.exec(item.attachmentFilename);
        if (match) return {item, sha256: match[1]};
      }
      return null;
    }

    function translated(source) {
      for (const direction of ['en-zh', 'zh-en']) {
        try {
          const value = Zotero.Prefs?.get('extensions.askgpt-inline.localPDF.' + source.libraryID + '.' + source.key + '.' + direction, true);
          if (typeof value !== 'string' || value.length > 4096) continue;
          const row = JSON.parse(value);
          if (row?.schema === 1 && row.targetKey === source.key && row.sourceSHA256 === row.targetSHA256 &&
              SHA256.test(row.sourceSHA256)) return true;
        } catch (_) { /* Older translations can lack an ownership record. */ }
      }
      return false;
    }

    function snapshotURL(ctx) {
      const parent = check(ctx);
      for (const item of [Zotero.Items.get(ctx.source.id), parent]) {
        const url = item.getField?.('url');
        if (typeof url === 'string' && /^https?:\/\/[^/\s@]+(?:[/?#]|$)/i.test(url) &&
            url.length <= 4096 && !/\s/.test(url)) return url;
      }
      const doi = parent.getField?.('DOI');
      return typeof doi === 'string' && doi.length <= 256 && /^10\.\d{4,9}\/\S+$/i.test(doi)
        ? 'https://doi.org/' + doi.split('/').map(encodeURIComponent).join('/') : '';
    }

    async function open(ctx, existing, isCurrent) {
      const path = await existing.item.getFilePathAsync();
      if (!path) throw fail('missing');
      const file = await verifyFile(deps, Zotero.File.pathToFile(path), existing.sha256);
      if (sibling(ctx)?.item.id !== existing.item.id) throw fail('source');
      await openInBrowser(deps, file, isCurrent);
      return existing.item;
    }

    async function request(run, connection, method, suffix, body = null) {
      if (stopped) throw fail('stopped');
      const output = suffix.endsWith('/output');
      let response, outputTooLarge = false;
      try {
        response = await Zotero.HTTP.request(method, BASE + suffix, {
          ...(body ? {body} : {}), headers: {Authorization: 'Bearer ' + connection.token,
            ...(body ? {'Content-Type': 'application/pdf'} : {}), Accept: output ? 'text/html' : 'application/json'},
          timeout: body || output ? 60000 : 10000, responseType: output ? 'arraybuffer' : 'text',
          anon: true, noCache: true, followRedirects: false, debug: false, logBodyLength: 0, errorDelayMax: 0,
          successCodes: [200, 202, 400, 401, 403, 404, 409, 411, 413, 415, 429, 503],
          cancellerReceiver(cancel) { run.cancel = cancel; if (stopped) cancel(); },
          ...(output ? {requestObserver(xhr) {
            xhr.addEventListener('progress', event => {
              if (event.loaded > MAX_HTML || event.lengthComputable && event.total > MAX_HTML) {
                outputTooLarge = true; xhr.abort();
              }
            });
          }} : {})
        });
      } catch (_) {
        throw fail(stopped ? 'stopped' : outputTooLarge ? 'integrity' : 'bridge');
      } finally { run.cancel = null; }
      if (stopped) throw fail('stopped');
      if (outputTooLarge) throw fail('integrity');
      if (response.responseURL && response.responseURL !== BASE + suffix) throw fail('response');
      if ([401, 403].includes(response.status)) throw fail('connection');
      if (response.status === 404) throw fail(suffix ? 'expired' : 'update');
      if (response.status === 413) throw fail('limit');
      if ([409, 429].includes(response.status)) throw fail('busy');
      if (response.status === 503) {
        let code;
        try { code = JSON.parse(response.responseText).error; } catch (_) {}
        throw fail(ERRORS.includes(code) ? code : 'bridge');
      }
      if (![200, 202].includes(response.status)) throw fail('response');
      return response;
    }

    function pause(run, delay = POLL_INTERVAL_MS) {
      return new Promise(resolve => {
        run.resume = resolve;
        run.timer = setTimer(() => { run.timer = null; run.resume = null; resolve(); }, delay);
      });
    }

    async function readJob(run, connection, suffix, progress) {
      for (let attempt = 0; ; attempt++) {
        try { return await request(run, connection, 'GET', suffix); }
        catch (error) {
          if (error?.code !== 'bridge' || attempt >= MAX_GET_RETRIES) throw error;
          progress('reconnecting');
          await pause(run, POLL_INTERVAL_MS * (attempt + 1));
        }
      }
    }

    async function generate(ctx, run, reader, isCurrent, progress) {
      check(ctx, true);
      if (!isCurrent()) throw fail('stopped');
      if (translated(ctx.source)) throw fail('translated');
      const connection = await readConnection();
      await ensurePDFReady(connection, () => !stopped && isCurrent());
      if (!isCurrent() || stopped) throw fail('stopped');
      let result, id = jobs.get(ctx.identity);
      if (!id) {
        progress('fetching');
        const doc = resolvePDF(reader).pdfDocument;
        const original = await doc.getData();
        if (!isCurrent() || stopped || binding(reader).identity !== ctx.identity ||
            resolvePDF(reader).pdfDocument !== doc) throw fail('stopped');
        const bytes = PDF.copyOpenPDFData(original, Components);
        try {
          PDF.validPDF(bytes, MAX_PDF);
          // Zotero's chrome XHR uses the same plain ArrayBuffer as PDF translation.
          result = status(await request(run, connection, 'POST', '', bytes.buffer));
        } finally { bytes.fill(0); }
        id = result.id;
        jobs.set(ctx.identity, id);
      }
      for (;;) {
        result ||= status(await readJob(run, connection, '/' + id, progress), id);
        if (result.state === 'complete') break;
        if (result.state === 'failed') {
          jobs.delete(ctx.identity);
          throw fail(ERRORS.includes(result.error) ? result.error : 'html_failed');
        }
        const stage = result.stage === 'reviewing' && result.phase === 'repairing' ? 'repairing' : result.stage;
        progress(stage || (result.state === 'queued' ? 'queued' : 'starting'), result.elapsedSeconds);
        result = null;
        await pause(run);
      }
      progress('saving', result.elapsedSeconds);
      check(ctx, true);
      const duplicate = sibling(ctx);
      if (duplicate) return duplicate.item;
      const response = await readJob(run, connection, '/' + id + '/output', progress);
      progress('saving', result.elapsedSeconds);
      if (response.status !== 200 ||
          response.getResponseHeader?.('Content-Type')?.toLowerCase().split(';')[0].trim() !== 'text/html' ||
          Object.prototype.toString.call(response.response) !== '[object ArrayBuffer]' ||
          response.response.byteLength !== result.bytes) throw fail('integrity');
      const bytes = new Uint8Array(response.response);
      const directory = Zotero.getTempDirectory().clone();
      directory.append('askgpt-paper-html');
      directory.createUnique(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
      try {
        const file = directory.clone();
        file.append('askgpt-paper-' + ctx.source.key + '-' + result.sha256 + '.html');
        await IOUtils.write(file.path, bytes, {mode: 'create', permissions: 0o600});
        await verifyFile(deps, file, result.sha256, result.bytes);
        check(ctx, true);
        const existing = sibling(ctx);
        if (existing) return existing.item;
        const item = await Zotero.Attachments.importSnapshotFromFile({file: file.path, url: snapshotURL(ctx), title: TITLE,
          contentType: 'text/html', charset: 'UTF-8', parentItemID: ctx.parent.id, singleFile: true});
        if (sibling(ctx)?.item.id !== item?.id) throw fail('save');
        return item;
      } finally {
        await IOUtils.remove(directory.path, {recursive: true, ignoreAbsent: true}).catch(() => {});
      }
    }

    function view(reader) {
      try {
        const ctx = binding(reader), previous = views.get(ctx.identity);
        if (running.has(ctx.identity) || previous?.state === 'failed') return previous;
        return {state: sibling(ctx) ? 'saved' : 'idle'};
      } catch (_) { return null; }
    }
    function deliver(listener, value) {
      try { listener(value); } catch (error) { Zotero.logError?.(error); }
    }
    function notify(identity, value, onChange) {
      deliver(onChange, value);
      for (const listener of subscribers.get(identity) || []) if (listener !== onChange) deliver(listener, value);
    }
    return {
      view,
      subscribe(reader, listener) {
        let identity;
        try { ({identity} = binding(reader)); } catch (_) { deliver(listener, null); return () => {}; }
        if (stopped) return () => {};
        const group = subscribers.get(identity) || new Set();
        group.add(listener);
        subscribers.set(identity, group);
        deliver(listener, view(reader));
        return () => {
          group.delete(listener);
          if (!group.size && subscribers.get(identity) === group) subscribers.delete(identity);
        };
      },
      async activate(reader, {isCurrent, onChange = () => {}}) {
        if (stopped || !isCurrent()) return;
        let ctx;
        try { ctx = binding(reader); } catch (_) { return; }
        const {identity} = ctx;
        if (running.has(identity)) return;
        const run = {cancel: null, timer: null, resume: null, startedAt: Date.now(), elapsedSeconds: 0};
        let interrupted = false;
        const report = value => { if (!stopped) { views.set(identity, value); notify(identity, value, onChange); } };
        const progress = (stage, workerSeconds) => {
          const measured = Number.isSafeInteger(workerSeconds) ? workerSeconds : 0;
          const elapsedSeconds = Math.max(run.elapsedSeconds, measured, Math.floor((Date.now() - run.startedAt) / 1000));
          if (run.stage === stage && run.elapsedSeconds === elapsedSeconds) return;
          run.stage = stage; run.elapsedSeconds = elapsedSeconds;
          report({state: 'running', stage, elapsedSeconds, startedAt: run.startedAt});
        };
        running.set(identity, run);
        try {
          const existing = sibling(ctx);
          if (existing) {
            progress('opening');
            await open(ctx, existing, isCurrent);
            report({state: 'saved', opened: true});
          } else {
            progress('starting');
            await generate(ctx, run, reader, isCurrent, progress);
            jobs.delete(identity);
            report({state: 'saved', generated: true});
          }
        } catch (error) {
          if (error?.code === 'expired') jobs.delete(identity);
          if (error?.code === 'stopped') { interrupted = true; views.delete(identity); }
          else report({state: 'failed', code: error?.code || 'failed', saved: Boolean(siblingSafe(ctx))});
        } finally {
          running.delete(identity);
          if (views.get(identity)?.state === 'saved') views.delete(identity);
          if (interrupted && !stopped) notify(identity, view(reader), onChange);
        }
      },
      shutdown() {
        stopped = true;
        for (const run of running.values()) {
          run.cancel?.();
          if (run.timer !== null) clearTimer(run.timer);
          run.resume?.();
        }
        views.clear();
        jobs.clear();
        subscribers.clear();
      }
    };
    function siblingSafe(ctx) { try { return sibling(ctx); } catch (_) { return null; } }
  }

  const api = {create, verifyFile, openInBrowser}; root.AskGPTPaperHTMLVersion = api;
  if (typeof module !== 'undefined') module.exports = api;
})(this);
