"""Four process-wide file permits for PDF batch model I/O only."""
from __future__ import annotations

from contextlib import contextmanager
import errno
import fcntl
import os
from pathlib import Path
import stat

from layout_common import ProtocolFailure

MAX_GLOBAL_BATCHES = 4
PERMIT_SUBDIRECTORY = "batch-model-permits"
POLL_SECONDS = .025


class BatchPermits:
    """Separate opens contend across both threads and worker processes.

    Only an acquired descriptor stays open during the helper's batch call. An
    ordinary return, exception, process exit or SIGKILL releases its flock; no
    PID registry, expiry, stale-file deletion or session-wide ownership exists.
    """
    def __init__(self, directory):
        self.directory = Path(directory)
        descriptor = self._open_directory(create=True)
        try:
            for index in range(MAX_GLOBAL_BATCHES):
                fd = self._open_slot(descriptor, index)
                os.close(fd)
        finally: os.close(descriptor)

    def _open_directory(self, *, create=False):
        try:
            if create: self.directory.mkdir(mode=0o700, exist_ok=True)
            descriptor = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        except OSError:
            raise ProtocolFailure("unsafe_cache_directory") from None
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o700):
                raise ProtocolFailure("unsafe_cache_directory")
        except BaseException:
            os.close(descriptor); raise
        return descriptor

    @staticmethod
    def _check_file(descriptor):
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            raise ProtocolFailure("unsafe_cache_directory")
        return info

    def _open_slot(self, directory, index):
        name = f"slot-{index}.lock"
        try:
            descriptor = os.open(name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600, dir_fd=directory)
        except OSError:
            raise ProtocolFailure("unsafe_cache_directory") from None
        try:
            info = self._check_file(descriptor)
            bound = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if (bound.st_dev, bound.st_ino) != (info.st_dev, info.st_ino):
                raise ProtocolFailure("unsafe_cache_directory")
        except BaseException:
            os.close(descriptor); raise
        return descriptor

    def _acquire(self, cancelled):
        directory = self._open_directory()
        try:
            while True:
                if cancelled.is_set(): raise ProtocolFailure("gpt_unavailable")
                for index in range(MAX_GLOBAL_BATCHES):
                    if cancelled.is_set(): raise ProtocolFailure("gpt_unavailable")
                    descriptor = self._open_slot(directory, index)
                    try:
                        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except OSError as error:
                        os.close(descriptor)
                        if error.errno in {errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR}: continue
                        raise ProtocolFailure("gpt_unavailable") from None
                    try:
                        self._check_file(descriptor)
                        if cancelled.is_set(): raise ProtocolFailure("gpt_unavailable")
                    except BaseException:
                        os.close(descriptor); raise
                    return descriptor
                # No blocked flock and no polling sleep that misses cancellation.
                cancelled.wait(POLL_SECONDS)
        finally: os.close(directory)

    @contextmanager
    def hold(self, cancelled):
        descriptor = self._acquire(cancelled)
        try:
            if cancelled.is_set(): raise ProtocolFailure("gpt_unavailable")
            yield
        finally:
            try: fcntl.flock(descriptor, fcntl.LOCK_UN)
            finally: os.close(descriptor)
