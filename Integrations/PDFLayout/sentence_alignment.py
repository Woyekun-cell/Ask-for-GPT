"""Upgrade cached paragraph provenance to semantic sentence correspondence.

The existing PDFs never change. Glyph rectangles come from those exact PDFs;
the model is only permitted to select IDs of already extracted sentences.
"""
from __future__ import annotations

from copy import deepcopy
from collections import Counter
import hashlib
import json
import re
import unicodedata

from layout_common import ProtocolFailure

SENTENCE_REVISION = "pdf-sentence-semantic-v1"
SENTENCE_EXTRACTION_REVISION = "pdf-sentence-glyph-v1"
MAX_ALIGNMENT_SCALARS = 60_000
MAX_ALIGNMENT_SENTENCES = 1024
MAX_ALIGNMENT_PARAGRAPHS = 256
MAX_ALIGNMENT_MESSAGE = 256 * 1024
_ABBREVIATIONS = {"al", "fig", "figs", "eq", "eqs", "ref", "refs", "dr", "mr", "mrs", "ms",
    "prof", "vs", "cf", "no", "nos", "vol", "pp", "e.g", "i.e", "approx", "inc", "jr", "sr"}


def _normal(text):
    # PDF small-cap glyphs and font ToUnicode maps can differ from the IR's
    # casing/typographic hyphen. Actual text sent to the model is never folded.
    return "".join(char for char in unicodedata.normalize("NFKC", text).casefold().replace("\u2010","-")
                   if not char.isspace() and char not in "\u00ad\u200b\ufeff")


def sentence_ranges(text):
    """Conservative punctuation splitting; offsets always reference exact text."""
    result, start, index = [], 0, 0
    while index < len(text):
        char = text[index]
        # Cached translations sometimes join several English sentences with
        # semicolons. Keep those explicit clauses as exact smaller anchors.
        boundary = char in ".!?。！？;；"
        if char == ".":
            if index and index+1 < len(text) and text[index-1].isalnum() and text[index+1].isalnum():
                boundary = False
            token = re.search(r"([A-Za-z][A-Za-z.]*)$", text[:index])
            if token:
                word = token.group(1)
                if word.lower() in _ABBREVIATIONS or (len(word) == 1 and word.isupper()): boundary = False
            if index+1 < len(text) and text[index+1] == ".": boundary = False
        if boundary:
            end = index+1
            while end < len(text) and text[end] in '!?。！？\"\u201d\u2019\')]}': end += 1
            while start < end and text[start].isspace(): start += 1
            if start < end: result.append((start,end))
            start = end
            index = end
        else: index += 1
    while start < len(text) and text[start].isspace(): start += 1
    end = len(text.rstrip())
    if start < end: result.append((start,end))
    return result


def page_glyphs(page):
    """Extract real horizontal glyphs in content reading order, in PDF space."""
    import pymupdf
    crop = page.cropbox
    inverse = ~pymupdf.Matrix(1,0,0,-1,-crop.x0,page.mediabox.y1-crop.y0)
    rows = []
    for block in page.get_text("rawdict")["blocks"]:
        if block.get("type") != 0: continue
        for line in block.get("lines",[]):
            direction = line.get("dir",(1,0))
            if line.get("wmode",0) != 0 or direction[0] < .99 or abs(direction[1]) > .01: continue
            chars = []
            for span in line.get("spans",[]):
                for char in span.get("chars",[]):
                    text = char.get("c","")
                    box = char.get("bbox")
                    if not isinstance(text,str) or not box: continue
                    rect = pymupdf.Rect(box) * inverse
                    if rect.is_empty or rect.is_infinite: continue
                    origin=char.get("origin")
                    point=list(pymupdf.Point(origin)*inverse) if origin else None
                    chars.append({"text":text,"rect":[float(x) for x in rect],"origin":point})
            if chars: rows.append(chars)
    return rows


def _inside(rect, regions, origin=None, text=""):
    x,y=(rect[0]+rect[2])/2,(rect[1]+rect[3])/2
    for region in regions:
        if region[0]-.05 <= x <= region[2]+.05 and region[1]-.05 <= y <= region[3]+.05: return True
        # A following CJK glyph often starts exactly at the preceding sentence's
        # right edge. Its origin is not evidence that its ink belongs to that
        # sentence. Keep this fallback half-open on the advance edge; the real
        # glyph-center test above still handles legitimate edge overhangs.
        if origin and region[0]-.05<=origin[0]<region[2]-.05 and region[1]-.05<=origin[1]<=region[3]+.05: return True
        # A period's stored ink bbox can be only 1 pt tall, while the PDF's
        # selectable font bbox includes the full ascender/descender. Neither
        # its center nor its origin must fall in that ink. Use actual rectangle
        # intersection for punctuation, then still require exact full content.
        if (text and all(char in ".,;:!?。！？；：，" for char in text)
                and region[2]-region[0]<=rect[2]-rect[0]+.1
                and region[3]-region[1]<=rect[3]-rect[1]+.1
                and min(rect[2],region[2])-max(rect[0],region[0])>.01
                and min(rect[3],region[3])-max(rect[1],region[1])>.01): return True
    return False


def _exact_glyph_substring(glyphs, expected):
    """Trim excess region-edge glyphs only after a unique exact text proof."""
    wanted=_normal(expected)
    if not wanted:return []
    pieces=[_normal(glyph["text"]) for glyph in glyphs]
    text="".join(pieces)
    # Combining normalization across glyph boundaries cannot be subdivided
    # reliably. Refuse recovery rather than assigning invented glyph offsets.
    if text!=_normal("".join(glyph["text"] for glyph in glyphs)):return []
    start=text.find(wanted)
    if start<0 or text.find(wanted,start+1)>=0:return []
    end=start+len(wanted);offset=0;first=last=None
    for index,piece in enumerate(pieces):
        following=offset+len(piece)
        if piece and offset==start:first=index
        if piece and following==end:last=index
        offset=following
    if first is None or last is None or last<first:return []
    # Exact boundaries must retain whole real glyphs, including ligatures.
    selected=glyphs[first:last+1]
    return selected if _normal("".join(g["text"] for g in selected))==wanted else []


def extract_sentences(rows, side, identity, prefix):
    glyphs=[]
    for row_index,row in enumerate(rows):
        selected=[];previous=None;run=0
        for column,char in enumerate(row):
            if not _inside(char["rect"],side["rects"],char.get("origin"),char["text"]):continue
            if previous is None or column!=previous+1:
                if selected:selected.append({"text":" ","rect":None,"line":None})
                run+=1
            # A semantic n:1 sentence group can contain separated pieces of
            # the same PDF line. Distinct exact glyph runs must never union
            # across an unselected intervening phrase or sentence.
            selected.append({**char,"line":row_index*100_000+run})
            previous=column
        if not selected: continue
        if glyphs: glyphs.append({"text":" ","rect":None,"line":None})
        glyphs.extend(selected)
    text="".join(char["text"] for char in glyphs)
    # No fuzzy/geometric nearest-block recovery: exact normalized content must
    # agree with the existing provenance before any sentence can be mapped.
    if not text.strip():return []
    if _normal(text)!=_normal(side["text"]):
        glyphs=_exact_glyph_substring(glyphs,side["text"])
        if not glyphs:return []
        text="".join(char["text"] for char in glyphs)
    expanded=[]
    for glyph_index,char in enumerate(glyphs):
        expanded.extend([{**char,"text":letter,"glyphIndex":glyph_index} for letter in char["text"]])
    sentences=[]
    for index,(start,end) in enumerate(sentence_ranges(text)):
        lines=[]
        for char in expanded[start:end]:
            rect=char["rect"]
            if rect is None or char["text"].isspace(): continue
            if lines and lines[-1][0] == char["line"]:
                previous=lines[-1][1]
                previous[0]=min(previous[0],rect[0]);previous[1]=min(previous[1],rect[1])
                previous[2]=max(previous[2],rect[2]);previous[3]=max(previous[3],rect[3])
            else: lines.append((char["line"],list(rect)))
        if lines:
            sentences.append({"id":f"{identity}_{prefix}{index}","text":text[start:end],
                "rects":[[round(x,4) for x in rect] for _,rect in lines],
                "glyphs":[{"text":glyphs[i]["text"],"rect":([round(x,4) for x in glyphs[i]["rect"]]
                    if glyphs[i]["rect"] is not None else None),"line":glyphs[i]["line"]}
                    for i in dict.fromkeys(char["glyphIndex"] for char in expanded[start:end])]})
    return sentences


def prepare_page(page_record, source, mono):
    source_rows,target_rows=page_glyphs(source),page_glyphs(mono)
    prepared=[]
    for paragraph in page_record["paragraphs"]:
        left=extract_sentences(source_rows,paragraph["source"],paragraph["id"],"s")
        right=extract_sentences(target_rows,paragraph["target"],paragraph["id"],"t")
        if left and right: prepared.append({"id":paragraph["id"],"source":left,"target":right})
    return prepared


def identity_matches(prepared):
    """Only unchanged complete paragraphs with unique, identical real glyphs.

    This is a physical identity proof, not a cross-language semantic shortcut.
    Case/Unicode/whitespace normalization and nearest-position guesses are not
    permitted. A single changed sentence sends the entire paragraph to the
    semantic path, preserving its full context.
    """
    matches={}
    for paragraph in prepared:
        left,right=paragraph["source"],paragraph["target"]
        if not left or len(left)!=len(right): continue
        if "".join(row["text"] for row in left)!="".join(row["text"] for row in right): continue
        candidates={}
        for source in left:
            candidates[source["id"]]=[target["id"] for target in right
                if source["text"]==target["text"] and len(source["rects"])==len(target["rects"])
                and all(abs(a-b)<=.01 for x,y in zip(source["rects"],target["rects"]) for a,b in zip(x,y))]
        if (all(len(values)==1 for values in candidates.values())
                and len({values[0] for values in candidates.values()})==len(right)):
            matches.update(candidates)
    return matches


def validate_request(paragraphs):
    if not isinstance(paragraphs,list) or not 1 <= len(paragraphs) <= MAX_ALIGNMENT_PARAGRAPHS:
        raise ProtocolFailure("alignment_invalid")
    identities=set();count=scalars=0
    for paragraph in paragraphs:
        if not isinstance(paragraph,dict) or set(paragraph) != {"id","source","target"}: raise ProtocolFailure("alignment_invalid")
        identity=paragraph["id"]
        if not isinstance(identity,str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}",identity) or identity in identities:
            raise ProtocolFailure("alignment_invalid")
        identities.add(identity)
        for side in ("source","target"):
            values=paragraph[side]
            if not isinstance(values,list) or not values: raise ProtocolFailure("alignment_invalid")
            count+=len(values)
            for sentence in values:
                if (not isinstance(sentence,dict) or set(sentence) != {"id","text"}
                        or not isinstance(sentence["id"],str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}",sentence["id"])
                        or sentence["id"] in identities or not isinstance(sentence["text"],str) or not sentence["text"].strip()
                        or any(0xD800 <= ord(char) <= 0xDFFF for char in sentence["text"])):
                    raise ProtocolFailure("alignment_invalid")
                identities.add(sentence["id"]);scalars+=len(sentence["text"])
    if count > MAX_ALIGNMENT_SENTENCES or scalars > MAX_ALIGNMENT_SCALARS:
        raise ProtocolFailure("alignment_invalid")
    if len(json.dumps(paragraphs,ensure_ascii=False,separators=(",",":")).encode()) > MAX_ALIGNMENT_MESSAGE-512:
        raise ProtocolFailure("alignment_invalid")
    return paragraphs


def requests_for_page(prepared):
    batches=[];current=[];identical=identity_matches(prepared)
    for paragraph in prepared:
        if all(row["id"] in identical for row in paragraph["source"]): continue
        item={"id":paragraph["id"],"source":[{"id":x["id"],"text":x["text"]} for x in paragraph["source"]],
            "target":[{"id":x["id"],"text":x["text"]} for x in paragraph["target"]]}
        try: validate_request(current+[item])
        except ProtocolFailure:
            if current: batches.append(current);current=[]
            validate_request([item])
        current.append(item)
    if current: batches.append(current)
    return batches


_NUMERIC_TOKEN = re.compile(r"[eE]\d+|[+\-\u2212]?(?:\d+(?:\.\d+)*|\.\d+)(?:[eE][+\-\u2212]?\d+)?")


def _numeric_anchors(text, *, fragment=False):
    # NFC preserves decimal/sign spelling and never folds superscripts into
    # ordinary digits. e-prefixed article IDs remain complete identifiers.
    text=unicodedata.normalize("NFC",text)
    found=list(_NUMERIC_TOKEN.finditer(text))
    if fragment:
        remainder=_NUMERIC_TOKEN.sub("",text)
        if (not found or any(not char.isspace() and unicodedata.category(char)[0] not in "PS" for char in remainder)):
            return None
        # A detached sign is not evidence for an unsigned number.
        if any(char in remainder for char in "+-\u2212"):return ["".join(text.split())]
    def identifier(char):return char=="_" or char.isascii() and char.isalnum()
    result=[]
    for match in found:
        if not fragment and ((match.start() and identifier(text[match.start()-1]))
                or (match.end()<len(text) and identifier(text[match.end()]))):continue
        token=match.group()
        result.append("e"+token[1:] if token[0] in "eE" else token)
    return result


def _numeric_link_compatible(source,target):
    def compatible(left,right):
        anchors=_numeric_anchors(left,fragment=True)
        if anchors is None:return True
        candidate=_numeric_anchors(right,fragment=True)
        if candidate is None:candidate=_numeric_anchors(right)
        return any(candidate[index:index+len(anchors)]==anchors for index in range(len(candidate)-len(anchors)+1))
    if compatible(source,target):return True
    # PDF text can split 159 into "1 59". This ambiguity cannot prove that an
    # existing model edge is wrong; it never creates or redirects a link.
    compact=lambda text:re.sub(r"(?<=\d)\s+(?=\d)","",text)
    left,right=compact(source),compact(target)
    return (left!=source or right!=target) and compatible(left,right)


def filter_unsafe_numeric_sentence_links(value):
    """Remove semantic rows when we cannot reconcile numeric anchors.

    A merged saved row cannot be safely split back into original sentences.
    Its phrases leave with it; immutable paragraph text and PDF geometry stay.
    """
    affected=set()
    for page in value.get("pages",[]):
        for paragraph in page["paragraphs"]:
            rows=paragraph.get("sentences",[])
            safe=[row for row in rows if row.get("method")!="semantic-model"
                or _numeric_link_compatible(row["source"]["text"],row["target"]["text"])]
            if len(safe)!=len(rows):
                paragraph["sentences"]=safe;affected.add(page["sourcePage"])
    if not affected:return False
    value["sentencePages"]=[p for p in value.get("sentencePages",[]) if p not in affected]
    value["sentencePartialPages"]=sorted(set(value.get("sentencePartialPages",[]))|affected)
    if "phraseExtractedPages" in value:value["phraseExtractedPages"]=[p for p in value["phraseExtractedPages"] if p not in affected]
    if isinstance(value.get("phraseCoverage"),dict):
        value["phraseCoverage"]={key:row for key,row in value["phraseCoverage"].items() if key not in {str(p) for p in affected}}
    return True


def validate_matches(value,paragraphs):
    validate_request(paragraphs)
    expected={sentence["id"]:(paragraph, sentence) for paragraph in paragraphs for sentence in paragraph["source"]}
    if not isinstance(value,dict) or set(value) != set(expected): raise ProtocolFailure("alignment_invalid")
    for identity,targets in value.items():
        paragraph,_=expected[identity]
        order={sentence["id"]:index for index,sentence in enumerate(paragraph["target"])}
        if (not isinstance(targets,list) or len(targets)>3 or any(not isinstance(x,str) or x not in order for x in targets)
                or len(set(targets)) != len(targets) or targets != sorted(targets,key=order.get)):
            raise ProtocolFailure("alignment_invalid")
    # Connected components expose n:1 and reject ambiguous many-to-many blocks.
    for paragraph in paragraphs:
        remaining={x["id"] for x in paragraph["source"] if value[x["id"]]}
        while remaining:
            sources={next(iter(remaining))};targets=set()
            while True:
                new_targets={y for x in sources for y in value[x]}
                new_sources={x for x in remaining if set(value[x]) & new_targets}
                if new_targets==targets and new_sources==sources: break
                sources,targets=new_sources,new_targets
            if len(sources)>3 or len(targets)>3 or (len(sources)>1 and len(targets)>1):
                raise ProtocolFailure("alignment_invalid")
            remaining-=sources
    result={identity:targets[:] for identity,targets in value.items()}
    for identity,targets in result.items():
        paragraph,source=expected[identity]
        text={row["id"]:row["text"] for row in paragraph["target"]}
        if targets and not _numeric_link_compatible(source["text"]," ".join(text[target] for target in targets)):
            result[identity]=[]
    return result


def _input_digest(prepared):
    return hashlib.sha256(json.dumps(prepared,ensure_ascii=False,sort_keys=True,separators=(",",":"),allow_nan=False).encode()).hexdigest()


def _anchor_digest(paragraph):
    # Word enrichment may replace spaces/glyph pools after a fresh extraction.
    # The saved sentence relation itself and its proven rectangles stay fixed.
    return _input_digest([{ "id":s["id"],"method":s["method"],**{name:{"text":_normal(s[name]["text"]),
        "rects":s[name]["rects"]} for name in ("source","target")}} for s in paragraph.get("sentences",[])])


def reusable_sentence_paragraph(paragraph,prepared):
    """Trust only our revision bound to the current immutable glyph input.

    A semantic refusal can be reused, but never qualifies the page as covered.
    A present anchor must independently own its exact current PDF glyphs.
    """
    if (paragraph.get("sentenceAttemptRevision")!=SENTENCE_EXTRACTION_REVISION
            or paragraph.get("sentenceInputSHA256")!=_input_digest(prepared)
            or paragraph.get("sentenceAnchorsSHA256")!=_anchor_digest(paragraph)):return False
    def key(g):return (g["text"],tuple(g["rect"]))
    for name in ("source","target"):
        pool=Counter(key(g) for row in prepared[name] for g in row["glyphs"] if g.get("rect") is not None)
        claimed=Counter()
        for saved in paragraph.get("sentences",[]):
            side=saved[name];glyphs=side.get("glyphs")
            if not isinstance(glyphs,list) or _normal("".join(g["text"] for g in glyphs))!=_normal(side["text"]):return False
            claimed.update(key(g) for g in glyphs if g.get("rect") is not None)
        if claimed-pool:return False
    return True


def paragraph_sentence_coverage(paragraph):
    return all(Counter(_normal(paragraph[name]["text"]))==Counter("".join(_normal(s[name]["text"])
        for s in paragraph.get("sentences",[]))) for name in ("source","target"))


def bind_verified_sentence_paragraph(paragraph,prepared,words):
    """Adopt a covered paragraph from a formerly complete legacy sidecar.

    The caller has freshly extracted every saved sentence from those exact
    PDF rectangles. Missing or foreign glyphs refuse adoption. No relation is
    inferred here, and existing successful word links are left untouched.
    """
    if not paragraph_sentence_coverage(paragraph):return None
    candidate=deepcopy(paragraph)
    for saved in candidate.get("sentences",[]):
        unit=words.get(saved["id"])
        if unit is None:return None
        for name in ("source","target"):
            if _normal(saved[name]["text"])!=_normal(unit[name+"Text"]):return None
            saved[name]["glyphs"]=deepcopy(unit[name+"Glyphs"])
    candidate["sentenceAttemptRevision"]=SENTENCE_EXTRACTION_REVISION
    candidate["sentenceInputSHA256"]=_input_digest(prepared)
    candidate["sentenceAnchorsSHA256"]=_anchor_digest(candidate)
    return candidate if reusable_sentence_paragraph(candidate,prepared) else None


def upgrade_page(page_record,prepared,matches,*,preserve_unprepared=False):
    import pymupdf
    identical=identity_matches(prepared)
    matches={**matches,**identical}
    result=deepcopy(page_record);lookup={x["id"]:x for x in prepared}
    for paragraph in result["paragraphs"]:
        original=lookup.get(paragraph["id"])
        if original is None and preserve_unprepared:continue
        paragraph["sentences"]=[]
        for field in ("sentenceAttemptRevision","sentenceInputSHA256","sentenceAnchorsSHA256"):paragraph.pop(field,None)
        if original is None: continue
        left={x["id"]:x for x in original["source"]};right={x["id"]:x for x in original["target"]}
        source_order={identity:index for index,identity in enumerate(left)}
        remaining={x for x in left if matches.get(x)}
        while remaining:
            sources={next(iter(remaining))};targets=set()
            while True:
                new_targets={y for x in sources for y in matches[x]}
                new_sources={x for x in remaining if set(matches[x]) & new_targets}
                if new_targets==targets and new_sources==sources: break
                sources,targets=new_sources,new_targets
            def side(values,chosen):
                selected=[x for x in values.values() if x["id"] in chosen]
                return {"text":" ".join(x["text"] for x in selected),"rects":[r for x in selected for r in x["rects"]],
                    "glyphs":[g for index,x in enumerate(selected)
                        for g in ([{"text":" ","rect":None,"line":None}] if index else [])+x.get("glyphs",[])]}
            source,target=side(left,sources),side(right,targets)
            def paired(side,matrix):
                return {"rects":[[round(x,4) for x in pymupdf.Rect(r)*pymupdf.Matrix(*matrix)] for r in side["rects"]]}
            paragraph["sentences"].append({"id":min(sources,key=source_order.get),"source":source,"target":target,
                "dualSource":paired(source,result["sourceToDual"]),"dualTarget":paired(target,result["targetToDual"]),
                "method":"glyph-identity" if all(x in identical for x in sources) else "semantic-model"})
            remaining-=sources
        paragraph["sentences"].sort(key=lambda row:source_order[row["id"]])
        paragraph["sentenceAttemptRevision"]=SENTENCE_EXTRACTION_REVISION
        paragraph["sentenceInputSHA256"]=_input_digest(original)
        paragraph["sentenceAnchorsSHA256"]=_anchor_digest(paragraph)
    return result
