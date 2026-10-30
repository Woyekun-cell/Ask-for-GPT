"""Private bounded checkpoints of exact, already validated page model answers."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import time
import uuid

import platform_ops as platform

from gpt_batch import validate_context, validate_segments, validate_translations
from layout_common import ProtocolFailure

MAX_RECORD_BYTES = 512 * 1024
MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
MAX_DOCUMENTS = 8
MAX_AGE = 7 * 24 * 3600


def _encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def _private_directory(path):
    if path.exists() or path.is_symlink():
        if not platform.directory_is_private(path):raise ValueError("unsafe_checkpoint")
    else:platform.private_directory(path)
    if not platform.directory_is_private(path):raise ValueError("unsafe_checkpoint")


class BatchCheckpoint:
    def __init__(self, root, binding, source, target):
        self.directory = None
        self.source, self.target = source, target
        if not isinstance(binding, str) or not re.fullmatch(r"[0-9a-f]{64}", binding):
            return
        parent = Path(root) / "translation-checkpoints"
        try:
            _private_directory(parent)
            directory = parent / binding
            _private_directory(directory)
            os.utime(directory, None, follow_symlinks=False)
            entries = []
            for path in parent.iterdir():
                info = path.lstat()
                if re.fullmatch(r"[0-9a-f]{64}", path.name) and platform.directory_is_private(path):
                    entries.append((info.st_mtime, path))
            for index, (modified, path) in enumerate(sorted(entries, reverse=True)):
                if path != directory and (index >= MAX_DOCUMENTS or time.time() - modified > MAX_AGE):
                    shutil.rmtree(path)
            self.directory = directory
        except (OSError, ValueError):
            pass  # Optional checkpoint failure must not change translation.

    def translate(self, model, rows, context=None):
        validate_segments(rows)
        context = validate_context(context)
        identity = hashlib.sha256(_encode([1, self.source, self.target, rows, context])).hexdigest()
        path = self.directory / (identity + ".json") if self.directory else None
        if path is not None:
            try:
                fd = platform.secure_open(path, os.O_RDONLY | getattr(os,"O_NONBLOCK",0))
                with os.fdopen(fd, "rb") as handle:
                    info = platform.validate_file(handle.fileno())
                    if not 4 < info.st_size <= MAX_RECORD_BYTES:
                        raise ValueError("unsafe_checkpoint")
                    value = json.loads(handle.read(MAX_RECORD_BYTES + 1))
                if (set(value) != {"schema", "requestSHA256", "outputSHA256", "translations"}
                        or value["schema"] != 1 or value["requestSHA256"] != identity
                        or value["outputSHA256"] != hashlib.sha256(_encode(value["translations"])).hexdigest()):
                    raise ValueError("changed_checkpoint")
                return validate_translations(value["translations"], rows)
            except (OSError, ValueError, TypeError, KeyError, ProtocolFailure):
                pass
        output = validate_translations(model(rows, context=context) if context is not None else model(rows), rows)
        if path is not None:
            temporary = path.with_suffix("." + uuid.uuid4().hex + ".tmp")
            try:
                encoded = _encode({"schema": 1, "requestSHA256": identity,
                    "outputSHA256": hashlib.sha256(_encode(output)).hexdigest(), "translations": output})
                size = sum(p.lstat().st_size for p in self.directory.iterdir())
                # Unsafe existing entries are never replaced or repaired.
                if not path.exists() and not path.is_symlink() and len(encoded) <= MAX_RECORD_BYTES and size + len(encoded) <= MAX_DOCUMENT_BYTES:
                    fd = platform.secure_open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, "wb") as handle:
                        handle.write(encoded)
                    os.replace(temporary, path)
            except OSError:
                pass
            finally:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
        return output
