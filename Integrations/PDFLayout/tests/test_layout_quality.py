import copy
import importlib
from pathlib import Path
from types import SimpleNamespace as NS
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try: quality = importlib.import_module('layout_quality')
except ModuleNotFoundError: quality = None


def box(x, y, x2, y2): return NS(x=x, y=y, x2=x2, y2=y2)
def glyph(text, x=0, y=100, size=8.5, font='source', visual=None):
    return NS(char_unicode=text, box=box(x, y, x+len(text)*size*.55, y+size),
              visual_bbox=NS(box=visual) if visual else None,
              pdf_style=NS(font_id=font, font_size=size), vertical=False, xobj_id=-1,
              advance=len(text)*size*.55)
def composition(char): return NS(pdf_character=char, pdf_line=None, pdf_same_style_characters=None,
                                 pdf_formula=None, pdf_same_style_unicode_characters=None)
def paragraph(text, x=0, y=100, label='fallback_line', size=8.5, font='source'):
    g=glyph(text,x,y,size,font)
    return NS(unicode=text,box=box(x,y,x+len(text)*size*.55,y+size),
              pdf_paragraph_composition=[composition(g)],layout_label=label,
              pdf_style=g.pdf_style,vertical=False,xobj_id=-1)
def page(paragraphs, number=0):
    return NS(pdf_paragraph=paragraphs,page_number=number,pdf_character=[],pdf_font=[],
              cropbox=NS(box=box(0,0,600,800)))

class LayoutQualityTests(unittest.TestCase):
    def setUp(self): self.assertIsNotNone(quality, 'layout quality module missing')

    def prose_fixture(self, scales=(1., .98, .95)):
        text='The same body style continues with enough source text to establish a repeated document typography cohort.'
        ps=[paragraph(text,30,600-i*100,label='plain text',size=9.2,font='body') for i in range(len(scales))]
        pg=page(ps);pg.pdf_font=[NS(font_id='body',name='AAAAAA+MinionPro-Regular',bold=False,italic=False)]
        quality.protect_source_page(pg)
        for p,scale in zip(ps,scales):p.optimal_scale=scale
        return pg,ps

    def test_same_source_prose_style_uses_one_fitting_scale(self):
        pg,ps=self.prose_fixture()
        before=[copy.deepcopy(p.box) for p in ps]
        stats=quality.harmonize_typeset_scales(NS(page=[pg]))
        self.assertEqual([p.optimal_scale for p in ps[:3]],[.95,.95,.95])
        self.assertEqual(stats['uniformProseGroups'],1)
        self.assertEqual(stats['uniformProseParagraphs'],2)
        self.assertEqual([p.box for p in ps],before,'scale preflight must not move source geometry')
        quality.repair_typeset_page(pg)

    def test_harmonization_keeps_hierarchy_protected_text_and_formula_sizes(self):
        pg,ps=self.prose_fixture()
        title=paragraph('A deliberately larger paper title',30,730,label='title',size=24,font='body')
        caption=paragraph('A figure caption with its own smaller typography '+('details '*15),30,250,label='figure_caption',size=8.5,font='body')
        footer=paragraph('https://doi.org/10.1038/s41576-020-0236-x',30,40,size=6,font='body')
        ps[0].pdf_paragraph_composition.append(NS(pdf_character=None,pdf_line=None,pdf_same_style_characters=None,
            pdf_formula=NS(pdf_character=[glyph('1',80,603,size=5.36,font='body')])))
        pg.pdf_paragraph.extend([title,caption,footer]);quality.protect_source_page(pg)
        for p,scale in zip(ps,[1.,.95,.9]):p.optimal_scale=scale
        for p in [title,caption,footer]:p.optimal_scale=.95
        source_scripts=copy.deepcopy(ps[0].pdf_paragraph_composition[-1])
        quality.harmonize_typeset_scales(NS(page=[pg]))
        self.assertEqual([p.optimal_scale for p in ps[:3]],[.95,.95,.9])
        self.assertEqual([p.optimal_scale for p in [title,caption,footer]],[.95,.95,.95])
        self.assertEqual(ps[0].pdf_paragraph_composition[-1],source_scripts)
        quality.repair_typeset_page(pg)

    def test_subset_font_prefixes_match_across_pages_but_different_faces_do_not(self):
        a,pa=self.prose_fixture((1.,.95))
        b,pb=self.prose_fixture((.95,.95))
        b.pdf_font[0].name='BBBBBB+MinionPro-Regular'
        quality.protect_source_page(b)
        for p in pb:p.optimal_scale=.95
        other,po=self.prose_fixture((1.,1.))
        other.pdf_font[0].name='CCCCCC+MyriadPro-Regular';quality.protect_source_page(other)
        for p in po:p.optimal_scale=1.
        quality.harmonize_typeset_scales(NS(page=[a,b,other]))
        self.assertEqual([p.optimal_scale for p in pa+pb],[.95]*4)
        self.assertEqual([p.optimal_scale for p in po],[1.,1.])
        for pg in [a,b,other]:quality.repair_typeset_page(pg)

    def test_severely_constrained_prose_does_not_make_whole_document_tiny(self):
        pg,ps=self.prose_fixture((1.,.95,.5))
        stats=quality.harmonize_typeset_scales(NS(page=[pg]))
        self.assertEqual([p.optimal_scale for p in ps],[.95,.95,.5])
        self.assertEqual(stats['skippedSmallScaleParagraphs'],1)
        quality.repair_typeset_page(pg)

    def test_prose_expansion_uses_only_empty_space_and_keeps_width_top_and_neighbors(self):
        pg,ps=self.prose_fixture((1.,1.))
        body=ps[0];neighbor=ps[1]
        neighbor.box.y=575;neighbor.box.y2=584
        # The captured source obstacle is conservative, even if target boxes
        # later change during another paragraph's preflight.
        neighbor.pdf_paragraph_composition=[composition(glyph('Following text',30,575,9.2,'body'))]
        quality.protect_source_page(pg)
        original=copy.deepcopy(body.box);other=copy.deepcopy(neighbor.box)
        expanded=quality.prose_expansion_box(pg,body)
        self.assertIsNotNone(expanded)
        self.assertEqual((expanded.x,expanded.x2,expanded.y2),(original.x,original.x2,original.y2))
        self.assertGreaterEqual(expanded.y,584.2+9.2*.4)
        self.assertGreaterEqual(expanded.y,original.y-9.2*1.8)
        self.assertEqual(body.box,original)
        self.assertEqual(neighbor.box,other)
        quality.repair_typeset_page(pg)

    def test_prose_expansion_stops_before_figure_table_rule_and_unparsed_glyph(self):
        for kind in ('pdf_figure','pdf_curve','pdf_character','page_layout'):
            pg,ps=self.prose_fixture((1.,1.));body=ps[0]
            obstacle=NS(box=box(25,580,200,590),class_name='table')
            setattr(pg,kind,[obstacle])
            expanded=quality.prose_expansion_box(pg,body)
            self.assertIsNotNone(expanded)
            self.assertGreaterEqual(expanded.y,590+9.2*.4)
            obstacle.box.y2=599
            self.assertIsNone(quality.prose_expansion_box(pg,body))
            quality.repair_typeset_page(pg)

    def test_typography_never_joins_distinct_source_sizes_or_vertical_text(self):
        pg,ps=self.prose_fixture((1.,.9,.95))
        ps[1].pdf_paragraph_composition[0].pdf_character.pdf_style.font_size=8.5
        ps[2].vertical=True
        quality.protect_source_page(pg)
        quality.harmonize_typeset_scales(NS(page=[pg]))
        self.assertEqual([p.optimal_scale for p in ps],[1.,.9,.95])
        self.assertIsNone(quality.prose_expansion_box(pg,ps[2]))
        quality.repair_typeset_page(pg)

    def test_nearby_caption_size_and_six_point_references_do_not_get_shrunk(self):
        pg,ps=self.prose_fixture((1.,.95))
        cap=paragraph('A caption with an intentionally close font size',30,250,label='figure_caption',size=9.0,font='body')
        pg.pdf_paragraph.append(cap);quality.protect_source_page(pg)
        quality.harmonize_typeset_scales(NS(page=[pg]))
        self.assertEqual([p.optimal_scale for p in ps[:2]],[1.,.95])
        quality.repair_typeset_page(pg)
        pg,ps=self.prose_fixture((1.,.95))
        for p in ps:
            p.pdf_paragraph_composition[0].pdf_character.pdf_style.font_size=6.
        quality.protect_source_page(pg)
        quality.harmonize_typeset_scales(NS(page=[pg]))
        self.assertEqual([p.optimal_scale for p in ps],[1.,.95])
        quality.repair_typeset_page(pg)

    def test_author_names_keep_original_glyphs_and_footnotes(self):
        p=paragraph('Glennis A. Logsdon 1, Mitchell R. Vollger 1 and Evan E. Eichler 1,2',x=150,y=575,label='plain text')
        pg=page([p]);before=copy.deepcopy(p.pdf_paragraph_composition)
        protected=quality.protect_source_page(pg)
        self.assertIn(id(p),protected)
        self.assertEqual(p.pdf_paragraph_composition,before)
        self.assertEqual(quality.repair_typeset_page(pg)['fittedTableLines'],0)

    def test_body_sentence_with_names_is_not_metadata(self):
        p=paragraph('Glennis A. Logsdon and Mitchell R. Vollger developed an assay that improves the results.',x=150,y=575,label='plain text')
        self.assertNotIn(id(p),quality.protect_source_page(page([p])))

    def test_pure_doi_email_preserved_but_body_mention_translates(self):
        p=paragraph('https://doi.org/10.1038/s41576-020-0236-x',y=500)
        email=paragraph('e-mail: eee@gs.washington.edu',y=490)
        body=paragraph('Our results were deposited and can be accessed at https://doi.org/10.1234/example.',y=200,label='plain text')
        protected=quality.protect_source_page(page([p,email,body]))
        self.assertEqual(protected,{id(p),id(email)})

    def test_caption_word_tail_is_rejoined_without_discarding_source_glyph(self):
        p=paragraph('length and platform',x=100,y=300,label='table_caption')
        end=p.pdf_paragraph_composition[0].pdf_character.box.x2
        tail=paragraph('s',x=end,y=300)
        pg=page([p,tail]);g=tail.pdf_paragraph_composition[0].pdf_character
        quality.protect_source_page(pg)
        self.assertEqual(p.unicode,'length and platforms')
        self.assertEqual(pg.pdf_paragraph,[p])
        self.assertIs(p.pdf_paragraph_composition[-1].pdf_character,g)

    def test_caption_superscript_does_not_join_word(self):
        p=paragraph('A table result',x=100,y=300,label='table_caption')
        tail=paragraph('s',x=p.box.x2,y=303,size=5)
        pg=page([p,tail]);quality.protect_source_page(pg)
        self.assertEqual(pg.pdf_paragraph,[p,tail])

    def test_separate_panel_letter_not_deleted(self):
        caption=paragraph('A figure result',x=100,y=300,label='figure_caption')
        tail=paragraph('s',x=caption.box.x2+7,y=300)
        pg=page([caption,tail]);quality.protect_source_page(pg)
        self.assertEqual(pg.pdf_paragraph,[caption,tail])

    def test_bold_multiline_table_header_is_one_translation_cell(self):
        cap=paragraph('Table 1: Accuracy',x=40,y=330,label='table_caption')
        a=paragraph('Read',310,310);b=paragraph('accuracy',310,301);c=paragraph('(%)',310,292)
        pg=page([cap,a,b,c]);pg.pdf_font=[NS(font_id='source',bold=True)]
        quality.protect_source_page(pg)
        self.assertEqual([p.unicode for p in pg.pdf_paragraph],['Table 1: Accuracy','Read accuracy (%)'])
        self.assertEqual(len(a.pdf_paragraph_composition),3)

    def test_horizontal_rule_keeps_subheaders_separate(self):
        cap=paragraph('Table 1: Accuracy',40,330,label='table_caption')
        a=paragraph('Flow cell',310,310);b=paragraph('Mean',310,298)
        pg=page([cap,a,b]);pg.pdf_font=[NS(font_id='source',bold=True)]
        pg.pdf_curve=[NS(box=box(308,307,355,307))]
        quality.protect_source_page(pg)
        self.assertEqual([p.unicode for p in pg.pdf_paragraph],['Table 1: Accuracy','Flow cell','Mean'])

    def test_nonbold_data_rows_and_other_columns_never_merge(self):
        cap=paragraph('Table 1: Values',40,330,label='table_caption')
        a=paragraph('Cell A',310,310);b=paragraph('Cell B',310,300);c=paragraph('Cell C',355,300)
        pg=page([cap,a,b,c]);pg.pdf_font=[NS(font_id='source',bold=False)]
        quality.protect_source_page(pg)
        self.assertEqual(len(pg.pdf_paragraph),4)
        pg.pdf_font=[NS(font_id='source',bold=True)];pg.pdf_paragraph=[cap,a,c]
        quality.protect_source_page(pg)
        self.assertEqual(len(pg.pdf_paragraph),3)

    def test_bold_data_labels_never_merge_into_one_cell(self):
        cap=paragraph('Table 1: Treatment results',40,330,label='table_caption')
        rows=[paragraph('Control',310,310),paragraph('Treated',310,300),paragraph('Recovered',310,290)]
        pg=page([cap]+rows);pg.pdf_font=[NS(font_id='source',bold=True)]
        quality.protect_source_page(pg)
        self.assertEqual([p.unicode for p in pg.pdf_paragraph],['Table 1: Treatment results','Control','Treated','Recovered'])

    def test_header_words_below_first_regular_data_row_are_not_headers(self):
        cap=paragraph('Table 1: Results',40,330,label='table_caption')
        a=paragraph('Read',310,290);b=paragraph('accuracy',310,280)
        row=paragraph('Data item',40,300,font='regular')
        pg=page([cap,row,a,b]);pg.pdf_font=[NS(font_id='source',bold=True),NS(font_id='regular',bold=False)]
        quality.protect_source_page(pg)
        self.assertEqual([p.unicode for p in pg.pdf_paragraph],['Table 1: Results','Data item','Read','accuracy'])

    def test_all_bold_measurement_data_below_top_header_stay_separate(self):
        cap=paragraph('Table 1: Results',40,340,label='table_caption')
        heading=paragraph('Condition',310,320);a=paragraph('Read',310,300);b=paragraph('accuracy',310,290)
        pg=page([cap,heading,a,b]);pg.pdf_font=[NS(font_id='source',bold=True)]
        quality.protect_source_page(pg)
        self.assertEqual([p.unicode for p in pg.pdf_paragraph],['Table 1: Results','Condition','Read','accuracy'])

    def test_formula_groups_never_merge_as_table_header_lines(self):
        cap=paragraph('Table 1: Results',40,330,label='table_caption')
        a=paragraph('Read',310,310);b=paragraph('accuracy',310,300)
        b.pdf_paragraph_composition.append(NS(pdf_character=None,pdf_line=None,pdf_same_style_characters=None,pdf_formula=NS(pdf_character=[glyph('x²',340,300)])))
        pg=page([cap,a,b]);pg.pdf_font=[NS(font_id='source',bold=True)]
        quality.protect_source_page(pg)
        self.assertEqual(len(pg.pdf_paragraph),3)

    def table_fixture(self):
        cap=paragraph('Table 1: Read accuracy and cost',x=30,y=330,label='table_caption')
        top=paragraph('Read',x=310,y=309)
        middle=paragraph('accuracy',x=310,y=300)
        bottom=paragraph('(%)',x=310,y=291)
        pg=page([cap,top,middle,bottom]);quality.protect_source_page(pg)
        middle.unicode='准确度';middle.pdf_paragraph_composition=[composition(glyph(c,310+i*8.5,295,8.5,'mapped')) for i,c in enumerate('准确度')]
        fonts=NS(fontid2font={'mapped':NS(ascender=1.15,descender=-.286)})
        return pg,middle,fonts

    def test_table_glyph_metrics_fit_neighbor_row_slot(self):
        pg,p,fonts=self.table_fixture()
        result=quality.repair_typeset_page(pg,font_mapper=fonts)
        self.assertEqual(result['fittedTableLines'],1)
        chars=[x.pdf_character for x in p.pdf_paragraph_composition]
        low=min(c.box.y-.286*c.pdf_style.font_size for c in chars)
        high=max(c.box.y+1.15*c.pdf_style.font_size for c in chars)
        self.assertGreaterEqual(low,299.5)
        self.assertLessEqual(high,308.600001)
        self.assertEqual(''.join(c.char_unicode for c in chars),'准确度')
        self.assertGreater(min(c.pdf_style.font_size for c in chars),4.6)

    def test_target_font_bounds_do_not_overlap_retained_source_units(self):
        pg,p,fonts=self.table_fixture()
        pg.pdf_font=[NS(font_id='source',ascent=931.,descent=-230.)]
        # Recapture before substitution, as the real pipeline does.
        p.unicode='accuracy';p.pdf_paragraph_composition=[composition(glyph('accuracy',310,300))]
        quality.protect_source_page(pg)
        p.unicode='准确度';p.pdf_paragraph_composition=[composition(glyph(c,310+i*8.5,295,8.5,'mapped')) for i,c in enumerate('准确度')]
        quality.repair_typeset_page(pg,font_mapper=fonts)
        chars=[x.pdf_character for x in p.pdf_paragraph_composition]
        low=min(c.box.y-.286*c.pdf_style.font_size for c in chars)
        high=max(c.box.y+1.15*c.pdf_style.font_size for c in chars)
        retained_low_top=291+.931*8.5
        retained_high_bottom=309-.230*8.5
        self.assertGreaterEqual(low,retained_low_top+.14999)
        self.assertLessEqual(high,retained_high_bottom-.14999)

    def test_repair_is_idempotent_and_does_not_move_source_units(self):
        pg,p,fonts=self.table_fixture();units=copy.deepcopy(pg.pdf_paragraph[-1])
        quality.repair_typeset_page(pg,font_mapper=fonts)
        after=copy.deepcopy(p)
        self.assertEqual(quality.repair_typeset_page(pg,font_mapper=fonts)['fittedTableLines'],0)
        self.assertEqual(p,after)
        self.assertEqual(pg.pdf_paragraph[-1],units)

    def test_formula_compositions_are_never_scaled(self):
        pg,p,fonts=self.table_fixture()
        p.pdf_paragraph_composition.append(NS(pdf_character=None,pdf_line=None,pdf_same_style_characters=None,pdf_formula=NS(pdf_character=[glyph('x',310,295)])))
        before=copy.deepcopy(p)
        quality.repair_typeset_page(pg,font_mapper=fonts)
        self.assertEqual(p,before)

    def test_body_without_table_caption_not_reflowed(self):
        pg,p,fonts=self.table_fixture();pg.pdf_paragraph[0].layout_label='plain text'
        quality.protect_source_page(pg)
        before=copy.deepcopy(p);quality.repair_typeset_page(pg,font_mapper=fonts)
        self.assertEqual(p,before)

    def test_unknown_font_metrics_and_incomplete_test_objects_are_safe(self):
        pg,p,fonts=self.table_fixture();before=copy.deepcopy(p)
        self.assertEqual(quality.repair_typeset_page(pg)['fittedTableLines'],0)
        self.assertEqual(p,before)
        self.assertEqual(quality.protect_source_page(NS(pdf_paragraph=[NS(unicode='test')])) ,set())
        self.assertEqual(quality.repair_typeset_page(NS())['fittedTableLines'],0)

    def region(self, pg, kind, bounds, confidence=.95):
        pg.page_layout=[NS(class_name=kind,box=box(*bounds),conf=confidence)]
        return pg

    def table_policy_fixture(self):
        cap=paragraph('Table 1. Results',40,320,label='table_caption')
        heads=[paragraph('Group',45,293),paragraph('Mean',150,293),paragraph('SD',250,293)]
        data=[paragraph('Control',45,267),paragraph('12.4',150,267),paragraph('0.8',250,267),
              paragraph('Treated',45,247),paragraph('18.9',150,247),paragraph('1.2',250,247)]
        foot=paragraph('Values are means. See the text.',40,215,label='table_footnote')
        body=paragraph('The treatment increased the measured response.',40,180,label='plain text')
        pg=self.region(page([cap]+heads+data+[foot,body]),'table',(40,235,320,310))
        pg.pdf_curve=[NS(box=box(40,280,140,280)),NS(box=box(140,280,240,280)),NS(box=box(240,280,320,280))]
        return pg,heads,data,[cap,foot,body]

    def fragmented_grid(self):
        cap=paragraph('Table 1. Population results',40,340,label='table_caption')
        header=[paragraph('Population and',45,309),paragraph('consortium',45,300),paragraph('(if applicable)',45,291),
            paragraph('Number of',150,309),paragraph('individuals',155,300),
            paragraph('Total novel',250,309),paragraph('sequence',250,300),paragraph('reported',250,291)]
        cells=[paragraph('African ancestry,',45,267),paragraph('Research Consortium',45,258),
            paragraph('275',150,267),paragraph('29.5 Mb',250,267),
            paragraph('Control',45,237),paragraph('18.9',150,237),paragraph('1.2',250,237)]
        pg=self.region(page([cap]+header+cells),'table',(40,225,320,325))
        pg.pdf_curve=[NS(box=box(a,y,b,y)) for y in (280,250,225) for a,b in ((40,140),(140,240),(240,320))]
        pg.pdf_font=[NS(font_id='source',bold=False)]
        return pg,header,cells

    def test_structural_grid_merges_complete_header_cells_without_font_or_word_whitelist(self):
        pg,header,cells=self.fragmented_grid();original=[c for p in header for c in quality._characters(p)]
        quality.protect_source_page(pg)
        self.assertEqual([p.unicode for p in pg.pdf_paragraph if quality.is_table_header(pg,p)],
            ['Population and consortium (if applicable)','Number of individuals','Total novel sequence reported'])
        remaining=[c for p in pg.pdf_paragraph if quality.is_table_header(pg,p) for c in quality._characters(p)]
        self.assertEqual({id(c) for c in remaining},{id(c) for c in original})
        self.assertEqual(len(remaining),len(original))
        self.assertEqual(cells[2].unicode,'275');self.assertEqual(cells[3].unicode,'29.5 Mb')

    def test_first_column_complete_row_label_merges_but_other_data_columns_never_do(self):
        pg,headers,cells=self.fragmented_grid();before=copy.deepcopy(cells[2:])
        quality.protect_source_page(pg)
        self.assertEqual(cells[0].unicode,'African ancestry, Research Consortium')
        self.assertNotIn(cells[1],pg.pdf_paragraph)
        self.assertTrue(quality.is_table_row_label(pg,cells[0]))
        self.assertEqual(cells[2:],before)
        self.assertIn(cells[4],pg.pdf_paragraph)
        self.assertEqual(cells[4].unicode,'Control')

    def test_first_column_id_fragments_merge_for_whole_cell_protection(self):
        pg,headers,cells=self.fragmented_grid();cells[0].unicode='Sample';cells[1].unicode='HG002'
        protected=quality.protect_source_page(pg)
        self.assertEqual(cells[0].unicode,'Sample HG002')
        self.assertIn(id(cells[0]),protected);self.assertFalse(quality.is_table_row_label(pg,cells[0]))

    def test_full_width_rule_without_proven_column_edges_does_not_merge_generic_headers(self):
        pg,headers,cells=self.fragmented_grid()
        pg.pdf_curve=[NS(box=box(40,y,320,y)) for y in (280,250,225)]
        quality.protect_source_page(pg)
        self.assertEqual(headers[3].unicode,'Number of');self.assertIn(headers[4],pg.pdf_paragraph)
        self.assertEqual(cells[0].unicode,'African ancestry,');self.assertIn(cells[1],pg.pdf_paragraph)

    def test_header_crossing_column_edge_and_full_size_formula_are_not_fused(self):
        pg,headers,cells=self.fragmented_grid()
        headers[3].pdf_paragraph_composition[0].pdf_character.box.x2=245
        headers[3].box.x2=245
        headers[6].pdf_paragraph_composition.append(NS(pdf_character=None,pdf_line=None,pdf_same_style_characters=None,
            pdf_formula=NS(pdf_character=[glyph('x²',280,300)])))
        quality.protect_source_page(pg)
        self.assertEqual(headers[3].unicode,'Number of');self.assertIn(headers[4],pg.pdf_paragraph)
        self.assertEqual(headers[5].unicode,'Total novel');self.assertIn(headers[6],pg.pdf_paragraph)

    def test_caption_font_boundary_word_split_joins_table_prefix_and_caption_tail(self):
        first=paragraph('Table 1 | Reported novel sequ',40,340,label='fallback_line')
        tail=paragraph('ences from a structural variant cohort',first.box.x2-.03,340,label='table_caption')
        pg=page([first,tail]);original=list(quality._characters(first))+list(quality._characters(tail))
        quality.protect_source_page(pg)
        self.assertEqual(pg.pdf_paragraph,[first]);self.assertEqual(first.layout_label,'table_caption')
        self.assertEqual(first.unicode,'Table 1 | Reported novel sequences from a structural variant cohort')
        self.assertEqual(list(quality._characters(first)),original)

    def test_plain_body_prefix_or_caption_far_gap_is_never_concatenated(self):
        for text,label,gap in [('A body word','plain text',-.03),('Table 1 | Results','fallback_line',4)]:
            first=paragraph(text,40,340,label=label);tail=paragraph('other results',first.box.x2+gap,340,label='table_caption')
            pg=page([first,tail]);quality.protect_source_page(pg)
            self.assertEqual(pg.pdf_paragraph,[first,tail])

    def test_figure_words_keep_source_glyphs_but_caption_and_body_translate(self):
        label=paragraph('Tumour cells',60,500)
        caption=paragraph('Fig. 1. The response in tumour cells.',50,470,label='figure_caption')
        body=paragraph('The response was measured in each group.',50,430,label='plain text')
        pg=self.region(page([label,caption,body]),'figure',(40,460,400,600))
        before=copy.deepcopy(label)
        self.assertEqual(quality.protect_source_page(pg),{id(label)})
        self.assertEqual(label,before)

    def test_figure_region_never_swallows_a_crossing_paragraph_or_low_confidence_detection(self):
        crossing=paragraph('A body paragraph crossing the detected edge.',20,500,label='plain text')
        inside=paragraph('Cell',60,520)
        pg=self.region(page([crossing,inside]),'figure',(40,480,200,600))
        self.assertEqual(quality.protect_source_page(pg),{id(inside)})
        pg.page_layout[0].conf=.4
        self.assertEqual(quality.protect_source_page(pg),set())

    def test_moderate_figure_confidence_needs_an_explicit_caption_below_it(self):
        label=paragraph('Gene expression',60,500)
        caption=paragraph('Fig. 1. Expression in the two groups.',40,450,label='figure_caption')
        pg=self.region(page([label,caption]),'figure',(40,470,350,600),confidence=.63)
        self.assertEqual(quality.protect_source_page(pg),{id(label)})
        caption.layout_label='plain text'
        self.assertEqual(quality.protect_source_page(pg),set())
        caption.layout_label='figure_caption';caption.box.y=640;caption.box.y2=650
        caption.pdf_paragraph_composition[0].pdf_character.box=caption.box
        self.assertEqual(quality.protect_source_page(pg),set())

    def test_vector_diagram_requires_both_short_labels_and_actual_paths(self):
        labels=[paragraph('Gene '+str(i),60+(i%2)*120,500-(i//2)*20) for i in range(8)]
        pg=self.region(page(labels),'figure',(40,420,350,600),confidence=.37)
        self.assertEqual(quality.protect_source_page(pg),set())
        pg.pdf_curve=[NS(box=box(60,450+i*2,140,450+i*2)) for i in range(8)]
        self.assertEqual(quality.protect_source_page(pg),{id(p) for p in labels})
        pg.pdf_paragraph=[paragraph('Long article prose '*40,60,500,label='plain text')]
        self.assertEqual(quality.protect_source_page(pg),set())

    def test_short_panel_title_mislabeled_caption_is_still_a_figure_label(self):
        panel=paragraph('b Hi-C sequencing',60,500,label='figure_caption')
        caption=paragraph('Fig. 1. A sequencing diagram.',50,460,label='figure_caption')
        pg=self.region(page([panel,caption]),'figure',(40,450,400,600))
        self.assertEqual(quality.protect_source_page(pg),{id(panel)})

    def test_table_column_and_text_row_labels_translate_but_values_stay_original(self):
        pg,heads,data,prose=self.table_policy_fixture()
        before=copy.deepcopy(data)
        protected=quality.protect_source_page(pg)
        self.assertEqual(protected,{id(p) for p in [data[1],data[2],data[4],data[5]]})
        self.assertTrue(all(id(p) not in protected for p in heads+prose))
        self.assertTrue(all(quality.is_table_header(pg,p) for p in heads))
        self.assertTrue(all(not quality.is_table_header(pg,p) for p in data+prose))
        self.assertTrue(all(quality.is_table_row_label(pg,p) for p in [data[0],data[3]]))
        self.assertTrue(all(not quality.is_table_row_label(pg,p) for p in heads+[data[1],data[2],data[4],data[5]]+prose))
        self.assertFalse(quality.is_table_header(page(heads),heads[0]))
        self.assertEqual(data,before)

    def test_table_policy_is_independent_of_bold_and_preserves_formulas(self):
        pg,heads,data,_=self.table_policy_fixture()
        for p in heads:p.pdf_style.font_id='regular'
        for p in data:p.pdf_style.font_id='bold'
        pg.pdf_font=[NS(font_id='regular',bold=False),NS(font_id='bold',bold=True)]
        data[1].pdf_paragraph_composition.append(NS(pdf_character=None,pdf_line=None,pdf_same_style_characters=None,pdf_formula=NS(pdf_character=[glyph('x²',175,267)])))
        before=copy.deepcopy(data)
        self.assertEqual(quality.protect_source_page(pg),{id(p) for p in [data[1],data[2],data[4],data[5]]})
        self.assertEqual(data,before)

    def test_table_without_reliable_header_separator_keeps_all_cells(self):
        pg,heads,data,prose=self.table_policy_fixture();pg.pdf_curve=[]
        self.assertEqual(quality.protect_source_page(pg),{id(p) for p in heads+data})

    def test_partial_rules_do_not_turn_a_data_row_into_a_header(self):
        pg,heads,data,_=self.table_policy_fixture()
        pg.pdf_curve=[NS(box=box(40,280,190,280)),NS(box=box(220,280,320,280))]
        self.assertEqual(quality.protect_source_page(pg),{id(p) for p in heads+data})

    def test_a_lower_data_separator_cannot_make_the_first_numeric_row_a_header(self):
        pg,heads,data,_=self.table_policy_fixture()
        pg.pdf_curve=[NS(box=box(40,257,320,257))]
        self.assertEqual(quality.protect_source_page(pg),{id(p) for p in heads+data})

    def test_unstructured_body_mislabeled_as_table_is_not_preserved(self):
        body=paragraph('A long prose paragraph in the normal article body.',40,280,label='plain text')
        pg=self.region(page([body]),'table',(30,200,400,320))
        self.assertEqual(quality.protect_source_page(pg),set())
        # A nearby caption belonging to another table is not sufficient.
        pg.pdf_paragraph.insert(0,paragraph('Table 2. Results',40,328,label='table_caption'))
        self.assertEqual(quality.protect_source_page(pg),set())

    def test_table_geometry_must_not_protect_nearby_body_or_note(self):
        pg,heads,data,prose=self.table_policy_fixture()
        # A full-width note accidentally included in the detected table box
        # still keeps its semantic caption/footnote role and must translate.
        pg.page_layout[0].box.y=210
        protected=quality.protect_source_page(pg)
        self.assertTrue(all(id(p) in protected for p in [data[1],data[2],data[4],data[5]]))
        self.assertTrue(all(id(p) not in protected for p in prose))

    def test_first_column_identifiers_numbers_and_abbreviations_remain_original(self):
        for text in ['HG002','R9.4','Control_A','NA12878','C57BL/6J','PacBio','WT','12.5','GFP','HGP (2001 draft)',
                     'BRCA1','TP53','IL-6','10 mg','Sample HG002','Gene, BRCA1','Mixed, 25 mg','Swedish, 12.5']:
            with self.subTest(text=text):
                pg,heads,data,_=self.table_policy_fixture();data[0].unicode=text
                protected=quality.protect_source_page(pg)
                self.assertIn(id(data[0]),protected);self.assertFalse(quality.is_table_row_label(pg,data[0]))

    def test_actual_population_row_description_can_translate_with_camelcase_consortium(self):
        pg,heads,data,_=self.table_policy_fixture();data[0].unicode='Swedish, SweGen'
        original=copy.deepcopy(data)
        protected=quality.protect_source_page(pg)
        self.assertNotIn(id(data[0]),protected)
        self.assertTrue(quality.is_table_row_label(pg,data[0]))
        self.assertEqual(data,original)
        self.assertTrue(all(id(p) in protected for p in [data[1],data[2],data[4],data[5]]))

    def test_actual_mixed_population_row_description_can_translate_with_accession(self):
        pg,heads,data,_=self.table_policy_fixture();data[0].unicode='Mixed , data from 1KGP'
        original=copy.deepcopy(data)
        protected=quality.protect_source_page(pg)
        self.assertNotIn(id(data[0]),protected)
        self.assertTrue(quality.is_table_row_label(pg,data[0]))
        self.assertEqual(data,original)
        self.assertTrue(all(id(p) in protected for p in [data[1],data[2],data[4],data[5]]))

    def test_population_description_with_id_in_data_column_stays_original(self):
        pg,heads,data,_=self.table_policy_fixture();data[1].unicode='Mixed, data from 1KGP'
        data[2].unicode='0.8';pg.pdf_paragraph.append(paragraph('4.2',285,267))
        original=copy.deepcopy(data)
        protected=quality.protect_source_page(pg)
        self.assertIn(id(data[1]),protected)
        self.assertFalse(quality.is_table_row_label(pg,data[1]))
        self.assertEqual(data,original)

    def test_text_in_a_data_column_is_not_a_row_label(self):
        pg,heads,data,_=self.table_policy_fixture();data[1].unicode='Control'
        # Keep a numeric pair in the first row so the header boundary remains
        # independently verifiable rather than relying on the candidate label.
        data[2].unicode='0.8';extra=paragraph('4.2',285,267);pg.pdf_paragraph.append(extra)
        protected=quality.protect_source_page(pg)
        self.assertIn(id(data[1]),protected);self.assertFalse(quality.is_table_row_label(pg,data[1]))

    def test_overlapping_column_headers_cannot_establish_a_first_column(self):
        pg,heads,data,_=self.table_policy_fixture()
        heads[0].pdf_paragraph_composition[0].pdf_character.box.x2=175
        heads[0].box.x2=175
        protected=quality.protect_source_page(pg)
        self.assertIn(id(data[0]),protected);self.assertIn(id(data[3]),protected)
        self.assertFalse(any(quality.is_table_row_label(pg,p) for p in data))

    def test_exact_identity_result_preserves_original_row_brand_and_ordinary_identifier_glyphs(self):
        from gpt_batch import apply_prepared_translation
        for text in ['Illumina','HG002']:
            with self.subTest(text=text):
                p=paragraph(text,45,267,label='plain text')
                pg=page([p]);protected=quality.protect_source_page(pg)
                original=copy.deepcopy(p);comps=p.pdf_paragraph_composition;style=p.pdf_style;bounds=p.box
                calls=[];translator=NS(translation_config=NS(raise_if_cancelled=lambda:None),post_translate_paragraph=lambda *a:calls.append(a))
                self.assertFalse(apply_prepared_translation(translator,pg,p,None,None,text,text))
                self.assertEqual(calls,[]);self.assertIn(id(p),protected)
                self.assertEqual(p,original);self.assertIs(p.pdf_paragraph_composition,comps)
                self.assertIs(p.pdf_style,style);self.assertIs(p.box,bounds)

    def test_translated_or_whitespace_changed_result_still_uses_normal_postprocessing(self):
        from gpt_batch import apply_prepared_translation
        p=paragraph('Illumina',45,267);pg=page([p]);protected=quality.protect_source_page(pg);calls=[]
        translator=NS(translation_config=NS(raise_if_cancelled=lambda:None),post_translate_paragraph=lambda *a:calls.append(a))
        self.assertTrue(apply_prepared_translation(translator,pg,p,None,None,'Illumina','因美纳'))
        self.assertTrue(apply_prepared_translation(translator,pg,p,None,None,'Illumina ','Illumina'))
        self.assertEqual(len(calls),2);self.assertNotIn(id(p),protected)

    def test_identity_cannot_bypass_cancellation_or_mark_an_unrelated_page(self):
        from gpt_batch import apply_prepared_translation
        p=paragraph('Illumina',45,267);pg=page([p]);protected=quality.protect_source_page(pg)
        def cancelled():raise RuntimeError('cancelled')
        translator=NS(translation_config=NS(raise_if_cancelled=cancelled),post_translate_paragraph=lambda *a:self.fail('must not apply'))
        with self.assertRaisesRegex(RuntimeError,'cancelled'):
            apply_prepared_translation(translator,pg,p,None,None,'Illumina','Illumina')
        self.assertNotIn(id(p),protected);self.assertFalse(quality.mark_source_preserved(page([p]),p))

if __name__ == '__main__': unittest.main()
