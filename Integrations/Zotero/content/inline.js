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
  const TranslatedAnnotations=root.AskGPTPDFTranslatedAnnotations||optional('pdf-translated-annotations');
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
    let disposed=false,notifierID=null,sidebar=null,backgroundOwner=null;
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
    function stopBackground(session){session?.background?.stop?.();}
    function ensureBackground(context,session){
      const reader=context.reader;
      if(!session||session.localGeometryOnly||!session.native||session.busy||!session.valid?.()||!active(reader)||session.mode==='original'||!session.layer?.visible||typeof session.layer.setAlignmentProgress!=='function'||!(session.alignment||session.layoutAlignment)||session.job?.state!=='complete')return;
      const previous=session.background;
      if(previous&&!previous.stopped&&previous.jobID===session.job.id&&previous.epoch===session.epoch){previous.wake();return;}
      if(backgroundOwner&&backgroundOwner!==previous)backgroundOwner.stop();
      const run={jobID:session.job.id,epoch:session.epoch,sha:(session.layoutAlignment||session.alignment).sourceSHA256,pages:session.job.sourcePages.slice(),completed:new Set(),prepared:new Set(),partial:new Set(),foreground:0,idleUntil:Date.now()+700,timer:null,pollTimer:null,cancelWatch:null,waiters:new Set(),stopped:false,done:false,running:false,eligible:false,received:false,version:null,activePage:null,workState:'unregistered',lastFocus:null,generation:0};
      session.background=run;backgroundOwner=run;
      run.current=()=>!run.stopped&&!session.localGeometryOnly&&backgroundOwner===run&&context.session===session&&session.valid?.()&&session.job?.id===run.jobID&&session.epoch===run.epoch&&(session.layoutAlignment||session.alignment)?.sourceSHA256===run.sha&&active(reader)&&session.mode!=='original'&&session.layer?.visible===true;
      const releaseWaiters=()=>{for(const resolve of [...run.waiters])resolve();run.waiters.clear();};
      const armIdle=()=>{if(run.timer!==null)timers.clearTimer(run.timer);run.timer=null;if(!run.current()||run.foreground)return;run.timer=timers.setTimer(()=>{run.timer=null;releaseWaiters();},Math.max(0,run.idleUntil-Date.now()));};
      run.waitIdle=async()=>{while(run.current()&&(run.foreground||Date.now()<run.idleUntil))await new Promise(resolve=>{run.waiters.add(resolve);armIdle();});if(!run.current())throw new PDF.PDFError('stopped');};
      run.activity=()=>{if(!run.current())return;run.idleUntil=Date.now()+700;armIdle();};
      // Foreground ownership and model yielding belong to the service. This
      // local guard postpones only native metadata application during input.
      run.beginForeground=()=>{if(!run.current())return ()=>{};run.foreground++;if(run.timer!==null)timers.clearTimer(run.timer);run.timer=null;let ended=false;return ()=>{if(ended)return;ended=true;run.foreground--;if(run.current()){run.idleUntil=Date.now()+700;armIdle();}};};
      run.focusPage=page=>{if(!run.current()||!run.eligible||!['queued','running'].includes(run.workState)||run.foreground||!run.pages.includes(page)||run.completed.has(page)||run.prepared.has(page)||run.lastFocus===page)return;run.lastFocus=page;void transport.prioritizeAlignment(run.jobID,page,run.pages,[]).catch(error=>{if(run.current()&&error?.code!=='stopped')report('sentencePriority',error);});};
      run.stop=()=>{if(run.stopped)return;run.stopped=true;if(backgroundOwner===run)backgroundOwner=null;for(const key of ['timer','pollTimer']){if(run[key]!==null)timers.clearTimer(run[key]);run[key]=null;}run.cancelWatch?.();run.cancelWatch=null;releaseWaiters();session.layer?.setAlignmentProgress?.(null);};
      const publish=state=>{if(!run.current())return;if(!state.eligible){session.layer.setAlignmentProgress(null);return;}const processed=new Set([...run.completed,...run.prepared]),value={state:state.paused?'paused':state.state==='running'?'running':state.workState==='partial'||state.workState==='blocked'||run.partial.size?'partial':'complete',completed:processed.size,total:run.pages.length},key=value.state+':'+value.completed+':'+value.total;if(run.lastProgress===key)return;run.lastProgress=key;session.layer.setAlignmentProgress(value);};
      run.accept=state=>{
        if(!run.current())return;run.generation++;
        const oldPage=run.activePage,changed=run.received&&state.alignmentVersion&&state.alignmentVersion!==run.version,prepared=run.received?[...(state.completedPages||[]),...(state.preparedPages||[])].filter(page=>!run.completed.has(page)&&!run.prepared.has(page)):[];
        run.completed=new Set(state.completedPages||[]);run.prepared=new Set(state.preparedPages||[]);run.partial=new Set(state.partialPages||[]);run.activePage=state.currentPage;run.version=state.alignmentVersion||run.version;run.received=true;run.eligible=state.eligible;run.workState=state.workState;run.done=!state.eligible||state.state!=='running';publish(state);run.focusPage(session.layer.currentSourcePage);
        if(changed||prepared.length){const pages=new Set([...prepared,...(changed?[oldPage,state.currentPage]:[])]);for(const page of pages)session.pageAlignments?.delete(page);const page=session.layer.currentSourcePage;if(pages.has(page))session.hydratePage?.(page,true);}
      };
      async function poll(){
        if(!run.current()){run.stop();return;}if(run.running)return;run.running=true;const generation=run.generation;
        try{const value=await transport.alignmentWork(run.jobID,run.pages,cancel=>{if(run.current())run.cancelWatch=cancel;else cancel?.();});if(run.current()&&run.generation===generation)run.accept(value);}
        catch(error){if(run.current()&&run.generation===generation&&error?.code!=='stopped'){run.done=true;report('alignment',error);session.layer.setAlignmentProgress({state:'partial',completed:new Set([...run.completed,...run.prepared]).size,total:run.pages.length});}}
        finally{run.running=false;run.cancelWatch=null;if(run.current()&&!run.done)run.pollTimer=timers.setTimer(()=>{run.pollTimer=null;void poll();},1000);}
      }
      run.wake=()=>{if(run.current()&&!run.running&&!run.done&&run.pollTimer===null)void poll();};
      if(session.alignmentWorkState)run.accept(session.alignmentWorkState);
      void poll();
    }
    function showError(context,error){
      context.error?.remove();context.error=null;const text=PDF.errorMessage(error);if(!text||!alive(context.reader))return;
      let doc;try{doc=Core.resolvePDFContext(context.reader).win.document;}catch(_){return;}
      const banner=element(doc,'div','askgpt-pdf-error',text);banner.setAttribute('role','alert');
      banner.setAttribute('style','position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483100;max-width:calc(100% - 32px);padding:10px 14px;border:1px solid #9996;border-radius:10px;background:Canvas;color:CanvasText;font:13px -apple-system,sans-serif;box-shadow:0 4px 20px #0002');
      doc.body.appendChild(banner);context.error=banner;
    }
    function retireWork(context,session){
      stopBackground(session);
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
      else ensureBackground(context,session);
    }
    function ensureContext(reader){
      if(contexts.has(reader)){const existing=contexts.get(reader);existing.attachPDF?.();return existing;}
      const context={reader,buttons:new Set(),toolbarSlot:null,toolbarControlsAttached:false,session:null,keyWindows:new Map(),error:null};contexts.set(reader,context);
      const ownsContext=()=>!disposed&&contexts.get(reader)===context;
      const attach=win=>{
        if(!win||context.keyWindows.has(win)||!ownsContext())return;
        const handler=event=>{if(ownsContext()&&!event.defaultPrevented&&!event.repeat&&event.altKey&&event.shiftKey&&!event.ctrlKey&&!event.metaKey&&event.code==='KeyX'&&active(reader)){event.preventDefault();event.stopImmediatePropagation();void toggle(reader,{translationAction:true});}};
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
      const requestedWhole=options.whole===true,translationAction=options.translationAction===true;
      if(localVersions)options={whole:true,mode:'dual',...options};
      const explicitWhole=options.whole===true&&(requestedWhole||translationAction);
      let pdf;try{pdf=Core.resolvePDFContext(reader);if(typeof pdf.pdfDocument.getData!=='function')throw new PDF.PDFError('compatibility');}catch(error){report('context',error);showError(context,error);return;}
      const nativeContext={...pdf,reader:reader._internalReader,outerReader:reader,sourceView:reader._internalReader?._primaryView};
      const native=Native?.canMount?.(nativeContext)===true;
      if(nativeContext.sourceView?._options&&!native){showError(context,new PDF.PDFError('compatibility'));return;}
      const session={pdf,native,localGeometryOnly:false,localSourceSHA256:null,localAlignmentBinding:null,registrationNotice:null,pendingLegacyAdoption:null,registrationGeneration:0,alignment:null,layoutAlignment:null,layoutSignature:null,pageAlignments:new Map(),semanticPages:new Set(),semanticBinding:null,hydration:null,precision:null,translatedAnnotations:null,selectionGeneration:0,selectionPage:null,selectionViewport:null,pendingSelection:null,epoch:0,outputEpoch:0,layer:null,cancelMount:null,cancel:null,job:null,busy:true,pendingDisplay:false,progress:{stage:'preparing'},whole:options.whole===true,direction:options.direction==='zh-en'?'zh-en':'en-zh',mode:options.mode==='dual'?'dual':'mono',lastTranslatedMode:options.mode==='dual'?'dual':'mono',removers:[],data:null,dataPromise:null,outputs:new Map()};context.session=session;notify(context);
      const valid=()=>{if(!alive(reader)||context.session!==session)return false;try{return Core.resolvePDFContext(reader).pdfDocument===pdf.pdfDocument;}catch(_){return false;}};
      function finish(epoch){
        if(context.session!==session||session.epoch!==epoch)return;
        if(!valid()){report('stale');closeSession(context,{restorePosition:false});return;}
        session.busy=false;setProgress(context,session,null);
        adoptLegacyRegistration();refreshRegistrationNotice();ensureBackground(context,session);
      }
      function clearSelection(){
        session.selectionGeneration++;session.selectionPage=null;session.selectionViewport=null;session.pendingSelection=null;if(session.hydration?.owner){session.hydration.cancel?.();session.hydration=null;}
        if(session.interaction){session.interaction.latest=null;session.interaction.group=null;}
      }
      session.clearSelection=clearSelection;
      function interactionState(){
        if(!session.interaction||session.interaction.jobID!==session.job?.id)session.interaction={jobID:session.job?.id,latest:null,cache:new Map(),pending:new Map(),restored:new Set(),targetSHA256:null};
        return session.interaction;
      }
      function acceptSelection(value,run){
        const checked=PDF.validateSelectionLinks(value,run.jobID,value.page,(session.alignment||session.layoutAlignment)?.sourceSHA256);
        if(run.targetSHA256!==null&&run.targetSHA256!==checked.targetSHA256)throw new PDF.PDFError('response');run.targetSHA256=checked.targetSHA256;return checked;
      }
      function restoreSelectionLinks(page){
        if(session.localGeometryOnly||!session.native||!session.job||!Number.isInteger(page)||!session.job.sourcePages.includes(page)||typeof session.layer?.updateSelectionLinks!=='function')return;
        const run=interactionState();if(run.restored.has(page))return;run.restored.add(page);
        void transport.selectionLinks(run.jobID,page,session.job.sourcePages).then(value=>{if(!valid()||session.interaction!==run||session.job?.id!==run.jobID)return;session.layer?.updateSelectionLinks(acceptSelection(value,run));}).catch(error=>{if(valid()&&session.interaction===run){run.restored.delete(page);report('nativeSelection',error);}});
      }
      function requestSelection(page,query,options={}){
        const quiet=options.suppressStatus===true;
        if(session.localGeometryOnly){if(!quiet)session.layer?.setAnnotationStatus?.('unavailable');return quiet?Promise.resolve({errorCode:'selection_unavailable'}):'unavailable';}
        if(!quiet)session.background?.activity?.();
        if(!query||query.page!==page)return quiet?Promise.resolve({errorCode:'selection_unavailable'}):'unavailable';const run=interactionState(),key=JSON.stringify(query);
        if(!quiet){session.selectionPage=page;session.selectionViewport=session.layer?.currentSourcePage;run.latest=key;run.latestGeneration=session.selectionGeneration;run.group=null;}
        const current=()=>valid()&&session.interaction===run&&session.job?.id===run.jobID;
        const ownsStatus=()=>current()&&run.latest===key&&run.latestGeneration===session.selectionGeneration&&session.mode!=='original'&&session.layer?.visible===true;
        const selectionStatus=value=>value.link&&session.layer?.hasExactSelection?.()!==false?null:'unavailable';
        if(run.cache.has(key)){const value=run.cache.get(key);if(value.link||options.retry!==true){if(quiet)return Promise.resolve(value);session.layer?.updateSelectionLinks?.(value);const status=selectionStatus(value);session.layer?.setAnnotationStatus?.(status);return status===null?'ready':'unavailable';}}
        if(!quiet)session.layer?.setAnnotationStatus?.('preparing');if(run.pending.has(key))return quiet?run.pending.get(key):'pending';
        const releaseForeground=session.background?.beginForeground?.();
        const pending=transport.selectionAlignment(run.jobID,session.data,query,session.job.sourcePages,undefined,{retry:options.retry===true}).then(value=>{
          if(!current())return {errorCode:'stopped'};const checked=acceptSelection(value,run);run.cache.set(key,checked);
          // The native store can reuse a validated link after the selection
          // moves. A group publishes only its own current fragments: a stale
          // repaint could otherwise clear its loading state inside native UI.
          if((!quiet||ownsStatus())&&!run.group?.current?.()&&(checked.link||ownsStatus()))session.layer?.updateSelectionLinks?.(checked);
          if(ownsStatus())session.layer?.setAnnotationStatus?.(selectionStatus(checked));
          return checked;
        }).catch(error=>{if(ownsStatus()){session.layer?.setAnnotationStatus?.(selectionErrorStatus(error?.code));report('nativeSelection',error);}return {errorCode:error?.code||'failed'};}).finally(()=>{run.pending.delete(key);releaseForeground?.();});
        run.pending.set(key,pending);return quiet?pending:'started';
      }
      function selectionErrorStatus(code){return ({selection_busy:'busy',selection_timeout:'timeout',selection_invalid:'unavailable',selection_unavailable:'unavailable'})[code]||'failed';}
      function selectionGroupQueries(page,values,pages=[page]){
        if(!Array.isArray(values)||!values.length||values.length>8)return null;
        try{return Array.from(values).map(query=>{
          if(!query||!pages.includes(query.page)||typeof query.paragraph!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(query.paragraph)||!['source','target'].includes(query.side)||query.side!==values[0].side||typeof query.text!=='string'||!query.text.trim()||Array.from(query.text).length>2048||Array.from(query.text).some(c=>{const n=c.codePointAt(0);return n>=0xd800&&n<=0xdfff;})||!Array.isArray(query.rects)||!query.rects.length||query.rects.length>32)throw 0;
          const rects=Array.from(query.rects).map(r=>{if(!Array.isArray(r)||r.length!==4||!Array.from(r).every(n=>Number.isFinite(n)&&Math.abs(n)<=1000000)||r[2]<=r[0]||r[3]<=r[1])throw 0;return r.slice();});
          const selected={page:query.page,paragraph:query.paragraph,side:query.side,rects,text:query.text};let bytes=0;for(const c of JSON.stringify(selected)){const n=c.codePointAt(0);bytes+=n<=0x7f?1:n<=0x7ff?2:n<=0xffff?3:4;}if(bytes>8192)throw 0;return selected;
        });}catch(_){return null;}
      }
      function requestSelectionGroup(page,values,options={}){
        if(session.localGeometryOnly||!valid()||session.mode==='original'||session.layer?.visible!==true)return 'unavailable';
        session.background?.activity?.();
        const queries=selectionGroupQueries(page,values,options.pages),run=interactionState();
        if(!queries){run.latest=null;run.group=null;session.layer?.setAnnotationStatus?.('unavailable');return 'unavailable';}
        const key='group:'+JSON.stringify(queries),existing=run.group;
        if(existing?.key===key&&existing.current()&&!existing.finished)return 'pending';
        session.selectionPage=page;session.selectionViewport=session.layer?.currentSourcePage;run.latest=key;run.latestGeneration=session.selectionGeneration;
        const group={key,generation:session.selectionGeneration,epoch:session.epoch,finished:false};run.group=group;
        group.current=()=>valid()&&session.interaction===run&&session.job?.id===run.jobID&&session.epoch===group.epoch&&session.selectionGeneration===group.generation&&session.selectionPage===page&&run.group===group&&run.latest===key&&session.mode!=='original'&&session.layer?.visible===true;
        const finish=status=>{group.finished=true;if(group.current())session.layer?.setAnnotationStatus?.(status);return status===null?'ready':status;};
        const complete=()=>finish(session.layer?.hasExactSelection?.()===true?null:'unavailable');
        let first=0;for(;first<queries.length;first++){
          if(!group.current())return finish('unavailable');
          const cached=run.cache.get(JSON.stringify(queries[first]));if(!cached||!cached.link&&options.retry===true)break;
          if(!cached.link)return finish('unavailable');session.layer?.updateSelectionLinks?.(cached);
          if(!group.current())return finish('unavailable');
        }
        if(first===queries.length)return complete();
        session.layer?.setAnnotationStatus?.('preparing');
        group.promise=(async()=>{
          for(let index=first;index<queries.length;index++){
            if(!group.current())return 'stopped';
            const checked=await requestSelection(queries[index].page,queries[index],{suppressStatus:true,retry:options.retry===true});
            if(!group.current())return 'stopped';
            if(checked?.errorCode){report('nativeSelection',new PDF.PDFError(checked.errorCode));return finish(selectionErrorStatus(checked.errorCode));}
            if(!checked?.link)return finish('unavailable');
            session.layer?.updateSelectionLinks?.(checked);if(!group.current())return 'stopped';if(index<queries.length-1)session.layer?.setAnnotationStatus?.('preparing');
          }
          return complete();
        })().catch(error=>{if(group.current()){report('nativeSelection',error);return finish(selectionErrorStatus(error?.code));}return 'stopped';}).finally(()=>{group.finished=true;});
        return 'started';
      }
      function requestPrecision(page,options={}){
        if(session.localGeometryOnly||!session.native||!session.job||!session.data||!Number.isInteger(page)||!session.job.sourcePages.includes(page))return 'unavailable';
        if(options.pages!==undefined&&(!Array.isArray(options.pages)||!options.pages.length||options.pages.length>2||options.pages[0]!==page||new Set(options.pages).size!==options.pages.length||options.pages.some(p=>!Number.isInteger(p)||!session.job.sourcePages.includes(p))||options.pages.length===2&&options.pages[1]!==page+1))return 'unavailable';
        const metadataPages=options.pages||[page],viewport=session.layer?.currentSourcePage,ownerPayload=options.hydrationOnly===true||Boolean(selectionGroupQueries(page,options.selections!==undefined?options.selections:options.selection?[options.selection]:[],metadataPages)),metadataOwner=options.explicit===true&&ownerPayload;
        if(metadataOwner&&Math.abs(session.job.sourcePages.indexOf(page)-session.job.sourcePages.indexOf(viewport))>1)return 'unavailable';
        if(options.hydrationOnly===true){
          if(!session.layoutAlignment)return session.layer?.hasExactSelection?.()===true?'ready':'unavailable';
          if((options.pages||[page]).every(item=>session.semanticPages.has(item))){const ready=session.layer?.hasExactSelection?.()===true;session.layer?.setAnnotationStatus?.(ready?null:'unavailable');return ready?'ready':'unavailable';}
          session.selectionPage=page;session.selectionViewport=viewport;session.pendingSelection={hydrationOnly:true,metadataOwner,pages:metadataPages.slice(),page,jobID:session.job.id,epoch:session.epoch,generation:session.selectionGeneration};session.layer?.setAnnotationStatus?.('preparing');hydrateAlignment(false,metadataPages,metadataOwner?page:null);return 'pending';
        }
        if(session.layoutAlignment&&(!session.alignment||!session.semanticPages.has(page)||Array.isArray(options.pages)&&options.pages.some(item=>!session.semanticPages.has(item)))){
          // Layout-only first paint can accept a deliberate selection before
          // the cached glyph mapping arrives. Retain that one query rather
          // than silently replacing it with passive whole-page preparation.
          const fragments=options.selections!==undefined?selectionGroupQueries(page,options.selections,metadataPages):null;
          if(options.selections!==undefined&&!fragments){session.pendingSelection=null;session.layer?.setAnnotationStatus?.('unavailable');return 'unavailable';}
          if(options.explicit===true&&(fragments||options.selection?.page===page&&typeof options.selection.text==='string')){
            session.selectionPage=page;session.selectionViewport=viewport;session.pendingSelection={page,metadataOwner,pages:metadataPages.slice(),...(fragments?{queries:fragments}:{query:JSON.parse(JSON.stringify(options.selection))}),retry:options.retry===true,jobID:session.job.id,epoch:session.epoch,generation:session.selectionGeneration};
          }
          if(session.hydration?.failed){if(options.explicit===true){hydrateAlignment(true,metadataPages,metadataOwner?page:null);return 'pending';}session.layer?.setAnnotationStatus?.('failed');return 'failed';}
          hydrateAlignment(false,metadataPages,metadataOwner?page:null);session.layer?.setAnnotationStatus?.('preparing');
          return 'pending';
        }
        if(options.selections!==undefined)return requestSelectionGroup(page,options.selections,options);
        if(options.selection)return requestSelection(page,options.selection,options);
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
            let alignment=await transport.upgradeAlignment(run.jobID,session.data,[page],session.job.sourcePages,cancel=>{if(watching())run.cancel=cancel;else cancel();},{probe:true,resultOnly:Boolean(session.layoutAlignment),...(units.length?{units}:{}),...(!session.layoutAlignment?{onPartial:async alignment=>{if(!watching())return;session.alignment=alignment;await session.layer?.updateAlignment?.(alignment);if(watching())status();}}:{})});if(session.layoutAlignment)alignment=await transport.pageAlignment(run.jobID,page,session.job.sourcePages,cancel=>{if(watching())run.cancel=cancel;else cancel?.();},{beforeAlignment:()=>session.background?.waitIdle?.()});
            if(!watching())return;rememberPageAlignment(page,alignment);if(session.layoutAlignment){session.semanticPages=new Set([page]);session.semanticBinding=null;}session.alignment=alignment;run.failed.delete(page);await session.layer?.updateAlignment?.(alignment,session.layoutAlignment?{pages:[page]}:undefined);if(watching()){bindSemanticAlignment();status();}
          }catch(error){
            if(watching()&&error?.code!=='stopped'){
              try{const alignment=await(session.layoutAlignment?transport.pageAlignment(run.jobID,page,session.job.sourcePages,()=>{},{beforeAlignment:()=>session.background?.waitIdle?.()}):transport.alignment(run.jobID,session.job.sourcePages));if(!watching())return;rememberPageAlignment(page,alignment);if(session.layoutAlignment){session.semanticPages=new Set([page]);session.semanticBinding=null;}session.alignment=alignment;await session.layer?.updateAlignment?.(alignment,session.layoutAlignment?{pages:[page]}:undefined);if(watching())bindSemanticAlignment();}catch(_){}
              if(watching()){if(phraseReady(session.alignment,page))run.failed.delete(page);else run.failed.add(page);report('sentence',error);status();}
            }
          }finally{if(watching()){run.currentPage=null;run.cancel=null;run.running=false;}}
        })();return 'started';
      }
      function resumeFromToolbar(){
        if(!valid())return;
        if(session.localGeometryOnly){if(session.mode==='original')return instance.setMode(reader,session.lastTranslatedMode);session.layer?.setAnnotationStatus?.('unavailable');return;}
        const retried=session.layer?.retrySelection?.();if(retried===true||retried==='started')return;
        if(session.layoutAlignment&&!session.alignment){if(session.mode==='original')return instance.setMode(reader,session.lastTranslatedMode).then(()=>hydrateAlignment(true));hydrateAlignment(true);return;}
        const page=session.layer?.currentSourcePage;
        if(session.native&&!session.busy&&session.job?.state==='complete'&&session.layer?.visible&&Number.isInteger(page)&&!phraseReady(session.alignment,page))return requestPrecision(page,{explicit:true});
        return startFromResume();
      }
      const startFromResume=()=>{if(session.mode==='original'){session.mode=session.lastTranslatedMode;notify(context);}return start(session.whole);};
      function rememberPageAlignment(page,value){
        if(!session.layoutAlignment)return;
        if(value.sourceSHA256!==session.layoutAlignment.sourceSHA256)throw new PDF.PDFError('response');
        const layoutPages=value.pages.map(p=>({...p,paragraphs:p.paragraphs.map(({sentences,...row})=>row)}));session.layoutSignature??=JSON.stringify(session.layoutAlignment.pages);if(JSON.stringify(layoutPages)!==session.layoutSignature)throw new PDF.PDFError('response');
        session.pageAlignments.delete(page);session.pageAlignments.set(page,value);while(session.pageAlignments.size>3)session.pageAlignments.delete(session.pageAlignments.keys().next().value);
      }
      function bindSemanticAlignment(){
        const layout=session.layoutAlignment,value=session.alignment,view=session.layer?.nativeView;
        session.semanticBinding=layout&&value&&view&&typeof value.sourceSHA256==='string'&&/^[0-9a-f]{64}$/.test(value.sourceSHA256)&&value.sourceSHA256===layout.sourceSHA256?{jobID:session.job.id,epoch:session.epoch,sourceSHA256:value.sourceSHA256,layout,signature:session.layoutSignature,view}:null;
      }
      function hydrateAlignment(retry=false,requestedPages=null,ownerPage=null){
        if(!valid()||session.localGeometryOnly||session.paintEpoch!=null||!session.native||!session.layoutAlignment||!session.job||session.mode==='original'||!session.layer?.visible)return;
        const pending=session.pendingSelection;if(requestedPages===null&&pending?.metadataOwner&&pending.generation===session.selectionGeneration){requestedPages=pending.pages;ownerPage=pending.page;}
        const viewport=session.layer.currentSourcePage,owner=Number.isInteger(ownerPage),page=owner?ownerPage:viewport,pages=requestedPages||[page];
        if(!owner&&session.selectionPage!==null&&session.selectionPage!==viewport&&session.selectionViewport===viewport)return;
        if(!Number.isInteger(page)||!pages.length||pages.length>2||pages.some(item=>!Number.isInteger(item)||!session.job.sourcePages.includes(item))||!pages.includes(page))return;
        if(session.hydration&&session.hydration.page===page&&session.hydration.viewport===viewport&&(!session.hydration.owner||session.hydration.generation===session.selectionGeneration)&&pages.every(item=>session.hydration.pages.includes(item))&&!session.hydration.finished&&(!session.hydration.failed||!retry))return;
        if(!retry&&pages.every(item=>session.semanticPages.has(item)))return;
        session.hydration?.cancel?.();
        const run={jobID:session.job.id,epoch:session.epoch,page,viewport,owner,generation:session.selectionGeneration,pages:pages.slice(),failed:false,finished:false,cancel:null},sourcePages=session.job.sourcePages.slice(),layout=session.layoutAlignment;session.hydration=run;
        const current=()=>valid()&&session.hydration===run&&session.epoch===run.epoch&&session.job?.id===run.jobID&&session.mode!=='original'&&session.layer?.visible===true&&session.layer.currentSourcePage===viewport&&(!owner||session.selectionGeneration===run.generation);
        const idle=async()=>{if(!current())throw new PDF.PDFError('stopped');if(!run.owner)await session.background?.waitIdle?.();if(!current())throw new PDF.PDFError('stopped');};
        const load=()=>{run.cancel=null;if(!current())return;report('alignmentBegin');void(async()=>{
          await idle();
          for(const physical of pages){
            let value=session.pageAlignments.get(physical);
            if(!value||retry){value=await transport.pageAlignment(run.jobID,physical,sourcePages,cancel=>{if(current())run.cancel=cancel;else cancel?.();},{beforeAlignment:idle});if(!current())return;
              rememberPageAlignment(physical,value);
            }else{session.pageAlignments.delete(physical);session.pageAlignments.set(physical,value);}
          }
          if(!current())return;
          const values=pages.map(physical=>session.pageAlignments.get(physical));let value=values[0];
          if(values.length>1){const byPage=new Map(pages.map((physical,index)=>[physical,values[index].pages.find(p=>p.sourcePage===physical)]));value={...value,pages:layout.pages.map(p=>byPage.get(p.sourcePage)||p)};for(const key of ['sentencePages','sentencePartialPages','phrasePages','phraseExtractedPages'])if(values.some(item=>item[key]!==undefined))value[key]=[...new Set(values.flatMap(item=>item[key]||[]))];if(values.some(item=>item.phraseCoverage))value.phraseCoverage=Object.assign({},...values.map(item=>item.phraseCoverage||{}));for(const key of ['sentenceAlignmentRevision','phraseAlignmentRevision','phraseExtractionRevision']){const item=values.find(item=>item[key]!==undefined);if(item)value[key]=item[key];}if(values.some(item=>item.granularity==='sentence'))value.granularity='sentence';}
          session.semanticBinding=null;session.alignment=value;session.semanticPages=new Set(pages);session.layer?.updateAlignment?.(value,{pages:pages.slice()});bindSemanticAlignment();run.finished=true;ensureBackground(context,session);report('alignmentReady');pages.forEach(restoreSelectionLinks);
          const pending=session.pendingSelection;session.pendingSelection=null;
          if(pending&&pending.jobID===run.jobID&&pending.epoch===session.epoch&&pending.generation===session.selectionGeneration&&pending.page===page){
            if(pending.hydrationOnly){session.layer.setAnnotationStatus?.(session.layer.hasExactSelection?.()===true?null:'unavailable');return;}
            if(session.layer.hasExactSelection?.()===true)session.layer.setAnnotationStatus?.(null);
            else{const replanned=session.layer.retrySelection?.({retry:pending.retry===true});if(replanned!==true&&replanned!=='started'){if(pending.queries)requestSelectionGroup(page,pending.queries,{explicit:true,pages:pending.pages,retry:pending.retry});else requestSelection(page,pending.query,{explicit:true,retry:pending.retry});}}return;
          }
          const status=requestPrecision(page);session.layer?.setAnnotationStatus?.(status==='ready'?null:['idle','unavailable'].includes(status)?'idle':['failed','retry_wait','retry_limited'].includes(status)?status:'preparing');
        })().catch(error=>{if(current()&&error?.code!=='stopped'){run.failed=true;run.finished=true;session.layer?.setAnnotationStatus?.('failed');report('alignment',error);}});};
        const schedule=()=>{if(!current())return;const timer=timers.setTimer(load,0);run.cancel=()=>timers.clearTimer(timer);};
        const frameWindow=reader._iframeWindow;
        if(typeof frameWindow?.requestAnimationFrame==='function'){const callback=Components.utils?.exportFunction?Components.utils.exportFunction(schedule,frameWindow):schedule;const frame=frameWindow.requestAnimationFrame(callback);run.cancel=()=>frameWindow.cancelAnimationFrame?.(frame);}else schedule();
      }
      session.hydratePage=(page,refresh=false)=>{if(session.layer?.currentSourcePage===page)hydrateAlignment(refresh,[page]);};
      async function display(mode){
        if(!valid()||!session.job)return;
        // The job is independent of visibility. Defer PDF.js presentation in
        // hidden tabs, where animation frames may be suspended by Zotero.
        if(!active(reader)){session.pendingDisplay=true;return;}
        if(mode==='original'){session.hydration?.cancel?.();session.hydration=null;stopBackground(session);clearSelection();session.outputEpoch++;session.pendingDisplay=false;session.layer.showOriginal();return;}
        const adoption=activateLegacyLayout(),epoch=++session.outputEpoch,previousError=context.error;session.mode=mode;report('outputBegin');session.layer.prepareOutput();setProgress(context,session,{stage:'loading'});
        // The bilingual layout uses two real native views: the existing source
        // and this same local translated PDF. Retain its bytes and PDF worker
        // instead of downloading a second, physically combined PDF.
        const outputKind=session.native?'mono':mode,jobID=session.job.id;
        try{const [output,mapping]=await Promise.all([
            session.outputs.get(outputKind)||transport.output(session.job.id,outputKind),
            session.native&&!session.localGeometryOnly?(session.layoutAlignment?{value:session.layoutAlignment,complete:false}:session.alignment?{value:session.alignment,complete:true}:transport.layoutAlignment(session.job.id,session.job.sourcePages)):null
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
          const binding=session.semanticBinding,view=session.layer.nativeView,warm=Boolean(session.native&&view&&binding?.view===view&&binding.jobID===jobID&&binding.epoch===session.epoch&&binding.layout===session.layoutAlignment&&binding.signature===session.layoutSignature&&binding.sourceSHA256===session.layoutAlignment?.sourceSHA256&&binding.sourceSHA256===session.alignment?.sourceSHA256&&session.semanticPages.has(session.layer.currentSourcePage));
          // Retained current-page semantics stay in the native validator's
          // normal path; cold or changed bindings still paint layout first.
          session.paintEpoch=epoch;if(session.localGeometryOnly)await session.layer.showOutput(output,session.job.sourcePages,mode,null,{geometryOnly:true});else await session.layer.showOutput(output,session.job.sourcePages,mode,warm?session.alignment:session.layoutAlignment||session.alignment);if(session.paintEpoch===epoch)session.paintEpoch=null;
          if(valid()&&session.job?.id===jobID&&epoch===session.outputEpoch){if(session.layer.visible===true&&context.error===previousError){previousError?.remove();context.error=null;}if(session.layoutAlignment&&!warm){session.semanticPages.clear();session.semanticBinding=null;}restoreSelectionLinks(session.layer.currentSourcePage);hydrateAlignment();refreshRegistrationNotice();}
        }catch(error){if(session.paintEpoch===epoch)session.paintEpoch=null;report('output',error);if(valid()&&epoch===session.outputEpoch){session.semanticBinding=null;session.layer.restoreOriginal();
          if(adoption&&adoption.current()){session.localGeometryOnly=true;session.layoutAlignment=adoption.rollback.layout;session.alignment=adoption.rollback.alignment;session.layoutSignature=adoption.rollback.signature;session.semanticPages.clear();session.pendingLegacyAdoption=null;registrationFailed(adoption,error);if(session.mode!=='original')await display(session.mode);}
          else showError(context,error);
        }}
      }
      function refreshRegistrationNotice(){
        const notice=session.registrationNotice;if(notice&&valid()&&session.job?.id===notice.jobID&&session.epoch===notice.epoch&&session.mode!=='original'&&session.layer?.visible)session.layer.setStatus?.(notice.text);
      }
      function registrationFailed(run,error){
        if(!run.current())return;report('alignment',error);session.registrationNotice={jobID:run.jobID,epoch:run.epoch,text:run.accepted?'后台中英对应已登记；对应数据暂未载入，可点整份重试':'后台中英对应未能启动，可点整份重试'};refreshRegistrationNotice();
      }
      function activateLegacyLayout(){
        const run=session.pendingLegacyAdoption;if(!run?.layout||!run.current())return false;
        run.rollback={layout:session.layoutAlignment,alignment:session.alignment,signature:session.layoutSignature};session.layoutAlignment=run.layout;session.layoutSignature=null;session.alignment=null;session.semanticPages.clear();session.semanticBinding=null;session.localGeometryOnly=false;session.pendingLegacyAdoption=null;return run;
      }
      function adoptLegacyRegistration(){
        const run=session.pendingLegacyAdoption;if(!run||!run.current()||run.running||session.busy||session.mode==='original'||!session.layer?.visible)return;
        run.running=true;void(async()=>{
          if(!run.layout){const mapping=await transport.layoutAlignment(run.jobID,session.job.sourcePages);if(!run.current())return;
            const value=mapping.value;if(mapping.complete||value.provenance!=='pdf-glyph-candidates'||value.recoveryRevision!=='pdf-glyph-candidates-v1'||value.sourceSHA256!==run.sourceSHA||value.targetSHA256!==run.binding?.targetSHA256)throw new PDF.PDFError('response');run.layout=value;
          }
          if(!run.current()||session.busy||session.mode==='original'||!session.layer?.visible)return;
          const epoch=session.epoch;session.busy=true;setProgress(context,session,{stage:'loading'});
          try{let shown;do{shown=session.mode;await display(shown);}while(run.current()&&session.mode!==shown);}finally{finish(epoch);}
        })().catch(error=>{if(session.pendingLegacyAdoption===run)session.pendingLegacyAdoption=null;registrationFailed(run,error);}).finally(()=>{run.running=false;});
      }
      function registerFullTranslation(){
        const job=session.job;if(!job||job.state!=='complete'||job.sourcePages.length!==job.pageCount||job.sourcePages.some((page,index)=>page!==index)||!session.data)return Promise.resolve();
        if(session.alignmentRegistration?.jobID===job.id&&session.alignmentRegistration.epoch===session.epoch)return session.alignmentRegistration.promise;
        const run={jobID:job.id,epoch:session.epoch,generation:++session.registrationGeneration,geometryOnly:session.localGeometryOnly,sourceSHA:session.localSourceSHA256,binding:session.localAlignmentBinding,promise:null,accepted:false,running:false,layout:null};session.alignmentRegistration=run;
        run.current=()=>valid()&&session.job?.id===run.jobID&&session.epoch===run.epoch&&session.registrationGeneration===run.generation&&(!run.geometryOnly||session.localSourceSHA256===run.sourceSHA&&session.localAlignmentBinding===run.binding);
        session.registrationNotice=null;session.pendingLegacyAdoption=null;
        run.promise=Promise.resolve().then(()=>{
          if(run.geometryOnly&&(!run.binding||typeof run.sourceSHA!=='string'||!/^[a-f0-9]{64}$/.test(run.sourceSHA)))throw new PDF.PDFError('response');
          return transport.registerAlignmentWork(job.id,session.data,job.sourcePages,...(run.geometryOnly?[run.binding]:[]));
        }).then(value=>{if(!run.current())return value;if(value.eligible!==true)throw new PDF.PDFError('alignment_unavailable');run.accepted=true;session.alignmentWorkState=value;
          if(run.geometryOnly){session.pendingLegacyAdoption=run;adoptLegacyRegistration();}else{ensureBackground(context,session);session.background?.accept?.(value);session.background?.wake?.();}return value;
        }).catch(error=>registrationFailed(run,error)).finally(()=>{if(session.alignmentRegistration===run)session.alignmentRegistration=null;});
        return run.promise;
      }
      session.registerFullTranslation=registerFullTranslation;
      async function start(whole,action={}){
        if(!valid())return;
        const epoch=++session.epoch;
        const current=()=>valid()&&session.epoch===epoch;
        try{
          report('startBegin');clearSelection();session.busy=true;session.whole=whole;session.outputEpoch++;session.precision?.cancel?.();session.precision=null;session.interaction=null;session.translatedAnnotations=null;const retirement=retireWork(context,session);session.outputs.clear();session.alignment=null;session.layoutAlignment=null;session.layoutSignature=null;session.pageAlignments.clear();session.semanticPages.clear();session.semanticBinding=null;session.alignmentWorkState=null;session.localGeometryOnly=false;session.localSourceSHA256=null;session.localAlignmentBinding=null;session.registrationNotice=null;session.pendingLegacyAdoption=null;
          session.layer.prepareOutput();setProgress(context,session,{stage:'preparing'});context.error?.remove();context.error=null;
          await retirement;report('retired');if(!current())return;
          // User-initiated opening also needs the helper for cached layouts.
          // Background alignment reads never relaunch an app the user quit.
          await transport.connect(cancel=>{if(current())session.cancel=cancel;else cancel?.();});if(!current())return;
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
          session.localGeometryOnly=local?.alignmentKnownMissing===true;session.localSourceSHA256=local?.sourceSHA256||null;session.localAlignmentBinding=local?.alignmentBinding?{...local.alignmentBinding}:null;if(session.localGeometryOnly)session.layer?.setAlignmentProgress?.(null);
          if(whole&&action.fullTranslation===true&&(!local||action.explicitWhole===true))void registerFullTranslation();
          let localSaveFailed=false,localItem=local?.item||null,annotationSaveUnavailable=false;
          if(local){session.outputs.set('mono',PDF.validPDF(local.output));if(!session.native)session.outputs.set(session.mode,PDF.validPDF(local.output));report('localVersionReady');}
          else if(whole&&localVersions){
            try{localItem=await localVersions.find(reader,session.direction);localSaveFailed=!localItem;}catch(_){localSaveFailed=true;report('localVersionError');}
            if(!current())return;
          }
          if(session.native&&(localItem||whole&&localVersions)){
            try{
              if(!localItem)throw new PDF.PDFError('local_version_save');
              const store=await TranslatedAnnotations?.create?.({Zotero,item:localItem});if(!current())return;
              if(!store)throw new PDF.PDFError('local_version_save');session.translatedAnnotations=store;
            }catch(_){if(!current())return;annotationSaveUnavailable=true;report('translatedAnnotations',new PDF.PDFError('local_version_save'));}
          }
          let shown;do{shown=session.mode;await display(shown);}while(current()&&session.mode!==shown);
          if(current()&&localSaveFailed)showError(context,new PDF.PDFError('local_version_save'));
          if(current()&&annotationSaveUnavailable)session.layer?.setStatus?.('译文标注保存暂不可用');
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
          if(session.mode==='original'){session.mode=session.lastTranslatedMode;notify(context);}return start(whole,{fullTranslation:whole,explicitWhole:whole});
        };
        const layer=await mount(session.native?nativeContext:pdf,css,{
          current:()=>startFromToolbar(false),whole:()=>startFromToolbar(true),resume:()=>resumeFromToolbar(),
          stop:()=>{if(session.cancel){session.epoch++;void retireWork(context,session);session.busy=false;setProgress(context,session,null);}},exit:()=>closeSession(context),original:()=>instance.original(reader),mode:mode=>instance.setMode(reader,mode),
          direction:next=>{if(next===session.direction||!valid())return;session.direction=next;void start(session.whole);},
          toggleHover:()=>instance.setHoverEnabled(!hoverOn),
          failure:error=>{if(!session.native)report('render',error);if(valid())showError(context,error);},
          align:(page,options)=>requestPrecision(page,options),selectionChanged:clearSelection,page:page=>{if(session.selectionPage!==null&&(session.selectionViewport??session.selectionPage)!==page)clearSelection();session.background?.focusPage?.(page);hydrateAlignment(false,[page]);restoreSelectionLinks(page);return requestPrecision(page);},
          alignmentActivity:()=>session.background?.activity?.(),
          translatedAnnotations:()=>session.translatedAnnotations,
          readingInput:()=>{if(valid()&&session.native&&session.mode==='dual'&&session.layer?.scrollLinked===true)context.resume?.noteInput?.();}
        },{Components,installFigureView:(view,enabled)=>attachFigure(context,view,()=>active(reader)&&enabled()),reportDiagnostic:report,isCurrent:valid,lookupWord,hoverEnabled:()=>hoverOn&&active(reader),toolbarHost:()=>context.toolbarSlot,setCancel:cancel=>{session.cancelMount=cancel;}});
        if(!valid()){layer.dispose();if(context.session===session)closeSession(context,{restorePosition:false});return;}session.layer=layer;attachToolbarControls(context);setProgress(context,session,session.progress);void start(session.whole,{fullTranslation:session.whole,explicitWhole});
      }catch(error){report('mount',error);if(context.session!==session)return;closeSession(context);showError(context,error);}
    }
    const toolbar=event=>{
      if(disposed||event.reader?.type!=='pdf')return;const context=ensureContext(event.reader);
      if(context.toolbarSlot?.ownerDocument!==event.doc){
        context.toolbarSlot?.remove();for(const node of context.buttons)node.remove();context.buttons.clear();context.toolbarControlsAttached=false;
        const slot=element(event.doc,'span','askgpt-inline-toolbar-slot');slot.setAttribute('style','display:inline-flex;align-items:center;gap:3px;min-width:0;-webkit-app-region:no-drag');context.toolbarSlot=slot;
        const node=element(event.doc,'button','toolbar-button askgpt-inline-toolbar');node.setAttribute('type','button');node.setAttribute('tabindex','-1');node.addEventListener('click',()=>{void toggle(event.reader,{translationAction:true});});context.buttons.add(node);slot.appendChild(node);
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
        notifierID=Zotero.Notifier.registerObserver({notify(event,type,ids){if(type!=='tab')return;for(const [reader,context] of [...contexts]){if(event==='close'&&ids.includes(reader.tabID))removeContext(reader);else if(event==='select'){if(ids.includes(reader.tabID))resumePresentation(context);else{stopBackground(context.session);clearFigure(context);}}}}},['tab'],pluginID);
        for(const win of Zotero.getMainWindows())instance.attachMainWindow(win);
        for(const reader of Zotero.Reader._readers||[])if(reader.type==='pdf')ensureContext(reader);
        if(Sidebar&&Zotero.ItemPaneManager){sidebar=Sidebar.create({Zotero,pluginID,rootURI:dependencies.rootURI||'',actions:instance});sidebar.start();}
      },
      attachMainWindow(win){if(disposed||mainWindows.has(win))return;sidebar?.attachWindow(win);const handler=event=>{if(event.defaultPrevented||event.repeat||!event.altKey||!event.shiftKey||event.ctrlKey||event.metaKey||event.code!=='KeyX')return;const reader=Zotero.Reader.getByTabID(win.Zotero_Tabs?.selectedID);if(!reader||reader.type!=='pdf')return;event.preventDefault();event.stopImmediatePropagation();void toggle(reader,{translationAction:true});};win.addEventListener('keydown',handler,true);mainWindows.set(win,handler);},
      detachMainWindow(win){sidebar?.detachWindow(win);const handler=mainWindows.get(win);if(handler)win.removeEventListener('keydown',handler,true);mainWindows.delete(win);for(const reader of [...contexts.keys()])if(reader._window===win)removeContext(reader);},
      state,subscribe(callback){subscribers.add(callback);return()=>subscribers.delete(callback);},
      hoverEnabled(){return hoverOn;},
      resumeEnabled(){return resumeOn;},
      setResumeEnabled(value){if(typeof value!=='boolean')return resumeOn;resumeOn=value;try{Zotero.Prefs?.set?.('extensions.askgpt-inline.readingResume',value,true);}catch(_){}for(const context of contexts.values()){context.resume?.clear?.();notify(context);}return resumeOn;},
      setHoverEnabled(value){if(typeof value!=='boolean')return hoverOn;hoverOn=value;try{Zotero.Prefs?.set?.('extensions.askgpt-inline.hoverGloss',value,true);}catch(_){}for(const context of contexts.values()){context.hover?.clear();context.session?.layer?.clearHover?.();context.session?.layer?.refreshHover?.();notify(context);}return hoverOn;},
      async translate(reader,options={}){if(!active(reader))return;const session=contexts.get(reader)?.session;if(!session)return toggle(reader,{...options,translationAction:true});if(session.busy||!session.layer)return;const direction=options.direction==='zh-en'?'zh-en':'en-zh',mode=options.mode==='mono'?'mono':options.mode==='dual'||localVersions?'dual':'mono',whole=options.whole===undefined?Boolean(localVersions):options.whole===true;
        const currentPage=Number.isInteger(session.layer?.currentSourcePage)?session.layer.currentSourcePage:session.pdf.viewer.currentPageNumber-1;
        if(session.native&&session.job?.state==='complete'&&direction===session.direction&&whole===session.whole&&(whole||session.job.sourcePages.includes(currentPage))){await instance.setMode(reader,mode);if(whole)void session.registerFullTranslation?.();return;}
        session.direction=direction;session.mode=mode;session.lastTranslatedMode=mode;return session.start(whole,{fullTranslation:whole,explicitWhole:whole});},
      async setMode(reader,mode){
        if(!active(reader)||!['original','mono','dual'].includes(mode))return;const context=contexts.get(reader),session=context?.session;if(!session)return;
        context.resume?.flush?.();context.resume?.clear?.();
        context.hover?.clear();session.layer?.clearHover?.();
        if(mode==='original'){
          if(!session.native||!session.layer?.showOriginal){closeSession(context);return;}
          session.hydration?.cancel?.();session.hydration=null;session.paintEpoch=null;stopBackground(session);session.clearSelection?.();session.outputEpoch++;session.mode='original';session.pendingDisplay=false;session.layer.showOriginal();notify(context);return;
        }
        if(mode===session.mode&&!session.busy&&!session.pendingDisplay&&session.layer?.visible)return;
        session.mode=mode;session.lastTranslatedMode=mode;notify(context);
        if(!session.busy&&!session.job)return session.start(session.whole);
        if(!session.busy&&session.job){const epoch=session.epoch;session.busy=true;setProgress(context,session,{stage:'loading'});
          try{
            await transport.connect(cancel=>{if(session.valid()&&session.epoch===epoch)session.cancel=cancel;else cancel?.();});
            if(!session.valid()||session.epoch!==epoch||session.mode==='original')return;
            let shown;do{shown=session.mode;await session.display(shown);}while(session.valid()&&session.mode!==shown);
          }catch(error){if(session.valid()&&session.epoch===epoch&&session.mode!=='original'&&error?.code!=='stopped'){session.layer.restoreOriginal();showError(context,error);}}
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
