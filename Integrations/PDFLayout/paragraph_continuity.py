"""Repair source prose fragmentation using real layout blocks and glyphs.

No translation, inferred text, font remapping, or process-wide state. Existing
glyph/composition objects retain their styles, coordinates and formula anchors.
"""
from copy import copy
import math
import re
from statistics import median

_PROSE = {'plain text', 'plain_text', 'text'}
_CAPTION = re.compile(r'^(?:table|fig(?:ure)?\.?)\s*\d', re.I)


def _box(value):
    try:
        result = tuple(getattr(value, key) for key in ('x', 'y', 'x2', 'y2'))
        if all(isinstance(x, (int, float)) and math.isfinite(x) for x in result): return result
    except (AttributeError, TypeError): pass
    return None


def _characters(paragraph):
    for comp in getattr(paragraph, 'pdf_paragraph_composition', ()):
        char = getattr(comp, 'pdf_character', None)
        if char is not None: yield char
        else:
            for key in ('pdf_line', 'pdf_same_style_characters', 'pdf_formula'):
                group = getattr(comp, key, None)
                if group is not None:
                    yield from getattr(group, 'pdf_character', ())
                    break


def _visible_chars(paragraph):
    return [c for c in _characters(paragraph)
            if (getattr(c, 'char_unicode', '') or '').strip() and _box(getattr(c, 'box', None))]


def _size(char):
    value = getattr(getattr(char, 'pdf_style', None), 'font_size', None)
    return value if isinstance(value, (int, float)) and math.isfinite(value) and value > 0 else None


def _style_equal(a, b):
    sa, sb = _size(a), _size(b)
    return (sa is not None and sb is not None and abs(sa - sb) <= .05
            and getattr(a.pdf_style, 'font_id', None) == getattr(b.pdf_style, 'font_id', None)
            and getattr(a, 'xobj_id', None) == getattr(b, 'xobj_id', None))


def _center_inside(char, region):
    bounds = _box(getattr(char, 'box', None)); outer = _box(getattr(region, 'box', None))
    if bounds is None or outer is None: return False
    x, y = (bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2
    return outer[0] - .1 <= x <= outer[2] + .1 and outer[1] - .1 <= y <= outer[3] + .1


def _region(page, paragraph):
    chars = _visible_chars(paragraph)
    if not chars: return None
    layouts = getattr(page, 'page_layout', ())
    # A prose false positive inside a real figure/table must not move labels.
    if any(getattr(r, 'class_name', '') in {'figure', 'table'} and getattr(r, 'conf', 0) >= .25
           and any(_center_inside(c, r) for c in chars) for r in layouts): return None
    matches = [r for r in layouts if getattr(r, 'class_name', '') in _PROSE
               and getattr(r, 'conf', 0) >= .7 and getattr(r, 'id', None) is not None
               and all(_center_inside(c, r) for c in chars)]
    return max(matches, key=lambda r: r.conf, default=None)


def _eligible(paragraph):
    label = getattr(paragraph, 'layout_label', '')
    text = getattr(paragraph, 'unicode', '') or ''
    if (getattr(paragraph, 'vertical', False) or _CAPTION.match(text.lstrip())
            or label not in _PROSE | {'title'}): return False
    if label == 'title' and len(text.strip()) > 3: return False
    # Pure formulas remain separate, including formula-only letters.
    return any(getattr(c, 'pdf_formula', None) is None
               for c in getattr(paragraph, 'pdf_paragraph_composition', ()))


def _edges(paragraph):
    chars = _visible_chars(paragraph)
    return (chars[0], chars[-1]) if chars else (None, None)


def _same_row(left, right):
    _, last = _edges(left); first, _ = _edges(right)
    if last is None or first is None or not _style_equal(last, first): return None
    size = _size(last); a, b = _box(last.box), _box(first.box)
    gap = b[0] - a[2]
    if abs(a[1] - b[1]) > .15 or not -.1 * size <= gap <= .6 * size: return None
    return gap, size


def _rebox(paragraph):
    chars = _visible_chars(paragraph)
    boxes = [_box(getattr(getattr(c, 'visual_bbox', None), 'box', None)) or _box(c.box) for c in chars]
    if not boxes or getattr(paragraph, 'box', None) is None: return
    paragraph.box = copy(paragraph.box)
    paragraph.box.x = min(b[0] for b in boxes); paragraph.box.y = min(b[1] for b in boxes)
    paragraph.box.x2 = max(b[2] for b in boxes); paragraph.box.y2 = max(b[3] for b in boxes)


def _text_join(left, right, gap=None, size=None):
    a, b = left.unicode or '', right.unicode or ''
    if not a or not b or a[-1].isspace() or b[0].isspace(): return a + b
    if gap is None: return a + ' ' + b
    # Advance boxes distinguish kerning within a broken word from a real space.
    spacer = gap > size * .12 and b[0] not in '.,;:!?)]}'
    return a + (' ' if spacer else '') + b


def _split_title_tails(page):
    total = 0; output = []
    for paragraph in page.pdf_paragraph:
        comps = getattr(paragraph, 'pdf_paragraph_composition', ())
        if getattr(paragraph, 'layout_label', '') != 'title' or len(comps) < 2:
            output.append(paragraph); continue
        # Only a complete existing composition on a different, verified body
        # baseline may leave a heading. Never split glyphs or guess words.
        head, tail = copy(paragraph), copy(paragraph)
        head.pdf_paragraph_composition = list(comps[:-1]); tail.pdf_paragraph_composition = [comps[-1]]
        head_chars, tail_chars = _visible_chars(head), _visible_chars(tail)
        region = _region(page, tail)
        if not head_chars or not tail_chars or region is None or _region(page, head) is not None:
            output.append(paragraph); continue
        if not all(abs(c.box.y - tail_chars[0].box.y) <= .15 for c in tail_chars):
            output.append(paragraph); continue
        if min(c.box.y for c in head_chars) - tail_chars[0].box.y < .7 * (_size(tail_chars[0]) or math.inf):
            output.append(paragraph); continue
        neighbor = any(other is not paragraph and _eligible(other) and _region(page, other) is region
                       and _same_row(tail, other) is not None for other in page.pdf_paragraph)
        if not neighbor:
            output.append(paragraph); continue
        head.unicode = ''.join(getattr(c, 'char_unicode', '') or '' for c in _characters(head))
        tail.unicode = ''.join(getattr(c, 'char_unicode', '') or '' for c in _characters(tail))
        if ''.join((head.unicode + tail.unicode).split()) != ''.join((paragraph.unicode or '').split()):
            output.append(paragraph); continue
        head.pdf_style, tail.pdf_style = head_chars[0].pdf_style, tail_chars[0].pdf_style
        tail.layout_label, tail.layout_id = 'plain text', region.id
        _rebox(head); _rebox(tail); output.extend((head, tail)); total += 1
    page.pdf_paragraph[:] = output
    return total


def _leading(paragraph):
    baselines = []
    for c in _visible_chars(paragraph):
        # Inline bars/anchors may have slightly shifted baselines; they cannot
        # constitute another text row within less than half their font size.
        if not baselines or abs(c.box.y - baselines[-1]) > max(.2, (_size(c) or 0) * .45):
            baselines.append(c.box.y)
    gaps = [a - b for a, b in zip(baselines, baselines[1:]) if a - b > .2]
    if not gaps: return None
    value = median(gaps)
    return value if all(abs(g - value) <= .15 for g in gaps) else None


def _wrapped(left, right, region):
    if (getattr(left, 'layout_label', '') not in _PROSE or getattr(right, 'layout_label', '') not in _PROSE
            or getattr(left, 'layout_id', None) != getattr(right, 'layout_id', None)
            or getattr(left, 'first_line_indent', False) or getattr(right, 'first_line_indent', False)
            or (left.unicode or '').rstrip().endswith(('.', '!', '?', ';', ':'))
            or not (right.unicode or '').lstrip()[:1].islower()): return False
    first_left, last_left = _edges(left); first_right, _ = _edges(right)
    if last_left is None or first_right is None or not _style_equal(last_left, first_right): return False
    size = _size(last_left); leading, other = _leading(left), _leading(right)
    if leading is None or other is None or abs(leading - other) > .15 or not size <= leading <= size * 1.6: return False
    bounds = _box(region.box)
    return (abs(last_left.box.y - first_right.box.y - leading) <= .15
            and abs(first_left.box.x - first_right.box.x) <= .15
            and 0 <= bounds[2] - last_left.box.x2 <= size * 2)


def _intervening_glyph(page, left, right):
    _, end = _edges(left); start, _ = _edges(right)
    if start.box.x <= end.box.x2: return False
    for p in page.pdf_paragraph:
        if p is left or p is right: continue
        for c in _visible_chars(p):
            if (end.box.x2 < (c.box.x + c.box.x2) / 2 < start.box.x
                    and abs(c.box.y - start.box.y) <= .5 * _size(start)): return True
    return False


def _drawn_barrier(page, left, right, region, wrapped):
    _, end = _edges(left); start, _ = _edges(right)
    rb = _box(region.box)
    for curve in getattr(page, 'pdf_curve', ()):
        b = _box(getattr(curve, 'box', None))
        if b is None: continue
        if wrapped:
            if (b[3] - b[1] <= .3 and start.box.y < b[1] < end.box.y
                    and min(b[2], rb[2]) - max(b[0], rb[0]) >= (rb[2] - rb[0]) * .5): return True
        elif (b[2] - b[0] <= .3 and end.box.x2 - .1 <= b[0] <= start.box.x + .1
              and b[3] - b[1] >= _size(start) * .5
              and b[3] >= start.box.y and b[1] <= start.box.y + _size(start)): return True
    return False


def _merge(page, left, right, inline):
    left.unicode = _text_join(left, right, *(inline if inline is not None else (None, None)))
    left.pdf_paragraph_composition.extend(right.pdf_paragraph_composition)
    left.layout_label = 'plain text'; _rebox(left)
    page.pdf_paragraph[:] = [p for p in page.pdf_paragraph if p is not right]


def join_prose_fragments(page):
    stats = {'joinedInline': 0, 'joinedWrapped': 0, 'splitTitleTails': 0}
    if not isinstance(getattr(page, 'pdf_paragraph', None), list): return stats
    stats['splitTitleTails'] = _split_title_tails(page)
    for wrapped in (False, True):
        while True:
            candidates = [(p, _region(page, p)) for p in page.pdf_paragraph if _eligible(p)]
            candidates = [(p, r) for p, r in candidates if r is not None]
            candidates.sort(key=lambda item: (-_edges(item[0])[0].box.y, _edges(item[0])[0].box.x))
            found = False
            for left, region in candidates:
                for right, other in candidates:
                    if left is right or region is not other: continue
                    inline = _same_row(left, right) if not wrapped else None
                    if (inline is None if not wrapped else not _wrapped(left, right, region)): continue
                    if not wrapped and _intervening_glyph(page, left, right): continue
                    if _drawn_barrier(page, left, right, region, wrapped): continue
                    _merge(page, left, right, inline)
                    stats['joinedWrapped' if wrapped else 'joinedInline'] += 1
                    found = True; break
                if found: break
            if not found: break
    return stats
