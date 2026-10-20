"""Real macOS process-boundary regression; no real Codex login or model call."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "Integrations/PDFLayout"))
import server


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("swiftc"), "macOS Foundation process test")
class HelperLifecycleProcessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        cls.root = Path(cls.folder.name)
        cls.fixture = cls.root / "OwnedHelper.swift"
        cls.executable = cls.root / "owned-helper"
        cls.fixture.write_text(r'''import Foundation
import Darwin
@main struct OwnedHelper {
    static func main() async throws {
        let marker = CommandLine.arguments[1]
        let rpc = try CodexRPCConnection(executable: "/bin/sh", arguments: ["-c",
            "trap '' TERM; printf '%s' \"$$\" > \"$1\"; exec /bin/sleep 30", "owned-cli", marker],
            workingDirectory: URL(fileURLWithPath: "/private/tmp"),
            environment: ProcessInfo.processInfo.environment)
        let lifecycle = TranslationHelperLifecycle { await rpc.close() }
        lifecycle.start()
        do { _ = try await rpc.request("fixture/wait", timeout: 30) } catch { }
        await lifecycle.shutdownAndWait()
    }
}
''')
        sdk = Path("/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk")
        if not sdk.is_dir():
            sdk = Path(subprocess.check_output(["xcrun", "--sdk", "macosx", "--show-sdk-path"], text=True).strip())
        result = subprocess.run(["swiftc", "-parse-as-library", "-sdk", str(sdk),
            "-module-cache-path", "/private/tmp/askgpt-helper-lifecycle-module-cache",
            str(ROOT / "Sources/AskGPTCore/CodexRPC.swift"),
            str(ROOT / "Sources/AskGPTCore/TranslationHelperLifecycle.swift"),
            str(cls.fixture), "-o", str(cls.executable)], capture_output=True, text=True, timeout=120)
        if result.returncode: raise AssertionError(result.stderr)

    @classmethod
    def tearDownClass(cls): cls.folder.cleanup()

    def setUp(self):
        self.case = tempfile.TemporaryDirectory(dir=self.root)
        self.directory = Path(self.case.name)
        self.owned = []

    def tearDown(self):
        for process in self.owned:
            try: os.kill(process, signal.SIGKILL)
            except ProcessLookupError: pass
        self.case.cleanup()

    def marker_pid(self, marker):
        for _ in range(200):
            if marker.exists() and marker.read_text().strip():
                identity = int(marker.read_text())
                self.owned.append(identity)
                return identity
            time.sleep(.025)
        self.fail("owned native CLI did not start")

    def assert_gone(self, identity):
        for _ in range(200):
            try: os.kill(identity, 0)
            except ProcessLookupError: return
            time.sleep(.025)
        self.fail("owned native process survived lifecycle cleanup")

    def test_signal_while_model_waits_closes_independent_cli_group(self):
        for number in (signal.SIGTERM, signal.SIGINT):
            marker = self.directory / (str(number) + ".pid")
            helper = subprocess.Popen([str(self.executable), str(marker)], stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.owned.append(helper.pid)
            child = self.marker_pid(marker)
            self.assertEqual(os.getpgid(child), child)
            self.assertNotEqual(os.getpgid(child), os.getpgid(helper.pid))
            helper.send_signal(number)
            self.assertEqual(helper.wait(timeout=4), 0)
            self.assert_gone(child)
            helper.stdin.close()

    def test_parent_exit_while_model_waits_closes_independent_cli_group(self):
        marker = self.directory / "parent-exit.pid"
        helper_marker = self.directory / "helper.pid"
        bridge = subprocess.Popen([sys.executable, "-c",
            "import pathlib,subprocess,sys,time; p=subprocess.Popen(sys.argv[1:3]); "
            "pathlib.Path(sys.argv[3]).write_text(str(p.pid)); time.sleep(30)",
            str(self.executable), str(marker), str(helper_marker)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.owned.append(bridge.pid)
        child = self.marker_pid(marker)
        helper = self.marker_pid(helper_marker)
        self.assertNotEqual(os.getpgid(child), os.getpgid(helper))
        bridge.terminate(); bridge.wait(timeout=2)
        self.assert_gone(child)
        self.assert_gone(helper)

    def test_server_cancel_allows_helper_to_clean_cli_after_worker_leader_exits(self):
        import pymupdf
        worker = self.directory / "owned-worker.py"
        worker.write_text("import argparse,pathlib,subprocess,time\n"
            "p=argparse.ArgumentParser();p.add_argument('--job-dir');p.add_argument('--cache-root');p.add_argument('--translator');a=p.parse_args()\n"
            "d=pathlib.Path(a.job_dir)\n"
            f"h=subprocess.Popen([{str(self.executable)!r},str(d/'cli.pid')])\n"
            "(d/'helper.pid').write_text(str(h.pid));time.sleep(30)\n")
        manager = server.JobManager(self.directory / "cache", Path(sys.executable),
            worker_script=worker, ready_override=True)
        try:
            job = manager.begin()
            doc = pymupdf.open(); doc.new_page()
            (job.directory / "input.pdf").write_bytes(doc.tobytes()); doc.close()
            (job.directory / "input.pdf").chmod(0o600)
            manager.submit(job, "all", "en", "zh-Hans")
            helper = self.marker_pid(job.directory / "helper.pid")
            child = self.marker_pid(job.directory / "cli.pid")
            self.assertNotEqual(os.getpgid(child), job.process.pid)
            manager.cancel(job)
            self.assert_gone(child)
            self.assert_gone(helper)
            self.assertEqual(job.state, "cancelled")
        finally:
            manager.shutdown()

    def test_server_pipe_eof_watchdog_leaves_helper_alive_for_independent_cli_cleanup(self):
        marker = self.directory / "eof-cli.pid"
        helper_marker = self.directory / "eof-helper.pid"
        worker_script = self.directory / "eof-worker.py"
        worker_script.write_text("import pathlib,subprocess,sys,time\n"
            f"sys.path.insert(0,{str(ROOT / 'Integrations/PDFLayout')!r})\n"
            "import worker\n"
            "def fake_translation(*args):\n"
            f" h=subprocess.Popen([{str(self.executable)!r},{str(marker)!r}])\n"
            f" pathlib.Path({str(helper_marker)!r}).write_text(str(h.pid))\n"
            " time.sleep(30)\n"
            "worker.translate_job=fake_translation\n"
            "raise SystemExit(worker.main())\n")
        process = subprocess.Popen([sys.executable, "-B", str(worker_script),
            "--job-dir", str(self.directory), "--cache-root", str(self.directory),
            "--translator", str(self.executable)], stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        self.owned.append(process.pid)
        child = self.marker_pid(marker)
        helper = self.marker_pid(helper_marker)
        self.assertNotEqual(os.getpgid(child), process.pid)
        process.stdin.close()
        self.assertEqual(process.wait(timeout=2), -signal.SIGTERM)
        self.assert_gone(child)
        self.assert_gone(helper)


if __name__ == "__main__": unittest.main()
