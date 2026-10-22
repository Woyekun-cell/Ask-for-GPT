"""Real local safety/IPC regression plus Windows-native policies in Windows CI."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import platform_ops as ops


class PlatformOpsTests(unittest.TestCase):
    def test_windows_job_cleanup_timeout_is_bounded_and_never_claims_success(self):
        closed = []
        class Kernel:
            def TerminateJobObject(self, handle, code): return True
            def WaitForSingleObject(self, handle, milliseconds):
                time.sleep(milliseconds / 1000); return 0x102
            def CloseHandle(self, handle): closed.append(handle); return True
        started = time.monotonic()
        with patch.multiple(ops, kernel=Kernel(), _wincheck=lambda value:value,
                            _job_process_handles=lambda handle:[(101, 501)], create=True):
            with self.assertRaisesRegex(TimeoutError, 'owned_job_cleanup_timeout'):
                ops._terminate_windows_job(42, timeout=.03)
        self.assertLess(time.monotonic() - started, .3)
        self.assertIn(501, closed)

    def test_windows_finish_waits_for_asynchronous_descendant_exit_before_closing_job(self):
        exited, closed = threading.Event(), []
        timer = threading.Timer(.05, exited.set)
        class Kernel:
            def TerminateJobObject(self, handle, code): timer.start(); return True
            def WaitForSingleObject(self, handle, milliseconds):
                return 0 if exited.wait(milliseconds / 1000) else 0x102
            def CloseHandle(self, handle): closed.append((handle, exited.is_set())); return True
        process = SimpleNamespace(_askgpt_job_handle=42, _askgpt_job_lock=threading.Lock(),
                                  poll=lambda:0, stdin=None)
        try:
            with patch.multiple(ops, IS_WINDOWS=True, kernel=Kernel(), _wincheck=lambda value:value,
                                _job_process_handles=lambda handle:[(101, 501)], create=True):
                ops.finish_owned(process, grace=0)
            self.assertTrue(exited.is_set(), 'cleanup returned while its descendant was still terminating')
            self.assertIn((42, True), closed, 'the owned job must remain open until descendant exit')
            self.assertIn((501, True), closed, 'owned process synchronization handles must be released')
        finally:
            if timer.ident is not None: timer.join(1)
    def test_generated_tree_protects_only_new_items_and_rejects_links(self):
        with tempfile.TemporaryDirectory() as root:
            directory = ops.private_directory(Path(root) / 'generated')
            previous = ops.snapshot_private_tree(directory)
            child = directory / 'fonts'
            child.mkdir()
            output = child / 'fixture.font'
            output.write_bytes(b'generated fixture')
            ops.protect_generated_tree(directory, previous)
            protected = ops.snapshot_private_tree(directory)
            self.assertIn(output, protected)
            outside = Path(root) / 'outside'
            outside.write_bytes(b'original')
            with self.assertRaisesRegex(ValueError, 'unsafe_generated_path'):
                ops.protect_generated_file(outside, directory, previous)
            os.link(output, directory / 'alias')
            with self.assertRaisesRegex(ValueError, 'unsafe_cache_file'):
                ops.protect_generated_tree(directory, previous)
            self.assertEqual(outside.read_bytes(), b'original')

    def test_generated_tree_never_repairs_an_unsafe_old_item(self):
        with tempfile.TemporaryDirectory() as root:
            directory = ops.private_directory(Path(root) / 'generated')
            output = directory / 'old'
            descriptor = ops.secure_open(output, os.O_RDWR | os.O_CREAT | os.O_EXCL)
            os.close(descriptor)
            previous = ops.snapshot_private_tree(directory)
            if ops.IS_WINDOWS:
                subprocess.run(['icacls.exe', str(output), '/setowner', '*S-1-5-32-544'], check=True, capture_output=True)
            else: output.chmod(0o644)
            with self.assertRaises((OSError, ValueError)): ops.protect_generated_tree(directory, previous)
            with self.assertRaises((OSError, ValueError)): ops.snapshot_private_tree(directory)

    @unittest.skipUnless(ops.IS_WINDOWS, 'Windows elevated creator owner and inherited ACL')
    def test_windows_generated_admin_owner_is_narrowed_only_for_new_private_entries(self):
        with tempfile.TemporaryDirectory() as root:
            directory = ops.private_directory(Path(root) / 'generated')
            previous = ops.snapshot_private_tree(directory)
            child = directory / 'models'
            child.mkdir()
            output = child / 'fixture.model'
            output.write_bytes(b'generated fixture')
            for path in (child, output):
                subprocess.run(['icacls.exe', str(path), '/setowner', '*S-1-5-32-544'], check=True, capture_output=True)
            ops.protect_generated_tree(directory, previous)
            self.assertIn(output, ops.snapshot_private_tree(directory))
            previous = ops.snapshot_private_tree(directory)
            unsafe = directory / 'broad'
            unsafe.write_bytes(b'no repair')
            subprocess.run(['icacls.exe', str(unsafe), '/grant', '*S-1-1-0:(R)'], check=True, capture_output=True)
            with self.assertRaisesRegex(ValueError, 'unsafe_file_acl'): ops.protect_generated_tree(directory, previous)

    def test_private_file_rejects_symlink_and_multiple_links(self):
        with tempfile.TemporaryDirectory() as root:
            directory = ops.private_directory(Path(root) / 'private')
            path = directory / 'test.json'
            descriptor = ops.secure_open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
            os.write(descriptor, b'private')
            ops.validate_file(descriptor)
            os.close(descriptor)
            other = directory / 'alias'
            os.link(path, other)
            with self.assertRaises((OSError, ValueError)):
                descriptor = ops.secure_open(path, os.O_RDONLY)
                try: ops.validate_file(descriptor)
                finally: os.close(descriptor)
            other.unlink()
            try: other.symlink_to(path)
            except OSError:
                if ops.IS_WINDOWS: return  # Unprivileged Windows can disallow symlink creation.
                raise
            with self.assertRaises((OSError, ValueError)): ops.secure_open(other, os.O_RDONLY)

    def test_lock_uses_distinct_opens_and_releases_on_close(self):
        with tempfile.TemporaryDirectory() as root:
            path = ops.private_directory(Path(root) / 'private') / 'service.lock'
            first = ops.secure_open(path, os.O_RDWR | os.O_CREAT, 0o600)
            second = ops.secure_open(path, os.O_RDWR, 0o600)
            try:
                ops.lock_exclusive(first)
                with self.assertRaises(OSError): ops.lock_exclusive(second)
                os.close(first); first = None
                ops.lock_exclusive(second)
                ops.unlock(second)
            finally:
                if first is not None: os.close(first)
                os.close(second)

    def test_owned_process_and_bounded_pipe_exchange_unicode_path(self):
        with tempfile.TemporaryDirectory(prefix='中文 pipe ') as root:
            script = Path(root) / 'echo child.py'
            script.write_text('import sys\nfor line in sys.stdin.buffer:\n sys.stdout.buffer.write(line); sys.stdout.buffer.flush()\n', encoding='utf-8')
            process = ops.spawn_owned([sys.executable, str(script)], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            try:
                message = ('中' * 50000 + '\n').encode()
                deadline = time.monotonic() + 5
                ops.write_pipe(process.stdin, message, deadline)
                buffer = bytearray()
                while b'\n' not in buffer:
                    buffer.extend(ops.read_pipe(process.stdout, deadline, maximum=65536))
                self.assertEqual(bytes(buffer), message)
            finally:
                ops.finish_owned(process, grace=.05)
                process.wait(timeout=3)
                process.stdin.close(); process.stdout.close()

    def test_stalled_child_pipe_deadline_is_bounded(self):
        process = ops.spawn_owned([sys.executable, '-c', 'import time; time.sleep(20)'],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            with self.assertRaises(TimeoutError):
                ops.write_pipe(process.stdin, b'x' * 1024 * 1024, time.monotonic() + .15)
        finally:
            ops.finish_owned(process, grace=.05)
            process.wait(timeout=3)
            process.stdin.close(); process.stdout.close()

    def test_background_writer_is_joined_before_pipe_is_reused(self):
        # Exercise the blocking writer on every host; native Windows tests also
        # verify that terminating its Job Object releases the blocked write.
        process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(20)'],
                                   stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
        try:
            with patch.object(ops, 'IS_WINDOWS', True):
                with self.assertRaises(TimeoutError):
                    ops.write_pipe(process.stdin, b'x' * 1024 * 1024, time.monotonic() + .05)
            process.kill(); process.wait(timeout=3)
            ops.join_pipe_writer(process.stdin)
            self.assertFalse(any(thread.name == 'askgpt-pipe-write' and thread.is_alive()
                                 for thread in threading.enumerate()))
        finally:
            if process.poll() is None: process.kill(); process.wait(timeout=3)
            process.stdin.close()

    @unittest.skipUnless(ops.IS_WINDOWS, 'Windows ACL and reparse validation')
    def test_windows_acl_rejects_broad_read_and_reparse_directory(self):
        with tempfile.TemporaryDirectory() as root:
            directory = ops.private_directory(Path(root) / 'protected')
            path = directory / 'secret'
            fd = ops.secure_open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL)
            os.close(fd)
            subprocess.run(['icacls.exe', str(path), '/grant', '*S-1-1-0:(R)'], check=True,
                           capture_output=True)
            with self.assertRaises((OSError, ValueError)): ops.secure_open(path, os.O_RDONLY)
            junction = Path(root) / 'junction'
            subprocess.run(['cmd.exe', '/c', 'mklink', '/J', str(junction), str(directory)],
                           check=True, capture_output=True)
            try:
                with self.assertRaises((OSError, ValueError)): ops.secure_open(junction / 'secret', os.O_RDONLY)
            finally: junction.rmdir()

    @unittest.skipUnless(ops.IS_WINDOWS, 'Windows Job Object ownership')
    def test_windows_job_terminates_descendant_after_leader_exits(self):
        with tempfile.TemporaryDirectory() as root:
            pidfile = Path(root) / 'child.pid'
            code = ('import subprocess,sys,pathlib; p=subprocess.Popen([sys.executable,"-c",'
                    '"import time; time.sleep(60)"]); pathlib.Path(sys.argv[1]).write_text(str(p.pid))')
            process = ops.spawn_owned([sys.executable, '-c', code, str(pidfile)], stdout=subprocess.DEVNULL)
            process.wait(timeout=5)
            child = int(pidfile.read_text())
            ops.finish_owned(process, grace=.05)
            self.assertFalse(ops.windows_process_alive(child))


if __name__ == '__main__': unittest.main()
