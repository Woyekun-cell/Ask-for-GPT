"""Validated immutable metadata snapshots avoid rereading an entire paper."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from layout_common import ProtocolFailure
import test_sentence_alignment as fixtures


class AlignmentSnapshotCacheTests(unittest.TestCase):
    setUp = fixtures.SentenceAlignmentTests.setUp
    tearDown = fixtures.SentenceAlignmentTests.tearDown
    manager = fixtures.SentenceAlignmentTests.manager
    install = fixtures.SentenceAlignmentTests.install
    service = fixtures.SentenceAlignmentTests.service
    request = fixtures.SentenceAlignmentTests.request

    def test_layout_http_preserves_paragraph_geometry_without_claiming_precise_metadata(self):
        self.value['layoutRevision']='existing-layout-v1'
        expected=copy.deepcopy(self.value)
        self.value.update(granularity='sentence',sentenceAlignmentRevision='pdf-sentence-semantic-v1',
            sentencePages=[0,1],phraseAlignmentRevision='pdf-phrase-semantic-v1',phrasePages=[0,1],
            phraseExtractedPages=[0,1],phraseCoverage={'0':{'complete':True}},unexpected='not-layout')
        for page in self.value['pages']:
            paragraph=page['paragraphs'][0]
            sentence={'id':paragraph['id']+'_s0','method':'semantic-model'}
            for name in ('source','target','dualSource','dualTarget'):
                sentence[name]=copy.deepcopy(paragraph[name])
                if name in ('source','target'):
                    sentence[name]['glyphs']=[{'text':sentence[name]['text'],
                        'rect':sentence[name]['rects'][0][:],'line':0}]
            sentence['phrases']=[{'id':sentence['id']+'_w0','method':'semantic-phrase-model',
                'sourceTokenCount':1,'targetTokenCount':1,
                **{name:copy.deepcopy(sentence[name]) for name in ('source','target','dualSource','dualTarget')}}]
            paragraph['sentences']=[sentence]
            paragraph['source']['glyphs']=[{'unexpected':'paragraph metadata'}]
            paragraph['dualTarget']['unexpected']='not-layout'
            page['unexpected']='not-layout'
            page['source']['unexpected']='not-layout'
        manager=self.manager();job=self.install(manager);service=self.service(manager)
        before={path.name:(path.read_bytes(),path.stat().st_mtime_ns) for path in job.directory.iterdir() if path.is_file()}
        with patch.object(server.subprocess,'Popen',side_effect=AssertionError('layout GET started a helper')):
            status,raw=self.request(service,'GET',f'/v1/pdf/jobs/{job.id}/alignment-layout.json')
            self.assertEqual(status,200)
            result=json.loads(raw)
            self.assertEqual(result,expected)
            server.validate_alignment(result,[0,1],2,self.sha)
            full_status,full_raw=self.request(service,'GET',f'/v1/pdf/jobs/{job.id}/alignment.json')
        self.assertEqual(full_status,200)
        self.assertEqual(json.loads(full_raw),self.value)
        self.assertLess(len(raw),len(full_raw))
        self.assertEqual(before,{path.name:(path.read_bytes(),path.stat().st_mtime_ns) for path in job.directory.iterdir() if path.is_file()})

    def test_layout_http_keeps_authentication_completion_and_immutable_file_guards(self):
        manager=self.manager();job=self.install(manager);service=self.service(manager)
        route=f'/v1/pdf/jobs/{job.id}/alignment-layout.json'
        self.assertEqual(self.request(service,'GET',route,token='b'*64)[0],401)
        self.assertEqual(self.request(service,'GET',route+'?extra=1')[0],404)
        running=manager.begin()
        self.assertEqual(self.request(service,'GET',f'/v1/pdf/jobs/{running.id}/alignment-layout.json')[0],409)
        path=server._alignment_path(job.directory,job.cache_info)
        path.chmod(0o644)
        status,raw=self.request(service,'GET',route)
        self.assertEqual((status,json.loads(raw)),(404,{'error':'alignment_unavailable'}))

    def test_layout_projection_does_not_alias_full_snapshot_or_other_reads(self):
        manager=self.manager();job=self.install(manager)
        first=manager.read_layout_alignment(job)
        first['pages'][0]['paragraphs'][0]['source']['rects'][0][0]=999
        first['sourcePages'].append(99)
        self.assertEqual(manager.read_layout_alignment(job),self.value)
        self.assertEqual(manager.read_alignment(job),self.value)

    def test_store_validated_snapshot_is_reused_and_every_reader_owns_its_deep_tree(self):
        manager=self.manager();job=self.install(manager)
        with patch.object(server,'validate_alignment',side_effect=AssertionError('a trusted unchanged snapshot was fully revalidated')), \
                patch.object(server,'_private_file',side_effect=AssertionError('cached metadata bytes were reread')):
            first=manager.read_alignment(job)
            first['pages'][0]['paragraphs'][0]['source']['text']='caller mutation'
            first['pages'][0]['paragraphs'][0]['source']['rects'][0][0]=999
            first['pages'].append({'caller':'owned'})
            second=manager.read_alignment(job)
        self.assertEqual(second,self.value)
        self.assertIsNot(first['pages'],second['pages'])

    def test_restart_keeps_its_already_validated_generation_without_a_second_full_scan(self):
        manager=self.manager();job=self.install(manager)
        with patch.object(server,'validate_alignment',wraps=server.validate_alignment) as validate:
            restarted=self.manager();current=restarted.get(job.id)
            self.assertEqual(validate.call_count,1)
            self.assertEqual(restarted.read_alignment(current),self.value)
            self.assertEqual(restarted.read_alignment(current),self.value)
            self.assertEqual(validate.call_count,1)

    def test_actual_file_content_inode_mode_links_and_preserved_mtime_never_bypass_snapshot_guard(self):
        manager=self.manager()
        for change in ('content','inode','mode','symlink','hardlink'):
            with self.subTest(change=change):
                job=self.install(manager);path=server._alignment_path(job.directory,job.cache_info)
                old=path.stat();raw=path.read_bytes()
                if change=='content':
                    changed=raw.replace(b'First fact',b'Other fact',1)
                    self.assertEqual(len(changed),len(raw));path.write_bytes(changed)
                    os.utime(path,ns=(old.st_atime_ns,old.st_mtime_ns))
                elif change=='inode':
                    replacement=job.directory/'replacement.json';replacement.write_bytes(raw);replacement.chmod(0o600)
                    os.utime(replacement,ns=(old.st_atime_ns,old.st_mtime_ns));os.replace(replacement,path)
                elif change=='mode':path.chmod(0o644)
                elif change=='symlink':
                    outside=job.directory/'owned-copy.json';outside.write_bytes(raw);outside.chmod(0o600)
                    path.unlink();path.symlink_to(outside)
                else:os.link(path,job.directory/'linked-copy.json')
                with patch.object(server,'validate_alignment',side_effect=AssertionError('changed metadata reached semantic validation')):
                    with self.assertRaisesRegex(ProtocolFailure,'alignment_unavailable'):manager.read_alignment(job)

    def test_change_during_copy_is_rejected_before_the_snapshot_is_returned(self):
        manager=self.manager();job=self.install(manager);path=server._alignment_path(job.directory,job.cache_info)
        original=server.json.loads
        def changed_copy(*args,**kwargs):
            result=original(*args,**kwargs);path.chmod(0o644);return result
        with patch.object(server.json,'loads',side_effect=changed_copy):
            with self.assertRaisesRegex(ProtocolFailure,'alignment_unavailable'):manager.read_alignment(job)

    def test_publish_switches_generation_only_after_commit_and_never_aliases_its_caller(self):
        manager=self.manager();job=self.install(manager);old=manager.read_alignment(job)
        updated=copy.deepcopy(old);updated.update(granularity='sentence',sentenceAlignmentRevision='pdf-sentence-semantic-v1',sentencePages=[])
        with patch.object(server,'validate_alignment',wraps=server.validate_alignment) as validate:
            manager.publish_alignment(job,updated);self.assertEqual(validate.call_count,1)
            updated['pages'][0]['paragraphs'][0]['source']['text']='mutated after publication'
            current=manager.read_alignment(job);self.assertEqual(validate.call_count,1)
        self.assertEqual(current['granularity'],'sentence')
        self.assertEqual(current['pages'],old['pages'])
        restarted=self.manager();self.assertEqual(restarted.read_alignment(restarted.get(job.id)),current)

    def test_failed_metadata_commit_preserves_the_previous_validated_snapshot(self):
        manager=self.manager();job=self.install(manager);old=manager.read_alignment(job)
        updated=copy.deepcopy(old);updated.update(granularity='sentence',sentenceAlignmentRevision='pdf-sentence-semantic-v1',sentencePages=[])
        atomic=server.atomic_json
        def failed(path,value):
            if path.name=='cache.json':raise OSError('interrupted metadata pointer')
            return atomic(path,value)
        with patch.object(server,'atomic_json',side_effect=failed):
            with self.assertRaises(OSError):manager.publish_alignment(job,updated)
        with patch.object(server,'validate_alignment',side_effect=AssertionError('failed publish replaced a valid generation')):
            self.assertEqual(manager.read_alignment(job),old)

    def test_lru_job_limit_evicts_old_metadata_without_discarding_its_completed_pdf(self):
        with patch.object(server,'MAX_ALIGNMENT_SNAPSHOT_JOBS',2):
            manager=self.manager();jobs=[self.install(manager) for _ in range(3)]
            with patch.object(server,'validate_alignment',wraps=server.validate_alignment) as validate:
                manager.read_alignment(jobs[1]);self.assertEqual(validate.call_count,0)
                manager.read_alignment(jobs[0]);self.assertEqual(validate.call_count,0)
                manager.read_alignment(jobs[1]);self.assertEqual(validate.call_count,0)
                manager.read_alignment(jobs[2]);self.assertEqual(validate.call_count,0)
            self.assertTrue(all((job.directory/'mono.pdf').is_file() for job in jobs))

    def test_oversized_metadata_is_read_safely_without_exceeding_the_byte_cache_budget(self):
        with patch.object(server,'MAX_ALIGNMENT_SNAPSHOT_BYTES',1):
            manager=self.manager();job=self.install(manager)
            with patch.object(server,'validate_alignment',wraps=server.validate_alignment) as validate:
                self.assertEqual(manager.read_alignment(job),self.value)
                self.assertEqual(manager.read_alignment(job),self.value)
                self.assertEqual(validate.call_count,0)

    def test_unproven_generation_must_be_validated_before_later_evicted_reads_can_reuse_it(self):
        manager=self.manager();job=self.install(manager)
        manager._forget_alignment_snapshot(job.id)
        job._validated_alignment_binding=None
        with patch.object(server,'validate_alignment',wraps=server.validate_alignment) as validate:
            self.assertEqual(manager.read_alignment(job),self.value)
            self.assertEqual(validate.call_count,1)
            manager._forget_alignment_snapshot(job.id)
            self.assertEqual(manager.read_alignment(job),self.value)
            self.assertEqual(validate.call_count,1)

    def test_matching_unproven_signature_and_hash_cannot_admit_invalid_semantics(self):
        manager=self.manager();job=self.install(manager)
        path=server._alignment_path(job.directory,job.cache_info)
        invalid=copy.deepcopy(self.value)
        invalid['pages'][0]['paragraphs'][0]['source']['rects']=[[0,0,0,10]]
        raw=json.dumps(invalid).encode();path.write_bytes(raw)
        metadata=copy.deepcopy(job.cache_info)
        metadata['alignment']={'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)}
        unproven=server.Job('0'*32,job.directory,state='complete',source_pages=job.source_pages[:],
            page_count=job.page_count,cache_info=metadata,
            output_signatures={'alignment':server._output_signature(path,server.MAX_ALIGNMENT_BYTES)})
        with patch.object(server,'validate_alignment',wraps=server.validate_alignment) as validate:
            with self.assertRaisesRegex(ProtocolFailure,'alignment_unavailable'):manager.read_alignment(unproven)
        self.assertEqual(validate.call_count,1)

    def test_changed_source_sha_or_physical_scope_cannot_reuse_a_previous_snapshot(self):
        manager=self.manager();job=self.install(manager)
        for change in ('source','scope'):
            with self.subTest(change=change):
                old_sha=job.cache_info['sourceSHA256'];old_pages=job.source_pages
                try:
                    if change=='source':job.cache_info['sourceSHA256']='f'*64
                    else:job.source_pages=[1,0]
                    with self.assertRaisesRegex(ProtocolFailure,'alignment_unavailable'):manager.read_alignment(job)
                finally:job.cache_info['sourceSHA256']=old_sha;job.source_pages=old_pages


if __name__=='__main__':unittest.main()
