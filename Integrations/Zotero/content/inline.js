(function (root) {
  'use strict';
  const Core=root.AskGPTInlineCore||(typeof require==='function'?require('./inline-core.js'):null);
  const PDF=root.AskGPTPDFLayout||(typeof require==='function'?require('./pdf-layout.js'):null);
  const Native=root.AskGPTPDFNativeView||(typeof require==='function'?require('./pdf-native-view.js'):null);
  const Sidebar=root.AskGPTSidebar||(typeof require==='function'?require('./sidebar.js'):null);
  const ConnectionSecurity=root.AskGPTConnectionSecurity||(typeof require==='function'?require('./connection-security.js'):null);
  const Hover=root.AskGPTPDFHoverGloss||(typeof require==='function'?require('./pdf-hover-gloss.js'):null);
  const Resume=root.AskGPTPDFReadingResume||(typeof require==='function'?(()=>{try{return require('./pdf-reading-resume.js');}catch(_){return null;}})():null);
  const ResumeStore=root.AskGPTPDFReadingResumeStore||(typeof require==='function'?(()=>{try{return require('./pdf-reading-resume-store.js');}catch(_){return null;}})():null);
  const optional=name=>{if(typeof require==='function')try{return require('./'+name+'.js');}catch(_){}return null;};
  const LocalVersion=root.AskGPTPDFLocalVersion||optional('pdf-local-version');
  const FigureBridge=root.AskGPTPDFFigureBridge||optional('pdf-figure-bridge');
  const FigureRegion=root.AskGPTPDFFigureRegion||optional('pdf-figure-region');
  const FigureReader=root.AskGPTPDFFigureReader||optional('pdf-figure-reader');
  const FigurePreview=root.AskGPTPDFFigurePreview||optional('pdf-figure-preview');
  const FigureWindow=root.AskGPTPDFFigureWindow||optional('pdf-figure-window');
  const FigureMarkup=root.AskGPTPDFFigureMarkup||optional('pdf-figure-markup');
  const FigureStore=root.AskGPTPDFFigureMarkupStore||optional('pdf-figure-markup-store');
  const XHTML='http://www.w3.org/1999/xhtml';
  function element(doc,name,className,text){const node=doc.createElementNS(XHTML,name);if(className)node.className=className;if(text!=null)node.textContent=text;return node;}
  async function readConnection(dependencies){
    const {readText}=dependencies;
    const file=ConnectionSecurity.readerDirectory(dependencies);file.append('inline-connection.json');
    if(!file.exists()||!file.isFile()||file.isSymlink()||file.fileSize>4096)throw new Core.InlineError('connection');
    let text;try{text=await ConnectionSecurity.withPrivateFile(dependencies,file,readText);}catch(error){throw new Core.InlineError(error?.code==='permissions'?'permissions':'connection');}
    let value;try{value=JSON.parse(text);}catch(_){throw new Core.InlineError('connection');}
    return Core.validateConnection(value);
  }
  function createPDFTransport(dependencies){return PDF.createTransport(dependencies,readConnection);}
  function createWordLookup(dependencies){
    return async word=>{
      if(typeof word!=='string'||word.length>96||!/[A-Za-z]/.test(word)||!/^[A-Za-z.'’‐‑-]+$/.test(word))throw new Core.InlineError('text');
      const connection=await readConnection(dependencies);
      const response=await dependencies.Zotero.HTTP.request('POST',connection.url.replace(/\/translate$/,'/lookup'),{
        body:JSON.stringify({word}),headers:{'Content-Type':'application/json',Authorization:'Bearer '+connection.token},
        responseType:'text',timeout:2500,followRedirects:false,debug:false,logBodyLength:0,successCodes:[200,400,401,403,404,413,503]
      });
      if(response.status!==200||typeof response.responseText!=='string'||response.responseText.length>32768)throw new Core.InlineError('response');
      let value;try{value=JSON.parse(response.responseText);}catch(_){throw new Core.InlineError('response');}
      if(!value||typeof value!=='object'||!Object.hasOwn(value,'entry'))throw new Core.InlineError('response');
      if(value.entry===null)return null;
      const entry=value.entry,query=word.replace(/’/g,"'").replace(/[‐‑]/g,'-');
      if(!entry||entry.query!==query||typeof entry.headword!=='string'||!entry.headword.trim()||entry.headword.length>96
        ||entry.phonetic!=null&&(typeof entry.phonetic!=='string'||entry.phonetic.length>160)
        ||!Array.isArray(entry.senses)||entry.senses.length<1||entry.senses.length>32
        ||entry.senses.some(s=>!s||typeof s.partOfSpeech!=='string'||s.partOfSpeech.length>24||!Array.isArray(s.meanings)||s.meanings.length<1||s.meanings.length>64||s.meanings.some(m=>typeof m!=='string'||!m.trim()||m.length>4096)))throw new Core.InlineError('response');
      return {query:entry.query,headword:entry.headword,phonetic:entry.phonetic??null,senses:entry.senses.map(s=>({partOfSpeech:s.partOfSpeech,meanings:s.meanings.slice()}))};
    };
  }
  function createFigureLookup(dependencies){
    const invalid=code=>new Core.InlineError(code||'response');
    function validate(value){
      if(!value||Object.keys(value).sort().join(',')!=='exclusions,figures'||!Array.isArray(value.figures)||value.figures.length>64||!Array.isArray(value.exclusions)||value.exclusions.length>256)throw invalid();
      const rows=(items,excluded)=>items.map(item=>{const rect=item?.rect,keys=excluded?'confidence,kind,rect':'confidence,rect';if(!item||Object.keys(item).sort().join(',')!==keys||!Array.isArray(rect)||rect.length!==4||!rect.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1)||rect[2]<=rect[0]||rect[3]<=rect[1]||typeof item.confidence!=='number'||!Number.isFinite(item.confidence)||item.confidence<0||item.confidence>1||excluded&&!['caption','text','header'].includes(item.kind))throw invalid();return {rect:rect.slice(),confidence:item.confidence,...(excluded?{kind:item.kind}:{})};});
      return {figures:rows(value.figures,false),exclusions:rows(value.exclusions,true)};
    }
    return async(input,options={})=>{
      if(!(input instanceof Uint8Array)||input.byteLength<24||input.byteLength>4*1024*1024)throw invalid('figure_input');
      const bytes=new Uint8Array(input),view=new DataView(bytes.buffer),width=view.getUint32(16),height=view.getUint32(20);
      if([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82].some((n,i)=>bytes[i]!==n)||!width||!height||width>1024||height>1024||width*height>1048576){bytes.fill(0);throw invalid('figure_input');}
      let aborted=false,abortRequest=null,timer=null,resume=null;
      const current=()=>!aborted&&(options.isCurrent?.()??true),stop=()=>{aborted=true;try{abortRequest?.();}catch(_){}if(timer!==null){dependencies.clearTimer?.(timer);timer=null;resume?.();}};options.setCancel?.(stop);
      try{
        const connection=await readConnection(dependencies);
        for(let attempt=0;attempt<3;attempt++){
          if(!current())throw invalid('stopped');let response;
          try{response=await dependencies.Zotero.HTTP.request('POST','http://127.0.0.1:43795/v1/pdf/figure-regions',{body:bytes,headers:{'Content-Type':'image/png',Authorization:'Bearer '+connection.token},responseType:'text',timeout:14000,followRedirects:false,anon:true,noCache:true,debug:false,logBodyLength:0,errorDelayMax:0,successCodes:[200,400,401,403,413,429,502,503,504],cancellerReceiver(cancel){abortRequest=cancel;if(!current())stop();}});}catch(_){throw invalid(current()?'figure_failed':'stopped');}finally{abortRequest=null;}
          if(!current())throw invalid('stopped');if(typeof response.responseText!=='string'||response.responseText.length>65536)throw invalid();let value;try{value=JSON.parse(response.responseText);}catch(_){throw invalid();}
          if(response.status===200)return validate(value);
          const code=typeof value?.error==='string'&&['figure_busy','figure_unavailable','figure_timeout','figure_input','figure_limit','figure_failed'].includes(value.error)?value.error:'response';
          if(response.status!==429||code!=='figure_busy'||attempt===2)throw invalid(code);
          await new Promise(resolve=>{resume=resolve;timer=dependencies.setTimer(()=>{timer=null;resume=null;resolve();},[600,1400][attempt]);});
        }
      }finally{bytes.fill(0);if(timer!==null)dependencies.clearTimer?.(timer);options.setCancel?.(null);}
    };
  }
  function create(dependencies){
    const {Zotero,Services,Components,css,pluginID}=dependencies;
    const timers={...dependencies,setTimer:dependencies.setTimer||((fn,ms)=>Zotero.getMainWindow().setTimeout(fn,ms)),clearTimer:dependencies.clearTimer||(id=>Zotero.getMainWindow()?.clearTimeout(id))};
    const localVersions=LocalVersion?.create(dependencies);
    const transport=createPDFTransport(timers),lookupWord=createWordLookup(timers),lookupFigure=createFigureLookup(timers),contexts=new Map(),mainWindows=new Map();
    let hoverOn=true;try{hoverOn=Zotero.Prefs?.get?.('extensions.askgpt-inline.hoverGloss',true)!==false;}catch(_){}
    let resumeOn=true;try{resumeOn=Zotero.Prefs?.get?.('extensions.askgpt-inline.readingResume',true)!==false;}catch(_){}
    const resumeStore=ResumeStore?.create?.({Zotero,validateAnchor:Resume?.validateAnchor});
    const figureStore=FigureStore?.create?.({...dependencies,getWindow:()=>Zotero.getMainWindow?.(),reportExportDiagnostic:value=>report('figureExport',{code:'rendered',figureNumbers:{fieldsReady:200+value.phase,opsReady:value.result}})});
    const subscribers=new Set();
    let disposed=false,notifierID=null,sidebar=null;
    const report=(stage,error)=>{try{void dependencies.reportDiagnostic?.(stage,error);}catch(_){}};
    const cleanup=operation=>{try{return operation();}catch(_){report('nativeDispose',{name:'Error',code:'compatibility'});}};
    const alive=reader=>!disposed&&!reader?._window?.closed;
    function active(reader){return alive(reader)&&(!reader.tabID||reader._window?.Zotero_Tabs?.selectedID===reader.tabID);}
    function updateToolbar(context){for(const node of context.buttons){const opened=Boolean(context.session);node.hidden=Boolean(context.session?.native&&context.toolbarControlsAttached);if(node.hidden)node.style.setProperty('display','none','important');else node.style.removeProperty('display');node.textContent=opened?'原文':'翻译';const title=(opened?'Original PDF · 恢复原 PDF':'Translate PDF · 保留版式翻译')+' · Option+Shift+X';node.setAttribute('title',title);node.setAttribute('aria-label',title);}}
    function attachToolbarControls(context){const layer=context.session?.native&&context.session.layer;context.toolbarControlsAttached=Boolean(layer?.attachToolbar?.(context.toolbarSlot));updateToolbar(context);}
    function progressValue(value){
      if(!value||!['preparing','translating','layout','loading'].includes(value.stage))return null;
      const result={stage:value.stage};
      if(value.stage==='translating'&&Number.isInteger(value.completed)&&Number.isInteger(value.total)&&value.total>0&&value.total<=2000&&value.completed>=0&&value.completed<=value.total){result.completed=value.completed;result.total=value.total;}
      return result;
    }
    function phraseReady(value,page){return value?.phraseAlignmentRevision==='pdf-phrase-semantic-v1'&&value.phraseExtractionRevision==='pdf-glyph-boundary-v2'&&value.phrasePages?.includes(page)===true&&value.phraseExtractedPages?.includes(page)===true&&PDF.sentenceCoverage(value.pages?.find(value=>value.sourcePage===page));}
    function state(reader){const session=contexts.get(reader)?.session;return {open:Boolean(session),original:session?.mode==='original',busy:Boolean(session?.busy),whole:session?Boolean(session.whole):Boolean(localVersions),mode:session?((session.mode==='original'?session.lastTranslatedMode:session.mode)==='dual'?'dual':'mono'):(localVersions?'dual':'mono'),direction:session?.direction==='zh-en'?'zh-en':'en-zh',progress:session?.busy?progressValue(session.progress):null};}
    function notify(context){updateToolbar(context);context.resume?.refresh?.();const value=state(context.reader);for(const callback of subscribers){try{callback(context.reader,value);}catch(_){}}}
    function setProgress(context,session,value){if(context.session!==session)return;session.progress=progressValue(value);session.layer?.setProgress?.(session.progress);notify(context);}
    function showError(context,error){
      context.error?.remove();context.error=null;const text=PDF.errorMessage(error);if(!text||!alive(context.reader))return;
      let doc;try{doc=Core.resolvePDFContext(context.reader).win.document;}catch(_){return;}
      const banner=element(doc,'div','askgpt-pdf-error',text);banner.setAttribute('role','alert');
      banner.setAttribute('style','position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483100;max-width:calc(100% - 32px);padding:10px 14px;border:1px solid #9996;border-radius:10px;background:Canvas;color:CanvasText;font:13px -apple-system,sans-serif;box-shadow:0 4px 20px #0002');
      doc.body.appendChild(banner);context.error=banner;
    }
    function retireWork(context,session){
      cleanup(()=>session.hydration?.cancel?.());session.hydration=null;
      const cancel=session.cancel,job=session.job;session.cancel=null;session.job=null;const cancelling=cleanup(()=>cancel?.());
      // Retirement belongs to one reader context. A slow DELETE for another paper
      // must never serialize a newly authorized translation.
      context.retiring=Promise.resolve(context.retiring).then(()=>cancelling).then(async()=>{if(job?.id&&job.state!=='complete')await transport.cancel(job.id);}).catch(()=>{});
      return context.retiring;
    }
    function closeSession(context,options={}){
      clearFigure(context);cleanup(()=>context.resume?.flush?.());cleanup(()=>context.resume?.clear?.());
      cleanup(()=>context.hover?.clear());cleanup(()=>context.session?.layer?.clearHover?.());
      const session=context.session;if(!session)return;context.session=null;session.epoch++;session.outputEpoch++;
      cleanup(()=>session.precision?.cancel?.());session.precision=null;
      cleanup(()=>retireWork(context,session));cleanup(()=>session.cancelMount?.());
      for(const remove of session.removers.splice(0))cleanup(remove);
      cleanup(()=>session.layer?.dispose(options.restorePosition!==false));cleanup(()=>notify(context));
    }
    function clearFigure(context,dispose=false){
      cleanup(()=>context.figureRefineStart?.());context.figureRefineStart=null;cleanup(()=>context.figureRefine?.cancel?.());context.figureRefine=null;
      context.figureEpoch=(context.figureEpoch||0)+1;cleanup(()=>context.figureRender?.cancel?.());context.figureRender=null;context.figureOwner=null;
      cleanup(()=>context.figurePreview?.[dispose?'dispose':'close']?.());if(dispose)context.figurePreview=null;
      for(const handle of context.figureHandles||[])cleanup(()=>handle.clear?.());
    }
    function attachFigure(context,view,enabled){
      if(!FigureReader||!FigureRegion||!FigurePreview||!FigureMarkup||!figureStore)return null;
      if(Services?.scriptloader&&dependencies.rootURI&&!view?._iframeWindow?.PDFViewerApplication?.pdfDocument)return null;
      const owns=()=>!disposed&&contexts.get(context.reader)===context&&enabled();
      let bridge;try{bridge=FigureBridge?.create({view,Services,Components,rootURI:dependencies.rootURI,lookupFigure,enabled:owns,reportDiagnostic:numbers=>report('figureOperatorShape',{name:'FigureDiagnostic',code:'rendered',figureNumbers:numbers})});}catch(error){report('figureError',{name:error?.name,code:'compatibility',errorDetail:'figureNativeAttach',figureNumbers:{fieldsReady:Number.isInteger(error?.figurePhase)?error.figurePhase:-1}});return null;}
      const handle=FigureReader.install(view,{region:FigureRegion,nativeBridge:bridge,prewarm:Boolean(bridge),Components,enabled:owns,reportDiagnostic:report,
        exportCallback:callback=>Components.utils?.exportFunction?Components.utils.exportFunction(callback,view._iframeWindow):callback,
        async onOpen(value){
          if(!owns())return;const now=Date.now(),previewStarted=Number.isSafeInteger(value.requestedAt)&&value.requestedAt>0&&value.requestedAt<=now&&now-value.requestedAt<=60000?value.requestedAt:now,reader=context.reader,item=reader._item||Zotero.Items?.get?.(reader.itemID),pdf=view._iframeWindow?.PDFViewerApplication?.pdfDocument;
          const binding=FigureMarkup.validateBinding({libraryID:item?.libraryID,itemKey:item?.key,fingerprint:pdf?.fingerprints?.[0],pageIndex:value.index,rect:value.rect});
          if(!binding){report('figureError',{code:'compatibility',errorDetail:'figureBinding'});handle.message('当前文档暂时无法预览图片');return;}
          clearFigure(context);context.figureOwner=view;const generation=context.figureEpoch;context.hover?.clear();context.resume?.clear?.();
          const parentDoc=reader._internalReader?._primaryView?._options?.container?.ownerDocument||reader._iframeWindow?.document,parentWin=parentDoc?.defaultView||reader._iframeWindow;
          if(!parentDoc?.body)return;handle.message('正在打开图片…');
          let task,canvas,nativeHost;
          try{
            if(bridge)task=bridge.render(value.index,binding.rect);else {const page=value.page||await pdf.getPage(value.index+1);if(!owns()||context.figureEpoch!==generation)return;task=FigureRegion.renderCrop({page,pageView:value.pageView,rect:binding.rect,doc:parentDoc,nativeWindow:view._iframeWindow,Components});}context.figureRender=task;
            canvas=await task.promise;if(!owns()||context.figureEpoch!==generation){canvas.width=canvas.height=0;return;}
            if(Services?.scriptloader&&dependencies.rootURI){
              if(!FigureWindow)throw new Error('Native Preview unavailable');
              const hasDisplaySize=Number.isFinite(value.displayWidth)&&value.displayWidth>0&&Number.isFinite(value.displayHeight)&&value.displayHeight>0;
              // Fallback: one PDF point per CSS pixel; bitmap pixels supply only its aspect ratio.
              const fallbackScale=Math.max(binding.rect[2]-binding.rect[0],binding.rect[3]-binding.rect[1])/Math.max(canvas.width,canvas.height);
              const displayWidth=hasDisplaySize?value.displayWidth:canvas.width*fallbackScale,displayHeight=hasDisplaySize?value.displayHeight:canvas.height*fallbackScale;
              nativeHost=await FigureWindow.open({Services,Components,displayWidth,displayHeight,timerWindow:Zotero.getMainWindow?.()||parentWin,reportDiagnostic:phase=>report('figureWindow',{code:'rendered',figureNumbers:{fieldsReady:phase}}),isCurrent:()=>owns()&&context.figureEpoch===generation,exportCallback:(fn,target)=>Components.utils?.exportFunction?Components.utils.exportFunction(fn,target):fn});
              if(!owns()||context.figureEpoch!==generation){nativeHost.close();canvas.width=canvas.height=0;return;}
            }
            const previewDoc=nativeHost?.doc||parentDoc,previewWin=nativeHost?.win||parentWin;let preview;
            preview=FigurePreview.create({doc:previewDoc,win:previewWin,iconDocument:parentDoc,nativeHost,markup:FigureMarkup,store:figureStore,allowMarkup:false,
              onClosed:()=>{if(context.figurePreview===preview){context.figurePreview=null;cleanup(()=>context.figureRefineStart?.());context.figureRefineStart=null;cleanup(()=>context.figureRefine?.cancel?.());context.figureRefine=null;}},
              exportCallback:fn=>Components.utils?.exportFunction?Components.utils.exportFunction(fn,previewWin):fn,
              waiveCanvas:ctx=>Components.utils?.waiveXrays?Components.utils.waiveXrays(ctx):ctx,
              unwrapPNG:value=>Components.utils?.waiveXrays?Components.utils.waiveXrays(value):value,
              reportExportDiagnostic:value=>report('figureExport',{code:'rendered',figureNumbers:{fieldsReady:value.phase,opsCount:Math.min(500000,value.byteLength||0)}})});context.figurePreview=preview;
            const opened=await preview.open({binding,label:'Preview',canvas});
            if(opened){
              report('figureOpened',{code:'rendered'});
              report('figurePreviewTiming',{code:'rendered',previewNumbers:{openMilliseconds:Date.now()-previewStarted,renderMilliseconds:task?.renderMilliseconds,snapshot:task?.snapshot?1:0}});
              const regionWidth=binding.rect[2]-binding.rect[0],regionHeight=binding.rect[3]-binding.rect[1],detailScale=Math.min(4,4096/regionWidth,4096/regionHeight,Math.sqrt(12000000/(regionWidth*regionHeight)));
              if(bridge&&task?.snapshot&&canvas.width*canvas.height<regionWidth*regionHeight*detailScale*detailScale*.98){
                // Start detail work only after the first window frame can paint.
                // Its task and late pixels belong to this exact preview session.
                const timerWindow=Zotero.getMainWindow?.()||parentWin,exportTo=(fn,target)=>Components.utils?.exportFunction?Components.utils.exportFunction(fn,target):fn;
                let frame=null,timer=null;const cancelStart=()=>{if(frame!==null)previewWin.cancelAnimationFrame?.(frame);if(timer!==null)timerWindow.clearTimeout(timer);frame=timer=null;};
                context.figureRefineStart=cancelStart;
                const refine=()=>{
                  timer=null;if(context.figureRefineStart===cancelStart)context.figureRefineStart=null;
                  if(!owns()||context.figureEpoch!==generation||context.figurePreview!==preview||!preview.isOpen)return;
                  const detail=bridge.render(value.index,binding.rect,{snapshot:false});context.figureRefine=detail;
                  void detail.promise.then(sharp=>{if(!owns()||context.figureEpoch!==generation||context.figurePreview!==preview||!preview.isOpen){sharp.width=sharp.height=0;return;}preview.upgradeCanvas(sharp);}).catch(()=>{}).finally(()=>{if(context.figureRefine===detail)context.figureRefine=null;});
                };
                const afterPaint=()=>{frame=null;if(owns()&&context.figureEpoch===generation&&context.figurePreview===preview)timer=timerWindow.setTimeout(exportTo(refine,timerWindow),0);};
                if(typeof previewWin.requestAnimationFrame==='function')frame=previewWin.requestAnimationFrame(exportTo(afterPaint,previewWin));else timer=timerWindow.setTimeout(exportTo(refine,timerWindow),0);
              }
            }else{void preview.dispose();if(context.figurePreview===preview)context.figurePreview=null;}
          }catch(error){report('figureError',{name:error?.name,code:'compatibility',errorDetail:'figureRender'});if(owns()&&context.figureEpoch===generation)handle.message('图片暂时无法打开，请重试');nativeHost?.close?.();if(canvas)canvas.width=canvas.height=0;
          }finally{if(context.figureRender===task)context.figureRender=null;}
        }});
      if(!handle)return null;context.figureHandles??=new Set();context.figureHandles.add(handle);const disposeHandle=handle.dispose;
      handle.dispose=()=>{if(context.figureOwner===view)clearFigure(context);try{disposeHandle();}finally{try{bridge?.dispose();}finally{context.figureHandles.delete(handle);}}};return handle;
    }
    function resumePresentation(context){
      if(!active(context.reader))return;const session=context.session;notify(context);
      if(session?.pendingDisplay&&!session.busy&&session.job&&session.layer){
        session.pendingDisplay=false;void instance.setMode(context.reader,session.mode);
      }
    }
    function ensureContext(reader){
      if(contexts.has(reader)){const existing=contexts.get(reader);existing.attachPDF?.();return existing;}
      const context={reader,buttons:new Set(),toolbarSlot:null,toolbarControlsAttached:false,session:null,keyWindows:new Map(),error:null};contexts.set(reader,context);
      const ownsContext=()=>!disposed&&contexts.get(reader)===context;
      const attach=win=>{
        if(!win||context.keyWindows.has(win)||!ownsContext())return;
        const handler=event=>{if(ownsContext()&&!event.defaultPrevented&&!event.repeat&&event.altKey&&event.shiftKey&&!event.ctrlKey&&!event.metaKey&&event.code==='KeyX'&&active(reader)){event.preventDefault();event.stopImmediatePropagation();void toggle(reader);}};
        const onFocus=()=>{if(ownsContext())resumePresentation(context);};
        const onUnload=()=>{if(ownsContext())removeContext(reader);};
        win.addEventListener('keydown',handler,true);win.addEventListener('focus',onFocus);win.addEventListener('unload',onUnload);context.keyWindows.set(win,{handler,onFocus,onUnload});
      };
      attach(reader._window);attach(reader._iframeWindow);
      const attachPDF=()=>{if(!ownsContext())return;
        const view=reader._internalReader?._primaryView;
        if(view&&context.initializingView!==view){context.initializingView=view;view.initializedPromise?.then(()=>{if(ownsContext()){attachPDF();attachExistingToolbar();}},()=>{});}
        try{
        attach(Core.resolvePDFContext(reader).win);
        if(view?._iframeWindow&&Hover&&context.hoverView!==view){
          context.hover?.dispose();context.hover=null;
          context.hover=Hover.install(view,{lookup:lookupWord,reportDiagnostic:report,enabled:()=>ownsContext()&&hoverOn&&active(reader)&&(!context.session?.native||!context.session?.layer?.visible||context.session.mode!=='mono'),
            exportCallback:callback=>Components.utils?.exportFunction?Components.utils.exportFunction(callback,view._iframeWindow):callback});
          context.hoverView=view;
        }
        if(view?._iframeWindow?.PDFViewerApplication?.pdfViewer&&context.figureView!==view){
          context.figureHandle?.dispose();context.figureHandle=attachFigure(context,view,()=>active(reader)&&(!context.session?.native||!context.session?.layer?.visible||context.session.mode!=='mono'));if(context.figureHandle)context.figureView=view;
        }
        if(view?._iframeWindow&&Resume&&context.resumeView!==view){
          context.resume?.dispose();context.resume=null;
          context.resume=Resume.install(view,{load:()=>resumeStore?.load(reader),save:anchor=>resumeStore?.save(reader,anchor),
            enabled:()=>ownsContext()&&resumeOn&&active(reader)&&reader._window?.document?.hasFocus?.()!==false&&(!context.session||context.session.mode==='original'||context.session.native&&context.session.mode==='dual'),
            onDiagnostic:(stage,error)=>report(stage,error),
            exportCallback:callback=>Components.utils?.exportFunction?Components.utils.exportFunction(callback,view._iframeWindow):callback});
          context.resumeView=view;
        }
      }catch(error){report('hoverAttach',error);}};
      const attachExistingToolbar=()=>{if(!ownsContext())return;try{const doc=reader._iframeWindow?.document,host=doc?.querySelector?.('.toolbar .end > .custom-sections')||doc?.querySelector?.('.toolbar .end');if(!host)return;toolbar({reader,doc,append:node=>host.appendChild(node)});}catch(error){report('toolbar',error);}};
      context.attachPDF=attachPDF;attachPDF();attachExistingToolbar();return context;
    }
    async function toggle(reader,options={}){
      if(!active(reader))return;const context=ensureContext(reader);context.error?.remove();context.error=null;
      context.resume?.flush?.();context.resume?.clear?.();
      context.hover?.clear();
      if(context.session){const session=context.session;if(session.native&&session.layer?.showOriginal)return instance.setMode(reader,session.mode==='original'?session.lastTranslatedMode:'original');closeSession(context);return;}
      if(localVersions)options={whole:true,mode:'dual',...options};
      let pdf;try{pdf=Core.resolvePDFContext(reader);if(typeof pdf.pdfDocument.getData!=='function')throw new PDF.PDFError('compatibility');}catch(error){report('context',error);showError(context,error);return;}
      const nativeContext={...pdf,reader:reader._internalReader,outerReader:reader,sourceView:reader._internalReader?._primaryView};
      const native=Native?.canMount?.(nativeContext)===true;
      if(nativeContext.sourceView?._options&&!native){showError(context,new PDF.PDFError('compatibility'));return;}
      const session={pdf,native,alignment:null,layoutAlignment:null,hydration:null,precision:null,epoch:0,outputEpoch:0,layer:null,cancelMount:null,cancel:null,job:null,busy:true,pendingDisplay:false,progress:{stage:'preparing'},whole:options.whole===true,direction:options.direction==='zh-en'?'zh-en':'en-zh',mode:options.mode==='dual'?'dual':'mono',lastTranslatedMode:options.mode==='dual'?'dual':'mono',removers:[],data:null,dataPromise:null,outputs:new Map()};context.session=session;notify(context);
      const valid=()=>{if(!alive(reader)||context.session!==session)return false;try{return Core.resolvePDFContext(reader).pdfDocument===pdf.pdfDocument;}catch(_){return false;}};
      function finish(epoch){
        if(context.session!==session||session.epoch!==epoch)return;
        if(!valid()){report('stale');closeSession(context,{restorePosition:false});return;}
        session.busy=false;setProgress(context,session,null);
      }
      function interactionState(){
        if(!session.interaction||session.interaction.jobID!==session.job?.id)session.interaction={jobID:session.job?.id,latest:null,cache:new Map(),pending:new Map(),restored:new Set(),targetSHA256:null};
        return session.interaction;
      }
      function acceptSelection(value,run){
        const checked=PDF.validateSelectionLinks(value,run.jobID,value.page,(session.alignment||session.layoutAlignment)?.sourceSHA256);
        if(run.targetSHA256!==null&&run.targetSHA256!==checked.targetSHA256)throw new PDF.PDFError('response');run.targetSHA256=checked.targetSHA256;return checked;
      }
      function restoreSelectionLinks(page){
        if(!session.native||!session.job||!Number.isInteger(page)||!session.job.sourcePages.includes(page)||typeof session.layer?.updateSelectionLinks!=='function')return;
        const run=interactionState();if(run.restored.has(page))return;run.restored.add(page);
        void transport.selectionLinks(run.jobID,page,session.job.sourcePages).then(value=>{if(!valid()||session.interaction!==run||session.job?.id!==run.jobID)return;session.layer?.updateSelectionLinks(acceptSelection(value,run));}).catch(error=>{if(valid()&&session.interaction===run){run.restored.delete(page);report('nativeSelection',error);}});
      }
      function requestSelection(page,query){
        if(!query||query.page!==page)return 'unavailable';const run=interactionState(),key=JSON.stringify(query);run.latest=key;
        const current=()=>valid()&&session.interaction===run&&session.job?.id===run.jobID;
        if(run.cache.has(key)){const value=run.cache.get(key);session.layer?.updateSelectionLinks?.(value);session.layer?.setAnnotationStatus?.(value.link?null:'failed');return value.link?'ready':'failed';}
        if(run.pending.has(key))return 'pending';session.layer?.setAnnotationStatus?.('preparing');
        const pending=transport.selectionAlignment(run.jobID,session.data,query,session.job.sourcePages).then(value=>{
          if(!current())return;const checked=acceptSelection(value,run);run.cache.set(key,checked);if(run.latest!==key)return;session.layer?.updateSelectionLinks?.(checked);session.layer?.setAnnotationStatus?.(checked.link?null:'failed');
        }).catch(error=>{if(current()&&run.latest===key){session.layer?.setAnnotationStatus?.('failed');report('nativeSelection',error);}}).finally(()=>{run.pending.delete(key);});
        run.pending.set(key,pending);return 'started';
      }
      function requestPrecision(page,options={}){
        if(!session.native||!session.job||!session.data||!Number.isInteger(page)||!session.job.sourcePages.includes(page))return 'unavailable';
        if(session.layoutAlignment&&!session.alignment){
          if(session.hydration?.failed){if(options.explicit===true){hydrateAlignment(true);return 'pending';}session.layer?.setAnnotationStatus?.('failed');return 'failed';}
          session.layer?.setAnnotationStatus?.('preparing');
          return 'pending';
        }
        if(options.selection)return requestSelection(page,options.selection);
        const explicit=options.explicit===true,units=Array.isArray(options.units)?options.units.slice(0,8):[];
        // Existing translated PDFs remain immediately readable. Upgrade old
        // mapping only for the reader's explicit selection or retry action.
        if(session.job.reusedLegacy===true&&!explicit)return 'idle';
        let run=session.precision;
        const ready=phraseReady(session.alignment,page),status=()=>session.layer?.setAnnotationStatus?.(phraseReady(session.alignment,run.visiblePage)?null:run.failed.has(run.visiblePage)?'failed':'preparing');
        if(!run||run.jobID!==session.job.id){run={jobID:session.job.id,attempted:new Set(),failed:new Set(),history:new Map(),visiblePage:page,currentPage:null,running:false,cancel:null,generation:0,priority:null};session.precision=run;}
        const changed=run.visiblePage!==page;
        run.visiblePage=page;
        // Only the visible page owns a listener. Cancelling it does not cancel
        // the independent service task or discard successful checkpoints.
        if(changed){run.generation++;run.cancel?.();run.cancel=null;run.currentPage=null;run.running=false;run.priority=null;if(!run.failed.has(page))run.attempted.delete(page);}
        if(ready){if(changed||explicit||run.failed.delete(page))session.layer?.setAnnotationStatus?.(null);return 'ready';}
        // Crossing a cached page must not download and synchronously validate
        // the whole word sidecar. Selection/save/retry request precision on demand.
        if(!explicit)return run.running&&run.currentPage===page?'pending':'idle';
        const current=()=>valid()&&session.precision===run&&session.job?.id===run.jobID;
        if(run.running&&run.currentPage===page){
          if(explicit&&units.length){
            const key=page+':'+units.join('|');if(run.priority!==key){run.priority=key;const priorityGeneration=run.generation,ticket=run.prioritySequence=(run.prioritySequence||0)+1;
              void transport.prioritizeAlignment(run.jobID,page,session.job.sourcePages,units).then(value=>{
                if(!current()||run.generation!==priorityGeneration||run.prioritySequence!==ticket||run.visiblePage!==page||run.priority!==key)return;
                // The first PDF request may still be in transit. Re-probe with
                // the latest selected units if there is no service task yet.
                if(value.state==='idle'){run.generation++;run.cancel?.();run.cancel=null;run.running=false;run.currentPage=null;run.attempted.delete(page);requestPrecision(page,{explicit:true,units});}
              }).catch(error=>{if(current())report('sentencePriority',error);});
            }
          }
          if(explicit)status();return 'pending';
        }
        if(run.attempted.has(page)){
          if(!explicit||!run.failed.has(page)){if(changed)status();return 'failed';}
          const now=Date.now(),history=(run.history.get(page)||[]).filter(time=>now-time<60000);run.history.set(page,history);
          if(history.length>=3){session.layer?.setAnnotationStatus?.('retry_limited');return 'retry_limited';}
          if(history.length&&now-history.at(-1)<3000){session.layer?.setAnnotationStatus?.('retry_wait');return 'retry_wait';}
          run.attempted.delete(page);run.failed.delete(page);
        }
        run.running=true;run.currentPage=page;run.attempted.add(page);run.priority=units.length?page+':'+units.join('|'):null;status();
        const generation=++run.generation,watching=()=>current()&&run.generation===generation;
        const now=Date.now();run.history.set(page,[...(run.history.get(page)||[]).filter(time=>now-time<60000),now]);
        void(async()=>{
          try{
            // PDF page warmup remains local. Never queue speculative GPT pages
            // ahead of the page or phrase the reader is actually using.
            const alignment=await transport.upgradeAlignment(run.jobID,session.data,[page],session.job.sourcePages,cancel=>{if(watching())run.cancel=cancel;else cancel();},{probe:true,...(units.length?{units}:{}),onPartial:async alignment=>{if(!watching())return;session.alignment=alignment;await session.layer?.updateAlignment?.(alignment);if(watching())status();}});
            if(!watching())return;session.alignment=alignment;run.failed.delete(page);await session.layer?.updateAlignment?.(alignment);if(watching())status();
          }catch(error){
            if(watching()&&error?.code!=='stopped'){
              try{const alignment=await transport.alignment(run.jobID,session.job.sourcePages);if(!watching())return;session.alignment=alignment;await session.layer?.updateAlignment?.(alignment);}catch(_){}
              if(watching()){if(phraseReady(session.alignment,page))run.failed.delete(page);else run.failed.add(page);report('sentence',error);status();}
            }
          }finally{if(watching()){run.currentPage=null;run.cancel=null;run.running=false;}}
        })();return 'started';
      }
      function resumeFromToolbar(){
        if(!valid())return;
        if(session.layoutAlignment&&!session.alignment){if(session.mode==='original')return instance.setMode(reader,session.lastTranslatedMode).then(()=>hydrateAlignment(true));hydrateAlignment(true);return;}
        const page=session.layer?.currentSourcePage;
        if(session.native&&!session.busy&&session.job?.state==='complete'&&session.layer?.visible&&Number.isInteger(page)&&!phraseReady(session.alignment,page))return requestPrecision(page,{explicit:true});
        return startFromResume();
      }
      const startFromResume=()=>{if(session.mode==='original'){session.mode=session.lastTranslatedMode;notify(context);}return start(session.whole);};
      function hydrateAlignment(retry=false){
        if(!valid()||!session.native||session.alignment||!session.layoutAlignment||!session.job)return;
        if(session.hydration&&(!session.hydration.failed||!retry))return;
        const run={jobID:session.job.id,epoch:session.epoch,failed:false,cancel:null},pages=session.job.sourcePages.slice(),layout=session.layoutAlignment;session.hydration=run;
        session.layer?.setAnnotationStatus?.('preparing');
        const current=()=>valid()&&session.hydration===run&&session.epoch===run.epoch&&session.job?.id===run.jobID;
        const load=()=>{run.cancel=null;if(!current())return;
          report('alignmentBegin');void transport.alignment(run.jobID,pages,cancel=>{if(current())run.cancel=cancel;else cancel?.();}).then(value=>{
            if(!current())return;
            const layoutPages=value.pages.map(page=>({...page,paragraphs:page.paragraphs.map(({sentences,...row})=>row)}));
            if(value.sourceSHA256!==layout.sourceSHA256||JSON.stringify(layoutPages)!==JSON.stringify(layout.pages))throw new PDF.PDFError('response');
            session.alignment=value;try{session.layer?.updateAlignment?.(value);}catch(error){session.alignment=null;throw error;}
            session.layoutAlignment=null;
            report('alignmentReady');const page=session.layer?.currentSourcePage;restoreSelectionLinks(page);
            const status=requestPrecision(page);session.layer?.setAnnotationStatus?.(status==='ready'?null:['idle','unavailable'].includes(status)?'idle':['failed','retry_wait','retry_limited'].includes(status)?status:'preparing');
          }).catch(error=>{if(current()){run.failed=true;session.layer?.setAnnotationStatus?.('failed');report('alignment',error);}});
        };
        const schedule=()=>{if(!current())return;const timer=timers.setTimer(load,0);run.cancel=()=>timers.clearTimer(timer);};
        // Give the visible native page a paint opportunity before the large
        // word sidecar can occupy the main thread.
        const frameWindow=reader._iframeWindow;
        if(typeof frameWindow?.requestAnimationFrame==='function'){
          const callback=Components.utils?.exportFunction?Components.utils.exportFunction(schedule,frameWindow):schedule;
          const frame=frameWindow.requestAnimationFrame(callback);run.cancel=()=>frameWindow.cancelAnimationFrame?.(frame);
        }else schedule();
      }
      async function display(mode){
        if(!valid()||!session.job)return;
        // The job is independent of visibility. Defer PDF.js presentation in
        // hidden tabs, where animation frames may be suspended by Zotero.
        if(!active(reader)){session.pendingDisplay=true;return;}
        if(mode==='original'){session.outputEpoch++;session.pendingDisplay=false;session.layer.showOriginal();return;}
        const epoch=++session.outputEpoch;session.mode=mode;report('outputBegin');session.layer.prepareOutput();setProgress(context,session,{stage:'loading'});
        // The bilingual layout uses two real native views: the existing source
        // and this same local translated PDF. Retain its bytes and PDF worker
        // instead of downloading a second, physically combined PDF.
        const outputKind=session.native?'mono':mode,jobID=session.job.id;
        try{const [output,mapping]=await Promise.all([
            session.outputs.get(outputKind)||transport.output(session.job.id,outputKind),
            session.native?(session.alignment?{value:session.alignment,complete:true}:session.layoutAlignment?{value:session.layoutAlignment,complete:false}:transport.layoutAlignment(session.job.id,session.job.sourcePages)):null
          ]);if(!valid()||session.job?.id!==jobID)return;
          session.outputs.set(outputKind,output);
          // A background precision upgrade may finish while another PDF mode
          // is downloading. Keep that newer mapping instead of the snapshot
          // captured when Promise.all started.
          if(mapping?.complete)session.alignment=session.alignment||mapping.value;
          else if(mapping)session.layoutAlignment=mapping.value;
          if(epoch!==session.outputEpoch)return;
          if(!active(reader)){session.pendingDisplay=true;return;}
          session.pendingDisplay=false;report('outputReady');setProgress(context,session,{stage:'loading'});
          await session.layer.showOutput(output,session.job.sourcePages,mode,session.alignment||session.layoutAlignment);
          if(valid()&&session.job?.id===jobID&&epoch===session.outputEpoch){restoreSelectionLinks(session.layer.currentSourcePage);hydrateAlignment();}
        }catch(error){report('output',error);if(valid()&&epoch===session.outputEpoch){session.layer.restoreOriginal();showError(context,error);}}
      }
      async function start(whole){
        if(!valid())return;
        const epoch=++session.epoch;
        const current=()=>valid()&&session.epoch===epoch;
        try{
          report('startBegin');session.busy=true;session.whole=whole;session.outputEpoch++;session.precision?.cancel?.();session.precision=null;session.interaction=null;const retirement=retireWork(context,session);session.outputs.clear();session.alignment=null;session.layoutAlignment=null;
          session.layer.prepareOutput();setProgress(context,session,{stage:'preparing'});context.error?.remove();context.error=null;
          await retirement;report('retired');if(!current())return;
          if(!session.data){
            const pending=session.dataPromise||(session.dataPromise=pdf.pdfDocument.getData());
            try{const returned=await pending;if(!current())return;session.data=PDF.copyOpenPDFData(returned,Components);}
            // The owned copy replaces the fulfilled promise's whole-PDF buffer.
            finally{if(current()&&session.dataPromise===pending)session.dataPromise=null;}
          }if(!current())return;
          const page=Number.isInteger(session.layer?.currentSourcePage)?session.layer.currentSourcePage+1:pdf.viewer.currentPageNumber;
          if(!Number.isInteger(page)||page<1||page>pdf.pageCount)throw new PDF.PDFError('compatibility');
          const reverse=session.direction==='zh-en';
          let local=null;if(whole&&localVersions){try{local=await localVersions.load(reader,session.direction);}catch(_){throw new PDF.PDFError('local_version_save');}if(!current())return;if(local?.alreadyTranslated)throw new PDF.PDFError('already_translated');}
          const job=local?PDF.validateStatus(local.job,null,'all'):await transport.start(session.data,{pages:whole?'all':String(page),source:reverse?'zh-Hans':'en',target:reverse?'en':'zh-Hans'},cancel=>{if(current())session.cancel=cancel;else cancel();},value=>{if(current())setProgress(context,session,value);});
          report('jobReady');
          if(!current()){void transport.cancel(job.id).catch(()=>{});return;}
          session.cancel=null;session.job=job;if(job.pageCount!==pdf.pageCount)throw new PDF.PDFError('response');
          let localSaveFailed=false;
          if(local){session.outputs.set('mono',PDF.validPDF(local.output));if(!session.native)session.outputs.set(session.mode,PDF.validPDF(local.output));report('localVersionReady');}
          else if(whole&&localVersions){
            try{localSaveFailed=!await localVersions.find(reader,session.direction);}catch(_){localSaveFailed=true;report('localVersionError');}
            if(!current())return;
          }
          let shown;do{shown=session.mode;await display(shown);}while(current()&&session.mode!==shown);
          if(current()&&localSaveFailed)showError(context,new PDF.PDFError('local_version_save'));
        }catch(error){if(session.job?.state==='complete'&&whole&&localVersions&&!error?.code)error=new PDF.PDFError('local_version_save');report('start',error);if(current()){session.cancel=null;if(error?.code==='already_translated')closeSession(context,{restorePosition:false});else session.layer.restoreOriginal();showError(context,error);}}
        finally{finish(epoch);}
      }
      session.start=start;session.display=display;session.valid=valid;session.finish=finish;
      try{
        // PDF.js treats Command-wheel as zoom in the source document. While
        // this translation session is showing its original (including pending
        // or failed output), intercept it before PDF.js's window bubble handler.
        // The translated iframe owns its separate gestures; other readers and
        // Control-only wheel retain Zotero's normal behavior.
        const original=pdf.win.document.getElementById('viewerContainer'),wheelOptions={capture:true,passive:false};
        const onOriginalWheel=event=>{
          if(!valid()||session.layer?.visible||!event.metaKey||event.defaultPrevented||!original)return;
          const target=event.target;if(target!==original&&!original.contains?.(target))return;
          const horizontal=Number.isFinite(event.deltaX)&&event.deltaX!==0,raw=horizontal?event.deltaX:event.deltaY;
          if(!Number.isFinite(raw)||raw===0)return;
          let unit=1;
          if(event.deltaMode===1){try{unit=parseFloat(pdf.win.getComputedStyle?.(original)?.lineHeight)||16;}catch(_){unit=16;}}
          else if(event.deltaMode===2)unit=(horizontal?original.clientWidth:original.clientHeight)||800;
          const distance=Math.max(-1000000,Math.min(1000000,raw*unit));
          event.preventDefault();event.stopImmediatePropagation();
          const maximum=Math.max(0,original.scrollWidth-original.clientWidth);
          original.scrollLeft=Math.max(0,Math.min(maximum,original.scrollLeft+distance));
        };
        pdf.win.addEventListener('wheel',onOriginalWheel,wheelOptions);
        session.removers.push(()=>pdf.win.removeEventListener('wheel',onOriginalWheel,wheelOptions));
        const bus=pdf.application.eventBus;
        // Keep whole-document jobs alive while the user reads the original PDF.
        // The translated iframe owns its scrolling. The native bridge maps
        // reading state and annotations back to the original attachment.
        if(bus?.on&&bus?.off){const onPageChange=()=>{pdf.pageIndex=pdf.viewer.currentPageNumber-1;};bus.on('pagechanging',onPageChange);session.removers.push(()=>bus.off('pagechanging',onPageChange));}
        const onUnload=()=>closeSession(context,{restorePosition:false});pdf.win.addEventListener('unload',onUnload);session.removers.push(()=>pdf.win.removeEventListener('unload',onUnload));
        const mount=session.native?Native.mount:PDF.mount;
        const startFromToolbar=whole=>{
          if(!valid())return;
          if(session.native&&!session.busy&&session.job?.state==='complete'&&(session.alignment||session.layoutAlignment)&&session.outputs.has('mono'))return instance.translate(reader,{whole,mode:session.mode==='original'?session.lastTranslatedMode:session.mode,direction:session.direction});
          if(session.mode==='original'){session.mode=session.lastTranslatedMode;notify(context);}return start(whole);
        };
        const layer=await mount(session.native?nativeContext:pdf,css,{
          current:()=>startFromToolbar(false),whole:()=>startFromToolbar(true),resume:()=>resumeFromToolbar(),
          stop:()=>{if(session.cancel){session.epoch++;void retireWork(context,session);session.busy=false;setProgress(context,session,null);}},exit:()=>closeSession(context),original:()=>instance.original(reader),mode:mode=>instance.setMode(reader,mode),
          direction:next=>{if(next===session.direction||!valid())return;session.direction=next;void start(session.whole);},
          toggleHover:()=>instance.setHoverEnabled(!hoverOn),
          failure:error=>{if(!session.native)report('render',error);if(valid())showError(context,error);},
          align:(page,options)=>requestPrecision(page,options),page:page=>{restoreSelectionLinks(page);return requestPrecision(page);},
          readingInput:()=>{if(valid()&&session.native&&session.mode==='dual'&&session.layer?.scrollLinked===true)context.resume?.noteInput?.();}
        },{Components,installFigureView:(view,enabled)=>attachFigure(context,view,()=>active(reader)&&enabled()),reportDiagnostic:report,isCurrent:valid,lookupWord,hoverEnabled:()=>hoverOn&&active(reader),toolbarHost:()=>context.toolbarSlot,setCancel:cancel=>{session.cancelMount=cancel;}});
        if(!valid()){layer.dispose();if(context.session===session)closeSession(context,{restorePosition:false});return;}session.layer=layer;attachToolbarControls(context);setProgress(context,session,session.progress);void start(session.whole);
      }catch(error){report('mount',error);if(context.session!==session)return;closeSession(context);showError(context,error);}
    }
    const toolbar=event=>{
      if(disposed||event.reader?.type!=='pdf')return;const context=ensureContext(event.reader);
      if(context.toolbarSlot?.ownerDocument!==event.doc){
        context.toolbarSlot?.remove();for(const node of context.buttons)node.remove();context.buttons.clear();context.toolbarControlsAttached=false;
        const slot=element(event.doc,'span','askgpt-inline-toolbar-slot');slot.setAttribute('style','display:inline-flex;align-items:center;gap:3px;min-width:0;-webkit-app-region:no-drag');context.toolbarSlot=slot;
        const node=element(event.doc,'button','toolbar-button askgpt-inline-toolbar');node.setAttribute('type','button');node.setAttribute('tabindex','-1');node.addEventListener('click',()=>{void toggle(event.reader);});context.buttons.add(node);slot.appendChild(node);
      }
      // Zotero clears CustomSections before each renderToolbar event. Re-append
      // our persistent slot synchronously, including when the fallback slot was
      // already connected, then reattach the same native controls and handlers.
      event.append(context.toolbarSlot);attachToolbarControls(context);
    };
    function removeContext(reader){
      const context=contexts.get(reader);if(!context||context.removing)return;context.removing=true;
      cleanup(()=>context.resume?.flush?.());contexts.delete(reader);
      clearFigure(context,true);for(const handle of [...(context.figureHandles||[])])cleanup(()=>handle.dispose());context.figureHandles?.clear();context.figureHandle=null;context.figureView=null;
      const resume=context.resume,hover=context.hover;context.resume=null;context.hover=null;
      cleanup(()=>resume?.dispose());cleanup(()=>hover?.dispose());cleanup(()=>closeSession(context));cleanup(()=>context.error?.remove());context.error=null;
      for(const [win,callbacks] of context.keyWindows)for(const [type,callback,capture] of [['keydown',callbacks.handler,true],['focus',callbacks.onFocus,false],['unload',callbacks.onUnload,false]])cleanup(()=>win.removeEventListener(type,callback,capture));
      for(const node of context.buttons)cleanup(()=>node.remove());cleanup(()=>context.toolbarSlot?.remove());context.toolbarSlot=null;context.keyWindows.clear();context.buttons.clear();context.initializingView=null;context.hoverView=null;context.resumeView=null;context.attachPDF=null;
    }
    const instance={
      start(){
        Zotero.Reader.registerEventListener('renderToolbar',toolbar,pluginID);
        notifierID=Zotero.Notifier.registerObserver({notify(event,type,ids){if(type!=='tab')return;for(const [reader,context] of [...contexts]){if(event==='close'&&ids.includes(reader.tabID))removeContext(reader);else if(event==='select'){if(ids.includes(reader.tabID))resumePresentation(context);else clearFigure(context);}}}},['tab'],pluginID);
        for(const win of Zotero.getMainWindows())instance.attachMainWindow(win);
        for(const reader of Zotero.Reader._readers||[])if(reader.type==='pdf')ensureContext(reader);
        if(Sidebar&&Zotero.ItemPaneManager){sidebar=Sidebar.create({Zotero,pluginID,rootURI:dependencies.rootURI||'',actions:instance});sidebar.start();}
      },
      attachMainWindow(win){if(disposed||mainWindows.has(win))return;sidebar?.attachWindow(win);const handler=event=>{if(event.defaultPrevented||event.repeat||!event.altKey||!event.shiftKey||event.ctrlKey||event.metaKey||event.code!=='KeyX')return;const reader=Zotero.Reader.getByTabID(win.Zotero_Tabs?.selectedID);if(!reader||reader.type!=='pdf')return;event.preventDefault();event.stopImmediatePropagation();void toggle(reader);};win.addEventListener('keydown',handler,true);mainWindows.set(win,handler);},
      detachMainWindow(win){sidebar?.detachWindow(win);const handler=mainWindows.get(win);if(handler)win.removeEventListener('keydown',handler,true);mainWindows.delete(win);for(const reader of [...contexts.keys()])if(reader._window===win)removeContext(reader);},
      state,subscribe(callback){subscribers.add(callback);return()=>subscribers.delete(callback);},
      hoverEnabled(){return hoverOn;},
      resumeEnabled(){return resumeOn;},
      setResumeEnabled(value){if(typeof value!=='boolean')return resumeOn;resumeOn=value;try{Zotero.Prefs?.set?.('extensions.askgpt-inline.readingResume',value,true);}catch(_){}for(const context of contexts.values()){context.resume?.clear?.();notify(context);}return resumeOn;},
      setHoverEnabled(value){if(typeof value!=='boolean')return hoverOn;hoverOn=value;try{Zotero.Prefs?.set?.('extensions.askgpt-inline.hoverGloss',value,true);}catch(_){}for(const context of contexts.values()){context.hover?.clear();context.session?.layer?.clearHover?.();context.session?.layer?.refreshHover?.();notify(context);}return hoverOn;},
      async translate(reader,options={}){if(!active(reader))return;const session=contexts.get(reader)?.session;if(!session)return toggle(reader,options);if(session.busy||!session.layer)return;const direction=options.direction==='zh-en'?'zh-en':'en-zh',mode=options.mode==='mono'?'mono':options.mode==='dual'||localVersions?'dual':'mono',whole=options.whole===undefined?Boolean(localVersions):options.whole===true;
        const currentPage=Number.isInteger(session.layer?.currentSourcePage)?session.layer.currentSourcePage:session.pdf.viewer.currentPageNumber-1;
        if(session.native&&session.job?.state==='complete'&&direction===session.direction&&whole===session.whole&&(whole||session.job.sourcePages.includes(currentPage)))return instance.setMode(reader,mode);
        session.direction=direction;session.mode=mode;session.lastTranslatedMode=mode;return session.start(whole);},
      async setMode(reader,mode){
        if(!active(reader)||!['original','mono','dual'].includes(mode))return;const context=contexts.get(reader),session=context?.session;if(!session)return;
        context.resume?.flush?.();context.resume?.clear?.();
        context.hover?.clear();session.layer?.clearHover?.();
        if(mode==='original'){
          if(!session.native||!session.layer?.showOriginal){closeSession(context);return;}
          session.outputEpoch++;session.mode='original';session.pendingDisplay=false;session.layer.showOriginal();notify(context);return;
        }
        if(mode===session.mode&&!session.busy&&!session.pendingDisplay&&session.layer?.visible)return;
        session.mode=mode;session.lastTranslatedMode=mode;notify(context);
        if(!session.busy&&session.job){const epoch=session.epoch;session.busy=true;setProgress(context,session,{stage:'loading'});
          try{let shown;do{shown=session.mode;await session.display(shown);}while(session.valid()&&session.mode!==shown);}
          finally{session.finish(epoch);}
        }
      },
      original(reader){return instance.setMode(reader,'original');},
      restore(reader){const context=contexts.get(reader);if(context&&active(reader))closeSession(context);},
      shutdown(){disposed=true;sidebar?.shutdown();sidebar=null;if(typeof Zotero.Reader._unregisterEventListenerByPluginID==='function')Zotero.Reader._unregisterEventListenerByPluginID(pluginID);if(notifierID!==null)Zotero.Notifier.unregisterObserver(notifierID);notifierID=null;for(const reader of [...contexts.keys()])removeContext(reader);for(const win of [...mainWindows.keys()])instance.detachMainWindow(win);subscribers.clear();},toggle
    };return instance;
  }
  root.AskGPTInline={create};
  if(typeof module!=='undefined')module.exports={create,createPDFTransport,createWordLookup,createFigureLookup,mountPDFView:PDF.mount,pdfErrorMessage:PDF.errorMessage,readConnection};
})(this);
