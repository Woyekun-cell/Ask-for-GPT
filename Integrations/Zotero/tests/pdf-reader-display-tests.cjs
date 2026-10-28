'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module'),test=path.join(__dirname,'pdf-native-view-tests.cjs'),helpers={exports:{}};
new Function('require','module','exports','__dirname',fs.readFileSync(test,'utf8').split('(async()=>{')[0]+'\nmodule.exports={fixture,alignment};')(createRequire(test),helpers,helpers.exports,__dirname);
const {fixture}=helpers.exports;
(async()=>{
 const f=await fixture({},({reader,source})=>{Object.assign(reader._state,{lightTheme:{id:'snow',background:'#eceff4',foreground:'#333333'},darkTheme:null,colorScheme:'light'});Object.assign(source._options,{lightTheme:null,colorScheme:'dark'});});
 try{
  await f.show([0],'dual');const options=f.layer.nativeView._options;
  assert.deepEqual(options.lightTheme,f.reader._state.lightTheme);assert.equal(options.darkTheme,null);assert.equal(options.colorScheme,'light');
  await f.flush();for(const lane of ['source','target']){
   (lane==='source'?f.source:f.layer.nativeView)._iframeWindow.emit('pointerdown',{button:0});
   const sourceCount=f.source.calls.filter(x=>x[0]==='fitWidth').length,targetCount=f.layer.nativeView.calls.filter(x=>x[0]==='fitWidth').length;
   f.layer.menu.allNodes().find(n=>n.getAttribute('title')==='Fit width · 适合宽度').emit('click');await f.flush();
   assert.equal(f.source.calls.filter(x=>x[0]==='fitWidth').length,sourceCount+1);assert.equal(f.layer.nativeView.calls.filter(x=>x[0]==='fitWidth').length,targetCount+1);
  }
  assert.equal(f.writes.length,0);console.log('PASS current theme at creation and fit width from either bilingual lane');
 }finally{f.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
