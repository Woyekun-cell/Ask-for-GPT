"""Real protected source-upload fixture, portable to the Windows runner."""
import hashlib
import io
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import platform_ops as platform
import server
from selection_service import SelectionAlignmentService


class PortableSelectionSourceTests(unittest.TestCase):
    def test_source_upload_uses_protected_native_file_and_preserves_original(self):
        with tempfile.TemporaryDirectory(prefix='PDF 中文 ') as root:
            directory = platform.private_directory(Path(root) / 'job')
            original = Path(root) / 'original.pdf'
            source = b'%PDF-1.7\nlocal source fixture\n'
            original.write_bytes(source)
            mono = directory / 'mono.pdf'
            descriptor = platform.secure_open(mono, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(descriptor, 'wb') as stream: stream.write(b'%PDF-1.7\ntranslated fixture\n')
            job = SimpleNamespace(id='portable_job', state='complete', directory=directory,
                output_signatures={'mono':server._output_signature(mono)},
                cache_info={'sourceSHA256':hashlib.sha256(source).hexdigest(),
                    'outputs':{'mono':{'sha256':hashlib.sha256(mono.read_bytes()).hexdigest()}}})
            service = SelectionAlignmentService(SimpleNamespace())
            installed = service.install_source(job, io.BytesIO(source), len(source))
            self.assertEqual(installed.read_bytes(), source)
            self.assertEqual(original.read_bytes(), source)
            descriptor = platform.secure_open(installed, os.O_RDONLY)
            try: platform.validate_file(descriptor)
            finally: os.close(descriptor)
            self.assertEqual(list(directory.glob('.selection-source-*')), [])


if __name__ == '__main__': unittest.main()
