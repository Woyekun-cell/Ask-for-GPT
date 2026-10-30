"""Compact only overwritten graphic history; all live PDF instructions stay exact."""
import sys,unittest,random
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from preparation import compact_graphic_history
from babeldoc.format.pdf.document_il.frontend import il_creater_active_support as support
from babeldoc.format.pdf.document_il.frontend import il_creater_active as active
class PreparationTests(unittest.TestCase):
 def test_real_graphic_sequences_match_before_after_and_old_snapshots_do_not_change(self):
  random.seed(92);plain=support.EMPTY_PASSTHROUGH_SNAPSHOT;fast=plain;old=[]
  original=support.replace_first_passthrough_operator
  with compact_graphic_history():
   for i in range(3000):
    op=random.choice(['w','J','j','M']);item=(op,str(i%9))
    if i%139==0:
     plain=support.append_passthrough_instruction(plain,('q',''));fast=support.append_passthrough_instruction(fast,('q',''))
    plain=original(plain,op,item);fast=active.replace_first_passthrough_operator(fast,op,item)
    if i%37==0:
     self.assertEqual(plain.to_tuple(),fast.to_tuple());self.assertEqual(plain.render(),fast.render())
     self.assertEqual(plain.next_version,fast.next_version);old.append((fast,fast.to_tuple()))
   self.assertLess(fast.event_count,300)
  self.assertIs(support.replace_first_passthrough_operator,original)
  for snapshot,expected in old:self.assertEqual(snapshot.to_tuple(),expected)
 def test_context_restores_functions_on_failure_and_tuple_input_uses_original(self):
  original=support.replace_first_passthrough_operator;adapter=active.replace_first_passthrough_operator
  with self.assertRaises(ValueError),compact_graphic_history():
   self.assertEqual(active.replace_first_passthrough_operator((('w','1'),),'w',('w','2')),(('w','2'),))
   raise ValueError()
  self.assertIs(support.replace_first_passthrough_operator,original);self.assertIs(active.replace_first_passthrough_operator,adapter)
if __name__=='__main__':unittest.main()
