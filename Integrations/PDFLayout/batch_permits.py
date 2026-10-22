"""Four process-wide file permits for PDF batch model I/O only."""
from __future__ import annotations

from contextlib import contextmanager
import errno
import os
from pathlib import Path
import stat
import platform_ops as platform

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
        finally: self._close_directory(descriptor)

    def _open_directory(self, *, create=False):
        if platform.IS_WINDOWS:
            try:
                if create and not self.directory.exists(): platform.private_directory(self.directory)
                return platform.open_private_directory(self.directory)
            except (OSError, ValueError): raise ProtocolFailure("unsafe_cache_directory") from None
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
    def _close_directory(descriptor):
        platform.close_directory(descriptor)

    @staticmethod
    def _check_file(descriptor):
        try: return platform.validate_file(descriptor)
        except (OSError, ValueError): raise ProtocolFailure("unsafe_cache_directory") from None

    def _open_slot(self, directory, index):
        name = f"slot-{index}.lock"
        if platform.IS_WINDOWS:
            descriptor = None
            try:
                platform.check_directory_binding(directory, self.directory)
                descriptor = platform.secure_open(self.directory / name, os.O_RDWR | os.O_CREAT)
                self._check_file(descriptor)
                platform.check_directory_binding(directory, self.directory)
                return descriptor
            except BaseException as error:
                if descriptor is not None: os.close(descriptor)
                if isinstance(error, (OSError, ValueError)):
                    raise ProtocolFailure("unsafe_cache_directory") from None
                raise
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
                        platform.lock_exclusive(descriptor)
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
        finally: self._close_directory(directory)

    @contextmanager
    def hold(self, cancelled):
        descriptor = self._acquire(cancelled)
        try:
            if cancelled.is_set(): raise ProtocolFailure("gpt_unavailable")
            yield
        finally:
            try: platform.unlock(descriptor)
            finally: os.close(descriptor)
