"""Exact research section headings cannot silently become a different section."""
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from gpt_batch import apply_prepared_translation


class ScientificHeadingTests(unittest.TestCase):
    def apply(self,source,output,lang_in="en",lang_out="zh-CN"):
        calls=[]
        translator=SimpleNamespace(translation_config=SimpleNamespace(lang_in=lang_in,lang_out=lang_out,
            raise_if_cancelled=lambda:None),post_translate_paragraph=lambda *args:calls.append(args[-1]))
        with patch('layout_quality.mark_source_preserved') as preserved:
            applied=apply_prepared_translation(translator,object(),object(),object(),object(),source,output)
        return calls,applied,preserved.called

    def test_competing_interests_cannot_become_author_contributions(self):
        self.assertEqual(self.apply('Competing interests','作者贡献'),(['利益冲突'],True,False))
        self.assertEqual(self.apply('Author contributions','利益冲突'),(['作者贡献'],True,False))

    def test_only_the_entire_exact_heading_is_calibrated(self):
        for source,output in [('Acknowledgements','致谢'),('References','参考文献'),
            ('Competing interests affect these decisions.','相互竞争的利益影响这些决定。'),
            ('Competing {v0} interests','相互竞争的{v0}利益'),('Table','表'),('Methods and results','方法与结果')]:
            with self.subTest(source=source):self.assertEqual(self.apply(source,output)[0],[output])

    def test_reverse_direction_and_unsupported_language_are_not_confused(self):
        self.assertEqual(self.apply('利益冲突','Author contributions','zh-CN','en')[0],['Competing interests'])
        self.assertEqual(self.apply('作者贡献','Competing interests','zh-Hans','en')[0],['Author contributions'])
        self.assertEqual(self.apply('Competing interests','Contributions','en','fr')[0],['Contributions'])

    def test_identity_return_of_a_recognized_heading_is_still_translated(self):
        self.assertEqual(self.apply('  competing   interests  ','  competing   interests  '),(['利益冲突'],True,False))
        self.assertEqual(self.apply('DNA','DNA'),([],False,True))


if __name__=='__main__':unittest.main()
