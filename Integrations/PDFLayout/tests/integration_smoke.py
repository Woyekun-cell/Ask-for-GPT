#!/usr/bin/env python3
"""Real offline engine/HTTP regression; caller supplies a synthetic PDF fixture."""
import argparse
import hashlib
import http.client
import json
from pathlib import Path
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import JobManager, create_server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True, type=Path)
    parser.add_argument("--cache-root", required=True, type=Path)
    parser.add_argument("--translator", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--pages", default="all,3")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    manager = JobManager(args.cache_root, args.translator)
    service = create_server(manager, "synthetic-local-test-token-" + "x" * 32, port=0)
    threading.Thread(target=service.serve_forever, daemon=True).start()
    port = service.server_address[1]
    def request(method, route, body=None, extra=None):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
        headers = {"Host": f"127.0.0.1:{port}",
            "Authorization": "Bearer synthetic-local-test-token-" + "x" * 32}
        headers.update(extra or {})
        connection.request(method, route, body=body, headers=headers)
        response = connection.getresponse()
        result = response.status, response.read()
        connection.close()
        return result
    records = []
    try:
        status, raw = request("GET", "/v1/pdf/health")
        assert status == 200 and json.loads(raw)["status"] == "ready", "runtime_not_ready"
        for pages in args.pages.split(","):
            started = time.monotonic()
            status, raw = request("POST", "/v1/pdf/jobs", args.fixture.read_bytes(),
                {"Content-Type": "application/pdf", "X-AskGPT-Pages": pages,
                 "X-AskGPT-Source": "en", "X-AskGPT-Target": "zh-Hans"})
            assert status == 202, raw.decode()
            job = json.loads(raw)
            route = "/v1/pdf/jobs/" + job["id"]
            while job["state"] == "running":
                if time.monotonic() - started > 180:
                    request("DELETE", route)
                    raise AssertionError("integration_timeout")
                time.sleep(.2)
                status, raw = request("GET", route)
                assert status == 200, "job_status_unavailable"
                job = json.loads(raw)
            assert job["state"] == "complete", json.dumps(job)
            record = {"pages": pages, "sourcePages": job["sourcePages"],
                "pageCount": job["pageCount"], "seconds": round(time.monotonic() - started, 3), "files": {}}
            for kind in ["mono", "dual"]:
                status, raw = request("GET", route + "/" + kind + ".pdf")
                assert status == 200 and raw.startswith(b"%PDF-"), "pdf_download_failed"
                filename = ("all" if pages == "all" else "page" + pages) + "." + kind + ".pdf"
                (args.output_dir / filename).write_bytes(raw)
                record["files"][kind] = {"name": filename, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
            records.append(record)
            print(json.dumps(record, separators=(",", ":")), flush=True)
        (args.output_dir / "integration.json").write_text(json.dumps({"status": "PASS", "jobs": records}, indent=2) + "\n")
    finally:
        manager.shutdown()
        service.shutdown()
        service.server_close()


if __name__ == "__main__": main()
