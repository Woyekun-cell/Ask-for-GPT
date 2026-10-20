"""Bounded page I/O concurrency; no model calls or document cache mutations."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
import json
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from layout_common import ProtocolFailure

try:
    from page_parallel import NativeHelperPool, parallel_page_translation
except ImportError:
    NativeHelperPool=parallel_page_translation=None


class PageParallelTests(unittest.TestCase):
    def engine(self, callback, abort=lambda:None):
        class Base:
            def translate(self,document):
                self.docs=document
                # Upstream creates this single-thread paragraph executor. Our
                # page adapter must not change its configuration or other stages.
                with ThreadPoolExecutor(max_workers=1) as executor:
                    for page in document.page:self.process_page(page,executor,None,object())
                self.upstream_completed_count=sum(hasattr(page,'output') for page in document.page)
            def process_page(self,page,executor,pbar,tracker):callback(page)
        high=SimpleNamespace(ILTranslator=Base)
        instance_config=SimpleNamespace(raise_if_cancelled=lambda:None,pool_max_workers=1)
        return high,Base,instance_config,SimpleNamespace(abort_page_batches=abort)

    def test_four_pages_overlap_and_keep_identical_results_to_two_workers(self):
        outputs={}
        for count in (2,4):
            gate=threading.Event();lock=threading.Lock();started=[]
            def process(page):
                with lock:started.append(page.page_number)
                self.assertTrue(gate.wait(3))
                page.output={'id':page.page_number,'text':'译文 '+page.text,'anchors':['{v1}']}
            high,original,config,engine=self.engine(process)
            doc=SimpleNamespace(page=[SimpleNamespace(page_number=i,text=f'page{i} {{v1}}')for i in range(12)])
            with parallel_page_translation(high,count):
                instance=high.ILTranslator();instance.translation_config=config;instance.translate_engine=engine
                with ThreadPoolExecutor(1)as caller:
                    future=caller.submit(instance.translate,doc)
                    try:
                        until=time.monotonic()+3
                        while len(started)<count and time.monotonic()<until:time.sleep(.005)
                        self.assertEqual(started,list(range(count)))
                        self.assertEqual(config.pool_max_workers,1)
                    finally:gate.set()
                    future.result(3)
            self.assertIs(high.ILTranslator,original)
            outputs[count]=[page.output for page in doc.page]
        self.assertEqual(outputs[2],outputs[4])

    def test_two_pages_overlap_with_bounded_pending_work_and_keep_page_results(self):
        self.assertIsNotNone(parallel_page_translation)
        lock=threading.Lock();gate=threading.Event();started=[];active=maximum=0
        def process(page):
            nonlocal active,maximum
            with lock:started.append(page.page_number);active+=1;maximum=max(maximum,active)
            self.assertTrue(gate.wait(3));time.sleep(.01 if page.page_number%2 else .03)
            page.output=page.text
            with lock:active-=1
        high,original,config,engine=self.engine(process)
        doc=SimpleNamespace(page=[SimpleNamespace(page_number=i,text=f"page{i}") for i in range(6)])
        with parallel_page_translation(high,2):
            instance=high.ILTranslator();instance.translation_config=config;instance.translate_engine=engine
            with ThreadPoolExecutor(max_workers=1) as caller:
                future=caller.submit(instance.translate,doc)
                deadline=time.monotonic()+3
                while len(started)<2 and time.monotonic()<deadline:time.sleep(.005)
                self.assertEqual(started,[0,1]);self.assertEqual(config.pool_max_workers,1)
                gate.set();future.result(3)
        self.assertIs(high.ILTranslator,original)
        self.assertEqual(maximum,2)
        self.assertEqual(instance.upstream_completed_count,6,"upstream stage must stay open until all page applies finish")
        self.assertEqual([p.output for p in doc.page],[f"page{i}" for i in range(6)])

    def test_first_failure_stops_new_pages_and_aborts_only_its_helper_pool(self):
        self.assertIsNotNone(parallel_page_translation)
        entered=threading.Event();released=threading.Event();seen=[];aborts=[]
        failure=ProtocolFailure("batch_invalid");failure.error_detail="formula";failure.page_index=0
        def process(page):
            seen.append(page.page_number)
            if page.page_number==0:
                self.assertTrue(entered.wait(3));raise failure
            entered.set();self.assertTrue(released.wait(3))
        def abort():aborts.append(True);released.set()
        high,original,config,engine=self.engine(process,abort)
        with parallel_page_translation(high,2):
            instance=high.ILTranslator();instance.translation_config=config;instance.translate_engine=engine
            with self.assertRaises(ProtocolFailure) as result:
                instance.translate(SimpleNamespace(page=[SimpleNamespace(page_number=i) for i in range(5)]))
        self.assertIs(result.exception,failure)
        self.assertEqual(seen,[0,1]);self.assertEqual(aborts,[True])
        self.assertIs(high.ILTranslator,original)

    def test_helper_pool_uses_distinct_clients_and_never_crosses_response_pages(self):
        self.assertIsNotNone(NativeHelperPool)
        gate=threading.Barrier(2);clients=[]
        class Helper:
            def __init__(self):self.closed=False;self.calls=0;clients.append(self)
            def __enter__(self):return self
            def __exit__(self,*args):self.closed=True
            def translate_batch(self,rows):
                self.calls+=1;gate.wait(3)
                return [{"id":r["id"],"text":"translated "+r["text"]} for r in rows]
        with NativeHelperPool(Helper,2) as helpers:
            with ThreadPoolExecutor(max_workers=2) as caller:
                futures=[caller.submit(helpers.translate_batch,[{"id":"p0","text":f"page{i}"}]) for i in range(2)]
                self.assertEqual([f.result(3)[0]["text"] for f in futures],["translated page0","translated page1"])
        self.assertEqual(len(clients),2);self.assertTrue(all(c.calls==1 and c.closed for c in clients))

    def test_closing_one_helper_pool_does_not_close_another_document(self):
        self.assertIsNotNone(NativeHelperPool)
        class Helper:
            def __init__(self):self.closed=False
            def __enter__(self):return self
            def __exit__(self,*args):self.closed=True
            def translate_batch(self,rows):
                if self.closed:raise AssertionError("other document was closed")
                return rows
        with NativeHelperPool(Helper,2) as first,NativeHelperPool(Helper,2) as second:
            first.close()
            self.assertEqual(second.translate_batch([{"id":"p0","text":"other paper"}])[0]["text"],"other paper")
            with self.assertRaises(ProtocolFailure):first.translate_batch([{"id":"p0","text":"cancelled"}])

    def test_real_jsonl_helpers_overlap_and_close_without_crossing_page_ids(self):
        from worker import NativeHelper
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);executable=root/"helper"
            executable.write_text("#!/usr/bin/env python3\nimport json,os,pathlib,sys,time\n"
                "assert sys.argv[1:]==['--gpt-batch']\n"
                f"root=pathlib.Path({str(root)!r})\n"
                "for line in sys.stdin:\n r=json.loads(line)\n"
                " (root/('entered-'+str(os.getpid()))).write_text('started')\n"
                " while not (root/'release').exists():time.sleep(.005)\n"
                " print(json.dumps({'id':r['id'],'translations':[{'id':x['id'],'text':'translated '+x['text']} for x in r['segments']]}),flush=True)\n")
            executable.chmod(0o700);clients=[]
            def factory():
                helper=NativeHelper(executable,"en","zh-Hans",batch_timeout=5);clients.append(helper);return helper
            with NativeHelperPool(factory,2) as helpers,ThreadPoolExecutor(max_workers=2) as caller:
                futures=[caller.submit(helpers.translate_batch,[{"id":"p0","text":f"page{i} {{v1}}"}]) for i in range(12)]
                try:
                    deadline=time.monotonic()+3
                    while len(list(root.glob('entered-*')))<2 and time.monotonic()<deadline:time.sleep(.005)
                    self.assertEqual(len(list(root.glob('entered-*'))),2,"both real helpers must be in flight")
                finally:(root/"release").touch()
                self.assertEqual([f.result(3)[0]['text'] for f in futures],[f"translated page{i} {{v1}}" for i in range(12)])
                self.assertEqual(len(list(root.glob('entered-*'))),2,"twelve pages must reuse only two native child processes")
            self.assertTrue(all(client.process is None for client in clients))

    def test_normal_close_allows_retry_but_pool_cancel_is_final(self):
        from worker import NativeHelper
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'helper'
            path.write_text("#!/usr/bin/env python3\nimport json,sys\nfor line in sys.stdin:\n r=json.loads(line)\n"
                " print(json.dumps({'id':r['id'],'translations':r['segments']}),flush=True)\n")
            path.chmod(0o700)
            with NativeHelper(path,'en','zh-Hans') as helper:
                rows=[{'id':'p0','text':'source text'}]
                self.assertEqual(helper.translate_batch(rows),rows);first=helper.process.pid
                helper.close();self.assertIsNone(helper.process)
                self.assertEqual(helper.translate_batch(rows),rows)
                self.assertNotEqual(helper.process.pid,first)
                helper.cancel();self.assertIsNone(helper.process)
                with self.assertRaisesRegex(ProtocolFailure,'gpt_unavailable'):helper.translate_batch(rows)

    def test_pool_abort_cannot_miss_a_helper_in_the_middle_of_starting(self):
        from worker import NativeHelper
        import worker
        entered=threading.Event();release=threading.Event();cancelled=threading.Event();handles=[]
        class Handle:
            def __init__(self):self.closed=False;handles.append(self)
            def close(self):self.closed=True
        process=SimpleNamespace(stdin=Handle(),stdout=Handle(),poll=lambda:0)
        def spawn(*args,**kwargs):
            entered.set();self.assertTrue(release.wait(3));return process
        helper=NativeHelper(Path('/not-executed'),"en","zh-Hans")
        with patch.object(worker.subprocess,'Popen',side_effect=spawn) as popen,\
                NativeHelperPool(lambda:helper,1) as helpers,ThreadPoolExecutor(max_workers=2) as caller:
            start=caller.submit(helper._start,batch=True)
            self.assertTrue(entered.wait(3))
            def abort():helpers.close();cancelled.set()
            aborting=caller.submit(abort)
            try:
                self.assertFalse(cancelled.wait(.05),"abort must join the in-flight process installation")
            finally:release.set()
            start.result(3);aborting.result(3)
            self.assertIsNone(helper.process);self.assertTrue(all(h.closed for h in handles))
            with self.assertRaises(ProtocolFailure):helper._start(batch=True)
            self.assertEqual(popen.call_count,1,"an aborted helper must never restart")

    def test_parallel_page_failure_records_one_atomic_diagnostic_tuple(self):
        from gpt_batch import page_translator_class
        class OwnedLock:
            def __init__(self):self.lock=threading.Lock();self.owner=None;self.entries=0
            def __enter__(self):
                self.lock.acquire();self.owner=threading.get_ident();self.entries+=1
            def __exit__(self,*args):self.owner=None;self.lock.release()
        class Engine(SimpleNamespace):
            def __setattr__(self,key,value):
                if (getattr(self,'watch',False) and key.startswith('fatal_')
                        and self.error_lock.owner!=threading.get_ident()):self.unprotected.append(key)
                super().__setattr__(key,value)
        gate=threading.Barrier(2)
        def fail(segments):
            gate.wait(3)
            failure=ProtocolFailure('batch_invalid')
            failure.error_detail='formula' if segments[0]['text']=='page zero' else 'count'
            raise failure
        engine=Engine(batch_translate=fail,fatal_error=None,fatal_error_detail=None,
                      fatal_page_index=None,error_lock=OwnedLock(),watch=True,unprotected=[])
        cls=page_translator_class();translator=cls.__new__(cls)
        translator.translate_engine=engine
        translator.translation_config=SimpleNamespace(raise_if_cancelled=lambda:None)
        translator.pre_translate_paragraph=lambda p,*args:(p.unicode,p.unicode)
        translator.post_translate_paragraph=lambda *args:None
        pages=[SimpleNamespace(page_number=i,pdf_font=[],pdf_xobject=[],
            pdf_paragraph=[SimpleNamespace(unicode=text)]) for i,text in enumerate(['page zero','page one'])]
        with ThreadPoolExecutor(2) as executor:
            futures=[executor.submit(translator.process_page,p,None,None,
                SimpleNamespace(new_paragraph=lambda:object())) for p in pages]
            for future in futures:
                with self.assertRaisesRegex(ProtocolFailure,'batch_invalid'):future.result(3)
        self.assertEqual(engine.unprotected,[],"all fatal diagnostic writes must hold the same engine lock")
        self.assertEqual(engine.error_lock.entries,2)
        self.assertIn((engine.fatal_error,engine.fatal_error_detail,engine.fatal_page_index),
                      [('batch_invalid','formula',0),('batch_invalid','count',1)])


if __name__=="__main__":unittest.main()
