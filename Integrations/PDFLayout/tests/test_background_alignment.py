"""Background indexing checkpoints use temporary PDFs and a deterministic helper."""
import copy
import hashlib
import json
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import test_sentence_alignment as fixtures
from worker import NativeHelper
from sentence_service import SentenceUpgradeService, Upgrade
import phrase_alignment as phrase


class BackgroundAlignmentTests(unittest.TestCase):
    for _name in ("setUp", "tearDown", "manager", "install", "service", "request",
                  "await_upgrade", "paragraph_fixture"):
        locals()[_name] = getattr(fixtures.SentenceAlignmentTests, _name)

    def setup_job(self):
        self.paragraph_fixture(3)
        manager = self.manager()
        job = self.install(manager)
        return manager, job, self.service(manager), f"/v1/pdf/jobs/{job.id}/alignment-upgrade"

    def control(self, service, route, action, scope=None):
        value={"action": action}
        if scope is not None:value["scope"]=scope
        code, raw = self.request(service, "POST", route, json.dumps(value).encode(),
                                 extra_headers={"Content-Type": "application/json"})
        return code, json.loads(raw)

    def word_batch_fixture(self,background,priority=False):
        def glyphs(text,y):return [{"text":c,"rect":[i*10,y,i*10+8,y+10],"line":0} for i,c in enumerate(text)]
        units=[]
        for index,words in enumerate((40,44)):
            source,target="Gene "*words,"测"*48
            units.append(phrase.prepare_unit(f"p0_0_s{index}",
                {"text":source,"glyphs":glyphs(source,10)},
                {"text":target,"glyphs":glyphs(target,30)}))
        manager=SimpleNamespace(lock=threading.RLock(),stopping=False)
        service=SentenceUpgradeService(manager)
        parent=SimpleNamespace(id="parent",source_pages=[0],cache_info={})
        upgrade=Upgrade(parent,None,[0],[],background=background,focus_page=0)
        if priority:upgrade.priority_units[0]=[units[1]["id"]]
        page={"sourceToDual":[1,0,0,1,0,0],"targetToDual":[1,0,0,1,400,0],
            "paragraphs":[{"id":"p0_0","sentences":[{"id":u["id"],"source":{},"target":{}} for u in units]}]}
        calls=[]
        def align(helper,request,state,budget):
            calls.append(copy.deepcopy(request));return {u["id"]:[] for u in request}
        with patch.object(service,"_align_phrase_request",align),patch.object(service,"_publish_words"), \
                patch("sentence_service.phrase_requests",wraps=phrase.phrase_requests) as batches:
            _,reason=service._word_turns(None,upgrade,0,0,page,units,units)
        return units,calls,reason,batches.call_args

    def test_word_turns_uses_larger_batches_only_for_background_indexing(self):
        for background,expected in ((False,[1,1]),(True,[2])):
            with self.subTest(background=background):
                units,calls,reason,arguments=self.word_batch_fixture(background)
                self.assertIsNone(reason)
                self.assertEqual([len(c) for c in calls],expected)
                self.assertEqual([u for c in calls for u in c],[phrase.request_unit(u) for u in units])
                self.assertEqual(arguments.kwargs,{"background":background})

    def test_background_batch_still_splits_out_an_explicit_selected_unit_first(self):
        units,calls,reason,_=self.word_batch_fixture(True,priority=True)
        self.assertIsNone(reason)
        self.assertEqual([[u["id"] for u in c] for c in calls],[[units[1]["id"]],[units[0]["id"]]])

    def test_background_publishes_all_sentences_before_words_and_extracts_words_once(self):
        manager, job, service, route = self.setup_job()
        events = []
        sentences, words = NativeHelper.align, NativeHelper.align_phrases
        real_prepare = manager.sentence_upgrades._prepare_words
        def sentence_turn(helper, request):
            events.append("sentence")
            return sentences(helper, request)
        def word_turn(helper, request):
            events.append("word")
            saved = manager.read_alignment(job)
            self.assertEqual(len(saved["pages"][0]["paragraphs"]), 3)
            self.assertTrue(all(p.get("sentences") for p in saved["pages"][0]["paragraphs"]))
            return words(helper, request)
        with patch.object(NativeHelper, "align", sentence_turn), patch.object(NativeHelper, "align_phrases", word_turn), patch.object(manager.sentence_upgrades, "_prepare_words", wraps=real_prepare) as prepared:
            code, state = self.request(service, "POST", route, self.source.read_bytes(),
                                       extra_headers={"X-AskGPT-Background": "1"})
            self.assertEqual(code, 202)
            self.assertEqual(self.await_upgrade(service, route)["state"], "complete")
            self.assertEqual(prepared.call_count, 1)
        self.assertEqual(events[:2],["sentence"]*2)
        self.assertEqual(events.count("sentence"),2)
        self.assertNotIn("sentence",events[events.index("word"):])

    def test_background_pause_stops_the_next_turn_and_resume_retains_checkpoint(self):
        manager, job, service, route = self.setup_job()
        entered, released, responded = threading.Event(), threading.Event(), threading.Event()
        original, calls = NativeHelper.align, []
        def align(helper, request):
            calls.append(request[0]["id"])
            if len(calls) == 1:
                entered.set()
                self.assertTrue(released.wait(4))
            result = original(helper, request)
            responded.set()
            return result
        try:
            with patch.object(NativeHelper, "align", align):
                self.request(service, "POST", route, self.source.read_bytes(), extra_headers={"X-AskGPT-Background": "1"})
                self.assertTrue(entered.wait(4))
                code, paused = self.control(service, route, "pause")
                self.assertEqual(code, 200)
                self.assertTrue(paused["paused"])
                accepted=len(calls);self.assertIn(accepted,(1,2))
                released.set()
                # Pausing gates the next turn; the already accepted JSONL
                # response has its own bounded fixture wait before that gate.
                self.assertTrue(responded.wait(5), "fixture helper did not return its first response")
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    state = json.loads(self.request(service, "GET", route)[1])
                    if state.get("phase") == "paused": break
                    time.sleep(.01)
                self.assertEqual(state.get("phase"), "paused")
                self.assertTrue(state["paused"])
                self.assertEqual(len(calls),accepted)
                first = copy.deepcopy(manager.read_alignment(job)["pages"][0]["paragraphs"][0])
                self.assertTrue(first.get("sentences"))
                self.assertEqual(self.control(service, route, "resume")[0], 200)
                self.assertEqual(self.await_upgrade(service, route)["state"], "complete")
                self.assertEqual(manager.read_alignment(job)["pages"][0]["paragraphs"][0]["sentences"][0]["source"], first["sentences"][0]["source"])
        finally: released.set()

    def test_cancelling_only_background_upgrade_preserves_completed_pdf_job(self):
        manager, job, service, route = self.setup_job()
        original = NativeHelper.align
        entered, released = threading.Event(), threading.Event()
        pdf_hash = hashlib.sha256((job.directory / "mono.pdf").read_bytes()).hexdigest()
        def align(helper, request):
            entered.set(); released.wait(4)
            return original(helper, request)
        try:
            with patch.object(NativeHelper, "align", align):
                self.request(service, "POST", route, self.source.read_bytes(), extra_headers={"X-AskGPT-Background": "1"})
                self.assertTrue(entered.wait(4))
                code, state = self.control(service, route, "cancel")
                self.assertEqual(code, 200)
                self.assertEqual(state["state"], "failed")
                self.assertEqual(state["error"], "alignment_cancelled")
                released.set()
            self.assertEqual(job.state, "complete")
            self.assertEqual(hashlib.sha256((job.directory / "mono.pdf").read_bytes()).hexdigest(), pdf_hash)
        finally: released.set()

    def test_control_cannot_pause_an_interactive_upgrade(self):
        manager, job, service, route = self.setup_job()
        entered, released = threading.Event(), threading.Event()
        original = NativeHelper.align
        def align(helper, request):
            entered.set(); released.wait(4)
            return original(helper, request)
        try:
            with patch.object(NativeHelper, "align", align):
                self.request(service, "POST", route, self.source.read_bytes())
                self.assertTrue(entered.wait(4))
                code, state = self.control(service, route, "cancel")
                self.assertEqual(code, 200)
                self.assertEqual(state["state"], "running")
                self.assertFalse(state.get("paused", False))
                released.set()
                self.assertEqual(self.await_upgrade(service, route)["state"], "complete")
        finally: released.set()

    def test_explicit_unit_keeps_its_early_word_turn_in_background_mode(self):
        manager, job, service, route = self.setup_job()
        events = []
        sentences, words = NativeHelper.align, NativeHelper.align_phrases
        def sentence_turn(helper, request):
            events.append(("sentence", request[0]["id"]))
            return sentences(helper, request)
        def word_turn(helper, request):
            events.append(("word", request[0]["id"]))
            return words(helper, request)
        with patch.object(NativeHelper, "align", sentence_turn), patch.object(NativeHelper, "align_phrases", word_turn):
            self.request(service, "POST", route, self.source.read_bytes(), extra_headers={
                "X-AskGPT-Background": "1", "X-AskGPT-Units": '["p0_2"]'})
            self.assertEqual(self.await_upgrade(service, route)["state"], "complete")
        self.assertEqual(events[:2], [("sentence", "p0_2"), ("word", "p0_2_s0")])

    def test_control_and_background_header_reject_ambiguous_input(self):
        manager, job, service, route = self.setup_job()
        for payload in [b'{"action":"delete"}', b'{"action":"pause","page":0}', b'{"action":"pause","action":"resume"}']:
            self.assertEqual(self.request(service, "POST", route, payload, extra_headers={"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request(service, "POST", route, self.source.read_bytes(), extra_headers={"X-AskGPT-Background": "true"})[0], 400)
        self.assertEqual(job.state, "complete")

    def test_cancelled_scope_fences_a_delayed_background_upload(self):
        manager, job, service, route = self.setup_job()
        self.assertEqual(self.control(service, route, "cancel", "closed-before-upload")[0], 200)
        code, raw = self.request(service, "POST", route, self.source.read_bytes(), extra_headers={
            "X-AskGPT-Background": "1", "X-AskGPT-Background-Scope": "closed-before-upload"})
        self.assertEqual(code, 400)
        self.assertEqual(json.loads(raw)["error"], "alignment_cancelled")
        self.assertFalse(self.calls.exists())
        self.assertEqual(job.state, "complete")

    def test_a_late_old_scope_cancel_cannot_stop_a_new_background_run(self):
        manager, job, service, route = self.setup_job()
        old = {"X-AskGPT-Background": "1", "X-AskGPT-Background-Scope": "old-view"}
        self.request(service, "POST", route, self.source.read_bytes(), extra_headers=old)
        self.assertEqual(self.await_upgrade(service, route)["state"], "complete")
        original = NativeHelper.align
        entered, released = threading.Event(), threading.Event()
        def align(helper, request):
            entered.set(); released.wait(4)
            return original(helper, request)
        try:
            with patch.object(NativeHelper, "align", align):
                self.request(service, "POST", route, self.source.read_bytes(), pages="2", extra_headers={
                    "X-AskGPT-Background": "1", "X-AskGPT-Background-Scope": "new-view"})
                self.assertTrue(entered.wait(4))
                for action, scope in [("pause", "old-view"), ("cancel", "old-view"), ("cancel", None)]:
                    code, state = self.control(service, route, action, scope)
                    self.assertEqual(code, 200)
                    self.assertEqual(state["state"], "running")
                    self.assertEqual(state["scope"], "new-view")
                    self.assertFalse(state["paused"])
                released.set()
                self.assertEqual(self.await_upgrade(service, route)["state"], "complete")
        finally: released.set()

    def test_a_racing_background_post_cannot_merge_into_someone_elses_queue(self):
        for background, scope in [(False, None), (True, "older-scope")]:
            with self.subTest(background=background):
                discarded=[]
                manager=SimpleNamespace(lock=threading.RLock(), stopping=False,
                    read_alignment=lambda _: {"pages": []},
                    _discard_placeholder=lambda job: discarded.append(job.id))
                service=SentenceUpgradeService(manager)
                parent=SimpleNamespace(id="parent", source_pages=[0,1], cache_info={})
                active=Upgrade(parent, None, [0], [], current_page=0, focus_page=0,
                    background=background, scope=scope)
                service.upgrades[parent.id]=active
                service.submit(parent, SimpleNamespace(id="new-temp"), [1], background=True, scope="new-scope")
                self.assertEqual(active.requested, [0])
                self.assertEqual(active.pending, [])
                self.assertEqual(active.focus_page, 0)
                self.assertEqual(discarded, ["new-temp"])

    def test_a_long_pause_does_not_consume_the_next_word_model_budget(self):
        manager=SimpleNamespace(lock=threading.RLock(), stopping=False)
        service=SentenceUpgradeService(manager)
        parent=SimpleNamespace(id="parent", source_pages=[0], cache_info={})
        upgrade=Upgrade(parent, None, [0], [], background=True, focus_page=0)
        clock=[0.0];gates=[0];calls=[]
        original=service._wait_active
        def checkpoint(state):
            gates[0]+=1
            if gates[0]==1:state.paused.set()
            return original(state)
        def wait(_):clock[0]+=100;upgrade.paused.clear();return False
        upgrade.cancelled.wait=wait
        helper=SimpleNamespace(batch_timeout=100,align_phrases=lambda request: calls.append(request) or {})
        page={"paragraphs":[{"id":"p","sentences":[{"id":"p_s0"}]}]};unit={"id":"p_s0"}
        with patch("sentence_service.time.monotonic",lambda: clock[0]), \
             patch("sentence_service.reusable_phrase_unit",lambda *_: False), \
             patch("sentence_service.identity_groups",lambda *_: []), \
             patch("sentence_service.phrase_requests",lambda _,**options: [[unit]]), \
             patch("sentence_service.validate_phrase_matches",lambda value,request: {"p_s0":[]}), \
             patch("sentence_service.upgrade_phrase_page",lambda page,*args,**kwargs: page), \
             patch.object(service,"_publish_words"),patch.object(service,"_wait_active",checkpoint):
            service._word_turns(helper,upgrade,0,0,page,[unit],[unit])
        self.assertEqual(clock[0],100)
        self.assertEqual(len(calls),1)


if __name__ == "__main__": unittest.main()
