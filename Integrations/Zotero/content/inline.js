(function (root) {
  'use strict';
  const Core=root.AskGPTInlineCore||(typeof require==='function'?require('./inline-core.js'):null);
  const PDF=root.AskGPTPDFLayout||(typeof require==='function'?require('./pdf-layout.js'):null);
  const Native=root.AskGPTPDFNativeView||(typeof require==='function'?require('./pdf-native-view.js'):null);
  const Sidebar=root.AskGPTSidebar||(typeof require==='function'?require('./sidebar.js'):null);
  const ConnectionSecurity=root.AskGPTConnectionSecurity||(typeof require==='function'?require('./connection-security.js'):null);
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
  function create(dependencies){
    const {Zotero,Services,Components,css,pluginID}=dependencies;
    const timers={...dependencies,setTimer:dependencies.setTimer||((fn,ms)=>Zotero.getMainWindow().setTimeout(fn,ms)),clearTimer:dependencies.clearTimer||(id=>Zotero.getMainWindow()?.clearTimeout(id))};
    const transport=createPDFTransport(timers),contexts=new Map(),mainWindows=new Map();
    const subscribers=new Set();
    let disposed=false,notifierID=null,sidebar=null;
    const report=(stage,error)=>{try{void dependencies.reportDiagnostic?.(stage,error);}catch(_){}};
    const alive=reader=>!disposed&&!reader?._window?.closed;
    function active(reader){return alive(reader)&&(!reader.tabID||reader._window?.Zotero_Tabs?.selectedID===reader.tabID);}
    function updateToolbar(context){for(const node of context.buttons){const opened=Boolean(context.session);node.hidden=Boolean(context.session?.native&&context.toolbarControlsAttached);if(node.hidden)node.style.setProperty('display','none','important');else node.style.removeProperty('display');node.textContent=opened?'↩':'⇄';const title=(opened?'Original PDF · 恢复原 PDF':'Translate PDF · 保留版式翻译')+' · Option+Shift+X';node.setAttribute('title',title);node.setAttribute('aria-label',title);}}
    function attachToolbarControls(context){const layer=context.session?.native&&context.session.layer;context.toolbarControlsAttached=Boolean(layer?.attachToolbar?.(context.toolbarSlot));updateToolbar(context);}
    function progressValue(value){
      if(!value||!['preparing','translating','layout','loading'].includes(value.stage))return null;
      const result={stage:value.stage};
      if(value.stage==='translating'&&Number.isInteger(value.completed)&&Number.isInteger(value.total)&&value.total>0&&value.total<=2000&&value.completed>=0&&value.completed<=value.total){result.completed=value.completed;result.total=value.total;}
      return result;
    }
    function phraseReady(value,page){return value?.phraseAlignmentRevision==='pdf-phrase-semantic-v1'&&value.phraseExtractionRevision==='pdf-glyph-boundary-v2'&&value.phrasePages?.includes(page)===true&&value.phraseExtractedPages?.includes(page)===true&&PDF.sentenceCoverage(value.pages?.find(value=>value.sourcePage===page));}
    function state(reader){const session=contexts.get(reader)?.session;return {open:Boolean(session),original:session?.mode==='original',busy:Boolean(session?.busy),whole:Boolean(session?.whole),mode:(session?.mode==='original'?session.lastTranslatedMode:session?.mode)==='dual'?'dual':'mono',direction:session?.direction==='zh-en'?'zh-en':'en-zh',progress:session?.busy?progressValue(session.progress):null};}
    function notify(context){updateToolbar(context);const value=state(context.reader);for(const callback of subscribers){try{callback(context.reader,value);}catch(_){}}}
    function setProgress(context,session,value){if(context.session!==session)return;session.progress=progressValue(value);session.layer?.setProgress?.(session.progress);notify(context);}
    function showError(context,error){
      context.error?.remove();context.error=null;const text=PDF.errorMessage(error);if(!text||!alive(context.reader))return;
      let doc;try{doc=Core.resolvePDFContext(context.reader).win.document;}catch(_){return;}
      const banner=element(doc,'div','askgpt-pdf-error',text);banner.setAttribute('role','alert');
      banner.setAttribute('style','position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483100;max-width:calc(100% - 32px);padding:10px 14px;border:1px solid #9996;border-radius:10px;background:Canvas;color:CanvasText;font:13px -apple-system,sans-serif;box-shadow:0 4px 20px #0002');
      doc.body.appendChild(banner);context.error=banner;
    }
    function retireWork(context,session){
      const cancelling=session.cancel?.();session.cancel=null;const job=session.job;session.job=null;
      // Retirement belongs to one reader context. A slow DELETE for another paper
      // must never serialize a newly authorized translation.
      context.retiring=Promise.resolve(context.retiring).then(()=>cancelling).then(async()=>{if(job?.id&&job.state!=='complete')await transport.cancel(job.id);}).catch(()=>{});
      return context.retiring;
    }
    function closeSession(context,options={}){
      const session=context.session;if(!session)return;context.session=null;session.epoch++;session.outputEpoch++;
      session.precision?.cancel?.();session.precision=null;
      void retireWork(context,session);session.cancelMount?.();
      for(const remove of session.removers.splice(0)){try{remove();}catch(_){}}
      session.layer?.dispose(options.restorePosition!==false);notify(context);
    }
    function resumePresentation(context){
      if(!active(context.reader))return;const session=context.session;notify(context);
      if(session?.pendingDisplay&&!session.busy&&session.job&&session.layer){
        session.pendingDisplay=false;void instance.setMode(context.reader,session.mode);
      }
    }
    function ensureContext(reader){
      if(contexts.has(reader))return contexts.get(reader);
      const context={reader,buttons:new Set(),toolbarSlot:null,toolbarControlsAttached:false,session:null,keyWindows:new Map(),error:null};contexts.set(reader,context);
      const attach=win=>{
        if(!win||context.keyWindows.has(win)||disposed)return;
        const handler=event=>{if(!event.defaultPrevented&&!event.repeat&&event.altKey&&event.shiftKey&&!event.ctrlKey&&!event.metaKey&&event.code==='KeyX'&&active(reader)){event.preventDefault();event.stopImmediatePropagation();void toggle(reader);}};
        const onFocus=()=>resumePresentation(context);
        const onUnload=()=>removeContext(reader);
        win.addEventListener('keydown',handler,true);win.addEventListener('focus',onFocus);win.addEventListener('unload',onUnload);context.keyWindows.set(win,{handler,onFocus,onUnload});
      };
      attach(reader._window);attach(reader._iframeWindow);
      const attachPDF=()=>{if(disposed||!contexts.has(reader))return;try{attach(Core.resolvePDFContext(reader).win);}catch(_){}};
      const attachExistingToolbar=()=>{try{const doc=reader._iframeWindow?.document,host=doc?.querySelector?.('.toolbar .end > .custom-sections')||doc?.querySelector?.('.toolbar .end');if(!host)return;toolbar({reader,doc,append:node=>host.appendChild(node)});}catch(error){report('toolbar',error);}};
      attachPDF();attachExistingToolbar();reader._internalReader?._primaryView?.initializedPromise?.then(()=>{attachPDF();attachExistingToolbar();},()=>{});return context;
    }
    async function toggle(reader,options={}){
      if(!active(reader))return;const context=ensureContext(reader);context.error?.remove();context.error=null;
      if(context.session){const session=context.session;if(session.native&&session.layer?.showOriginal)return instance.setMode(reader,session.mode==='original'?session.lastTranslatedMode:'original');closeSession(context);return;}
      let pdf;try{pdf=Core.resolvePDFContext(reader);if(typeof pdf.pdfDocument.getData!=='function')throw new PDF.PDFError('compatibility');}catch(error){report('context',error);showError(context,error);return;}
      const nativeContext={...pdf,reader:reader._internalReader,outerReader:reader,sourceView:reader._internalReader?._primaryView};
      const native=Native?.canMount?.(nativeContext)===true;
      if(nativeContext.sourceView?._options&&!native){showError(context,new PDF.PDFError('compatibility'));return;}
      const session={pdf,native,alignment:null,precision:null,epoch:0,outputEpoch:0,layer:null,cancelMount:null,cancel:null,job:null,busy:true,pendingDisplay:false,progress:{stage:'preparing'},whole:options.whole===true,direction:options.direction==='zh-en'?'zh-en':'en-zh',mode:options.mode==='dual'?'dual':'mono',lastTranslatedMode:options.mode==='dual'?'dual':'mono',removers:[],data:null,dataPromise:null,outputs:new Map()};context.session=session;notify(context);
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
        const checked=PDF.validateSelectionLinks(value,run.jobID,value.page,session.alignment?.sourceSHA256);
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
        if(options.selection)return requestSelection(page,options.selection);
        const explicit=options.explicit===true,units=Array.isArray(options.units)?options.units.slice(0,8):[];
        let run=session.precision;
        const ready=phraseReady(session.alignment,page),status=()=>session.layer?.setAnnotationStatus?.(phraseReady(session.alignment,run.visiblePage)?null:run.failed.has(run.visiblePage)?'failed':'preparing');
        if(!run||run.jobID!==session.job.id){run={jobID:session.job.id,attempted:new Set(),failed:new Set(),history:new Map(),visiblePage:page,currentPage:null,running:false,cancel:null,generation:0,priority:null};session.precision=run;}
        const changed=run.visiblePage!==page;
        run.visiblePage=page;
        // Only the visible page owns a listener. Cancelling it does not cancel
        // the independent service task or discard successful checkpoints.
        if(changed){run.generation++;run.cancel?.();run.cancel=null;run.currentPage=null;run.running=false;run.priority=null;if(!run.failed.has(page))run.attempted.delete(page);}
        if(ready){if(changed||explicit||run.failed.delete(page))session.layer?.setAnnotationStatus?.(null);return 'ready';}
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
        const page=session.layer?.currentSourcePage;
        if(session.native&&!session.busy&&session.job?.state==='complete'&&session.layer?.visible&&Number.isInteger(page)&&!phraseReady(session.alignment,page))return requestPrecision(page,{explicit:true});
        return startFromResume();
      }
      const startFromResume=()=>{if(session.mode==='original'){session.mode=session.lastTranslatedMode;notify(context);}return start(session.whole);};
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
        try{const [output,alignment]=await Promise.all([
            session.outputs.get(outputKind)||transport.output(session.job.id,outputKind),
            session.native?(session.alignment||transport.alignment(session.job.id,session.job.sourcePages)):null
          ]);if(!valid()||session.job?.id!==jobID)return;
          session.outputs.set(outputKind,output);
          // A background precision upgrade may finish while another PDF mode
          // is downloading. Keep that newer mapping instead of the snapshot
          // captured when Promise.all started.
          session.alignment=session.alignment||alignment;
          if(epoch!==session.outputEpoch)return;
          if(!active(reader)){session.pendingDisplay=true;return;}
          session.pendingDisplay=false;report('outputReady');setProgress(context,session,{stage:'loading'});
          await session.layer.showOutput(output,session.job.sourcePages,mode,session.alignment);
          if(valid()&&session.job?.id===jobID&&epoch===session.outputEpoch)restoreSelectionLinks(session.layer.currentSourcePage);
        }catch(error){report('output',error);if(valid()&&epoch===session.outputEpoch){session.layer.restoreOriginal();showError(context,error);}}
      }
      async function start(whole){
        if(!valid())return;
        const epoch=++session.epoch;
        const current=()=>valid()&&session.epoch===epoch;
        try{
          report('startBegin');session.busy=true;session.whole=whole;session.outputEpoch++;session.precision?.cancel?.();session.precision=null;session.interaction=null;const retirement=retireWork(context,session);session.outputs.clear();session.alignment=null;
          session.layer.prepareOutput();setProgress(context,session,{stage:'preparing'});context.error?.remove();context.error=null;
          await retirement;report('retired');if(!current())return;
          if(!session.dataPromise)session.dataPromise=pdf.pdfDocument.getData();
          if(!session.data){const returned=await session.dataPromise;if(!current())return;session.data=PDF.copyOpenPDFData(returned,Components);}if(!current())return;
          const page=Number.isInteger(session.layer?.currentSourcePage)?session.layer.currentSourcePage+1:pdf.viewer.currentPageNumber;
          if(!Number.isInteger(page)||page<1||page>pdf.pageCount)throw new PDF.PDFError('compatibility');
          const reverse=session.direction==='zh-en';
          const job=await transport.start(session.data,{pages:whole?'all':String(page),source:reverse?'zh-Hans':'en',target:reverse?'en':'zh-Hans'},cancel=>{if(current())session.cancel=cancel;else cancel();},value=>{if(current())setProgress(context,session,value);});
          report('jobReady');
          if(!current()){void transport.cancel(job.id).catch(()=>{});return;}
          session.cancel=null;session.job=job;if(job.pageCount!==pdf.pageCount)throw new PDF.PDFError('response');
          let shown;do{shown=session.mode;await display(shown);}while(current()&&session.mode!==shown);
        }catch(error){report('start',error);if(current()){session.cancel=null;session.layer.restoreOriginal();showError(context,error);}}
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
        const startFromToolbar=whole=>{if(session.mode==='original'){session.mode=session.lastTranslatedMode;notify(context);}return start(whole);};
        const layer=await mount(session.native?nativeContext:pdf,css,{
          current:()=>startFromToolbar(false),whole:()=>startFromToolbar(true),resume:()=>resumeFromToolbar(),
          stop:()=>{if(session.cancel){session.epoch++;void retireWork(context,session);session.busy=false;setProgress(context,session,null);}},exit:()=>closeSession(context),original:()=>instance.original(reader),mode:mode=>instance.setMode(reader,mode),
          direction:next=>{if(next===session.direction||!valid())return;session.direction=next;void start(session.whole);},
          failure:error=>{if(!session.native)report('render',error);if(valid())showError(context,error);},
          align:(page,options)=>requestPrecision(page,options),page:page=>{restoreSelectionLinks(page);return requestPrecision(page);}
        },{Components,reportDiagnostic:report,isCurrent:valid,toolbarHost:()=>context.toolbarSlot,setCancel:cancel=>{session.cancelMount=cancel;}});
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
      const context=contexts.get(reader);if(!context)return;closeSession(context);context.error?.remove();
      for(const [win,callbacks] of context.keyWindows){try{win.removeEventListener('keydown',callbacks.handler,true);win.removeEventListener('focus',callbacks.onFocus);win.removeEventListener('unload',callbacks.onUnload);}catch(_){}}
      for(const node of context.buttons)node.remove();context.toolbarSlot?.remove();context.toolbarSlot=null;context.keyWindows.clear();context.buttons.clear();contexts.delete(reader);
    }
    const instance={
      start(){
        Zotero.Reader.registerEventListener('renderToolbar',toolbar,pluginID);
        notifierID=Zotero.Notifier.registerObserver({notify(event,type,ids){if(type!=='tab')return;for(const [reader,context] of [...contexts]){if(event==='close'&&ids.includes(reader.tabID))removeContext(reader);else if(event==='select'&&ids.includes(reader.tabID))resumePresentation(context);}}},['tab'],pluginID);
        for(const win of Zotero.getMainWindows())instance.attachMainWindow(win);
        for(const reader of Zotero.Reader._readers||[])if(reader.type==='pdf')ensureContext(reader);
        if(Sidebar&&Zotero.ItemPaneManager){sidebar=Sidebar.create({Zotero,pluginID,rootURI:dependencies.rootURI||'',actions:instance});sidebar.start();}
      },
      attachMainWindow(win){if(disposed||mainWindows.has(win))return;sidebar?.attachWindow(win);const handler=event=>{if(event.defaultPrevented||event.repeat||!event.altKey||!event.shiftKey||event.ctrlKey||event.metaKey||event.code!=='KeyX')return;const reader=Zotero.Reader.getByTabID(win.Zotero_Tabs?.selectedID);if(!reader||reader.type!=='pdf')return;event.preventDefault();event.stopImmediatePropagation();void toggle(reader);};win.addEventListener('keydown',handler,true);mainWindows.set(win,handler);},
      detachMainWindow(win){sidebar?.detachWindow(win);const handler=mainWindows.get(win);if(handler)win.removeEventListener('keydown',handler,true);mainWindows.delete(win);for(const reader of [...contexts.keys()])if(reader._window===win)removeContext(reader);},
      state,subscribe(callback){subscribers.add(callback);return()=>subscribers.delete(callback);},
      async translate(reader,options={}){if(!active(reader))return;const session=contexts.get(reader)?.session;if(!session)return toggle(reader,options);if(session.busy||!session.layer)return;const direction=options.direction==='zh-en'?'zh-en':'en-zh',mode=options.mode==='dual'?'dual':'mono',whole=options.whole===true;
        const currentPage=Number.isInteger(session.layer?.currentSourcePage)?session.layer.currentSourcePage:session.pdf.viewer.currentPageNumber-1;
        if(session.native&&session.job?.state==='complete'&&direction===session.direction&&whole===session.whole&&(whole||session.job.sourcePages.includes(currentPage)))return instance.setMode(reader,mode);
        session.direction=direction;session.mode=mode;session.lastTranslatedMode=mode;return session.start(whole);},
      async setMode(reader,mode){
        if(!active(reader)||!['original','mono','dual'].includes(mode))return;const context=contexts.get(reader),session=context?.session;if(!session)return;
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
  if(typeof module!=='undefined')module.exports={create,createPDFTransport,mountPDFView:PDF.mount,pdfErrorMessage:PDF.errorMessage,readConnection};
})(this);
