"""Independent, single-turn word links over immutable, proven PDF glyphs."""
from __future__ import annotations

from collections import Counter
from copy import deepcopy
from dataclasses import dataclass, field
import hashlib
import json
import math
import os
import re
import threading
import time
import uuid
import platform_ops as platform

from layout_common import MAX_PDF_BYTES, ProtocolFailure, atomic_json
from sentence_alignment import (_normal, _inside, _exact_glyph_substring, page_glyphs,
    _input_digest)
from phrase_alignment import (EXTRACTION_REVISION, prepare_unit, request_unit,
    validate_phrase_request, validate_phrase_matches, materialize_unit, _lexical)

REVISION = "pdf-selection-semantic-v1"
MAX_SELECTION_TOKENS = 128
MAX_SELECTION_WORDS = 32
MAX_QUERY_BYTES = 8192
MAX_RECORD_BYTES = 512 * 1024
MODEL_TIMEOUT = 20.0
WARMUP_TIMEOUT = 20.0
QUEUE_TIMEOUT = .2
MAX_HELPERS = 2
MAX_RESTORED_LINKS = 256
MAX_RESTORE_BYTES = 4 * 1024 * 1024
MAX_PREPARED_PAGES = 4


def parse_query(raw):
    def unique(pairs):
        result = dict(pairs)
        if len(result) != len(pairs): raise ValueError()
        return result
    try:
        if not isinstance(raw, bytes) or not 1 <= len(raw) <= MAX_QUERY_BYTES: raise ValueError()
        return validate_query(json.loads(raw, object_pairs_hook=unique))
    except (ValueError, TypeError, UnicodeError):
        raise ProtocolFailure("selection_invalid") from None


def validate_query(value):
    if (not isinstance(value, dict) or set(value) != {"page", "paragraph", "side", "rects", "text"}
            or type(value["page"]) is not int or not 0 <= value["page"] < 2000
            or not isinstance(value["paragraph"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value["paragraph"])
            or value["side"] not in ("source", "target")
            or not isinstance(value["text"], str) or not value["text"].strip()
            or len(value["text"]) > 2048 or any(0xD800 <= ord(c) <= 0xDFFF for c in value["text"])
            or not isinstance(value["rects"], list) or not 1 <= len(value["rects"]) <= 32):
        raise ProtocolFailure("selection_invalid")
    for rect in value["rects"]:
        if (not isinstance(rect, list) or len(rect) != 4
                or any(type(n) not in (int, float) or abs(n) > 1_000_000 or not math.isfinite(n) for n in rect)
                or rect[2] <= rect[0] or rect[3] <= rect[1]): raise ProtocolFailure("selection_invalid")
    if len(json.dumps(value, ensure_ascii=False).encode()) > MAX_QUERY_BYTES: raise ProtocolFailure("selection_invalid")
    return deepcopy(value)


def _selection_word_count(tokens):
    return sum(len(re.findall(r"[A-Za-z]+(?:['’\-][A-Za-z]+)*",token["text"])) for token in tokens)


def validate_selection_request(unit, side, start, end):
    validate_phrase_request([unit])
    if (side not in ("source", "target") or type(start) is not int or type(end) is not int
            or not 0 <= start <= end < len(unit[side]) or end-start+1 > MAX_SELECTION_TOKENS
            or _selection_word_count(unit[side][start:end+1]) > MAX_SELECTION_WORDS):
        raise ProtocolFailure("selection_invalid")


def validate_selection_match(unit, side, start, end, match, *, language=None):
    validate_selection_request(unit, side, start, end)
    if match is None: return None
    try:
        validate_phrase_matches({unit["id"]: [match]}, [unit],
            max_group_tokens=MAX_SELECTION_TOKENS,max_group_words=MAX_SELECTION_WORDS)
        for name in ("source","target"):
            claimed_ids=set(match[name+"IDs"])
            if _selection_word_count(token for token in unit[name] if token["id"] in claimed_ids)>MAX_SELECTION_WORDS:
                raise ValueError()
        selected = [row["id"] for row in unit[side][start:end+1]]
        claimed = match[side+"IDs"]
        chinese = language == "zh-Hans" if language is not None else any(
            "\u3400" <= c <= "\u9fff" for token in unit[side][start:end+1] for c in token["text"])
        if (not set(selected) <= set(claimed) or not chinese and selected != claimed): raise ValueError()
    except (ProtocolFailure, ValueError, KeyError, TypeError):
        raise ProtocolFailure("selection_invalid") from None
    return deepcopy(match)


def _glyph_key(glyph):
    return glyph["text"], tuple(round(x, 4) for x in glyph["rect"])


def _center_in(glyph, rect):
    box = glyph["rect"]
    return rect[0]-.05 <= (box[0]+box[2])/2 <= rect[2]+.05 and rect[1]-.05 <= (box[1]+box[3])/2 <= rect[3]+.05


def _owner_side(rows, side):
    # Keep real glyph text, including U+00AD. A literal IR '-' may represent
    # that physically present discretionary glyph; never erase hard hyphens.
    glyphs = []
    for row_index, row in enumerate(rows):
        chosen = []; previous = None; run = 0
        for index, glyph in enumerate(row):
            if not _inside(glyph["rect"], side["rects"], glyph.get("origin"), glyph["text"]): continue
            if previous is None or index != previous+1:
                if chosen: chosen.append({"text":" ", "rect":None, "line":None})
                run += 1
            chosen.append({"text":glyph["text"], "rect":[round(x,4) for x in glyph["rect"]], "line":row_index*100_000+run})
            previous = index
        if chosen:
            if glyphs: glyphs.append({"text":" ", "rect":None, "line":None})
            glyphs.extend(chosen)
    text = "".join(g["text"] for g in glyphs)
    if _normal(text) != _normal(side["text"]):
        exact = _exact_glyph_substring(glyphs, side["text"])
        if exact: glyphs = exact
        else:
            # Only substitute a real soft-hyphen glyph for this equality proof.
            # Returned geometry and text always retain the original PDF glyph.
            proof = [{**g, "text":g["text"].replace("\u00ad", "-")} for g in glyphs]
            selected = _exact_glyph_substring(proof, side["text"])
            if not selected: raise ProtocolFailure("selection_unavailable")
            first = next((i for i,g in enumerate(proof) if g is selected[0]), None)
            if first is None: raise ProtocolFailure("selection_unavailable")
            glyphs = glyphs[first:first+len(selected)]
    if not glyphs: raise ProtocolFailure("selection_unavailable")
    return {"text":"".join(g["text"] for g in glyphs), "glyphs":glyphs}


def _model_request(prepared, query, start, end):
    """Narrow only proven sentence context; retain immutable parent token IDs."""
    parent=prepared["unit"]; fallback=(request_unit(parent),start,end)
    try:
        side=query["side"]
        paragraphs=[p for p in prepared["page"]["paragraphs"] if p["id"]==parent["id"]==query["paragraph"]]
        if len(paragraphs)!=1:return fallback
        paragraph=paragraphs[0];sentences=paragraph.get("sentences",[])
        real=[g for row in prepared["rows"][side] for g in row if _normal(g["text"])
            and any(_center_in(g,r) for r in query["rects"])]
        if not real or _normal("".join(g["text"] for g in real))!=_normal(query["text"]):return fallback
        touches=[row for row in sentences if any(_inside(g["rect"],row[side]["rects"],g.get("origin"),g["text"]) for g in real)]
        if len(touches)!=1:return fallback
        sentence=touches[0]
        if sentence.get("method") not in {"semantic-model","glyph-identity"} or not all(
                _inside(g["rect"],sentence[side]["rects"],g.get("origin"),g["text"]) for g in real):return fallback
        sides={name:_owner_side(prepared["rows"][name],sentence[name]) for name in ("source","target")}
        local=prepare_unit(parent["id"],sides["source"],sides["target"])
        if local is None:return fallback
        request=request_unit(local);indices={}
        for name in ("source","target"):
            owned=Counter(_glyph_key(g) for g in parent[name+"Glyphs"] if g.get("rect") is not None)
            claimed=Counter(_glyph_key(g) for g in sides[name]["glyphs"] if g.get("rect") is not None)
            if not claimed or claimed-owned or any(count!=1 or owned[key]!=1 for key,count in claimed.items()):return fallback
            actual={}
            for row in prepared["rows"][name]:
                for glyph in row:actual.setdefault(_glyph_key(glyph),[]).append(glyph)
            for key in claimed:
                if len(actual.get(key,[]))!=1:return fallback
                glyph=actual[key][0]
                if not _normal(glyph["text"]):continue
                if any(row is not sentence and _inside(glyph["rect"],row[name]["rects"],glyph.get("origin"),glyph["text"]) for row in sentences):return fallback
                if any(p is not paragraph and _inside(glyph["rect"],p[name]["rects"],glyph.get("origin"),glyph["text"]) for p in prepared["page"]["paragraphs"]):return fallback
            # A sentence boundary may not split a Latin token or PDF ligature.
            # Match complete physical glyph tuples, never text/offset guesses.
            lookup={}
            for index,token in enumerate(parent[name]):
                signature=tuple(_glyph_key(g) for g in token["glyphs"] if g.get("rect") is not None)
                lookup.setdefault(signature,[]).append(index)
            positions=[]
            for token in local[name]:
                signature=tuple(_glyph_key(g) for g in token["glyphs"] if g.get("rect") is not None)
                matches=lookup.get(signature,[])
                if len(matches)!=1 or token["text"]!=parent[name][matches[0]]["text"]:return fallback
                positions.append(matches[0])
            if not positions or positions!=list(range(positions[0],positions[-1]+1)):return fallback
            indices[name]=positions
            request[name]=[{"id":parent[name][i]["id"],"text":parent[name][i]["text"]} for i in positions]
        selected=indices[side]
        if start not in selected or end not in selected:return fallback
        local_start,local_end=selected.index(start),selected.index(end)
        validate_selection_request(request,side,local_start,local_end)
        return request,local_start,local_end
    except (ProtocolFailure,KeyError,TypeError,ValueError,IndexError):
        return fallback


@dataclass
class _Pending:
    event: threading.Event = field(default_factory=threading.Event)
    result: dict | None = None
    error: str | None = None


class SelectionAlignmentService:
    def __init__(self, manager):
        self.manager = manager
        self.lock = threading.RLock()
        self.slots = threading.BoundedSemaphore(MAX_HELPERS)
        self.helpers = []
        self.active_helpers = set()
        self.retired_helpers = set()
        self.warming_pairs = set()
        self.warmup_threads = set()
        self.pending = {}
        self.sources = {}
        self.owners = {}
        self.pages = {}
        self.closed = False

    def _bindings(self, job):
        from server import _output_signature
        if job.state != "complete": raise ProtocolFailure("job_not_complete")
        if _output_signature(job.directory/"mono.pdf") != job.output_signatures.get("mono"):
            raise ProtocolFailure("selection_invalid")
        return {"jobID":job.id, "sourceSHA256":job.cache_info["sourceSHA256"],
            "targetSHA256":job.cache_info["outputs"]["mono"]["sha256"], "revision":REVISION}

    def source_path(self, job):
        from server import _private_file, _output_signature
        path = job.directory/"selection-source.pdf"
        try:
            signature = _output_signature(path, MAX_PDF_BYTES)
            with self.lock: previous = self.sources.get(job.id)
            if previous != signature:
                signature, digest = _private_file(path, MAX_PDF_BYTES, checksum=True)
                if digest != job.cache_info["sourceSHA256"]: raise ValueError()
                with self.lock: self.sources[job.id] = signature
        except FileNotFoundError: raise ProtocolFailure("selection_source_required") from None
        except (OSError, ValueError): raise ProtocolFailure("selection_invalid") from None
        return path

    def install_source(self, job, stream, length):
        from server import _private_file
        self._bindings(job)
        temporary = job.directory/(".selection-source-"+uuid.uuid4().hex+".pdf")
        try:
            descriptor = platform.secure_open(temporary, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                remaining = length
                while remaining:
                    chunk = stream.read(min(65536, remaining))
                    if not chunk: raise ProtocolFailure("incomplete_upload")
                    output.write(chunk); remaining -= len(chunk)
            _, digest = _private_file(temporary, MAX_PDF_BYTES, checksum=True)
            if digest != job.cache_info["sourceSHA256"]: raise ProtocolFailure("source_changed")
            with self.lock:
                final = job.directory/"selection-source.pdf"
                if final.exists() or final.is_symlink(): self.source_path(job)
                else: os.replace(temporary, final)
                return self.source_path(job)
        except (OSError, ValueError): raise ProtocolFailure("selection_invalid") from None
        finally: temporary.unlink(missing_ok=True)

    def _page_binding(self, job):
        from server import _output_signature, MAX_ALIGNMENT_BYTES
        try:
            with self.manager.lock:
                binding = self.manager._alignment_snapshot_binding(job)
                if _output_signature(binding[0],MAX_ALIGNMENT_BYTES) != binding[1]: raise ValueError()
                return binding
        except (OSError,ValueError,TypeError,KeyError):
            raise ProtocolFailure("selection_invalid") from None

    def _page_bundle(self, job, source_path, page_key, context, source_page):
        import pymupdf
        with self.lock: bundle = self.pages.get(page_key)
        if bundle is not None: return bundle
        value = self.manager.read_alignment(job)
        page = next(p for p in value["pages"] if p["sourcePage"] == source_page)
        # Do not introduce manager.lock then self.lock nesting: conflict
        # verification can reenter _prepare with self.lock already held.
        with self.manager.lock, pymupdf.open(source_path) as source, pymupdf.open(job.directory/"mono.pdf") as mono:
            if len(source) != job.page_count or len(mono) != len(job.source_pages): raise ProtocolFailure("selection_invalid")
            rows = {"source":page_glyphs(source[source_page]), "target":page_glyphs(mono[page["outputPage"]])}
        if self._page_binding(job) != context: raise ProtocolFailure("selection_invalid")
        with self.lock:
            bundle = self.pages.get(page_key)
            if bundle is None:
                if len(self.pages) >= MAX_PREPARED_PAGES:
                    evicted = next(iter(self.pages)); self.pages.pop(evicted)
                    # Owners share this exact page/rows tree; evict those
                    # references too so the page limit bounds retained trees.
                    self.owners = {key:owner for key,owner in self.owners.items() if key[0] != evicted}
                bundle = {"page":page, "rows":rows}; self.pages[page_key] = bundle
        return bundle

    def _prepare(self, job, query):
        binding = self._bindings(job)
        source_path = self.source_path(job)
        if query["page"] not in job.source_pages: raise ProtocolFailure("selection_invalid")
        context = self._page_binding(job)
        generation=job.cache_info.get("alignment",{}).get("sha256")
        page_key = (job.id, binding["targetSHA256"], query["page"], context)
        cache_key = (page_key,query["paragraph"])
        with self.lock: prepared = self.owners.get(cache_key)
        new_owner = prepared is None
        if prepared is None:
            bundle = self._page_bundle(job,source_path,page_key,context,query["page"])
            page,rows = bundle["page"],bundle["rows"]
            paragraphs = [p for p in page["paragraphs"] if p["id"] == query["paragraph"]]
            if len(paragraphs) != 1: raise ProtocolFailure("selection_invalid")
            paragraph = paragraphs[0]
            sides = {side:_owner_side(rows[side], paragraph[side]) for side in ("source", "target")}
            unit = prepare_unit(paragraph["id"], sides["source"], sides["target"])
            if unit is None: raise ProtocolFailure("selection_unavailable")
            validate_phrase_request([request_unit(unit)])
            prepared = {"unit":unit, "rows":rows, "page":page, "alignmentVersion":generation,
                "ownerSHA256":_input_digest(unit)}
        unit = prepared["unit"]; side = query["side"]
        real = [g for row in prepared["rows"][side] for g in row if _normal(g["text"])
            and any(_center_in(g, rect) for rect in query["rects"])]
        if not real or _normal("".join(g["text"] for g in real)) != _normal(query["text"]):
            raise ProtocolFailure("selection_invalid")
        owned = Counter(_glyph_key(g) for g in unit[side+"Glyphs"] if g.get("rect") is not None)
        selected = Counter(_glyph_key(g) for g in real)
        if selected-owned: raise ProtocolFailure("selection_invalid")
        if any(_inside(g["rect"], paragraph[side]["rects"], g.get("origin"), g["text"])
                for paragraph in prepared["page"]["paragraphs"] if paragraph["id"] != query["paragraph"] for g in real):
            raise ProtocolFailure("selection_invalid")
        indices = [i for i,token in enumerate(unit[side]) if any(_glyph_key(g) in selected for g in token["glyphs"])]
        if not indices or indices != list(range(indices[0], indices[-1]+1)): raise ProtocolFailure("selection_invalid")
        start, end = indices[0], indices[-1]
        # A selected Latin fragment must not silently become its whole token.
        # CJK may still expand later to its proven complete lexical equivalent.
        for token in unit[side][start:end+1]:
            if not _lexical(token): continue
            required=Counter(_glyph_key(g) for g in token["glyphs"] if g.get("rect") is not None and _normal(g["text"]))
            if required-selected:
                failure=ProtocolFailure("selection_invalid");failure.error_detail="partial_latin_token"
                raise failure
        validate_selection_request(request_unit(unit), side, start, end)
        key = _input_digest([binding, EXTRACTION_REVISION, query["page"], query["paragraph"],
            prepared["ownerSHA256"], side, start, end])
        if self._page_binding(job) != context: raise ProtocolFailure("selection_invalid")
        if new_owner:
            with self.lock:
                # A concurrent page eviction must not resurrect its retained
                # tree through an owner inserted after that eviction.
                if self.pages.get(page_key) is bundle:
                    if len(self.owners) >= 64: self.owners.pop(next(iter(self.owners)))
                    self.owners[cache_key] = prepared
        return binding, prepared, start, end, key

    def _record(self, job, path, binding, prepared, query, start, end, key):
        from server import _private_file
        try:
            _, raw = _private_file(path, MAX_RECORD_BYTES)
            value = json.loads(raw)
            required = {"schema", "binding", "page", "query", "ownerSHA256", "key", "match", "link"}
            if (not isinstance(value,dict) or set(value) != required or value["schema"] != 1
                    or value["binding"] != binding or value["page"] != query["page"]
                    or value["key"] != key or value["ownerSHA256"] != prepared["ownerSHA256"]): raise ValueError()
            language = job.cache_info[query["side"]]
            match = validate_selection_match(request_unit(prepared["unit"]), query["side"], start, end, value["match"], language=language)
            link = self._materialize(prepared, match, key)
            self._validate_link_ownership(prepared,link)
            if value["link"] != link: raise ValueError()
            return value
        except FileNotFoundError: return None
        except (OSError, ValueError, TypeError, KeyError, ProtocolFailure):
            raise ProtocolFailure("selection_invalid") from None

    @staticmethod
    def _materialize(prepared, match, key):
        if match is None: return None
        page = prepared["page"]
        link = materialize_unit(prepared["unit"], [match], page["sourceToDual"], page["targetToDual"])[0]
        link["id"] = "sel_"+key
        link["key"] = key
        link["paragraph"] = prepared["unit"]["id"]
        return link

    @staticmethod
    def _validate_link_ownership(prepared,link):
        if link is None:return
        page=prepared["page"];identity=prepared["unit"]["id"]
        for side in ("source","target"):
            real={}
            for row in prepared["rows"][side]:
                for glyph in row:real.setdefault(_glyph_key(glyph),[]).append(glyph)
            own=Counter(_glyph_key(g) for g in prepared["unit"][side+"Glyphs"] if g.get("rect") is not None)
            claimed=Counter(_glyph_key(g) for g in link[side]["glyphs"])
            if not claimed or claimed-own:raise ProtocolFailure("selection_invalid")
            for key in claimed:
                actual=real.get(key,[])
                if len(actual)!=1:raise ProtocolFailure("selection_invalid")
                glyph=actual[0]
                owners=[p["id"] for p in page["paragraphs"]
                    if _inside(glyph["rect"],p[side]["rects"],glyph.get("origin"),glyph["text"])]
                if owners!=[identity]:raise ProtocolFailure("selection_invalid")

    @staticmethod
    def _compatible_groups(incoming,other):
        # Keep both the whole phrase and a more specific word link. Both
        # sides must refine (or coarsen) together; crossed ownership refuses.
        return (incoming==other or all(incoming[side]<other[side] for side in incoming)
            or all(other[side]<incoming[side] for side in incoming))

    def _check_conflicts(self, job, binding, prepared, link):
        if link is None: return
        from server import _private_file
        incoming = {side:set(_glyph_key(g) for g in link[side]["glyphs"]) for side in ("source","target")}
        pools={side:Counter(_glyph_key(g) for g in prepared["unit"][side+"Glyphs"] if g.get("rect") is not None)
            for side in ("source","target")}
        for paragraph in prepared["page"]["paragraphs"]:
            if paragraph["id"]!=prepared["unit"]["id"]: continue
            for sentence in paragraph.get("sentences",[]):
                for old in sentence.get("phrases",[]):
                    proven=True;other={}
                    for side in ("source","target"):
                        glyphs=old[side].get("glyphs",[])
                        claimed=Counter(_glyph_key(g) for g in glyphs if g.get("rect") is not None)
                        if (not claimed or claimed-pools[side]
                                or _normal("".join(g["text"] for g in glyphs))!=_normal(old[side]["text"])):
                            proven=False;break
                        other[side]=set(claimed)
                    if proven and any(incoming[side]&other[side] for side in incoming) and not self._compatible_groups(incoming,other):
                        raise ProtocolFailure("selection_invalid")
        for path in job.directory.glob("selection-*.json"):
            try:
                _, raw = _private_file(path,MAX_RECORD_BYTES); saved=json.loads(raw)
                if saved.get("binding")!=binding or saved.get("ownerSHA256")!=prepared["ownerSHA256"] or saved.get("link") is None: continue
                query=validate_query(saved["query"])
                _, current, start, end, key=self._prepare(job,query)
                record=self._record(job,path,binding,current,query,start,end,key)
                other={side:set(_glyph_key(g) for g in record["link"][side]["glyphs"]) for side in ("source","target")}
                if any(incoming[side]&other[side] for side in incoming) and not self._compatible_groups(incoming,other):
                    raise ProtocolFailure("selection_invalid")
            except ProtocolFailure as error:
                if getattr(error,"error_detail",None)=="partial_latin_token": continue
                raise
            except (OSError,ValueError,TypeError,KeyError): raise ProtocolFailure("selection_invalid") from None

    @staticmethod
    def _response(binding, page, key, link, cached, began, phases=None):
        return {**binding, "page":page, "key":key, "link":deepcopy(link), "cached":cached,
            "timing":{**deepcopy(phases or {}), "totalSeconds":round(time.monotonic()-began,6)}}

    def align(self, job, query, *, retry=False):
        if type(retry) is not bool: raise ProtocolFailure("selection_invalid")
        began = time.monotonic(); query = validate_query(query)
        binding, prepared, start, end, key = self._prepare(job, query)
        phases = {"prepareSeconds":round(time.monotonic()-began,6)}
        phase_began = time.monotonic()
        path = job.directory/("selection-"+key+".json")
        record = self._record(job, path, binding, prepared, query, start, end, key)
        phases["cacheReadSeconds"] = round(time.monotonic()-phase_began,6)
        # Only an explicit retry may revisit a saved null. Proven links keep
        # their instant cache path, and concurrent retries join the same turn.
        if record is not None and (record["link"] is not None or not retry):
            return self._response(binding, query["page"], key, record["link"], True, began, phases)
        with self.lock:
            if self.closed or self.manager.stopping: raise ProtocolFailure("service_stopping")
            pending = self.pending.get((job.id,key)); owner = pending is None
            if owner:
                pending = _Pending(); self.pending[(job.id,key)] = pending
        if not owner:
            phase_began = time.monotonic()
            if not pending.event.wait(MODEL_TIMEOUT+1): raise ProtocolFailure("selection_timeout")
            if pending.error: raise ProtocolFailure(pending.error)
            phases["deduplicatedWaitSeconds"] = round(time.monotonic()-phase_began,6)
            phases["sharedPending"] = True
            return self._response(binding,query["page"],key,pending.result["link"],True,began,phases)
        helper = None; acquired = False; foreground = None
        try:
            phase_began = time.monotonic()
            if not self.slots.acquire(timeout=QUEUE_TIMEOUT): raise ProtocolFailure("selection_busy")
            acquired = True
            phases["queueWaitSeconds"] = round(time.monotonic()-phase_began,6)
            phase_began = time.monotonic()
            record = self._record(job,path,binding,prepared,query,start,end,key)
            phases["cacheReadSeconds"] += round(time.monotonic()-phase_began,6)
            if record is not None and (record["link"] is not None or not retry):
                pending.result = self._response(binding,query["page"],key,record["link"],True,began,phases)
                return deepcopy(pending.result)
            phase_began = time.monotonic()
            from worker import NativeHelper
            pair = (job.cache_info["source"], job.cache_info["target"])
            with self.lock:
                if self.closed: raise ProtocolFailure("service_stopping")
                available = next((h for h in self.helpers if (h.source,h.target) == pair), None)
                phases["helperReused"] = available is not None
                if available: self.helpers.remove(available); helper = available
                else:
                    if len(self.helpers)+len(self.active_helpers) >= MAX_HELPERS and self.helpers:
                        self.helpers.pop(0).close()
                    helper = NativeHelper(self.manager.translator, *pair, batch_timeout=MODEL_TIMEOUT)
                self.active_helpers.add(helper)
            phases["helperSetupSeconds"] = round(time.monotonic()-phase_began,6)
            phase_began = time.monotonic()
            model_unit,model_start,model_end=_model_request(prepared,query,start,end)
            foreground=self.manager.sentence_upgrades.foreground();foreground.__enter__()
            match = helper.align_selection(model_unit, query["side"], model_start, model_end)
            phases["helperExchangeSeconds"] = round(time.monotonic()-phase_began,6)
            if helper.selection_timing: phases["native"] = deepcopy(helper.selection_timing)
            phase_began = time.monotonic()
            current,current_prepared,current_start,current_end,current_key=self._prepare(job,query)
            if (current!=binding or current_key!=key or (current_start,current_end)!=(start,end)
                    or current_prepared["ownerSHA256"]!=prepared["ownerSHA256"]):
                raise ProtocolFailure("selection_invalid")
            prepared=current_prepared
            language = job.cache_info[query["side"]]
            match = validate_selection_match(request_unit(prepared["unit"]), query["side"], start, end, match, language=language)
            link = self._materialize(prepared, match, key)
            self._validate_link_ownership(prepared,link)
            record = {"schema":1, "binding":binding, "page":query["page"], "query":query,
                "ownerSHA256":prepared["ownerSHA256"], "key":key, "match":match, "link":link}
            if len(json.dumps(record,ensure_ascii=False).encode()) > MAX_RECORD_BYTES: raise ProtocolFailure("selection_invalid")
            with self.lock:
                if self.closed or self.manager.stopping: raise ProtocolFailure("service_stopping")
                self._check_conflicts(job,binding,prepared,link)
                atomic_json(path, record)
            phases["validationAndSaveSeconds"] = round(time.monotonic()-phase_began,6)
            pending.result = self._response(binding, query["page"], key, link, False, began, phases)
            return deepcopy(pending.result)
        except ProtocolFailure as error:
            code = str(error)
            if code in {"alignment_timeout", "translation_timeout"}: code = "selection_timeout"
            if code not in {"selection_timeout", "selection_busy", "selection_invalid", "selection_unavailable", "gpt_unavailable", "service_stopping"}: code = "selection_invalid"
            pending.error = code; raise ProtocolFailure(code) from None
        except Exception:
            pending.error = "selection_invalid"; raise ProtocolFailure("selection_invalid") from None
        finally:
            if foreground is not None:foreground.__exit__(None,None,None)
            release_slot=acquired
            with self.lock:
                if helper is not None:
                    self.active_helpers.discard(helper)
                    if pending.error:
                        helper._retire_selection_process()
                        self.retired_helpers.add(helper)
                        def retired(owned=helper):
                            with self.lock:self.retired_helpers.discard(owned)
                            self.slots.release()
                        helper.when_selection_retired(retired)
                        release_slot=False
                    elif self.closed or len(self.helpers) >= MAX_HELPERS: helper.close()
                    else: self.helpers.append(helper)
                self.pending.pop((job.id,key), None); pending.event.set()
            if release_slot:self.slots.release()

    def _prewarm(self, job):
        # Page presentation can prepare the language pair before a PDF upload.
        # Only this background task touches the native helper; GET never waits
        # for a connection, session creation, pool eviction or a warmup ACK.
        pair = (job.cache_info["source"], job.cache_info["target"])
        with self.lock:
            if (self.closed or self.manager.stopping or pair in self.warming_pairs
                    or any((h.source,h.target)==pair for h in self.helpers)
                    or any((h.source,h.target)==pair for h in self.active_helpers)):
                return
            if not self.slots.acquire(blocking=False): return
            self.warming_pairs.add(pair)

            def warm():
                helper = None; ready = False
                try:
                    from worker import NativeHelper
                    with self.lock:
                        if self.closed or self.manager.stopping: return
                        evicted = self.helpers.pop(0) if len(self.helpers)+len(self.active_helpers)>=MAX_HELPERS and self.helpers else None
                        helper = NativeHelper(self.manager.translator, *pair, batch_timeout=MODEL_TIMEOUT)
                        self.active_helpers.add(helper)
                    if evicted is not None: evicted.close()
                    helper.warm_selection(timeout=WARMUP_TIMEOUT)
                    ready = True
                except Exception:
                    # Readiness is optional; selection retains its cold path.
                    # A failed ACK is never promoted to an available helper.
                    pass
                finally:
                    release_slot = True
                    with self.lock:
                        if helper is not None:
                            self.active_helpers.discard(helper)
                            if not ready:
                                helper._retire_selection_process()
                                self.retired_helpers.add(helper)
                                def retired(owned=helper):
                                    with self.lock:self.retired_helpers.discard(owned)
                                    self.slots.release()
                                helper.when_selection_retired(retired)
                                release_slot = False
                            elif self.closed or len(self.helpers)>=MAX_HELPERS: helper.close()
                            else: self.helpers.append(helper)
                        self.warming_pairs.discard(pair)
                        self.warmup_threads.discard(threading.current_thread())
                    if release_slot:self.slots.release()

            thread = threading.Thread(target=warm,name="askgpt-selection-warm",daemon=False)
            self.warmup_threads.add(thread)
            try: thread.start()
            except RuntimeError:
                self.warmup_threads.discard(thread);self.warming_pairs.discard(pair);self.slots.release()

    def links(self, job, page):
        if type(page) is not int or page not in job.source_pages: raise ProtocolFailure("selection_invalid")
        binding = self._bindings(job); links = []; seen = set(); total=0
        paths = sorted(job.directory.glob("selection-*.json"))
        if len(paths) > 2048: raise ProtocolFailure("selection_invalid")
        for path in paths:
            if not re.fullmatch(r"selection-[0-9a-f]{64}\.json",path.name): raise ProtocolFailure("selection_invalid")
            from server import _private_file
            try:
                _, raw = _private_file(path, MAX_RECORD_BYTES); saved = json.loads(raw)
                if saved.get("binding") != binding: continue
                if saved.get("page") != page: continue
                query = validate_query(saved["query"])
                current, prepared, start, end, key = self._prepare(job, query)
                if path.name != "selection-"+key+".json": raise ValueError()
                record = self._record(job,path,current,prepared,query,start,end,key)
                link=record["link"]
                if link is not None:
                    identity=_input_digest([link["source"],link["target"]])
                    if identity not in seen:
                        total+=len(json.dumps(link,ensure_ascii=False).encode())
                        if total>MAX_RESTORE_BYTES: raise ProtocolFailure("selection_invalid")
                        links.append(link);seen.add(identity)
            except ProtocolFailure as error:
                if getattr(error,"error_detail",None)=="partial_latin_token": continue
                raise
            except (OSError, ValueError, TypeError, KeyError): raise ProtocolFailure("selection_invalid") from None
            if len(links) > MAX_RESTORED_LINKS: raise ProtocolFailure("selection_invalid")
        self._prewarm(job)
        return {**binding, "page":page, "links":links}

    def shutdown(self):
        with self.lock:
            self.closed = True; helpers = self.helpers[:]+list(self.active_helpers)+list(self.retired_helpers); self.helpers.clear()
            warmups = list(self.warmup_threads)
        for helper in helpers: helper.cancel()
        for thread in warmups: thread.join(timeout=WARMUP_TIMEOUT+4.5)
        for helper in helpers: helper.wait_selection_retired()
