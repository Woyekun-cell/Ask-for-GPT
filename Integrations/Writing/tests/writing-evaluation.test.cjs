const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const script = path.join(root, 'scripts/writing-skill-eval');
const evaluation = () => require(script);
const copy = value => JSON.parse(JSON.stringify(value));
function result(item, issues = []) {
  return {requestID:'unit-'+item.id, snapshotHash:evaluation().sha256(item.input.rawText),
    skillVersion:'1.0.1', status:'completed', issues};
}
function issue(item, original, replacement, category='grammar') {
  return {id:'issue-1', original, replacement, category, reason:'修正主谓一致。',
    range:{start:item.input.rawText.indexOf(original),length:original.length}, requiresAuthorConfirmation:true};
}

test('frozen suites contain 12 calibration, 12 independent holdout and 6 clean cases with exact UTF16 anchors', () => {
  const suites = evaluation().loadSuites(root);
  assert.equal(suites.calibration.cases.length,12); assert.equal(suites.holdout.cases.length,12); assert.equal(suites.clean.cases.length,6);
  const cases = Object.values(suites).flatMap(s => s.cases);
  assert.equal(new Set(cases.map(c=>c.id)).size,30); assert.equal(new Set(cases.map(c=>c.input.rawText)).size,30);
  const unicode = cases.find(c=>c.id==='hold-09');
  assert.equal(unicode.input.rawText.slice(unicode.expected.issues[0].range.start, unicode.expected.issues[0].range.start+unicode.expected.issues[0].range.length),'was frozen');
  assert.ok(cases.some(c=>c.tags.includes('review-only'))); assert.ok(cases.some(c=>c.tags.includes('en-US'))); assert.ok(cases.some(c=>c.tags.includes('en-GB')));
});
test('default invocation validates only and never starts swift or codex', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'writing-eval-')); t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const marker = path.join(temporary,'called');
  for (const command of ['swift','swiftc','codex']) fs.writeFileSync(path.join(temporary,command),`#!/bin/sh\ntouch '${marker}'\nexit 99\n`,{mode:0o755});
  const run=spawnSync(process.execPath,[script],{encoding:'utf8',env:{...process.env,PATH:temporary+path.delimiter+process.env.PATH}});
  assert.equal(run.status,0,run.stderr); assert.equal(fs.existsSync(marker),false);
  const report=JSON.parse(run.stdout); assert.equal(report.mode,'validate'); assert.equal(report.modelCalls,0); assert.equal(report.cases,30);
});
test('fixture validation rejects split graphemes, incorrect expected anchors and editing protected spans', () => {
  const suites=evaluation().loadSuites(root);
  const broken=copy(suites); broken.holdout.cases[8].input.targetRange={start:1,length:1};
  assert.throws(()=>evaluation().validateSuites(broken),/grapheme/);
  const badAnchor=copy(suites); badAnchor.calibration.cases[0].expected.issues[0].range.start++;
  assert.throws(()=>evaluation().validateSuites(badAnchor),/anchor/);
  const protectedEdit=copy(suites); protectedEdit.calibration.cases[0].input.protectedRanges=[protectedEdit.calibration.cases[0].expected.issues[0].range];
  assert.throws(()=>evaluation().validateSuites(protectedEdit),/protected/);
});
test('scorer detects a valid correction and rejects wrong hashes, failed status and unsafe ranges', () => {
  const item=evaluation().loadSuites(root).holdout.cases[0];
  const good=result(item,[issue(item,'indicates','indicate')]);
  let score=evaluation().scoreCase(item,{result:good,elapsedSeconds:0.2});
  assert.equal(score.pass,true); assert.equal(score.detected,1); assert.equal(score.falsePositives,0); assert.equal(score.acceptableText,true);
  for (const changed of [{...good,snapshotHash:'0'.repeat(64)},{...good,status:'failed'}, {...good,issues:[{...good.issues[0],range:{start:1,length:2}}]}]) {
    score=evaluation().scoreCase(item,{result:changed,elapsedSeconds:0.2}); assert.equal(score.pass,false); assert.equal(score.structureValid,false);
  }
});
test('clean false positives and scientific literal drift remain visible even with valid result structure', () => {
  const item=evaluation().loadSuites(root).clean.cases[0];
  const edit=issue(item,'did not','did');
  const score=evaluation().scoreCase(item,{result:result(item,[edit]),elapsedSeconds:0.2});
  assert.equal(score.structureValid,true); assert.equal(score.falsePositives,1); assert.equal(score.fidelity.pass,false); assert.equal(score.pass,false);
  const number=issue(item,'0.27','0.01');
  assert.equal(evaluation().scoreCase(item,{result:result(item,[number]),elapsedSeconds:0.2}).fidelity.numericTokensPreserved,false);
});
test('context ambiguity requires an unchanged review-only author question', () => {
  const item=evaluation().loadSuites(root).holdout.cases[7];
  const query={...issue(item,'This treatment','This treatment','context'),reason:'这里指哪一种处理？'};
  assert.equal(evaluation().scoreCase(item,{result:result(item,[query]),elapsedSeconds:0.2}).pass,true);
  const guess={...query,replacement:'Heat treatment'};
  assert.equal(evaluation().scoreCase(item,{result:result(item,[guess]),elapsedSeconds:0.2}).pass,false);
  assert.equal(evaluation().scoreCase(item,{result:result(item,[{...query,reason:'可能存在歧义。'}]),elapsedSeconds:0.2}).pass,false);
});
test('replay refuses provenance mismatches and live execution requires explicit limited fixture IDs', () => {
  const suites=evaluation().loadSuites(root); const policy=evaluation().policyManifest(root);
  const manifest=evaluation().suiteManifest(root);
  assert.throws(()=>evaluation().validateRun({schemaVersion:1,fixtureHashes:{},policy,records:[]},suites,manifest,policy),/provenance/);
  for (const args of [['--live'],['--live','--ids','missing','--output','/tmp/unused.json'],['--live','--ids',Object.values(suites).flatMap(s=>s.cases).slice(0,7).map(c=>c.id).join(','),'--output','/tmp/unused.json']]) {
    const run=spawnSync(process.execPath,[script,...args],{encoding:'utf8'}); assert.notEqual(run.status,0); assert.match(run.stderr,/IDs|ids|six|6|fixture/);
  }
});
test('smoke defaults to offline validation and does not imply native, model, HTTPS or GUI execution', () => {
  const run=spawnSync(process.execPath,[path.join(root,'scripts/writing-smoke')],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr); const report=JSON.parse(run.stdout);
  assert.equal(report.mode,'validate'); assert.equal(report.modelCalls,0);
  assert.match(report.limitations.join(' '),/not.*GUI/i);
});
test('saved semantic failure returns nonzero and evidence files cannot be overwritten', t => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'writing-score-')); t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const suites=evaluation().loadSuites(root),item=suites.clean.cases[0];
  const input=path.join(temporary,'input.json'),output=path.join(temporary,'output.json');
  const bad=result(item,[issue(item,'0.27','0.01')]);
  fs.writeFileSync(input,JSON.stringify({schemaVersion:1,fixtureHashes:evaluation().suiteManifest(root),policy:evaluation().policyManifest(root),records:[{id:item.id,mode:item.mode,requestID:bad.requestID,result:bad,elapsedSeconds:0.1}]}));
  const run=spawnSync(process.execPath,[script,'--results',input,'--output',output],{encoding:'utf8'});
  assert.equal(run.status,1); const report=JSON.parse(fs.readFileSync(output));
  assert.equal(report.summary.passed,0);assert.equal(report.summary.fidelityPassed,0);assert.equal(report.modelCalls,0);
  const saved=fs.readFileSync(output,'utf8');
  assert.notEqual(spawnSync(process.execPath,[script,'--validate','--output',output],{encoding:'utf8'}).status,0);
  assert.equal(fs.readFileSync(output,'utf8'),saved);
});
