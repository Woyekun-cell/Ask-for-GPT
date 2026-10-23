"""Short-lived offline figure inference; the HTTP process never loads ONNX."""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import struct
import subprocess
import sys
import threading

from layout_common import ProtocolFailure, configure_asset_home, install_offline_guard

MAX_PNG_BYTES = 4 * 1024 * 1024
MAX_EDGE = 1024
MAX_PIXELS = 1024 * 1024
MAX_RESPONSE_BYTES = 64 * 1024
MODEL_NAME = 'doclayout_yolo_docstructbench_imgsz1024.onnx'
MODEL_BYTES = 75324598
MODEL_SHA256 = 'fece9af02f618b603ff7921ccec6861d13e7e1f9830e091dfb7e8ad9311e5b21'
ERRORS = frozenset({'figure_input', 'figure_limit', 'figure_busy', 'figure_unavailable', 'figure_timeout', 'figure_failed'})


def png_size(raw):
    if not isinstance(raw, bytes): raise ProtocolFailure('figure_input')
    if len(raw) > MAX_PNG_BYTES: raise ProtocolFailure('figure_limit')
    if (len(raw) < 33 or raw[:16] != b'\x89PNG\r\n\x1a\n\0\0\0\rIHDR'):
        raise ProtocolFailure('figure_input')
    width, height = struct.unpack('>II', raw[16:24])
    if not width or not height: raise ProtocolFailure('figure_input')
    if max(width, height) > MAX_EDGE or width * height > MAX_PIXELS:
        raise ProtocolFailure('figure_limit')
    return width, height


def model_asset(cache_root):
    path = Path(cache_root) / 'engine-home/.cache/babeldoc/models' / MODEL_NAME
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_size != MODEL_BYTES
                    or hashlib.file_digest(source, 'sha256').hexdigest() != MODEL_SHA256):
                raise ProtocolFailure('figure_unavailable')
            current = os.fstat(source.fileno())
            if any(getattr(current, name) != getattr(info, name) for name in
                   ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_mode', 'st_uid')):
                raise ProtocolFailure('figure_unavailable')
    except (OSError, ValueError): raise ProtocolFailure('figure_unavailable') from None
    return path


def validate_result(value):
    if not isinstance(value, dict) or set(value) != {'figures', 'exclusions'}:
        raise ProtocolFailure('figure_failed')
    def number(value):
        return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1
    result = {}
    for key, limit in [('figures', 64), ('exclusions', 256)]:
        rows = value[key]
        if not isinstance(rows, list) or len(rows) > limit: raise ProtocolFailure('figure_failed')
        result[key] = []
        for row in rows:
            keys = {'rect', 'confidence'} | ({'kind'} if key == 'exclusions' else set())
            if (not isinstance(row, dict) or set(row) != keys
                    or not number(row['confidence']) or not isinstance(row['rect'], list)
                    or len(row['rect']) != 4 or not all(number(n) for n in row['rect'])
                    or row['rect'][0] >= row['rect'][2] or row['rect'][1] >= row['rect'][3]
                    or key == 'exclusions' and row['kind'] not in {'caption', 'text', 'header'}):
                raise ProtocolFailure('figure_failed')
            result[key].append({name: list(item) if name == 'rect' else item for name, item in row.items()})
    return result


def normalized_regions(prediction, width, height):
    result = {'figures': [], 'exclusions': []}
    exclusions = {'figure_caption': 'caption', 'plain text': 'text', 'abandon': 'header', 'title': 'text'}
    for box in prediction.boxes:
        category = prediction.names[int(box.cls)]
        key = 'figures' if category == 'figure' else 'exclusions' if category in exclusions else None
        if key is None: continue
        coordinates = [float(n) for n in box.xyxy]
        confidence = float(box.conf)
        if (len(coordinates) != 4 or not all(math.isfinite(n) for n in coordinates)
                or not math.isfinite(confidence) or not 0 <= confidence <= 1):
            raise ProtocolFailure('figure_failed')
        rect = [max(0, min(1, n / (width if i % 2 == 0 else height))) for i, n in enumerate(coordinates)]
        if rect[0] >= rect[2] or rect[1] >= rect[3]: continue
        if len(result[key]) >= (64 if key == 'figures' else 256): continue
        row = {'rect': rect, 'confidence': confidence}
        if key == 'exclusions': row['kind'] = exclusions[category]
        result[key].append(row)
    return validate_result(result)


def predict(raw, cache_root):
    width, height = png_size(raw)
    model_asset(cache_root)
    configure_asset_home(Path(cache_root))
    install_offline_guard()
    with redirect_stdout(sys.stderr):
        import cv2
        import numpy as np
        from gpt_batch import load_single_page_layout_model
        image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None or image.shape != (height, width, 3): raise ProtocolFailure('figure_input')
        # BabelDOC's own document adapter feeds BGR into this same CPU path.
        model = load_single_page_layout_model()
        prediction = model.predict(image)[0]
        return normalized_regions(prediction, width, height)


class FigureRegionService:
    def __init__(self, cache_root, *, worker_script=None, timeout=12):
        self.cache_root = Path(cache_root)
        self.worker_script = Path(worker_script) if worker_script is not None else Path(__file__)
        self.timeout = max(.01, min(12, timeout))
        self._slot = threading.BoundedSemaphore(1)
        self._lock = threading.RLock()
        self._process = None
        self._stopping = False

    @staticmethod
    def _stop(process):
        if process.poll() is not None: return
        process.kill()
        process.wait(timeout=2)

    def detect(self, raw):
        png_size(raw)
        if not self._slot.acquire(blocking=False): raise ProtocolFailure('figure_busy')
        process = None
        try:
            with self._lock:
                if self._stopping: raise ProtocolFailure('figure_unavailable')
                environment = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', PYTHONUNBUFFERED='1')
                process = subprocess.Popen([sys.executable, str(self.worker_script), '--cache-root', str(self.cache_root)],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    env=environment, start_new_session=True)
                self._process = process
            try: output, _ = process.communicate(input=raw, timeout=self.timeout)
            except subprocess.TimeoutExpired:
                self._stop(process);process.communicate()
                raise ProtocolFailure('figure_timeout') from None
            if len(output) > MAX_RESPONSE_BYTES: raise ProtocolFailure('figure_failed')
            try: value = json.loads(output)
            except (ValueError, UnicodeError): raise ProtocolFailure('figure_failed') from None
            if process.returncode:
                code = value.get('error') if isinstance(value, dict) else None
                raise ProtocolFailure(code if code in ERRORS else 'figure_failed')
            return validate_result(value)
        except OSError: raise ProtocolFailure('figure_unavailable') from None
        finally:
            if process is not None:
                self._stop(process)
                for stream in (process.stdin, process.stdout):
                    if stream: stream.close()
            with self._lock:
                if self._process is process: self._process = None
            self._slot.release()

    def shutdown(self):
        with self._lock:
            self._stopping = True
            if self._process is not None: self._stop(self._process)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache-root', type=Path, required=True)
    arguments = parser.parse_args()
    try:
        value = predict(sys.stdin.buffer.read(MAX_PNG_BYTES + 1), arguments.cache_root)
        raw = json.dumps(value, separators=(',', ':'), allow_nan=False).encode()
        if len(raw) > MAX_RESPONSE_BYTES: raise ProtocolFailure('figure_failed')
    except Exception as error:
        code = str(error) if isinstance(error, ProtocolFailure) and str(error) in ERRORS else 'figure_unavailable'
        sys.stdout.write(json.dumps({'error': code}, separators=(',', ':')))
        return 2
    sys.stdout.buffer.write(raw)
    return 0


if __name__ == '__main__': sys.exit(main())
