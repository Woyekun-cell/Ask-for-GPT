(function(root) {
  'use strict';
  const version = root.AskGPTPaperHTMLVersion ||
    (typeof module !== 'undefined' ? require('./paper-html-version.js') : null);
  const FILENAME = /^askgpt-paper-([A-Z0-9]{8})-([a-f0-9]{64})\.html$/;
  const LIGHT_THEME = 'reader.lightTheme';
  const DARK_THEME = 'reader.darkTheme';

  function create(deps = {}) {
    const {Zotero, pluginID} = deps;
    const manager = Zotero?.Reader;
    if (!manager?.registerEventListener || !Zotero.Items?.getByLibraryAndKey ||
        !Zotero.File?.pathToFile || !version?.verifyFile) return null;

    let active = false;
    let checked = new WeakMap();
    const themeObservers = [], commandWindows = new Map();
    let restoreOpen = null;

    function candidate(item) {
      if (!item || item.deleted ||
          !Number.isSafeInteger(item.parentID) || item.attachmentContentType !== 'text/html' ||
          item.isSnapshotAttachment?.() !== true) return null;
      const filename = item.attachmentFilename;
      const marker = FILENAME.exec(filename);
      if (!marker) return null;
      const parent = Zotero.Items.get(item.parentID);
      const source = Zotero.Items.getByLibraryAndKey(item.libraryID, marker[1]);
      if (!parent || parent.deleted || parent.libraryID !== item.libraryID ||
          parent.isRegularItem?.() !== true || !source || source.deleted ||
          source.libraryID !== item.libraryID || source.parentID !== parent.id || source.isPDFAttachment?.() !== true) return null;
      return {item, filename, digest: marker[2], owner: [item.id, parent.id, source.id, filename].join(':')};
    }

    function readerCandidate(reader) {
      if (reader?.type !== 'snapshot' || reader._isUninitialized || reader._isTabClosed) return null;
      const item = Zotero.Items.get(reader.itemID);
      return item && reader._item?.id === item.id ? candidate(item) : null;
    }

    async function verifiedFile(snapshot) {
      const path = await snapshot.item.getFilePathAsync();
      if (!path) return null;
      const file = Zotero.File.pathToFile(path);
      if (file.leafName !== snapshot.filename) return null;
      return version.verifyFile(deps, file, snapshot.digest);
    }

    async function openVerified(snapshot, isCurrent) {
      try {
        const file = await verifiedFile(snapshot);
        if (!file) return false;
        await version.openInBrowser(deps, file, () => isCurrent() &&
          candidate(Zotero.Items.get(snapshot.item.id))?.owner === snapshot.owner);
        return true;
      } catch (_) { return false; }
    }

    function wrapFileOpen() {
      const handlers = Zotero.FileHandlers, original = handlers?.open;
      if (!Zotero.isMac || typeof original !== 'function') return;
      const descriptor = Object.getOwnPropertyDescriptor(handlers, 'open');
      function open(item, options) {
        const fallback = () => Reflect.apply(original, this, arguments);
        if (restoreOpen !== restore || this !== handlers || options?.location) return fallback();
        let snapshot;
        try { snapshot = candidate(Zotero.Items.get(item?.id)); } catch (_) { return fallback(); }
        if (!snapshot) return fallback();
        return openVerified(snapshot, () => restoreOpen === restore).then(opened => opened || fallback());
      }
      function restore() {
        restoreOpen = null;
        if (handlers.open !== open) return;
        try {
          if (descriptor) Object.defineProperty(handlers, 'open', descriptor);
          else delete handlers.open;
        } catch (error) { Zotero.logError?.(error); }
      }
      try { handlers.open = open; if (handlers.open === open) restoreOpen = restore; } catch (_) {}
    }

    function attachMainWindow(win) {
      if (!active || !Zotero.isMac || !win?.addEventListener || commandWindows.has(win)) return;
      let armed = [];
      function disarm() {
        for (const [item, command] of armed) item.removeEventListener('command', command, true);
        armed = [];
      }
      function onPopupShowing(event) {
        const popup = event.target, anchor = popup?.anchorNode;
        // Ethereal Style 6.1's version command otherwise closes and moves reader tabs.
        if (popup?.id !== 'zoterostyle-menupopup' || anchor?.id !== 'pdf-version-button') return;
        disarm();
        const reader = (manager._readers || []).find(value => value.type === 'pdf' &&
          !value._isTabClosed && !value._isUninitialized && value._iframeWindow?.document === anchor.ownerDocument);
        const pdf = reader && Zotero.Items.get(reader.itemID);
        const parent = pdf?.isPDFAttachment?.() && Zotero.Items.get(pdf.parentID);
        if (!parent?.isRegularItem?.() || parent.deleted || parent.libraryID !== pdf.libraryID) return;
        const siblings = parent.getAttachments(false).map(id => Zotero.Items.get(id)).filter(item =>
          item?.isSnapshotAttachment?.() && !item.deleted && item.parentID === parent.id);
        const rows = Array.from(popup.children);
        for (const item of rows) {
          const label = item.getAttribute('label'), tooltip = 'snapshot\n' + label;
          if ((item.localName || item.tagName) !== 'menuitem' || item.getAttribute('type') !== 'checkbox' ||
              !label || item.getAttribute('tooltiptext') !== tooltip ||
              rows.filter(row => row.getAttribute('tooltiptext') === tooltip).length !== 1) continue;
          const matching = siblings.filter(value => value.getDisplayTitle?.() === label);
          const snapshot = matching.length === 1 && candidate(matching[0]);
          if (!snapshot) continue;
          const isCurrent = () => active && commandWindows.get(win) === detach && !reader._isTabClosed && !reader._isUninitialized;
          let consumed = false;
          const command = event => {
            if (!isCurrent()) return;
            event.preventDefault(); event.stopImmediatePropagation();
            if (consumed) return;
            consumed = true;
            void openVerified(snapshot, isCurrent).then(opened => {
              if (!opened && isCurrent()) return manager.open(snapshot.item.id);
            }).catch(error => Zotero.logError?.(error));
          };
          item.addEventListener('command', command, true);
          armed.push([item, command]);
        }
      }
      function detach() { win.removeEventListener('popupshowing', onPopupShowing, true); disarm(); }
      win.addEventListener('popupshowing', onPopupShowing, true);
      commandWindows.set(win, detach);
    }

    function detachMainWindow(win) {
      commandWindows.get(win)?.();
      commandWindows.delete(win);
    }

    function keepPaperColors(native) {
      // Zotero's stock light fallback disables Dark Reader and its static recoloring.
      // Paper Reading Workflow's HTML uses its own light palette and responsive CSS.
      if (native._state.lightTheme) native.setLightTheme(null);
      if (native._state.darkTheme) native.setDarkTheme(null);
    }

    async function inspect(reader) {
      if (!active || reader?.type !== 'snapshot') return;
      const native = reader._internalReader;
      if (native?._type !== 'snapshot' || !native._state || !native._primaryView?.initializedPromise ||
          typeof native.setLightTheme !== 'function' || typeof native.setDarkTheme !== 'function') return;
      const snapshot = readerCandidate(reader);
      if (!snapshot) return;
      const view = native._primaryView;
      const prior = checked.get(native);
      if (prior?.owner === snapshot.owner && (prior.verified || prior.view === view)) {
        if (prior.verified) keepPaperColors(native);
        return;
      }
      const record = {owner: snapshot.owner, view, verified: false};
      checked.set(native, record);
      if (!await verifiedFile(snapshot) || !active) return;
      await view.initializedPromise;
      if (!active || checked.get(native) !== record || reader._internalReader !== native ||
          native._primaryView !== view || readerCandidate(reader)?.owner !== snapshot.owner) return;
      record.verified = true;
      keepPaperColors(native);
    }

    function onToolbar({reader}) { void inspect(reader).catch(() => {}); }
    function onThemeChanged() {
      // Run after Zotero's per-reader preference observers.
      void Promise.resolve().then(() => {
        for (const reader of manager._readers || []) {
          if (reader.type === 'snapshot') onToolbar({reader});
        }
      });
    }

    return {
      attachMainWindow, detachMainWindow,
      start() {
        if (active) return;
        active = true;
        manager.registerEventListener('renderToolbar', onToolbar, pluginID);
        wrapFileOpen();
        for (const win of Zotero.getMainWindows?.() || []) attachMainWindow(win);
        for (const key of [LIGHT_THEME, DARK_THEME]) {
          const id = Zotero.Prefs?.registerObserver?.(key, onThemeChanged);
          if (id !== undefined) themeObservers.push(id);
        }
        onThemeChanged();
      },
      shutdown() {
        if (!active) return;
        active = false;
        restoreOpen?.();
        for (const win of commandWindows.keys()) detachMainWindow(win);
        manager.unregisterEventListener?.('renderToolbar', onToolbar);
        for (const id of themeObservers.splice(0)) Zotero.Prefs?.unregisterObserver?.(id);
        for (const reader of manager._readers || []) {
          try {
            const native = reader._internalReader;
            if (!checked.get(native)?.verified || reader._isUninitialized || reader._isTabClosed) continue;
            native.setLightTheme(Zotero.Prefs?.get?.(LIGHT_THEME));
            native.setDarkTheme(Zotero.Prefs?.get?.(DARK_THEME));
          } catch (_) { /* Zotero can close a renderer during plugin shutdown. */ }
        }
        checked = new WeakMap();
      }
    };
  }

  const api = {create};
  root.AskGPTPaperHTMLAppearance = api;
  if (typeof module !== 'undefined') module.exports = api;
})(this);
