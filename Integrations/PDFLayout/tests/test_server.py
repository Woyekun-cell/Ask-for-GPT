import importlib
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try:
    server_module = importlib.import_module("server")
except ModuleNotFoundError:
    server_module = None


class ServiceContractTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(server_module, "PDF HTTP service is not implemented")
        import pymupdf
        self.folder = tempfile.TemporaryDirectory()
        root = Path(self.folder.name)
        self.worker = root / "fake-worker.py"
        self.worker.write_text("import argparse,pathlib,json,time,shutil\n"
            "p=argparse.ArgumentParser();p.add_argument('--job-dir');p.add_argument('--cache-root');p.add_argument('--translator');a=p.parse_args()\n"
            "d=pathlib.Path(a.job_dir);time.sleep(.3)\n"
            "shutil.copyfile(d/'input.pdf',d/'mono.pdf');shutil.copyfile(d/'input.pdf',d/'dual.pdf')\n"
            "(d/'result.json').write_text(json.dumps({'state':'complete'}))\n")
        self.manager = server_module.JobManager(root / "cache", Path(sys.executable),
            worker_script=self.worker, ready_override=True)
        self.origin = "chrome-extension://ofcbkomnacejiphoifjmkmkpjcjddmfj"
        self.service = server_module.create_server(self.manager, "a" * 64, port=0, extension_origin=self.origin)
        self.thread = threading.Thread(target=self.service.serve_forever, daemon=True)
        self.thread.start()
        doc = pymupdf.open()
        for _ in range(3): doc.new_page()
        self.pdf = doc.tobytes()
        doc.close()

    def tearDown(self):
        if server_module is None: return
        self.manager.shutdown()
        self.service.shutdown()
        self.service.server_close()
        self.thread.join(2)
        self.folder.cleanup()

    def request(self, method, path, body=None, headers=None):
        port = self.service.server_address[1]
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=4)
        values = {"Host": f"127.0.0.1:{port}", "Authorization": "Bearer " + "a" * 64}
        if headers: values.update(headers)
        connection.request(method, path, body=body, headers=values)
        response = connection.getresponse()
        result = (response.status, response.read(), dict(response.getheaders()))
        connection.close()
        return result

    def submit(self, pages="all"):
        status, body, _ = self.request("POST", "/v1/pdf/jobs", self.pdf,
            {"Content-Type": "application/pdf", "X-AskGPT-Pages": pages,
             "X-AskGPT-Source": "en", "X-AskGPT-Target": "zh-Hans"})
        return status, json.loads(body)

    def test_authentication_precedes_reading_upload_body(self):
        port = self.service.server_address[1]
        client = socket.create_connection(("127.0.0.1", port), timeout=2)
        client.sendall((f"POST /v1/pdf/jobs HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
            "Authorization: Bearer invalid\r\nContent-Length: 10000000\r\n\r\n").encode())
        response = client.recv(4096)
        client.close()
        self.assertIn(b"401", response.split(b"\r\n")[0])

    def test_host_origin_and_traversal_are_rejected(self):
        for headers in [{"Host": "localhost:43795"}, {"Origin": "http://example.com"}]:
            self.assertEqual(self.request("GET", "/v1/pdf/health", headers=headers)[0], 403)
        for path in ["/v1/pdf/jobs/../../secret/mono.pdf", "/v1/pdf/jobs/%2e%2e/mono.pdf"]:
            self.assertEqual(self.request("GET", path)[0], 404)

    def test_health_is_authenticated_and_private(self):
        status, raw, _ = self.request("GET", "/v1/pdf/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw), {"status": "ready", "protocolVersion": 1})
        self.assertNotIn(self.folder.name.encode(), raw)

    def test_paired_extension_cors_does_not_remove_authentication(self):
        status, _, headers = self.request("GET", "/v1/pdf/health", headers={"Origin": self.origin})
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), self.origin)
        self.assertNotIn("Access-Control-Allow-Credentials", headers)
        self.assertEqual(self.request("GET", "/v1/pdf/health",
            headers={"Origin": self.origin, "Authorization": "Bearer invalid"})[0], 401)
        self.assertEqual(self.request("GET", "/v1/pdf/health",
            headers={"Origin": "chrome-extension://" + "b" * 32})[0], 403)
        self.assertNotIn("Access-Control-Allow-Origin", self.request("GET", "/v1/pdf/health")[2])

    def test_preflight_is_exactly_paired_and_limited_to_pdf_protocol(self):
        allowed = {"Origin": self.origin, "Authorization": "", "Access-Control-Request-Method": "POST",
                   "Access-Control-Request-Headers": "authorization,content-type,x-askgpt-pages,x-askgpt-source,x-askgpt-target"}
        status, _, headers = self.request("OPTIONS", "/v1/pdf/jobs", headers=allowed)
        self.assertEqual(status, 204)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), self.origin)
        self.assertIn("DELETE", headers.get("Access-Control-Allow-Methods", ""))
        for patch in [{"Origin": "https://example.com"}, {"Access-Control-Request-Method": "PUT"},
                      {"Access-Control-Request-Headers": "authorization,x-arbitrary"},
                      {"Access-Control-Request-Headers": "content-type"}]:
            self.assertEqual(self.request("OPTIONS", "/v1/pdf/jobs", headers={**allowed, **patch})[0], 403)
        self.assertEqual(self.request("OPTIONS", "/v1/other", headers=allowed)[0], 404)

    def test_job_page_mapping_and_two_worker_limit(self):
        status, job = self.submit("3")
        self.assertEqual(status, 202)
        self.assertEqual(job["sourcePages"], [2])
        self.assertEqual(job["pageCount"], 3)
        self.assertEqual(self.submit()[0], 202)
        self.assertEqual(self.submit("1")[0], 409)
        self.assertNotIn(self.folder.name, json.dumps(job))
        self.assertEqual((self.manager.jobs_root / job["id"]).stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.manager.jobs_root / job["id"] / "input.pdf").stat().st_mode & 0o777, 0o600)

    def test_cancelled_job_never_serves_partial_pdf(self):
        _, job = self.submit()
        status, body, _ = self.request("DELETE", "/v1/pdf/jobs/" + job["id"])
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["state"], "cancelled")
        self.assertEqual(self.request("GET", f"/v1/pdf/jobs/{job['id']}/mono.pdf")[0], 409)
        self.assertFalse((self.manager.jobs_root / job["id"] / "input.pdf").exists())

    def test_invalid_pdf_and_out_of_range_pages_fail(self):
        self.assertEqual(self.submit("4")[0], 400)
        status, _, _ = self.request("POST", "/v1/pdf/jobs", b"not a pdf",
            {"Content-Type": "application/pdf", "X-AskGPT-Pages": "all",
             "X-AskGPT-Source": "en", "X-AskGPT-Target": "zh-Hans"})
        self.assertEqual(status, 400)

    def test_completed_job_downloads_are_pdf_and_do_not_expose_paths(self):
        _, job = self.submit()
        for _ in range(40):
            status, raw, _ = self.request("GET", "/v1/pdf/jobs/" + job["id"])
            if json.loads(raw)["state"] == "complete": break
            time.sleep(.05)
        self.assertEqual(json.loads(raw)["state"], "complete")
        self.assertFalse((self.manager.jobs_root / job["id"] / "input.pdf").exists())
        for kind in ["mono", "dual"]:
            status, body, headers = self.request("GET", f"/v1/pdf/jobs/{job['id']}/{kind}.pdf")
            self.assertEqual(status, 200)
            self.assertTrue(body.startswith(b"%PDF"))
            self.assertEqual(headers["Content-Type"], "application/pdf")

    def test_cached_http_submission_is_complete_and_disconnect_cannot_cancel_original(self):
        _, initial = self.submit("2")
        for _ in range(40):
            if self.manager.get(initial["id"]).state == "complete": break
            time.sleep(.05)
        original = self.manager.get(initial["id"])
        self.assertEqual(original.state, "complete")
        with patch.object(server_module.subprocess, "Popen", side_effect=AssertionError("cached upload spawned worker")):
            status, repeated = self.submit("2-2")
        self.assertEqual(status, 202)
        self.assertEqual(repeated, original.public())
        reply = self.service.RequestHandlerClass.reply
        def disconnected(handler, status, *args, **kwargs):
            if status == 202: raise BrokenPipeError("synthetic_cached_response_disconnect")
            return reply(handler, status, *args, **kwargs)
        self.service.RequestHandlerClass.reply = disconnected
        self.submit("2")
        self.assertEqual(original.state, "complete")
        self.assertEqual(len(self.manager.jobs), 1)
        self.assertFalse(self.manager.active)
        self.assertEqual(self.request("GET", f"/v1/pdf/jobs/{original.id}/mono.pdf")[0], 200)

    def test_prune_only_uuid_inactive_jobs_and_enforce_count_limit(self):
        sentinel = self.manager.jobs_root / "keep-user-directory"
        sentinel.mkdir()
        (sentinel / "do-not-delete.txt").write_text("original")
        identities = []
        for number in range(server_module.MAX_INACTIVE_JOBS + 2):
            identity = f"{number + 1:032x}"
            directory = self.manager.jobs_root / identity
            directory.mkdir(mode=0o700)
            (directory / "mono.pdf").write_bytes(self.pdf)
            identities.append(identity)
        self.manager.prune()
        remaining = [identity for identity in identities if (self.manager.jobs_root / identity).exists()]
        self.assertEqual(len(remaining), server_module.MAX_INACTIVE_JOBS)
        self.assertTrue((sentinel / "do-not-delete.txt").exists())

    def test_cancel_kills_descendants_even_when_parent_exits_on_term(self):
        self.worker.write_text("import argparse,pathlib,subprocess,sys,time\n"
            "p=argparse.ArgumentParser();p.add_argument('--job-dir');p.add_argument('--cache-root');p.add_argument('--translator');a=p.parse_args()\n"
            "c=subprocess.Popen([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)'])\n"
            "(pathlib.Path(a.job_dir)/'child.pid').write_text(str(c.pid));time.sleep(30)\n")
        _, job = self.submit()
        pid_file = self.manager.jobs_root / job["id"] / "child.pid"
        for _ in range(40):
            if pid_file.exists(): break
            time.sleep(.025)
        child = int(pid_file.read_text())
        time.sleep(.1)
        try:
            self.request("DELETE", "/v1/pdf/jobs/" + job["id"])
            for _ in range(30):
                state = subprocess.run(["/bin/ps", "-p", str(child), "-o", "stat="],
                    capture_output=True, text=True).stdout.strip()
                if not state or state.startswith("Z"): break
                time.sleep(.025)
            self.assertTrue(not state or state.startswith("Z"), "native helper descendant survived cancellation")
        finally:
            try: os.kill(child, 9)
            except ProcessLookupError: pass

    def test_completed_worker_cannot_leave_translation_descendants_running(self):
        self.worker.write_text("import argparse,pathlib,subprocess,sys,time,shutil,json\n"
            "p=argparse.ArgumentParser();p.add_argument('--job-dir');p.add_argument('--cache-root');p.add_argument('--translator');a=p.parse_args()\n"
            "d=pathlib.Path(a.job_dir)\n"
            "c=subprocess.Popen([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)'])\n"
            "(d/'child.pid').write_text(str(c.pid))\n"
            "shutil.copyfile(d/'input.pdf',d/'mono.pdf');shutil.copyfile(d/'input.pdf',d/'dual.pdf')\n"
            "(d/'result.json').write_text(json.dumps({'state':'complete'}))\n")
        _, job = self.submit()
        pid_file = self.manager.jobs_root / job["id"] / "child.pid"
        for _ in range(180):
            if pid_file.exists() and self.manager.get(job["id"]).state == "complete": break
            time.sleep(.025)
        child = int(pid_file.read_text())
        try:
            self.assertEqual(self.manager.get(job["id"]).state, "complete")
            for _ in range(30):
                state = subprocess.run(["/bin/ps", "-p", str(child), "-o", "stat="],
                    capture_output=True, text=True).stdout.strip()
                if not state or state.startswith("Z"): break
                time.sleep(.025)
            self.assertTrue(not state or state.startswith("Z"), "completed worker left native/GPT descendant running")
        finally:
            try: os.kill(child, 9)
            except ProcessLookupError: pass

    def test_disconnect_while_writing_202_cancels_started_process(self):
        original = self.service.RequestHandlerClass.reply
        def broken_reply(handler, status, *args, **kwargs):
            if status == 202: raise BrokenPipeError("synthetic_response_disconnect")
            return original(handler, status, *args, **kwargs)
        self.service.RequestHandlerClass.reply = broken_reply
        self.submit()
        jobs = list(self.manager.jobs.values())
        self.assertEqual(len(jobs), 1)
        job = jobs[0]
        self.assertIsNotNone(job.process)
        self.assertIsNotNone(job.process.poll(), "unowned worker survived failed 202 delivery")
        self.assertEqual(job.state, "cancelled")
        self.assertFalse(self.manager.active)

    def test_oversized_output_is_rejected_without_reading_it(self):
        job = self.manager.begin()
        job.state = "complete"
        with (job.directory / "mono.pdf").open("wb") as output:
            output.truncate(server_module.MAX_OUTPUT_BYTES + 1)
        status, raw, _ = self.request("GET", f"/v1/pdf/jobs/{job.id}/mono.pdf")
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(raw)["error"], "output_too_large")

    def test_age_prune_keeps_active_and_never_follows_symlink(self):
        job = self.manager.begin()
        (job.directory / "input.pdf").write_bytes(self.pdf)
        old = self.manager.jobs_root / ("d" * 32)
        server_module.private_directory(old)
        (old / "mono.pdf").write_bytes(self.pdf)
        outside = Path(self.folder.name) / "outside"
        outside.mkdir()
        (outside / "original.pdf").write_bytes(self.pdf)
        link = self.manager.jobs_root / ("e" * 32)
        link.symlink_to(outside, target_is_directory=True)
        expired = time.time() - server_module.MAX_JOB_AGE - 1
        os.utime(job.directory, (expired, expired))
        os.utime(old, (expired, expired))
        self.manager.prune()
        self.assertTrue(job.directory.exists())
        self.assertFalse(old.exists())
        self.assertTrue((outside / "original.pdf").exists())

    def test_size_prune_enforces_total_limit(self):
        previous = server_module.MAX_CACHE_BYTES
        server_module.MAX_CACHE_BYTES = len(self.pdf) + 1
        try:
            for number in range(3):
                path = self.manager.jobs_root / f"{number + 1:032x}"
                server_module.private_directory(path)
                (path / "mono.pdf").write_bytes(self.pdf)
            self.manager.prune()
            self.assertEqual(len(list(self.manager.jobs_root.iterdir())), 1)
        finally:
            server_module.MAX_CACHE_BYTES = previous


class CompletedResultCacheTests(unittest.TestCase):
    """A repeat PDF must reuse verified output without starting a worker."""
    def setUp(self):
        import pymupdf
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.worker = self.root / "cache-worker.py"
        self.worker.write_text("import argparse,pathlib,json,shutil,os\n"
            "p=argparse.ArgumentParser();p.add_argument('--job-dir');p.add_argument('--cache-root');p.add_argument('--translator');a=p.parse_args()\n"
            "d=pathlib.Path(a.job_dir)\n"
            "for k in ['mono','dual']:\n shutil.copyfile(d/'input.pdf',d/(k+'.pdf'));os.chmod(d/(k+'.pdf'),0o600)\n"
            "(d/'result.json').write_text(json.dumps({'state':'complete'}))\n")
        self.managers = []
        self.manager = self.new_manager()
        doc = pymupdf.open()
        for _ in range(3): doc.new_page()
        self.pdf = doc.tobytes()
        doc.close()

    def new_manager(self, **kwargs):
        manager = server_module.JobManager(self.root / "cache", Path(sys.executable),
            worker_script=self.worker, ready_override=True, **kwargs)
        self.managers.append(manager)
        return manager

    def tearDown(self):
        for manager in self.managers: manager.shutdown()
        self.folder.cleanup()

    def submit(self, manager=None, *, pages="all", source="en", target="zh-Hans", pdf=None):
        manager = manager or self.manager
        job = manager.begin()
        path = job.directory / "input.pdf"
        path.write_bytes(self.pdf if pdf is None else pdf)
        path.chmod(0o600)
        return job, manager.submit(job, pages, source, target)

    def completed(self, **kwargs):
        placeholder, public = self.submit(**kwargs)
        manager = kwargs.get("manager") or self.manager
        for _ in range(100):
            job = manager.get(public["id"])
            if job.state != "running": break
            time.sleep(.01)
        self.assertEqual(job.state, "complete")
        return job

    def test_same_pdf_and_canonical_page_range_reuse_complete_id_without_worker(self):
        original = self.completed(pages="1,2-3")
        with patch.object(server_module.subprocess, "Popen", side_effect=AssertionError("cache spawned worker")):
            placeholder, result = self.submit(pages="all")
        self.assertEqual(result["id"], original.id)
        self.assertEqual(result["state"], "complete")
        self.assertFalse(placeholder.directory.exists())
        self.assertNotIn(placeholder.id, self.manager.jobs)
        self.assertFalse(self.manager.active)
        self.assertFalse((original.directory / "input.pdf").exists())

    def test_completed_outputs_reload_after_service_restart(self):
        original = self.completed(pages="2")
        self.manager.shutdown()
        restarted = self.new_manager()
        self.assertEqual(restarted.get(original.id).state, "complete")
        with patch.object(server_module.subprocess, "Popen", side_effect=AssertionError("restart lost cache")):
            _, result = self.submit(manager=restarted, pages="2-2")
        self.assertEqual(result["id"], original.id)
        metadata = json.loads((original.directory / "cache.json").read_text())
        self.assertEqual((original.directory / "cache.json").stat().st_mode & 0o777, 0o600)
        self.assertNotIn("input.pdf", json.dumps(metadata))
        self.assertNotIn(self.folder.name, json.dumps(metadata))

    def test_cache_hit_only_hashes_new_source_not_both_verified_output_files(self):
        original = self.completed()
        digest = server_module.hashlib.file_digest
        with patch.object(server_module.hashlib, "file_digest", wraps=digest) as calls:
            _, result = self.submit()
        self.assertEqual(result["id"], original.id)
        self.assertEqual(calls.call_count, 1)

    def test_completed_result_never_expires_and_reopens_after_service_restart(self):
        original = self.completed()
        expired = time.time() - server_module.MAX_JOB_AGE - 1
        os.utime(original.directory, (expired, expired))
        self.manager.prune()
        self.assertTrue(original.directory.exists())
        self.assertIn(original.cache_info["cacheKey"], self.manager.completed)
        self.manager.shutdown()
        restarted = self.new_manager()
        self.assertIn(original.id, restarted.jobs)
        with patch.object(server_module.subprocess, "Popen", side_effect=AssertionError("expired completed cache spawned worker")):
            self.assertEqual(self.completed(manager=restarted).id, original.id)

    def test_five_completed_documents_survive_restart_and_hit_refreshes_lru(self):
        completed = [self.completed(pdf=self.pdf + f"\n% document {index}".encode()) for index in range(5)]
        first = completed[0]
        six_days_ago = time.time() - 6 * 24 * 60 * 60
        os.utime(first.directory, (six_days_ago, six_days_ago))
        self.manager.shutdown()
        restarted = self.new_manager()
        self.assertTrue(all(item.id in restarted.jobs for item in completed))
        _, reused = self.submit(manager=restarted, pdf=self.pdf + b"\n% document 0")
        self.assertEqual(reused["id"], first.id)
        self.assertGreater(first.directory.stat().st_mtime, six_days_ago + 24 * 60 * 60)
        eight_days_ago = time.time() - 8 * 24 * 60 * 60
        os.utime(first.directory, (eight_days_ago, eight_days_ago))
        restarted.prune()
        self.assertTrue(first.directory.exists())

    def test_pressure_limits_only_remove_incomplete_jobs_and_keep_every_completed_document(self):
        completed = [self.completed(pdf=self.pdf + f"\n% permanent {index}".encode()) for index in range(5)]
        expired = time.time()-365*24*60*60
        for item in completed: os.utime(item.directory,(expired,expired))
        incomplete=[]
        for _ in range(6):
            job=self.manager.begin();self.manager._release_active(job)
            (job.directory/'input.pdf').write_bytes(self.pdf)
            os.utime(job.directory,(expired,expired));incomplete.append(job)
        with patch.multiple(server_module,MAX_JOB_AGE=0,MAX_INACTIVE_JOBS=0,MAX_CACHE_BYTES=0):
            self.manager.prune()
            self.manager.shutdown()
            restarted=self.new_manager()
        self.assertTrue(all(item.directory.exists() for item in completed))
        self.assertTrue(all(not item.directory.exists() for item in incomplete))
        self.assertTrue(all(item.id in restarted.jobs for item in completed))
        with patch.object(server_module.subprocess,"Popen",side_effect=AssertionError("pressure lost permanent cache")):
            for index,item in enumerate(completed):
                _,result=self.submit(manager=restarted,pdf=self.pdf+f"\n% permanent {index}".encode())
                self.assertEqual(result['id'],item.id)

    def test_http_close_delete_complete_and_restart_preserve_the_same_translation(self):
        original=self.completed()
        def open_service(manager):
            service=server_module.create_server(manager,'a'*64,port=0)
            thread=threading.Thread(target=service.serve_forever,daemon=True);thread.start()
            return service,thread
        def request(service,method,path,body=None):
            connection=http.client.HTTPConnection('127.0.0.1',service.server_address[1],timeout=4)
            headers={'Authorization':'Bearer '+'a'*64}
            if body is not None:
                headers.update({'Content-Type':'application/pdf','X-AskGPT-Pages':'all',
                    'X-AskGPT-Source':'en','X-AskGPT-Target':'zh-Hans'})
            connection.request(method,path,body=body,headers=headers)
            response=connection.getresponse();result=response.status,response.read();connection.close();return result
        route='/v1/pdf/jobs/'+original.id
        first,thread=open_service(self.manager)
        try:
            status,pdf=request(first,'GET',route+'/mono.pdf');self.assertEqual(status,200)
            status,raw=request(first,'DELETE',route)
            self.assertEqual(status,200);self.assertEqual(json.loads(raw)['state'],'complete')
        finally:
            first.shutdown();first.server_close();thread.join(2);self.manager.shutdown()
        expired=time.time()-365*24*60*60;os.utime(original.directory,(expired,expired))
        with patch.multiple(server_module,MAX_JOB_AGE=0,MAX_INACTIVE_JOBS=0,MAX_CACHE_BYTES=0):
            restarted=self.new_manager()
        second,thread=open_service(restarted)
        try:
            with patch.object(server_module.subprocess,'Popen',side_effect=AssertionError('HTTP reopen started model')):
                status,raw=request(second,'POST','/v1/pdf/jobs',self.pdf)
            self.assertEqual(status,202);self.assertEqual(json.loads(raw)['id'],original.id)
            self.assertEqual(json.loads(raw)['state'],'complete')
            self.assertEqual(request(second,'GET',route+'/mono.pdf'),(200,pdf))
        finally:
            second.shutdown();second.server_close();thread.join(2)

    def test_cancelled_result_has_no_completed_metadata_and_is_never_reused(self):
        self.worker.write_text("import time;time.sleep(30)\n")
        job, _ = self.submit()
        self.manager.cancel(job)
        self.assertFalse((job.directory / "cache.json").exists())
        self.assertEqual(self.manager.completed, {})
        self.manager.shutdown()
        restarted = self.new_manager()
        self.assertNotIn(job.id, restarted.jobs)

    def test_batch_failure_codes_remain_fixed_and_never_become_cache_entries(self):
        for error in ["batch_limit", "batch_invalid", "gpt_unavailable", "private exception with source text"]:
            self.worker.write_text("import argparse,pathlib,json\n"
                "p=argparse.ArgumentParser();p.add_argument('--job-dir');p.add_argument('--cache-root');p.add_argument('--translator');a=p.parse_args()\n"
                f"(pathlib.Path(a.job_dir)/'result.json').write_text(json.dumps({{'state':'failed','error':{error!r}}}))\n"
                "raise SystemExit(1)\n")
            job, _ = self.submit()
            for _ in range(100):
                if job.state != "running": break
                time.sleep(.01)
            self.assertEqual(job.state, "failed")
            self.assertEqual(job.error, error if error in {"batch_limit", "batch_invalid", "gpt_unavailable"} else "layout_failed")
            self.assertEqual(self.manager.completed, {})
            self.assertFalse((job.directory / "cache.json").exists())

    def test_source_range_direction_and_translation_revision_cannot_hit_stale_output(self):
        original = self.completed()
        for kwargs in [{"pages": "2"}, {"source": "zh-Hans", "target": "en"},
                       {"pdf": self.pdf + b"\n% changed source"}]:
            changed = self.completed(**kwargs)
            self.assertNotEqual(changed.id, original.id)
        self.manager.shutdown()
        revised = self.new_manager(translation_revision=server_module.TRANSLATION_REVISION + "-next")
        self.assertNotIn(original.id, revised.jobs)
        with patch.multiple(server_module,MAX_JOB_AGE=0,MAX_INACTIVE_JOBS=0,MAX_CACHE_BYTES=0):
            revised.prune()
        self.assertTrue(original.directory.exists(),"version upgrade deleted a historical completed translation")
        changed = self.completed(manager=revised)
        self.assertNotEqual(changed.id, original.id)

    def test_mutated_or_missing_output_is_recomputed_instead_of_reused(self):
        original = self.completed()
        path = original.directory / "mono.pdf"
        value = path.read_bytes()
        path.write_bytes(value[:-1] + bytes([value[-1] ^ 1]))
        replacement = self.completed()
        self.assertNotEqual(replacement.id, original.id)
        (replacement.directory / "dual.pdf").unlink()
        again = self.completed()
        self.assertNotEqual(again.id, replacement.id)

    def test_restart_rejects_symlink_unsafe_permissions_and_tampered_metadata(self):
        for change in ["metadata_symlink", "output_symlink", "permissions", "output_digest", "range"]:
            original = self.completed()
            cache = original.directory / "cache.json"
            output = original.directory / "mono.pdf"
            if change == "metadata_symlink":
                outside = self.root / "outside-cache.json"
                outside.write_bytes(cache.read_bytes()); cache.unlink(); cache.symlink_to(outside)
            elif change == "output_symlink":
                outside = self.root / "outside.pdf"
                outside.write_bytes(output.read_bytes()); output.unlink(); output.symlink_to(outside)
            elif change == "permissions": cache.chmod(0o644)
            elif change == "output_digest":
                raw = bytearray(output.read_bytes()); raw[-1] ^= 1; output.write_bytes(raw)
            else:
                metadata = json.loads(cache.read_text())
                metadata["sourcePages"] = [999]
                cache.write_text(json.dumps(metadata))
            self.manager.shutdown()
            self.manager = self.new_manager()
            self.assertNotIn(original.id, self.manager.jobs, change)


if __name__ == "__main__": unittest.main()
