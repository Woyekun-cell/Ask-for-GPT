"""Explicit recovery candidates from two already saved, strictly bound PDFs.

Page containers only bound model input. They never assert paragraph translation
provenance; only subsequently validated sentence/phrase links are semantic proof.
"""
from contextlib import ExitStack, contextmanager
import hashlib
import json
import os
import re
import stat
import platform_ops as platform

from alignment import (_geometry, _dual_matrix, _dual_rects, validate_alignment,
    MAX_ALIGNMENT_BYTES, MAX_TEXT, MAX_RECTS)
from layout_common import BABELDOC_VERSION, MAX_OUTPUT_BYTES, MAX_PDF_BYTES, ProtocolFailure
from sentence_alignment import SENTENCE_REVISION, page_glyphs

PROVENANCE='pdf-glyph-candidates'
RECOVERY_REVISION='pdf-glyph-candidates-v1'
LEGACY_REVISION='pdf-layout-gpt-v3'


def validate_binding(info,binding):
    if (not isinstance(binding,dict) or set(binding)!={'sourceLanguage','targetLanguage','targetSHA256','targetBytes'}
            or (binding['sourceLanguage'],binding['targetLanguage']) not in {('en','zh-Hans'),('zh-Hans','en')}
            or not isinstance(binding['targetSHA256'],str) or not re.fullmatch(r'[0-9a-f]{64}',binding['targetSHA256'])
            or type(binding['targetBytes']) is not int or not 5<=binding['targetBytes']<=MAX_OUTPUT_BYTES
            or binding['sourceLanguage']!=info.get('source') or binding['targetLanguage']!=info.get('target')
            or info.get('outputs',{}).get('mono')!={'sha256':binding['targetSHA256'],'bytes':binding['targetBytes']}):
        raise ProtocolFailure('alignment_invalid')


def validate_recovery(value,metadata):
    if (metadata.get('revision')!=LEGACY_REVISION or metadata.get('sourcePages')!=list(range(metadata['pageCount']))
            or value.get('provenance')!=PROVENANCE or value.get('recoveryRevision')!=RECOVERY_REVISION
            or value.get('targetSHA256')!=metadata['outputs']['mono']['sha256']):
        raise ValueError('invalid_recovery_binding')


def read_record(manager,identity,binding):
    from server import _private_file, _cache_key
    directory=manager.jobs_root/identity
    try:details=directory.lstat()
    except FileNotFoundError:raise ProtocolFailure('job_not_found') from None
    if not platform.directory_is_private(directory):raise ProtocolFailure('alignment_invalid')
    _,raw=_private_file(directory/'cache.json',65536)
    def unique(pairs):
        value=dict(pairs)
        if len(value)!=len(pairs):raise ValueError('duplicate_metadata')
        return value
    info=json.loads(raw,object_pairs_hook=unique);count=info.get('pageCount');pages=info.get('sourcePages')
    if (type(info.get('schema')) is not int or info.get('schema')!=1 or info.get('state')!='complete' or info.get('revision')!=LEGACY_REVISION
            or info.get('babeldoc')!=BABELDOC_VERSION or type(count) is not int or not 1<=count<=2000
            or not isinstance(pages,list) or pages!=list(range(count)) or any(type(page) is not int for page in pages)
            or not isinstance(info.get('sourceSHA256'),str) or not re.fullmatch(r'[0-9a-f]{64}',info['sourceSHA256'])
            or info.get('cacheKey')!=_cache_key(info['sourceSHA256'],pages,count,info.get('source'),info.get('target'),LEGACY_REVISION)
            or 'alignment' in info or 'alignmentFile' in info):raise ProtocolFailure('alignment_invalid')
    validate_binding(info,binding);signatures={}
    for kind in ('mono','dual'):
        signature,digest=_private_file(directory/(kind+'.pdf'),MAX_OUTPUT_BYTES,checksum=True)
        if info.get('outputs',{}).get(kind)!={'sha256':digest,'bytes':signature[2]}:raise ProtocolFailure('alignment_invalid')
        signatures[kind]=signature
    manager._validate_legacy_outputs(directory,pages,signatures,None)
    return directory,info,signatures


@contextmanager
def _verified_pdf(path,signature):
    import pymupdf
    from server import _signature, _output_signature, _open_pdf_descriptor
    descriptor=platform.secure_open(path,os.O_RDONLY)
    with os.fdopen(descriptor,'rb') as handle:
        if _signature(os.fstat(handle.fileno()))!=signature:raise ValueError('changed_recovery_pdf')
        with _open_pdf_descriptor(handle) as document:
            if document.needs_pass or not document.is_pdf:raise ValueError('invalid_recovery_pdf')
            yield document
        if (_signature(os.fstat(handle.fileno()))!=signature or _output_signature(path,MAX_PDF_BYTES if path.name=='selection-source.pdf' else MAX_OUTPUT_BYTES)!=signature):
            raise ValueError('changed_recovery_pdf')


def _side(page):
    rows=page_glyphs(page)
    if len(rows)>MAX_RECTS or sum(len(char['text']) for row in rows for char in row)+max(0,len(rows)-1)>MAX_TEXT:
        raise ValueError('candidate_text_too_large')
    text=' '.join(''.join(char['text'] for char in row) for row in rows)
    rects=[[round(value,4) for value in (min(char['rect'][0] for char in row),min(char['rect'][1] for char in row),
        max(char['rect'][2] for char in row),max(char['rect'][3] for char in row))] for row in rows]
    return {'text':text,'rects':rects} if text.strip() and rects else None


def candidate_alignment(source_path,mono_path,dual_path,info,signatures):
    from server import _private_file
    paths=[source_path,mono_path,dual_path]
    source_signature,source_digest=_private_file(source_path,MAX_PDF_BYTES,checksum=True)
    if source_digest!=info['sourceSHA256']:raise ValueError('source_changed')
    with ExitStack() as stack:
        source,mono,dual=[stack.enter_context(_verified_pdf(path,signature)) for path,signature in
            zip(paths,[source_signature,signatures['mono'],signatures['dual']])]
        if len(source)!=info['pageCount'] or len(mono)!=len(info['sourcePages']) or len(dual)!=len(info['sourcePages']):
            raise ValueError('invalid_recovery_pages')
        value={'schema':1,'coordinateSpace':'pdf','granularity':'sentence','provenance':PROVENANCE,
            'recoveryRevision':RECOVERY_REVISION,'sourcePages':info['sourcePages'][:],'pageCount':info['pageCount'],
            'sourceSHA256':info['sourceSHA256'],'targetSHA256':info['outputs']['mono']['sha256'],
            'sentenceAlignmentRevision':SENTENCE_REVISION,'sentencePages':[],'sentencePartialPages':[],'pages':[]}
        encoded_size=len(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode())
        for local,physical in enumerate(info['sourcePages']):
            original,translated,paired=source[physical],mono[local],dual[local]
            row={'sourcePage':physical,'outputPage':local,'source':_geometry(original),'mono':_geometry(translated),'dual':_geometry(paired),
                'sourceToDual':[round(x,6) for x in _dual_matrix(original,paired,translated=False)],
                'targetToDual':[round(x,6) for x in _dual_matrix(translated,paired,translated=True)],'paragraphs':[]}
            left,right=_side(original),_side(translated)
            if left and right:
                row['paragraphs']=[{'id':f'p{physical}_0','source':left,'target':right,
                    'dualSource':{'rects':_dual_rects(left['rects'],original,paired,translated=False)},
                    'dualTarget':{'rects':_dual_rects(right['rects'],translated,paired,translated=True)}}]
            else:row['candidateTextUnavailable']=True
            encoded_size+=len(json.dumps(row,ensure_ascii=False,separators=(',',':')).encode())+1
            if encoded_size>MAX_ALIGNMENT_BYTES:raise ValueError('alignment_too_large')
            value['pages'].append(row)
        validate_alignment(value,info['sourcePages'],info['pageCount'],info['sourceSHA256'])
        validate_recovery(value,info)
        if len(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode())>MAX_ALIGNMENT_BYTES:raise ValueError('alignment_too_large')
        return value


def adopt(manager,identity,binding,stream,length):
    from server import Job
    with manager.lock:
        existing=manager.jobs.get(identity)
        if existing is not None:validate_binding(existing.cache_info,binding)
        else:directory,info,signatures=read_record(manager,identity,binding)
    if existing is not None:
        manager.selection_alignments.install_source(existing,stream,length)
        return existing
    parent=Job(identity,directory,state='complete',source_pages=info['sourcePages'][:],page_count=info['pageCount'],
        cache_info=info,output_signatures=signatures,reused_legacy=True)
    manager.selection_alignments.install_source(parent,stream,length)
    with manager.lock:
        existing=manager.jobs.get(identity)
        if existing is not None:
            validate_binding(existing.cache_info,binding);return existing
        _,latest,latest_signatures=read_record(manager,identity,binding)
        if latest!=info or latest_signatures!=signatures:raise ProtocolFailure('alignment_invalid')
        source=manager.selection_alignments.source_path(parent)
        value=candidate_alignment(source,directory/'mono.pdf',directory/'dual.pdf',info,signatures)
        manager.jobs[identity]=parent;manager.completed[info['cacheKey']]=identity
        try:manager.publish_alignment(parent,value)
        except BaseException:
            manager.jobs.pop(identity,None);manager.completed.pop(info['cacheKey'],None)
            raise
        manager.permanent.add(identity)
        return parent
