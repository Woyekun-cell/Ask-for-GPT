const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const [web,output,work]=process.argv.slice(2);
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.pdf':'application/pdf','.json':'application/json','.wasm':'application/wasm'};
const server=http.createServer((req,res)=>{const p=path.join(web,decodeURIComponent(req.url.split('?')[0])==='/'?'index.html':decodeURIComponent(req.url.split('?')[0]));if(!p.startsWith(web+path.sep)||!fs.existsSync(p)){res.writeHead(404);res.end('missing');return;}res.writeHead(200,{'Content-Type':types[path.extname(p)]||'application/octet-stream'});fs.createReadStream(p).pipe(res);});
server.listen(0,'127.0.0.1',async()=>{
 let browser;
 try{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1480,height:940},deviceScaleFactor:1.5,colorScheme:'light'});
  const logs=[],externalRequests=[];page.on('pageerror',e=>logs.push(e.stack));page.on('console',m=>{if(m.type()==='error')logs.push(m.text());});
  await page.route('**/*',route=>{const url=route.request().url();if(url.startsWith(`http://127.0.0.1:${server.address().port}/`)||url.startsWith('data:')||url.startsWith('blob:'))route.continue();else {externalRequests.push(url);route.abort();}});
  await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'load'});
  try{await page.waitForFunction(()=>window.demoReady||window.demoFailure,{timeout:45000});}catch(e){fs.writeFileSync(path.join(work,'browser-errors.json'),JSON.stringify(logs,null,2));await page.screenshot({path:path.join(work,'failure.png')});throw e;}
  const failure=await page.evaluate(()=>window.demoFailure);if(failure)throw new Error(failure);
  await page.waitForTimeout(1000);
  await page.screenshot({path:path.join(output,'01-overview.png')});
  console.log('Rendered 01-overview.png');
  await page.evaluate(()=>{updateDemoState({whole:true,mode:'mono',busy:true,progress:{stage:'translating',completed:1,total:3}});return layer.showOutput(demoTranslated,[0,1,2],'mono',demoAlignment);});
  await page.evaluate(()=>{resetDemoPage();layer.nativeView._iframeWindow.PDFViewerApplication.pdfViewer.currentScaleValue='page-fit';layer.setProgress({stage:'translating',completed:1,total:3});});
  await page.waitForTimeout(500);await page.screenshot({path:path.join(output,'02-views.png')});console.log('Rendered 02-views.png');
  await page.evaluate(()=>{updateDemoState({whole:false,mode:'dual',busy:false,progress:null});return layer.showOutput(demoTranslated,[0,1,2],'dual',demoAlignment);});
  await page.evaluate(()=>{layer.setProgress(null);resetDemoPage();for(const v of [reader._primaryView,layer.nativeView])v._iframeWindow.PDFViewerApplication.pdfViewer.currentScaleValue='page-width';});
  await page.waitForTimeout(700);
  await page.screenshot({path:path.join(output,'01-overview.png')});console.log('Refreshed 01-overview.png after both panes settled');
  const precise=await page.evaluate(()=>prepareDemoPhrase());fs.writeFileSync(path.join(work,'rendered-glyph-alignment.json'),JSON.stringify(precise,null,2));
  await page.evaluate(()=>selectDemoPhrase());await page.waitForTimeout(350);await page.screenshot({path:path.join(output,'03-selection.png')});console.log('Rendered 03-selection.png');
  const paletteCount=await page.locator('.selection-popup .color-button').count();
  if(paletteCount!==8)throw Error('Expected native eight-color palette, got '+paletteCount);
  await page.locator('.selection-popup .color-button').nth(3).click();
  await page.evaluate(()=>{reader._primaryView._iframeWindow.getSelection().removeAllRanges();layer.nativeView._iframeWindow.getSelection().removeAllRanges();reader._primaryView._onSetSelectionPopup(null);});
  await page.waitForTimeout(350);await page.screenshot({path:path.join(output,'04-annotations.png')});console.log('Rendered 04-annotations.png');
  await page.evaluate(()=>layer.setScrollLinked(false));await page.locator('.askgpt-native-more').click();await page.waitForTimeout(200);
  await page.screenshot({path:path.join(output,'05-reading-tools.png')});console.log('Rendered 05-reading-tools.png');
  await page.getByRole('button',{name:'Figure and table navigation · 图表定位',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.askgpt-figure-status')?.textContent.includes('选择一侧'));
  await page.screenshot({path:path.join(output,'06-navigation.png')});console.log('Rendered 06-navigation.png');
  fs.writeFileSync(path.join(work,'native-inspect.json'),JSON.stringify(await page.evaluate(()=>({buttons:[...document.querySelectorAll('button')].map(x=>({text:x.textContent,title:x.title,class:x.className})),sourcePage:Object.keys(reader._primaryView._pdfPages),targetPage:Object.keys(layer.nativeView._pdfPages),sourceChars:reader._primaryView._pdfPages[0]?.chars.slice(0,90),targetChars:layer.nativeView._pdfPages[0]?.chars.slice(0,90)})),null,2));
  fs.writeFileSync(path.join(work,'browser-errors.json'),JSON.stringify({renderer:await browser.version(),externalRequests,logs,errors:await page.evaluate(()=>demoErrors),paletteCount,annotations:await page.evaluate(()=>reader._state.annotations.map(a=>({text:a.text,color:a.color,position:a.position})))},null,2));
  await browser.close();server.close();
 }catch(e){console.error(e.stack);if(browser)await browser.close();server.close();process.exitCode=1;}
});
