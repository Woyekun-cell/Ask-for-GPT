import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import subprocess

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try:
    common = importlib.import_module("layout_common")
except ModuleNotFoundError:
    common = None


class TranslationContractTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(common, "PDF layout translation contract is not implemented")

    def test_long_paragraph_is_bounded_without_losing_source(self):
        text = ("A sentence about cells and proteins. " * 170) + "尾句。"
        chunks = common.split_text(text, 1800)
        self.assertEqual("".join(chunks), text)
        self.assertTrue(all(0 < len(chunk) <= 1800 for chunk in chunks))

    def test_formula_placeholders_never_enter_native_translator(self):
        seen = []
        def translate(text):
            seen.append(text)
            return "译文"
        output = common.translate_protected("The value {v1} increases with {v2}.", translate)
        self.assertEqual(common.placeholders(output), ["{v1}", "{v2}"])
        self.assertTrue(all("{v" not in item for item in seen))

    def test_helper_cannot_introduce_formula_placeholder(self):
        with self.assertRaises(common.ProtocolFailure):
            common.translate_protected("A protein is expressed.", lambda text: "译文 {v9}")

    def test_pages_are_sorted_unique_and_zero_based(self):
        self.assertEqual(common.parse_pages("3,1,3-4", 4), [0, 2, 3])
        self.assertEqual(common.parse_pages("all", 3), [0, 1, 2])

    def test_bad_pages_fail_without_silent_clamping(self):
        for value in ["0", "4", "2-1", "-1", "../../a", "all,2", "", "1.0"]:
            with self.subTest(value=value), self.assertRaises(common.ProtocolFailure):
                common.parse_pages(value, 3)

    def test_private_config_rejects_symlink_and_world_readable(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / "connection.json"
            common.atomic_json(config, {"token": "a" * 64, "version": 1,
                "endpoint": "http://127.0.0.1:43792"})
            self.assertEqual(common.load_token(config), "a" * 64)
            link = Path(folder) / "link.json"
            link.symlink_to(config)
            with self.assertRaises(common.ProtocolFailure): common.load_token(link)
            if common.platform.IS_WINDOWS:
                subprocess.run(['icacls.exe', str(config), '/grant', '*S-1-1-0:(R)'], check=True, capture_output=True)
            else: config.chmod(0o644)
            with self.assertRaises(common.ProtocolFailure): common.load_token(config)

    @unittest.skipUnless(os.name == 'nt', 'Windows reparse directory validation')
    def test_private_config_rejects_junction_parent_without_reading_the_token(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = common.private_directory(Path(folder) / 'private')
            config = directory / 'connection.json'
            common.atomic_json(config, {'token':'a' * 64, 'version':1, 'endpoint':'http://127.0.0.1:43792'})
            junction = Path(folder) / 'junction'
            subprocess.run(['cmd.exe', '/c', 'mklink', '/J', str(junction), str(directory)], check=True, capture_output=True)
            try:
                with self.assertRaises(common.ProtocolFailure): common.load_token(junction / 'connection.json')
            finally: junction.rmdir()

    def test_offline_guard_blocks_socket_connect_and_dns(self):
        import subprocess
        command = [sys.executable, "-c", "import sys,socket; sys.path.insert(0,sys.argv[1]); "
            "from layout_common import install_offline_guard; install_offline_guard(); "
            "s=socket.socket(); "
            "\ntry: s.connect(('127.0.0.1',9))\nexcept PermissionError: print('blocked')\n"
            "try: socket.getaddrinfo('example.com',443)\nexcept PermissionError: print('dns-blocked')",
            str(Path(__file__).resolve().parents[1])]
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip().splitlines(), ["blocked", "dns-blocked"])

    def test_extension_origin_is_derived_only_from_private_paired_configuration(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "connection.json"
            value = {"token": "a" * 64, "version": 1, "endpoint": "http://127.0.0.1:43792",
                     "extensionID": "ofcbkomnacejiphoifjmkmkpjcjddmfj"}
            common.atomic_json(path, value)
            self.assertEqual(common.load_connection(path),
                ("a" * 64, "chrome-extension://ofcbkomnacejiphoifjmkmkpjcjddmfj"))
            for invalid in ["*", "https://example.com", "a" * 31, "q" * 32, None]:
                value["extensionID"] = invalid
                common.atomic_json(path, value)
                with self.assertRaises(common.ProtocolFailure): common.load_connection(path)


if __name__ == "__main__": unittest.main()
