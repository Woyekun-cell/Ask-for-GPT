// Minimal DOM boundary double. Browser rendering is verified separately.
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.events = new Map(); this.textContent = ''; this.className = ''; this.disabled = false; this.checked = true; this.value = ''; this.hidden = false; this.dataset = {}; }
  append(...nodes) { for(const node of nodes)node.parentNode=this; this.children.push(...nodes); }
  replaceChildren(...nodes) { for(const node of this.children)node.parentNode=null; this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(k, fn) { if (!this.events.has(k)) this.events.set(k, new Set()); this.events.get(k).add(fn); }
  removeEventListener(k, fn) { this.events.get(k)?.delete(fn); }
  closest(selector) { for(let node=this;node;node=node.parentNode)if(node.tagName===selector)return node;return null; }
  async dispatch(event) {event.currentTarget=this;for(const fn of this.events.get(event.type)||[])await fn(event);if(!event.cancelBubble)await this.parentNode?.dispatch(event);}
  async fire(k, detail = {}) {const event={type:k,target:this,preventDefault(){},stopPropagation(){this.cancelBubble=true;},...detail};await this.dispatch(event);}
  focus() { this.focused = true; }
}
function makeDOM() {
  const ids = ['status', 'scope-label', 'capability-message', 'spelling-variant', 'writing-style', 'dictionary-count', 'issue-list', 'issue-count', 'previous', 'next', 'check-selection', 'check-polish', 'check-context', 'mark-palette', 'palette-note', 'auto-check', 'pause', 'close', 'error'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const root = new Element();
  const doc = new Element('document');
  doc.createElement = tag => new Element(tag);
  doc.querySelector = selector => elements[selector.slice(1)] || null;
  doc.visibilityState = 'visible';
  root.ownerDocument = doc;
  root.querySelector = doc.querySelector;
  return {root, elements, doc};
}
class Clock {
  constructor() { this.time = 0; this.jobs = []; this.serial = 0; }
  setTimeout = (fn, ms) => { const id = ++this.serial; this.jobs.push({id, at: this.time + ms, fn}); return id; };
  clearTimeout = id => { this.jobs = this.jobs.filter(j => j.id !== id); };
  async tick(ms) { this.time += ms; let job; while ((job = this.jobs.filter(j => j.at <= this.time).sort((a,b) => a.at-b.at)[0])) { this.clearTimeout(job.id); job.fn(); await flush(); } }
}
async function flush() { for (let i = 0; i < 16; ++i) await Promise.resolve(); }
function texts(element) { return [element.textContent, ...element.children.flatMap(texts)].filter(Boolean); }
function find(element, text) { if (element.textContent === text) return element; for (const c of element.children) { const result = find(c, text); if (result) return result; } return null; }
module.exports = {makeDOM, Clock, flush, texts, find};
