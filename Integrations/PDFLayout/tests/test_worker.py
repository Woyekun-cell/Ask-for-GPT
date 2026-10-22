import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from helper_fixture import enable_python_helpers

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try:
    worker = importlib.import_module("worker")
except ModuleNotFoundError:
    worker = None


class NativeHelperProtocolTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(worker, "PDF native helper adapter is not implemented")
        enable_python_helpers(self, worker)
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "helper"

    def tearDown(self):
        if worker is not None: self.temp.cleanup()

    def make_helper(self, body):
        self.path.write_text("#!/usr/bin/env python3\nimport json,sys,time\n" + body, encoding='utf-8')
        self.path.chmod(0o700)
        return worker.NativeHelper(self.path, "en", "zh-Hans", timeout=5)

    def test_jsonl_id_and_translation(self):
        with self.make_helper("for line in sys.stdin:\n r=json.loads(line); print(json.dumps({'id':r['id'],'translation':'译文'}),flush=True)\n") as helper:
            self.assertEqual(helper.translate("Test sentence."), "译文")
            self.assertEqual(helper.translate("Another sentence."), "译文")

    def test_wrong_id_and_empty_translation_are_errors(self):
        for response in ["{'id':'wrong','translation':'译文'}", "{'id':r['id'],'translation':''}"]:
            with self.subTest(response=response), self.make_helper("for line in sys.stdin:\n r=json.loads(line); print(json.dumps(" + response + "),flush=True)\n") as helper:
                with self.assertRaises(worker.ProtocolFailure): helper.translate("Test sentence.")

    def test_timeout_terminates_stalled_helper(self):
        with self.make_helper("for line in sys.stdin: time.sleep(20)\n") as helper:
            helper.timeout = .15
            with self.assertRaisesRegex(worker.ProtocolFailure, "translation_timeout"):
                helper.translate("Test sentence.")
            self.assertIsNone(helper.process)

    def test_non_llm_translator_does_not_claim_prompt_support(self):
        translator = worker.make_translator(lambda text: "译文", "en", "zh-Hans")
        with self.assertRaises(NotImplementedError): translator.do_llm_translate(None)
        self.assertEqual(translator.do_translate("A value {v1} grows."), "译文 {v1} 译文")


if __name__ == "__main__": unittest.main()
