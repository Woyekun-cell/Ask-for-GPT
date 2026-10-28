"""Numeric certainty guard: real replay IDs, no helper, PDF or network writes."""
import copy
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import sentence_alignment as sentence
from layout_common import ProtocolFailure

class SentenceNumericGuardTests(unittest.TestCase):
    @staticmethod
    def request(sources,targets):
        return [{'id':'p','source':[{'id':k,'text':v} for k,v in sources], 'target':[{'id':k,'text':v} for k,v in targets]}]

    def test_recorded_five_wrong_numeric_edges_are_omitted_and_three_legal_siblings_survive(self):
        request=self.request([('s23','91.'),('s30','93.'),('s33','94.'),('s44','9, e1002935 (2013).'),('s45','97.'),('s52','99.'),('s79','3, 3 (2018).'),('s94','19, 127 (2017).')],
            [('t28','91.'),('t36','93.'),('t52','9, e1002935 (2013)。'),('t53','97.'),('t93','3, 3 (2018)。')])
        original={'s23':['t53'],'s30':['t28'],'s33':['t36'],'s44':['t52'],'s45':['t53'],'s52':['t52'],'s79':['t93'],'s94':['t93']};before=copy.deepcopy(original)
        result=sentence.validate_matches(original,request)
        self.assertEqual({k for k,v in result.items() if not v},{'s23','s30','s33','s52','s94'})
        self.assertEqual({k:v for k,v in result.items() if v},{'s44':['t52'],'s45':['t53'],'s79':['t93']});self.assertEqual(original,before);self.assertIsNot(result,original)

    def test_whole_numeric_tokens_decimal_sign_order_and_e_identifier_are_preserved(self):
        pairs=[('91.','191.',False),('91.','A91',False),('1.2.','12.',False),('-1.2.','1.2.',False),('+1.2.','1.2.',False),('-1.2.','-1.2。',True),('1, 2.','2, 1.',False),('e1002935.','1002935.',False),('9,e1002935(2013).','9,e1002936(2013)。',False),('9,e1002935(2013).','9, e1002935 (2013)。',True),('９１.','91.',False),('1 2.','12.',True)]
        for left,right,keep in pairs:
            with self.subTest(source=left,target=right):
                result=sentence.validate_matches({'s':['t']},self.request([('s',left)],[('t',right)]));self.assertEqual(result['s'],['t'] if keep else [])

    def test_target_merged_numbers_and_multiple_target_sentences_allow_only_contiguous_anchor_subsequence(self):
        for source,target,keep in [('91.','Merged citations 89, 91, 93.',True),('91,93.','89,91,92,93.',False),('91,93.','89,91,93,95.',True)]:
            with self.subTest(source=source,target=target):self.assertEqual(sentence.validate_matches({'s':['t']},self.request([('s',source)],[('t',target)]))['s'],['t'] if keep else [])
        self.assertEqual(sentence.validate_matches({'s':['t0','t1']},self.request([('s','91,93.')],[('t0','89,91.'),('t1','93,95.')]))['s'],['t0','t1'])

    def test_observed_digit_whitespace_split_keeps_only_the_existing_model_edge(self):
        request=self.request([('s','20,159–163(2018).')],[('t','20, 1 59–163 (2018)。')])
        self.assertEqual(sentence.validate_matches({'s':['t']},request),{'s':['t']})
        self.assertEqual(sentence.validate_matches({'s':[]},request),{'s':[]},'uncertainty may preserve but never invent a match')

    def test_digit_whitespace_fallback_never_discards_decimal_sign_or_e_identifier(self):
        for left,right in [('-159.','+1 59.'),('-159.','1 59.'),('1.59.','1 59.'),('e159.','1 59.'),('91.','191.')]:
            with self.subTest(source=left,target=right):self.assertEqual(sentence.validate_matches({'s':['t']},self.request([('s',left)],[('t',right)])),{'s':[]})

    def test_normal_prose_and_legal_semantic_reordering_do_not_get_a_global_adjacency_rule(self):
        request=self.request([('s0','Three controls differ.'),('s20','Control 91 differs.'),('s50','A distant sentence.')],[('t0','91个对照有差异。'),('t1','另一个句子。')])
        value={'s0':['t1'],'s20':['t0'],'s50':['t1']};self.assertEqual(sentence.validate_matches(value,request),value)

    def test_unknown_duplicate_cross_or_many_to_many_ids_still_raise_before_filtering(self):
        request=self.request([('s0','91.'),('s1','92.')],[('t0','191.'),('t1','192.')])
        for value in [{'s0':['unknown'],'s1':[]},{'s0':['t0','t0'],'s1':[]},{'s0':['t0','t1'],'s1':['t0']}]:
            with self.subTest(value=value),self.assertRaises(ProtocolFailure):sentence.validate_matches(value,request)

    @staticmethod
    def cached():
        def row(identity,left,right,method='semantic-model'):
            return {'id':identity,'method':method,'source':{'text':left,'rects':[[1,1,2,2]]},'target':{'text':right,'rects':[[3,1,4,2]]},'phrases':[{'id':identity+'_phrase'}]}
        rows=[row('n0','91. 97.','97.'),row('n1','93.','91.'),row('n2','94.','93.'),row('n3','9,e1002935(2013). 99.','9,e1002935(2013)。'),row('n4','3,3(2018). 19,127(2017).','3,3(2018)。'),row('good','97.','97。'),row('prose','Gene e1002935 has 91 reads.','这个基因有191个读段。'),row('identity','91.','191.','glyph-identity')]
        return {'granularity':'sentence','sentencePages':[0,1],'sentencePartialPages':[],'phrasePages':[0,1],'phraseExtractedPages':[0,1],'phraseCoverage':{'0':{'aligned':8},'1':{'aligned':1}},'pages':[{'sourcePage':0,'paragraphs':[{'id':'p0','source':{'text':'keep source'},'target':{'text':'keep target'},'sentences':rows}]},{'sourcePage':1,'paragraphs':[{'id':'p1','sentences':[row('other','42.','42。')]}]}]}

    def test_cached_merged_numeric_rows_and_their_phrases_are_removed_without_rewriting_parent_or_other_page(self):
        value=self.cached();before=copy.deepcopy(value);changed=sentence.filter_unsafe_numeric_sentence_links(value)
        self.assertTrue(changed);paragraph=value['pages'][0]['paragraphs'][0]
        self.assertEqual([row['id'] for row in paragraph['sentences']],['good','prose','identity'])
        self.assertEqual(paragraph['source'],before['pages'][0]['paragraphs'][0]['source']);self.assertEqual(paragraph['target'],before['pages'][0]['paragraphs'][0]['target']);self.assertEqual(value['pages'][1],before['pages'][1])
        self.assertEqual(value['sentencePages'],[1]);self.assertEqual(value['sentencePartialPages'],[0]);self.assertEqual(value['phraseExtractedPages'],[1]);self.assertEqual(value['phrasePages'],[0,1]);self.assertEqual(value['phraseCoverage'],{'1':{'aligned':1}})
        frozen=copy.deepcopy(value);self.assertFalse(sentence.filter_unsafe_numeric_sentence_links(value));self.assertEqual(value,frozen)

    def test_cached_legal_merged_target_and_normal_text_are_noops(self):
        value=self.cached();value['pages'][0]['paragraphs'][0]['sentences']=value['pages'][0]['paragraphs'][0]['sentences'][5:];value['pages'][0]['paragraphs'][0]['sentences'][0]['target']['text']='其他数 89,97,100。';before=copy.deepcopy(value)
        self.assertFalse(sentence.filter_unsafe_numeric_sentence_links(value));self.assertEqual(value,before)

if __name__=='__main__':unittest.main()
