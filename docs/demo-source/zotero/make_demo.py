"""Self-authored public demonstration PDF pair; no research paper or model call."""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import json,sys

base = Path(sys.argv[1]).resolve() if len(sys.argv)>1 else Path(__file__).resolve().parents[3]/'work/github-zotero-visuals/demo'
base.mkdir(parents=True,exist_ok=True)
pdfmetrics.registerFont(TTFont('Demo', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'))
SIZE=(600,800)
sources = [
    ('Reading a research paper', '科研文献阅读示例'),
    ('Ask for GPT · Reading notes', 'Ask for GPT · 阅读笔记'),
    ('COMPARE TEXT • HIGHLIGHT TERMS • LOCATE FIGURES', '对照正文 · 标记术语 · 定位图表'),
    ('Abstract', '摘要'),
    ('The human genome contains many kinds of sequence variation.', '人类基因组包含多种类型的序列变异。'),
    ('A clear reading workflow keeps context, notes and figures together.', '清晰的阅读流程可以把上下文、笔记与图表放在一起。'),
    ('Read a paragraph, check its terminology, and keep useful notes.', '读完一段，核对术语，再把有用的信息记下来。'),
    ('Keep the original page close while exploring the translation.', '阅读译文时，保留原始页面，方便随时核对。'),
    ('1. Read with context', '1. 联系上下文阅读'),
    ('Compare the original text and the translated page side by side.', '并排查看原文与译文页面。'),
    ('Select a short phrase, then choose a highlight color manually.', '选中短语后，手动选择高亮颜色。'),
    ('Use linked scrolling to follow both pages during close reading.', '精读时可使用联动滚动，同时跟随两个页面。'),
    ('Switch to independent scrolling when you need another location.', '需要查看不同位置时，可切换为独立滚动。'),
    ('2. Keep figures close', '2. 结合图表阅读'),
    ('The figure index locates captions in the original document.', '图表索引定位原始文档中的图题与表题。'),
    ('Choose the left or right pane before jumping to a figure.', '跳转图表前，先选择左侧或右侧页面。'),
]

def write(path, side):
    c=canvas.Canvas(str(path), pagesize=SIZE, invariant=1)
    c.setTitle('Ask for GPT — Self-authored reading demonstration')
    c.setAuthor('Ask for GPT documentation')
    for page in range(3):
        c.setFillColorRGB(.12,.17,.23)
        c.setFont('Demo',9);c.drawString(42,770,'ASK FOR GPT  /  READING DEMONSTRATION')
        c.setStrokeColorRGB(.78,.81,.84);c.line(42,758,558,758)
        if page==0:
            positions=[(730,23),(704,11),(683,8),(650,15),(625,11),(606,11),(587,11),(568,11),(532,15),(507,11),(488,11),(469,11),(450,11),(413,15),(388,11),(369,11)]
            for (y,size),row in zip(positions,sources):
                c.setFont('Demo',size);c.drawString(42,y,row[side])
            c.setFillColorRGB(.93,.96,.98);c.roundRect(42,103,516,230,5,fill=1,stroke=0)
            c.setFillColorRGB(.14,.38,.56);c.setFont('Demo',11)
            c.drawString(58,309,'Fig. 1 | Reading workflow' if side==0 else '图 1 | 阅读流程')
            for j,label in enumerate(['Original','Translation','Annotations'] if side==0 else ['原文','译文','标注']):
                x=65+j*166;c.setFillColorRGB(.78,.87,.93);c.roundRect(x,204,142,60,6,fill=1,stroke=0)
                c.setFillColorRGB(.12,.25,.34);c.setFont('Demo',12);c.drawCentredString(x+71,229,label)
            c.setFont('Demo',9);c.drawString(58,147,'Keep text, translation and reading notes together.' if side==0 else '把原文、译文与阅读笔记放在一起。')
        elif page==1:
            c.setFont('Demo',23);c.drawString(42,720,'Example figure and table' if side==0 else '示例图与表')
            c.setFont('Demo',13);c.drawString(42,676,'Fig. 2 | A second reading location' if side==0 else '图 2 | 第二个阅读位置')
            c.setFillColorRGB(.91,.95,.97);c.roundRect(42,410,516,238,6,fill=1,stroke=0)
            c.setFillColorRGB(.16,.31,.43);c.setFont('Demo',16);c.drawCentredString(300,520,'Self-authored schematic' if side==0 else '自有示意内容')
            c.setFont('Demo',13);c.drawString(42,361,'Table 1 | Documentation topics' if side==0 else '表 1 | 文档主题')
            for j,row in enumerate([('Topic','Control'),('View','Original / translation / dual'),('Notes','Manual color selection'),('Navigation','Figure index')]):
                y=320-j*37;c.setStrokeColorRGB(.8,.84,.87);c.line(42,y-12,558,y-12);c.setFont('Demo',11);c.drawString(54,y,row[0]);c.drawString(230,y,row[1])
        else:
            c.setFont('Demo',23);c.drawString(42,720,'Continue reading' if side==0 else '继续阅读')
            for j,text in enumerate(['Return to the original document at any time.','Reading position and notes belong to the same document.','This page completes the three-page demonstration.'] if side==0 else ['可随时切回原始文档。','阅读位置与笔记关联到同一文档。','这是三页演示文档的最后一页。']):
                c.setFont('Demo',12);c.drawString(42,660-j*30,text)
        c.setFont('Demo',9);c.setFillColorRGB(.45,.49,.54);c.drawString(42,36,'Self-authored demonstration / 自有演示文档');c.drawRightString(558,36,str(page+1));c.showPage()
    c.save()

write(base/'original.pdf',0);write(base/'translation.pdf',1)
# Geometry for the deliberately simple example. Handwritten parallel text is a
# rendering fixture, never an output from the translation or alignment models.
pages=[]
for i in range(3):
    p={'sourcePage':i,'outputPage':i,'source':{'mediaBox':[0,0,600,800],'cropBox':[0,0,600,800],'rotation':0},'mono':{'mediaBox':[0,0,600,800],'cropBox':[0,0,600,800],'rotation':0},'dual':{'mediaBox':[0,0,1200,800],'cropBox':[0,0,1200,800],'rotation':0},'sourceToDual':[1,0,0,1,0,0],'targetToDual':[1,0,0,1,600,0],'paragraphs':[]}
    if i==0:
        for j,(y,size) in enumerate([(730,23),(704,11),(683,8),(650,15),(625,11),(606,11),(587,11),(568,11),(532,15),(507,11),(488,11),(469,11),(450,11),(413,15),(388,11),(369,11)]):
            row=sources[j];r=[42,y-3,558,y+size]; p['paragraphs'].append({'id':f'p{i}_{j}','source':{'text':row[0],'rects':[r]},'target':{'text':row[1],'rects':[r]},'dualSource':{'rects':[r]},'dualTarget':{'rects':[[642,y-3,1158,y+size]]}})
    pages.append(p)
(base/'alignment.json').write_text(json.dumps({'schema':1,'coordinateSpace':'pdf','granularity':'paragraph','pages':pages},ensure_ascii=False,indent=2)+'\n')
