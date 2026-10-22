"""Real local safety/IPC regression plus Windows-native policies in Windows CI."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import platform_ops as ops


class PlatformOpsTests(unittest.TestCase):
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
