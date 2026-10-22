import importlib
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import threading
from helper_fixture import enable_python_helpers
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try:
    batch = importlib.import_module("gpt_batch")
except ModuleNotFoundError:
    batch = None
import worker
from layout_common import ProtocolFailure


class BatchContractTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(batch, "PDF page batch contract is missing")
        self.segments = [{"id": "p0", "text": "Table 1: A value {v1} grows."},
                         {"id": "p1", "text": "The protein is not active."}]

    def test_reordered_results_map_to_original_ids_and_keep_formula(self):
        result = batch.validate_translations([
            {"id": "p1", "text": "该蛋白不活跃。"},
            {"id": "p0", "text": "表1：数值 {v1} 增加。"}], self.segments)
        self.assertEqual([x["id"] for x in result], ["p0", "p1"])

    def test_missing_duplicate_extra_empty_and_wrong_formula_fail(self):
        valid = [{"id": "p0", "text": "表1：数值 {v1} 增加。"},
                 {"id": "p1", "text": "该蛋白不活跃。"}]
        variants = [valid[:1], [valid[0], valid[0]], valid + [{"id": "p9", "text": "多余"}],
                    [valid[0], {"id": "p1", "text": " "}],
                    [{"id": "p0", "text": "值 {v2} 增加"}, valid[1]],
                    [{"id": "p0", "text": "值 {v1} {v1} 增加"}, valid[1]]]
        for result in variants:
            with self.subTest(result=result), self.assertRaises(ProtocolFailure):
                batch.validate_translations(result, self.segments)

    def test_page_limits_fail_before_request(self):
        for segments in [[{"id": f"p{i}", "text": "text"} for i in range(257)],
                         [{"id": "p0", "text": "a" * 60001}],
                         [{"id": "p0", "text": "\x00" * 60000}],
                         [{"id": "p0", "text": "\ud800"}],
                         [{"id": "p0", "text": "x", "sourcePath": "not allowed"}]]:
            with self.subTest(count=len(segments)), self.assertRaises(ProtocolFailure):
                batch.validate_segments(segments)

    def test_real_figure_page_count_fits_one_batch_without_dropping_labels(self):
        segments = [{"id": "p" + str(index), "text": "A bounded figure label " + str(index)}
                    for index in range(131)]
        self.assertEqual(batch.validate_segments(segments), segments)
        translations = [{"id": item["id"], "text": "图标签 " + str(index)}
                        for index, item in enumerate(segments)]
        self.assertEqual(len(batch.validate_translations(translations, segments)), 131)

    def page_translator(self, translate):
        cls = batch.page_translator_class()
        instance = cls.__new__(cls)
        instance.translation_config = SimpleNamespace(raise_if_cancelled=lambda: None)
        instance.translate_engine = SimpleNamespace(batch_translate=translate, fatal_error=None)
        instance.pre_translate_paragraph = lambda paragraph, tracker, fonts, xfonts: (
            (None, None) if paragraph.unicode == "SKIP" else (paragraph.unicode, paragraph.unicode))
        instance.post_translate_paragraph = lambda paragraph, tracker, prepared, text: setattr(paragraph, "unicode", text)
        return instance

    def test_each_page_is_one_batch_and_results_do_not_cross_pages(self):
        calls = []
        def translate(segments):
            calls.append([x.copy() for x in segments])
            return [{"id": x["id"], "text": "译：" + x["text"]} for x in reversed(segments)]
        translator = self.page_translator(translate)
        tracker = SimpleNamespace(new_paragraph=lambda: object())
        progress = SimpleNamespace(advance=lambda count: None)
        pages = [SimpleNamespace(pdf_font=[], pdf_xobject=[], pdf_paragraph=[
            SimpleNamespace(unicode="Page one {v1}"), SimpleNamespace(unicode="SKIP"),
            SimpleNamespace(unicode="Table 1")]),
            SimpleNamespace(pdf_font=[], pdf_xobject=[], pdf_paragraph=[SimpleNamespace(unicode="Page two")])]
        for page in pages:
            translator.process_page(page, None, progress, tracker)
        self.assertEqual([len(x) for x in calls], [2, 1])
        self.assertEqual(pages[0].pdf_paragraph[0].unicode, "译：Page one {v1}")
        self.assertEqual(pages[0].pdf_paragraph[1].unicode, "SKIP")
        self.assertEqual(pages[1].pdf_paragraph[0].unicode, "译：Page two")

    def test_bad_page_batch_does_not_partially_apply_or_fallback(self):
        def translate(segments):
            return [{"id": segments[0]["id"], "text": "First translated"},
                    {"id": segments[1]["id"], "text": "Formula omitted"}]
        translator = self.page_translator(translate)
        page = SimpleNamespace(pdf_font=[], pdf_xobject=[], pdf_paragraph=[
            SimpleNamespace(unicode="First original"), SimpleNamespace(unicode="Value {v1}")])
        with self.assertRaisesRegex(ProtocolFailure, "formula_placeholder_mismatch"):
            translator.process_page(page, None, None, SimpleNamespace(new_paragraph=lambda: object()))
        self.assertEqual([x.unicode for x in page.pdf_paragraph], ["First original", "Value {v1}"])
        self.assertEqual(translator.translate_engine.fatal_error, "formula_placeholder_mismatch")

    def test_identity_segment_cannot_bypass_the_full_batch_formula_validation(self):
        translator=self.page_translator(lambda segments:[{'id':'p0','text':'Illumina'}, {'id':'p1','text':'Value {v2}'}])
        page=SimpleNamespace(pdf_font=[],pdf_xobject=[],pdf_paragraph=[SimpleNamespace(unicode='Illumina'),SimpleNamespace(unicode='Value {v1}')])
        with patch('layout_quality.mark_source_preserved') as preserved,self.assertRaisesRegex(ProtocolFailure,'formula_placeholder_mismatch'):
            translator.process_page(page,None,None,SimpleNamespace(new_paragraph=lambda:object()))
        preserved.assert_not_called();self.assertEqual([p.unicode for p in page.pdf_paragraph],['Illumina','Value {v1}'])

    def test_adapter_alias_restored_on_engine_exception(self):
        from babeldoc.format.pdf import high_level
        original = high_level.ILTranslator
        with self.assertRaisesRegex(RuntimeError, "synthetic"):
            with batch.patched_page_translator(high_level):
                self.assertIsNot(high_level.ILTranslator, original)
                raise RuntimeError("synthetic")
        self.assertIs(high_level.ILTranslator, original)

    def test_page_preserves_only_fixed_batch_error_detail(self):
        def translate(segments):
            failure = ProtocolFailure("batch_invalid")
            failure.error_detail = "formula"
            raise failure
        translator = self.page_translator(translate)
        page = SimpleNamespace(pdf_font=[], pdf_xobject=[], pdf_paragraph=[SimpleNamespace(unicode="A value {v1}")])
        with self.assertRaises(ProtocolFailure) as caught:
            translator.process_page(page, None, None, SimpleNamespace(new_paragraph=lambda: object()))
        self.assertEqual(getattr(caught.exception, "error_detail", None), "formula")

    def test_single_page_model_uses_explicit_cpu_without_global_provider_patch(self):
        self.assertTrue(hasattr(batch, "load_single_page_layout_model"), "single-page CPU model is missing")
        from babeldoc.docvision import doclayout
        providers_function = doclayout.onnxruntime.get_available_providers
        model = SimpleNamespace(metadata_props=[SimpleNamespace(key="stride", value="32"),
                                               SimpleNamespace(key="names", value="{0: 'text'}")],
                                SerializeToString=lambda: b"synthetic-model")
        with patch.object(doclayout, "get_doclayout_onnx_model_path", return_value="synthetic.onnx"), \
             patch.object(doclayout.onnx, "load", return_value=model), \
             patch.object(doclayout.onnxruntime, "InferenceSession", return_value="synthetic-session") as session:
            layout = batch.load_single_page_layout_model()
        session.assert_called_once_with(b"synthetic-model", providers=["CPUExecutionProvider"])
        self.assertEqual(layout.stride, 32)
        self.assertEqual(layout.model, "synthetic-session")
        self.assertEqual(layout._names, {0: "text"})
        self.assertIs(doclayout.onnxruntime.get_available_providers, providers_function)


class HeaderPreprocessingTests(unittest.TestCase):
    def translator(self, callback=None):
        class Translator:
            def pre_translate_paragraph(self,paragraph,tracker,fonts,xfonts):
                if callback: callback(self,paragraph)
                return ((paragraph.unicode,paragraph.unicode)
                        if len(paragraph.unicode)>=self.translation_config.min_text_length else (None,None))
        value=Translator()
        value.translation_config=SimpleNamespace(min_text_length=5,cancellation=object(),raise_if_cancelled=lambda:None)
        value.translate_engine=object();value.font_mapper=object()
        return value

    def test_short_headers_get_local_minimum_while_parallel_body_keeps_its_threshold(self):
        entered,release=threading.Event(),threading.Event();observed=[]
        def callback(instance,paragraph):
            observed.append(instance)
            if paragraph.header:
                entered.set();self.assertTrue(release.wait(2))
        translator=self.translator(callback);config=translator.translation_config
        header=SimpleNamespace(unicode='Mean',header=True)
        body=SimpleNamespace(unicode='Mean',header=False)
        with patch('layout_quality.is_table_header',side_effect=lambda page,p:p.header),ThreadPoolExecutor(2) as executor:
            pending=executor.submit(batch.prepare_source_paragraph,translator,object(),header,None,{}, {})
            try:
                self.assertTrue(entered.wait(2))
                self.assertEqual(config.min_text_length,5)
                self.assertEqual(batch.prepare_source_paragraph(translator,object(),body,None,{},{}),(None,None))
            finally:release.set()
            self.assertEqual(pending.result(2),('Mean','Mean'))
        local=observed[0]
        self.assertIsNot(local,translator);self.assertIsNot(local.translation_config,config)
        self.assertIs(local.translation_config.cancellation,config.cancellation)
        self.assertIs(local.translation_config.raise_if_cancelled,config.raise_if_cancelled)
        self.assertIs(local.font_mapper,translator.font_mapper);self.assertIs(local.translate_engine,translator.translate_engine)
        self.assertIs(translator.translation_config,config);self.assertEqual(config.min_text_length,5)

    def test_header_failure_leaves_original_translator_and_config_unchanged(self):
        def fail(instance,paragraph):raise RuntimeError('synthetic header failure')
        translator=self.translator(fail);config=translator.translation_config
        with patch('layout_quality.is_table_header',return_value=True),self.assertRaisesRegex(RuntimeError,'synthetic header'):
            batch.prepare_source_paragraph(translator,object(),SimpleNamespace(unicode='Ref.'),None,{}, {})
        self.assertIs(translator.translation_config,config);self.assertEqual(config.min_text_length,5)

    def test_unconfirmed_short_text_never_gets_a_header_exception(self):
        translator=self.translator()
        with patch('layout_quality.is_table_header',return_value=False):
            for text in ['Read','Mean','Ref.','Cell']:
                self.assertEqual(batch.prepare_source_paragraph(translator,object(),SimpleNamespace(unicode=text),None,{},{}),(None,None))

    def test_confirmed_short_text_row_label_has_the_same_isolated_exception(self):
        translator=self.translator();config=translator.translation_config
        with patch('layout_quality.is_table_header',return_value=False),patch('layout_quality.is_table_row_label',return_value=True):
            self.assertEqual(batch.prepare_source_paragraph(translator,object(),SimpleNamespace(unicode='Sex'),None,{},{}),('Sex','Sex'))
        self.assertIs(translator.translation_config,config);self.assertEqual(config.min_text_length,5)


class BatchHelperProtocolTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(worker.NativeHelper, "translate_batch"), "GPT batch helper is missing")
        enable_python_helpers(self, worker)
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "helper"

    def tearDown(self):
        if hasattr(self, "temp"): self.temp.cleanup()

    def make_helper(self, body):
        self.path.write_text("#!/usr/bin/env python3\nimport json,sys,time\n" + body, encoding='utf-8')
        self.path.chmod(0o700)
        return worker.NativeHelper(self.path, "en", "zh-Hans", batch_timeout=2)

    def test_batch_launch_flag_and_jsonl_identity(self):
        body = "assert sys.argv[1:] == ['--gpt-batch']\nfor line in sys.stdin:\n r=json.loads(line); print(json.dumps({'id':r['id'],'translations':[{'id':s['id'],'text':'译文 '+s['text']} for s in r['segments']]}),flush=True)\n"
        with self.make_helper(body) as helper:
            for text in ["First {v1}", "Second"]:
                self.assertEqual(helper.translate_batch([{"id": "p0", "text": text}]),
                                 [{"id": "p0", "text": "译文 " + text}])

    def test_fixed_helper_error_detail_remains_diagnostic_without_source_text(self):
        body = "for line in sys.stdin:\n r=json.loads(line); print(json.dumps({'id':r['id'],'error':'batch_invalid','errorDetail':'formula'}),flush=True)\n"
        with self.make_helper(body) as helper:
            with self.assertRaises(ProtocolFailure) as caught:
                helper.translate_batch([{"id": "p0", "text": "Source {v1}"}])
            self.assertEqual(str(caught.exception), "batch_invalid")
            self.assertEqual(getattr(caught.exception, "error_detail", None), "formula")

    def test_scientific_number_mismatch_is_a_content_error_not_a_formula_error(self):
        body = "for line in sys.stdin:\n r=json.loads(line); print(json.dumps({'id':r['id'],'error':'batch_invalid','errorDetail':'content'}),flush=True)\n"
        with self.make_helper(body) as helper:
            with self.assertRaises(ProtocolFailure) as caught:
                helper.translate_batch([{"id": "p0", "text": "20,000 variants {v1}"}])
            self.assertEqual(str(caught.exception), "batch_invalid")
            self.assertEqual(getattr(caught.exception, "error_detail", None), "content")

    def test_batch_error_and_timeout_are_terminal_without_native_retry(self):
        with self.make_helper("for line in sys.stdin:\n r=json.loads(line); print(json.dumps({'id':r['id'],'error':'gpt_unavailable'}),flush=True)\n") as helper:
            with self.assertRaisesRegex(ProtocolFailure, "gpt_unavailable"):
                helper.translate_batch([{"id": "p0", "text": "Text"}])
            self.assertIsNone(helper.process)

    def test_stalled_stdin_cannot_block_a_large_batch_past_deadline(self):
        with self.make_helper("time.sleep(3)\n") as helper:
            helper.batch_timeout = .05
            started = time.monotonic()
            with self.assertRaisesRegex(ProtocolFailure, "translation_timeout"):
                helper.translate_batch([{"id": "p0", "text": "😀" * 60000}])
            self.assertLess(time.monotonic() - started, 2)
        with self.make_helper("for line in sys.stdin: time.sleep(10)\n") as helper:
            helper.batch_timeout = .1
            with self.assertRaisesRegex(ProtocolFailure, "translation_timeout"):
                helper.translate_batch([{"id": "p0", "text": "Text"}])
            self.assertIsNone(helper.process)


if __name__ == "__main__": unittest.main()
