#!/usr/bin/env python3
"""One layout-preserving job; offline Python uses a bounded native text bridge."""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import threading
import time
import uuid
import platform_ops as platform
from types import MappingProxyType

from layout_common import (BABELDOC_VERSION, MAX_OUTPUT_BYTES, ProtocolFailure, atomic_json, configure_asset_home,
    install_offline_guard, private_directory, translate_protected)
from gpt_batch import (ERROR_DETAILS, MAX_MESSAGE_BYTES, load_single_page_layout_model, patched_page_translator, validate_segments,
    validate_translations, validate_context, MAX_CONTEXT_SIDE_SCALARS)
from alignment import AlignmentCollector, capture_typesetting
from page_parallel import MAX_PAGE_WORKERS, NativeHelperPool, parallel_page_translation
from batch_permits import PERMIT_SUBDIRECTORY
from batch_checkpoint import BatchCheckpoint
from preparation import compact_graphic_history

if os.environ.get("ASKGPT_PDF_OFFLINE") == "1":
    # multiprocessing's PDF-saving children import this module as __mp_main__.
    # Install the same irreversible network guard there before unpickling work.
    install_offline_guard()


def report_progress(directory: Path, value: dict):
    # Optional UI telemetry must never alter translation/cache results. Only
    # fixed stages and page counts are written, never document text or IDs.
    try: atomic_json(Path(directory) / "progress.json", value)
    except OSError: pass


class JobProgress:
    def __init__(self, directory: Path, total: int):
        self.directory, self.total, self.completed = Path(directory), total, set()
        self.lock = threading.RLock()
        report_progress(self.directory, {"stage": "preparing"})

    def start_page(self):
        with self.lock:
            if len(self.completed) < self.total:
                report_progress(self.directory, {"stage": "translating", "completed": len(self.completed), "total": self.total})

    def finish_page(self, page: int):
        with self.lock:
            if type(page) is not int or not 0 <= page < self.total or page in self.completed: return
            self.completed.add(page)
            report_progress(self.directory, {"stage": "translating", "completed": len(self.completed), "total": self.total})
            if len(self.completed) == self.total: self.layout()

    def layout(self):
        with self.lock:report_progress(self.directory, {"stage": "layout"})


class NativeHelper:
    def __init__(self, executable: Path, source: str, target: str, *, timeout: float = 15,
                 batch_timeout: float = 100):
        self.executable = Path(executable)
        self.source, self.target, self.timeout = source, target, timeout
        self.batch_timeout = batch_timeout
        self.process = None
        self.process_mode = None
        self.buffer = bytearray()
        self.lock = threading.Lock()
        self.lifecycle_lock = threading.RLock()
        self.cancelled = False
        self.batch_pool_cancelled = None
        self._selection_reapers = set()
        self._selection_reap_callbacks = []
        self.selection_timing = {}

    def __enter__(self): return self
    def __exit__(self, *args): self.close()

    def close(self):
        with self.lifecycle_lock:
            self._close_process()

    def cancel(self):
        # Pool shutdown is final. A page that was already acquiring a slot
        # cannot create a new child after cancellation retires this helper.
        with self.lifecycle_lock:
            self.cancelled = True
            self._close_process()

    def bind_batch_cancellation(self, event):
        with self.lifecycle_lock:
            self.batch_pool_cancelled = event

    def _close_process(self):
        process, self.process = self.process, None
        self.process_mode = None
        self.buffer.clear()
        self._reap_process(process)

    @staticmethod
    def _reap_process(process):
        if process:
            if platform.IS_WINDOWS:
                # Kill the owned job before closing anonymous pipes: a writer
                # may be blocked after a timeout, and close must not wait on it.
                platform.finish_owned(process, grace=.5)
            elif process.poll() is None:
                # A completed Swift batch can release its ephemeral CLI
                # sessions on EOF before forced process cleanup is necessary.
                if process.stdin: process.stdin.close()
                try: process.wait(timeout=.5)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    # The native helper owns CLI sessions that must receive
                    # interrupt/close before its own forced termination.
                    try: process.wait(timeout=2.5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=1)
            for handle in [process.stdin, process.stdout]:
                if handle: handle.close()

    def _retire_selection_process(self):
        # HTTP failure latency excludes the existing graceful child cleanup.
        # Detach first: neither this failed child nor its buffered reply can
        # re-enter the interactive pool. The owned reaper still closes EOF,
        # gives the native helper time to retire Codex, then TERM/KILL + waits.
        with self.lifecycle_lock:
            process, self.process = self.process, None
            self.process_mode = None
            self.buffer.clear()
        if process is None: return
        def reap():
            try: self._reap_process(process)
            except (OSError, ValueError):
                for handle in (process.stdin, process.stdout):
                    try:
                        if handle: handle.close()
                    except (OSError, ValueError): pass
            finally:
                with self.lifecycle_lock:
                    self._selection_reapers.discard(threading.current_thread())
                    callbacks=self._selection_reap_callbacks[:] if not self._selection_reapers else []
                    if callbacks:self._selection_reap_callbacks.clear()
                for callback in callbacks:callback()
        # A normal interpreter exit must finish owned child retirement. This
        # controlled non-daemon thread is bounded by _reap_process's waits.
        thread=threading.Thread(target=reap,name="askgpt-selection-reap",daemon=False)
        with self.lifecycle_lock:
            self._selection_reapers.add(thread)
            thread.start()

    def when_selection_retired(self, callback):
        with self.lifecycle_lock:
            if self._selection_reapers:
                self._selection_reap_callbacks.append(callback);return
        callback()

    def wait_selection_retired(self, timeout=4.5):
        deadline=time.monotonic()+timeout
        while True:
            with self.lifecycle_lock:threads=list(self._selection_reapers)
            if not threads:return True
            for thread in threads:
                remaining=deadline-time.monotonic()
                if remaining<=0:return False
                thread.join(remaining)

    def _start(self, *, batch=False, alignment=False, phrases=False, selection=False):
        # Installation and cancellation share a lock, including Popen itself:
        # cancellation either prevents a child or joins and closes that child.
        with self.lifecycle_lock:
            if self.cancelled or (self.batch_pool_cancelled is not None and self.batch_pool_cancelled.is_set()):
                raise ProtocolFailure("gpt_unavailable")
            return self._start_process(batch=batch, alignment=alignment, phrases=phrases, selection=selection)

    def _start_process(self, *, batch=False, alignment=False, phrases=False, selection=False):
        mode = "selection_alignment" if selection else "phrase_alignment" if phrases else "alignment" if alignment else batch
        if self.process is not None and self.process.poll() is None and self.process_mode == mode: return self.process
        self.close()
        environment = dict(os.environ)
        # BabelDOC's private asset HOME must not hide the user's installed Apple
        # language packs from the dedicated native helper.
        environment["HOME"] = platform.actual_user_home()
        if platform.IS_WINDOWS: environment["USERPROFILE"] = platform.actual_user_home()
        flags = ["--gpt-selection-align"] if selection else ["--gpt-phrase-align"] if phrases else ["--gpt-align"] if alignment else (["--gpt-batch"] if batch else [])
        self.process = platform.spawn_owned([str(self.executable)] + flags, popen=subprocess.Popen, own_group=False, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0, env=environment)
        self.process_mode = mode
        return self.process

    def _exchange(self, process, encoded, deadline, maximum, timeout_error, invalid_error):
        try:
            platform.write_pipe(process.stdin, encoded, deadline)
            while b"\n" not in self.buffer:
                data = platform.read_pipe(process.stdout, deadline)
                if not data or len(self.buffer) + len(data) > maximum:
                    raise ProtocolFailure(invalid_error)
                self.buffer.extend(data)
        except TimeoutError:
            raise ProtocolFailure(timeout_error) from None
        line, _, extra = self.buffer.partition(b"\n")
        self.buffer = bytearray(extra)
        return json.loads(line)

    def translate(self, text: str) -> str:
        if not text.strip(): return text
        if len(text) > 1800: raise ProtocolFailure("translation_chunk_too_large")
        with self.lock:
            try:
                process = self._start()
                identity = uuid.uuid4().hex
                message = {"id": identity, "text": text, "source": self.source, "target": self.target}
                encoded = (json.dumps(message, ensure_ascii=False) + "\n").encode()
                response = self._exchange(process, encoded, time.monotonic() + self.timeout,
                                          1024 * 1024, "translation_timeout", "translation_failed")
                if not isinstance(response, dict) or response.get("id") != identity or response.get("error"):
                    raise ProtocolFailure("translation_failed")
                result = response.get("translation")
                if not isinstance(result, str) or not result.strip():
                    raise ProtocolFailure("empty_translation")
                return result
            except ProtocolFailure:
                self.close()
                raise
            except (OSError, ValueError, TypeError):
                self.close()
                raise ProtocolFailure("translation_failed") from None

    def translate_batch(self, segments, context=None):
        """One bounded JSONL request per prepared page; never retry as Apple."""
        validate_segments(segments)
        context = validate_context(context)
        identity = uuid.uuid4().hex
        message = {"id": identity, "segments": segments, "source": self.source, "target": self.target}
        if context is not None: message["context"] = context
        encoded = (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        if len(encoded) > MAX_MESSAGE_BYTES: raise ProtocolFailure("batch_limit")
        with self.lock:
            try:
                process = self._start(batch=True)
                deadline = time.monotonic() + self.batch_timeout
                response = self._exchange(process, encoded, deadline, MAX_MESSAGE_BYTES,
                                          "translation_timeout", "batch_invalid")
                if (not isinstance(response, dict) or response.get("id") != identity
                        or set(response) - {"id", "translations", "error", "errorDetail", "firstDeltaSeconds", "totalSeconds"}):
                    raise ProtocolFailure("batch_invalid")
                detail = response.get("errorDetail")
                if detail is not None and (response.get("error") != "batch_invalid"
                        or not isinstance(detail, str) or detail not in ERROR_DETAILS):
                    raise ProtocolFailure("batch_invalid")
                if response.get("error"):
                    code = response["error"]
                    allowed = {"gpt_unavailable", "batch_invalid", "batch_limit", "translation_timeout",
                               "formula_placeholder_mismatch"}
                    failure = ProtocolFailure(code if isinstance(code, str) and code in allowed else "gpt_unavailable")
                    if detail is not None: failure.error_detail = detail
                    raise failure
                return validate_translations(response.get("translations"), segments)
            except ProtocolFailure:
                self.close()
                raise
            except (OSError, ValueError, TypeError):
                self.close()
                raise ProtocolFailure("gpt_unavailable") from None

    def align(self, paragraphs):
        from sentence_alignment import MAX_ALIGNMENT_MESSAGE, validate_request, validate_matches
        validate_request(paragraphs)
        with self.lock:
            try:
                process = self._start(alignment=True)
                identity=uuid.uuid4().hex
                encoded=(json.dumps({"id":identity,"paragraphs":paragraphs,"source":self.source,"target":self.target},
                    ensure_ascii=False,separators=(",",":"))+"\n").encode()
                if len(encoded)>MAX_ALIGNMENT_MESSAGE: raise ProtocolFailure("alignment_invalid")
                deadline=time.monotonic()+self.batch_timeout
                response = self._exchange(process, encoded, deadline, MAX_ALIGNMENT_MESSAGE,
                                          "alignment_timeout", "alignment_invalid")
                if (not isinstance(response,dict) or response.get("id")!=identity
                        or set(response)-{"id","alignments","error","errorDetail","firstDeltaSeconds","totalSeconds"}):
                    raise ProtocolFailure("alignment_invalid")
                if response.get("error"):
                    code=response["error"]
                    failure=ProtocolFailure(code if code in {"alignment_invalid","alignment_timeout","gpt_unavailable"} else "alignment_invalid")
                    detail=response.get("errorDetail")
                    if str(failure)=="alignment_invalid" and detail in {"jsonObject","count","rowShape","id","order","group"}:
                        failure.error_detail=detail
                    raise failure
                return validate_matches(response.get("alignments"),paragraphs)
            except ProtocolFailure:
                self.close();raise
            except (OSError,ValueError,TypeError):
                self.close();raise ProtocolFailure("alignment_invalid") from None

    def align_phrases(self, units):
        from phrase_alignment import MAX_PHRASE_MESSAGE, validate_phrase_request, validate_phrase_matches
        validate_phrase_request(units)
        with self.lock:
            try:
                process=self._start(phrases=True)
                identity=uuid.uuid4().hex
                encoded=(json.dumps({"id":identity,"units":units,"source":self.source,"target":self.target},
                    ensure_ascii=False,separators=(",",":"))+"\n").encode()
                if len(encoded)>MAX_PHRASE_MESSAGE:raise ProtocolFailure("alignment_invalid")
                deadline=time.monotonic()+self.batch_timeout
                response = self._exchange(process, encoded, deadline, MAX_PHRASE_MESSAGE,
                                          "alignment_timeout", "alignment_invalid")
                if (not isinstance(response,dict) or response.get("id")!=identity
                        or set(response)-{"id","alignments","error","errorDetail","firstDeltaSeconds","totalSeconds"}):
                    raise ProtocolFailure("alignment_invalid")
                if response.get("error"):
                    code=response["error"]
                    failure=ProtocolFailure(code if code in {"alignment_invalid","alignment_timeout","gpt_unavailable"} else "alignment_invalid")
                    detail=response.get("errorDetail")
                    if str(failure)=="alignment_invalid" and detail in {"jsonObject","count","rowShape","id","order","group"}:
                        failure.error_detail=detail
                    raise failure
                return validate_phrase_matches(response.get("alignments"),units)
            except ProtocolFailure:
                self.close();raise
            except (OSError,ValueError,TypeError):
                self.close();raise ProtocolFailure("alignment_invalid") from None

    def _selection_exchange(self, message, timeout):
        from phrase_alignment import MAX_PHRASE_MESSAGE
        process = self._start(selection=True)
        identity = uuid.uuid4().hex
        encoded = (json.dumps({"id":identity, **message, "source":self.source, "target":self.target},
            ensure_ascii=False, separators=(",",":"))+"\n").encode()
        if len(encoded) > MAX_PHRASE_MESSAGE: raise ProtocolFailure("selection_invalid")
        deadline = time.monotonic()+timeout
        response = self._exchange(process, encoded, deadline, MAX_PHRASE_MESSAGE,
                                  "selection_timeout", "selection_invalid")
        if not isinstance(response,dict) or response.get("id")!=identity: raise ProtocolFailure("selection_invalid")
        return response

    def warm_selection(self, *, timeout=20.0):
        """Prepare an isolated native session; this frame contains no document."""
        with self.lock:
            try:
                response = self._selection_exchange({"warmup":True}, timeout)
                if set(response)-{"id","ready","error","errorDetail"}: raise ProtocolFailure("selection_invalid")
                if response.get("error"):
                    raise ProtocolFailure("gpt_unavailable" if response["error"]=="gpt_unavailable" else "selection_invalid")
                if response.get("ready") is not True: raise ProtocolFailure("selection_invalid")
            except ProtocolFailure:
                self._retire_selection_process(); raise
            except (OSError,ValueError,TypeError):
                self._retire_selection_process(); raise ProtocolFailure("selection_invalid") from None

    def align_selection(self, unit, side, start, end):
        """One bounded selection turn; no sentence worker, mode switch or retry."""
        from selection_service import validate_selection_request, validate_selection_match
        validate_selection_request(unit, side, start, end)
        with self.lock:
            self.selection_timing = {}
            try:
                response = self._selection_exchange({"unit":unit, "side":side, "range":[start,end]}, self.batch_timeout)
                if set(response)-{"id","match","error","errorDetail","totalSeconds","firstDeltaSeconds"}:
                    raise ProtocolFailure("selection_invalid")
                if response.get("error"):
                    code=response["error"]
                    raise ProtocolFailure(code if code in {"selection_timeout","gpt_unavailable"} else "selection_invalid")
                if "match" not in response: raise ProtocolFailure("selection_invalid")
                match = validate_selection_match(unit,side,start,end,response["match"],
                    language=self.source if side=="source" else self.target)
                # Diagnostic numbers never affect an otherwise valid mapping.
                # Reset each turn and allowlist finite durations only.
                total, first = response.get("totalSeconds"), response.get("firstDeltaSeconds")
                valid = lambda n: type(n) in (int,float) and 0 <= n <= 86400 and math.isfinite(n)
                if valid(total) and (first is None or valid(first) and first <= total):
                    self.selection_timing = {"totalSeconds":float(total)}
                    if first is not None: self.selection_timing["firstDeltaSeconds"] = float(first)
                return match
            except ProtocolFailure:
                self._retire_selection_process(); raise
            except (OSError,ValueError,TypeError):
                self._retire_selection_process(); raise ProtocolFailure("selection_invalid") from None


def _source_page_prose(page):
    """Read native PDF body text; no image payloads, OCR or PDF mutation.

    Ambiguous short labels, narrow cells, running margins and captions are
    excluded only from this optional context, never from translation input.
    """
    import pymupdf
    # Native text coordinates are unrotated; page.rect exchanges dimensions on
    # quarter-turn pages, while cropbox retains the extraction coordinate size.
    bounds_page = getattr(page, "cropbox", page.rect)
    width, height = float(bounds_page.width), float(bounds_page.height)
    if not math.isfinite(width + height) or min(width, height) <= 0: return ""
    flags = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
    rows = []
    for index, block in enumerate(page.get_text("dict", flags=flags, sort=False).get("blocks", ())):
        if block.get("type") != 0: continue
        bounds = block.get("bbox", ())
        if (len(bounds) != 4 or not all(type(value) in (int, float) and math.isfinite(value) for value in bounds)
                or bounds[2] - bounds[0] < width * .2 or bounds[1] < height * .04
                or bounds[3] > height * .96): continue
        lines = []
        for line in block.get("lines", ()):
            text = "".join(span.get("text", "") for span in line.get("spans", ())).strip()
            if re.match(r"^(?:fig(?:ure)?\.?|table)\s*\d", text, re.I): break
            lines.append(text)
        text = " ".join(" ".join(lines).split())
        if (len(text) < 32 or sum(char.isalpha() for char in text) < 24
                or any(0xD800 <= ord(char) <= 0xDFFF for char in text)
                or "✉" in text or "orcid" in text.casefold()): continue
        if len(re.findall(r"[A-Za-z]+", text)) < 7 and len(re.findall(r"[\u3400-\u9fff]", text)) < 20: continue
        rows.append((bounds, index, text))
    # Do not alternate columns by global Y. Preserve native line/span order
    # inside each actual body block, then read each distinct column top-down.
    columns = []
    for row in sorted(rows, key=lambda item: (item[0][0], item[0][1], item[1])):
        if not columns or row[0][0] - columns[-1][0] > width * .12:
            columns.append((row[0][0], []))
        columns[-1][1].append(row)
    return "\n".join(row[2] for _, items in columns for row in sorted(items, key=lambda item:(item[0][1], item[1])))


def collect_source_context(input_pdf, selected):
    """Immutable bounded context keyed by actual physical source page.

    Full, single-page and gapped requests use the same original neighbours.
    Probe callers share this function, so there is no private context recipe
    that differs from the real worker's source quotation.
    """
    import pymupdf
    with pymupdf.open(input_pdf) as document:
        if (not isinstance(selected, (list, tuple)) or not selected
                or any(type(page) is not int or not 0 <= page < len(document) for page in selected)
                or list(selected) != sorted(set(selected))):
            raise ProtocolFailure("invalid_request")
        neighbours = {other for page in selected for other in (page - 1, page + 1) if 0 <= other < len(document)}
        prose = {page: _source_page_prose(document[page]) for page in sorted(neighbours)}
        return MappingProxyType({page: MappingProxyType({
            "before": prose.get(page - 1, "")[-MAX_CONTEXT_SIDE_SCALARS:],
            "after": prose.get(page + 1, "")[:MAX_CONTEXT_SIDE_SCALARS],
        }) for page in selected})


def make_translator(translate, source, target):
    from babeldoc.translator.translator import BaseTranslator

    class AppleNativeTranslator(BaseTranslator):
        name = "askgpt-apple-local"

        def __init__(self):
            # Upstream SQLite caches retain source text outside job retention.
            # The dedicated Apple helper already caches its short-lived session.
            super().__init__(source, target, ignore_cache=True)
            self.add_cache_impact_parameters("adapter", "formula-protected-v1")
            self.fatal_error = None
            self.error_lock = threading.Lock()

        def do_llm_translate(self, text, rate_limit_params=None):
            # This is BabelDOC's explicit non-LLM feature detection contract.
            raise NotImplementedError

        def do_translate(self, text, rate_limit_params=None):
            if self.fatal_error: raise ProtocolFailure(self.fatal_error)
            try:
                return translate_protected(text, translate)
            except ProtocolFailure as error:
                with self.error_lock: self.fatal_error = str(error)
                raise
            except Exception:
                with self.error_lock: self.fatal_error = "translation_failed"
                raise ProtocolFailure("translation_failed") from None

        def get_formular_placeholder(self, placeholder_id):
            return "{v" + str(placeholder_id) + "}", r"\{\s*v\s*" + str(placeholder_id) + r"\s*\}"

    return AppleNativeTranslator()


def make_batch_translator(translate_batch, source, target, progress=None):
    """Keep the non-LLM layout path; its page adapter owns the GPT batch."""
    from babeldoc.translator.translator import BaseTranslator

    class GPTBatchTranslator(BaseTranslator):
        name = "askgpt-gpt-batch"

        def __init__(self):
            super().__init__(source, target, ignore_cache=True)
            self.batch_translate = translate_batch
            self.fatal_error = None
            self.fatal_error_detail = None
            self.fatal_page_index = None
            self.error_lock = threading.Lock()
            self.page_started = progress.start_page if progress else None
            self.page_completed = progress.finish_page if progress else None

        def do_llm_translate(self, text, rate_limit_params=None):
            # Upstream's LLM-only adapter splits every ~200 tokens; bypass it
            # in favor of the pinned per-page adapter below.
            raise NotImplementedError

        def do_translate(self, text, rate_limit_params=None):
            self.fatal_error = "batch_invalid"
            raise ProtocolFailure("batch_invalid")

        def get_formular_placeholder(self, placeholder_id):
            return "{v" + str(placeholder_id) + "}", r"\{\s*v\s*" + str(placeholder_id) + r"\s*\}"

    return GPTBatchTranslator()


def _with_physical_page(failure, selected):
    # The engine input is a compact copy of selected pages, not the source PDF.
    # Only the worker owns the mapping back to one-based physical source pages.
    index = getattr(failure, "page_index", None)
    if type(index) is int and 0 <= index < len(selected):
        page = selected[index]
        if type(page) is int and 0 <= page < 2000:
            failure.failed_page = page + 1
    return failure


def compose_dual(source_path: Path, mono_path: Path, selected: list[int], destination: Path):
    """Place visible source/translated pages side by side as vector PDF forms.

    Upstream 0.6.4 uses media-box origins for dual PDFs with nonzero crop boxes.
    Composing from the actual visible pages preserves crop/rotation geometry.
    """
    import pymupdf
    with pymupdf.open(source_path) as source, pymupdf.open(mono_path) as translated:
        if len(translated) != len(selected): raise ProtocolFailure("invalid_output")
        with pymupdf.open() as output:
            for index, source_index in enumerate(selected):
                original, mono = source[source_index], translated[index]
                # show_pdf_page imports form coordinates without /Rotate. Bake
                # rotation into temporary in-memory content, preserving vectors.
                _bake_visible_rotation(original)
                _bake_visible_rotation(mono)
                left, right = original.rect, mono.rect
                if abs(left.width - right.width) > .1 or abs(left.height - right.height) > .1:
                    raise ProtocolFailure("invalid_output")
                page = output.new_page(width=left.width + right.width, height=max(left.height, right.height))
                page.show_pdf_page(pymupdf.Rect(0, 0, left.width, left.height), source, source_index)
                page.show_pdf_page(pymupdf.Rect(left.width, 0, left.width + right.width, right.height), translated, index)
            output.save(destination, garbage=4, deflate=True)


def _bake_visible_rotation(page):
    """PyMuPDF remove_rotation() resets CropBox on quarter turns.

    Rotate the complete media-space content, then restore the transformed
    visible crop. Otherwise a rotated, cropped paper grows to its uncropped
    size and every annotation/progress coordinate is displaced.
    """
    if not page.rotation: return
    import pymupdf
    crop = pymupdf.Rect(page.cropbox)
    page.set_cropbox(page.mediabox)
    rotated_crop = crop * page.rotation_matrix
    page.remove_rotation()
    page.set_cropbox(rotated_crop)


def prepare_engine_input(source_path: Path, destination: Path, selected: list[int] | None = None):
    """Keep selected physical pages in original order, without source edits.

    The engine works on local page indices only. Geometry restoration and dual
    composition still use the untouched original plus the original page map.
    This avoids normalizing/parsing every page for a one-page request.
    """
    import pymupdf
    with pymupdf.open(source_path) as document:
        if selected is not None:
            if (not selected or selected != sorted(set(selected))
                    or any(type(page) is not int or page < 0 or page >= len(document) for page in selected)):
                raise ProtocolFailure("invalid_request")
            document.select(selected)
        for page in document:
            # Do not use remove_rotation here: that transforms all graphic
            # coordinates and reproduces the upstream rotated-page displacement.
            page.set_rotation(0)
            page.set_cropbox(page.mediabox)
        document.save(destination, garbage=4, deflate=True)


def restore_mono_geometry(source_path: Path, engine_mono: Path, selected: list[int], destination: Path):
    import pymupdf
    with pymupdf.open(source_path) as source, pymupdf.open(engine_mono) as translated:
        if len(translated) != len(selected): raise ProtocolFailure("invalid_output")
        for index, source_index in enumerate(selected):
            original, page = source[source_index], translated[index]
            if (abs(page.mediabox.width - original.mediabox.width) > .1
                    or abs(page.mediabox.height - original.mediabox.height) > .1):
                raise ProtocolFailure("invalid_output")
            page.set_cropbox(original.cropbox)
            page.set_rotation(original.rotation)
        translated.save(destination, garbage=4, deflate=True)


def translate_job(job_dir: Path, cache_root: Path, helper_path: Path):
    existing_outputs = platform.snapshot_private_tree(job_dir, recursive=False) if platform.IS_WINDOWS else None
    report_progress(job_dir, {"stage": "preparing"})
    if importlib.metadata.version("BabelDOC") != BABELDOC_VERSION:
        raise ProtocolFailure("runtime_missing")
    configure_asset_home(cache_root)
    import pymupdf
    from babeldoc.format.pdf import high_level
    from babeldoc.format.pdf.translation_config import TranslationConfig, WatermarkOutputMode
    from babeldoc.translator.translator import set_translate_rate_limiter
    request_path = job_dir / "request.json"
    if request_path.is_symlink() or request_path.stat().st_size > 64 * 1024:
        raise ProtocolFailure("invalid_request")
    request = json.loads(request_path.read_text())
    selected = request["sourcePages"]
    if (not isinstance(selected, list) or not selected
            or any(type(page) is not int or page < 0 for page in selected)
            or selected != sorted(set(selected))):
        raise ProtocolFailure("invalid_request")
    progress = JobProgress(job_dir, len(selected))
    source, target = request["source"], request["target"]
    if (source, target) not in {("en", "zh-Hans"), ("zh-Hans", "en")}:
        raise ProtocolFailure("invalid_request")
    input_file = job_dir / "input.pdf"
    if input_file.is_symlink(): raise ProtocolFailure("invalid_request")
    high_level.init()
    set_translate_rate_limiter(100)
    output_dir = private_directory(job_dir / "outputs")
    working_dir = private_directory(job_dir / "work")
    engine_input = working_dir / "source-unrotated.pdf"
    prepare_engine_input(input_file, engine_input, selected)
    page_workers=min(MAX_PAGE_WORKERS,len(selected))
    # A page may use the existing two 120-second validated attempts. The old
    # 100-second pipe deadline killed the native helper before it could finish.
    with NativeHelperPool(lambda:NativeHelper(helper_path,source,target,batch_timeout=250),page_workers,
            global_permit_directory=cache_root/PERMIT_SUBDIRECTORY) as helpers:
        checkpoint = BatchCheckpoint(cache_root, request.get("batchCacheKey"), source, target)
        translate_batch = (lambda rows, context=None: checkpoint.translate(helpers.translate_batch, rows, context)) if checkpoint.directory else helpers.translate_batch
        translator = make_batch_translator(translate_batch, source, target, progress)
        translator.source_page_indices = tuple(selected)
        translator.source_context_by_physical = collect_source_context(input_file, selected)
        translator.abort_page_batches=helpers.close
        alignment = AlignmentCollector()
        translator.alignment_collector = alignment
        configuration = TranslationConfig(translator=translator, input_file=engine_input,
            lang_in="en" if source == "en" else "zh-CN",
            lang_out="zh-CN" if target == "zh-Hans" else "en",
            doc_layout_model=load_single_page_layout_model() if len(selected) == 1 else None,
            # source-unrotated.pdf contains only the selected source pages.
            # All indices below belong to that private, compact input copy.
            pages=None,
            output_dir=output_dir, working_dir=working_dir,
            no_dual=True, no_mono=False, only_include_translated_page=True,
            watermark_output_mode=WatermarkOutputMode.NoWatermark,
            auto_extract_glossary=False, save_auto_extracted_glossary=False,
            disable_rich_text_translate=True, use_alternating_pages_dual=False,
            qps=100, pool_max_workers=1, use_rich_pbar=False,
            skip_clean=False, enhance_compatibility=False,
            skip_scanned_detection=False, ocr_workaround=False,
            auto_enable_ocr_workaround=False)
        try:
            with compact_graphic_history(), patched_page_translator(high_level), parallel_page_translation(high_level,page_workers), capture_typesetting(high_level, alignment):
                result = high_level.translate(configuration)
        except ProtocolFailure as error:
            raise _with_physical_page(error, selected)
        progress.layout()
        # Upstream can recover a failed paragraph by retaining its source. Do not
        # misreport that recovered PDF as a successfully translated document.
        if translator.fatal_error:
            failure = ProtocolFailure(translator.fatal_error)
            detail = translator.fatal_error_detail
            if str(failure) == "batch_invalid" and isinstance(detail, str) and detail in ERROR_DETAILS:
                failure.error_detail = detail
            failure.page_index = translator.fatal_page_index
            raise _with_physical_page(failure, selected)
        for kind, path in [("mono", result.mono_pdf_path)]:
            if (path is None or Path(path).is_symlink() or Path(path).resolve().parent != output_dir.resolve()
                    or not 4 < Path(path).stat().st_size <= MAX_OUTPUT_BYTES):
                raise ProtocolFailure("invalid_output")
            with pymupdf.open(path) as document:
                if len(document) != len(selected): raise ProtocolFailure("invalid_output")
            target_path = job_dir / (kind + ".pdf")
            restore_mono_geometry(input_file, path, selected, target_path)
            if platform.IS_WINDOWS: platform.protect_generated_file(target_path, job_dir, existing_outputs)
            else: platform.protect_path(target_path)
        compose_dual(input_file, job_dir / "mono.pdf", selected, job_dir / "dual.pdf")
        if (job_dir / "dual.pdf").stat().st_size > MAX_OUTPUT_BYTES:
            raise ProtocolFailure("invalid_output")
        if platform.IS_WINDOWS: platform.protect_generated_file(job_dir / "dual.pdf", job_dir, existing_outputs)
        else: platform.protect_path(job_dir / "dual.pdf")
        try:
            alignment.write(job_dir / "alignment.json", input_file,
                job_dir / "mono.pdf", job_dir / "dual.pdf", selected, request["pageCount"])
        except (ValueError, OSError, TypeError, KeyError):
            raise ProtocolFailure("invalid_output") from None
        return {"state": "complete"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-dir", required=True, type=Path)
    parser.add_argument("--cache-root", required=True, type=Path)
    parser.add_argument("--translator", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    os.environ["ASKGPT_PDF_OFFLINE"] = "1"
    install_offline_guard()
    logging.disable(logging.CRITICAL)
    # If the owning server dies, its pipe closes: terminate this whole job group,
    # including the dedicated native translator rather than leaving an orphan.
    def parent_watchdog():
        try:
            while os.read(0, 1): pass
        except OSError: pass
        # Give the native helper its shutdown path: Foundation can place the
        # CLI in a separate group, which the helper must retire explicitly.
        # SIGKILL here would prevent that cleanup after a server crash.
        if platform.IS_WINDOWS: os._exit(1)  # Job handles close and retire owned helpers.
        try: os.killpg(os.getpgrp(), signal.SIGTERM)
        except ProcessLookupError: pass
    threading.Thread(target=parent_watchdog, daemon=True).start()
    try:
        result = translate_job(args.job_dir, args.cache_root, args.translator)
    except ProtocolFailure as error:
        result = {"state": "failed", "error": str(error)}
        detail = getattr(error, "error_detail", None)
        if str(error) == "batch_invalid" and isinstance(detail, str) and detail in ERROR_DETAILS:
            result["errorDetail"] = detail
        page = getattr(error, "failed_page", None)
        if type(page) is int and 1 <= page <= 2000:
            result["failedPage"] = page
    except PermissionError:
        result = {"state": "failed", "error": "pdf_worker_network_disabled"}
    except Exception as error:
        scanned = "scanned" in type(error).__name__.lower()
        result = {"state": "failed", "error": "scanned_pdf_unsupported" if scanned else "layout_failed"}
    atomic_json(args.job_dir / "result.json", result)
    return 0 if result["state"] == "complete" else 1


if __name__ == "__main__": raise SystemExit(main())
