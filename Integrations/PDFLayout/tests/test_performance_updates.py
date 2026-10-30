"""Exact checkpoint scope and optimistic page updates in temporary jobs."""
import copy,json,sys,threading,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server
from batch_checkpoint import BatchCheckpoint
from layout_common import ProtocolFailure
import test_sentence_alignment as fixtures
from test_parallel_jobs import ParallelJobTests as _ParallelFixture

class PublicationTests(unittest.TestCase):
    for _name in ('setUp','tearDown','manager','install'):locals()[_name]=getattr(fixtures.SentenceAlignmentTests,_name)
    def test_full_sentence_and_word_validation_does_not_hold_manager_lock(self):
        for mode in ('sentence','word'):
            manager=self.manager();job=self.install(manager);service=manager.sentence_upgrades;upgrade=SimpleNamespace(parent=job,cancelled=threading.Event())
            if mode=='word':service._publish_sentences(upgrade,0,0,copy.deepcopy(self.value['pages'][0]),complete=True)
            entered=threading.Event();release=threading.Event();acquired=threading.Event();failures=[];original=server.validate_alignment
            def blocked(*args):entered.set();self.assertTrue(release.wait(3));return original(*args)
            def run():
                try:
                    if mode=='sentence':service._publish_sentences(upgrade,0,0,copy.deepcopy(self.value['pages'][0]))
                    else:service._publish_words(upgrade,0,0,copy.deepcopy(self.value['pages'][0]),[])
                except Exception as error:failures.append(error)
            def contender():
                with manager.lock:acquired.set()
            with patch.object(server,'validate_alignment',side_effect=blocked):
                thread=threading.Thread(target=run);thread.start();other=None
                try:
                    self.assertTrue(entered.wait(2));other=threading.Thread(target=contender);other.start();self.assertTrue(acquired.wait(.25),mode+' validation monopolized manager lock')
                finally:
                    release.set();thread.join(4)
                    if other:other.join(4)
            self.assertFalse(failures)
    def test_two_page_publications_rebase_and_preserve_both_updates(self):
        manager=self.manager();job=self.install(manager);service=manager.sentence_upgrades;upgrade=SimpleNamespace(parent=job,cancelled=threading.Event())
        barrier=threading.Barrier(2);failures=[];original=server.validate_alignment;seen=set();mutex=threading.Lock()
        def crossed(*args):
            identity=threading.get_ident()
            with mutex:first=identity not in seen;seen.add(identity)
            if first:barrier.wait(2)
            return original(*args)
        def run(page):
            try:service._publish_sentences(upgrade,page,page,copy.deepcopy(self.value['pages'][page]),complete=True)
            except Exception as error:failures.append(error)
        with patch.object(server,'validate_alignment',side_effect=crossed):
            threads=[threading.Thread(target=run,args=(page,)) for page in (0,1)]
            for thread in threads:thread.start()
            for thread in threads:thread.join(5)
        self.assertFalse(any(thread.is_alive() for thread in threads));self.assertFalse(failures)
        value=manager.read_alignment(job);self.assertEqual(value['sentencePages'],[0,1]);self.assertEqual(value['sentencePartialPages'],[])
    def test_cancel_or_stopping_during_validation_never_commits(self):
        for mode in ('cancel','stopping'):
            manager=self.manager();job=self.install(manager);service=manager.sentence_upgrades;upgrade=SimpleNamespace(parent=job,cancelled=threading.Event());before=job.cache_info.copy();original=server.validate_alignment
            def stop(*args):
                result=original(*args)
                if mode=='cancel':upgrade.cancelled.set()
                else:manager.stopping=True
                return result
            with patch.object(server,'validate_alignment',side_effect=stop),self.assertRaisesRegex(ProtocolFailure,'alignment_cancelled'):
                service._publish_sentences(upgrade,0,0,copy.deepcopy(self.value['pages'][0]),complete=True)
            self.assertEqual(job.cache_info,before);self.assertEqual(manager.read_alignment(job),self.value)
    def test_stale_direct_publication_cannot_overwrite_a_new_generation(self):
        manager=self.manager();job=self.install(manager);old=manager.read_alignment(job);latest=copy.deepcopy(old);latest['layoutRevision']='new';original=server.validate_alignment;once=[]
        def newer(*args):
            result=original(*args)
            if not once:once.append(True);manager.publish_alignment(job,latest)
            return result
        with patch.object(server,'validate_alignment',side_effect=newer),self.assertRaisesRegex(ProtocolFailure,'alignment_conflict'):manager.publish_alignment(job,old)
        self.assertEqual(manager.read_alignment(job)['layoutRevision'],'new')

    def test_initial_sidecar_publication_binds_absence_and_full_outputs(self):
        manager=self.manager();job=self.install(manager)
        manager._forget_alignment_snapshot(job.id);job.cache_info.pop('alignment');job.output_signatures.pop('alignment')
        manager.publish_alignment(job,self.value)
        self.assertEqual(manager.read_alignment(job),self.value)
        self.assertIn('alignment',job.cache_info);self.assertIn('alignment',job.output_signatures)

    def test_two_word_page_publications_preserve_coverage_for_both_pages(self):
        manager=self.manager();job=self.install(manager);service=manager.sentence_upgrades;upgrade=SimpleNamespace(parent=job,cancelled=threading.Event())
        for page in (0,1):service._publish_sentences(upgrade,page,page,copy.deepcopy(self.value['pages'][page]),complete=True)
        barrier=threading.Barrier(2);original=server.validate_alignment;seen=set();mutex=threading.Lock();failures=[]
        def crossed(*args):
            identity=threading.get_ident()
            with mutex:first=identity not in seen;seen.add(identity)
            if first:barrier.wait(2)
            return original(*args)
        def run(page):
            try:service._publish_words(upgrade,page,page,copy.deepcopy(self.value['pages'][page]),[])
            except Exception as error:failures.append(error)
        with patch.object(server,'validate_alignment',side_effect=crossed):
            threads=[threading.Thread(target=run,args=(page,)) for page in (0,1)]
            for thread in threads:thread.start()
            for thread in threads:thread.join(5)
        self.assertFalse(any(thread.is_alive() for thread in threads));self.assertFalse(failures)
        value=manager.read_alignment(job);self.assertEqual(value['phrasePages'],[0,1]);self.assertEqual(set(value['phraseCoverage']),{'0','1'})

    def test_final_pointer_commit_obeys_manager_generation_mutex(self):
        manager=self.manager();job=self.install(manager);value=copy.deepcopy(self.value);value['layoutRevision']='mutex-new'
        old=job.cache_info.copy();validated=threading.Event();release=threading.Event();staged=threading.Event();failures=[]
        original_validate=server.validate_alignment;original_read=server._private_file
        def validate(*args):
            result=original_validate(*args);validated.set();self.assertTrue(release.wait(3));return result
        def read(path,*args,**kwargs):
            result=original_read(path,*args,**kwargs)
            if path.name.startswith('.alignment-publish-'):staged.set()
            return result
        def run():
            try:manager.publish_alignment(job,value)
            except Exception as error:failures.append(error)
        with patch.object(server,'validate_alignment',side_effect=validate),patch.object(server,'_private_file',side_effect=read):
            thread=threading.Thread(target=run);thread.start()
            try:
                self.assertTrue(validated.wait(2))
                with manager.lock:
                    release.set();self.assertTrue(staged.wait(2));self.assertEqual(job.cache_info,old)
                    self.assertTrue(thread.is_alive(),'pointer committed while generation mutex was owned elsewhere')
            finally:release.set();thread.join(4)
        self.assertFalse(failures);self.assertEqual(manager.read_alignment(job)['layoutRevision'],'mutex-new')

class CheckpointScopeTests(unittest.TestCase):
    for _name in ('setUp','tearDown','submit','started','wait_until'):locals()[_name]=getattr(_ParallelFixture,_name)
    def test_real_request_checkpoint_key_is_canonical_and_exact_rows_context_remain_isolated(self):
        import pymupdf
        with pymupdf.open() as document:document.new_page();document.new_page();pdf=document.tobytes()
        first,_=self.submit(pdf,pages='1');self.started(first);one=json.loads((first.directory/'request.json').read_text());one_key=first.cache_info['cacheKey']
        rows=[{'id':'p0','text':'There are 12 cells.'}];context={'before':'','after':'Physical neighbour.'};calls=[]
        def model(rows,context=None):calls.append(1);return [{'id':r['id'],'text':'有12个细胞。'} for r in rows]
        BatchCheckpoint(self.manager.cache_root,one['batchCacheKey'],'en','zh-Hans').translate(model,rows,context);self.manager.cancel(first)
        second,_=self.submit(pdf,pages='all');self.started(second);whole=json.loads((second.directory/'request.json').read_text())
        self.assertNotEqual(one_key,second.cache_info['cacheKey']);self.assertEqual(one['batchCacheKey'],whole['batchCacheKey']);self.assertEqual(whole['batchCacheKey'],second.cache_info['cacheKey'])
        cache=BatchCheckpoint(self.manager.cache_root,whole['batchCacheKey'],'en','zh-Hans');cache.translate(model,rows,context);self.assertEqual(len(calls),1)
        for changed_rows,changed_context in [([{'id':'p1','text':rows[0]['text']}],context),(rows,{'before':'Changed','after':''})]:cache.translate(model,changed_rows,changed_context)
        self.assertEqual(len(calls),3)
        for key in [server._cache_key('f'*64,[0,1],2,'en','zh-Hans',self.manager.translation_revision),server._cache_key(first.cache_info['sourceSHA256'],[0,1],2,'en','zh-Hans','other-revision')]:BatchCheckpoint(self.manager.cache_root,key,'en','zh-Hans').translate(model,rows,context)
        BatchCheckpoint(self.manager.cache_root,whole['batchCacheKey'],'zh-Hans','en').translate(model,rows,context);self.assertEqual(len(calls),6)

    def test_inflight_same_pdf_other_scope_is_rejected_without_checkpoint_contention(self):
        import pymupdf
        with pymupdf.open() as document:document.new_page();document.new_page();pdf=document.tobytes()
        first,_=self.submit(pdf,pages='1');self.started(first)
        with self.assertRaisesRegex(ProtocolFailure,'job_conflict'):self.submit(pdf,pages='all')
        self.assertIsNone(first.process.poll());self.assertEqual(first.state,'running')

    def test_finishing_worker_still_owns_document_until_monitor_commits_its_state(self):
        first,_=self.submit(self.pdf_a);self.started(first)
        # A leader can exit while monitor still verifies/stores its outputs.
        with patch.object(first.process,'poll',return_value=0),self.assertRaisesRegex(ProtocolFailure,'job_conflict'):
            self.submit(self.pdf_a)
        self.assertEqual(first.state,'running');self.assertIsNone(first.process.poll())

del _ParallelFixture
if __name__=='__main__':unittest.main()
