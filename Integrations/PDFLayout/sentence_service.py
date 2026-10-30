"""Independent, bounded sentence-sidecar upgrades for immutable cached PDFs."""
from __future__ import annotations

from dataclasses import dataclass, field
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from contextlib import nullcontext, contextmanager
from types import SimpleNamespace
from copy import deepcopy
from collections import Counter, OrderedDict
import threading
import time
import re
import hashlib
import json
import os
import uuid

from layout_common import ProtocolFailure
from sentence_alignment import (SENTENCE_REVISION, prepare_page, requests_for_page,
    upgrade_page, validate_matches, _normal, reusable_sentence_paragraph, paragraph_sentence_coverage,
    bind_verified_sentence_paragraph)
from phrase_alignment import (PHRASE_REVISION, prepare_phrase_page, phrase_requests,
    upgrade_phrase_page, validate_phrase_matches, EXTRACTION_REVISION,
    reusable_phrase_unit, phrase_page_coverage, identity_groups)
from layout_common import atomic_json
from page_parallel import NativeHelperPool
from batch_permits import PERMIT_SUBDIRECTORY

INDEX_REVISION="pdf-background-index-v1"
INDEX_FILE="alignment-index.json"
MAX_INDEX_BYTES=1024*1024
WORK_FILE="alignment-work.json"
WORK_REVISION="pdf-alignment-work-v1"
WORK_ERRORS={"alignment_cancelled","alignment_invalid","alignment_timeout","alignment_unavailable","gpt_unavailable"}
INDEX_COUNTS=("unavailableParagraphs","unavailableSentences","refusedWordUnits")


@dataclass
class Upgrade:
    parent: object
    temporary: object
    requested: list[int]
    pending: list[int]
    completed: set[int] = field(default_factory=set)
    state: str = "running"
    error: str | None = None
    mapped: int = 0
    current_page: int | None = None
    helper: object | None = None
    thread: object | None = None
    cancelled: threading.Event = field(default_factory=threading.Event)
    phase: str = "preparing"
    batch: int = 0
    batches: int = 0
    calls: int = 0
    error_detail: str | None = None
    focus_page: int | None = None
    priority_units: dict[int,list[str]] = field(default_factory=dict)
    background: bool = False
    paused: threading.Event = field(default_factory=threading.Event)
    scope: str | None = None
    prepared: set[int] = field(default_factory=set)
    partial: set[int] = field(default_factory=set)
    durable_source: object | None = None
    durable: bool = False

    def public(self):
        result={"id":self.parent.id,"state":self.state,"sourcePages":self.requested[:],
                "completedPages":sorted(self.completed),"mappedSentences":self.mapped,
                "currentPage":self.current_page,"pendingPages":self.pending[:],
                "phase":self.phase,"batch":self.batch,"batches":self.batches,"calls":self.calls}
        if self.background:result.update(background=True,paused=self.paused.is_set(),
            preparedPages=sorted(self.prepared),partialPages=sorted(self.partial))
        if self.durable:result["durable"]=True
        if self.scope is not None:result["scope"]=self.scope
        if self.error: result["error"]=self.error
        if self.error_detail:result["errorDetail"]=self.error_detail
        version=self.parent.cache_info.get("alignment",{}).get("sha256")
        if version:result["alignmentVersion"]=version
        return result


class SentenceUpgradeService:
    def __init__(self,manager):
        self.manager=manager
        self.upgrades={}
        self.cancelled_scopes=OrderedDict()
        self.work_pending=OrderedDict();self.work_summaries=OrderedDict();self.work_priorities={}
        self.work_thread=None;self.work_current=None;self.work_stopping=threading.Event()
        self.foreground_count=0

    @contextmanager
    def foreground(self):
        with self.manager.lock:self.foreground_count+=1
        try:yield
        finally:
            with self.manager.lock:self.foreground_count-=1

    def _blocked(self,upgrade):
        return ((getattr(upgrade,"paused",None) is not None and upgrade.paused.is_set())
                or getattr(upgrade,"durable",False) and self.foreground_count>0)

    def _work_record(self,parent):
        from server import _private_file
        try:
            _,raw=_private_file(parent.directory/WORK_FILE,MAX_INDEX_BYTES)
            def unique_object(pairs):
                result=dict(pairs)
                if len(result)!=len(pairs):raise ValueError('duplicate_field')
                return result
            record=json.loads(raw,object_pairs_hook=unique_object)
            if (set(record)!={"revision","kind","bindingSHA256","enabled","failedPages","error"}
                    or record["revision"]!=WORK_REVISION or record["kind"]!="explicit-whole"
                    or record["bindingSHA256"]!=self._index_binding(parent) or type(record["enabled"]) is not bool
                    or not isinstance(record["failedPages"],dict) or len(record["failedPages"])>len(parent.source_pages)
                    or any(key!=str(int(key)) or int(key) not in parent.source_pages or value not in WORK_ERRORS for key,value in record["failedPages"].items())
                    or record["error"] is not None and record["error"] not in WORK_ERRORS):return None
            return record
        except (OSError,ValueError,TypeError,KeyError):return None

    def _write_work(self,parent,record):
        # A crashed fixed-name atomic_json .tmp must not wedge future intent.
        staging=parent.directory/(".alignment-work-"+uuid.uuid4().hex+".json")
        try:atomic_json(staging,record);os.replace(staging,parent.directory/WORK_FILE)
        finally:
            staging.unlink(missing_ok=True);staging.with_suffix('.json.tmp').unlink(missing_ok=True)

    def validate_work_parent(self,parent,*,validate_ir=True):
        with self.manager.lock:
            if (parent.state!="complete" or parent.source_pages!=list(range(parent.page_count))
                    or self.manager._cached_job(parent.cache_info["cacheKey"]) is not parent):raise ProtocolFailure("alignment_invalid")
            if validate_ir:
                value=self.manager.read_alignment(parent)
                if value.get("sourceSHA256")!=parent.cache_info["sourceSHA256"]:raise ProtocolFailure("alignment_invalid")
            return self._index_binding(parent)

    def _work_source(self,parent,*,validate_ir=False):
        binding=self.validate_work_parent(parent,validate_ir=validate_ir)
        try:
            self.manager.selection_alignments._bindings(parent)
            source=self.manager.selection_alignments.source_path(parent)
        except ProtocolFailure as error:
            raise ProtocolFailure("alignment_unavailable" if str(error)=="selection_source_required" else "alignment_invalid") from None
        if self.validate_work_parent(parent,validate_ir=False)!=binding:raise ProtocolFailure("alignment_invalid")
        return source

    def _work_snapshot(self,parent,*,value=None):
        from server import _signature
        with self.manager.lock:
            active=self.upgrades.get(parent.id)
            if active is not None and active.state=="running":return active.public()
            try:index=_signature((parent.directory/INDEX_FILE).lstat())
            except OSError:index=None
            key=(parent.cache_info.get("alignment",{}).get("sha256"),index)
            cached=self.work_summaries.get(parent.id)
            if cached is not None and cached[0]==key:
                self.work_summaries.move_to_end(parent.id);return deepcopy(cached[1])
            if value is None:result=self.status(parent)
            else:
                completed=self._completed(value);records=self._index_records(parent,value)
                result={"id":parent.id,"state":"complete" if set(parent.source_pages)<=completed else "idle",
                    "sourcePages":parent.source_pages[:],"completedPages":sorted(completed),
                    "preparedPages":sorted(int(p) for p in records),"partialPages":sorted(int(p) for p,row in records.items() if row["partial"]),
                    "currentPage":None,"pendingPages":[],"mappedSentences":sum(len(p.get("sentences",[])) for page in value["pages"] for p in page["paragraphs"])}
            self.work_summaries[parent.id]=(key,deepcopy(result));self.work_summaries.move_to_end(parent.id)
            while len(self.work_summaries)>4:self.work_summaries.popitem(last=False)
            return result

    def work_status(self,parent):
        base={"id":parent.id,"state":"idle","sourcePages":parent.source_pages[:],"completedPages":[],"preparedPages":[],"partialPages":[],"mappedSentences":0,"currentPage":None,"pendingPages":[],"durable":False,"eligible":False,"workState":"unregistered"}
        record=self._work_record(parent)
        if record is None:return base
        base.update(durable=True,eligible=True)
        try:
            self._work_source(parent)
            value=self._work_snapshot(parent);base.update(value);base.update(sourcePages=parent.source_pages[:],durable=True,eligible=True)
            ready=set(base.get("completedPages",[]))|set(base.get("preparedPages",[]));failed=set(map(int,record["failedPages"]))
            pending=[p for p in parent.source_pages if p not in ready|failed]
            if record['error'] is not None or not record['enabled']:
                base.update(state='failed',workState='blocked',error=record['error'] or 'alignment_cancelled')
            elif pending:
                base.pop('error',None);base.pop('errorDetail',None)
                base.update(state='running',workState='running' if self.work_current==parent.id else 'queued')
                base['pendingPages']=[p for p in pending if p!=base.get('currentPage')]
            elif failed:
                base.update(state='failed',workState='blocked',error=next(iter(record['failedPages'].values())))
            else:
                base.pop('error',None);base.update(state='complete',workState='partial' if base.get('partialPages') else 'complete',currentPage=None,pendingPages=[])
        except (ProtocolFailure,OSError,ValueError,TypeError,KeyError):
            base.update(state='failed',workState='blocked',error='alignment_invalid')
        return base

    def _queue_work(self,parent):
        with self.manager.lock:
            if self.manager.stopping or self.work_stopping.is_set():return
            self.work_pending[parent.id]=None
            if self.work_thread is None:
                self.work_thread=threading.Thread(target=self._run_work,daemon=True,name='askgpt-alignment-work');self.work_thread.start()

    def register_work(self,parent):
        self._work_source(parent,validate_ir=True)
        with self.manager.lock:
            if self.manager.stopping:raise ProtocolFailure('service_stopping')
            record={"revision":WORK_REVISION,"kind":"explicit-whole","bindingSHA256":self._index_binding(parent),"enabled":True,"failedPages":{},"error":None}
            self._write_work(parent,record)
        value=self.work_status(parent)
        if value['state']=='running':self._queue_work(parent)
        return self.work_status(parent)

    def restore_work(self,parent,value):
        # Reuse startup's already validated IR; never reparse completed intent.
        record=self._work_record(parent)
        if record is None:return
        summary=self._work_snapshot(parent,value=value)
        ready=set(summary.get('completedPages',[]))|set(summary.get('preparedPages',[]));failed=set(map(int,record['failedPages']))
        if record['enabled'] and record['error'] is None and any(p not in ready|failed for p in parent.source_pages):self.work_pending[parent.id]=None

    def resume_work(self):
        # Dispatch only after all services and completed-job validation exist.
        if self.work_pending:
            parent=self.manager.jobs.get(next(iter(self.work_pending)))
            if parent is not None:self._queue_work(parent)

    def _run_work(self):
        while True:
            with self.manager.lock:
                if self.manager.stopping or self.work_stopping.is_set() or not self.work_pending:
                    self.work_current=None;self.work_thread=None;return
                identity,_=self.work_pending.popitem(last=False);parent=self.manager.jobs.get(identity);self.work_current=identity
            if parent is None:continue
            try:
                record=self._work_record(parent)
                if record is None or not record['enabled'] or record['error'] is not None:continue
                with self.manager.lock:
                    active=self.upgrades.get(parent.id)
                    busy=active is not None and active.state=='running' or self.foreground_count>0 or sum(u.state=='running' for u in self.upgrades.values())>=2
                if busy:
                    self._queue_work(parent);self.work_stopping.wait(.05);continue
                value=self._work_snapshot(parent);ready=set(value.get('completedPages',[]))|set(value.get('preparedPages',[]));failed=set(map(int,record['failedPages']))
                remaining=[p for p in parent.source_pages if p not in ready|failed]
                if not remaining:continue
                source=self._work_source(parent,validate_ir=True)
                preferred=self.work_priorities.get(parent.id);page=preferred if preferred in remaining else remaining[0];scope='work_'+uuid.uuid4().hex
                self.submit(parent,None,[page],background=True,scope=scope,durable_source=source)
                with self.manager.lock:active=self.upgrades.get(parent.id)
                if active is None or active.scope!=scope:
                    self._queue_work(parent);self.work_stopping.wait(.05);continue
                while active.thread.is_alive() and not self.work_stopping.is_set():active.thread.join(.05)
                if self.manager.stopping or self.work_stopping.is_set():continue
                with self.manager.lock:
                    record=self._work_record(parent)
                    if record is None:continue
                    if active.state=='failed':record['failedPages'][str(page)]=active.error if active.error in WORK_ERRORS else 'alignment_invalid';self._write_work(parent,record)
                self._queue_work(parent)
            except Exception as error:
                if self.manager.stopping or self.work_stopping.is_set():continue
                if isinstance(error,ProtocolFailure) and str(error)=='alignment_conflict':
                    self._queue_work(parent);self.work_stopping.wait(.05);continue
                with self.manager.lock:
                    record=self._work_record(parent)
                    if record is not None:
                        record['error']=str(error) if str(error) in WORK_ERRORS else 'alignment_invalid'
                        try:self._write_work(parent,record)
                        except OSError:pass

    @staticmethod
    def _index_binding(parent):
        from sentence_alignment import SENTENCE_EXTRACTION_REVISION
        info=parent.cache_info
        value=[info["sourceSHA256"],info["outputs"]["mono"]["sha256"],info["source"],info["target"],info.get("revision"),
            parent.source_pages,parent.page_count,SENTENCE_REVISION,SENTENCE_EXTRACTION_REVISION,PHRASE_REVISION,EXTRACTION_REVISION]
        return hashlib.sha256(json.dumps(value,separators=(",",":")).encode()).hexdigest()

    @staticmethod
    def _index_input(page):
        # New verified anchors invalidate a former refusal; phrase enrichment
        # itself must not invalidate the input of the next background visit.
        value=[{key:page[key] for key in ("sourcePage","source","mono","sourceToDual","targetToDual")},
            [{"id":p["id"],**{side:{key:p[side][key] for key in ("text","rects")} for side in ("source","target")},
                "sentences":[{"id":s["id"],"method":s["method"],**{side:{"text":_normal(s[side]["text"]),"rects":s[side]["rects"]} for side in ("source","target")}} for s in p.get("sentences",[])]}
             for p in page["paragraphs"]]]
        return hashlib.sha256(json.dumps(value,ensure_ascii=False,separators=(",",":")).encode()).hexdigest()

    def _index_records(self,parent,value):
        from server import _private_file
        try:
            _,raw=_private_file(parent.directory/INDEX_FILE,MAX_INDEX_BYTES)
            record=json.loads(raw)
            if (not isinstance(record,dict) or set(record)!={"revision","bindingSHA256","pages"}
                    or record["revision"]!=INDEX_REVISION or record["bindingSHA256"]!=self._index_binding(parent)
                    or not isinstance(record["pages"],dict) or len(record["pages"])>len(parent.source_pages)):return {}
            pages={str(p["sourcePage"]):p for p in value["pages"]};result={}
            for key,row in record["pages"].items():
                if (key not in pages or not isinstance(row,dict) or set(row)!={"inputSHA256","partial",*INDEX_COUNTS}
                        or type(row["partial"]) is not bool or any(type(row[k]) is not int or not 0<=row[k]<=200000 for k in INDEX_COUNTS)
                        or row["partial"]!=any(row[k] for k in INDEX_COUNTS)
                        or row["inputSHA256"]!=self._index_input(pages[key])):continue
                result[key]=row
            return result
        except (OSError,ValueError,TypeError,KeyError):return {}

    def _record_prepared(self,upgrade,local,physical,words,prepared):
        with self.manager.lock:
            if upgrade.cancelled.is_set() or self.manager.stopping:raise ProtocolFailure("alignment_cancelled")
            value=self.manager.read_alignment(upgrade.parent);page=value["pages"][local]
            records=self._index_records(upgrade.parent,value)
            sentences=[s for p in page["paragraphs"] for s in p.get("sentences",[])]
            extracted={unit["id"] for unit in words}
            counts={"unavailableParagraphs":int(bool(page.get("candidateTextUnavailable")))+sum(not paragraph_sentence_coverage(p) or (prepared is not None and p["id"] not in prepared) for p in page["paragraphs"]),
                "unavailableSentences":sum(s["id"] not in extracted for s in sentences),
                "refusedWordUnits":sum(s["id"] in extracted and not s.get("phrases") for s in sentences)}
            partial=any(counts.values())
            records[str(physical)]={"inputSHA256":self._index_input(page),"partial":partial,**counts}
            record={"revision":INDEX_REVISION,"bindingSHA256":self._index_binding(upgrade.parent),"pages":records}
            if len(json.dumps(record,separators=(",",":")).encode())>MAX_INDEX_BYTES:raise ProtocolFailure("alignment_invalid")
            atomic_json(upgrade.parent.directory/INDEX_FILE,record)
            upgrade.prepared.add(physical)
            if partial:upgrade.partial.add(physical)
            else:upgrade.partial.discard(physical)

    def _completed(self,value):
        if (value.get("phraseAlignmentRevision")!=PHRASE_REVISION
                or value.get("phraseExtractionRevision")!=EXTRACTION_REVISION):return set()
        # Old sidecars can contain valid links but have silently skipped whole
        # sentences. Revisit only their missing links, never their cached PDFs.
        marked=set(value.get("phrasePages",[]))&set(value.get("phraseExtractedPages",[]))
        return {page["sourcePage"] for page in value["pages"] if page["sourcePage"] in marked
            and not page.get("candidateTextUnavailable") and all(paragraph_sentence_coverage(p) for p in page["paragraphs"])}

    def _sentence_completed(self,value):
        return set(value.get("sentencePages",[])) if value.get("sentenceAlignmentRevision")==SENTENCE_REVISION else set()

    def validate_priority_units(self,parent,physical,units):
        if (type(physical) is not int or physical not in parent.source_pages or not isinstance(units,list)
                or len(units)>8 or any(not isinstance(unit,str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}",unit) for unit in units)
                or len(set(units))!=len(units)):raise ProtocolFailure("invalid_units")
        if not units:return []
        value=self.manager.read_alignment(parent)
        page=next(page for page in value["pages"] if page["sourcePage"]==physical)
        known={p["id"] for p in page["paragraphs"]}|{s["id"] for p in page["paragraphs"] for s in p.get("sentences",[])}
        if any(unit not in known for unit in units):raise ProtocolFailure("invalid_units")
        return units[:]

    @staticmethod
    def _focus(upgrade,selected,units=None):
        upgrade.focus_page=selected[0]
        if units is not None:upgrade.priority_units[selected[0]]=units[:]
        ahead=[page for page in selected if page not in upgrade.completed and page!=upgrade.current_page]
        upgrade.pending[:]=ahead+[page for page in upgrade.pending if page not in ahead]
        upgrade.requested=sorted(set(upgrade.requested)|set(selected))

    def prioritize(self,parent,physical,units):
        units=self.validate_priority_units(parent,physical,units)
        record=self._work_record(parent)
        if record is not None:
            value=self.work_status(parent)
            if value['workState'] in {'queued','running'}:
                with self.manager.lock:
                    self.work_priorities[parent.id]=physical;active=self.upgrades.get(parent.id)
                    if active is not None and active.state=='running' and active.durable:
                        active.paused.clear();active.priority_units[physical]=units[:]
                        if physical!=active.requested[0]:active.focus_page=physical;active.pending[:]=[physical]
                return self.work_status(parent)
            return value
        with self.manager.lock:
            active=self.upgrades.get(parent.id)
            if active is not None and active.state=="running":
                active.paused.clear();self._focus(active,[physical],units);return active.public()
            result={**self.status(parent),"state":"idle","currentPage":None,"pendingPages":[]}
            result.pop("error",None);result.pop("errorDetail",None)
            return result

    def status(self,parent):
        with self.manager.lock:
            active=self.upgrades.get(parent.id)
            if active is not None:
                if active.background and active.state!="running":
                    from server import _signature
                    try:signature=_signature((parent.directory/INDEX_FILE).lstat())
                    except OSError:signature=None
                    binding=(self._index_binding(parent),parent.cache_info.get("alignment",{}).get("sha256"),signature)
                    if binding!=getattr(active,"index_status_binding",None):
                        current=self.manager.read_alignment(parent);records=self._index_records(parent,current)
                        active.completed=self._completed(current)
                        active.prepared={int(p) for p in records};active.partial={int(p) for p,row in records.items() if row["partial"]}
                        active.index_status_binding=binding
                return active.public()
            value=self.manager.read_alignment(parent)
            completed=self._completed(value)
            records=self._index_records(parent,value)
            return {"id":parent.id,"state":"complete" if set(parent.source_pages)<=completed else "idle",
                "sourcePages":parent.source_pages[:],"completedPages":sorted(completed),
                "preparedPages":sorted(int(p) for p in records),"partialPages":sorted(int(p) for p,row in records.items() if row["partial"]),
                "currentPage":None,"pendingPages":[],
                "mappedSentences":sum(len(p.get("sentences",[])) for page in value["pages"] for p in page["paragraphs"])}

    def control(self,parent,action,scope=None):
        if not isinstance(action,str) or action not in {"pause","resume","cancel"}:raise ProtocolFailure("invalid_units")
        if scope is not None and (not isinstance(scope,str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}",scope)):raise ProtocolFailure("invalid_units")
        helper=None
        with self.manager.lock:
            if action=="cancel" and scope is not None:
                key=(parent.id,scope);self.cancelled_scopes[key]=True;self.cancelled_scopes.move_to_end(key)
                while len(self.cancelled_scopes)>128:self.cancelled_scopes.popitem(last=False)
            active=self.upgrades.get(parent.id)
            if active is None or active.state!="running" or not active.background or active.scope!=scope:return self.status(parent)
            if action=="pause":active.paused.set()
            else:active.paused.clear()
            if action=="cancel":
                active.cancelled.set();active.state="failed";active.error="alignment_cancelled";active.current_page=None
                helper=active.helper
            result=active.public()
        if helper is not None:helper.cancel()
        return result

    def _wait_active(self,upgrade):
        """Pause between bounded turns, without holding the PDF/metadata lock."""
        start=time.monotonic();phase=getattr(upgrade,"phase","preparing");paused=getattr(upgrade,"paused",None)
        while self._blocked(upgrade):
            if upgrade.cancelled.is_set() or getattr(self.manager,"stopping",False):raise ProtocolFailure("alignment_cancelled")
            upgrade.phase="paused";upgrade.cancelled.wait(.05)
        if upgrade.cancelled.is_set() or getattr(self.manager,"stopping",False):raise ProtocolFailure("alignment_cancelled")
        if getattr(upgrade,"phase",None)=="paused":upgrade.phase=phase
        return time.monotonic()-start

    def submit(self,parent,temporary,selected,priority_units=None,*,background=False,scope=None,durable_source=None):
        with self.manager.lock:
            if type(background) is not bool:raise ProtocolFailure("invalid_units")
            if scope is not None and (not background or not isinstance(scope,str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}",scope)):raise ProtocolFailure("invalid_units")
            if scope is not None and (parent.id,scope) in self.cancelled_scopes:raise ProtocolFailure("alignment_cancelled")
            if self.manager.stopping: raise ProtocolFailure("service_stopping")
            existing=self.upgrades.get(parent.id)
            if existing is not None and existing.state=="running" and background and (not existing.background or existing.scope!=scope):
                if priority_units is not None:self.validate_priority_units(parent,selected[0],priority_units)
                self.manager._discard_placeholder(temporary) if temporary is not None else None
                return existing.public()
            value=self.manager.read_alignment(parent)
            if priority_units is not None:
                if len(selected)!=1:raise ProtocolFailure("invalid_units")
                priority_units=self.validate_priority_units(parent,selected[0],priority_units)
            completed=self._completed(value)
            records=self._index_records(parent,value) if background else {}
            prepared={int(p) for p in records};partial={int(p) for p,row in records.items() if row["partial"]}
            if set(selected)<=completed|prepared:
                self.manager._discard_placeholder(temporary) if temporary is not None else None
                return {"id":parent.id,"state":"complete","sourcePages":selected[:],
                    "completedPages":sorted(completed),"currentPage":None,"pendingPages":[],
                    **({"preparedPages":sorted(prepared),"partialPages":sorted(partial)} if background else {}),
                    "mappedSentences":sum(len(p.get("sentences",[]))
                        for page in value["pages"] if page["sourcePage"] in selected for p in page["paragraphs"])}
            existing=self.upgrades.get(parent.id)
            if existing is not None and existing.state=="running":
                if background and (not existing.background or existing.scope!=scope):
                    self.manager._discard_placeholder(temporary) if temporary is not None else None
                    return existing.public()
                # A durable coordinator owns one fixed page; never expand its
                # failure/checkpoint owner when a legacy foreground route joins.
                if existing.durable:
                    physical=selected[0];self.work_priorities[parent.id]=physical;existing.paused.clear()
                    if priority_units is not None:existing.priority_units[physical]=priority_units[:]
                    if physical!=existing.requested[0]:existing.focus_page=physical;existing.pending[:]=[physical]
                else:self._focus(existing,selected,priority_units)
                self.manager._discard_placeholder(temporary) if temporary is not None else None
                return existing.public()
            if sum(x.state=="running" for x in self.upgrades.values())>=2:
                raise ProtocolFailure("alignment_conflict")
            upgrade=Upgrade(parent,temporary,selected[:],[p for p in selected if p not in completed|prepared],completed=completed,background=background,scope=scope,prepared=prepared,partial=partial,durable_source=durable_source,durable=durable_source is not None)
            self._focus(upgrade,selected,priority_units)
            self.upgrades[parent.id]=upgrade
            upgrade.thread=threading.Thread(target=self._run,args=(upgrade,),daemon=True)
            upgrade.thread.start()
            return upgrade.public()

    def _run(self,upgrade):
        from worker import NativeHelper
        manager=self.manager;foreground=None
        try:
            if not upgrade.background:foreground=self.foreground();foreground.__enter__()
            factory=lambda:NativeHelper(manager.translator,upgrade.parent.cache_info["source"],upgrade.parent.cache_info["target"])
            context=NativeHelperPool(factory,2,global_permit_directory=manager.cache_root/PERMIT_SUBDIRECTORY) if upgrade.background else factory()
            with context as helper:
                upgrade.helper=helper
                while True:
                    self._wait_active(upgrade)
                    source_input=manager.selection_alignments.source_path(upgrade.parent) if upgrade.durable else upgrade.temporary.directory/"input.pdf"
                    with manager.lock:
                        if upgrade.cancelled.is_set() or manager.stopping: raise ProtocolFailure("alignment_cancelled")
                        if not upgrade.pending:
                            upgrade.current_page=None
                            upgrade.state="complete"
                            upgrade.phase="complete"
                            break
                        if upgrade.durable and upgrade.pending[0]!=upgrade.requested[0]:
                            upgrade.state="complete";upgrade.phase="yielded";break
                        physical=upgrade.pending.pop(0)
                        if upgrade.background and physical in upgrade.prepared:continue
                        value=manager.read_alignment(upgrade.parent)
                        if physical in self._completed(value):
                            upgrade.completed.add(physical);continue
                        upgrade.current_page=physical
                        local=upgrade.parent.source_pages.index(physical)
                        page=value["pages"][local]
                        upgrade.phase="sentence_prepare"
                        upgrade.batch=upgrade.batches=upgrade.calls=0
                        # PyMuPDF calls are serialized, model turns are not.
                        import pymupdf
                        with pymupdf.open(source_input) as source, \
                                pymupdf.open(upgrade.parent.directory/"mono.pdf") as mono:
                            if len(source)!=upgrade.parent.page_count or len(mono)!=len(upgrade.parent.source_pages):
                                raise ProtocolFailure("alignment_invalid")
                            legacy_ready=physical in self._sentence_completed(value)
                            sentence_ready=legacy_ready and all(paragraph_sentence_coverage(p) for p in page["paragraphs"])
                            prepared_lookup=None if sentence_ready else {}
                            prepared=[] if sentence_ready else prepare_page(page,source[physical],mono[local])
                            if prepared_lookup is not None:prepared_lookup={p["id"]:p for p in prepared}
                            if legacy_ready and not sentence_ready:
                                page=deepcopy(page);lookup={p["id"]:p for p in prepared}
                                proof={u["id"]:u for u in prepare_phrase_page(page,source[physical],mono[local])}
                                for index,paragraph in enumerate(page["paragraphs"]):
                                    if paragraph["id"] not in lookup:continue
                                    bound=bind_verified_sentence_paragraph(paragraph,lookup[paragraph["id"]],proof)
                                    if bound is not None:page["paragraphs"][index]=bound
                    updated=deepcopy(page)
                    if legacy_ready and not sentence_ready:
                        # Old full-page markers sometimes concealed missing
                        # paragraphs. Keep proven neighbors and their words,
                        # and repair only the missing/unprovable paragraphs.
                        self._publish_sentences(upgrade,local,physical,updated,complete=False)
                    if not sentence_ready:
                        lookup={p["id"]:p for p in prepared}
                        if upgrade.background:
                            updated,reason=self._background_sentences(helper,upgrade,local,physical,updated,lookup)
                            if reason=="page":continue
                        else:
                            # Only the requested real paragraph enters a sentence
                            # turn. Its word links are published before neighboring
                            # paragraphs start, without weakening annotation bounds.
                            remaining=list(lookup)
                            for paragraph in updated["paragraphs"]:paragraph.setdefault("sentences",[])
                            yielded=False
                            while remaining:
                                with manager.lock:
                                    identity=self._paragraph_order(upgrade,physical,updated,remaining)[0]
                                    remaining.remove(identity)
                                paragraph=next(p for p in updated["paragraphs"] if p["id"]==identity)
                                item=lookup[identity]
                                if not reusable_sentence_paragraph(paragraph,item):
                                    matches={};requests=requests_for_page([item])
                                    upgrade.phase="sentence";upgrade.batch=upgrade.calls=0;upgrade.batches=len(requests)
                                    budget={"calls":0,"deadline":time.monotonic()+90}
                                    for request in requests:
                                        upgrade.batch+=1;upgrade.calls=0
                                        matches.update(self._align_request(helper,request,upgrade,budget))
                                    updated=upgrade_page(updated,[item],matches,preserve_unprepared=True)
                                    sentence_ready=self._sentence_page_ready(updated,lookup)
                                    self._publish_sentences(upgrade,local,physical,updated,complete=sentence_ready)
                                    if self._yield_page(upgrade,physical):yielded=True;break
                                owned={s["id"] for p in updated["paragraphs"] if p["id"]==identity for s in p.get("sentences",[])}
                                focused=set(upgrade.priority_units.get(physical,[]))
                                # Background indexing publishes all readable sentence
                                # anchors first and extracts the page's words once.
                                # An explicit selected unit retains its early turn.
                                if not upgrade.background or identity in focused or owned & focused:
                                    words=self._prepare_words(upgrade,local,physical,updated)
                                    updated,reason=self._word_turns(helper,upgrade,local,physical,updated,words,
                                        [u for u in words if u["id"] in owned],paragraph=identity,pending=remaining)
                                    if reason=="page":yielded=True;break
                                    if reason=="paragraph":remaining.append(identity)
                            if yielded:continue
                        sentence_ready=self._sentence_page_ready(updated,lookup)
                        # Missing/excluded paragraphs and semantic refusals are
                        # partial evidence, never a full-page completion flag.
                        self._publish_sentences(upgrade,local,physical,updated,complete=sentence_ready)
                    words=self._prepare_words(upgrade,local,physical,updated)
                    updated,reason=self._word_turns(helper,upgrade,local,physical,updated,words,words)
                    if reason=="page":continue
                    updated=upgrade_phrase_page(updated,words,{},reuse_verified=True,preserve_unprepared=True)
                    coverage_error="sentence_coverage" if not sentence_ready else self._coverage_error(updated,words)
                    if coverage_error:
                        upgrade.phase="coverage"
                        self._publish_words(upgrade,local,physical,updated,words)
                        if upgrade.background:
                            self._record_prepared(upgrade,local,physical,words,prepared_lookup)
                            upgrade.current_page=None
                            continue
                        failure=ProtocolFailure("alignment_unavailable");failure.error_detail=coverage_error
                        raise failure
                    self._publish_words(upgrade,local,physical,updated,words,complete=True)
                    if upgrade.background:self._record_prepared(upgrade,local,physical,words,prepared_lookup)
                    with manager.lock:
                        upgrade.completed.add(physical)
                        upgrade.mapped+=sum(len(p.get("sentences",[])) for p in updated["paragraphs"])
                        upgrade.current_page=None
        except Exception as error:
            allowed={"alignment_cancelled","alignment_invalid","alignment_timeout","gpt_unavailable","alignment_unavailable"}
            with manager.lock:
                upgrade.state="failed"
                upgrade.current_page=None
                upgrade.error="alignment_cancelled" if upgrade.cancelled.is_set() else str(error) if isinstance(error,ProtocolFailure) and str(error) in allowed else "alignment_invalid"
                detail=getattr(error,"error_detail",None)
                upgrade.error_detail=detail if detail in {"deadline","call_budget","jsonObject","count","rowShape","id","order","group","sentence_coverage","glyph_extraction"} else None
        finally:
            if foreground is not None:foreground.__exit__(None,None,None)
            upgrade.helper=None
            with manager.lock:
                if upgrade.temporary is not None and manager.jobs.get(upgrade.temporary.id) is upgrade.temporary:
                    (upgrade.temporary.directory/"state.json").unlink(missing_ok=True)
                    manager._discard_placeholder(upgrade.temporary)

    @staticmethod
    def _sentence_page_ready(page,prepared):
        return not page.get("candidateTextUnavailable") and all(p["id"] in prepared and reusable_sentence_paragraph(p,prepared[p["id"]])
            and paragraph_sentence_coverage(p) for p in page["paragraphs"])

    @staticmethod
    def _paragraph_order(upgrade,physical,page,identities):
        owner={s["id"]:p["id"] for p in page["paragraphs"] for s in p.get("sentences",[])}
        rank={}
        for index,identity in enumerate(upgrade.priority_units.get(physical,[])):
            rank.setdefault(owner.get(identity,identity),index)
        return sorted(identities,key=lambda identity:rank.get(identity,len(rank)))

    def _yield_page(self,upgrade,physical):
        self._wait_active(upgrade)
        with self.manager.lock:
            if upgrade.cancelled.is_set() or self.manager.stopping:raise ProtocolFailure("alignment_cancelled")
            if upgrade.focus_page!=physical and upgrade.focus_page in upgrade.pending:
                if physical not in upgrade.pending:upgrade.pending.append(physical)
                upgrade.current_page=None
                return True
            return False

    def _prepare_words(self,upgrade,local,physical,updated):
        self._wait_active(upgrade)
        import pymupdf
        source_input=self.manager.selection_alignments.source_path(upgrade.parent) if upgrade.durable else upgrade.temporary.directory/"input.pdf"
        with self.manager.lock:
            if upgrade.cancelled.is_set() or self.manager.stopping:raise ProtocolFailure("alignment_cancelled")
            upgrade.phase="phrase_prepare";upgrade.batch=upgrade.batches=upgrade.calls=0
            with pymupdf.open(source_input) as source, \
                    pymupdf.open(upgrade.parent.directory/"mono.pdf") as mono:
                return prepare_phrase_page(updated,source[physical],mono[local])

    def _background_batches(self,helper,upgrade,physical,has_work,take,align,dispatch=lambda:True):
        """At most two accepted batches; only this coordinator yields checkpoints."""
        futures={};failure=None
        executor=ThreadPoolExecutor(max_workers=2,thread_name_prefix="askgpt-alignment")
        try:
            while has_work() or futures:
                with self.manager.lock:
                    if upgrade.cancelled.is_set() or self.manager.stopping:raise ProtocolFailure("alignment_cancelled")
                    changed=upgrade.focus_page!=physical and upgrade.focus_page in upgrade.pending
                    paused=self._blocked(upgrade)
                    filling=not failure and not changed and not paused and dispatch()
                    while filling and has_work() and len(futures)<2:
                        request=take();budget={"calls":0,"deadline":time.monotonic()+90,"checkpoints":[]}
                        state=SimpleNamespace(cancelled=upgrade.cancelled,paused=upgrade.paused,phase=upgrade.phase,calls=0,durable=upgrade.durable)
                        upgrade.batch+=1;upgrade.calls=0;upgrade.batches=max(upgrade.batches,upgrade.batch)
                        futures[executor.submit(align,helper,request,state,budget)]=(request,budget)
                        changed=upgrade.focus_page!=physical and upgrade.focus_page in upgrade.pending
                        filling=not changed and not self._blocked(upgrade) and dispatch()
                if not futures:
                    if failure:raise failure
                    if changed or not dispatch():break
                    if paused:self._wait_active(upgrade)
                    continue
                done,_=wait(futures,timeout=.05,return_when=FIRST_COMPLETED)
                for future in done:
                    request,budget=futures.pop(future)
                    try:result=future.result()
                    except Exception as error:
                        if failure is None:failure=error
                        result=None
                    upgrade.calls=budget["calls"]
                    checkpoints=budget["checkpoints"] or ([(request,result)] if result is not None else [])
                    for requested,matches in checkpoints:
                        if upgrade.cancelled.is_set() or self.manager.stopping:raise ProtocolFailure("alignment_cancelled")
                        yield requested,matches
            if failure:raise failure
        finally:
            if futures:
                cancel=getattr(helper,"cancel",None)
                if callable(cancel):cancel()
            executor.shutdown(wait=True,cancel_futures=True)

    def _background_sentences(self,helper,upgrade,local,physical,updated,lookup):
        remaining=[]
        for identity,item in lookup.items():
            paragraph=next(p for p in updated["paragraphs"] if p["id"]==identity)
            if reusable_sentence_paragraph(paragraph,item):continue
            if requests_for_page([item]):remaining.append(identity)
            else:
                updated=upgrade_page(updated,[item],{},preserve_unprepared=True)
                self._publish_sentences(upgrade,local,physical,updated,complete=self._sentence_page_ready(updated,lookup))
        upgrade.phase="sentence";upgrade.batch=upgrade.calls=0;upgrade.batches=(len(remaining)+1)//2
        while remaining:
            early=set();focused_inflight=set()
            def take():
                order=self._paragraph_order(upgrade,physical,updated,remaining)
                focused=set(upgrade.priority_units.get(physical,[]))
                selected=[identity for identity in order if identity in focused or any(s["id"] in focused for p in updated["paragraphs"] if p["id"]==identity for s in p.get("sentences",[]))]
                candidates=selected[:2] if selected else order[:2]
                request=requests_for_page([lookup[identity] for identity in candidates])[0]
                for row in request:remaining.remove(row["id"])
                if selected:focused_inflight.update(row["id"] for row in request)
                return request
            for request,matches in self._background_batches(helper,upgrade,physical,lambda:bool(remaining),take,self._align_request,lambda:not early and not focused_inflight):
                focused_inflight.difference_update(row["id"] for row in request)
                matches=validate_matches(matches,request)
                updated=upgrade_page(updated,[lookup[row["id"]] for row in request],matches,preserve_unprepared=True)
                self._publish_sentences(upgrade,local,physical,updated,complete=self._sentence_page_ready(updated,lookup))
                focused=set(upgrade.priority_units.get(physical,[]));parents={row["id"] for row in request}
                for paragraph in updated["paragraphs"]:
                    if paragraph["id"] not in parents:continue
                    owned={s["id"] for s in paragraph.get("sentences",[])}
                    early.update(owned if paragraph["id"] in focused else owned&focused)
            if self._yield_page(upgrade,physical):return updated,"page"
            if early:
                words=self._prepare_words(upgrade,local,physical,updated)
                updated,reason=self._word_turns(helper,upgrade,local,physical,updated,words,[u for u in words if u["id"] in early])
                if reason=="page":return updated,"page"
        return updated,None

    def _word_turns(self,helper,upgrade,local,physical,updated,words,units,*,paragraph=None,pending=()):
        if self._yield_page(upgrade,physical):return updated,"page"
        existing={s["id"]:s for p in updated["paragraphs"] for s in p.get("sentences",[])}
        missing=[unit for unit in units if not reusable_phrase_unit(existing[unit["id"]],unit)]
        identities=[unit for unit in missing if identity_groups(unit)]
        if identities:
            updated=upgrade_phrase_page(updated,identities,{},reuse_verified=True,preserve_unprepared=True)
            self._publish_words(upgrade,local,physical,updated,words)
            if self._yield_page(upgrade,physical):return updated,"page"
        requests=phrase_requests(missing,background=upgrade.background)
        upgrade.phase="phrase";upgrade.batch=upgrade.calls=0;upgrade.batches=len(requests)
        if upgrade.background:
            def take():
                rank={identity:index for index,identity in enumerate(upgrade.priority_units.get(physical,[]))}
                for identity,pid in {s["id"]:p["id"] for p in updated["paragraphs"] for s in p.get("sentences",[])}.items():
                    if pid in rank and identity not in rank:rank[identity]=rank[pid]
                index=min(range(len(requests)),key=lambda index:min(rank.get(u["id"],len(rank)) for u in requests[index]))
                request=requests.pop(index);selected=[u for u in request if u["id"] in rank]
                if selected:
                    rest=[u for u in request if u["id"] not in rank]
                    if rest:requests.insert(index,rest);upgrade.batches+=1
                    request=selected
                return request
            for request,matches in self._background_batches(helper,upgrade,physical,lambda:bool(requests),take,self._align_phrase_request):
                matches=validate_phrase_matches(matches,request)
                requested={u["id"] for u in request};batch=[u for u in units if u["id"] in requested]
                updated=upgrade_phrase_page(updated,batch,matches,reuse_verified=True,preserve_unprepared=True)
                self._publish_words(upgrade,local,physical,updated,words)
            return updated,"page" if self._yield_page(upgrade,physical) else None
        while requests:
            if self._yield_page(upgrade,physical):return updated,"page"
            with self.manager.lock:
                priorities=upgrade.priority_units.get(physical,[])
                owner={s["id"]:p["id"] for p in updated["paragraphs"] for s in p.get("sentences",[])}
                # New same-page hints can interrupt the remaining work of an
                # old paragraph after its last atomic model checkpoint.
                if paragraph is not None and pending:
                    order=self._paragraph_order(upgrade,physical,updated,[paragraph,*pending])
                    if order[0]!=paragraph:return updated,"paragraph"
                rank={identity:index for index,identity in enumerate(priorities)}
                for identity,pid in owner.items():
                    if pid in rank and identity not in rank:rank[identity]=rank[pid]
                index=min(range(len(requests)),key=lambda index:min(rank.get(u["id"],len(rank)) for u in requests[index]))
                request=requests.pop(index)
                selected=[u for u in request if u["id"] in rank]
                if selected:
                    rest=[u for u in request if u["id"] not in rank]
                    if rest:requests.insert(index,rest);upgrade.batches+=1
                    request=selected
            upgrade.batch+=1;upgrade.calls=0
            if self._yield_page(upgrade,physical):return updated,"page"
            budget={"calls":0,"deadline":time.monotonic()+90}
            matches=self._align_phrase_request(helper,request,upgrade,budget)
            requested={u["id"] for u in request}
            batch=[u for u in units if u["id"] in requested]
            updated=upgrade_phrase_page(updated,batch,matches,reuse_verified=True,preserve_unprepared=True)
            self._publish_words(upgrade,local,physical,updated,words)
            if self._yield_page(upgrade,physical):return updated,"page"
        return updated,None

    def _publish_sentences(self,upgrade,local,physical,updated,*,complete=False):
        def transform(value):
            full=self._sentence_completed(value)
            partial=set(value.get("sentencePartialPages",[]))
            if complete:full.add(physical);partial.discard(physical)
            else:full.discard(physical);partial.add(physical)
            value["pages"][local]=updated;value["granularity"]="sentence"
            value["sentenceAlignmentRevision"]=SENTENCE_REVISION
            value["sentencePages"]=sorted(full);value["sentencePartialPages"]=sorted(partial)
            if physical in value.get("phraseExtractedPages",[]):
                value["phraseExtractedPages"]=[x for x in value["phraseExtractedPages"] if x!=physical]
            return value
        self.manager.update_alignment(upgrade.parent,transform,cancelled=upgrade.cancelled)

    @staticmethod
    def _coverage_error(page,words):
        """Readiness counts cannot hide missing translated paragraph anchors.

        Character multisets only gate completeness after independently proven
        PDF geometry; they never choose links, positions or translations.
        """
        extracted={unit["id"] for unit in words}
        for paragraph in page["paragraphs"]:
            if _normal(paragraph["source"]["text"])==_normal(paragraph["target"]["text"]):continue
            sentences=paragraph.get("sentences",[])
            for side in ("source","target"):
                expected=Counter(_normal(paragraph[side]["text"]))
                anchored=Counter("".join(_normal(sentence[side]["text"]) for sentence in sentences))
                if expected!=anchored:return "sentence_coverage"
            if any(sentence["id"] not in extracted for sentence in sentences):return "glyph_extraction"
        return None

    @staticmethod
    def _consume_call(upgrade,budget):
        remaining=budget["deadline"]-time.monotonic()
        upgrade.calls=budget["calls"]
        if budget["calls"]>=4 or remaining<=0:
            failure=ProtocolFailure("alignment_timeout")
            failure.error_detail="call_budget" if budget["calls"]>=4 else "deadline"
            raise failure
        budget["calls"]+=1;upgrade.calls=budget["calls"]
        return remaining

    def _publish_words(self,upgrade,local,physical,updated,words,*,complete=False):
        manager=self.manager
        def transform(value):
            extracted=self._completed(value)
            if complete:extracted.add(physical)
            else:extracted.discard(physical)
            value["pages"][local]=updated
            value["granularity"]="sentence"
            value["sentenceAlignmentRevision"]=SENTENCE_REVISION
            value["phraseAlignmentRevision"]=PHRASE_REVISION
            value["phrasePages"]=sorted(set(value.get("phrasePages",[]))|{physical})
            value["phraseExtractionRevision"]=EXTRACTION_REVISION
            value["phraseExtractedPages"]=sorted(extracted)
            value["phraseCoverage"]={**value.get("phraseCoverage",{}),str(physical):phrase_page_coverage(updated,words)}
            return value
        manager.update_alignment(upgrade.parent,transform,cancelled=upgrade.cancelled)

    def _model_turn(self,helper,method,request,upgrade,budget):
        while True:
            budget["deadline"]+=self._wait_active(upgrade)
            began=time.monotonic();lease=getattr(helper,"lease",None)
            with lease() if callable(lease) else nullcontext(helper) as actual:
                budget["deadline"]+=time.monotonic()-began
                if upgrade.cancelled.is_set() or getattr(self.manager,"stopping",False):raise ProtocolFailure("alignment_cancelled")
                if self._blocked(upgrade):continue
                remaining=self._consume_call(upgrade,budget);old_timeout=getattr(actual,"batch_timeout",100)
                if hasattr(actual,"batch_timeout"):actual.batch_timeout=min(old_timeout,remaining)
                try:return getattr(actual,method)(request)
                finally:
                    if hasattr(actual,"batch_timeout"):actual.batch_timeout=old_timeout

    @staticmethod
    def _repair_siblings(align,helper,request,upgrade,budget):
        result={};failure=None;middle=len(request)//2
        for part in (request[:middle],request[middle:]):
            try:result.update(align(helper,part,upgrade,budget))
            except ProtocolFailure as error:
                if str(error)!="alignment_invalid" or "checkpoints" not in budget:raise
                if failure is None:failure=error
        if failure is not None:raise failure
        return result

    def _align_request(self,helper,request,upgrade,budget=None):
        """Keep validated leaves if a later repair exhausts the same budget."""
        if budget is None:budget={"calls":0,"deadline":time.monotonic()+90}
        try:
            matches=validate_matches(self._model_turn(helper,"align",request,upgrade,budget),request)
            if "checkpoints" in budget:budget["checkpoints"].append((request,matches))
            return matches
        except ProtocolFailure as error:
            if str(error)=="alignment_timeout" and not getattr(error,"error_detail",None):error.error_detail="deadline"
            if str(error)!="alignment_invalid" or len(request)==1:raise
            return self._repair_siblings(self._align_request,helper,request,upgrade,budget)

    def _align_phrase_request(self,helper,request,upgrade,budget):
        try:
            matches=validate_phrase_matches(self._model_turn(helper,"align_phrases",request,upgrade,budget),request)
            if "checkpoints" in budget:budget["checkpoints"].append((request,matches))
            return matches
        except ProtocolFailure as error:
            if str(error)=="alignment_timeout" and not getattr(error,"error_detail",None):error.error_detail="deadline"
            if str(error)!="alignment_invalid" or len(request)==1:raise
            return self._repair_siblings(self._align_phrase_request,helper,request,upgrade,budget)

    def shutdown(self):
        self.work_stopping.set()
        with self.manager.lock:
            running=[x for x in self.upgrades.values() if x.thread is not None and x.thread.is_alive()]
            for upgrade in running: upgrade.cancelled.set()
        for upgrade in running:
            helper=upgrade.helper
            if helper is not None: helper.close()
        for upgrade in running:
            if upgrade.thread is not None and upgrade.thread is not threading.current_thread(): upgrade.thread.join(4)
        thread=self.work_thread
        if thread is not None and thread is not threading.current_thread():thread.join(4)
