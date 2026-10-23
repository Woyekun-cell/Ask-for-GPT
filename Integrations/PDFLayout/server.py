#!/usr/bin/env python3
"""Authenticated, bounded loopback PDF service. It never accepts input paths."""
from __future__ import annotations

import argparse
from collections import OrderedDict
from dataclasses import dataclass, field
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
import uuid
import platform_ops as platform

from layout_common import (BABELDOC_VERSION, MAX_OUTPUT_BYTES, MAX_PDF_BYTES, PORT,
    ProtocolFailure, atomic_json, load_connection, parse_pages, private_directory)
from gpt_batch import ERROR_DETAILS
from alignment import MAX_ALIGNMENT_BYTES, subset_alignment, validate_alignment

JOB_ROUTE = re.compile(r"/v1/pdf/jobs/([0-9a-f]{32})(?:/(mono\.pdf|dual\.pdf|alignment\.json|alignment-layout\.json))?")
ALIGNMENT_UPGRADE_ROUTE = re.compile(r"/v1/pdf/jobs/([0-9a-f]{32})/alignment-upgrade")
SELECTION_ALIGNMENT_ROUTE = re.compile(r"/v1/pdf/jobs/([0-9a-f]{32})/selection-alignment")
SELECTION_LINKS_ROUTE = re.compile(r"/v1/pdf/jobs/([0-9a-f]{32})/selection-alignment\?page=(0|[1-9][0-9]{0,3})")
MAX_CACHE_BYTES = 768 * 1024 * 1024
MAX_INACTIVE_JOBS = 64
MAX_JOB_AGE = 7 * 24 * 60 * 60
# These bounds apply only to unfinished/failed/cancelled working directories.
# Completed translations are permanent local results, not disposable cache.
# Old PDFs remain their original translation generation. Reopening one must
# neither run translation again nor claim the newer paragraph/context quality.
TRANSLATION_REVISION = "pdf-layout-gpt-v7-context-paragraph"
LEGACY_OUTPUT_REVISIONS = ("pdf-layout-gpt-v6-paragraph-isolated", "pdf-layout-gpt-v5-aligned-visual", "pdf-layout-gpt-v4-aligned")
CACHE_SCHEMA = 1
PROCESS_GROUP_GRACE = 3.5
MAX_RUNNING_JOBS = 2
MAX_CONCURRENT_UPLOADS = 2
MAX_ALIGNMENT_SNAPSHOT_JOBS = 2
MAX_ALIGNMENT_SNAPSHOT_BYTES = 32 * 1024 * 1024


def _finish_owned_group(process, *, grace=PROCESS_GROUP_GRACE):
    """Retire only the process object spawned and owned by this service."""
    platform.finish_owned(process, grace=grace)


def _cache_key(source_sha, pages, page_count, source, target, revision):
    # Content/range identity is shared by every reader; paths and reader IDs are absent.
    value = [CACHE_SCHEMA, BABELDOC_VERSION, revision, source_sha,
             page_count, pages, source, target]
    return hashlib.sha256(json.dumps(value, separators=(",", ":")).encode()).hexdigest()


def _signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns, info.st_mode, info.st_uid, info.st_nlink)


def _alignment_path(directory, metadata):
    name=metadata.get("alignmentFile","alignment.json")
    if name!="alignment.json" and (not isinstance(name,str) or not re.fullmatch(r"alignment-[0-9a-f]{64}\.json",name)):
        raise ValueError("unsafe_alignment_path")
    return Path(directory)/name


def _private_file(path, maximum, *, checksum=False, repair_mode=False):
    """Read only an owned regular file, without following links or loading a PDF into RAM."""
    descriptor = platform.secure_open(path, os.O_RDONLY, repair=repair_mode)
    with os.fdopen(descriptor, "rb") as handle:
        info = os.fstat(handle.fileno())
        info = platform.validate_file(handle.fileno(), repair=repair_mode)
        if not 4 < info.st_size <= maximum:
            raise ValueError("unsafe_cache_file")
        if not checksum:
            data = handle.read(maximum + 1)
            if _signature(os.fstat(handle.fileno())) != _signature(info):
                raise ValueError("changed_cache_file")
            return _signature(info), data
        if handle.read(5) != b"%PDF-":
            raise ValueError("invalid_cached_pdf")
        handle.seek(0)
        digest = hashlib.file_digest(handle, "sha256").hexdigest()
        if _signature(os.fstat(handle.fileno())) != _signature(info):
            raise ValueError("changed_cache_file")
        return _signature(info), digest


def _output_signature(path, maximum=MAX_OUTPUT_BYTES):
    descriptor = platform.secure_open(path, os.O_RDONLY)
    with os.fdopen(descriptor, "rb") as handle:
        info = os.fstat(handle.fileno())
        platform.validate_file(handle.fileno())
        if not 4 < info.st_size <= maximum:
            raise ValueError("unsafe_cache_file")
        return _signature(info)


def _open_pdf_descriptor(handle, *, windows=None):
    """Keep the verified FD open; Windows MuPDF needs a bounded byte stream."""
    import pymupdf
    if windows is None:
        windows = os.name == 'nt'
    if not windows:
        return pymupdf.open('/dev/fd/' + str(handle.fileno()))
    before = os.fstat(handle.fileno())
    if not 4 < before.st_size <= MAX_OUTPUT_BYTES:
        raise ValueError('unsafe_cache_file')
    data = handle.read(before.st_size + 1)
    if len(data) != before.st_size or _signature(os.fstat(handle.fileno())) != _signature(before):
        raise ValueError('changed_cache_file')
    return pymupdf.open(stream=data, filetype='pdf')


def _has_completed_record(directory):
    """Retain a completed result even across incompatible layout revisions.

    This is a deletion guard, never a cache-hit validator. Actual reuse still
    checks the source/range/languages/revision, PDF digests and private files in
    _load_completed/_cached_job. A damaged old result must not be silently
    removed merely because its age or the temporary-work budget was exceeded.
    """
    try:
        _, raw = _private_file(Path(directory) / "cache.json", 64 * 1024)
        value = json.loads(raw)
        if (not isinstance(value, dict) or value.get("state") != "complete"
                or type(value.get("schema")) is not int or value["schema"] < 1
                or not isinstance(value.get("sourceSHA256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", value["sourceSHA256"])
                or not isinstance(value.get("outputs"), dict)):
            return False
        for kind in ("mono", "dual"):
            output = value["outputs"].get(kind)
            if (not isinstance(output, dict) or not isinstance(output.get("sha256"), str)
                    or not re.fullmatch(r"[0-9a-f]{64}", output["sha256"])
                    or type(output.get("bytes")) is not int or not 4 < output["bytes"] <= MAX_OUTPUT_BYTES):
                return False
        return True
    except (OSError, ValueError, TypeError, KeyError): return False


def _job_progress(directory, total):
    fallback = {"stage": "preparing"}
    try:
        _, raw = _private_file(Path(directory) / "progress.json", 4096)
        value = json.loads(raw)
        if not isinstance(value, dict): return fallback
        if set(value) == {"stage"} and value["stage"] in {"preparing", "layout"}:
            return {"stage": value["stage"]}
        if (set(value) == {"stage", "completed", "total"} and value["stage"] == "translating"
                and type(value["completed"]) is int and type(value["total"]) is int
                and 1 <= value["total"] == total <= 2000
                and 0 <= value["completed"] <= value["total"]):
            return {"stage": "translating", "completed": value["completed"], "total": value["total"]}
    except (OSError, ValueError, TypeError, KeyError): pass
    return fallback


@dataclass
class Job:
    id: str
    directory: Path
    state: str = "running"
    source_pages: list[int] | None = None
    page_count: int = 0
    error: str | None = None
    process: subprocess.Popen | None = None
    cache_info: dict | None = None
    output_signatures: dict = field(default_factory=dict)
    _validated_alignment_binding: tuple | None = None
    error_detail: str | None = None
    failed_page: int | None = None
    reused_legacy: bool = False

    def public(self):
        result = {"id": self.id, "state": self.state,
                  "sourcePages": self.source_pages or [], "pageCount": self.page_count}
        if self.error: result["error"] = self.error
        if self.state == "failed":
            if self.error == "batch_invalid" and isinstance(self.error_detail, str) and self.error_detail in ERROR_DETAILS:
                result["errorDetail"] = self.error_detail
            if (type(self.failed_page) is int and 1 <= self.failed_page <= 2000
                    and self.failed_page <= self.page_count and self.failed_page - 1 in (self.source_pages or [])):
                result["failedPage"] = self.failed_page
        if self.state == "running": result["progress"] = _job_progress(self.directory, len(self.source_pages or []))
        if self.state == "complete":
            result["alignmentAvailable"] = "alignment" in self.output_signatures
            if self.reused_legacy:
                result.update(reusedLegacy=True, translationRevision=self.cache_info["revision"])
        return result


class JobManager:
    def __init__(self, cache_root: Path, translator: Path, *, worker_script: Path | None = None,
                 ready_override: bool | None = None, translation_revision: str = TRANSLATION_REVISION):
        self.cache_root = private_directory(cache_root)
        self.jobs_root = private_directory(self.cache_root / "jobs")
        self.translator = Path(translator)
        self.worker_script = worker_script or Path(__file__).with_name("worker.py")
        self.alignment_required = worker_script is None
        self.ready_override = ready_override
        self.translation_revision = translation_revision
        self.lock = threading.RLock()
        self.upload_slots = threading.BoundedSemaphore(MAX_CONCURRENT_UPLOADS)
        self.jobs: dict[str, Job] = {}
        self.completed: dict[str, str] = {}
        self.permanent: set[str] = set()
        self.active: set[str] = set()
        self.stopping = False
        self._alignment_snapshots = OrderedDict()
        self._alignment_snapshot_bytes = 0
        from sentence_service import SentenceUpgradeService
        self.sentence_upgrades = SentenceUpgradeService(self)
        from selection_service import SelectionAlignmentService
        self.selection_alignments = SelectionAlignmentService(self)
        from figure_regions import FigureRegionService
        self.figure_regions = FigureRegionService(self.cache_root)
        self._load_completed()
        self.prune()

    def _reusable_revisions(self):
        # Backend identity is part of translation semantics, not a version to
        # drop during migration. Unknown/custom generations stay exact-only.
        suffix = self.translation_revision.removeprefix(TRANSLATION_REVISION)
        if self.translation_revision != TRANSLATION_REVISION and not re.fullmatch(r"-backend-[0-9a-f]{64}", suffix):
            return (self.translation_revision,)
        return (self.translation_revision, *(revision + suffix for revision in LEGACY_OUTPUT_REVISIONS))

    @staticmethod
    def _validate_legacy_outputs(directory, pages, signatures, alignment):
        """Check real PDF pages through verified descriptors, without text reads."""
        from alignment import _geometry
        for kind in ("mono", "dual"):
            path = directory / (kind + ".pdf")
            descriptor = platform.secure_open(path, os.O_RDONLY)
            with os.fdopen(descriptor, "rb") as handle:
                expected = signatures[kind]
                if _signature(os.fstat(handle.fileno())) != expected: raise ValueError("changed_cache_file")
                try:
                    with _open_pdf_descriptor(handle) as document:
                        if document.needs_pass or not document.is_pdf or len(document) != len(pages):
                            raise ValueError("invalid_cached_page_mapping")
                        if alignment is not None:
                            for index, page in enumerate(document):
                                if _geometry(page) != {name: alignment["pages"][index][kind][name]
                                        for name in ("mediaBox", "cropBox", "rotation")}:
                                    raise ValueError("invalid_cached_page_geometry")
                except Exception:
                    # Malformed historical PDFs must not prevent service startup.
                    raise ValueError("invalid_cached_pdf") from None
                if _signature(os.fstat(handle.fileno())) != expected or _output_signature(path) != expected:
                    raise ValueError("changed_cache_file")

    def _load_completed(self):
        for directory in self.jobs_root.iterdir():
            if not re.fullmatch(r"[0-9a-f]{32}", directory.name): continue
            try:
                info = directory.lstat()
                if not platform.directory_is_private(directory): continue
                _, raw = _private_file(directory / "cache.json", 64 * 1024)
                value = json.loads(raw)
                pages, count = value["sourcePages"], value["pageCount"]
                if (value.get("schema") != CACHE_SCHEMA or value.get("state") != "complete"
                        or value.get("revision") not in self._reusable_revisions()
                        or value.get("babeldoc") != BABELDOC_VERSION
                        or type(count) is not int or not 1 <= count <= 2000
                        or not isinstance(pages, list) or not pages
                        or any(type(page) is not int or not 0 <= page < count for page in pages)
                        or pages != sorted(set(pages))
                        or (value["source"], value["target"]) not in {("en", "zh-Hans"), ("zh-Hans", "en")}
                        or not isinstance(value["sourceSHA256"], str)
                        or not re.fullmatch(r"[0-9a-f]{64}", value["sourceSHA256"])):
                    continue
                # A production reader must not get stuck reopening an old PDF
                # whose metadata cannot prove its annotation correspondence.
                # prune still retains these completed files permanently.
                if self.alignment_required and "alignment" not in value: continue
                key = _cache_key(value["sourceSHA256"], pages, count,
                                 value["source"], value["target"], value["revision"])
                if key != value["cacheKey"]: continue
                signatures = {}
                for kind in ("mono", "dual"):
                    signature, digest = _private_file(directory / (kind + ".pdf"), MAX_OUTPUT_BYTES, checksum=True)
                    if value["outputs"][kind] != {"sha256": digest, "bytes": signature[2]}:
                        raise ValueError("changed_cache_file")
                    signatures[kind] = signature
                alignment_raw, alignment = None, None
                if "alignment" in value:
                    signature, raw = _private_file(_alignment_path(directory,value), MAX_ALIGNMENT_BYTES)
                    if value["alignment"] != {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": signature[2]}:
                        raise ValueError("changed_cache_file")
                    alignment = validate_alignment(json.loads(raw), pages, count, value["sourceSHA256"])
                    signatures["alignment"] = signature
                    alignment_raw = raw
                legacy = value["revision"] != self.translation_revision
                if legacy: self._validate_legacy_outputs(directory, pages, signatures, alignment)
                job = Job(directory.name, directory, state="complete", source_pages=pages,
                          page_count=count, cache_info=value, output_signatures=signatures, reused_legacy=legacy)
                self.jobs[job.id] = job
                self.completed[key] = job.id
                self.permanent.add(job.id)
                if alignment_raw is not None:
                    self._remember_alignment_snapshot(job,alignment_raw)
            except (OSError, ValueError, TypeError, KeyError):
                continue

    def _cached_job(self, key):
        identity = self.completed.get(key)
        job = self.jobs.get(identity)
        if not job or job.state != "complete":
            self.completed.pop(key, None)
            return None
        try:
            info = job.directory.lstat()
            if not platform.directory_is_private(job.directory): raise ValueError()
            for kind in ("mono", "dual"):
                # The full digest was checked at completion/restart. Changed inode,
                # size, mtime or ctime invalidates the hit without rereading 900 MiB.
                if _output_signature(job.directory / (kind + ".pdf")) != job.output_signatures[kind]:
                    raise ValueError()
            if "alignment" in job.output_signatures:
                signature = _output_signature(_alignment_path(job.directory,job.cache_info), MAX_ALIGNMENT_BYTES)
                if signature != job.output_signatures["alignment"]: raise ValueError()
            return job
        except (OSError, ValueError, KeyError):
            self.completed.pop(key, None)
            return None

    def _matching_completed(self, source_sha, pages, page_count, source, target, revision):
        key = _cache_key(source_sha, pages, page_count, source, target, revision)
        job = self._cached_job(key)
        expected = {"cacheKey": key, "sourceSHA256": source_sha, "sourcePages": pages,
            "pageCount": page_count, "source": source, "target": target,
            "revision": revision, "babeldoc": BABELDOC_VERSION}
        return job if job is not None and job.cache_info and all(
            job.cache_info.get(name) == value for name, value in expected.items()) else None

    def _discard_placeholder(self, job):
        self._clean_intermediates(job)
        job.directory.rmdir()
        self.jobs.pop(job.id, None)
        self._release_active(job)

    def _release_active(self, job):
        self.active.discard(job.id)

    def _store_completed(self, job):
        if not job.cache_info: return
        outputs, signatures = {}, {}
        for kind in ("mono", "dual"):
            signature, digest = _private_file(job.directory / (kind + ".pdf"),
                MAX_OUTPUT_BYTES, checksum=True, repair_mode=True)
            outputs[kind] = {"sha256": digest, "bytes": signature[2]}
            signatures[kind] = signature
        value = {**job.cache_info, "schema": CACHE_SCHEMA, "state": "complete", "outputs": outputs}
        value.pop("alignment", None)
        alignment_path = job.directory / "alignment.json"
        alignment_raw = None
        if alignment_path.exists() or alignment_path.is_symlink():
            signature, raw = _private_file(alignment_path, MAX_ALIGNMENT_BYTES)
            validate_alignment(json.loads(raw), job.source_pages, job.page_count, job.cache_info["sourceSHA256"])
            value["alignment"] = {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": signature[2]}
            signatures["alignment"] = signature
            alignment_raw = raw
        atomic_json(job.directory / "cache.json", value)
        job.cache_info, job.output_signatures = value, signatures
        self.completed[value["cacheKey"]] = job.id
        self.permanent.add(job.id)
        if alignment_raw is not None:
            self._remember_alignment_snapshot(job,alignment_raw)

    def _alignment_snapshot_binding(self,job):
        metadata=job.cache_info["alignment"]
        return (str(_alignment_path(job.directory,job.cache_info)),tuple(job.output_signatures["alignment"]),
            tuple(job.source_pages),job.page_count,job.cache_info["sourceSHA256"],metadata["sha256"],metadata["bytes"])

    def _forget_alignment_snapshot(self,identity):
        entry=self._alignment_snapshots.pop(identity,None)
        if entry is not None:self._alignment_snapshot_bytes-=len(entry[1])

    def _remember_alignment_snapshot(self,job,raw):
        # Only bytes whose complete semantic/geometry validation has already
        # succeeded enter here. Immutable JSON gives every reader a private
        # deep tree without caching hundreds of thousands of mutable objects.
        binding=self._alignment_snapshot_binding(job)
        job._validated_alignment_binding=binding
        self._forget_alignment_snapshot(job.id)
        if len(raw)>MAX_ALIGNMENT_SNAPSHOT_BYTES or MAX_ALIGNMENT_SNAPSHOT_JOBS<1:return
        while self._alignment_snapshots and (len(self._alignment_snapshots)>=MAX_ALIGNMENT_SNAPSHOT_JOBS
                or self._alignment_snapshot_bytes+len(raw)>MAX_ALIGNMENT_SNAPSHOT_BYTES):
            self._forget_alignment_snapshot(next(iter(self._alignment_snapshots)))
        self._alignment_snapshots[job.id]=(binding,bytes(raw))
        self._alignment_snapshot_bytes+=len(raw)

    def read_alignment(self,job):
        with self.lock:
            if job.state!="complete" or "alignment" not in job.output_signatures:
                self._forget_alignment_snapshot(job.id)
                raise ProtocolFailure("alignment_unavailable")
            try:
                binding=self._alignment_snapshot_binding(job);path=Path(binding[0]);expected=binding[1]
                if _output_signature(path,MAX_ALIGNMENT_BYTES)!=expected:raise ValueError("changed_alignment")
                cached=self._alignment_snapshots.get(job.id)
                if cached is not None and cached[0]==binding:
                    value=json.loads(cached[1]);self._alignment_snapshots.move_to_end(job.id)
                else:
                    signature,raw=_private_file(path,MAX_ALIGNMENT_BYTES)
                    if (signature!=expected or len(raw)!=binding[6]
                            or hashlib.sha256(raw).hexdigest()!=binding[5]):raise ValueError("changed_alignment")
                    value=json.loads(raw)
                    # Evict bytes, not the proof that this exact file/content
                    # generation already passed the complete semantic checks.
                    if job._validated_alignment_binding!=binding:
                        value=validate_alignment(value,job.source_pages,job.page_count,job.cache_info["sourceSHA256"])
                    self._remember_alignment_snapshot(job,raw)
                # Changes while copying/validating must not return a stale
                # trusted tree, even when size or mtime was restored.
                if _output_signature(path,MAX_ALIGNMENT_BYTES)!=expected:raise ValueError("changed_alignment")
                return value
            except (OSError,ValueError,TypeError,KeyError):
                self._forget_alignment_snapshot(job.id)
                raise ProtocolFailure("alignment_unavailable") from None

    def read_layout_alignment(self,job):
        # Project only after the full snapshot passed the same integrity and
        # semantic checks as alignment.json; paragraph layout claims no precision.
        value=self.read_alignment(job)
        result={key:value[key] for key in ("schema","coordinateSpace","provenance",
            "sourcePages","pageCount","sourceSHA256")}
        result.update(granularity="paragraph",pages=[])
        if "layoutRevision" in value:result["layoutRevision"]=value["layoutRevision"]
        for page in value["pages"]:
            row={key:page[key] for key in ("sourcePage","outputPage","sourceToDual","targetToDual")}
            for name in ("source","mono","dual"):
                row[name]={key:page[name][key] for key in ("mediaBox","cropBox","rotation")}
            row["paragraphs"]=[]
            for paragraph in page["paragraphs"]:
                part={"id":paragraph["id"]}
                for name in ("source","target","dualSource","dualTarget"):
                    keys=("text","rects") if name in ("source","target") else ("rects",)
                    part[name]={key:paragraph[name][key] for key in keys}
                row["paragraphs"].append(part)
            result["pages"].append(row)
        return result

    def publish_alignment(self,job,value):
        """One atomic metadata pointer commits a generation; PDF bytes stay put."""
        with self.lock:
            if self._cached_job(job.cache_info["cacheKey"]) is not job: raise ProtocolFailure("alignment_unavailable")
            raw=json.dumps(value,ensure_ascii=False,separators=(",",":")).encode()
            if len(raw)>MAX_ALIGNMENT_BYTES: raise ProtocolFailure("alignment_invalid")
            snapshot=validate_alignment(json.loads(raw),job.source_pages,job.page_count,job.cache_info["sourceSHA256"])
            digest=hashlib.sha256(raw).hexdigest();name="alignment-"+digest+".json"
            path=job.directory/name
            atomic_json(path,snapshot)
            signature,saved=_private_file(path,MAX_ALIGNMENT_BYTES)
            if saved!=raw:raise ProtocolFailure("alignment_unavailable")
            metadata={**job.cache_info,"alignmentFile":name,
                "alignment":{"sha256":hashlib.sha256(saved).hexdigest(),"bytes":signature[2]}}
            previous=job.cache_info.get("alignmentFile")
            atomic_json(job.directory/"cache.json",metadata)
            job.cache_info=metadata;job.output_signatures["alignment"]=signature
            self._remember_alignment_snapshot(job,saved)
            if previous and previous!=name:
                old=_alignment_path(job.directory,{"alignmentFile":previous})
                try: old.unlink(missing_ok=True)
                except OSError: pass

    def _extract_cached_pages(self, whole, job, selected):
        """Copy PDF page objects through verified descriptors; never rasterize."""
        import pymupdf
        for kind in ("mono", "dual"):
            path = whole.directory / (kind + ".pdf")
            expected = whole.output_signatures[kind]
            descriptor = platform.secure_open(path, os.O_RDONLY)
            with os.fdopen(descriptor, "rb") as handle:
                if _signature(os.fstat(handle.fileno())) != expected:
                    raise ValueError("changed_cache_file")
                # MuPDF opens this already-owned descriptor, not a path that
                # could have been replaced between signature check and open.
                with _open_pdf_descriptor(handle) as source, pymupdf.open() as output:
                    if source.needs_pass or not source.is_pdf or len(source) != whole.page_count:
                        raise ValueError("invalid_cached_page_mapping")
                    geometry = []
                    for index, physical in enumerate(selected):
                        page = source[physical]
                        geometry.append((page.mediabox, page.cropbox, page.rotation))
                        output.insert_pdf(source, from_page=physical, to_page=physical,
                                          final=int(index == len(selected) - 1))
                    destination = job.directory / (kind + ".pdf")
                    target = platform.secure_open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(target, "wb") as saved:
                        # PyMuPDF treats a named file object's .name as a path.
                        # A nameless bounded stream keeps writes on this FD.
                        sink = SimpleNamespace(write=saved.write, seek=saved.seek,
                                               tell=saved.tell, truncate=saved.truncate)
                        output.save(sink, garbage=3, deflate=True)
                        saved.flush()
                        os.fsync(saved.fileno())
                if (_signature(os.fstat(handle.fileno())) != expected
                        or _output_signature(path) != expected):
                    raise ValueError("changed_cache_file")
            target = platform.secure_open(destination, os.O_RDONLY)
            with os.fdopen(target, "rb") as saved, _open_pdf_descriptor(saved) as output:
                if len(output) != len(selected): raise ValueError("invalid_cached_page_mapping")
                for index, expected_geometry in enumerate(geometry):
                    page = output[index]
                    if (page.mediabox, page.cropbox, page.rotation) != expected_geometry:
                        raise ValueError("invalid_cached_page_geometry")
        # A change to either complete source while copying the other invalidates
        # the pair. Never publish one mode from a different cache generation.
        for kind in ("mono", "dual"):
            if _output_signature(whole.directory / (kind + ".pdf")) != whole.output_signatures[kind]:
                raise ValueError("changed_cache_file")
        if "alignment" in whole.output_signatures:
            signature, raw = _private_file(_alignment_path(whole.directory,whole.cache_info), MAX_ALIGNMENT_BYTES)
            if signature != whole.output_signatures["alignment"]: raise ValueError("changed_cache_file")
            value = validate_alignment(json.loads(raw), whole.source_pages, whole.page_count,
                                       whole.cache_info["sourceSHA256"])
            value = subset_alignment(value, selected)
            validate_alignment(value, selected, job.page_count, job.cache_info["sourceSHA256"])
            atomic_json(job.directory / "alignment.json", value)

    def _derive_completed_range(self, job, revision=None):
        original_info = job.cache_info
        revision = revision or self.translation_revision
        info = {**original_info, "revision": revision}
        info["cacheKey"] = _cache_key(info["sourceSHA256"], job.source_pages, job.page_count,
            info["source"], info["target"], revision)
        all_pages = list(range(job.page_count))
        if not info or job.source_pages == all_pages: return False
        key = _cache_key(info["sourceSHA256"], all_pages, job.page_count,
                         info["source"], info["target"], revision)
        whole = self._cached_job(key)
        if whole is None: return False
        expected = {**info, "cacheKey": key, "sourcePages": all_pages}
        if (whole.state != "complete" or whole.page_count != job.page_count or whole.source_pages != all_pages
                or not whole.cache_info or any(whole.cache_info.get(name) != value for name, value in expected.items())):
            return False
        job.cache_info = info
        job.reused_legacy = revision != self.translation_revision
        try:
            self._extract_cached_pages(whole, job, job.source_pages)
            self._store_completed(job)
            job.state = "complete"
            atomic_json(job.directory / "state.json", job.public())
            os.utime(whole.directory, None)
        except Exception:
            # This optional fast path must not make a usable source fail, or
            # expose a partial/tampered cached output. Continue via the worker.
            if self.completed.get(info["cacheKey"]) == job.id:
                self.completed.pop(info["cacheKey"], None)
            for name in ("mono.pdf", "dual.pdf", "alignment.json", "cache.json", "state.json"):
                try: (job.directory / name).unlink(missing_ok=True)
                except OSError: pass
            job.cache_info, job.output_signatures, job.state = original_info, {}, "running"
            job.reused_legacy = False
            return False
        self._clean_intermediates(job)
        self._release_active(job)
        try: self.prune(preserve=job.id)
        except OSError: pass
        return True

    def _clean_intermediates(self, job):
        for name in ["input.pdf", "outputs", "work", "request.json", "result.json", "progress.json", "progress.tmp"]:
            path = job.directory / name
            try:
                if path.is_symlink(): path.unlink()
                elif path.is_dir(): shutil.rmtree(path)
                else: path.unlink(missing_ok=True)
            except OSError: pass

    def prune(self, preserve=None):
        """Bound temporary UUID jobs; keep all completed translations forever."""
        with self.lock:
            entries = []
            for path in self.jobs_root.iterdir():
                if not re.fullmatch(r"[0-9a-f]{32}", path.name): continue
                info = path.lstat()
                if (not platform.directory_is_private(path)
                        or path.name in self.active or path.name == preserve): continue
                # Older revisions are intentionally not eligible for today's
                # layout/annotation mapping, but their completed PDFs remain
                # the user's saved results. Never treat them as temporary work.
                if path.name in self.permanent or _has_completed_record(path):
                    self.permanent.add(path.name)
                    continue
                size = sum(child.stat().st_size for child in path.rglob("*")
                           if not child.is_symlink() and child.is_file())
                entries.append((info.st_mtime, size, path))
            entries.sort(reverse=True)
            total, count = 0, 0
            for modified, size, path in entries:
                if time.time() - modified > MAX_JOB_AGE or count >= MAX_INACTIVE_JOBS or total + size > MAX_CACHE_BYTES:
                    shutil.rmtree(path)
                    removed = self.jobs.pop(path.name, None)
                    if removed and removed.cache_info:
                        key = removed.cache_info["cacheKey"]
                        if self.completed.get(key) == removed.id: self.completed.pop(key, None)
                else:
                    count += 1
                    total += size

    def ready(self):
        if self.ready_override is not None: return self.ready_override
        try:
            if (importlib.metadata.version("BabelDOC") != BABELDOC_VERSION
                    or not self.translator.is_file() or not os.access(self.translator, os.X_OK)):
                return False
            marker = self.cache_root / "assets-ready.json"
            if marker.is_symlink() or marker.stat().st_size > 256 * 1024: return False
            value = json.loads(marker.read_text())
            assets = self.cache_root / "engine-home" / ".cache" / "babeldoc"
            if value.get("babeldoc") != BABELDOC_VERSION or not value.get("files"): return False
            for item in value["files"]:
                relative = Path(item["name"])
                if relative.is_absolute() or ".." in relative.parts: return False
                path = assets / relative
                if path.is_symlink() or not path.is_file() or path.stat().st_size != item["bytes"]:
                    return False
            return True
        except (OSError, ValueError, TypeError, KeyError, importlib.metadata.PackageNotFoundError):
            return False

    def begin(self) -> Job:
        with self.lock:
            if self.stopping: raise ProtocolFailure("service_stopping")
            self.prune()
            identity = uuid.uuid4().hex
            job = Job(identity, private_directory(self.jobs_root / identity))
            self.jobs[identity] = job
            self.active.add(identity)
            return job

    def abandon(self, job: Job):
        # Delivery of 202 can fail after spawn. The client then has no job ID,
        # so its lost upload must terminate rather than release a live worker.
        with self.lock:
            # A completed cache hit discards its upload placeholder. Losing
            # that response must not invalidate the original reusable output.
            if self.jobs.get(job.id) is not job: return
            # Cached and derived results are already independently verified.
            # Losing their HTTP reply must not invalidate reusable output.
            if job.state in {"complete", "failed", "cancelled"}: return
        if job.process is not None:
            self.cancel(job)
            return
        with self.lock:
            self._clean_intermediates(job)
            job.state = "failed"
            job.error = "invalid_pdf"
            self._release_active(job)
            self.prune()

    def submit(self, job: Job, pages: str, source: str, target: str):
        import pymupdf
        try:
            # PyMuPDF is process-safe, but its library calls are not thread-safe.
            # Uploads overlap; metadata validation and cache extraction share
            # this lock. Actual layout/translation stays in independent workers.
            with self.lock, pymupdf.open(job.directory / "input.pdf") as document:
                if document.needs_pass or not document.is_pdf:
                    raise ProtocolFailure("pdf_encrypted_or_invalid")
                page_count = len(document)
                selected = parse_pages(pages, page_count)
            with self.lock:
                if self.stopping or job.state != "running" or self.jobs.get(job.id) is not job:
                    raise ProtocolFailure("service_stopping")
                job.page_count, job.source_pages = page_count, selected
                _, source_sha = _private_file(job.directory / "input.pdf", MAX_PDF_BYTES, checksum=True)
                key = _cache_key(source_sha, selected, page_count, source, target, self.translation_revision)
                cached = self._matching_completed(source_sha, selected, page_count, source, target, self.translation_revision)
                if cached is not None:
                    self._discard_placeholder(job)
                    os.utime(cached.directory, None)
                    return cached.public()
                job.cache_info = {"cacheKey": key, "sourceSHA256": source_sha,
                    "sourcePages": selected, "pageCount": page_count, "source": source,
                    "target": target, "revision": self.translation_revision, "babeldoc": BABELDOC_VERSION}
                if self._derive_completed_range(job): return job.public()
                for revision in self._reusable_revisions()[1:]:
                    cached = self._matching_completed(source_sha, selected, page_count, source, target, revision)
                    if cached is not None:
                        self._discard_placeholder(job)
                        os.utime(cached.directory, None)
                        return cached.public()
                    if self._derive_completed_range(job, revision): return job.public()
                # An exported mono PDF is already in the requested target
                # language. Match verified bytes, never a filename or a guess.
                for completed_key in list(self.completed):
                    completed = self.jobs.get(self.completed.get(completed_key))
                    info = completed.cache_info if completed else None
                    if (info and info.get("target") == target
                            and info.get("sourceSHA256") != source_sha
                            and info.get("outputs", {}).get("mono", {}).get("sha256") == source_sha
                            and self._cached_job(completed_key) is not None):
                        raise ProtocolFailure("already_translated")
                # Each BabelDOC process loads its own model and helper. Keep
                # two independent papers concurrent without unbounded models.
                if sum(other.process is not None and other.process.poll() is None
                        for other in self.jobs.values()) >= MAX_RUNNING_JOBS:
                    raise ProtocolFailure("job_conflict")
                atomic_json(job.directory / "request.json", {"sourcePages": selected,
                    "pageCount": page_count, "source": source, "target": target})
                job.process = platform.spawn_owned([sys.executable, str(self.worker_script),
                    "--job-dir", str(job.directory), "--cache-root", str(self.cache_root),
                    "--translator", str(self.translator)], popen=subprocess.Popen, stdin=subprocess.PIPE,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                    env={**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1",
                         "ASKGPT_PDF_OFFLINE": "1"})
                thread = threading.Thread(target=self._monitor, args=(job,), daemon=True)
                thread.start()
                return job.public()
        except ProtocolFailure:
            self.abandon(job)
            raise
        except Exception:
            self.abandon(job)
            raise ProtocolFailure("invalid_pdf") from None

    def _monitor(self, job: Job):
        process = job.process
        code = process.wait()
        if process.stdin:
            process.stdin.close()
        with self.lock:
            # cancel() owns the one group grace once it marks this state.
            # Do not race its final signal against an already reaped group.
            if job.state == "cancelled": return
        # Only Popen(start_new_session=True) processes created above enter here.
        # Their group may outlive its leader after a helper/GPT timeout, even when
        # the worker exits normally. Never derive a process/group ID from a request.
        _finish_owned_group(process)
        with self.lock:
            if job.state == "cancelled": return
            try:
                result_file = job.directory / "result.json"
                if result_file.is_symlink() or result_file.stat().st_size > 8192:
                    raise ValueError()
                result = json.loads(result_file.read_text())
                complete = code == 0 and result.get("state") == "complete"
                for kind in ["mono", "dual"]:
                    path = job.directory / (kind + ".pdf")
                    complete = complete and not path.is_symlink() and path.is_file() and 4 < path.stat().st_size <= MAX_OUTPUT_BYTES
                if complete and self.alignment_required:
                    path = job.directory / "alignment.json"
                    complete = not path.is_symlink() and path.is_file()
                if complete: self._store_completed(job)
                self._clean_intermediates(job)
                job.state = "complete" if complete else "failed"
                if not complete:
                    allowed = {"translation_timeout", "translation_failed", "formula_placeholder_mismatch",
                        "empty_translation", "runtime_missing", "layout_failed", "invalid_output",
                        "scanned_pdf_unsupported", "pdf_worker_network_disabled", "batch_limit",
                        "batch_invalid", "gpt_unavailable"}
                    error = result.get("error", "layout_failed")
                    job.error = error if isinstance(error, str) and error in allowed else "layout_failed"
                    detail = result.get("errorDetail")
                    job.error_detail = detail if (job.error == "batch_invalid" and isinstance(detail, str)
                        and detail in ERROR_DETAILS) else None
                    page = result.get("failedPage")
                    job.failed_page = page if (type(page) is int and 1 <= page <= min(2000, job.page_count)
                        and page - 1 in (job.source_pages or [])) else None
            except (OSError, ValueError, TypeError):
                self._clean_intermediates(job)
                job.state, job.error = "failed", "layout_failed"
                job.error_detail, job.failed_page = None, None
            self._release_active(job)
            atomic_json(job.directory / "state.json", job.public())
            self.prune()

    def get(self, identity):
        with self.lock:
            job = self.jobs.get(identity)
            if not job: raise ProtocolFailure("job_not_found")
            return job

    def cancel(self, job):
        with self.lock:
            if job.state in {"complete", "failed", "cancelled"}: return job.public()
            job.state = "cancelled"
            process = job.process
        if process:
            deadline = time.monotonic() + PROCESS_GROUP_GRACE
            if not platform.IS_WINDOWS:
                try: os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError: pass
                try: process.wait(timeout=PROCESS_GROUP_GRACE)
                except subprocess.TimeoutExpired: pass
            # The worker may exit before a hung/TERM-ignoring native descendant.
            # A group can outlive its leader, so do not rely on wait(parent).
            _finish_owned_group(process, grace=deadline - time.monotonic())
            process.wait(timeout=2)
        with self.lock:
            self._clean_intermediates(job)
            self._release_active(job)
            atomic_json(job.directory / "state.json", job.public())
            self.prune()
            return job.public()

    def shutdown(self):
        with self.lock:
            self.stopping = True
        self.sentence_upgrades.shutdown()
        self.selection_alignments.shutdown()
        self.figure_regions.shutdown()
        with self.lock: jobs = list(self.jobs.values())
        for job in jobs:
            if job.state == "running": self.cancel(job)


class PDFHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def handle_error(self, request, client_address):
        # Default HTTPServer tracebacks can echo request data and filesystem paths.
        pass


def create_server(manager: JobManager, token: str, *, port: int = PORT, extension_origin: str | None = None):
    if extension_origin is not None and not re.fullmatch(r"chrome-extension://[a-p]{32}", extension_origin):
        raise ProtocolFailure("invalid_configuration")
    cors_headers = {"authorization", "content-type", "x-askgpt-pages", "x-askgpt-source", "x-askgpt-target", "x-askgpt-units", "x-askgpt-selection"}
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "AskGPTPDF/1"
        sys_version = ""

        def log_message(self, *args): pass

        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def valid_host_origin(self, *, require_origin=False):
            origins = self.headers.get_all("Origin") or []
            return (self.headers.get_all("Host") == [f"127.0.0.1:{self.server.server_address[1]}"]
                    and ((not origins and not require_origin)
                         or (extension_origin is not None and origins == [extension_origin])))

        def end_headers(self):
            if self.valid_host_origin(require_origin=True):
                self.send_header("Access-Control-Allow-Origin", extension_origin)
                self.send_header("Vary", "Origin")
            super().end_headers()

        def handle_expect_100(self):
            # Authentication must precede even an informational upload response.
            if not self.authorize(): return False
            self.send_response_only(100)
            self.end_headers()
            return True

        def reply(self, status, value=None, *, pdf=None):
            data = pdf if pdf is not None else json.dumps(value or {}, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/pdf" if pdf is not None else "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

        def authorize(self):
            if not self.valid_host_origin():
                self.reply(403, {"error": "invalid_origin_or_host"})
                return False
            auth = self.headers.get_all("Authorization") or []
            if len(auth) != 1 or not hmac.compare_digest(auth[0].encode("utf-8"), ("Bearer " + token).encode()):
                self.reply(401, {"error": "unauthorized"})
                return False
            return True

        def do_GET(self):
            if not self.authorize(): return
            if self.path == "/v1/pdf/health":
                return self.reply(200, {"status": "ready" if manager.ready() else "runtime_missing",
                                       "protocolVersion": 1})
            selected=SELECTION_LINKS_ROUTE.fullmatch(self.path)
            if selected:
                try:
                    parent=manager.get(selected[1])
                    return self.reply(200,manager.selection_alignments.links(parent,int(selected[2])))
                except ProtocolFailure as error: return self.selection_error(error)
                except (OSError,ValueError,TypeError,KeyError): return self.reply(400,{"error":"selection_invalid"})
            upgrade=ALIGNMENT_UPGRADE_ROUTE.fullmatch(self.path)
            if upgrade:
                try: return self.reply(200,manager.sentence_upgrades.status(manager.get(upgrade[1])))
                except ProtocolFailure: return self.reply(404,{"error":"job_not_found"})
            match = JOB_ROUTE.fullmatch(self.path)
            if not match: return self.reply(404, {"error": "not_found"})
            try:
                job = manager.get(match[1])
                if not match[2]: return self.reply(200, job.public())
                if job.state != "complete": return self.reply(409, {"error": "job_not_complete"})
                if match[2] in ("alignment.json","alignment-layout.json"):
                    try: return self.reply(200,manager.read_layout_alignment(job) if match[2]=="alignment-layout.json" else manager.read_alignment(job))
                    except ProtocolFailure: return self.reply(404,{"error":"alignment_unavailable"})
                path = job.directory / match[2]
                descriptor = platform.secure_open(path, os.O_RDONLY)
                with os.fdopen(descriptor, "rb") as handle:
                    info = os.fstat(handle.fileno())
                    if not stat.S_ISREG(info.st_mode): raise OSError()
                    if info.st_size > MAX_OUTPUT_BYTES:
                        return self.reply(413, {"error": "output_too_large"})
                    self.send_response(200)
                    self.send_header("Content-Type", "application/pdf")
                    self.send_header("Content-Length", str(info.st_size))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    shutil.copyfileobj(handle, self.wfile, length=64 * 1024)
                    self.close_connection = True
                    return
            except ProtocolFailure: return self.reply(404, {"error": "job_not_found"})
            except (OSError, ValueError, TypeError, KeyError):
                return self.reply(404, {"error": "output_unavailable"})

        def do_POST(self):
            if not self.authorize(): return
            if self.path == '/v1/pdf/figure-regions': return self.post_figure_regions()
            selected=SELECTION_ALIGNMENT_ROUTE.fullmatch(self.path)
            if selected: return self.post_selection_alignment(selected[1])
            upgrade=ALIGNMENT_UPGRADE_ROUTE.fullmatch(self.path)
            if upgrade: return self.post_alignment_upgrade(upgrade[1])
            if self.path != "/v1/pdf/jobs": return self.reply(404, {"error": "not_found"})
            if not manager.ready(): return self.reply(503, {"error": "runtime_missing"})
            if self.headers.get("Transfer-Encoding") is not None:
                return self.reply(400, {"error": "unsupported_transfer_encoding"})
            lengths = self.headers.get_all("Content-Length") or []
            if len(lengths) != 1 or not lengths[0].isdigit():
                return self.reply(411, {"error": "content_length_required"})
            length = int(lengths[0])
            if length > MAX_PDF_BYTES: return self.reply(413, {"error": "pdf_too_large"})
            if length < 5: return self.reply(400, {"error": "invalid_pdf"})
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/pdf":
                return self.reply(415, {"error": "pdf_content_type_required"})
            source, target = self.headers.get("X-AskGPT-Source"), self.headers.get("X-AskGPT-Target")
            if (source, target) not in {("en", "zh-Hans"), ("zh-Hans", "en")}:
                return self.reply(400, {"error": "invalid_language_pair"})
            pages = self.headers.get("X-AskGPT-Pages", "all")
            if not manager.upload_slots.acquire(blocking=False):
                return self.reply(409, {"error": "job_conflict"})
            job = None
            try:
                job = manager.begin()
                descriptor = platform.secure_open(job.directory / "input.pdf",
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "wb") as output:
                    remaining = length
                    while remaining:
                        data = self.rfile.read(min(64 * 1024, remaining))
                        if not data: raise ProtocolFailure("incomplete_upload")
                        output.write(data)
                        remaining -= len(data)
                with (job.directory / "input.pdf").open("rb") as pdf:
                    if pdf.read(5) != b"%PDF-": raise ProtocolFailure("invalid_pdf")
                return self.reply(202, manager.submit(job, pages, source, target))
            except ProtocolFailure as error:
                if job: manager.abandon(job)
                code = str(error)
                return self.reply(409 if code == "job_conflict" else 400, {"error": code})
            except (OSError, TimeoutError):
                if job: manager.abandon(job)
                return self.reply(400, {"error": "incomplete_upload"})
            finally:
                manager.upload_slots.release()

        def post_figure_regions(self):
            from figure_regions import MAX_PNG_BYTES, png_size
            lengths = self.headers.get_all('Content-Length') or []
            types = self.headers.get_all('Content-Type') or []
            if (self.headers.get('Transfer-Encoding') is not None or len(lengths) != 1
                    or not lengths[0].isdigit() or len(types) != 1
                    or types[0].split(';', 1)[0].strip().lower() != 'image/png'):
                return self.reply(400, {'error': 'figure_input'})
            length = int(lengths[0])
            if length > MAX_PNG_BYTES: return self.reply(413, {'error': 'figure_limit'})
            if length < 33: return self.reply(400, {'error': 'figure_input'})
            try:
                raw = self.rfile.read(length)
                if len(raw) != length: raise ProtocolFailure('figure_input')
                png_size(raw)
                return self.reply(200, manager.figure_regions.detect(raw))
            except ProtocolFailure as error:
                code = str(error)
                statuses = {'figure_input': 400, 'figure_limit': 413, 'figure_busy': 429,
                    'figure_unavailable': 503, 'figure_timeout': 504, 'figure_failed': 502}
                return self.reply(statuses.get(code, 502), {'error': code if code in statuses else 'figure_failed'})
            except (OSError, TimeoutError): return self.reply(400, {'error': 'figure_input'})
            except Exception: return self.reply(502, {'error': 'figure_failed'})

        def selection_error(self,error):
            code=str(error)
            status={"selection_source_required":409,"selection_busy":409,"job_not_complete":409,
                "job_not_found":404,"selection_timeout":504,"gpt_unavailable":503,"service_stopping":503}.get(code,400)
            allowed={"selection_source_required","selection_busy","selection_invalid","selection_unavailable",
                "job_not_complete","job_not_found","selection_timeout","gpt_unavailable","service_stopping","source_changed","incomplete_upload"}
            return self.reply(status,{"error":code if code in allowed else "selection_invalid"})

        def post_selection_alignment(self,identity):
            from selection_service import MAX_QUERY_BYTES, parse_query
            try: parent=manager.get(identity)
            except ProtocolFailure: return self.reply(404,{"error":"job_not_found"})
            if parent.state!="complete": return self.reply(409,{"error":"job_not_complete"})
            if self.headers.get("Transfer-Encoding") is not None:
                return self.reply(400,{"error":"unsupported_transfer_encoding"})
            lengths=self.headers.get_all("Content-Length") or []
            if len(lengths)!=1 or not lengths[0].isdigit(): return self.reply(411,{"error":"content_length_required"})
            length=int(lengths[0]);types=self.headers.get_all("Content-Type") or []
            if len(types)!=1: return self.reply(400,{"error":"invalid_content_type"})
            content_type=types[0].split(";",1)[0].strip().lower()
            selection_headers=self.headers.get_all("X-AskGPT-Selection") or []
            try:
                if content_type=="application/json":
                    if selection_headers or not 1<=length<=MAX_QUERY_BYTES: raise ProtocolFailure("selection_invalid")
                    raw=self.rfile.read(length)
                    if len(raw)!=length: raise ProtocolFailure("incomplete_upload")
                    query=parse_query(raw)
                elif content_type=="application/pdf":
                    if not 5<=length<=MAX_PDF_BYTES: return self.reply(413,{"error":"pdf_too_large"})
                    if len(selection_headers)!=1 or len(selection_headers[0])>MAX_QUERY_BYTES:
                        raise ProtocolFailure("selection_invalid")
                    header=selection_headers[0]
                    query=parse_query(header.encode("ascii"))
                    if not manager.upload_slots.acquire(blocking=False): raise ProtocolFailure("selection_busy")
                    try: manager.selection_alignments.install_source(parent,self.rfile,length)
                    finally: manager.upload_slots.release()
                else: return self.reply(415,{"error":"invalid_content_type"})
                return self.reply(200,manager.selection_alignments.align(parent,query))
            except ProtocolFailure as error: return self.selection_error(error)
            except (OSError,TimeoutError,ValueError,TypeError,KeyError): return self.reply(400,{"error":"selection_invalid"})

        def post_alignment_upgrade(self,identity):
            try: parent=manager.get(identity)
            except ProtocolFailure: return self.reply(404,{"error":"job_not_found"})
            if parent.state!="complete": return self.reply(409,{"error":"job_not_complete"})
            if self.headers.get("Transfer-Encoding") is not None:
                return self.reply(400,{"error":"unsupported_transfer_encoding"})
            lengths=self.headers.get_all("Content-Length") or []
            if len(lengths)!=1 or not lengths[0].isdigit(): return self.reply(411,{"error":"content_length_required"})
            length=int(lengths[0])
            types=self.headers.get_all("Content-Type") or []
            if len(types)!=1:return self.reply(400,{"error":"invalid_content_type"})
            content_type=types[0].split(";",1)[0].strip().lower()
            unit_headers=self.headers.get_all("X-AskGPT-Units") or []
            if len(unit_headers)>1:return self.reply(400,{"error":"invalid_units"})
            if content_type=="application/json":
                if not 1<=length<=2048 or unit_headers:return self.reply(400,{"error":"invalid_units"})
                try:
                    def unique_object(pairs):
                        result=dict(pairs)
                        if len(result)!=len(pairs):raise ValueError("duplicate_field")
                        return result
                    raw=self.rfile.read(length)
                    if len(raw)!=length:raise ValueError("incomplete_priority")
                    value=json.loads(raw,object_pairs_hook=unique_object)
                    if not isinstance(value,dict) or set(value)!={"page","units"}:raise ValueError("invalid_priority")
                    return self.reply(200,manager.sentence_upgrades.prioritize(parent,value["page"],value["units"]))
                except (ProtocolFailure,OSError,TimeoutError,ValueError,TypeError,KeyError):
                    return self.reply(400,{"error":"invalid_units"})
            if not 5<=length<=MAX_PDF_BYTES: return self.reply(413,{"error":"pdf_too_large"})
            if content_type!="application/pdf":
                return self.reply(415,{"error":"pdf_content_type_required"})
            priority_units=None
            try:
                selected=parse_pages(self.headers.get("X-AskGPT-Pages","all"),parent.page_count)
                if any(x not in parent.source_pages for x in selected): raise ProtocolFailure("invalid_pages")
                if unit_headers:
                    if len(selected)!=1 or len(unit_headers[0])>1024:raise ProtocolFailure("invalid_units")
                    priority_units=manager.sentence_upgrades.validate_priority_units(parent,selected[0],json.loads(unit_headers[0]))
            except (ProtocolFailure,ValueError,TypeError): return self.reply(400,{"error":"invalid_pages"})
            if not manager.upload_slots.acquire(blocking=False): return self.reply(409,{"error":"alignment_conflict"})
            temporary=None
            try:
                temporary=manager.begin()
                descriptor=platform.secure_open(temporary.directory/"input.pdf",os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                with os.fdopen(descriptor,"wb") as output:
                    remaining=length
                    while remaining:
                        chunk=self.rfile.read(min(65536,remaining))
                        if not chunk: raise ProtocolFailure("incomplete_upload")
                        output.write(chunk);remaining-=len(chunk)
                _,digest=_private_file(temporary.directory/"input.pdf",MAX_PDF_BYTES,checksum=True)
                if digest!=parent.cache_info["sourceSHA256"]: raise ProtocolFailure("source_changed")
                result=manager.sentence_upgrades.submit(parent,temporary,selected,priority_units)
                temporary=None
                return self.reply(202,result)
            except ProtocolFailure as error:
                return self.reply(409 if str(error)=="alignment_conflict" else 400,{"error":str(error)})
            except (OSError,ValueError,TypeError,KeyError): return self.reply(400,{"error":"alignment_invalid"})
            finally:
                if temporary is not None:
                    with manager.lock: manager._discard_placeholder(temporary)
                manager.upload_slots.release()

        def do_DELETE(self):
            if not self.authorize(): return
            match = JOB_ROUTE.fullmatch(self.path)
            if not match or match[2]: return self.reply(404, {"error": "not_found"})
            try: return self.reply(200, manager.cancel(manager.get(match[1])))
            except ProtocolFailure: return self.reply(404, {"error": "job_not_found"})

        def do_OPTIONS(self):
            if not self.valid_host_origin(require_origin=True):
                return self.reply(403, {"error": "invalid_origin_or_host"})
            if (self.path not in {"/v1/pdf/jobs", "/v1/pdf/health"} and not JOB_ROUTE.fullmatch(self.path)
                    and not ALIGNMENT_UPGRADE_ROUTE.fullmatch(self.path)):
                return self.reply(404, {"error": "not_found"})
            methods = self.headers.get_all("Access-Control-Request-Method") or []
            requested = self.headers.get_all("Access-Control-Request-Headers") or []
            names = {name.strip().lower() for name in requested[0].split(",")} if len(requested) == 1 else set()
            if (len(methods) != 1 or methods[0] not in {"GET", "POST", "DELETE"}
                    or "authorization" not in names or not names.issubset(cors_headers)):
                return self.reply(403, {"error": "invalid_preflight"})
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE")
            self.send_header("Access-Control-Allow-Headers", ", ".join(sorted(cors_headers)))
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True

        def do_PUT(self):
            if self.authorize(): self.reply(405, {"error": "method_not_allowed"})

        do_PATCH = do_PUT
        do_HEAD = do_PUT

    return PDFHTTPServer(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--translator", required=True, type=Path)
    parser.add_argument("--cache-root", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        root = private_directory(args.cache_root)
        lock_file = platform.secure_open(root / "server.lock", os.O_RDWR | os.O_CREAT, 0o600)
        platform.validate_file(lock_file)
        platform.lock_exclusive(lock_file)
        # An optional backend configuration has its own permanent result namespace.
        # Keep the historical Codex namespace unchanged when no override is selected.
        backend_identity = os.environ.get("ASKGPT_TRANSLATION_CACHE_ID", "")
        if backend_identity and not re.fullmatch(r"[0-9a-f]{64}", backend_identity):
            raise ValueError("invalid_translation_backend_identity")
        revision = TRANSLATION_REVISION + ("-backend-" + backend_identity if backend_identity else "")
        manager = JobManager(args.cache_root, args.translator, translation_revision=revision)
        token, extension_origin = load_connection(args.config)
        service = create_server(manager, token, extension_origin=extension_origin)
    except Exception:
        print("pdf_service_start_failed", file=sys.stderr)
        return 1
    def stop(signum, frame):
        threading.Thread(target=service.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try: service.serve_forever(poll_interval=.2)
    finally:
        manager.shutdown()
        service.server_close()
    return 0


if __name__ == "__main__": raise SystemExit(main())
