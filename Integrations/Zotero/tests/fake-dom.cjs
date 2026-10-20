// A small event/DOM fixture for lifecycle and literal-text assertions. This does
// not emulate Gecko layout, sandbox policies, accessibility, or a real Zotero UI.
class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type, values = {}) {
    const event = { type, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.immediateStopped = true; }, ...values };
    for (const callback of [...(this.listeners.get(type) || [])]) { callback(event); if (event.immediateStopped) break; }
    return event;
  }
  listenerCount() { return [...this.listeners.values()].reduce((sum, entries) => sum + entries.size, 0); }
}
class Style {
  constructor() { this.values = new Map(); }
  setProperty(name, value, priority = '') { this.values.set(name, { value, priority }); }
  getPropertyValue(name) { return this.values.get(name)?.value || ''; }
  getPropertyPriority(name) { return this.values.get(name)?.priority || ''; }
  removeProperty(name) { this.values.delete(name); }
}
class Element extends Target {
  constructor(doc, tag) {
    super(); this.ownerDocument = doc; this.tagName = tag; this.children = []; this.attributes = new Map();
    this.style = new Style(); this.parentNode = null; this._text = ''; this.className = '';
    if (tag === 'iframe') { this.contentDocument = new Document(); this.navigationMode = doc.iframeNavigation; }
  }
  set textContent(value) { this._text = String(value); for (const child of this.children) child.parentNode = null; this.children = []; this.ownerDocument.onText?.(this, this._text); }
  get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(node) { return this.insertBefore(node, null); }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  insertBefore(node, next) {
    node.remove(); const index = next ? this.children.indexOf(next) : this.children.length;
    this.children.splice(index, 0, node); node.parentNode = this;
    if (node.tagName === 'iframe' && node.getAttribute('srcdoc') && node.navigationMode !== 'manual') {
      queueMicrotask(() => { if (node.parentNode) node.finishNavigation(); });
    }
    return node;
  }
  finishNavigation() { this.contentDocument = new Document(); this.contentDocument.URL = 'about:srcdoc'; this.contentDocument.readyState = 'complete'; this.emit('load'); }
  remove() { if (this.parentNode) { const list = this.parentNode.children; list.splice(list.indexOf(this), 1); this.parentNode = null; } }
  replaceWith(node) { const parent = this.parentNode; parent.insertBefore(node, this); this.remove(); }
  allNodes() { return [this, ...this.children.flatMap(x => x.allNodes())]; }
}
class Document extends Target {
  constructor() { super(); this.head = new Element(this, 'head'); this.body = new Element(this, 'body'); this.ids = new Map(); this.iframeNavigation = 'auto'; this.URL = 'about:blank'; this.readyState = 'loading'; }
  createElementNS(namespace, name) { const node = new Element(this, name); node.namespaceURI = namespace; return node; }
  getElementById(id) { return this.ids.get(id) || null; }
}
class Window extends Target {
  constructor() { super(); this.document = new Document(); this.closed = false; this.setTimeout = setTimeout; this.clearTimeout = clearTimeout; }
}
function pdfWindow() {
  const win = new Window(), viewer = new Element(win.document, 'div');
  viewer.scrollTop = 160; viewer.scrollLeft = 20;
  win.document.ids.set('viewerContainer', viewer); win.document.body.appendChild(viewer);
  return { win, viewer };
}
module.exports = { Target, Element, Document, Window, pdfWindow };
