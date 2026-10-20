(() => {
  'use strict';
  if (globalThis.__ASKGPT_INLINE_V1__) return;
  const OWN = 'data-askgpt-inline-owned';
  const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,dd,dt,td,th,[role="paragraph"]';
  const COMPLEX = 'form,input,textarea,select,button,[contenteditable],[role="textbox"],pre,code,kbd,samp,math,mjx-container,.katex,.MathJax,[role="math"]';
  const EXCLUDE = 'form,input,textarea,select,button,pre,code,kbd,samp,script,style,noscript,nav,math,mjx-container,svg,canvas,iframe,object,embed,[contenteditable],[role="textbox"],[role="navigation"],[role="menu"],[role="toolbar"],[hidden],[aria-hidden="true"],[' + OWN + ']';
  const MAX_RECORDS = 1200, MAX_SOURCE = 300_000, MAX_SCAN = 10_000;
  const COLOR_KEY = 'askgpt.inline.translationColor';
  const COLORS = {
    theme: { label: 'Theme', swatch: 'linear-gradient(135deg,#f8fafc 50%,#475569 50%)' },
    blue: { label: 'Blue', light: '#1d4ed8', dark: '#93c5fd', swatch: '#3b82f6' },
    green: { label: 'Green', light: '#047857', dark: '#6ee7b7', swatch: '#10b981' },
    purple: { label: 'Purple', light: '#7c3aed', dark: '#c4b5fd', swatch: '#a78bfa' }
  };
  const DIRECTIONS = {
    'en-zh': { source: 'en', target: 'zh-Hans', label: 'EN→中' },
    'zh-en': { source: 'zh-Hans', target: 'en', label: '中→EN' }
  };
  let run;
  function urlKey() { const url = new URL(location.href); url.hash = ''; return url.href; }
  function message(value) {
    return new Promise(resolve => {
      let finished = false;
      const finish = result => { if (!finished) { finished = true; clearTimeout(timer); resolve(result); } };
      const timer = setTimeout(() => finish({ ok: false, code: 'TIMEOUT' }), 15_000);
      try {
        chrome.runtime.sendMessage(value, response => {
          if (chrome.runtime.lastError) finish({ ok: false, code: 'DISCONNECTED' });
          else finish(response || { ok: false, code: 'FAILED' });
        });
      } catch { finish({ ok: false, code: 'DISCONNECTED' }); }
    });
  }
  function owned(node) {
    const element = node.nodeType === 1 ? node : node.parentElement;
    return !!element?.closest?.('[' + OWN + ']');
  }
  function eligible(element) {
    if (!element?.isConnected || element.closest(EXCLUDE)) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
          Number.parseFloat(style.opacity) === 0) return false;
    }
    return true;
  }
  function complex(element) { return element.matches(COMPLEX) || !!element.querySelector(COMPLEX); }
  function leaf(element) { return eligible(element) && !complex(element) && !element.querySelector(BLOCKS); }
  function sourceText(element) {
    if (!eligible(element)) return '';
    const pieces = [];
    function read(node) {
      if (node.nodeType === 3) { pieces.push(node.nodeValue || ''); return; }
      if (node.nodeType !== 1 || node.matches(EXCLUDE)) return;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
          Number.parseFloat(style.opacity) === 0) return;
      if (node.tagName === 'BR') pieces.push(' ');
      else for (const child of node.childNodes) read(child);
    }
    read(element);
    return pieces.join('').replace(/\s+/gu, ' ').trim();
  }
  function readable(text, direction) {
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    const han = (text.match(/\p{Script=Han}/gu) || []).length;
    return direction === 'zh-en' ? han >= 1 && han >= latin : latin >= 3 && latin >= han;
  }
  function chunks(text) {
    const output = [];
    let remaining = Array.from(text);
    while (remaining.length > 1800) {
      let boundary = 1800;
      while (boundary > 900 && !/\s/u.test(remaining[boundary])) boundary -= 1;
      if (boundary <= 900) boundary = 1800;
      output.push(remaining.slice(0, boundary).join('').trim());
      remaining = remaining.slice(boundary);
    }
    if (remaining.join('').trim()) output.push(remaining.join('').trim());
    return output;
  }
  function distance(element) {
    const rect = element.getBoundingClientRect();
    return Math.max(0, rect.top - innerHeight, -rect.bottom);
  }
  function visible(record) { return distance(record.element) <= 650; }
  function valid(state, record, epoch, version) {
    return run === state && !state.restored && !state.paused && state.epoch === epoch && record.version === version &&
      record.element.isConnected && leaf(record.element) && pairable(record.element) && urlKey() === state.url && sourceText(record.element) === record.source;
  }
  function updateStatus(state, detail) {
    if (run !== state || state.restored) return;
    state.status.textContent = detail || '';
    state.status.hidden = !detail;
    state.status.title = state.complexCount ? `${state.complexCount} complex paragraphs kept unchanged` : '';
    state.stop.disabled = state.paused || state.unsupported;
    state.resume.disabled = !state.paused || state.unsupported;
    state.stop.hidden = state.paused || state.unsupported;
    state.resume.hidden = !state.paused || state.unsupported;
    state.directionButton.textContent = DIRECTIONS[state.direction].label;
    state.directionButton.disabled = state.unsupported;
    for (const button of state.colorButtons.values()) button.disabled = state.unsupported;
  }
  function failureText(code) {
    return ({ UNPAIRED: 'Connect Ask for GPT', INACTIVE: 'Paused · resume', UNAVAILABLE: 'Ask for GPT offline',
      NATIVE_UNAVAILABLE: 'Language pack unavailable', BUSY: 'Busy · retry', TIMEOUT: 'Timed out · retry',
      INVALID: 'Unsupported paragraph', DISCONNECTED: 'Reload extension / page', CANCELLED: '' })[code] ?? 'Translation failed · retry';
  }
  function applyRecordColor(state, record) {
    if (!record.target) return;
    const palette = COLORS[state.color];
    if (state.color === 'theme') { record.target.style.removeProperty('color'); return; }
    const numbers = (getComputedStyle(record.element).color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const dark = numbers.length === 3 ? numbers[0] * .2126 + numbers[1] * .7152 + numbers[2] * .0722 > 155 :
      !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    record.target.style.color = dark ? palette.dark : palette.light;
  }
  function chooseColor(state, color, persist = false) {
    if (run !== state || state.restored || !Object.hasOwn(COLORS, color)) return;
    state.color = color;
    for (const record of state.records.values()) applyRecordColor(state, record);
    for (const [value, button] of state.colorButtons) button.setAttribute('aria-pressed', String(value === color));
    if (persist) {
      state.colorRevision += 1;
      try {
        chrome.storage.local.set({ [COLOR_KEY]: color }, () => {
          if (chrome.runtime.lastError) updateStatus(state, 'Color not saved');
        });
      } catch { updateStatus(state, 'Color not saved'); }
    }
  }
  function makeHost(state, tag = 'askgpt-inline-translation') {
    const host = document.createElement(tag);
    host.setAttribute(OWN, state.id);
    state.hosts.add(host);
    return host;
  }
  function pairable(element) {
    // Absolutely positioned text and vertical writing do not have a normal
    // downward flow to expand. Keep such source content unchanged.
    const style = getComputedStyle(element);
    return !['absolute', 'fixed'].includes(style.position) &&
      !/^(vertical|sideways)/.test(style.writingMode || '');
  }
  function pairLayout(record) {
    const element = record.element, computed = getComputedStyle(element);
    if (!record.layout) record.layout = { attribute: element.getAttribute('style'), baseline: styleKey(element.style), properties: new Map() };
    else if (record.layout.appliedAttribute !== element.getAttribute('style')) record.layout.externalChange = true;
    function set(name, value) {
      const current = element.style.getPropertyValue(name), priority = element.style.getPropertyPriority(name);
      let saved = record.layout.properties.get(name);
      // Remember a site's later inline update, instead of restoring an obsolete
      // value when this reading session is removed.
      if (!saved || current !== saved.applied || priority !== 'important') {
        saved = { value: current, priority, applied: value };
        record.layout.properties.set(name, saved);
      }
      if (current !== value || priority !== 'important') element.style.setProperty(name, value, 'important');
      saved.applied = value;
    }
    if (/(flex|grid|contents)/.test(computed.display) || computed.display === 'inline') {
      set('display', element.tagName === 'LI' ? 'list-item' : 'block');
    }
    // A translation is part of this same grid/flex/list/table item. Expand only
    // that item; never flatten the surrounding page or create another item.
    set('height', 'auto'); set('max-height', 'none');
    set('overflow-x', 'visible'); set('overflow-y', 'visible');
    set('column-count', 'auto'); set('column-width', 'auto');
    set('break-inside', 'avoid-column');
    record.layout.appliedAttribute = element.getAttribute('style');
  }
  function styleKey(style) {
    return Array.from(style).sort().map(name => [name, style.getPropertyValue(name), style.getPropertyPriority(name)]).flat().join('\n');
  }
  function releaseTranslation(state, record) {
    record.host?.remove(); state.hosts.delete(record.host);
    record.host = null; record.target = null;
    if (!record.layout) return;
    if (!record.layout.externalChange && record.element.getAttribute('style') === record.layout.appliedAttribute) {
      if (record.layout.attribute === null) record.element.removeAttribute('style');
      else record.element.setAttribute('style', record.layout.attribute);
      record.layout = null;
      return;
    }
    for (const [name, saved] of record.layout.properties) {
      if (record.element.style.getPropertyValue(name) !== saved.applied ||
          record.element.style.getPropertyPriority(name) !== 'important') continue;
      if (saved.value) record.element.style.setProperty(name, saved.value, saved.priority);
      else record.element.style.removeProperty(name);
    }
    if (styleKey(record.element.style) === record.layout.baseline) {
      if (record.layout.attribute === null) record.element.removeAttribute('style');
      else record.element.setAttribute('style', record.layout.attribute);
    }
    record.layout = null;
  }
  function translationHost(state, record) {
    pairLayout(record);
    if (record.host) {
      if (record.host.parentElement !== record.element) record.element.append(record.host);
      return record.host;
    }
    const host = makeHost(state);
    host.lang = DIRECTIONS[state.direction].target;
    for (const [name, value] of Object.entries({ display: 'block', position: 'static', float: 'none', clear: 'both',
      width: '100%', 'max-width': '100%', 'box-sizing': 'border-box', 'column-span': 'all' })) host.style.setProperty(name, value, 'important');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host{display:block;margin:.45em 0 .75em;color:inherit;font:inherit;line-height:1.65;line-height:clamp(1.45em,1lh,1.9em);font-optical-sizing:auto}
      div{font:inherit;line-height:inherit;white-space:pre-wrap;overflow-wrap:anywhere;padding-left:.75em;border-left:1px solid currentColor;border-left-color:color-mix(in srgb,currentColor 38%,transparent)}
      @media(prefers-contrast:more){div{border-left-color:currentColor}}
      @media(forced-colors:active){div{color:CanvasText!important;border-left-color:CanvasText}}
    `;
    const content = document.createElement('div');
    content.lang = DIRECTIONS[state.direction].target;
    shadow.append(style, content);
    record.target = content;
    record.host = host;
    applyRecordColor(state, record);
    // Keeping the original node as the layout item also preserves its IDs,
    // listeners, list marker, grid placement and position when a page moves it.
    record.element.append(host);
    return host;
  }
  function clippedPair(record) {
    const bounds = record.host.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return false;
    let scrollX = false, scrollY = false;
    for (let ancestor = record.element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const overflowX = style.overflowX || style.overflow, overflowY = style.overflowY || style.overflow;
      const clipX = !scrollX && /^(hidden|clip)$/.test(overflowX);
      const clipY = !scrollY && /^(hidden|clip)$/.test(overflowY);
      if (clipX || clipY) {
        const box = ancestor.getBoundingClientRect();
        if ((clipY && (bounds.top < box.top - 1 || bounds.bottom > box.bottom + 1)) ||
            (clipX && (bounds.left < box.left - 1 || bounds.right > box.right + 1))) return true;
      }
      // A result below/alongside a scrolling viewport is reachable by scrolling;
      // an outer viewport's clipping must not permanently retire that pair.
      // Track each axis separately and only after checking the current ancestor:
      // a genuinely clipped card inside a scroller still cannot grow safely.
      if (/^(auto|scroll|overlay)$/.test(overflowX) && ancestor.scrollWidth > ancestor.clientWidth + 1) scrollX = true;
      if (/^(auto|scroll|overlay)$/.test(overflowY) && ancestor.scrollHeight > ancestor.clientHeight + 1) scrollY = true;
    }
    return false;
  }
  function render(state, record) {
    if (!record.results.length || record.layoutBlocked || !record.element.isConnected) return;
    translationHost(state, record);
    record.target.textContent = record.results.join('\n');
    // Do not let a fixed, clipped card show half a translation or alter an
    // unrelated ancestor's page layout. A new source/session may retry it.
    if (clippedPair(record)) {
      record.layoutBlocked = true; record.error = 'Unsupported paragraph layout';
      releaseTranslation(state, record);
    }
  }
  function cancelRecord(state, record) {
    if (record.activeId) message({ type: 'INLINE_CONTROL', sessionId: state.id, action: 'cancel-block', id: record.activeId });
    record.activeId = null;
  }
  function invalidate(state, record, text) {
    cancelRecord(state, record);
    state.sourceCharacters -= Array.from(record.source).length;
    record.version += 1; record.source = text; record.parts = chunks(text);
    record.cursor = 0; record.results = []; record.error = null; record.layoutBlocked = false;
    releaseTranslation(state, record);
    state.sourceCharacters += Array.from(text).length;
  }
  function prune(state) {
    for (const [element, record] of state.records) {
      if (element.isConnected) continue;
      cancelRecord(state, record); releaseTranslation(state, record);
      state.sourceCharacters -= Array.from(record.source).length;
      state.intersection?.unobserve(element); state.records.delete(element);
    }
  }
  function add(state, element) {
    const existing = state.records.get(element);
    function discard() {
      if (!existing) return;
      cancelRecord(state, existing); releaseTranslation(state, existing);
      state.sourceCharacters -= Array.from(existing.source).length;
      state.intersection?.unobserve(element); state.records.delete(element);
    }
    if (!eligible(element) || !pairable(element) || element.querySelector(BLOCKS)) { discard(); return; }
    if (complex(element)) {
      if (!state.complexBlocks.has(element)) { state.complexBlocks.add(element); state.complexCount += 1; }
      discard();
      return;
    }
    const text = sourceText(element);
    if (!readable(text, state.direction)) {
      if (existing) {
        cancelRecord(state, existing); releaseTranslation(state, existing);
        state.sourceCharacters -= Array.from(existing.source).length;
        state.intersection?.unobserve(element); state.records.delete(element);
      }
      return;
    }
    if (existing) {
      if (existing.source !== text) {
        const size = state.sourceCharacters - Array.from(existing.source).length + Array.from(text).length;
        if (size > MAX_SOURCE) {
          cancelRecord(state, existing); existing.version += 1; releaseTranslation(state, existing);
          state.sourceCharacters -= Array.from(existing.source).length;
          state.records.delete(element); state.limited = true; return;
        }
        invalidate(state, existing, text);
      }
      return;
    }
    if (state.records.size >= MAX_RECORDS || state.sourceCharacters + Array.from(text).length > MAX_SOURCE) {
      state.limited = true; return;
    }
    const record = { element, source: text, parts: chunks(text), cursor: 0, results: [], version: 0,
      ordinal: ++state.ordinal, host: null, target: null, activeId: null, error: null };
    state.records.set(element, record); state.sourceCharacters += Array.from(text).length;
    state.intersection?.observe(element);
  }
  function scan(state, root) {
    if (root.nodeType !== 1 || owned(root) || !root.isConnected) return;
    const semantic = root.matches(BLOCKS) || root.querySelector(BLOCKS);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = root, visited = 0;
    do {
      if (++visited > MAX_SCAN) { state.limited = true; break; }
      if (node.matches(BLOCKS) || (!semantic && node.tagName === 'DIV' && !node.querySelector('div,' + BLOCKS))) add(state, node);
    } while ((node = walker.nextNode()));
  }
  function rootOfPage() { return document.querySelector('main,[role="main"],article') || document.body; }
  async function drain(state) {
    if (run !== state || state.paused || state.restored || state.busy || state.unsupported) return;
    if (urlKey() !== state.url) { restore(state); return; }
    prune(state);
    const record = [...state.records.values()].filter(value => value.cursor < value.parts.length && !value.error && !value.layoutBlocked &&
      leaf(value.element) && pairable(value.element) && visible(value))
      .sort((a, b) => distance(a.element) - distance(b.element) || a.ordinal - b.ordinal)[0];
    if (!record) { updateStatus(state, state.limited ? 'Page limit · results kept' : undefined); return; }
    const epoch = state.epoch, version = record.version;
    const token = {}; state.busy = token;
    const id = `b${record.ordinal.toString(36)}v${version.toString(36)}p${record.cursor.toString(36)}`;
    record.activeId = id;
    updateStatus(state);
    try {
      const direction = DIRECTIONS[state.direction];
      const response = await message({ type: 'INLINE_TRANSLATE', sessionId: state.id, id,
        text: record.parts[record.cursor], source: direction.source, target: direction.target });
      if (!valid(state, record, epoch, version)) {
        if (run === state && !state.paused && state.epoch === epoch && record.element.isConnected && urlKey() === state.url) add(state, record.element);
        return;
      }
      if (!response.ok || response.id !== id || typeof response.translation !== 'string') {
        record.error = failureText(response.code);
        await pause(state, record.error);
        return;
      }
      record.results.push(response.translation); record.cursor += 1;
      render(state, record);
    } finally {
      if (record.activeId === id) record.activeId = null;
      if (state.busy === token) state.busy = null;
      if (run === state && !state.paused && !state.restored) queueMicrotask(() => drain(state));
    }
  }
  function scheduleScan(state, node) {
    if (state.pending.size < 100) state.pending.add(node.nodeType === 1 ? node : node.parentElement);
    else state.pendingOverflow = true;
    if (state.scanTimer) return;
    state.scanTimer = setTimeout(() => {
      state.scanTimer = null;
      if (run !== state || state.restored) return;
      if (urlKey() !== state.url) { restore(state); return; }
      prune(state);
      const candidates = state.pendingOverflow ? [rootOfPage()] : [...state.pending];
      state.pending.clear(); state.pendingOverflow = false;
      for (const root of candidates) {
        if (!root || owned(root)) continue;
        const nearest = root.closest(BLOCKS);
        if (nearest) add(state, nearest);
        scan(state, root);
      }
      for (const record of state.records.values()) {
        if (record.element.isConnected && (!eligible(record.element) || !pairable(record.element))) {
          cancelRecord(state, record); record.version += 1; releaseTranslation(state, record);
          record.results = []; record.cursor = 0;
        }
        if (record.results.length && eligible(record.element) && pairable(record.element)) render(state, record);
        applyRecordColor(state, record);
      }
      drain(state);
    }, 120);
  }
  async function pause(state, detail, notify = true) {
    if (run !== state || state.restored) return;
    state.paused = true; state.epoch += 1; state.busy = null;
    for (const record of state.records.values()) cancelRecord(state, record);
    updateStatus(state, detail);
    if (notify) {
      state.control = message({ type: 'INLINE_CONTROL', sessionId: state.id, action: 'pause' });
      await state.control;
    }
  }
  async function resume(state) {
    if (run !== state || state.restored || state.unsupported) return;
    const epoch = state.epoch;
    await state.control;
    if (run !== state || state.restored || state.epoch !== epoch) return;
    const response = await message({ type: 'INLINE_CONTROL', sessionId: state.id, action: 'resume' });
    if (run !== state || state.restored || state.epoch !== epoch) return;
    if (!response.ok) { updateStatus(state, failureText(response.code)); return; }
    state.paused = false; state.epoch += 1;
    for (const record of state.records.values()) record.error = null;
    updateStatus(state); drain(state);
  }
  async function changeDirection(state, direction) {
    if (run !== state || state.restored || state.unsupported || !Object.hasOwn(DIRECTIONS, direction) || state.direction === direction) return;
    state.direction = direction;
    // A direction change is a new generation. Retire every block ID and await
    // the worker's cancellation before issuing requests in the other direction.
    const pending = pause(state);
    const epoch = state.epoch;
    clearTimeout(state.scanTimer); state.scanTimer = null;
    state.pending.clear(); state.pendingOverflow = false;
    state.intersection?.disconnect();
    for (const record of state.records.values()) {
      releaseTranslation(state, record);
    }
    state.records.clear(); state.sourceCharacters = 0; state.limited = false;
    state.complexBlocks = new WeakSet(); state.complexCount = 0;
    scan(state, rootOfPage());
    await pending;
    if (run === state && !state.restored && state.epoch === epoch) await resume(state);
  }
  function restore(state, notify = true) {
    if (run !== state || state.restored) return;
    state.restored = true; state.epoch += 1;
    state.observer?.disconnect(); state.intersection?.disconnect(); clearTimeout(state.scanTimer);
    document.removeEventListener('visibilitychange', state.visibility);
    window.removeEventListener('pagehide', state.pagehide);
    window.removeEventListener('scroll', state.scroll);
    for (const record of state.records.values()) releaseTranslation(state, record);
    for (const host of state.hosts) host.remove();
    state.records.clear(); state.hosts.clear(); state.pending.clear(); run = undefined;
    if (notify) message({ type: 'INLINE_CONTROL', sessionId: state.id, action: 'restore' });
  }
  function toolbar(state) {
    const host = makeHost(state, 'askgpt-inline-controls');
    host.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2147483647;width:max-content;max-width:calc(100vw - 24px);display:block;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host{color-scheme:light dark;--ink:#343832;--solid:#f7f7f2;--surface:rgba(250,250,246,.88);--edge:rgba(38,43,34,.13);--hover:rgba(38,43,34,.065);--shadow:rgba(21,25,20,.12)}
      section{box-sizing:border-box;display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:2px;padding:4px 6px;max-width:100%;font:500 12px/1.3 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-optical-sizing:auto;letter-spacing:.01em;color:var(--ink);background:var(--surface);-webkit-backdrop-filter:blur(18px) saturate(1.1);backdrop-filter:blur(18px) saturate(1.1);border:1px solid var(--edge);border-radius:14px;box-shadow:0 4px 18px var(--shadow),inset 0 1px 0 rgba(255,255,255,.28)}
      span{order:1;flex:1 1 100%;min-width:0;max-width:100%;line-height:1.4;margin:0 4px;overflow-wrap:anywhere;text-align:center}
      button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;position:relative;min-width:30px;height:30px;padding:0 7px;border:0;border-radius:9px;background:transparent;color:inherit;font:inherit;white-space:nowrap;cursor:pointer;touch-action:manipulation;transition:background-color 120ms ease,transform 120ms ease}
      button:hover:not(:disabled){background:var(--hover)}
      button:active:not(:disabled){background:var(--hover);transform:scale(.96)}
      button:focus-visible{outline:2px solid Highlight;outline-offset:2px}
      button:disabled{opacity:.42;cursor:default}
      button svg{display:block;width:16px;height:16px;flex:none;pointer-events:none}
      .separator{display:block;flex:0 0 1px;width:1px;height:16px;margin:0 4px;background:var(--edge)}
      .swatch{width:30px;padding:0;border-radius:50%}
      .swatch::after{content:"";display:block;box-sizing:border-box;width:12px;height:12px;background:var(--swatch);border:1px solid rgba(38,43,34,.15);border-radius:50%}
      .swatch[aria-pressed="true"]::before{content:"";position:absolute;inset:5px;border:1.25px solid currentColor;border-radius:50%}
      button[hidden],span[hidden]{display:none}
      @media(prefers-color-scheme:dark){:host{--ink:#eceee6;--solid:#292c27;--surface:rgba(39,43,37,.9);--edge:rgba(237,241,229,.16);--hover:rgba(237,241,229,.09);--shadow:rgba(0,0,0,.27)}section{box-shadow:0 4px 18px var(--shadow),inset 0 1px 0 rgba(255,255,255,.045)}.swatch::after{border-color:rgba(245,247,239,.2)}}
      @media(prefers-reduced-transparency:reduce){section{background:var(--solid);-webkit-backdrop-filter:none;backdrop-filter:none}}
      @media(prefers-contrast:more){section{background:var(--solid);border-color:var(--ink);-webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:none}.separator{background:var(--ink)}.swatch[aria-pressed="true"]::before{border-width:2px}}
      @media(prefers-reduced-motion:reduce){button{transition:none}button:active:not(:disabled){transform:none}}
      @media(forced-colors:active){section{color:CanvasText;background:Canvas;border-color:CanvasText;box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none}.separator{background:CanvasText}button{color:ButtonText}.swatch::after{forced-color-adjust:none}.swatch[aria-pressed="true"]::before{border-color:Highlight}}
    `;
    const bar = document.createElement('section'); bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Ask for GPT inline translation');
    const status = document.createElement('span'); status.setAttribute('aria-live', 'polite'); state.status = status;
    function button(text, title, action, name) {
      const element = document.createElement('button'); element.type = 'button'; element.textContent = text;
      element.title = title; element.setAttribute('aria-label', title);
      if (name) element.dataset.action = name;
      element.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); action(); });
      bar.append(element); return element;
    }
    function separator() {
      const element = document.createElement('i'); element.className = 'separator'; element.setAttribute('aria-hidden', 'true'); bar.append(element);
    }
    function iconButton(path, title, action, name) {
      const element = button('', title, action, name);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor',
        'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path'); line.setAttribute('d', path);
      svg.append(line); element.append(svg); return element;
    }
    state.directionButton = button(DIRECTIONS[state.direction].label, 'Switch translation direction',
      () => changeDirection(state, state.direction === 'en-zh' ? 'zh-en' : 'en-zh'), 'direction');
    separator();
    for (const [color, palette] of Object.entries(COLORS)) {
      const swatch = button('', palette.label, () => chooseColor(state, color, true));
      swatch.className = 'swatch'; swatch.dataset.color = color;
      swatch.style.setProperty('--swatch', palette.swatch); state.colorButtons.set(color, swatch);
    }
    bar.append(status);
    separator();
    state.stop = iconButton('M9 5v14M15 5v14', 'Pause translation', () => pause(state), 'pause');
    state.resume = iconButton('m9 5 10 7-10 7Z', 'Resume translation', () => resume(state), 'resume');
    iconButton('M4 10h9a6 6 0 1 1-4.24 10.24M4 10l5-5M4 10l5 5', 'Restore original', () => restore(state), 'restore');
    shadow.append(style, bar); document.documentElement.append(host);
    chooseColor(state, state.color);
    updateStatus(state);
  }
  function start(id) {
    if (run) restore(run, false);
    const state = { id, url: urlKey(), epoch: 0, ordinal: 0, sourceCharacters: 0, paused: false, restored: false,
      unsupported: false, records: new Map(), hosts: new Set(), pending: new Set(), busy: null, limited: false,
      complexBlocks: new WeakSet(), complexCount: 0, direction: 'en-zh', color: 'blue', colorRevision: 0, colorButtons: new Map() };
    run = state; toolbar(state);
    const pdf = document.contentType === 'application/pdf' ||
      (!!document.querySelector('embed[type="application/pdf"],object[type="application/pdf"],pdf-viewer') && !document.querySelector('main p,article p'));
    if (pdf) {
      state.unsupported = true; state.paused = true;
      updateStatus(state, 'PDF · use Zotero');
      return { ok: true, supported: false };
    }
    // Store only the visual preference. Every new session starts EN → Chinese.
    // Scanning never waits for storage, and a late preference cannot override
    // the user's color selection in this session.
    try {
      chrome.storage.local.get(COLOR_KEY, values => {
        if (!chrome.runtime.lastError && state.colorRevision === 0) chooseColor(state, values?.[COLOR_KEY]);
      });
    } catch { /* A missing preference does not interrupt translation. */ }
    state.intersection = typeof IntersectionObserver === 'function' ? new IntersectionObserver(() => drain(state), { rootMargin: '650px' }) : null;
    state.observer = new MutationObserver(records => {
      for (const record of records) {
        if (owned(record.target)) continue;
        if (record.type === 'attributes' && record.attributeName === 'style') {
          const layout = state.records.get(record.target)?.layout;
          if (layout && layout.appliedAttribute === record.target.getAttribute('style')) continue;
        }
        const changed = [...record.addedNodes, ...record.removedNodes];
        if (record.type === 'childList' && changed.length && changed.every(owned)) {
          // A site can remove/move an injected result while retaining its source.
          // Repair that pair once, without responding to our own insertion.
          const source = state.records.get(record.target);
          if (source?.host && [...record.removedNodes].includes(source.host)) scheduleScan(state, record.target);
          continue;
        }
        scheduleScan(state, record.target);
        for (const node of record.addedNodes) if (!owned(node)) scheduleScan(state, node);
      }
    });
    state.observer.observe(document.body, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'contenteditable', 'role'] });
    state.visibility = () => { if (!document.hidden) drain(state); };
    state.pagehide = () => restore(state);
    state.scroll = () => { if (urlKey() !== state.url) restore(state); else drain(state); };
    document.addEventListener('visibilitychange', state.visibility);
    window.addEventListener('pagehide', state.pagehide, { once: true });
    window.addEventListener('scroll', state.scroll, { passive: true });
    scan(state, rootOfPage()); updateStatus(state); drain(state);
    return { ok: true, supported: true };
  }
  chrome.runtime.onMessage.addListener((value, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !value) return false;
    if (value.type === 'INLINE_START' && typeof value.sessionId === 'string') sendResponse(start(value.sessionId));
    else if (run && value.sessionId === run.id && value.type === 'INLINE_RESTORE') { restore(run, false); sendResponse({ ok: true }); }
    else if (run && value.sessionId === run.id && value.type === 'INLINE_PAUSE') { pause(run, undefined, false); sendResponse({ ok: true }); }
    else return false;
    return false;
  });
  // This flag and all state stay in the extension's ISOLATED world, not MAIN.
  globalThis.__ASKGPT_INLINE_V1__ = true;
})();
