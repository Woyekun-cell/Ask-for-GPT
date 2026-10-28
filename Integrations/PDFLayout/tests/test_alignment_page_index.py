"""Page-scoped evidence and independent background-attempt checkpoints."""
import copy,json,os,threading,time,unittest
from pathlib import Path
from unittest.mock import patch
import test_sentence_alignment as fixtures
import server,phrase_alignment as phrase
from layout_common import ProtocolFailure
from worker import NativeHelper

class AlignmentPageIndexTests(unittest.TestCase):
    setUp=fixtures.SentenceAlignmentTests.setUp
    tearDown=fixtures.SentenceAlignmentTests.tearDown
    manager=fixtures.SentenceAlignmentTests.manager
    install=fixtures.SentenceAlignmentTests.install
    service=fixtures.SentenceAlignmentTests.service
    request=fixtures.SentenceAlignmentTests.request

    def background(self,manager,job,pages=(0,),scope='bg_fixture'):
        temporary=manager.begin();path=temporary.directory/'input.pdf'
        path.write_bytes(self.source.read_bytes());path.chmod(0o600)
        result=manager.sentence_upgrades.submit(job,temporary,list(pages),background=True,scope=scope)
        active=manager.sentence_upgrades.upgrades.get(job.id)
        if active and active.thread:active.thread.join(5);self.assertFalse(active.thread.is_alive())
        return manager.sentence_upgrades.status(job)

    def missing(self,manager,job):
        value=manager.read_alignment(job);missing=copy.deepcopy(value['pages'][0]['paragraphs'][0]);missing['id']='p0_'+str(99+sum(p['id'].startswith('p0_99') for p in value['pages'][0]['paragraphs']))
        missing.pop('sentences',None)
        missing['source']['text']='A real layout row whose glyphs are unavailable.'
        missing['target']['text']='Unavailable target row.'
        value['pages'][0]['paragraphs'].append(missing);manager.publish_alignment(job,value)

    def test_page_http_contains_all_layout_but_only_requested_semantics_and_markers(self):
        manager=self.manager();job=self.install(manager);self.assertEqual(self.background(manager,job,[0,1])['state'],'complete')
        full=manager.read_alignment(job);service=self.service(manager);route=f'/v1/pdf/jobs/{job.id}/alignment-page.json?page=1'
        with patch.object(server.subprocess,'Popen',side_effect=AssertionError('page GET started helper')):
            status,raw=self.request(service,'GET',route)
        self.assertEqual(status,200);result=json.loads(raw);server.validate_alignment(result,[0,1],2,self.sha)
        self.assertEqual(result['sourceSHA256'],full['sourceSHA256']);self.assertEqual(result['sourcePages'],[0,1])
        for index,page in enumerate(result['pages']):
            self.assertEqual(page['source'],full['pages'][index]['source'])
            self.assertEqual(page['paragraphs'][0]['source'],{k:v for k,v in full['pages'][index]['paragraphs'][0]['source'].items() if k in ('text','rects')})
            self.assertEqual('sentences' in page['paragraphs'][0],index==1)
        self.assertEqual(result['sentencePages'],[1]);self.assertEqual(result['phrasePages'],[1]);self.assertEqual(result['phraseExtractedPages'],[1]);self.assertEqual(set(result['phraseCoverage']),{'1'})
        self.assertLess(len(raw),len(json.dumps(full).encode()))
        self.assertEqual(self.request(service,'GET',route,token='b'*64)[0],401)
        for bad in ['-1','01','2','1&other=1','1&page=0']:
            self.assertIn(self.request(service,'GET',route.rsplit('=',1)[0]+'='+bad)[0],(400,404))

    def test_page_projection_cache_is_bounded_owned_and_checks_file_generation(self):
        manager=self.manager();job=self.install(manager);self.background(manager,job,[0,1])
        first=manager.read_page_alignment(job,0);first['pages'][0]['paragraphs'][0]['source']['text']='caller mutation'
        with patch.object(manager,'read_alignment',side_effect=AssertionError('warm page reparsed whole IR')):
            second=manager.read_page_alignment(job,0)
        self.assertNotEqual(second['pages'][0]['paragraphs'][0]['source']['text'],'caller mutation')
        value=manager.read_alignment(job);value['layoutRevision']='new-generation';manager.publish_alignment(job,value)
        self.assertEqual(manager.read_page_alignment(job,0)['layoutRevision'],'new-generation')
        path=server._alignment_path(job.directory,job.cache_info);path.chmod(0o644)
        with self.assertRaises(ProtocolFailure):manager.read_page_alignment(job,0)

    def test_background_partial_is_prepared_persisted_and_skipped_without_claiming_exact_completion(self):
        manager=self.manager();job=self.install(manager);self.missing(manager,job)
        pdfs={n:(job.directory/n).read_bytes() for n in ('mono.pdf','dual.pdf')}
        result=self.background(manager,job)
        self.assertEqual(result['state'],'complete');self.assertEqual(result['completedPages'],[])
        self.assertEqual(result['preparedPages'],[0]);self.assertEqual(result['partialPages'],[0])
        value=manager.read_alignment(job);self.assertNotIn(0,value.get('phraseExtractedPages',[]))
        self.assertTrue(value['pages'][0]['paragraphs'][0]['sentences'][0]['phrases'])
        path=job.directory/'alignment-index.json';record=json.loads(path.read_text())
        self.assertGreater(record['pages']['0']['unavailableParagraphs'],0);self.assertEqual(path.stat().st_mode&0o777,0o600);self.assertEqual(path.stat().st_nlink,1)
        with patch.object(NativeHelper,'__enter__',side_effect=AssertionError('prepared partial repeated model')):
            again=self.background(manager,job,scope='new-view')
        self.assertEqual(again['preparedPages'],[0])
        manager.shutdown();restarted=self.manager();restored=restarted.get(job.id)
        status=restarted.sentence_upgrades.status(restored);self.assertEqual(status['preparedPages'],[0]);self.assertEqual(status['completedPages'],[])
        for n,data in pdfs.items():self.assertEqual((job.directory/n).read_bytes(),data)

    def test_prepared_proof_is_invalidated_by_layout_target_binding_revision_and_private_file_changes(self):
        manager=self.manager();job=self.install(manager);self.missing(manager,job);self.background(manager,job)
        self.assertEqual(manager.sentence_upgrades.status(job)['preparedPages'],[0])
        original=copy.deepcopy(job.cache_info);job.cache_info['outputs']['mono']['sha256']='f'*64
        self.assertEqual(manager.sentence_upgrades.status(job)['preparedPages'],[]);job.cache_info=original
        path=job.directory/'alignment-index.json';record=json.loads(path.read_text());record['revision']='other';path.write_text(json.dumps(record));path.chmod(0o600)
        self.assertEqual(manager.sentence_upgrades.status(job)['preparedPages'],[])
        record['revision']='pdf-background-index-v1';path.write_text(json.dumps(record));path.chmod(0o644)
        self.assertEqual(manager.sentence_upgrades.status(job)['preparedPages'],[])
        path.chmod(0o600);self.assertEqual(manager.sentence_upgrades.status(job)['preparedPages'],[0])
        self.missing(manager,job);self.assertEqual(manager.sentence_upgrades.status(job)['preparedPages'],[])

    def test_background_timeout_keeps_checkpoint_but_is_never_prepared_and_resume_reuses_successes(self):
        manager=self.manager();job=self.install(manager);real=NativeHelper.align_phrases;requests=phrase.phrase_requests;calls=[]
        def split(units,**options):return [batch for unit in units for batch in requests([unit],**options)]
        def fail_second(helper,request):
            calls.append(request[0]['id'])
            if len(calls)==2:raise ProtocolFailure('alignment_timeout')
            return real(helper,request)
        with patch('sentence_service.phrase_requests',split),patch.object(NativeHelper,'align_phrases',fail_second):result=self.background(manager,job)
        self.assertEqual(result['state'],'failed');self.assertEqual(result['error'],'alignment_timeout');self.assertEqual(result['preparedPages'],[])
        saved=manager.read_alignment(job);first=copy.deepcopy(saved['pages'][0]['paragraphs'][0]['sentences'][0]);self.assertTrue(first['phrases'])
        resumed=[]
        def capture(helper,request):resumed.extend(u['id'] for u in request);return real(helper,request)
        with patch('sentence_service.phrase_requests',split),patch.object(NativeHelper,'align_phrases',capture):result=self.background(manager,job,scope='retry')
        self.assertEqual(result['preparedPages'],[0]);self.assertEqual(resumed,[calls[1]]);self.assertEqual(manager.read_alignment(job)['pages'][0]['paragraphs'][0]['sentences'][0],first)

    def test_explicit_foreground_still_refuses_missing_coverage_after_background_preparation(self):
        manager=self.manager();job=self.install(manager);self.missing(manager,job);self.background(manager,job)
        temporary=manager.begin();p=temporary.directory/'input.pdf';p.write_bytes(self.source.read_bytes());p.chmod(0o600)
        manager.sentence_upgrades.submit(job,temporary,[0]);active=manager.sentence_upgrades.upgrades[job.id];active.thread.join(5)
        self.assertEqual(active.state,'failed');self.assertEqual(active.error_detail,'sentence_coverage');self.assertEqual(active.completed,set())

    def test_unextractable_words_and_semantic_refusals_are_partial_attempts_not_exact_coverage(self):
        for refusal in ('sentence','glyph'):
            manager=self.manager();job=self.install(manager)
            def declined(helper,request):return {s['id']:[] for p in request for s in p['source']}
            context=patch.object(NativeHelper,'align',declined) if refusal=='sentence' else patch('sentence_service.prepare_phrase_page',return_value=[])
            with context,patch.object(NativeHelper,'align_phrases',side_effect=AssertionError('unextractable/refused unit called word model')):
                result=self.background(manager,job,scope='bg_'+refusal)
            self.assertEqual(result['preparedPages'],[0]);self.assertEqual(result['partialPages'],[0]);self.assertEqual(result['completedPages'],[])
            row=json.loads((job.directory/'alignment-index.json').read_text())['pages']['0']
            self.assertGreater(row['unavailableParagraphs'] if refusal=='sentence' else row['unavailableSentences'],0)
            manager.shutdown()

    def test_projection_bound_and_inflight_private_generation_guard(self):
        manager=self.manager();job=self.install(manager);self.background(manager,job,[0,1])
        with patch.object(server,'MAX_ALIGNMENT_PROJECTIONS',1):
            manager.read_page_alignment(job,1);manager.read_page_alignment(job,0)
            self.assertEqual(len(manager._alignment_projections),1)
            self.assertLessEqual(manager._alignment_projection_bytes,server.MAX_ALIGNMENT_PROJECTION_BYTES)
        path=server._alignment_path(job.directory,job.cache_info);real_loads=json.loads;changed=[]
        def change_during_copy(raw,*args,**kwargs):
            if not changed:changed.append(True);path.chmod(0o644)
            return real_loads(raw,*args,**kwargs)
        with patch.object(server.json,'loads',side_effect=change_during_copy),self.assertRaises(ProtocolFailure):manager.read_page_alignment(job,0)

if __name__=='__main__':unittest.main()
