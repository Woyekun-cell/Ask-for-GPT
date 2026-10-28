"""Explicit full-translation intent survives reader/service lifetime; no remote model."""
import hashlib
import io
import json
import os
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import test_sentence_alignment as fixtures
from worker import NativeHelper
from layout_common import ProtocolFailure


class AlignmentWorkTests(unittest.TestCase):
    for _name in ('setUp','tearDown','manager','install','service','request','prepared'):
        locals()[_name]=getattr(fixtures.SentenceAlignmentTests,_name)

    def post_work(self,service,job,headers=None):
        return self.request(service,'POST',f'/v1/pdf/jobs/{job.id}/alignment-work',self.source.read_bytes(),extra_headers={'X-AskGPT-Full-Translation':'1',**(headers or {})})

    def get_work(self,service,job):
        status,raw=self.request(service,'GET',f'/v1/pdf/jobs/{job.id}/alignment-work');self.assertEqual(status,200);return json.loads(raw)

    def wait_work(self,service,job):
        until=time.monotonic()+10
        while time.monotonic()<until:
            value=self.get_work(service,job)
            if value['state']!='running':return value
            time.sleep(.02)
        self.fail('durable work did not settle')

    def test_get_and_imported_or_current_page_operations_never_create_full_translation_intent(self):
        manager=self.manager();job=self.install(manager);service=self.service(manager)
        with patch.object(NativeHelper,'align',side_effect=AssertionError('read/import started model')):
            value=self.get_work(service,job);self.assertFalse(value['eligible']);self.assertFalse(value['durable']);self.assertEqual(value['workState'],'unregistered')
            for flag in (None,'0','true'):
                headers={} if flag is None else {'X-AskGPT-Full-Translation':flag}
                code,_=self.request(service,'POST',f'/v1/pdf/jobs/{job.id}/alignment-work',self.source.read_bytes(),extra_headers=headers);self.assertEqual(code,400)
            self.assertFalse((job.directory/'alignment-work.json').exists());self.assertFalse((job.directory/'selection-source.pdf').exists())

    def test_explicit_whole_work_finishes_without_an_http_watcher_and_duplicate_posts_reuse_every_checkpoint(self):
        manager=self.manager();job=self.install(manager);service=self.service(manager);pdfs={name:(job.directory/name).read_bytes() for name in ('mono.pdf','dual.pdf')}
        status,raw=self.post_work(service,job);self.assertEqual(status,202,raw);first=json.loads(raw);self.assertTrue(first['eligible']);self.assertTrue(first['durable'])
        result=self.wait_work(service,job);self.assertEqual(result['state'],'complete');self.assertEqual(result['preparedPages'],[0,1]);self.assertIn(result['workState'],('complete','partial'))
        record=json.loads((job.directory/'alignment-work.json').read_text());self.assertEqual(record['kind'],'explicit-whole');self.assertEqual((job.directory/'selection-source.pdf').read_bytes(),self.source.read_bytes());before=self.calls.read_bytes()
        with patch.object(NativeHelper,'align',side_effect=AssertionError('prepared page was not reused')),patch.object(NativeHelper,'align_phrases',side_effect=AssertionError('prepared words were not reused')):
            self.assertEqual(self.post_work(service,job)[0],202);self.assertEqual(self.wait_work(service,job)['preparedPages'],[0,1])
        self.assertEqual(self.calls.read_bytes(),before);self.assertEqual({name:(job.directory/name).read_bytes() for name in pdfs},pdfs);self.assertTrue(job.directory.exists())

    def test_service_shutdown_keeps_intent_and_next_service_resumes_only_registered_work(self):
        manager=self.manager();job=self.install(manager);service=self.service(manager);entered=threading.Event()
        def held(helper,request):
            entered.set()
            until=time.monotonic()+4
            while not helper.cancelled and time.monotonic()<until:time.sleep(.01)
            raise ProtocolFailure('alignment_cancelled')
        with patch.object(NativeHelper,'align',held):
            self.assertEqual(self.post_work(service,job)[0],202);self.assertTrue(entered.wait(3));manager.shutdown()
        record=json.loads((job.directory/'alignment-work.json').read_text());self.assertTrue(record['enabled']);self.assertFalse(record['failedPages']);self.assertIsNone(record['error']);self.assertTrue((job.directory/'mono.pdf').exists())
        resumed=self.manager();restored=resumed.get(job.id);web=self.service(resumed);value=self.wait_work(web,restored);self.assertEqual(value['state'],'complete');self.assertEqual(value['preparedPages'],[0,1])

    def test_tampered_durable_source_blocks_without_a_model_or_deleting_usable_cached_pdf(self):
        manager=self.manager();job=self.install(manager);service=self.service(manager);self.assertEqual(self.post_work(service,job)[0],202);self.wait_work(service,job);manager.shutdown()
        path=job.directory/'selection-source.pdf';path.write_bytes(b'%PDF-1.7\nchanged source\n');path.chmod(0o600)
        with patch.object(NativeHelper,'align',side_effect=AssertionError('tampered source reached model')),patch.object(NativeHelper,'align_phrases',side_effect=AssertionError('tampered source reached word model')):
            restored=self.manager();web=self.service(restored);value=self.wait_work(web,restored.get(job.id));self.assertEqual(value['workState'],'blocked');self.assertEqual(value['state'],'failed');self.assertTrue(value['eligible']);time.sleep(.08);self.assertEqual(self.get_work(web,restored.get(job.id))['workState'],'blocked')
        self.assertTrue((job.directory/'mono.pdf').exists());self.assertTrue((job.directory/'alignment-work.json').exists())

    def test_a_stale_atomic_tmp_cannot_block_new_intent_and_corrupt_intent_never_starts_work(self):
        manager=self.manager();job=self.install(manager);service=self.service(manager);stale=job.directory/'alignment-work.json.tmp';stale.write_text('unfinished prior write');stale.chmod(0o600)
        self.assertEqual(self.post_work(service,job)[0],202);self.assertEqual(self.wait_work(service,job)['state'],'complete');self.assertTrue(stale.exists(),'do not delete unrelated prior artifacts')
        manager.shutdown();(job.directory/'alignment-work.json').write_text('{broken');(job.directory/'alignment-work.json').chmod(0o600)
        with patch.object(NativeHelper,'align',side_effect=AssertionError('corrupt intent started work')):
            restored=self.manager();web=self.service(restored);value=self.get_work(web,restored.get(job.id));self.assertFalse(value['eligible']);self.assertEqual(value['workState'],'unregistered')

    def test_foreground_gate_releases_in_finally_and_background_does_not_start_during_foreground_work(self):
        manager=self.manager();service=manager.sentence_upgrades;request=fixtures.sentence.requests_for_page(self.prepared())[0];state=SimpleNamespace(durable=True,paused=threading.Event(),cancelled=threading.Event(),phase='sentence');called=threading.Event();result={}
        helper=SimpleNamespace(batch_timeout=100,align=lambda rows:called.set() or {s['id']:[] for p in rows for s in p['source']})
        def run():
            try:result['value']=service._align_request(helper,request,state)
            except Exception as error:result['error']=error
        try:
            with service.foreground():
                thread=threading.Thread(target=run);thread.start();time.sleep(.08);self.assertFalse(called.is_set());raise RuntimeError('foreground failure')
        except RuntimeError:pass
        thread.join(2);self.assertFalse(thread.is_alive());self.assertNotIn('error',result);self.assertTrue(called.is_set());self.assertEqual(service.foreground_count,0)

    def test_warm_status_and_foreground_queue_wait_do_not_read_or_clone_full_ir(self):
        manager=self.manager();job=self.install(manager);web=self.service(manager);service=manager.sentence_upgrades
        with service.foreground():
            self.assertEqual(self.post_work(web,job)[0],202)
            with patch.object(manager,'read_alignment',side_effect=AssertionError('foreground wait parsed full IR')):
                time.sleep(.18)
                for _ in range(4):self.assertEqual(self.get_work(web,job)['state'],'running')
        self.assertEqual(self.wait_work(web,job)['state'],'complete')
        thread=service.work_thread
        if thread is not None:thread.join(3);self.assertFalse(thread.is_alive())
        self.get_work(web,job) # establish one changed-generation summary
        with patch.object(manager,'read_alignment',side_effect=AssertionError('warm polling parsed full IR')):
            for _ in range(5):self.assertEqual(self.get_work(web,job)['state'],'complete')

    def test_duplicate_intent_fields_and_unsafe_source_are_never_model_authority(self):
        manager=self.manager();job=self.install(manager);web=self.service(manager);self.assertEqual(self.post_work(web,job)[0],202);self.wait_work(web,job)
        record_path=job.directory/'alignment-work.json';record=record_path.read_text();source=job.directory/'selection-source.pdf';payload=source.read_bytes()
        duplicate=record[:-1]+',"enabled":true}'
        record_path.write_text(duplicate);record_path.chmod(0o600)
        self.assertFalse(self.get_work(web,job)['eligible']);record_path.write_text(record);record_path.chmod(0o600)
        with patch.object(NativeHelper,'align',side_effect=AssertionError('unsafe source started model')):
            for mutation in ('symlink','hardlink','permissions','short'):
                with self.subTest(mutation=mutation):
                    source.unlink(missing_ok=True)
                    external=self.root/('unsafe-'+mutation+'.pdf');external.write_bytes(payload);external.chmod(0o600)
                    if mutation=='symlink':source.symlink_to(external)
                    elif mutation=='hardlink':os.link(external,source)
                    else:source.write_bytes(payload if mutation=='permissions' else b'bad');source.chmod(0o644 if mutation=='permissions' else 0o600)
                    self.assertEqual(self.get_work(web,job)['workState'],'blocked');self.assertEqual(external.read_bytes(),payload)
            source.unlink();source.write_bytes(payload);source.chmod(0o600)
        self.assertEqual(self.get_work(web,job)['state'],'complete')

    def test_failed_page_is_attempted_once_then_other_pages_finish_and_only_explicit_post_retries(self):
        manager=self.manager();job=self.install(manager);web=self.service(manager);original=NativeHelper.align;attempted=[]
        def fail_first(helper,request):
            ids=[row['id'] for row in request];attempted.extend(ids)
            if any(identity.startswith('p0_') for identity in ids):raise ProtocolFailure('alignment_timeout')
            return original(helper,request)
        with patch.object(NativeHelper,'align',fail_first):
            self.assertEqual(self.post_work(web,job)[0],202);value=self.wait_work(web,job)
            self.assertEqual(value['workState'],'blocked');self.assertEqual(value['preparedPages'],[1]);self.assertEqual(attempted.count('p0_0'),1);self.assertIn('p1_0',attempted)
            before=list(attempted)
            for _ in range(3):self.assertEqual(self.get_work(web,job)['workState'],'blocked')
            time.sleep(.08);self.assertEqual(attempted,before)
        retried=[]
        def reuse(helper,request):retried.extend(row['id'] for row in request);return original(helper,request)
        with patch.object(NativeHelper,'align',reuse):
            self.assertEqual(self.post_work(web,job)[0],202);self.assertEqual(self.wait_work(web,job)['state'],'complete')
        self.assertEqual(retried,['p0_0']);self.assertFalse(json.loads((job.directory/'alignment-work.json').read_text())['failedPages'])

    def test_priority_only_reorders_registered_pending_work_and_does_not_create_or_retry_jobs(self):
        manager=self.manager();job=self.install(manager);web=self.service(manager);service=manager.sentence_upgrades;original=NativeHelper.align;order=[]
        def observed(helper,request):order.extend(row['id'] for row in request);return original(helper,request)
        with patch.object(NativeHelper,'align',observed):
            self.assertEqual(service.prioritize(job,1,[])['state'],'idle');self.assertIsNone(service.work_thread);self.assertFalse((job.directory/'alignment-work.json').exists())
            with service.foreground():
                self.assertEqual(self.post_work(web,job)[0],202);self.assertEqual(service.prioritize(job,1,[])['state'],'running');time.sleep(.08);self.assertEqual(order,[])
            self.assertEqual(self.wait_work(web,job)['state'],'complete');self.assertEqual(order[0],'p1_0');before=order[:]
            self.assertEqual(service.prioritize(job,0,[])['state'],'complete');time.sleep(.06);self.assertEqual(order,before)

    def test_priority_change_drains_accepted_page_then_yields_to_new_page_without_modeling_old_words_first(self):
        manager=self.manager();job=self.install(manager);web=self.service(manager);service=manager.sentence_upgrades;original=NativeHelper.align;original_words=NativeHelper.align_phrases;entered=threading.Event();release=threading.Event();order=[]
        def held(helper,request):
            order.append(('sentence',request[0]['id']))
            if request[0]['id']=='p0_0':entered.set();self.assertTrue(release.wait(3))
            return original(helper,request)
        def words(helper,request):order.append(('word',request[0]['id']));return original_words(helper,request)
        with patch.object(NativeHelper,'align',held),patch.object(NativeHelper,'align_phrases',words):
            self.assertEqual(self.post_work(web,job)[0],202);self.assertTrue(entered.wait(3));service.prioritize(job,1,[]);release.set();self.assertEqual(self.wait_work(web,job)['state'],'complete')
        self.assertEqual(order[0],('sentence','p0_0'));self.assertEqual(order[1],('sentence','p1_0'));self.assertEqual(json.loads((job.directory/'alignment-work.json').read_text())['failedPages'],{})

    def test_slot_race_requeues_without_poisoning_persistent_intent_or_losing_pages(self):
        manager=self.manager();job=self.install(manager);web=self.service(manager);service=manager.sentence_upgrades;original=service.submit;calls=[]
        def conflict_once(*args,**kwargs):
            calls.append(args[2][:])
            if len(calls)==1:raise ProtocolFailure('alignment_conflict')
            return original(*args,**kwargs)
        with patch.object(service,'submit',conflict_once):
            self.assertEqual(self.post_work(web,job)[0],202);value=self.wait_work(web,job)
        self.assertEqual(value['state'],'complete');self.assertEqual(value['preparedPages'],[0,1]);self.assertGreaterEqual(len(calls),3);record=json.loads((job.directory/'alignment-work.json').read_text());self.assertIsNone(record['error']);self.assertEqual(record['failedPages'],{})

    def test_restart_uses_already_validated_sidecar_to_leave_finished_intent_out_of_the_queue(self):
        manager=self.manager();job=self.install(manager);web=self.service(manager);self.assertEqual(self.post_work(web,job)[0],202);self.wait_work(web,job);manager.shutdown()
        import server
        original=server.JobManager.read_alignment
        calls=[]
        def observed(owner,*args,**kwargs):calls.append(args[0].id);return original(owner,*args,**kwargs)
        with patch.object(server.JobManager,'read_alignment',observed),patch.object(NativeHelper,'align',side_effect=AssertionError('finished intent reached model')):
            restored=self.manager();thread=restored.sentence_upgrades.work_thread
            if thread is not None:thread.join(3);self.assertFalse(thread.is_alive())
            self.assertEqual(calls,[],'startup already validated this exact sidecar; do not clone it again')
            value=restored.sentence_upgrades.work_status(restored.get(job.id));self.assertEqual(value['state'],'complete');self.assertEqual(calls,[])

    def test_legacy_foreground_join_does_not_expand_durable_fixed_page_or_misattribute_its_checkpoint(self):
        from sentence_service import Upgrade
        manager=self.manager();job=self.install(manager);service=manager.sentence_upgrades
        manager.selection_alignments.install_source(job,io.BytesIO(self.source.read_bytes()),self.source.stat().st_size)
        with patch.object(service,'_queue_work'):
            service.register_work(job)
        for owner,selected in ((1,0),(0,1)):
            with self.subTest(owner=owner,selected=selected):
                active=Upgrade(job,None,[owner],[],current_page=owner,focus_page=owner,background=True,durable=True,scope='work_test')
                service.upgrades[job.id]=active;temporary=manager.begin()
                result=service.submit(job,temporary,[selected],[],background=False)
                self.assertEqual(active.requested,[owner]);self.assertEqual(active.pending,[selected]);self.assertEqual(active.focus_page,selected);self.assertEqual(service.work_priorities[job.id],selected)
                self.assertFalse(temporary.directory.exists());self.assertEqual(result['sourcePages'],[owner]);self.assertTrue(job.directory.exists())
        service.upgrades.pop(job.id)

    def test_real_selection_model_gate_is_finally_scoped_but_cached_selection_does_not_gate(self):
        from test_selection_alignment import SelectionAlignmentTests
        SelectionAlignmentTests.selection_helper(self);manager=self.manager();job=self.install(manager);service=manager.selection_alignments;coordinator=manager.sentence_upgrades
        service.install_source(job,io.BytesIO(self.source.read_bytes()),self.source.stat().st_size);query=SelectionAlignmentTests.query(self);original=NativeHelper.align_selection;seen=[]
        def observed(helper,*args):seen.append(coordinator.foreground_count);return original(helper,*args)
        with patch.object(NativeHelper,'align_selection',observed):
            self.assertFalse(service.align(job,query)['cached'])
        self.assertEqual(seen,[1]);self.assertEqual(coordinator.foreground_count,0)
        with patch.object(coordinator,'foreground',side_effect=AssertionError('cached lookup paused background')):
            self.assertTrue(service.align(job,query)['cached'])
        with patch.object(NativeHelper,'align_selection',side_effect=ProtocolFailure('gpt_unavailable')):
            with self.assertRaisesRegex(ProtocolFailure,'gpt_unavailable'):service.align(job,SelectionAlignmentTests.query(self,text='First'))
        self.assertEqual(coordinator.foreground_count,0)

    def test_full_intent_gate_also_rejects_incomplete_and_partial_document_jobs(self):
        manager=self.manager();job=self.install(manager);web=self.service(manager);pending=manager.begin()
        self.assertEqual(self.post_work(web,pending)[0],409);self.assertFalse((pending.directory/'alignment-work.json').exists())
        pages=job.source_pages;job.source_pages=[0]
        try:
            self.assertEqual(self.post_work(web,job)[0],400);self.assertFalse((job.directory/'selection-source.pdf').exists());self.assertFalse((job.directory/'alignment-work.json').exists())
        finally:job.source_pages=pages

if __name__=='__main__':unittest.main()
