"""Sentence geometry is real; semantic relations are explicit helper IDs."""
import copy
import hashlib
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import alignment
import sentence_alignment as sentence
import phrase_alignment as phrase
import server
from layout_common import atomic_json,BABELDOC_VERSION,ProtocolFailure
from worker import compose_dual,NativeHelper


class SentenceAlignmentTests(unittest.TestCase):
    def test_unique_exact_normalized_substring_recovers_only_real_glyphs_inside_existing_regions(self):
        chars=[{"text":c,"rect":[i*10,0,i*10+8,10]} for i,c in enumerate("邻甲。乙。")]
        side={"text":"甲。","rects":[[0,0,48,10]]}
        parts=sentence.extract_sentences([chars],side,"p0_0","s")
        self.assertEqual([part["text"] for part in parts],["甲。"])
        self.assertEqual(parts[0]["glyphs"],[{**chars[i],"line":1} for i in (1,2)])
        self.assertEqual(parts[0]["rects"],[[10,0,28,10]])

    def test_exact_recovery_refuses_ambiguous_missing_internal_and_out_of_region_text(self):
        for text,wanted,region in [("Gene Gene","Gene",[0,0,88,10]),("Gne","Gene",[0,0,28,10]),
                ("GeXne","Gene",[0,0,48,10]),("Gene next","Gene",[10,0,88,10])]:
            chars=[{"text":c,"rect":[i*10,0,i*10+8,10]} for i,c in enumerate(text)]
            self.assertEqual(sentence.extract_sentences([chars],{"text":wanted,"rects":[region]},"p0_0","s"),[])
        ligature=[[{"text":"ffi","rect":[0,0,20,10]}]]
        self.assertEqual(sentence.extract_sentences(ligature,{"text":"fi","rects":[[0,0,20,10]]},"p0_0","s"),[])

    def setUp(self):
        import pymupdf
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.source=self.root/"source.pdf";self.mono=self.root/"mono.pdf";self.dual=self.root/"dual.pdf"
        self.source_text=["First fact binds. Second fact blocks.","Control one. Control two."]
        self.target_text=["Blocking happens. Binding happens.","One control. Two controls."]
        for path,texts in [(self.source,self.source_text),(self.mono,self.target_text)]:
            with pymupdf.open() as doc:
                for text in texts:
                    page=doc.new_page(width=400,height=250);page.insert_text((20,45),text,fontsize=11)
                doc.save(path)
        compose_dual(self.source,self.mono,[0,1],self.dual)
        self.sha=hashlib.sha256(self.source.read_bytes()).hexdigest()
        pages=[]
        with pymupdf.open(self.source) as source,pymupdf.open(self.mono) as target:
            for index in range(2):
                def side(page,text):
                    bbox=page.get_text("blocks")[0][:4]
                    rect=pymupdf.Rect(bbox)*~page.transformation_matrix
                    return {"text":text,"rects":[list(rect)]}
                left,right=side(source[index],self.source_text[index]),side(target[index],self.target_text[index])
                pages.append({"sourcePage":index,"outputPage":index,"source":alignment._geometry(source[index]),
                    "mono":alignment._geometry(target[index]),"dual":{"mediaBox":[0,0,800,250],"cropBox":[0,0,800,250],"rotation":0},
                    "sourceToDual":[1,0,0,1,0,0],"targetToDual":[1,0,0,1,400,0],"paragraphs":[
                        {"id":f"p{index}_0","source":left,"target":right,"dualSource":{"rects":left["rects"]},
                        "dualTarget":{"rects":[[r[0]+400,r[1],r[2]+400,r[3]] for r in right["rects"]]}}]})
        self.value={"schema":1,"coordinateSpace":"pdf","granularity":"paragraph","provenance":"babeldoc-ir",
            "sourcePages":[0,1],"pageCount":2,"sourceSHA256":self.sha,"pages":pages}
        self.calls=self.root/"calls.txt";self.helper=self.root/"helper"
        self.helper.write_text("#!/usr/bin/env python3\nimport sys,json,pathlib\n"
            "assert sys.argv[1:] in [['--gpt-align'],['--gpt-phrase-align']]\n"
            f"calls=pathlib.Path({str(self.calls)!r})\n"
            "for line in sys.stdin:\n"
            " r=json.loads(line);out={}\n"
            " if 'paragraphs' in r:\n"
            "  for p in r['paragraphs']:\n"
            "   for i,s in enumerate(p['source']):out[s['id']]=[p['target'][-1-i]['id']]\n"
            " else:\n"
            "  for u in r['units']:\n"
            "   out[u['id']]=[]\n"
            "   for s in u['source']:\n"
            "    stem={'blocks':'Blocking','binds':'Binding'}.get(s['text'])\n"
            "    t=next((t for t in u['target'] if t['text']==stem),None)\n"
            "    if t:out[u['id']].append({'sourceIDs':[s['id']],'targetIDs':[t['id']]})\n"
            " with calls.open('a') as f:f.write('call\\n')\n"
            " print(json.dumps({'id':r['id'],'alignments':out}),flush=True)\n")
        self.helper.chmod(0o700);self.managers=[];self.services=[]

    def tearDown(self):
        for service in self.services: service.shutdown();service.server_close()
        for manager in self.managers: manager.shutdown()
        self.temp.cleanup()

    def manager(self):
        manager=server.JobManager(self.root/"cache",self.helper,ready_override=True)
        self.managers.append(manager);return manager

    def install(self,manager):
        job=manager.begin()
        for name,path in [("mono.pdf",self.mono),("dual.pdf",self.dual)]:
            (job.directory/name).write_bytes(path.read_bytes());(job.directory/name).chmod(0o600)
        atomic_json(job.directory/"alignment.json",self.value)
        job.source_pages,job.page_count=[0,1],2
        job.cache_info={"cacheKey":server._cache_key(self.sha,[0,1],2,"en","zh-Hans",manager.translation_revision),
            "sourceSHA256":self.sha,"sourcePages":[0,1],"pageCount":2,"source":"en","target":"zh-Hans",
            "revision":manager.translation_revision,"babeldoc":BABELDOC_VERSION}
        manager._store_completed(job);job.state="complete";manager._release_active(job);return job

    def service(self,manager):
        service=server.create_server(manager,"a"*64,port=0);self.services.append(service)
        threading.Thread(target=service.serve_forever,daemon=True).start();return service

    def request(self,service,method,path,body=None,pages="1",token="a"*64,extra_headers=None):
        connection=http.client.HTTPConnection("127.0.0.1",service.server_address[1],timeout=5)
        headers={"Authorization":"Bearer "+token}
        if body is not None: headers.update({"Content-Type":"application/pdf","X-AskGPT-Pages":pages})
        headers.update(extra_headers or {})
        connection.request(method,path,body=body,headers=headers);response=connection.getresponse()
        result=(response.status,response.read());connection.close();return result

    def await_upgrade(self,service,route):
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            status,raw=self.request(service,"GET",route);self.assertEqual(status,200)
            value=json.loads(raw)
            if value["state"]!="running":return value
            time.sleep(.02)
        self.fail("sentence upgrade did not settle")

    def prepared(self):
        import pymupdf
        with pymupdf.open(self.source) as source,pymupdf.open(self.mono) as target:
            return sentence.prepare_page(self.value["pages"][0],source[0],target[0])

    def paragraph_fixture(self,count=3):
        """Separate real paragraphs, rather than invented sentence rectangles."""
        import pymupdf
        texts=(("First fact binds.","Second fact blocks.","Third fact helps."),
               ("Binding happens.","Blocking happens.","Helping happens."))
        records=[]
        for side,path,original,rows in (("source",self.source,self.source_text,texts[0]),("target",self.mono,self.target_text,texts[1])):
            with pymupdf.open() as pdf:
                page=pdf.new_page(width=400,height=250)
                for index,text in enumerate(rows[:count]):page.insert_text((20,45+index*45),text,fontsize=11)
                page=pdf.new_page(width=400,height=250);page.insert_text((20,45),original[1],fontsize=11)
                pdf.save(path)
            with pymupdf.open(path) as pdf:
                records.append([{ "text":text,"rects":[list(pymupdf.Rect(block[:4])*~pdf[0].transformation_matrix)]}
                    for text,block in zip(rows[:count],pdf[0].get_text("blocks"))])
        paragraphs=[]
        for index,(left,right) in enumerate(zip(*records)):
            paragraphs.append({"id":f"p0_{index}","source":left,"target":right,"dualSource":{"rects":left["rects"]},
                "dualTarget":{"rects":[[r[0]+400,r[1],r[2]+400,r[3]] for r in right["rects"]]}})
        self.value["pages"][0]["paragraphs"]=paragraphs
        self.sha=hashlib.sha256(self.source.read_bytes()).hexdigest();self.value["sourceSHA256"]=self.sha
        compose_dual(self.source,self.mono,[0,1],self.dual)

    def test_partial_sentence_pages_are_disjoint_bounded_and_subset_keeps_them(self):
        value=copy.deepcopy(self.value)
        value.update(granularity="sentence",sentenceAlignmentRevision=sentence.SENTENCE_REVISION,
            sentencePages=[1],sentencePartialPages=[0],phraseAlignmentRevision=phrase.PHRASE_REVISION,phrasePages=[0])
        alignment.validate_alignment(value,[0,1],2,self.sha)
        self.assertEqual(alignment.subset_alignment(value,[0])["sentencePartialPages"],[0])
        self.assertEqual(alignment.subset_alignment(value,[1])["sentencePartialPages"],[])
        for changes in ({"sentencePartialPages":[0,0]},{"sentencePartialPages":[1]},{"sentencePartialPages":[2]},
                {"sentencePartialPages":[True]},{"phraseExtractedPages":[0]}):
            with self.subTest(changes=changes),self.assertRaises(ValueError):
                alignment.validate_alignment({**value,**changes},[0,1],2,self.sha)

    def test_paragraph_merge_preserves_sibling_anchors_and_reuse_requires_current_real_glyphs(self):
        self.paragraph_fixture(2);prepared=self.prepared();first,second=prepared
        def match(p):return {s["id"]:[p["target"][i]["id"]] for i,s in enumerate(p["source"])}
        first_page=sentence.upgrade_page(self.value["pages"][0],[first],match(first),preserve_unprepared=True)
        first_saved=copy.deepcopy(first_page["paragraphs"][0]);first_saved["sentences"][0]["testOwnedData"]=True
        first_page["paragraphs"][0]=copy.deepcopy(first_saved)
        result=sentence.upgrade_page(first_page,[second],match(second),preserve_unprepared=True)
        self.assertEqual(result["paragraphs"][0],first_saved)
        self.assertTrue(sentence.reusable_sentence_paragraph(first_saved,first))
        for altered in ("input","anchor","text","revision"):
            saved=copy.deepcopy(first_saved);current=copy.deepcopy(first)
            if altered=="input":current["source"][0]["glyphs"][0]["rect"][0]+=.2
            elif altered=="anchor":saved["sentences"][0]["source"]["glyphs"][0]["rect"][0]+=.2
            elif altered=="text":saved["sentences"][0]["source"]["text"]="Other content."
            else:saved["sentenceAttemptRevision"]="untrusted"
            with self.subTest(altered=altered):self.assertFalse(sentence.reusable_sentence_paragraph(saved,current))

    def test_new_page_selected_paragraph_gets_sentence_then_words_before_other_paragraphs(self):
        self.paragraph_fixture();manager=self.manager();job=self.install(manager);service=self.service(manager)
        route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade";events=[];real_s=NativeHelper.align;real_w=NativeHelper.align_phrases
        def align(helper,request):
            events.append(("sentence",[p["id"] for p in request]))
            if len(events)>2:
                saved=manager.read_alignment(job)
                self.assertTrue(saved["pages"][0]["paragraphs"][2]["sentences"][0].get("phraseAttemptRevision"))
            return real_s(helper,request)
        def words(helper,request):
            events.append(("word",[u["id"] for u in request]));saved=manager.read_alignment(job)
            if len(events)==2:
                self.assertEqual(saved["sentencePages"],[]);self.assertEqual(saved["sentencePartialPages"],[0])
                self.assertNotIn(0,saved.get("phraseExtractedPages",[]))
                self.assertFalse(saved["pages"][0]["paragraphs"][0].get("sentences"))
            return real_w(helper,request)
        with patch.object(NativeHelper,"align",align),patch.object(NativeHelper,"align_phrases",words):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes(),extra_headers={"X-AskGPT-Units":'["p0_2"]'})[0],202)
            result=self.await_upgrade(service,route)
        self.assertEqual(result["state"],"complete",result)
        self.assertEqual(events[:2],[("sentence",["p0_2"]),("word",["p0_2_s0"])])
        self.assertEqual(manager.read_alignment(job)["sentencePages"],[0]);self.assertEqual(manager.read_alignment(job)["sentencePartialPages"],[])
        self.assertEqual(manager.read_alignment(job)["phraseExtractedPages"],[0])

    def test_partial_paragraph_checkpoint_survives_later_sentence_failure_and_retry(self):
        self.paragraph_fixture(2);manager=self.manager();job=self.install(manager);service=self.service(manager)
        route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade";real=NativeHelper.align
        def failed(helper,request):
            if request[0]["id"]=="p0_1":raise ProtocolFailure("alignment_timeout")
            return real(helper,request)
        with patch.object(NativeHelper,"align",failed):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
            self.assertEqual(self.await_upgrade(service,route)["error"],"alignment_timeout")
        saved=manager.read_alignment(job);first=copy.deepcopy(saved["pages"][0]["paragraphs"][0])
        self.assertTrue(first["sentences"][0]["phrases"]);self.assertEqual(saved["sentencePages"],[])
        self.assertEqual(saved["sentencePartialPages"],[0]);self.assertEqual(saved["phraseExtractedPages"],[])
        calls=[]
        def resumed(helper,request):calls.extend(p["id"] for p in request);return real(helper,request)
        with patch.object(NativeHelper,"align",resumed):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
            self.assertEqual(self.await_upgrade(service,route)["state"],"complete")
        self.assertEqual(calls,["p0_1"]);self.assertEqual(manager.read_alignment(job)["pages"][0]["paragraphs"][0],first)

    def test_legacy_false_full_page_repairs_only_missing_paragraph_and_keeps_verified_words(self):
        import pymupdf
        self.paragraph_fixture();prepared=self.prepared();matches={p["source"][0]["id"]:[p["target"][0]["id"]] for p in prepared[:2]}
        page=sentence.upgrade_page(self.value["pages"][0],prepared[:2],matches)
        for paragraph in page["paragraphs"]:
            for key in ("sentenceAttemptRevision","sentenceInputSHA256","sentenceAnchorsSHA256"):paragraph.pop(key,None)
        with pymupdf.open(self.source) as source,pymupdf.open(self.mono) as mono:
            words=phrase.prepare_phrase_page(page,source[0],mono[0])
        page=phrase.upgrade_phrase_page(page,words,{u["id"]:[] for u in words})
        self.value["pages"][0]=page
        self.value.update(granularity="sentence",sentenceAlignmentRevision=sentence.SENTENCE_REVISION,sentencePages=[0],
            phraseAlignmentRevision=phrase.PHRASE_REVISION,phrasePages=[0],phraseExtractionRevision=phrase.EXTRACTION_REVISION,
            phraseExtractedPages=[0],phraseCoverage={"0":phrase.phrase_page_coverage(page,words)})
        manager=self.manager();job=self.install(manager);service=self.service(manager)
        route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade";calls=[];real_s=NativeHelper.align;real_w=NativeHelper.align_phrases
        def align(helper,request):calls.append(("sentence",[p["id"] for p in request]));return real_s(helper,request)
        def word(helper,request):calls.append(("word",[p["id"] for p in request]));return real_w(helper,request)
        with patch.object(NativeHelper,"align",align),patch.object(NativeHelper,"align_phrases",word):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
            self.assertEqual(self.await_upgrade(service,route)["state"],"complete")
        self.assertEqual(calls,[("sentence",["p0_2"]),("word",["p0_2_s0"])])
        saved=manager.read_alignment(job)
        for index in (0,1):self.assertEqual(saved["pages"][0]["paragraphs"][index]["sentences"],page["paragraphs"][index]["sentences"])
        self.assertEqual(saved["sentencePages"],[0]);self.assertEqual(saved["sentencePartialPages"],[])
        self.assertEqual(saved["phraseExtractedPages"],[0])

    def test_priority_json_accepts_paragraph_hint_and_reorders_remaining_paragraphs_live(self):
        self.paragraph_fixture();manager=self.manager();job=self.install(manager);service=self.service(manager)
        route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade";entered=threading.Event();release=threading.Event();events=[]
        real_s=NativeHelper.align;real_w=NativeHelper.align_phrases
        def align(helper,request):events.extend(p["id"] for p in request);return real_s(helper,request)
        def words(helper,request):
            if request[0]["id"]=="p0_0_s0":entered.set();release.wait(4)
            return real_w(helper,request)
        try:
            with patch.object(NativeHelper,"align",align),patch.object(NativeHelper,"align_phrases",words):
                self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202);self.assertTrue(entered.wait(3))
                payload=json.dumps({"page":0,"units":["p0_2"]}).encode()
                self.assertEqual(self.request(service,"POST",route,payload,extra_headers={"Content-Type":"application/json"})[0],200)
                release.set();self.assertEqual(self.await_upgrade(service,route)["state"],"complete")
        finally:release.set()
        self.assertEqual(events,["p0_0","p0_2","p0_1"])

    def test_focus_change_at_sentence_checkpoint_yields_before_starting_old_page_words(self):
        self.paragraph_fixture(2);manager=self.manager();job=self.install(manager);service=self.service(manager)
        route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade";entered=threading.Event();release=threading.Event();events=[]
        real_s=NativeHelper.align;real_w=NativeHelper.align_phrases
        def align(helper,request):
            events.append(("sentence",request[0]["id"]))
            if len(events)==1:entered.set();release.wait(4)
            return real_s(helper,request)
        def words(helper,request):events.append(("word",request[0]["id"]));return real_w(helper,request)
        try:
            with patch.object(NativeHelper,"align",align),patch.object(NativeHelper,"align_phrases",words):
                self.assertEqual(self.request(service,"POST",route,self.source.read_bytes(),pages="1,2")[0],202);self.assertTrue(entered.wait(3))
                payload=json.dumps({"page":1,"units":["p1_0"]}).encode()
                self.assertEqual(self.request(service,"POST",route,payload,extra_headers={"Content-Type":"application/json"})[0],200)
                release.set();self.assertEqual(self.await_upgrade(service,route)["state"],"complete")
        finally:release.set()
        self.assertEqual(events[:3],[("sentence","p0_0"),("sentence","p1_0"),("word","p1_0_s0")])
        self.assertEqual(sum(e==("sentence","p0_0") for e in events),1)
        # A reused paragraph has no new sentence checkpoint; it must still
        # notice a focus update before any old-page word work begins.
        from sentence_service import Upgrade
        state=Upgrade(job,manager.begin(),[0,1],[1],current_page=0,focus_page=1)
        updated,reason=manager.sentence_upgrades._word_turns(None,state,0,0,self.value["pages"][0],[],[])
        self.assertEqual(reason,"page");self.assertEqual(state.pending,[1,0])

    def test_new_paragraph_hint_preempts_remaining_word_batches_of_current_paragraph(self):
        # Keep two independently extracted sentences inside A, plus real B.
        self.paragraph_fixture(3);first,second,third=self.value["pages"][0]["paragraphs"]
        for name in ("source","target","dualSource","dualTarget"):
            first[name]["rects"]+=second[name]["rects"]
            if name in ("source","target"):first[name]["text"]+=" "+second[name]["text"]
        self.value["pages"][0]["paragraphs"]=[first,third]
        manager=self.manager();job=self.install(manager);service=self.service(manager)
        route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade";entered=threading.Event();release=threading.Event();events=[]
        real_s=NativeHelper.align;real_w=NativeHelper.align_phrases;original=phrase.phrase_requests
        def split(units):return [request for unit in units for request in original([unit])]
        def align(helper,request):events.append(("sentence",request[0]["id"]));return real_s(helper,request)
        def words(helper,request):
            events.append(("word",request[0]["id"]))
            if len(events)==2:entered.set();release.wait(4)
            return real_w(helper,request)
        try:
            with patch("sentence_service.phrase_requests",split),patch.object(NativeHelper,"align",align),patch.object(NativeHelper,"align_phrases",words):
                self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202);self.assertTrue(entered.wait(3))
                payload=json.dumps({"page":0,"units":["p0_2"]}).encode()
                self.assertEqual(self.request(service,"POST",route,payload,extra_headers={"Content-Type":"application/json"})[0],200)
                release.set();self.assertEqual(self.await_upgrade(service,route)["state"],"complete")
        finally:release.set()
        self.assertEqual(events,[("sentence","p0_0"),("word","p0_0_s0"),("sentence","p0_2"),
            ("word","p0_2_s0"),("word","p0_0_s1")])

    def test_cancelled_partial_paragraph_cannot_publish_late_word_result(self):
        self.paragraph_fixture(2);manager=self.manager();job=self.install(manager);service=self.service(manager)
        route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade";entered=threading.Event();release=threading.Event()
        def words(helper,request):entered.set();release.wait(4);return {u["id"]:[] for u in request}
        try:
            with patch.object(NativeHelper,"align_phrases",words):
                self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202);self.assertTrue(entered.wait(3))
                saved=manager.read_alignment(job);manager.sentence_upgrades.upgrades[job.id].cancelled.set()
                release.set();self.assertEqual(self.await_upgrade(service,route)["error"],"alignment_cancelled")
        finally:release.set()
        self.assertEqual(manager.read_alignment(job),saved);self.assertEqual(saved["sentencePartialPages"],[0])

    def test_active_page_is_not_requeued_and_new_visible_page_gets_priority(self):
        from sentence_service import Upgrade
        manager=self.manager();job=self.install(manager)
        original=manager.begin()
        upgrade=Upgrade(job,original,[0],[],current_page=0)
        manager.sentence_upgrades.upgrades[job.id]=upgrade
        duplicate=manager.begin()
        result=manager.sentence_upgrades.submit(job,duplicate,[0,1])
        self.assertEqual(upgrade.pending,[1])
        self.assertEqual(result["currentPage"],0)
        self.assertEqual(result["pendingPages"],[1])
        self.assertNotIn(duplicate.id,manager.jobs)
        duplicate=manager.begin()
        manager.sentence_upgrades.submit(job,duplicate,[0,1])
        self.assertEqual(upgrade.pending,[1])

    def test_a_focused_queued_page_preempts_only_after_a_successful_word_checkpoint(self):
        manager=self.manager();job=self.install(manager);service=self.service(manager)
        route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade";entered=threading.Event();release=threading.Event();calls=[]
        real=NativeHelper.align_phrases;original_requests=phrase.phrase_requests
        def split(units):return [b for u in units for b in original_requests([u])]
        def capture(helper,request):
            calls.append(request[0]["id"])
            if len(calls)==1:entered.set();release.wait(4)
            if request[0]["id"].startswith("p1_"):
                saved=manager.read_alignment(job);self.assertTrue(saved["pages"][0]["paragraphs"][0]["sentences"][0]["phrases"])
            return real(helper,request)
        try:
            with patch("sentence_service.phrase_requests",split),patch.object(NativeHelper,"align_phrases",capture):
                self.assertEqual(self.request(service,"POST",route,self.source.read_bytes(),pages="1,2")[0],202)
                self.assertTrue(entered.wait(6),manager.sentence_upgrades.status(job))
                self.assertEqual(self.request(service,"POST",route,self.source.read_bytes(),pages="2")[0],202)
                release.set();self.assertEqual(self.await_upgrade(service,route)["state"],"complete")
        finally:release.set()
        self.assertEqual(calls,["p0_0_s0","p1_0_s0","p1_0_s1","p0_0_s1"])
        self.assertEqual(manager.read_alignment(job)["phraseExtractedPages"],[0,1])

    def test_an_unfocused_prefetch_page_does_not_thrash_the_visible_page(self):
        manager=self.manager();job=self.install(manager);service=self.service(manager)
        route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade";calls=[];real=NativeHelper.align_phrases;original=phrase.phrase_requests
        def split(units):return [b for u in units for b in original([u])]
        def capture(helper,request):calls.append(request[0]["id"]);return real(helper,request)
        with patch("sentence_service.phrase_requests",split),patch.object(NativeHelper,"align_phrases",capture):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes(),pages="1,2")[0],202)
            self.assertEqual(self.await_upgrade(service,route)["state"],"complete")
        self.assertEqual(calls,["p0_0_s0","p0_0_s1","p1_0_s0","p1_0_s1"])

    def test_units_header_accepts_only_bounded_existing_sentence_ids_on_one_selected_page(self):
        manager=self.manager();job=self.install(manager);self.install_legacy_sentence_page(manager,job)
        service=self.service(manager);route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade"
        bad=[("1",'not-json'),("1",'{}'),("1",'[1]'),("1",'["unknown"]'),("1",'["../escape"]'),
            ("1",json.dumps(["p0_0_s0"]*9)),("1",'["p0_0_s0","p0_0_s0"]'),("2",'["p0_0_s0"]'),
            ("1,2",'["p0_0_s0"]'),("1",' '*1025)]
        with patch.object(NativeHelper,"align",side_effect=AssertionError("rejected priority called model")),patch.object(NativeHelper,"align_phrases",side_effect=AssertionError("rejected priority called model")):
            for pages,header in bad:
                with self.subTest(pages=pages,header=header[:80]):self.assertEqual(self.request(service,"POST",route,self.source.read_bytes(),pages=pages,extra_headers={"X-AskGPT-Units":header})[0],400)
        calls=[];real=NativeHelper.align_phrases
        def capture(helper,request):calls.append([u["id"] for u in request]);return real(helper,request)
        with patch.object(NativeHelper,"align_phrases",capture):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes(),extra_headers={"X-AskGPT-Units":'["p0_0_s1"]'})[0],202)
            self.assertEqual(self.await_upgrade(service,route)["state"],"complete")
        self.assertEqual(calls,[["p0_0_s1"],["p0_0_s0"]],"the priority model turn must not contain an unselected neighboring sentence")

    def test_small_json_reprioritizes_remaining_units_mid_page_without_copying_pdf_or_starting_helper(self):
        import pymupdf
        self.source_text[0]+=" Third fact helps.";self.target_text[0]+=" Helping happens."
        for path,texts in ((self.source,self.source_text),(self.mono,self.target_text)):
            with pymupdf.open() as doc:
                for text in texts:page=doc.new_page(width=400,height=250);page.insert_text((20,45),text,fontsize=11)
                doc.save(path)
        self.sha=hashlib.sha256(self.source.read_bytes()).hexdigest();self.value["sourceSHA256"]=self.sha
        with pymupdf.open(self.source) as a,pymupdf.open(self.mono) as b:
            paragraph=self.value["pages"][0]["paragraphs"][0]
            for side,pdf,text in (("source",a,self.source_text[0]),("target",b,self.target_text[0])):
                rect=list(pymupdf.Rect(pdf[0].get_text("blocks")[0][:4])*~pdf[0].transformation_matrix)
                paragraph[side]={"text":text,"rects":[rect]};paragraph["dualSource" if side=="source" else "dualTarget"]={"rects":[rect if side=="source" else [rect[0]+400,rect[1],rect[2]+400,rect[3]]]}
            prepared=sentence.prepare_page(self.value["pages"][0],a[0],b[0])
        p=prepared[0];matches={s["id"]:[p["target"][-1-i]["id"]] for i,s in enumerate(p["source"])}
        self.value["pages"][0]=sentence.upgrade_page(self.value["pages"][0],prepared,matches)
        self.value.update(granularity="sentence",sentenceAlignmentRevision=sentence.SENTENCE_REVISION,sentencePages=[0])
        compose_dual(self.source,self.mono,[0,1],self.dual)
        manager=self.manager();job=self.install(manager);service=self.service(manager);route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade"
        entered=threading.Event();release=threading.Event();calls=[];real=NativeHelper.align_phrases;original=phrase.phrase_requests
        def split(units):return [b for u in units for b in original([u])]
        def capture(helper,request):
            calls.append(request[0]["id"])
            if len(calls)==1:entered.set();release.wait(4)
            return real(helper,request)
        try:
            with patch("sentence_service.phrase_requests",split),patch.object(NativeHelper,"align_phrases",capture):
                self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202);self.assertTrue(entered.wait(3))
                upgrade=manager.sentence_upgrades.upgrades[job.id];temporary=upgrade.temporary;before=set(manager.jobs)
                payload=json.dumps({"page":0,"units":["p0_0_s0","p0_0_s2"]}).encode()
                with patch.object(manager,"begin",side_effect=AssertionError("small priority allocated a job")),patch.object(NativeHelper,"_start",side_effect=AssertionError("small priority started a helper")),patch.object(pymupdf,"open",side_effect=AssertionError("small priority opened a PDF")):
                    status,raw=self.request(service,"POST",route,payload,extra_headers={"Content-Type":"application/json"})
                self.assertEqual(status,200);self.assertEqual(json.loads(raw)["state"],"running")
                self.assertEqual(set(manager.jobs),before);self.assertIs(upgrade.temporary,temporary)
                release.set();self.assertEqual(self.await_upgrade(service,route)["state"],"complete")
        finally:release.set()
        self.assertEqual(calls,["p0_0_s0","p0_0_s2","p0_0_s1"])

    def test_idle_small_priority_needs_no_pdf_and_rejects_malformed_or_cross_page_units(self):
        import pymupdf
        manager=self.manager();job=self.install(manager);self.install_legacy_sentence_page(manager,job)
        service=self.service(manager);route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade";before=set(manager.jobs)
        with patch.object(manager,"begin",side_effect=AssertionError("idle JSON allocated a job")),patch.object(NativeHelper,"_start",side_effect=AssertionError("idle JSON started model")),patch.object(pymupdf,"open",side_effect=AssertionError("idle JSON read PDF")):
            payload=json.dumps({"page":0,"units":["p0_0_s0"]}).encode()
            status,raw=self.request(service,"POST",route,payload,extra_headers={"Content-Type":"application/json"})
            self.assertEqual(status,200);self.assertEqual(json.loads(raw)["state"],"idle");self.assertEqual(set(manager.jobs),before)
            self.assertEqual(self.request(service,"POST",route,payload,token="wrong",extra_headers={"Content-Type":"application/json"})[0],401)
            bad=[{},[],{"page":True,"units":[]},{"page":2,"units":[]},{"page":0,"units":["p1_0_s0"]},
                {"page":0,"units":["p0_0_s0"],"text":"must not be accepted"},{"page":0,"units":["p0_0_s0"]*9}]
            for value in bad:self.assertEqual(self.request(service,"POST",route,json.dumps(value).encode(),extra_headers={"Content-Type":"application/json"})[0],400)
            self.assertEqual(self.request(service,"POST",route,b' '*2049,extra_headers={"Content-Type":"application/json"})[0],400)
            self.assertEqual(self.request(service,"POST",route,b'{"page":0,"page":1,"units":[]}',extra_headers={"Content-Type":"application/json"})[0],400)
            for duplicate in ("Content-Type","X-AskGPT-Units"):
                connection=http.client.HTTPConnection("127.0.0.1",service.server_address[1],timeout=5)
                connection.putrequest("POST",route);connection.putheader("Authorization","Bearer "+"a"*64)
                connection.putheader("Content-Length",str(len(payload)));connection.putheader("Content-Type","application/json")
                if duplicate=="Content-Type":connection.putheader("Content-Type","application/json")
                else:connection.putheader(duplicate,"[]");connection.putheader(duplicate,"[]")
                connection.endheaders(payload);response=connection.getresponse();self.assertEqual(response.status,400);response.read();connection.close()

    def test_preflight_allows_only_the_new_bounded_units_header(self):
        manager=self.manager();origin="chrome-extension://"+"a"*32
        service=server.create_server(manager,"a"*64,port=0,extension_origin=origin);self.services.append(service)
        threading.Thread(target=service.serve_forever,daemon=True).start()
        for header,expected in (("Authorization, Content-Type, X-AskGPT-Units",204),("Authorization, X-Private-Text",403)):
            connection=http.client.HTTPConnection("127.0.0.1",service.server_address[1],timeout=5)
            connection.request("OPTIONS","/v1/pdf/jobs/"+"b"*32+"/alignment-upgrade",headers={"Origin":origin,"Access-Control-Request-Method":"POST","Access-Control-Request-Headers":header})
            response=connection.getresponse();self.assertEqual(response.status,expected)
            if expected==204:self.assertIn("x-askgpt-units",response.getheader("Access-Control-Allow-Headers"))
            response.read();connection.close()

    def test_cached_status_needs_no_upload_and_reports_no_inflight_page(self):
        manager=self.manager();job=self.install(manager)
        self.install_legacy_sentence_page(manager,job)
        value=manager.read_alignment(job)
        value.update(granularity="sentence",sentenceAlignmentRevision=sentence.SENTENCE_REVISION,sentencePages=[0],
            phraseAlignmentRevision=phrase.PHRASE_REVISION,phrasePages=[0],
            phraseExtractionRevision=phrase.EXTRACTION_REVISION,phraseExtractedPages=[0],phraseCoverage={"0":{"sentences":0,"extractable":0,"aligned":0,"unavailable":0,"sourceTokens":0,"targetTokens":0,"mappedSourceTokens":0,"mappedTargetTokens":0}})
        manager.publish_alignment(job,value)
        with patch.object(NativeHelper,"align",side_effect=AssertionError("GET status called model")):
            result=manager.sentence_upgrades.status(job)
        self.assertEqual(result["state"],"idle")
        self.assertEqual(result["completedPages"],[0])
        self.assertIsNone(result["currentPage"])
        self.assertEqual(result["pendingPages"],[])
        self.assertEqual(set(manager.jobs),{job.id})

    def test_exact_glyph_sentences_have_distinct_rectangles_inside_one_paragraph(self):
        prepared=self.prepared();self.assertEqual(len(prepared),1)
        self.assertEqual([x["text"] for x in prepared[0]["source"]],["First fact binds.","Second fact blocks."])
        a,b=prepared[0]["source"]
        self.assertLess(a["rects"][0][2],b["rects"][0][0])
        self.assertLess(a["rects"][0][2],self.value["pages"][0]["paragraphs"][0]["source"]["rects"][0][2])

    def identity_prepared(self):
        import pymupdf
        page=copy.deepcopy(self.value["pages"][0])
        paragraph=page["paragraphs"][0]
        paragraph["target"]=copy.deepcopy(paragraph["source"])
        with pymupdf.open(self.source) as source:
            return page,sentence.prepare_page(page,source[0],source[0])

    def test_identical_real_glyph_sentences_bypass_semantic_requests(self):
        page,prepared=self.identity_prepared()
        matches=sentence.identity_matches(prepared)
        self.assertEqual(matches,{"p0_0_s0":["p0_0_t0"],"p0_0_s1":["p0_0_t1"]})
        self.assertEqual(sentence.requests_for_page(prepared),[])
        upgraded=sentence.upgrade_page(page,prepared,{})
        self.assertEqual([s["method"] for s in upgraded["paragraphs"][0]["sentences"]],["glyph-identity"]*2)
        for row in upgraded["paragraphs"][0]["sentences"]:
            self.assertEqual(row["source"],row["target"])

    def test_identity_never_uses_casefold_moved_glyphs_or_ambiguous_candidates(self):
        _,prepared=self.identity_prepared()
        for change in ("text","position","duplicate"):
            rows=copy.deepcopy(prepared)
            if change=="text": rows[0]["target"][0]["text"]=rows[0]["target"][0]["text"].upper()
            elif change=="position": rows[0]["target"][0]["rects"][0][1]+=.02
            else:
                duplicate=copy.deepcopy(rows[0]["target"][0]);duplicate["id"]+="_duplicate"
                rows[0]["target"].append(duplicate)
            self.assertEqual(sentence.identity_matches(rows),{},change)
            self.assertEqual(len(sentence.requests_for_page(rows)),1,change)

    def test_identity_validator_requires_exact_text_and_same_real_boxes(self):
        page,prepared=self.identity_prepared()
        value=copy.deepcopy(self.value)
        value["pages"][0]=sentence.upgrade_page(page,prepared,{})
        value.update(granularity="sentence",sentenceAlignmentRevision=sentence.SENTENCE_REVISION,sentencePages=[0])
        alignment.validate_alignment(value,[0,1],2,self.sha)
        for change in ("text","position","count"):
            changed=copy.deepcopy(value);target=changed["pages"][0]["paragraphs"][0]["sentences"][0]["target"]
            if change=="text":target["text"]+=" altered"
            elif change=="position":target["rects"][0][0]+=.02
            else:target["rects"].append(target["rects"][0][:])
            with self.assertRaises(ValueError,msg=change):alignment.validate_alignment(changed,[0,1],2,self.sha)

    def test_preserved_pdf_pages_upgrade_and_restart_without_starting_any_helper(self):
        self.mono.write_bytes(self.source.read_bytes())
        self.dual=self.root/"identity-dual.pdf"
        compose_dual(self.source,self.mono,[0,1],self.dual)
        for page in self.value["pages"]:
            paragraph=page["paragraphs"][0]
            paragraph["target"]=copy.deepcopy(paragraph["source"])
            paragraph["dualTarget"]={"rects":[[r[0]+400,r[1],r[2]+400,r[3]] for r in paragraph["source"]["rects"]]}
        manager=self.manager();job=self.install(manager);service=self.service(manager)
        originals={name:(job.directory/name).read_bytes() for name in ("mono.pdf","dual.pdf")}
        route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade"
        with patch.object(NativeHelper,"_start",side_effect=AssertionError("identity started model helper")):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes(),pages="1,2")[0],202)
            state=self.await_upgrade(service,route)
        self.assertEqual(state["state"],"complete")
        self.assertEqual(state["completedPages"],[0,1])
        upgraded=manager.read_alignment(job)
        rows=[row for page in upgraded["pages"] for p in page["paragraphs"] for row in p["sentences"]]
        self.assertEqual(len(rows),4)
        self.assertTrue(all(row["method"]=="glyph-identity" for row in rows))
        for name,data in originals.items():self.assertEqual((job.directory/name).read_bytes(),data)
        manager.shutdown();restarted=self.manager()
        self.assertEqual(restarted.read_alignment(restarted.get(job.id)),upgraded)
        self.assertFalse(self.calls.exists())

    def test_fuzzy_text_mismatch_never_invents_sentence_boxes(self):
        import pymupdf
        changed=copy.deepcopy(self.value["pages"][0]);changed["paragraphs"][0]["source"]["text"]="unrelated text"
        with pymupdf.open(self.source) as source,pymupdf.open(self.mono) as target:
            self.assertEqual(sentence.prepare_page(changed,source[0],target[0]),[])

    def test_tiny_punctuation_ink_intersection_does_not_capture_adjacent_line_comma(self):
        period=[333.3694,124.444,335.467,136.8548]
        ink=[[333.903,127.6456,334.9334,128.7036]]
        self.assertFalse(sentence._inside(period,ink,[333.3694,127.756]))
        self.assertTrue(sentence._inside(period,ink,[333.3694,127.756],"."))
        comma=[186.451,113.441,188.549,125.852]
        above=[[142.6403,125.3756,330.6138,134.2904]]
        self.assertFalse(sentence._inside(comma,above,[186.451,116.753],","))

    def test_pdf_small_caps_and_encoded_hyphen_anchor_normalization_keeps_text_exact(self):
        self.assertEqual(sentence._normal("Read-based DNA"),sentence._normal("READ\u2010BASED DNA"))
        self.assertNotEqual(sentence._normal("activates"),sentence._normal("inactivates"))

    def test_abbreviations_decimal_urls_and_chinese_sentence_boundaries(self):
        text="Fig. 2 shows 3.14 units. Dr. Smith agrees. 中文一句。中文两句！"
        self.assertEqual([text[a:b] for a,b in sentence.sentence_ranges(text)],
            ["Fig. 2 shows 3.14 units.","Dr. Smith agrees.","中文一句。","中文两句！"])
        url="See https://doi.org/10.1101/gr.279617.124 for detail. Next fact."
        self.assertEqual(len(sentence.sentence_ranges(url)),2)
        clause="原文保持不变；译文仅提供对应ID。"
        self.assertEqual([clause[a:b] for a,b in sentence.sentence_ranges(clause)],
            ["原文保持不变；","译文仅提供对应ID。"])

    def test_invalid_paragraph_cannot_be_cached_as_a_semantic_refusal(self):
        good=sentence.requests_for_page(self.prepared())[0][0]
        bad=copy.deepcopy(good);bad["id"]="ambiguous"
        for side in ("source","target"):
            for row in bad[side]:row["id"]="bad_"+row["id"]
        class Helper:
            def align(self,request):
                if any(p["id"]=="ambiguous" for p in request):raise ProtocolFailure("alignment_invalid")
                return {row["id"]:[p["target"][-1-i]["id"]] for p in request for i,row in enumerate(p["source"])}
        manager=self.manager();state=SimpleNamespace(cancelled=threading.Event())
        with self.assertRaises(ProtocolFailure):manager.sentence_upgrades._align_request(Helper(),[good,bad],state)

    def test_ambiguous_page_has_four_call_budget_then_fails_without_guessing(self):
        base=sentence.requests_for_page(self.prepared())[0][0];request=[]
        for index in range(17):
            row=copy.deepcopy(base);row["id"]=f"paragraph{index}"
            for side in ("source","target"):
                for item in row[side]:item["id"]=f"p{index}_"+item["id"]
            request.append(row)
        calls=[]
        class Helper:
            def align(self,request):calls.append(len(request));raise ProtocolFailure("alignment_invalid")
        manager=self.manager();state=SimpleNamespace(cancelled=threading.Event())
        with self.assertRaises(ProtocolFailure):manager.sentence_upgrades._align_request(Helper(),request,state)
        self.assertEqual(len(calls),4)
        budget={"calls":0,"deadline":time.monotonic()-1}
        with self.assertRaises(ProtocolFailure):manager.sentence_upgrades._align_request(Helper(),request,state,budget)
        self.assertEqual(len(calls),4)

    def test_helper_semantic_ids_can_reorder_equal_sentence_counts(self):
        prepared=self.prepared();request=sentence.requests_for_page(prepared)[0]
        with NativeHelper(self.helper,"en","zh-Hans") as helper: matches=helper.align(request)
        result=sentence.upgrade_page(self.value["pages"][0],prepared,matches)
        first=result["paragraphs"][0]["sentences"][0]
        self.assertEqual(first["source"]["text"],"First fact binds.")
        self.assertEqual(first["target"]["text"],"Binding happens.")
        self.assertGreater(first["target"]["rects"][0][0],result["paragraphs"][0]["sentences"][1]["target"]["rects"][0][0])

    def test_invalid_cross_paragraph_missing_ids_and_many_to_many_fail(self):
        prepared=self.prepared();request=sentence.requests_for_page(prepared)[0];p=request[0]
        s=[x["id"] for x in p["source"]];t=[x["id"] for x in p["target"]]
        for value in [{s[0]:[t[0]]},{s[0]:["other_t0"],s[1]:[]},
                {s[0]:t,s[1]:[t[0]]},{s[0]:list(reversed(t)),s[1]:[]}]:
            with self.subTest(value=value),self.assertRaises(ProtocolFailure): sentence.validate_matches(value,request)
        self.assertEqual(sentence.validate_matches({s[0]:[t[0]],s[1]:[t[0]]},request),{s[0]:[t[0]],s[1]:[t[0]]})

    def test_http_upgrade_changes_only_sidecar_then_restart_and_repeat_use_it_without_model(self):
        manager=self.manager();job=self.install(manager);service=self.service(manager)
        original={x:(job.directory/x).read_bytes() for x in ("mono.pdf","dual.pdf")}
        route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade"
        self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
        state=self.await_upgrade(service,route);self.assertEqual(state["state"],"complete")
        self.assertEqual(state["completedPages"],[0]);self.assertEqual(state["mappedSentences"],2)
        upgraded=manager.read_alignment(job)
        self.assertEqual(upgraded["granularity"],"sentence");self.assertEqual(upgraded["sentencePages"],[0])
        self.assertEqual(upgraded["phrasePages"],[0]);self.assertEqual(upgraded["phraseAlignmentRevision"],phrase.PHRASE_REVISION)
        units=[u for p in upgraded["pages"][0]["paragraphs"] for s in p["sentences"] for u in s["phrases"]]
        self.assertEqual([(u["source"]["text"],u["target"]["text"]) for u in units],[("binds","Binding"),("blocks","Blocking")])
        for name,data in original.items(): self.assertEqual((job.directory/name).read_bytes(),data)
        self.assertEqual(job.cache_info["cacheKey"],server._cache_key(self.sha,[0,1],2,"en","zh-Hans",manager.translation_revision))
        self.assertTrue(job.cache_info["alignmentFile"].startswith("alignment-"))
        manager.shutdown()
        self.assertEqual([p.name for p in manager.jobs_root.iterdir()],[job.id])
        restarted=self.manager();second=self.service(restarted)
        self.assertEqual(restarted.read_alignment(restarted.get(job.id)),upgraded)
        calls=self.calls.read_bytes()
        with patch.object(NativeHelper,"align",side_effect=AssertionError("already aligned page called model")):
            status,raw=self.request(second,"POST",route,self.source.read_bytes())
        self.assertEqual(status,202);self.assertEqual(json.loads(raw)["state"],"complete")
        self.assertEqual(self.calls.read_bytes(),calls)
        placeholder=restarted.begin()
        (placeholder.directory/"input.pdf").write_bytes(self.source.read_bytes());(placeholder.directory/"input.pdf").chmod(0o600)
        with patch.object(server.subprocess,"Popen",side_effect=AssertionError("sentence range started translation")):
            result=restarted.submit(placeholder,"1","en","zh-Hans")
        derived=restarted.read_alignment(restarted.get(result["id"]))
        self.assertEqual(derived["sentencePages"],[0]);self.assertEqual(derived["sourcePages"],[0])
        self.assertEqual(derived["phrasePages"],[0])
        self.assertEqual(derived["pages"][0]["paragraphs"],upgraded["pages"][0]["paragraphs"])

    def install_legacy_sentence_page(self,manager,job):
        value=manager.read_alignment(job)
        prepared=self.prepared()
        value["pages"][0]=sentence.upgrade_page(value["pages"][0],prepared,
            {"p0_0_s0":["p0_0_t1"],"p0_0_s1":["p0_0_t0"]})
        for paragraph in value["pages"][0]["paragraphs"]:
            for row in paragraph["sentences"]:
                for name in ("source","target"):row[name].pop("glyphs",None)
        value.update(granularity="sentence",sentenceAlignmentRevision=sentence.SENTENCE_REVISION,sentencePages=[0])
        manager.publish_alignment(job,value)
        return value

    def test_legacy_sentence_cache_gets_only_word_metadata_without_retranslation(self):
        manager=self.manager();job=self.install(manager)
        original=self.install_legacy_sentence_page(manager,job)
        service=self.service(manager);route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade"
        pdfs={name:(job.directory/name).read_bytes() for name in ("mono.pdf","dual.pdf")}
        self.assertEqual(manager.sentence_upgrades.status(job)["completedPages"],[])
        with patch.object(NativeHelper,"align",side_effect=AssertionError("legacy sentence repeated GPT")), \
                patch.object(NativeHelper,"translate_batch",side_effect=AssertionError("word metadata retranslated PDF")):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
            result=self.await_upgrade(service,route)
        self.assertEqual(result["state"],"complete")
        value=manager.read_alignment(job);self.assertEqual(value["phrasePages"],[0])
        self.assertEqual(value["sentencePages"],original["sentencePages"])
        self.assertEqual([x["id"] for x in value["pages"][0]["paragraphs"][0]["sentences"]],
            [x["id"] for x in original["pages"][0]["paragraphs"][0]["sentences"]])
        for name,data in pdfs.items():self.assertEqual((job.directory/name).read_bytes(),data)

    def test_old_ready_page_repairs_only_missing_glyph_units_and_preserves_cached_pdf_and_verified_words(self):
        import pymupdf
        manager=self.manager();job=self.install(manager)
        value=self.install_legacy_sentence_page(manager,job)
        with pymupdf.open(self.source) as source,pymupdf.open(self.mono) as mono:
            words=phrase.prepare_phrase_page(value["pages"][0],source[0],mono[0])
        first=words[0]
        s=next(t for t in first["source"] if t["text"]=="binds")
        t=next(t for t in first["target"] if t["text"]=="Binding")
        value["pages"][0]=phrase.upgrade_phrase_page(value["pages"][0],words,{first["id"]:[{"sourceIDs":[s["id"]],"targetIDs":[t["id"]]}]})
        value.update(phraseAlignmentRevision=phrase.PHRASE_REVISION,phrasePages=[0])
        manager.publish_alignment(job,value)
        self.assertEqual(manager.sentence_upgrades.status(job)["completedPages"],[])
        original=copy.deepcopy(value["pages"][0]["paragraphs"][0]["sentences"][0])
        pdfs={name:(job.directory/name).read_bytes() for name in ("mono.pdf","dual.pdf")}
        service=self.service(manager);route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade"
        calls=[];real=NativeHelper.align_phrases
        def capture(helper,units):
            calls.append([u["id"] for u in units]);return real(helper,units)
        with patch.object(NativeHelper,"align",side_effect=AssertionError("sentence was already aligned")),patch.object(NativeHelper,"align_phrases",capture):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
            self.assertEqual(self.await_upgrade(service,route)["state"],"complete")
        self.assertEqual(calls,[[words[1]["id"]]])
        updated=manager.read_alignment(job)
        self.assertEqual(updated["pages"][0]["paragraphs"][0]["sentences"][0],original)
        self.assertEqual(updated["phraseExtractionRevision"],phrase.EXTRACTION_REVISION)
        self.assertEqual(updated["phraseExtractedPages"],[0])
        self.assertEqual(updated["phraseCoverage"]["0"]["aligned"],2)
        for name,data in pdfs.items():self.assertEqual((job.directory/name).read_bytes(),data)
        with patch.object(NativeHelper,"align_phrases",side_effect=AssertionError("ready page repeated model")):
            self.assertEqual(json.loads(self.request(service,"POST",route,self.source.read_bytes())[1])["state"],"complete")

    def test_word_model_failure_preserves_legacy_sentence_sidecar_and_pdf(self):
        manager=self.manager();job=self.install(manager)
        original=self.install_legacy_sentence_page(manager,job)
        service=self.service(manager);route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade"
        pdfs={name:(job.directory/name).read_bytes() for name in ("mono.pdf","dual.pdf")}
        with patch.object(NativeHelper,"align_phrases",side_effect=ProtocolFailure("gpt_unavailable")):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
            result=self.await_upgrade(service,route)
        self.assertEqual(result["state"],"failed");self.assertEqual(result["error"],"gpt_unavailable")
        self.assertEqual(manager.read_alignment(job),original)
        for name,data in pdfs.items():self.assertEqual((job.directory/name).read_bytes(),data)

    def test_cancelled_word_upgrade_cannot_publish_late_model_result(self):
        manager=self.manager();job=self.install(manager)
        original=self.install_legacy_sentence_page(manager,job)
        service=self.service(manager);route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade"
        entered=threading.Event();release=threading.Event()
        def delayed(helper,request):
            entered.set();release.wait(3)
            return {unit["id"]:[] for unit in request}
        with patch.object(NativeHelper,"align_phrases",delayed):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
            self.assertTrue(entered.wait(2))
            manager.sentence_upgrades.upgrades[job.id].cancelled.set();release.set()
            result=self.await_upgrade(service,route)
        self.assertEqual(result["state"],"failed");self.assertEqual(result["error"],"alignment_cancelled")
        self.assertEqual(manager.read_alignment(job),original)

    def test_sentence_budget_cannot_mark_unattempted_words_complete(self):
        manager=self.manager();job=self.install(manager);service=self.service(manager)
        route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade"
        def consumed(service,helper,request,upgrade,budget):
            budget.update(calls=4,deadline=time.monotonic()-1)
            return {"p0_0_s0":["p0_0_t1"],"p0_0_s1":["p0_0_t0"]}
        with patch("sentence_service.SentenceUpgradeService._align_request",consumed):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
            result=self.await_upgrade(service,route)
        self.assertEqual(result["state"],"complete")
        value=manager.read_alignment(job)
        words=[word for p in value["pages"][0]["paragraphs"] for row in p["sentences"] for word in row["phrases"]]
        self.assertEqual([(w["source"]["text"],w["target"]["text"]) for w in words],[("binds","Binding"),("blocks","Blocking")])

    def test_new_sentence_results_survive_word_timeout_and_retry_skips_sentence_model(self):
        manager=self.manager();job=self.install(manager);service=self.service(manager)
        route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade"
        with patch.object(NativeHelper,"align_phrases",side_effect=ProtocolFailure("alignment_timeout")):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
            result=self.await_upgrade(service,route)
        self.assertEqual(result["state"],"failed");self.assertEqual(result["error"],"alignment_timeout")
        value=manager.read_alignment(job);self.assertEqual(value["sentencePages"],[0])
        self.assertNotIn(0,value.get("phrasePages",[]))
        self.assertEqual(len(value["pages"][0]["paragraphs"][0]["sentences"]),2)
        with patch.object(NativeHelper,"align",side_effect=AssertionError("word retry repeated sentence model")):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
            result=self.await_upgrade(service,route)
        self.assertEqual(result["state"],"complete");self.assertEqual(result["completedPages"],[0])

    def test_successful_word_batch_survives_later_timeout_and_retry_only_requests_missing_words(self):
        manager=self.manager();job=self.install(manager)
        self.install_legacy_sentence_page(manager,job)
        service=self.service(manager);route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade"
        pdfs={name:(job.directory/name).read_bytes() for name in ("mono.pdf","dual.pdf")}
        original_requests=phrase.phrase_requests;real=NativeHelper.align_phrases;calls=[]
        def split(units):return [part for unit in units for part in original_requests([unit])]
        def later_timeout(helper,request):
            calls.append([unit["id"] for unit in request])
            if len(calls)==2:raise ProtocolFailure("alignment_timeout")
            return real(helper,request)
        with patch("sentence_service.phrase_requests",split),patch.object(NativeHelper,"align_phrases",later_timeout):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
            result=self.await_upgrade(service,route)
        self.assertEqual(result["state"],"failed")
        saved=manager.read_alignment(job);rows=saved["pages"][0]["paragraphs"][0]["sentences"]
        self.assertEqual(rows[0]["phrases"][0]["source"]["text"],"binds")
        self.assertNotIn(0,saved.get("phraseExtractedPages",[]),"a partial page must never be marked ready")
        verified=copy.deepcopy(rows[0]);calls.clear()
        def capture(helper,request):calls.append([unit["id"] for unit in request]);return real(helper,request)
        with patch("sentence_service.phrase_requests",split),patch.object(NativeHelper,"align_phrases",capture), \
                patch.object(NativeHelper,"align",side_effect=AssertionError("retry repeated sentence GPT")):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
            self.assertEqual(self.await_upgrade(service,route)["state"],"complete")
        self.assertEqual(calls,[[rows[1]["id"]]])
        self.assertEqual(manager.read_alignment(job)["pages"][0]["paragraphs"][0]["sentences"][0],verified)
        for name,data in pdfs.items():self.assertEqual((job.directory/name).read_bytes(),data)

    def test_independent_valid_word_batches_do_not_share_the_previous_batch_repair_budget(self):
        manager=self.manager();job=self.install(manager);self.install_legacy_sentence_page(manager,job)
        service=self.service(manager);route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade"
        original_requests=phrase.phrase_requests
        from sentence_service import SentenceUpgradeService
        real=SentenceUpgradeService._align_phrase_request;calls=[]
        def split(units):return [part for unit in units for part in original_requests([unit])]
        def consumed(service,helper,request,upgrade,budget):
            result=real(service,helper,request,upgrade,budget);calls.append(budget)
            budget.update(calls=4,deadline=time.monotonic()-1)
            return result
        with patch("sentence_service.phrase_requests",split),patch.object(SentenceUpgradeService,"_align_phrase_request",consumed):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
            result=self.await_upgrade(service,route)
        self.assertEqual(result["state"],"complete")
        self.assertEqual(len(calls),2);self.assertIsNot(calls[0],calls[1])

    def test_word_budget_and_invalid_single_response_are_failures_not_semantic_refusals(self):
        from sentence_service import SentenceUpgradeService
        state=SimpleNamespace(cancelled=threading.Event())
        request=[{"id":"p0_0_s0","sourceText":"Gene","targetText":"基因",
            "source":[{"id":"a0","text":"Gene"}],"target":[{"id":"b0","text":"基"},{"id":"b1","text":"因"}]}]
        class Helper:
            batch_timeout=100
            def align_phrases(self,request):raise ProtocolFailure("alignment_invalid")
        helper=Helper();service=SentenceUpgradeService(None)
        for budget in ({"calls":4,"deadline":time.monotonic()+10},{"calls":0,"deadline":time.monotonic()-1},
                {"calls":0,"deadline":time.monotonic()+10}):
            with self.subTest(budget=budget),self.assertRaises(ProtocolFailure):service._align_phrase_request(helper,request,state,budget)
        self.assertEqual(helper.batch_timeout,100)
        helper.align_phrases=lambda request:{"p0_0_s0":[]}
        self.assertEqual(service._align_phrase_request(helper,request,state,{"calls":0,"deadline":time.monotonic()+10}),{"p0_0_s0":[]})

    def test_alignment_diagnostics_distinguish_deadline_and_call_budget_without_text(self):
        from sentence_service import SentenceUpgradeService
        service=SentenceUpgradeService(None);state=SimpleNamespace(cancelled=threading.Event())
        for budget,detail in (({"calls":4,"deadline":time.monotonic()+10},"call_budget"),
                ({"calls":0,"deadline":time.monotonic()-1},"deadline")):
            with self.assertRaises(ProtocolFailure) as caught:service._align_phrase_request(None,[],state,budget)
            self.assertEqual(caught.exception.error_detail,detail)

    def test_running_phrase_phase_reports_bounded_batch_calls_and_validation_reason(self):
        manager=self.manager();job=self.install(manager);self.install_legacy_sentence_page(manager,job)
        service=self.service(manager);route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade";observed=[]
        def failed(helper,request):
            observed.append(manager.sentence_upgrades.status(job))
            failure=ProtocolFailure("alignment_invalid");failure.error_detail="rowShape";raise failure
        with patch.object(NativeHelper,"align_phrases",failed):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
            result=self.await_upgrade(service,route)
        self.assertEqual(result["state"],"failed");self.assertEqual(result["phase"],"phrase")
        self.assertEqual((result["batch"],result["batches"]),(1,1))
        self.assertEqual(result["errorDetail"],"rowShape")
        self.assertTrue(observed);self.assertEqual(observed[0]["calls"],1)
        self.assertTrue(all(set(row)<={"id","state","sourcePages","completedPages","mappedSentences","currentPage","pendingPages","alignmentVersion","phase","batch","batches","calls","error","errorDetail"} for row in observed))

    def test_omitted_translated_paragraph_retains_successful_words_without_false_page_readiness(self):
        manager=self.manager();job=self.install(manager);value=manager.read_alignment(job)
        missing=copy.deepcopy(value["pages"][0]["paragraphs"][0]);missing["id"]="p0_99"
        missing["source"]["text"]="A missing factual paragraph.";missing["target"]["text"]="Unextracted translation."
        value["pages"][0]["paragraphs"].append(missing);manager.publish_alignment(job,value)
        service=self.service(manager);route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade"
        self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202);result=self.await_upgrade(service,route)
        self.assertEqual(result["state"],"failed");self.assertEqual(result["error"],"alignment_unavailable")
        self.assertEqual(result["errorDetail"],"sentence_coverage")
        saved=manager.read_alignment(job);self.assertNotIn(0,saved.get("phraseExtractedPages",[]))
        self.assertTrue(saved["pages"][0]["paragraphs"][0]["sentences"][0]["phrases"])
        self.assertEqual(saved["pages"][0]["paragraphs"][1]["sentences"],[])

    def test_sentence_timeout_preserves_pdf_and_cannot_mark_metadata_complete(self):
        manager=self.manager();job=self.install(manager);service=self.service(manager)
        original=manager.read_alignment(job);route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade"
        with patch.object(NativeHelper,"align",side_effect=ProtocolFailure("alignment_timeout")), \
                patch.object(NativeHelper,"align_phrases",side_effect=AssertionError("no semantic sentence anchors")):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
            result=self.await_upgrade(service,route)
        self.assertEqual(result["state"],"failed");self.assertEqual(result["error"],"alignment_timeout")
        self.assertEqual(result["completedPages"],[]);self.assertEqual(manager.read_alignment(job),original)

    def test_explicit_sentence_refusal_has_no_false_word_readiness_or_word_model_retry(self):
        manager=self.manager();job=self.install(manager);service=self.service(manager)
        route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade"
        def refusal(helper,request):return {s["id"]:[] for p in request for s in p["source"]}
        with patch.object(NativeHelper,"align",refusal), \
                patch.object(NativeHelper,"align_phrases",side_effect=AssertionError("empty semantic set invented words")):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
            result=self.await_upgrade(service,route)
        self.assertEqual(result["state"],"failed");self.assertEqual(result["completedPages"],[])
        self.assertEqual(result["errorDetail"],"sentence_coverage")
        value=manager.read_alignment(job);self.assertEqual(value["phrasePages"],[0])
        self.assertEqual(value["pages"][0]["paragraphs"][0]["sentences"],[])
        with patch.object(NativeHelper,"align",side_effect=AssertionError("explicit refusal retried forever")):
            self.assertEqual(self.request(service,"POST",route,self.source.read_bytes())[0],202)
            result=self.await_upgrade(service,route)
        self.assertEqual(result["state"],"failed")

    def test_auth_source_sha_and_page_scope_precede_any_model(self):
        manager=self.manager();job=self.install(manager);service=self.service(manager)
        route=f"/v1/pdf/jobs/{job.id}/alignment-upgrade"
        for body,pages,token,status in [(self.source.read_bytes(),"1","b"*64,401),
                (self.source.read_bytes()+b"\n% changed","1","a"*64,400),
                (self.source.read_bytes(),"3","a"*64,400)]:
            self.assertEqual(self.request(service,"POST",route,body,pages,token)[0],status)
        self.assertFalse(self.calls.exists());self.assertEqual(len(manager.jobs),1)

    def test_metadata_commit_failure_keeps_original_sidecar_and_pdf_cache_usable(self):
        manager=self.manager();job=self.install(manager)
        value=copy.deepcopy(self.value);value.update(granularity="sentence",sentenceAlignmentRevision=sentence.SENTENCE_REVISION,sentencePages=[])
        original=manager.read_alignment(job);real_atomic=server.atomic_json
        def fail_metadata(path,value):
            if path.name=="cache.json": raise OSError("simulated metadata interruption")
            return real_atomic(path,value)
        with patch.object(server,"atomic_json",side_effect=fail_metadata):
            with self.assertRaises(OSError): manager.publish_alignment(job,value)
        self.assertEqual(manager.read_alignment(job),original)
        manager.shutdown();restarted=self.manager()
        self.assertEqual(restarted.read_alignment(restarted.get(job.id)),original)


if __name__=="__main__":unittest.main()
