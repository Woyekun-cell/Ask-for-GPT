"""Exact validated model batches survive a failed PDF job, without replay."""
import json,os,sys,tempfile,unittest,hashlib
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import batch_checkpoint
from layout_common import ProtocolFailure

class CheckpointTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.calls=0
  self.rows=[{'id':'p1','text':'There are 12 cells {v1}.'}]
  self.output=[{'id':'p1','text':'有12个细胞 {v1}。'}]
 def tearDown(self):self.tmp.cleanup()
 def model(self,rows,context=None):self.calls+=1;return [{'id':x['id'],'text':self.output[0]['text']} for x in rows]
 def cache(self,key='a'*64):return batch_checkpoint.BatchCheckpoint(self.root,key,'en','zh-Hans')
 def test_reopen_after_failed_other_page_reuses_identical_validated_output_without_model(self):
  self.assertEqual(self.cache().translate(self.model,self.rows,{'before':'A','after':'B'}),self.output)
  def failed(*a,**k):raise ProtocolFailure('gpt_unavailable')
  with self.assertRaises(ProtocolFailure):self.cache().translate(failed,[{'id':'p2','text':'Other page'}])
  self.assertEqual(self.cache().translate(failed,self.rows,{'before':'A','after':'B'}),self.output)
  self.assertEqual(self.calls,1)
 def test_every_input_context_language_and_binding_change_misses(self):
  c=self.cache();c.translate(self.model,self.rows)
  for rows,context in [(self.rows,{'before':'X','after':''}),([{'id':'p1','text':'Different 12 cells {v1}.'}],None),([{'id':'p2','text':self.rows[0]['text']}],None)]:
   c.translate(self.model,rows,context)
  self.cache('b'*64).translate(self.model,self.rows)
  self.assertEqual(self.calls,5)
 def test_invalid_or_failed_outputs_are_never_saved(self):
  c=self.cache()
  for output in [[],[{'id':'p1','text':'Missing marker'}]]:
   with self.assertRaises(ProtocolFailure):c.translate(lambda *a,**k:output,self.rows)
  self.assertEqual(c.translate(self.model,self.rows),self.output);self.assertEqual(self.calls,1)
 def test_tampered_record_or_nonprivate_file_is_miss_and_not_accepted(self):
  for change in ['text','permission','symlink','hardlink']:
   with self.subTest(change=change):
    c=self.cache();c.translate(self.model,self.rows);p=next((self.root/'translation-checkpoints'/('a'*64)).glob('*.json'))
    if change=='text':
     v=json.loads(p.read_text());v['translations'][0]['text']='changed {v1}';p.write_text(json.dumps(v))
    elif change=='permission':p.chmod(0o644)
    elif change=='symlink':
     q=self.root/'target';p.rename(q);p.symlink_to(q)
    else:os.link(p,self.root/'link')
    before=self.calls;self.assertEqual(c.translate(self.model,self.rows),self.output);self.assertEqual(self.calls,before+1)
    # Only disposable fixture paths; product must leave unsafe entries alone.
    for q in (self.root/'translation-checkpoints'/('a'*64)).glob('*'):q.unlink()
    for name in ['target','link']:(self.root/name).unlink(missing_ok=True)
 def test_unsafe_checkpoint_parent_disables_cache_without_following_it(self):
  target=self.root/'outside';target.mkdir();(self.root/'translation-checkpoints').symlink_to(target,target_is_directory=True)
  self.assertEqual(self.cache().translate(self.model,self.rows),self.output);self.assertEqual(list(target.iterdir()),[])
 def test_entries_are_private_and_record_contains_no_original_text(self):
  self.cache().translate(self.model,self.rows)
  p=next((self.root/'translation-checkpoints'/('a'*64)).glob('*.json'))
  self.assertEqual(p.stat().st_mode&0o777,0o600);self.assertEqual(p.parent.stat().st_mode&0o777,0o700)
  self.assertNotIn('There are',p.read_text());self.assertNotIn('before',p.read_text())
if __name__=='__main__':unittest.main()
