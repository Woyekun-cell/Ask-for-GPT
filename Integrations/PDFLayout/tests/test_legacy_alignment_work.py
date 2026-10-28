"""Recover only explicit full-document correspondence from exact saved PDFs; no real model."""
import copy
import hashlib
import json
import time
import threading
from pathlib import Path
import unittest
from unittest.mock import patch
import test_sentence_alignment as fixtures
import alignment
import server
from layout_common import atomic_json, BABELDOC_VERSION, ProtocolFailure
from worker import NativeHelper


class LegacyAlignmentWorkTests(unittest.TestCase):
    for _name in ('setUp','tearDown','manager','service','request'):
        locals()[_name]=getattr(fixtures.SentenceAlignmentTests,_name)

    def legacy(self,manager,identity='b'*32,**updates):
        directory=manager.jobs_root/identity;directory.mkdir(mode=0o700)
        outputs={}
        for kind,path in [('mono',self.mono),('dual',self.dual)]:
            raw=path.read_bytes();(directory/(kind+'.pdf')).write_bytes(raw);(directory/(kind+'.pdf')).chmod(0o600)
            outputs[kind]={'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)}
        metadata={'schema':1,'state':'complete','babeldoc':BABELDOC_VERSION,'revision':'pdf-layout-gpt-v3',
            'cacheKey':server._cache_key(self.sha,[0,1],2,'en','zh-Hans','pdf-layout-gpt-v3'),
            'sourceSHA256':self.sha,'sourcePages':[0,1],'pageCount':2,'source':'en','target':'zh-Hans','outputs':outputs}
        metadata.update(updates);atomic_json(directory/'cache.json',metadata)
        return identity,directory,metadata

    def headers(self,metadata):
        return {'X-AskGPT-Full-Translation':'1','X-AskGPT-Source-Language':metadata['source'],
            'X-AskGPT-Target-Language':metadata['target'],'X-AskGPT-Target-SHA256':metadata['outputs']['mono']['sha256'],
            'X-AskGPT-Target-Bytes':str(metadata['outputs']['mono']['bytes'])}

    def post(self,web,identity,metadata,**changes):
        headers=self.headers(metadata);headers.update(changes)
        return self.request(web,'POST',f'/v1/pdf/jobs/{identity}/alignment-work',self.source.read_bytes(),extra_headers=headers)

    def wait(self,web,identity):
        until=time.monotonic()+10
        while time.monotonic()<until:
            code,raw=self.request(web,'GET',f'/v1/pdf/jobs/{identity}/alignment-work');self.assertEqual(code,200,raw)
            value=json.loads(raw)
            if value['state']!='running':return value
            time.sleep(.02)
        self.fail('legacy background work did not settle')

    def test_open_get_and_restart_do_not_adopt_old_pdfs_or_create_intent(self):
        manager=self.manager();identity,directory,metadata=self.legacy(manager);web=self.service(manager);before=(directory/'cache.json').read_bytes()
        with patch.object(NativeHelper,'align',side_effect=AssertionError('GET/open started model')):
            for route in [f'/v1/pdf/jobs/{identity}',f'/v1/pdf/jobs/{identity}/alignment-work']:
                self.assertEqual(self.request(web,'GET',route)[0],404)
            restored=self.manager();self.assertNotIn(identity,restored.jobs)
        self.assertEqual((directory/'cache.json').read_bytes(),before);self.assertFalse((directory/'alignment-work.json').exists())

    def test_explicit_whole_recovers_real_candidate_ranges_without_retranslating_or_replacing_pdfs(self):
        manager=self.manager();identity,directory,metadata=self.legacy(manager);web=self.service(manager)
        pdfs={name:(directory/name).read_bytes() for name in ('mono.pdf','dual.pdf')}
        with manager.sentence_upgrades.foreground():
            code,raw=self.post(web,identity,metadata);self.assertEqual(code,202,raw)
            value=manager.read_alignment(manager.get(identity));self.assertEqual(value['provenance'],'pdf-glyph-candidates')
            self.assertEqual(value['targetSHA256'],metadata['outputs']['mono']['sha256']);self.assertEqual(value['sentencePages'],[])
            self.assertEqual(value['pages'][0]['paragraphs'][0]['source']['text'],self.source_text[0])
            self.assertEqual(value['pages'][0]['paragraphs'][0]['target']['text'],self.target_text[0])
            self.assertEqual(value['pages'][0]['paragraphs'][0].get('sentences',[]),[])
            self.assertTrue(json.loads(raw)['eligible'])
        state=self.wait(web,identity);self.assertEqual(state['state'],'complete');self.assertEqual(state['preparedPages'],[0,1])
        saved=json.loads((directory/'cache.json').read_text())
        self.assertEqual({k:saved[k] for k in metadata},metadata);self.assertEqual(set(saved)-set(metadata),{'alignment','alignmentFile'})
        self.assertEqual({name:(directory/name).read_bytes() for name in pdfs},pdfs)
        self.assertEqual((directory/'selection-source.pdf').read_bytes(),self.source.read_bytes())
        self.assertEqual(manager.get(identity).cache_info['revision'],'pdf-layout-gpt-v3')
        before=self.calls.read_bytes()
        with patch.object(NativeHelper,'align',side_effect=AssertionError('repeat re-aligned prepared sentences')),patch.object(NativeHelper,'align_phrases',side_effect=AssertionError('repeat re-aligned prepared words')):
            self.assertEqual(self.post(web,identity,metadata)[0],202);self.wait(web,identity)
        self.assertEqual(self.calls.read_bytes(),before)

    def test_restart_resumes_only_registered_candidate_work_and_reuses_completed_pages(self):
        manager=self.manager();identity,directory,metadata=self.legacy(manager);web=self.service(manager)
        self.assertEqual(self.post(web,identity,metadata)[0],202);self.wait(web,identity);manager.shutdown();before=self.calls.read_bytes()
        with patch.object(NativeHelper,'align',side_effect=AssertionError('completed restart called model')),patch.object(NativeHelper,'align_phrases',side_effect=AssertionError('completed restart called model')):
            restored=self.manager();self.assertIn(identity,restored.jobs);state=self.wait(self.service(restored),identity)
            self.assertTrue(state['eligible']);self.assertEqual(state['preparedPages'],[0,1]);self.assertEqual(self.calls.read_bytes(),before)

    def test_bad_explicit_bindings_and_untrusted_legacy_records_cannot_adopt(self):
        for index,changes in enumerate([{'X-AskGPT-Full-Translation':'0'},{'X-AskGPT-Target-SHA256':'0'*64},
                {'X-AskGPT-Target-Bytes':'5'},{'X-AskGPT-Source-Language':'zh-Hans'},
                {'X-AskGPT-Target-Language':'en'}]):
            with self.subTest(changes=changes):
                manager=self.manager();identity,directory,metadata=self.legacy(manager,identity=f'{index+1:032x}');web=self.service(manager)
                before=(directory/'cache.json').read_bytes();code,_=self.post(web,identity,metadata,**changes)
                self.assertNotEqual(code,202);self.assertNotIn(identity,manager.jobs);self.assertEqual((directory/'cache.json').read_bytes(),before)
                self.assertFalse((directory/'alignment-work.json').exists())
        for index,changes in enumerate([{'sourcePages':[0]},{'cacheKey':'0'*64},{'revision':'unknown-old-version'},{'schema':True}]):
            with self.subTest(metadata=changes):
                manager=self.manager();identity,directory,metadata=self.legacy(manager,identity=f'{index+10:032x}',**changes);web=self.service(manager)
                self.assertNotEqual(self.post(web,identity,metadata)[0],202);self.assertNotIn(identity,manager.jobs)

    def test_changed_source_or_symlink_output_never_publishes_candidate_or_intent(self):
        manager=self.manager();identity,directory,metadata=self.legacy(manager);web=self.service(manager);before=(directory/'cache.json').read_bytes()
        code,_=self.request(web,'POST',f'/v1/pdf/jobs/{identity}/alignment-work',self.mono.read_bytes(),extra_headers=self.headers(metadata))
        self.assertNotEqual(code,202);self.assertEqual((directory/'cache.json').read_bytes(),before);self.assertFalse((directory/'selection-source.pdf').exists())
        (directory/'mono.pdf').unlink();(directory/'mono.pdf').symlink_to(self.mono)
        self.assertNotEqual(self.post(web,identity,metadata)[0],202);self.assertNotIn(identity,manager.jobs);self.assertEqual((directory/'cache.json').read_bytes(),before)

    def test_recovered_provenance_is_not_accepted_without_explicit_recovery_revision_and_target_binding(self):
        value=copy.deepcopy(self.value);value.update(provenance='pdf-glyph-candidates',granularity='sentence',sentenceAlignmentRevision='pdf-sentence-semantic-v1',sentencePages=[])
        with self.assertRaises(ValueError):alignment.validate_alignment(value,[0,1],2,self.sha)
        value.update(recoveryRevision='pdf-glyph-candidates-v1',targetSHA256='f'*64)
        alignment.validate_alignment(value,[0,1],2,self.sha)
        value['pages'][0]['paragraphs'][0]['id']='p0_8'
        with self.assertRaises(ValueError):alignment.validate_alignment(value,[0,1],2,self.sha)


    def test_source_only_or_unextractable_candidate_page_stays_partial_instead_of_becoming_ready(self):
        import pymupdf
        from worker import compose_dual
        with pymupdf.open() as pdf:
            pdf.new_page(width=400,height=250)
            page=pdf.new_page(width=400,height=250);page.insert_text((20,45),self.target_text[1],fontsize=11)
            self.mono.unlink();pdf.save(self.mono)
        self.dual.unlink();compose_dual(self.source,self.mono,[0,1],self.dual)
        manager=self.manager();identity,directory,metadata=self.legacy(manager);web=self.service(manager)
        self.assertEqual(self.post(web,identity,metadata)[0],202);state=self.wait(web,identity)
        self.assertEqual(state['workState'],'partial');self.assertIn(0,state['partialPages']);self.assertNotIn(0,state['completedPages'])
        value=manager.read_alignment(manager.get(identity));self.assertTrue(value['pages'][0]['candidateTextUnavailable'])
        self.assertEqual(value['pages'][0]['paragraphs'],[]);self.assertNotIn(0,value['sentencePages'])
        layout=manager.read_layout_alignment(manager.get(identity));self.assertEqual(layout['provenance'],'pdf-glyph-candidates')
        self.assertEqual(layout['targetSHA256'],metadata['outputs']['mono']['sha256']);self.assertTrue(layout['pages'][0]['candidateTextUnavailable'])
        self.assertNotIn('sentenceAlignmentRevision',layout)

    def test_interrupted_registered_recovery_resumes_after_shutdown_without_reader_or_retranslation(self):
        manager=self.manager();identity,directory,metadata=self.legacy(manager);web=self.service(manager);entered=threading.Event()
        def held(helper,request):
            entered.set();until=time.monotonic()+4
            while not helper.cancelled and time.monotonic()<until:time.sleep(.01)
            raise ProtocolFailure('alignment_cancelled')
        with patch.object(NativeHelper,'align',held):
            self.assertEqual(self.post(web,identity,metadata)[0],202);self.assertTrue(entered.wait(3));manager.shutdown()
        intent=json.loads((directory/'alignment-work.json').read_text());self.assertTrue(intent['enabled']);self.assertIsNone(intent['error']);self.assertFalse(intent['failedPages'])
        restored=self.manager();state=self.wait(self.service(restored),identity);self.assertEqual(state['preparedPages'],[0,1]);self.assertTrue(state['eligible'])
        self.assertEqual((directory/'mono.pdf').read_bytes(),self.mono.read_bytes())

    def test_a_foreign_target_binding_cannot_be_accepted_for_an_already_loaded_modern_job(self):
        manager=self.manager();job=fixtures.SentenceAlignmentTests.install(self,manager);web=self.service(manager)
        metadata=json.loads((job.directory/'cache.json').read_text());before=(job.directory/'cache.json').read_bytes()
        self.assertEqual(self.post(web,job.id,metadata,**{'X-AskGPT-Target-SHA256':'0'*64})[0],400)
        self.assertFalse((job.directory/'alignment-work.json').exists());self.assertEqual((job.directory/'cache.json').read_bytes(),before)

    def test_restart_rejects_candidate_sidecar_bound_to_another_target_even_with_a_fresh_sidecar_digest(self):
        manager=self.manager();identity,directory,metadata=self.legacy(manager);web=self.service(manager)
        self.assertEqual(self.post(web,identity,metadata)[0],202);self.wait(web,identity);manager.shutdown()
        saved=json.loads((directory/'cache.json').read_text());path=directory/saved['alignmentFile'];value=json.loads(path.read_text());value['targetSHA256']='0'*64
        atomic_json(path,value);raw=path.read_bytes();saved['alignment']={'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)};atomic_json(directory/'cache.json',saved)
        with patch.object(NativeHelper,'align',side_effect=AssertionError('foreign recovery started model')):
            restored=self.manager();self.assertNotIn(identity,restored.jobs)
        self.assertEqual((directory/'mono.pdf').read_bytes(),self.mono.read_bytes());self.assertTrue((directory/'alignment-work.json').exists())


    def test_recovery_extraction_checks_actual_source_digest_and_stops_at_per_page_and_total_bounds(self):
        import legacy_alignment as recovery
        manager=self.manager();identity,directory,metadata=self.legacy(manager)
        source=directory/'selection-source.pdf';source.write_bytes(self.source.read_bytes());source.chmod(0o600)
        signatures={kind:server._output_signature(directory/(kind+'.pdf')) for kind in ['mono','dual']}
        args=(source,directory/'mono.pdf',directory/'dual.pdf',metadata,signatures)
        for name,limit in [('MAX_TEXT',10),('MAX_RECTS',0),('MAX_ALIGNMENT_BYTES',500)]:
            with self.subTest(bound=name),patch.object(recovery,name,limit),patch.object(recovery,'_side',wraps=recovery._side) as side:
                with self.assertRaises(ValueError):recovery.candidate_alignment(*args)
                self.assertLessEqual(side.call_count,2,'never extract the next page after an exceeded bound')
        changed={**metadata,'sourceSHA256':'0'*64}
        with self.assertRaisesRegex(ValueError,'source_changed'):
            recovery.candidate_alignment(source,directory/'mono.pdf',directory/'dual.pdf',changed,signatures)
        self.assertFalse((directory/'alignment-work.json').exists())


if __name__=='__main__':unittest.main()
