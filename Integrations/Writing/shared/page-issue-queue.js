const CATEGORIES = new Set(['spelling', 'grammar', 'expression', 'context']);
const MODES = new Set(['spelling', 'polish']);

export function snapshotIdentity(snapshot) {
  return JSON.stringify([snapshot.documentSessionID, snapshot.blockID, snapshot.revision,
    snapshot.snapshotHash, snapshot.contextHash, snapshot.targetRange?.start, snapshot.targetRange?.length]);
}

function issueIdentity(issue) {
  return JSON.stringify([issue.category, issue.range.start, issue.range.length, issue.original, issue.replacement]);
}

function validIssue(issue) {
  return issue && typeof issue.id === 'string' && CATEGORIES.has(issue.category) &&
    ['original', 'replacement', 'reason'].every(key => typeof issue[key] === 'string') &&
    (issue.original !== issue.replacement || (['spelling', 'context'].includes(issue.category) && issue.reason.trim().length > 0)) &&
    Number.isSafeInteger(issue.range?.start) && issue.range.start >= 0 &&
    Number.isSafeInteger(issue.range?.length) && issue.range.length > 0;
}

/** Page numbers group the display only. All identities retain the raw snapshot. */
export class PageIssueQueue {
  #blocks = new Map();
  #requests = new Map();
  #listeners = new Set();
  #items = [];
  #candidates = [];
  #verifyIssuePages = false;
  #currentKey = null;
  #disposed = false;
  #selectionExplicit = false;
  #scope = {scope: 'visiblePages', pageIndices: [], snapshots: []};

  get issues() { return this.#items.map(item => item.envelope); }
  get candidates() { return this.#candidates.map(item => item.envelope); }
  get current() { return this.#items.find(item => item.key === this.#currentKey)?.envelope || null; }
  get state() {
    const blocks = [...this.#blocks.values()];
    const checked = blocks.length > 0 && blocks.every(block => block.results.size > 0);
    const polishChecked = blocks.length > 0 && blocks.every(block => block.results.has('polish'));
    const pendingPages = this.#verifyIssuePages && this.#scope.scope === 'visiblePages' && this.#scope.pageIndices.length > 0 &&
      this.#candidates.some(item => !item.pages?.length);
    return {checked, polishChecked, status: this.#items.length ? 'issues' : pendingPages ? 'pendingPages' : checked ? 'clean' : 'unchecked',
      count: this.#items.length, index: this.#items.findIndex(item => item.key === this.#currentKey),
      scope: this.#scope.scope, pageIndices: [...this.#scope.pageIndices]};
  }

  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  updateScope(scope, {verifyIssuePages = false} = {}) {
    if (this.#disposed) return;
    this.#verifyIssuePages = verifyIssuePages;
    const blocks = new Map();
    for (const snapshot of scope.snapshots || []) {
      const key = snapshotIdentity(snapshot);
      const existing = blocks.get(key);
      if (existing) {
        existing.snapshot = {...existing.snapshot, pageIndices: [...new Set([...existing.snapshot.pageIndices, ...snapshot.pageIndices])].sort((a,b) => a-b)};
        continue;
      }
      const old = this.#blocks.get(key);
      const block = {snapshot: {...snapshot, pageIndices: [...snapshot.pageIndices]}, order: blocks.size,
        results: old?.results || new Map(), latest: old?.latest || new Map(), ignored: old?.ignored || new Set(),
        pages: !verifyIssuePages && old && JSON.stringify(old.snapshot.pageIndices) === JSON.stringify(snapshot.pageIndices) ? old.pages : new Map()};
      blocks.set(key, block);
      if (!this.#requests.has(snapshot.requestID)) {
        this.#requests.set(snapshot.requestID, {key, mode: 'spelling'});
        if (!block.latest.has('spelling')) block.latest.set('spelling', snapshot.requestID);
      }
    }
    this.#blocks = blocks;
    this.#scope = {...scope, pageIndices: [...(scope.pageIndices || [])]};
    for (const [id, request] of this.#requests) if (!blocks.has(request.key)) this.#requests.delete(id);
    this.#rebuild();
  }

  registerRequest(snapshot, mode) {
    if (this.#disposed || !MODES.has(mode)) return false;
    const key = snapshotIdentity(snapshot), block = this.#blocks.get(key);
    if (!block) return false;
    const previous = block.latest.get(mode);
    if (previous) this.#requests.delete(previous);
    block.latest.set(mode, snapshot.requestID);
    this.#requests.set(snapshot.requestID, {key, mode});
    return true;
  }

  acceptResult(result) {
    if (this.#disposed || !result || result.status !== 'completed' || !Array.isArray(result.issues)) return false;
    const request = this.#requests.get(result.requestID);
    const block = request && this.#blocks.get(request.key);
    if (!block || block.snapshot.snapshotHash !== result.snapshotHash || block.latest.get(request.mode) !== result.requestID) return false;
    block.results.set(request.mode, result.issues.filter(validIssue).map(issue => ({...issue, range: {...issue.range}})));
    this.#rebuild();
    return true;
  }

  invalidate(blockID) {
    if (this.#disposed) return;
    for (const [key, block] of this.#blocks) {
      if (block.snapshot.blockID !== blockID) continue;
      block.results.clear(); block.latest.clear(); block.ignored.clear(); block.pages.clear();
      for (const [id, request] of this.#requests) if (request.key === key) this.#requests.delete(id);
    }
    this.#rebuild();
  }

  dismiss(envelope = this.current) {
    if (!envelope) return;
    const block = this.#blocks.get(snapshotIdentity(envelope.snapshot));
    block?.ignored.add(issueIdentity(envelope.issue));
    this.#rebuild();
  }

  pagesFor(envelope) {
    const block = this.#blocks.get(snapshotIdentity(envelope.snapshot));
    return [...(block?.pages.get(issueIdentity(envelope.issue)) || (block?.snapshot.pageIndices.length === 1 ? block.snapshot.pageIndices : []))];
  }

  setIssuePages(envelope, pageIndices) {
    const block = this.#blocks.get(snapshotIdentity(envelope.snapshot));
    if (!block || !this.#candidates.some(item => item.envelope.issue.id === envelope.issue.id && snapshotIdentity(item.envelope.snapshot) === snapshotIdentity(envelope.snapshot))) return false;
    block.pages.set(issueIdentity(envelope.issue), [...new Set(pageIndices.filter(page => Number.isSafeInteger(page) && page > 0))].sort((a,b)=>a-b));
    this.#rebuild(); return true;
  }

  select(envelope) {
    const item = this.#items.find(item => snapshotIdentity(item.envelope.snapshot) === snapshotIdentity(envelope.snapshot) && item.envelope.issue.id === envelope.issue.id);
    if (item) { this.#selectionExplicit = true; this.#currentKey = item.key; this.#emit(); }
    return this.current;
  }

  next() { return this.#move(1); }
  previous() { return this.#move(-1); }
  #move(direction) {
    if (!this.#items.length) return null;
    const index = Math.max(0, this.#items.findIndex(item => item.key === this.#currentKey));
    this.#selectionExplicit = true;
    this.#currentKey = this.#items[Math.max(0, Math.min(this.#items.length-1, index+direction))].key;
    this.#emit(); return this.current;
  }

  #rebuild() {
    const previousIndex = this.#items.findIndex(item => item.key === this.#currentKey);
    const items = [];
    for (const [key, block] of this.#blocks) {
      const seen = new Set();
      for (const issues of block.results.values()) for (const issue of issues) {
        const id = issueIdentity(issue);
        if (seen.has(id) || block.ignored.has(id)) continue;
        seen.add(id);
        items.push({key: `${key}:${id}`, order: block.order, pages: block.pages.get(id),
          page: Math.min(...(block.pages.get(id) || block.snapshot.pageIndices), Infinity),
          envelope: {snapshot: block.snapshot, issue}});
      }
    }
    items.sort((a,b) => a.page-b.page || a.order-b.order || a.envelope.issue.range.start-b.envelope.issue.range.start);
    this.#candidates = items;
    this.#items = items.filter(item => {
      if (this.#scope.scope !== 'visiblePages' || !this.#scope.pageIndices.length) return true;
      const pages = item.pages || (this.#verifyIssuePages ? [] : item.envelope.snapshot.pageIndices);
      return pages.some(page => this.#scope.pageIndices.includes(page));
    });
    if (!this.#selectionExplicit) this.#currentKey = this.#items[0]?.key || null;
    else if (!this.#items.some(item => item.key === this.#currentKey)) this.#currentKey = this.#items[Math.min(Math.max(previousIndex, 0), this.#items.length-1)]?.key || null;
    this.#emit();
  }
  #emit() { for (const listener of this.#listeners) listener(this.state); }
  dispose() { this.#disposed = true; this.#blocks.clear(); this.#requests.clear(); this.#items = []; this.#candidates = []; this.#currentKey = null; this.#listeners.clear(); }
}
