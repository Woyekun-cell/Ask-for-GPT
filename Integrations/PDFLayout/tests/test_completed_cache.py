"""Whole-document cache extraction uses real vector/image PDFs, never a model."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from layout_common import BABELDOC_VERSION, atomic_json
from worker import compose_dual


class WholeDocumentRangeCacheTests(unittest.TestCase):
    def setUp(self):
        import pymupdf
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.worker = self.root / "vector-only-fixture-worker.py"
        self.worker.write_text("raise RuntimeError('vector fixture must never start a worker')\n")
        self.manager = server.JobManager(self.root / "cache", Path(sys.executable),
            worker_script=self.worker, ready_override=True)
        self.managers = [self.manager]
        with pymupdf.open() as document:
            for index in range(4):
                page = document.new_page(width=220, height=320)
                page.insert_text((25, 45), "SOURCE " + str(index + 1), fontsize=12)
                page.draw_rect(pymupdf.Rect(30, 90, 185, 155), color=(.1, .2, .7), fill=(.1 * index, .6, .4))
                pixmap = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 3, 3), 0)
                pixmap.clear_with(30 + 40 * index)
                page.insert_image(pymupdf.Rect(40, 190, 140, 245), pixmap=pixmap)
                if index == 1: page.set_rotation(90)
                if index == 2: page.set_cropbox(pymupdf.Rect(10, 15, 205, 300))
            self.pdf = document.tobytes()

    def tearDown(self):
        for manager in self.managers: manager.shutdown()
        self.temp.cleanup()

    def install_whole(self, *, selected=None, source="en", target="zh-Hans", revision=None, babeldoc=None):
        import pymupdf
        pages = list(range(4)) if selected is None else selected
        job = self.manager.begin()
        original = self.root / "fixture-original.pdf"
        original.write_bytes(self.pdf)
        with pymupdf.open(stream=self.pdf, filetype="pdf") as document:
            for index in range(4): document[index].insert_text((25, 75), "TRANSLATED " + str(index + 1), fontsize=11)
            document.select(pages)
            document.save(job.directory / "mono.pdf")
        compose_dual(original, job.directory / "mono.pdf", pages, job.directory / "dual.pdf")
        digest = hashlib.sha256(self.pdf).hexdigest()
        revision = revision or self.manager.translation_revision
        job.cache_info = {"cacheKey": server._cache_key(digest, pages, 4, source, target, revision),
            "sourceSHA256": digest, "sourcePages": pages, "pageCount": 4, "source": source, "target": target,
            "revision": revision, "babeldoc": babeldoc or BABELDOC_VERSION}
        job.page_count, job.source_pages = 4, pages
        self.manager._store_completed(job)
        job.state = "complete"
        self.manager.active.discard(job.id)
        return job

    def submit(self, pages="2", *, manager=None, source="en", target="zh-Hans", pdf=None):
        manager = manager or self.manager
        job = manager.begin()
        path = job.directory / "input.pdf"
        path.write_bytes(self.pdf if pdf is None else pdf)
        path.chmod(0o600)
        return job, manager.submit(job, pages, source, target)

    def assert_preserved(self, original, extracted, selected):
        import pymupdf
        with pymupdf.open(original) as whole, pymupdf.open(extracted) as output:
            self.assertEqual(len(output), len(selected))
            for local, physical in enumerate(selected):
                before, after = whole[physical], output[local]
                self.assertEqual(after.mediabox, before.mediabox)
                self.assertEqual(after.cropbox, before.cropbox)
                self.assertEqual(after.rotation, before.rotation)
                self.assertEqual(after.read_contents(), before.read_contents())
                self.assertEqual(len(after.get_images()), len(before.get_images()))
                self.assertEqual(len(after.get_drawings()), len(before.get_drawings()))
                self.assertEqual(after.get_pixmap(alpha=False).samples, before.get_pixmap(alpha=False).samples)

    def test_whole_to_single_and_multi_page_are_immediate_standalone_verified_caches(self):
        whole = self.install_whole()
        for pages, selected in [("2", [1]), ("1,3", [0, 2]), ("4", [3])]:
            with self.subTest(pages=pages), patch.object(server.subprocess, "Popen", side_effect=AssertionError("range reuse spawned worker")):
                job, result = self.submit(pages)
            self.assertEqual(result["state"], "complete")
            self.assertEqual(result["id"], job.id)
            self.assertNotEqual(job.id, whole.id)
            self.assertEqual(result["sourcePages"], selected)
            self.assertEqual(result["pageCount"], 4)
            self.assertNotIn("progress", result)
            self.assertIsNone(job.process)
            self.assertFalse(self.manager.active)
            self.assertFalse((job.directory / "input.pdf").exists())
            self.assertFalse((job.directory / "request.json").exists())
            for kind in ["mono", "dual"]:
                output = job.directory / (kind + ".pdf")
                self.assertEqual(output.stat().st_mode & 0o777, 0o600)
                self.assert_preserved(whole.directory / (kind + ".pdf"), output, selected)
            self.assertEqual(self.manager.completed[job.cache_info["cacheKey"]], job.id)
            self.assertEqual(json.loads((job.directory / "cache.json").read_text())["sourcePages"], selected)
        # A derived entry must remain usable after the whole cache is removed.
        self.manager.completed.pop(whole.cache_info["cacheKey"])
        with patch.object(server.subprocess, "Popen", side_effect=AssertionError("exact derived hit spawned worker")):
            placeholder, result = self.submit("1,3")
        self.assertEqual(result["sourcePages"], [0, 2])
        self.assertFalse(placeholder.directory.exists())

    def test_extracted_range_survives_restart_without_its_whole_output(self):
        whole = self.install_whole()
        with patch.object(server.subprocess, "Popen", side_effect=AssertionError("range reuse spawned worker")):
            extracted, _ = self.submit("3")
        for kind in ["mono", "dual"]: (whole.directory / (kind + ".pdf")).unlink()
        self.manager.shutdown()
        restarted = server.JobManager(self.root / "cache", Path(sys.executable),
            worker_script=self.worker, ready_override=True)
        self.managers.append(restarted)
        with patch.object(server.subprocess, "Popen", side_effect=AssertionError("restart lost extracted range")):
            _, result = self.submit("3", manager=restarted)
        self.assertEqual(result["id"], extracted.id)

    def assert_miss(self, **kwargs):
        # A normal fake worker is intentionally entered; an exception here ends
        # the fixture immediately and prevents launching any subprocess.
        with patch.object(server.subprocess, "Popen", side_effect=RuntimeError("synthetic_worker_path")) as spawn:
            with self.assertRaises(server.ProtocolFailure): self.submit(**kwargs)
        self.assertEqual(spawn.call_count, 1)
        self.assertFalse(self.manager.active)
        for job in self.manager.jobs.values():
            if job.state != "complete":
                self.assertFalse((job.directory / "mono.pdf").exists())
                self.assertFalse((job.directory / "dual.pdf").exists())
                self.assertFalse((job.directory / "cache.json").exists())

    def test_source_language_revision_and_babel_identity_are_not_crossed(self):
        whole = self.install_whole()
        self.assert_miss(source="zh-Hans", target="en")
        self.assert_miss(pdf=self.pdf + b"\n% changed original")
        self.manager.translation_revision += "-next"
        self.assert_miss()
        self.manager.translation_revision = server.TRANSLATION_REVISION
        whole.cache_info["babeldoc"] = "different"
        self.assert_miss()

    def test_old_fragment_generations_are_retained_but_cannot_supply_context_paragraph_results(self):
        for revision in ("pdf-layout-gpt-v5-aligned-visual", "pdf-layout-gpt-v6-paragraph-isolated"):
            with self.subTest(revision=revision):
                self.assertNotEqual(server.TRANSLATION_REVISION, revision)
                old = self.install_whole(revision=revision)
                old_files = {name: (old.directory / name).read_bytes() for name in ("mono.pdf", "dual.pdf", "cache.json")}
                fresh = server.JobManager(self.manager.cache_root, Path(sys.executable),
                    worker_script=self.worker, ready_override=True)
                self.managers.append(fresh)
                self.assertIsNone(fresh._cached_job(old.cache_info["cacheKey"]))
                fresh.prune()
                for name, data in old_files.items():
                    self.assertEqual((old.directory / name).read_bytes(), data)

    def test_partial_document_cache_cannot_impersonate_whole(self):
        self.install_whole(selected=[0, 2])
        self.assert_miss(pages="2")

    def test_unsafe_or_changed_output_never_supplies_an_extracted_page(self):
        for change in ["symlink", "hardlink", "mode", "changed", "wrong_page_count"]:
            with self.subTest(change=change):
                whole = self.install_whole()
                path = whole.directory / "dual.pdf"
                if change == "symlink":
                    outside = self.root / "outside.pdf"
                    outside.write_bytes(path.read_bytes()); path.unlink(); path.symlink_to(outside)
                elif change == "hardlink": os.link(path, self.root / "hardlink.pdf")
                elif change == "mode": path.chmod(0o644)
                elif change == "changed":
                    raw = bytearray(path.read_bytes()); raw[-1] ^= 1; path.write_bytes(raw)
                else:
                    import pymupdf
                    path.unlink()
                    with pymupdf.open() as document:
                        document.new_page(); document.save(path)
                    self.manager._store_completed(whole)
                self.assert_miss()
                self.manager.completed.pop(whole.cache_info["cacheKey"], None)

    def test_mutation_during_extraction_discards_both_outputs_and_uses_worker(self):
        whole = self.install_whole()
        original = server._output_signature
        hits = 0
        def changed_after_open(path):
            nonlocal hits
            if path == whole.directory / "mono.pdf":
                hits += 1
                if hits == 2:
                    with path.open("ab") as handle: handle.write(b"\n% changed while deriving")
            return original(path)
        with patch.object(server, "_output_signature", side_effect=changed_after_open): self.assert_miss()

    def test_derived_202_disconnect_does_not_destroy_the_completed_range(self):
        self.install_whole()
        service = server.create_server(self.manager, "a" * 64, port=0)
        thread = threading.Thread(target=service.serve_forever, daemon=True)
        thread.start()
        reply = service.RequestHandlerClass.reply
        def disconnected(handler, status, *args, **kwargs):
            if status == 202: raise BrokenPipeError("synthetic_derived_response_disconnect")
            return reply(handler, status, *args, **kwargs)
        service.RequestHandlerClass.reply = disconnected
        try:
            port = service.server_address[1]
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
            with patch.object(server.subprocess, "Popen", side_effect=AssertionError("disconnect spawned worker")):
                connection.request("POST", "/v1/pdf/jobs", self.pdf,
                    {"Host": f"127.0.0.1:{port}", "Authorization": "Bearer " + "a" * 64,
                     "Content-Type": "application/pdf", "X-AskGPT-Pages": "2",
                     "X-AskGPT-Source": "en", "X-AskGPT-Target": "zh-Hans"})
                response = connection.getresponse(); response.read(); connection.close()
                _, repeated = self.submit("2")
            self.assertEqual(repeated["state"], "complete")
            self.assertEqual(repeated["sourcePages"], [1])
            self.assertFalse(self.manager.active)
        finally:
            service.shutdown(); service.server_close(); thread.join(2)

    def test_incomplete_job_in_completed_index_cannot_return_a_cache_hit(self):
        whole = self.install_whole()
        whole.state = "failed"
        self.assertIsNone(self.manager._cached_job(whole.cache_info["cacheKey"]))
        self.assertNotIn(whole.cache_info["cacheKey"], self.manager.completed)


if __name__ == "__main__": unittest.main()
