"""Semantic word IDs over real cached-PDF glyphs. Never proportional geometry."""
from __future__ import annotations

from copy import deepcopy
import json
import re
import unicodedata

from layout_common import ProtocolFailure
from sentence_alignment import _normal, extract_sentences, page_glyphs

PHRASE_REVISION="pdf-phrase-semantic-v1"
EXTRACTION_REVISION="pdf-glyph-boundary-v2"
MAX_PHRASE_UNITS=64
MAX_PHRASE_TOKENS=2048
MAX_PHRASE_SCALARS=60_000
MAX_PHRASE_MESSAGE=256*1024
TARGET_PHRASE_BATCH_TOKENS=128
TARGET_PHRASE_BATCH_UNITS=2
BACKGROUND_PHRASE_BATCH_TOKENS=256
MAX_GROUP_TOKENS=16
MAX_GROUP_WORDS=4


def _cjk(char):
    value=ord(char)
    return (0x3400<=value<=0x9fff or 0xf900<=value<=0xfaff or 0x20000<=value<=0x323af
        or 0x3040<=value<=0x30ff or 0xac00<=value<=0xd7af)


def _word(char):return unicodedata.category(char)[0] in "LNM" and not _cjk(char)


def token_ranges(text):
    """Complete Latin words/IDs, individual CJK scalars, standalone punctuation."""
    # Ignore normalization-empty format characters for lexical boundaries,
    # while retaining every range in the original glyph/text coordinate space.
    # Thus Long-\u200bread stays one real token, including its inline format
    # glyph, while an isolated U+200B/soft hyphen/BOM is never sent as a token.
    offsets=[i for i,char in enumerate(text) if char.isspace() or _normal(char)]
    text="".join(text[i] for i in offsets)
    result=[];index=0
    while index<len(text):
        start=index;char=text[index]
        if char.isspace():index+=1;continue
        index+=1
        if _word(char):
            while index<len(text):
                char=text[index]
                if _word(char):index+=1;continue
                if (char in "-'’‐‑" and index+1<len(text) and _word(text[index-1]) and _word(text[index+1])):
                    index+=1;continue
                if char=="." and index+1<len(text) and text[index-1].isdigit() and text[index+1].isdigit():
                    index+=1;continue
                break
        else:
            while index<len(text) and unicodedata.category(text[index]).startswith("M"):index+=1
        result.append((offsets[start],offsets[index-1]+1))
    return result


def _copy_glyph(glyph):
    return {"text":glyph["text"],"rect":list(glyph["rect"]) if glyph.get("rect") is not None else None,
        "line":glyph.get("line")}


def _tokens(text,glyphs,prefix):
    # Text is assembled from the exact glyph stream, including synthetic
    # inter-line spaces. Never search another occurrence or infer a position.
    if text!="".join(x["text"] for x in glyphs):return []
    spans=[];offset=0
    for glyph in glyphs:
        spans.append((offset,offset+len(glyph["text"]),glyph));offset=spans[-1][1]
    ranges=token_ranges(text);merged=[]
    # An indivisible PDF ligature may span several scalars. Merge only tokens
    # that physically share that one glyph; never invent subdivisions.
    for start,end in ranges:
        chosen=[g for a,b,g in spans if a<end and b>start and g.get("rect") is not None]
        if not chosen:continue
        real_start=min(a for a,b,g in spans if a<end and b>start and g.get("rect") is not None)
        real_end=max(b for a,b,g in spans if a<end and b>start and g.get("rect") is not None)
        if merged and real_start<merged[-1][1]:merged[-1]=(merged[-1][0],max(merged[-1][1],real_end))
        else:merged.append((real_start,real_end))
    result=[]
    for index,(start,end) in enumerate(merged):
        selected=[_copy_glyph(g) for a,b,g in spans if a<end and b>start and g.get("rect") is not None]
        if not selected or not _normal(text[start:end]):continue
        result.append({"id":f"{prefix}_w{index}","text":text[start:end],"glyphs":selected,"start":start,"end":end})
    return result


def prepare_unit(identity,source,target):
    left=[_copy_glyph(g) for g in source.get("glyphs",[])];right=[_copy_glyph(g) for g in target.get("glyphs",[])]
    # Existing v1 sidecars have no glyphs. Their geometry is re-extracted from
    # immutable PDFs by prepare_phrase_page before this function is called.
    source_text="".join(g["text"] for g in left);target_text="".join(g["text"] for g in right)
    if _normal(source_text)!=_normal(source["text"]) or _normal(target_text)!=_normal(target["text"]):return None
    a,b=_tokens(source_text,left,identity+"_a"),_tokens(target_text,right,identity+"_b")
    if not a or not b:return None
    return {"id":identity,"sourceText":source_text,"targetText":target_text,"source":a,"target":b,
        "sourceGlyphs":left,"targetGlyphs":right}


def prepare_phrase_page(page_record,source,mono):
    rows={"source":page_glyphs(source),"target":page_glyphs(mono)};result=[]
    for paragraph in page_record["paragraphs"]:
        for sentence in paragraph.get("sentences",[]):
            sides={}
            for name in ("source","target"):
                # Re-extract instead of trusting optional legacy glyph fields.
                parts=extract_sentences(rows[name],sentence[name],sentence["id"],name[0])
                if not parts:break
                glyphs=[]
                for part in parts:
                    if glyphs:glyphs.append({"text":" ","rect":None,"line":None})
                    glyphs.extend(part["glyphs"])
                sides[name]={"text":sentence[name]["text"],"glyphs":glyphs}
            if len(sides)!=2:continue
            item=prepare_unit(sentence["id"],sides["source"],sides["target"])
            if item is not None:result.append(item)
    return result


def request_unit(unit):
    return {"id":unit["id"],"sourceText":unit["sourceText"],"targetText":unit["targetText"],
        **{name:[{"id":x["id"],"text":x["text"]} for x in unit[name]] for name in ("source","target")}}


def validate_phrase_request(units):
    if not isinstance(units,list) or not 1<=len(units)<=MAX_PHRASE_UNITS:raise ProtocolFailure("alignment_invalid")
    seen=set();count=scalars=0
    for unit in units:
        if not isinstance(unit,dict) or set(unit)!={"id","sourceText","targetText","source","target"}:raise ProtocolFailure("alignment_invalid")
        identity=unit["id"]
        if not isinstance(identity,str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}",identity) or identity in seen:raise ProtocolFailure("alignment_invalid")
        seen.add(identity)
        for name in ("source","target"):
            text=unit[name+"Text"]
            if not isinstance(text,str) or not text.strip() or any(0xd800<=ord(x)<=0xdfff for x in text):raise ProtocolFailure("alignment_invalid")
            scalars+=len(text);tokens=unit[name]
            if not isinstance(tokens,list) or not tokens:raise ProtocolFailure("alignment_invalid")
            count+=len(tokens)
            for token in tokens:
                if (not isinstance(token,dict) or set(token)!={"id","text"} or not isinstance(token["id"],str)
                    or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}",token["id"]) or token["id"] in seen
                    or not isinstance(token["text"],str) or not token["text"].strip()
                    or any(0xd800<=ord(x)<=0xdfff for x in token["text"])):raise ProtocolFailure("alignment_invalid")
                seen.add(token["id"]);scalars+=len(token["text"])
            if _normal("".join(x["text"] for x in tokens))!=_normal(text):raise ProtocolFailure("alignment_invalid")
    if (count>MAX_PHRASE_TOKENS or scalars>MAX_PHRASE_SCALARS
        or len(json.dumps(units,ensure_ascii=False,separators=(",",":")).encode())>MAX_PHRASE_MESSAGE-512):raise ProtocolFailure("alignment_invalid")
    return units


def _lexical(token):
    # Match PDFPhraseAlignmentTranslator.expand: the four-word limit counts
    # only tokens containing ASCII Latin letters, independently of CJK length.
    return re.search(r"[A-Za-z]",token["text"]) is not None


def validate_phrase_matches(value,units,*,max_group_tokens=MAX_GROUP_TOKENS,max_group_words=MAX_GROUP_WORDS):
    validate_phrase_request(units)
    if not isinstance(value,dict) or set(value)!={x["id"] for x in units}:raise ProtocolFailure("alignment_invalid")
    for unit in units:
        groups=value[unit["id"]]
        if not isinstance(groups,list) or len(groups)>len(unit["source"])+len(unit["target"]):raise ProtocolFailure("alignment_invalid")
        used={"source":set(),"target":set()}
        for group in groups:
            if not isinstance(group,dict) or set(group)!={"sourceIDs","targetIDs"}:raise ProtocolFailure("alignment_invalid")
            for side in ("source","target"):
                identities=group[side+"IDs"];order={row["id"]:i for i,row in enumerate(unit[side])}
                if (not isinstance(identities,list) or not 1<=len(identities)<=max_group_tokens
                    or any(not isinstance(x,str) or x not in order or x in used[side] for x in identities)
                    or len(set(identities))!=len(identities)):raise ProtocolFailure("alignment_invalid")
                indices=[order[x] for x in identities]
                if indices!=list(range(indices[0],indices[0]+len(indices))):raise ProtocolFailure("alignment_invalid")
                if sum(_lexical(unit[side][i]) for i in indices)>max_group_words:raise ProtocolFailure("alignment_invalid")
                used[side].update(identities)
    return value


def identity_groups(unit):
    if unit["sourceText"]!=unit["targetText"] or len(unit["source"])!=len(unit["target"]):return []
    result=[]
    for left,right in zip(unit["source"],unit["target"]):
        if left["text"]!=right["text"] or len(left["glyphs"])!=len(right["glyphs"]):return []
        if any(a["text"]!=b["text"] or any(abs(x-y)>.01 for x,y in zip(a["rect"],b["rect"])) for a,b in zip(left["glyphs"],right["glyphs"])):return []
        result.append({"sourceIDs":[left["id"]],"targetIDs":[right["id"]]})
    return result


def phrase_requests(prepared,*,background=False):
    result=[];current=[]
    token_limit=BACKGROUND_PHRASE_BATCH_TOKENS if background else TARGET_PHRASE_BATCH_TOKENS
    for unit in prepared:
        if identity_groups(unit):continue
        request=request_unit(unit)
        # Keep complete sentences together, while publishing useful links
        # sooner than a near-2048-token response. The hard protocol bound still
        # applies to an indivisible long sentence.
        if current and (len(current)>=TARGET_PHRASE_BATCH_UNITS or
                sum(len(x[side]) for x in current+[request] for side in ("source","target"))>token_limit):
            result.append(current);current=[]
        try:validate_phrase_request(current+[request])
        except ProtocolFailure:
            if current:result.append(current);current=[]
            # An unattempted oversized request is an upgrade failure, never
            # a semantic [] that could be persisted as permanently ready.
            validate_phrase_request([request])
        current.append(request)
    if current:result.append(current)
    return result


def _side(tokens,identities,text):
    selected=[x for x in tokens if x["id"] in identities];glyphs=[_copy_glyph(g) for t in selected for g in t["glyphs"]]
    # Preserve token internal spaces (rare indivisible glyph), and whitespace
    # between adjacent Latin words for readable annotation text only.
    selected_text=text[selected[0]["start"]:selected[-1]["end"]]
    lines=[]
    for g in glyphs:
        r=g["rect"]
        if lines and g["line"]==lines[-1][0]:
            previous=lines[-1][1];previous[:]=[min(previous[0],r[0]),min(previous[1],r[1]),max(previous[2],r[2]),max(previous[3],r[3])]
        else:lines.append((g["line"],list(r)))
    return {"text":selected_text,"rects":[[round(x,4) for x in r] for _,r in lines],"glyphs":glyphs}


def materialize_unit(unit,groups,source_matrix,target_matrix,method="semantic-phrase-model"):
    import pymupdf
    result=[]
    for index,group in enumerate(groups):
        source=_side(unit["source"],group["sourceIDs"],unit["sourceText"])
        target=_side(unit["target"],group["targetIDs"],unit["targetText"])
        def dual(side,matrix):return {"rects":[[round(x,4) for x in pymupdf.Rect(r)*pymupdf.Matrix(*matrix)] for r in side["rects"]]}
        result.append({"id":unit["id"]+f"_w{index}","source":source,"target":target,
            "dualSource":dual(source,source_matrix),"dualTarget":dual(target,target_matrix),"method":method,
            "sourceTokenCount":len(group["sourceIDs"]),"targetTokenCount":len(group["targetIDs"])})
    return result


def reusable_phrase_unit(sentence,unit):
    """Reuse only links whose complete glyph pools still match immutable PDFs."""
    return (bool(sentence.get("phrases")) or sentence.get("phraseAttemptRevision")==EXTRACTION_REVISION) and all(
        sentence.get(side,{}).get("glyphs")==unit[side+"Glyphs"]
        and _normal(sentence[side]["text"])==_normal(unit[side+"Text"])
        for side in ("source","target"))


def phrase_page_coverage(page_record,prepared):
    lookup={x["id"]:x for x in prepared}
    sentences=[s for p in page_record["paragraphs"] for s in p.get("sentences",[])]
    result={"sentences":len(sentences),"extractable":len(prepared),"aligned":0,"unavailable":0,
        "sourceTokens":sum(len(x["source"]) for x in prepared),
        "targetTokens":sum(len(x["target"]) for x in prepared),
        "mappedSourceTokens":0,"mappedTargetTokens":0}
    for sentence in sentences:
        if sentence["id"] not in lookup:continue
        groups=sentence.get("phrases",[])
        result["aligned"]+=bool(groups)
        for side in ("source","target"):
            result["mapped"+side.capitalize()+"Tokens"]+=sum(x[side+"TokenCount"] for x in groups)
    result["unavailable"]=result["extractable"]-result["aligned"]
    return result


def upgrade_phrase_page(page_record,prepared,matches,*,reuse_verified=False,preserve_unprepared=False):
    result=deepcopy(page_record);lookup={x["id"]:x for x in prepared}
    for paragraph in result["paragraphs"]:
        for sentence in paragraph.get("sentences",[]):
            unit=lookup.get(sentence["id"])
            if unit is not None and reuse_verified and reusable_phrase_unit(sentence,unit):continue
            if unit is None and preserve_unprepared:continue
            sentence["phrases"]=[]
            if unit is None:continue
            sentence["source"]["text"]=unit["sourceText"]
            sentence["target"]["text"]=unit["targetText"]
            sentence["source"]["glyphs"]=deepcopy(unit["sourceGlyphs"])
            sentence["target"]["glyphs"]=deepcopy(unit["targetGlyphs"])
            identical=identity_groups(unit);groups=identical or matches.get(unit["id"],[])
            if identical or unit["id"] in matches:sentence["phraseAttemptRevision"]=EXTRACTION_REVISION
            else:sentence.pop("phraseAttemptRevision",None)
            sentence["phrases"]=materialize_unit(unit,groups,result["sourceToDual"],result["targetToDual"],
                "glyph-identity" if identical else "semantic-phrase-model")
    return result
