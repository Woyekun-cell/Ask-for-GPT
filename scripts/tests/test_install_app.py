import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError


SCRIPT = Path(__file__).resolve().parents[1] / 'install-app'
loader = importlib.machinery.SourceFileLoader('install_app', str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
install_app = importlib.util.module_from_spec(spec)
loader.exec_module(install_app)


class Clock:
    def __init__(self):
        self.now = 0

    def monotonic(self):
        return self.now

    def sleep(self, delay):
        self.now += delay


class Response:
    def __init__(self, value=None):
        self.value = value or {'status': 'ready', 'protocolVersion': 1}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self, limit):
        return json.dumps(self.value).encode()


class InstallStartupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.app = self.directory / 'Ask for GPT.app'
        self.connection = self.directory / 'inline-connection.json'
        self.token = 'test_token_' + 'a' * 48
        self.connection.write_text(json.dumps({'version': 1, 'endpoint': 'http://127.0.0.1:43792', 'token': self.token}))
        self.connection.chmod(0o600)
        self.clock = Clock()
        self.requests = []
        self.responses = []

    def tearDown(self):
        self.temporary.cleanup()

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        value = self.responses.pop(0) if self.responses else Response()
        if isinstance(value, BaseException):
            raise value
        return value

    def start(self, timeout=3):
        self.assertTrue(callable(getattr(install_app, 'start_installed_app', None)),
                        'install must start the replacement and wait for authenticated PDF readiness')
        with patch.object(install_app.subprocess, 'run') as launch, \
             patch.object(install_app.request, 'build_opener', return_value=self) as build_opener, \
             patch.object(install_app.time, 'monotonic', self.clock.monotonic), \
             patch.object(install_app.time, 'sleep', self.clock.sleep):
            result = install_app.start_installed_app(self.app, self.connection, timeout=timeout)
            self.assertEqual(build_opener.call_args.args[0].proxies, {})
            self.assertIsInstance(build_opener.call_args.args[1], install_app.NoRedirect)
            return result, launch

    def test_launches_background_and_waits_for_both_authenticated_services(self):
        self.responses = [URLError('not yet listening'), Response(), Response()]
        _, launch = self.start()
        launch.assert_called_once_with(['/usr/bin/open', '-g', str(self.app), '--args', '--background'],
                                       check=True, stdout=install_app.subprocess.DEVNULL,
                                       stderr=install_app.subprocess.DEVNULL, timeout=10)
        self.assertGreater(self.clock.now, 0)
        self.assertEqual([r.full_url for r, _ in self.requests[-2:]], [
            'http://127.0.0.1:43792/v1/inline/health', 'http://127.0.0.1:43795/v1/pdf/health'])
        for value, limit in self.requests:
            self.assertEqual(value.get_header('Authorization'), 'Bearer ' + self.token)
            self.assertGreater(limit, 0)
            self.assertLessEqual(limit, 1)

    def test_unreachable_service_is_bounded_and_reports_installed_package(self):
        self.responses = [URLError('refused')] * 20
        with self.assertRaisesRegex(RuntimeError, 'installed.*PDF.*ready') as failure:
            self.start(timeout=2)
        self.assertGreaterEqual(self.clock.now, 2)
        self.assertLessEqual(self.clock.now, 2.5)
        self.assertNotIn(self.token, str(failure.exception))

    def test_no_proxy_or_redirect_handler(self):
        self.assertTrue(hasattr(install_app, 'NoRedirect'), 'loopback health must not follow redirects')
        self.assertIsNone(install_app.NoRedirect().redirect_request(None, None, 302, 'redirect', {}, 'https://example.com'))
        self.start()

    def test_unsafe_connection_modes_symlinks_and_hardlinks_are_rejected(self):
        for mutation in ('mode', 'symlink', 'hardlink', 'oversize'):
            with self.subTest(mutation=mutation):
                self.connection.unlink(missing_ok=True)
                self.connection.write_text(json.dumps({'version': 1, 'endpoint': 'http://127.0.0.1:43792', 'token': self.token}))
                self.connection.chmod(0o600)
                if mutation == 'mode':
                    self.connection.chmod(0o644)
                elif mutation == 'symlink':
                    target = self.directory / 'target.json'
                    self.connection.rename(target)
                    self.connection.symlink_to(target)
                elif mutation == 'hardlink':
                    os.link(self.connection, self.directory / 'linked.json')
                else:
                    self.connection.write_bytes(b' ' * 8193)
                with self.assertRaisesRegex(RuntimeError, 'connection'):
                    self.start()
                self.assertEqual(self.requests, [])

    def test_invalid_endpoint_or_token_never_gets_requested(self):
        for change in ({'endpoint': 'https://example.com'}, {'token': 'short'}, {'version': True}):
            with self.subTest(change=change):
                self.connection.write_text(json.dumps({'version': 1, 'endpoint': 'http://127.0.0.1:43792', 'token': self.token, **change}))
                with self.assertRaisesRegex(RuntimeError, 'connection'):
                    self.start()
                self.assertEqual(self.requests, [])

    def test_unauthorized_and_runtime_missing_do_not_poll_until_timeout(self):
        for value, message in ((HTTPError('http://127.0.0.1:43792', 302, 'redirect', {}, None), 'connection'),
                               (HTTPError('http://127.0.0.1:43792', 401, 'unauthorized', {}, None), 'connection'),
                               (HTTPError('http://127.0.0.1:43792', 403, 'forbidden', {}, None), 'connection'),
                               (Response({'status': 'runtime_missing', 'protocolVersion': 1}), 'component')):
            with self.subTest(message=message):
                self.responses = [value]
                self.requests = []
                with self.assertRaisesRegex(RuntimeError, message):
                    self.start()
                self.assertEqual(len(self.requests), 1)
                self.assertEqual(self.clock.now, 0)

    def test_wrong_owner_is_rejected(self):
        with patch.object(install_app.os, 'getuid', return_value=os.getuid() + 1):
            with self.assertRaisesRegex(RuntimeError, 'connection'):
                self.start()
        self.assertEqual(self.requests, [])

    def test_launch_failure_reports_installed_package_without_health_requests(self):
        self.assertTrue(callable(getattr(install_app, 'start_installed_app', None)))
        with patch.object(install_app.subprocess, 'run', side_effect=OSError('cannot launch')):
            with self.assertRaisesRegex(RuntimeError, 'installed.*startup failed'):
                install_app.start_installed_app(self.app, self.connection)
        self.assertEqual(self.requests, [])


if __name__ == '__main__':
    unittest.main()
