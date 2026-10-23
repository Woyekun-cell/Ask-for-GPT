const assert = require('node:assert/strict');
const PDF = require('../content/pdf-layout.js');
const DOM = require('./fake-dom.cjs');
let checks = 0;
async function check(name, run) { await run(); checks++; console.log('PASS ' + name); }
(async () => {
  await check('native readiness diagnostics name only the fixed failed wait phase', () => {
    for(const errorDetail of ['nativeInitialize','nativePaint']){
      const value=PDF.diagnostic('output',{name:'Error',code:'compatibility',errorDetail,message:'PRIVATE_TEXT_TOKEN',promise:'PRIVATE_TEXT_TOKEN'});
      assert.equal(value.errorDetail,errorDetail);assert(!JSON.stringify(value).includes('PRIVATE_TEXT_TOKEN'));
    }
    assert.equal(PDF.diagnostic('output',{errorDetail:'PRIVATE_TEXT_TOKEN'}).errorDetail,undefined);
  });
  await check('native lifecycle diagnostics retain only bounded resource counts', () => {
    const secret='PRIVATE_PDF_TEXT_TOKEN';
    for(const stage of ['nativeResourcesAttached','nativeResourcesReleased']){
      const value=PDF.diagnostic(stage,{name:'NativeResourceDiagnostic',code:'rendered',message:secret,resourceNumbers:{parentListeners:1,mediaListeners:1,pendingTimers:0,destroyRequests:1,text:secret,token:secret}});
      assert.equal(value.stage,stage);assert.equal(value.exception,'NativeResourceDiagnostic');
      assert.deepEqual(value.resourceNumbers,{parentListeners:1,mediaListeners:1,pendingTimers:0,destroyRequests:1});
      assert(!JSON.stringify(value).includes(secret));
    }
    const value=PDF.diagnostic('nativeResourcesReleased',{resourceNumbers:{parentListeners:Infinity,mediaListeners:-1,pendingTimers:10001,destroyRequests:NaN}});
    assert.deepEqual(value.resourceNumbers,{parentListeners:-1,mediaListeners:-1,pendingTimers:-1,destroyRequests:-1});
  });
  await check('native paint diagnostics contain only fixed bounded numeric geometry and queue state',()=>{
    const input={iframeWidth:800,iframeHeight:600,containerWidth:800,containerHeight:600,visiblePages:1,renderingState:2,canvasWidth:1600,canvasHeight:1200,documentHidden:0,readerFocused:1,updateInvoked:1,forceInvoked:1,loadingTaskPresent:1,documentPresent:1,documentPages:18,viewerPages:18,currentPage:4,frameReadyState:3,text:'PRIVATE_TEXT_TOKEN',url:'PRIVATE_TEXT_TOKEN',token:'PRIVATE_TEXT_TOKEN'},safe=PDF.diagnostic('nativeState',{name:'RenderSnapshot',code:'rendered',errorDetail:'nativePaint',paintNumbers:input});assert(safe.paintNumbers);assert.equal(safe.paintNumbers.iframeWidth,800);assert.equal(safe.paintNumbers.renderingState,2);assert.equal(Object.keys(safe.paintNumbers).length,18);for(const key of ['loadingTaskPresent','documentPresent','documentPages','viewerPages','currentPage','frameReadyState'])assert.equal(safe.paintNumbers[key],input[key]);assert(!JSON.stringify(safe).includes('PRIVATE_TEXT_TOKEN'));
    const invalid=PDF.diagnostic('nativeState',{paintNumbers:{iframeWidth:Infinity,iframeHeight:-1,renderingState:8,visiblePages:900000,documentHidden:2,loadingTaskPresent:2,documentPresent:-1,documentPages:2001,viewerPages:Infinity,currentPage:-2,frameReadyState:4}});assert.equal(invalid.paintNumbers.iframeWidth,0);assert.equal(invalid.paintNumbers.iframeHeight,0);assert.equal(invalid.paintNumbers.renderingState,-1);assert.equal(invalid.paintNumbers.visiblePages,0);assert.equal(invalid.paintNumbers.documentHidden,0);for(const key of ['loadingTaskPresent','documentPresent','documentPages','viewerPages','currentPage','frameReadyState'])assert.equal(invalid.paintNumbers[key],0);assert.equal(PDF.diagnostic('output',{paintNumbers:input}).paintNumbers,undefined);
  });
  await check('legacy cache provenance is complete, bounded and never inferred from an untrusted flag',()=>{
    const base={id:'fixture',state:'complete',pageCount:2,sourcePages:[0,1]},revision='pdf-layout-gpt-v5-aligned-visual-backend-'+'a'.repeat(64);
    const safe=PDF.validateStatus({...base,reusedLegacy:true,translationRevision:revision});assert.equal(safe.reusedLegacy,true);assert.equal(safe.translationRevision,revision);
    for(const fields of [{reusedLegacy:true},{reusedLegacy:true,translationRevision:'private'},{reusedLegacy:true,translationRevision:'pdf-layout-gpt-v7-context-paragraph'},{reusedLegacy:'true',translationRevision:revision},{reusedLegacy:true,translationRevision:revision,state:'running'}]){const value=PDF.validateStatus({...base,...fields});assert.equal(value.reusedLegacy,undefined);assert.equal(value.translationRevision,undefined);}
  });
  await check('figure input and detection timings retain fixed bounded numbers only',()=>{
    const value=PDF.diagnostic('figureInputTiming',{figureNumbers:{waitMilliseconds:17,cacheReady:1,inputKind:2,detectionMilliseconds:40,modelMilliseconds:30,operatorsMilliseconds:8,geometryMilliseconds:2,width:900,height:450,text:'PRIVATE'}});
    assert.equal(value.stage,'figureInputTiming');for(const [key,n] of Object.entries({waitMilliseconds:17,cacheReady:1,inputKind:2,detectionMilliseconds:40,modelMilliseconds:30,operatorsMilliseconds:8,geometryMilliseconds:2,width:900,height:450}))assert.equal(value.figureNumbers[key],n);assert(!JSON.stringify(value).includes('PRIVATE'));
    const invalid=PDF.diagnostic('figureInputTiming',{figureNumbers:{waitMilliseconds:60001,cacheReady:2,inputKind:3,width:Infinity}});assert.equal(invalid.figureNumbers.waitMilliseconds,-1);assert.equal(invalid.figureNumbers.cacheReady,-1);assert.equal(invalid.figureNumbers.inputKind,-1);assert.equal(invalid.figureNumbers.width,-1);
  });
  await check('progress accepts only bounded real phases and page counts', () => {
    assert.deepEqual(PDF.validateProgress({stage:'translating',completed:2,total:12,token:'secret'}),{stage:'translating',completed:2,total:12});
    assert.deepEqual(PDF.validateProgress({stage:'preparing'}),{stage:'preparing'});
    for (const value of [null, {}, {stage:'<script>'}, {stage:'translating',completed:13,total:12}, {stage:'translating',completed:1,total:0}]) assert.equal(PDF.validateProgress(value),null);
  });
  await check('failure diagnostics retain only a whitelisted reason and physical source page', () => {
    const value=PDF.validateStatus({id:'fixture',state:'failed',pageCount:20,sourcePages:[10],error:'batch_invalid',errorDetail:'formula',failedPage:11});
    assert.equal(value.errorDetail,'formula');assert.equal(value.failedPage,11);
    assert.match(PDF.errorMessage(Object.assign(new PDF.PDFError(value.error),value)),/第 11 页：公式/);
    const safe=PDF.diagnostic('start',{errorDetail:'secret source',failedPage:5001});
    assert.equal(safe.errorDetail,undefined);assert.equal(safe.failedPage,undefined);
    assert.equal(PDF.validateStatus({...value,errorDetail:'untrusted',failedPage:12}).failedPage,undefined);
  });
  await check('scientific content mismatch is distinct from a formula failure', () => {
    const value=PDF.validateStatus({id:'fixture',state:'failed',pageCount:12,sourcePages:[3],error:'batch_invalid',errorDetail:'content',failedPage:4});
    assert.equal(value.errorDetail,'content');assert.equal(PDF.diagnostic('start',value).errorDetail,'content');
    const message=PDF.errorMessage(Object.assign(new PDF.PDFError(value.error),value));assert.match(message,/数值/);assert(!message.includes('公式'));
  });
  await check('progress stays visible over the readable original and disappears on dispose', async () => {
    const f = DOM.pdfWindow();
    f.viewer.style.setProperty('visibility','visible');
    const layer = await PDF.mount({win:f.win,viewer:{currentPageNumber:1}},'',{stop(){}},{});
    layer.setProgress({stage:'translating',completed:2,total:12});
    const hud = f.win.document.body.allNodes().find(n=>n.className==='askgpt-pdf-progress');
    assert(hud); assert.equal(hud.hidden,false); assert(hud.textContent.includes('2 / 12'));
    assert.equal(f.viewer.style.getPropertyValue('visibility'),'visible');
    const bar=hud.allNodes().find(n=>n.tagName==='progress');
    assert.equal(bar.getAttribute('value'),'2'); assert.equal(bar.getAttribute('max'),'12');
    layer.setProgress({stage:'preparing'}); assert.equal(bar.getAttribute('value'),undefined);
    layer.setProgress(null); assert.equal(hud.hidden,true);
    layer.dispose(); assert.equal(hud.parentNode,null);
  });
  await check('progress cancellation remains available before translated output exists', async () => {
    const f=DOM.pdfWindow(); let cancelled=0;
    const layer=await PDF.mount({win:f.win,viewer:{currentPageNumber:1}},'',{exit(){cancelled++;}},{});
    layer.setProgress({stage:'preparing'});
    const cancel=f.win.document.body.allNodes().find(n=>n.getAttribute('aria-label')==='Cancel translation');
    assert(cancel); cancel.emit('click'); assert.equal(cancelled,1); layer.dispose();
  });
  console.log(JSON.stringify({status:'PASS',checks}));
})().catch(error=>{console.error(error);process.exitCode=1;});
