const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const scripts = path.join(root,'scripts');
const run = (name,args=[],options={}) => spawnSync('python3',[path.join(scripts,name),...args],{encoding:'utf8',...options});
const ID='931f421a-3efa-48bd-906a-dc3182d38f5b';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'askgpt-writing-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const home=path.join(dir,'home');fs.mkdirSync(home);return {dir,home,output:path.join(dir,'prepared'),wps:path.join(home,'Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons'),wef:path.join(home,'Library/Containers/com.microsoft.Word/Data/Documents/wef')};}
function prepare(f){return run('install-writing-addins',['prepare','--output',f.output,'--home',f.home]);}
function noHosts(f){const bin=path.join(f.dir,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'ps'),'#!/bin/sh\nexit 0\n',{mode:0o755});return {...process.env,PATH:bin+path.delimiter+process.env.PATH};}

test('packager requires one destination, copies only public runtime and validates XML source locations',t=>{
  const f=fixture(t);const target=path.join(f.dir,'runtime');assert.notEqual(run('package-writing-integrations').status,0);const result=run('package-writing-integrations',[target]);assert.equal(result.status,0,result.stderr);
  const manifest=JSON.parse(fs.readFileSync(path.join(target,'package-manifest.json')));assert.equal(manifest.packageID,'askgpt-writing');assert.equal(manifest.containsCredentials,false);assert.ok(fs.existsSync(path.join(target,'shared/taskpane.js')));assert.ok(fs.existsSync(path.join(target,'wps/main.js')));assert.equal(fs.existsSync(path.join(target,'tests')),false);
  const xml=fs.readFileSync(path.join(target,'word/manifest.xml'),'utf8');assert.match(xml,new RegExp(ID));assert.match(xml,/https:\/\/localhost:43793\/shared\/taskpane.html\?host=word/);assert.equal(fs.existsSync(path.join(target,'wps/index.html')),false);
  fs.writeFileSync(path.join(target,'connection.local.json'),'secret');assert.notEqual(run('package-writing-integrations',[target]).status,0);assert.equal(fs.readFileSync(path.join(target,'connection.local.json'),'utf8'),'secret');
});
test('packager ignores unlisted credential/test assets and refuses symlinked runtime sources',t=>{
  const f=fixture(t);const clone=path.join(f.dir,'source');fs.mkdirSync(path.join(clone,'scripts'),{recursive:true});fs.copyFileSync(path.join(scripts,'package-writing-integrations'),path.join(clone,'scripts/package-writing-integrations'));fs.cpSync(path.join(root,'Integrations/Writing'),path.join(clone,'Integrations/Writing'),{recursive:true});fs.writeFileSync(path.join(clone,'Integrations/Writing/shared/private.pem'),'PRIVATE KEY');fs.writeFileSync(path.join(clone,'Integrations/Writing/shared/connection.local.json'),'secret');
  const command=path.join(clone,'scripts/package-writing-integrations');const target=path.join(f.dir,'runtime');let result=spawnSync('python3',[command,target],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(fs.existsSync(path.join(target,'shared/private.pem')),false);assert.equal(fs.existsSync(path.join(target,'shared/connection.local.json')),false);
  const runtime=path.join(clone,'Integrations/Writing/shared/taskpane.js');fs.unlinkSync(runtime);fs.symlinkSync(path.join(root,'Integrations/Writing/shared/taskpane.js'),runtime);result=spawnSync('python3',[command,path.join(f.dir,'other')],{encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/symlink|symbolic/i);
});
test('prepare preserves real host files; own WPS entries alone change byte-for-byte and Word keeps plugin ID',t=>{
  const f=fixture(t);fs.mkdirSync(f.wps,{recursive:true});const foreign="  <!-- keep lexical form -->\n  <jsplugin name='other' version='9' type='et' url='https://other.invalid/' />\n";const original=`<?xml version="1.0" encoding="UTF-8"?>\n<jsplugins>\n${foreign}  <jsplugin name='askgpt-writing' type='wps' version='old' url='file://'/>\n</jsplugins>\n`;for(const name of ['jsplugins.xml','publish.xml'])fs.writeFileSync(path.join(f.wps,name),original);
  const result=prepare(f);assert.equal(result.status,0,result.stderr);for(const name of ['jsplugins.xml','publish.xml']){assert.equal(fs.readFileSync(path.join(f.wps,name),'utf8'),original);const merged=fs.readFileSync(path.join(f.output,'wps',name),'utf8');assert.ok(merged.includes(foreign));assert.equal((merged.match(/name="askgpt-writing"/g)||[]).length,1);assert.match(merged,/version="0.1.0"/);}
  assert.equal(fs.existsSync(f.wef),false);assert.match(fs.readFileSync(path.join(f.output,'word',ID+'.xml'),'utf8'),new RegExp(`<Id>${ID}</Id>`));assert.ok(fs.existsSync(path.join(f.output,'wps/askgpt-writing_0.1.0/main.js')));
});
test('install needs explicit TLS/closed-host attestations and refuses an actually running host',t=>{
  const f=fixture(t);assert.equal(prepare(f).status,0);for(const flags of [[],['--hosts-closed'],['--tls-trusted']]){const result=run('install-writing-addins',['install','--prepared',f.output,...flags]);assert.notEqual(result.status,0);assert.equal(fs.existsSync(f.wef),false);}
  const bin=path.join(f.dir,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'ps'),'#!/bin/sh\nprintf "/Applications/Microsoft Word.app/Contents/MacOS/Microsoft Word\\n"\n',{mode:0o755});const result=run('install-writing-addins',['install','--prepared',f.output,'--hosts-closed','--tls-trusted'],{env:{...process.env,PATH:bin+path.delimiter+process.env.PATH}});assert.notEqual(result.status,0);assert.match(result.stderr,/running|运行|退出/i);assert.equal(fs.existsSync(f.wef),false);
});
test('install into an isolated home makes exact backups and retains every foreign registration',t=>{
  const f=fixture(t);fs.mkdirSync(f.wps,{recursive:true});const original='<jsplugins>\n  <jsplugin name="foreign" type="wps" custom="unchanged"/>\n</jsplugins>\n';fs.writeFileSync(path.join(f.wps,'jsplugins.xml'),original);assert.equal(prepare(f).status,0);const result=run('install-writing-addins',['install','--prepared',f.output,'--hosts-closed','--tls-trusted'],{env:noHosts(f)});assert.equal(result.status,0,result.stderr);assert.ok(fs.readFileSync(path.join(f.wps,'jsplugins.xml'),'utf8').includes('  <jsplugin name="foreign" type="wps" custom="unchanged"/>\n'));assert.ok(fs.existsSync(path.join(f.wef,ID+'.xml')));const backups=fs.readdirSync(path.join(f.output,'backups'),{recursive:true}).filter(p=>String(p).endsWith('jsplugins.xml'));assert.equal(backups.length,1);assert.equal(fs.readFileSync(path.join(f.output,'backups',backups[0]),'utf8'),original);
});
test('stale preparation, foreign Word ID and malformed WPS config fail before host writes',t=>{
  const f=fixture(t);fs.mkdirSync(f.wps,{recursive:true});fs.writeFileSync(path.join(f.wps,'jsplugins.xml'),'<jsplugins/>');assert.equal(prepare(f).status,0);fs.writeFileSync(path.join(f.wps,'jsplugins.xml'),'<jsplugins><!-- user update --></jsplugins>');const result=run('install-writing-addins',['install','--prepared',f.output,'--hosts-closed','--tls-trusted'],{env:noHosts(f)});assert.notEqual(result.status,0);assert.match(result.stderr,/changed|stale|变化/i);assert.equal(fs.existsSync(f.wef),false);
  const g=fixture(t);fs.mkdirSync(g.wef,{recursive:true});fs.writeFileSync(path.join(g.wef,ID+'.xml'),'<OfficeApp><Id>somebody-else</Id></OfficeApp>');assert.notEqual(prepare(g).status,0);
  const h=fixture(t);fs.mkdirSync(h.wps,{recursive:true});fs.writeFileSync(path.join(h.wps,'jsplugins.xml'),'<broken>');assert.notEqual(prepare(h).status,0);assert.equal(fs.readFileSync(path.join(h.wps,'jsplugins.xml'),'utf8'),'<broken>');
});
test('a self-closing WPS registry retains root attributes while adding only our entry',t=>{
  const f=fixture(t);fs.mkdirSync(f.wps,{recursive:true});fs.writeFileSync(path.join(f.wps,'jsplugins.xml'),'<jsplugins custom="keep" />');const result=prepare(f);assert.equal(result.status,0,result.stderr);assert.match(fs.readFileSync(path.join(f.output,'wps/jsplugins.xml'),'utf8'),/custom="keep"/);
});

test('packaged taskpane includes the complete local module dependency graph',t=>{
  const f=fixture(t),target=path.join(f.dir,'runtime');const result=run('package-writing-integrations',[target]);assert.equal(result.status,0,result.stderr);
  const visited=new Set();
  function visit(file){
    if(visited.has(file))return;visited.add(file);assert.equal(fs.existsSync(file),true,`Missing runtime dependency: ${path.relative(target,file)}`);
    const source=fs.readFileSync(file,'utf8'),references=[...source.matchAll(/(?:src=["']|from\s*["']|import\s*\(\s*["'])(\.{1,2}\/[^"']+)["']/g)].map(match=>match[1]);
    for(const reference of references)visit(path.resolve(path.dirname(file),reference));
  }
  visit(path.join(target,'shared/taskpane.html'));
  assert.ok(visited.has(path.join(target,'word/native-document-service.js')));
});

test('packager rejects a shared runtime whose source differs from the reviewed HTTPS taskpane',t=>{
  for(const change of [
    xml=>xml.replace('id="Taskpane.Url" DefaultValue="https://localhost:43793/shared/taskpane.html?host=word"','id="Taskpane.Url" DefaultValue="https://foreign.invalid/taskpane.html"'),
    xml=>xml.replace('Runtime resid="Taskpane.Url" lifetime="long"','Runtime resid="Other.Url" lifetime="long"')
  ]){
    const f=fixture(t),clone=path.join(f.dir,'source');fs.mkdirSync(path.join(clone,'scripts'),{recursive:true});fs.copyFileSync(path.join(scripts,'package-writing-integrations'),path.join(clone,'scripts/package-writing-integrations'));fs.cpSync(path.join(root,'Integrations/Writing'),path.join(clone,'Integrations/Writing'),{recursive:true});
    const manifest=path.join(clone,'Integrations/Writing/word/manifest.xml');fs.writeFileSync(manifest,change(fs.readFileSync(manifest,'utf8')));
    const result=spawnSync('python3',[path.join(clone,'scripts/package-writing-integrations'),path.join(f.dir,'runtime')],{encoding:'utf8'});assert.notEqual(result.status,0);assert.equal(fs.existsSync(path.join(f.dir,'runtime')),false);
  }
});
