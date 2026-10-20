const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const {createFakeWPS} = require('./fake-wps.cjs');
async function setup(options) {const fake = createFakeWPS(options); const {createWPSHost} = await import(pathToFileURL(path.join(__dirname, '../wps/wps-host.js'))); const host = createWPSHost({Application: fake.Application}); await host.initialize(); return {fake, host};}
const issue = (snapshot, original = 'are', replacement = 'is', start = snapshot.rawText.indexOf(original)) => ({snapshot, issue: {id:'i', category:'grammar', original, replacement, reason:'agreement', range:{start,length:original.length},requiresAuthorConfirmation:false}});

test('WPS always states sidebar/manual mode; neither viewport nor cursor-page is advertised', async () => {
  const {host} = await setup(); assert.equal(host.capabilities.annotations, false); assert.equal(host.capabilities.visiblePages, false); assert.equal(host.capabilities.cursorPage, false); assert.equal(host.capabilities.automaticCheck, false); assert.match(host.capabilities.message, /侧栏.*下划线.*主动检查/);
  for (const mode of ['visiblePages', 'cursorPage']) {const scope = await host.captureScope(mode); assert.equal(scope.scope, 'activeParagraph'); assert.deepEqual(scope.pageIndices, []);}
});
test('capture preserves raw Unicode/whitespace and limits selection to exact source bounds', async () => {
  const {host} = await setup({paragraphs:['Before.\r', '  😀e\u0301 are here.  \r', 'After.\r'],active:1,selection:[7,10]}); const {snapshots:[s]} = await host.captureScope('selection');
  assert.equal(s.rawText, '  😀e\u0301 are here.  \r'); assert.deepEqual(s.targetRange,{start:7,length:3}); assert.equal(s.contextBefore,'Before.\r'); assert.equal(s.contextAfter,'After.\r'); assert.equal(s.snapshotHash.length,64); assert.equal(s.contextHash.length,64); assert.equal(typeof s.revision,'string');
});
test('empty/cross-paragraph/other-story and oversized selections fail explicitly', async () => {
  for (const options of [{selection:[0,0]}, {selection:[0,25]}, {selection:[0,3],storyType:7}, {paragraphs:['a'.repeat(4001)+'\r'],selection:[0,3]}]) {const {host} = await setup(options); await assert.rejects(host.captureScope('selection'), /selection|选|story|正文|范围|scope/i);}
});
test('exact minimal range replacement preserves surrounding source and tracking setting', async () => {
  const {host,fake} = await setup(); const s = (await host.captureScope('activeParagraph')).snapshots[0]; await host.applyIssue(issue(s));
  assert.equal(fake.state.paragraphs[0],'The result is clear.\r'); assert.deepEqual(fake.state.replacements,[{start:11,end:14,text:'is'}]); assert.equal(fake.document.TrackRevisions,true); await assert.rejects(host.applyIssue(issue(s)),/stale/i);
});
test('duplicate words use source offset; a forged range cannot select first matching text', async () => {
  const {host,fake} = await setup({paragraphs:['are are\r']}); const s = (await host.captureScope('activeParagraph')).snapshots[0]; await host.focusIssue(issue(s,'are','is',4)); assert.deepEqual(fake.state.selected,[{start:4,end:7}]); await host.applyIssue(issue(s,'are','is',4)); assert.equal(fake.state.paragraphs[0],'are is\r');
});
test('fresh original, context, document, hash and transport-independent anchor prevent stale writes', async () => {
  for (const change of ['text','context','document','hash','target','protected']) {const {host,fake} = await setup(); const s = (await host.captureScope('activeParagraph')).snapshots[0]; const e = issue({...s,requestID:'transport-id'});
    if(change==='text') fake.state.paragraphs[0]='The result was clear.\r'; if(change==='context') fake.state.paragraphs[1]='Changed.\r'; if(change==='document') fake.switchDocument(); if(change==='hash') e.snapshot.snapshotHash='forged'; if(change==='target') e.snapshot.targetRange={start:0,length:3}; if(change==='protected') e.snapshot.protectedRanges=[{start:11,length:3}];
    await assert.rejects(host.applyIssue(e),/stale|document|target|保护/i); assert.equal(fake.state.replacements.length,0);
  }
  const {host,fake} = await setup(); const s=(await host.captureScope('activeParagraph')).snapshots[0]; await host.applyIssue(issue({...s,requestID:'new-request'})); assert.equal(fake.state.replacements.length,1);
});
test('fields, mixed formatting, formulae, controls and unreadable formats stay preview-only without blanket language suppression', async () => {
  for(const options of [{fields:[{start:11,length:3}]},{fieldsUnknown:true},{xml:'<w:p><w:r><w:t>The result </w:t></w:r><w:r><w:t>are clear.</w:t></w:r></w:p>'},{xml:'<w:p><w:r><w:t>are</w:t><m:oMath/></w:r></w:p>'},{xml:undefined,parentControl:true},{xml:''},{controls:1}]) {
    const {host,fake}=await setup(options); const s=(await host.captureScope('activeParagraph')).snapshots[0]; assert.equal((await host.getIssueActions(issue(s))).canApply,false); await host.focusIssue(issue(s)); await assert.rejects(host.applyIssue(issue(s)),/preview|保护|格式/i); assert.equal(fake.state.replacements.length,0);
    if(!options.fields) assert.deepEqual(s.protectedRanges,[]); else assert.deepEqual(s.protectedRanges,[{start:11,length:3}]);
  }
});
test('fresh read-only, document protection and final mutation prevent every write', async () => {
  for (const kind of ['readOnly','protection','unknownPermission','mutation']) {const {host,fake}=await setup();const s=(await host.captureScope('activeParagraph')).snapshots[0]; if(kind==='readOnly')fake.document.ReadOnly=true;if(kind==='protection')fake.document.ProtectionType=3;if(kind==='unknownPermission')delete fake.document.ReadOnly;if(kind==='mutation')fake.state.onXML=()=>{fake.state.paragraphs[0]='Someone typed a new sentence.\r';}; await assert.rejects(host.applyIssue(issue(s)),/preview|stale|权限|格式/i);assert.equal(fake.state.replacements.length,0);}
});
test('control-character or review-only suggestions cannot write; review-only can focus',async()=>{
  const {host,fake}=await setup();const s=(await host.captureScope('activeParagraph')).snapshots[0];for(const replacement of ['is\rnext','is\u0000','is\n'])await assert.rejects(host.applyIssue(issue(s,'are',replacement)),/replacement|control|preview/i);const e=issue(s,'are','are');e.issue.category='context';await host.focusIssue(e);await assert.rejects(host.applyIssue(e),/review|preview/i);assert.equal(fake.state.replacements.length,0);
});
test('selection scope cannot write outside selected text',async()=>{const {host,fake}=await setup({selection:[0,3]});const s=(await host.captureScope('selection')).snapshots[0];await assert.rejects(host.applyIssue(issue(s)),/outside|target/i);assert.equal(fake.state.replacements.length,0);});
test('ContentChange absence stays manual; event registration alone never claims Mac realtime verification',async()=>{
  for(const missingContentChange of [false,true]){const {host,fake}=await setup({missingContentChange});const events=[];const stop=await host.watch(event=>events.push(event));assert.equal(host.capabilities.automaticCheck,false);assert.equal(host.capabilities.paragraphEvents,false);assert.match(host.capabilities.message,/主动检查/);const s=(await host.captureScope('activeParagraph')).snapshots[0];if(!missingContentChange){await fake.emit('ContentChange');await assert.rejects(host.applyIssue(issue(s)),/stale/i);assert.ok(events.some(event=>event.type==='invalidated'));}await stop();assert.equal(fake.state.listeners.size,0);}
});
test('sidebar show/clear/dispose never writes document typography and releases only own event names',async()=>{
  const {host,fake}=await setup();const s=(await host.captureScope('activeParagraph')).snapshots[0];await host.watch(()=>{});await host.showIssues([issue(s)]);await host.clear();await host.dispose();assert.equal(fake.state.styleWrites,0);assert.equal(fake.state.replacements.length,0);assert.equal(fake.state.listeners.size,0);await assert.rejects(host.captureScope(),/disposed/);
});
test('bounded context never splits emoji or combining graphemes',async()=>{
  const {host}=await setup({paragraphs:['😀'.repeat(700)+'\r','The result are clear.\r','e\u0301'.repeat(700)+'\r'],active:1});const s=(await host.captureScope('activeParagraph')).snapshots[0];assert.equal(s.contextBefore,'😀'.repeat(499)+'\r');assert.equal(s.contextAfter,'e\u0301'.repeat(500));
});
test('local WPS ribbon callback opens only the fixed HTTPS shared taskpane and reuses its pane',()=>{
  const fake=createFakeWPS();const context={Application:fake.Application};vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../wps/main.js'),'utf8'),context);context.AskGPTWritingOpen();context.AskGPTWritingOpen();assert.equal(fake.state.panes.length,1);assert.equal(fake.state.panes[0].URL,'https://localhost:43793/shared/taskpane.html?host=wps');assert.equal(fake.state.panes[0].Visible,true);
});
test('a newer capture retires an old revision even after source is undone to its original text',async()=>{
  const {host,fake}=await setup();const first=(await host.captureScope('activeParagraph')).snapshots[0];fake.state.paragraphs[0]='The result was clear.\r';const changed=(await host.captureScope('activeParagraph')).snapshots[0];assert.equal(changed.blockID,first.blockID);assert.notEqual(changed.revision,first.revision);fake.state.paragraphs[0]=first.rawText;await assert.rejects(host.applyIssue(issue(first)),/stale/i);assert.equal(fake.state.replacements.length,0);
});
test('permission change during XML inspection is rechecked at the final write boundary',async()=>{
  const {host,fake}=await setup();const s=(await host.captureScope('activeParagraph')).snapshots[0];let reads=0;fake.state.onXML=()=>{if(++reads===4)fake.document.ReadOnly=true;};await assert.rejects(host.applyIssue(issue(s)),/preview|权限/i);assert.equal(fake.state.replacements.length,0);
});

test('a new manual capture with a different paragraph length retires older source anchors',async()=>{
  const {host,fake}=await setup();const first=(await host.captureScope('activeParagraph')).snapshots[0];
  fake.state.paragraphs[0]='The result was never clear.\r';await host.captureScope('activeParagraph');
  fake.state.paragraphs[0]=first.rawText;await assert.rejects(host.applyIssue(issue(first)),/stale/i);assert.equal(fake.state.replacements.length,0);
});
