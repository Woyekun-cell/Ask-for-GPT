"""Version-pinned paragraph provenance from the layout IR, never text proximity.

Coordinates are absolute, bottom-left PDF user-space coordinates. A Chinese
selection uses only explicitly proven semantic units; word upgrades add exact
PDF glyph pools without changing any original or translated PDF.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import math
from pathlib import Path
import threading

from layout_common import BABELDOC_VERSION, atomic_json

ALIGNMENT_SCHEMA = 1
MAX_ALIGNMENT_BYTES = 32 * 1024 * 1024
MAX_PARAGRAPHS = 200_000
MAX_TEXT = 60_000
MAX_RECTS = 4096


def _box(value):
    if value is None: return None
    try: result = [float(value.x), float(value.y), float(value.x2), float(value.y2)]
    except (AttributeError, TypeError, ValueError): return None
    if not all(math.isfinite(x) and abs(x) < 1_000_000 for x in result): return None
    if result[2] <= result[0] or result[3] <= result[1]: return None
    return [round(x, 4) for x in result]


def _characters(paragraph):
    for composition in getattr(paragraph, "pdf_paragraph_composition", []):
        single = getattr(composition, "pdf_character", None)
        if single is not None:
            yield single
            continue
        for kind in ("pdf_line", "pdf_same_style_characters", "pdf_formula"):
            group = getattr(composition, kind, None)
            if group is not None:
                yield from getattr(group, "pdf_character", [])
                break


def _visible_rect(char, logical, fonts):
    visual = _box(getattr(getattr(char, "visual_bbox", None), "box", None))
    if visual is not None: return visual
    style = getattr(char, "pdf_style", None)
    font = fonts.get(getattr(style, "font_id", None))
    size = getattr(style, "font_size", None)
    ascent, descent = getattr(font, "ascender", None), getattr(font, "descender", None)
    # Original IR fonts store ascent/descent in 1000-unit font space. Only
    # FontMapper's actual PyMuPDF fonts expose normalized ascender/descender.
    # Retain logical bounds when real metrics or writing direction are unknown.
    if (not getattr(char, "vertical", False)
            and all(type(x) in (int, float) and math.isfinite(x) for x in (size, ascent, descent))
            and 0 < size < 1_000_000 and 0 < ascent - descent < 4):
        return [logical[0], logical[1] + descent * size,
                logical[2], logical[1] + ascent * size]
    return logical


def _line_rects(characters, *, font_mapper=None):
    """Group only glyphs on the same baseline; preserve gaps between columns."""
    lines = []
    fonts = getattr(font_mapper, "fontid2font", {}) if font_mapper is not None else {}
    if not isinstance(fonts, dict): fonts = {}
    for char in characters:
        text = getattr(char, "char_unicode", "") or ""
        logical = _box(getattr(char, "box", None))
        if not logical or not text.strip(): continue
        rect = _visible_rect(char, logical, fonts)
        # A formula's superscripts remain separate if their baselines differ.
        # Horizontal tolerance is bounded by local glyph height, never a page.
        height = logical[3] - logical[1]
        previous = lines[-1] if lines else None
        if (previous and abs(logical[1] - previous["baseline"]) <= min(height, previous["height"]) * .25
                and -height <= logical[0] - previous["right"] <= height * 1.5):
            bounds = previous["rect"]
            bounds[0] = min(bounds[0], rect[0]); bounds[1] = min(bounds[1], rect[1])
            bounds[2] = max(bounds[2], rect[2]); bounds[3] = max(bounds[3], rect[3])
            previous["right"] = logical[2]
        else: lines.append({"rect": list(rect), "baseline": logical[1], "height": height, "right": logical[2]})
    return [[round(x, 4) for x in line["rect"]] for line in lines]


def _snapshot(paragraph, *, rendered=False, font_mapper=None):
    characters = list(_characters(paragraph))
    # post_translate_paragraph.unicode can still contain {vN}/style anchors.
    # The final glyphs contain the restored formula and exact visible text.
    text = None if rendered else getattr(paragraph, "unicode", None)
    if not isinstance(text, str) or not text.strip():
        text = "".join(getattr(char, "char_unicode", "") or "" for char in characters)
    rects = _line_rects(characters, font_mapper=font_mapper)
    # A paragraph without rendered glyph geometry is unmappable. Do not turn
    # a large inferred paragraph box into a highlight over figures or columns.
    if not text.strip() or len(text) > MAX_TEXT or not rects or len(rects) > MAX_RECTS: return None
    return {"text": text, "rects": rects}


def _geometry(page):
    # PyMuPDF's transformation_matrix omits the crop offset on some rotated
    # pages. Convert the documented top-left cropbox explicitly instead.
    crop = [page.cropbox.x0, page.mediabox.y1 - page.cropbox.y1,
            page.cropbox.x1, page.mediabox.y1 - page.cropbox.y0]
    return {"mediaBox": [round(x, 4) for x in page.mediabox],
            "cropBox": [round(x, 4) for x in crop], "rotation": page.rotation}


def _pdf_to_visible(page):
    import pymupdf
    crop = page.cropbox
    return pymupdf.Matrix(1, 0, 0, -1, -crop.x0, page.mediabox.y1 - crop.y0) * page.rotation_matrix


def _dual_matrix(page, dual, *, translated):
    import pymupdf
    matrix = _pdf_to_visible(page)
    if translated:
        # compose_dual places the translated form after the actual source
        # width, including any sub-point engine rounding difference.
        matrix *= pymupdf.Matrix(1, 0, 0, 1, dual.rect.width - page.rect.width, 0)
    matrix *= ~_pdf_to_visible(dual)
    return matrix


def _dual_rects(rects, page, dual, *, translated):
    import pymupdf
    matrix = _dual_matrix(page, dual, translated=translated)
    return [[round(x, 4) for x in pymupdf.Rect(rect) * matrix] for rect in rects]


class AlignmentCollector:
    """Associate original and translated glyphs through the same IR object."""
    def __init__(self):
        self.lock = threading.Lock()
        self.sources = {}
        self.targets = {}

    def capture_source_page(self, page):
        local = getattr(page, "page_number", None)
        if type(local) is not int or not 0 <= local < 2000: return
        with self.lock:
            for index, paragraph in enumerate(page.pdf_paragraph):
                source = _snapshot(paragraph)
                if source:
                    # Retain the object until typesetting: a recycled Python
                    # object ID must never make an unrelated block look aligned.
                    self.sources[(local, id(paragraph))] = (index, source, paragraph)

    def capture_target_document(self, document, *, font_mapper=None):
        with self.lock:
            for page in document.page:
                local = getattr(page, "page_number", None)
                for paragraph in page.pdf_paragraph:
                    key = (local, id(paragraph))
                    if key not in self.sources or self.sources[key][2] is not paragraph: continue
                    target = _snapshot(paragraph, rendered=True, font_mapper=font_mapper)
                    if target: self.targets[key] = target

    def write(self, destination, source_path, mono_path, dual_path, selected, page_count):
        import pymupdf
        from layout_quality import TYPOGRAPHY_REVISION
        with Path(source_path).open("rb") as handle:
            source_sha = hashlib.file_digest(handle, "sha256").hexdigest()
        value = {"schema": ALIGNMENT_SCHEMA, "coordinateSpace": "pdf", "granularity": "paragraph",
                 "provenance": "babeldoc-ir", "sourcePages": selected, "pageCount": page_count,
                 "layoutRevision": TYPOGRAPHY_REVISION,
                 "sourceSHA256": source_sha, "pages": []}
        with pymupdf.open(source_path) as source, pymupdf.open(mono_path) as mono, pymupdf.open(dual_path) as dual:
            if len(source) != page_count or len(mono) != len(selected) or len(dual) != len(selected):
                raise ValueError("invalid_alignment_geometry")
            for local, physical in enumerate(selected):
                original, translated, paired = source[physical], mono[local], dual[local]
                page = {"sourcePage": physical, "outputPage": local, "source": _geometry(original),
                        "mono": _geometry(translated), "dual": _geometry(paired),
                        "sourceToDual": [round(x, 6) for x in _dual_matrix(original, paired, translated=False)],
                        "targetToDual": [round(x, 6) for x in _dual_matrix(translated, paired, translated=True)],
                        "paragraphs": []}
                for key, (index, snapshot, _) in self.sources.items():
                    if key[0] != local or key not in self.targets: continue
                    target = self.targets[key]
                    page["paragraphs"].append({"id": f"p{physical}_{index}", "source": snapshot,
                        "target": target,
                        "dualSource": {"rects": _dual_rects(snapshot["rects"], original, paired, translated=False)},
                        "dualTarget": {"rects": _dual_rects(target["rects"], translated, paired, translated=True)}})
                page["paragraphs"].sort(key=lambda item: int(item["id"].rsplit("_", 1)[1]))
                value["pages"].append(page)
        validate_alignment(value, selected, page_count, value["sourceSHA256"])
        data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        if len(data) > MAX_ALIGNMENT_BYTES: raise ValueError("alignment_too_large")
        atomic_json(Path(destination), value)
        return value


def _rects(value):
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_RECTS: return False
    for rect in value:
        if (not isinstance(rect, list) or len(rect) != 4
                or any(type(x) not in (int, float) or not math.isfinite(x) or abs(x) >= 1_000_000 for x in rect)
                or rect[2] <= rect[0] or rect[3] <= rect[1]): return False
    return True


def _glyph_key(glyph):
    return (glyph["text"],tuple(glyph["rect"]) if glyph.get("rect") is not None else None,glyph.get("line"))


def _glyphs(value, text):
    import unicodedata
    canonical=lambda text:"".join(c for c in unicodedata.normalize("NFKC",text) if not c.isspace())
    if not isinstance(value,list) or not 1<=len(value)<=MAX_TEXT:return False
    for glyph in value:
        if (not isinstance(glyph,dict) or set(glyph)-{"text","rect","line"}
                or not isinstance(glyph.get("text"),str) or not glyph["text"]
                or any(0xd800<=ord(x)<=0xdfff for x in glyph["text"])):return False
        if glyph.get("rect") is None:
            if not glyph["text"].isspace():return False
        elif not _rects([glyph["rect"]]):return False
        line=glyph.get("line")
        if line is not None and (type(line) is not int or line<0):return False
    return canonical("".join(g["text"] for g in value))==canonical(text)


def _validate_phrases(sentence,page):
    from collections import Counter
    import pymupdf
    phrases=sentence.get("phrases",[])
    if not isinstance(phrases,list) or len(phrases)>2048:raise ValueError("invalid_phrase_alignment")
    pools={};positions={};used={"source":set(),"target":set()};identities=set()
    for name in ("source","target"):
        side=sentence[name];glyphs=side.get("glyphs")
        if glyphs is None and not phrases:continue
        if not _glyphs(glyphs,side["text"]):raise ValueError("invalid_phrase_glyphs")
        pools[name]=Counter(_glyph_key(g) for g in glyphs if g.get("rect") is not None)
        positions[name]={_glyph_key(g):index for index,g in enumerate(g for g in glyphs if g.get("rect") is not None and not g["text"].isspace())}
        for glyph in glyphs:
            rect=glyph.get("rect")
            if rect is not None and not glyph["text"].isspace() and not any(r[0]-.02<=rect[0] and r[1]-.02<=rect[1]
                    and r[2]+.02>=rect[2] and r[3]+.02>=rect[3] for r in side["rects"]):raise ValueError("invalid_phrase_glyphs")
    for phrase in phrases:
        identity=phrase.get("id") if isinstance(phrase,dict) else None
        if (not isinstance(identity,str) or len(identity)>128 or identity in identities
                or not identity.startswith(sentence["id"]+"_w")
                or phrase.get("method") not in {"semantic-phrase-model","glyph-identity"}):raise ValueError("invalid_phrase_alignment")
        identities.add(identity)
        for name in ("source","target"):
            side=phrase.get(name);count=phrase.get(name+"TokenCount")
            if (not isinstance(side,dict) or not isinstance(side.get("text"),str) or not side["text"].strip()
                    or len(side["text"])>MAX_TEXT or not _rects(side.get("rects"))
                    or not _glyphs(side.get("glyphs"),side["text"]) or type(count) is not int or not 1<=count<=16):raise ValueError("invalid_phrase_alignment")
            keys=[_glyph_key(g) for g in side["glyphs"] if g.get("rect") is not None]
            if not keys or any(key in used[name] for key in keys) or Counter(keys)-pools.get(name,Counter()):raise ValueError("invalid_phrase_glyphs")
            indices=[positions[name][key] for glyph,key in zip((g for g in side["glyphs"] if g.get("rect") is not None),keys) if not glyph["text"].isspace()]
            if not indices or indices!=list(range(indices[0],indices[0]+len(indices))):raise ValueError("invalid_phrase_glyphs")
            used[name].update(keys)
            # The displayed rectangles must be exactly the real glyph runs,
            # not a broad box covering unrelated words on the same line.
            lines=[]
            for glyph in side["glyphs"]:
                rect=glyph.get("rect")
                if rect is None:continue
                if lines and glyph.get("line")==lines[-1][0]:
                    previous=lines[-1][1];previous[:]=[min(previous[0],rect[0]),min(previous[1],rect[1]),max(previous[2],rect[2]),max(previous[3],rect[3])]
                else:lines.append((glyph.get("line"),list(rect)))
            expected=[rect for _,rect in lines]
            if len(expected)!=len(side["rects"]) or any(abs(a-b)>.02 for x,y in zip(expected,side["rects"]) for a,b in zip(x,y)):raise ValueError("invalid_phrase_rects")
            paired=phrase.get("dual"+name.capitalize())
            if not isinstance(paired,dict) or not _rects(paired.get("rects")):raise ValueError("invalid_phrase_rects")
            expected=[[float(x) for x in pymupdf.Rect(r)*pymupdf.Matrix(*page[name+"ToDual"])] for r in side["rects"]]
            if len(expected)!=len(paired["rects"]) or any(abs(a-b)>.02 for x,y in zip(expected,paired["rects"]) for a,b in zip(x,y)):raise ValueError("invalid_phrase_transform")
        if phrase["method"]=="glyph-identity":
            source,target=phrase["source"],phrase["target"]
            if (source["text"]!=target["text"] or len(source["glyphs"])!=len(target["glyphs"])
                    or any(a["text"]!=b["text"] or any(abs(x-y)>.01 for x,y in zip(a["rect"],b["rect"])) for a,b in zip(source["glyphs"],target["glyphs"]))):raise ValueError("invalid_phrase_identity")


def validate_alignment(value, selected, page_count, source_sha):
    """Validate bounded JSON before serving it or deriving a smaller cache."""
    if (not isinstance(value, dict) or value.get("schema") != ALIGNMENT_SCHEMA
            or value.get("coordinateSpace") != "pdf" or value.get("granularity") not in {"paragraph","sentence"}
            or value.get("provenance") != "babeldoc-ir" or value.get("sourcePages") != selected
            or value.get("pageCount") != page_count or value.get("sourceSHA256") != source_sha
            or not isinstance(value.get("pages"), list) or len(value["pages"]) != len(selected)):
        raise ValueError("invalid_alignment")
    if value["granularity"]=="sentence":
        sentence_pages=value.get("sentencePages")
        partial_pages=value.get("sentencePartialPages",[])
        if (value.get("sentenceAlignmentRevision")!="pdf-sentence-semantic-v1" or not isinstance(sentence_pages,list)
                or any(type(x) is not int or x not in selected for x in sentence_pages)
                or sentence_pages!=sorted(set(sentence_pages))
                or not isinstance(partial_pages,list) or any(type(x) is not int or x not in selected for x in partial_pages)
                or partial_pages!=sorted(set(partial_pages)) or set(partial_pages)&set(sentence_pages)):
            raise ValueError("invalid_sentence_alignment")
    elif value.get("sentencePartialPages"):
        raise ValueError("invalid_sentence_alignment")
    present=set(value.get("sentencePages",[]))|set(value.get("sentencePartialPages",[]))
    phrase_revision=value.get("phraseAlignmentRevision")
    phrase_pages=value.get("phrasePages",[])
    if (phrase_revision is not None or phrase_pages):
        if (phrase_revision!="pdf-phrase-semantic-v1" or value["granularity"]!="sentence"
                or not isinstance(phrase_pages,list) or any(type(x) is not int or x not in present for x in phrase_pages)
                or phrase_pages!=sorted(set(phrase_pages))):raise ValueError("invalid_phrase_alignment")
    extracted=value.get("phraseExtractedPages",[])
    if (not isinstance(extracted,list) or any(type(x) is not int or x not in value.get("sentencePages",[]) or x not in phrase_pages for x in extracted)
            or extracted!=sorted(set(extracted))):raise ValueError("invalid_phrase_alignment")
    count = 0
    for local, page in enumerate(value["pages"]):
        if not isinstance(page, dict) or page.get("sourcePage") != selected[local] or page.get("outputPage") != local:
            raise ValueError("invalid_alignment_page")
        for key in ("source", "mono", "dual"):
            geometry = page.get(key)
            if (not isinstance(geometry, dict) or not _rects([geometry.get("mediaBox")])
                    or not _rects([geometry.get("cropBox")]) or geometry.get("rotation") not in (0, 90, 180, 270)):
                raise ValueError("invalid_alignment_geometry")
        for key in ("sourceToDual", "targetToDual"):
            matrix = page.get(key)
            if (not isinstance(matrix, list) or len(matrix) != 6
                    or any(type(x) not in (int, float) or not math.isfinite(x) or abs(x) >= 1_000_000 for x in matrix)
                    or abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]) < 1e-8):
                raise ValueError("invalid_alignment_transform")
        paragraphs, seen = page.get("paragraphs"), set()
        if not isinstance(paragraphs, list): raise ValueError("invalid_alignment_paragraph")
        count += len(paragraphs)
        if count > MAX_PARAGRAPHS: raise ValueError("alignment_too_large")
        for paragraph in paragraphs:
            if not isinstance(paragraph, dict): raise ValueError("invalid_alignment_paragraph")
            identity = paragraph.get("id")
            if (not isinstance(identity, str) or len(identity) > 40 or identity in seen
                    or not identity.startswith(f"p{selected[local]}_")
                    or not identity.rsplit("_", 1)[-1].isdigit()): raise ValueError("invalid_alignment_id")
            seen.add(identity)
            sentences=paragraph.get("sentences",[])
            if not isinstance(sentences,list) or len(sentences)>1024: raise ValueError("invalid_sentence_alignment")
            sentence_ids=set()
            for sentence in sentences:
                sid=sentence.get("id") if isinstance(sentence,dict) else None
                if (not isinstance(sid,str) or len(sid)>128 or sid in sentence_ids
                        or not sid.startswith(identity+"_s") or sentence.get("method") not in {"semantic-model","glyph-identity"}):
                    raise ValueError("invalid_sentence_alignment")
                sentence_ids.add(sid)
                for side_name in ("source","target","dualSource","dualTarget"):
                    side=sentence.get(side_name)
                    if not isinstance(side,dict) or not _rects(side.get("rects")): raise ValueError("invalid_sentence_alignment")
                    if side_name in {"source","target"}:
                        text=side.get("text")
                        if not isinstance(text,str) or not text.strip() or len(text)>MAX_TEXT: raise ValueError("invalid_sentence_alignment")
                if "phrases" in sentence:
                    if selected[local] not in phrase_pages:raise ValueError("invalid_phrase_alignment")
                    _validate_phrases(sentence,page)
                if sentence["method"]=="glyph-identity":
                    source,target=sentence["source"],sentence["target"]
                    if (source["text"]!=target["text"] or len(source["rects"])!=len(target["rects"])
                            or any(abs(a-b)>.01 for x,y in zip(source["rects"],target["rects"]) for a,b in zip(x,y))):
                        raise ValueError("invalid_sentence_identity")
            for key in ("source", "target", "dualSource", "dualTarget"):
                side = paragraph.get(key)
                if not isinstance(side, dict) or not _rects(side.get("rects")): raise ValueError("invalid_alignment_rects")
                if key in ("source", "target"):
                    text = side.get("text")
                    if (not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT
                            or any(0xD800 <= ord(x) <= 0xDFFF for x in text)):
                        raise ValueError("invalid_alignment_text")
    return value


def subset_alignment(value, selected):
    pages = {page["sourcePage"]: page for page in value["pages"]}
    result = {**value, "sourcePages": selected,
            "pages": [{**pages[physical], "outputPage": local} for local, physical in enumerate(selected)]}
    if "sentencePages" in result: result["sentencePages"]=[x for x in result["sentencePages"] if x in selected]
    if "sentencePartialPages" in result: result["sentencePartialPages"]=[x for x in result["sentencePartialPages"] if x in selected]
    if "phrasePages" in result: result["phrasePages"]=[x for x in result["phrasePages"] if x in selected]
    if "phraseExtractedPages" in result: result["phraseExtractedPages"]=[x for x in result["phraseExtractedPages"] if x in selected]
    if "phraseCoverage" in result: result["phraseCoverage"]={str(x):result["phraseCoverage"][str(x)] for x in selected if str(x) in result["phraseCoverage"]}
    return result


@contextmanager
def capture_typesetting(high_level, collector):
    """No global runtime changes outside one pinned worker process/job."""
    import importlib.metadata
    if importlib.metadata.version("BabelDOC") != BABELDOC_VERSION: raise ValueError("runtime_missing")
    original = high_level.Typesetting
    class CapturedTypesetting(original):
        def _get_optimal_scale(self, paragraph, page, typesetting_units, use_english_line_break=True):
            scale = super()._get_optimal_scale(paragraph, page, typesetting_units, use_english_line_break)
            if not self.is_cjk or scale >= 1. - 1e-6: return scale
            from layout_quality import prose_expansion_box
            expanded = prose_expansion_box(page, paragraph)
            if expanded is None: return scale
            # Upstream only tries whitespace expansion after shrinking below
            # 70%. Probe a bounded, collision-checked target box at full size
            # first. Failed probes leave every existing box untouched.
            try:
                _, fits = self._layout_typesetting_units(typesetting_units, expanded, 1., 1.5,
                                                        paragraph, use_english_line_break)
            except Exception: return scale
            if fits:
                paragraph.box = expanded
                return 1.
            return scale

        def preprocess_document(self, document, pbar):
            result = super().preprocess_document(document, pbar)
            from layout_quality import harmonize_typeset_scales
            harmonize_typeset_scales(document)
            return result

        def render_page(self, page):
            result = super().render_page(page)
            from layout_quality import repair_typeset_page
            repair_typeset_page(page, font_mapper=self.font_mapper)
            return result

        def typesetting_document(self, document):
            result = super().typesetting_document(document)
            collector.capture_target_document(document, font_mapper=self.font_mapper)
            return result
    high_level.Typesetting = CapturedTypesetting
    try: yield
    finally: high_level.Typesetting = original
