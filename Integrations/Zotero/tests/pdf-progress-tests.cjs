const assert = require('node:assert/strict');
const PDF = require('../content/pdf-layout.js');
const DOM = require('./fake-dom.cjs');
let checks = 0;
async function check(name, run) { await run(); checks++; console.log('PASS ' + name); }
(async () => {
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
