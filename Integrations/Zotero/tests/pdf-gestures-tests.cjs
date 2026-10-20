const assert = require('node:assert/strict');
const PDF = require('../content/pdf-layout.js');
const DOM = require('./fake-dom.cjs');
let checks = 0;
async function check(name, fn) { await fn(); checks++; process.stdout.write(`PASS ${name}\n`); }
const tick = () => new Promise(setImmediate);
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const bytes = () => new TextEncoder().encode('%PDF-1.7\nfixture\n');

async function fixture(options = {}) {
  const { win, viewer } = DOM.pdfWindow(), renders = [], events = [], frames = new Map(), timers = new Map();
  const source = { source: true }, sourcePage = options.currentPage || 1, sourceScroll = { top: viewer.scrollTop, left: viewer.scrollLeft };
  let frameSerial = 0, nextRender = null, nextRenderPage = null, time = 0, pixelReads = 0, geometryReads = 0;
  viewer.style.setProperty('visibility', 'visible');
  win.PDFViewerApplication = { pdfDocument: source, pdfViewer: { currentPageNumber: sourcePage, pagesCount: 3 } };
  win.pdfjsLib = {
    PDFWorker: class { destroy() {} },
    getDocument: () => ({ promise: Promise.resolve({ numPages: options.pages || 1, destroy() {}, async getPage(pageNumber) {
      return { getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale, scale }),
        render(options) { renders.push(options); const wait = nextRenderPage === null || nextRenderPage === pageNumber ? nextRender : null; if (wait) { nextRender = null; nextRenderPage = null; } return { promise: wait?.promise || Promise.resolve(), cancel() {} }; } };
    } }), destroy() {} })
  };
  const create = DOM.Document.prototype.createElementNS;
  DOM.Document.prototype.createElementNS = function(ns, name) {
    const node = create.call(this, ns, name);
    if (name === 'canvas') node.getContext = () => ({ canvas: node, getImageData() { pixelReads++; return { data: [255,255,255,255] }; } });
    if (name === 'section') node.getBoundingClientRect = () => {
      geometryReads++;
      const scroll = node.ownerDocument.scrollingElement;
      const dimension = (element, key, fallback) => {
        const value = element.style.getPropertyValue(key);
        if (value.startsWith('calc(')) return Number(value.match(/([\d.]+)px/)[1]) * Number(element.parentNode.style.getPropertyValue('--askgpt-zoom') || 1);
        return parseFloat(value) || fallback;
      };
      const width = dimension(node, 'width', 768);
      const height = dimension(node, 'height', 1000);
      let top = 118;
      for (const sibling of node.parentNode?.children || []) { if (sibling === node) break; top += dimension(sibling, 'height', 1000) + 20; }
      const left = 16 + Math.max(0, (768 - width) / 2) - scroll.scrollLeft;
      top -= scroll.scrollTop;
      return { left, right: left + width, top, bottom: top + height, width, height };
    };
    if (name === 'iframe') {
      const finish = node.finishNavigation.bind(node);
      node.finishNavigation = () => {
        // Configure the new browsing context before the module's load callback.
        const emit = node.emit.bind(node);
        node.emit = (type, values) => {
          if (type === 'load') {
            const doc = node.contentDocument, html = new DOM.Element(doc, 'html');
            html.clientWidth = 800; html.clientHeight = 600; html.scrollLeft = 0; html.scrollTop = 500;
            if (options.integerScroll) { let left = 0; Object.defineProperty(html, 'scrollLeft', { get: () => left, set: value => { left = Math.round(value); } }); }
            html.scrollWidth = 5000; html.scrollHeight = 10000; doc.documentElement = html; doc.scrollingElement = html;
            const add = doc.addEventListener.bind(doc);
            doc.addEventListener = (type, listener, options) => { events.push({ type, options }); add(type, listener, options); };
            doc.defaultView = { innerHeight: 600, performance: { now: () => time }, matchMedia: () => ({ matches: !!options.reducedMotion }),
              setTimeout(callback, delay) { const id = ++frameSerial; timers.set(id, { callback, at: time + delay }); return id; }, clearTimeout(id) { timers.delete(id); },
              requestAnimationFrame(callback) { const id = ++frameSerial; frames.set(id, callback); return id; },
              cancelAnimationFrame(id) { frames.delete(id); }, getComputedStyle: () => ({ lineHeight: '16px' }) };
          }
          return emit(type, values);
        };
        finish(); node.emit = emit;
      };
    }
    return node;
  };
  const layer = await PDF.mount({ win, viewer: win.PDFViewerApplication.pdfViewer }, '', {}, {});
  await layer.showOutput(bytes(), Array.from({ length: options.pages || 1 }, (_, i) => i), 'mono');
  const scroll = layer.doc.scrollingElement;
  async function flush(ms = 16) { time += ms; const scheduled = [...frames.values()]; frames.clear(); for (const callback of scheduled) callback(time);
    for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.callback(); } await tick(); await tick(); }
  async function settle() { for (let i = 0; i < 40; i++) await flush(); }
  const wheel = values => layer.doc.emit('wheel', { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, clientX: 300, clientY: 250, ...values });
  return { layer, win, viewer, source, sourcePage, sourceScroll, renders, events, scroll, wheel, flush, settle, reads: () => ({ pixels: pixelReads, geometry: geometryReads }), pendingFrames: () => frames.size,
    blockNextRender(pageNumber = null) { nextRenderPage = pageNumber; nextRender = deferred(); return nextRender; },
    close() { layer.dispose(); DOM.Document.prototype.createElementNS = create; } };
}
const zoom = f => Number(f.layer.body.getAttribute('data-zoom') || 1);

(async () => {
  await check('translated PDF has a cancellable Control-wheel gesture', async () => {
    const f = await fixture();
    try {
      const e = f.wheel({ ctrlKey: true, deltaY: -100 });
      assert.equal(e.defaultPrevented, true, 'Control-wheel must not zoom the host app');
      assert.equal(f.events.find(e => e.type === 'wheel')?.options?.passive, false);
      await f.flush(); assert(zoom(f) > 1); assert.equal(f.renders.length, 1); await f.settle(); assert.equal(f.renders.length, 2);
    } finally { f.close(); }
  });
  await check('Control-wheel preserves the PDF point beneath the mouse', async () => {
    const f = await fixture();
    try {
      const page = f.layer.body.children[0], before = page.getBoundingClientRect();
      const fraction = { x: (300 - before.left) / before.width, y: (250 - before.top) / before.height };
      f.wheel({ ctrlKey: true, deltaY: -120 }); await f.flush(); const after = page.getBoundingClientRect();
      assert(Math.abs(after.left + fraction.x * after.width - 300) < 0.01);
      assert(Math.abs(after.top + fraction.y * after.height - 250) < 0.01);
      assert.equal(f.win.PDFViewerApplication.pdfDocument, f.source); assert.equal(f.win.PDFViewerApplication.pdfViewer.currentPageNumber, f.sourcePage);
      assert.equal(f.viewer.scrollTop, f.sourceScroll.top); assert.equal(f.viewer.scrollLeft, f.sourceScroll.left);
    } finally { f.close(); }
  });
  await check('a burst of wheel events previews without rasterizing and respects zoom limits', async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 25; i++) f.wheel({ ctrlKey: true, deltaY: -4 });
      assert.equal(f.renders.length, 1); await f.flush(); assert.equal(f.renders.length, 1);
      f.wheel({ ctrlKey: true, deltaY: -1e12 }); await f.flush(); assert.equal(zoom(f), 4);
      f.wheel({ ctrlKey: true, deltaY: 1e12 }); await f.flush(); assert.equal(zoom(f), 0.5);
    } finally { f.close(); }
  });
  await check('line and page wheel units match equivalent pixel distances', async () => {
    const values = [];
    for (const input of [{ deltaY: -16 }, { deltaY: -1, deltaMode: 1 }, { deltaY: -600 }, { deltaY: -1, deltaMode: 2 }]) {
      const f = await fixture(); try { f.wheel({ ctrlKey: true, ...input }); await f.flush(); values.push(zoom(f)); } finally { f.close(); }
    }
    assert.equal(values[0], values[1]); assert.equal(values[2], values[3]);
  });
  await check('Command-wheel scrolls the translated document horizontally without rerendering', async () => {
    const f = await fixture();
    try {
      const top = f.scroll.scrollTop;
      assert.equal(f.wheel({ metaKey: true, deltaY: 48 }).defaultPrevented, true); await f.flush(); assert(f.scroll.scrollLeft > 0 && f.scroll.scrollLeft < 48); await f.settle(); assert.equal(f.scroll.scrollLeft, 48);
      f.wheel({ metaKey: true, deltaX: -20, deltaY: 40 }); await f.settle(); assert.equal(f.scroll.scrollLeft, 28);
      f.wheel({ metaKey: true, deltaY: 1, deltaMode: 1 }); await f.settle(); assert.equal(f.scroll.scrollLeft, 44);
      assert.equal(f.scroll.scrollTop, top); await f.flush(); assert.equal(f.renders.length, 1); assert.equal(zoom(f), 1);
    } finally { f.close(); }
  });
  await check('Command takes precedence over a synthetic pinch Control flag in translated output', async () => {
    const f = await fixture();
    try {
      const top = f.scroll.scrollTop, event = f.wheel({ metaKey: true, ctrlKey: true, deltaY: 40 });
      assert.equal(event.defaultPrevented, true); await f.settle(); assert.equal(f.scroll.scrollLeft, 40); assert.equal(f.scroll.scrollTop, top);
      await f.flush(); assert.equal(zoom(f), 1); assert.equal(f.renders.length, 1);
    } finally { f.close(); }
  });
  await check('ordinary and Shift wheels retain default scrolling; hidden output handles no gesture', async () => {
    const f = await fixture();
    try {
      for (const modifiers of [{}, { shiftKey: true }]) assert(!f.wheel({ deltaY: 40, ...modifiers }).defaultPrevented);
      f.layer.restoreOriginal(); assert(!f.wheel({ ctrlKey: true, deltaY: -40 }).defaultPrevented); assert(!f.wheel({ metaKey: true, deltaY: 40 }).defaultPrevented);
      await f.flush(); assert.equal(f.renders.length, 1);
    } finally { f.close(); }
  });
  await check('mode changes and disposal discard queued wheel work', async () => {
    const f = await fixture();
    try {
      f.wheel({ ctrlKey: true, deltaY: -100 }); await f.layer.showOutput(bytes(), [0], 'dual'); await f.flush();
      assert.equal(zoom(f), 1); assert.equal(f.renders.length, 2); assert.equal(f.layer.body.getAttribute('data-mode'), 'dual');
      f.wheel({ ctrlKey: true, deltaY: -100 }); f.layer.dispose(); await f.flush(); assert.equal(f.renders.length, 2); assert.equal(f.viewer.style.getPropertyValue('visibility'), 'visible');
    } finally { f.close(); }
  });
  await check('continuous zoom keeps pixels visible and never blocks feedback on raster work', async () => {
    const f = await fixture();
    try {
      const canvas = f.layer.body.children[0].children[0];
      await f.settle(); const reads = f.reads();
      for (let i = 0; i < 30; i++) {
        const before = zoom(f); f.wheel({ ctrlKey: true, deltaY: -3 }); await f.flush();
        assert(zoom(f) > before, 'each display frame must respond');
        assert.equal(f.layer.body.children[0].children[0], canvas); assert(canvas.width > 0);
        assert.equal(f.renders.length, 1, 'PDF rasterization must stay out of gesture frames');
      }
      assert.equal(f.reads().pixels, reads.pixels, 'gesture frames must not force GPU pixel reads');
      const pending = f.blockNextRender(); await f.settle(); assert.equal(f.renders.length, 2);
      const before = zoom(f); f.wheel({ ctrlKey: true, deltaY: -20 }); await f.flush(); assert(zoom(f) > before);
      assert.equal(f.layer.body.children[0].children[0], canvas, 'a slow refresh must retain the last good pixels');
      pending.resolve(); await tick(); await tick();
      assert.equal(f.layer.body.children[0].children[0], canvas, 'stale raster must not replace a newer preview');
      await f.settle(); assert.equal(f.renders.length, 3); assert.notEqual(f.layer.body.children[0].children[0], canvas);
      assert.equal(canvas.width, 0, 'replaced bitmap must be released');
    } finally { f.close(); }
  });
  await check('horizontal motion is bounded, reverses immediately and has no added travel', async () => {
    const f = await fixture();
    try {
      f.wheel({ metaKey: true, deltaY: 200 }); await f.flush(); const first = f.scroll.scrollLeft;
      assert(first > 0 && first < 200);
      f.wheel({ metaKey: true, deltaY: -20 }); await f.flush(); assert(f.scroll.scrollLeft < first, 'direction changes must not finish an obsolete target');
      await f.settle(); assert(Math.abs(f.scroll.scrollLeft - Math.max(0, first - 20)) < 0.01);
      f.wheel({ metaKey: true, deltaY: -1e6 }); await f.settle(); assert.equal(f.scroll.scrollLeft, 0);
      f.wheel({ metaKey: true, deltaY: 1e6 }); await f.settle(); assert.equal(f.scroll.scrollLeft, f.scroll.scrollWidth - f.scroll.clientWidth);
      const stopped = f.scroll.scrollLeft; await f.settle(); assert.equal(f.scroll.scrollLeft, stopped);
    } finally { f.close(); }
  });
  await check('pixel-rounded scrolling settles without an endless animation loop', async () => {
    const f = await fixture({ integerScroll: true });
    try {
      await f.settle(); f.wheel({ metaKey: true, deltaY: 100.4 }); await f.settle();
      assert(Math.abs(f.scroll.scrollLeft - 100.4) <= 1); assert.equal(f.pendingFrames(), 0);
    } finally { f.close(); }
  });
  await check('reduced motion pans directly without an animation tail', async () => {
    const f = await fixture({ reducedMotion: true });
    try { f.wheel({ metaKey: true, deltaY: 60 }); await f.flush(); assert.equal(f.scroll.scrollLeft, 60); }
    finally { f.close(); }
  });
  await check('deep document anchors require bounded geometry reads during wheel input', async () => {
    const f = await fixture({ pages: 2000 });
    try {
      f.scroll.scrollTop = 1800000; await f.settle(); const reads = f.reads().geometry;
      f.wheel({ ctrlKey: true, deltaY: -10 }); await f.flush();
      assert(f.reads().geometry - reads < 40, 'a wheel frame must not scan the entire PDF');
    } finally { f.close(); }
  });
  await check('hiding during a refresh discards its late bitmap and all queued motion', async () => {
    const f = await fixture();
    try {
      const pending = f.blockNextRender(); f.wheel({ ctrlKey: true, deltaY: -20 }); await f.flush(); await f.settle();
      f.wheel({ metaKey: true, deltaY: 60 }); const left = f.scroll.scrollLeft;
      f.layer.restoreOriginal(); pending.resolve(); await f.settle();
      assert.equal(f.layer.visible, false); assert.equal(f.scroll.scrollLeft, left);
      assert.equal(f.viewer.style.getPropertyValue('visibility'), 'visible');
    } finally { f.close(); }
  });
  await check('a late first render of a neighbor cannot reopen hidden output', async () => {
    const f = await fixture({ pages: 3 });
    try {
      const pending = f.blockNextRender(2); f.wheel({ ctrlKey: true, deltaY: -20 }); await f.flush(); await f.settle();
      f.layer.restoreOriginal(); pending.resolve(); await f.settle();
      assert.equal(f.layer.visible, false); assert.equal(f.viewer.style.getPropertyValue('visibility'), 'visible');
    } finally { f.close(); }
  });
  await check('settling new neighboring page dimensions preserves the reading anchor', async () => {
    const f = await fixture({ pages: 3, currentPage: 2 });
    try {
      f.scroll.scrollTop = 1100; f.wheel({ ctrlKey: true, deltaY: -20 }); await f.flush();
      const page = f.layer.body.children[1], before = page.getBoundingClientRect();
      const fraction = (250 - before.top) / before.height; await f.settle(); const after = page.getBoundingClientRect();
      assert(Math.abs(after.top + fraction * after.height - 250) < 0.01, 'neighbor refinements must not move the text being read');
    } finally { f.close(); }
  });
  await check('switching modifier gestures cancels obsolete input before it can move the anchor', async () => {
    const f = await fixture();
    try {
      f.wheel({ ctrlKey: true, deltaY: -40 }); f.wheel({ metaKey: true, deltaY: 60 }); await f.flush();
      assert.equal(zoom(f), 1, 'a queued Control zoom must not apply after switching to pan');
      f.wheel({ ctrlKey: true, deltaY: -40 }); await f.flush(); const left = f.scroll.scrollLeft;
      for (let i = 0; i < 5; i++) await f.flush();
      assert.equal(f.scroll.scrollLeft, left, 'old pan animation must not continue after switching to zoom');
    } finally { f.close(); }
  });
  await check('existing zoom and fit-width buttons continue to work after a wheel gesture', async () => {
    const f = await fixture();
    try {
      f.wheel({ ctrlKey: true, deltaY: -100 }); await f.flush();
      const all = f.layer.doc.body.allNodes(); all.find(n => n.getAttribute('title') === 'Zoom in · 放大').emit('click'); await tick(); assert(zoom(f) > 1);
      all.find(n => n.getAttribute('title') === 'Fit width · 适合宽度').emit('click'); await tick(); assert.equal(zoom(f), 1);
    } finally { f.close(); }
  });
  process.stdout.write(JSON.stringify({ status: 'PASS', checks }) + '\n');
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
