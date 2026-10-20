"""Word relations select IDs; all geometry remains from the immutable PDFs."""
import copy
from pathlib import Path
import sys
import tempfile
import hashlib
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import phrase_alignment as phrase
from layout_common import ProtocolFailure


def glyphs(text,y=10):
    return [{"text":char,"rect":[i*10,y,i*10+8,y+10],"line":0} for i,char in enumerate(text)]


def unit(source="Genome sequencing improves accuracy.",target="测序提高基因组准确性。"):
    return phrase.prepare_unit("p0_0_s0",{"text":source,"glyphs":glyphs(source)},
        {"text":target,"glyphs":glyphs(target,30)})


class PhraseAlignmentTests(unittest.TestCase):
    def request(self,row):return phrase.request_unit(row)

    def test_tokens_are_complete_english_words_and_exact_chinese_characters(self):
        row=unit("Long-read DNA's 3.14-kb reads.","长读长DNA的3.14千碱基读段。")
        self.assertEqual([x["text"] for x in row["source"]],["Long-read","DNA's","3.14-kb","reads","."])
        self.assertEqual([x["text"] for x in row["target"]],["长","读","长","DNA","的","3.14","千","碱","基","读","段","。"])
        for side in ("source","target"):
            for token in row[side]:
                self.assertEqual(token["text"],"".join(g["text"] for g in token["glyphs"]))

    def test_zero_width_long_read_and_full_length_keep_original_word_glyphs_and_offsets(self):
        source="Long-\u200bread and full-\u200blength RNA.";target="长读长和全长转录本。"
        raw=glyphs(source);row=phrase.prepare_unit("p0_0_s0",{"text":source,"glyphs":raw},
            {"text":target,"glyphs":glyphs(target,30)})
        self.assertEqual([t["text"] for t in row["source"]],["Long-\u200bread","and","full-\u200blength","RNA","."])
        self.assertEqual(row["sourceText"],source);self.assertEqual(row["sourceGlyphs"],raw)
        first,full=row["source"][0],row["source"][2];offset=source.index("full")
        self.assertEqual((first["start"],first["end"]),(0,len("Long-\u200bread")))
        self.assertEqual(first["glyphs"],raw[:first["end"]])
        self.assertEqual((full["start"],full["end"]),(offset,offset+len("full-\u200blength")))
        self.assertEqual(full["glyphs"],raw[full["start"]:full["end"]])
        self.assertEqual(full["glyphs"][0]["rect"],raw[offset]["rect"])
        request=[self.request(row)];phrase.validate_phrase_request(request)
        for side in ("source","target"):
            self.assertTrue(all(phrase._normal(t["text"]) for t in request[0][side]))
            self.assertEqual(phrase._normal("".join(t["text"] for t in request[0][side])),phrase._normal(row[side+"Text"]))

    def test_isolated_zero_width_soft_hyphen_and_bom_never_become_empty_visible_tokens(self):
        source="\u200bAlpha \u00ad \ufeffBeta\u200b";target="\ufeff甲 \u200b乙 \u00ad"
        row=unit(source,target)
        self.assertEqual([t["text"] for t in row["source"]],["Alpha","Beta"])
        self.assertEqual([t["text"] for t in row["target"]],["甲","乙"])
        self.assertEqual(row["sourceGlyphs"],glyphs(source));self.assertEqual(row["targetGlyphs"],glyphs(target,30))
        self.assertEqual(row["source"][1]["start"],source.index("Beta"))
        for side in ("source","target"):
            self.assertTrue(all(phrase._normal(t["text"]) for t in row[side]))
            self.assertEqual(phrase._normal("".join(t["text"] for t in row[side])),phrase._normal(row[side+"Text"]))
        self.assertIsNone(unit("\u200b\u00ad\ufeff","甲"))

    def test_format_character_rule_is_shared_by_both_languages_and_different_visible_words(self):
        for english in ("nano\u200bpore sequencing","trans\u00adcription factors","protein\ufeff-binding"):
            for source,target in ((english,"转录\u200b调控"),("转录\u200b调控",english)):
                with self.subTest(source=source,target=target):
                    row=unit(source,target);phrase.validate_phrase_request([self.request(row)])
                    for side,original,y in (("source",source,10),("target",target,30)):
                        raw=glyphs(original,y)
                        self.assertEqual(row[side+"Text"],original);self.assertEqual(row[side+"Glyphs"],raw)
                        self.assertEqual(phrase._normal("".join(t["text"] for t in row[side])),phrase._normal(original))
                        for token in row[side]:
                            self.assertTrue(phrase._normal(token["text"]))
                            self.assertEqual(token["text"],original[token["start"]:token["end"]])
                            self.assertEqual(token["glyphs"],raw[token["start"]:token["end"]])

    def test_reordered_semantic_groups_use_only_actual_glyphs(self):
        row=unit();request=[self.request(row)];s=row["source"];t=row["target"]
        matches={row["id"]:[{"sourceIDs":[s[0]["id"]],"targetIDs":[x["id"] for x in t[4:7]]},
            {"sourceIDs":[s[1]["id"]],"targetIDs":[x["id"] for x in t[0:2]]}]}
        phrase.validate_phrase_matches(matches,request)
        records=phrase.materialize_unit(row,matches[row["id"]],[1,0,0,1,0,0],[1,0,0,1,400,0])
        self.assertEqual(records[0]["source"]["text"],"Genome")
        self.assertEqual(records[0]["target"]["text"],"基因组")
        self.assertEqual(records[1]["source"]["text"],"sequencing")
        self.assertEqual(records[1]["target"]["text"],"测序")
        self.assertEqual(records[0]["source"]["glyphs"],s[0]["glyphs"])
        self.assertEqual(records[0]["target"]["glyphs"],[g for x in t[4:7] for g in x["glyphs"]])
        self.assertLess(records[1]["source"]["rects"][0][2],len(row["sourceText"])*10)
        self.assertEqual(records[0]["sourceTokenCount"],1)
        self.assertEqual(records[0]["dualTarget"]["rects"][0][0],440)

    def test_missing_ambiguous_tokens_stay_unmapped_and_never_become_sentence(self):
        row=unit();self.assertEqual(phrase.validate_phrase_matches({row["id"]:[]},[self.request(row)]),{row["id"]:[]})
        self.assertEqual(phrase.materialize_unit(row,[],[1,0,0,1,0,0],[1,0,0,1,400,0]),[])

    def test_cross_unit_duplicate_noncontiguous_and_broad_sentence_groups_are_rejected(self):
        row=unit();request=[self.request(row)];s=row["source"];t=row["target"]
        good={"sourceIDs":[s[0]["id"]],"targetIDs":[t[4]["id"],t[5]["id"],t[6]["id"]]}
        invalid=[{}, {row["id"]:[{**good,"sourceIDs":["other_w0"]}]},
            {row["id"]:[good,good]}, {row["id"]:[{**good,"targetIDs":[t[4]["id"],t[6]["id"]]}]},
            {row["id"]:[{**good,"targetIDs":[t[6]["id"],t[5]["id"],t[4]["id"]]}]}]
        for value in invalid:
            with self.subTest(value=value),self.assertRaises(ProtocolFailure):phrase.validate_phrase_matches(value,request)
        broad=unit("This is a complete sentence with many words.")
        with self.assertRaises(ProtocolFailure):phrase.validate_phrase_matches({broad["id"]:[{
            "sourceIDs":[x["id"] for x in broad["source"]],"targetIDs":[x["id"] for x in broad["target"]]}]},[self.request(broad)])

    def test_five_to_sixteen_chinese_tokens_can_match_bounded_english_words_in_either_direction(self):
        for size in (5,8,16):
            for source,target in (("transcript","甲"*size),("甲"*size,"full length transcript")):
                row=unit(source,target);value={row["id"]:[{side+"IDs":[t["id"] for t in row[side]] for side in ("source","target")}]}
                with self.subTest(size=size,source=source):self.assertEqual(phrase.validate_phrase_matches(value,[self.request(row)]),value)

    def test_ascii_english_word_limit_and_sixteen_token_limit_remain_strict_in_both_directions(self):
        for a,b in (("one two three four five","甲乙丙丁戊"),("transcript","甲"*17)):
            for source,target in ((a,b),(b,a)):
                row=unit(source,target);value={row["id"]:[{side+"IDs":[t["id"] for t in row[side]] for side in ("source","target")}]}
                with self.subTest(source=source),self.assertRaises(ProtocolFailure):phrase.validate_phrase_matches(value,[self.request(row)])

    def test_non_ascii_letters_follow_the_swift_ascii_word_count_contract_in_both_directions(self):
        for source,target in (("α β γ δ ε","甲乙丙丁戊"),("甲乙丙丁戊","α β γ δ ε")):
            row=unit(source,target);value={row["id"]:[{side+"IDs":[t["id"] for t in row[side]] for side in ("source","target")}]}
            with self.subTest(source=source):self.assertEqual(phrase.validate_phrase_matches(value,[self.request(row)]),value)

    def test_identity_requires_exact_token_glyph_and_same_physical_position(self):
        row=unit("Read DNA.","Read DNA.");row["targetGlyphs"]=copy.deepcopy(row["sourceGlyphs"])
        row=phrase.prepare_unit(row["id"],{"text":row["sourceText"],"glyphs":row["sourceGlyphs"]},
            {"text":row["targetText"],"glyphs":row["targetGlyphs"]})
        result=phrase.identity_groups(row)
        self.assertEqual(len(result),3)
        changed=copy.deepcopy(row);changed["target"][0]["glyphs"][0]["rect"][0]+=.1
        self.assertEqual(phrase.identity_groups(changed),[])
        changed=unit("Read DNA.","READ DNA.");self.assertEqual(phrase.identity_groups(changed),[])

    def test_ligature_multiple_scalars_keep_one_actual_glyph_box(self):
        left={"text":"office","glyphs":[{"text":"o","rect":[0,0,5,10],"line":0},
            {"text":"ffi","rect":[5,0,15,10],"line":0},{"text":"c","rect":[15,0,20,10],"line":0},
            {"text":"e","rect":[20,0,25,10],"line":0}]}
        row=phrase.prepare_unit("p0_0_s0",left,{"text":"办公室","glyphs":glyphs("办公室")})
        self.assertEqual(row["source"][0]["glyphs"],left["glyphs"])
        self.assertEqual(row["source"][0]["text"],"office")

    def real_fixture(self):
        import pymupdf
        import sentence_alignment as sentence
        import alignment
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        folder=Path(temporary.name);source=folder/"source.pdf";target=folder/"mono.pdf"
        for path,text,font in ((source,"Genome sequencing improves accuracy.","helv"),(target,"测序提高基因组准确性。","china-s")):
            with pymupdf.open() as document:
                page=document.new_page(width=400,height=250)
                page.insert_text((20,45),text,fontsize=11,fontname=font);document.save(path)
        with pymupdf.open(source) as a,pymupdf.open(target) as b:
            def side(page):
                rect=pymupdf.Rect(page.get_text("blocks")[0][:4])*~page.transformation_matrix
                return {"text":page.get_text().strip(),"rects":[list(rect)]}
            left,right=side(a[0]),side(b[0])
            page={"sourcePage":0,"outputPage":0,"source":alignment._geometry(a[0]),"mono":alignment._geometry(b[0]),
                "dual":{"mediaBox":[0,0,800,250],"cropBox":[0,0,800,250],"rotation":0},
                "sourceToDual":[1,0,0,1,0,0],"targetToDual":[1,0,0,1,400,0],"paragraphs":[
                    {"id":"p0_0","source":left,"target":right,"dualSource":{"rects":left["rects"]},
                    "dualTarget":{"rects":[[r[0]+400,r[1],r[2]+400,r[3]] for r in right["rects"]]}}]}
            prepared=sentence.prepare_page(page,a[0],b[0])
            page=sentence.upgrade_page(page,prepared,{"p0_0_s0":["p0_0_t0"]})
            prepared=phrase.prepare_phrase_page(page,a[0],b[0])
        return page,prepared,hashlib.sha256(source.read_bytes()).hexdigest()

    def test_real_pdf_chinese_char_to_english_word_and_dual_are_true_glyphs(self):
        import alignment
        page,prepared,sha=self.real_fixture();self.assertEqual(len(prepared),1)
        row=prepared[0];source=row["source"];target=row["target"]
        matches={row["id"]:[{"sourceIDs":[source[0]["id"]],"targetIDs":[x["id"] for x in target[4:7]]},
            {"sourceIDs":[source[1]["id"]],"targetIDs":[x["id"] for x in target[:2]]}]}
        value={"schema":1,"coordinateSpace":"pdf","granularity":"sentence","provenance":"babeldoc-ir",
            "sourcePages":[0],"pageCount":1,"sourceSHA256":sha,"sentenceAlignmentRevision":"pdf-sentence-semantic-v1",
            "sentencePages":[0],"phraseAlignmentRevision":phrase.PHRASE_REVISION,"phrasePages":[0],
            "pages":[phrase.upgrade_phrase_page(page,prepared,matches)]}
        alignment.validate_alignment(value,[0],1,sha)
        mapped=value["pages"][0]["paragraphs"][0]["sentences"][0]["phrases"]
        self.assertEqual([(x["source"]["text"],x["target"]["text"]) for x in mapped],[("Genome","基因组"),("sequencing","测序")])
        self.assertEqual(mapped[0]["source"]["glyphs"],source[0]["glyphs"])
        self.assertEqual(mapped[0]["target"]["glyphs"],[g for t in target[4:7] for g in t["glyphs"]])
        for mutation in ("rogueGlyph","bigBox","duplicate","dual","revision","skipGlyph","line"):
            changed=copy.deepcopy(value);unit=changed["pages"][0]["paragraphs"][0]["sentences"][0]["phrases"][0]
            if mutation=="rogueGlyph":unit["target"]["glyphs"][0]["rect"][0]+=.1
            elif mutation=="bigBox":unit["source"]["rects"][0][2]+=20
            elif mutation=="duplicate":changed["pages"][0]["paragraphs"][0]["sentences"][0]["phrases"].append(copy.deepcopy(unit))
            elif mutation=="dual":unit["dualTarget"]["rects"][0][0]+=5
            elif mutation=="skipGlyph":unit["target"]["glyphs"].pop(1);unit["target"]["text"]="基组"
            elif mutation=="line":unit["target"]["glyphs"][0]["line"]+=1
            else:changed.pop("phraseAlignmentRevision")
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):alignment.validate_alignment(changed,[0],1,sha)
        subset=alignment.subset_alignment(value,[0]);self.assertEqual(subset["phrasePages"],[0])

    def test_new_extraction_refuses_old_sentence_with_mismatched_text(self):
        import pymupdf
        page,prepared,_=self.real_fixture()
        self.assertTrue(prepared[0]["sourceGlyphs"])
        # A legacy sidecar's unrelated text cannot gain a guessed word map.
        sentence=page["paragraphs"][0]["sentences"][0]
        changed=phrase.prepare_unit(sentence["id"],{"text":"unrelated","glyphs":prepared[0]["sourceGlyphs"]},sentence["target"])
        self.assertIsNone(changed)

    def test_disjoint_real_runs_never_cover_intervening_unmatched_words(self):
        from sentence_alignment import extract_sentences
        chars=[{"text":c,"rect":[i*10,0,i*10+8,10]} for i,c in enumerate("Gene unrelated binds")]
        side={"text":"Gene binds","rects":[[0,0,38,10],[150,0,198,10]]}
        parts=extract_sentences([chars],side,"p0_0","s")
        self.assertEqual(len(parts),1)
        row=phrase.prepare_unit("p0_0_s0",parts[0],{"text":"基因结合","glyphs":glyphs("基因结合")})
        self.assertIsNotNone(row)
        matches=[{"sourceIDs":[t["id"] for t in row["source"]],"targetIDs":[t["id"] for t in row["target"]]}]
        phrase.validate_phrase_matches({row["id"]:matches},[self.request(row)])
        record=phrase.materialize_unit(row,matches,[1,0,0,1,0,0],[1,0,0,1,400,0])[0]
        self.assertEqual(record["source"]["rects"],[[0,0,38,10],[150,0,198,10]])

    def test_oversized_unit_is_not_silently_persisted_as_semantic_refusal(self):
        row=unit("Gene.","基"*(phrase.MAX_PHRASE_TOKENS+1))
        with self.assertRaises(ProtocolFailure):phrase.phrase_requests([row])

    def test_origin_at_next_sentence_boundary_does_not_capture_the_next_cjk_glyph(self):
        from sentence_alignment import extract_sentences
        chars=[{"text":c,"rect":[i*10,0,(i+1)*10,10],"origin":[i*10,2]} for i,c in enumerate("甲。乙。")]
        first={"text":"甲。","rects":[[0,0,20,10]]}
        self.assertEqual(extract_sentences([chars],first,"p0_0","t")[0]["text"],"甲。")
        second={"text":"乙。","rects":[[20,0,40,10]]}
        self.assertEqual(extract_sentences([chars],second,"p0_0","t")[0]["text"],"乙。")

    def test_real_adjacent_chinese_sentences_reextract_as_two_complete_glyph_units(self):
        import pymupdf
        import sentence_alignment as sentence
        with pymupdf.open() as doc:
            page=doc.new_page(width=400,height=250)
            page.insert_text((20,45),"甲。乙。",fontsize=11,fontname="china-s")
            rows=sentence.page_glyphs(page)
            rects=[g["rect"] for row in rows for g in row]
            side={"text":"甲。乙。","rects":[[min(r[0] for r in rects),min(r[1] for r in rects),max(r[2] for r in rects),max(r[3] for r in rects)]]}
            parts=sentence.extract_sentences(rows,side,"p0_0","s")
            self.assertEqual([p["text"] for p in parts],["甲。","乙。"])
            for part in parts:
                again=sentence.extract_sentences(rows,part,part["id"],"t")
                self.assertEqual(len(again),1)
                self.assertEqual(again[0]["text"],part["text"])

    def test_rounded_adjacent_punctuation_bbox_does_not_capture_preceding_sentence_stop(self):
        from sentence_alignment import _inside
        self.assertFalse(_inside([10,0,20.000003,10],[[20,0,30,10]],[10,2],"。"))
        self.assertTrue(_inside([10,0,20,10],[[16,3,17,4]],[10,2],"."))

    def test_verified_glyph_links_reuse_without_resending_or_changing_existing_words(self):
        page,prepared,_=self.real_fixture();row=prepared[0]
        matches={row["id"]:[{"sourceIDs":[row["source"][0]["id"]],"targetIDs":[t["id"] for t in row["target"][4:7]]}]}
        updated=phrase.upgrade_phrase_page(page,prepared,matches)
        cached=copy.deepcopy(updated["paragraphs"][0]["sentences"][0])
        self.assertTrue(phrase.reusable_phrase_unit(cached,row))
        self.assertEqual(phrase.upgrade_phrase_page(updated,prepared,{},reuse_verified=True),updated)
        coverage=phrase.phrase_page_coverage(updated,prepared)
        self.assertEqual((coverage["sentences"],coverage["extractable"],coverage["aligned"],coverage["unavailable"]),(1,1,1,0))
        self.assertEqual(coverage["mappedSourceTokens"],1);self.assertEqual(coverage["mappedTargetTokens"],3)
        changed=copy.deepcopy(row);changed["targetGlyphs"][0]["rect"][0]+=.01
        self.assertFalse(phrase.reusable_phrase_unit(cached,changed))

    def test_request_bounds_and_shape_are_strict(self):
        request=[self.request(unit())];phrase.validate_phrase_request(request)
        for mutate in (lambda x:x[0].update(extra=True),lambda x:x[0]["source"][0].update(rect=[0,0,1,1]),
                lambda x:x[0]["target"][0].update(id=x[0]["source"][0]["id"]),
                lambda x:x[0]["source"][0].update(text="\ud800")):
            changed=copy.deepcopy(request);mutate(changed)
            with self.assertRaises(ProtocolFailure):phrase.validate_phrase_request(changed)

    def test_small_batches_keep_complete_units_and_respect_the_hard_single_unit_bound(self):
        prepared=[]
        for i in range(9):
            item=unit("Gene sequencing. "*8,"基因测序。"*8);item["id"]=f"p0_{i}_s0"
            # Rebuild IDs with the actual unit identity.
            prepared.append(phrase.prepare_unit(item["id"],{"text":item["sourceText"],"glyphs":item["sourceGlyphs"]},
                {"text":item["targetText"],"glyphs":item["targetGlyphs"]}))
        batches=phrase.phrase_requests(prepared)
        self.assertGreater(len(batches),1)
        self.assertEqual([u["id"] for batch in batches for u in batch],[u["id"] for u in prepared])
        self.assertTrue(all(sum(len(u[side]) for u in batch for side in ("source","target"))<=phrase.TARGET_PHRASE_BATCH_TOKENS for batch in batches))

    def test_semantic_batches_have_at_most_two_units_even_when_the_units_are_short(self):
        rows=[phrase.prepare_unit(f"p0_{i}_s0",{"text":"Gene.","glyphs":glyphs("Gene.")},
            {"text":"基因。","glyphs":glyphs("基因。")}) for i in range(5)]
        batches=phrase.phrase_requests(rows)
        self.assertEqual([len(batch) for batch in batches],[2,2,1])
        self.assertEqual([u["id"] for batch in batches for u in batch],[u["id"] for u in rows])

    def test_soft_128_token_bound_preserves_an_indivisible_long_unit(self):
        rows=[]
        for i,repeats in enumerate((14,14,30)):
            a,b="Gene. "*repeats,"基因。"*repeats
            rows.append(phrase.prepare_unit(f"p0_{i}_s0",{"text":a,"glyphs":glyphs(a)},
                {"text":b,"glyphs":glyphs(b)}))
        batches=phrase.phrase_requests(rows)
        self.assertEqual([len(batch) for batch in batches],[1,1,1])
        sizes=[sum(len(u[side]) for u in batch for side in ("source","target")) for batch in batches]
        self.assertEqual(sizes,[70,70,150])
        self.assertEqual([u["id"] for batch in batches for u in batch],[u["id"] for u in rows])

    def test_verified_empty_word_response_reuses_exact_glyphs_without_becoming_guessed_links(self):
        page,prepared,_=self.real_fixture();row=prepared[0]
        updated=phrase.upgrade_phrase_page(page,prepared,{row["id"]:[]},preserve_unprepared=True)
        cached=updated["paragraphs"][0]["sentences"][0]
        self.assertEqual(cached["phrases"],[])
        self.assertTrue(phrase.reusable_phrase_unit(cached,row))
        self.assertEqual(phrase.upgrade_phrase_page(updated,prepared,{},reuse_verified=True),updated)
        changed=copy.deepcopy(row);changed["targetGlyphs"][0]["rect"][0]+=.01
        self.assertFalse(phrase.reusable_phrase_unit(cached,changed))


if __name__=="__main__":unittest.main()
