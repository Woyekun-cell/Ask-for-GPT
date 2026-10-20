"""Fixed, text-free diagnostics survive the adapter/worker/service boundary."""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gpt_batch
import server
import worker
from layout_common import ProtocolFailure, atomic_json


class BatchFailureDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self): self.temp.cleanup()

    def run_failed_job(self, *, swallowed, detail="rowShape", local_page=1, selected=None):
        import pymupdf
        from babeldoc.format.pdf import high_level, translation_config
        from babeldoc.translator import translator as engine_translator
        selected = [1, 10] if selected is None else selected
        job = self.root / ("swallowed" if swallowed else "direct")
        job.mkdir(exist_ok=True)
        # Real configure_asset_home creates this private parent. The diagnostic
        # fixture patches asset setup, so retain its filesystem precondition for
        # the new global page-batch permits without masking their validation.
        (self.root / "cache").mkdir(mode=0o700, exist_ok=True)
        atomic_json(job / "request.json", {"sourcePages": selected, "source": "en", "target": "zh-Hans"})
        with pymupdf.open() as source:
            for _ in range(12): source.new_page()
            source.save(job / "input.pdf")

        def fail_batch(rows):
            failure = ProtocolFailure("batch_invalid")
            failure.error_detail = detail
            raise failure

        helper = SimpleNamespace(translate_batch=fail_batch)

        def babel_translate(configuration):
            # Use the real page adapter; emulate upstream retaining the source
            # after its exception rather than manually constructing fatal state.
            adapter = high_level.ILTranslator.__new__(high_level.ILTranslator)
            adapter.translation_config = SimpleNamespace(raise_if_cancelled=lambda: None)
            adapter.translate_engine = configuration.translator
            adapter.pre_translate_paragraph = lambda paragraph, *args: (paragraph.unicode, None)
            adapter.post_translate_paragraph = lambda *args: self.fail("invalid batch applied text")
            page = SimpleNamespace(page_number=local_page, pdf_font=[], pdf_xobject=[],
                pdf_paragraph=[SimpleNamespace(unicode="Private source text {v1}")])
            try:
                adapter.process_page(page, None, None, SimpleNamespace(new_paragraph=lambda: object()))
            except ProtocolFailure:
                if not swallowed: raise
            return SimpleNamespace(mono_pdf_path=None)

        with ExitStack() as stack:
            stack.enter_context(patch.object(worker, "configure_asset_home"))
            stack.enter_context(patch.object(high_level, "init"))
            stack.enter_context(patch.object(high_level, "translate", side_effect=babel_translate))
            stack.enter_context(patch.object(translation_config, "TranslationConfig", side_effect=lambda **kwargs: SimpleNamespace(**kwargs)))
            stack.enter_context(patch.object(engine_translator, "set_translate_rate_limiter"))
            helper_type = stack.enter_context(patch.object(worker, "NativeHelper"))
            helper_type.return_value.__enter__.return_value = helper
            with self.assertRaises(ProtocolFailure) as caught:
                worker.translate_job(job, self.root / "cache", self.root / "unused-helper")
        return caught.exception

    def test_babel_swallowed_batch_failure_retains_fixed_detail_and_physical_page(self):
        error = self.run_failed_job(swallowed=True)
        self.assertEqual(str(error), "batch_invalid")
        self.assertEqual(getattr(error, "error_detail", None), "rowShape")
        # Local compact page 1 is original physical page 11, not page 2.
        self.assertEqual(getattr(error, "failed_page", None), 11)

    def test_direct_adapter_failure_uses_same_physical_mapping(self):
        error = self.run_failed_job(swallowed=False, detail="count")
        self.assertEqual(getattr(error, "error_detail", None), "count")
        self.assertEqual(getattr(error, "failed_page", None), 11)

    def test_untrusted_details_and_invalid_local_page_are_not_exportable(self):
        for page in [True, -1, 2, "1", None, 2000]:
            with self.subTest(page=page):
                error = self.run_failed_job(swallowed=True, detail="private source/token", local_page=page)
                self.assertIsNone(getattr(error, "error_detail", None))
                self.assertIsNone(getattr(error, "failed_page", None))

    def test_worker_result_serializes_only_whitelisted_detail_and_numeric_page(self):
        for detail, page, expected in [
                ("formula", 11, {"errorDetail": "formula", "failedPage": 11}),
                ("rowShape", 2000, {"errorDetail": "rowShape", "failedPage": 2000}),
                ("private source/token", 2001, {}), ("formula", True, {"errorDetail": "formula"}),
                (None, "11", {}), ([], 0, {})]:
            with self.subTest(detail=detail, page=page):
                failure = ProtocolFailure("batch_invalid")
                failure.error_detail, failure.failed_page = detail, page
                with ExitStack() as stack:
                    stack.enter_context(patch.object(sys, "argv", ["worker", "--job-dir", str(self.root),
                        "--cache-root", str(self.root), "--translator", "unused"]))
                    stack.enter_context(patch.dict(os.environ))
                    stack.enter_context(patch.object(worker, "install_offline_guard"))
                    stack.enter_context(patch.object(worker.os, "umask"))
                    stack.enter_context(patch.object(worker.threading, "Thread"))
                    stack.enter_context(patch.object(worker, "translate_job", side_effect=failure))
                    self.assertEqual(worker.main(), 1)
                result = json.loads((self.root / "result.json").read_text())
                self.assertEqual(result, {"state": "failed", "error": "batch_invalid", **expected})
                self.assertEqual((self.root / "result.json").stat().st_mode & 0o777, 0o600)


class ServiceFailureDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.manager = server.JobManager(self.root / "cache", Path(sys.executable), ready_override=True)

    def tearDown(self):
        self.manager.shutdown()
        self.temp.cleanup()

    def monitor(self, result):
        job = self.manager.begin()
        job.source_pages, job.page_count = [1, 10], 12
        job.process = SimpleNamespace(wait=lambda: 1, stdin=None)
        atomic_json(job.directory / "result.json", result)
        with patch.object(server, "_finish_owned_group"):
            self.manager._monitor(job)
        self.assertFalse((job.directory / "result.json").exists())
        state_file = job.directory / "state.json"
        self.assertEqual(state_file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(state_file.read_text()), job.public())
        self.assertEqual(self.manager.completed, {})
        self.assertFalse((job.directory / "cache.json").exists())
        return job.public()

    def test_monitor_keeps_safe_failure_detail_after_removing_worker_result(self):
        result = self.monitor({"state": "failed", "error": "batch_invalid", "errorDetail": "rowShape",
            "failedPage": 11, "text": "private body", "token": "private token"})
        self.assertEqual(result, {"id": result["id"], "state": "failed", "sourcePages": [1, 10],
            "pageCount": 12, "error": "batch_invalid", "errorDetail": "rowShape", "failedPage": 11})

    def test_monitor_drops_unsafe_fields_without_misreporting_formula(self):
        for detail, page in [("private body/token", 11), (["formula"], True), ("count", "11"),
                             ("empty", 2001), ("id", 3), (None, 0)]:
            with self.subTest(detail=detail, page=page):
                result = self.monitor({"state": "failed", "error": "batch_invalid",
                    "errorDetail": detail, "failedPage": page})
                self.assertEqual(result["error"], "batch_invalid")
                if isinstance(detail, str) and detail in gpt_batch.ERROR_DETAILS:
                    self.assertEqual(result.get("errorDetail"), detail)
                else: self.assertNotIn("errorDetail", result)
                if type(page) is int and page in {2, 11}:
                    self.assertEqual(result.get("failedPage"), page)
                else: self.assertNotIn("failedPage", result)
                self.assertNotIn("private", json.dumps(result))

    def test_detail_is_only_valid_for_batch_invalid(self):
        result = self.monitor({"state": "failed", "error": "translation_timeout",
            "errorDetail": "formula", "failedPage": 2})
        self.assertNotIn("errorDetail", result)
        self.assertEqual(result.get("failedPage"), 2)


if __name__ == "__main__": unittest.main()
