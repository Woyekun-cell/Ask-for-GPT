"""Validated immutable metadata snapshots avoid rereading an entire paper."""
import copy
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
                manager.read_alignment(jobs[0]);self.assertEqual(validate.call_count,1)
                manager.read_alignment(jobs[1]);self.assertEqual(validate.call_count,1)
                manager.read_alignment(jobs[2]);self.assertEqual(validate.call_count,2)
            self.assertTrue(all((job.directory/'mono.pdf').is_file() for job in jobs))

    def test_oversized_metadata_is_read_safely_without_exceeding_the_byte_cache_budget(self):
        with patch.object(server,'MAX_ALIGNMENT_SNAPSHOT_BYTES',1):
            manager=self.manager();job=self.install(manager)
            with patch.object(server,'validate_alignment',wraps=server.validate_alignment) as validate:
                self.assertEqual(manager.read_alignment(job),self.value)
                self.assertEqual(manager.read_alignment(job),self.value)
                self.assertEqual(validate.call_count,2)

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
