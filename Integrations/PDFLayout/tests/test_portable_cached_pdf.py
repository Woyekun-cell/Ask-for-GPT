"""Exercise the Windows descriptor/stream cache path with real vector PDFs."""
import os
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import platform_ops as platform
import server

class PortableCachedPdfTests(unittest.TestCase):
    def test_whole_cache_extracts_vector_pages_without_device_paths(self):
        import pymupdf
        with tempfile.TemporaryDirectory(prefix='cached PDF 中文 ') as temp:
            root = platform.private_directory(Path(temp) / 'private')
            whole_dir = platform.private_directory(root / 'whole')
            selected_dir = platform.private_directory(root / 'selected')
            with pymupdf.open() as document:
                for number in range(3):
                    page = document.new_page(width=220, height=320)
                    page.insert_text((20, 40), 'PAGE ' + str(number))
                    page.draw_rect((30, 80, 180, 150), fill=(0.2, number/4, 0.6))
                    if number == 1: page.set_rotation(90)
                data = document.tobytes()
            signatures = {}
            for kind in ('mono', 'dual'):
                path = whole_dir / (kind + '.pdf')
                fd = platform.secure_open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(fd, 'wb') as stream: stream.write(data)
                signatures[kind] = server._output_signature(path)
            whole = SimpleNamespace(directory=whole_dir, output_signatures=signatures, page_count=3)
            job = SimpleNamespace(directory=selected_dir)
            original = server._open_pdf_descriptor
            with patch.object(server, '_open_pdf_descriptor', lambda handle: original(handle, windows=True)):
                server.JobManager._extract_cached_pages(None, whole, job, [1])
            with pymupdf.open(stream=data, filetype='pdf') as document:
                for kind in ('mono', 'dual'):
                    with pymupdf.open(selected_dir / (kind + '.pdf')) as selected:
                        self.assertEqual(len(selected), 1)
                        self.assertEqual(selected[0].rotation, document[1].rotation)
                        self.assertEqual(selected[0].read_contents(), document[1].read_contents())
                        self.assertEqual(len(selected[0].get_drawings()), len(document[1].get_drawings()))
                        self.assertEqual(selected[0].get_pixmap().samples, document[1].get_pixmap().samples)

    def test_oversize_rejected_before_read(self):
        handle = SimpleNamespace(fileno=lambda: 4, read=lambda n: self.fail('oversize read'))
        with patch.object(server.os, 'fstat', return_value=SimpleNamespace(st_size=server.MAX_OUTPUT_BYTES+1)):
            with self.assertRaises(ValueError): server._open_pdf_descriptor(handle, windows=True)

if __name__ == '__main__': unittest.main()
