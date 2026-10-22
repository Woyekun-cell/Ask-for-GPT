import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('windows_package', Path(__file__).resolve().parents[1] / 'package.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)

class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'bundle 中文'
        self.root.mkdir()
        for name in package.REQUIRED:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('fixture', encoding='utf-8')

    def test_roundtrip_and_changed_binary_rejected(self):
        package.manifest(self.root)
        self.assertEqual(package.check(self.root)['status'], 'PASS')
        (self.root / 'AskGPT.Windows.exe').write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'hash differs'):
            package.check(self.root)

    def test_private_config_rejected(self):
        (self.root / 'auth.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'Private/generated'):
            package.manifest(self.root)

    def test_unknown_extra_rejected(self):
        package.manifest(self.root)
        (self.root / 'unexpected.txt').write_text('extra')
        with self.assertRaisesRegex(ValueError, 'member set'):
            package.check(self.root)

    def test_uninstall_only_deletes_manifest_files(self):
        destination = Path(self.temp.name) / 'uninstall.nsh'
        package.write_nsis_uninstall(self.root, destination)
        text = destination.read_text(encoding='utf-8')
        self.assertNotIn('RMDir /r', text)
        self.assertIn('AskGPT.Windows.exe', text)
        self.assertNotIn('APPDATA', text)

    def test_duplicate_path_rejected(self):
        value = package.manifest(self.root)
        value['files'].append(value['files'][0])
        (self.root / 'package-manifest.json').write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            package.check(self.root)

    def test_installed_check_accepts_only_generated_uninstaller_extra(self):
        package.manifest(self.root)
        (self.root / 'Uninstall.exe').write_bytes(b'MZ fixture')
        with self.assertRaisesRegex(ValueError, 'member set'):
            package.check(self.root)
        self.assertEqual(package.check(self.root, installed=True)['status'], 'PASS')
        (self.root / 'unrelated.txt').write_text('unrelated')
        with self.assertRaisesRegex(ValueError, 'member set'):
            package.check(self.root, installed=True)

if __name__ == '__main__':
    unittest.main()
