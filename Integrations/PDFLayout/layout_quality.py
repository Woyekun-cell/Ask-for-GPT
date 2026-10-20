"""Conservative layout repairs for BabelDOC 0.6.4's existing vector IR.

No text is inferred or removed. Metadata retains its original glyphs. A caption
word split at a touching same-font glyph is reunited before translation. Only
translated short table lines are fitted using the target font's real metrics.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from copy import copy
import math
import re
import threading

_LOCK = threading.Lock()
_PAGES = {}  # Slotted engine dataclasses cannot carry temporary source data.
_NAME_INITIALS = re.compile(r"\b[A-Z][a-z]+\s+(?:[A-Z]\.\s*)+[A-Z][A-Za-z'’-]+")
_NAMES_LIST = re.compile(r"\b[A-Z][a-z]+\s+[A-Z][a-z]+(?:\s*[,;，]\s*\d*)")
_EMAIL = re.compile(r"(?:e[ -]?mail\s*:\s*)?[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", re.I)
_DOI = re.compile(r"(?:https?://(?:dx\.)?doi\.org/|doi\s*:\s*)?10\.\d{4,9}/[^\s]+", re.I)
_CAPTIONS = {"table_caption", "figure_caption"}
CONTENT_POLICY = "figure-original-table-header-v1"
_REGION_PROSE = _CAPTIONS | {"table_footnote", "figure_footnote"}
_PROSE_LABELS = {"plain text", "text", "paragraph", "body", "fallback_line"}
TYPOGRAPHY_REVISION = "source-style-prose-v1"


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _box(value):
    if value is None: return None
    values = tuple(getattr(value, key, None) for key in ("x", "y", "x2", "y2"))
    return values if all(_number(x) for x in values) and values[2] >= values[0] and values[3] >= values[1] else None


def _characters(paragraph):
    for comp in getattr(paragraph, "pdf_paragraph_composition", ()):
        char = getattr(comp, "pdf_character", None)
        if char is not None: yield char
        for key in ("pdf_line", "pdf_same_style_characters", "pdf_formula"):
            group = getattr(comp, key, None)
            if group is not None: yield from getattr(group, "pdf_character", ())


def _union(boxes):
    boxes = [x for x in boxes if x is not None]
    if not boxes: return None
    return min(x[0] for x in boxes), min(x[1] for x in boxes), max(x[2] for x in boxes), max(x[3] for x in boxes)


def _source_bounds(paragraph):
    return _union(_box(getattr(getattr(c, "visual_bbox", None), "box", None)) or _box(getattr(c, "box", None))
                  for c in _characters(paragraph)) or _box(getattr(paragraph, "box", None))


def _source_font_bounds(paragraph, fonts):
    boxes = []
    for char in _characters(paragraph):
        bounds, size = _box(getattr(char, "box", None)), _font_size(char)
        font = fonts.get(getattr(getattr(char, "pdf_style", None), "font_id", None))
        ascent, descent = getattr(font, "ascent", None), getattr(font, "descent", None)
        if bounds is None or size is None or not _number(ascent) or not _number(descent): return None
        if max(abs(ascent), abs(descent)) > 4: ascent, descent = ascent / 1000, descent / 1000
        if not 0 < ascent - descent < 4: return None
        boxes.append((bounds[0], bounds[1] + descent * size, bounds[2], bounds[1] + ascent * size))
    return _union(boxes)


def _font_size(char):
    value = getattr(getattr(char, "pdf_style", None), "font_size", None)
    return value if _number(value) and value > 0 else None


def _prose_typography(paragraph, chars, fonts):
    """Source-only typography; target length never determines a style cohort."""
    if (getattr(paragraph, "vertical", False)
            or getattr(paragraph, "layout_label", None) not in _PROSE_LABELS): return None
    weights = Counter()
    for char in chars:
        text = "".join((getattr(char, "char_unicode", "") or "").split())
        size = _font_size(char)
        font = fonts.get(getattr(getattr(char, "pdf_style", None), "font_id", None))
        name = getattr(font, "name", None)
        if not text or size is None or not isinstance(name, str) or not name: continue
        # A PDF subset prefix is not a distinct face. Weight/italic and exact
        # source size keep headings, emphasis, references and body separate.
        name = re.sub(r"^[A-Z]{6}\+", "", name)
        key = (name, round(size, 2), bool(getattr(font, "bold", False)), bool(getattr(font, "italic", False)))
        weights[key] += len(text)
    if not weights: return None
    key, count = weights.most_common(1)[0]
    total = sum(weights.values())
    # Short labels/cells and a mixed-font run provide no reliable prose style.
    if total < 20 or count < total * .65: return None
    return key


def _same_inline_word(previous, tail):
    text, suffix = getattr(previous, "unicode", "") or "", getattr(tail, "unicode", "") or ""
    previous_label, tail_label = getattr(previous, "layout_label", None), getattr(tail, "layout_label", None)
    classic = previous_label in _CAPTIONS and tail_label == "fallback_line" and re.fullmatch(r"[a-z]{1,2}", suffix)
    # The layout model can assign only the second font fragment to a caption:
    # "Table 1 | ... sequ" (fallback) + "ences from ..." (caption). The real
    # touching same-baseline boundary below proves a split word, not prose.
    table = ((previous_label == "table_caption" and tail_label in {"fallback_line", "table_caption"})
             or (previous_label == "fallback_line" and tail_label == "table_caption"
                 and re.match(r"^Table\s+\d+[A-Za-z]?\s*[|:.]", text)))
    if not ((classic or table and re.match(r"[a-z]", suffix)) and re.search(r"[a-z]$", text)):
        return False
    a, b = list(_characters(previous)), list(_characters(tail))
    if not a or not b: return False
    last, first = a[-1], b[0]
    ab, bb = _box(getattr(last, "box", None)), _box(getattr(first, "box", None))
    sa, sb = _font_size(last), _font_size(first)
    if ab is None or bb is None or sa is None or sb is None: return False
    return (getattr(last, "xobj_id", None) == getattr(first, "xobj_id", None)
            and getattr(last.pdf_style, "font_id", None) == getattr(first.pdf_style, "font_id", None)
            and abs(sa - sb) <= .05 and abs(ab[1] - bb[1]) <= .05
            and -.05 <= bb[0] - ab[2] <= min(.5, sa * .06))


def _join_caption_tails(page):
    paragraphs = getattr(page, "pdf_paragraph", None)
    if not isinstance(paragraphs, list): return
    index = 1
    while index < len(paragraphs):
        previous, tail = paragraphs[index - 1], paragraphs[index]
        if not _same_inline_word(previous, tail):
            index += 1
            continue
        previous.unicode += tail.unicode
        if getattr(tail, "layout_label", None) == "table_caption": previous.layout_label = "table_caption"
        previous.pdf_paragraph_composition.extend(tail.pdf_paragraph_composition)
        a, b = _box(previous.box), _box(tail.box)
        if a and b:
            previous.box = copy(previous.box)
            previous.box.x, previous.box.y = min(a[0], b[0]), min(a[1], b[1])
            previous.box.x2, previous.box.y2 = max(a[2], b[2]), max(a[3], b[3])
        paragraphs.pop(index)


def _header_phrase(text):
    # Geometry/font alone cannot distinguish a bold header from bold data
    # labels. Keep this to unambiguous compound measurement headers.
    text = " ".join(text.casefold().split())
    return any(re.fullmatch(pattern, text) for pattern in (
        r"read (?:accuracy|length)(?:\s*\([^)]{1,24}\))?",
        r"sequencing technology",
        r"throughput per flow cell(?:\s*\([^)]{1,24}\))?",
        r"estimated cost per(?: gb(?:\s*\([^)]{1,24}\))?)?",
        r"maximum throughput per(?: year(?:\s*\([^)]{1,24}\))?[a-z]?)?",
    ))


def _header_formula_safe(paragraph, size):
    for comp in getattr(paragraph, "pdf_paragraph_composition", ()):
        formula = getattr(comp, "pdf_formula", None)
        if formula is None: continue
        chars = list(getattr(formula, "pdf_character", ()))
        text = "".join(getattr(c, "char_unicode", "") or "" for c in chars).strip()
        # Retain a genuine small superscript table-note marker. Equations and
        # full-size formula/variable groups never participate in header merges.
        if not re.fullmatch(r"[a-z]", text) or any((_font_size(c) or size) >= size * .8 for c in chars):
            return False
    return True


def _join_table_header_lines(page):
    paragraphs = getattr(page, "pdf_paragraph", None)
    if not isinstance(paragraphs, list): return
    captions = [_source_bounds(p) for p in paragraphs if getattr(p, "layout_label", None) == "table_caption"]
    captions = [b for b in captions if b is not None]
    if not captions: return
    fonts = {getattr(f, "font_id", None): f for f in getattr(page, "pdf_font", ())}
    floors = {}
    for paragraph in paragraphs:
        b = _source_bounds(paragraph)
        chars = list(_characters(paragraph))
        sizes = [s for c in chars if (s := _font_size(c)) is not None]
        if (b is None or not sizes or max(sizes) > 11 or b[3] - b[1] > 24
                or getattr(paragraph, "layout_label", None) != "fallback_line"): continue
        higher = [caption[1] for caption in captions if 0 < caption[1] - b[3] < 500]
        if not higher: continue
        main = [c for c in chars if (_font_size(c) or 0) >= max(sizes) * .8]
        if main and all(getattr(fonts.get(getattr(c.pdf_style, "font_id", None)), "bold", None) is False
                        or getattr(fonts.get(getattr(c.pdf_style, "font_id", None)), "bold", None) == 0 for c in main):
            caption_y = min(higher)
            floors[caption_y] = max(floors.get(caption_y, -math.inf), b[3])
    headers = []
    for paragraph in paragraphs:
        bounds, chars = _source_bounds(paragraph), list(_characters(paragraph))
        sizes = [s for c in chars if (s := _font_size(c)) is not None]
        if (getattr(paragraph, "layout_label", None) != "fallback_line" or bounds is None or not sizes
                or max(sizes) > 11 or bounds[3] - bounds[1] > 24 or bounds[2] - bounds[0] > 160
                or not any(0 <= b[1] - bounds[3] < 500 for b in captions)): continue
        higher = [caption[1] for caption in captions if 0 <= caption[1] - bounds[3] < 500]
        caption_y = min(higher)
        if bounds[1] <= floors.get(caption_y, -math.inf) or not _header_formula_safe(paragraph, max(sizes)): continue
        main = [c for c in chars if (_font_size(c) or 0) >= max(sizes) * .8]
        ids = {getattr(c.pdf_style, "font_id", None) for c in main}
        if len(ids) != 1 or not main: continue
        identity = next(iter(ids))
        if not getattr(fonts.get(identity), "bold", False): continue
        baselines = [_box(c.box)[1] for c in main if _box(getattr(c, "box", None))]
        if not baselines or max(baselines) - min(baselines) > .2: continue
        headers.append({"paragraph": paragraph, "font": identity, "size": max(sizes), "caption": caption_y,
                        "x": bounds[0], "top": max(baselines), "bottom": min(baselines), "lines": 1})
    tops = {}
    for header in headers: tops[header["caption"]] = max(tops.get(header["caption"], -math.inf), header["top"])
    removed = set()
    for header in sorted(headers, key=lambda h: (-h["top"], h["x"])):
        if id(header["paragraph"]) in removed: continue
        if header["top"] < tops[header["caption"]] - header["size"] * .5: continue
        while header["lines"] < 4:
            matches = [h for h in headers if id(h["paragraph"]) not in removed and h is not header
                       and h["font"] == header["font"] and abs(h["size"] - header["size"]) < .1
                       and abs(h["x"] - header["x"]) < 1.25
                       and .5 * header["size"] < header["bottom"] - h["top"] < 1.8 * header["size"]]
            if not matches: break
            lower = min(matches, key=lambda h: header["bottom"] - h["top"])
            if not _header_phrase((header["paragraph"].unicode or "") + " " + (lower["paragraph"].unicode or "")): break
            # A drawn horizontal rule separates parent/subheaders (Read length
            # versus N50/Maximum) even when their left edges coincide.
            barrier = False
            for curve in getattr(page, "pdf_curve", ()):
                b = _box(getattr(curve, "box", None))
                if (b and b[3] - b[1] <= .15 and b[2] - b[0] >= 5
                        and lower["top"] < b[1] < header["bottom"]
                        and b[0] <= header["x"] + 1 and b[2] >= header["x"] + 5):
                    barrier = True
                    break
            if barrier: break
            upper_p, lower_p = header["paragraph"], lower["paragraph"]
            upper_p.unicode = (upper_p.unicode or "") + " " + (lower_p.unicode or "")
            upper_p.pdf_paragraph_composition.extend(lower_p.pdf_paragraph_composition)
            a, b = _box(upper_p.box), _box(lower_p.box)
            if a and b:
                upper_p.box = copy(upper_p.box)
                upper_p.box.x, upper_p.box.y = min(a[0], b[0]), min(a[1], b[1])
                upper_p.box.x2, upper_p.box.y2 = max(a[2], b[2]), max(a[3], b[3])
            removed.add(id(lower_p))
            header["bottom"], header["lines"] = lower["bottom"], header["lines"] + lower["lines"]
    if removed: paragraphs[:] = [p for p in paragraphs if id(p) not in removed]


def _metadata(page, paragraph, bounds):
    text = " ".join((getattr(paragraph, "unicode", "") or "").split())
    if not text or len(text) > 500: return False
    if _EMAIL.fullmatch(text) or _DOI.fullmatch(text): return True
    crop = _box(getattr(getattr(page, "cropbox", None), "box", None))
    if getattr(page, "page_number", None) != 0 or crop is None or bounds is None: return False
    # A bibliography or a sentence that happens to cite two names is not a byline.
    if bounds[1] < crop[1] + (crop[3] - crop[1]) * .55 or len(text.split()) > 65: return False
    if len(_NAME_INITIALS.findall(text)) >= 2:
        remainder = _NAME_INITIALS.sub("", text)
        remainder = re.sub(r"\b(?:and|orcid|id|md|phd)\b", "", remainder, flags=re.I)
        return re.search(r"[A-Za-z]", remainder) is None
    return len(_NAMES_LIST.findall(text)) >= 3 and not re.search(r"[.!?。]($|\s+[A-Z])", text)


def _inside(bounds, region, tolerance=1.):
    return (bounds is not None and bounds[0] >= region[0] - tolerance
            and bounds[1] >= region[1] - tolerance and bounds[2] <= region[2] + tolerance
            and bounds[3] <= region[3] + tolerance)


def _full_table_rules(page, region):
    """Recover a real cross-table rule from adjacent PDF path segments."""
    lines = []
    width = region[2] - region[0]
    for item in [*getattr(page, "pdf_curve", ()), *getattr(page, "pdf_rectangle", ())]:
        b = _box(getattr(item, "box", None))
        if (b is None or b[3] - b[1] > .7 or b[2] - b[0] < 4
                or not region[1] - 1 <= (b[1] + b[3]) / 2 <= region[3] + 1): continue
        left, right = max(b[0], region[0]), min(b[2], region[2])
        if right > left: lines.append(((b[1] + b[3]) / 2, left, right))
    groups = []
    for y, left, right in sorted(lines, reverse=True):
        group = next((g for g in groups if abs(g[0] - y) <= .5), None)
        if group is None:
            group = [y, []];groups.append(group)
        group[1].append((left, right))
    result = []
    for y, intervals in groups:
        merged = []
        for left, right in sorted(intervals):
            if merged and left <= merged[-1][1] + 1.5:
                merged[-1][1] = max(merged[-1][1], right)
            else: merged.append([left, right])
        # A large gap is a subheader rule, not a table-wide row boundary.
        if len(merged) == 1 and merged[0][1] - merged[0][0] >= .85 * width:
            result.append(y)
    return sorted(result, reverse=True)


def _columns(rows):
    right, count = -math.inf, 0
    for row in sorted(rows, key=lambda r: r[1][0]):
        b = row[1]
        if b[0] >= right + 2:
            right, count = b[2], count + 1
    return count


def _numeric_cell(paragraph):
    text = (getattr(paragraph, "unicode", "") or "").strip()
    # Numeric measurements, ranges and their table-note suffixes are data.
    # A header such as N50 or Read length (kb) does not start with a number.
    return re.match(r"^[\[(]?\s*[<>≤≥≈~+−–-]?\s*\d", text) is not None


def _tabular_rows(rows):
    # A real table has repeated aligned cell rows. A caption next to a model
    # mistake must not turn one long prose paragraph into an untranslated table.
    tops = sorted({b[3] for _, b in rows}, reverse=True)
    used, count = [], 0
    for top in tops:
        if any(abs(top - previous) <= 12 for previous in used): continue
        row = [r for r in rows if abs(r[1][3] - top) <= 3]
        if _columns(row) >= 2:
            used.append(top);count += 1
            if count >= 2: return True
    return False


def _table_headers(rows, rules):
    """Allow only a header above the first structurally supported data rule.

    Fonts/boldness never identify headers. Ambiguous or borderless tables keep
    all cells unchanged instead of allowing a data row to become a header.
    """
    for y in rules:
        above = [r for r in rows if r[1][1] >= y + .2]
        below = [r for r in rows if r[1][3] <= y + .2]
        if _columns(above) < 2 or not below: continue
        # Never choose a later data-row separator when an earlier numeric row
        # would thereby be included in the purported header band.
        if any(_numeric_cell(p) for p, _ in above): return set()
        top = max(b[3] for _, b in below)
        first_row = [r for r in below if r[1][3] >= top - 12]
        if _columns([r for r in first_row if _numeric_cell(r[0])]) < 2:
            return set()
        return {id(p) for p, _ in above}
    return set()


def _rule_columns(page, region, separator):
    """Only adjacent, explicitly drawn cell segments prove column edges."""
    intervals = set()
    for item in [*getattr(page, "pdf_curve", ()), *getattr(page, "pdf_rectangle", ())]:
        b = _box(getattr(item, "box", None))
        if (b is None or b[3] - b[1] > .7 or b[2] - b[0] < 4
                or abs((b[1] + b[3]) / 2 - separator) > .5): continue
        left, right = max(b[0], region[0]), min(b[2], region[2])
        if right > left: intervals.add((round(left, 3), round(right, 3)))
    spans = sorted(intervals)
    if len(spans) < 2: return None
    width = region[2] - region[0]
    if spans[0][0] > region[0] + max(2, .05 * width) or spans[-1][1] < region[2] - max(2, .05 * width): return None
    # A full-width line overlaid on cell rules, or crossing/overlapping rules,
    # is ambiguous. Do not invent a partition by font, text, or equal spacing.
    if any(not -.5 <= spans[i + 1][0] - spans[i][1] <= 1.5 for i in range(len(spans) - 1)): return None
    return [spans[0][0]] + [(a[1] + b[0]) / 2 for a, b in zip(spans, spans[1:])] + [spans[-1][1]]


def _merge_cell(paragraphs):
    if len(paragraphs) < 2: return None
    rows = []
    for paragraph in paragraphs:
        chars = list(_characters(paragraph));sizes = [_font_size(c) for c in chars if _font_size(c)]
        if not chars or not sizes or getattr(paragraph, "vertical", False) or not _header_formula_safe(paragraph, max(sizes)): return None
        main = [c for c in chars if (_font_size(c) or 0) >= max(sizes) * .8 and _box(getattr(c, "box", None))]
        if not main: return None
        baselines = [c.box.y for c in main]
        rows.append((paragraph, max(baselines), min(baselines), _source_bounds(paragraph), max(sizes)))
    if len({getattr(p, "xobj_id", None) for p, *_ in rows}) != 1: return None
    rows.sort(key=lambda row: (-row[1], row[3][0]))
    for previous, following in zip(rows, rows[1:]):
        gap = previous[2] - following[1]
        if gap < -.25 or gap > 2.2 * max(previous[4], following[4]): return None
        if abs(previous[1] - following[1]) <= .25 and following[3][0] < previous[3][2] - .1: return None
    first = rows[0][0]
    first.unicode = " ".join((getattr(row[0], "unicode", "") or "").strip() for row in rows)
    first.pdf_paragraph_composition = [comp for row in rows for comp in row[0].pdf_paragraph_composition]
    bounds = _union(_box(row[0].box) for row in rows)
    if bounds is not None:
        first.box = copy(first.box)
        first.box.x, first.box.y, first.box.x2, first.box.y2 = bounds
    return first


def _join_table_cell_fragments(page):
    """Merge only structural column headings and complete first-column rows.

    Other table data never enter this path. Existing geometry/numeric evidence
    proves the header separator, then the PDF's segmented rule proves each
    column; no keyword, font weight, nearest-cell, or proportional heuristic.
    """
    paragraphs = getattr(page, "pdf_paragraph", None)
    if not isinstance(paragraphs, list): return
    removed = set()
    for layout in getattr(page, "page_layout", ()):
        region = _box(getattr(layout, "box", None))
        confidence = getattr(layout, "conf", 0)
        if getattr(layout, "class_name", None) != "table" or not _number(confidence) or confidence < .9 or region is None: continue
        rows = [(p, _source_bounds(p)) for p in paragraphs if id(p) not in removed
                and getattr(p, "layout_label", None) not in _REGION_PROSE and _inside(_source_bounds(p), region)]
        if not _tabular_rows(rows): continue
        rules = _full_table_rules(page, region);headers = _table_headers(rows, rules)
        if not headers: continue
        header_bottom = min(b[1] for p, b in rows if id(p) in headers)
        below = [y for y in rules if y < header_bottom]
        if not below: continue
        separator = max(below);columns = _rule_columns(page, region, separator)
        if columns is None: continue
        cells = {}
        for paragraph, bounds in rows:
            slots = [i for i, (left, right) in enumerate(zip(columns, columns[1:]))
                     if bounds[0] >= left - 1 and bounds[2] <= right + 1]
            if len(slots) != 1: continue
            column = slots[0]
            if id(paragraph) in headers: key = ("header", column)
            elif column == 0:
                bands = [(high, low) for high, low in zip(rules, rules[1:]) if high <= separator + .5]
                slots = [i for i, (high, low) in enumerate(bands) if bounds[1] >= low - .2 and bounds[3] <= high + .2]
                if len(slots) != 1: continue
                key = ("row", slots[0])
            else: continue
            cells.setdefault(key, []).append(paragraph)
        for group in cells.values():
            merged = _merge_cell(group)
            if merged is not None: removed.update(id(p) for p in group if p is not merged)
    if removed: paragraphs[:] = [p for p in paragraphs if id(p) not in removed]


def _diagram_region(page, rows, region):
    # Some vector figures are scored below 0.5 and have their full legend on
    # the following page. Require both many short labels and real drawing
    # paths; a weak model box or a prose column alone is insufficient.
    if len(rows) < 6: return False
    short = [(p, b) for p, b in rows if len((getattr(p, "unicode", "") or "").strip()) <= 120
             and b[3] - b[1] <= 24]
    if len(short) < 6 or len(short) < .8 * len(rows): return False
    paths = 0
    for curve in getattr(page, "pdf_curve", ()):
        b = _box(getattr(curve, "box", None))
        if _inside(b, region) and max(b[2] - b[0], b[3] - b[1]) >= 2:
            paths += 1
            if paths >= 8: return True
    return False


def _panel_heading(paragraph, bounds):
    text = (getattr(paragraph, "unicode", "") or "").strip()
    return (getattr(paragraph, "layout_label", None) == "figure_caption"
            and bounds[3] - bounds[1] <= 20 and len(text) <= 120
            and re.match(r"^[A-Za-z]\s+\S", text) is not None)


def _row_label_text(paragraph):
    text = (getattr(paragraph, "unicode", "") or "").strip()
    # Keep measurements, model/sample/accession IDs and bare abbreviations as
    # original glyphs. A proven first-column population description may include
    # an original consortium/accession token after a comma. Recognize that
    # narrow syntax rather than treating an arbitrary ID as descriptive text.
    if not text or len(text) > 160: return False
    parts = [part.strip() for part in text.split(",")]
    if (len(parts) == 2
            and re.fullmatch(r"(?:mixed|[a-z]{2,}(?:ish|ese))", parts[0], re.I)):
        identifier = re.sub(r"^data\s+from\s+", "", parts[1], flags=re.I)
        if (re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{1,31}", identifier)
                and len(re.findall(r"[A-Za-z]", identifier)) >= 2
                and any(c.isupper() for c in identifier)
                and (any(c.isdigit() for c in identifier) or re.search(r"[a-z][A-Z]", identifier))):
            return True
    if re.search(r"[\d_./:@\\]", text) or re.search(r"[a-z][A-Z]", text): return False
    words = re.findall(r"[A-Za-z]+", text)
    if not words or any(len(word) > 1 and word.isupper() for word in words): return False
    return any(len(word) >= 3 and sum(char.islower() for char in word) >= 2 for word in words)


def _table_row_labels(page, rows, headers, rules):
    headings = [(p, b) for p, b in rows if id(p) in headers]
    if not headings: return set()
    left = min(b[0] for _, b in headings)
    first = [(p, b) for p, b in headings if abs(b[0] - left) <= 2]
    other = [b[0] for _, b in headings if b[0] > left + 2]
    if not other: return set()
    next_left, first_right = min(other), max(b[2] for _, b in first)
    if next_left - first_right < 3: return set()
    boundary = (first_right + next_left) / 2
    bottom = min(b[1] for _, b in headings)
    separators = [y for y in rules if y < bottom]
    if not separators: return set()
    separator = max(separators)
    # Prefer a real column boundary where the full header rule was emitted as
    # adjacent cell-sized paths; otherwise stay inside the header's whitespace.
    endpoints = []
    for curve in getattr(page, "pdf_curve", ()):
        b = _box(getattr(curve, "box", None))
        if b and b[3] - b[1] <= .7 and abs((b[1] + b[3]) / 2 - separator) <= .5:
            endpoints.extend(x for x in (b[0], b[2]) if first_right + 1 <= x <= next_left - 1)
    if endpoints: boundary = min(endpoints, key=lambda x: abs(x - boundary))
    return {id(p) for p, b in rows if id(p) not in headers and b[3] <= separator + .2
            and b[0] >= left - 2 and b[2] <= boundary - .5 and _row_label_text(p)}


def _content_protection(page, header_ids=None, row_label_ids=None):
    """Keep figure labels and table data in the original vector text layer."""
    paragraphs = [(p, _source_bounds(p)) for p in getattr(page, "pdf_paragraph", ())]
    prose = [(p, b) for p, b in paragraphs if b is not None
             and getattr(p, "layout_label", None) in _REGION_PROSE]
    protected = set()
    for layout in getattr(page, "page_layout", ()):
        kind, confidence = getattr(layout, "class_name", None), getattr(layout, "conf", None)
        region = _box(getattr(layout, "box", None))
        if (kind not in {"figure", "table"} or not _number(confidence) or confidence < .25
                or region is None or region[2] - region[0] < 8 or region[3] - region[1] < 8): continue
        caption = any(getattr(p, "layout_label", None) == kind + "_caption"
                      and min(b[2], region[2]) - max(b[0], region[0]) > .25 * min(b[2] - b[0], region[2] - region[0])
                      and (abs(b[3] - region[1]) <= 40
                           or kind == "table" and abs(b[1] - region[3]) <= 40) for p, b in prose)
        # DocLayout can give a true multi-panel figure 0.6 confidence. A nearby
        # explicitly classified figure caption provides independent support;
        # unsupported weak regions must never freeze normal article prose.
        rows = [(p, b) for p, b in paragraphs if _inside(b, region)
                and (getattr(p, "layout_label", None) not in _REGION_PROSE
                     or kind == "figure" and _panel_heading(p, b))]
        if confidence < .8 and (kind != "figure" or not (
                confidence >= .5 and caption or _diagram_region(page, rows, region))): continue
        if kind == "figure":
            protected.update(id(p) for p, _ in rows)
            continue
        if not _tabular_rows(rows): continue
        rules = _full_table_rules(page, region)
        headers = _table_headers(rows, rules)
        # A model label alone must not freeze a prose paragraph misclassified
        # as a table. Require a nearby table caption or a verified row boundary.
        if not caption and not headers: continue
        row_labels = _table_row_labels(page, rows, headers, rules)
        protected.update(id(p) for p, _ in rows if id(p) not in headers and id(p) not in row_labels)
        if header_ids is not None: header_ids.update(headers)
        if row_label_ids is not None: row_label_ids.update(row_labels)
    return protected


def protect_source_page(page):
    from paragraph_continuity import join_prose_fragments
    join_prose_fragments(page)
    """Return paragraph object IDs which must bypass translation, unchanged."""
    _join_caption_tails(page)
    _join_table_cell_fragments(page)
    _join_table_header_lines(page)
    header_ids, row_label_ids = set(), set()
    rows, protected = [], _content_protection(page, header_ids, row_label_ids)
    source_fonts = {getattr(f, "font_id", None): f for f in getattr(page, "pdf_font", ())}
    for paragraph in getattr(page, "pdf_paragraph", ()):
        bounds = _source_bounds(paragraph)
        chars = list(_characters(paragraph))
        sizes = [size for char in chars if (size := _font_size(char)) is not None]
        if _metadata(page, paragraph, bounds): protected.add(id(paragraph))
        if bounds is not None:
            rows.append({"id": id(paragraph), "bounds": bounds,
                         "size": max(sizes) if sizes else None,
                         "text": getattr(paragraph, "unicode", "") or "",
                         "label": getattr(paragraph, "layout_label", "") or "",
                         "tableHeader": id(paragraph) in header_ids,
                         "tableRowLabel": id(paragraph) in row_label_ids,
                         "fontBounds": _source_font_bounds(paragraph, source_fonts),
                         "typography": _prose_typography(paragraph, chars, source_fonts),
                         "glyphs": {id(c) for c in chars}})
    with _LOCK:
        if len(_PAGES) >= 2048: _PAGES.pop(next(iter(_PAGES)))
        _PAGES[id(page)] = (page, rows, protected)
    return protected


def _prose_row(page, paragraph):
    with _LOCK:
        captured = _PAGES.get(id(page))
        if captured is None or captured[0] is not page or id(paragraph) in captured[2]: return None
        row = next((r for r in captured[1] if r["id"] == id(paragraph)), None)
        if (row is None or row.get("typography") is None
                or row.get("tableHeader") or row.get("tableRowLabel")): return None
        return row


def prose_expansion_box(page, paragraph):
    """Use at most one line of proven empty space before reducing prose size.

    Only the private target layout box changes. Source glyphs/boxes, images,
    tables, neighboring text, paragraph order and the page geometry stay fixed.
    """
    row = _prose_row(page, paragraph)
    bounds = _box(getattr(paragraph, "box", None))
    crop = _box(getattr(getattr(page, "cropbox", None), "box", None))
    if row is None or bounds is None or crop is None: return None
    size = row["typography"][1]
    # Preserve a real inter-paragraph gap and room for the target descender.
    margin = max(2., size * .4)
    floor = max(crop[1] + margin, bounds[1] - size * 1.8)
    with _LOCK:
        captured = _PAGES.get(id(page))
        if captured is None or captured[0] is not page: return None
        obstacles = [r.get("fontBounds") or r["bounds"] for r in captured[1] if r is not row]
    for key in ("pdf_character", "pdf_figure", "pdf_curve", "pdf_rectangle", "page_layout"):
        for item in getattr(page, key, ()):
            if key == "page_layout" and getattr(item, "class_name", None) not in {"figure", "table", "isolate_formula"}: continue
            obstacle = _box(getattr(item, "box", None))
            if obstacle is not None: obstacles.append(obstacle)
    for other in obstacles:
        if other[0] >= bounds[2] or other[2] <= bounds[0]: continue
        if other[3] <= bounds[1] + .05:
            floor = max(floor, other[3] + margin)
        elif other[1] < bounds[1] - .05 and other[3] < bounds[3] - .05:
            # An obstacle already intersects the lower edge. Its visible
            # occupancy makes any downward extension ambiguous.
            return None
    if floor >= bounds[1] - .5: return None
    expanded = copy(paragraph.box)
    expanded.y = floor
    return expanded


def harmonize_typeset_scales(document):
    """Reduce small variations without sacrificing source typography hierarchy.

    The engine still lays out each target glyph. No PDF text is post-scaled,
    and original emphasis/superscript ratios remain part of the same run.
    """
    groups, source_sizes = defaultdict(list), set()
    stats = {"uniformProseGroups": 0, "uniformProseParagraphs": 0, "skippedSmallScaleParagraphs": 0}
    for page in getattr(document, "page", ()):
        with _LOCK: captured = _PAGES.get(id(page))
        if captured is not None and captured[0] is page:
            for row in captured[1]:
                if row["label"] in _PROSE_LABELS | _CAPTIONS | {"title", "table_footnote", "figure_footnote"}:
                    size = row["typography"][1] if row.get("typography") else row.get("size")
                    if _number(size) and size > 0: source_sizes.add(size)
        for paragraph in getattr(page, "pdf_paragraph", ()):
            row = _prose_row(page, paragraph)
            scale = getattr(paragraph, "optimal_scale", None)
            if row is None or not _number(scale) or not 0 < scale <= 1: continue
            # A pathological cramped fragment must not make the rest of a
            # document microscopic. It keeps the engine's local fit instead.
            if scale < .8 - 1e-6:
                stats["skippedSmallScaleParagraphs"] += 1
                continue
            groups[row["typography"]].append((paragraph, scale))
    for typography, rows in groups.items():
        if len(rows) < 2: continue
        size = typography[1]
        lower = max((s for s in source_sizes if s < size - .05), default=0.)
        # Do not push body below a smaller original heading/caption level or
        # shrink readable six-point references further. A tight local box keeps
        # its engine fit; it never dictates a tiny size for the whole document.
        floor = max(.95, lower / size, 6. / size)
        safe = [(paragraph, scale) for paragraph, scale in rows if scale >= floor - 1e-6]
        if len(safe) < 2: continue
        common = min(scale for _, scale in safe)
        changed = [(paragraph, scale) for paragraph, scale in safe if scale > common + 1e-6]
        if not changed: continue
        for paragraph, _ in changed: paragraph.optimal_scale = common
        stats["uniformProseGroups"] += 1
        stats["uniformProseParagraphs"] += len(changed)
    return stats


def is_table_header(page, paragraph):
    """Only the exact source object confirmed in this page's structural audit."""
    with _LOCK:
        captured = _PAGES.get(id(page))
        return bool(captured is not None and captured[0] is page
                    and any(row["id"] == id(paragraph) and row.get("tableHeader", False)
                            for row in captured[1]))


def is_table_row_label(page, paragraph):
    with _LOCK:
        captured = _PAGES.get(id(page))
        return bool(captured is not None and captured[0] is page
                    and any(row["id"] == id(paragraph) and row.get("tableRowLabel", False)
                            for row in captured[1]))


def mark_source_preserved(page, paragraph):
    """Keep an unchanged validated result on its existing original glyph path.

    Called before post-translation; upstream preprocessing only reads the
    paragraph. The original composition, style, font and boxes are still intact.
    """
    with _LOCK:
        captured = _PAGES.get(id(page))
        if (captured is None or captured[0] is not page
                or not any(p is paragraph for p in getattr(page,"pdf_paragraph",()))): return False
        captured[2].add(id(paragraph))
        return True


def _target_bounds(chars, fonts):
    boxes = []
    for char in chars:
        bounds, size = _box(getattr(char, "box", None)), _font_size(char)
        font = fonts.get(getattr(getattr(char, "pdf_style", None), "font_id", None))
        ascent, descent = getattr(font, "ascender", None), getattr(font, "descender", None)
        if bounds is None or size is None or not _number(ascent) or not _number(descent) or not 0 < ascent - descent < 4:
            return None
        boxes.append((bounds[0], bounds[1] + descent * size, bounds[2], bounds[1] + ascent * size))
    return _union(boxes)


def _line_slot(row, candidates):
    bounds, size = row["bounds"], row["size"]
    center = (bounds[1] + bounds[3]) / 2
    above, below, upper_limits, lower_limits = [], [], [], []
    for neighbor in candidates:
        if row is neighbor: continue
        other = neighbor["bounds"]
        overlap = min(bounds[2], other[2]) - max(bounds[0], other[0])
        if overlap <= 0 or overlap < .35 * min(bounds[2] - bounds[0], other[2] - other[0]): continue
        distance = (other[1] + other[3]) / 2 - center
        if not .45 * size < abs(distance) < 2.5 * size: continue
        (above if distance > 0 else below).append(abs(distance))
        visible = neighbor.get("fontBounds")
        if visible:
            (upper_limits if distance > 0 else lower_limits).append(visible[1] if distance > 0 else visible[3])
    if not above and not below: return None
    up = min(above) if above else min(below)
    down = min(below) if below else min(above)
    low, high = center - down / 2 + .15, center + up / 2 - .15
    if lower_limits: low = max(low, max(lower_limits) + .15)
    if upper_limits: high = min(high, min(upper_limits) - .15)
    return low, high


def repair_typeset_page(page, font_mapper=None):
    """Fit translated compact table lines inside their source-neighbor slots.

    Glyphs are moved/scaled together as vectors. Formula groups, source glyphs,
    body paragraphs, and unknown font metrics are deliberately untouched.
    """
    stats = {"fittedTableLines": 0, "unsafeTableLines": 0}
    with _LOCK: captured = _PAGES.pop(id(page), None)
    if captured is None or captured[0] is not page: return stats
    rows, protected = captured[1:]
    captions = [r["bounds"][1] for r in rows if r["label"] == "table_caption"]
    fonts = getattr(font_mapper, "fontid2font", {}) if font_mapper is not None else {}
    if not captions or not isinstance(fonts, dict) or not fonts: return stats
    candidates = [r for r in rows if r["label"] in {"fallback_line", "table", "table_text"}
                  and r["size"] is not None and r["size"] <= 11
                  and r["bounds"][3] - r["bounds"][1] <= 24
                  and r["bounds"][2] - r["bounds"][0] <= 160 and len(r["text"]) <= 80
                  and any(0 <= caption - r["bounds"][3] <= 500 for caption in captions)]
    lookup = {r["id"]: r for r in candidates}
    for paragraph in getattr(page, "pdf_paragraph", ()):
        row = lookup.get(id(paragraph))
        if row is None or id(paragraph) in protected or getattr(paragraph, "vertical", False): continue
        compositions = getattr(paragraph, "pdf_paragraph_composition", ())
        if any(getattr(c, "pdf_formula", None) is not None for c in compositions): continue
        chars = [getattr(c, "pdf_character", None) for c in compositions]
        if not chars or any(c is None or id(c) in row["glyphs"] for c in chars): continue
        target, slot = _target_bounds(chars, fonts), _line_slot(row, candidates)
        if target is None or slot is None: continue
        low, high = slot
        if target[1] >= low - .1 and target[3] <= high + .1: continue
        height = target[3] - target[1]
        if height <= 0 or high <= low: continue
        scale = min(1., (high - low) / height)
        if scale < .55:
            stats["unsafeTableLines"] += 1
            continue
        bottom = (low + high - height * scale) / 2
        for char in chars:
            original = _box(char.box)
            char.box = copy(char.box)
            char.box.x = target[0] + (original[0] - target[0]) * scale
            char.box.x2 = target[0] + (original[2] - target[0]) * scale
            char.box.y = bottom + (original[1] - target[1]) * scale
            char.box.y2 = bottom + (original[3] - target[1]) * scale
            char.pdf_style = copy(char.pdf_style)
            char.pdf_style.font_size *= scale
            if _number(getattr(char, "advance", None)): char.advance *= scale
            # New unicode glyphs normally lack a visual_bbox. Never leave a
            # stale one if an engine build supplies it.
            if getattr(char, "visual_bbox", None) is not None:
                char.visual_bbox = None
        stats["fittedTableLines"] += 1
    return stats
