(function (root) {
  'use strict';
  const BASE = 'http://127.0.0.1:43792';
  class InlineError extends Error {
    constructor(code) { super(code); this.code = code; }
  }
  function errorMessage(error) {
    const messages = {
      connection: '请开启 Ask for GPT 原页翻译连接',
      permissions: '连接权限异常，请重新开启连接',
      compatibility: 'PDF 接口不可用，请重新打开 PDF',
      read: 'PDF 文字读取失败，请重新打开 PDF',
      direction: '仅支持英语与中文互译',
      text: '本页超限，未完整读取',
      limit: '已达本次上限，全文未完成',
      response: '译文无效，请重试',
      timeout: '翻译超时，点继续重试',
      native: '请检查英中翻译语言包',
      bridge: '本机连接失败，请启动 Ask for GPT'
    };
    return messages[error?.code] || messages.bridge;
  }
  function validateConnection(value) {
    if (!value || value.version !== 1 || ![BASE, BASE + '/'].includes(value.endpoint)
      || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value.token)) {
      throw new InlineError('connection');
    }
    return { url: BASE + '/v1/inline/translate', token: value.token };
  }
  function validateResponse(value, id) {
    if (!value || value.id !== id || typeof value.translation !== 'string'
      || !value.translation.trim() || value.translation.length > 18000) throw new InlineError('response');
    return value.translation.trim();
  }
  function appendSoftSpace(text) { return /[-\u2010\u2011\s]$/.test(text) ? text : text + ' '; }
  function rectOf(char) {
    const rect = char?.rect;
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return null;
    return { left: Math.min(rect[0], rect[2]), right: Math.max(rect[0], rect[2]),
      bottom: Math.min(rect[1], rect[3]), top: Math.max(rect[1], rect[3]), height: Math.max(1, Math.abs(rect[3] - rect[1])) };
  }
  function paragraphsFromChars(chars) {
    if (!Array.isArray(chars) || chars.length > 300000) throw new InlineError('text');
    const paragraphs = []; let text = '', characters = 0, previous = null;
    const flush = () => { if (text.trim()) paragraphs.push(text.trim()); text = ''; };
    // Zotero has already structured/sorted these chars. Retain that order and
    // its paragraph markers; do not sort individual scientific glyphs by y.
    for (const char of chars) {
      if (!char || char.ignorable) continue;
      if (typeof char.c !== 'string') throw new InlineError('compatibility');
      characters += char.c.length;
      if (characters > 300000) throw new InlineError('text');
      const rect = rectOf(char), before = previous?.rect;
      if (rect && before && ![90, 270].includes(char.rotation) && ![90, 270].includes(previous.char.rotation)) {
        const height = Math.max(rect.height, before.height);
        const sameLine = Math.abs(rect.bottom - before.bottom) <= height * 0.65;
        // Missing break markers must not glue separate columns or a return
        // from the bottom of one column to the top of the next into one block.
        if ((sameLine && rect.left - before.right > height * 2.5)
          || (previous.char.lineBreakAfter && rect.bottom > before.bottom + height)
          || (rect.bottom > before.bottom + height * 1.8 && Math.abs(rect.left - before.left) > height * 2.5)) flush();
      }
      text += char.c;
      if (char.paragraphBreakAfter) flush();
      else if (char.spaceAfter || char.lineBreakAfter) text = appendSoftSpace(text);
      previous = { char, rect };
    }
    flush(); return paragraphs;
  }
  function paragraphsFromPDFJSItems(items) {
    if (!Array.isArray(items) || items.length > 100000) throw new InlineError('text');
    let characters = 0;
    const fragments = [];
    for (const item of items) {
      if (typeof item?.str !== 'string') continue;
      characters += item.str.length;
      if (characters > 300000) throw new InlineError('text');
      if (!item.str.trim()) continue;
      const x = item.transform?.[4], y = item.transform?.[5];
      const height = Math.max(1, Math.abs(item.height || item.transform?.[3] || 12));
      const width = Number.isFinite(item.width) ? Math.abs(item.width) : Array.from(item.str).length * height * 0.5;
      fragments.push({ text: item.str, order: fragments.length, x, right: Number.isFinite(x) ? x + width : null, y, height,
        eol: item.hasEOL, vertical: item.dir === 'ttb'
          || (Number.isFinite(item.transform?.[1]) && Math.abs(item.transform[1]) > Math.abs(item.transform[0] || 0)) });
    }
    if (!fragments.length) return [];
    const positioned = fragments.filter(item => Number.isFinite(item.x) && Number.isFinite(item.y) && !item.vertical);
    const isolated = fragments.filter(item => !Number.isFinite(item.x) || !Number.isFinite(item.y) || item.vertical);
    if (!positioned.length) {
      // No reliable geometry: retain content-stream order rather than invent a
      // spatial order. EOL remains a soft wrap; explicit blank gaps are absent.
      let text = '', previous = null;
      for (const item of items) {
        if (typeof item?.str !== 'string') continue;
        if (previous?.hasEOL) text = appendSoftSpace(text);
        text += item.str; previous = item;
      }
      return text.trim() ? [text.trim()] : [];
    }
    const rows = [];
    for (const item of positioned.slice().sort((a, b) => b.y - a.y || a.x - b.x)) {
      let row = rows.at(-1);
      if (!row || Math.abs(row.y - item.y) > Math.max(row.height, item.height) * 0.65) {
        row = { y: item.y, height: item.height, items: [] }; rows.push(row);
      }
      row.items.push(item); row.height = Math.max(row.height, item.height);
    }
    // Superscript/subscript baselines can sit just outside normal line
    // tolerance. Bind only short, smaller glyph runs to nearby larger text;
    // widening the tolerance for all text would merge adjacent body lines.
    // Search a fixed number of neighbouring rows and x-neighbours, not all
    // fragment pairs, so a highly fragmented page has bounded per-item work.
    for (const row of rows) row.items.sort((a, b) => a.x - b.x);
    const attached = new Map(), itemRows = new Map();
    for (const row of rows) for (const item of row.items) itemRows.set(item, row);
    let weight = positioned.reduce((sum, item) => sum + item.text.length, 0) / 2, bodyHeight = 12;
    for (const item of positioned.slice().sort((a, b) => a.height - b.height)) {
      weight -= item.text.length;
      if (weight <= 0) { bodyHeight = item.height; break; }
    }
    function anchorScore(item, anchor) {
      if (!anchor || !itemRows.has(anchor) || item.height > anchor.height * 0.75 || item.height < anchor.height * 0.25
        || Math.abs(item.y - anchor.y) > anchor.height * 0.95) return null;
      const postfix = item.x >= anchor.x + anchor.height * 0.2 && item.x <= anchor.right + anchor.height * 0.7;
      const prefix = item.right <= anchor.x + anchor.height * 0.15 && anchor.x - item.right <= anchor.height * 0.7;
      if (!postfix && !prefix) return null;
      return (Math.abs(item.y - anchor.y) + Math.max(0, item.x - anchor.right, anchor.x - item.right)) / anchor.height;
    }
    function nearestX(values, x) {
      let left = 0, right = values.length;
      while (left < right) {
        const middle = (left + right) >>> 1;
        if (values[middle].x < x) left = middle + 1; else right = middle;
      }
      return left;
    }
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      for (const item of row.items) {
        const value = item.text.trim();
        if (item.height > bodyHeight * 0.8 || Array.from(value).length > 12 || /\s/.test(value)) continue;
        let best = null;
        // Nearby source-stream fragments retain the local base/exponent link
        // even when the next line's raised glyph is geometrically closer to
        // the preceding baseline. Only these tiny runs use source adjacency;
        // page/column order is still derived from reliable geometry.
        for (let distance = 1; distance <= 4 && !best; distance++) {
          for (const offset of [-distance, distance]) {
            const anchor = fragments[item.order + offset], score = anchorScore(item, anchor);
            if (score !== null && (!best || score < best.score)) best = { row: itemRows.get(anchor), score };
          }
        }
        if (!best) for (let near = Math.max(0, rowIndex - 8); near <= Math.min(rows.length - 1, rowIndex + 8); near++) {
          const candidate = rows[near], index = nearestX(candidate.items, item.x);
          for (let position = Math.max(0, index - 2); position < Math.min(candidate.items.length, index + 2); position++) {
            const score = anchorScore(item, candidate.items[position]);
            if (score !== null && (!best || score < best.score)) best = { row: candidate, score };
          }
        }
        if (best) attached.set(item, best.row);
      }
    }
    const rowItems = new Map(rows.map(row => [row, []]));
    for (const row of rows) for (const item of row.items) rowItems.get(attached.get(item) || row).push(item);
    const lines = [];
    for (const row of rows) {
      row.items = rowItems.get(row);

      let line = null, previous = null;
      for (const item of row.items.sort((a, b) => a.x - b.x)) {
        const gap = previous ? item.x - previous.right : 0;
        if (!line || gap > Math.max(row.height, item.height) * 2.5) {
          line = { text: '', x: item.x, right: item.right, y: item.y, height: item.height, row };
          lines.push(line);
        } else if (gap > Math.max(previous.height, item.height) * 0.12 && !/^\s/.test(item.text)) {
          line.text = appendSoftSpace(line.text);
        }
        line.text += item.text; line.right = Math.max(line.right, item.right);
        if (item.height > line.height) { line.height = item.height; line.y = item.y; }
        previous = item;
      }
    }
    function paragraphsFromLines(group) {
      const paragraphs = []; let text = '', previous = null, startX = 0;
      const flush = () => { if (text.trim()) paragraphs.push(text.trim()); text = ''; };
      const maximumWidth = group.reduce((maximum, line) => Math.max(maximum, line.right - line.x), 1);
      for (const line of group.slice().sort((a, b) => b.y - a.y || a.x - b.x)) {
        if (previous) {
          const height = Math.max(previous.height, line.height), gap = previous.y - line.y;
          const fontChange = Math.max(previous.height, line.height) / Math.min(previous.height, line.height) > 1.24;
          const indented = line.x - startX > height * 0.85;
          const endedShort = previous.right - previous.x < maximumWidth * 0.72 && /[.!?。！？:：;；]$/.test(previous.text.trim());
          const separateOnSameRow = Math.abs(gap) < height * 0.65 && line.x - previous.right > height * 2.5;
          if (gap > height * 1.8 || gap < -height || fontChange || indented || endedShort || separateOnSameRow) flush();
          else text = appendSoftSpace(text);
        }
        if (!text) startX = line.x;
        text += line.text; previous = line;
      }
      flush(); return paragraphs;
    }
    function orderedParagraphs(group, depth = 0) {
      if (depth > 6 || group.length < 4) return paragraphsFromLines(group);
      // A gutter needs lines on both sides and shared vertical extent. Spanning
      // headings are kept between their adjacent column bands, never sorted
      // into one of the body columns. The source item stream may interleave
      // columns, so it cannot be used as the reading order.
      const rowGroups = new Map();
      for (const line of group) {
        if (!rowGroups.has(line.row)) rowGroups.set(line.row, []);
        rowGroups.get(line.row).push(line);
      }
      const candidates = new Map();
      for (const row of rowGroups.values()) {
        row.sort((a, b) => a.x - b.x);
        for (let i = 1; i < row.length; i++) {
          const left = row[i - 1], right = row[i];
          if (right.x - left.right <= Math.max(left.height, right.height) * 2.5) continue;
          const cut = Math.round((left.right + right.x) / 2);
          candidates.set(cut, (candidates.get(cut) || 0) + 1);
        }
      }
      // Staggered baselines can leave every row with one fragment. Large
      // repeated changes in line starts still expose a real column gutter.
      const starts = group.slice().sort((a, b) => a.x - b.x), startGaps = [];
      for (let i = 1; i < starts.length; i++) {
        const before = starts[i - 1], after = starts[i], gap = after.x - before.x;
        if (gap > Math.max(before.height, after.height) * 3) startGaps.push({ x: after.x, gap, height: Math.max(before.height, after.height) });
      }
      for (const boundary of startGaps.sort((a, b) => b.gap - a.gap).slice(0, 64)) {
        let right = -Infinity;
        for (const line of group) {
          if (line.x < boundary.x && line.right < boundary.x - boundary.height * 2.5) right = Math.max(right, line.right);
        }
        if (Number.isFinite(right)) {
          const cut = Math.round((right + boundary.x) / 2);
          candidates.set(cut, (candidates.get(cut) || 0) + 1);
        }
      }
      let best = null;
      // Bound work for unusually fragmented pages instead of an O(n²) scan of
      // every possible gutter. Repeated gutters are evaluated first.
      for (const [cut] of [...candidates].sort((a, b) => b[1] - a[1]).slice(0, 64)) {
        let leftCount = 0, rightCount = 0, leftMin = Infinity, leftMax = -Infinity,
          rightMin = Infinity, rightMax = -Infinity, height = Infinity;
        const spanning = [];
        for (const line of group) {
          if (line.right < cut) { leftCount++; leftMin = Math.min(leftMin, line.y); leftMax = Math.max(leftMax, line.y); height = Math.min(height, line.height); }
          else if (line.x > cut) { rightCount++; rightMin = Math.min(rightMin, line.y); rightMax = Math.max(rightMax, line.y); height = Math.min(height, line.height); }
          else spanning.push(line);
        }
        if (leftCount < 2 || rightCount < 2 || Math.min(leftMax, rightMax) - Math.max(leftMin, rightMin) < height * 0.25) continue;
        const score = Math.min(leftCount, rightCount) * 2 - spanning.length;
        if (!best || score > best.score) best = { cut, score, spanning };
      }
      if (!best) return paragraphsFromLines(group);
      const spanning = new Set(best.spanning), output = [];
      const remaining = group.filter(line => !spanning.has(line)).sort((a, b) => b.y - a.y || a.x - b.x);
      const band = values => {
        output.push(...orderedParagraphs(values.filter(line => line.right < best.cut), depth + 1));
        output.push(...orderedParagraphs(values.filter(line => line.x > best.cut), depth + 1));
      };
      let cursor = 0;
      for (const span of best.spanning.slice().sort((a, b) => b.y - a.y || a.x - b.x)) {
        const above = [];
        while (cursor < remaining.length && remaining[cursor].y > span.y) above.push(remaining[cursor++]);
        band(above); output.push(span.text.trim());
      }
      band(remaining.slice(cursor)); return output;
    }
    // Unsupported marginal/coordinate-free fragments remain separate blocks.
    // They cannot force reliably positioned columns back into stream order.
    return [...orderedParagraphs(lines), ...isolated.map(item => item.text.trim())];
  }
  function splitBlocks(paragraphs, maximum = 1800) {
    const blocks = [];
    for (const raw of paragraphs) {
      let points = Array.from(String(raw).replace(/\r\n?/g, '\n').trim());
      while (points.length > maximum) {
        let end = maximum;
        for (let i = maximum; i >= maximum / 2; i--) {
          if (/\s/.test(points[i])) { end = i; break; }
        }
        blocks.push(points.slice(0, end).join('').trim());
        points = Array.from(points.slice(end).join('').trim());
      }
      const tail = points.join('');
      if (tail) blocks.push(tail);
    }
    if (blocks.length > 2000) throw new InlineError('text');
    return blocks;
  }
  function resolvePDFContext(reader) {
    const win = reader?._internalReader?._primaryView?._iframeWindow;
    const application = win?.PDFViewerApplication;
    const pdfDocument = application?.pdfDocument, viewer = application?.pdfViewer;
    if (reader?.type !== 'pdf' || !win?.document || !pdfDocument || !viewer
      || (!pdfDocument.getPageData && !pdfDocument.getPage) || !Number.isInteger(viewer.currentPageNumber)
      || !Number.isInteger(viewer.pagesCount) || viewer.pagesCount < 1
      || viewer.currentPageNumber < 1 || viewer.currentPageNumber > viewer.pagesCount) throw new InlineError('compatibility');
    return { win, application, pdfDocument, viewer, pageIndex: viewer.currentPageNumber - 1, pageCount: viewer.pagesCount };
  }
  class InlineRun {
    constructor(options) {
      const source = options.source ?? 'en', target = options.target ?? 'zh-Hans';
      if (!((source === 'en' && target === 'zh-Hans') || (source === 'zh-Hans' && target === 'en'))) {
        throw new InlineError('direction');
      }
      this.source = source; this.target = target;
      this.options = options; this.pages = new Map(); this.epoch = 0; this.cancellers = new Set();
      this.disposed = false; this.characters = 0; this.blocks = 0;
      this.maximumCharacters = options.maximumCharacters ?? 2000000;
      this.nonce = 'z' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
    status(value) { this.options.onStatus?.(value); }
    stop(emit = true) {
      this.epoch++;
      for (const cancel of this.cancellers) { try { cancel(); } catch (_) {} }
      this.cancellers.clear();
      if (emit && !this.disposed) this.status({ state: 'stopped' });
    }
    dispose() { this.stop(false); this.disposed = true; this.pages.clear(); }
    async start(indices) {
      if (this.disposed) return;
      this.stop(false); const epoch = this.epoch;
      const valid = () => !this.disposed && this.epoch === epoch && (this.options.isCurrent?.() ?? true);
      if (!Array.isArray(indices) || indices.length > 2000) { this.status({ state: 'limit' }); return; }
      this.status({ state: 'working', total: indices.length });
      let failed = 0, empty = 0, done = 0, consecutiveFailures = 0;
      for (const pageIndex of indices) {
        if (!valid()) return;
        let blocks = this.pages.get(pageIndex);
        try {
          if (!blocks) {
            const paragraphs = await this.options.readPage(pageIndex);
            if (!valid()) return;
            const texts = splitBlocks(paragraphs);
            const count = texts.reduce((sum, text) => sum + text.length, 0);
            if (this.characters + count > this.maximumCharacters || this.blocks + texts.length > 10000) throw new InlineError('limit');
            blocks = texts.map((original, index) => ({ id: `${this.nonce}-p${pageIndex}-b${index}`, pageIndex, original, translation: '', error: '' }));
            this.characters += count; this.blocks += blocks.length; this.pages.set(pageIndex, blocks);
          }
          this.options.onPage?.({ pageIndex, blocks: blocks.map(x => ({ ...x })), empty: blocks.length === 0 });
          if (!blocks.length) { empty++; continue; }
          for (const block of blocks) {
            if (!valid()) return;
            if (block.translation) continue;
            let cancel = null;
            try {
              const response = await this.options.translate({ id: block.id, text: block.original, source: this.source, target: this.target }, value => {
                cancel = value;
                if (valid()) this.cancellers.add(value); else { try { value(); } catch (_) {} }
              });
              if (!valid()) return;
              const translation = validateResponse(response, block.id);
              if (this.characters + translation.length > this.maximumCharacters) throw new InlineError('limit');
              block.translation = translation; block.error = ''; this.characters += translation.length;
              this.options.onTranslation?.({ ...block }); consecutiveFailures = 0;
            } catch (error) {
              if (!valid()) return;
              if (error?.code === 'limit') throw error;
              block.error = errorMessage(error); failed++; consecutiveFailures++;
              this.options.onTranslation?.({ ...block });
              if (consecutiveFailures >= 3) { this.status({ state: 'error', failed, empty, done }); return; }
            } finally { if (cancel) this.cancellers.delete(cancel); }
          }
          done++; this.status({ state: 'working', done, total: indices.length, empty, failed });
        } catch (error) {
          if (!valid()) return;
          if (error?.code === 'limit' || error?.code === 'text') { this.status({ state: 'limit' }); return; }
          this.options.onPage?.({ pageIndex, blocks: [], error: errorMessage(error), empty: false });
          failed++;
        }
      }
      if (valid()) this.status({ state: failed || empty ? 'incomplete' : 'complete', done, total: indices.length, failed, empty });
    }
  }
  const api = { InlineError, errorMessage, validateConnection, validateResponse, paragraphsFromChars,
    paragraphsFromPDFJSItems, splitBlocks, resolvePDFContext, InlineRun };
  root.AskGPTInlineCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(this);
