(function (root) {
  'use strict';
  const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest/';
  const CLOUD = 'https://pmc-oa-opendata.s3.amazonaws.com/';
  const TAG = 'Ask GPT Supplement';
  const MAX_FILE = 64 * 1024 * 1024, MAX_XML = 4 * 1024 * 1024, MAX_PREVIEW_PDF = 32 * 1024 * 1024;
  const TYPES = {pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',
    tif:'image/tiff',tiff:'image/tiff',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    csv:'text/csv',tsv:'text/tab-separated-values',txt:'text/plain',zip:'application/zip',mp4:'video/mp4',mov:'video/quicktime'};
  const CODES = new Set(['supplements_parent','supplements_changed','supplements_readonly','supplements_limit',
    'supplements_file','supplements_response','supplements_identity','supplements_network','supplements_save',
    'supplements_busy','supplements_selection','supplements_archive','supplements_missing','supplements_unavailable']);
  const failure = code => Object.assign(new Error(code), {code});
  const reason = (error, fallback) => CODES.has(error?.code) ? error.code : fallback;
  const clean = (value, maximum = 1024) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, maximum) : '';
  const extension = name => String(name || '').split('.').pop().toLowerCase();
  function doi(value) {
    const result = clean(value, 300).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
    return /^10\.\d{4,9}\/[^\s"<>]+$/.test(result) && result.length <= 256 ? result : '';
  }
  function pmcid(value) {
    const match = clean(value, 4096).match(/^https:\/\/(?:www\.)?(?:europepmc\.org|pmc\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov)(?::443)?\/(?:articles|pmc\/articles)\/(PMC[1-9]\d{0,11})(?:\/|[?#]|$)/i);
    return match ? match[1].toUpperCase() : '';
  }
  function field(item, name) { try { return clean(item?.getField?.(name), 4096); } catch (_) { return ''; } }
  function signature(bytes) {
    const prefix = Array.from(bytes.subarray(0, 16), value => String.fromCharCode(value)).join('');
    if (prefix.startsWith('%PDF-')) return 'application/pdf';
    if ([137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (/^GIF8[79]a/.test(prefix)) return 'image/gif';
    if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') return 'image/webp';
    if (prefix.startsWith('II*\0') || prefix.startsWith('MM\0*')) return 'image/tiff';
    return '';
  }
  function create(deps = {}) {
    const {Zotero, Services, Components, IOUtils} = deps;
    const discoveries = new Map(), pending = new Map();
    const file = path => Zotero.File.pathToFile(path);
    const validItem = item => item && !item.deleted && Number.isSafeInteger(item.id) && item.id > 0 &&
      Number.isSafeInteger(item.libraryID) && item.libraryID > 0 && /^[A-Z0-9]{8}$/.test(item.key);
    function context(reader) {
      const source = Zotero.Items.get(reader?.itemID);
      if (!validItem(source) || source.isAttachment?.() !== true || reader?._item && reader._item.id !== source.id ||
          source.attachmentContentType !== 'application/pdf' || !Number.isSafeInteger(source.parentID)) throw failure('supplements_parent');
      const parent = Zotero.Items.get(source.parentID);
      if (!validItem(parent) || parent.isRegularItem?.() !== true || parent.libraryID !== source.libraryID) throw failure('supplements_parent');
      return {reader, source, parent, identity: parent.libraryID + ':' + parent.key, sourceKey: source.key,
        doi: doi(field(parent, 'DOI')) || doi(field(parent, 'url')), pmcid: pmcid(field(parent, 'url'))};
    }
    function check(ctx, write = false) {
      const next = context(ctx.reader);
      if (next.identity !== ctx.identity || next.sourceKey !== ctx.sourceKey || next.source.id !== ctx.source.id ||
          next.doi !== ctx.doi || next.pmcid !== ctx.pmcid) throw failure('supplements_changed');
      if (write) {
        const library = Zotero.Libraries?.get?.(ctx.parent.libraryID);
        if (library && (library.editable === false || library.filesEditable === false)) throw failure('supplements_readonly');
      }
      return next;
    }
    function siblings(ctx) {
      check(ctx);
      const ids = ctx.parent.getAttachments?.() || [];
      if (!Array.isArray(ids) || ids.length > 1000) throw failure('supplements_limit');
      return ids.map(id => Zotero.Items.get(id)).filter(item => validItem(item) && item.isAttachment?.() === true &&
        item.parentID === ctx.parent.id && item.libraryID === ctx.parent.libraryID);
    }
    function regular(value, maximum = MAX_FILE) {
      return value.exists() && !value.isSymlink() && value.isFile() && value.fileSize > 0 && value.fileSize <= maximum;
    }
    async function localFile(item, maximum = Infinity) {
      const path = await item.getFilePathAsync?.();
      if (!path) return null;
      const value = file(path);
      return regular(value, maximum) ? value : null;
    }
    async function descriptor(item) {
      const value = await localFile(item);
      return {id:item.id, title:field(item, 'title') || clean(item.attachmentFilename) || 'Supplement',
        fileName:clean(item.attachmentFilename || value?.leafName), contentType:clean(item.attachmentContentType),
        url:field(item, 'url'), managed:item.hasTag?.(TAG) === true, available:!!value};
    }
    async function list(reader) {
      const ctx = context(reader), result = [];
      for (const item of siblings(ctx)) {
        if (item.id === ctx.source.id || item.attachmentContentType === 'text/html') continue;
        const name = field(item, 'title') + ' ' + clean(item.attachmentFilename);
        if (/ - (?:中文译文|English translation)(?:\.pdf)?(?: |$)/i.test(name)) continue;
        if (item.attachmentContentType === 'application/pdf' && item.hasTag?.(TAG) !== true &&
            !/supplement|supporting|additional|appendi[xc]|补充|附件|(?:^|[ _-])(?:s\d+|mmc\d+|moesm\d+)/i.test(name)) continue;
        if (item.hasTag?.(TAG) !== true && !TYPES[extension(item.attachmentFilename)]) continue;
        result.push(await descriptor(item));
      }
      check(ctx);
      return result;
    }
    async function request(url, maximum) {
      let exceeded = false, response;
      try {
        response = await Zotero.HTTP.request('GET', url, {responseType:'arraybuffer', timeout:20000, followRedirects:false,
          anon:true, noCache:true, debug:false, logBodyLength:0, errorDelayMax:0, successCodes:[200,404,429,503],
          headers:{Accept:'application/json, application/xml, application/zip, */*;q=0.1'},
          requestObserver(xhr) {
            const stop = () => { exceeded = true; xhr.abort(); };
            xhr.addEventListener('progress', event => { if (event.loaded > maximum || event.lengthComputable && event.total > maximum) stop(); });
            xhr.addEventListener('readystatechange', () => {
              if (xhr.readyState === 2) { const length = Number(xhr.getResponseHeader('Content-Length')); if (Number.isFinite(length) && length > maximum) stop(); }
            });
          }});
      } catch (_) { throw failure(exceeded ? 'supplements_limit' : 'supplements_network'); }
      if (exceeded) throw failure('supplements_limit');
      if (response.status !== 200 || response.responseURL && response.responseURL !== url) throw failure('supplements_network');
      const bytes = new Uint8Array(response.response);
      if (!bytes.length || bytes.length > maximum) throw failure('supplements_limit');
      return bytes;
    }
    function decode(bytes) {
      try {
        const Decoder = deps.TextDecoder || root.TextDecoder || Services?.appShell?.hiddenDOMWindow?.TextDecoder;
        return new Decoder('utf-8', {fatal:true}).decode(bytes);
      } catch (_) { throw failure('supplements_response'); }
    }
    function parse(xml, ctx, id) {
      if (/<!ENTITY\s/i.test(xml)) throw failure('supplements_response');
      const Parser = deps.DOMParser || root.DOMParser || Services?.appShell?.hiddenDOMWindow?.DOMParser;
      const doc = new Parser().parseFromString(xml, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length || doc.documentElement?.localName !== 'article') throw failure('supplements_response');
      const articleIDs = Array.from(doc.getElementsByTagName('article-id'));
      const articleDOI = articleIDs.find(node => node.getAttribute('pub-id-type') === 'doi');
      const articlePMC = articleIDs.find(node => ['pmc', 'pmcid'].includes(node.getAttribute('pub-id-type')));
      if (ctx.doi && doi(articleDOI?.textContent) !== ctx.doi || !ctx.doi && !articlePMC || articlePMC &&
          articlePMC.textContent.trim().replace(/^PMC/i, '') !== id.slice(3)) throw failure('supplements_identity');
      const result = [], seen = new Set();
      for (const material of Array.from(doc.getElementsByTagName('supplementary-material'))) {
        for (const node of [material, ...Array.from(material.getElementsByTagName('*'))]) {
          const name = node.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || node.getAttribute('xlink:href') || '';
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name) || !TYPES[extension(name)] || seen.has(name)) continue;
          seen.add(name);
          const label = material.getElementsByTagName('label')[0]?.textContent || '';
          const caption = material.getElementsByTagName('title')[0]?.textContent || material.getElementsByTagName('caption')[0]?.textContent || '';
          result.push({id:id + ':' + name, title:clean([label, caption].filter(Boolean).join(' — ')) || name,
            fileName:name, url:'https://europepmc.org/articles/' + id + '#supplementary-material', source:'Europe PMC'});
          if (result.length >= 32) return result;
        }
      }
      return result;
    }
    async function find(reader) {
      const ctx = context(reader), base = {source:'Europe PMC', candidates:[]};
      if (!ctx.doi && !ctx.pmcid) return {...base, status:'no_identifier', message:'No DOI or Europe PMC/PMC article URL is available. Add local files instead.'};
      let cloudErrorCode = '';
      if (ctx.pmcid) {
        try { return await cloudFind(ctx); }
        catch (error) {
          if (['supplements_changed','supplements_parent'].includes(error.code)) throw error;
          cloudErrorCode = reason(error, 'supplements_response');
        }
      }
      try {
        let id = ctx.pmcid;
        if (ctx.doi) {
          const url = BASE + 'search?query=' + encodeURIComponent('DOI:"' + ctx.doi + '"') + '&format=json&resultType=core&pageSize=10';
          const json = JSON.parse(decode(await request(url, 512 * 1024)));
          check(ctx);
          const matches = (json.resultList?.result || []).filter(value => doi(value.doi) === ctx.doi && /^PMC[1-9]\d{0,11}$/.test(value.pmcid || '') && value.isOpenAccess === 'Y');
          const ids = [...new Set(matches.map(value => value.pmcid))];
          if (ids.length !== 1 || id && id !== ids[0]) return {...base, status:'none', message:'No exact open-access article match was found. Add local files instead.'};
          id = ids[0];
        }
        const xml = decode(await request(BASE + id + '/fullTextXML', MAX_XML));
        check(ctx);
        const candidates = parse(xml, ctx, id);
        discoveries.set(ctx.identity, {doi:ctx.doi, pmcid:ctx.pmcid, id, candidates});
        return {...base, candidates:candidates.map(value => ({...value})), status:candidates.length ? 'ready' : 'none',
          message:candidates.length ? '' : 'No downloadable supplement files were declared by this open source. Add local files instead.'};
      } catch (error) {
        if (['supplements_changed','supplements_parent'].includes(error.code)) throw error;
        return {...base, status:'unavailable', errorCode:reason(error, 'supplements_response'),
          ...(cloudErrorCode ? {cloudErrorCode} : {}), message:'The public source is unavailable or unsupported. Retry later or add local files.'};
      }
    }
    async function hash(value, algorithm = 'SHA256') {
      if (!regular(value)) throw failure('supplements_file');
      if (deps.hashFile) return deps.hashFile(value, algorithm);
      const beforeSize = value.fileSize, beforeTime = value.lastModifiedTime;
      const stream = Components.classes['@mozilla.org/network/file-input-stream;1'].createInstance(Components.interfaces.nsIFileInputStream);
      try {
        stream.init(value, 0x01, 0o444, 0);
        const digest = Components.classes['@mozilla.org/security/hash;1'].createInstance(Components.interfaces.nsICryptoHash);
        digest.init(digest[algorithm]); digest.updateFromStream(stream, 0xffffffff);
        const result = Array.from(digest.finish(false), char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
        if (!regular(value) || value.fileSize !== beforeSize || value.lastModifiedTime !== beforeTime) throw failure('supplements_changed');
        return result;
      } finally { stream.close(); }
    }
    async function add(ctx, value, title, url = '') {
      check(ctx, true);
      if (!regular(value) || !TYPES[extension(value.leafName)]) throw failure('supplements_file');
      const expected = TYPES[extension(value.leafName)], header = await IOUtils.read(value.path, {maxBytes:512});
      if ((expected === 'application/pdf' || expected.startsWith('image/')) && signature(header) !== expected) throw failure('supplements_file');
      if (['zip','docx','xlsx','pptx'].includes(extension(value.leafName)) &&
          !(header[0] === 80 && header[1] === 75 && [3,5,7].includes(header[2]) && [4,6,8].includes(header[3]))) throw failure('supplements_file');
      const checksum = await hash(value);
      for (const existing of siblings(ctx)) {
        const previous = await localFile(existing);
        if (previous && previous.fileSize === value.fileSize && await hash(previous) === checksum) return {duplicate:existing.id};
      }
      check(ctx, true);
      const item = await Zotero.Attachments.importFromFile({file:value.path, libraryID:ctx.parent.libraryID,
        parentItemID:ctx.parent.id, title:clean(title) || value.leafName, contentType:TYPES[extension(value.leafName)]});
      if (!validItem(item) || item.parentID !== ctx.parent.id || item.libraryID !== ctx.parent.libraryID) throw failure('supplements_save');
      const saved = await localFile(item);
      if (!saved || await hash(saved) !== checksum) throw failure('supplements_save');
      item.addTag(TAG);
      if (url) item.setField('url', url);
      await item.saveTx();
      return {entry:await descriptor(item)};
    }
    function serialize(ctx, operation) {
      if (pending.has(ctx.identity)) throw failure('supplements_busy');
      const task = operation().finally(() => { if (pending.get(ctx.identity) === task) pending.delete(ctx.identity); });
      pending.set(ctx.identity, task);
      return task;
    }
    function cloudReference(value, prefix, name) {
      const expected = 's3://pmc-oa-opendata/' + prefix + '/' + name + '?md5=';
      if (typeof value !== 'string' || !value.startsWith(expected) || !/^[a-f0-9]{32}$/.test(value.slice(expected.length))) return null;
      return {url:CLOUD + prefix + '/' + name, md5:value.slice(expected.length)};
    }
    async function cloudVersion(ctx, discovery, write = false) {
      const xml = decode(await request(CLOUD + '?list-type=2&prefix=' + discovery.id + '.&delimiter=%2F&max-keys=9', 32768));
      check(ctx, write);
      if (/<!ENTITY\s/i.test(xml)) throw failure('supplements_response');
      const Parser = deps.DOMParser || root.DOMParser || Services?.appShell?.hiddenDOMWindow?.DOMParser;
      const doc = new Parser().parseFromString(xml, 'application/xml');
      if (doc.documentElement?.localName !== 'ListBucketResult' || doc.getElementsByTagName('parsererror').length ||
          doc.getElementsByTagName('IsTruncated')[0]?.textContent !== 'false') throw failure('supplements_response');
      const prefixes = Array.from(doc.getElementsByTagName('CommonPrefixes')).map(node => node.getElementsByTagName('Prefix')[0]?.textContent);
      if (!prefixes.length || prefixes.length > 8 || new Set(prefixes).size !== prefixes.length || prefixes.some(value =>
          typeof value !== 'string' || !value.startsWith(discovery.id + '.') || !/^[1-9]\d{0,3}\/$/.test(value.slice(discovery.id.length + 1)))) throw failure('supplements_response');
      const versions = await Promise.all(prefixes.map(async rawPrefix => {
        const prefix = rawPrefix.slice(0, -1), version = Number(prefix.slice(discovery.id.length + 1));
        const meta = JSON.parse(decode(await request(CLOUD + prefix + '/' + prefix + '.json', 65536)));
        if (meta.pmcid !== discovery.id || meta.version !== version || !doi(meta.doi) || ctx.doi && doi(meta.doi) !== ctx.doi ||
            meta.is_pmc_openaccess !== true || meta.is_manuscript !== false || meta.is_retracted !== false ||
            !/^CC(?:0| BY(?:-(?:NC|SA|ND))*)$/.test(meta.license_code || '') ||
            !Array.isArray(meta.media_urls) || meta.media_urls.length > 1000) return null;
        const main = cloudReference(meta.pdf_url, prefix, prefix + '.pdf');
        return main ? {prefix, main, media:meta.media_urls, doi:doi(meta.doi),
          xml:cloudReference(meta.xml_url, prefix, prefix + '.xml')} : null;
      }));
      check(ctx, write);
      let matches = versions.filter(Boolean);
      if (matches.length > 1) {
        const source = await localFile(ctx.source);
        if (!source) throw failure('supplements_identity');
        const checksum = await hash(source, 'MD5'); check(ctx, write);
        matches = matches.filter(value => value.main.md5 === checksum);
      }
      if (matches.length !== 1) throw failure('supplements_identity');
      return matches[0];
    }
    function byteHash(bytes, algorithm = 'MD5') {
      if (deps.hashBytes) return deps.hashBytes(bytes, algorithm);
      const digest = Components.classes['@mozilla.org/security/hash;1'].createInstance(Components.interfaces.nsICryptoHash);
      digest.init(digest[algorithm]); digest.update(bytes, bytes.length);
      return Array.from(digest.finish(false), char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    }
    async function cloudFind(ctx) {
      const id = ctx.pmcid, version = await cloudVersion(ctx, {id});
      if (!version.xml) throw failure('supplements_response');
      const bytes = await request(version.xml.url, MAX_XML); check(ctx);
      if (byteHash(bytes) !== version.xml.md5) throw failure('supplements_identity');
      const candidates = parse(decode(bytes), {...ctx, doi:version.doi}, id).filter(value =>
        extension(value.fileName) === 'pdf' && version.media.filter(raw => cloudReference(raw, version.prefix, value.fileName)).length === 1)
        .map(value => ({...value, source:'PMC Cloud', url:CLOUD + version.prefix + '/' + value.fileName}));
      discoveries.set(ctx.identity, {doi:ctx.doi, pmcid:ctx.pmcid, id, candidates, cloudVersion:version});
      return {source:'PMC Cloud', candidates:candidates.map(value => ({...value})), status:candidates.length ? 'ready' : 'none',
        message:candidates.length ? '' : 'No verified supplementary PDFs are available from this public source. Add local files instead.'};
    }
    async function cloudDownload(ctx, discovery, selected, verifiedVersion) {
      const result = {added:[], skipped:[], failed:[]}; let directory;
      try {
        if (!selected.some(value => extension(value.fileName) === 'pdf')) throw failure('supplements_missing');
        const version = verifiedVersion || await cloudVersion(ctx, discovery, true);
        directory = Zotero.getTempDirectory().clone(); directory.append('askgpt-supplements-cloud');
        directory.createUnique(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
        for (const candidate of selected) {
          try {
            check(ctx, true);
            if (extension(candidate.fileName) !== 'pdf') throw failure('supplements_missing');
            const references = version.media.map(value => cloudReference(value, version.prefix, candidate.fileName)).filter(Boolean);
            if (references.length !== 1) throw failure('supplements_missing');
            const reference = references[0], bytes = await request(reference.url, MAX_FILE); check(ctx, true);
            if (signature(bytes) !== 'application/pdf') throw failure('supplements_file');
            const target = directory.clone(); target.append(candidate.fileName);
            await IOUtils.write(target.path, bytes, {mode:'create', permissions:0o600});
            if (await hash(target, 'MD5') !== reference.md5) throw failure('supplements_file');
            const saved = await add(ctx, target, candidate.title, reference.url);
            if (saved.duplicate) result.skipped.push({id:candidate.id, reason:'duplicate'}); else result.added.push(saved.entry);
          } catch (error) {
            if (['supplements_changed','supplements_parent','supplements_readonly'].includes(error.code)) throw error;
            result.failed.push({id:candidate.id, reason:reason(error, 'supplements_network')});
          }
        }
        return result;
      } catch (error) {
        if (['supplements_changed','supplements_parent','supplements_readonly'].includes(error.code)) throw error;
        return {added:[], skipped:[], failed:selected.map(value => ({id:value.id, reason:reason(error, 'supplements_network')}))};
      } finally {
        if (directory) try { await IOUtils.remove(directory.path, {recursive:true, ignoreAbsent:true}); } catch (_) {}
      }
    }
    async function download(reader, selection) {
      const ctx = context(reader); check(ctx, true);
      const discovery = discoveries.get(ctx.identity);
      if (!discovery || discovery.doi !== ctx.doi || discovery.pmcid !== ctx.pmcid || !Array.isArray(selection) || !selection.length || selection.length > 32) throw failure('supplements_selection');
      const ids = [...new Set(selection.map(value => typeof value === 'string' ? value : value?.id))];
      const selected = ids.map(id => discovery.candidates.find(value => value.id === id));
      if (selected.some(value => !value)) throw failure('supplements_selection');
      return serialize(ctx, async () => {
        if (discovery.cloudVersion) return cloudDownload(ctx, discovery, selected, discovery.cloudVersion);
        const result = {added:[], skipped:[], failed:[]}; let directory, zip;
        try {
          let bytes;
          try { bytes = await request(BASE + discovery.id + '/supplementaryFiles', MAX_FILE); }
          catch (error) {
            if (error.code === 'supplements_network') return await cloudDownload(ctx, discovery, selected);
            throw error;
          }
          check(ctx, true);
          if (bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4) throw failure('supplements_archive');
          directory = Zotero.getTempDirectory().clone(); directory.append('askgpt-supplements');
          directory.createUnique(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
          const archive = directory.clone(); archive.append('bundle.zip');
          await IOUtils.write(archive.path, bytes, {mode:'create', permissions:0o600});
          zip = deps.createZipReader ? deps.createZipReader() : Components.classes['@mozilla.org/libjar/zip-reader;1'].createInstance(Components.interfaces.nsIZipReader);
          zip.open(archive);
          const entries = zip.findEntries(null), names = new Map(); let count = 0, total = 0;
          while (entries.hasMore()) {
            const name = entries.getNext(), entry = zip.getEntry(name);
            if (++count > 1000 || !Number.isSafeInteger(entry.realSize) || entry.realSize < 0 ||
                (total += entry.realSize) > 128 * 1024 * 1024 || /(^|[\\/])\.\.?([\\/]|$)|^[\\/]|[\\:\x00-\x1f]/.test(name) ||
                (entry.permissions & 0o170000) === 0o120000) throw failure('supplements_archive');
            if (entry.isDirectory) continue;
            const basename = name.split('/').pop();
            if (names.has(basename)) names.set(basename, null); else names.set(basename, name);
          }
          for (const candidate of selected) {
            try {
              check(ctx, true);
              const name = names.get(candidate.fileName), entry = name && zip.getEntry(name);
              if (!entry || entry.realSize <= 0 || entry.realSize > MAX_FILE) throw failure('supplements_missing');
              const target = directory.clone(); target.append(candidate.fileName);
              zip.extract(name, target);
              if (!regular(target) || target.fileSize !== entry.realSize) throw failure('supplements_archive');
              const saved = await add(ctx, target, candidate.title, BASE + discovery.id + '/supplementaryFiles#' + encodeURIComponent(candidate.fileName));
              if (saved.duplicate) result.skipped.push({id:candidate.id, reason:'duplicate'}); else result.added.push(saved.entry);
            } catch (error) {
              if (['supplements_changed','supplements_parent','supplements_readonly'].includes(error.code)) throw error;
              result.failed.push({id:candidate.id, reason:reason(error, 'supplements_save')});
            }
          }
          return result;
        } catch (error) {
          if (['supplements_changed','supplements_parent','supplements_readonly'].includes(error.code)) throw error;
          return {added:result.added, skipped:result.skipped, failed:selected.filter(value =>
            !result.added.some(item => item.fileName === value.fileName) && !result.skipped.some(item => item.id === value.id))
            .map(value => ({id:value.id, reason:reason(error, 'supplements_network')}))};
        } finally {
          try { zip?.close(); } catch (_) {}
          if (directory) try { await IOUtils.remove(directory.path, {recursive:true, ignoreAbsent:true}); } catch (_) {}
        }
      });
    }
    async function chooseFiles(reader) {
      const ctx = context(reader); check(ctx, true);
      return serialize(ctx, async () => {
        const Picker = (deps.ChromeUtils || root.ChromeUtils)?.importESModule('chrome://zotero/content/modules/filePicker.mjs').FilePicker;
        const picker = deps.createFilePicker ? deps.createFilePicker() : new Picker();
        picker.init(reader._window || Zotero.getMainWindow?.(), 'Add supplementary files', picker.modeOpenMultiple);
        picker.appendFilter('Supplementary files', Object.keys(TYPES).map(ext => '*.' + ext).join(';'));
        const answer = await picker.show(); check(ctx, true);
        const result = {added:[], skipped:[], failed:[]};
        if (answer !== picker.returnOK) return {...result, cancelled:true};
        const paths = Array.from(picker.files || []);
        if (!paths.length || paths.length > 32) throw failure('supplements_limit');
        for (const path of paths) {
          try {
            if (typeof path !== 'string' || !/^(?:\/|[A-Za-z]:[\\/])/.test(path)) throw failure('supplements_file');
            const value = file(path), saved = await add(ctx, value, value.leafName);
            if (saved.duplicate) result.skipped.push({id:clean(value.leafName), reason:'duplicate'}); else result.added.push(saved.entry);
          } catch (error) {
            if (['supplements_changed','supplements_parent','supplements_readonly'].includes(error.code)) throw error;
            result.failed.push({id:'local-file', reason:reason(error, 'supplements_file')});
          }
        }
        return result;
      });
    }
    async function attachment(reader, id) {
      const ctx = context(reader), item = siblings(ctx).find(value => value.id === id);
      if (!item || item.id === ctx.source.id) throw failure('supplements_file');
      const value = await localFile(item); check(ctx);
      if (!value) throw failure('supplements_file');
      return {ctx, item, value};
    }
    async function preview(reader, id) {
      const {ctx, item, value} = await attachment(reader, id), details = await descriptor(item);
      const type = details.contentType;
      if (type !== 'application/pdf' && !['image/png','image/jpeg','image/gif','image/webp'].includes(type)) return {...details, kind:'external'};
      const maximum = type === 'application/pdf' ? MAX_PREVIEW_PDF : 12 * 1024 * 1024;
      if (value.fileSize > maximum) return {...details, kind:'external'};
      const bytes = await IOUtils.read(value.path, {maxBytes:maximum + 1}); check(ctx);
      if (bytes.length !== value.fileSize || bytes.length > maximum || signature(bytes) !== type) throw failure('supplements_file');
      return {...details, kind:type === 'application/pdf' ? 'pdf' : 'image', bytes};
    }
    async function open(reader, id) {
      const {ctx, value} = await attachment(reader, id); check(ctx);
      if (typeof Zotero.launchFile !== 'function') throw failure('supplements_unavailable');
      await Zotero.launchFile(value.path); return {opened:true};
    }
    return {list, find, download, chooseFiles, preview, open};
  }
  const api = {create}; root.AskGPTPaperSupplements = api;
  if (typeof module !== 'undefined') module.exports = api;
})(this);
