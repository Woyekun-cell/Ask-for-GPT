"""Selection cache identity and context lifetime use isolated PDF fixtures."""
import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]
import pymupdf
import alignment
import phrase_alignment as phrase
import sentence_alignment as sentence
import selection_service as selection
from layout_common import ProtocolFailure
from test_selection_alignment import SelectionAlignmentTests as _SelectionFixture
import test_sentence_alignment as fixtures
from worker import NativeHelper, compose_dual


class SelectionLifecycleTests(unittest.TestCase):
    setUp=_SelectionFixture.setUp
    tearDown=_SelectionFixture.tearDown
    manager=_SelectionFixture.manager
    install=_SelectionFixture.install
    query=_SelectionFixture.query
    semantic_first_page=_SelectionFixture.semantic_first_page
    exact_binding=staticmethod(_SelectionFixture.exact_binding)
    def install_selection(self):
        manager=self.manager();job=self.install(manager);service=manager.selection_alignments
        raw=self.source.read_bytes();service.install_source(job,io.BytesIO(raw),len(raw))
        return manager,job,service

    def test_conflicting_reverse_cache_stays_expired_after_phrase_removal_and_restart(self):
        self.semantic_first_page();manager,job,service=self.install_selection()
        query=self.query();reverse=self.query(side='target',text='Binding')
        with patch.object(NativeHelper,'align_selection',autospec=True,side_effect=self.exact_binding):
            service.align(job,query);service.align(job,reverse)
        self.publish_conflicting_phrase(manager,job)
        def current_match(helper,unit,side,start,end):
            return {'sourceIDs':[next(t['id'] for t in unit['source'] if t['text']=='binds')],
                'targetIDs':[next(t['id'] for t in unit['target'] if t['text']=='happens')]}
        with patch.object(NativeHelper,'align_selection',autospec=True,side_effect=current_match):
            service.align(job,query)
        changed=manager.read_alignment(job)
        for paragraph in changed['pages'][0]['paragraphs']:
            for row in paragraph.get('sentences',[]):row['phrases']=[]
        manager.publish_alignment(job,changed)
        service.shutdown();service=selection.SelectionAlignmentService(manager);manager.selection_alignments=service
        with patch.object(service,'_prewarm'):
            links=service.links(job,0)['links']
        self.assertEqual([(x['source']['text'],x['target']['text']) for x in links],[('binds','happens')])
        self.assertTrue(list(job.directory.glob('expired-selection-*.json')))
        with patch.object(NativeHelper,'align_selection',return_value=None) as helper:
            result=service.align(job,reverse)
        self.assertFalse(result['cached']);self.assertIsNone(result['link']);self.assertEqual(helper.call_count,1)

    def test_fresh_same_content_validation_revokes_only_its_expiration_marker(self):
        self.semantic_first_page();manager,job,service=self.install_selection();query=self.query()
        with patch.object(NativeHelper,'align_selection',autospec=True,side_effect=self.exact_binding):original=service.align(job,query)
        self.publish_conflicting_phrase(manager,job)
        with patch.object(service,'_prewarm'):self.assertEqual(service.links(job,0)['links'],[])
        changed=manager.read_alignment(job)
        for paragraph in changed['pages'][0]['paragraphs']:
            for row in paragraph.get('sentences',[]):row['phrases']=[]
        manager.publish_alignment(job,changed)
        with patch.object(NativeHelper,'align_selection',autospec=True,side_effect=self.exact_binding) as helper:
            renewed=service.align(job,query);again=service.align(job,query)
        self.assertEqual(renewed['link'],original['link']);self.assertFalse(renewed['cached'])
        self.assertTrue(again['cached']);self.assertEqual(helper.call_count,1)
        service.shutdown();service=selection.SelectionAlignmentService(manager);manager.selection_alignments=service
        with patch.object(service,'_prewarm'):self.assertEqual(service.links(job,0)['links'],[original['link']])

    def test_legacy_source_validation_never_inverts_cache_read_lock_order(self):
        import legacy_alignment
        import threading
        from test_legacy_alignment_work import LegacyAlignmentWorkTests
        self.semantic_first_page();manager,job,service=self.install_selection();query=self.query()
        with patch.object(NativeHelper,'align_selection',autospec=True,side_effect=self.exact_binding):service.align(job,query)
        binding,prepared,start,end,key=service._prepare(job,query)
        identity,directory,metadata=LegacyAlignmentWorkTests.legacy(self,manager)
        legacy_binding={'sourceLanguage':metadata['source'],'targetLanguage':metadata['target'],
            'targetSHA256':metadata['outputs']['mono']['sha256'],'targetBytes':metadata['outputs']['mono']['bytes']}
        real_source=service.source_path;observed=[]
        def source_path(parent):
            if parent.id==identity and not service.lock._is_owned():
                self.assertFalse(manager.lock._is_owned(),'legacy manager -> selection reverses cache lock order')
                errors=[]
                def read():
                    try:service._record(job,job.directory/('selection-'+key+'.json'),binding,prepared,query,start,end,key)
                    except BaseException as e:errors.append(e)
                reader=threading.Thread(target=read,daemon=True);reader.start();reader.join(2)
                self.assertFalse(reader.is_alive());self.assertEqual(errors,[]);observed.append(True)
            return real_source(parent)
        with patch.object(service,'source_path',side_effect=source_path):
            raw=self.source.read_bytes();legacy_alignment.adopt(manager,identity,legacy_binding,io.BytesIO(raw),len(raw))
        self.assertTrue(observed)

    def regroup(self, manager, job, *, merged=False, swapped=False):
        changed=manager.read_alignment(job);prepared=fixtures.SentenceAlignmentTests.prepared(self)
        relation={row['id']:[prepared[0]['target'][1 if merged and i<2 else (1-i if swapped and i<2 else i)]['id']]
            for i,row in enumerate(prepared[0]['source'])}
        changed['pages'][0]=sentence.upgrade_page(changed['pages'][0],prepared,relation)
        changed.update(granularity='sentence',sentenceAlignmentRevision=sentence.SENTENCE_REVISION,
            sentencePages=[] if merged else [0],sentencePartialPages=[0] if merged else [])
        manager.publish_alignment(job,changed)

    def large_parent(self):
        sides={}
        for name,path,lines,texts in [('source',self.source,['First fact binds. Second fact blocks.']+['Control fact holds.']*300,self.source_text),
                ('target',self.mono,['Blocking happens. Binding happens.']+['Control holds.']*300,self.target_text)]:
            with pymupdf.open() as doc:
                page=doc.new_page(width=400,height=6500)
                for index,text in enumerate(lines):page.insert_text((20,45+20*index),text,fontsize=11)
                page=doc.new_page(width=400,height=250);page.insert_text((20,45),texts[1],fontsize=11);doc.save(path)
            texts[0]=' '.join(lines)
            with pymupdf.open(path) as doc:
                sides[name]={'text':texts[0],'rects':[list(pymupdf.Rect(row[:4])*~doc[0].transformation_matrix) for row in doc[0].get_text('blocks')]}
                self.value['pages'][0]['source' if name=='source' else 'mono']=alignment._geometry(doc[0])
        paragraph=self.value['pages'][0]['paragraphs'][0];paragraph.update(sides)
        paragraph['dualSource']={'rects':copy.deepcopy(sides['source']['rects'])}
        paragraph['dualTarget']={'rects':[[r[0]+400,r[1],r[2]+400,r[3]] for r in sides['target']['rects']]}
        self.sha=hashlib.sha256(self.source.read_bytes()).hexdigest();self.value['sourceSHA256']=self.sha
        compose_dual(self.source,self.mono,[0,1],self.dual)
        with pymupdf.open(self.dual) as doc:self.value['pages'][0]['dual']=alignment._geometry(doc[0])

    def publish_conflicting_phrase(self, manager, job):
        changed=manager.read_alignment(job);page=changed['pages'][0]
        with pymupdf.open(self.source) as left,pymupdf.open(self.mono) as right:
            units=phrase.prepare_phrase_page(page,left[0],right[0])
        matches={}
        for unit in units:
            source=next((t for t in unit['source'] if t['text']=='binds'),None)
            if source:matches[unit['id']]=[{'sourceIDs':[source['id']],
                'targetIDs':[next(t['id'] for t in unit['target'] if t['text']=='happens')]}]
        changed['pages'][0]=phrase.upgrade_phrase_page(page,units,matches)
        changed.update(phraseAlignmentRevision=phrase.PHRASE_REVISION,phrasePages=[0]);manager.publish_alignment(job,changed)

    def test_late_phrase_conflict_expires_cache_without_poisoning_page(self):
        self.semantic_first_page();manager,job,service=self.install_selection();query=self.query()
        with patch.object(NativeHelper,'align_selection',autospec=True,side_effect=self.exact_binding):service.align(job,query)
        self.publish_conflicting_phrase(manager,job)
        with patch.object(service,'_prewarm'):
            self.assertEqual(service.links(job,0)['links'],[])
        with patch.object(NativeHelper,'align_selection',autospec=True,side_effect=self.exact_binding):
            with self.assertRaisesRegex(ProtocolFailure,'selection_invalid'):service.align(job,query)
        fresh=selection.SelectionAlignmentService(manager)
        try:
            with patch.object(fresh,'_prewarm'):self.assertEqual(fresh.links(job,0)['links'],[])
        finally:fresh.shutdown()

    def test_sentence_context_changed_during_model_turn_cannot_commit(self):
        self.semantic_first_page();manager,job,service=self.install_selection()
        def changed(helper,unit,side,start,end):
            self.assertEqual(unit['targetText'],'Binding happens.');self.regroup(manager,job)
            return self.exact_binding(helper,unit,side,start,end)
        with patch.object(NativeHelper,'align_selection',autospec=True,side_effect=changed):
            with self.assertRaisesRegex(ProtocolFailure,'selection_invalid'):service.align(job,self.query())
        self.assertFalse(list(job.directory.glob('selection-*.json')))

    def test_sentence_generation_changed_at_commit_cannot_publish(self):
        self.semantic_first_page();manager,job,service=self.install_selection();original=service._check_conflicts
        def changed(*args):
            original(*args);self.regroup(manager,job)
        with patch.object(NativeHelper,'align_selection',autospec=True,side_effect=self.exact_binding),patch.object(service,'_check_conflicts',side_effect=changed):
            with self.assertRaisesRegex(ProtocolFailure,'selection_invalid'):service.align(job,self.query())
        self.assertFalse(list(job.directory.glob('selection-*.json')))

    def test_large_parent_cache_identity_survives_sentence_regroup_and_limits(self):
        self.large_parent();manager,job,service=self.install_selection();self.regroup(manager,job,merged=True);query=self.query()
        before=(self.source.read_bytes(),(job.directory/'mono.pdf').read_bytes())
        binding,parent,start,end,key=service._prepare(job,query)
        self.assertGreater(len(parent['unit']['source'])+len(parent['unit']['target']),2048)
        with patch.object(NativeHelper,'align_selection',autospec=True,side_effect=self.exact_binding):original=service.align(job,query)
        self.regroup(manager,job,swapped=True)
        with patch.object(NativeHelper,'align_selection',side_effect=AssertionError('regroup replay called model')),patch.object(service,'_prewarm'):
            updated=service.align(job,query);self.assertTrue(updated['cached']);self.assertEqual(updated['key'],key)
            self.assertEqual(updated['link'],original['link']);self.assertEqual(service.links(job,0)['links'],[original['link']])
        changed=manager.read_alignment(job);changed['pages'][0]['paragraphs'][0]['sentences']=[]
        manager.publish_alignment(job,changed)
        fresh=selection.SelectionAlignmentService(manager)
        try:
            with patch.object(NativeHelper,'align_selection',side_effect=AssertionError('cached owner incorrectly needs model context')),patch.object(fresh,'_prewarm'):
                self.assertTrue(fresh.align(job,query)['cached']);self.assertEqual(fresh.links(job,0)['links'],[original['link']])
        finally:fresh.shutdown()
        self.assertEqual(len(list(job.directory.glob('selection-*.json'))),1)
        self.assertEqual((self.source.read_bytes(),(job.directory/'mono.pdf').read_bytes()),before)

    def legacy_scoped_record(self, service, job, query):
        binding,prepared,start,end,_=service._prepare(job,query)
        request,local_start,local_end=selection._model_request(prepared,query,start,end)
        parent=prepared['unit'];scoped={'id':parent['id']}
        for name in ('source','target'):
            ids={token['id'] for token in request[name]};tokens=[token for token in parent[name] if token['id'] in ids]
            offset=tokens[0]['start'];scoped[name+'Text']=parent[name+'Text'][offset:tokens[-1]['end']]
            scoped[name]=[{**token,'start':token['start']-offset,'end':token['end']-offset} for token in tokens]
            scoped[name+'Glyphs']=[g for token in tokens for g in token['glyphs']]
        owner=selection._input_digest(scoped)
        key=selection._input_digest([binding,phrase.EXTRACTION_REVISION,query['page'],query['paragraph'],owner,query['side'],local_start,local_end])
        match=self.exact_binding(None,request,query['side'],local_start,local_end)
        record={'schema':1,'binding':binding,'page':query['page'],'query':query,'ownerSHA256':owner,'key':key,'match':match,
            'link':service._materialize({**prepared,'unit':scoped},match,key)}
        path=job.directory/('selection-'+key+'.json');path.write_text(json.dumps(record));path.chmod(0o600);return path,record

    def test_legacy_scoped_record_expires_after_regroup_without_poisoning_new_record(self):
        self.large_parent();manager,job,service=self.install_selection();self.regroup(manager,job,merged=True);query=self.query()
        legacy,saved=self.legacy_scoped_record(service,job,query);before=legacy.read_bytes();self.regroup(manager,job,swapped=True)
        for fresh in (service,selection.SelectionAlignmentService(manager)):
            try:
                with patch.object(fresh,'_prewarm'):self.assertEqual(fresh.links(job,0)['links'],[])
            finally:
                if fresh is not service:fresh.shutdown()
        with patch.object(NativeHelper,'align_selection',autospec=True,side_effect=self.exact_binding):value=service.align(job,query)
        with patch.object(service,'_prewarm'):self.assertEqual(service.links(job,0)['links'],[value['link']])
        self.assertNotEqual(value['key'],saved['key']);self.assertEqual(legacy.read_bytes(),before)

    def test_legacy_scope_random_key_or_tampered_geometry_is_rejected(self):
        self.semantic_first_page();manager,job,service=self.install_selection();query=self.query()
        path,saved=self.legacy_scoped_record(service,job,query)
        for kind in ('key','geometry','schema'):
            record=copy.deepcopy(saved)
            if kind=='key':record['key']='f'*64
            elif kind=='geometry':record['link']['target']['text']='forged'
            else:record['schema']=2
            path.write_text(json.dumps(record))
            with patch.object(service,'_prewarm'),self.assertRaisesRegex(ProtocolFailure,'selection_invalid'):service.links(job,0)
        path.write_text('[]')
        with self.assertRaisesRegex(ProtocolFailure,'selection_invalid'):service.links(job,0)

    def test_cache_read_revalidates_generation_changed_after_prepare(self):
        self.semantic_first_page();manager,job,service=self.install_selection();query=self.query()
        with patch.object(NativeHelper,'align_selection',autospec=True,side_effect=self.exact_binding):service.align(job,query)
        original=service._record;changed=[]
        def publish_then_read(*args):
            if not changed:changed.append(True);self.publish_conflicting_phrase(manager,job)
            return original(*args)
        with patch.object(service,'_record',side_effect=publish_then_read),patch.object(NativeHelper,'align_selection',autospec=True,side_effect=self.exact_binding):
            with self.assertRaisesRegex(ProtocolFailure,'selection_invalid'):service.align(job,query)

    def test_schema_one_full_owner_cache_remains_usable(self):
        self.semantic_first_page();manager,job,service=self.install_selection();query=self.query()
        with patch.object(NativeHelper,'align_selection',autospec=True,side_effect=self.exact_binding):value=service.align(job,query)
        path=job.directory/('selection-'+value['key']+'.json');saved=json.loads(path.read_text());saved['schema']=1
        path.write_text(json.dumps(saved))
        with patch.object(NativeHelper,'align_selection',side_effect=AssertionError('full-owner schema1 was expired')),patch.object(service,'_prewarm'):
            self.assertTrue(service.align(job,query)['cached']);self.assertEqual(service.links(job,0)['links'],[value['link']])


del _SelectionFixture

if __name__=='__main__':unittest.main()
