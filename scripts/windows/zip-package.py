#!/usr/bin/env python3
"""Create a UTF-8 ZIP and verify the actual extracted payload."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import zipfile

spec = importlib.util.spec_from_file_location('windows_package', Path(__file__).with_name('package.py'))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)
source, destination = map(Path, sys.argv[1:])
package.check(source)
with zipfile.ZipFile(destination, 'x', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for path in sorted(source.rglob('*')):
        if path.is_file():
            archive.write(path, (Path('Ask-for-GPT-Windows') / path.relative_to(source)).as_posix())
with tempfile.TemporaryDirectory(prefix='AskGPT ZIP verify ') as temp:
    with zipfile.ZipFile(destination) as archive:
        if archive.testzip() is not None:
            raise ValueError('ZIP CRC mismatch')
        archive.extractall(temp)
    print(package.check(Path(temp) / 'Ask-for-GPT-Windows'))
