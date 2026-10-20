"""Real page geometry and authenticated provenance; no model/network calls."""
import copy
import hashlib
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import alignment
import server
from layout_common import atomic_json, BABELDOC_VERSION, ProtocolFailure
from worker import compose_dual


def glyph(text, rect):
    return NS(char_unicode=text, box=NS(x=rect[0], y=rect[1], x2=rect[2], y2=rect[3]))


def paragraph(text, x=20, y=220):
    return NS(unicode=text, pdf_paragraph_composition=[NS(pdf_character=glyph(char, [x+i*9, y, x+i*9+8, y+12]))
              for i, char in enumerate(text)])


class AlignmentTests(unittest.TestCase):
    def setUp(self):
        import pymupdf
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "source.pdf"
        self.mono = self.root / "mono.pdf"
        self.dual = self.root / "dual.pdf"
        with pymupdf.open() as document:
            for index in range(3):
                page = document.new_page(width=240, height=320)
                page.insert_text((20, 80), "ORIGINAL " + str(index))
                if index == 1:
                    page.set_cropbox(pymupdf.Rect(10, 20, 225, 300))
                    page.set_rotation(90)
            document.save(self.source)
            document.save(self.mono)
        compose_dual(self.source, self.mono, [0, 1, 2], self.dual)
        self.sha = hashlib.sha256(self.source.read_bytes()).hexdigest()

    def tearDown(self): self.temporary.cleanup()

    def test_source_visual_glyph_bounds_take_priority_without_changing_baseline_grouping(self):
        first, second = glyph("g", [20,100,28,110]), glyph("A", [29,100,37,110])
        first.visual_bbox=NS(box=NS(x=20.5,y=97.8,x2=27.8,y2=105.4))
        second.visual_bbox=NS(box=NS(x=29.1,y=100.2,x2=36.9,y2=107.3))
        self.assertEqual(alignment._line_rects([first,second]), [[20.5,97.8,36.9,107.3]])

    def test_target_font_metrics_cover_descenders_and_superscripts_remain_separate(self):
        import pymupdf
        font=pymupdf.Font("helv")
        first, second = glyph("g",[20,100,26,110]), glyph("A",[27,100,34,110])
        for char in (first,second): char.pdf_style=NS(font_id="mapped",font_size=10)
        superscript=glyph("2",[34,107,38,113]);superscript.pdf_style=NS(font_id="mapped",font_size=6)
        mapper=NS(fontid2font={"mapped":font})
        result=alignment._line_rects([first,second,superscript],font_mapper=mapper)
        self.assertEqual(len(result),2)
        self.assertAlmostEqual(result[0][1],100+font.descender*10,places=4)
        self.assertAlmostEqual(result[0][3],100+font.ascender*10,places=4)
        self.assertEqual(result[0][0::2],[20,34])

    def test_existing_visual_bounds_win_over_target_font_metrics(self):
        char=glyph("x",[20,100,28,110]);char.pdf_style=NS(font_id="mapped",font_size=10)
        char.visual_bbox=NS(box=NS(x=20.1,y=99,x2=27.9,y2=108))
        mapper=NS(fontid2font={"mapped":NS(ascender=1.15,descender=-.286)})
        self.assertEqual(alignment._line_rects([char],font_mapper=mapper),[[20.1,99,27.9,108]])

    def collect(self):
        collector = alignment.AlignmentCollector()
        for index in range(3):
            first, second = paragraph("source first", 20, 220), paragraph("source second", 20, 160)
            page = NS(page_number=index, pdf_paragraph=[first, second])
            collector.capture_source_page(page)
            # Swap target locations AND ordering. Only object provenance can
            # still associate the right source; nearest-position matching fails.
            first.unicode = "第一译文"; first.pdf_paragraph_composition = paragraph(first.unicode, 20, 160).pdf_paragraph_composition
            second.unicode = "第二译文"; second.pdf_paragraph_composition = paragraph(second.unicode, 20, 220).pdf_paragraph_composition
            page.pdf_paragraph.reverse()
            collector.capture_target_document(NS(page=[page]))
        return collector.write(self.root / "alignment.json", self.source, self.mono, self.dual, [0, 1, 2], 3)

    def test_ir_identity_survives_changed_text_reordered_paragraphs_and_positions(self):
        value = self.collect()
        self.assertEqual(value["granularity"], "paragraph")
        for physical, page in enumerate(value["pages"]):
            first, second = page["paragraphs"]
            self.assertEqual(first["id"], f"p{physical}_0")
            self.assertEqual(first["source"]["text"], "source first")
            self.assertEqual(first["target"]["text"], "第一译文")
            self.assertEqual(first["source"]["rects"][0][1], 220)
            self.assertEqual(first["target"]["rects"][0][1], 160)
            self.assertEqual(second["target"]["text"], "第二译文")
        self.assertEqual((self.root / "alignment.json").stat().st_mode & 0o777, 0o600)

    def test_rotated_cropped_dual_transform_round_trips_every_point(self):
        import pymupdf
        value = self.collect()
        with pymupdf.open(self.source) as source, pymupdf.open(self.dual) as dual:
            for index, page in enumerate(value["pages"]):
                for side, offset in [("sourceToDual", 0), ("targetToDual", source[index].rect.width)]:
                    matrix = pymupdf.Matrix(*page[side])
                    original = pymupdf.Point(35, 240)
                    mapped = original * matrix
                    # Independent visible-crop calculation, including the
                    # rotated+cropped case where PyMuPDF's matrix is incorrect.
                    crop = source[index].cropbox
                    expected = pymupdf.Point(original.x - crop.x0,
                        source[index].mediabox.y1 - original.y - crop.y0)
                    if source[index].rotation == 90:
                        expected = pymupdf.Point(crop.height - expected.y, expected.x)
                    expected.x += offset
                    expected *= ~dual[index].transformation_matrix
                    self.assertLess(abs(mapped.x - expected.x) + abs(mapped.y - expected.y), .001)
                    restored = mapped * ~matrix
                    self.assertLess(abs(restored.x - original.x) + abs(restored.y - original.y), .001)
                target_rect = page["paragraphs"][0]["target"]["rects"][0]
                expected = list(pymupdf.Rect(target_rect) * pymupdf.Matrix(*page["targetToDual"]))
                actual = page["paragraphs"][0]["dualTarget"]["rects"][0]
                self.assertTrue(all(abs(a-b) < .001 for a,b in zip(actual, expected)))

    def test_dual_left_half_preserves_exact_visible_pixels_for_combined_crop_and_rotation(self):
        import pymupdf
        with pymupdf.open(self.source) as source, pymupdf.open(self.dual) as dual:
            for index in range(3):
                rect = source[index].rect
                self.assertAlmostEqual(dual[index].rect.width, rect.width * 2, places=3)
                self.assertAlmostEqual(dual[index].rect.height, rect.height, places=3)
                expected = source[index].get_pixmap(alpha=False)
                actual = dual[index].get_pixmap(clip=rect, alpha=False)
                self.assertEqual(actual.samples, expected.samples)

    def test_all_rotations_keep_visible_crop_and_vector_content(self):
        import pymupdf
        source_path, dual_path = self.root / "rotations.pdf", self.root / "rotations-dual.pdf"
        with pymupdf.open() as source:
            for rotation in (0, 90, 180, 270):
                page = source.new_page(width=240, height=320)
                page.draw_rect(pymupdf.Rect(30, 45, 100, 90), color=(.1,.3,.7), fill=(.2,.8,.4))
                page.insert_text((45, 165), "Visible content " + str(rotation), fontsize=12)
                page.set_cropbox(pymupdf.Rect(10, 20, 225, 300))
                page.set_rotation(rotation)
            source.save(source_path)
        compose_dual(source_path, source_path, [0,1,2,3], dual_path)
        with pymupdf.open(source_path) as source, pymupdf.open(dual_path) as dual:
            for index in range(4):
                with self.subTest(rotation=source[index].rotation):
                    original = source[index].get_pixmap(alpha=False)
                    left = dual[index].get_pixmap(clip=source[index].rect, alpha=False)
                    self.assertEqual(left.samples, original.samples)
                    self.assertAlmostEqual(dual[index].rect.width, source[index].rect.width*2, places=3)
                    self.assertEqual(len(dual[index].get_drawings()), len(source[index].get_drawings())*2)

    def test_subset_keeps_physical_ids_and_geometry_and_remaps_output_index(self):
        value = self.collect()
        subset = alignment.subset_alignment(value, [1, 2])
        alignment.validate_alignment(subset, [1, 2], 3, self.sha)
        self.assertEqual([x["outputPage"] for x in subset["pages"]], [0, 1])
        self.assertEqual([x["sourcePage"] for x in subset["pages"]], [1, 2])
        self.assertEqual(subset["pages"][0]["paragraphs"], value["pages"][1]["paragraphs"])

    def test_subset_keeps_only_its_phrase_extraction_coverage(self):
        value=self.collect()
        value.update(phraseExtractionRevision='pdf-glyph-boundary-v2',phraseExtractedPages=[0,1,2],
                     phraseCoverage={'0':{'sentences':3},'1':{'sentences':5},'2':{'sentences':2}})
        subset=alignment.subset_alignment(value,[1,2])
        self.assertEqual(subset['phraseExtractedPages'],[1,2])
        self.assertEqual(subset['phraseCoverage'],{'1':{'sentences':5},'2':{'sentences':2}})
        self.assertEqual(subset['phraseExtractionRevision'],'pdf-glyph-boundary-v2')
        self.assertEqual(value['phraseExtractedPages'],[0,1,2])
        self.assertEqual(set(value['phraseCoverage']),{'0','1','2'})

    def test_unknown_or_unrendered_paragraph_never_gets_invented_geometry(self):
        collector = alignment.AlignmentCollector()
        source = paragraph("source")
        page = NS(page_number=0, pdf_paragraph=[source])
        collector.capture_source_page(page)
        page.pdf_paragraph = [paragraph("translated but unrelated")]
        collector.capture_target_document(NS(page=[page]))
        value = collector.write(self.root / "alignment.json", self.source, self.mono, self.dual, [0, 1, 2], 3)
        self.assertTrue(all(not page["paragraphs"] for page in value["pages"]))

    def test_target_excerpt_uses_restored_glyphs_instead_of_formula_style_anchors(self):
        collector = alignment.AlignmentCollector()
        block = paragraph("Source equation E=mc²")
        page = NS(page_number=0, pdf_paragraph=[block])
        collector.capture_source_page(page)
        block.unicode = "译文{v1}"
        block.pdf_paragraph_composition = paragraph("译文E=mc²").pdf_paragraph_composition
        collector.capture_target_document(NS(page=[page]))
        value = collector.write(self.root / "alignment.json", self.source, self.mono, self.dual, [0,1,2], 3)
        self.assertEqual(value["pages"][0]["paragraphs"][0]["target"]["text"], "译文E=mc²")

    def test_invalid_coordinates_identity_or_source_hash_are_rejected(self):
        value = self.collect()
        for change in ("nan", "degenerate", "page", "duplicate", "matrix", "hash"):
            invalid = copy.deepcopy(value)
            row = invalid["pages"][0]
            if change == "nan": row["paragraphs"][0]["target"]["rects"][0][0] = float("nan")
            if change == "degenerate": row["paragraphs"][0]["target"]["rects"][0][2] = -1
            if change == "page": row["sourcePage"] = 2
            if change == "duplicate": row["paragraphs"].append(row["paragraphs"][0])
            if change == "matrix": row["sourceToDual"] = [0]*6
            if change == "hash": invalid["sourceSHA256"] = "0"*64
            with self.subTest(change=change), self.assertRaises(ValueError):
                alignment.validate_alignment(invalid, [0, 1, 2], 3, self.sha)

    def test_completed_cache_derivation_and_restart_preserve_verified_sidecar(self):
        value = self.collect()
        manager = server.JobManager(self.root / "cache", Path(sys.executable), ready_override=True)
        self.addCleanup(manager.shutdown)
        job = manager.begin()
        for name in ("mono.pdf", "dual.pdf", "alignment.json"):
            (job.directory / name).write_bytes((self.root / name).read_bytes())
            (job.directory / name).chmod(0o600)
        job.source_pages, job.page_count = [0, 1, 2], 3
        job.cache_info = {"cacheKey": server._cache_key(self.sha, job.source_pages, 3, "en", "zh-Hans", manager.translation_revision),
            "sourceSHA256": self.sha, "sourcePages": job.source_pages, "pageCount": 3,
            "source": "en", "target": "zh-Hans", "revision": manager.translation_revision, "babeldoc": BABELDOC_VERSION}
        manager._store_completed(job); job.state = "complete"; manager._release_active(job)
        self.assertTrue(job.public()["alignmentAvailable"])
        with patch.object(server.subprocess, "Popen", side_effect=AssertionError("derived cache spawned model")):
            derived = manager.begin()
            (derived.directory / "input.pdf").write_bytes(self.source.read_bytes())
            (derived.directory / "input.pdf").chmod(0o600)
            result = manager.submit(derived, "2", "en", "zh-Hans")
        self.assertTrue(result["alignmentAvailable"])
        actual = json.loads((derived.directory / "alignment.json").read_text())
        self.assertEqual(actual["pages"][0]["paragraphs"], value["pages"][1]["paragraphs"])
        self.assertEqual(actual["pages"][0]["outputPage"], 0)
        expired=time.time()-365*24*60*60
        for completed in (job,derived):
            self.assertEqual(manager.cancel(completed)["state"],"complete")
            import os
            os.utime(completed.directory,(expired,expired))
        with patch.multiple(server,MAX_JOB_AGE=0,MAX_INACTIVE_JOBS=0,MAX_CACHE_BYTES=0):
            restarted = server.JobManager(manager.cache_root, Path(sys.executable), ready_override=True)
        self.addCleanup(restarted.shutdown)
        self.assertTrue(restarted.jobs[derived.id].public()["alignmentAvailable"])
        self.assertEqual(json.loads((derived.directory/"alignment.json").read_text()),actual)
        with patch.object(server.subprocess,"Popen",side_effect=AssertionError("permanent aligned cache started model")):
            placeholder=restarted.begin()
            (placeholder.directory/"input.pdf").write_bytes(self.source.read_bytes())
            (placeholder.directory/"input.pdf").chmod(0o600)
            reopened=restarted.submit(placeholder,"2","en","zh-Hans")
        self.assertEqual(reopened["id"],derived.id)

    def test_http_alignment_requires_auth_and_refuses_changed_links_and_permissions(self):
        self.collect()
        manager = server.JobManager(self.root / "cache", Path(sys.executable), ready_override=True)
        self.addCleanup(manager.shutdown)
        job = manager.begin()
        for name in ("mono.pdf", "dual.pdf", "alignment.json"):
            (job.directory / name).write_bytes((self.root / name).read_bytes()); (job.directory / name).chmod(0o600)
        job.source_pages, job.page_count = [0, 1, 2], 3
        job.cache_info = {"cacheKey": "0"*64, "sourceSHA256": self.sha}
        manager._store_completed(job); job.state = "complete"; manager._release_active(job)
        service = server.create_server(manager, "a"*64, port=0)
        thread = threading.Thread(target=service.serve_forever, daemon=True); thread.start()
        self.addCleanup(service.server_close); self.addCleanup(service.shutdown)
        def request(token="a"*64):
            port = service.server_address[1]
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
            connection.request("GET", f"/v1/pdf/jobs/{job.id}/alignment.json", headers={"Authorization":"Bearer "+token})
            response = connection.getresponse(); result=(response.status,response.read()); connection.close(); return result
        status, raw = request()
        self.assertEqual(status, 200); self.assertEqual(json.loads(raw)["sourceSHA256"], self.sha)
        self.assertEqual(request("b"*64)[0], 401)
        path = job.directory / "alignment.json"
        original = path.read_bytes()
        path.write_bytes(original + b" ")
        self.assertEqual(request()[0], 404)
        path.unlink(); path.symlink_to(self.root / "alignment.json")
        self.assertEqual(request()[0], 404)

    def test_production_worker_cannot_publish_pdf_without_provenance_sidecar(self):
        import subprocess
        script = self.root / "no-provenance-worker.py"
        script.write_text("import argparse,pathlib,shutil,json\n"
            "p=argparse.ArgumentParser();p.add_argument('--job-dir');p.add_argument('--cache-root');p.add_argument('--translator');a=p.parse_args()\n"
            "d=pathlib.Path(a.job_dir)\n"
            "shutil.copyfile(d/'input.pdf',d/'mono.pdf');shutil.copyfile(d/'input.pdf',d/'dual.pdf')\n"
            "(d/'result.json').write_text(json.dumps({'state':'complete'}))\n")
        manager = server.JobManager(self.root / "cache", Path(sys.executable), ready_override=True)
        self.addCleanup(manager.shutdown)
        real_popen = subprocess.Popen
        def substitute_worker(command, *args, **kwargs):
            self.assertEqual(Path(command[1]), Path(server.__file__).with_name("worker.py"))
            return real_popen([command[0], str(script), *command[2:]], *args, **kwargs)
        job = manager.begin()
        (job.directory / "input.pdf").write_bytes(self.source.read_bytes()); (job.directory / "input.pdf").chmod(0o600)
        with patch.object(server.subprocess, "Popen", side_effect=substitute_worker):
            manager.submit(job, "1", "en", "zh-Hans")
        deadline = time.monotonic()+6
        while job.state == "running" and time.monotonic() < deadline: time.sleep(.025)
        self.assertEqual(job.state, "failed")
        self.assertNotIn("alignmentAvailable", job.public())
        self.assertFalse(manager.completed)

    def test_production_restart_retains_but_never_reuses_cache_without_alignment_metadata(self):
        import os
        self.collect()
        manager=server.JobManager(self.root/"cache",Path(sys.executable),ready_override=True)
        self.addCleanup(manager.shutdown)
        job=manager.begin()
        for name in ("mono.pdf","dual.pdf","alignment.json"):
            (job.directory/name).write_bytes((self.root/name).read_bytes());(job.directory/name).chmod(0o600)
        job.source_pages,job.page_count=[0,1,2],3
        job.cache_info={"cacheKey":server._cache_key(self.sha,[0,1,2],3,"en","zh-Hans",manager.translation_revision),
            "sourceSHA256":self.sha,"sourcePages":[0,1,2],"pageCount":3,"source":"en","target":"zh-Hans",
            "revision":manager.translation_revision,"babeldoc":BABELDOC_VERSION}
        manager._store_completed(job);job.state="complete";manager._release_active(job)
        metadata=json.loads((job.directory/"cache.json").read_text());metadata.pop("alignment")
        atomic_json(job.directory/"cache.json",metadata)
        original={name:(job.directory/name).read_bytes() for name in ("mono.pdf","dual.pdf","alignment.json")}
        expired=time.time()-365*24*60*60;os.utime(job.directory,(expired,expired))
        manager.shutdown()
        with patch.multiple(server,MAX_JOB_AGE=0,MAX_INACTIVE_JOBS=0,MAX_CACHE_BYTES=0):
            restarted=server.JobManager(manager.cache_root,Path(sys.executable),ready_override=True)
        self.addCleanup(restarted.shutdown)
        self.assertNotIn(job.id,restarted.jobs)
        self.assertFalse(restarted.completed)
        for name,data in original.items(): self.assertEqual((job.directory/name).read_bytes(),data)
        placeholder=restarted.begin()
        (placeholder.directory/"input.pdf").write_bytes(self.source.read_bytes());(placeholder.directory/"input.pdf").chmod(0o600)
        with patch.object(server.subprocess,"Popen",side_effect=RuntimeError("new aligned worker required")) as spawn:
            with self.assertRaises(ProtocolFailure): restarted.submit(placeholder,"all","en","zh-Hans")
        self.assertEqual(spawn.call_count,1)


if __name__ == "__main__": unittest.main()
