"""Version-pinned, one-page GPT batches without changing BabelDOC's layout IR."""
from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from contextlib import contextmanager, nullcontext
from copy import copy
from dataclasses import replace
from functools import lru_cache
import ast
import importlib.metadata
import json
import re
import threading
from types import MappingProxyType

from layout_common import BABELDOC_VERSION, PLACEHOLDER, ProtocolFailure, placeholders

ADAPTER_REVISION = "pdf-layout-gpt-v8-source-styles"
MAX_SEGMENTS = 256
MAX_SCALARS = 60_000
MAX_MESSAGE_BYTES = 256 * 1024
SEGMENT_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
ERROR_DETAILS = frozenset({"jsonObject", "count", "rowShape", "id", "empty", "formula", "content"})
MAX_CONTEXT_SIDE_SCALARS = 2_000
MAX_NUMERIC_PAGE_RETRIES = 2


def validate_context(value):
    """Optional read-only quotation context; never joins translation rows."""
    if value is None: return None
    if (not isinstance(value, Mapping) or set(value) != {"before", "after"}
            or any(not isinstance(value[key], str) or len(value[key]) > MAX_CONTEXT_SIDE_SCALARS
                   or any(0xD800 <= ord(char) <= 0xDFFF for char in value[key]) for key in ("before", "after"))):
        raise ProtocolFailure("batch_limit")
    result = {key: value[key] for key in ("before", "after")}
    return result if any(result.values()) else None


def snapshot_page_context(document, engine):
    """Freeze physical-neighbour context before parallel page translation.

    Only the original selected-page map connects compact IR indices to source
    pages. Gapped selected pages must never become false adjacent pages.
    """
    selected = getattr(engine, "source_page_indices", ())
    physical = getattr(engine, "source_context_by_physical", {})
    result = {}
    if not isinstance(selected, tuple) or not isinstance(physical, Mapping): return MappingProxyType(result)
    for page in getattr(document, "page", ()):
        local = getattr(page, "page_number", None)
        if type(local) is not int or not 0 <= local < len(selected): continue
        context = validate_context(physical.get(selected[local]))
        if context is not None: result[local] = MappingProxyType(context)
    return MappingProxyType(result)


def load_single_page_layout_model():
    """Avoid per-job CoreML compilation for a single explicitly chosen page.

    BabelDOC 0.6.4's existing model methods/preprocessing stay unchanged. Only
    this job's inference session uses CPU; provider discovery, global runtime
    settings and multi-page jobs retain upstream behavior. The measured local
    cold-start saving outweighs CPU's extra inference time for one page.
    """
    if importlib.metadata.version("BabelDOC") != BABELDOC_VERSION:
        raise ProtocolFailure("runtime_missing")
    from babeldoc.docvision import doclayout
    model_path = doclayout.get_doclayout_onnx_model_path()
    model = doclayout.onnx.load(model_path)
    metadata = {item.key: item.value for item in model.metadata_props}
    layout = doclayout.OnnxModel.__new__(doclayout.OnnxModel)
    layout.model_path = str(model_path)
    layout._stride = ast.literal_eval(metadata["stride"])
    layout._names = ast.literal_eval(metadata["names"])
    layout.model = doclayout.onnxruntime.InferenceSession(
        model.SerializeToString(), providers=["CPUExecutionProvider"])
    layout.lock = threading.Lock()
    return layout


def _text(value):
    return (isinstance(value, str) and bool(value.strip())
            and not any(0xD800 <= ord(char) <= 0xDFFF for char in value))


def validate_segments(value):
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_SEGMENTS:
        raise ProtocolFailure("batch_limit")
    seen, scalar_count = set(), 0
    for item in value:
        if (not isinstance(item, dict) or set(item) != {"id", "text"}
                or not isinstance(item["id"], str) or not SEGMENT_ID.fullmatch(item["id"])
                or item["id"] in seen or not _text(item["text"])):
            raise ProtocolFailure("batch_invalid")
        seen.add(item["id"])
        scalar_count += len(item["text"])
    if scalar_count > MAX_SCALARS:
        raise ProtocolFailure("batch_limit")
    # Reserve room for the request identity and language fields. JSON escaping
    # can make 60,000 control characters much larger than 60,000 UTF-8 bytes.
    if len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()) > MAX_MESSAGE_BYTES - 512:
        raise ProtocolFailure("batch_limit")
    return value


def _rich_text_structure(text):
    """Count whole style spans and formula ownership without fixing word order."""
    stack, spans, formulas = [], Counter(), Counter()
    for match in PLACEHOLDER.finditer(text):
        token = match.group()
        if token.startswith("{v"):
            formulas[(token, tuple(start[0] for start in stack))] += 1
        elif not token.startswith("</"):
            stack.append((token, match.end()))
        else:
            if not stack:
                return None
            start, content_start = stack.pop()
            expected_end = "</style>" if start.startswith("<style") else "</" + start[1:]
            if token != expected_end:
                return None
            # A matched but empty tag would silently move visible emphasis onto
            # nothing. Whitespace-only source runs remain legal.
            visible = bool(PLACEHOLDER.sub("", text[content_start:match.start()]).strip())
            spans[(tuple(parent[0] for parent in stack), start, visible)] += 1
    return None if stack else (spans, formulas)


def validate_translations(value, segments):
    validate_segments(segments)
    if not isinstance(value, list) or len(value) != len(segments):
        raise ProtocolFailure("batch_invalid")
    expected = {item["id"]: item["text"] for item in segments}
    outputs = {}
    for item in value:
        if (not isinstance(item, dict) or set(item) != {"id", "text"}
                or not isinstance(item["id"], str) or item["id"] not in expected
                or item["id"] in outputs or not _text(item["text"])):
            raise ProtocolFailure("batch_invalid")
        source = expected[item["id"]]
        if Counter(placeholders(item["text"])) != Counter(placeholders(source)):
            raise ProtocolFailure("formula_placeholder_mismatch")
        if "<b" in source or "<style" in source:
            structure = _rich_text_structure(source)
            if structure is not None and structure != _rich_text_structure(item["text"]):
                raise ProtocolFailure("formula_placeholder_mismatch")
        outputs[item["id"]] = item["text"]
    if len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()) > MAX_MESSAGE_BYTES - 512:
        raise ProtocolFailure("batch_limit")
    return [{"id": item["id"], "text": outputs[item["id"]]} for item in segments]


def prepare_source_paragraph(translator, page, paragraph, tracker, fonts, xfonts):
    """Include short confirmed headers without mutating any shared settings."""
    from layout_quality import is_table_header, is_table_row_label
    if is_table_header(page, paragraph) or is_table_row_label(page, paragraph):
        # Upstream preprocessing only reads configuration/translator state.
        # Keep real cancellation, font mapper, engine and placeholder fields,
        # but give this call its own minimum. Other pages may run concurrently.
        isolated = copy(translator)
        isolated.translation_config = copy(translator.translation_config)
        isolated.translation_config.min_text_length = 1
        return isolated.pre_translate_paragraph(paragraph, tracker, fonts, xfonts)
    return translator.pre_translate_paragraph(paragraph, tracker, fonts, xfonts)


_HEADINGS_TO_CHINESE = {
    "competing interests": "利益冲突", "conflict of interest": "利益冲突",
    "conflicts of interest": "利益冲突", "author contributions": "作者贡献",
    "acknowledgements": "致谢", "acknowledgments": "致谢",
    "references": "参考文献", "abstract": "摘要", "introduction": "引言",
    "methods": "方法", "results": "结果", "discussion": "讨论",
    "conclusions": "结论", "conclusion": "结论",
}
_HEADINGS_TO_ENGLISH = {
    "利益冲突": "Competing interests", "作者贡献": "Author contributions",
    "致谢": "Acknowledgements", "参考文献": "References", "摘要": "Abstract",
    "引言": "Introduction", "方法": "Methods", "结果": "Results",
    "讨论": "Discussion", "结论": "Conclusions",
}


def _calibrate_heading(source, output, configuration):
    # Only complete, exact section labels are deterministic. Ordinary prose,
    # table cells, protected anchors and other language pairs keep the model
    # result. In particular, do not let interests and contributions swap roles.
    source_language,target_language=getattr(configuration,"lang_in",None),getattr(configuration,"lang_out",None)
    text=" ".join(source.split())
    if source_language=="en" and target_language in {"zh-CN","zh-Hans"}:
        return _HEADINGS_TO_CHINESE.get(text.casefold(),output)
    if source_language in {"zh-CN","zh-Hans"} and target_language=="en":
        return _HEADINGS_TO_ENGLISH.get(text,output)
    return output


def apply_prepared_translation(translator, page, paragraph, tracker, prepared, source_text, output_text):
    """Apply an already validated response; exact identity keeps original glyphs."""
    translator.translation_config.raise_if_cancelled()
    output_text = _calibrate_heading(source_text, output_text, translator.translation_config)
    if output_text == source_text:
        from layout_quality import mark_source_preserved
        mark_source_preserved(page, paragraph)
        return False
    translator.post_translate_paragraph(paragraph, tracker, prepared, output_text)
    return True


def page_translator_class():
    from babeldoc.format.pdf.document_il.midend.il_translator import ILTranslator

    class PageBatchILTranslator(ILTranslator):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            # High-level BabelDOC must keep choosing its per-page adapter.
            # Only this adapter's preprocessing needs the rich-text capability.
            self.support_llm_translate = True

        def translate(self, document):
            self.source_context_by_page = snapshot_page_context(document, self.translate_engine)
            return super().translate(document)

        def process_page(self, page, executor, pbar=None, tracker=None):
            """Reuse upstream preprocessing/postprocessing; never move a block.

            The parent translate() still owns document tracking, progress stages,
            and cancellation. Only the page's translation boundary changes.
            Every response is validated before applying any paragraph from it.
            """
            try:
                self.translation_config.raise_if_cancelled()
                from layout_quality import protect_source_page
                protected = protect_source_page(page)
                alignment = getattr(self.translate_engine, "alignment_collector", None)
                if alignment is not None: alignment.capture_source_page(page)
                page_fonts = {font.font_id: font for font in page.pdf_font}
                xobject_fonts = {}
                for xobject in page.pdf_xobject:
                    fonts = page_fonts.copy()
                    fonts.update({font.font_id: font for font in xobject.pdf_font})
                    xobject_fonts[xobject.xobj_id] = fonts
                prepared, segments = [], []
                for index, paragraph in enumerate(page.pdf_paragraph):
                    self.translation_config.raise_if_cancelled()
                    if id(paragraph) in protected:
                        if pbar: pbar.advance(1)
                        continue
                    paragraph_tracker = tracker.new_paragraph()
                    text, translation_input = prepare_source_paragraph(
                        self, page, paragraph, paragraph_tracker, page_fonts, xobject_fonts)
                    if text is None:
                        if pbar: pbar.advance(1)
                        continue
                    identity = "p" + str(index)
                    segments.append({"id": identity, "text": text})
                    prepared.append((paragraph, paragraph_tracker, translation_input))
                page_completed = getattr(self.translate_engine, "page_completed", None)
                if not segments:
                    # Empty/number/formula-only pages need no model request;
                    # they still have actually finished the translation stage.
                    if page_completed: page_completed(getattr(page, "page_number", None))
                    return
                validate_segments(segments)
                page_started = getattr(self.translate_engine, "page_started", None)
                if page_started: page_started()
                context = getattr(self, "source_context_by_page", {}).get(getattr(page, "page_number", None))
                for attempt in range(1 + MAX_NUMERIC_PAGE_RETRIES):
                    self.translation_config.raise_if_cancelled()
                    try:
                        raw = (self.translate_engine.batch_translate(segments, context=context) if context is not None
                               else self.translate_engine.batch_translate(segments))
                        break
                    except ProtocolFailure as error:
                        # Keep the page in flight while the helper regenerates it.
                        if (attempt == MAX_NUMERIC_PAGE_RETRIES or str(error) != "batch_invalid"
                                or getattr(error, "error_detail", None) != "content"):
                            raise
                outputs = validate_translations(raw, segments)
                self.translation_config.raise_if_cancelled()
                for (paragraph, paragraph_tracker, translation_input), segment, output in zip(prepared, segments, outputs):
                    apply_prepared_translation(self, page, paragraph, paragraph_tracker, translation_input,
                                               segment["text"], output["text"])
                    if pbar: pbar.advance(1)
                # Only a fully validated and applied page advances progress.
                # A failed batch must never claim a completed translated page.
                if page_completed: page_completed(getattr(page, "page_number", None))
            except Exception as error:
                code = str(error) if isinstance(error, ProtocolFailure) else "batch_invalid"
                detail = getattr(error, "error_detail", None)
                detail = detail if code == "batch_invalid" and isinstance(detail, str) and detail in ERROR_DETAILS else None
                page_index = getattr(page, "page_number", None)
                page_index = page_index if type(page_index) is int and 0 <= page_index < 2000 else None
                # BabelDOC may retain the source after swallowing this error.
                # Keep the same bounded diagnostics on the engine for that path.
                with getattr(self.translate_engine, "error_lock", nullcontext()):
                    if not self.translate_engine.fatal_error:
                        self.translate_engine.fatal_error = code
                        self.translate_engine.fatal_error_detail = detail
                        self.translate_engine.fatal_page_index = page_index
                failure = ProtocolFailure(code)
                if detail is not None: failure.error_detail = detail
                if page_index is not None: failure.page_index = page_index
                raise failure from None

    return PageBatchILTranslator


_FACE_EMPHASIS = re.compile(
    r"[-_, ](?:(?P<weight>(?:(?:extra|ultra|semi|demi)[ -]?)?bold|heavy|black|demi)[ -]?)?"
    r"(?P<slant>italic|oblique|ital)?(?:ps|mt)*$", re.I,
)


@lru_cache(maxsize=512)
def _named_font_emphasis(name):
    suffix = _FACE_EMPHASIS.search(name)
    return (bool(suffix["weight"]), bool(suffix["slant"])) if suffix else (False, False)


def _source_font_emphasis(font):
    # Base-14 and other unembedded face names can carry style even when the
    # parser's font flags are unset or zero.
    bold, italic = _named_font_emphasis(getattr(font, "name", "") or "")
    return bold or bool(getattr(font, "bold", False)), italic or bool(getattr(font, "italic", False))


@contextmanager
def _preserve_italic_fallback():
    """Keep translated CJK glyphs slanted when the installed family has no italic."""
    from babeldoc.format.pdf.document_il.backend import pdf_creater
    from babeldoc.format.pdf.document_il.il_version_1 import GraphicState, PdfFont
    from babeldoc.format.pdf.document_il.midend.typesetting import TypesettingUnit
    from babeldoc.format.pdf.document_il.utils.fontmap import FontMapper

    original_map = FontMapper.map
    original_render = TypesettingUnit.render
    original_draw = pdf_creater.CharacterRenderUnit.render
    italic_glyphs = {}

    def map_font(mapper, source, char):
        if not isinstance(source, PdfFont):
            return original_map(mapper, source, char)
        bold, italic = _source_font_emphasis(source)
        if not italic:
            if bold and not source.bold:
                source = replace(source, bold=True)
            return original_map(mapper, source, char)
        for font in mapper.script_fonts:
            if (font.is_italic and bool(font.is_bold) == bold
                    and ("serif" in font.font_id.lower()) == bool(source.serif)
                    and font.has_glyph(ord(char))):
                return font
        return original_map(mapper, replace(source, bold=bold, italic=False), char)

    def render(unit):
        chars, curves, forms = original_render(unit)
        if (unit.unicode and unit.font is not None
                and not unit.font.is_italic and _source_font_emphasis(unit.original_font)[1]):
            italic_glyphs.update((id(char), char) for char in chars)
        return chars, curves, forms

    def draw(unit, output, context):
        char = unit.char
        if italic_glyphs.get(id(char)) is not char:
            return original_draw(unit, output, context)
        # The writer brackets each glyph in q/Q. Compute against its final
        # baseline, after any table fitting or other relocation.
        existing = getattr(char.pdf_style.graphic_state, "passthrough_per_char_instruction", "") or ""
        shear = .18
        state = GraphicState(passthrough_per_char_instruction=f"{existing} 1 0 {shear} 1 {-shear * char.box.y:.6f} 0 cm")
        styled = replace(char, pdf_style=replace(char.pdf_style, graphic_state=state))
        replacement = pdf_creater.CharacterRenderUnit(styled, unit.render_order, unit.sub_render_order)
        return original_draw(replacement, output, context)

    FontMapper.map = map_font
    TypesettingUnit.render = render
    pdf_creater.CharacterRenderUnit.render = draw
    try:
        yield
    finally:
        FontMapper.map = original_map
        TypesettingUnit.render = original_render
        pdf_creater.CharacterRenderUnit.render = original_draw


@contextmanager
def patched_page_translator(high_level):
    if importlib.metadata.version("BabelDOC") != BABELDOC_VERSION:
        raise ProtocolFailure("runtime_missing")
    original = high_level.ILTranslator
    high_level.ILTranslator = page_translator_class()
    try:
        with _preserve_italic_fallback():
            yield
    finally:
        high_level.ILTranslator = original
