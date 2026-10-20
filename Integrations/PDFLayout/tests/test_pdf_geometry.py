from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import worker


class PDFGeometryTests(unittest.TestCase):
    def test_selected_pages_from_twelve_page_source_keep_mapping_and_exact_pixels(self):
        import pymupdf
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with pymupdf.open() as source:
                for index in range(12):
                    page = source.new_page(width=200, height=300)
                    page.insert_text((30, 45), "PHYSICAL PAGE " + str(index + 1), fontsize=12)
                    page.draw_rect(pymupdf.Rect(25, 80, 175, 160), color=(.2, .4, .6),
                                   fill=(index / 12, .8, .4))
                    image = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 2, 2), 0)
                    image.clear_with(50 + index * 10)
                    page.insert_image(pymupdf.Rect(30, 180, 100, 230), pixmap=image)
                    if index % 2: page.set_rotation(90)
                    if index == 10: page.set_cropbox(pymupdf.Rect(10, 20, 190, 290))
                source.save(root / "source.pdf")
            original_bytes = (root / "source.pdf").read_bytes()
            for selected in [[10], [1, 10]]:
                with self.subTest(selected=selected):
                    worker.prepare_engine_input(root / "source.pdf", root / "engine.pdf", selected)
                    with pymupdf.open(root / "source.pdf") as source, pymupdf.open(root / "engine.pdf") as engine:
                        self.assertEqual(len(engine), len(selected))
                        for local_index, source_index in enumerate(selected):
                            self.assertEqual(engine[local_index].read_contents(), source[source_index].read_contents())
                            self.assertIn(str(source_index + 1), engine[local_index].get_text())
                            self.assertEqual(engine[local_index].rotation, 0)
                            self.assertEqual(engine[local_index].cropbox, engine[local_index].mediabox)
                    worker.restore_mono_geometry(root / "source.pdf", root / "engine.pdf", selected, root / "mono.pdf")
                    worker.compose_dual(root / "source.pdf", root / "mono.pdf", selected, root / "dual.pdf")
                    with pymupdf.open(root / "source.pdf") as source, pymupdf.open(root / "mono.pdf") as mono, pymupdf.open(root / "dual.pdf") as dual:
                        self.assertEqual(len(mono), len(selected))
                        for local_index, source_index in enumerate(selected):
                            original = source[source_index]
                            self.assertEqual(mono[local_index].rotation, original.rotation)
                            self.assertEqual(mono[local_index].cropbox, original.cropbox)
                            expected = original.get_pixmap(alpha=False)
                            self.assertEqual(mono[local_index].get_pixmap(alpha=False).samples, expected.samples)
                            visible = original.rect
                            left = dual[local_index].get_pixmap(clip=pymupdf.Rect(0, 0, visible.width, visible.height), alpha=False)
                            self.assertEqual(left.samples, expected.samples)
                            self.assertEqual(len(mono[local_index].get_images()), len(original.get_images()))
                    self.assertEqual((root / "source.pdf").read_bytes(), original_bytes)

    def test_crop_normalization_restores_visible_pixels_without_editing_content(self):
        import pymupdf
        import numpy as np
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = pymupdf.open()
            page = source.new_page(width=200, height=300)
            page.draw_rect(pymupdf.Rect(20, 80, 180, 170), color=(0, 0, 1), fill=(.3, .8, .5))
            page.insert_text((25, 45), "CROP VECTOR", fontsize=12)
            page.set_cropbox(pymupdf.Rect(10, 20, 190, 290))
            source.save(root / "source.pdf")
            worker.prepare_engine_input(root / "source.pdf", root / "engine.pdf")
            with pymupdf.open(root / "engine.pdf") as engine:
                self.assertEqual(engine[0].cropbox, engine[0].mediabox)
                self.assertEqual(engine[0].read_contents(), source[0].read_contents())
            worker.restore_mono_geometry(root / "source.pdf", root / "engine.pdf", [0], root / "mono.pdf")
            with pymupdf.open(root / "mono.pdf") as mono:
                self.assertEqual(mono[0].cropbox, source[0].cropbox)
                expected = np.frombuffer(source[0].get_pixmap(alpha=False).samples, dtype=np.uint8)
                actual = np.frombuffer(mono[0].get_pixmap(alpha=False).samples, dtype=np.uint8)
                self.assertTrue(np.array_equal(expected, actual))
            source.close()

    def test_engine_input_changes_metadata_not_content_and_restores_exact_pixels(self):
        import pymupdf
        import numpy as np
        self.assertTrue(hasattr(worker, "prepare_engine_input"), "rotation normalization is missing")
        self.assertTrue(hasattr(worker, "restore_mono_geometry"), "rotation restoration is missing")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = pymupdf.open()
            page = source.new_page(width=200, height=300)
            page.draw_rect(pymupdf.Rect(20, 80, 180, 170), color=(0, 0, 1), fill=(.3, .8, .5))
            page.insert_text((25, 45), "ROTATED VECTOR", fontsize=12)
            page.set_rotation(90)
            source.save(root / "source.pdf")
            before = (root / "source.pdf").read_bytes()
            worker.prepare_engine_input(root / "source.pdf", root / "engine.pdf")
            self.assertEqual((root / "source.pdf").read_bytes(), before)
            with pymupdf.open(root / "engine.pdf") as engine:
                self.assertEqual(engine[0].rotation, 0)
                self.assertEqual(engine[0].get_drawings()[0]["rect"], source[0].get_drawings()[0]["rect"])
            worker.restore_mono_geometry(root / "source.pdf", root / "engine.pdf", [0], root / "mono.pdf")
            with pymupdf.open(root / "mono.pdf") as mono:
                self.assertEqual(mono[0].rotation, 90)
                expected = np.frombuffer(source[0].get_pixmap(alpha=False).samples, dtype=np.uint8)
                actual = np.frombuffer(mono[0].get_pixmap(alpha=False).samples, dtype=np.uint8)
                self.assertTrue(np.array_equal(expected, actual))
            source.close()

    def test_dual_preserves_visible_crop_rotation_and_pixels(self):
        import pymupdf
        import numpy as np
        self.assertTrue(hasattr(worker, "compose_dual"), "visible-page dual adapter is missing")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = pymupdf.open()
            for number in range(3):
                page = source.new_page(width=200, height=300)
                page.draw_rect(pymupdf.Rect(15, 15, 180, 280), color=(1, 0, 0), fill=(.2, .8, .4))
                page.insert_text((25, 45), "SYNTHETIC PAGE", fontsize=12)
                if number == 1: page.set_rotation(90)
                if number == 2: page.set_cropbox(pymupdf.Rect(10, 20, 190, 290))
            source.save(root / "source.pdf")
            source.save(root / "mono.pdf")
            worker.compose_dual(root / "source.pdf", root / "mono.pdf", [0, 1, 2], root / "dual.pdf")
            with pymupdf.open(root / "dual.pdf") as dual:
                self.assertEqual(len(dual), 3)
                for number in range(3):
                    original = source[number]
                    bounds = original.rect
                    self.assertAlmostEqual(dual[number].rect.width, bounds.width * 2)
                    self.assertAlmostEqual(dual[number].rect.height, bounds.height)
                    expected = original.get_pixmap(alpha=False)
                    for clip in [pymupdf.Rect(0, 0, bounds.width, bounds.height),
                                 pymupdf.Rect(bounds.width, 0, bounds.width * 2, bounds.height)]:
                        actual = dual[number].get_pixmap(clip=clip, alpha=False)
                        self.assertEqual((actual.width, actual.height), (expected.width, expected.height))
                        left = np.frombuffer(actual.samples, dtype=np.uint8).astype(int)
                        right = np.frombuffer(expected.samples, dtype=np.uint8).astype(int)
                        self.assertLess(float(np.mean(np.abs(left - right))), .5, f"page={number}")
            source.close()


if __name__ == "__main__": unittest.main()
