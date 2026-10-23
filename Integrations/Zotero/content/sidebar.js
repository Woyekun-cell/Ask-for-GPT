(function (root) {
  'use strict';
  const FTL = 'askgpt-inline.ftl';
  const XUL = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';
  const labels = {
    scope: ['范围', 'Scope'], current: ['当前页', 'Current page'], whole: ['整篇', 'Whole document'],
    mode: ['显示', 'View'], mono: ['译文', 'Translation'], dual: ['中英对照', 'Side by side'],
    direction: ['方向', 'Direction'], 'en-zh': ['EN → 中', 'EN → 中'], 'zh-en': ['中 → EN', '中 → EN'],
    translate: ['翻译', 'Translate'], original: ['原文', 'Original'], hover: ['悬停释义', 'Hover dictionary'], resume: ['重开时提示阅读位置', 'Highlight reading position on reopen'],
    'progress-preparing': ['准备中', 'Preparing'], 'progress-translating': ['翻译中', 'Translating'],
    'progress-layout': ['排版中', 'Laying out'], 'progress-loading': ['加载译文', 'Loading translation']
  };
  function create({ Zotero, pluginID, rootURI, actions }) {
    const windows = new Set(), panels = new Map(), preferences = new WeakMap(), draftFields = new WeakMap();
    let paneID = null, unsubscribe = null, started = false, disposed = false, serial = 0;
    function progressValue(value) {
      if (!value || !['preparing', 'translating', 'layout', 'loading'].includes(value.stage)) return null;
      const result = { stage: value.stage };
      if (value.stage === 'translating' && Number.isInteger(value.completed) && Number.isInteger(value.total)
        && value.total > 0 && value.total <= 2000 && value.completed >= 0 && value.completed <= value.total) {
        result.completed = value.completed; result.total = value.total;
      }
      return result;
    }
    const normalized = value => ({ open: Boolean(value?.open), busy: Boolean(value?.busy), whole: Boolean(value?.whole),
      mode: value?.mode === 'dual' ? 'dual' : 'mono', direction: value?.direction === 'zh-en' ? 'zh-en' : 'en-zh', progress: progressValue(value?.progress) });
    const state = reader => normalized(actions.state(reader));
    function readerFor(body) {
      const details = body?.closest('item-details'), id = details?.tabID || details?.dataset?.tabId;
      const reader = id ? Zotero.Reader.getByTabID(id) : null;
      const win = body?.ownerDocument?.defaultView;
      return reader?.type === 'pdf' && !win?.closed && (!reader._window || reader._window === win) ? reader : null;
    }
    function current(panel) {
      if (disposed || panels.get(panel.body) !== panel || readerFor(panel.body) !== panel.reader) return false;
      const win = panel.doc.defaultView;
      return !win?.Zotero_Tabs || win.Zotero_Tabs.selectedID === panel.reader.tabID;
    }
    function settings(reader) {
      if (!preferences.has(reader)) {
        const value = state(reader);
        preferences.set(reader, { whole: value.whole, mode: value.mode, direction: value.direction });
        draftFields.set(reader, new Set());
      }
      return preferences.get(reader);
    }
    function localized(node, key, attribute) {
      node.setAttribute(attribute, labels[key][String(Zotero.locale || '').startsWith('zh') ? 0 : 1]);
      node.setAttribute('data-l10n-id', 'askgpt-inline-' + key);
      return node;
    }
    function xul(doc, name) {
      return typeof doc.createXULElement === 'function' ? doc.createXULElement(name) : doc.createElementNS(XUL, name);
    }
    function listen(panel, node, type, fn) {
      node.addEventListener(type, fn); panel.removers.push(() => node.removeEventListener(type, fn));
    }
    function disposePanel(body) {
      const panel = panels.get(body); if (!panel) return;
      panels.delete(body); for (const remove of panel.removers.splice(0)) remove();
    }
    function update(panel, next = state(panel.reader), syncPreferences = false) {
      if (panels.get(panel.body) !== panel) return;
      panel.state = normalized(next);
      const choice = settings(panel.reader);
      if (syncPreferences) {
        const drafts = draftFields.get(panel.reader);
        for (const key of ['whole', 'mode', 'direction']) if (!drafts.has(key)) choice[key] = panel.state[key];
        panel.pending = false;
      }
      panel.scope.value = choice.whole ? 'whole' : 'current'; panel.mode.value = choice.mode; panel.direction.value = choice.direction;
      panel.hover.checked = actions.hoverEnabled?.() !== false;
      panel.resume.checked = actions.resumeEnabled?.() !== false;
      const busy = panel.pending || panel.state.busy;
      panel.translate.disabled = busy; panel.original.disabled = !(busy || panel.state.open);
      panel.body.setAttribute('aria-busy', String(busy)); panel.translate.setAttribute('aria-busy', String(busy));
      panel.progressGroup.hidden = !busy;
      const progress = panel.state.progress || { stage: 'preparing' }, count = Number.isInteger(progress.total);
      if (count && progress.total > 1) panel.progressMeter.setAttribute('value', String(Math.floor(100 * progress.completed / progress.total)));
      else panel.progressMeter.removeAttribute('value');
      if (count) {
        const value = String(Zotero.locale || '').startsWith('zh')
          ? `翻译 ${progress.completed} / ${progress.total} 页` : `Translating ${progress.completed} / ${progress.total} pages`;
        panel.progressLabel.setAttribute('value', value); panel.progressLabel.setAttribute('data-l10n-id', 'askgpt-inline-progress-pages');
        panel.progressLabel.setAttribute('data-l10n-args', JSON.stringify({ completed: progress.completed, total: progress.total }));
      } else { localized(panel.progressLabel, 'progress-' + progress.stage, 'value'); panel.progressLabel.setAttribute('data-l10n-args', '{}'); }
    }
    function render({ doc, body, tabType }) {
      disposePanel(body); body.replaceChildren();
      const reader = readerFor(body); if (disposed || tabType !== 'reader' || !reader) return;
      attachWindow(doc.defaultView);
      const panel = { doc, body, reader, removers: [], pending: false, state: state(reader) };
      panels.set(body, panel);
      const container = xul(doc, 'vbox'); container.setAttribute('style', 'gap: 8px; padding: 4px 0; min-width: 0;');
      const choice = settings(reader), id = 'askgpt-inline-controls-' + (++serial);
      function menu(key, values) {
        const row = xul(doc, 'hbox'); row.setAttribute('align', 'center'); row.setAttribute('style', 'gap: 8px; min-width: 0;');
        const label = localized(xul(doc, 'label'), key, 'value'); label.setAttribute('control', id + '-' + key); label.setAttribute('style', 'min-width: 3em;');
        const list = xul(doc, 'menulist'); list.setAttribute('id', id + '-' + key); list.setAttribute('native', 'true');
        list.setAttribute('flex', '1'); list.setAttribute('style', 'min-width: 0;'); list.setAttribute('data-askgpt-control', key);
        const popup = xul(doc, 'menupopup');
        for (const [value, textKey] of values) { const item = localized(xul(doc, 'menuitem'), textKey, 'label'); item.setAttribute('value', value); popup.appendChild(item); }
        list.appendChild(popup); row.append(label, list); container.appendChild(row); return list;
      }
      panel.scope = menu('scope', [['current', 'current'], ['whole', 'whole']]);
      panel.progressGroup = xul(doc, 'vbox'); panel.progressGroup.setAttribute('style', 'gap: 4px; margin: 0 4px 2px;');
      panel.progressGroup.setAttribute('data-askgpt-control', 'progress');
      panel.progressLabel = xul(doc, 'label'); panel.progressLabel.setAttribute('data-askgpt-control', 'progress-label');
      panel.progressLabel.setAttribute('style', 'font-size: .9em; color: var(--fill-secondary);');
      panel.progressMeter = doc.createElementNS('http://www.w3.org/1999/xhtml', 'progress'); panel.progressMeter.setAttribute('data-askgpt-control', 'progress-meter');
      panel.progressMeter.setAttribute('max', '100'); panel.progressMeter.setAttribute('style', 'width: 100%;');
      panel.progressGroup.append(panel.progressLabel, panel.progressMeter); container.appendChild(panel.progressGroup);
      panel.mode = menu('mode', [['mono', 'mono'], ['dual', 'dual']]);
      panel.direction = menu('direction', [['en-zh', 'en-zh'], ['zh-en', 'zh-en']]);
      panel.hover = localized(xul(doc,'checkbox'),'hover','label');
      panel.hover.setAttribute('data-askgpt-control','hover');container.appendChild(panel.hover);
      listen(panel,panel.hover,'command',()=>{if(current(panel))actions.setHoverEnabled?.(panel.hover.checked===true);});
      panel.resume = localized(xul(doc,'checkbox'),'resume','label');
      panel.resume.setAttribute('data-askgpt-control','resume');container.appendChild(panel.resume);
      listen(panel,panel.resume,'command',()=>{if(current(panel))actions.setResumeEnabled?.(panel.resume.checked===true);});
      const buttons = xul(doc, 'hbox'); buttons.setAttribute('style', 'gap: 6px; margin-top: 2px;');
      for (const key of ['translate', 'original']) {
        panel[key] = localized(xul(doc, 'button'), key, 'label'); panel[key].setAttribute('data-askgpt-control', key);
        panel[key].setAttribute('flex', '1'); panel[key].setAttribute('style', 'min-width: 0;'); buttons.appendChild(panel[key]);
      }
      container.appendChild(buttons); body.appendChild(container);
      listen(panel, panel.scope, 'command', () => { if (current(panel)) { choice.whole = panel.scope.value === 'whole'; draftFields.get(reader).add('whole'); } });
      listen(panel, panel.direction, 'command', () => { if (current(panel)) { choice.direction = panel.direction.value === 'zh-en' ? 'zh-en' : 'en-zh'; draftFields.get(reader).add('direction'); } });
      listen(panel, panel.mode, 'command', () => {
        if (!current(panel)) return;
        choice.mode = panel.mode.value === 'dual' ? 'dual' : 'mono'; draftFields.get(reader).add('mode'); actions.setMode(reader, choice.mode);
      });
      listen(panel, panel.translate, 'command', () => {
        if (!current(panel) || panel.pending || state(reader).busy) return;
        panel.pending = true; update(panel);
        draftFields.get(reader).clear();
        let result;
        try { result = actions.translate(reader, { ...choice }); }
        catch (_) { panel.pending = false; update(panel); return; }
        void Promise.resolve(result).catch(() => {}).finally(() => { panel.pending = false; update(panel); });
      });
      listen(panel, panel.original, 'command', () => {
        if (!current(panel) || panel.original.disabled) return;
        panel.pending = false; if (typeof actions.original === 'function') actions.original(reader); else actions.restore(reader); update(panel);
      });
      update(panel);
    }
    function attachWindow(win) {
      if (!win || win.closed || disposed || windows.has(win)) return;
      win.MozXULElement?.insertFTLIfNeeded?.(FTL); windows.add(win);
    }
    function detachWindow(win) {
      if (!windows.delete(win)) return;
      for (const [body, panel] of [...panels]) if (panel.doc.defaultView === win) disposePanel(body);
      win.document?.querySelector('[href="' + FTL + '"]')?.remove();
    }
    return {
      start() {
        if (disposed || started) return; started = true;
        for (const win of Zotero.getMainWindows()) attachWindow(win);
        const icon = rootURI.replace(/\/?$/, '/') + 'content/translate.svg';
        paneID = Zotero.ItemPaneManager.registerSection({
          paneID: 'pdf-translation', pluginID,
          header: { l10nID: 'askgpt-inline-section-header', icon },
          sidenav: { l10nID: 'askgpt-inline-section-sidenav', icon },
          onInit() {}, onDestroy: ({ body }) => disposePanel(body),
          onItemChange: ({ body, tabType, setEnabled }) => setEnabled(tabType === 'reader' && Boolean(readerFor(body))),
          onRender: render
        });
        if (paneID) unsubscribe = actions.subscribe((reader, next) => {
          if (disposed) return;
          for (const panel of panels.values()) if (panel.reader === reader) update(panel, next, true);
        });
      }, attachWindow, detachWindow,
      shutdown() {
        if (disposed) return; disposed = true; unsubscribe?.(); unsubscribe = null;
        for (const body of [...panels.keys()]) disposePanel(body);
        if (paneID) Zotero.ItemPaneManager.unregisterSection(paneID); paneID = null;
        for (const win of [...windows]) detachWindow(win);
      }
    };
  }
  root.AskGPTSidebar = { create };
  if (typeof module !== 'undefined') module.exports = { create };
})(this);
