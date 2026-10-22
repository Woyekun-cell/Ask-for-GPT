"""Local-only file permits bound page GPT I/O across document workers."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
import os
import queue
import stat
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from layout_common import ProtocolFailure
import platform_ops as platform
from page_parallel import NativeHelperPool, MAX_PAGE_WORKERS
try:
    from batch_permits import BatchPermits, MAX_GLOBAL_BATCHES
except ImportError:
    BatchPermits = None
    MAX_GLOBAL_BATCHES = None


class BatchPermitTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(BatchPermits, 'global batch permits are not implemented')
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name) / 'batch-model-permits'
    def tearDown(self):
        if hasattr(self, 'temporary'): self.temporary.cleanup()
    def wait_for(self, predicate):
        until = time.monotonic() + 3
        while not predicate() and time.monotonic() < until: time.sleep(.005)
        self.assertTrue(predicate())
    def test_four_slots_bound_eight_threads(self):
        self.assertEqual(MAX_PAGE_WORKERS, 4)
        self.assertEqual(MAX_GLOBAL_BATCHES, 4)
        permits = BatchPermits(self.directory)
        lock, release = threading.Lock(), threading.Event()
        active = maximum = entered = 0
        def run():
            nonlocal active, maximum, entered
            with permits.hold(threading.Event()):
                with lock: active += 1; entered += 1; maximum = max(maximum, active)
                try: self.assertTrue(release.wait(3))
                finally:
                    with lock: active -= 1
        with ThreadPoolExecutor(8) as executor:
            futures = [executor.submit(run) for _ in range(8)]
            try:
                self.wait_for(lambda: entered == 4)
                time.sleep(.05); self.assertEqual(entered, 4)
            finally: release.set()
            for future in futures: future.result(3)
        self.assertEqual(maximum, 4)
        self.assertEqual(len(list(self.directory.glob('slot-*.lock'))), 4)
        for path in self.directory.iterdir():
            descriptor = platform.secure_open(path, os.O_RDONLY)
            try: platform.validate_file(descriptor)
            finally: os.close(descriptor)
    def test_two_four_helper_pools_share_only_four_global_io_slots(self):
        lock, release = threading.Lock(), threading.Event()
        active = maximum = entered = 0
        class Helper:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def translate_batch(self, rows):
                nonlocal active, maximum, entered
                with lock: active += 1; entered += 1; maximum = max(maximum, active)
                try:
                    if not release.wait(3): raise AssertionError('test release timed out')
                    return rows
                finally:
                    with lock: active -= 1
        with NativeHelperPool(Helper, 4, global_permit_directory=self.directory) as first, \
                NativeHelperPool(Helper, 4, global_permit_directory=self.directory) as second, ThreadPoolExecutor(8) as executor:
            futures = [executor.submit(pool.translate_batch, [{'id':'p0','text':str(i)}])
                for i, pool in enumerate([first]*4+[second]*4)]
            try:
                self.wait_for(lambda: entered == 4)
                time.sleep(.05); self.assertEqual(entered, 4)
            finally: release.set()
            self.assertEqual([future.result(3)[0]['text'] for future in futures], list(map(str,range(8))))
        self.assertEqual(maximum, 4)
    def test_cancelled_global_wait_never_starts_native_child(self):
        import worker
        permits = BatchPermits(self.directory)
        with ExitStack() as held:
            for _ in range(4): held.enter_context(permits.hold(threading.Event()))
            helper = worker.NativeHelper(Path('/must-not-start'), 'en', 'zh-Hans')
            with patch.object(worker.subprocess, 'Popen') as popen, \
                    NativeHelperPool(lambda: helper, 1, global_permit_directory=self.directory) as pool, ThreadPoolExecutor(1) as executor:
                future = executor.submit(pool.translate_batch, [{'id':'p0','text':'source'}])
                time.sleep(.05); self.assertFalse(future.done())
                started = time.monotonic(); pool.close()
                with self.assertRaisesRegex(ProtocolFailure, 'gpt_unavailable'): future.result(.5)
                self.assertLess(time.monotonic()-started,.5)
                popen.assert_not_called(); self.assertIsNone(helper.process)
    def test_close_event_blocks_last_helper_before_its_cancel_is_reached(self):
        import worker
        entered,release=threading.Event(),threading.Event()
        class DelayedCancel:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def cancel(self):entered.set();release.wait(3)
        last=worker.NativeHelper(Path('/must-not-start'),'en','zh-Hans')
        contexts=[DelayedCancel(),DelayedCancel(),DelayedCancel(),last]
        with NativeHelperPool(lambda:contexts.pop(0),4,global_permit_directory=self.directory) as pool,\
                ThreadPoolExecutor(1) as executor,patch.object(worker.subprocess,'Popen') as popen:
            future=executor.submit(pool.close)
            try:
                self.assertTrue(entered.wait(3))
                self.assertFalse(last.cancelled,'close has not yet reached the last helper')
                with self.assertRaisesRegex(ProtocolFailure,'gpt_unavailable'):last._start(batch=True)
                popen.assert_not_called()
            finally:release.set();future.result(3)
    def test_exception_releases_permit_and_idle_helper_holds_none(self):
        permits = BatchPermits(self.directory)
        with self.assertRaisesRegex(ValueError, 'intentional'):
            with permits.hold(threading.Event()): raise ValueError('intentional')
        class Helper:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def translate_batch(self, rows): return rows
        with NativeHelperPool(Helper, 1, global_permit_directory=self.directory) as pool:
            self.assertEqual(pool.translate_batch([{'id':'p0','text':'same'}])[0]['text'], 'same')
            with ExitStack() as held:
                for _ in range(4): held.enter_context(permits.hold(threading.Event()))
    def test_process_exit_releases_its_file_lock(self):
        permits = BatchPermits(self.directory)
        module_directory = str(Path(__file__).resolve().parents[1])
        script = ('import sys,threading,time;sys.path.insert(0,'+repr(module_directory)+');'
            'from batch_permits import BatchPermits;'
            'p=BatchPermits('+repr(str(self.directory))+');'
            'c=p.hold(threading.Event());c.__enter__();print("held",flush=True);time.sleep(30)')
        with ExitStack() as held:
            for _ in range(3): held.enter_context(permits.hold(threading.Event()))
            process = subprocess.Popen([sys.executable,'-c',script],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            try:
                self.assertEqual(platform.read_pipe(process.stdout, time.monotonic()+3).rstrip(b'\r\n'), b'held')
                with ThreadPoolExecutor(1) as executor:
                    def acquire():
                        with permits.hold(threading.Event()): return True
                    future = executor.submit(acquire)
                    time.sleep(.05); self.assertFalse(future.done())
                    process.kill(); process.wait(timeout=3)
                    self.assertTrue(future.result(1))
            finally:
                if process.poll() is None: process.kill();process.wait(timeout=3)
                process.stdout.close();process.stderr.close()
    def test_two_independent_process_pools_share_four_slots(self):
        BatchPermits(self.directory)
        release=Path(self.temporary.name)/'release'
        module_directory=str(Path(__file__).resolve().parents[1])
        script=("import sys,time,pathlib;from concurrent.futures import ThreadPoolExecutor;sys.path.insert(0,"+repr(module_directory)+")\n"
            "from page_parallel import NativeHelperPool\n"
            "class Helper:\n"
            " def __enter__(self):return self\n"
            " def __exit__(self,*args):pass\n"
            " def translate_batch(self,rows):\n"
            "  print('entered',flush=True)\n"
            "  while not pathlib.Path("+repr(str(release))+").exists():time.sleep(.005)\n"
            "  return rows\n"
            "with NativeHelperPool(Helper,4,global_permit_directory="+repr(str(self.directory))+") as pool,ThreadPoolExecutor(4) as executor:\n"
            " futures=[executor.submit(pool.translate_batch,[{'id':'p0','text':str(i)}])for i in range(4)]\n"
            " for future in futures:future.result(5)\n")
        processes=[subprocess.Popen([sys.executable,'-c',script],stdout=subprocess.PIPE,stderr=subprocess.PIPE)for _ in range(2)]
        entered=0
        messages=queue.Queue()
        def collect(process):
            for line in process.stdout: messages.put(line)
        readers=[threading.Thread(target=collect,args=(process,),daemon=True) for process in processes]
        for reader in readers: reader.start()
        try:
            deadline=time.monotonic()+3
            while entered<4 and time.monotonic()<deadline:
                try: entered += messages.get(timeout=.1).rstrip(b'\r\n') == b'entered'
                except queue.Empty: pass
            self.assertEqual(entered,4)
            with self.assertRaises(queue.Empty): messages.get(timeout=.1)
            release.touch()
            for process in processes:self.assertEqual(process.wait(timeout=3),0)
        finally:
            release.touch(exist_ok=True)
            for process in processes:
                if process.poll()is None:process.kill();process.wait(timeout=3)
            for reader in readers: reader.join(3)
            for process in processes:
                process.stdout.close();process.stderr.close()
    def test_permit_descriptor_is_not_inheritable(self):
        permits=BatchPermits(self.directory)
        descriptor=permits._acquire(threading.Event())
        try:
            self.assertFalse(os.get_inheritable(descriptor))
        finally:os.close(descriptor)
    def test_wait_is_cancelled_without_any_permit_being_released(self):
        permits, cancelled = BatchPermits(self.directory), threading.Event()
        with ExitStack() as held, ThreadPoolExecutor(1) as executor:
            for _ in range(4): held.enter_context(permits.hold(threading.Event()))
            def run():
                with permits.hold(cancelled): raise AssertionError('cancelled acquired')
            future = executor.submit(run); time.sleep(.05); cancelled.set()
            with self.assertRaisesRegex(ProtocolFailure,'gpt_unavailable'): future.result(.5)
    def test_symlink_slot_is_rejected_without_touching_target(self):
        platform.private_directory(self.directory)
        target=Path(self.temporary.name)/'outside';target.write_text('leave untouched');target.chmod(0o600)
        try: (self.directory/'slot-0.lock').symlink_to(target)
        except OSError:
            if platform.IS_WINDOWS: self.skipTest('Windows symlink privilege unavailable; junction rejection tested separately')
            raise
        with self.assertRaisesRegex(ProtocolFailure,'unsafe_cache_directory'): BatchPermits(self.directory)
        self.assertEqual(target.read_text(),'leave untouched')
    def test_hardlinked_slot_is_rejected(self):
        platform.private_directory(self.directory)
        target=Path(self.temporary.name)/'outside';target.touch(mode=0o600)
        os.link(target,self.directory/'slot-0.lock')
        with self.assertRaisesRegex(ProtocolFailure,'unsafe_cache_directory'): BatchPermits(self.directory)
        self.assertEqual(target.stat().st_nlink,2)
    def test_public_mode_directory_and_lock_are_rejected(self):
        if platform.IS_WINDOWS:
            platform.private_directory(self.directory)
            subprocess.run(['icacls.exe',str(self.directory),'/grant','*S-1-1-0:(R)'],check=True,capture_output=True)
            with self.assertRaisesRegex(ProtocolFailure,'unsafe_cache_directory'): BatchPermits(self.directory)
            platform.private_directory(self.directory)
            path=self.directory/'slot-0.lock'
            descriptor=platform.secure_open(path,os.O_RDWR|os.O_CREAT|os.O_EXCL);os.close(descriptor)
            subprocess.run(['icacls.exe',str(path),'/grant','*S-1-1-0:(R)'],check=True,capture_output=True)
            with self.assertRaisesRegex(ProtocolFailure,'unsafe_cache_directory'): BatchPermits(self.directory)
            return
        self.directory.mkdir(mode=0o755);self.directory.chmod(0o755)
        with self.assertRaisesRegex(ProtocolFailure,'unsafe_cache_directory'): BatchPermits(self.directory)
        self.directory.chmod(0o700)
        path=self.directory/'slot-0.lock';path.touch(mode=0o644);path.chmod(0o644)
        with self.assertRaisesRegex(ProtocolFailure,'unsafe_cache_directory'): BatchPermits(self.directory)
        self.assertEqual(path.stat().st_mode&0o777,0o644,'do not silently repair unsafe existing files')
    def test_symlink_directory_is_rejected(self):
        target=Path(self.temporary.name)/'actual';target.mkdir(mode=0o700)
        if platform.IS_WINDOWS:
            subprocess.run(['cmd.exe','/c','mklink','/J',str(self.directory),str(target)],check=True,capture_output=True)
        else: self.directory.symlink_to(target,target_is_directory=True)
        with self.assertRaisesRegex(ProtocolFailure,'unsafe_cache_directory'): BatchPermits(self.directory)
    def test_wrong_file_owner_is_rejected(self):
        if platform.IS_WINDOWS: self.skipTest('POSIX uid injection; Windows ACL owner checked through native handles')
        original=os.fstat
        def altered(fd):
            value=original(fd)
            if not stat.S_ISREG(value.st_mode):return value
            return SimpleNamespace(st_mode=value.st_mode,st_uid=value.st_uid+1,st_nlink=value.st_nlink)
        with patch('batch_permits.os.fstat',side_effect=altered):
            with self.assertRaisesRegex(ProtocolFailure,'unsafe_cache_directory'): BatchPermits(self.directory)


if __name__=='__main__':unittest.main()
