"""Installer subprocess tests; all downloads and installations stay in a fixture."""
import io
import os
from pathlib import Path
import platform
import subprocess
import sys
import tarfile
import tempfile
import unittest


INSTALLER = Path(__file__).resolve().parents[1] / "install-runtime"
UV_SHA256 = "50487ae565ccd96e499056b4674d438f4c53170202617b4c759defe0c6a1b544"
SUPPORTED_HOST = (sys.platform == "darwin" and platform.machine() == "arm64"
                  and int((platform.mac_ver()[0] or "0").split(".")[0]) >= 15)


@unittest.skipUnless(SUPPORTED_HOST, "macOS 15+ Apple Silicon installer")
class InstallRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="askgpt-install-test-")
        self.root = Path(self.temporary.name).resolve()
        self.cache = self.root / "PDF Layout"
        self.bin = self.root / "fixture-bin"
        self.bin.mkdir()
        self.log = self.root / "calls.log"
        self.python = self.root / "fixture-python"
        self.python.write_text("#!/bin/sh\nset -eu\nprintf 'python:%s\\n' \"$*\" >> \"$INSTALL_TEST_LOG\"\nprintf '%s\\n' '{\"babeldoc\":\"0.6.4\",\"files\":[]}' > \"$3/assets-ready.json\"\n")
        self.python.chmod(0o755)
        self.uv = self.root / "fixture-uv"
        self.uv.write_text("""#!/bin/sh
set -eu
printf 'uv:%s\\n' "$*" >> "$INSTALL_TEST_LOG"
case "$1" in
  --version) printf 'uv 0.12.23 (46b84fd0b 2026-10-03)\\n' ;;
  python) mkdir -p "$UV_PYTHON_INSTALL_DIR" ;;
  venv)
    for target do :; done
    mkdir -p "$target/bin"
    cp "$INSTALL_TEST_PYTHON" "$target/bin/python"
    ln -s python "$target/bin/python3"
    ;;
  pip) [ "${INSTALL_TEST_FAIL_PIP:-0}" != 1 ] || exit 9 ;;
  *) exit 8 ;;
esac
""")
        self.uv.chmod(0o755)
        self.archive = self.root / "uv.tar.gz"
        with tarfile.open(self.archive, "w:gz") as archive:
            payload = self.uv.read_bytes()
            entry = tarfile.TarInfo("uv-aarch64-apple-darwin/uv")
            entry.size = len(payload)
            entry.mode = 0o755
            archive.addfile(entry, io.BytesIO(payload))
        (self.bin / "curl").write_text("""#!/bin/sh
set -eu
printf 'curl:%s\\n' "$*" >> "$INSTALL_TEST_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then shift; output=$1; fi
  shift
done
cp "$INSTALL_TEST_ARCHIVE" "$output"
""")
        (self.bin / "curl").chmod(0o755)
        # The success fixture cannot have the digest of the real upstream binary.
        # Assert the production pin and checksum invocation at this boundary;
        # rejection below deliberately uses the real system checksum program.
        (self.bin / "shasum").write_text(
            "#!/bin/sh\nset -eu\n[ \"$*\" = '-a 256 -c -' ]\nIFS= read -r line\n"
            f"case \"$line\" in '{UV_SHA256}  '*) ;; *) exit 1 ;; esac\n"
            "printf 'fixture checksum: OK\\n'\n")
        (self.bin / "shasum").chmod(0o755)
        self.environment = {k: v for k, v in os.environ.items()
                            if not k.startswith(("ASKGPT_", "UV_", "PYTHON"))}
        self.environment.update({"HOME": str(self.root / "empty-home"),
                                 "PATH": str(self.bin) + ":/usr/bin:/bin:/usr/sbin:/sbin",
                                 "INSTALL_TEST_LOG": str(self.log),
                                 "INSTALL_TEST_PYTHON": str(self.python),
                                 "INSTALL_TEST_ARCHIVE": str(self.archive)})

    def tearDown(self):
        self.temporary.cleanup()

    def run_installer(self, **environment):
        return subprocess.run(["/bin/sh", str(INSTALLER), str(self.cache)],
                              env={**self.environment, **environment}, text=True,
                              capture_output=True, timeout=20)

    def calls(self):
        return self.log.read_text() if self.log.exists() else ""

    def test_bootstraps_without_external_uv_or_python(self):
        self.assertFalse((Path(self.environment["HOME"]) / ".local/bin/uv").exists())
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.calls()
        self.assertIn("https://releases.astral.sh/github/uv/releases/download/0.12.23/uv-aarch64-apple-darwin.tar.gz", calls)
        self.assertIn("--proto =https", calls)
        self.assertIn("--proto-redir =https", calls)
        self.assertNotIn("--insecure", calls)
        self.assertIn("uv:python install", calls)
        self.assertIn("3.12.15", calls)
        self.assertIn(str(self.cache / "Tools/python"), calls)
        self.assertIn("--only-binary :all:", calls)
        self.assertIn("--require-hashes", calls)
        self.assertIn("prepare-assets.py --cache-root " + str(self.cache), calls)
        self.assertTrue((self.cache / "Tools/uv").is_file())
        self.assertTrue((self.cache / "assets-ready.json").is_file())
        self.assertFalse((self.cache / ".install-lock").exists())

    def test_checksum_mismatch_does_not_execute_download(self):
        (self.bin / "shasum").unlink()
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("校验失败", result.stderr)
        self.assertNotIn("uv:", self.calls())
        self.assertFalse((self.cache / "Tools/uv").exists())
        self.assertFalse((self.cache / ".install-lock").exists())
        self.assertEqual(list(self.cache.glob(".install-*")), [])

    def test_existing_lock_prevents_download_and_is_preserved(self):
        lock = self.cache / ".install-lock"
        lock.mkdir(parents=True)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("正在准备", result.stderr)
        self.assertEqual(self.calls(), "")
        self.assertTrue(lock.is_dir())

    def test_explicit_tool_overrides_skip_bootstrap_download(self):
        result = self.run_installer(ASKGPT_UV=str(self.uv), ASKGPT_PYTHON=str(self.python))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("curl:", self.calls())
        self.assertNotIn("uv:python install", self.calls())
        self.assertIn("--python " + str(self.python), self.calls())
        self.assertIn("--only-binary :all:", self.calls())

    def test_failed_install_releases_lock_and_can_be_retried(self):
        result = self.run_installer(INSTALL_TEST_FAIL_PIP="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("重新运行", result.stderr)
        self.assertFalse((self.cache / ".install-lock").exists())
        self.log.unlink()
        retry = self.run_installer()
        self.assertEqual(retry.returncode, 0, retry.stdout + retry.stderr)
        self.assertNotIn("curl:", self.calls())


if __name__ == "__main__":
    unittest.main()
