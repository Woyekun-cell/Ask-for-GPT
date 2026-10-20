"""The dedicated phrase JSONL bridge uses only local protocol fixtures."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from layout_common import ProtocolFailure
from worker import NativeHelper


class PhraseHelperTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.units=[{"id":"u0","sourceText":"alpha","targetText":"甲","source":[{"id":"s0","text":"alpha"}],
            "target":[{"id":"t0","text":"甲"}]}]

    def tearDown(self):self.temp.cleanup()

    def helper(self,body):
        path=self.root/"helper"
        path.write_text("#!/usr/bin/env python3\nimport json,sys,time\n"
            "assert sys.argv[1:]==['--gpt-phrase-align']\nfor line in sys.stdin:\n r=json.loads(line)\n"+body)
        path.chmod(0o700);return path

    def test_phrase_mode_id_and_groups_are_independent_of_sentence_protocol(self):
        path=self.helper(" assert set(r)=={'id','units','source','target'}\n"
            " print(json.dumps({'id':r['id'],'alignments':{'u0':[{'sourceIDs':['s0'],'targetIDs':['t0']}]}}),flush=True)\n")
        with NativeHelper(path,"en","zh-Hans") as helper:
            self.assertEqual(helper.align_phrases(self.units),{"u0":[{"sourceIDs":["s0"],"targetIDs":["t0"]}]})
            self.assertEqual(helper.process_mode,"phrase_alignment")

    def test_unknown_token_id_rejects_response_and_closes_process(self):
        path=self.helper(" print(json.dumps({'id':r['id'],'alignments':{'u0':[{'sourceIDs':['foreign'],'targetIDs':['t0']}]}}),flush=True)\n")
        with NativeHelper(path,"en","zh-Hans") as helper:
            with self.assertRaisesRegex(ProtocolFailure,"alignment_invalid"):helper.align_phrases(self.units)
            self.assertIsNone(helper.process)

    def test_invalid_input_never_starts_a_process(self):
        with NativeHelper(self.root/"must-not-run","en","zh-Hans") as helper:
            with self.assertRaisesRegex(ProtocolFailure,"alignment_invalid"):helper.align_phrases([])
            self.assertIsNone(helper.process)

    def test_phrase_timeout_closes_its_process(self):
        path=self.helper(" time.sleep(10)\n")
        with NativeHelper(path,"en","zh-Hans",batch_timeout=.1) as helper:
            with self.assertRaisesRegex(ProtocolFailure,"alignment_timeout"):helper.align_phrases(self.units)
            self.assertIsNone(helper.process)


if __name__=="__main__":unittest.main()
