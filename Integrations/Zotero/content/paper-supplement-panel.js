(function(root) {
  'use strict';
  const XHTML = 'http://www.w3.org/1999/xhtml';
  let sequence = 0;
  const HTML_STAGES = {
    starting: 'Preparing HTML…', fetching: 'Reading original PDF…', queued: 'Waiting to start…',
    extracting: 'Extracting PDF…', writing: 'Writing HTML draft…', reviewing: 'Reviewing HTML draft…',
    repairing: 'Repairing HTML draft…', rendering: 'Rendering HTML…', checking: 'Checking HTML…',
    saving: 'Saving to Zotero…', opening: 'Opening HTML…', reconnecting: 'Reconnecting…'
  };
  const CSS = `
.askgpt-supplement-button{font:inherit;white-space:nowrap;min-width:28px}
.askgpt-paper-html-progress {
  display:inline-flex; align-items:center; gap:4px; max-inline-size:min(190px,36vw); min-inline-size:0;
  margin-inline:3px; color:var(--fill-secondary,CanvasText); font:11px -apple-system,sans-serif; white-space:nowrap;
}
.askgpt-paper-html-progress[hidden],.askgpt-paper-html-progress [hidden]{display:none!important}
.askgpt-paper-html-progress .askgpt-paper-html-stage{min-inline-size:0;overflow:hidden;text-overflow:ellipsis}
.askgpt-paper-html-progress progress {
  display:block; flex:none; inline-size:44px; max-inline-size:28%; block-size:3px;
  accent-color:var(--accent-blue,#007aff);
}
.askgpt-paper-html-progress time{flex:none;font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion:reduce) {
  .askgpt-paper-html-progress progress {
    appearance:none; background:repeating-linear-gradient(135deg,currentColor 0 2px,transparent 2px 4px);
  }
  .askgpt-paper-html-progress progress::-moz-progress-bar{background:none;animation:none}
}
.askgpt-paper-action[aria-haspopup="menu"]::after {
  content:""; display:inline-block; width:5px; height:5px; margin-inline-start:7px;
  border-inline-end:1.4px solid currentColor; border-block-end:1.4px solid currentColor;
  transform:translateY(-2px) rotate(45deg);
}
.askgpt-supplement-menu {
  position:fixed; z-index:92; box-sizing:border-box;
  min-width:min(168px,calc(100vw - 16px)); max-width:min(280px,calc(100vw - 16px));
  max-height:calc(100vh - 16px); overflow:auto; overscroll-behavior:contain;
  padding:6px; border:1px solid var(--fill-quaternary,#8886); border-radius:19px;
  background:var(--material-background,Canvas); color:var(--fill-primary,CanvasText);
  box-shadow:0 8px 28px #0003,inset 0 1px 1px #fff7,inset 0 -1px 0 #fff2; font:13px/1.35 -apple-system,sans-serif;
}
@supports (background:color-mix(in srgb,Canvas 82%,transparent)) and ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))) {
  .askgpt-supplement-menu {
    background:linear-gradient(145deg,#fff2,transparent 48%),color-mix(in srgb,var(--material-background,Canvas) 82%,transparent);
    -webkit-backdrop-filter:blur(16px) saturate(155%); backdrop-filter:blur(16px) saturate(155%);
  }
}
.askgpt-supplement-menu[hidden],.askgpt-supplement-menu [hidden]{display:none!important}
.askgpt-supplement-menu button {
  display:block; width:100%; min-height:30px; padding:6px 10px;
  border:0; border-radius:12px; background:transparent; color:inherit;
  font:inherit; cursor:default; text-align:start; overflow-wrap:anywhere;
}
.askgpt-supplement-menu button[aria-disabled=false]:is(:hover,:active),
.askgpt-supplement-menu button:not([aria-disabled]):is(:hover,:active),
.askgpt-supplement-menu button:focus-visible { background:var(--fill-quinary,#8882) }
.askgpt-supplement-menu button:focus-visible { outline:2px solid var(--accent-blue,#007aff); outline-offset:-2px }
.askgpt-supplement-menu button[aria-disabled=true]{cursor:progress}
.askgpt-supplement-menu-status {
  margin:3px 4px 0; padding:5px 6px 4px; border-top:1px solid var(--fill-quaternary,#8886);
  font-size:12px; overflow-wrap:anywhere;
}
@media (prefers-reduced-transparency:reduce), (prefers-contrast:more), (forced-colors:active) {
  .askgpt-supplement-menu { background:Canvas; -webkit-backdrop-filter:none; backdrop-filter:none; box-shadow:none }
}
@media (prefers-contrast:more), (forced-colors:active) {
  .askgpt-supplement-menu { color:CanvasText; border-color:CanvasText }
  .askgpt-supplement-menu button:focus-visible { outline-color:Highlight }
  .askgpt-supplement-menu-status { color:CanvasText; border-color:CanvasText }
}
.askgpt-supplement-drawer{position:fixed;z-index:89;right:8px;box-sizing:border-box;width:min(600px,calc(100vw - 16px));display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--fill-quaternary,#8886);border-radius:8px;background:var(--material-background,Canvas);color:var(--fill-primary,CanvasText);box-shadow:0 4px 18px #0003;font:13px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;color-scheme:light dark}
.askgpt-supplement-drawer[data-preview=true]{bottom:8px}
.askgpt-supplement-drawer[hidden],.askgpt-supplement-drawer [hidden]{display:none!important}
.askgpt-supplement-drawer button{font:inherit;color:inherit;border:1px solid var(--fill-quaternary,#8885);border-radius:5px;background:var(--material-toolbar,Canvas);min-height:28px;padding:3px 9px;cursor:default}
.askgpt-supplement-drawer button:disabled{opacity:.45}.askgpt-supplement-drawer button:focus-visible,.askgpt-supplement-drawer input:focus-visible{outline:2px solid var(--accent-blue,#007aff);outline-offset:2px}
.askgpt-supplement-header{display:flex;align-items:center;gap:8px;padding:9px 10px;border-bottom:1px solid var(--fill-quinary,#8883)}
.askgpt-supplement-heading{flex:1;min-width:0;margin:0;font-size:14px;font-weight:600;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.askgpt-supplement-close{font-size:18px!important;padding:0!important;width:28px;border:0!important;background:transparent!important}
.askgpt-supplement-actions{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px}.askgpt-supplement-list{overflow:auto;max-height:160px;padding:0 10px 8px;overscroll-behavior:contain}
.askgpt-supplement-list button{display:block;width:100%;text-align:left;margin-top:4px;overflow-wrap:anywhere}.askgpt-supplement-list button[aria-pressed=true]{border-color:var(--accent-blue,#007aff);background:var(--fill-quinary,#8882)}
.askgpt-supplement-candidates{overflow:auto;max-height:210px;margin:0 10px 8px;padding:8px;border:1px solid var(--fill-quaternary,#8884);border-radius:5px;overscroll-behavior:contain}
.askgpt-supplement-candidates h3{font:inherit;font-weight:600;margin:0 0 6px}.askgpt-supplement-candidates label{display:flex;gap:7px;align-items:flex-start;padding:4px 0;overflow-wrap:anywhere}.askgpt-supplement-candidates input{flex:none;margin-top:3px}.askgpt-supplement-candidates button{margin-top:7px}
.askgpt-supplement-status{padding:0 10px 8px;overflow-wrap:anywhere}.askgpt-supplement-status:empty{display:none}.askgpt-supplement-status button{margin-left:7px}
.askgpt-supplement-preview{flex:1;min-height:120px;overflow:auto;overscroll-behavior:contain;padding:10px;background:var(--fill-quinary,#8881);border-top:1px solid var(--fill-quinary,#8883)}
.askgpt-supplement-preview canvas{display:block;margin:0 auto;max-width:100%;height:auto;background:white}.askgpt-supplement-preview img{display:block;max-width:100%;height:auto;margin:0 auto}.askgpt-supplement-preview:empty{display:none}
.askgpt-supplement-pages{display:flex;align-items:center;justify-content:center;gap:9px;padding:6px 10px;border-top:1px solid var(--fill-quinary,#8883)}
.askgpt-supplement-external{margin:8px 10px}.askgpt-supplement-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:pre-wrap}
@media(min-width:1100px){.askgpt-supplement-drawer{width:min(600px,47vw)}}
@media(prefers-contrast:more){.askgpt-supplement-drawer{border-color:CanvasText;box-shadow:none}.askgpt-supplement-drawer button:disabled{opacity:.65}}
`;
  function create(options = {}) {
    const {supplements, paperHTML} = options, contexts = new Map(), Cu = options.Components?.utils;
    let stopped = false;
    const owned = value => value && Cu?.waiveXrays ? Cu.waiveXrays(value) : value;
    const transfer = (value, target) => Cu?.cloneInto ? Cu.cloneInto(value, target, { wrapReflectors: true }) : value;
    function render({ reader, doc, append, trigger, primaryMenu = false, isCurrent = () => true }) {
      if (stopped || reader?.type !== 'pdf' || !doc?.body || (!trigger && typeof append !== 'function')) return null;
      const old = contexts.get(reader);
      if (old?.button.ownerDocument === doc && old.trigger === trigger) { if (!trigger) append(old.button); return old; }
      old?.dispose();
      const win = doc.defaultView || reader._iframeWindow, removers = [], rows = [], choiceRemovers = [], statusRemovers = [], previews = [];
      let disposed = false, generation = 0, previewGeneration = 0, busy = false, entries = [], candidates = [], selected = new Set(), currentItem = null;
      let objectURL = null, worker = null, loading = null, pdf = null, renderTask = null, pageNumber = 1, rendering = false, menuAnchor = null;
      let nativePopup = null, unsubscribeHTML = null, progressTimer = null, progressState = null;
      const element = (name, text) => { const node = doc.createElementNS(XHTML, name); if (text != null) node.textContent = text; return node; };
      const button = trigger || element('button', '补充材料'), drawer = element('section'), style = element('style'), heading = element('h2', '补充材料');
      const menu = element('div'), menuItem = element('button', 'Supplementary Materials');
      const htmlItem = trigger && paperHTML ? element('button') : null, htmlStatus = htmlItem && element('div');
      const menuItems = [menuItem, htmlItem].filter(Boolean);
      const progress = htmlItem && element('span'), bar = progress && element('progress');
      const progressLabel = progress && element('span'), elapsedLabel = progress && element('time');
      const timerWindow = reader._window || win;
      menu.className = 'askgpt-supplement-menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
      menu.setAttribute('lang', 'en'); menu.setAttribute('aria-label', 'Paper Actions');
      for (const item of menuItems) {
        item.setAttribute('role', 'menuitem'); item.setAttribute('type', 'button'); item.setAttribute('tabindex', '-1'); menu.appendChild(item);
      }
      if (htmlItem) {
        htmlItem.hidden = true; htmlStatus.hidden = true; htmlStatus.className = 'askgpt-supplement-menu-status';
        htmlStatus.setAttribute('role', 'status'); menu.appendChild(htmlStatus);
        progress.className = 'askgpt-paper-html-progress'; progress.hidden = true;
        progress.setAttribute('lang', 'en');
        bar.setAttribute('aria-label', 'Generating HTML version');
        progressLabel.className = 'askgpt-paper-html-stage'; progressLabel.setAttribute('role', 'status');
        progress.append(bar, progressLabel, elapsedLabel);
      }
      const header = element('header'), actions = element('div'), list = element('div'), choices = element('div'), status = element('div'), preview = element('div'), pages = element('div');
      const closeButton = element('button', '×'), findButton = element('button', '查找补充材料'), addButton = element('button', '添加本地文件');
      const previous = element('button', '上一页'), next = element('button', '下一页'), pageLabel = element('span'), external = element('button', '在外部应用打开');
      const id = 'askgpt-supplements-' + (++sequence);
      if (primaryMenu) {
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
      }
      if (!trigger) {
        button.className = 'toolbar-button askgpt-supplement-button'; button.setAttribute('data-askgpt-supplements-button', ''); button.setAttribute('aria-label', '打开或收起补充材料');
        button.setAttribute('title', '补充材料'); button.setAttribute('aria-controls', id); button.setAttribute('aria-expanded', 'false');
      }
      drawer.className = 'askgpt-supplement-drawer'; drawer.id = id; drawer.hidden = true; drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-modal', 'false'); drawer.setAttribute('aria-labelledby', id + '-heading');
      drawer.setAttribute('data-askgpt-inline-owned', ''); heading.id = id + '-heading'; heading.className = 'askgpt-supplement-heading';
      header.className = 'askgpt-supplement-header'; closeButton.className = 'askgpt-supplement-close'; closeButton.setAttribute('aria-label', '关闭补充材料'); closeButton.setAttribute('title', '关闭补充材料');
      actions.className = 'askgpt-supplement-actions'; list.className = 'askgpt-supplement-list'; list.setAttribute('aria-label', '本篇论文的补充文件');
      choices.className = 'askgpt-supplement-candidates'; choices.hidden = true;
      status.className = 'askgpt-supplement-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      preview.className = 'askgpt-supplement-preview'; preview.setAttribute('tabindex', '0'); preview.setAttribute('aria-label', '补充材料阅读区');
      pages.className = 'askgpt-supplement-pages'; pages.hidden = true; pageLabel.setAttribute('role', 'status');
      external.className = 'askgpt-supplement-external'; external.hidden = true;
      for (const node of [closeButton, findButton, addButton, previous, next, external]) node.setAttribute('type', 'button');
      if (!trigger) button.setAttribute('type', 'button');
      header.append(heading, closeButton); actions.append(findButton); if (typeof supplements?.chooseFiles === 'function') actions.append(addButton);
      pages.append(previous, pageLabel, next); drawer.append(header, actions, list, choices, status, pages, preview, external);
      style.textContent = CSS;
      const clear = bucket => { for (const remove of bucket.splice(0)) { try { remove(); } catch (_) {} } };
      const listen = (target, type, handler, bucket = removers) => {
        const callback = options.exportCallback ? options.exportCallback(handler, win) : Cu?.exportFunction ? Cu.exportFunction(handler, win) : handler;
        target.addEventListener(type, callback, false); bucket.push(() => target.removeEventListener(type, callback, false));
      };
      const current = token => !disposed && !drawer.hidden && token === generation;
      const safely = (target, method) => { try { const result = target?.[method]?.(); Promise.resolve(owned(result)).catch(() => {}); } catch (_) {} };
      function controls() {
        findButton.disabled = busy; addButton.disabled = busy; external.disabled = busy || currentItem === null;
        drawer.setAttribute('aria-busy', String(busy));
        for (const node of list.querySelectorAll('button')) node.disabled = busy;
        for (const node of choices.querySelectorAll('input')) node.disabled = busy;
        const download = choices.querySelector('button'); if (download) { download.disabled = busy || !selected.size; download.textContent = '下载所选（' + selected.size + '）'; }
        previous.disabled = busy || rendering || !pdf || pageNumber <= 1; next.disabled = busy || rendering || !pdf || pageNumber >= pdf.numPages;
      }
      function message(text, retry) {
        clear(statusRemovers); status.textContent = text;
        if (retry) { const node = element('button', '重试'); node.setAttribute('type', 'button'); listen(node, 'click', retry, statusRemovers); status.appendChild(node); }
      }
      function position() {
        const box = button.getBoundingClientRect?.();
        const height = win?.innerHeight || 768, top = Math.max(8, Math.min(height - 160, (box?.bottom || 35) + 7));
        drawer.style.setProperty('top', top + 'px'); drawer.style.setProperty('max-height', Math.max(120, height - top - 8) + 'px');
      }
      function clearPreview() {
        previewGeneration++; clear(previews); safely(renderTask, 'cancel'); renderTask = null;
        // Only documents/workers created for this drawer are retired.
        if (loading) safely(loading, 'destroy'); else if (pdf) safely(pdf, 'destroy');
        safely(worker, 'destroy'); loading = null; pdf = null; worker = null; rendering = false;
        if (objectURL) { try { win.URL.revokeObjectURL(objectURL); } catch (_) {} objectURL = null; }
        preview.textContent = ''; drawer.removeAttribute('data-preview'); pages.hidden = true; external.hidden = true;
      }
      function close(restoreFocus = true) {
        if (disposed) return;
        drawer.hidden = true; generation++; busy = false; clearPreview(); currentItem = null; if (!trigger) button.setAttribute('aria-expanded', 'false');
        if (restoreFocus) button.focus?.({ preventScroll: true });
      }
      function closeMenu(restoreFocus = false) {
        const popup = nativePopup; nativePopup = null;
        menu.hidden = true; menuAnchor = null;
        if (primaryMenu) button.setAttribute('aria-expanded', 'false');
        popup?.close();
        if (restoreFocus) button.focus?.({ preventScroll: true });
      }
      function positionMenu() {
        if (menu.hidden) return;
        const box = button.getBoundingClientRect?.(), bounds = menu.getBoundingClientRect();
        const x = menuAnchor?.x ?? box?.left ?? 8;
        const y = Math.max(menuAnchor?.y ?? 0, (box?.bottom ?? 35) + 4);
        menu.style.setProperty('left', Math.max(8, Math.min((win.innerWidth || 1024) - bounds.width - 8, x)) + 'px');
        menu.style.setProperty('top', Math.max(8, Math.min((win.innerHeight || 768) - bounds.height - 8, y)) + 'px');
      }
      function show() {
        if (disposed) return;
        closeMenu(); if (!drawer.hidden) { closeButton.focus?.({ preventScroll: true }); return; }
        generation++; heading.textContent = '补充材料'; drawer.hidden = false; if (!trigger) button.setAttribute('aria-expanded', 'true'); position(); closeButton.focus?.({ preventScroll: true }); void reload();
      }
      function clearProgressTimer() {
        if (progressTimer !== null) timerWindow.clearTimeout(progressTimer);
        progressTimer = null;
      }
      function showElapsed() {
        const {startedAt, elapsedSeconds = 0} = progressState;
        const fromStart = Number.isFinite(startedAt) ? Math.floor((Date.now() - startedAt) / 1000) : 0;
        const seconds = Math.max(elapsedSeconds, fromStart, 0);
        const minutes = Math.floor(seconds / 60);
        elapsedLabel.textContent = (minutes ? minutes + 'm ' : '') + (seconds % 60) + 's';
        elapsedLabel.setAttribute('datetime', 'PT' + seconds + 'S');
        if (progressTimer === null && Number.isFinite(startedAt)) progressTimer = timerWindow.setTimeout(() => {
          progressTimer = null;
          if (!disposed && progressState?.state === 'running') showElapsed();
        }, 1000);
      }
      function updateProgress(value, label, detail) {
        const running = value?.state === 'running', failed = value?.state === 'failed';
        if (!running || progressState?.state !== 'running') clearProgressTimer();
        progressState = value;
        const text = running ? label : failed ? (value.saved ? 'Could not open HTML' : 'HTML conversion failed')
          : value?.generated ? 'HTML saved to Zotero' : value?.opened ? 'HTML opened' : '';
        if (progressLabel.textContent !== text) progressLabel.textContent = text;
        progress.hidden = !text; bar.hidden = !running; elapsedLabel.hidden = !running;
        progress.setAttribute('title', detail || text);
        if (running) showElapsed();
      }
      function updateHTMLMenu(value = paperHTML?.view(reader)) {
        if (!htmlItem || disposed) return;
        const errors = {
          source: 'Open the original PDF under a Zotero item.',
          translated: 'Switch to the original PDF to generate HTML.',
          connection: 'Enable the Zotero connection in Ask for GPT.',
          update: 'Update Ask for GPT and retry.',
          readonly: 'Attachments in this library are read-only.',
          missing: 'The HTML attachment has not been downloaded.',
          pdf: 'Unable to read the original PDF. Reopen the paper to retry.',
          compatibility: 'The PDF reader is unavailable. Reopen the paper and retry.',
          response: 'The local conversion service returned an invalid response. Try again.',
          integrity: 'The HTML file did not pass verification.',
          limit: 'This PDF exceeds the conversion size limit.',
          busy: 'A conversion is already running. Retry shortly.',
          bridge: 'The local conversion service is unreachable. Try again.',
          html_runtime_missing: 'The local paper-reading workflow is unavailable.',
          html_workflow_incompatible: 'The installed PaperLens skill could not be loaded. Check its files and retry.',
          html_model_unavailable: 'Check the model connection in Ask for GPT.',
          html_extract_failed: 'Could not extract the original PDF. Try again.',
          html_review_failed: 'The HTML draft did not pass review. You can retry.',
          html_verify_failed: 'The HTML did not pass validation. You can retry.',
          html_timed_out: 'The conversion timed out before saving. You can retry.',
          job_conflict: 'A conversion is already running. Retry shortly.'
        };
        const running = value?.state === 'running';
        htmlItem.hidden = !value; htmlItem.setAttribute('aria-disabled', String(running));
        htmlItem.textContent = running ? HTML_STAGES[value.stage] || HTML_STAGES.starting
          : value?.state === 'saved' || value?.saved ? 'Open HTML in Browser'
          : value?.state === 'failed' ? 'Retry HTML Generation'
          : 'Generate HTML Version';
        htmlStatus.hidden = value?.state !== 'failed';
        htmlStatus.textContent = htmlStatus.hidden ? '' : errors[value.code] || 'Could not generate the HTML version. Try again.';
        updateProgress(value, htmlItem.textContent, htmlStatus.textContent);
        positionMenu();
      }
      function activateHTML() {
        if (!disposed && isCurrent()) void paperHTML.activate(reader, {isCurrent, onChange: unsubscribeHTML ? undefined : updateHTMLMenu});
      }
      function showMenu(event) {
        event.preventDefault(); event.stopImmediatePropagation();
        const wasOpen = nativePopup || !menu.hidden;
        closeMenu();
        if (disposed || !isCurrent() || (wasOpen && event.type === 'click')) return;
        menuAnchor = event.type === 'contextmenu' && event.clientX > 0 ? {x: event.clientX, y: event.clientY} : null;
        updateHTMLMenu();
        if (primaryMenu) button.setAttribute('aria-expanded', 'true');
        const items = [{label: menuItem.textContent, run: () => { if (!disposed && isCurrent()) show(); }}];
        if (htmlItem && !htmlItem.hidden) {
          items.push({label: htmlItem.textContent, disabled: htmlItem.getAttribute('aria-disabled') === 'true', run: activateHTML});
          if (!htmlStatus.hidden) items.push({label: htmlStatus.textContent, disabled: true});
        }
        nativePopup = root.AskGPTPaperNativeMenu?.open({chromeWindow: reader._window, anchor: button, items, onClose: () => {
          nativePopup = null; if (primaryMenu) button.setAttribute('aria-expanded', 'false');
        }});
        if (nativePopup) return;
        menu.hidden = false;
        positionMenu();
        menuItems[0].focus?.({ preventScroll: true });
      }
      async function operate(label, action, failure, retry) {
        if (busy || disposed || drawer.hidden) return;
        const token = generation; busy = true; message(label); controls();
        try { await action(token); } catch (_) { if (current(token)) message(failure, retry); }
        finally { if (current(token)) { busy = false; controls(); } }
      }
      function renderList() {
        clear(rows); list.textContent = '';
        if (!entries.length) list.textContent = '尚未添加补充材料';
        for (const entry of entries) {
          const node = element('button', entry.title || entry.fileName || '补充文件'); node.setAttribute('type', 'button');
          node.setAttribute('aria-pressed', String(entry.id === currentItem)); node.setAttribute('title', entry.fileName || entry.title || '补充文件');
          listen(node, 'click', () => { void showEntry(entry); }, rows); list.appendChild(node);
        }
        controls();
      }
      async function loadList(token) {
        const result = await supplements.list(reader);
        if (!current(token)) return;
        entries = Array.isArray(result) ? result.slice(0, 500) : []; renderList();
      }
      function reload() { return operate('读取本地文件…', async token => { await loadList(token); if (current(token)) message(''); }, '无法读取本地文件。请重试。', reload); }
      function renderCandidates() {
        clear(choiceRemovers); choices.textContent = ''; choices.hidden = !candidates.length;
        if (!candidates.length) return;
        choices.appendChild(element('h3', '选择要下载的文件'));
        for (const candidate of candidates) {
          const label = element('label'), check = element('input'), text = element('span', candidate.title || candidate.fileName || '补充文件');
          check.setAttribute('type', 'checkbox'); check.checked = selected.has(candidate.id);
          listen(check, 'change', () => { if (check.checked) selected.add(candidate.id); else selected.delete(candidate.id); controls(); }, choiceRemovers);
          label.append(check, text); choices.appendChild(label);
        }
        const download = element('button'); download.setAttribute('type', 'button'); listen(download, 'click', () => { void downloadSelected(); }, choiceRemovers); choices.appendChild(download); controls();
      }
      function find() {
        return operate('查找补充材料…', async token => {
          const result = await supplements.find(reader); if (!current(token)) return;
          candidates = Array.isArray(result?.candidates) ? result.candidates.slice(0, 200) : []; selected = new Set(); renderCandidates();
          message(candidates.length ? '来源：Europe PMC。勾选后确认下载。' : result?.status === 'no_identifier' ? '论文缺少 DOI 或 PMC 编号，可添加本地文件。' : result?.status === 'unavailable' ? '暂时无法查询，可重试或添加本地文件。' : '未找到可下载的补充材料，可添加本地文件。');
        }, '查找失败。请重试或添加本地文件。', find);
      }
      function outcome(result, cancelled) {
        const added = result?.added?.length || 0, skipped = result?.skipped?.length || 0, failed = result?.failed?.length || 0;
        return added || skipped || failed ? [added ? '已添加 ' + added + ' 个文件' : '', skipped ? '已跳过 ' + skipped + ' 个' : '', failed ? failed + ' 个文件失败，可重新查找后重试' : ''].filter(Boolean).join('；') : cancelled;
      }
      function downloadSelected() {
        if (!selected.size) return;
        const ids = [...selected];
        return operate('下载所选文件…', async token => {
          const result = await supplements.download(reader, ids); if (!current(token)) return;
          await loadList(token); if (!current(token)) return;
          const failed = new Set((result?.failed || []).map(x => x.id)), succeeded = new Set(ids.filter(id => !failed.has(id)));
          candidates = candidates.filter(x => !succeeded.has(x.id)); selected = new Set(); renderCandidates(); message(outcome(result, '未添加文件'));
        }, '下载失败。可重新选择后重试。');
      }
      function add() {
        return operate('选择本地文件…', async token => {
          const result = await supplements.chooseFiles(reader); if (!current(token)) return;
          await loadList(token); if (current(token)) message(outcome(result, '未选择文件'));
        }, '添加失败。请重新选择文件。', add);
      }
      function previewFailure() {
        clearPreview(); external.hidden = false; message('无法预览此文件，可在外部应用打开。'); controls();
      }
      async function paintPage(token, previewToken) {
        if (!current(token) || previewToken !== previewGeneration || !pdf) return;
        rendering = true; controls(); safely(renderTask, 'cancel'); renderTask = null;
        const document = pdf;
        try {
          const page = owned(await owned(document.getPage(pageNumber)));
          if (!current(token) || previewToken !== previewGeneration || pdf !== document) return;
          const base = owned(page.getViewport(transfer({ scale: 1 }, pdfWindow())));
          if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0) throw Error('pdf_size');
          const width = Math.max(180, preview.clientWidth - 20 || Math.min(560, (win.innerWidth || 1000) * .45));
          const ratio = Math.min(2, win.devicePixelRatio || 1), scale = Math.min(width / base.width, Math.sqrt(8000000 / (base.width * base.height)) / ratio);
          const viewport = owned(page.getViewport(transfer({ scale: scale * ratio }, pdfWindow()))), canvas = element('canvas');
          canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height)); canvas.style.setProperty('width', (canvas.width / ratio) + 'px');
          canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', '补充材料，第 ' + pageNumber + ' 页');
          preview.textContent = ''; preview.appendChild(canvas); preview.scrollTop = 0;
          renderTask = owned(page.render(transfer({ canvasContext: canvas.getContext('2d'), viewport }, pdfWindow())));
          await owned(renderTask.promise);
          if (!current(token) || previewToken !== previewGeneration || pdf !== document) return;
          renderTask = null; pageLabel.textContent = pageNumber + ' / ' + document.numPages; message('');
          if (typeof page.getTextContent === 'function') {
            const text = await owned(page.getTextContent()).catch(() => null);
            if (current(token) && previewToken === previewGeneration && pdf === document) {
              const readable = element('div', (text?.items || []).slice(0, 20000).map(x => x.str || '').join(' ').slice(0, 100000)); readable.className = 'askgpt-supplement-sr'; preview.appendChild(readable);
            }
          }
          page.cleanup?.();
        } catch (_) { if (current(token) && previewToken === previewGeneration) previewFailure(); }
        finally { if (current(token) && previewToken === previewGeneration) { rendering = false; controls(); } }
      }
      function pdfWindow() { return reader._internalReader?._primaryView?._iframeWindow; }
      async function showEntry(entry) {
        const requestGeneration = generation;
        return operate('载入补充材料…', async token => {
          clearPreview(); currentItem = entry.id; renderList();
          const value = await supplements.preview(reader, entry.id); if (!current(token)) return;
          heading.textContent = value?.title || entry.title || entry.fileName || '补充材料';
          const previewToken = previewGeneration;
          if (value?.kind === 'external') { external.hidden = false; message('此类文件需在外部应用打开。'); return; }
          const bytes = value?.bytes;
          if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1 || !bytes.byteLength || bytes.byteLength > (value.kind === 'pdf' ? 32 : 12) * 1024 * 1024) throw Error('preview_bytes');
          if (value.kind === 'image' && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(value.contentType)) {
            objectURL = win.URL.createObjectURL(new win.Blob([bytes], { type: value.contentType }));
            const image = element('img'); image.setAttribute('alt', value.title || entry.title || '补充图片');
            listen(image, 'load', () => { if (current(token) && previewToken === previewGeneration) message(''); }, previews);
            listen(image, 'error', () => { if (current(token) && previewToken === previewGeneration) previewFailure(); }, previews);
            image.setAttribute('src', objectURL); preview.appendChild(image); drawer.setAttribute('data-preview', 'true'); message(''); return;
          }
          if (value.kind !== 'pdf' || value.contentType !== 'application/pdf') throw Error('preview_type');
          const realm = pdfWindow(), lib = realm?.pdfjsLib;
          if (!lib?.getDocument || !lib.PDFWorker) throw Error('preview_unavailable');
          worker = owned(new lib.PDFWorker());
          const settings = transfer({ data: new Uint8Array(bytes), isEvalSupported: false, enableXfa: false, disableAutoFetch: true, ownerDocument: doc }, realm); settings.worker = worker;
          loading = owned(lib.getDocument(settings)); const loaded = owned(await owned(loading.promise));
          if (!current(token) || previewToken !== previewGeneration) { safely(loaded, 'destroy'); return; }
          loading = null; pdf = loaded;
          if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > 10000) throw Error('preview_pages');
          pageNumber = 1; pages.hidden = false; drawer.setAttribute('data-preview', 'true'); await paintPage(token, previewToken);
        }, '无法预览此文件，可在外部应用打开。', () => { void showEntry(entry); }).then(() => {
          if (current(requestGeneration) && currentItem === entry.id && !pdf && !objectURL) {
            if (loading || worker) clearPreview(); external.hidden = false; controls();
          }
        });
      }
      function changePage(delta) {
        if (!pdf || rendering || busy) return;
        pageNumber = Math.max(1, Math.min(pdf.numPages, pageNumber + delta)); void paintPage(generation, previewGeneration);
      }
      const handle = {
        button, trigger, element: drawer, get open() { return !drawer.hidden; },
        close, show,
        refresh: reload,
        dispose() {
          if (disposed) return;
          close(false); closeMenu(); disposed = true; clearProgressTimer(); unsubscribeHTML?.();
          clear(rows); clear(choiceRemovers); clear(statusRemovers); clear(removers); drawer.remove(); menu.remove(); style.remove(); progress?.remove(); if (!trigger) button.remove();
          if (contexts.get(reader) === handle) contexts.delete(reader);
        }
      };
      try {
        if (trigger) {
          if (primaryMenu) listen(button, 'click', showMenu);
          else listen(button, 'click', event => { if (event.button === 0 && !event.ctrlKey) closeMenu(); });
          listen(button, 'contextmenu', showMenu);
          listen(button, 'keydown', event => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10') || (primaryMenu && event.key === 'ArrowDown')) showMenu(event);
          });
        } else listen(button, 'click', () => { if (!drawer.hidden) close(); else show(); });
        listen(menuItem, 'click', show);
        if (htmlItem) listen(htmlItem, 'click', () => {
          if (menu.hidden || htmlItem.hidden || htmlItem.getAttribute('aria-disabled') === 'true') return;
          activateHTML();
        });
        listen(doc, 'pointerdown', event => { if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) closeMenu(); });
        listen(doc, 'click', event => { if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) closeMenu(); });
        listen(closeButton, 'click', () => close()); listen(findButton, 'click', () => { void find(); }); listen(addButton, 'click', () => { void add(); });
        listen(previous, 'click', () => changePage(-1)); listen(next, 'click', () => changePage(1));
        listen(external, 'click', () => { void operate('打开文件…', async token => { await supplements.open(reader, currentItem); if (current(token)) message(''); }, '无法打开文件。请检查文件是否仍在本地。'); });
        listen(doc, 'keydown', event => {
          if (!menu.hidden && event.key === 'Tab') { closeMenu(); return; }
          if (!menu.hidden && menu.contains(event.target) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            const items = menuItems.filter(item => !item.hidden), index = items.indexOf(event.target);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
            event.preventDefault(); items[next].focus?.(); return;
          }
          if (event.key === 'Escape' && (!menu.hidden || !drawer.hidden)) { event.preventDefault(); event.stopImmediatePropagation(); if (!menu.hidden) closeMenu(true); else close(); }
        });
        listen(win, 'resize', () => { if (!drawer.hidden) position(); positionMenu(); }); listen(win, 'unload', () => handle.dispose());
        doc.head.appendChild(style); doc.body.append(drawer, menu); if (!trigger) append(button);
        if (progress) {
          if (append) append(progress); else button.after(progress);
          unsubscribeHTML = paperHTML.subscribe?.(reader, updateHTMLMenu) || null;
          if (!unsubscribeHTML) updateHTMLMenu();
        }
        contexts.set(reader, handle);
      } catch (error) { handle.dispose(); throw error; }
      return handle;
    }
    return { render, dispose(reader) { contexts.get(reader)?.dispose(); }, shutdown() { stopped = true; for (const context of [...contexts.values()]) context.dispose(); } };
  }
  const api = { create }; root.AskGPTPaperSupplementPanel = api;
  if (typeof module !== 'undefined') module.exports = api;
})(this);
