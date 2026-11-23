(function (root) {
  'use strict';
  const menus = new WeakMap();
  const latestMenu = new WeakMap();
  const report = error => root.Zotero?.logError?.(error);

  function open({chromeWindow, anchor, items, onClose} = {}) {
    const doc = chromeWindow?.document, anchorWindow = anchor?.ownerDocument?.defaultView;
    const os = root.Services?.appinfo?.OS;
    const isMac = os ? os === 'Darwin' : /^Mac/.test(chromeWindow?.navigator?.platform || '');
    if (!isMac || chromeWindow?.closed || !doc?.createXULElement || !anchorWindow || anchorWindow.closed ||
        anchor.isConnected === false || !items?.length) return null;

    let popup, handle, closing = false, closed = false, selected = false;
    const token = Symbol();
    function finish(notify) {
      if (closed) return;
      closed = true;
      if (menus.get(chromeWindow) === handle) menus.delete(chromeWindow);
      anchorWindow.removeEventListener('unload', close);
      popup?.removeEventListener('popuphidden', onHidden);
      popup?.remove();
      if (notify) {
        try { onClose?.(); } catch (error) { report(error); }
      }
    }
    function onHidden(event) {
      if (event.target === popup) finish(true);
    }
    function close() {
      if (closing) return;
      closing = true;
      if (closed) return;
      try { popup.hidePopup(); } catch (error) { report(error); }
      finally { finish(true); }
    }

    try {
      if (root.Services?.prefs?.getBoolPref?.('widget.macos.native-context-menus', true) === false) return null;
      const popupset = doc.getElementById('zotero-reader-popupset') || doc.querySelector(':root > popupset');
      const rect = anchor.getBoundingClientRect();
      const x = Math.round(anchorWindow.mozInnerScreenX + rect.left);
      const y = Math.round(anchorWindow.mozInnerScreenY + rect.bottom + 4);
      if (!popupset || !Number.isFinite(x) || !Number.isFinite(y)) return null;
      popup = doc.createXULElement('menupopup');
      if (typeof popup.openPopupAtScreen !== 'function' || typeof popup.hidePopup !== 'function') return null;
      for (const {label, disabled, run} of items) {
        const item = doc.createXULElement('menuitem');
        item.setAttribute('label', label);
        if (disabled || typeof run !== 'function') item.setAttribute('disabled', 'true');
        else item.addEventListener('command', () => {
          // Zotero can send the selected Cocoa command after popuphidden.
          if (closing || selected || anchor.isConnected === false || latestMenu.get(chromeWindow) !== token) return;
          selected = true;
          try { Promise.resolve(run()).catch(report); } catch (error) { report(error); }
        });
        popup.appendChild(item);
      }
      menus.get(chromeWindow)?.close();
      handle = {close};
      menus.set(chromeWindow, handle);
      latestMenu.set(chromeWindow, token);
      popup.addEventListener('popuphidden', onHidden);
      anchorWindow.addEventListener('unload', close);
      popupset.appendChild(popup);
      // Cocoa native menus require the screen-positioned context-menu path.
      popup.openPopupAtScreen(x, y, true);
      return handle;
    } catch (error) {
      closing = true;
      finish(false);
      report(error);
      return null;
    }
  }

  const api = {open}; root.AskGPTPaperNativeMenu = api;
  if (typeof module !== 'undefined') module.exports = api;
})(this);
