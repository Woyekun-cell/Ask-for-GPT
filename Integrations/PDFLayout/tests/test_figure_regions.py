import hashlib
import http.client
import importlib
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try:
    figures = importlib.import_module('figure_regions')
except ModuleNotFoundError:
    figures = None
from layout_common import ProtocolFailure


def png(width=16, height=8):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress((b'\0' + b'\xff\xff\xff' * width) * height)) + chunk(b'IEND', b''))


class FigureRegionTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(figures, 'local figure service is missing')
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)

    def tearDown(self):
        if hasattr(self, 'folder'): self.folder.cleanup()

    def worker(self, source):
        path = self.root / 'fake-figure.py'
        path.write_text(source)
        return path

    def test_png_bounds_are_checked_before_decoding_or_model_loading(self):
        self.assertEqual(figures.png_size(png()), (16, 8))
        for raw, code in [(b'not png', 'figure_input'), (png(1025, 1), 'figure_limit'),
                          (png() + b'x' * (4 * 1024 * 1024), 'figure_limit')]:
            with self.subTest(code=code), self.assertRaisesRegex(ProtocolFailure, code): figures.png_size(raw)

    def test_only_figure_and_fixed_exclusion_classes_return_normalized_clamped_numbers(self):
        names={0:'title',1:'plain text',2:'abandon',3:'figure',4:'figure_caption',5:'table'}
        boxes=[SimpleNamespace(xyxy=[-2, 5, 120, 45], conf=.9, cls=3),
               SimpleNamespace(xyxy=[5, 45, 80, 49], conf=.8, cls=4),
               SimpleNamespace(xyxy=[5, 1, 80, 4], conf=.8, cls=2),
               SimpleNamespace(xyxy=[5, 5, 80, 9], conf=.8, cls=0),
               SimpleNamespace(xyxy=[5, 12, 80, 19], conf=.8, cls=1),
               SimpleNamespace(xyxy=[5, 20, 80, 29], conf=.8, cls=5)]
        result=figures.normalized_regions(SimpleNamespace(names=names,boxes=boxes), 100, 50)
        self.assertEqual(result['figures'],[{'rect':[0, .1, 1, .9], 'confidence':.9}])
        self.assertEqual([box['kind'] for box in result['exclusions']],['caption','header','text','text'])
        self.assertEqual(set(result),{'figures','exclusions'})
        for bad in [float('nan'),float('inf')]:
            boxes[0].xyxy[0]=bad
            with self.assertRaisesRegex(ProtocolFailure,'figure_failed'): figures.normalized_regions(SimpleNamespace(names=names,boxes=boxes),100,50)

    def test_result_parser_rejects_private_or_malformed_child_fields(self):
        valid={'figures':[{'rect':[0,0,.5,.5],'confidence':.8}],'exclusions':[]}
        self.assertEqual(figures.validate_result(valid),valid)
        for value in [{**valid,'path':'PRIVATE'}, {**valid,'figures':[{'rect':[0,0,1,1],'confidence':2}]},
                      {**valid,'exclusions':[{'rect':[0,0,1,1],'confidence':.9,'kind':'PRIVATE'}]},
                      {**valid,'figures':valid['figures']*65}]:
            with self.assertRaisesRegex(ProtocolFailure,'figure_failed'): figures.validate_result(value)

    def test_cached_model_is_verified_without_any_download_fallback(self):
        with self.assertRaisesRegex(ProtocolFailure,'figure_unavailable'): figures.model_asset(self.root)
        path=self.root/'engine-home/.cache/babeldoc/models'/figures.MODEL_NAME
        path.parent.mkdir(parents=True);path.write_bytes(b'fake pinned model')
        with patch.object(figures,'MODEL_BYTES',path.stat().st_size), patch.object(figures,'MODEL_SHA256',hashlib.sha256(path.read_bytes()).hexdigest()):
            self.assertEqual(figures.model_asset(self.root),path)
            path.write_bytes(b'x'*path.stat().st_size)
            with self.assertRaisesRegex(ProtocolFailure,'figure_unavailable'): figures.model_asset(self.root)

    def test_short_child_returns_only_bounded_json_and_leaves_no_image_or_job_files(self):
        path=self.worker("import sys,json\nraw=sys.stdin.buffer.read()\nprint(json.dumps({'figures':[], 'exclusions':[]}))\n")
        service=figures.FigureRegionService(self.root,worker_script=path)
        before=set(self.root.iterdir())
        self.assertEqual(service.detect(png()),{'figures':[],'exclusions':[]})
        self.assertEqual(set(self.root.iterdir()),before)
        self.assertIsNone(service._process)
        service.shutdown()

    def test_missing_assets_fail_in_the_real_child_before_creating_asset_directories(self):
        service=figures.FigureRegionService(self.root)
        with self.assertRaisesRegex(ProtocolFailure,'figure_unavailable'): service.detect(png())
        self.assertFalse((self.root/'engine-home').exists())
        self.assertIsNone(service._process)
        service.shutdown()

    def test_shutdown_reaps_a_running_child_and_invalid_stdout_is_not_forwarded(self):
        path=self.worker("import sys,time\nsys.stdin.buffer.read()\ntime.sleep(10)\n")
        service=figures.FigureRegionService(self.root,worker_script=path)
        errors=[]
        def run():
            try:service.detect(png())
            except ProtocolFailure as error:errors.append(str(error))
        thread=threading.Thread(target=run);thread.start()
        for _ in range(100):
            if service._process is not None:break
            time.sleep(.005)
        pid=service._process.pid;service.shutdown();thread.join(2)
        self.assertFalse(thread.is_alive());self.assertIsNone(service._process)
        with self.assertRaises(ProcessLookupError):os.kill(pid,0)
        self.assertTrue(errors)
        for output in ["print('PRIVATE_TEXT_TOKEN_PATH')", "print('x'*70000)", "print('{\"error\":\"PRIVATE_TEXT_TOKEN_PATH\"}')"]:
            path=self.worker('import sys\nsys.stdin.buffer.read()\n'+output+'\n')
            service=figures.FigureRegionService(self.root,worker_script=path)
            with self.assertRaisesRegex(ProtocolFailure,'figure_failed'):service.detect(png())
            service.shutdown()

    def test_package_includes_only_the_new_reviewed_helper_without_documents(self):
        import subprocess
        destination=self.root/'package'
        subprocess.run([sys.executable,str(Path(__file__).resolve().parents[3]/'scripts/package-pdf-layout'),str(destination)],check=True,capture_output=True)
        manifest=json.loads((destination/'package-manifest.json').read_text())
        self.assertIn('figure_regions.py',manifest['files'])
        self.assertFalse(manifest['containsDocuments']);self.assertFalse(manifest['containsCredentials'])
        self.assertEqual(manifest['files']['figure_regions.py'],hashlib.sha256((destination/'figure_regions.py').read_bytes()).hexdigest())

    def test_busy_timeout_failure_and_shutdown_release_the_single_owned_process(self):
        path=self.worker("import sys,time\nsys.stdin.buffer.read()\ntime.sleep(10)\n")
        service=figures.FigureRegionService(self.root,worker_script=path,timeout=.15)
        errors=[]
        def run():
            try: service.detect(png())
            except ProtocolFailure as error: errors.append(str(error))
        thread=threading.Thread(target=run);thread.start()
        for _ in range(100):
            if service._process is not None:break
            time.sleep(.005)
        pid=service._process.pid
        with self.assertRaisesRegex(ProtocolFailure,'figure_busy'): service.detect(png())
        thread.join(2);self.assertEqual(errors,['figure_timeout']);self.assertIsNone(service._process)
        with self.assertRaises(ProcessLookupError):os.kill(pid,0)
        service.shutdown()
        with self.assertRaisesRegex(ProtocolFailure,'figure_unavailable'): service.detect(png())


class FigureHTTPTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(figures,'local figure service is missing')
        import server
        self.folder=tempfile.TemporaryDirectory();self.manager=server.JobManager(Path(self.folder.name)/'cache',Path(sys.executable),ready_override=True)
        self.service=server.create_server(self.manager,'a'*64,port=0)
        self.thread=threading.Thread(target=self.service.serve_forever,daemon=True);self.thread.start()

    def tearDown(self):
        if not hasattr(self,'service'):return
        self.manager.shutdown();self.service.shutdown();self.service.server_close();self.thread.join(2);self.folder.cleanup()

    def request(self,body,headers=None):
        port=self.service.server_address[1];client=http.client.HTTPConnection('127.0.0.1',port,timeout=3)
        values={'Host':f'127.0.0.1:{port}','Authorization':'Bearer '+'a'*64,'Content-Type':'image/png'};values.update(headers or {})
        client.request('POST','/v1/pdf/figure-regions',body,values);response=client.getresponse();raw=response.read();client.close();return response.status,json.loads(raw)

    def test_figure_route_is_authenticated_bounded_and_independent_of_translation_jobs(self):
        value={'figures':[],'exclusions':[]}
        with patch.object(self.manager.figure_regions,'detect',return_value=value) as detect:
            self.assertEqual(self.request(png()),(200,value));detect.assert_called_once_with(png())
            self.assertEqual(self.request(png(),{'Authorization':'Bearer wrong'})[0],401)
            self.assertEqual(self.request(png(),{'Origin':'https://example.com'})[0],403)
            self.assertEqual(self.request(png(),{'Content-Type':'application/pdf'}),(400,{'error':'figure_input'}))
            self.assertEqual(self.request(b'',{'Content-Length':str(4*1024*1024+1)}),(413,{'error':'figure_limit'}))
        self.assertEqual(self.manager.jobs,{})
        self.assertEqual(list(self.manager.jobs_root.iterdir()),[])

    def test_public_errors_never_expose_internal_details(self):
        for code,status in [('figure_busy',429),('figure_unavailable',503),('figure_timeout',504),('figure_failed',502)]:
            with patch.object(self.manager.figure_regions,'detect',side_effect=ProtocolFailure(code)):
                self.assertEqual(self.request(png()),(status,{'error':code}))
        with patch.object(self.manager.figure_regions,'detect',side_effect=RuntimeError('PRIVATE_TEXT_TOKEN_PATH')):
            self.assertEqual(self.request(png()),(502,{'error':'figure_failed'}))


if __name__=='__main__':unittest.main()
