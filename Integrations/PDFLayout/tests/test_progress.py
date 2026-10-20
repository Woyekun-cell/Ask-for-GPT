import json
import os
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
import worker
import gpt_batch
from layout_common import ProtocolFailure, atomic_json


class WorkerProgressTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(worker, "JobProgress"), "worker page progress is missing")
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)

    def tearDown(self):
        if hasattr(self, "temp"): self.temp.cleanup()

    def read(self): return json.loads((self.directory / "progress.json").read_text())

    def test_real_page_completions_advance_once_then_enter_layout(self):
        progress = worker.JobProgress(self.directory, 2)
        self.assertEqual(self.read(), {"stage": "preparing"})
        progress.start_page()
        self.assertEqual(self.read(), {"stage": "translating", "completed": 0, "total": 2})
        progress.finish_page(0)
        self.assertEqual(self.read(), {"stage": "translating", "completed": 1, "total": 2})
        progress.finish_page(0)
        self.assertEqual(self.read()["completed"], 1)
        progress.start_page()
        self.assertEqual(self.read()["completed"], 1)
        progress.finish_page(1)
        self.assertEqual(self.read(), {"stage": "layout"})
        self.assertEqual((self.directory / "progress.json").stat().st_mode & 0o777, 0o600)

    def test_failed_or_out_of_range_callbacks_cannot_report_fake_completion(self):
        progress = worker.JobProgress(self.directory, 2)
        progress.start_page()
        for value in [None, -1, 2, True, "1"]:
            progress.finish_page(value)
            self.assertEqual(self.read(), {"stage": "translating", "completed": 0, "total": 2})

    def test_progress_write_failure_does_not_change_translation_outcome(self):
        with patch.object(worker, "atomic_json", side_effect=OSError("synthetic progress IO failure")):
            progress = worker.JobProgress(self.directory, 1)
            progress.start_page()
            progress.finish_page(0)


class PageAdapterProgressTests(unittest.TestCase):
    def translator(self, translate, events):
        cls = gpt_batch.page_translator_class()
        instance = cls.__new__(cls)
        instance.translation_config = SimpleNamespace(raise_if_cancelled=lambda: None)
        instance.translate_engine = SimpleNamespace(batch_translate=translate, fatal_error=None,
            page_started=lambda: events.append("started"),
            page_completed=lambda index: events.append(("completed", index)))
        instance.pre_translate_paragraph = lambda paragraph, tracker, fonts, xfonts: (
            (None, None) if paragraph.unicode == "SKIP" else (paragraph.unicode, paragraph.unicode))
        def apply(paragraph, tracker, prepared, text):
            paragraph.unicode = text
            events.append("applied")
        instance.post_translate_paragraph = apply
        return instance

    def test_completion_follows_validation_and_actual_ir_apply(self):
        events = []
        translate = lambda rows: [{"id": item["id"], "text": "译文 {v1}"} for item in rows]
        instance = self.translator(translate, events)
        page = SimpleNamespace(page_number=0, pdf_font=[], pdf_xobject=[],
            pdf_paragraph=[SimpleNamespace(unicode="Value {v1}")])
        instance.process_page(page, None, None, SimpleNamespace(new_paragraph=lambda: object()))
        self.assertEqual(events, ["started", "applied", ("completed", 0)])

    def test_invalid_batch_never_increments_completed_pages(self):
        events = []
        instance = self.translator(lambda rows: [{"id": "p0", "text": "Formula omitted"}], events)
        page = SimpleNamespace(page_number=0, pdf_font=[], pdf_xobject=[],
            pdf_paragraph=[SimpleNamespace(unicode="Value {v1}")])
        with self.assertRaises(ProtocolFailure):
            instance.process_page(page, None, None, SimpleNamespace(new_paragraph=lambda: object()))
        self.assertEqual(events, ["started"])

    def test_page_requiring_no_translation_is_actually_processed_once(self):
        events = []
        instance = self.translator(lambda rows: self.fail("no translatable text must not invoke GPT"), events)
        page = SimpleNamespace(page_number=0, pdf_font=[], pdf_xobject=[],
            pdf_paragraph=[SimpleNamespace(unicode="SKIP")])
        instance.process_page(page, None, None, SimpleNamespace(new_paragraph=lambda: object()))
        self.assertEqual(events, [("completed", 0)])


class PublicProgressTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.job = server.Job("a" * 32, self.directory, source_pages=[0, 2], page_count=3)

    def tearDown(self): self.temp.cleanup()

    def write(self, value): atomic_json(self.directory / "progress.json", value)

    def test_running_job_exposes_only_valid_progress_and_terminal_jobs_hide_it(self):
        self.assertEqual(self.job.public().get("progress"), {"stage": "preparing"})
        self.write({"stage": "translating", "completed": 1, "total": 2})
        self.assertEqual(self.job.public()["progress"], {"stage": "translating", "completed": 1, "total": 2})
        for stage in ["preparing", "layout"]:
            self.write({"stage": stage})
            self.assertEqual(self.job.public()["progress"], {"stage": stage})
        for state in ["complete", "cancelled", "failed"]:
            self.job.state = state
            self.assertNotIn("progress", self.job.public())

    def test_malformed_progress_never_exposes_paths_or_source_content(self):
        for value in [{"stage": "unknown"}, {"stage": "preparing", "text": "synthetic private source"},
                      {"stage": "translating", "completed": True, "total": 2},
                      {"stage": "translating", "completed": -1, "total": 2},
                      {"stage": "translating", "completed": 3, "total": 2},
                      {"stage": "translating", "completed": 1, "total": 3},
                      {"stage": "translating", "completed": 1, "total": 2, "path": "/private/synthetic"},
                      [], "synthetic"]:
            with self.subTest(value=value):
                self.write(value)
                self.assertEqual(self.job.public().get("progress"), {"stage": "preparing"})

    def test_unsafe_progress_file_is_not_followed_or_repaired(self):
        path = self.directory / "progress.json"
        self.write({"stage": "layout"})
        path.chmod(0o644)
        self.assertEqual(self.job.public().get("progress"), {"stage": "preparing"})
        self.assertEqual(path.stat().st_mode & 0o777, 0o644)
        path.unlink()
        target = self.directory / "synthetic-private.json"
        target.write_text('{"stage":"layout"}')
        target.chmod(0o600)
        path.symlink_to(target)
        self.assertEqual(self.job.public().get("progress"), {"stage": "preparing"})
        path.unlink()
        self.write({"stage": "layout"})
        with patch.object(server.os, "getuid", return_value=os.getuid() + 1):
            self.assertEqual(self.job.public().get("progress"), {"stage": "preparing"})
        path.write_bytes(b"x" * 4097)
        self.assertEqual(self.job.public().get("progress"), {"stage": "preparing"})

    def test_cancelled_job_cleans_and_ignores_late_progress(self):
        manager = server.JobManager(self.directory / "cache", Path(sys.executable), ready_override=True)
        job = manager.begin()
        job.source_pages, job.page_count = [0, 1], 2
        atomic_json(job.directory / "progress.json", {"stage": "translating", "completed": 1, "total": 2})
        (job.directory / "progress.tmp").write_text('{"stage":"layout"}')
        result = manager.cancel(job)
        self.assertEqual(result["state"], "cancelled")
        self.assertNotIn("progress", result)
        self.assertFalse((job.directory / "progress.json").exists())
        self.assertFalse((job.directory / "progress.tmp").exists())
        atomic_json(job.directory / "progress.json", {"stage": "layout"})
        self.assertNotIn("progress", job.public())


if __name__ == "__main__": unittest.main()
