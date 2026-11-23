(function (root) {
  'use strict';

  const Reading = root.AskGPTPaperReadingActions ||
    (typeof module !== 'undefined' ? require('./paper-reading-actions.js') : null);
  const Topic = root.AskGPTPaperTopic ||
    (typeof module !== 'undefined' ? require('./paper-topic.js') : null);
  const colors = new Set(['#ffd400', '#2ea8e5', '#5fb236', '#e56eee', '#ff6666']);
  const marks = new Set(['highlight', 'underline']);
  const key = value => typeof value === 'string' && /^[A-Z0-9]{8}$/.test(value);
  const plain = value => typeof value === 'string' ? value.trim() : '';
  const comparable = value => plain(value).normalize('NFKC').replace(/\s+/gu, ' ');
  const escaped = value => value.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c])).replace(/\r\n?|\n/g, '<br>');
  const failure = (code, details) => Object.assign(new Error(code), {code}, details);
  const positivePage = page => Number.isInteger(page) && page > 0 && page <= 2000;
  const noteWrapper = /^(<div class="zotero-note znv[0-9]+">)([\s\S]*)<\/div>$/;
  const noteContent = value => plain(value).replace(noteWrapper, '$2');

  function annotationStyle(operation) {
    const {mark = 'highlight', color = '#ffd400'} = operation;
    const comment = plain(operation.comment);
    if (!marks.has(mark) || !colors.has(color) || comment.length > 12000
        || operation.comment !== undefined && !comment) throw failure('missing');
    return {mark, color, comment};
  }

  function nativePosition(value, page) {
    if (value?.pageIndex !== page - 1 || !Array.isArray(value.rects)
        || !value.rects.length || value.rects.length > 256) return null;
    const rects = [];
    for (const rect of value.rects) {
      if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(n => Number.isFinite(n) && Math.abs(n) < 1e7)
          || rect[2] <= rect[0] || rect[3] <= rect[1]) return null;
      rects.push(Array.from(rect));
    }
    const position = {pageIndex: page - 1, rects};
    return JSON.stringify(position).length <= 6000 ? position : null;
  }

  function existingPosition(item) {
    try { return JSON.parse(item.annotationPosition); } catch (_) { return null; }
  }

  function samePosition(a, b) {
    return !!a && a.pageIndex === b.pageIndex && Array.isArray(a.rects) && a.rects.length === b.rects.length
      && a.rects.every((rect, i) => Array.isArray(rect) && rect.length === 4
        && rect.every((n, j) => Math.abs(n - b.rects[i][j]) <= .75));
  }

  function create({Zotero, Components, reader, isCurrent, setTimer, clearTimer, revealOriginal, translateTopic} = {}) {
    if (!Reading || !Zotero?.Items?.get || !Zotero.DB?.executeTransaction || !Zotero.Item
        || !Zotero.Notifier?.Queue || !Zotero.Notifier.commit || typeof isCurrent !== 'function') return null;
    const boundID = reader?.itemID;
    let busy = false;
    const history = [];

    function attachment() {
      if (!isCurrent() || reader?.itemID !== boundID || reader?.type !== 'pdf' || reader?._isTabClosed) {
        throw failure('stale');
      }
      const item = Zotero.Items.get(boundID);
      if (item?.id !== boundID || !key(item.key) || !Number.isSafeInteger(item.libraryID) || item.libraryID < 1
          || item.deleted || !item.isAttachment?.() || !item.isPDFAttachment?.()) throw failure('stale');
      return item;
    }

    function parentFor(item) {
      const parent = item.parentID ? Zotero.Items.get(item.parentID) : null;
      if (!parent || parent.id !== item.parentID || parent.libraryID !== item.libraryID || parent.deleted
          || parent.isRegularItem?.() !== true) throw failure('missing');
      return parent;
    }

    function requireWritable(item) {
      if (item.isEditable?.() !== true || Zotero.Libraries?.get?.(item.libraryID)?.editable === false)
        throw failure('readonly');
    }

    function documentFor(item) {
      const view = reader._internalReader?._primaryView, win = view?._iframeWindow;
      const application = win?.PDFViewerApplication, pdf = application?.pdfDocument;
      if (!positivePage(pdf?.numPages) || application.pdfViewer?.pagesCount !== pdf.numPages) throw failure('stale');
      function current() {
        if (attachment() !== item || reader._internalReader?._primaryView !== view
            || view._iframeWindow?.PDFViewerApplication?.pdfDocument !== pdf || view._destroyed) throw failure('stale');
      }
      return {view, win, pdf, current, label(index) {
        try { return plain(view._getPageLabel?.(index, false)) || String(index + 1); }
        catch (_) { return String(index + 1); }
      }};
    }

    function citationList(context, item) {
      return (Array.isArray(context.citations) ? context.citations : []).slice(0, 100).flatMap((value, index) => {
        const quote = plain(value?.quote);
        return positivePage(value?.page) && quote && quote.length <= 6000
          && (value.attachmentID === undefined || value.attachmentID === item.libraryID + ':' + item.key)
          ? [{quote, page: value.page, citation: index + 1, marker: value.marker}] : [];
      });
    }

    async function locate(operation, context, citations, document, pageCache) {
      let quote = plain(operation.quote), suggested = [];
      const selection = plain(context.selectedText);
      const selectionOnly = operation.target === 'selection';
      if (operation.citation !== undefined) {
        const source = citations.find(value => value.citation === operation.citation);
        if (!source) throw failure('missing');
        quote = source.quote;
        suggested = [source.page];
      } else if ((!quote && operation.target !== 'citation' && selection) || selectionOnly) {
        quote = quote || selection;
        if (!selection || comparable(quote) !== comparable(selection) || !positivePage(context.page)) throw failure('missing');
        suggested = [context.page];
      } else if (quote) {
        const needle = comparable(quote);
        const related = citations.filter(source => comparable(source.quote).includes(needle));
        if (related.length) suggested = related.map(source => source.page);
        else {
          const extracted = (Array.isArray(context.pages) ? context.pages : []).slice(0, 32)
            .filter(page => positivePage(page?.number) && comparable(page?.text).includes(needle));
          suggested = extracted.map(page => page.number);
          if (positivePage(context.page)) suggested.unshift(context.page);
        }
      } else {
        const unique = [...new Map(citations.map(value => [value.page + ':' + comparable(value.quote), value])).values()];
        if (unique.length > 1) throw failure('ambiguous', {candidates: unique.map(({citation, page}) => ({citation, page}))});
        if (!unique.length) throw failure('missing');
        quote = unique[0].quote;
        suggested = [unique[0].page];
      }
      if (!quote || quote.length > 6000) throw failure('missing');
      const pages = [...new Set(suggested)].filter(page => page <= document.pdf.numPages);
      if (pages.length > 6) throw failure('ambiguous');
      const fromSelection = !operation.citation && operation.target !== 'citation'
        && document.pdf.numPages >= context.page && comparable(quote) === comparable(selection)
        && (selectionOnly || pages.length === 1 && pages[0] === context.page);
      // Native single-page selections carry their own geometry and disambiguate repeated text.
      if (fromSelection && positivePage(context.page)) {
        const position = nativePosition(context.selectedPosition, context.page);
        if (position) return {quote, page: context.page, position, offset: 0};
      }
      const results = await Promise.all(pages.map(async page => {
        const index = page - 1;
        let pending = pageCache.get(index);
        if (!pending) {
          pending = Reading.pageChars({...document, index, Components, setTimer, clearTimer, timeout: 750});
          pageCache.set(index, pending);
        }
        const chars = await pending;
        document.current();
        if (!chars?.length || chars.length > 100000) return {unread: true};
        const match = Reading.locateQuote(chars, quote);
        if (match?.ambiguous) throw failure('ambiguous');
        const position = nativePosition({pageIndex: index, rects: match?.rects}, page);
        return position ? {quote, page, position, offset: match.offset} : null;
      }));
      const matches = results.filter(result => result?.position);
      if (matches.length > 1 || matches.length && results.some(result => result?.unread)) throw failure('ambiguous');
      if (!matches.length) throw failure('missing');
      return matches[0];
    }

    async function locateAnswerQuotes(operation, context, document) {
      if (!Array.isArray(operation.quotes) || !operation.quotes.length || operation.quotes.length > 12
          || operation.quotes.some(quote => !plain(quote) || quote.length > 6000)) throw failure('missing');
      const quotes = [...new Set(operation.quotes.map(quote => plain(quote).replace(/\s+/gu, ' ')))];
      const found = quotes.map(() => null);
      const pageCount = document.pdf.numPages;
      let pagesScanned = 0;
      for (let start = 0; start < pageCount; start += 4) {
        document.current();
        const count = Math.min(4, pageCount - start);
        const pages = await Promise.all(Array.from({length: count}, async (_, offset) => {
          const index = start + offset;
          const chars = await Reading.pageChars({...document, index, Components, setTimer, clearTimer});
          document.current();
          return Array.isArray(chars) ? Reading.locateQuotes(chars, quotes) : null;
        }));
        document.current();
        pages.forEach((matches, pageOffset) => {
          if (!matches) return;
          pagesScanned++;
          const pageIndex = start + pageOffset, page = pageIndex + 1;
          matches.forEach((match, index) => {
            if (!match || found[index] === false) return;
            const position = nativePosition({pageIndex, rects: match.rects}, page);
            // An exact occurrence with unusable geometry still blocks a second match.
            found[index] = !position || found[index] ? false : {
              page, position, quote: quotes[index], offset: match.offset,
            };
          });
        });
        context.onProgress?.(start + count, pageCount);
      }
      document.current();
      // A failed page read cannot establish that the match is unique in the PDF.
      const matches = pagesScanned === pageCount ? found.filter(Boolean) : [];
      return {matches, report: {matched: matches.length, unresolvedMatches: quotes.length - matches.length,
        pagesScanned, pageCount}};
    }

    function noteBody(operation, context, citations, parent) {
      const explicit = operation.text !== undefined;
      const {target = 'answer'} = operation;
      if (!explicit && !['answer', 'selection', 'abstract'].includes(target)) throw failure('missing');
      const fromAnswer = !explicit && target === 'answer';
      let body;
      if (explicit) body = plain(operation.text);
      else if (target === 'selection') body = plain(context.selectedText) || plain(context.noteSelection);
      else if (target === 'abstract') body = plain(parent?.getField?.('abstractNote'));
      else body = plain(context.answer);
      if (!body || body.length > 64000) throw failure('missing');
      const referenced = fromAnswer && citations.length > 0;
      if (fromAnswer) {
        const references = new Map(citations.map(({marker, citation}) => [marker, citation]));
        body = body.replace(/\[\[(p\d{1,4}\.\d{1,4})\]\]/g,
          (_, marker) => references.has(marker) ? ' [' + references.get(marker) + ']' : '');
      }
      const html = '<p>' + escaped(body) + '</p>';
      if (!referenced) return html;
      return html + '<h3>原文出处 / Sources</h3><ol>' + citations.map(({page, quote}) =>
        '<li>PDF p. ' + page + ' · ' + escaped(quote) + '</li>').join('') + '</ol>';
    }

    function identity(value, item, parentID, type) {
      return !!value && !value.deleted && value.libraryID === item.libraryID && value.parentID === parentID
        && key(value.key) && (type === 'note' ? value.isNote?.() === true
          : marks.has(type) && value.isAnnotation?.() === true && value.annotationType === type);
    }

    function childNotes(item, parent) {
      return (parent.getNotes?.() || []).map(id => Zotero.Items.get(id))
        .filter(value => identity(value, item, parent.id, 'note'));
    }

    function fingerprint(value, type) {
      const common = [value.dateModified, value.getTags?.() || [], value.getRelations?.() || {}];
      return JSON.stringify(type === 'note' ? [...common, noteContent(value.getNote())] : [...common,
        value.annotationType, value.annotationText, value.annotationComment, value.annotationColor,
        value.annotationPosition, value.annotationPageLabel, value.annotationSortIndex, value.annotationIsExternal]);
    }

    function findSaved(row, item) {
      const value = Zotero.Items.getByLibraryAndKey?.(item.libraryID, row.key);
      try {
        return identity(value, item, row.parentID, row.type)
          && value.isEditable?.() === true && fingerprint(value, row.type) === row.fingerprint ? value : null;
      } catch (_) { return null; }
    }

    async function write(item, current, action) {
      const notifierQueue = new Zotero.Notifier.Queue();
      const edited = new Set();
      let result;
      try {
        result = await Zotero.DB.executeTransaction(async () => {
          if (attachment() !== item) throw failure('stale');
          current?.();
          const output = await action({notifierQueue, skipSelect: true}, value => edited.add(value));
          if (attachment() !== item) throw failure('stale');
          current?.();
          return output;
        }, {waitTimeout: 850});
      } catch (error) {
        for (const value of edited) {
          try { await value.reload?.(null, true); } catch (reloadError) { Zotero.logError?.(reloadError); }
        }
        throw error;
      }
      try { await Zotero.Notifier.commit(notifierQueue); }
      catch (error) { Zotero.logError?.(error); }
      return result;
    }

    function remember(rows) {
      if (!rows.length) return;
      history.push(rows);
      if (history.length > 12) history.shift();
    }

    async function save(item, operations, context) {
      const citations = citationList(context, item);
      const highlights = operations.filter(operation => operation.type === 'highlight');
      const requestedNotes = operations.filter(operation => operation.type === 'note');
      const topic = operations.length === 1 && operations[0].type === 'topic' ? operations[0] : null;
      const answerQuotes = operations.length === 1 && operations[0].type === 'answerQuotes' ? operations[0] : null;
      const paperText = operations.length === 1 && ['paperTitle', 'paperAbstract'].includes(operations[0].type)
        ? operations[0] : null;
      if (!topic && !answerQuotes && !paperText && requestedNotes.length + highlights.length !== operations.length) throw failure('missing');
      const parent = requestedNotes.length ? parentFor(item) : null;
      if (parent) requireWritable(parent);
      const notes = requestedNotes.map(operation => noteBody(operation, context, citations, parent));
      const needsDocument = highlights.length || topic || answerQuotes || paperText;
      if (needsDocument) requireWritable(item);
      const document = needsDocument ? documentFor(item) : null;
      const pageCache = new Map();
      const response = {highlights: 0, notes: 0, skipped: 0, locations: [], noteKeys: []};
      let resolved;
      if (topic) {
        if (!Topic || typeof topic.topic !== 'string' || !topic.topic.trim() || topic.topic.length > 100) throw failure('missing');
        const style = annotationStyle(topic);
        // Only the search terms enter the local system translator.
        const translatedTopic = await translateTopic?.(topic.topic, context.pages).catch(() => null);
        document.current();
        const {matches, pagesScanned, pageCount, unresolvedMatches} = await Topic.find({
          document, Components, setTimer, clearTimer, topic: topic.topic, translatedTopic,
          onProgress: context.onProgress, pageCache,
        });
        response.topicScan = {matched: matches.length, pagesScanned, pageCount, unresolvedMatches};
        resolved = matches.map(location => ({...location, ...style}));
        if (!resolved.length) return response;
      } else if (answerQuotes || paperText) {
        let target = answerQuotes;
        const abstract = paperText?.type === 'paperAbstract';
        const missingText = abstract ? 'paper-abstract-missing' : 'paper-title-missing';
        const style = annotationStyle(paperText || answerQuotes);
        if (paperText) {
          const metadata = item.parentID ? parentFor(item) : item;
          const quote = comparable(metadata.getField?.(abstract ? 'abstractNote' : 'title'));
          if (!quote || quote.length > 6000) throw failure(missingText);
          target = {quotes: [quote]};
        }
        const {matches, report} = await locateAnswerQuotes(target, context, document);
        if (paperText && !matches.length)
          throw failure(report.pagesScanned < report.pageCount ? 'paper-text-unread' : missingText);
        if (!paperText) response.answerQuotesScan = report;
        if (!matches.length) return response;
        resolved = matches.map(location => ({...location, ...style}));
      } else {
        resolved = await Promise.all(highlights.map(async operation => {
          const style = annotationStyle(operation);
          return {...await locate(operation, context, citations, document, pageCache), ...style};
        }));
      }
      const rows = await write(item, document?.current, async (options, trackEdit) => {
        if (resolved.length) requireWritable(item);
        if (parent) {
          if (parentFor(item) !== parent) throw failure('stale');
          requireWritable(parent);
        }
        const saved = [];
        const existing = resolved.length ? item.getAnnotations() : [];
        for (const location of resolved) {
          document.current();
          const {mark, comment, page, quote, position} = location;
          const matching = existing.filter(value => identity(value, item, item.id, mark)
            && samePosition(existingPosition(value), position));
          const duplicate = matching.some(value => !comment || plain(value.annotationComment) === comment);
          if (duplicate) { response.skipped++; continue; }
          const match = matching.length === 1 ? matching[0] : null;
          if (comment && match?.isEditable?.() === true && !match.annotationIsExternal && !plain(match.annotationComment)) {
            const previousComment = match.annotationComment || '';
            const created = saved.find(row => row.key === match.key);
            if (!created) trackEdit(match);
            match.annotationComment = comment;
            await match.save(options);
            response.comments = (response.comments || 0) + 1;
            const updatedFingerprint = fingerprint(match, mark);
            if (created) created.fingerprint = updatedFingerprint;
            else {
              response.locations.push({page, quote, position});
              saved.push({type: mark, key: match.key, parentID: item.id, previousComment, fingerprint: updatedFingerprint});
            }
            continue;
          }
          const annotation = new Zotero.Item('annotation');
          annotation.libraryID = item.libraryID;
          annotation.parentID = item.id;
          annotation.annotationType = mark;
          annotation.annotationText = location.quote;
          annotation.annotationComment = location.comment;
          annotation.annotationColor = location.color;
          annotation.annotationPageLabel = document.label(location.position.pageIndex);
          annotation.annotationSortIndex = String(location.position.pageIndex).padStart(5, '0') + '|'
            + String(location.offset).padStart(6, '0') + '|00000';
          annotation.annotationPosition = JSON.stringify(location.position);
          await annotation.save(options);
          if (!identity(annotation, item, item.id, mark)) throw failure('failed');
          existing.push(annotation);
          if (mark === 'underline') response.underlines = (response.underlines || 0) + 1;
          else response.highlights++;
          if (comment) response.comments = (response.comments || 0) + 1;
          response.locations.push({page, quote, position});
          saved.push({type: mark, key: annotation.key, parentID: item.id, fingerprint: fingerprint(annotation, mark)});
        }
        const existingNotes = notes.length ? childNotes(item, parent) : [];
        for (const html of notes) {
          if (attachment() !== item || parentFor(item) !== parent) throw failure('stale');
          const matched = existingNotes.find(value => {
            try { return noteContent(value.getNote()) === html; } catch (_) { return false; }
          });
          if (matched) { response.skipped++; continue; }
          const note = new Zotero.Item('note');
          note.libraryID = item.libraryID;
          note.parentID = parent.id;
          note.setNote(html);
          await note.save(options);
          if (!identity(note, item, parent.id, 'note')) throw failure('failed');
          existingNotes.push(note);
          response.notes++;
          response.noteKeys.push(note.key);
          saved.push({type: 'note', key: note.key, parentID: parent.id, fingerprint: fingerprint(note, 'note')});
        }
        return saved;
      });
      remember(rows);
      return response;
    }

    async function editNote(item, operation) {
      const body = plain(operation.text);
      const title = plain(operation.title);
      if (!body || body.length > 64000 || operation.title !== undefined && !title) throw failure('missing-note');
      const parent = parentFor(item);
      requireWritable(parent);
      const response = {highlights: 0, notes: 0, updatedNotes: 0, skipped: 0, locations: [], noteKeys: []};
      const rows = await write(item, null, async (options, trackEdit) => {
        if (parentFor(item) !== parent) throw failure('stale');
        requireWritable(parent);
        let note;
        if (title) {
          const matches = childNotes(item, parent).filter(value => plain(value.getNoteTitle?.()) === title);
          if (matches.length > 1) throw failure('ambiguous-note');
          [note] = matches;
        } else {
          const created = history.findLast(batch => batch.some(row => row.type === 'note' && row.previousNote === undefined))
            ?.findLast(row => row.type === 'note' && row.previousNote === undefined);
          const recent = created && history.findLast(batch => batch.some(row => row.key === created.key))
            ?.findLast(row => row.key === created.key);
          if (recent?.parentID === parent.id) note = findSaved(recent, item);
        }
        if (!note) throw failure('missing-note');
        requireWritable(note);
        let previousNote;
        try { previousNote = note.getNote(); }
        catch (_) {
          await note.loadDataType?.('note');
          previousNote = note.getNote();
        }
        if (!identity(note, item, parent.id, 'note') || parentFor(item) !== parent) throw failure('stale');
        if (title && plain(note.getNoteTitle?.()) !== title) throw failure('missing-note');
        const paragraph = '<p>' + escaped(body) + '</p>';
        const content = noteContent(previousNote);
        const append = operation.type === 'noteAppend';
        if (append ? content.endsWith(paragraph) : content === paragraph) {
          response.skipped++;
          response.noteKeys.push(note.key);
          return [];
        }
        const next = (append ? content : '') + paragraph;
        const wrapper = noteWrapper.exec(plain(previousNote))?.[1];
        trackEdit(note);
        note.setNote(wrapper ? wrapper + next + '</div>' : next);
        await note.save(options);
        response.updatedNotes++;
        response.noteKeys.push(note.key);
        return [{type: 'note', key: note.key, parentID: parent.id, previousNote, fingerprint: fingerprint(note, 'note')}];
      });
      remember(rows);
      return response;
    }

    async function adjust(item, operation) {
      const undoHighlight = operation.type === 'undoHighlight';
      const undo = operation.type === 'undo' || undoHighlight;
      if (!undo && !colors.has(operation.color)) throw failure('missing');
      const batchUndo = undo && !undoHighlight;
      const index = batchUndo ? history.length - 1 : history.findLastIndex(rows => rows.some(row => row.type === 'highlight'));
      if (index < 0) throw failure(undoHighlight ? 'no-recent-highlight' : 'missing');
      const recent = history[index];
      const rows = batchUndo ? recent : recent.filter(row => row.type === 'highlight');
      if (undoHighlight && rows.length !== 1) throw failure('choose-highlight-undo');
      const response = {highlights: 0, notes: 0, skipped: 0, [undo ? 'undone' : 'updated']: 0};
      const trashed = [];
      const changes = await write(item, null, async (options, trackEdit) => {
        if (rows.some(row => marks.has(row.type))) requireWritable(item);
        const updated = [];
        for (const row of rows) {
          if (attachment() !== item) throw failure('stale');
          const value = findSaved(row, item);
          if (!value) { response.skipped++; continue; }
          if (undo) {
            // A generated item remains recoverable in Trash.
            const restoring = row.previousNote !== undefined || row.previousComment !== undefined
              || row.previousColor !== undefined;
            if (row.type === 'note') requireWritable(parentFor(item));
            trackEdit(value);
            if (row.previousNote !== undefined) value.setNote(row.previousNote);
            else if (row.previousComment !== undefined) value.annotationComment = row.previousComment;
            else if (row.previousColor !== undefined) value.annotationColor = row.previousColor;
            else {
              value.deleted = true;
              if (marks.has(row.type)) trashed.push(row.key);
            }
            await value.save(options);
            if (restoring) updated.push({key: row.key, fingerprint: fingerprint(value, row.type)});
            response.undone++;
          } else {
            const previousColor = value.annotationColor;
            if (previousColor === operation.color) { response.skipped++; continue; }
            trackEdit(value);
            value.annotationColor = operation.color;
            await value.save(options);
            updated.push({type: row.type, key: row.key, parentID: row.parentID, previousColor,
              fingerprint: fingerprint(value, row.type)});
            response.updated++;
          }
        }
        return updated;
      });
      if (undo) {
        const remaining = undoHighlight ? recent.filter(row => row.type !== 'highlight') : [];
        if (remaining.length) history[index] = remaining;
        else history.splice(index, 1);
        for (const change of changes) {
          const previous = history.findLast(batch => batch.some(row => row.key === change.key))?.find(row => row.key === change.key);
          if (previous) previous.fingerprint = change.fingerprint;
        }
      } else remember(changes);
      if (trashed.length) {
        // Zotero repaints saved annotations through the notifier. Its reader
        // only removes annotations on permanent deletion, so remove the view
        // for recoverable Trash explicitly after the transaction commits.
        const readers = new Set([reader, ...(Zotero.Reader?._readers || [])]);
        await Promise.all([...readers].filter(target => target.itemID === item.id && !target._isTabClosed)
          .map(async target => {
            try { await target.unsetAnnotations?.(trashed); } catch (error) { Zotero.logError?.(error); }
          }));
      }
      return response;
    }

    async function execute(operations, context = {}) {
      if (busy) throw failure('failed');
      if (!Array.isArray(operations) || !operations.length || operations.length > 12) throw failure('missing');
      const item = attachment();
      busy = true;
      try {
        if (operations.length === 1 && ['undo', 'undoHighlight', 'recolor'].includes(operations[0]?.type))
          return await adjust(item, operations[0]);
        if (operations.length === 1 && ['noteAppend', 'noteReplace'].includes(operations[0]?.type))
          return await editNote(item, operations[0]);
        if (operations.some(operation => !operation)) throw failure('missing');
        return await save(item, operations, context);
      } catch (error) {
        if (['ambiguous', 'missing', 'readonly', 'stale', 'failed', 'too-many-topic',
          'paper-title-missing', 'paper-abstract-missing', 'paper-text-unread', 'no-recent-highlight',
          'choose-highlight-undo', 'missing-note', 'ambiguous-note'].includes(error?.code)) throw error;
        Zotero.logError?.(error);
        throw failure('failed');
      } finally { busy = false; }
    }

    async function reveal(location) {
      const item = attachment();
      await revealOriginal?.(reader);
      if (attachment() !== item) throw failure('stale');
      const document = documentFor(item);
      const {page} = location || {};
      if (!positivePage(page) || page > document.pdf.numPages) throw failure('missing');
      const position = nativePosition(location.position, page);
      if (!position || typeof document.view.navigateToPosition !== 'function') throw failure('missing');
      const win = reader._iframeWindow || document.win;
      const clone = value => Components?.utils?.cloneInto ? Components.utils.cloneInto(value, win) : value;
      await document.view.navigateToPosition(clone(position), clone({block: 'center', inline: 'nearest', behavior: 'instant'}));
    }

    function openNote(noteKey) {
      const item = attachment(), parent = parentFor(item);
      const note = key(noteKey) && Zotero.Items.getByLibraryAndKey?.(item.libraryID, noteKey);
      if (!identity(note, item, parent.id, 'note')) throw failure('missing');
      if (typeof Zotero.Notes?.open === 'function') return Zotero.Notes.open(note.id, undefined, {});
      const pane = reader._window?.ZoteroPane || Zotero.getActiveZoteroPane?.();
      if (typeof pane?.openNote !== 'function') throw failure('missing');
      return pane.openNote(note.id, {openInWindow: true});
    }

    return {execute, reveal, openNote};
  }

  const api = {create};
  root.AskGPTPaperCommands = api;
  if (typeof module !== 'undefined') module.exports = api;
})(this);
