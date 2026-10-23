(function (root) {
  'use strict';
  const LIMIT = 500000, MAX_PARTS = 12000, IDENTITY = [1, 0, 0, 1, 0, 0];
  const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7;
  function rect(value, line = false) {
    if (!value || value.length !== 4) return null;
    const r = [];
    for (let i = 0; i < 4; i++) { if (!finite(value[i])) return null; r.push(value[i]); }
    if (r[2] < r[0] || r[3] < r[1] || (!line && (r[2] === r[0] || r[3] === r[1]))) return null;
    return r;
  }
  function matrix(value) {
    if (!value || value.length !== 6) return null;
    const m = [];
    for (let i = 0; i < 6; i++) { if (!finite(value[i])) return null; m.push(value[i]); }
    return Math.abs(m[0] * m[3] - m[1] * m[2]) > 1e-12 ? m : null;
  }
  const area = r => (r[2] - r[0]) * (r[3] - r[1]);
  const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  function intersect(a, b) { return rect([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]); }
  function multiply(a, b) {
    return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  }
  function transform(r, m) {
    const xs = [], ys = [];
    for (const x of [r[0], r[2]]) for (const y of [r[1], r[3]]) { xs.push(m[0] * x + m[2] * y + m[4]); ys.push(m[1] * x + m[3] * y + m[5]); }
    return rect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], true);
  }
  function close(a, b, gap = 36) {
    const dx = Math.max(0, a[0] - b[2], b[0] - a[2]), dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
    return dx <= gap && dy <= gap && (dx === 0 || dy === 0);
  }
  function usable(r, page) { return r && r[2] - r[0] >= 32 && r[3] - r[1] >= 24 && area(r) >= 900 && area(r) < area(page) * .85; }
  function mergeParts(parts, page) {
    // Index active component envelopes, not every pair of individual strokes.
    // A union is reindexed and queried again so later panels can reconnect an
    // earlier component. Dense scatter plots retain bounded numeric geometry.
    const size = Math.max(36, (page[2] - page[0]) / 32, (page[3] - page[1]) / 32);
    const cells = new Map(), active = new Map(); let sequence = 0;
    const keys = (box, gap = 0) => {
      const values = [];
      const x0 = Math.floor((Math.max(page[0], box[0] - gap) - page[0]) / size), x1 = Math.floor((Math.min(page[2], box[2] + gap) - page[0]) / size);
      const y0 = Math.floor((Math.max(page[1], box[1] - gap) - page[1]) / size), y1 = Math.floor((Math.min(page[3], box[3] + gap) - page[1]) / size);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) values.push(x + ':' + y);
      return values;
    };
    for (const part of parts) {
      let value = { rect: part.rect, raster: part.raster, count: part.count }, changed = true;
      while (changed) {
        changed = false; const nearby = new Set();
        for (const key of keys(value.rect, 36)) for (const id of cells.get(key) || []) nearby.add(id);
        for (const id of nearby) {
          const other = active.get(id); if (!other || !close(value.rect, other.rect)) continue;
          active.delete(id);
          for (const key of other.keys) { const bucket = cells.get(key); bucket.delete(id); if (!bucket.size) cells.delete(key); }
          value = { rect: union(value.rect, other.rect), raster: value.raster || other.raster, count: value.count + other.count }; changed = true;
        }
      }
      const id = ++sequence; value.keys = keys(value.rect); active.set(id, value);
      for (const key of value.keys) { if (!cells.has(key)) cells.set(key, new Set()); cells.get(key).add(id); }
    }
    return Array.from(active.values());
  }
  function drawingParts(parts, page) {
    const width = page[2] - page[0], height = page[3] - page[1];
    const edge = r => ((r[0] <= page[0] + .5 || r[2] >= page[2] - .5) && r[2] - r[0] <= width * .05) || ((r[1] <= page[1] + .5 || r[3] >= page[3] - .5) && r[3] - r[1] <= height * .04);
    const values = parts.filter(part => !edge(part.rect));
    // An isolated hairline is usually a sidebar/running-header separator.
    // Real chart axes, arrows and scale bars touch drawing evidence nearby.
    // Index bounded geometry so a dense scatter plot never needs all pairs.
    const size = Math.max(36, width / 32, height / 32), cells = new Map();
    const keys = box => {
      const result = [];
      for (let x = Math.floor((box[0] - 3 - page[0]) / size); x <= Math.floor((box[2] + 3 - page[0]) / size); x++) for (let y = Math.floor((box[1] - 3 - page[1]) / size); y <= Math.floor((box[3] + 3 - page[1]) / size); y++) result.push(x + ':' + y);
      return result;
    };
    for (let i = 0; i < values.length; i++) for (const key of keys(values[i].rect)) { if (!cells.has(key)) cells.set(key, []); cells.get(key).push(i); }
    return values.filter((part, i) => {
      const r = part.rect, w = r[2] - r[0], h = r[3] - r[1];
      if (part.raster || Math.min(w, h) > 2 || Math.max(w, h) < Math.min(w, h) * 30) return true;
      for (const key of keys(r)) for (const j of cells.get(key) || []) if (j !== i && close(r, values[j].rect, 3)) return true;
      return false;
    });
  }
  function glyphs(chars) {
    const result = [];
    if (!chars || !Number.isInteger(chars.length) || chars.length > 100000) return result;
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i], r = rect(c?.rect);
      const rotation = c?.rotation === undefined ? 0 : c.rotation;
      if (r && typeof c.c === 'string' && c.c.length <= 32 && !c.ignorable && finite(rotation)) result.push({ rect: r, length: c.c.trim().length, rotation: ((rotation % 360) + 360) % 360, end: Boolean(c.lineBreakAfter || c.paragraphBreakAfter) });
    }
    return result;
  }
  function bodyInside(box, chars, minimum = 45, minimumWidth = 200, respectBreaks = true) {
    let line = null, count = 0, longLines = 0, previous = null, consecutive = 0;
    const finish = () => {
      if (line && count >= minimum && line[2] - line[0] >= Math.min(minimumWidth, (box[2] - box[0]) * .65)) {
        const h = line[3] - line[1], oldH = previous ? previous[3] - previous[1] : 0;
        const adjacent = previous && Math.abs(line[0] - previous[0]) <= 24 && Math.abs((line[1] + line[3] - previous[1] - previous[3]) / 2) <= Math.max(h, oldH) * 2.2;
        consecutive = adjacent ? consecutive + 1 : 1; previous = line; longLines = Math.max(longLines, consecutive);
      } else { previous = null; consecutive = 0; }
      line = null; count = 0;
    };
    for (const c of chars) {
      if (c.rotation % 180 !== 0) continue;
      const r = c.rect;
      if (r[0] >= box[0] && r[2] <= box[2] && r[1] >= box[1] && r[3] <= box[3]) {
        if (line && Math.abs((line[1] + line[3] - r[1] - r[3]) / 2) > Math.max(3, r[3] - r[1]) * .7) finish();
        line = line ? union(line, r) : r; count += c.length;
      }
      if (c.end && respectBreaks) finish();
    }
    finish(); return longLines >= 3;
  }
  function labelLines(chars) {
    // A PDF can emit one printed sentence as many text runs in arbitrary order.
    // Reassemble their geometric line before deciding it is a short plot label;
    // otherwise a caption's individual bold words can expand the crop.
    const lines = [], byRotation = new Map();
    for (const c of chars) {
      if (!c.length) continue;
      if (!byRotation.has(c.rotation)) byRotation.set(c.rotation, []);
      const angle = c.rotation * Math.PI / 180, ux = Math.cos(angle), uy = Math.sin(angle), r = c.rect;
      const along = [], across = [];
      for (const x of [r[0], r[2]]) for (const y of [r[1], r[3]]) { along.push(ux * x + uy * y); across.push(-uy * x + ux * y); }
      byRotation.get(c.rotation).push({ ...c, start: Math.min(...along), stop: Math.max(...along), center: (Math.min(...across) + Math.max(...across)) / 2, thickness: Math.max(3, Math.max(...across) - Math.min(...across)) });
    }
    for (const [rotation, values] of byRotation) {
      values.sort((a, b) => a.center - b.center || a.start - b.start);
      let row = [], reference = null;
      const finish = () => {
        row.sort((a, b) => a.start - b.start); let box = null, count = 0, previous = null;
        const flush = () => { if (box) lines.push({ rect: box, count, rotation }); box = null; count = 0; };
        for (const c of row) {
          if (previous && c.start - previous.stop > Math.max(3, Math.min(c.thickness, previous.thickness) * .8)) flush();
          box = box ? union(box, c.rect) : c.rect; count += c.length; previous = c;
        }
        flush(); row = []; reference = null;
      };
      for (const c of values) {
        if (reference && Math.abs(c.center - reference.center) > Math.max(c.thickness, reference.thickness) * .7) finish();
        row.push(c);
        if (!reference || c.thickness > reference.thickness) reference = c;
      }
      finish();
    }
    // Narrow explanatory sidebars consist of many short lines. They are prose,
    // even though each individual line fits the size of an axis label. Find
    // repeated left-aligned line stacks without inspecting document text.
    const prose = new Set(), columns = [];
    const horizontal = lines.filter(line => line.rotation % 180 === 0 && line.rect[2] - line.rect[0] >= 30 && line.rect[3] - line.rect[1] <= 24).sort((a, b) => a.rect[0] - b.rect[0]);
    for (const line of horizontal) {
      let column = columns.at(-1);
      if (!column || line.rect[0] - column.left > 6) { column = { left: line.rect[0], lines: [] }; columns.push(column); }
      column.lines.push(line);
    }
    for (const column of columns) {
      column.lines.sort((a, b) => a.rect[1] - b.rect[1]); let stack = [];
      const finish = () => { if (stack.length >= 3 && stack.filter(line => line.count >= 18).length >= 2) for (const line of stack) prose.add(line); stack = []; };
      for (const line of column.lines) {
        const old = stack.at(-1);
        if (old) {
          const a = old.rect, b = line.rect, ah = a[3] - a[1], bh = b[3] - b[1], distance = (b[1] + b[3] - a[1] - a[3]) / 2;
          if (distance < Math.min(ah, bh) * .5 || distance > Math.max(ah, bh) * 2.8 || Math.min(ah, bh) < Math.max(ah, bh) * .6) finish();
        }
        stack.push(line);
      }
      finish();
    }
    return lines.filter(line => !prose.has(line) && line.count <= 40 && line.rect[2] - line.rect[0] <= 220 && line.rect[3] - line.rect[1] <= 160).map(line => line.rect);
  }
  function includeLabels(box, labels, page) {
    let result = box;
    // Whole short labels join only the original drawing box. Never iterate
    // from added text toward a caption or paragraph below the figure.
    for (const r of labels) if (r[1] <= box[3] + 18 && close(box, r, 36)) result = union(result, r);
    return intersect(result, page) || box;
  }
  function semanticRegions(parts, page, chars, regions, exclusions) {
    if (!Array.isArray(regions) || regions.length > 64 || (exclusions !== undefined && (!Array.isArray(exclusions) || exclusions.length > 256))) return [];
    const figures = [], excluded = [];
    for (const value of regions) {
      const box = rect(value?.rect), confidence = value?.confidence;
      if (!box || !finite(confidence) || confidence < 0 || confidence > 1) return [];
      const clipped = intersect(box, page);
      if (confidence >= .35 && clipped && clipped[2] - clipped[0] >= 32 && clipped[3] - clipped[1] >= 24 && area(clipped) >= 900 && area(clipped) < area(page) * .95) figures.push({ rect: clipped, confidence });
    }
    for (const value of exclusions || []) {
      const box = rect(value?.rect), confidence = value?.confidence;
      if (!box || !finite(confidence) || confidence < 0 || confidence > 1 || !['caption', 'text', 'header'].includes(value?.kind)) return [];
      if (confidence >= .6) excluded.push({ rect: box, kind: value.kind, paragraph: value.kind === 'caption' && bodyInside(box, chars) });
    }
    const result = [], evidence = drawingParts(parts, page);
    const labelChars = chars.filter(c => { const r = c.rect, vertical = c.rotation % 180 === 90, along = vertical ? r[3] - r[1] : r[2] - r[0], across = vertical ? r[2] - r[0] : r[3] - r[1]; return c.length && across <= 64 && along <= across * Math.max(2, c.length) * 2; });
    const shortLabels = labelLines(labelChars);
    for (const figure of figures) {
      const model = figure.rect;
      const width = model[2] - model[0], height = model[3] - model[1], padding = Math.max(4, Math.min(12, Math.min(width, height) * .02));
      const touchesDrawing = r => evidence.some(part => {
        if (area(part.rect) >= area(page) * .85 || area(part.rect) >= area(model) * (part.raster ? 1.25 : .7)) return false;
        const overlap = intersect(part.rect, r); return overlap && area(overlap) >= Math.min(area(part.rect), area(r)) * .25;
      });
      const internalHeading = exclusion => {
        const e = exclusion.rect, overlap = intersect(e, model);
        if (exclusion.kind !== 'caption' || exclusion.paragraph || !overlap || area(overlap) < area(e) * .8 || bodyInside(e, chars, 18, 100, false)) return false;
        return shortLabels.some(line => {
          const covered = intersect(line, e);if (!covered || area(covered) < area(line) * .95 || area(covered) < area(e) * .5) return false;
          const glyph = labelChars.find(c => { const r = c.rect;return r[0] >= line[0] && r[1] >= line[1] && r[2] <= line[2] && r[3] <= line[3]; });
          if (!glyph || glyph.rotation % 90) return false;
          const angle = glyph.rotation * Math.PI / 180, ux = Math.round(Math.cos(angle)), uy = Math.round(Math.sin(angle));
          const project = r => { const along = [], across = [];for (const x of [r[0], r[2]]) for (const y of [r[1], r[3]]) { along.push(ux * x + uy * y);across.push(-uy * x + ux * y); }return [Math.min(...along), Math.min(...across), Math.max(...along), Math.max(...across)]; };
          const l = project(line), m = project(model), x = project(e), thickness = l[3] - l[1], crossing = x[3] - m[3];
          // A short panel title can straddle a noisy layout edge by less than
          // a glyph. Its whole line and nearby leaf graphics supply independent
          // support; a caption below the drawing or an outside header does not.
          if (crossing <= 0 || crossing > Math.min(4, thickness * .35) || x[0] < m[0] || x[2] > m[2] || x[1] < m[1]) return false;
          return evidence.some(part => {
            if (area(part.rect) >= area(page) * .85 || area(part.rect) >= area(model) * (part.raster ? 1.25 : .7)) return false;
            const p = project(part.rect), gap = l[1] - p[3], shared = Math.min(l[2], p[2]) - Math.max(l[0], p[0]);
            return gap >= 0 && gap <= Math.min(36, thickness * 3) && shared >= Math.max(2, Math.min(l[2] - l[0], p[2] - p[0]) * .1);
          });
        });
      };
      const activeExclusions = excluded.filter(exclusion => !internalHeading(exclusion));
      let limit = intersect([model[0] - padding, model[1] - padding, model[2] + padding, model[3] + padding], page);
      for (const exclusion of activeExclusions) {
        const e = exclusion.rect;
        if (!intersect(e, limit)) continue;
        const overlapX = Math.min(e[2], model[2]) - Math.max(e[0], model[0]), overlapY = Math.min(e[3], model[3]) - Math.max(e[1], model[1]);
        const captionBelow = exclusion.paragraph && e[3] <= model[1] + height * .35 && !touchesDrawing(e);
        // Only boxes crossing an outer edge constrain the figure. Text fully
        // inside a flowchart stays readable, regardless of paragraph density.
        if (overlapX >= width * .2 && ((e[1] < model[1] && e[3] <= model[1] + height * .2) || captionBelow)) limit[1] = Math.max(limit[1], e[3] + .5);
        else if (overlapX >= width * .2 && e[3] > model[3] && e[1] >= model[3] - height * .2) limit[3] = Math.min(limit[3], e[1] - .5);
        else if (overlapY >= height * .2 && e[0] < model[0] && e[2] <= model[0] + width * .2) limit[0] = Math.max(limit[0], e[2] + .5);
        else if (overlapY >= height * .2 && e[2] > model[2] && e[0] >= model[2] - width * .2) limit[2] = Math.min(limit[2], e[0] - .5);
      }
      if (!rect(limit)) continue;
      if (figure.confidence < .5) {
        // Lower scores need independent two-dimensional vector structure;
        // prose outlines, a lone bitmap and page envelopes cannot supply it.
        if (width < 64 || height < 48 || area(model) >= area(page) * .7 || bodyInside(limit, chars, 18, 100, false)) continue;
        let coverage = null, count = 0; const columns = new Set(), rows = new Set();
        for (const part of evidence) {
          const r = part.rect, overlap = intersect(r, model);
          if (part.raster || !overlap || r[2] - r[0] < 4 || r[3] - r[1] < 4 || area(r) < 80 || area(r) > area(model) * .3 || area(overlap) < area(r) * .75) continue;
          coverage = coverage ? union(coverage, overlap) : overlap; count++;
          columns.add(Math.floor(((overlap[0] + overlap[2]) / 2 - model[0]) / width * 4)); rows.add(Math.floor(((overlap[1] + overlap[3]) / 2 - model[1]) / height * 4));
        }
        if (count < 8 || columns.size < 2 || rows.size < 2 || !coverage || coverage[2] - coverage[0] < width * .5 || coverage[3] - coverage[1] < height * .5 || area(coverage) < area(model) * .25) continue;
      }
      let box = null, count = 0, raster = false;
      for (const part of evidence) {
        const overlap = intersect(part.rect, model);
        if (!overlap || (!part.raster && area(overlap) < area(part.rect) * .5)) continue;
        // A page-sized bitmap supplies pixels, not a page-sized figure bound.
        const support = intersect(part.rect, area(part.rect) > area(model) * 1.25 ? intersect(model, limit) : limit);
        if (!support) continue;
        box = box ? union(box, support) : support; count += part.count; raster ||= part.raster;
      }
      if (!box || (!raster && count < 2)) continue;
      const outside = activeExclusions.filter(e => e.rect[0] < model[0] || e.rect[1] < model[1] || e.rect[2] > model[2] || e.rect[3] > model[3]
        || ['text', 'caption'].includes(e.kind) && bodyInside(e.rect, chars, 18, 100, false) && !touchesDrawing(e.rect));
      let completeLabels = null;
      const admitLabel = (r, short = false) => {
        const middle = [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
        if (middle[0] < limit[0] || middle[0] > limit[2] || middle[1] < limit[1] || middle[1] > limit[3]) return;
        // A short label may straddle the uncertain model boundary. Retain its
        // whole glyph/line, within the original bounded padding, rather than
        // manufacturing half a printed character at that boundary.
        if (r[0] < limit[0] - padding || r[1] < limit[1] - padding || r[2] > limit[2] + padding || r[3] > limit[3] + padding || outside.some(e => intersect(e.rect, r))) return;
        // Layout boxes can start a little below a caption's long first line.
        // One glyph-height of that outside caption is still prose; existing
        // short axis labels keep their own complete, non-iterative grouping.
        if (!short && outside.some(e => e.kind === 'caption' && e.rect[3] < model[1] && intersect([e.rect[0], e.rect[1], e.rect[2], e.rect[3] + Math.min(12, r[3] - r[1])], r))
          && !shortLabels.some(label => middle[0] >= label[0] && middle[0] <= label[2] && middle[1] >= label[1] && middle[1] <= label[3])) return;
        const label = intersect(r, page); if (!label) return;
        completeLabels = completeLabels ? union(completeLabels, label) : label; box = union(box, label);
      };
      for (const c of labelChars) admitLabel(c.rect);
      // Use only lines assembled from the original glyphs. Added labels never
      // become anchors that can walk through a caption or a sidebar paragraph.
      for (const label of shortLabels) admitLabel(label, true);
      if (box[2] - box[0] < 32 || box[3] - box[1] < 24 || area(box) < 900) continue;
      // Path bounds omit stroke width and antialiasing outside outlined glyphs.
      const content = box;
      box = intersect([content[0] - 1, content[1] - 1, content[2] + 1, content[3] + 1], limit);
      for (const e of outside) if (intersect(e.rect, box)) {
        if (e.rect[2] <= content[0]) box[0] = Math.max(box[0], e.rect[2]);
        else if (e.rect[0] >= content[2]) box[2] = Math.min(box[2], e.rect[0]);
        if (e.rect[3] <= content[1]) box[1] = Math.max(box[1], e.rect[3]);
        else if (e.rect[1] >= content[3]) box[3] = Math.min(box[3], e.rect[1]);
      }
      if (completeLabels) box = intersect(union(box, completeLabels), page);
      result.push({ rect: box });
    }
    // Model scores rank detection confidence, not figure completeness. Refine
    // every candidate first, then keep the largest supported envelope before
    // removing its nested panels. Input order must not let a high-score panel
    // suppress the full figure that contains it.
    const complete = [];
    result.sort((a, b) => area(b.rect) - area(a.rect) || a.rect[0] - b.rect[0] || a.rect[1] - b.rect[1] || a.rect[2] - b.rect[2] || a.rect[3] - b.rect[3]);
    for (const candidate of result) if (!complete.some(item => { const overlap = intersect(item.rect, candidate.rect); return overlap && area(overlap) >= area(candidate.rect) * .9; })) complete.push(candidate);
    return complete.sort((a, b) => b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]);
  }
  function detectRegions(operatorList, OPS, options = {}) {
    try {
      const page = rect(options.viewBox), fns = operatorList?.fnArray, args = operatorList?.argsArray;
      if (!page || !OPS || !fns || !args || !Number.isInteger(fns.length) || fns.length > LIMIT || fns.length !== args.length) return [];
      let state = { m: IDENTITY, clip: page }, annotation = 0, pendingClip = false;
      const stack = [], groups = [], parts = [];
      const add = (box, raster) => {
        if (!box || !state.clip) return;
        if (box[0] === box[2]) box = [box[0] - .5, box[1], box[2] + .5, box[3]];
        if (box[1] === box[3]) box = [box[0], box[1] - .5, box[2], box[3] + .5];
        box = intersect(box, state.clip);
        if (!box || !state.clip) return;
        // Page-margin rules and crop marks must not turn nearby graphics into
        // a page-sized envelope. Shorter chart axes remain drawing evidence.
        const w = box[2] - box[0], h = box[3] - box[1];
        if (!raster && ((w <= 2 && h >= (page[3] - page[1]) * .65) || (h <= 2 && w >= (page[2] - page[0]) * .65))) return;
        const owners = [];
        for (const entry of stack) if (entry.group) { entry.group.count++; if (raster) entry.group.raster++; owners.push(entry.group); }
        // Gradients may be flattened into tens of thousands of consecutive
        // touching vector strips. Compact only connected drawing evidence with
        // identical Form ownership, before applying the bounded part budget.
        const previous = parts.at(-1);
        if (!raster && previous && !previous.raster && previous.owners.length === owners.length && owners.every((owner, index) => owner === previous.owners[index]) && close(previous.rect, box, .05)) {
          previous.rect = union(previous.rect, box); previous.count++; return;
        }
        if (parts.length >= MAX_PARTS) throw Error('bounded');
        parts.push({ rect: box, raster, count: 1, owners });
      };
      for (let i = 0; i < fns.length; i++) {
        // PDF.js uses null for operators without arguments (notably save/restore).
        const fn = fns[i], a = args[i] == null ? [] : args[i];
        if (!Number.isInteger(a.length)) return [];
        if (fn === OPS.beginAnnotation) { annotation++; continue; }
        if (fn === OPS.endAnnotation) { if (!annotation) return []; annotation--; continue; }
        if (annotation) continue;
        if (fn === OPS.save) { stack.push({ kind: 'save', state }); state = { ...state }; }
        else if (fn === OPS.restore) { if (stack.at(-1)?.kind !== 'save') return []; state = stack.pop().state; }
        else if (fn === OPS.transform) { const m = matrix(a); if (!m) return []; state = { ...state, m: multiply(state.m, m) }; }
        else if (fn === OPS.paintFormXObjectBegin || fn === OPS.beginGroup) {
          const form = fn === OPS.paintFormXObjectBegin, value = form ? { matrix: a[0], bbox: a[1] } : a[0];
          if (!value) return [];
          const m = value.matrix == null ? IDENTITY : matrix(value.matrix), bbox = rect(value.bbox);
          if (!m || (!bbox && (!form || value.bbox != null))) return [];
          if (!bbox) { stack.push({ kind: 'form', state }); state = { ...state, m: multiply(state.m, m) }; continue; }
          const next = multiply(state.m, m), box = transform(bbox, next), clip = box && state.clip && intersect(state.clip, box);
          const group = { rect: clip, count: 0, raster: 0 };
          // Tiny gradient/mask Forms remain on the ownership stack but cannot
          // become a standalone figure and must not exhaust the candidate cap.
          if (usable(clip, page)) groups.push(group); stack.push({ kind: form ? 'form' : 'group', state, group }); state = { m: next, clip };
        }
        else if (fn === OPS.paintFormXObjectEnd || fn === OPS.endGroup) {
          const kind = fn === OPS.paintFormXObjectEnd ? 'form' : 'group';
          if (stack.at(-1)?.kind !== kind) return []; state = stack.pop().state;
        }
        else if (fn === OPS.constructPath) {
          // PDF.js passes (paintOp, opaque native path, minMax). Never clone the path.
          const bounds = rect(a[2], true), path = bounds && transform(bounds, state.m);
          const paint = a[0];
          if (paint !== OPS.endPath && paint !== OPS.clip && paint !== OPS.eoClip && typeof paint === 'number') add(path, false);
          // PDF.js optimizes a path and its consuming paint into constructPath.
          // clip()/eoClip() precede that operator and become effective only
          // when the new path is consumed, never against the previous path.
          if (pendingClip) { state = { ...state, clip: path && state.clip && intersect(state.clip, path) }; pendingClip = false; }
        }
        else if (fn === OPS.clip || fn === OPS.eoClip) { pendingClip = true; }
        else if (fn === OPS.shadingFill) { if (state.clip && area(state.clip) < area(page) * .85) add(state.clip, false); }
        else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) { if (!a.length || a[0] == null) return []; add(transform([0, 0, 1, 1], state.m), true); }
        if (stack.length > 64 || groups.length > 256) return [];
      }
      if (stack.length || annotation || pendingClip) return [];
      const chars = glyphs(options.chars);
      if (options.layoutRegions !== undefined) return semanticRegions(parts, page, chars, options.layoutRegions, options.excludedRegions);
      const strong = groups.filter(g => usable(g.rect, page) && (g.raster || g.count >= 2));
      let candidates = parts.filter(p => area(p.rect) < area(page) * .85 && !p.owners.some(g => strong.includes(g)));
      for (const g of strong) if (!strong.some(other => other !== g && area(other.rect) > area(g.rect) && intersect(other.rect, g.rect)?.every((v, i) => v === g.rect[i]))) candidates.push({ rect: g.rect, raster: true, count: g.count });
      candidates = mergeParts(drawingParts(candidates, page), page);
      const labels = labelLines(chars), result = [];
      // Short panel labels can bridge otherwise separate drawing envelopes.
      // Rejoin those envelopes before the final paragraph rejection.
      candidates = mergeParts(candidates.map(candidate => ({ ...candidate, rect: includeLabels(candidate.rect, labels, page) })), page);
      for (const candidate of candidates) {
        const box = candidate.rect;
        if (box[2] - box[0] >= (page[2] - page[0]) * .75 && box[3] >= page[3] - (page[3] - page[1]) * .05 && box[3] - box[1] > (page[3] - page[1]) * .2) continue;
        if ((!candidate.raster && candidate.count < 3) || !usable(candidate.rect, page) || bodyInside(candidate.rect, chars)) continue;
        const item = { rect: candidate.rect };
        const captions = options.captions;
        if (captions && Number.isInteger(captions.length) && captions.length <= 200) {
          let distance = Infinity;
          for (let i = 0; i < captions.length; i++) {
            const c = captions[i], d = item.rect[1] - c?.top;
            if (finite(c?.left) && finite(c?.top) && typeof c.label === 'string' && c.label.length <= 80 && d >= -8 && d < 100 && Math.abs(c.left - item.rect[0]) < 100 && d < distance) { item.label = c.label; distance = d; }
          }
        }
        result.push(item); if (result.length > 64) return [];
      }
      return result.sort((a, b) => b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]);
    } catch (_) { return []; }
  }
  function hitRegion(regions, point) {
    if (!regions || !Number.isInteger(regions.length) || regions.length > 64 || !point || !finite(point[0]) || !finite(point[1])) return null;
    let found = null, size = Infinity;
    for (let i = 0; i < regions.length; i++) {
      const candidate = regions[i], box = rect(candidate?.rect);
      if (box && point[0] >= box[0] && point[0] <= box[2] && point[1] >= box[1] && point[1] <= box[3] && area(box) < size) { found = candidate; size = area(box); }
    }
    return found;
  }
  function renderCrop({ page, pageView, rect: requested, doc, nativeWindow, Components, maxPixels = 12000000, maxEdge = 4096 } = {}) {
    let canvas = null, task = null, finished = false, cancelled = false, rejectPromise, phase = 20;
    const error = (aborted = false) => Object.assign(new Error(aborted ? 'Figure preview cancelled' : 'Figure preview unavailable'), { name: aborted ? 'AbortError' : 'Error', code: aborted ? 'figure_cancelled' : 'figure_render', figurePhase: phase });
    const release = () => { if (canvas) { canvas.width = 0; canvas.height = 0; } };
    const Cu = Components?.utils;
    const native = value => Cu?.waiveXrays ? Cu.waiveXrays(value) : value;
    const options = value => Cu?.cloneInto && nativeWindow ? Cu.cloneInto(value, nativeWindow, { wrapReflectors: true }) : value;
    const promise = new Promise((resolve, reject) => {
      rejectPromise = reject;
      try {
        phase = 21;const source = native(page), pageBox = rect(source?.view), wanted = rect(requested), crop = wanted && pageBox && intersect(wanted, pageBox);
        if (!crop || !doc || !Number.isFinite(maxPixels) || !Number.isFinite(maxEdge) || maxPixels < 1 || maxEdge < 1) throw error();
        maxPixels = Math.min(12000000, Math.floor(maxPixels)); maxEdge = Math.min(4096, Math.floor(maxEdge));
        // Bindings use PDF coordinates; keep markup orientation stable when the
        // reader rotates its display by always using the document's own rotation.
        const value = source.rotate ?? 0, rotation = ((value % 360) + 360) % 360;
        if (![0, 90, 180, 270].includes(rotation)) throw error();
        const corners = viewport => {
          const xs = [], ys = [];
          for (const x of [crop[0], crop[2]]) for (const y of [crop[1], crop[3]]) { const p = viewport.convertToViewportPoint(x, y); if (!finite(p?.[0]) || !finite(p?.[1])) throw error(); xs.push(p[0]); ys.push(p[1]); }
          return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        };
        phase = 22;const initial = native(source.getViewport(options({ scale: 1, rotation }))), unit = corners(initial), w = unit[2] - unit[0], h = unit[3] - unit[1];
        let scale = Math.min(4, maxEdge / w, maxEdge / h, Math.sqrt(maxPixels / (w * h)));
        if (!Number.isFinite(scale) || scale <= 0) throw error();
        let viewport, box, width, height;
        for (let i = 0; i < 3; i++) {
          viewport = native(source.getViewport(options({ scale, rotation }))); box = corners(viewport);
          width = Math.ceil(box[2] - box[0]); height = Math.ceil(box[3] - box[1]);
          if (width <= maxEdge && height <= maxEdge && width * height <= maxPixels) break;
          scale *= Math.min(maxEdge / width, maxEdge / height, Math.sqrt(maxPixels / (width * height))) * .999;
        }
        if (!width || !height || width > maxEdge || height > maxEdge || width * height > maxPixels) throw error();
        phase = 23;canvas = doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas'); canvas.width = width; canvas.height = height;
        phase = 24;const context = native(canvas.getContext('2d', { alpha: false })); if (!context) throw error(); context.skipBlender = true;
        phase = 25;const parameters = options({ canvasContext: context, transform: [1, 0, 0, 1, -box[0], -box[1]], annotationMode: 0, background: 'rgb(255,255,255)' });
        parameters.viewport = viewport;
        phase = 26;task = native(source.render(parameters));
        // A returned helper and its Promise can each acquire an Xray wrapper.
        // Normalize only these exact render results before waiting for pixels.
        phase = 27;Promise.resolve(native(task.promise)).then(() => { task = null; if (!cancelled) { finished = true; resolve(canvas); } }, () => { task = null; if (!cancelled) { finished = true; release(); reject(error()); } });
      } catch (_) { finished = true; release(); reject(error()); }
    });
    return { promise, cancel() {
      if (cancelled) return; cancelled = true;
      if (!finished) { try { task?.cancel(); } catch (_) {} task = null; rejectPromise(error(true)); }
      release();
    } };
  }
  function snapshotCrop({ pageView, rect: requested, doc, maxPixels = 12000000, maxEdge = 4096 } = {}) {
    let canvas = null, source = null;
    try {
      source = pageView?.canvas;const viewport = pageView?.viewport, transformMatrix = matrix(viewport?.transform);
      if (pageView?.renderingState !== 3 || !source || !viewport || !transformMatrix || !doc || !Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < 1 || source.height < 1) return null;
      const display = viewport.rotation, intrinsic = pageView.pdfPage?.rotate ?? pageView.pdfPageRotate;
      if (![display, intrinsic].every(value => finite(value) && [0, 90, 180, 270].includes(((value % 360) + 360) % 360)) || !finite(viewport.width) || !finite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) return null;
      // PDF.js keeps the old bitmap during CSS rotation; its original viewport
      // is private. Use the completed bitmap only when that ambiguity is absent.
      const cssTransform = source.style?.transform || source.style?.getPropertyValue?.('transform') || '';
      if (cssTransform && cssTransform !== 'none') return null;
      if (!((Math.abs(transformMatrix[0]) < 1e-8 && Math.abs(transformMatrix[3]) < 1e-8) || (Math.abs(transformMatrix[1]) < 1e-8 && Math.abs(transformMatrix[2]) < 1e-8))) return null;
      const pageBox = rect(pageView.pdfPage?.view) || rect(viewport.viewBox), wanted = rect(requested), crop = pageBox && wanted && intersect(pageBox, wanted);
      if (!crop || !Number.isFinite(maxPixels) || !Number.isFinite(maxEdge) || maxPixels < 1 || maxEdge < 1) return null;
      maxPixels = Math.min(12000000, Math.floor(maxPixels));maxEdge = Math.min(4096, Math.floor(maxEdge));
      const box = transform(crop, transformMatrix), sourceWidth = source.width, sourceHeight = source.height;
      const left = Math.max(0, Math.floor(box[0] * sourceWidth / viewport.width)), top = Math.max(0, Math.floor(box[1] * sourceHeight / viewport.height));
      const right = Math.min(sourceWidth, Math.ceil(box[2] * sourceWidth / viewport.width)), bottom = Math.min(sourceHeight, Math.ceil(box[3] * sourceHeight / viewport.height));
      const width = right - left, height = bottom - top, rotation = ((intrinsic - display) % 360 + 360) % 360;
      if (width < 1 || height < 1) return null;
      const baseWidth = rotation % 180 ? height : width, baseHeight = rotation % 180 ? width : height;
      let scale = Math.min(1, maxEdge / baseWidth, maxEdge / baseHeight, Math.sqrt(maxPixels / (baseWidth * baseHeight))), outputWidth, outputHeight;
      for (let i = 0; i < 3; i++) {
        outputWidth = Math.ceil(baseWidth * scale);outputHeight = Math.ceil(baseHeight * scale);
        if (outputWidth <= maxEdge && outputHeight <= maxEdge && outputWidth * outputHeight <= maxPixels) break;
        scale *= Math.min(maxEdge / outputWidth, maxEdge / outputHeight, Math.sqrt(maxPixels / (outputWidth * outputHeight))) * .999;
      }
      if (!outputWidth || !outputHeight || outputWidth > maxEdge || outputHeight > maxEdge || outputWidth * outputHeight > maxPixels) return null;
      canvas = doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');if (canvas === source) return null;
      canvas.width = outputWidth;canvas.height = outputHeight;
      const context = canvas.getContext('2d', { alpha: false });if (!context) throw Error('snapshot');
      context.skipBlender = true;context.fillStyle = 'rgb(255,255,255)';context.fillRect(0, 0, outputWidth, outputHeight);
      const sx = outputWidth / baseWidth, sy = outputHeight / baseHeight;
      const mapping = rotation === 90 ? [0, sy, -sx, 0, outputWidth, 0] : rotation === 180 ? [-sx, 0, 0, -sy, outputWidth, outputHeight] : rotation === 270 ? [0, -sy, sx, 0, 0, outputHeight] : [sx, 0, 0, sy, 0, 0];
      context.setTransform(...mapping);context.drawImage(source, left, top, width, height, 0, 0, width, height);
      if (pageView.canvas !== source || pageView.viewport !== viewport || pageView.renderingState !== 3 || source.width !== sourceWidth || source.height !== sourceHeight) throw Error('snapshot');
      return canvas;
    } catch (_) { if (canvas && canvas !== source) { try { canvas.width = canvas.height = 0; } catch (_) {} } return null; }
  }
  const api = { detectRegions, hitRegion, renderCrop, snapshotCrop };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AskGPTPDFFigureRegion = api;
})(this);
