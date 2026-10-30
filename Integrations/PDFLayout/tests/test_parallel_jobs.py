"""Independent local PDF jobs use real processes; no model or network request."""
import http.client
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class ParallelJobTests(unittest.TestCase):
    def setUp(self):
        import pymupdf
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.worker = self.root / "controlled-worker.py"
        self.worker.write_text("import argparse,pathlib,json,time,shutil,os\n"
            "p=argparse.ArgumentParser();p.add_argument('--job-dir');p.add_argument('--cache-root');p.add_argument('--translator');a=p.parse_args()\n"
            "d=pathlib.Path(a.job_dir)\n"
            "(d/'started.tmp').write_text(json.dumps({'pid':os.getpid(),'time':time.monotonic()}))\n"
            "(d/'started.tmp').replace(d/'started.json')\n"
            "while not (d/'release').exists(): time.sleep(.01)\n"
            "for k in ['mono','dual']: shutil.copyfile(d/'input.pdf',d/(k+'.pdf'))\n"
            "(d/'result.json').write_text(json.dumps({'state':'complete'}))\n")
        self.manager = server.JobManager(self.root / "cache", Path(sys.executable),
            worker_script=self.worker, ready_override=True)
        with pymupdf.open() as document:
            document.new_page().insert_text((30, 50), "First paper")
            self.pdf_a = document.tobytes()
        with pymupdf.open() as document:
            document.new_page().insert_text((30, 50), "Second paper")
            self.pdf_b = document.tobytes()

    def tearDown(self):
        self.manager.shutdown()
        self.temp.cleanup()

    def submit(self, pdf, pages="all", source="en", target="zh-Hans"):
        placeholder = self.manager.begin()
        path = placeholder.directory / "input.pdf"
        path.write_bytes(pdf)
        path.chmod(0o600)
        result = self.manager.submit(placeholder, pages, source, target)
        return placeholder, self.manager.get(result["id"])

    def wait_until(self, predicate, message):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            if predicate(): return
            time.sleep(.01)
        self.fail(message)

    def started(self, job):
        self.wait_until(lambda: (job.directory / "started.json").exists(), "worker did not start")
        return json.loads((job.directory / "started.json").read_text())

    def release(self, job):
        (job.directory / "release").touch()
        self.wait_until(lambda: job.state != "running", "worker did not finish")

    def test_two_real_workers_overlap_and_preserve_individual_progress_and_output(self):
        _, first = self.submit(self.pdf_a)
        first_start = self.started(first)
        _, second = self.submit(self.pdf_b)
        second_start = self.started(second)
        self.assertNotEqual(first.id, second.id)
        self.assertNotEqual(first_start["pid"], second_start["pid"])
        self.assertIsNone(first.process.poll(), "second paper waited for first to finish")
        self.assertIsNone(second.process.poll())
        for job, completed in [(first, 0), (second, 1)]:
            (job.directory / "progress.json").write_text(json.dumps({
                "stage": "translating", "completed": completed, "total": 1}))
            (job.directory / "progress.json").chmod(0o600)
        self.assertEqual(first.public()["progress"]["completed"], 0)
        self.assertEqual(second.public()["progress"]["completed"], 1)
        self.release(second)
        self.assertEqual(second.state, "complete")
        self.assertEqual(first.state, "running")
        self.release(first)
        self.assertEqual(first.state, "complete")
        self.assertEqual((first.directory / "mono.pdf").read_bytes(), self.pdf_a)
        self.assertEqual((second.directory / "mono.pdf").read_bytes(), self.pdf_b)

    def test_cancelling_one_process_does_not_interrupt_other_or_its_files(self):
        _, first = self.submit(self.pdf_a)
        _, second = self.submit(self.pdf_b)
        self.started(first)
        self.started(second)
        self.manager.cancel(first)
        self.assertEqual(first.state, "cancelled")
        self.assertIsNotNone(first.process.poll())
        self.assertEqual(second.state, "running")
        self.assertIsNone(second.process.poll())
        self.assertEqual((second.directory / "input.pdf").read_bytes(), self.pdf_b)
        self.release(second)
        self.assertEqual(second.state, "complete")

    def test_same_content_inflight_refusal_cannot_cancel_the_original_job(self):
        _, first = self.submit(self.pdf_a, pages="1")
        self.started(first)
        placeholder=self.manager.begin()
        (placeholder.directory/'input.pdf').write_bytes(self.pdf_a)
        (placeholder.directory/'input.pdf').chmod(0o600)
        with self.assertRaisesRegex(server.ProtocolFailure,'job_conflict'):
            self.manager.submit(placeholder,'1-1','en','zh-Hans')
        self.manager.abandon(placeholder)
        self.assertIsNone(placeholder.process)
        self.assertEqual(placeholder.state,'failed')
        self.assertEqual(first.state,'running')
        self.assertIsNone(first.process.poll())
        self.release(first)
        self.assertEqual(first.state,'complete')

    def test_direction_is_part_of_running_task_identity_and_cancelled_task_can_restart(self):
        _, first = self.submit(self.pdf_a)
        _, reverse = self.submit(self.pdf_a, source="zh-Hans", target="en")
        self.assertNotEqual(first.id, reverse.id)
        self.started(first)
        self.started(reverse)
        self.manager.cancel(first)
        _, replacement = self.submit(self.pdf_a)
        self.assertNotEqual(first.id, replacement.id)
        self.started(replacement)
        self.release(replacement)
        self.release(reverse)

    def test_pruning_retains_all_running_tasks_even_when_expired_or_over_cache_limit(self):
        _, first = self.submit(self.pdf_a)
        _, second = self.submit(self.pdf_b)
        self.started(first)
        self.started(second)
        expired = time.time() - server.MAX_JOB_AGE - 1
        for job in [first, second]: os.utime(job.directory, (expired, expired))
        old_limit = server.MAX_CACHE_BYTES
        server.MAX_CACHE_BYTES = 0
        try: self.manager.prune()
        finally: server.MAX_CACHE_BYTES = old_limit
        for job in [first, second]:
            self.assertTrue((job.directory / "input.pdf").exists())
            self.assertIsNone(job.process.poll())
        self.release(first)
        self.release(second)

    def test_simultaneous_duplicate_submission_starts_one_worker_and_rejects_other(self):
        placeholders = [self.manager.begin(), self.manager.begin()]
        for job in placeholders:
            (job.directory / "input.pdf").write_bytes(self.pdf_a)
            (job.directory / "input.pdf").chmod(0o600)
        barrier=threading.Barrier(2);results=[];failures=[]
        def submit(job):
            try:barrier.wait(timeout=2);results.append(self.manager.submit(job,"all","en","zh-Hans"))
            except Exception as error:failures.append(error)
        threads=[threading.Thread(target=submit,args=(job,)) for job in placeholders]
        for thread in threads:thread.start()
        for thread in threads:thread.join(4)
        self.assertEqual(len(results),1);self.assertEqual([str(error) for error in failures],['job_conflict'])
        first=self.manager.get(results[0]['id']);self.started(first)
        self.assertEqual(sum(job.process is not None for job in placeholders),1)
        self.assertIsNone(first.process.poll());self.release(first)

    def test_two_worker_limit_preserves_original_tasks_and_completed_cache_still_reuses(self):
        _, first = self.submit(self.pdf_a)
        _, second = self.submit(self.pdf_b)
        self.started(first)
        self.started(second)
        with self.assertRaisesRegex(server.ProtocolFailure, "job_conflict"):
            self.submit(self.pdf_a)
        with self.assertRaisesRegex(server.ProtocolFailure, "job_conflict"):
            self.submit(self.pdf_a + b"\n% third paper")
        self.assertEqual(len(self.manager.active), 2)
        for job in [first, second]: self.assertIsNone(job.process.poll())
        self.release(first)
        placeholder, cached = self.submit(self.pdf_a)
        self.assertIs(cached, first)
        self.assertFalse(placeholder.directory.exists())
        self.manager.abandon(placeholder)
        self.assertEqual(first.state, "complete")
        self.assertIsNone(second.process.poll())
        _, third = self.submit(self.pdf_a + b"\n% third paper")
        self.started(third)
        self.release(third)
        self.release(second)

    def test_http_duplicate_refusal_has_no_shared_id_and_preserves_existing_worker(self):
        _,first=self.submit(self.pdf_a);self.started(first)
        service=server.create_server(self.manager,'a'*64,port=0)
        thread=threading.Thread(target=service.serve_forever,daemon=True);thread.start()
        connection=http.client.HTTPConnection('127.0.0.1',service.server_address[1],timeout=3)
        try:
            connection.request('POST','/v1/pdf/jobs',self.pdf_a,{'Authorization':'Bearer '+'a'*64,
                'Content-Type':'application/pdf','X-AskGPT-Source':'en','X-AskGPT-Target':'zh-Hans'})
            reply=connection.getresponse();self.assertEqual(reply.status,409)
            self.assertEqual(json.loads(reply.read()),{'error':'job_conflict'})
            self.assertEqual(first.state,'running');self.assertIsNone(first.process.poll())
            self.assertEqual(self.manager.active,{first.id})
            self.assertEqual((first.directory/'input.pdf').read_bytes(),self.pdf_a)
            self.release(first)
        finally:
            connection.close();service.shutdown();service.server_close();thread.join(2)

    def test_a_partial_upload_does_not_block_a_second_http_submission(self):
        service = server.create_server(self.manager, "a" * 64, port=0)
        thread = threading.Thread(target=service.serve_forever, daemon=True)
        thread.start()
        port = service.server_address[1]
        first = socket.create_connection(("127.0.0.1", port), timeout=3)
        second = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
        try:
            headers = (f"POST /v1/pdf/jobs HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
                "Authorization: Bearer " + "a" * 64 + "\r\nContent-Type: application/pdf\r\n"
                "X-AskGPT-Source: en\r\nX-AskGPT-Target: zh-Hans\r\n"
                f"Content-Length: {len(self.pdf_a)}\r\n\r\n")
            first.sendall(headers.encode() + self.pdf_a[:5])
            self.wait_until(lambda: len(self.manager.active) == 1, "first upload did not reserve its task")
            second.request("POST", "/v1/pdf/jobs", self.pdf_b, {
                "Host": f"127.0.0.1:{port}", "Authorization": "Bearer " + "a" * 64,
                "Content-Type": "application/pdf", "X-AskGPT-Source": "en", "X-AskGPT-Target": "zh-Hans"})
            response = second.getresponse()
            second_result = json.loads(response.read())
            self.assertEqual(response.status, 202, "second upload was rejected while first was still streaming")
            self.assertEqual(len(self.manager.active), 2)
            first.sendall(self.pdf_a[5:])
            raw = http.client.HTTPResponse(first)
            raw.begin()
            first_result = json.loads(raw.read())
            self.assertEqual(raw.status, 202)
            self.assertNotEqual(first_result["id"], second_result["id"])
            for result in [first_result, second_result]:
                job = self.manager.get(result["id"])
                self.started(job)
                self.release(job)
        finally:
            first.close()
            second.close()
            service.shutdown()
            service.server_close()
            thread.join(2)

    def test_shutdown_during_upload_cannot_launch_a_late_worker_or_change_cancelled_state(self):
        placeholder = self.manager.begin()
        (placeholder.directory / "input.pdf").write_bytes(self.pdf_a)
        (placeholder.directory / "input.pdf").chmod(0o600)
        self.manager.shutdown()
        self.assertEqual(placeholder.state, "cancelled")
        with self.assertRaises(server.ProtocolFailure):
            self.manager.submit(placeholder, "all", "en", "zh-Hans")
        self.manager.abandon(placeholder)
        self.assertEqual(placeholder.state, "cancelled")
        self.assertIsNone(placeholder.process)
        self.assertFalse(self.manager.active)

