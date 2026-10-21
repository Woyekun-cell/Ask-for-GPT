"""The interactive selection route uses real local PDFs and a fake JSONL helper."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_sentence_alignment as fixtures
from layout_common import ProtocolFailure
from worker import NativeHelper


class SelectionAlignmentTests(unittest.TestCase):
    setUp = fixtures.SentenceAlignmentTests.setUp
    tearDown = fixtures.SentenceAlignmentTests.tearDown
    manager = fixtures.SentenceAlignmentTests.manager
    install = fixtures.SentenceAlignmentTests.install
    service = fixtures.SentenceAlignmentTests.service
    request = fixtures.SentenceAlignmentTests.request

    def query(self, *, side="source", text="binds"):
        import pymupdf
        with pymupdf.open(self.source if side == "source" else self.mono) as pdf:
            found = pdf[0].search_for(text)
            self.assertEqual(len(found), 1)
            rect = list(found[0] * ~pdf[0].transformation_matrix)
        return {"page": 0, "paragraph": "p0_0", "side": side, "rects": [rect], "text": text}

    def selection_helper(self, *, null=False, warm_delay=0, warm_ready=True):
        self.helper.write_text("#!/usr/bin/env python3\nimport sys,json,pathlib,time,os\n"
            "assert sys.argv[1:]==['--gpt-selection-align']\n"
            f"calls=pathlib.Path({str(self.calls)!r})\n"
            f"frames=pathlib.Path({str(self.root/'selection-frames.jsonl')!r})\n"
            "for line in sys.stdin:\n"
            " r=json.loads(line)\n"
            " with frames.open('a') as f:f.write(json.dumps({'pid':os.getpid(),'request':r})+'\\n')\n"
            " if r.get('warmup'):\n"
            "  assert set(r)=={'id','warmup','source','target'}\n"
            f"  time.sleep({warm_delay!r})\n"
            f"  print(json.dumps({{'id':r['id'],'ready':{warm_ready!r}}}),flush=True);continue\n"
            " u=r['unit'];side=r['side'];start,end=r['range']\n"
            " chosen=u[side][start:end+1];other='target' if side=='source' else 'source'\n"
            " word=chosen[0]['text'];wanted={'binds':'Binding','Binding':'binds'}.get(word,word)\n"
            " counterpart=next((t for t in u[other] if t['text']==wanted),None)\n"
            " match=None if counterpart is None else {side+'IDs':[t['id'] for t in chosen],other+'IDs':[counterpart['id']]}\n"
            + (" match=None\n" if null else "") +
            " with calls.open('a') as f:f.write('selection\\n')\n"
            " print(json.dumps({'id':r['id'],'match':match,'totalSeconds':0.01,'firstDeltaSeconds':0.005}),flush=True)\n")
        self.helper.chmod(0o700)

    def post(self, service, job, query, *, upload=False, token="a"*64):
        route=f"/v1/pdf/jobs/{job.id}/selection-alignment"
        headers={"Content-Type":"application/pdf" if upload else "application/json"}
        body=self.source.read_bytes() if upload else json.dumps(query).encode()
        if upload:headers['X-AskGPT-Selection']=json.dumps(query)
        status,raw=self.request(service,"POST",route,body,token=token,extra_headers=headers)
        return status,json.loads(raw)

    def test_get_prewarms_without_source_returns_promptly_and_reuses_one_ready_helper(self):
        self.selection_helper(warm_delay=.8);manager=self.manager();job=self.install(manager);service=self.service(manager)
        route=f'/v1/pdf/jobs/{job.id}/selection-alignment?page=0';began=time.monotonic()
        for _ in range(3):
            status,raw=self.request(service,'GET',route);self.assertEqual((status,json.loads(raw)['links']),(200,[]))
        self.assertLess(time.monotonic()-began,.5,'GET must not wait for native session creation')
        self.assertFalse((job.directory/'selection-source.pdf').exists());self.assertFalse(self.calls.exists())
        deadline=time.monotonic()+3
        while not manager.selection_alignments.helpers and time.monotonic()<deadline:time.sleep(.01)
        self.assertTrue(manager.selection_alignments.helpers,'GET did not prepare a ready selection helper')
        frames=[json.loads(line) for line in (self.root/'selection-frames.jsonl').read_text().splitlines()]
        self.assertEqual(len(frames),1);self.assertEqual(set(frames[0]['request']),{'id','warmup','source','target'})
        self.assertEqual((frames[0]['request']['source'],frames[0]['request']['target']),('en','zh-Hans'))
        status,value=self.post(service,job,self.query(),upload=True);self.assertEqual(status,200,value)
        frames=[json.loads(line) for line in (self.root/'selection-frames.jsonl').read_text().splitlines()]
        self.assertEqual(len(frames),2);self.assertEqual(frames[0]['pid'],frames[1]['pid'])
        self.assertEqual(self.calls.read_text().splitlines(),['selection'])

    def test_failed_prewarm_never_enters_ready_pool_and_first_selection_still_falls_back(self):
        self.selection_helper(warm_ready=False);manager=self.manager();job=self.install(manager);service=self.service(manager)
        status,_=self.request(service,'GET',f'/v1/pdf/jobs/{job.id}/selection-alignment?page=0');self.assertEqual(status,200)
        deadline=time.monotonic()+3
        marker=self.root/'selection-frames.jsonl'
        while not marker.exists() and time.monotonic()<deadline:time.sleep(.01)
        self.assertTrue(marker.exists(),'GET never attempted its optional pair warmup')
        while manager.selection_alignments.warmup_threads and time.monotonic()<deadline:time.sleep(.01)
        self.assertFalse(manager.selection_alignments.warmup_threads);self.assertFalse(manager.selection_alignments.helpers)
        self.assertFalse(self.calls.exists())
        self.selection_helper()
        status,value=self.post(service,job,self.query(),upload=True);self.assertEqual(status,200,value)
        self.assertEqual(self.calls.read_text().splitlines(),['selection'])

    def test_shutdown_cancels_and_joins_inflight_prewarm_and_releases_its_slot(self):
        self.selection_helper(warm_delay=10);manager=self.manager();job=self.install(manager);service=self.service(manager)
        status,_=self.request(service,'GET',f'/v1/pdf/jobs/{job.id}/selection-alignment?page=0');self.assertEqual(status,200)
        marker=self.root/'selection-frames.jsonl';deadline=time.monotonic()+3
        while not marker.exists() and time.monotonic()<deadline:time.sleep(.01)
        self.assertTrue(marker.exists(),'GET never started the warmup helper')
        identity=json.loads(marker.read_text().splitlines()[0])['pid']
        threads=list(manager.selection_alignments.warmup_threads);self.assertEqual(len(threads),1)
        began=time.monotonic();manager.shutdown();self.assertLess(time.monotonic()-began,2)
        self.assertTrue(all(not thread.is_alive() for thread in threads));self.assertFalse(self.calls.exists())
        with self.assertRaises(ProcessLookupError):os.kill(identity,0)
        self.assertTrue(manager.selection_alignments.slots.acquire(blocking=False))
        self.assertTrue(manager.selection_alignments.slots.acquire(blocking=False))
        manager.selection_alignments.slots.release();manager.selection_alignments.slots.release()

    def test_json_requests_missing_verified_source_without_model_or_placeholder(self):
        manager=self.manager();job=self.install(manager);service=self.service(manager)
        before=set(manager.jobs)
        status,value=self.post(service,job,self.query())
        self.assertEqual((status,value.get('error')),(409,'selection_source_required'))
        self.assertEqual(set(manager.jobs),before)
        self.assertFalse(self.calls.exists())

    def test_cold_paragraph_maps_one_selection_and_keeps_original_sidecar_and_pdfs(self):
        self.selection_helper();manager=self.manager();job=self.install(manager);service=self.service(manager)
        old_alignment=manager.read_alignment(job);old_source=self.source.read_bytes();old_mono=(job.directory/'mono.pdf').read_bytes()
        status,value=self.post(service,job,self.query(),upload=True)
        self.assertEqual(status,200,value)
        self.assertEqual(value['revision'],'pdf-selection-semantic-v1')
        self.assertFalse(value['cached']);self.assertEqual(value['link']['source']['text'],'binds')
        self.assertEqual(value['link']['target']['text'],'Binding')
        self.assertEqual(value['page'],0);self.assertEqual(value['jobID'],job.id)
        self.assertEqual(value['sourceSHA256'],self.sha)
        self.assertEqual(value['targetSHA256'],hashlib.sha256(old_mono).hexdigest())
        self.assertEqual(manager.read_alignment(job),old_alignment)
        self.assertEqual(self.source.read_bytes(),old_source);self.assertEqual((job.directory/'mono.pdf').read_bytes(),old_mono)
        self.assertEqual((job.directory/'selection-source.pdf').stat().st_mode & 0o777,0o600)
        self.assertEqual(len(self.calls.read_text().splitlines()),1)

    def test_positive_and_negative_cache_survive_service_restart_without_model(self):
        for negative in [False,True]:
            with self.subTest(negative=negative):
                self.selection_helper(null=negative);manager=self.manager();job=self.install(manager);service=self.service(manager)
                query=self.query();status,first=self.post(service,job,query,upload=True);self.assertEqual(status,200,first)
                manager2=self.manager();job2=manager2.get(job.id);service2=self.service(manager2)
                with patch.object(NativeHelper,'align_selection',side_effect=AssertionError('cache hit called model')):
                    status,second=self.post(service2,job2,query)
                    self.assertEqual(status,200,second);self.assertTrue(second['cached']);self.assertEqual(second['link'],first['link'])
                    code,raw=self.request(service2,'GET',f'/v1/pdf/jobs/{job.id}/selection-alignment?page=0')
                listing=json.loads(raw);self.assertEqual(code,200,listing)
                self.assertEqual(listing['links'],[] if negative else [first['link']])

    def test_selection_timing_separates_native_turn_from_local_work_and_cache_replay(self):
        self.selection_helper();manager=self.manager();job=self.install(manager);service=self.service(manager)
        query=self.query();status,first=self.post(service,job,query,upload=True)
        self.assertEqual(status,200,first)
        timing=first['timing']
        self.assertEqual(timing['native'],{'totalSeconds':.01,'firstDeltaSeconds':.005})
        self.assertFalse(timing['helperReused'])
        for name in ('prepareSeconds','cacheReadSeconds','queueWaitSeconds','helperSetupSeconds',
                     'helperExchangeSeconds','validationAndSaveSeconds'):
            self.assertIs(type(timing[name]),float)
            self.assertGreaterEqual(timing[name],0)
            self.assertLessEqual(timing[name],timing['totalSeconds'])
        self.assertLessEqual(sum(timing[name] for name in timing if name.endswith('Seconds')
                                 and name!='totalSeconds'),timing['totalSeconds']+.00001)
        saved=json.loads(next(job.directory.glob('selection-*.json')).read_text())
        self.assertNotIn('timing',saved,'request diagnostics must not enter permanent word links')
        status,second=self.post(service,job,query)
        self.assertEqual(status,200,second);self.assertTrue(second['cached'])
        self.assertNotIn('native',second['timing'])
        self.assertNotIn('helperExchangeSeconds',second['timing'])
        self.assertEqual(self.calls.read_text().splitlines(),['selection'])

    def test_invalid_native_timing_never_changes_a_valid_match_or_leaks_previous_turn(self):
        self.selection_helper();manager=self.manager();job=self.install(manager);service=self.service(manager)
        self.assertEqual(self.post(service,job,self.query(),upload=True)[0],200)
        helper=manager.selection_alignments.helpers[0]
        self.assertEqual(helper.selection_timing,{'totalSeconds':.01,'firstDeltaSeconds':.005})
        from phrase_alignment import request_unit
        _,prepared,start,end,_=manager.selection_alignments._prepare(job,self.query())
        unit=request_unit(prepared['unit'])
        real=NativeHelper._selection_exchange
        for diagnostic in ({},{'totalSeconds':float('nan')},{'firstDeltaSeconds':True},
                           {'totalSeconds':-1},{'totalSeconds':1,'firstDeltaSeconds':2},
                           {'totalSeconds':float('inf')},{'totalSeconds':10**400},
                           {'totalSeconds':'secret text'}):
            with self.subTest(diagnostic=diagnostic):
                def exchange(owned,*args):
                    result=real(owned,*args)
                    result.pop('totalSeconds',None);result.pop('firstDeltaSeconds',None)
                    result.update(diagnostic)
                    return result
                with patch.object(NativeHelper,'_selection_exchange',exchange):
                    match=helper.align_selection(unit,'source',start,end)
                self.assertIsNotNone(match)
                self.assertEqual(helper.selection_timing,{})

    def test_same_query_concurrency_joins_one_independent_model_call(self):
        self.selection_helper();manager=self.manager();job=self.install(manager);service=self.service(manager)
        query=self.query();entered=threading.Event();release=threading.Event();results=[];real=NativeHelper.align_selection
        def delayed(helper,*args):entered.set();release.wait(3);return real(helper,*args)
        try:
            with patch.object(NativeHelper,'align_selection',delayed):
                first=threading.Thread(target=lambda:results.append(self.post(service,job,query,upload=True)));first.start()
                self.assertTrue(entered.wait(2))
                second=threading.Thread(target=lambda:results.append(self.post(service,job,query)));second.start()
                time.sleep(.05);release.set();first.join(3);second.join(3)
        finally:release.set()
        self.assertEqual(len(results),2);self.assertTrue(all(status==200 for status,_ in results),results)
        self.assertEqual(len(self.calls.read_text().splitlines()),1)
        self.assertEqual(results[0][1]['link'],results[1][1]['link'])
        follower=next(value for _,value in results if value['cached'])
        self.assertTrue(follower['timing']['sharedPending'])
        self.assertGreater(follower['timing']['deduplicatedWaitSeconds'],0)
        self.assertNotIn('native',follower['timing'])

    def split_first_page(self):
        import pymupdf
        paragraphs=[]
        with pymupdf.open(self.source) as source,pymupdf.open(self.mono) as target:
            for index,(left,right) in enumerate((('First fact binds.','Binding happens.'),
                                                ('Second fact blocks.','Blocking happens.'))):
                sides={}
                for name,page,text in (('source',source[0],left),('target',target[0],right)):
                    sides[name]={'text':text,'rects':[list(rect*~page.transformation_matrix) for rect in page.search_for(text)]}
                paragraphs.append({'id':f'p0_{index}',**sides,
                    'dualSource':{'rects':copy.deepcopy(sides['source']['rects'])},
                    'dualTarget':{'rects':[[x0+400,y0,x1+400,y1] for x0,y0,x1,y1 in sides['target']['rects']]}})
        self.value['pages'][0]['paragraphs']=paragraphs

    def test_different_paragraphs_reuse_one_verified_page_without_changing_word_keys(self):
        import io
        import selection_service as selection
        self.split_first_page();manager=self.manager();job=self.install(manager);service=manager.selection_alignments
        raw=self.source.read_bytes();service.install_source(job,io.BytesIO(raw),len(raw))
        first=self.query();second={**self.query(text='blocks'),'paragraph':'p0_1'}
        with patch.object(selection,'page_glyphs',wraps=selection.page_glyphs) as extract,\
                patch.object(manager,'read_alignment',wraps=manager.read_alignment) as read:
            _,a,_,_,_=service._prepare(job,first)
            binding,b,start,end,key=service._prepare(job,second)
        self.assertEqual(extract.call_count,2,'same-page paragraph changes must not re-extract both PDFs')
        self.assertEqual(read.call_count,1,'same-page paragraph changes must not decode the whole alignment again')
        self.assertIs(a['rows'],b['rows']);self.assertIs(a['page'],b['page'])
        fresh=selection.SelectionAlignmentService(manager)
        expected=fresh._prepare(job,second)
        self.assertEqual((binding,start,end,key),(expected[0],expected[2],expected[3],expected[4]))
        self.assertEqual(json.dumps(b,sort_keys=True),json.dumps(expected[1],sort_keys=True))
        fresh.shutdown()

    def test_page_cache_rejects_changed_alignment_before_a_new_paragraph_is_prepared(self):
        import io
        import server
        self.split_first_page();manager=self.manager();job=self.install(manager);service=manager.selection_alignments
        raw=self.source.read_bytes();service.install_source(job,io.BytesIO(raw),len(raw))
        service._prepare(job,self.query())
        path=server._alignment_path(job.directory,job.cache_info)
        path.write_bytes(path.read_bytes()+b' ')
        with self.assertRaises(ProtocolFailure):
            service._prepare(job,{**self.query(text='blocks'),'paragraph':'p0_1'})
        with self.assertRaises(ProtocolFailure):service._prepare(job,self.query())

    def test_page_eviction_releases_its_owner_references_and_keeps_exact_rebuild_keys(self):
        import io
        import pymupdf
        import selection_service as selection
        manager=self.manager();job=self.install(manager);service=manager.selection_alignments
        raw=self.source.read_bytes();service.install_source(job,io.BytesIO(raw),len(raw))
        with pymupdf.open(self.source) as source:
            rect=list(source[1].search_for('one')[0]*~source[1].transformation_matrix)
        other={'page':1,'paragraph':'p1_0','side':'source','rects':[rect],'text':'one'}
        with patch.object(selection,'MAX_PREPARED_PAGES',1):
            first=service._prepare(job,self.query())
            service._prepare(job,other)
            self.assertEqual(len(service.pages),1)
            self.assertTrue(all(key[0] in service.pages for key in service.owners))
            rebuilt=service._prepare(job,self.query())
            self.assertEqual((first[0],first[2:]),(rebuilt[0],rebuilt[2:]))
            self.assertEqual(json.dumps(first[1],sort_keys=True),json.dumps(rebuilt[1],sort_keys=True))
        self.assertEqual(len(service.pages),1)
        self.assertTrue(all(key[0] in service.pages for key in service.owners))

    def test_owner_hit_rejects_context_changed_during_preparation(self):
        import io
        manager=self.manager();job=self.install(manager);service=manager.selection_alignments
        raw=self.source.read_bytes();service.install_source(job,io.BytesIO(raw),len(raw))
        query=self.query();service._prepare(job,query)
        original=service._page_binding;calls=0;page_count=job.page_count
        def change_context(owned):
            nonlocal calls
            binding=original(owned);calls+=1
            if calls==1:owned.page_count+=1
            return binding
        try:
            with patch.object(service,'_page_binding',change_context),self.assertRaises(ProtocolFailure):
                service._prepare(job,query)
        finally:job.page_count=page_count
        self.assertEqual(calls,2)

    def test_concurrent_page_eviction_cannot_resurrect_a_late_owner(self):
        import io
        import pymupdf
        import selection_service as selection
        manager=self.manager();job=self.install(manager);service=manager.selection_alignments
        raw=self.source.read_bytes();service.install_source(job,io.BytesIO(raw),len(raw))
        with pymupdf.open(self.source) as source:
            rect=list(source[1].search_for('one')[0]*~source[1].transformation_matrix)
        other={'page':1,'paragraph':'p1_0','side':'source','rects':[rect],'text':'one'}
        entered=threading.Event();release=threading.Event();results=[];errors=[];original=selection._owner_side
        def paused(*args):
            if threading.current_thread() is thread:
                entered.set()
                if not release.wait(3):raise AssertionError('late owner test did not release its worker')
            return original(*args)
        def prepare():
            try:results.append(service._prepare(job,self.query()))
            except Exception as error:errors.append(error)
        thread=threading.Thread(target=prepare)
        try:
            with patch.object(selection,'MAX_PREPARED_PAGES',1),patch.object(selection,'_owner_side',paused):
                thread.start();self.assertTrue(entered.wait(2))
                service._prepare(job,other)
                release.set();thread.join(3)
        finally:release.set();thread.join(3)
        self.assertFalse(thread.is_alive());self.assertEqual(errors,[]);self.assertEqual(len(results),1)
        self.assertEqual(len(service.pages),1)
        self.assertTrue(all(key[0] in service.pages for key in service.owners))
        self.assertTrue(all(key[0][2]==1 for key in service.owners))

    def test_unknown_wrong_page_forged_text_and_ambiguous_parent_never_call_model(self):
        self.selection_helper();manager=self.manager();job=self.install(manager);service=self.service(manager);query=self.query()
        cases=[{**query,'paragraph':'unknown'},{**query,'page':1},{**query,'text':'invented'},
            {**query,'rects':[[0,0,399,249]],'text':'binds'},{**query,'page':True},{**query,'extra':'forbidden'}]
        for candidate in cases:
            status,value=self.post(service,job,candidate,upload=True)
            self.assertEqual(status,400,(candidate,value))
        self.assertFalse(self.calls.exists())

    def test_missing_authorization_and_wrong_uploaded_pdf_are_rejected(self):
        self.selection_helper();manager=self.manager();job=self.install(manager);service=self.service(manager);query=self.query()
        self.assertEqual(self.post(service,job,query,upload=True,token='b'*64)[0],401)
        status,raw=self.request(service,'POST',f'/v1/pdf/jobs/{job.id}/selection-alignment',self.mono.read_bytes(),
            extra_headers={'Content-Type':'application/pdf','X-AskGPT-Selection':json.dumps(query)})
        self.assertEqual((status,json.loads(raw)['error']),(400,'source_changed'))
        self.assertFalse((job.directory/'selection-source.pdf').exists());self.assertFalse(self.calls.exists())

    def test_tampered_small_cache_and_source_symlink_are_never_followed(self):
        self.selection_helper();manager=self.manager();job=self.install(manager);service=self.service(manager);query=self.query()
        status,value=self.post(service,job,query,upload=True);self.assertEqual(status,200,value)
        cached=job.directory/('selection-'+value['key']+'.json');cached.write_text('{}')
        status,value=self.post(service,job,query);self.assertEqual(status,400,value)
        (job.directory/'selection-source.pdf').unlink();(job.directory/'selection-source.pdf').symlink_to(self.source)
        status,value=self.post(service,job,query);self.assertEqual(status,400,value)

    def test_reverse_same_group_restores_once_and_conflicting_overlap_is_refused(self):
        self.selection_helper();manager=self.manager();job=self.install(manager);service=self.service(manager)
        status,first=self.post(service,job,self.query(),upload=True);self.assertEqual(status,200,first)
        status,reverse=self.post(service,job,self.query(side='target',text='Binding'));self.assertEqual(status,200,reverse)
        status,raw=self.request(service,'GET',f'/v1/pdf/jobs/{job.id}/selection-alignment?page=0')
        self.assertEqual(status,200);self.assertEqual(len(json.loads(raw)['links']),1)
        def conflict(helper,unit,side,start,end):
            source=next(t for t in unit['source'] if t['text']=='binds')
            return {'sourceIDs':[source['id']],'targetIDs':[unit['target'][start]['id']]}
        with patch.object(NativeHelper,'align_selection',conflict):
            status,value=self.post(service,job,self.query(side='target',text='Blocking'))
        self.assertEqual((status,value.get('error')),(400,'selection_invalid'))

    def test_duplicate_parent_ownership_is_ambiguous_even_when_query_id_is_unique(self):
        duplicate=copy.deepcopy(self.value['pages'][0]['paragraphs'][0]);duplicate['id']='p0_1'
        self.value['pages'][0]['paragraphs'].append(duplicate)
        self.selection_helper();manager=self.manager();job=self.install(manager);service=self.service(manager)
        status,value=self.post(service,job,self.query(),upload=True)
        self.assertEqual((status,value.get('error')),(400,'selection_invalid'));self.assertFalse(self.calls.exists())

    def test_new_link_cannot_conflict_with_existing_real_sentence_phrase(self):
        import pymupdf
        import sentence_alignment as sentence
        import phrase_alignment as phrase
        prepared=fixtures.SentenceAlignmentTests.prepared(self)
        relation={s['id']:[prepared[0]['target'][-1-i]['id']] for i,s in enumerate(prepared[0]['source'])}
        page=sentence.upgrade_page(self.value['pages'][0],prepared,relation)
        with pymupdf.open(self.source) as source,pymupdf.open(self.mono) as mono:words=phrase.prepare_phrase_page(page,source[0],mono[0])
        matches={}
        for unit in words:
            a=next((t for t in unit['source'] if t['text']=='binds'),None)
            b=next((t for t in unit['target'] if t['text']=='Binding'),None)
            if a and b:matches[unit['id']]=[{'sourceIDs':[t['id'] for t in unit['source']],
                'targetIDs':[t['id'] for t in unit['target']]}]
        self.value['pages'][0]=phrase.upgrade_phrase_page(page,words,matches)
        self.value.update(granularity='sentence',sentenceAlignmentRevision=sentence.SENTENCE_REVISION,sentencePages=[0],
            phraseAlignmentRevision=phrase.PHRASE_REVISION,phrasePages=[0])
        self.selection_helper();manager=self.manager();job=self.install(manager);service=self.service(manager)
        def conflict(helper,unit,side,start,end):
            source=next(t for t in unit['source'] if t['text']=='binds')
            return {'sourceIDs':[source['id']],'targetIDs':[unit['target'][start]['id']]}
        with patch.object(NativeHelper,'align_selection',conflict):
            status,value=self.post(service,job,self.query(side='target',text='Blocking'),upload=True)
        self.assertEqual((status,value.get('error')),(400,'selection_invalid'))
        old=manager.read_alignment(job)
        status,value=self.post(service,job,self.query())
        self.assertEqual(status,200,value)
        self.assertEqual(manager.read_alignment(job),old,'a word refinement must retain the old whole sentence group')

    def test_other_side_ambiguous_parent_cannot_publish_or_restore_a_link(self):
        duplicate=copy.deepcopy(self.value['pages'][0]['paragraphs'][0]);duplicate['id']='p0_1'
        duplicate['source']={'text':'Control one. Control two.','rects':copy.deepcopy(self.value['pages'][1]['paragraphs'][0]['source']['rects'])}
        # A separate source location cannot own the selected word; its target
        # deliberately overlaps the existing target paragraph.
        duplicate['source']['rects']=[[20,30,180,45]]
        duplicate['dualSource']={'rects':copy.deepcopy(duplicate['source']['rects'])}
        self.value['pages'][0]['paragraphs'].append(duplicate)
        self.selection_helper();manager=self.manager();job=self.install(manager);service=self.service(manager)
        status,value=self.post(service,job,self.query(),upload=True)
        self.assertEqual((status,value.get('error')),(400,'selection_invalid'))
        self.assertEqual(list(job.directory.glob('selection-*.json')),[])

    def test_restored_record_rechecks_both_sides_against_current_parent_proof(self):
        self.selection_helper();manager=self.manager();job=self.install(manager);service=self.service(manager)
        status,value=self.post(service,job,self.query(),upload=True);self.assertEqual(status,200,value)
        changed=manager.read_alignment(job);duplicate=copy.deepcopy(changed['pages'][0]['paragraphs'][0]);duplicate['id']='p0_1'
        duplicate['source']={'text':'Other prose','rects':[[20,30,180,45]]};duplicate['dualSource']={'rects':[[20,30,180,45]]}
        changed['pages'][0]['paragraphs'].append(duplicate);manager.publish_alignment(job,changed)
        with patch.object(NativeHelper,'align_selection',side_effect=AssertionError('changed live provenance reached model')):
            status,value=self.post(service,job,self.query())
            self.assertEqual((status,value.get('error')),(400,'selection_invalid'))
        manager2=self.manager();job2=manager2.get(job.id);service2=self.service(manager2)
        with patch.object(NativeHelper,'align_selection',side_effect=AssertionError('invalid cached ownership reached model')):
            status,value=self.post(service2,job2,self.query())
            self.assertEqual((status,value.get('error')),(400,'selection_invalid'))
            status,raw=self.request(service2,'GET',f'/v1/pdf/jobs/{job.id}/selection-alignment?page=0')
            self.assertEqual((status,json.loads(raw).get('error')),(400,'selection_invalid'))

    def test_consistent_nested_refinement_is_retained_in_both_direction_caches(self):
        self.selection_helper();manager=self.manager();job=self.install(manager);service=self.service(manager)
        def whole(helper,unit,side,start,end):
            source=[t['id'] for t in unit['source'][:3]]
            target=[t['id'] for t in unit['target'][-3:-1]]
            return {'sourceIDs':source,'targetIDs':target}
        query=self.query(text='First fact binds')
        with patch.object(NativeHelper,'align_selection',whole):
            status,group=self.post(service,job,query,upload=True)
        self.assertEqual(status,200,group)
        status,word=self.post(service,job,self.query())
        self.assertEqual(status,200,word)
        status,raw=self.request(service,'GET',f'/v1/pdf/jobs/{job.id}/selection-alignment?page=0')
        self.assertEqual(status,200);self.assertEqual(len(json.loads(raw)['links']),2)
        # A reverse broad group (both sides supersets) is equally compatible.
        with patch.object(NativeHelper,'align_selection',whole):
            status,reverse=self.post(service,job,self.query(side='target',text='Binding happens'))
        self.assertEqual(status,200,reverse)

    def test_two_active_interactive_queries_bound_the_third_without_waiting_for_background(self):
        self.selection_helper();manager=self.manager();job=self.install(manager);service=self.service(manager)
        # Install only the verified PDF; no sentence helper or speculative work.
        import io
        manager.selection_alignments.install_source(job,io.BytesIO(self.source.read_bytes()),self.source.stat().st_size)
        entered=threading.Event();release=threading.Event();count=[];results=[]
        def blocked(helper,*args):
            count.append(1)
            if len(count)==2:entered.set()
            release.wait(3);return None
        queries=[self.query(text=text) for text in ('binds','blocks','First')]
        threads=[]
        try:
            with patch.object(NativeHelper,'align_selection',blocked):
                for query in queries[:2]:
                    thread=threading.Thread(target=lambda q=query:results.append(self.post(service,job,q)));thread.start();threads.append(thread)
                self.assertTrue(entered.wait(2));began=time.monotonic();status,value=self.post(service,job,queries[2])
                self.assertEqual((status,value.get('error')),(409,'selection_busy'));self.assertLess(time.monotonic()-began,1)
                release.set()
                for thread in threads:thread.join(3)
        finally:release.set()
        self.assertTrue(all(status==200 for status,_ in results));self.assertEqual(len(count),2)

    def test_retiring_helpers_keep_the_two_permits_until_manager_shutdown_joins_them(self):
        self.selection_helper();manager=self.manager();job=self.install(manager);service=self.service(manager)
        release=threading.Event();real_reap=NativeHelper._reap_process
        def stalled_reap(process):
            if process is not None:release.wait(4)
            real_reap(process)
        def failed(helper,*args):helper._start(selection=True);raise ProtocolFailure('selection_invalid')
        try:
            with patch.object(NativeHelper,'_reap_process',side_effect=stalled_reap),patch.object(NativeHelper,'align_selection',failed):
                self.assertEqual(self.post(service,job,self.query(),upload=True)[0],400)
                self.assertEqual(self.post(service,job,self.query(text='blocks'))[0],400)
                self.assertEqual(len(manager.selection_alignments.retired_helpers),2)
                status,value=self.post(service,job,self.query(text='First'))
                self.assertEqual((status,value.get('error')),(409,'selection_busy'))
                release.set();manager.shutdown()
                self.assertEqual(len(manager.selection_alignments.retired_helpers),0)
        finally:release.set()


class SelectionHelperTests(unittest.TestCase):
    def test_warmup_is_pair_only_and_reuses_the_process_for_the_first_selection(self):
        import tempfile
        self.assertTrue(callable(getattr(NativeHelper,'warm_selection',None)),'native helper has no ready handshake')
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'helper';frames=Path(folder)/'frames'
            path.write_text("#!/usr/bin/env python3\nimport sys,json,pathlib\nassert sys.argv[1:]==['--gpt-selection-align']\n"
                f"frames=pathlib.Path({str(frames)!r})\n"
                "for line in sys.stdin:\n r=json.loads(line)\n"
                " with frames.open('a') as f:f.write(line)\n"
                " print(json.dumps({'id':r['id'],**({'ready':True} if r.get('warmup') else {'match':None})}),flush=True)\n")
            path.chmod(0o700)
            unit={'id':'u0','sourceText':'alpha','targetText':'甲','source':[{'id':'s0','text':'alpha'}],'target':[{'id':'t0','text':'甲'}]}
            with NativeHelper(path,'en','zh-Hans') as helper:
                helper.warm_selection();identity=helper.process.pid
                requests=[json.loads(line) for line in frames.read_text().splitlines()]
                self.assertEqual(len(requests),1);self.assertEqual(set(requests[0]),{'id','warmup','source','target'})
                self.assertIs(requests[0]['warmup'],True)
                self.assertIsNone(helper.align_selection(unit,'source',0,0));self.assertEqual(helper.process.pid,identity)

    def test_warmup_requires_matching_explicit_ready_ack_and_retires_failures(self):
        import tempfile
        self.assertTrue(callable(getattr(NativeHelper,'warm_selection',None)),'native helper has no ready handshake')
        for response in ["{'id':'wrong','ready':True}","{'id':r['id'],'ready':False}",
                "{'id':r['id'],'ready':True,'match':None}","{'id':r['id'],'error':'gpt_unavailable'}"]:
            with self.subTest(response=response),tempfile.TemporaryDirectory() as folder:
                path=Path(folder)/'helper'
                path.write_text("#!/usr/bin/env python3\nimport sys,json\nfor line in sys.stdin:\n r=json.loads(line)\n"
                    +f" print(json.dumps({response}),flush=True)\n")
                path.chmod(0o700)
                with NativeHelper(path,'en','zh-Hans') as helper:
                    with self.assertRaises(ProtocolFailure):helper.warm_selection()
                    self.assertIsNone(helper.process);self.assertTrue(helper.wait_selection_retired())

    def test_nested_refinement_requires_strict_change_on_both_sides(self):
        from selection_service import SelectionAlignmentService
        compatible=SelectionAlignmentService._compatible_groups
        whole={'source':{'DNA','polymerase'},'target':{'DNA','聚','合','酶'}}
        word={'source':{'polymerase'},'target':{'聚','合','酶'}}
        self.assertTrue(compatible(whole,whole));self.assertTrue(compatible(word,whole));self.assertTrue(compatible(whole,word))
        self.assertFalse(compatible({'source':{'genome'},'target':{'基','因'}},{'source':{'genome'},'target':{'基','因','组'}}))
        self.assertFalse(compatible({'source':{'DNA','polymerase'},'target':{'聚','合','酶'}},whole))
        self.assertFalse(compatible({'source':{'polymerase'},'target':{'DNA','聚','合','酶'}},whole))

    def test_new_selection_protocol_exists_before_starting_any_process(self):
        self.assertTrue(callable(getattr(NativeHelper,'align_selection',None)))

    def test_single_inclusive_selection_protocol_reuses_process_and_null_is_explicit(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'helper'
            path.write_text("#!/usr/bin/env python3\nimport sys,json\nassert sys.argv[1:]==['--gpt-selection-align']\n"
                "for line in sys.stdin:\n r=json.loads(line);assert r['range']==[0,0]\n"
                " print(json.dumps({'id':r['id'],'match':None}),flush=True)\n")
            path.chmod(0o700)
            unit={'id':'u0','sourceText':'alpha','targetText':'甲','source':[{'id':'s0','text':'alpha'}],'target':[{'id':'t0','text':'甲'}]}
            with NativeHelper(path,'en','zh-Hans') as helper:
                self.assertIsNone(helper.align_selection(unit,'source',0,0));pid=helper.process.pid
                self.assertIsNone(helper.align_selection(unit,'source',0,0));self.assertEqual(helper.process.pid,pid)
                self.assertEqual(helper.process_mode,'selection_alignment')

    def test_foreign_expanded_english_overlong_and_missing_null_matches_refuse(self):
        from selection_service import validate_selection_match,validate_selection_request
        unit={'id':'u0','sourceText':'alpha beta','targetText':'甲乙','source':[{'id':'s0','text':'alpha'},{'id':'s1','text':'beta'}],
            'target':[{'id':'t0','text':'甲'},{'id':'t1','text':'乙'}]}
        for match in [{'sourceIDs':['foreign'],'targetIDs':['t0']},{'sourceIDs':['s0','s1'],'targetIDs':['t0']}]:
            with self.assertRaises(ProtocolFailure):validate_selection_match(unit,'source',0,0,match,language='en')
        self.assertEqual(validate_selection_match(unit,'target',0,0,{'sourceIDs':['s0'],'targetIDs':['t0','t1']},language='zh-Hans')['targetIDs'],['t0','t1'])
        for start,end in [(True,0),(0,2),(-1,0),(1,0)]:
            with self.assertRaises(ProtocolFailure):validate_selection_request(unit,'source',start,end)

    def test_local_soft_hyphen_proof_retains_real_glyph_and_never_deletes_hard_hyphen(self):
        from selection_service import _owner_side
        text='nucleo\u00adtides';rows=[[{'text':c,'rect':[i*10,0,i*10+8,10],'origin':[i*10,0]} for i,c in enumerate(text)]]
        side={'text':'nucleo-tides','rects':[[0,0,len(text)*10,10]]}
        result=_owner_side(rows,side);self.assertEqual(result['text'],text);self.assertIn('\u00ad',[g['text'] for g in result['glyphs']])
        hard=[[{'text':c,'rect':[i*10,0,i*10+8,10],'origin':[i*10,0]} for i,c in enumerate('gene-name')]]
        with self.assertRaises(ProtocolFailure):_owner_side(hard,{'text':'genename','rects':[[0,0,90,10]]})

    def test_missing_match_foreign_id_and_timeout_close_without_retry(self):
        import tempfile
        unit={'id':'u0','sourceText':'alpha','targetText':'甲','source':[{'id':'s0','text':'alpha'}],'target':[{'id':'t0','text':'甲'}]}
        for body in ["print(json.dumps({'id':r['id']}),flush=True)",
                "print(json.dumps({'id':r['id'],'match':{'sourceIDs':['foreign'],'targetIDs':['t0']}}),flush=True)",
                "time.sleep(1)"]:
            with self.subTest(body=body),tempfile.TemporaryDirectory() as folder:
                path=Path(folder)/'helper';marker=Path(folder)/'calls';ready=Path(folder)/'ready'
                path.write_text("#!/usr/bin/env python3\nimport json,sys,time,pathlib\n"
                    +f"pathlib.Path({str(ready)!r}).write_text('ready')\nfor line in sys.stdin:\n r=json.loads(line)\n"
                    +f" with pathlib.Path({str(marker)!r}).open('a') as f:f.write('once\\n')\n "+body+"\n")
                path.chmod(0o700)
                with NativeHelper(path,'en','zh-Hans',batch_timeout=.5) as helper:
                    helper._start(selection=True);started=time.monotonic()+2
                    while not ready.exists() and time.monotonic()<started:time.sleep(.01)
                    self.assertTrue(ready.exists(),'protocol fixtures must start before timing their response')
                    with self.assertRaises(ProtocolFailure):helper.align_selection(unit,'source',0,0)
                    self.assertIsNone(helper.process)
                self.assertEqual(marker.read_text().splitlines(),['once'])

    def test_limits_refuse_long_selection_before_native_process_starts(self):
        import tempfile
        unit={'id':'u0','sourceText':'one two three four five','targetText':'甲',
            'source':[{'id':f's{i}','text':text} for i,text in enumerate('one two three four five'.split())],
            'target':[{'id':'t0','text':'甲'}]}
        with tempfile.TemporaryDirectory() as folder,NativeHelper(Path(folder)/'must-not-exist','en','zh-Hans') as helper:
            with self.assertRaises(ProtocolFailure):helper.align_selection(unit,'source',0,4)
            self.assertIsNone(helper.process)

    def test_selection_timeout_returns_before_stalled_helper_cleanup_grace_and_reaps_it(self):
        import signal
        import tempfile
        unit={'id':'u0','sourceText':'alpha','targetText':'甲','source':[{'id':'s0','text':'alpha'}],'target':[{'id':'t0','text':'甲'}]}
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'helper';marker=Path(folder)/'pid'
            path.write_text("#!/usr/bin/env python3\nimport signal,time,os,pathlib\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\n"
                +f"pathlib.Path({str(marker)!r}).write_text(str(os.getpid()))\ntime.sleep(20)\n")
            path.chmod(0o700)
            with NativeHelper(path,'en','zh-Hans',batch_timeout=.1) as helper:
                helper._start(selection=True)
                started=time.monotonic()+2
                while not marker.exists() and time.monotonic()<started:time.sleep(.01)
                self.assertTrue(marker.exists(),'the deliberately stalled fixture must be running before timing its timeout')
                began=time.monotonic()
                with self.assertRaisesRegex(ProtocolFailure,'selection_timeout'):helper.align_selection(unit,'source',0,0)
                elapsed=time.monotonic()-began
                self.assertLess(elapsed,.6,'interactive failures must not wait for the full helper retirement grace')
                self.assertIsNone(helper.process)
            identity=int(marker.read_text());deadline=time.monotonic()+4
            while time.monotonic()<deadline:
                try:os.kill(identity,0)
                except ProcessLookupError:break
                time.sleep(.025)
            else:
                os.kill(identity,signal.SIGKILL);self.fail('detached selection helper was not reaped')

    def test_normal_interpreter_exit_waits_for_owned_retired_selection_helper(self):
        import signal
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'helper';marker=Path(folder)/'pid'
            path.write_text("#!/usr/bin/env python3\nimport signal,time,os,pathlib\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\n"
                +f"pathlib.Path({str(marker)!r}).write_text(str(os.getpid()))\ntime.sleep(20)\n")
            path.chmod(0o700)
            code="""import sys,time,pathlib
sys.path.insert(0,sys.argv[1])
from worker import NativeHelper
from layout_common import ProtocolFailure
h=NativeHelper(pathlib.Path(sys.argv[2]),'en','zh-Hans',batch_timeout=.1)
h._start(selection=True)
while not pathlib.Path(sys.argv[3]).exists():time.sleep(.01)
unit={'id':'u0','sourceText':'alpha','targetText':'甲','source':[{'id':'s0','text':'alpha'}],'target':[{'id':'t0','text':'甲'}]}
try:h.align_selection(unit,'source',0,0)
except ProtocolFailure:pass
h.close()
print('returned',flush=True)
"""
            runner=subprocess.run([sys.executable,'-B','-c',code,str(Path(__file__).resolve().parents[1]),str(path),str(marker)],
                capture_output=True,text=True,timeout=7)
            self.assertEqual(runner.returncode,0,runner.stderr);self.assertIn('returned',runner.stdout)
            identity=int(marker.read_text())
            try:os.kill(identity,0)
            except ProcessLookupError:return
            os.kill(identity,signal.SIGKILL)
            self.fail('normal interpreter exit orphaned its retired selection helper')


if __name__=='__main__':unittest.main()
