"""Version-pinned, one-page GPT batches without changing BabelDOC's layout IR."""
from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from contextlib import contextmanager, nullcontext
from copy import copy
import ast
import importlib.metadata
import json
import re
import threading
from types import MappingProxyType

from layout_common import BABELDOC_VERSION, ProtocolFailure, placeholders

ADAPTER_REVISION = "pdf-layout-gpt-v5-context-paragraph"
MAX_SEGMENTS = 256
MAX_SCALARS = 60_000
MAX_MESSAGE_BYTES = 256 * 1024
SEGMENT_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
ERROR_DETAILS = frozenset({"jsonObject", "count", "rowShape", "id", "empty", "formula", "content"})
MAX_CONTEXT_SIDE_SCALARS = 2_000


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
        if Counter(placeholders(item["text"])) != Counter(placeholders(expected[item["id"]])):
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
                raw = (self.translate_engine.batch_translate(segments, context=context) if context is not None
                       else self.translate_engine.batch_translate(segments))
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


@contextmanager
def patched_page_translator(high_level):
    if importlib.metadata.version("BabelDOC") != BABELDOC_VERSION:
        raise ProtocolFailure("runtime_missing")
    original = high_level.ILTranslator
    high_level.ILTranslator = page_translator_class()
    try:
        yield
    finally:
        high_level.ILTranslator = original
