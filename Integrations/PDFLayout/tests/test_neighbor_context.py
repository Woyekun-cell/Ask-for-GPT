"""Read-only, bounded context from true physical neighbours, never OCR."""
from pathlib import Path
import copy
import hashlib
import json
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import gpt_batch
import worker
from page_parallel import NativeHelperPool
from layout_common import ProtocolFailure


class NeighborContextTests(unittest.TestCase):
    def make_pdf(self,path):
        import pymupdf
        with pymupdf.open()as document:
            for index in range(4):
                page=document.new_page()
                page.insert_textbox(pymupdf.Rect(60,90,530,300),
                    f'Physical page {index} contains actual source prose for context. '
                    f'This scientific sentence preserves marker PHYSICAL_{index} and the original meaning. '
                    'The paragraph continues with enough native text to distinguish prose from a short figure label.',fontsize=11)
            document.save(path)
    def test_single_and_gapped_selections_use_real_neighbours_not_compact_pages(self):
        self.assertTrue(hasattr(worker,'collect_source_context'))
        with tempfile.TemporaryDirectory()as temporary:
            path=Path(temporary)/'source.pdf';self.make_pdf(path)
            digest=hashlib.sha256(path.read_bytes()).hexdigest()
            all_pages=worker.collect_source_context(path,[0,1,2,3])
            gapped=worker.collect_source_context(path,[0,2])
            single=worker.collect_source_context(path,[2])
            self.assertIn('PHYSICAL_1',gapped[0]['after'])
            self.assertNotIn('PHYSICAL_2',gapped[0]['after'])
            self.assertIn('PHYSICAL_1',gapped[2]['before'])
            self.assertIn('PHYSICAL_3',gapped[2]['after'])
            self.assertEqual(dict(single[2]),dict(all_pages[2]))
            self.assertEqual(dict(gapped[2]),dict(all_pages[2]))
            self.assertEqual(all_pages[0]['before'],'')
            self.assertEqual(all_pages[3]['after'],'')
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),digest)
    def test_context_is_immutable_and_never_mutates_native_blocks(self):
        self.assertTrue(hasattr(worker,'_source_page_prose'))
        lines=[{'spans':[{'text':'A genuine source paragraph contains relevant scientific words and remains unchanged.'}]}]
        value={'blocks':[{'type':0,'bbox':(60,90,530,150),'lines':lines}]}
        previous=copy.deepcopy(value)
        page=SimpleNamespace(rect=SimpleNamespace(width=595,height=842),get_text=lambda *a,**k:value)
        self.assertIn('genuine source',worker._source_page_prose(page))
        self.assertEqual(value,previous)
        with tempfile.TemporaryDirectory()as temporary:
            path=Path(temporary)/'source.pdf';self.make_pdf(path)
            contexts=worker.collect_source_context(path,[0])
            with self.assertRaises(TypeError):contexts[0]['after']='changed'
            with self.assertRaises(TypeError):contexts[0]={}
    def test_native_columns_keep_left_then_right_and_remove_captions_margins_labels(self):
        self.assertTrue(hasattr(worker,'_source_page_prose'))
        def block(box,text):return {'type':0,'bbox':box,'lines':[{'spans':[{'text':text}]}]}
        value={'blocks':[
            block((320,60,555,150),'RIGHT_BEGIN has enough scientific words to qualify as actual body prose.'),
            block((40,380,290,440),'Fig. 2 This caption has enough scientific words but must never enter neighbour prose context.'),
            block((40,400,290,500),'LEFT_END has enough scientific words to qualify as actual body prose.'),
            block((40,60,290,150),'LEFT_BEGIN has enough scientific words to qualify as actual body prose.'),
            block((40,5,550,25),'HEADER has enough words but appears in the running page header margin.'),
            block((40,790,550,830),'FOOTER has enough words but appears in the running page footer margin.'),
            block((40,250,100,300),'CELL has descriptive words from a narrow table column and is excluded.'),
            {'type':1,'bbox':(0,0,500,500),'image':b'never OCR'},
        ]}
        page=SimpleNamespace(rect=SimpleNamespace(width=595,height=842),get_text=lambda *a,**k:value)
        text=worker._source_page_prose(page)
        self.assertLess(text.index('LEFT_BEGIN'),text.index('LEFT_END'))
        self.assertLess(text.index('LEFT_END'),text.index('RIGHT_BEGIN'))
        for forbidden in ['caption','HEADER','FOOTER','CELL','never OCR']:self.assertNotIn(forbidden,text)
    def test_unicode_scalar_limits_and_invalid_context_rejected(self):
        self.assertTrue(hasattr(gpt_batch,'validate_context'))
        context={'before':'😀'*2000,'after':'汉'*2000}
        self.assertEqual(gpt_batch.validate_context(context),context)
        self.assertIsNone(gpt_batch.validate_context(None))
        for invalid in [{'before':'😀'*2001,'after':''},{'before':'','after':'x'*2001},
                {'before':'\ud800','after':''},{'before':2,'after':''},{'before':'x'},{'before':'','after':'','path':'secret'},[]]:
            with self.subTest(invalid=str(invalid)[:45]),self.assertRaises(ProtocolFailure):gpt_batch.validate_context(invalid)
    def test_snapshot_mapping_does_not_treat_skipped_selected_pages_as_adjacent(self):
        self.assertTrue(hasattr(gpt_batch,'snapshot_page_context'))
        engine=SimpleNamespace(source_page_indices=(0,2),source_context_by_physical={
            0:{'before':'','after':'true physical one'},2:{'before':'true physical one','after':'true physical three'}})
        document=SimpleNamespace(page=[SimpleNamespace(page_number=0),SimpleNamespace(page_number=1)])
        value=gpt_batch.snapshot_page_context(document,engine)
        self.assertEqual(value[1]['before'],'true physical one')
        engine.source_context_by_physical[2]['before']='later mutation'
        self.assertEqual(value[1]['before'],'true physical one')
        with self.assertRaises(TypeError):value[1]['before']='mutate'
    def test_pool_passes_optional_context_without_breaking_legacy_helpers(self):
        observed=[]
        class ContextHelper:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def translate_batch(self,rows,context=None):observed.append(context);return rows
        context={'before':'previous','after':'following'}
        with NativeHelperPool(ContextHelper,1)as pool:
            self.assertEqual(pool.translate_batch([{'id':'p0','text':'source'}],context=context)[0]['text'],'source')
        self.assertEqual(observed,[context])
        class LegacyHelper(ContextHelper):
            def translate_batch(self,rows):return rows
        with NativeHelperPool(LegacyHelper,1)as pool:self.assertEqual(pool.translate_batch([{'id':'p0','text':'source'}])[0]['text'],'source')
    def test_native_jsonl_contains_only_actual_optional_context(self):
        with tempfile.TemporaryDirectory()as temporary:
            path=Path(temporary)/'helper'
            path.write_text('#!/usr/bin/env python3\nimport json,sys\nfor line in sys.stdin:\n r=json.loads(line)\n'
                " text=json.dumps(r.get('context','NO_CONTEXT'),ensure_ascii=False)\n"
                " print(json.dumps({'id':r['id'],'translations':[{'id':x['id'],'text':text}for x in r['segments']]}),flush=True)\n")
            path.chmod(0o700)
            with worker.NativeHelper(path,'en','zh-Hans')as helper:
                rows=[{'id':'p0','text':'source'}];context={'before':'previous','after':'following'}
                self.assertEqual(json.loads(helper.translate_batch(rows,context=context)[0]['text']),context)
                self.assertEqual(json.loads(helper.translate_batch(rows)[0]['text']),'NO_CONTEXT')
    def test_invalid_context_never_starts_native_process(self):
        helper=worker.NativeHelper(Path('/must-not-start'),'en','zh-Hans')
        with patch.object(worker.subprocess,'Popen')as popen,self.assertRaises(ProtocolFailure):
            helper.translate_batch([{'id':'p0','text':'source'}],context={'before':'x'*2001,'after':''})
        popen.assert_not_called()
    def test_rotation_does_not_change_native_neighbour_prose(self):
        import pymupdf
        with tempfile.TemporaryDirectory()as temporary:
            original=Path(temporary)/'source.pdf';rotated=Path(temporary)/'rotated.pdf';self.make_pdf(original)
            with pymupdf.open(original)as document:
                for page in document:page.set_rotation(90)
                document.save(rotated)
            a,b=worker.collect_source_context(original,[1]),worker.collect_source_context(rotated,[1])
            self.assertEqual(dict(a[1]),dict(b[1]))
    def test_invalid_physical_selections_are_rejected(self):
        with tempfile.TemporaryDirectory()as temporary:
            source=Path(temporary)/'source.pdf';self.make_pdf(source)
            for selected in [[],[True],[0,0],[2,1],[0,'2'],[[]],[-1],[4]]:
                with self.subTest(selected=selected),self.assertRaises(ProtocolFailure):worker.collect_source_context(source,selected)
    def test_page_adapter_freezes_and_delivers_context_without_translating_it(self):
        from babeldoc.format.pdf.document_il.midend.il_translator import ILTranslator
        observed=[]
        def run_parent(instance,document):
            for page in document.page:instance.process_page(page,None,None,SimpleNamespace(new_paragraph=lambda:object()))
        def translate(rows,context=None):
            observed.append(dict(context))
            return [{'id':row['id'],'text':'译：'+row['text']}for row in rows]
        cls=gpt_batch.page_translator_class();translator=cls.__new__(cls)
        translator.translation_config=SimpleNamespace(raise_if_cancelled=lambda:None)
        translator.translate_engine=SimpleNamespace(batch_translate=translate,fatal_error=None,
            source_page_indices=(0,2),source_context_by_physical={
                0:{'before':'','after':'REAL_NEIGHBOUR_ONE'},2:{'before':'REAL_NEIGHBOUR_ONE','after':'REAL_NEIGHBOUR_THREE'}})
        translator.pre_translate_paragraph=lambda p,*args:(p.unicode,p.unicode)
        translator.post_translate_paragraph=lambda p,t,prepared,text:setattr(p,'unicode',text)
        pages=[SimpleNamespace(page_number=i,pdf_font=[],pdf_xobject=[],pdf_paragraph=[SimpleNamespace(unicode=f'body{i}')])for i in range(2)]
        with patch.object(ILTranslator,'translate',run_parent):translator.translate(SimpleNamespace(page=pages))
        self.assertEqual(observed,[{'before':'','after':'REAL_NEIGHBOUR_ONE'},
            {'before':'REAL_NEIGHBOUR_ONE','after':'REAL_NEIGHBOUR_THREE'}])
        self.assertEqual([page.pdf_paragraph[0].unicode for page in pages],['译：body0','译：body1'])


if __name__=='__main__':unittest.main()
