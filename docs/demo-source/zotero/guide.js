/* Runs current plugin modules over Zotero's extracted Reader/PDFView resources.
 * All state and PDF content in this process are self-authored fixtures. */
window.demoErrors=[];window.addEventListener('error',e=>demoErrors.push(e.message));
async function setupDemo(){
  const [data,ftl,alignment,translated]=await Promise.all([
    fetch('/demo/original.pdf').then(r=>r.arrayBuffer()),fetch('/reader.ftl').then(r=>r.text()),
    fetch('/demo/alignment.json').then(r=>r.json()),fetch('/demo/translation.pdf').then(r=>r.arrayBuffer())]);
  window.reader=createReader({type:'pdf',data:{buf:new Uint8Array(data)},ftl:[ftl],title:'Reading demonstration',authorName:'Demo Reader',annotations:[],sidebarOpen:false,contextPaneOpen:true,showContextPaneToggle:true,primaryViewState:{pageIndex:0,scale:'page-width',top:0,left:0},onSaveAnnotations:(v,done)=>done(),onDeleteAnnotations:()=>{},onChangeViewState:()=>{},onChangeSidebarWidth:()=>{},onToggleSidebar:()=>{},onOpenContextMenu:()=>{}});
  await reader._primaryView.initializedPromise;
  await reader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.onePageRendered;
  document.documentElement.style.setProperty('--sidebar-width','0px');
  const content=document.createElement('aside');content.id='demo-context';
  content.innerHTML='<div class="context-title">Ask for GPT</div><div class="context-subtitle">PDF 翻译</div><item-details data-tab-id="demo"><div id="demo-sidebar"></div></item-details><div class="context-foot">原生界面演示<br>自有示例文档</div>';
  document.body.append(content);
  // XUL is Gecko-only. This transparent rendering adapter maps the actual
  // sidebar.js nodes to native HTML controls; it does not reimplement its state.
  document.createXULElement=function(name){
    const tags={vbox:'div',hbox:'div',label:'label',menulist:'select',menupopup:'optgroup',menuitem:'option',button:'button'};
    const el=document.createElement(tags[name]||'div'),set=el.setAttribute.bind(el);el.dataset.xul=name;
    if(name==='vbox')el.style.display='flex',el.style.flexDirection='column';
    if(name==='hbox')el.style.display='flex',el.style.alignItems='center';
    el.setAttribute=function(key,value){set(key,value);if(key==='style'&&['hbox','vbox'].includes(name)){el.style.display='flex';if(name==='vbox')el.style.flexDirection='column';}if((name==='label'&&key==='value')||(['button','menuitem'].includes(name)&&key==='label'))el.textContent=value;};
    el.addEventListener('change',()=>el.dispatchEvent(new Event('command')));
    if(name==='button')el.addEventListener('click',()=>el.dispatchEvent(new Event('command')));
    return el;
  };
  window.demoState={open:true,busy:false,whole:false,mode:'dual',direction:'en-zh',progress:null};
  let section,subscriber;
  const zreader={type:'pdf',tabID:'demo',_window:window};window.Zotero_Tabs={selectedID:'demo'};
  const Zotero={locale:'zh-CN',getMainWindows:()=>[window],Reader:{getByTabID:()=>zreader},ItemPaneManager:{registerSection:s=>(section=s,'demo'),unregisterSection:()=>{}}};
  window.sidebar=AskGPTSidebar.create({Zotero,pluginID:'documentation-only',rootURI:'/plugin/',actions:{state:()=>demoState,subscribe:f=>(subscriber=f,()=>{}),setMode:(_,m)=>{demoState.mode=m;window.layer?.showOutput(translated,[0,1,2],m,alignment);},translate:()=>{},original:()=>layer.showOriginal()}});
  sidebar.start();section.onRender({doc:document,body:document.getElementById('demo-sidebar'),tabType:'reader'});
  window.updateDemoState=value=>{Object.assign(demoState,value);subscriber(zreader,demoState);};
  const host=document.querySelector('.toolbar .end > .custom-sections')||document.querySelector('.toolbar .end');
  window.layer=await AskGPTPDFNativeView.mount({sourceView:reader._primaryView,reader,win:window,pageCount:3},'',{current:()=>{},whole:()=>{},stop:()=>{},resume:()=>{},original:()=>layer.showOriginal(),failure:e=>demoErrors.push(e.message)},{toolbarHost:host});
  await layer.showOutput(translated,[0,1,2],'dual',alignment);
  window.resetDemoPage=function(index=0){for(const v of [reader._primaryView,layer.nativeView]){const app=v._iframeWindow.PDFViewerApplication;app.pdfViewer.scrollPageIntoView({pageNumber:index+1});if(index===0)v._iframeWindow.document.getElementById('viewerContainer').scrollTop=0;}};
  resetDemoPage();
  // The only precise semantic pair used by the selection demo is handwritten.
  // Its rectangles come from the real rendered PDFView glyphs, not guessed UI.
  window.prepareDemoPhrase=function(){
    const fixture=JSON.parse(JSON.stringify(alignment));
    const bounds=gs=>[Math.min(...gs.map(g=>g.rect[0])),Math.min(...gs.map(g=>g.rect[1])),Math.max(...gs.map(g=>g.rect[2])),Math.max(...gs.map(g=>g.rect[3]))];
    const part=gs=>({text:gs.map(g=>g.text).join(''),glyphs:gs,rects:[bounds(gs)]});
    const line=v=>v._pdfPages[0].chars.filter(g=>Math.abs(g.baseline-625)<.01).map(g=>({text:g.c,rect:Array.from(g.rect),line:0}));
    const source=part(line(reader._primaryView)),target=part(line(layer.nativeView));
    const subset=(p,text)=>{const at=p.text.indexOf(text);if(at<0)throw Error('Demo phrase missing: '+text);return part(p.glyphs.slice(at,at+text.length));};
    const dual=(p,dx)=>({rects:p.rects.map(r=>[r[0]+dx,r[1],r[2]+dx,r[3]])});
    const a=subset(source,'genome'),b=subset(target,'基因组');
    const sentence={id:'demo-sentence',method:'semantic-model',source,target,dualSource:dual(source,0),dualTarget:dual(target,600),phrases:[{id:'demo-handwritten-genome',method:'semantic-phrase-model',source:a,target:b,dualSource:dual(a,0),dualTarget:dual(b,600),sourceTokenCount:1,targetTokenCount:3}]};
    fixture.granularity='sentence';fixture.sentenceAlignmentRevision='pdf-sentence-semantic-v1';fixture.sentencePages=[0];fixture.phraseAlignmentRevision='pdf-phrase-semantic-v1';fixture.phrasePages=[0];
    fixture.pages[0].paragraphs[4]={id:'demo-paragraph',source,target,dualSource:dual(source,0),dualTarget:dual(target,600),sentences:[sentence]};
    layer.updateAlignment(fixture);window.demoAlignment=fixture;window.demoPhrase={source:a,target:b};return fixture;
  };
  window.selectDemoPhrase=function(){
    const view=layer.nativeView,position={pageIndex:0,rects:demoPhrase.target.rects};
    const textLayer=view._iframeWindow.document.querySelector('.page[data-page-number="1"] .textLayer');
    const walker=view._iframeWindow.document.createTreeWalker(textLayer,NodeFilter.SHOW_TEXT);let node;
    while(node=walker.nextNode()){const start=node.textContent.indexOf('基因组');if(start>=0){const range=view._iframeWindow.document.createRange();range.setStart(node,start);range.setEnd(node,start+3);const selection=view._iframeWindow.getSelection();selection.removeAllRanges();selection.addRange(range);break;}}
    const rect=view.getClientRectForPopup(position,0,0);
    view._onSetSelectionPopup({annotation:{type:'highlight',color:'#ffd400',text:'基因组',position,sortIndex:'00000|000200|00164'},rect});
  };
  window.demoTranslated=translated;window.demoAlignment=alignment;
  window.demoReady=true;
}
window.addEventListener('DOMContentLoaded',()=>setupDemo().catch(e=>{demoErrors.push(e.stack);console.error(e);window.demoFailure=e.stack;}),{once:true});
