(function (root) {
  'use strict';
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const ROUTE = 'http://127.0.0.1:43792/v1/inline/paper-chat';
  const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const MARKER = /^p[0-9]{1,4}\.[0-9]{1,4}$/;
  const CITATION = /\[\[(p[0-9]{1,4}\.[0-9]{1,4})\]\]/g;
  const CITATION_RUN = /\[\[p[0-9]{1,4}\.[0-9]{1,4}\]\](?:[ \t,，、]*\[\[p[0-9]{1,4}\.[0-9]{1,4}\]\])*/g;
  const PARTIAL_CITATION = /\[\[p?[0-9]{0,4}(?:\.[0-9]{0,4})?\]?$/;
  const ATTACHMENT = /^[1-9][0-9]{0,11}:[A-Z0-9]{8}$/;
  const VERSION = /^[1-9][0-9]{0,3}(?:\.[0-9]{1,2}){0,2}$/;
  const failure = code => Object.assign(new Error(code), {code});
  const CSS = `
.askgpt-paper-chat {
  --askgpt-window: #f5f5f7;
  --askgpt-card: #fbfbfc;
  --askgpt-control: #eaeaec;
  --askgpt-edge: #d7d7dc;
  --askgpt-label: #222226;
  --askgpt-secondary: #616167;
  --askgpt-blue: #006adf;
  --askgpt-link: #005fc9;
  position: fixed; z-index: 87;
  left: var(--askgpt-chat-left, 12px); top: var(--askgpt-chat-top, auto);
  bottom: var(--askgpt-chat-bottom, 12px); margin: 0;
  box-sizing: border-box; color: var(--askgpt-label);
  background: var(--askgpt-window); color-scheme: light dark;
  border: 1px solid var(--askgpt-edge); border-radius: 15px;
  box-shadow: 0 9px 28px #0003, 0 2px 5px #0001; font: 13px/1.45 -apple-system, BlinkMacSystemFont, sans-serif;
}
.askgpt-paper-chat {
  display: flex; flex-direction: column; overflow: hidden; container-type: inline-size;
  width: var(--askgpt-chat-width, min(400px, calc(100vw - 24px)));
  height: var(--askgpt-chat-height, min(490px, 56vh));
}
.askgpt-paper-chat[hidden], .askgpt-paper-chat [hidden] { display: none !important; }
.askgpt-paper-chat button, .askgpt-paper-chat textarea {
  appearance: none; font: inherit; color: inherit; box-sizing: border-box;
  background: transparent; border: 0; margin: 0;
}
.askgpt-paper-chat button { padding: 0; cursor: pointer; -webkit-user-select: none; user-select: none; }
.askgpt-paper-chat button:focus-visible, .askgpt-paper-chat summary:focus-visible {
  outline: 2px solid var(--askgpt-blue); outline-offset: 1px;
}
.askgpt-paper-chat button:disabled { opacity: .47; cursor: default; }
.askgpt-chat-header, .askgpt-chat-footer { display: flex; align-items: center; gap: 5px; }
.askgpt-chat-header {
  padding: 4px 9px 4px 11px; min-height: 26px; flex: none;
  border-bottom: 1px solid var(--askgpt-edge);
}
.askgpt-chat-header, .askgpt-paper-chat .askgpt-chat-move {
  cursor: grab; touch-action: none; -webkit-user-select: none; user-select: none;
}
.askgpt-chat-header:active, .askgpt-paper-chat .askgpt-chat-move:active { cursor: grabbing; }
.askgpt-paper-chat .askgpt-chat-move { flex: 1; min-width: 0; font-weight: 650; text-align: start; border-radius: 5px; }
.askgpt-chat-header button:not(.askgpt-chat-move) {
  display: inline-grid; place-content: center; place-items: center;
  flex: none; width: 25px; height: 25px; border-radius: 7px; color: var(--askgpt-secondary);
  font-size: 15px; font-weight: 600; line-height: 1;
}
.askgpt-chat-window-icon { position: relative; display: block; width: 12px; height: 12px; pointer-events: none; }
.askgpt-chat-window-icon::before, .askgpt-chat-window-icon::after { content: ''; position: absolute; box-sizing: border-box; }
.askgpt-chat-window-icon::before { top: 5px; left: 0; width: 12px; height: 2px; border-radius: 1px; background: currentColor; }
.askgpt-chat-window-icon.detach::before { transform: rotate(-45deg); }
.askgpt-chat-window-icon.detach::after {
  top: 1px; right: 1px; width: 7px; height: 7px; border-top: 2px solid currentColor; border-right: 2px solid currentColor;
}
.askgpt-chat-window-icon.search::before {
  top: 0; left: 0; width: 9px; height: 9px; border: 1.5px solid currentColor; border-radius: 50%; background: none;
}
.askgpt-chat-window-icon.search::after {
  right: 0; bottom: 1px; width: 5px; height: 1.5px; border-radius: 1px; background: currentColor; transform: rotate(45deg);
}
.askgpt-chat-header button:not(.askgpt-chat-move):enabled:hover { background: var(--askgpt-control); color: var(--askgpt-label); }
.askgpt-chat-traffic { display: flex; flex: none; align-items: center; margin-inline: -4px 3px; cursor: default; }
.askgpt-chat-traffic button:not(.askgpt-chat-move),
.askgpt-chat-traffic button:not(.askgpt-chat-move):enabled:hover { width: 20px; background: transparent; }
.askgpt-chat-traffic .askgpt-chat-window-icon {
  border-radius: 50%; box-shadow: inset 0 0 0 1px #0002; color: #202024;
  background: var(--askgpt-traffic);
}
.askgpt-chat-traffic-close { --askgpt-traffic: #ff5f57; }
.askgpt-chat-traffic-fold { --askgpt-traffic: #febc2e; }
.askgpt-chat-traffic-fit { --askgpt-traffic: #28c840; }
.askgpt-chat-traffic button:disabled { --askgpt-traffic: var(--askgpt-edge); }
.askgpt-chat-traffic .askgpt-chat-window-icon::before,
.askgpt-chat-traffic .askgpt-chat-window-icon::after { opacity: 0; }
.askgpt-chat-traffic:hover button:enabled span::before, .askgpt-chat-traffic:hover button:enabled span::after,
.askgpt-chat-traffic button:focus-visible span::before, .askgpt-chat-traffic button:focus-visible span::after { opacity: 1; }
.askgpt-chat-traffic .askgpt-chat-window-icon::before { width: 6px; height: 1px; left: 3px; top: 5.5px; }
.askgpt-chat-window-icon.close::before { transform: rotate(45deg); }
.askgpt-chat-window-icon.close::after { inset: 5.5px 3px; background: currentColor; transform: rotate(-45deg); }
.askgpt-chat-window-icon.expand::after { inset: 3px 5.5px; background: currentColor; }
.askgpt-chat-traffic :is(.fit,.restore)::before, .askgpt-chat-traffic :is(.fit,.restore)::after {
  width: 0; height: 0; box-sizing: content-box; border: 2px solid transparent; border-radius: 0; background: none;
}
.askgpt-chat-traffic .fit::before { left: 2px; top: 2px; border-top-color: currentColor; border-left-color: currentColor; }
.askgpt-chat-traffic .fit::after { right: 2px; bottom: 2px; border-bottom-color: currentColor; border-right-color: currentColor; }
.askgpt-chat-traffic .restore::before { left: 2px; top: 6px; border-right-color: currentColor; border-top-color: currentColor; }
.askgpt-chat-traffic .restore::after { right: 2px; bottom: 6px; border-left-color: currentColor; border-bottom-color: currentColor; }
.askgpt-chat-paper, .askgpt-chat-message, .askgpt-chat-composer {
  background: var(--askgpt-card); border: 1px solid var(--askgpt-edge); border-radius: 12px;
}
.askgpt-chat-paper { flex: none; margin: 9px 10px 4px; padding: 8px 9px; }
.askgpt-chat-paper h2 {
  margin: 0 0 7px; font-size: 13px; font-weight: 650;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.askgpt-chat-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.askgpt-chat-scope { display: inline-flex; gap: 1px; background: var(--askgpt-control); border-radius: 8px; padding: 2px; }
.askgpt-chat-tools button, .askgpt-chat-footer button, .askgpt-chat-status button {
  border-radius: 7px; padding: 4px 9px; white-space: nowrap; font-size: 12px; font-weight: 600;
}
.askgpt-chat-scope button[aria-pressed=true], .askgpt-chat-footer .askgpt-chat-send:enabled {
  background: var(--askgpt-blue); color: #fff;
}
.askgpt-paper-chat .askgpt-chat-summarize, .askgpt-chat-footer button, .askgpt-chat-status button { background: var(--askgpt-control); }
.askgpt-chat-summarize:enabled:hover, .askgpt-chat-footer button:enabled:hover, .askgpt-chat-status button:enabled:hover { filter: brightness(.95); }
.askgpt-chat-messages { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 4px 10px 2px; }
.askgpt-chat-message { padding: 8px 10px; margin-bottom: 7px; }
.askgpt-chat-message.user { background: var(--askgpt-control); }
.askgpt-chat-message[data-search-current] { border-color: var(--askgpt-link); }
.askgpt-chat-find {
  flex: none; display: flex; align-items: center; gap: 4px; margin: 5px 10px 1px;
  padding: 3px 5px; border: 1px solid var(--askgpt-edge); border-radius: 8px;
  background: var(--askgpt-card);
}
.askgpt-chat-find:focus-within { border-color: var(--askgpt-blue); }
.askgpt-chat-find input {
  flex: 1; min-width: 0; background: none; border: 0; outline: none;
  color: inherit; font: inherit; padding: 1px 2px;
}
.askgpt-chat-find input::placeholder { color: var(--askgpt-secondary); }
.askgpt-chat-find button { flex: none; width: 24px; height: 24px; border-radius: 5px; }
.askgpt-chat-find button:enabled:hover { background: var(--askgpt-control); }
.askgpt-chat-find-count { flex: none; font-size: 11px; color: var(--askgpt-secondary); }
.askgpt-paper-chat[data-minimized="true"] {
  height: 36px; width: min(400px, var(--askgpt-chat-width, calc(100vw - 24px)));
  transform: translateY(max(0px, calc(var(--askgpt-chat-height, min(490px, 56vh)) - 36px)));
}
.askgpt-paper-chat[data-minimized="true"] > :not(.askgpt-chat-header),
.askgpt-paper-chat[data-minimized="true"] .askgpt-chat-window-action { display: none !important; }
.askgpt-paper-chat[data-minimized="true"] .askgpt-chat-header { border-bottom: 0; }
.askgpt-paper-chat[data-minimized="true"] :is(.askgpt-chat-header, .askgpt-chat-move) { cursor: default; }
.askgpt-chat-role { display: block; margin-bottom: 4px; font-size: 11px; font-weight: 650; color: var(--askgpt-secondary); }
.askgpt-chat-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.askgpt-chat-text strong { font-weight: 700; }
.askgpt-chat-text code { font: .92em ui-monospace, monospace; }
.askgpt-inline-citation {
  display: inline; margin-inline-start: .26em; white-space: normal;
  color: var(--askgpt-link); font-size: .9em; font-weight: 400; font-style: normal;
}
.askgpt-paper-chat .askgpt-inline-citation button {
  display: inline-block; padding-inline: .12em; white-space: nowrap; text-decoration: underline;
}
.askgpt-chat-sources { display: flex; flex-wrap: wrap; gap: 4px 8px; padding-top: 4px; font-size: 12px; }
.askgpt-chat-sources:empty { display: none; }
.askgpt-chat-unplaced { color: var(--askgpt-secondary); }
.askgpt-chat-sources button, .askgpt-chat-sources summary {
  text-align: start; color: var(--askgpt-link); padding: 2px; text-decoration: underline; cursor: pointer;
}
.askgpt-chat-sources details[open] { flex-basis: 100%; }
.askgpt-chat-sources details button { display: block; padding-inline-start: 12px; overflow-wrap: anywhere; }
.askgpt-chat-composer { padding: 7px 8px 6px; margin: 5px 10px 10px; flex: none; }
.askgpt-chat-composer:focus-within { border-color: var(--askgpt-blue); }
.askgpt-chat-composer textarea { display: block; width: 100%; min-height: 42px; resize: none; outline: none; padding: 0 1px; }
.askgpt-chat-composer textarea::placeholder { color: var(--askgpt-secondary); }
.askgpt-chat-footer { padding-top: 3px; }
.askgpt-chat-model { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; color: var(--askgpt-secondary); }
.askgpt-chat-status { padding: 2px 11px 4px; font-size: 12px; color: var(--askgpt-secondary); }
.askgpt-chat-status button { margin-inline-start: 6px; }
.askgpt-paper-chat .askgpt-chat-resize {
  position: absolute; z-index: 1; right: 1px; top: 1px; width: 22px; height: 22px;
  color: var(--askgpt-secondary); border-radius: 5px; cursor: nesw-resize; touch-action: none;
}
.askgpt-paper-chat[data-resize-y="bottom"] .askgpt-chat-resize { top: auto; bottom: 1px; cursor: nwse-resize; }
.askgpt-paper-chat[data-resize-x="left"] .askgpt-chat-resize { right: auto; left: 1px; cursor: nwse-resize; }
.askgpt-paper-chat[data-resize-y="bottom"][data-resize-x="left"] .askgpt-chat-resize { cursor: nesw-resize; }
.askgpt-paper-chat[data-resize-y="top"][data-resize-x="right"] .askgpt-chat-header { padding-right: 23px; }
.askgpt-paper-chat[data-resize-y="top"][data-resize-x="left"] .askgpt-chat-header { padding-left: 23px; }
.askgpt-paper-chat :is(.askgpt-chat-resize-horizontal, .askgpt-chat-resize-vertical) {
  position: absolute; z-index: 1; touch-action: none; color: var(--askgpt-secondary);
}
.askgpt-paper-chat .askgpt-chat-resize-horizontal {
  top: calc(50% - 22px); right: 0; width: 7px; height: 44px; cursor: ew-resize;
}
.askgpt-paper-chat[data-resize-x="left"] .askgpt-chat-resize-horizontal { right: auto; left: 0; }
.askgpt-paper-chat .askgpt-chat-resize-vertical {
  top: 0; left: 26px; right: 26px; height: 4px; cursor: ns-resize;
}
.askgpt-paper-chat[data-resize-y="bottom"] .askgpt-chat-resize-vertical { top: auto; bottom: 0; height: 7px; }
.askgpt-paper-chat :is(.askgpt-chat-resize-horizontal, .askgpt-chat-resize-vertical):focus-visible {
  outline-offset: -2px;
}
.askgpt-chat-resize-horizontal::after, .askgpt-chat-resize-vertical::after {
  content: ''; position: absolute; border-radius: 1px; background: currentColor; opacity: .45;
}
.askgpt-chat-resize-horizontal::after { top: calc(50% - 10px); right: 3px; width: 1px; height: 20px; }
.askgpt-chat-resize-vertical::after { left: calc(50% - 10px); top: 1px; width: 20px; height: 1px; }
.askgpt-paper-chat[data-resize-y="bottom"] .askgpt-chat-resize-vertical::after { top: auto; bottom: 2px; }
.askgpt-paper-chat[data-fitted="true"] :is(.askgpt-chat-resize, .askgpt-chat-resize-horizontal, .askgpt-chat-resize-vertical) {
  display: none;
}
.askgpt-paper-chat[data-fitted="true"] :is(.askgpt-chat-header, .askgpt-chat-move) { cursor: default; }
@container (max-width: 270px) {
  .askgpt-chat-paper, .askgpt-chat-composer { margin-inline: 6px; }
  .askgpt-chat-messages { padding-inline: 6px; }
}
@media (prefers-color-scheme: dark) {
  .askgpt-paper-chat {
    --askgpt-window: #2b2b2e; --askgpt-card: #323236; --askgpt-control: #3e3e44;
    --askgpt-edge: #4f4f55; --askgpt-label: #f3f3f5; --askgpt-secondary: #b9b9c0;
    --askgpt-blue: #126ad8; --askgpt-link: #9bc8ff;
  }
}
@supports (backdrop-filter: blur(18px)) {
  .askgpt-paper-chat {
    --askgpt-glass: rgb(244 247 251 / 68%);
    --askgpt-glass-light: rgb(255 255 255 / 58%);
    --askgpt-glass-rim: rgb(255 255 255 / 82%);
    background: linear-gradient(155deg, var(--askgpt-glass-light), transparent 40%), var(--askgpt-glass);
    backdrop-filter: blur(22px) saturate(145%);
    box-shadow: inset 0 1px 0 var(--askgpt-glass-rim), 0 9px 28px #0003, 0 2px 5px #0001;
  }
  @media (prefers-color-scheme: dark) {
    .askgpt-paper-chat {
      --askgpt-glass: rgb(38 39 46 / 76%);
      --askgpt-glass-light: rgb(255 255 255 / 13%);
      --askgpt-glass-rim: rgb(255 255 255 / 22%);
    }
  }
}
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active) {
  .askgpt-paper-chat { background: var(--askgpt-window); backdrop-filter: none; }
}
@media (prefers-contrast: more) {
  .askgpt-paper-chat {
    --askgpt-edge: CanvasText; --askgpt-secondary: CanvasText; --askgpt-blue: Highlight;
    --askgpt-link: LinkText; box-shadow: none;
  }
  .askgpt-chat-traffic button:enabled span::before, .askgpt-chat-traffic button:enabled span::after { opacity: 1; }
}
`;

  function installGeometry({doc, panel, header, moveHandle, resize, resizeHorizontal, resizeVertical,
                            available, loadLayout, saveLayout, fitChanged, t}) {
    const win = doc.defaultView;
    if (!win) return {fit() {}, toggleFit: () => false, fitted: false, cancel() {}, dispose() {}};
    const defaultLayout = {x: 0, y: 1, width: null, height: null};
    const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
    const validSize = n => n === null || Number.isFinite(n) && n > 0 && n <= 16_384;
    let layout = defaultLayout, gesture = null, fitted = false;
    try {
      const raw = loadLayout?.();
      const saved = typeof raw === 'string' && raw.length <= 240 ? JSON.parse(raw) : null;
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
          && validSize(saved.width) && validSize(saved.height)) {
        layout = {x: clamp(saved.x, 0, 1), y: clamp(saved.y, 0, 1), width: saved.width, height: saved.height};
      }
    } catch (_) { /* Invalid preferences use the default. */ }

    const live = doc.createElementNS(XHTML, 'span');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('style', 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);');
    panel.append(live);
    function area() {
      const view = win.visualViewport;
      const width = view?.width ?? win.innerWidth, height = view?.height ?? win.innerHeight;
      if (!(width > 0 && height > 0)) return null;
      const marginX = Math.min(12, width / 16), marginY = Math.min(12, height / 16);
      const left = (view?.offsetLeft || 0) + marginX, top = (view?.offsetTop || 0) + marginY;
      const bottom = top + height - marginY * 2;
      const toolbarBottom = doc.querySelector?.('.toolbar')?.getBoundingClientRect?.().bottom || 0;
      const readingTop = clamp(toolbarBottom, top, Math.max(top, bottom - Math.min(180, height / 2)));
      return {left, top: readingTop, width: width - marginX * 2, height: bottom - readingTop};
    }
    function frame(bounds) {
      if (fitted) return bounds;
      const width = clamp(layout.width ?? 400, Math.min(320, bounds.width), bounds.width);
      const height = clamp(layout.height ?? Math.min(490, bounds.height * .56), Math.min(220, bounds.height), bounds.height);
      return {left: bounds.left + (bounds.width - width) * layout.x,
        top: bounds.top + (bounds.height - height) * layout.y, width, height};
    }
    function fit(bounds = area()) {
      if (!bounds) return;
      const rect = frame(bounds);
      panel.style.setProperty('--askgpt-chat-left', rect.left + 'px');
      panel.style.setProperty('--askgpt-chat-top', rect.top + 'px');
      panel.style.setProperty('--askgpt-chat-bottom', 'auto');
      panel.style.setProperty('--askgpt-chat-width', rect.width + 'px');
      panel.style.setProperty('--askgpt-chat-height', rect.height + 'px');
      panel.setAttribute('data-fitted', String(fitted));
      panel.setAttribute('data-resize-x', gesture?.edgeX ?? (layout.x > .5 ? 'left' : 'right'));
      panel.setAttribute('data-resize-y', gesture?.edgeY ?? (layout.y > .5 ? 'top' : 'bottom'));
    }
    function persist() {
      try { saveLayout?.(JSON.stringify(layout)); } catch (_) { /* A failed write leaves the in-tab layout usable. */ }
    }
    function change(start, dx, dy) {
      const {bounds, rect, edgeX, edgeY} = start;
      const signX = edgeX === 'left' ? -1 : 1, signY = edgeY === 'top' ? -1 : 1;
      const width = edgeX ? clamp(rect.width + dx * signX, Math.min(320, bounds.width), bounds.width) : rect.width;
      const height = edgeY ? clamp(rect.height + dy * signY, Math.min(220, bounds.height), bounds.height) : rect.height;
      const left = rect.left + (edgeX ? (signX < 0 ? rect.width - width : 0) : dx);
      const top = rect.top + (edgeY ? (signY < 0 ? rect.height - height : 0) : dy);
      const x = bounds.width > width ? clamp((left - bounds.left) / (bounds.width - width), 0, 1) : layout.x;
      const y = bounds.height > height ? clamp((top - bounds.top) / (bounds.height - height), 0, 1) : layout.y;
      layout = {x, y, width: edgeX ? width : layout.width, height: edgeY ? height : layout.height};
      fit(bounds);
    }
    function startFor(handle) {
      const bounds = area();
      if (!bounds) return null;
      return {bounds, rect: frame(bounds),
        edgeX: handle === resize || handle === resizeHorizontal ? panel.getAttribute('data-resize-x') : null,
        edgeY: handle === resize || handle === resizeVertical ? panel.getAttribute('data-resize-y') : null};
    }
    function start(event) {
      if (!available() || fitted || gesture || event.button !== 0 || event.isPrimary === false) return;
      const handle = event.currentTarget;
      const control = event.target?.closest?.('button, input, textarea, select, a');
      if (handle === header && control && control !== moveHandle) return;
      const base = startFor(handle);
      if (!base) return;
      gesture = {...base, handle, id: event.pointerId, x: event.clientX, y: event.clientY, moved: false};
      try { handle.setPointerCapture?.(event.pointerId); } catch (_) { /* The document also listens for movement. */ }
    }
    function move(event) {
      if (!gesture || gesture.id !== event.pointerId) return;
      const {x, y, edgeX, edgeY} = gesture;
      const dx = edgeY && !edgeX ? 0 : event.clientX - x;
      const dy = edgeX && !edgeY ? 0 : event.clientY - y;
      if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
      gesture.moved = true;
      event.preventDefault();
      change(gesture, dx, dy);
    }
    function end(event) {
      if (!gesture || event && gesture.id !== event.pointerId) return;
      const {handle, id, moved} = gesture;
      gesture = null;
      if (handle.hasPointerCapture?.(id)) handle.releasePointerCapture(id);
      if (moved) persist();
      fit();
    }
    function toggleFit() {
      const bounds = area();
      if (!available() || !bounds) return fitted;
      end();
      fitted = !fitted;
      fit(bounds);
      fitChanged?.(fitted);
      return fitted;
    }
    const arrows = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};
    function key(event) {
      const direction = arrows[event.key];
      if (!direction || !available() || fitted) return;
      const handle = event.currentTarget;
      const base = startFor(handle);
      if (!base) return;
      if (base.edgeX && !base.edgeY && !direction[0] || base.edgeY && !base.edgeX && !direction[1]) return;
      event.preventDefault();
      event.stopPropagation?.();
      change(base, direction[0] * 16, direction[1] * 16);
      persist();
      live.textContent = base.edgeX || base.edgeY ? t('已调整问答栏大小', 'Paper chat resized')
        : t('已移动问答栏', 'Paper chat moved');
    }
    const removers = [];
    function listen(target, type, listener, capture = false) {
      target?.addEventListener(type, listener, capture);
      if (target) removers.push(() => target.removeEventListener(type, listener, capture));
    }
    const grips = [resize, resizeHorizontal, resizeVertical].filter(Boolean);
    for (const handle of [header, ...grips]) {
      listen(handle, 'pointerdown', start);
      listen(handle, 'lostpointercapture', end);
    }
    for (const handle of [moveHandle, ...grips]) listen(handle, 'keydown', key);
    listen(doc, 'pointermove', move);
    listen(doc, 'pointerup', end);
    listen(doc, 'pointercancel', end);
    const refit = () => { end(); fit(); };
    listen(win, 'resize', refit);
    listen(win.visualViewport, 'resize', refit);
    listen(win.visualViewport, 'scroll', refit);
    return {fit, toggleFit, get fitted() { return fitted; }, cancel: () => end(),
      dispose() { end(); for (const remove of removers) remove(); }};
  }

  function createTransport({Zotero, readConnection, ensureReady}) {
    let pairing;
    return async (message, {isCurrent, cancellers, connection} = {}) => {
      const current = () => isCurrent?.() !== false;
      if (!current()) throw failure('stopped');
      const credentials = connection ?? pairing ?? await readConnection();
      if (!connection && message.action === 'open') await ensureReady?.(credentials, current);
      if (!current()) throw failure('stopped');
      pairing = credentials;
      let reply, cancel;
      try {
        reply = await Zotero.HTTP.request('POST', ROUTE, {
          body: JSON.stringify(message), headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + credentials.token},
          responseType: 'text', timeout: message.action === 'jump' ? 20000 : 8000,
          followRedirects: false, anon: true, noCache: true, debug: false, logBodyLength: 0, errorDelayMax: 0,
          successCodes: [200, 400, 401, 403, 404, 409, 413, 429, 500, 502, 503, 504],
          cancellerReceiver(value) {
            cancel = value;
            if (!current()) cancel();
            else cancellers?.add(cancel);
          }
        });
      } catch (_) {
        pairing = undefined;
        throw failure(current() ? 'connection' : 'stopped');
      } finally {
        if (cancel) cancellers?.delete(cancel);
      }
      if (!current()) throw failure('stopped');
      if (reply.status === 404 && message.action === 'open') throw failure('update_app');
      if ([401, 403].includes(reply.status)) { pairing = undefined; throw failure('connection'); }
      if (reply.status === 413) throw failure('limit');
      if (reply.status === 503 && message.action !== 'open' && reply.responseText?.length <= 4096) {
        let code;
        try { code = JSON.parse(reply.responseText)?.error?.code; } catch (_) {}
        if (code === 'paper_chat_unavailable') throw failure('reopen');
      }
      if (reply.status !== 200 || typeof reply.responseText !== 'string' || reply.responseText.length > 16 * 1024 * 1024)
        throw failure('response');
      try { return JSON.parse(reply.responseText); } catch (_) { throw failure('response'); }
    };
  }

  function validState(state) {
    return state && ATTACHMENT.test(state.attachmentID) && typeof state.title === 'string' &&
      typeof state.model === 'string' && ['nearby', 'whole'].includes(state.scope) &&
      typeof state.isSending === 'boolean' && Array.isArray(state.messages) && state.messages.every(item =>
        item && UUID.test(item.id) && ['user', 'assistant'].includes(item.role) &&
        typeof item.text === 'string' && typeof item.completed === 'boolean' &&
        (item.sources == null || Array.isArray(item.sources) && item.sources.every(source =>
          source && MARKER.test(source.marker) && Number.isInteger(source.page) && source.page > 0 &&
          source.marker.startsWith('p' + source.page + '.') && typeof source.quote === 'string')));
  }

  const markFields = ['color', 'mark', 'comment', 'commentFromAnswer'];
  const modelActionFields = new Map([
    ['highlight', [...markFields, 'target', 'quote', 'citation']],
    ['paperTitle', markFields], ['paperAbstract', markFields], ['evidence', [...markFields, 'point']],
    ['topic', ['topic', 'color']], ['note', ['text', 'target']],
    ['noteAppend', ['text', 'title']], ['noteReplace', ['text', 'title']],
    ['recolor', ['color']], ['undo', []], ['undoHighlight', []],
  ]);
  const modelColors = new Set(['#ffd400', '#2ea8e5', '#5fb236', '#e56eee', '#ff6666']);

  function resolveModelActions(body, question) {
    if (typeof body !== 'string' || body.length > 8192) return null;
    let plan;
    try { plan = JSON.parse(body); } catch (_) { return null; }
    if (!plan || Object.keys(plan).length !== 2 || typeof plan.request !== 'string' ||
        !plan.request.trim() || !question.includes(plan.request) ||
        !Array.isArray(plan.operations) || !plan.operations.length || plan.operations.length > 8) return null;
    const text = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max;
    for (const operation of plan.operations) {
      const fields = modelActionFields.get(operation?.type);
      if (!fields || Object.keys(operation).some(name => name !== 'type' && !fields.includes(name))) return null;
      const {type, color, mark, point, citation, quote, topic, target, comment, commentFromAnswer, title} = operation;
      if (color !== undefined && !modelColors.has(color) || type === 'recolor' && !modelColors.has(color)
          || mark !== undefined && mark !== 'underline'
          || point !== undefined && (!Number.isInteger(point) || point < 1 || point > 100)
          || citation !== undefined && (!Number.isInteger(citation) || citation < 1 || citation > 30)
          || quote !== undefined && !text(quote, 6000)
          || comment !== undefined && (!text(comment, 12000) || !plan.request.includes(comment))
          || commentFromAnswer !== undefined && (commentFromAnswer !== true || comment !== undefined)
          || title !== undefined && (!text(title, 300) || !plan.request.includes(title))) return null;
      if (type === 'highlight' && ([target, quote, citation].filter(value => value !== undefined).length !== 1
          || target !== undefined && target !== 'selection')) return null;
      if (type === 'topic' && !text(topic, 100)) return null;
      if (type === 'note' && (target !== undefined && !['selection', 'abstract', 'answer'].includes(target)
          || target !== undefined && operation.text !== undefined
          || target === undefined && (!text(operation.text, 12000) || !plan.request.includes(operation.text)))) return null;
      if (['noteAppend', 'noteReplace'].includes(type) &&
          (!text(operation.text, 12000) || !plan.request.includes(operation.text))) return null;
    }
    return {operations: plan.operations};
  }

  function resolveEvidenceCommands(operations, answer) {
    const sources = answer?.sources || [];
    const citations = new Map(sources.map((source, index) => [source.marker, index + 1]));
    const points = Array.isArray(answer?.evidencePoints) ? answer.evidencePoints : [];
    const severalConclusions = (answer?.text.match(/^ {0,3}\d{1,3}[.)]\s+\S/gm)?.length || 0) > 1;
    const usable = points.filter(point => Number.isInteger(point?.number) && point.number > 0
      && Array.isArray(point.markers) && point.markers.length > 0
      && point.markers.every(marker => citations.has(marker)));
    const resolved = operations.flatMap(operation => {
      if (operation.type !== 'evidence') return [operation];
      if (!sources.length) throw failure('no-evidence');
      const matches = operation.point === undefined
        ? usable : usable.filter(point => point.number === operation.point);
      let markers;
      if (operation.point === undefined && sources.length === 1 && !severalConclusions) markers = [sources[0].marker];
      else if (matches.length === 1 && (operation.point !== undefined
          || !severalConclusions && new Set(matches[0].markers).size === citations.size)) markers = matches[0].markers;
      else if (operation.point === undefined) {
        throw Object.assign(failure('choose-evidence'), {points: usable.map(point => point.number)});
      } else throw failure('point-not-cited');
      return [...new Set(markers)].map(marker => ({
        type: 'highlight', citation: citations.get(marker), color: operation.color, comment: operation.comment,
        ...operation.mark && {mark: operation.mark},
        ...operation.commentFromAnswer && {commentFromAnswer: true},
      }));
    });
    if (resolved.length > 12) throw failure('too-many-evidence');
    return resolved;
  }

  function answerHighlightQuotes(text) {
    const quotes = new Set();
    let fence = '';
    let afterMarkedLabel = false;
    for (const line of text.split(/\r?\n/u)) {
      const delimiter = /^\s{0,3}(\x60{3,}|~{3,})/u.exec(line)?.[1];
      if (delimiter) {
        afterMarkedLabel = false;
        if (!fence) fence = delimiter;
        else if (delimiter[0] === fence[0] && delimiter.length >= fence.length
            && line.trim() === delimiter) fence = '';
        continue;
      }
      if (fence) continue;
      const marked = /^\s{0,3}(?:(?:[-+*]|\d+[.)])\s+)?🟨\s*(.+)$/u.exec(line)?.[1];
      const explicit = /^\s{0,3}>\s+(.+)$/u.exec(line)
        || /[:：]\s*“([^”]+)”\s*$/u.exec(line);
      const markedQuote = marked && (/^\*\*([^*]+)\*\*/u.exec(marked)?.[1] || marked);
      const candidate = explicit?.[1] || markedQuote || (afterMarkedLabel ? line : '');
      const quote = candidate.trim().replace(/\*\*([^*]+)\*\*/gu, '$1').replace(/^“(.+)”$/u, '$1');
      const complete = quote.length >= 20 && quote.length <= 3000 && /[.!?。！？]["'”’）)\]]*$/u.test(quote);
      if (complete) {
        quotes.add(quote.replace(/\s+/gu, ' '));
      }
      afterMarkedLabel = !!marked && !complete && marked.length <= 120;
    }
    return [...quotes];
  }

  function recentAnswer(messages, contextual, parseCommand) {
    const latest = messages.findLastIndex(item => item.role === 'assistant' && item.completed && item.text.trim());
    if (!contextual) return messages[latest];
    for (let index = latest; index >= 0; index -= 2) {
      const answer = messages[index], question = messages[index - 1];
      if (answer.role !== 'assistant' || !answer.completed) break;
      if (answer.sources?.length || answerHighlightQuotes(answer.text).length) return answer;
      if (question?.role !== 'user') break;
      const priorKind = parseCommand?.(question.text)?.kind;
      const formatQuestion = /^\s*(?:这(?:里)?是|是)(?:纯)?文本[吗么嘛][？?]?\s*$/u.test(question.text);
      const highlightFollowUp = ['capabilities', 'answerHighlight', 'contextHighlight'].includes(priorKind);
      if (!highlightFollowUp && !formatQuestion) break;
    }
    return messages[latest];
  }

  function highlightCommand(command, answer, selection) {
    if (command.operations) return resolveEvidenceCommands(command.operations, answer);
    if (command.kind === 'contextHighlight' && selection?.text && !selection.translated)
      return [{type: 'highlight', target: 'selection', color: command.color}];
    if (!answer) throw failure('no-highlight-target');
    const quotes = answerHighlightQuotes(answer.text);
    if (quotes.length > 12) throw failure('too-many-evidence');
    if (command.count && quotes.length !== command.count)
      throw Object.assign(failure('choose-highlight-count'), {count: command.count});
    if (quotes.length) return [{type: 'answerQuotes', quotes, color: command.color}];
    return resolveEvidenceCommands([{type: 'evidence', color: command.color}], answer);
  }

  function renderAssistantText(container, text, streaming, appendCitations) {
    const doc = container.ownerDocument;
    const inline = /\\(?<escape>[\\*_\x60])|(?<ticks>\x60+)(?<code>[^\x60]+)\k<ticks>(?!\x60)|(?<dollars>\${1,2})(?!\s)[^$]*?\S\k<dollars>(?!\$)|(?<![\w*])(?<stars>\*{1,3})(?![\s*])(?<emphasis>[^*]+)(?<!\s)\k<stars>(?![\w*])|(?<![\w_])(?<underscores>_{1,2})(?![\s_])(?<alternate>[^_]+)(?<!\s)\k<underscores>(?![\w_])/g;
    const partial = /(^|[^\w*])\*{1,3}(?![\s*])([^*]*)$/;
    const blockStart = /^ {0,3}(?:(?:#{1,6}|[-+*]|\d{1,9}\.)[ \t]+|\x60{3,}|~{3,})|^\s*$/;
    const cjkProse = /[\p{Script=Han}。！？、，；：“”「」]/u;
    const lines = (appendCitations ? text.replace(PARTIAL_CITATION, '') : text).split(/\r?\n/);
    const result = doc.createDocumentFragment();
    let fence = '';
    const literal = value => appendCitations ? value.replace(CITATION_RUN, '') : value;
    function append(parent, value) {
      if (!appendCitations || !value.includes('[[p')) { parent.append(value); return; }
      let start = 0;
      for (const run of value.matchAll(CITATION_RUN)) {
        parent.append(value.slice(start, run.index));
        if (value[run.index - 1] !== '\\') {
          appendCitations(parent, Array.from(run[0].matchAll(CITATION), match => match[1]));
        }
        start = run.index + run[0].length;
      }
      parent.append(value.slice(start));
    }
    function prose(value, start, end) {
      return value.slice(start, end).replace(/(?<!\*)([ \t]*)\*{2,3}(?!\*)([ \t]*)/g,
        (marker, left, right, offset) => {
          const at = start + offset;
          const before = value[at - 1] || '', after = value[at + marker.length] || '';
          if (/[\w*\\]/.test(before) || /[\w*\\]/.test(after)) {
            // In ASCII prose only remove an orphan at the edge of a complete phrase.
            const other = !before ? value.slice(at + marker.length) : !after ? value.slice(0, at) : '';
            if (!/^[A-Za-z]+(?:[ \t]+[A-Za-z]+){2,}[.!?]?$/.test(other.trim())) return marker;
          } else if (!cjkProse.test(before) && !cjkProse.test(after)) return marker;
          return before && after && (left || right) ? ' ' : '';
        });
    }
    for (let index = 0; index < lines.length; index++) {
      let line = lines[index];
      const marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
      if (marker && !fence) { fence = marker[1]; continue; }
      if (marker && fence && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = '';
        continue;
      }
      if (fence) {
        const code = doc.createElementNS(XHTML, 'code');
        code.textContent = literal(line);
        result.append(code);
      } else {
        const heading = /^ {0,3}#{1,6}[ \t]+(.+)$/.exec(line);
        if (!heading && line.trim()) {
          const start = index;
          while (index + 1 < lines.length && !blockStart.test(lines[index + 1])) index++;
          if (index !== start) line = lines.slice(start, index + 1).join('\n');
        }
        const body = heading ? doc.createElementNS(XHTML, 'strong') : result;
        const value = heading?.[1] ?? line.replace(/^([ \t]{0,3})[-+*][ \t]+(?=\S)/, '$1• ');
        let position = 0;
        for (const match of value.matchAll(inline)) {
          append(body, prose(value, position, match.index));
          const {escape, code, stars, emphasis, underscores, alternate} = match.groups;
          const delimiter = stars || underscores;
          if (code != null || delimiter) {
            const formatted = doc.createElementNS(XHTML, code != null ? 'code' : delimiter.length > 1 ? 'strong' : 'em');
            if (delimiter?.length === 3) {
              const italic = doc.createElementNS(XHTML, 'em');
              append(italic, emphasis);
              formatted.append(italic);
            } else if (code != null) formatted.textContent = literal(code);
            else append(formatted, emphasis ?? alternate);
            body.append(formatted);
          } else body.append(escape ?? literal(match[0]));
          position = match.index + match[0].length;
        }
        let tail = prose(value, position, value.length);
        if (streaming && index === lines.length - 1) tail = tail.replace(partial, '$1$2');
        append(body, tail);
        if (heading) result.append(body);
      }
      if (index < lines.length - 1) result.append('\n');
    }
    container.replaceChildren(result);
  }

  function mount({doc, clientID, chinese, request, extract, readInputs, isCurrent, openInWindow, setTimer, clearTimer,
                  loadLayout, saveLayout, commands, parseCommand}) {
    if (!doc?.body || !UUID.test(clientID)) return null;
    const t = (zh, en) => chinese ? zh : en;
    const cancellers = new Set(), rows = new Map(), commandRows = [];
    let disposed = false, active = true, attached = null, state = null, pending = false, polling = false, timer = null;
    let stagedInputs = null, snapshot = null, revision = 0, needsOpen = true, returnFocus = null;
    let commandPending = false, followUp = null, minimized = false;
    let searchMatches = [], searchCursor = -1;
    const current = () => !disposed && isCurrent();
    const send = (action, fields = {}, connection) => request({action, clientID, ...fields}, {
      isCurrent: current, cancellers, connection
    });
    function node(tag, className, label) {
      const value = doc.createElementNS(XHTML, tag);
      if (className) value.className = className;
      if (label != null) value.textContent = label;
      return value;
    }
    function button(label, fn, accessibleLabel = label) {
      const control = node('button', '', label);
      control.setAttribute('type', 'button');
      control.setAttribute('aria-label', accessibleLabel);
      if (label !== accessibleLabel) control.setAttribute('title', accessibleLabel);
      control.addEventListener('click', () => void fn());
      return control;
    }
    function windowButton(icon, label, fn) {
      const control = button('', fn, label);
      const shape = node('span', 'askgpt-chat-window-icon ' + icon);
      shape.setAttribute('aria-hidden', 'true');
      control.append(shape);
      return control;
    }

    const panel = node('section', 'askgpt-paper-chat');
    panel.id = 'askgpt-paper-chat-' + clientID;
    panel.hidden = true;
    panel.setAttribute('aria-label', t('论文问答', 'Paper chat'));
    const header = node('header', 'askgpt-chat-header');
    const moveHandle = node('button', 'askgpt-chat-move', 'Ask GPT');
    moveHandle.setAttribute('type', 'button');
    const moveLabel = t('移动 Ask GPT，可用方向键', 'Move Ask GPT with the arrow keys');
    moveHandle.setAttribute('aria-label', moveLabel);
    moveHandle.setAttribute('title', moveLabel);
    const title = node('h2', '', 'Ask GPT');
    const update = button('↓', () => run('update'), t('更新 Ask for GPT', 'Update Ask for GPT'));
    update.hidden = true;
    const float = openInWindow && windowButton('detach', t('在单独窗口打开 Ask GPT', 'Open Ask GPT in window'),
      () => openInWindow(stagedInputs || readInputs()));
    const find = windowButton('search', t('搜索对话（⌘F）', 'Search conversation (⌘F)'), () => setSearch(findBar.hidden));
    const fit = windowButton('fit', t('适配阅读区', 'Fit reading area'), () => geometry.toggleFit());
    const fold = windowButton('minimize', t('最小化论文问答', 'Minimize paper chat'), toggleMinimized);
    const close = windowButton('close', t('关闭论文问答', 'Close paper chat'), collapse);
    const windowControls = node('div', 'askgpt-chat-traffic');
    close.className = 'askgpt-chat-traffic-close';
    fold.className = 'askgpt-chat-traffic-fold';
    fit.className = 'askgpt-chat-traffic-fit';
    windowControls.append(close, fold, fit);
    for (const control of [update, float, find]) if (control) control.className = 'askgpt-chat-window-action';
    header.append(windowControls, moveHandle, update, find);
    if (float) header.append(float);
    const paper = node('div', 'askgpt-chat-paper');
    const tools = node('div', 'askgpt-chat-tools');
    const scope = node('div', 'askgpt-chat-scope');
    const nearby = button('Nearby', () => setScope('nearby'));
    const whole = button('Whole paper', () => setScope('whole'));
    const summarize = button('Summarize', () => submit(true));
    summarize.className = 'askgpt-chat-summarize';
    scope.append(nearby, whole);
    tools.append(scope, summarize);
    paper.append(title, tools);
    const findLabel = t('搜索这篇论文的对话', 'Search this paper’s conversation');
    const findBar = node('div', 'askgpt-chat-find');
    findBar.id = panel.id + '-find';
    findBar.hidden = true;
    findBar.setAttribute('role', 'search');
    findBar.setAttribute('aria-label', findLabel);
    find.setAttribute('aria-controls', findBar.id);
    find.setAttribute('aria-expanded', 'false');
    const search = node('input');
    search.setAttribute('type', 'search');
    search.setAttribute('aria-label', findLabel);
    search.setAttribute('placeholder', t('搜索对话', 'Find in conversation'));
    const searchCount = node('span', 'askgpt-chat-find-count');
    searchCount.setAttribute('role', 'status');
    const previousMatch = button('↑', () => stepSearch(-1), t('上一条匹配', 'Previous match'));
    const nextMatch = button('↓', () => stepSearch(1), t('下一条匹配', 'Next match'));
    const closeFind = button('×', () => setSearch(false), t('关闭搜索', 'Close search'));
    findBar.append(search, searchCount, previousMatch, nextMatch, closeFind);
    const transcript = node('div', 'askgpt-chat-messages');
    transcript.setAttribute('role', 'log');
    transcript.setAttribute('aria-label', t('这篇论文的对话', 'Conversation for this paper'));
    const status = node('div', 'askgpt-chat-status');
    status.hidden = true;
    status.setAttribute('role', 'status');
    const notice = node('span');
    const retry = button(t('重连', 'Reconnect'), () => run('open', {}, stagedInputs || readInputs()));
    retry.hidden = true;
    status.append(notice, retry);
    const composer = node('form', 'askgpt-chat-composer');
    const input = node('textarea');
    input.setAttribute('aria-label', t('关于这篇论文的问题', 'Question about this paper'));
    input.setAttribute('placeholder', commands
      ? t('提问或输入标注指令…', 'Ask or give an annotation command…')
      : t('提问…', 'Ask about this paper…'));
    input.setAttribute('rows', '2');
    input.setAttribute('maxlength', '12000');
    const footer = node('div', 'askgpt-chat-footer');
    const model = node('span', 'askgpt-chat-model');
    const stop = button(t('停止', 'Stop'), () => {
      cancelFollowUp();
      return run('stop');
    });
    const submitButton = node('button', 'askgpt-chat-send', t('发送', 'Send'));
    submitButton.setAttribute('type', 'submit');
    footer.append(model, stop, submitButton);
    composer.append(input, footer);
    composer.addEventListener('submit', event => { event.preventDefault(); void submit(false); });
    input.addEventListener('input', controls);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        void submit(false);
      }
    });
    search.addEventListener('input', () => refreshSearch(true));
    search.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      stepSearch(event.shiftKey ? -1 : 1);
    });
    panel.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (!minimized && event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey && event.key?.toLowerCase() === 'f') {
        event.preventDefault();
        event.stopPropagation?.();
        setSearch(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation?.();
        if (!minimized && !findBar.hidden) setSearch(false);
        else collapse();
      }
    });
    function grip(name, label) {
      const control = node('button', name);
      control.setAttribute('type', 'button');
      control.setAttribute('aria-label', label);
      control.setAttribute('title', label);
      return control;
    }
    const resize = grip('askgpt-chat-resize', t('缩放问答栏，可用方向键', 'Resize the chat with the arrow keys'));
    const resizeHorizontal = grip('askgpt-chat-resize-horizontal', t('调整问答栏宽度', 'Resize chat width'));
    const resizeVertical = grip('askgpt-chat-resize-vertical', t('调整问答栏高度', 'Resize chat height'));
    panel.append(header, paper, findBar, transcript, status, composer, resize, resizeHorizontal, resizeVertical);
    const style = node('style', '', CSS);
    doc.head?.appendChild(style);
    doc.body.append(panel);
    const geometry = installGeometry({doc, panel, header, moveHandle, resize, resizeHorizontal, resizeVertical,
      t, loadLayout, saveLayout, fitChanged: fitted => updateWindowButton(fit, fitted ? 'restore' : 'fit',
        fitted ? t('还原窗口大小', 'Restore window size') : t('适配阅读区', 'Fit reading area')),
      available: () => active && !panel.hidden && !minimized && current()});

    function updateWindowButton(control, icon, label) {
      control.children[0].className = 'askgpt-chat-window-icon ' + icon;
      control.setAttribute('aria-label', label);
      control.setAttribute('title', label);
    }
    function setSearch(open) {
      findBar.hidden = !open;
      find.setAttribute('aria-expanded', String(open));
      refreshSearch(open);
      (open ? search : find).focus?.({preventScroll: true});
    }
    function revealMatch(row) {
      const box = transcript.getBoundingClientRect?.(), target = row?.getBoundingClientRect?.();
      if (!box || !target) return;
      if (target.top < box.top || target.bottom > box.bottom) transcript.scrollTop += target.top - box.top - 4;
    }
    function markMatch(index, reveal) {
      const previous = searchMatches[searchCursor];
      previous?.removeAttribute('data-search-current');
      searchCursor = index;
      const currentMatch = searchMatches[index];
      currentMatch?.setAttribute('data-search-current', 'true');
      previousMatch.disabled = nextMatch.disabled = searchMatches.length < 2;
      const count = searchMatches.length;
      const label = index >= 0 ? (index + 1) + ' / ' + count : t('无匹配', 'No matches');
      searchCount.textContent = search.value?.trim() && !findBar.hidden ? label : '';
      if (reveal) revealMatch(currentMatch);
    }
    function refreshSearch(reveal = false) {
      const previous = searchMatches[searchCursor];
      previous?.removeAttribute('data-search-current');
      const normalized = text => text.normalize('NFKC').toLowerCase();
      const query = findBar.hidden ? '' : normalized(search.value?.trim() || '');
      searchMatches = query ? Array.from(transcript.children).filter(row =>
        Array.from(row.children).some(child => child.className === 'askgpt-chat-text' &&
          normalized(child.textContent).includes(query))) : [];
      searchCursor = -1;
      const index = reveal ? -1 : searchMatches.indexOf(previous);
      markMatch(searchMatches.length ? Math.max(index, 0) : -1, reveal);
    }
    function stepSearch(step) {
      const count = searchMatches.length;
      if (count) markMatch((searchCursor + step + count) % count, true);
    }

    function controls() {
      const sending = state?.isSending === true;
      stop.hidden = !sending || needsOpen;
      stop.disabled = pending;
      nearby.disabled = whole.disabled = summarize.disabled = needsOpen || pending || sending || !!followUp;
      nearby.setAttribute('aria-pressed', String((state?.scope || 'nearby') === 'nearby'));
      whole.setAttribute('aria-pressed', String(state?.scope === 'whole'));
      const parsed = commands && parseCommand?.(input.value || '');
      const local = parsed && parsed.kind !== 'mixed' && !(state?.localActions === true && parsed.error === 'clarify');
      submitButton.disabled = !active || commandPending || !!followUp || !input.value?.trim()
        || !local && (needsOpen || pending || sending);
      retry.disabled = pending;
      const version = state?.updateVersion;
      update.hidden = typeof version !== 'string' || !VERSION.test(version);
      update.disabled = update.hidden || needsOpen || pending || state?.updating === true;
      if (!update.hidden) {
        const label = state.updating === true
          ? t('正在准备 Ask for GPT ' + version, 'Preparing Ask for GPT ' + version)
          : t('更新 Ask for GPT 到 ' + version, 'Update Ask for GPT to ' + version);
        update.textContent = state.updating === true ? '…' : '↓';
        update.setAttribute('aria-label', label);
        update.setAttribute('title', label);
      }
    }
    function message(text = '', reconnect = false) {
      if (notice.textContent !== text) notice.textContent = text;
      retry.hidden = !reconnect;
      status.hidden = !text && !reconnect;
    }
    function clearPoll() { if (timer !== null) clearTimer(timer); timer = null; }
    function schedule() {
      clearPoll();
      if (current() && active && !panel.hidden && (!minimized || followUp) && !pending && !polling && !needsOpen &&
          (state?.isSending || state?.updating)) {
        timer = setTimer(() => { timer = null; void poll(); }, 600);
      }
    }
    function citationList(item, container, entries, inline) {
      const groups = new Map();
      for (const entry of entries) {
        if (!groups.has(entry.page)) groups.set(entry.page, []);
        groups.get(entry.page).push(entry);
      }
      for (const [page, sources] of groups) {
        const pageLabel = t('第 ' + page + ' 页', 'PDF p. ' + page);
        const jump = (source, label) => button(label, () => run('jump', {messageID: item.id, marker: source.marker}),
          t('跳到原文，' + pageLabel + '，' + source.quote, 'Jump to the source passage, ' + pageLabel + ', ' + source.quote));
        if (inline) {
          const group = node('span', 'askgpt-inline-citation');
          if (sources.length === 1) group.append(jump(sources[0], pageLabel));
          else {
            group.append(pageLabel + ' ');
            sources.forEach((source, index) => group.append(jump(source, '[' + (index + 1) + ']')));
          }
          container.append(group);
          continue;
        }
        if (sources.length === 1) {
          container.append(jump(sources[0], pageLabel));
          continue;
        }
        const group = node('details');
        group.append(node('summary', '', pageLabel));
        for (const source of sources) group.append(jump(source, source.quote || source.marker));
        container.append(group);
      }
    }
    function renderAnswer(item, row, markedText, streaming) {
      const sources = new Map();
      for (const source of item.sources || []) {
        if (!sources.has(source.marker)) sources.set(source.marker, source);
      }
      const placed = new Set();
      renderAssistantText(row.body, markedText ?? item.text, streaming, markedText == null ? undefined : (body, markers) => {
        const entries = [];
        for (const marker of new Set(markers)) {
          const source = sources.get(marker);
          if (!source) continue;
          placed.add(marker);
          entries.push(source);
        }
        citationList(item, body, entries, true);
      });
      row.sources.textContent = '';
      const unplaced = [...sources.values()].filter(source => !placed.has(source.marker));
      if (unplaced.length && item.completed) {
        row.sources.append(node('span', 'askgpt-chat-unplaced', t('未定位到具体句子的出处', 'Sources without an inline location')));
        citationList(item, row.sources, unplaced, false);
      }
    }
    function render(next, opening = false) {
      const expectedAttachment = attached || snapshot?.context.attachmentID;
      if (!validState(next) || expectedAttachment && next.attachmentID !== expectedAttachment) throw failure('response');
      if (opening) needsOpen = false;
      const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 42;
      state = next;
      attached = next.attachmentID;
      title.textContent = next.title || 'Ask GPT';
      title.setAttribute('title', next.title);
      model.textContent = next.model;
      model.setAttribute('title', next.model);
      const remaining = new Set(rows.keys());
      for (const item of next.messages) {
        let row = rows.get(item.id);
        if (!row) {
          const article = node('article', 'askgpt-chat-message ' + item.role);
          const body = node('div', 'askgpt-chat-text'), sources = node('div', 'askgpt-chat-sources');
          const label = item.role === 'user' ? t('你', 'You') : t('助手', 'Assistant');
          const role = node('span', 'askgpt-chat-role', label);
          role.setAttribute('aria-hidden', 'true');
          article.setAttribute('aria-label', label);
          article.append(role, body, sources);
          transcript.append(article);
          row = {article, body, sources, text: null, key: ''};
          rows.set(item.id, row);
        }
        const streaming = next.isSending && !item.completed;
        const markedText = item.role === 'assistant' && item.completed && typeof item.markedText === 'string'
          ? item.markedText : null;
        const key = JSON.stringify(item.sources || []);
        if (row.text !== item.text || row.markedText !== markedText || row.streaming !== streaming ||
            row.completed !== item.completed || row.key !== key) {
          row.text = item.text;
          row.markedText = markedText;
          row.streaming = streaming;
          row.completed = item.completed;
          row.key = key;
          if (item.role === 'assistant') renderAnswer(item, row, markedText, streaming);
          else row.body.textContent = item.text;
        }
        remaining.delete(item.id);
      }
      for (const id of remaining) { rows.get(id).article.remove(); rows.delete(id); }
      if (!findBar.hidden) refreshSearch();
      if (atBottom && active && !panel.hidden && searchCursor < 0) transcript.scrollTop = transcript.scrollHeight;
      const failed = typeof next.error === 'string' && next.error.trim();
      message(next.precision === 'page' ? t('已跳到原文页，未能精确定位段落。', 'Opened the source page. The exact passage could not be located.')
        : failed ? t('回答遇到问题，可以重试。', 'The answer failed. You can retry.')
        : next.isSending ? t('回答中…', 'Answering…') : '');
      controls();
      finishFollowUp();
    }
    function report(error, action) {
      if (action !== 'jump') cancelFollowUp();
      if (error?.code === 'stopped') { controls(); return; }
      const reconnect = needsOpen || error?.code === 'connection' || error?.code === 'reopen';
      if (reconnect) needsOpen = true;
      if (error?.code === 'update_app') {
        message(t('请更新 Ask for GPT，再打开论文问答。', 'Update Ask for GPT, then open paper chat again.'), reconnect);
      } else if (action === 'jump') {
        message(t('暂时无法跳到这段原文，请重试。', 'Could not jump to this passage. Try again.'), reconnect);
      } else {
        message(t('论文问答暂时不可用，请重试。', 'Paper chat is temporarily unavailable. Try again.'), reconnect);
      }
      controls();
    }
    async function poll(refresh = false) {
      if (!current() || !active || panel.hidden || minimized && !followUp || pending || polling || needsOpen ||
          !refresh && !state?.isSending && !state?.updating) return;
      polling = true;
      const previous = revision;
      try {
        const next = await send('state');
        if (current() && !pending && previous === revision) render(next);
      } catch (error) {
        if (current() && !pending && previous === revision) report(error, 'state');
      } finally {
        polling = false;
        schedule();
      }
    }
    async function run(action, fields = {}, inputs, connection) {
      if (!current() || !active || pending || needsOpen && action !== 'open') return false;
      clearPoll();
      revision++;
      pending = true;
      controls();
      try {
        if (inputs) {
          if (!snapshot || !sameInputs(inputs, snapshot.inputs)) {
            message(t('读取论文中…', 'Reading paper…'));
            const context = await extract(inputs, current);
            if (!current()) return false;
            if (attached && context.attachmentID !== attached) throw failure('stopped');
            snapshot = {inputs, context};
          }
          fields = {...fields, context: snapshot.context};
        }
        const next = await send(action, fields, connection);
        if (!current()) return false;
        render(next, action === 'open');
        return next;
      } catch (error) {
        if (current()) report(error, action);
        return false;
      } finally {
        pending = false;
        if (current()) { controls(); schedule(); }
      }
    }
    function sameInputs(a, b) {
      return a.page === b.page && a.selection?.text === b.selection?.text &&
        a.selection?.translated === b.selection?.translated && a.selection?.pageIndex === b.selection?.pageIndex;
    }
    function setScope(scope) {
      if (state && !state.isSending && state.scope !== scope) void run('scope', {scope});
    }
    function appendCommand(question, feedback, result) {
      const reply = node('article', 'askgpt-chat-message assistant');
      reply.setAttribute('aria-label', t('Zotero 操作', 'Zotero action'));
      reply.append(node('div', 'askgpt-chat-text', feedback));
      const links = node('div', 'askgpt-chat-sources');
      if (typeof commands.reveal === 'function') {
        for (const location of (result?.topicScan ? result.locations.slice(0, 8) : result?.locations) || []) {
          links.append(button(t('第 ' + location.page + ' 页', 'PDF p. ' + location.page),
            async () => {
              try { await commands.reveal(location); }
              catch (_) { if (current()) message(t('切回原 PDF 后再试。', 'Return to the original PDF and try again.')); }
            }, t('查看标注原文 ' + location.quote, 'Open annotated passage ' + location.quote)));
        }
      }
      if (typeof commands.openNote === 'function') {
        for (const key of result?.noteKeys || []) {
          links.append(button(t('打开笔记', 'Open note'), async () => {
            try { await commands.openNote(key); }
            catch (_) { if (current()) message(t('请在论文条目下查看笔记。', 'Find the note under this paper.')); }
          }));
        }
      }
      if (links.children.length) reply.append(links);
      const batch = [];
      if (question) {
        const user = node('article', 'askgpt-chat-message user');
        user.setAttribute('aria-label', t('你', 'You'));
        user.append(node('div', 'askgpt-chat-text', question));
        batch.push(user);
      }
      batch.push(reply);
      transcript.append(...batch);
      commandRows.push(batch);
      while (commandRows.length > 30) commandRows.shift().forEach(row => row.remove());
      if (!findBar.hidden) refreshSearch();
      if (searchCursor < 0) transcript.scrollTop = transcript.scrollHeight;
    }
    function commandFeedback(code, candidates, points, count) {
      if (code === 'choose-highlight-count')
        return t('无法确定你指的是哪 ' + count + ' 句。请指定原句或引用编号。',
          'Could not identify the ' + count + ' sentences. Specify the passages or citation numbers.');
      if (code === 'choose-evidence' && points?.length) {
        const listed = points.map(number => t('第 ' + number + ' 点', 'point ' + number)).join(t('、', ', '));
        return t('请指定' + listed + '，或给出引用编号。', 'Specify ' + listed + ', or give a citation number.');
      }
      if (code === 'ambiguous') {
        const options = candidates?.filter?.(candidate => Number.isInteger(candidate.citation))
          .map(candidate => t('引用 ' + candidate.citation, 'citation ' + candidate.citation)).join(t('、', ', '));
        return options
          ? t('找到多条原文，请指定' + options + '。', 'More than one source matches. Specify ' + options + '.')
          : t('找到多个位置，请给出更完整的原句或直接在原文划选。', 'More than one passage matches. Quote more text or select it in the PDF.');
      }
      const labels = {
        clarify: t('请指定原句、引用编号或要写入的文字。', 'Specify the original passage, citation number, or text to save.'),
        'no-highlight-target': t('请先在 PDF 划选原文，或指定要标哪一句。', 'Select text in the PDF or specify which sentence to highlight.'),
        'paper-title-missing': t('未能在原文中唯一定位论文标题。请给出标题原文或划选标题。',
          'Could not uniquely locate the paper title in the PDF. Quote or select the title.'),
        'paper-abstract-missing': t('没在 PDF 中唯一定位到完整摘要。可以划选摘要后再发指令。',
          'Could not uniquely locate the complete abstract in the PDF. Select it and send the command again.'),
        'paper-text-unread': t('有 PDF 页面暂未读到，请重试。',
          'Some PDF pages could not be read. Please retry.'),
        'no-recent-highlight': t('这次打开论文后还没有可撤回的 Ask GPT 高亮。',
          'There is no Ask GPT highlight to undo from this reader session.'),
        'choose-highlight-undo': t('上次保存了多条高亮。请在 Zotero 标注栏指定要撤回的那一条。',
          'The last highlight action saved several passages. Identify the one to remove in Zotero’s annotations pane.'),
        'choose-heading': t('请指定小节标题，例如 高亮「Methods」，或发送「高亮论文标题」。',
          'Specify a section heading, for example “Highlight \"Methods\"”, or ask to highlight the paper title.'),
        'no-evidence': t('当前回答没有可标注的原文引用。请给出原句，或先问这条结论的证据。', 'This answer has no source passages to highlight. Quote the passage or ask for its evidence first.'),
        'choose-evidence': t('当前回答有多条出处，请指定结论编号或引用编号。', 'This answer cites several passages. Specify a point or citation number.'),
        'point-not-cited': t('这条回答没有记录该结论对应的出处，请指定已有引用。', 'No source was recorded for that point. Specify an existing citation.'),
        'too-many-evidence': t('这批出处较多，请指定一条结论或少量引用。', 'Select one point or a few citations for this batch.'),
        'too-many-topic': t('命中句子过多，请缩小主题后再批量标注。', 'This topic matches too many passages. Narrow the topic and retry.'),
        'other-paper': t('请打开目标论文，再发送标注指令。', 'Open the target paper before sending an annotation command.'),
        'missing-note': t('这篇论文下没有找到目标笔记。可以给出笔记的完整标题。', 'The target note was not found under this paper. Enter its full title.'),
        'ambiguous-note': t('这篇论文下有同名笔记，请先区分标题。', 'More than one note under this paper has that title. Give each note a distinct title first.'),
        'model-action-invalid': t('没有确认要写入的内容或位置。可以再说明要改哪一处。', 'The requested change could not be verified. Specify its content or location.'),
        missing: t('缺少可用的原句、回答或可撤销操作。请指定原句或补充文案。', 'No passage, answer, or recent action was found. Specify the passage or note text.'),
        readonly: t('当前论文为只读，无法保存。', 'This paper is read-only.'),
        stale: t('阅读器已切换，请在目标论文里重试。', 'The reader changed. Try again in the target paper.'),
      };
      return labels[code] || t('Zotero 没能保存，请重试。', 'Zotero could not save the change. Try again.');
    }
    async function submitCommand(question, command, pinned) {
      if (!current() || !active || commandPending) return;
      if (command.kind === 'capabilities') {
        appendCommand(question, t(
          '可以直接在 Zotero 保存高亮、下划线、PDF 批注和论文笔记。试试「给摘要加个批注：核对样本量」或「把这条回答存成笔记」。',
          'This panel saves highlights, underlines, PDF comments, and notes in Zotero. Try “Save this answer as a Zotero note.”'));
        if (!pinned) input.value = '';
        controls();
        return;
      }
      if (command.error) {
        appendCommand(question, commandFeedback(command.error));
        return;
      }
      if (command.operations?.some(operation => operation.type === 'paperHeadings')) {
        appendCommand(question, commandFeedback('choose-heading'));
        if (!pinned) input.value = '';
        controls();
        return;
      }
      const live = readInputs(), inputs = pinned?.inputs || (live.selection?.text ? live : (stagedInputs || live));
      const selection = inputs.selection;
      const contextual = command.kind === 'contextHighlight' || command.kind === 'answerHighlight';
      const answer = pinned?.answer || recentAnswer(state?.messages || [], contextual, parseCommand);
      const saved = input.value;
      commandPending = true;
      let scanStatus = '';
      const scanProgress = (done, total) => {
        if (!current() || !active) return;
        scanStatus = t('搜索原文 ' + done + '/' + total + ' 页…', 'Searching ' + done + '/' + total + ' PDF pages…');
        message(scanStatus);
      };
      controls();
      try {
        const operations = highlightCommand(command, answer, selection).map(operation => {
          if (!operation.commentFromAnswer) return operation;
          if (!pinned?.answer?.text) throw failure('missing');
          const {commentFromAnswer, ...write} = operation;
          const body = node('div');
          renderAssistantText(body, pinned.answer.text.replace(/\[\[p\d{1,4}\.\d{1,4}\]\]/g, ''), false);
          return {...write, comment: body.textContent.trim()};
        });
        const scan = operations.some(operation => ['topic', 'answerQuotes', 'paperTitle', 'paperAbstract'].includes(operation.type));
        const result = await commands.execute(operations, {
          citations: (answer?.sources || []).map(source => ({...source, attachmentID: state?.attachmentID})),
          selectedText: selection?.translated ? '' : (selection?.text || ''),
          noteSelection: selection?.text || '',
          selectedPosition: selection?.translated ? undefined : selection?.position,
          page: Number.isInteger(selection?.pageIndex) ? selection.pageIndex + 1
            : Number.isInteger(inputs.page) ? inputs.page + 1 : null,
          answer: answer?.text || '',
          pages: snapshot?.context.pages || [],
          onProgress: scan ? scanProgress : undefined,
        });
        if (!current()) return;
        const messages = [];
        if (result.topicScan) {
          const {matched, pagesScanned, pageCount, unresolvedMatches} = result.topicScan;
          messages.push(t('已读取 ' + pagesScanned + '/' + pageCount + ' 页，按主题词找到 ' + matched + ' 条原文',
            'Read ' + pagesScanned + '/' + pageCount + ' pages and located ' + matched + ' passage(s) by topic terms'));
          if (unresolvedMatches) messages.push(t('另有 ' + unresolvedMatches + ' 处匹配未标注',
            'Left ' + unresolvedMatches + ' other match(es) unmarked'));
        }
        if (result.answerQuotesScan) {
          const {unresolvedMatches, pagesScanned, pageCount} = result.answerQuotesScan;
          if (pagesScanned < pageCount) messages.push(t('只读取到 ' + pagesScanned + '/' + pageCount + ' 页，请重试',
            'Read only ' + pagesScanned + '/' + pageCount + ' pages. Try again.'));
          if (unresolvedMatches) messages.push(t(unresolvedMatches + ' 条建议原句未能唯一定位',
            'Could not uniquely locate ' + unresolvedMatches + ' suggested passage(s)'));
        }
        if (result.highlights) messages.push(t('已保存 ' + result.highlights + ' 条标注', 'Saved ' + result.highlights + ' annotation(s)'));
        if (result.underlines) messages.push(t('已添加 ' + result.underlines + ' 条下划线', 'Added ' + result.underlines + ' underline(s)'));
        if (result.notes) messages.push(t('已保存 ' + result.notes + ' 条笔记', 'Saved ' + result.notes + ' note(s)'));
        if (result.comments) messages.push(t('已保存 ' + result.comments + ' 条批注', 'Saved ' + result.comments + ' PDF comment(s)'));
        if (result.updatedNotes) messages.push(t('已更新 ' + result.updatedNotes + ' 条笔记', 'Updated ' + result.updatedNotes + ' note(s)'));
        if (result.updated) messages.push(t('已更新 ' + result.updated + ' 条标注', 'Updated ' + result.updated + ' annotation(s)'));
        if (result.undone) messages.push(t('已撤销 ' + result.undone + ' 项操作', 'Undid ' + result.undone + ' change(s)'));
        if (result.skipped) messages.push(t('跳过 ' + result.skipped + ' 项', 'Skipped ' + result.skipped + ' item(s)'));
        appendCommand(question, messages.join(t('，', '. ')) || t('没有需要保存的改动', 'No changes to save'), result);
        if (!pinned && input.value === saved) input.value = '';
      } catch (error) {
        if (current()) appendCommand(question, commandFeedback(error?.code, error?.candidates, error?.points, error?.count));
      } finally {
        commandPending = false;
        if (current()) {
          if (scanStatus && notice.textContent === scanStatus) message();
          controls();
        }
      }
    }
    function cancelFollowUp() {
      if (!followUp) return;
      const semantic = followUp.semantic;
      followUp = null;
      if (!semantic) appendCommand(null, t('已取消本轮的 Zotero 操作。', 'Canceled the Zotero action for this turn.'));
    }
    function finishFollowUp() {
      if (!followUp?.answerID || !state || state.isSending || !current() || !active || panel.hidden) return;
      const plan = followUp;
      const [question, answer] = state.messages.slice(-2);
      if (state.error || state.attachmentID !== plan.attachmentID || state.scope !== plan.scope ||
          question?.id !== plan.questionID || answer?.id !== plan.answerID || !answer?.completed || !answer.text.trim()) {
        cancelFollowUp();
        controls();
        return;
      }
      followUp = null;
      let command = plan.command;
      if (plan.semantic) {
        const packet = state.actionPlan;
        command = packet?.questionID === question.id && packet?.answerID === answer.id
          ? resolveModelActions(packet.body, question.text) : null;
        if (!command) {
          if (packet) appendCommand(null, commandFeedback('model-action-invalid'));
          controls();
          return;
        }
      }
      void submitCommand(null, command, {answer, inputs: plan.inputs});
    }
    async function submit(summary) {
      const question = input.value?.trim();
      const command = !summary && question && commands && parseCommand?.(question);
      if (followUp) return;
      const semantic = !summary && !!commands && state?.localActions === true && (!command || command.error === 'clarify');
      if (command && command.kind !== 'mixed' && !semantic) return submitCommand(question, command);
      if (needsOpen || pending || commandPending || state?.isSending || !summary && !question) return;
      const live = readInputs();
      const inputs = live.selection?.text ? live : (stagedInputs || live);
      const saved = input.value;
      let plan, modelQuestion = question;
      if (command?.kind === 'mixed' || semantic) {
        plan = followUp = {command: command?.command, semantic, inputs, attachmentID: state.attachmentID,
          scope: state.scope, previousIDs: new Set(state.messages.map(item => item.id))};
      }
      if (command?.kind === 'mixed') {
        modelQuestion = command.question;
        if (command.command.kind === 'answerHighlight')
          modelQuestion += t('\n\n请用引用块列出支持回答的完整 PDF 原句。', '\n\nQuote the complete original PDF sentences that support the answer.');
      }
      const delivered = await run(summary ? 'summarize' : 'send',
        summary ? {} : {question: modelQuestion, ...semantic && {resolveActions: true}}, inputs);
      if (delivered) {
        stagedInputs = null;
        if (!summary && input.value === saved) input.value = '';
      }
      if (plan && followUp === plan) {
        const [sent, answer] = delivered?.messages.slice(-2) || [];
        if (!delivered || !active || panel.hidden || sent?.role !== 'user' || sent.text !== modelQuestion ||
            answer?.role !== 'assistant' || sent.id === answer.id ||
            plan.previousIDs.has(sent.id) || plan.previousIDs.has(answer.id)) cancelFollowUp();
        else {
          plan.questionID = sent.id;
          plan.answerID = answer.id;
          finishFollowUp();
        }
      }
      controls();
    }
    function collapse() {
      cancelFollowUp();
      const heldFocus = doc.activeElement && panel.contains?.(doc.activeElement);
      panel.hidden = true;
      geometry.cancel();
      clearPoll();
      if (heldFocus) {
        if (returnFocus?.isConnected) returnFocus.focus?.({preventScroll: true});
        else doc.defaultView?.focus?.();
      }
      returnFocus = null;
    }
    function setMinimized(value) {
      minimized = value;
      panel.setAttribute('data-minimized', String(value));
      fit.disabled = value;
      updateWindowButton(fold, value ? 'expand' : 'minimize',
        value ? t('还原论文问答', 'Restore paper chat') : t('最小化论文问答', 'Minimize paper chat'));
    }
    function toggleMinimized() {
      if (minimized) { show(); return; }
      geometry.cancel();
      setMinimized(true);
      schedule();
      fold.focus?.({preventScroll: true});
      controls();
    }
    function show(inputs, connection, focus = true) {
      if (!current() || !active) return false;
      if (panel.hidden && doc.activeElement !== doc.body) returnFocus = doc.activeElement;
      panel.hidden = false;
      if (minimized) setMinimized(false);
      geometry.fit();
      if (inputs?.selection?.text) stagedInputs = inputs;
      if (focus) input.focus?.({preventScroll: true});
      if (needsOpen && !pending) void run('open', {}, inputs || readInputs(), connection);
      else void poll(true);
      return true;
    }
    message();
    controls();
    return {
      panel, show, get opened() { return !panel.hidden && !minimized; },
      setActive(value) {
        const changed = active !== !!value;
        active = !!value;
        if (!active) { cancelFollowUp(); geometry.cancel(); clearPoll(); }
        else if (changed) { geometry.fit(); void poll(true); }
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        followUp = null;
        geometry.dispose();
        clearPoll();
        for (const cancel of cancellers) { try { cancel(); } catch (_) {} }
        cancellers.clear();
        panel.remove(); style.remove();
      }
    };
  }
  const api = {createTransport, mount};
  root.AskGPTPaperChatPanel = api;
  if (typeof module !== 'undefined') module.exports = api;
})(this);
