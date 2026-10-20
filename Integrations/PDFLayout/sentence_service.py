"""Independent, bounded sentence-sidecar upgrades for immutable cached PDFs."""
from __future__ import annotations

from dataclasses import dataclass, field
from copy import deepcopy
from collections import Counter
import threading
import time
import re

from layout_common import ProtocolFailure
from sentence_alignment import (SENTENCE_REVISION, prepare_page, requests_for_page,
    upgrade_page, validate_matches, _normal, reusable_sentence_paragraph, paragraph_sentence_coverage,
    bind_verified_sentence_paragraph)
from phrase_alignment import (PHRASE_REVISION, prepare_phrase_page, phrase_requests,
    upgrade_phrase_page, validate_phrase_matches, EXTRACTION_REVISION,
    reusable_phrase_unit, phrase_page_coverage, identity_groups)


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

    def public(self):
        result={"id":self.parent.id,"state":self.state,"sourcePages":self.requested[:],
                "completedPages":sorted(self.completed),"mappedSentences":self.mapped,
                "currentPage":self.current_page,"pendingPages":self.pending[:],
                "phase":self.phase,"batch":self.batch,"batches":self.batches,"calls":self.calls}
        if self.error: result["error"]=self.error
        if self.error_detail:result["errorDetail"]=self.error_detail
        version=self.parent.cache_info.get("alignment",{}).get("sha256")
        if version:result["alignmentVersion"]=version
        return result


class SentenceUpgradeService:
    def __init__(self,manager):
        self.manager=manager
        self.upgrades={}

    def _completed(self,value):
        if (value.get("phraseAlignmentRevision")!=PHRASE_REVISION
                or value.get("phraseExtractionRevision")!=EXTRACTION_REVISION):return set()
        # Old sidecars can contain valid links but have silently skipped whole
        # sentences. Revisit only their missing links, never their cached PDFs.
        marked=set(value.get("phrasePages",[]))&set(value.get("phraseExtractedPages",[]))
        return {page["sourcePage"] for page in value["pages"] if page["sourcePage"] in marked
            and all(paragraph_sentence_coverage(p) for p in page["paragraphs"])}

    def _sentence_completed(self,value):
        return set(value.get("sentencePages",[])) if value.get("sentenceAlignmentRevision")==SENTENCE_REVISION else set()

    def validate_priority_units(self,parent,physical,units):
        if (type(physical) is not int or physical not in parent.source_pages or not isinstance(units,list)
                or len(units)>8 or any(not isinstance(unit,str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}",unit) for unit in units)
                or len(set(units))!=len(units)):raise ProtocolFailure("invalid_units")
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
        with self.manager.lock:
            units=self.validate_priority_units(parent,physical,units)
            active=self.upgrades.get(parent.id)
            if active is not None and active.state=="running":
                self._focus(active,[physical],units)
                return active.public()
            result={**self.status(parent),"state":"idle","currentPage":None,"pendingPages":[]}
            result.pop("error",None);result.pop("errorDetail",None)
            return result

    def status(self,parent):
        with self.manager.lock:
            active=self.upgrades.get(parent.id)
            if active is not None: return active.public()
            value=self.manager.read_alignment(parent)
            completed=self._completed(value)
            return {"id":parent.id,"state":"complete" if set(parent.source_pages)<=completed else "idle",
                "sourcePages":parent.source_pages[:],"completedPages":sorted(completed),
                "currentPage":None,"pendingPages":[],
                "mappedSentences":sum(len(p.get("sentences",[])) for page in value["pages"] for p in page["paragraphs"])}

    def submit(self,parent,temporary,selected,priority_units=None):
        with self.manager.lock:
            if self.manager.stopping: raise ProtocolFailure("service_stopping")
            value=self.manager.read_alignment(parent)
            if priority_units is not None:
                if len(selected)!=1:raise ProtocolFailure("invalid_units")
                priority_units=self.validate_priority_units(parent,selected[0],priority_units)
            completed=self._completed(value)
            if set(selected)<=completed:
                self.manager._discard_placeholder(temporary)
                return {"id":parent.id,"state":"complete","sourcePages":selected[:],
                    "completedPages":sorted(completed),"currentPage":None,"pendingPages":[],
                    "mappedSentences":sum(len(p.get("sentences",[]))
                        for page in value["pages"] if page["sourcePage"] in selected for p in page["paragraphs"])}
            existing=self.upgrades.get(parent.id)
            if existing is not None and existing.state=="running":
                # New visible pages get priority after the current model turn.
                self._focus(existing,selected,priority_units)
                self.manager._discard_placeholder(temporary)
                return existing.public()
            if sum(x.state=="running" for x in self.upgrades.values())>=2:
                raise ProtocolFailure("alignment_conflict")
            upgrade=Upgrade(parent,temporary,selected[:],[p for p in selected if p not in completed],completed=completed)
            self._focus(upgrade,selected,priority_units)
            self.upgrades[parent.id]=upgrade
            upgrade.thread=threading.Thread(target=self._run,args=(upgrade,),daemon=True)
            upgrade.thread.start()
            return upgrade.public()

    def _run(self,upgrade):
        from worker import NativeHelper
        manager=self.manager
        try:
            with NativeHelper(manager.translator,upgrade.parent.cache_info["source"],upgrade.parent.cache_info["target"]) as helper:
                upgrade.helper=helper
                while True:
                    with manager.lock:
                        if upgrade.cancelled.is_set() or manager.stopping: raise ProtocolFailure("alignment_cancelled")
                        if not upgrade.pending:
                            upgrade.current_page=None
                            upgrade.state="complete"
                            upgrade.phase="complete"
                            break
                        physical=upgrade.pending.pop(0)
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
                        with pymupdf.open(upgrade.temporary.directory/"input.pdf") as source, \
                                pymupdf.open(upgrade.parent.directory/"mono.pdf") as mono:
                            if len(source)!=upgrade.parent.page_count or len(mono)!=len(upgrade.parent.source_pages):
                                raise ProtocolFailure("alignment_invalid")
                            legacy_ready=physical in self._sentence_completed(value)
                            sentence_ready=legacy_ready and all(paragraph_sentence_coverage(p) for p in page["paragraphs"])
                            prepared=[] if sentence_ready else prepare_page(page,source[physical],mono[local])
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
                        # Only the requested real paragraph enters a sentence
                        # turn. Its word links are published before neighboring
                        # paragraphs start, without weakening annotation bounds.
                        lookup={p["id"]:p for p in prepared}
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
                            words=self._prepare_words(upgrade,local,physical,updated)
                            owned={s["id"] for p in updated["paragraphs"] if p["id"]==identity for s in p.get("sentences",[])}
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
                        failure=ProtocolFailure("alignment_unavailable");failure.error_detail=coverage_error
                        raise failure
                    self._publish_words(upgrade,local,physical,updated,words,complete=True)
                    with manager.lock:
                        upgrade.completed.add(physical)
                        upgrade.mapped+=sum(len(p.get("sentences",[])) for p in updated["paragraphs"])
                        upgrade.current_page=None
        except Exception as error:
            allowed={"alignment_cancelled","alignment_invalid","alignment_timeout","gpt_unavailable","alignment_unavailable"}
            with manager.lock:
                upgrade.state="failed"
                upgrade.current_page=None
                upgrade.error=str(error) if isinstance(error,ProtocolFailure) and str(error) in allowed else "alignment_invalid"
                detail=getattr(error,"error_detail",None)
                upgrade.error_detail=detail if detail in {"deadline","call_budget","jsonObject","count","rowShape","id","order","group","sentence_coverage","glyph_extraction"} else None
        finally:
            upgrade.helper=None
            with manager.lock:
                if manager.jobs.get(upgrade.temporary.id) is upgrade.temporary:
                    (upgrade.temporary.directory/"state.json").unlink(missing_ok=True)
                    manager._discard_placeholder(upgrade.temporary)

    @staticmethod
    def _sentence_page_ready(page,prepared):
        return all(p["id"] in prepared and reusable_sentence_paragraph(p,prepared[p["id"]])
            and paragraph_sentence_coverage(p) for p in page["paragraphs"])

    @staticmethod
    def _paragraph_order(upgrade,physical,page,identities):
        owner={s["id"]:p["id"] for p in page["paragraphs"] for s in p.get("sentences",[])}
        rank={}
        for index,identity in enumerate(upgrade.priority_units.get(physical,[])):
            rank.setdefault(owner.get(identity,identity),index)
        return sorted(identities,key=lambda identity:rank.get(identity,len(rank)))

    def _yield_page(self,upgrade,physical):
        with self.manager.lock:
            if upgrade.cancelled.is_set() or self.manager.stopping:raise ProtocolFailure("alignment_cancelled")
            if upgrade.focus_page!=physical and upgrade.focus_page in upgrade.pending:
                if physical not in upgrade.pending:upgrade.pending.append(physical)
                upgrade.current_page=None
                return True
            return False

    def _prepare_words(self,upgrade,local,physical,updated):
        import pymupdf
        with self.manager.lock:
            if upgrade.cancelled.is_set() or self.manager.stopping:raise ProtocolFailure("alignment_cancelled")
            upgrade.phase="phrase_prepare";upgrade.batch=upgrade.batches=upgrade.calls=0
            with pymupdf.open(upgrade.temporary.directory/"input.pdf") as source, \
                    pymupdf.open(upgrade.parent.directory/"mono.pdf") as mono:
                return prepare_phrase_page(updated,source[physical],mono[local])

    def _word_turns(self,helper,upgrade,local,physical,updated,words,units,*,paragraph=None,pending=()):
        if self._yield_page(upgrade,physical):return updated,"page"
        existing={s["id"]:s for p in updated["paragraphs"] for s in p.get("sentences",[])}
        missing=[unit for unit in units if not reusable_phrase_unit(existing[unit["id"]],unit)]
        identities=[unit for unit in missing if identity_groups(unit)]
        if identities:
            updated=upgrade_phrase_page(updated,identities,{},reuse_verified=True,preserve_unprepared=True)
            self._publish_words(upgrade,local,physical,updated,words)
            if self._yield_page(upgrade,physical):return updated,"page"
        requests=phrase_requests(missing)
        upgrade.phase="phrase";upgrade.batch=upgrade.calls=0;upgrade.batches=len(requests)
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
            budget={"calls":0,"deadline":time.monotonic()+90}
            if self._yield_page(upgrade,physical):return updated,"page"
            matches=self._align_phrase_request(helper,request,upgrade,budget)
            requested={u["id"] for u in request}
            batch=[u for u in units if u["id"] in requested]
            updated=upgrade_phrase_page(updated,batch,matches,reuse_verified=True,preserve_unprepared=True)
            self._publish_words(upgrade,local,physical,updated,words)
            if self._yield_page(upgrade,physical):return updated,"page"
        return updated,None

    def _publish_sentences(self,upgrade,local,physical,updated,*,complete=False):
        with self.manager.lock:
            if upgrade.cancelled.is_set() or self.manager.stopping:raise ProtocolFailure("alignment_cancelled")
            value=self.manager.read_alignment(upgrade.parent)
            full=self._sentence_completed(value)
            partial=set(value.get("sentencePartialPages",[]))
            if complete:full.add(physical);partial.discard(physical)
            else:full.discard(physical);partial.add(physical)
            value["pages"][local]=updated;value["granularity"]="sentence"
            value["sentenceAlignmentRevision"]=SENTENCE_REVISION
            value["sentencePages"]=sorted(full);value["sentencePartialPages"]=sorted(partial)
            if physical in value.get("phraseExtractedPages",[]):
                value["phraseExtractedPages"]=[x for x in value["phraseExtractedPages"] if x!=physical]
            self.manager.publish_alignment(upgrade.parent,value)

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
        with manager.lock:
            if upgrade.cancelled.is_set() or manager.stopping:raise ProtocolFailure("alignment_cancelled")
            value=manager.read_alignment(upgrade.parent)
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
            manager.publish_alignment(upgrade.parent,value)

    def _align_request(self,helper,request,upgrade,budget=None):
        """An ambiguous paragraph must not discard reliable neighboring IDs."""
        if upgrade.cancelled.is_set(): raise ProtocolFailure("alignment_cancelled")
        if budget is None: budget={"calls":0,"deadline":time.monotonic()+90}
        remaining=self._consume_call(upgrade,budget)
        old_timeout=getattr(helper,"batch_timeout",100)
        if hasattr(helper,"batch_timeout"): helper.batch_timeout=min(old_timeout,remaining)
        try: return validate_matches(helper.align(request),request)
        except ProtocolFailure as error:
            if str(error)=="alignment_timeout" and not getattr(error,"error_detail",None):error.error_detail="deadline"
            if str(error)!="alignment_invalid": raise
            if len(request)==1: raise
            middle=len(request)//2
            return {**self._align_request(helper,request[:middle],upgrade,budget),
                    **self._align_request(helper,request[middle:],upgrade,budget)}
        finally:
            if hasattr(helper,"batch_timeout"): helper.batch_timeout=old_timeout

    def _align_phrase_request(self,helper,request,upgrade,budget):
        """Refuse ambiguous words, with no sentence or proportional fallback."""
        if upgrade.cancelled.is_set(): raise ProtocolFailure("alignment_cancelled")
        remaining=self._consume_call(upgrade,budget)
        old_timeout=getattr(helper,"batch_timeout",100)
        if hasattr(helper,"batch_timeout"): helper.batch_timeout=min(old_timeout,remaining)
        try:return validate_phrase_matches(helper.align_phrases(request),request)
        except ProtocolFailure as error:
            if str(error)=="alignment_timeout" and not getattr(error,"error_detail",None):error.error_detail="deadline"
            if str(error)!="alignment_invalid": raise
            if len(request)==1:raise
            middle=len(request)//2
            return {**self._align_phrase_request(helper,request[:middle],upgrade,budget),
                    **self._align_phrase_request(helper,request[middle:],upgrade,budget)}
        finally:
            if hasattr(helper,"batch_timeout"):helper.batch_timeout=old_timeout

    def shutdown(self):
        with self.manager.lock:
            running=[x for x in self.upgrades.values() if x.thread is not None and x.thread.is_alive()]
            for upgrade in running: upgrade.cancelled.set()
        for upgrade in running:
            helper=upgrade.helper
            if helper is not None: helper.close()
        for upgrade in running:
            if upgrade.thread is not None and upgrade.thread is not threading.current_thread(): upgrade.thread.join(4)
