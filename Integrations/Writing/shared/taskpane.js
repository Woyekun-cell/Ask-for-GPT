import {PageIssueQueue, snapshotIdentity} from './page-issue-queue.js';
import {WritingClient} from './writing-client.js';

const TYPES = {spelling: {label: '拼写', tone: 'red'}, grammar: {label: '语法', tone: 'red'}, expression: {label: '表达', tone: 'blue'}, context: {label: '上下文', tone: 'purple'}};
const SCOPES = {selection: '选句', visiblePages: '可见页', activeParagraph: '活动段', cursorPage: '光标页'};
export const MARK_PALETTES = Object.freeze({
  amber: Object.freeze({id: 'amber', start: '#FF9500', end: '#FFD60A'}),
  rose: Object.freeze({id: 'rose', start: '#B86D82', end: '#CC9BA1'}),
  ocean: Object.freeze({id: 'ocean', start: '#5D83B9', end: '#7BA9BC'}),
  mint: Object.freeze({id: 'mint', start: '#538E83', end: '#8EB6A1'})
});
const DEFAULT_PROFILE = {spellingVariant: 'en-US', style: 'minimal', customTerms: []};
function sameSet(a, b) { return a.size === b.size && [...a].every(value => b.has(value)); }
function envelopeIdentity(envelope) {return JSON.stringify([snapshotIdentity(envelope.snapshot), envelope.issue.id, envelope.issue.range, envelope.issue.original, envelope.issue.replacement]);}

/** Shared task pane owns UI and scheduling, never editor DOM or document writes. */
export class TaskpaneController {
  constructor({root, host, client, timers = globalThis, requestID = () => globalThis.crypto.randomUUID(), profile = DEFAULT_PROFILE, location = globalThis.location}) {
    this.root = root; this.document = root.ownerDocument || root; this.host = host; this.client = client;
    this.location = location; this.closing = false; this.reopening = false; this.reopenFailed = false;
    this.timers = timers; this.requestID = requestID; this.profile = {...DEFAULT_PROFILE, ...profile, customTerms: [...(profile.customTerms || [])]};
    this.queue = new PageIssueQueue(); this.scope = null; this.scopeMode = 'visiblePages';
    this.paused = false; this.disposed = false; this.started = false; this.auto = true; this.generation = 0; this.capabilities = {};
    this.pending = new Map(); this.debounce = new Map(); this.polishQueue = []; this.polishActive = null;
    this.listeners = []; this.unwatch = null; this.watching = null; this.captureVersion = 0; this.pageVersion = 0; this.applying = false; this.resumeAfterHidden = false;
    this.markPalette = MARK_PALETTES.amber; this.errors = new Map(); this.latestChecks = new Map();
    this.watchVersion = 0; this.actionStates = new Map(); this.markerWork = Promise.resolve();
    this.elements = Object.fromEntries(['status','scope-label','capability-message','spelling-variant','writing-style','dictionary-count','issue-list','issue-count','previous','next','check-selection','check-polish','check-context','mark-palette','palette-note','auto-check','pause','close','error'].map(id => [id, root.querySelector(`#${id}`)]));
    this.unsubscribe = this.queue.subscribe(() => this.render());
    this.bind('previous', 'click', () => this.navigate(-1));
    this.bind('next', 'click', () => this.navigate(1));
    this.bind('check-selection', 'click', () => this.checkSelection());
    this.bind('check-polish', 'click', () => this.checkPolish());
    this.bind('mark-palette', 'change', event => this.changeMarkPalette(event.target.value));
    this.bind('check-context', 'click', () => this.checkContext());
    this.bind('auto-check', 'change', event => this.setAutomatic(event.target.checked));
    this.bind('spelling-variant', 'change', event => this.changeProfile('spellingVariant', event.target.value));
    this.bind('writing-style', 'change', event => this.changeProfile('style', event.target.value));
    this.bind('pause', 'click', () => this.paused ? this.resume() : this.pause());
    // This lifecycle control survives disposal so a retained shared runtime can reopen explicitly.
    this.elements.close?.addEventListener('click', () => Promise.resolve(this.disposed ? this.reopen() : this.dispose()).catch(error => this.showError(error)));
    this.listen(root, 'keydown', event => { if (event.altKey && ['ArrowDown','ArrowUp'].includes(event.key)) {event.preventDefault(); this.navigate(event.key === 'ArrowDown' ? 1 : -1);} });
    this.listen(this.document, 'visibilitychange', () => this.onVisibilityChange());
    this.render();
  }

  listen(element, type, handler) {
    if (!element) return;
    const safeHandler = event => Promise.resolve(handler(event)).catch(error => this.showError(error));
    element.addEventListener(type, safeHandler); this.listeners.push(() => element.removeEventListener(type, safeHandler));
  }
  bind(id, type, handler) { this.listen(this.elements[id], type, handler); }

  async start() {
    if (this.started || this.disposed) return;
    this.started = true;
    const generation = this.generation;
    this.capabilities = await this.host.initialize() || {};
    if (this.disposed || generation !== this.generation) return;
    if (this.capabilities.automaticCheck === false) this.auto = false;
    await this.host.setMarkPalette?.(this.markPalette);
    if (this.disposed || generation !== this.generation) return;
    if (this.document.visibilityState === 'hidden') {this.paused = true; this.resumeAfterHidden = true; this.render(); return;}
    await this.resume();
  }

  async watch() {
    while (this.auto && !this.unwatch && !this.disposed && !this.paused) {
      if (this.watching) {await this.watching; continue;}
      const version = this.watchVersion;
      const watching = (async () => {
        const unwatch = await this.host.watch(event => {
          if (version !== this.watchVersion) return;
          return this.onHostChange(event).catch(error => this.showError(error));
        });
        if (version !== this.watchVersion || !this.auto || this.disposed || this.paused) {await unwatch?.(); return;}
        this.unwatch = unwatch;
      })();
      this.watching = watching;
      try {await watching;} finally {if (this.watching === watching) this.watching = null;}
    }
  }

  async stopWatch() {
    this.watchVersion++;
    const unwatch = this.unwatch; this.unwatch = null;
    await unwatch?.();
  }

  isLive(generation) {return generation === this.generation && !this.disposed && !this.paused;}
  hasEnvelope(envelope) {return this.queue.issues.some(item => envelopeIdentity(item) === envelopeIdentity(envelope));}
  hasCandidate(envelope) {return this.queue.candidates.some(item => envelopeIdentity(item) === envelopeIdentity(envelope));}
  clearMarkers() {
    const work = this.markerWork.catch(() => {}).then(() => this.host.clear());
    this.markerWork = work; return work;
  }
  publishIssues(generation = this.generation, version = this.pageVersion) {
    if (!this.host.showIssues) return Promise.resolve();
    const work = this.markerWork.catch(() => {}).then(async () => {
      if (!this.isLive(generation) || version !== this.pageVersion) return;
      await this.host.showIssues(this.queue.issues);
      if (!this.isLive(generation) || version !== this.pageVersion) await this.host.clear();
    });
    this.markerWork = work; return work;
  }

  async onHostChange(event = {}) {
    if (this.paused || this.disposed) return;
    if (event.type === 'annotationFocus' && event.envelope) {this.queue.select(event.envelope); return;}
    if (event.type === 'capabilitiesChanged') {
      this.capabilities = {...this.capabilities, ...event.capabilities}; this.actionStates.clear(); this.render();
      if (this.capabilities.automaticCheck === false && this.auto) await this.setAutomatic(false);
      await this.refreshIssueMetadata(); return;
    }
    const version = ++this.captureVersion;
    if (event.type === 'contentChanged' || event.type === 'invalidated') {
      this.cancelAll();
      const generation = this.generation;
      for (const snapshot of this.scope?.snapshots || []) this.queue.invalidate(snapshot.blockID);
      await this.clearMarkers();
      if (this.applying || !this.isLive(generation) || version !== this.captureVersion) return;
    }
    if (!this.auto) return;
    this.scopeMode = 'visiblePages';
    if (event.scope) this.updateScope(event.scope);
    else await this.refresh();
  }

  async refresh({immediate = false, force = false, manual = false, scopeMode = 'visiblePages', fallbackToVisible = false, checkModes = ['spelling']} = {}) {
    if (this.disposed || this.paused || (!this.auto && !manual)) return;
    const version = ++this.captureVersion, generation = this.generation;
    let scope;
    try {scope = await this.host.captureScope(scopeMode);} catch (error) {
      if (!fallbackToVisible || error.code !== 'emptySelection') throw error;
      if (!this.isLive(generation) || version !== this.captureVersion) return;
      scope = await this.host.captureScope('visiblePages');
    }
    if (this.disposed || this.paused || version !== this.captureVersion || generation !== this.generation) return;
    this.updateScope(scope, {immediate, force, manual, checkModes});
  }

  updateScope(scope, {immediate = false, force = false, manual = false, checkModes = ['spelling']} = {}) {
    this.captureVersion++; this.pageVersion++;
    const previous = new Set((this.scope?.snapshots || []).map(snapshotIdentity));
    const current = new Set(scope.snapshots.map(snapshotIdentity));
    for (const entry of [...this.pending.values()]) if (!current.has(entry.key)) this.cancelRequest(entry);
    this.polishQueue = this.polishQueue.filter(job => current.has(job.key));
    this.scope = scope;
    for (const [key, latest] of this.latestChecks) if (!current.has(latest.snapshotKey)) this.latestChecks.delete(key);
    for (const [key, failure] of this.errors) if (failure.snapshotKey ? !current.has(failure.snapshotKey) : !sameSet(previous, current)) this.errors.delete(key);
    this.queue.updateScope(scope, {verifyIssuePages: typeof this.host.getIssuePageIndices === 'function' && this.capabilities.visiblePages !== false});
    const identities = new Set(this.queue.candidates.map(envelopeIdentity));
    for (const [key, state] of this.actionStates) if (!identities.has(key) || state.pending) this.actionStates.delete(key);
    const generation = this.generation, version = this.pageVersion;
    void this.clearMarkers().catch(error => this.showError(error));
    void this.refreshIssueMetadata().then(() => this.queue.candidates.length ? this.publishIssues(generation,version) : undefined).catch(error => this.showError(error));
    const snapshots = [...new Map(scope.snapshots.map(snapshot => [snapshotIdentity(snapshot), snapshot])).values()];
    for (const snapshot of snapshots) {
      if (!force && previous.has(snapshotIdentity(snapshot))) continue;
      for (const mode of checkModes) this.schedule(snapshot, mode, immediate ? 0 : 300, manual);
    }
  }

  schedule(snapshot, mode, delay, manual = false) {
    if (this.paused || this.disposed || (!this.auto && !manual)) return;
    const key = snapshotIdentity(snapshot), timerKey = `${key}:${mode}`;
    if (this.debounce.has(timerKey)) this.timers.clearTimeout(this.debounce.get(timerKey));
    const timer = this.timers.setTimeout(() => {
      this.debounce.delete(timerKey);
      if (this.paused || this.disposed || (!this.auto && !manual) || !this.scope?.snapshots.some(s => snapshotIdentity(s) === key)) return;
      if (mode === 'polish') {this.polishQueue.push({snapshot, key}); this.drainPolish();}
      else this.runCheck(snapshot, mode);
    }, delay);
    this.debounce.set(timerKey, timer);
  }

  async runCheck(snapshot, mode) {
    const requestSnapshot = {...snapshot, requestID: this.requestID()};
    if (!this.queue.registerRequest(requestSnapshot, mode)) return;
    const entry = {snapshot: requestSnapshot, mode, key: snapshotIdentity(snapshot), controller: new AbortController(), generation: this.generation};
    this.latestChecks.set(this.checkErrorKey(entry), {requestID: requestSnapshot.requestID, snapshotKey: entry.key});
    this.pending.set(requestSnapshot.requestID, entry); this.render();
    try {
      const result = await this.client.check(requestSnapshot, mode, {...this.profile, customTerms: [...this.profile.customTerms]}, {signal: entry.controller.signal});
      if (this.disposed || this.paused || entry.controller.signal.aborted || entry.generation !== this.generation) return;
      if (result.status === 'failed') this.showError(new Error('检查失败，请重试'), entry);
      if (this.queue.acceptResult(result)) {
        this.errors.delete(this.checkErrorKey(entry)); this.render();
        const version = this.pageVersion;
        await this.refreshIssueMetadata();
        if (!this.isLive(entry.generation) || entry.controller.signal.aborted || version !== this.pageVersion) return;
        await this.publishIssues(entry.generation, version);
      }
    } catch (error) {
      if (!entry.controller.signal.aborted && !this.disposed && !this.paused && error.name !== 'AbortError') this.showError(error, entry);
    } finally { this.pending.delete(requestSnapshot.requestID); this.render(); }
  }

  async refreshIssueMetadata() {
    const version = this.pageVersion, generation = this.generation;
    await Promise.all(this.queue.candidates.map(async envelope => {
      const key = envelopeIdentity(envelope);
      const work = [];
      if (this.host.getIssuePageIndices) work.push((async () => {
        const pages = await this.host.getIssuePageIndices(envelope);
        if (this.isLive(generation) && version === this.pageVersion && this.hasCandidate(envelope)) this.queue.setIssuePages(envelope, pages);
      })());
      if (!this.actionStates.has(key)) {
        const pendingState = {pending: true, canApply: false, reason: ''};
        this.actionStates.set(key, pendingState); this.render();
        work.push((async () => {
          let actions;
          try {actions = this.host.getIssueActions ? await this.host.getIssueActions(envelope) : {canApply: false, reason: '无法核验此处格式，仅预览。'};}
          catch (error) {actions = {canApply: false, reason: error.message || '无法核验此处格式，仅预览。'};}
          if (!this.isLive(generation) || version !== this.pageVersion || !this.hasCandidate(envelope) || this.actionStates.get(key) !== pendingState) return;
          this.actionStates.set(key, {pending: false, canApply: actions.canApply === true, reason: typeof actions.reason === 'string' ? actions.reason : ''}); this.render();
        })());
      }
      await Promise.all(work);
    }));
  }

  async drainPolish() {
    if (this.polishActive || this.paused || this.disposed) return;
    const job = this.polishQueue.shift();
    if (!job) return;
    const active = this.runCheck(job.snapshot, 'polish');
    this.polishActive = active;
    try {await active;} finally {if (this.polishActive === active) this.polishActive = null; this.drainPolish();}
  }

  cancelRequest(entry) {
    entry.controller.abort(); this.pending.delete(entry.snapshot.requestID);
    Promise.resolve(this.client.cancel(entry.snapshot.requestID)).catch(() => {});
  }
  cancelAll() {
    this.generation++;
    this.latestChecks.clear(); this.actionStates.clear();
    for (const timer of this.debounce.values()) this.timers.clearTimeout(timer);
    this.debounce.clear(); this.polishQueue = [];
    for (const entry of [...this.pending.values()]) this.cancelRequest(entry);
  }

  async onVisibilityChange() {
    if (this.disposed) return;
    if (this.document.visibilityState === 'hidden' && !this.paused) {
      this.resumeAfterHidden = true; await this.pause({fromVisibility: true});
    } else if (this.document.visibilityState !== 'hidden' && this.resumeAfterHidden) {
      this.resumeAfterHidden = false; await this.resume();
    }
  }

  async pause({fromVisibility = false} = {}) {
    if (this.disposed) return;
    if (!fromVisibility) this.resumeAfterHidden = false;
    this.paused = true; this.captureVersion++; this.cancelAll();
    try {await this.stopWatch();} finally {try {await this.clearMarkers();} finally {this.render();}}
  }
  async resume() {
    if (this.disposed) return;
    this.paused = false; this.scopeMode = 'visiblePages';
    const generation = this.generation;
    if (this.auto) {
      try {await this.watch();} catch (error) {this.paused = true; this.render(); throw error;}
      if (!this.isLive(generation)) return;
      await this.refresh({force: true});
    }
    this.render();
  }
  async setAutomatic(enabled) {
    if (this.disposed) return;
    this.auto = enabled && this.capabilities.automaticCheck !== false;
    if (this.auto) {await this.resume(); return;}
    this.captureVersion++; this.cancelAll();
    try {await this.stopWatch();} finally {await this.clearMarkers(); this.render();}
  }
  async checkSelection() { await this.manualCheck('selection'); }
  async checkPolish() { await this.manualCheck('selection', {checkModes: ['polish']}); }
  async checkContext() { await this.manualCheck('selection', {fallbackToVisible: true, checkModes: ['polish']}); }
  async manualCheck(mode, {fallbackToVisible = false, checkModes = ['spelling']} = {}) {
    if (this.disposed) return;
    this.errors.delete('general');
    this.cancelAll(); this.paused = false; this.scopeMode = 'visiblePages'; this.resumeAfterHidden = false;
    const generation = this.generation;
    if (this.auto) await this.watch();
    if (!this.isLive(generation)) return;
    await this.refresh({immediate: true, force: true, manual: true, scopeMode: mode, fallbackToVisible, checkModes});
  }
  async changeProfile(field, value) {
    const allowed = {spellingVariant: ['en-US', 'en-GB'], style: ['minimal', 'clarity']};
    if (this.disposed || !allowed[field]?.includes(value) || this.profile[field] === value) return;
    this.profile = {...this.profile, [field]: value}; this.cancelAll(); this.captureVersion++;
    for (const snapshot of this.scope?.snapshots || []) this.queue.invalidate(snapshot.blockID);
    const generation = this.generation;
    await this.clearMarkers(); this.render();
    if (this.isLive(generation)) await this.refresh({force: true});
  }

  async changeMarkPalette(id) {
    const palette = Object.hasOwn(MARK_PALETTES, id) ? MARK_PALETTES[id] : null;
    if (!palette || this.disposed || palette === this.markPalette) return;
    this.markPalette = palette; this.render();
    await this.host.setMarkPalette?.(palette);
  }

  async navigate(direction) {
    const envelope = direction > 0 ? this.queue.next() : this.queue.previous();
    if (envelope && !this.paused && !this.disposed) await this.host.focusIssue(envelope);
  }
  async selectAndFocus(envelope) {
    if (this.paused || this.disposed || this.applying || !this.hasEnvelope(envelope)) return;
    this.queue.select(envelope); await this.host.focusIssue(envelope);
  }
  async accept(envelope) {
    if (this.applying || this.paused || this.disposed || envelope.issue.original === envelope.issue.replacement || !this.hasEnvelope(envelope)) return;
    this.applying = true; this.render();
    let generation = this.generation;
    try {
      const actions = this.host.getIssueActions ? await this.host.getIssueActions(envelope) : {canApply: false, reason: '无法核验此处格式，仅预览。'};
      if (!this.isLive(generation) || !this.hasEnvelope(envelope)) return;
      this.actionStates.set(envelopeIdentity(envelope), {...actions, pending: false});
      if (actions.canApply !== true || this.previewOnly(envelope)) return;
      this.cancelAll(); generation = this.generation; this.queue.invalidate(envelope.snapshot.blockID);
      await this.clearMarkers();
      if (!this.isLive(generation)) return;
      await this.host.applyIssue(envelope);
    } finally {
      this.applying = false; this.render();
      if (this.isLive(generation)) await this.refresh({force: true, manual: !this.auto});
    }
  }
  async ignore(envelope) {this.queue.dismiss(envelope); await this.publishIssues();}
  async addTerm(envelope) {
    if (envelope.issue.category !== 'spelling') return;
    const term = envelope.issue.original;
    if (!this.profile.customTerms.includes(term)) this.profile.customTerms.push(term);
    this.cancelAll(); this.queue.invalidate(envelope.snapshot.blockID); await this.clearMarkers(); await this.refresh({force: true, manual: !this.auto});
  }

  previewOnly(envelope) {
    const {snapshot, issue} = envelope;
    return this.capabilities.safeReplace === false || snapshot.protectedRanges.some(range => range.start < issue.range.start+issue.range.length && issue.range.start < range.start+range.length);
  }

  checkErrorKey(entry) { return `${entry.key}:${entry.mode}`; }
  showError(error, entry) {
    if (this.disposed || error?.name === 'AbortError') return;
    const snapshotKey = entry?.key;
    if (snapshotKey && (this.latestChecks.get(this.checkErrorKey(entry))?.requestID !== entry.snapshot.requestID || !this.isLive(entry.generation) || !this.scope?.snapshots.some(snapshot => snapshotIdentity(snapshot) === snapshotKey))) return;
    const message = error?.message || '检查失败，请重试';
    this.errors.set(entry ? this.checkErrorKey(entry) : 'general', {snapshotKey, message: entry ? `${entry.mode === 'polish' ? '润色' : '拼写'}：${message}` : message}); this.render();
  }
  element(tag, text, className) {const node = this.document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;}
  action(label, handler, className) {const button = this.element('button', label, className); button.type = 'button'; button.disabled = this.paused || this.disposed || this.applying; button.addEventListener('click', event => {event.stopPropagation(); return Promise.resolve(handler()).catch(error => this.showError(error));}); return button;}

  reopen() {
    if (!this.disposed || this.closing || this.reopening) return;
    try {
      const url = new URL(this.location?.href);
      if (url.protocol !== 'https:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname)
          || url.username || url.password || url.origin !== this.location.origin || url.pathname !== '/shared/taskpane.html'
          || url.searchParams.getAll('host').length > 1 || !['word','wps'].includes(url.searchParams.get('host') || 'word')
          || typeof this.location.reload !== 'function') throw new Error();
      this.reopenFailed = false; this.reopening = true; this.render();
      // Reload this same page to replace disposed host/client state; never replay an edit.
      this.location.reload();
    } catch {
      this.reopening = false; this.reopenFailed = true; this.render();
    }
  }

  render() {
    const state = this.queue.state, current = this.queue.current;
    this.root.setAttribute('data-palette', this.markPalette.id);
    this.elements.error.textContent = this.reopenFailed ? '请从写作菜单重新打开加载项。' : [...new Set([...this.errors.values()].map(error => error.message))].join('；');
    this.elements.error.hidden = this.disposed ? !this.reopenFailed : this.errors.size === 0;
    this.elements.status.textContent = this.disposed ? '已关闭' : this.paused ? '已暂停' : this.errors.size ? '检查失败' : this.pending.size ? (this.polishActive || [...this.pending.values()].some(entry => entry.mode === 'polish') ? '润色中…' : '检查中…') : state.status === 'unchecked' ? '尚未检查' : state.status === 'pendingPages' ? '检查中' : state.status === 'clean' ? (state.polishChecked ? '润色已检查' : '拼写已检查') : `${state.count} 条建议`;
    const pages = this.scope?.pageIndices || [];
    this.elements['scope-label'].textContent = `${SCOPES[this.scope?.scope || this.scopeMode] || '检查范围'}${pages.length ? ` · ${pages.join('、')}页` : ''}`;
    this.elements['issue-count'].textContent = state.count ? `${state.index+1}/${state.count}` : '';
    this.elements.previous.disabled = state.index <= 0 || this.paused || this.disposed;
    this.elements.next.disabled = state.index < 0 || state.index >= state.count-1 || this.paused || this.disposed;
    this.elements.pause.textContent = this.paused ? '继续' : '暂停';
    this.elements['auto-check'].checked = this.auto;
    this.elements['auto-check'].disabled = this.disposed || this.capabilities.automaticCheck === false;
    this.elements['spelling-variant'].value = this.profile.spellingVariant;
    this.elements['mark-palette'].value = this.markPalette.id;
    this.elements['mark-palette'].disabled = this.disposed;
    this.elements['palette-note'].textContent = this.capabilities.gradientMarks === true ? '用于文内标记与侧栏' : '侧栏配色；当前编辑器不支持文内渐变标记';
    this.elements['writing-style'].value = this.profile.style;
    this.elements['dictionary-count'].textContent = this.profile.customTerms.length ? `词典 ${this.profile.customTerms.length} 词` : '';
    this.elements['capability-message'].textContent = this.capabilities.message || (this.capabilities.annotations === false ? '侧栏检查；文内标注不可用。' : '');
    this.elements['capability-message'].hidden = !this.elements['capability-message'].textContent;
    this.elements['check-selection'].disabled = this.disposed || this.applying;
    this.elements['check-polish'].disabled = this.disposed || this.applying;
    this.elements['check-context'].disabled = this.disposed || this.applying;
    this.elements.pause.disabled = this.disposed;
    this.elements.close.textContent = this.disposed ? '重新开启' : '×';
    this.elements.close.setAttribute('aria-label', this.disposed ? '重新开启' : '关闭检查');
    this.elements.close.setAttribute('title', this.disposed ? '重新开启' : '关闭检查');
    this.elements.close.disabled = this.closing || this.reopening;
    const cards = this.queue.issues.map(envelope => {
      const {issue, snapshot} = envelope, type = TYPES[issue.category];
      const issuePages = this.queue.pagesFor(envelope);
      const actionsState = this.actionStates.get(envelopeIdentity(envelope));
      const previewOnly = this.previewOnly(envelope) || actionsState?.canApply !== true;
      const card = this.element('article', undefined, 'issue-card'); card.dataset.tone = type.tone;
      const expanded = envelope === current;
      card.tabIndex = 0; card.setAttribute('aria-current', String(expanded)); card.setAttribute('aria-expanded',String(expanded));
      const focus = event => {
        if (event.target?.closest?.('button') || (event.type === 'keydown' && event.key !== 'Enter')) return;
        event.preventDefault(); return this.selectAndFocus(envelope).catch(error => this.showError(error));
      };
      card.addEventListener('click',focus); card.addEventListener('keydown',focus);
      const meta = this.element('div', undefined, 'issue-meta');
      meta.append(this.element('span', type.label, 'issue-kind'), this.element('span', issuePages.length ? `${issuePages.join('、')}页` : '', 'issue-page'));
      if (!expanded) {
        const preview = Array.from(issue.original);
        const original = this.element('p', undefined, 'issue-original'); original.append(this.element('span', preview.length > 64 ? preview.slice(0,64).join('')+'…' : issue.original, 'issue-mark'));
        card.append(meta,original);
        return card;
      }
      const hasReplacement = issue.original !== issue.replacement;
      const original = this.element('p', undefined, 'issue-original');
      original.append(this.element('span', issue.original, 'issue-mark'));
      card.append(meta, original);
      if (hasReplacement) card.append(this.element('p', issue.replacement || '删除', 'issue-replacement'));
      card.append(this.element('p', issue.reason, 'issue-reason'));
      if (issue.requiresAuthorConfirmation) card.append(this.element('p', '需审阅', 'review-label'));
      if (previewOnly) card.append(this.element('p', '仅预览', 'review-label'));
      if (actionsState?.reason) card.append(this.element('p', actionsState.reason, 'capability-reason'));
      const actions = this.element('div', undefined, 'issue-actions');
      const accept = this.action('接受', () => this.accept(envelope), 'accept');
      if (previewOnly) accept.disabled = true;
      actions.append(this.action('定位', () => this.host.focusIssue(envelope)));
      if (hasReplacement) actions.append(accept);
      actions.append(this.action('忽略', () => this.ignore(envelope)));
      if (issue.category === 'spelling') actions.append(this.action('加词典', () => this.addTerm(envelope)));
      card.append(actions); return card;
    });
    this.elements['issue-list'].replaceChildren(...cards);
  }

  async dispose() {
    if (this.disposed || this.closing) return;
    this.closing = true; this.render();
    let failure;
    try {await this.pause();} catch (error) {failure = error;}
    this.disposed = true;
    for (const remove of this.listeners.splice(0)) remove();
    this.unsubscribe(); this.queue.dispose();
    const results = await Promise.allSettled([Promise.resolve().then(() => this.client.dispose?.()), Promise.resolve().then(() => this.host.dispose())]);
    this.closing = false;
    this.render();
    if (failure) throw failure;
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}

export async function bootTaskpane({document = globalThis.document, location = globalThis.location, host, client} = {}) {
  const root = document.querySelector('#writing-taskpane');
  if (!root) return null;
  if (!host) {
    const kind = new URL(location.href).searchParams.get('host') || 'word';
    if (kind === 'word') host = (await import('../word/word-host.js')).createWordHost();
    else if (kind === 'wps') host = (await import('../wps/wps-host.js')).createWPSHost();
    else throw new Error('不支持此编辑器');
  }
  const controller = new TaskpaneController({root, host, client: client || new WritingClient({origin: location.origin}), location});
  await controller.start();
  globalThis.addEventListener?.('pagehide', () => {void controller.dispose();}, {once: true});
  return controller;
}

export const taskpaneReady = globalThis.document?.querySelector('#writing-taskpane')
  ? bootTaskpane().catch(error => {const node = globalThis.document.querySelector('#error'); node.textContent = error.message || '无法启动写作检查'; node.hidden = false; return null;})
  : Promise.resolve(null);
