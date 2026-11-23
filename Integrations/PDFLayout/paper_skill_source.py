"""Pin the trusted local PaperLens resources for a single HTML job."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat

import platform_ops as platform


FILES = (
    'SKILL.md', 'references/build.md', 'references/review.md', 'assets/reader.src.html',
    'scripts/extract_pdf.py', 'scripts/prepare_html.py', 'scripts/verify_evidence.py',
    'scripts/verify_browser.mjs',
)
MAX_RESOURCE_BYTES = 2 * 1024 * 1024


class WorkflowSourceError(ValueError):
    """The workflow source could not be safely pinned."""


def _identity(info):
    return info.st_dev, info.st_ino, info.st_mode, info.st_uid


def _revision(info):
    return _identity(info), info.st_size, info.st_nlink, info.st_mtime_ns, info.st_ctime_ns


def _trusted(info, owners):
    return (not getattr(info, 'st_file_attributes', 0) & 0x400 and
            (owners is None or info.st_uid in owners and not info.st_mode & 0o022))


def _directory(path, owners):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or not _trusted(info, owners):
        raise WorkflowSourceError('paper_skill_unsafe')
    return _identity(info)


def _resource(path, owners):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not _trusted(info, owners):
        raise WorkflowSourceError('paper_skill_unsafe')
    if not 0 < info.st_size <= MAX_RESOURCE_BYTES:
        raise WorkflowSourceError('paper_skill_invalid_resource')
    return _revision(info)


def _read(path, expected):
    flags = os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_CLOEXEC', 0)
    descriptor = platform.secure_open(path, flags)
    with os.fdopen(descriptor, 'rb') as stream:
        if _revision(os.fstat(descriptor)) != expected:
            raise WorkflowSourceError('paper_skill_changed')
        data = stream.read(MAX_RESOURCE_BYTES + 1)
        if len(data) != expected[1] or _revision(os.fstat(descriptor)) != expected:
            raise WorkflowSourceError('paper_skill_changed')
    data.decode('utf-8')
    return data


def snapshot_workflow(work: Path, bundled: Path, home: Path) -> Path:
    """Select PaperLens (legacy if absent), copy one checked revision, and return its private root."""
    try:
        codex = home.resolve(strict=True) / '.codex'
        skills = codex / 'skills'
        for name in ('paperlens', 'paper-reading-workflow'):
            candidate = skills / name
            try:
                candidate.lstat()
            except FileNotFoundError:
                continue
            source, origin = candidate, name
            ancestors = (codex, skills)
            owners = None if platform.IS_WINDOWS else {os.getuid()}
            break
        else:
            source, origin = bundled.parent.resolve(strict=True) / bundled.name, 'bundled'
            ancestors = ()
            owners = None if platform.IS_WINDOWS else {os.getuid(), 0}

        directories = {path: _directory(path, owners) for path in
                       (*ancestors, source, source / 'references', source / 'assets', source / 'scripts')}
        resources = {name: _resource(source / name, owners) for name in FILES}
        contents = {name: _read(source / name, resources[name]) for name in FILES}
        if (directories != {path: _directory(path, owners) for path in directories} or
                resources != {name: _resource(source / name, owners) for name in FILES}):
            raise WorkflowSourceError('paper_skill_changed')

        destination = work / 'workflow-source'
        destination.mkdir(mode=0o700)
        hashes = {name: hashlib.sha256(data).hexdigest() for name, data in contents.items()}
        digest = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode('utf-8')).hexdigest()
        contents['source.json'] = (json.dumps({'source': origin, 'revision': digest, 'files': hashes}) + '\n').encode('utf-8')
        for name, data in contents.items():
            path = destination / name
            path.parent.mkdir(mode=0o700, exist_ok=True)
            descriptor = platform.secure_open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode=0o600)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(data)
        return destination
    except WorkflowSourceError:
        raise
    except (OSError, ValueError):
        raise WorkflowSourceError('paper_skill_unavailable') from None
