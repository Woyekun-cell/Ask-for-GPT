"""Source glyph continuity only; no translation or model calls."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
import sys
from types import SimpleNamespace as NS
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
try:
    from paragraph_continuity import join_prose_fragments
except ImportError:
    join_prose_fragments=None

def box(x,y,x2,y2):return NS(x=x,y=y,x2=x2,y2=y2)
def chars(text,x,y,size=6,font='body',xobj=0):
    out=[]
    for c in text:
        width=1.5 if c.isspace() else 3
        out.append(NS(char_unicode=c,box=box(x,y,x+width,y+size),visual_bbox=None,
                      pdf_style=NS(font_id=font,font_size=size),xobj_id=xobj));x+=width
    return out
def comp(cs):return NS(pdf_same_style_characters=NS(pdf_character=cs),pdf_line=None,pdf_formula=None,pdf_character=None)
def paragraph(text,x,y,*,label='plain text',font='body',size=6,layout=1,xobj=0):
    cs=chars(text,x,y,size,font,xobj)
    return NS(unicode=text,box=box(x,y,cs[-1].box.x2,y+size),pdf_style=cs[0].pdf_style,
        pdf_paragraph_composition=[comp(cs)],layout_label=label,layout_id=layout,
        vertical=False,xobj_id=xobj,first_line_indent=False)
def region(identity=1,kind='plain text',bounds=(10,10,300,300)):
    return NS(id=identity,class_name=kind,conf=.98,box=box(*bounds))
def page(paras,regions=None):return NS(pdf_paragraph=paras,page_layout=regions or [region()],pdf_curve=[])
def glyphs(p):
    return [c for co in p.pdf_paragraph_composition for c in (
        [co.pdf_character] if co.pdf_character is not None else
        next((getattr(co,k).pdf_character for k in ['pdf_line','pdf_same_style_characters','pdf_formula']
              if getattr(co,k,None) is not None),[]))]

class ParagraphContinuityTests(unittest.TestCase):
    def setUp(self):self.assertIsNotNone(join_prose_fragments,'source continuity repair is missing')

    def test_same_line_broken_word_and_initials_keep_glyph_objects_and_spacing(self):
        ps=[paragraph('Thi',20,100),paragraph('s wor',29,100),paragraph('k',42.5,100,label='title'),
            paragraph('was supported.',47,100),paragraph('R',20,60),paragraph('.',23,60,label='title'),
            paragraph('M',26,60),paragraph('.',29,60,label='title'),paragraph('S',32,60),
            paragraph('.',35,60,label='title'),paragraph('researched data.',39.5,60)]
        p=page(ps);original=[id(c) for item in ps for c in glyphs(item)]
        join_prose_fragments(p)
        self.assertEqual([item.unicode for item in p.pdf_paragraph],['This work was supported.','R.M.S. researched data.'])
        self.assertEqual([id(c) for item in p.pdf_paragraph for c in glyphs(item)],original)

    def test_title_with_a_body_composition_is_split_only_at_verified_body_baseline(self):
        title=paragraph('Acknowledgements',20,120,label='title',font='bold',size=6.5,layout=2)
        title.pdf_paragraph_composition.append(comp(chars('Thi',20,112)))
        title.unicode+=' Thi'
        p=page([title,paragraph('s work was supported.',29,112)],
               [region(bounds=(10,90,200,118)),region(2,'title',(10,119,150,129))])
        join_prose_fragments(p)
        self.assertEqual([q.unicode for q in p.pdf_paragraph],['Acknowledgements','This work was supported.'])
        self.assertEqual(p.pdf_paragraph[0].pdf_style.font_id,'bold')
        self.assertEqual(p.pdf_paragraph[1].pdf_style.font_id,'body')
        self.assertEqual(p.pdf_paragraph[0].layout_label,'title')

    def wrap_pair(self):
        left=paragraph('A long first line and more DNA sequences',20,160,size=10)
        left.pdf_paragraph_composition=[comp(chars('A long first line',20,160,10)+chars('and more DNA sequences',20,147,10))]
        right=paragraph('that occur in a species. Here we review.',20,134,size=10)
        right.pdf_paragraph_composition=[comp(chars('that occur in a species.',20,134,10)+chars('Here we review.',20,121,10))]
        return left,right

    def test_wrapped_continuation_requires_shared_real_block_and_matching_line_leading(self):
        left,right=self.wrap_pair();p=page([left,right],[region(bounds=(15,110,90,175))])
        join_prose_fragments(p)
        self.assertEqual(len(p.pdf_paragraph),1)
        self.assertEqual(p.pdf_paragraph[0].unicode,left.unicode)
        self.assertIn('sequences that occur',p.pdf_paragraph[0].unicode)
        self.assertEqual(join_prose_fragments(p),{'joinedInline':0,'joinedWrapped':0,'splitTitleTails':0})

    def test_cross_block_or_new_paragraph_or_changed_leading_is_not_joined(self):
        for change in ['layout','indent','terminal','leading']:
            left,right=self.wrap_pair()
            if change=='layout':right.layout_id=2
            if change=='indent':right.first_line_indent=True
            if change=='terminal':left.unicode+='.'
            if change=='leading':
                for c in glyphs(right):c.box.y-=4;c.box.y2-=4
            p=page([left,right],[region(bounds=(15,100,100,175)),region(2,bounds=(200,100,290,175))])
            join_prose_fragments(p)
            self.assertEqual(len(p.pdf_paragraph),2,change)

    def test_inline_formula_baseline_jitter_does_not_become_a_new_text_line(self):
        left,right=self.wrap_pair()
        cs=left.pdf_paragraph_composition[0].pdf_same_style_characters.pdf_character
        cs.insert(2,chars('|',26,160.7,10)[0])
        p=page([left,right],[region(bounds=(15,110,100,175))])
        join_prose_fragments(p)
        self.assertEqual(len(p.pdf_paragraph),1)

    def test_same_line_font_xobject_large_gap_or_other_column_is_not_joined(self):
        for change in ['font','size','xobj','gap','column']:
            a=paragraph('First',20,100);b=paragraph('continuation',35,100)
            if change=='font':
                for c in glyphs(b):c.pdf_style.font_id='other'
            if change=='size':
                for c in glyphs(b):c.pdf_style.font_size=8
            if change=='xobj':
                for c in glyphs(b):c.xobj_id=1
            if change in ['gap','column']:
                for c in glyphs(b):c.box.x+=80;c.box.x2+=80
            p=page([a,b]);join_prose_fragments(p)
            self.assertEqual(len(p.pdf_paragraph),2,change)

    def test_figure_table_caption_and_formula_are_excluded(self):
        for kind in ['figure','table','table_caption','figure_caption','formula']:
            a=paragraph('One',20,100);b=paragraph('word',29,100)
            rs=[region()]
            if kind in ['table','figure']:rs.append(region(2,kind,(10,90,100,120)))
            elif kind=='formula':
                cs=glyphs(b);b.pdf_paragraph_composition=[NS(pdf_formula=NS(pdf_character=cs),pdf_line=None,pdf_same_style_characters=None,pdf_character=None)]
            else:b.layout_label=kind
            p=page([a,b],rs);join_prose_fragments(p)
            self.assertEqual(len(p.pdf_paragraph),2,kind)

    def test_title_tail_without_same_line_neighbor_stays_unchanged(self):
        p=paragraph('Heading',20,120,label='title',font='bold',size=6.5)
        p.pdf_paragraph_composition.append(comp(chars('Thi',20,112)));p.unicode+=' Thi'
        document=page([p],[region(bounds=(10,90,200,118))]);join_prose_fragments(document)
        self.assertEqual(document.pdf_paragraph,[p]);self.assertEqual(p.unicode,'Heading Thi')

    def test_parallel_pages_have_no_shared_repair_state(self):
        pages=[page([paragraph('One',20,100),paragraph('word',30.5,100)]) for _ in range(8)]
        with ThreadPoolExecutor(2) as pool:list(pool.map(join_prose_fragments,pages))
        self.assertTrue(all([p.unicode for p in d.pdf_paragraph]==['One word'] for d in pages))

    def test_drawn_row_or_column_rule_prevents_a_join(self):
        inline=page([paragraph('One',20,100),paragraph('word',31,100)])
        inline.pdf_curve=[NS(box=box(30,99,30,108))]
        left,right=self.wrap_pair();wrapped=page([left,right],[region(bounds=(15,110,100,175))])
        wrapped.pdf_curve=[NS(box=box(15,140,100,140))]
        for value in [inline,wrapped]:
            join_prose_fragments(value)
            self.assertEqual(len(value.pdf_paragraph),2)

    def test_a_separate_formula_between_prose_fragments_is_never_jumped(self):
        a=paragraph('One',20,100);f=paragraph('+',29.2,100);b=paragraph('word',30.5,100)
        cs=glyphs(f);cs[0].box.x2=29.8
        f.pdf_paragraph_composition=[NS(pdf_formula=NS(pdf_character=cs),pdf_line=None,pdf_same_style_characters=None,pdf_character=None)]
        value=page([a,f,b]);join_prose_fragments(value)
        self.assertEqual(value.pdf_paragraph,[a,f,b])

if __name__=='__main__':unittest.main()
