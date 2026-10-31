const assert = require('node:assert/strict');
const security = require('../content/connection-security.js');
const adapter = require('../content/inline.js');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
let checks = 0;
function fixture(os = 'Darwin') {
  const requests = [], reads = [], directoryKeys = [];
  const file = {path: os === 'WINNT' ? 'C:\\Users\\测试 用户\\AppData\\Roaming' : '/Users/example', permissions:0o600, fileSize:240,
    clone(){return {...this};}, append(part){this.path += (os === 'WINNT' ? '\\' : '/') + part;},
    exists:()=>true, isFile:()=>true, isSymlink:()=>false};
  const dependencies = {Services:{appinfo:{OS:os},dirsvc:{get(key){directoryKeys.push(key);return file;}}},
    Components:{interfaces:{nsIFile:{}}},
    readText:async path=>{reads.push(path);return JSON.stringify({version:1,endpoint:'http://127.0.0.1:43792',token:'t'.repeat(64)});},
    Zotero:{HTTP:{request(...args){requests.push(args);throw Error('unexpected HTTP');}}}};
  return {file,dependencies,directoryKeys,requests,reads};
}
(async()=>{
  const scope={globalThis:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../content/connection-security.js'),'utf8'),scope);
  assert.equal(typeof scope.AskGPTConnectionSecurity?.readerDirectory,'function','bootstrap target must receive the security module even when globalThis is different');checks++;
  let f=fixture(); let directory=security.readerDirectory(f.dependencies);
  assert.equal(directory.path,'/Users/example/Library/Application Support/AskGPTReader');assert.deepEqual(f.directoryKeys,['Home']);checks++;
  f=fixture('WINNT');directory=security.readerDirectory(f.dependencies);
  assert.equal(directory.path,'C:\\Users\\测试 用户\\AppData\\Roaming\\AskGPTReader');assert.deepEqual(f.directoryKeys,['AppData']);checks++;
  f=fixture('WINNT');f.file.permissions=0o600;
  await assert.rejects(adapter.createPDFTransport(f.dependencies).start(new TextEncoder().encode('%PDF-1.7\n'),{pages:'1',source:'en',target:'zh-Hans'},()=>{}));
  assert.equal(f.requests.length,0);assert.equal(f.reads.length,0,'Unix mode bits must never authorize Windows token reads without native ACL verification');checks++;
  f=fixture();f.file.permissions=0o644;
  await assert.rejects(security.withPrivateFile(f.dependencies,f.file,f.dependencies.readText),{code:'permissions'});assert.equal(f.reads.length,0);checks++;
  f=fixture();f.file.isSymlink=()=>true;
  await assert.rejects(security.withPrivateFile(f.dependencies,f.file,f.dependencies.readText),{code:'permissions'});assert.equal(f.reads.length,0);checks++;
  f=fixture();f.file.fileSize=4097;
  await assert.rejects(security.withPrivateFile(f.dependencies,f.file,f.dependencies.readText),{code:'permissions'});assert.equal(f.reads.length,0);checks++;
  console.log(JSON.stringify({status:'PASS',checks}));
})().catch(error=>{console.error(error);process.exitCode=1;});
