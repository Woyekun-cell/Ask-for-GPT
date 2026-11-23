"""Private, bounded spool for the audited paper HTML workflow."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
from typing import Callable
import uuid

from layout_common import ProtocolFailure, atomic_json, private_directory
import platform_ops as platform

PAPER_HTML_UPLOAD = "/v1/pdf/paper-html"
MAX_PAPER_HTML_PDF_BYTES = 100 * 1024 * 1024
MAX_PAPER_HTML_BYTES = 32 * 1024 * 1024
MAX_RETAINED_JOBS = 8
STAGES = {"extracting", "writing", "reviewing", "rendering", "checking"}
PHASES = STAGES | {"repairing"}
ERRORS = {"html_runtime_missing", "html_workflow_incompatible", "html_model_unavailable", "html_extract_failed",
          "html_review_failed", "html_verify_failed", "html_timed_out", "html_failed"}


def _read_owned(path: Path, limit: int) -> bytes:
    descriptor = platform.secure_open(path, os.O_RDONLY)
    with os.fdopen(descriptor, "rb") as source:
        info = platform.validate_file(source.fileno())
        if not 0 < info.st_size <= limit:
            raise ValueError("file_size")
        data = source.read(limit + 1)
        if len(data) != info.st_size:
            raise ValueError("file_changed")
        return data


def _read_record(path: Path) -> dict:
    value = json.loads(_read_owned(path, 2048))
    if not isinstance(value, dict):
        raise ValueError("invalid_record")
    return value


def _phase_timings(record: dict) -> dict:
    entries = record.get("phaseTimingsMs")
    if not isinstance(entries, dict):
        return {}
    return {name: value for name, value in entries.items()
            if name in PHASES and type(value) is int and value >= 0}


def _output(path: Path) -> bytes:
    data = _read_owned(path, MAX_PAPER_HTML_BYTES)
    if not data[:256].lstrip().lower().startswith(b"<!doctype html>"):
        raise ValueError("invalid_html")
    return data


def _write_owned(path: Path, data: bytes) -> None:
    descriptor = platform.secure_open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(data)


def _work(directory: Path, translator: Path) -> None:
    os.umask(0o077)
    work = directory / "work"
    route = directory / "model-route.json"
    current_phase = None
    phase_start = time.monotonic_ns()
    durations = {}

    def close_phase(now: int) -> None:
        if current_phase is not None:
            durations[current_phase] = durations.get(current_phase, 0) + now - phase_start

    def timings() -> dict:
        return {name: duration // 1_000_000 for name, duration in durations.items()}

    def report(stage: str) -> None:
        nonlocal current_phase, phase_start
        if stage not in PHASES or stage == current_phase:
            return
        now = time.monotonic_ns()
        close_phase(now)
        current_phase, phase_start = stage, now
        # The public stage remains compatible with earlier Zotero add-ons.
        status = {"stage": "reviewing" if stage == "repairing" else stage, "phaseTimingsMs": timings()}
        if stage == "repairing":
            status["phase"] = stage
        atomic_json(directory / "stage.json", status)

    try:
        from paper_html_workflow import run
        result = run(work / "input.pdf", work, translator, route if route.is_file() else None, report)
        if not result.parent.resolve().is_relative_to(work.resolve()):
            raise ProtocolFailure("html_verify_failed")
        try:
            data = _output(result)
            data.decode("utf-8")
        except (OSError, ValueError):
            raise ProtocolFailure("html_verify_failed") from None
        _write_owned(directory / "approved.html", data)
        status = {"state": "complete"}
    except Exception as error:
        code = str(error)
        if code not in ERRORS:
            code = "html_runtime_missing" if isinstance(error, ImportError) else "html_failed"
        status = {"state": "failed", "error": code}
    close_phase(time.monotonic_ns())
    status["phaseTimingsMs"] = timings()
    atomic_json(directory / "result.json", status)


class PaperHTMLJobs:
    def __init__(self, cache_root: Path, translator: Path,
                 model_snapshot: Callable[[], str | None]):
        self.root = cache_root / "paper-html" / ("session-" + uuid.uuid4().hex)
        self.translator = translator
        self.model_snapshot = model_snapshot
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.active: str | None = None
        self.thread: threading.Thread | None = None
        self.jobs: dict[str, dict] = {}

    def start(self, source, length: int) -> dict:
        identity = uuid.uuid4().hex
        with self.lock:
            if self.stopping.is_set():
                raise ProtocolFailure("service_stopping")
            if self.active is not None:
                raise ProtocolFailure("job_conflict")
            self.active = identity
        directory = self.root / identity
        try:
            private_directory(self.root.parent)
            private_directory(self.root)
            private_directory(directory)
            work = private_directory(directory / "work")
            model_route = self.model_snapshot()
            if model_route is not None:
                _write_owned(directory / "model-route.json", model_route.encode())
            self._copy_pdf(source, length, work / "input.pdf")
            started = time.monotonic()
            state = {"id": identity, "state": "queued", "elapsedSeconds": 0}
            with self.lock:
                if self.stopping.is_set():
                    raise ProtocolFailure("service_stopping")
                while len(self.jobs) >= MAX_RETAINED_JOBS:
                    oldest = next(iter(self.jobs))
                    shutil.rmtree(self.root / oldest, ignore_errors=True)
                    del self.jobs[oldest]
                self.jobs[identity] = {**state, "_started": started}
                self.thread = threading.Thread(target=self._run, args=(identity, started), daemon=True)
                self.thread.start()
            return state.copy()
        except BaseException:
            shutil.rmtree(directory, ignore_errors=True)
            with self.lock:
                self.jobs.pop(identity, None)
                self.active = None
            raise

    def _copy_pdf(self, source, length: int, path: Path) -> None:
        descriptor = platform.secure_open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        deadline = time.monotonic() + 90
        with os.fdopen(descriptor, "wb") as output:
            prefix = source.read(5)
            if prefix != b"%PDF-":
                raise ProtocolFailure("invalid_pdf")
            output.write(prefix)
            remaining = length - len(prefix)
            while remaining:
                if self.stopping.is_set() or time.monotonic() >= deadline:
                    raise ProtocolFailure("incomplete_upload")
                data = source.read1(min(64 * 1024, remaining))
                if not data:
                    raise ProtocolFailure("incomplete_upload")
                output.write(data)
                remaining -= len(data)

    def _run(self, identity: str, started: float) -> None:
        directory = self.root / identity
        result = {"id": identity, "state": "failed", "error": "html_failed"}
        process = None
        try:
            with self.lock:
                self.jobs[identity]["state"] = "running"
            process = platform.spawn_owned(
                [sys.executable, str(Path(__file__).resolve()), str(directory), str(self.translator)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            while process.poll() is None and not self.stopping.is_set():
                self.stopping.wait(0.1)
            if process.poll() == 0 and not self.stopping.is_set():
                record = _read_record(directory / "result.json")
                if record.get("state") == "complete":
                    data = _output(directory / "approved.html")
                    checksum = hashlib.sha256(data).hexdigest()
                    result = {"id": identity, "state": "complete", "sha256": checksum, "bytes": len(data)}
                else:
                    code = record.get("error")
                    if isinstance(code, str) and code in ERRORS:
                        result["error"] = code
                if timings := _phase_timings(record):
                    result["phaseTimingsMs"] = timings
        except (OSError, ValueError):
            pass
        finally:
            if process is not None:
                try:
                    platform.finish_owned(process, grace=1)
                    process.wait(timeout=2)
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    result = {"id": identity, "state": "failed", "error": "html_failed"}
            shutil.rmtree(directory / "work", ignore_errors=True)
            for filename in ("model-route.json", "stage.json", "result.json"):
                try:
                    (directory / filename).unlink(missing_ok=True)
                except OSError:
                    pass
            if result["state"] == "failed":
                shutil.rmtree(directory, ignore_errors=True)
            with self.lock:
                result["elapsedSeconds"] = int(time.monotonic() - started)
                self.jobs[identity] = result
                self.active = None

    def _status(self, identity: str) -> dict:
        if identity not in self.jobs:
            raise ProtocolFailure("job_not_found")
        result = self.jobs[identity].copy()
        started = result.pop("_started", None)
        if started is not None:
            result["elapsedSeconds"] = int(time.monotonic() - started)
        return result

    def status(self, identity: str) -> dict:
        with self.lock:
            result = self._status(identity)
        if result["state"] == "running":
            try:
                record = _read_record(self.root / identity / "stage.json")
                stage = record.get("stage")
                if isinstance(stage, str) and stage in STAGES:
                    result["stage"] = stage
                    if stage == "reviewing" and record.get("phase") == "repairing":
                        result["phase"] = "repairing"
                    if timings := _phase_timings(record):
                        result["phaseTimingsMs"] = timings
            except (OSError, ValueError):
                pass
        return result

    def output(self, identity: str) -> bytes:
        with self.lock:
            result = self._status(identity)
            if result["state"] != "complete":
                raise ProtocolFailure("job_not_complete")
            try:
                data = _output(self.root / identity / "approved.html")
                if len(data) == result["bytes"] and hashlib.sha256(data).hexdigest() == result["sha256"]:
                    return data
            except (OSError, ValueError):
                pass
        raise ProtocolFailure("output_unavailable")

    def shutdown(self) -> None:
        with self.lock:
            self.stopping.set()
            worker = self.thread
        if worker is not None:
            worker.join(6)
        if worker is None or not worker.is_alive():
            shutil.rmtree(self.root, ignore_errors=True)


if __name__ == "__main__":
    _work(Path(sys.argv[1]), Path(sys.argv[2]))
