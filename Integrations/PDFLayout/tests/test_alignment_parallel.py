"""Bounded background model I/O; real temporary PDF glyphs, no remote model."""
from __future__ import annotations
import copy
import threading
import time
import unittest
from unittest.mock import patch
import test_sentence_alignment as fixtures
from sentence_service import Upgrade
from worker import NativeHelper


class AlignmentParallelTests(unittest.TestCase):
    for _name in ("setUp","tearDown","manager","install","paragraph_fixture","prepared"):
        locals()[_name]=getattr(fixtures.SentenceAlignmentTests,_name)

    def background(self):
        self.paragraph_fixture(3)
        manager=self.manager();job=self.install(manager);temporary=manager.begin()
        (temporary.directory/"input.pdf").write_bytes(self.source.read_bytes())
        state=Upgrade(job,temporary,[0],[0],background=True,focus_page=0)
        manager.sentence_upgrades.upgrades[job.id]=state
        return manager,job,state

    def launch(self,manager,state):
        thread=threading.Thread(target=manager.sentence_upgrades._run,args=(state,));state.thread=thread;thread.start();return thread

    def test_background_pairs_real_paragraphs_with_two_model_slots_and_main_thread_pdf_commit(self):
        manager,job,state=self.background();gate=threading.Event();second=threading.Event();lock=threading.Lock();calls=[];owners=[];active=peak=0
        real=NativeHelper.align;publish=manager.publish_alignment;prepare=manager.sentence_upgrades._prepare_words
        def align(helper,request):
            nonlocal active,peak
            with lock:
                calls.append([p["id"] for p in request]);active+=1;peak=max(peak,active)
                if len(calls)==2:second.set()
            try:self.assertTrue(gate.wait(3));return real(helper,request)
            finally:
                with lock:active-=1
        def save(*args,**kwargs):owners.append(threading.get_ident());return publish(*args,**kwargs)
        def words(*args,**kwargs):owners.append(threading.get_ident());return prepare(*args,**kwargs)
        try:
            with patch.object(NativeHelper,"align",align),patch.object(manager,"publish_alignment",save),patch.object(manager.sentence_upgrades,"_prepare_words",words):
                thread=self.launch(manager,state)
                try:self.assertTrue(second.wait(1),"background sentence requests must overlap in exactly two slots")
                finally:gate.set()
                thread.join(5);self.assertFalse(thread.is_alive())
        finally:gate.set()
        self.assertEqual(state.state,"complete");self.assertEqual(peak,2)
        self.assertEqual(sorted(map(len,calls)),[1,2]);self.assertEqual(sorted(p for batch in calls for p in batch),["p0_0","p0_1","p0_2"])
        self.assertTrue(owners);self.assertEqual(set(owners),{thread.ident},"PDF extraction/materialization/publishing stay on coordinator")
        self.assertTrue(all(p.get("sentences") for p in manager.read_alignment(job)["pages"][0]["paragraphs"]))

    def test_invalid_pair_retains_its_valid_split_and_other_inflight_checkpoint_before_failure(self):
        from layout_common import ProtocolFailure
        manager,job,state=self.background();real=NativeHelper.align;calls=[]
        def align(helper,request):
            calls.append([p["id"] for p in request])
            if len(request)>1 or request[0]["id"]=="p0_1":raise ProtocolFailure("alignment_invalid")
            return real(helper,request)
        with patch.object(NativeHelper,"align",align):
            thread=self.launch(manager,state);thread.join(5);self.assertFalse(thread.is_alive())
        self.assertEqual(state.state,"failed");self.assertEqual(state.error,"alignment_invalid")
        saved=manager.read_alignment(job)["pages"][0];owned={p["id"]:p.get("sentences",[]) for p in saved["paragraphs"]}
        self.assertTrue(owned["p0_0"],"validated left split cannot be discarded when the right split fails")
        self.assertTrue(owned["p0_2"],"another accepted future must be drained and checkpointed")
        self.assertFalse(owned["p0_1"]);self.assertNotIn(0,state.prepared)
        self.assertTrue(all(len(batch)<=2 for batch in calls));self.assertLessEqual(len(calls),4)

    def test_invalid_first_split_still_checkpoints_its_valid_right_neighbor(self):
        from layout_common import ProtocolFailure
        manager,job,state=self.background();real=NativeHelper.align;calls=[]
        def align(helper,request):
            calls.append([p["id"] for p in request])
            if len(request)>1 or request[0]["id"]=="p0_0":raise ProtocolFailure("alignment_invalid")
            return real(helper,request)
        with patch.object(NativeHelper,"align",align):
            thread=self.launch(manager,state);thread.join(5);self.assertFalse(thread.is_alive())
        self.assertEqual(state.error,"alignment_invalid")
        saved=manager.read_alignment(job)["pages"][0];owned={p["id"]:p.get("sentences",[]) for p in saved["paragraphs"]}
        self.assertFalse(owned["p0_0"]);self.assertTrue(owned["p0_1"]);self.assertTrue(owned["p0_2"]);self.assertLessEqual(len(calls),4)

    def word_fixture(self,count=8):
        from sentence_service import SentenceUpgradeService
        import phrase_alignment as phrase
        from types import SimpleNamespace
        def side(text,y):return {"text":text,"glyphs":[{"text":c,"rect":[i*10,y,i*10+8,y+10],"line":0} for i,c in enumerate(text)]}
        units=[phrase.prepare_unit(f"p0_0_s{i}",side("Gene "+str(i),10),side("基因"+str(i),30)) for i in range(count)]
        page={"sourceToDual":[1,0,0,1,0,0],"targetToDual":[1,0,0,1,400,0],"paragraphs":[{"id":"p0_0","sentences":[{"id":u["id"],"source":{},"target":{}} for u in units]}]}
        manager=SimpleNamespace(lock=threading.RLock(),stopping=False);service=SentenceUpgradeService(manager)
        state=Upgrade(SimpleNamespace(id="parent",source_pages=[0]),None,[0],[],background=True,focus_page=0)
        return service,state,page,units

    def test_word_slots_recheck_priority_pause_and_commit_out_of_order_on_one_coordinator(self):
        from page_parallel import NativeHelperPool
        service,state,page,units=self.word_fixture();lock=threading.Lock();gates={i:threading.Event() for i in range(8)};calls=[];commits=[];active=peak=0;result={}
        class Helper:
            batch_timeout=100
            def __enter__(helper):return helper
            def __exit__(helper,*args):pass
            def cancel(helper):
                for gate in gates.values():gate.set()
            def align_phrases(helper,request):
                nonlocal active,peak
                key=int(request[0]["id"].split('_s')[-1])
                with lock:calls.append([u["id"] for u in request]);active+=1;peak=max(peak,active)
                try:
                    if not gates[key].wait(3):raise AssertionError('fixture turn not released')
                    return {u["id"]:[] for u in request}
                finally:
                    with lock:active-=1
        def wait_count(count):
            until=time.monotonic()+2
            while len(calls)<count and time.monotonic()<until:time.sleep(.005)
            self.assertGreaterEqual(len(calls),count)
        def publish(_state,_local,_physical,updated,_words):commits.append((threading.get_ident(),copy.deepcopy(updated)))
        with NativeHelperPool(Helper,2) as pool,patch.object(service,"_publish_words",publish):
            def run():
                try:result['value']=service._word_turns(pool,state,0,0,page,units,units)
                except Exception as error:result['error']=error
            thread=threading.Thread(target=run);thread.start()
            try:
                wait_count(2);self.assertEqual([row[0] for row in calls],[units[0]['id'],units[2]['id']]);state.priority_units[0]=[units[6]['id']]
                state.paused.set();gates[2].set();time.sleep(.08);self.assertEqual(len(calls),2,'pause cannot refill an empty slot')
                self.assertTrue(commits,'an accepted result can checkpoint while subsequent dispatch is paused')
                state.paused.clear();wait_count(3);self.assertEqual(calls[2],[units[6]['id']],'new selected unit takes the next available slot')
                gates[6].set();wait_count(4);self.assertEqual(calls[3],[units[4]['id'],units[5]['id']],'completed priority hint does not serialize the remaining page')
            finally:
                for gate in gates.values():gate.set()
                thread.join(4)
            self.assertFalse(thread.is_alive());self.assertNotIn('error',result);self.assertEqual(peak,2)
            self.assertEqual({owner for owner,_ in commits},{thread.ident});final,reason=result['value'];self.assertIsNone(reason)
            self.assertTrue(all(s.get('phraseAttemptRevision') for p in final['paragraphs'] for s in p['sentences']))
            self.assertTrue(all(p['sentences'][2].get('phraseAttemptRevision') for _,p in [(owner,value['paragraphs'][0]) for owner,value in commits[1:]]),'later serial commits retain an earlier out-of-order unit checkpoint')

    def test_cancel_closes_both_accepted_helpers_and_no_late_word_checkpoint_is_written(self):
        from page_parallel import NativeHelperPool
        from layout_common import ProtocolFailure
        service,state,page,units=self.word_fixture();entered=threading.Barrier(3);release=threading.Event();clients=[];calls=[];result={}
        class Helper:
            batch_timeout=100
            def __init__(helper):helper.closed=False;clients.append(helper)
            def __enter__(helper):return helper
            def __exit__(helper,*args):helper.closed=True
            def cancel(helper):helper.closed=True;release.set()
            def align_phrases(helper,request):calls.append(request);entered.wait(2);release.wait(3);return {u['id']:[] for u in request}
        with NativeHelperPool(Helper,2) as pool,patch.object(service,'_publish_words') as publish:
            def run():
                try:service._word_turns(pool,state,0,0,page,units,units)
                except Exception as error:result['error']=error
            thread=threading.Thread(target=run);thread.start()
            try:entered.wait(2);state.cancelled.set();pool.cancel()
            finally:release.set();thread.join(4)
            self.assertFalse(thread.is_alive());self.assertEqual(len(calls),2);self.assertTrue(all(h.closed for h in clients));self.assertEqual(str(result.get('error')),'alignment_cancelled');publish.assert_not_called()

    def test_word_split_salvages_right_sibling_but_never_starts_after_a_timeout(self):
        from layout_common import ProtocolFailure
        import phrase_alignment as phrase
        service,state,page,units=self.word_fixture(2);request=[phrase.request_unit(u) for u in units]
        for failure in ('alignment_invalid','alignment_timeout'):
            calls=[];budget={'calls':0,'deadline':time.monotonic()+90,'checkpoints':[]}
            class Helper:
                batch_timeout=100
                def align_phrases(helper,rows):
                    calls.append([u['id'] for u in rows])
                    if len(rows)>1:raise ProtocolFailure('alignment_invalid')
                    if rows[0]['id']==units[0]['id']:raise ProtocolFailure(failure)
                    return {rows[0]['id']:[]}
            with self.assertRaisesRegex(ProtocolFailure,failure):service._align_phrase_request(Helper(),request,state,budget)
            self.assertEqual(budget['calls'],3 if failure=='alignment_invalid' else 2)
            self.assertEqual([rows[0][0]['id'] for rows in budget['checkpoints']],[units[1]['id']] if failure=='alignment_invalid' else [])

    def test_foreground_invalid_split_keeps_its_original_short_circuit_without_background_checkpoint_work(self):
        from layout_common import ProtocolFailure
        import phrase_alignment as phrase
        service,state,page,units=self.word_fixture(2);state.background=False;request=[phrase.request_unit(u) for u in units]
        for background in (False,True):
            calls=[];budget={'calls':0,'deadline':time.monotonic()+90,**({'checkpoints':[]} if background else {})}
            class Helper:
                batch_timeout=100
                def align_phrases(helper,rows):
                    calls.append([u['id'] for u in rows])
                    if len(rows)>1 or rows[0]['id']==units[0]['id']:raise ProtocolFailure('alignment_invalid')
                    return {rows[0]['id']:[]}
            with self.assertRaisesRegex(ProtocolFailure,'alignment_invalid'):service._align_phrase_request(Helper(),request,state,budget)
            self.assertEqual(len(calls),3 if background else 2)

    def test_focus_change_drains_the_two_accepted_word_checkpoints_without_launching_an_old_page_tail(self):
        from page_parallel import NativeHelperPool
        service,state,page,units=self.word_fixture();gate=threading.Event();entered=threading.Barrier(3);calls=[];commits=[];result={}
        class Helper:
            batch_timeout=100
            def __enter__(helper):return helper
            def __exit__(helper,*args):pass
            def cancel(helper):gate.set()
            def align_phrases(helper,request):calls.append(request);entered.wait(2);gate.wait(3);return {u['id']:[] for u in request}
        with NativeHelperPool(Helper,2) as pool,patch.object(service,'_publish_words',lambda _u,_l,_p,value,_w:commits.append(copy.deepcopy(value))):
            def run():
                try:result['value']=service._word_turns(pool,state,0,0,page,units,units)
                except Exception as error:result['error']=error
            thread=threading.Thread(target=run);thread.start()
            try:entered.wait(2);state.focus_page=1;state.pending=[1]
            finally:gate.set();thread.join(3)
            self.assertFalse(thread.is_alive());self.assertNotIn('error',result);self.assertEqual(len(calls),2);self.assertEqual(len(commits),2)
            final,reason=result['value'];self.assertEqual(reason,'page');self.assertEqual(state.pending,[1,0])
            attempted=[s for p in final['paragraphs'] for s in p['sentences'] if s.get('phraseAttemptRevision')];self.assertEqual(len(attempted),4,'only accepted checkpoints can be marked attempted')

    def test_pause_arriving_while_waiting_for_a_lease_releases_slot_without_spending_model_budget(self):
        from page_parallel import NativeHelperPool
        from sentence_service import SentenceUpgradeService
        from types import SimpleNamespace
        manager=SimpleNamespace(stopping=False);service=SentenceUpgradeService(manager);paused=threading.Event();state=SimpleNamespace(cancelled=threading.Event(),paused=paused,phase='sentence');calls=[]
        request=fixtures.sentence.requests_for_page(self.prepared())[0]
        class Helper:
            batch_timeout=100
            def __enter__(helper):return helper
            def __exit__(helper,*args):pass
            def align(helper,rows):calls.append(rows);return {s['id']:[] for p in rows for s in p['source']}
        with NativeHelperPool(Helper,1) as pool:
            held=pool.lease();held.__enter__();budget={'calls':0,'deadline':time.monotonic()+.04};result={}
            def run():
                try:result['value']=service._align_request(pool,request,state,budget)
                except Exception as error:result['error']=error
            thread=threading.Thread(target=run);thread.start();time.sleep(.06);paused.set();held.__exit__(None,None,None);time.sleep(.06)
            self.assertEqual(calls,[]);self.assertEqual(budget['calls'],0)
            with pool.lease():pass
            paused.clear();thread.join(2);self.assertFalse(thread.is_alive());self.assertNotIn('error',result);self.assertEqual(len(calls),1);self.assertEqual(budget['calls'],1)

if __name__=="__main__":unittest.main()
