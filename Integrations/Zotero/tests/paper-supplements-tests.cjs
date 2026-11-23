'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {create} = require('../content/paper-supplements.js');
let JSDOM;
for (const location of [path.resolve(__dirname, '../../../work/browser-inline-test/node_modules/jsdom'),
  path.resolve(__dirname, '../../../../github-release/Ask-for-GPT/work/browser-inline-test/node_modules/jsdom')]) {
  try { ({JSDOM} = require(location)); break; } catch (_) {}
}
if (!JSDOM) throw Error('Pinned test-only jsdom is required.');
const DOI = '10.1371/journal.pone.0000893', PMC = 'PMC1963317';
const XML = `<article xmlns:xlink="http://www.w3.org/1999/xlink"><front><article-meta>
<article-id pub-id-type="doi">${DOI}</article-id><article-id pub-id-type="pmc">1963317</article-id>
</article-meta></front><body><fig><graphic xlink:href="figure.png"/></fig><ext-link xlink:href="main.pdf"/></body>
<back><supplementary-material><label>Table S1</label><caption><title>Additional data</title></caption><media xlink:href="table-s1.csv"/></supplementary-material>
<supplementary-material><label>Supporting information</label><media xlink:href="support.pdf"/></supplementary-material>
<supplementary-material><media xlink:href="https://private.test/not-allowed.pdf"/></supplementary-material></back></article>`;
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'askgpt-supplement-test-'));
  const dom = new JSDOM('<!doctype html><html></html>');
  class File {
    constructor(value) { this.path = value; }
    clone() { return new File(this.path); }
    append(value) { this.path = path.join(this.path, value); }
    exists() { return fs.existsSync(this.path); }
    isSymlink() { return fs.lstatSync(this.path).isSymbolicLink(); }
    isFile() { return fs.statSync(this.path).isFile(); }
    get fileSize() { return fs.statSync(this.path).size; }
    get lastModifiedTime() { return fs.statSync(this.path).mtimeMs; }
    get leafName() { return path.basename(this.path); }
    createUnique(type, permissions) { assert.equal(type, 1); this.path = fs.mkdtempSync(this.path + '-'); fs.chmodSync(this.path, permissions); }
  }
  const values = new Map(), calls = [], imports = [], launched = [], extractions = [];
  const metadata = {DOI, url:'https://doi.org/' + DOI, title:'Original paper'};
  let nextID = 10, pickerAnswer = 0, pickerWait, selectedPaths = [], responseOverride;
  const archiveEntries = new Map([['assets/table-s1.csv', Buffer.from('sample,value\nA,7\n')], ['support.pdf', Buffer.from('%PDF-1.4\nsupplement')],
    ['main.pdf', Buffer.from('%PDF-1.4\nmain')], ['figure.png', Buffer.from([137,80,78,71,13,10,26,10])]]);
  const entryOverrides = new Map();
  const tags = new Map();
  function item(id, name, type, content, parentID = 1, title = name) {
    const ownDirectory = path.join(directory, String(id)); fs.mkdirSync(ownDirectory, {recursive:true});
    const filePath = path.join(ownDirectory, name); fs.writeFileSync(filePath, content);
    const fields = {title, url:''}; tags.set(id, new Set());
    const value = {id, key:String(id).padStart(8,'A'), libraryID:1, parentID, attachmentContentType:type, attachmentFilename:name,
      isAttachment:() => true, getField:name => fields[name] || '', setField(name,value) { fields[name] = value; },
      hasTag:name => tags.get(id).has(name), addTag:name => tags.get(id).add(name), async saveTx() {}, async getFilePathAsync() { return filePath; }};
    values.set(id, value); return value;
  }
  const main = item(2, 'original.pdf', 'application/pdf', '%PDF-1.4\nmain');
  const parent = {id:1,key:'PARENTAA',libraryID:1,isRegularItem:() => true,getField:name => metadata[name] || '',
    getAttachments:() => [...values.values()].filter(value => value.parentID === 1).map(value => value.id)};
  values.set(1, parent);
  const reader = {type:'pdf', itemID:2, _item:main, _window:{}};
  const library = {editable:true, filesEditable:true};
  const Zotero = {
    Items:{get:id => values.get(id)}, Libraries:{get:() => library}, File:{pathToFile:value => new File(value)},
    getTempDirectory:() => new File(directory), launchFile:async value => launched.push(value),
    Attachments:{async importFromFile(options) {
      imports.push({...options});
      const result = item(nextID++, path.basename(options.file), options.contentType, fs.readFileSync(options.file), options.parentItemID, options.title);
      assert.equal(result.libraryID, options.libraryID); return result;
    }},
    HTTP:{async request(method,url,options) {
      calls.push({method,url,options});
      if (responseOverride) return responseOverride(method,url,options);
      const payload = url.includes('/search?') ? JSON.stringify({resultList:{result:[{doi:DOI,pmcid:PMC,isOpenAccess:'Y'}]}})
        : url.endsWith('/fullTextXML') ? XML : Buffer.from('PK\x03\x04synthetic-fixture');
      const bytes = Uint8Array.from(Buffer.from(payload)); return {status:200,responseURL:url,response:bytes.buffer};
    }}
  };
  const IOUtils = {async read(value,{maxBytes} = {}) { return Uint8Array.from(fs.readFileSync(value).subarray(0,maxBytes)); },
    async write(value,bytes,options) { fs.writeFileSync(value,bytes,{flag:options.mode === 'create' ? 'wx' : 'w'}); },
    async remove(value,options) { fs.rmSync(value,{recursive:options.recursive,force:options.ignoreAbsent}); }};
  const deps = {Zotero,IOUtils,Components:{interfaces:{nsIFile:{DIRECTORY_TYPE:1}}},DOMParser:dom.window.DOMParser,TextDecoder,
    hashFile:(value,algorithm='SHA256') => crypto.createHash(algorithm.toLowerCase()).update(fs.readFileSync(value.path)).digest('hex'),
    hashBytes:(bytes,algorithm='MD5') => crypto.createHash(algorithm.toLowerCase()).update(bytes).digest('hex'),
    createFilePicker:() => ({modeOpenMultiple:3,returnOK:0,init(){},appendFilter(){},async show(){if(pickerWait) await pickerWait;return pickerAnswer;},get files(){return selectedPaths;}}),
    createZipReader:() => ({open(){},close(){},getEntry(name) { return {realSize:archiveEntries.get(name).length,isDirectory:false,permissions:0o100644,...entryOverrides.get(name)}; },
      findEntries() { const names=[...archiveEntries.keys()];let index=0;return {hasMore:() => index<names.length,getNext:() => names[index++]}; },
      extract(name,target) { extractions.push(name);fs.writeFileSync(target.path,archiveEntries.get(name)); }})};
  const api = create(deps);
  return {api,deps,reader,main,parent,metadata,library,values,calls,imports,launched,archiveEntries,entryOverrides,extractions,directory,item,
    setResponse:value => responseOverride=value,pick(value,answer=0,wait) {selectedPaths=value;pickerAnswer=answer;pickerWait=wait;},
    close(){dom.window.close();fs.rmSync(directory,{recursive:true,force:true});}};
}
async function using(operation) { const f=fixture();try { await operation(f); } finally { f.close(); } }

test('local supplemental list preserves source metadata and existing attachments without networking', () => using(async f => {
  f.item(3,'supporting.pdf','application/pdf','%PDF-1.4\nsupport','1');
  f.item(4,'data.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','PK\x03\x04data');
  f.item(5,'translation.pdf','application/pdf','%PDF-1.4\ntranslated',1,'Original paper - 中文译文');
  f.item(6,'support.pdf','application/pdf','%PDF-1.4\nsupport',1,'Supporting information');
  f.item(7,'unrelated.pdf','application/pdf','%PDF-1.4\nother');
  const before = JSON.stringify(f.metadata), result = await f.api.list(f.reader);
  assert.deepEqual(result.map(value => value.id),[4,6]);
  assert.equal(f.calls.length,0);assert.equal(f.imports.length,0);assert.equal(JSON.stringify(f.metadata),before);
  assert.equal(result[1].available,true);
}));

test('exact DOI lookup exposes only JATS supplementary files and fixed source URLs', () => using(async f => {
  const result = await f.api.find(f.reader);
  assert.equal(result.status,'ready');assert.equal(result.candidates.length,2);
  assert.deepEqual(result.candidates.map(value => value.fileName),['table-s1.csv','support.pdf']);
  assert(f.calls[0].url.includes(encodeURIComponent('DOI:"' + DOI + '"')));
  assert(f.calls.every(value => value.url.startsWith('https://www.ebi.ac.uk/europepmc/webservices/rest/')));
  assert(f.calls.every(value => value.options.followRedirects === false && value.options.anon === true));
  assert.equal(f.imports.length,0);
}));

test('absent identifiers, ambiguous DOI matches and wrong article XML never yield download candidates', () => using(async f => {
  f.metadata.DOI='';f.metadata.url='https://private.test/article';
  assert.equal((await f.api.find(f.reader)).status,'no_identifier');assert.equal(f.calls.length,0);
  f.metadata.DOI=DOI;
  f.setResponse(async (_method,url) => ({status:200,responseURL:url,response:Uint8Array.from(Buffer.from(JSON.stringify({resultList:{result:[
    {doi:'10.9999/wrong',pmcid:PMC,isOpenAccess:'Y'}]}}))).buffer}));
  assert.equal((await f.api.find(f.reader)).status,'none');
  f.metadata.DOI='';f.metadata.url='https://pmc.ncbi.nlm.nih.gov/articles/PMC1963317/';
  f.setResponse(async (_method,url) => ({status:200,responseURL:url,response:Uint8Array.from(Buffer.from(XML.replace('1963317</article-id>','1234567</article-id>'))).buffer}));
  assert.equal((await f.api.find(f.reader)).status,'unavailable');
}));

test('selected supplements import into only the pinned parent, read back unchanged and deduplicate by content', () => using(async f => {
  const before = fs.readFileSync(await f.main.getFilePathAsync()), metadata=JSON.stringify(f.metadata);
  const found=await f.api.find(f.reader), selected=found.candidates;
  assert.equal((await f.api.download(f.reader,[{id:selected[0].id,url:'http://127.0.0.1/private'}])).added.length,1);
  const saved=f.imports[0];assert.equal(saved.parentItemID,1);assert.equal(saved.libraryID,1);
  const entries=await f.api.list(f.reader);assert.equal(entries.length,1);assert.equal(entries[0].managed,true);
  assert.equal(fs.readFileSync(await f.values.get(entries[0].id).getFilePathAsync(),'utf8'),'sample,value\nA,7\n');
  const duplicate=await f.api.download(f.reader,[selected[0].id]);assert.equal(duplicate.skipped[0].reason,'duplicate');
  assert.equal(f.imports.length,1);assert.deepEqual(fs.readFileSync(await f.main.getFilePathAsync()),before);
  assert.equal(JSON.stringify(f.metadata),metadata);assert.equal(f.main.hasTag('Ask GPT Supplement'),false);
  assert(f.calls.at(-1).url.endsWith('/PMC1963317/supplementaryFiles'));
  assert(!fs.readdirSync(f.directory).some(name=>name.startsWith('askgpt-supplements-')));
}));

test('unknown selections and stale reader/metadata bindings cannot import into a different paper', () => using(async f => {
  const found=await f.api.find(f.reader);
  await assert.rejects(f.api.download(f.reader,['PMC1963317:main.pdf']),{code:'supplements_selection'});
  f.metadata.DOI='10.9999/changed';
  await assert.rejects(f.api.download(f.reader,[found.candidates[0].id]),{code:'supplements_selection'});
  f.main.parentID=99;
  await assert.rejects(f.api.list(f.reader),{code:'supplements_parent'});
  assert.equal(f.imports.length,0);
}));

test('ZIP traversal, duplicate entry names, symlinks and expansion limits cannot write imported attachments', async () => {
  for (const attack of ['traversal','duplicate','symlink','large']) await using(async f => {
    const found=await f.api.find(f.reader);
    if(attack==='traversal')f.archiveEntries.set('../outside.csv',Buffer.from('outside'));
    if(attack==='duplicate')f.archiveEntries.set('other/table-s1.csv',Buffer.from('ambiguous'));
    if(attack==='symlink')f.entryOverrides.set('assets/table-s1.csv',{permissions:0o120777});
    if(attack==='large')f.entryOverrides.set('assets/table-s1.csv',{realSize:129*1024*1024});
    const result=await f.api.download(f.reader,[found.candidates[0].id]);
    assert.equal(result.added.length,0);assert.equal(result.failed.length,1);assert.equal(f.imports.length,0);
    assert.equal(f.extractions.length,0);
  });
});

test('manual import uses native file picker, keeps original files and detects already saved main PDF', () => using(async f => {
  const local=path.join(f.directory,'manual.csv');fs.writeFileSync(local,'sample,value\nB,9\n');
  f.pick([local,await f.main.getFilePathAsync()]);
  const result=await f.api.chooseFiles(f.reader);
  assert.equal(result.added.length,1);assert.equal(result.skipped[0].reason,'duplicate');assert(fs.existsSync(local));
  assert.equal(result.added[0].title,'manual.csv');assert.equal(f.calls.length,0);
  const source=await f.main.getFilePathAsync();assert.equal(fs.readFileSync(source,'utf8'),'%PDF-1.4\nmain');
}));

test('picker cancellation, read-only libraries and reparenting while waiting do not save', () => using(async f => {
  f.pick([],1);assert.equal((await f.api.chooseFiles(f.reader)).cancelled,true);
  f.library.filesEditable=false;await assert.rejects(f.api.chooseFiles(f.reader),{code:'supplements_readonly'});
  f.library.filesEditable=true;
  let resolve;const waiting=new Promise(done=>resolve=done);f.pick([],0,waiting);
  const pending=f.api.chooseFiles(f.reader);f.main.parentID=999;resolve();
  await assert.rejects(pending,{code:'supplements_parent'});assert.equal(f.imports.length,0);
}));

test('previews read only the pinned paper local file, verify signatures and never launch a new tab', () => using(async f => {
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
  const image=f.item(4,'support.png','image/png',bytes);
  const preview=await f.api.preview(f.reader,image.id);assert.equal(preview.kind,'image');assert.deepEqual(Buffer.from(preview.bytes),bytes);
  assert.equal(preview.path,undefined);assert.equal(f.launched.length,0);
  const pdf=f.item(5,'support.pdf','application/pdf','%PDF-1.4\nfixture');
  assert.equal((await f.api.preview(f.reader,pdf.id)).kind,'pdf');
  const fake=f.item(6,'bad.pdf','application/pdf','<html>private login</html>');
  await assert.rejects(f.api.preview(f.reader,fake.id),{code:'supplements_file'});
  const foreign=f.item(7,'foreign.png','image/png',bytes,123);
  await assert.rejects(f.api.preview(f.reader,foreign.id),{code:'supplements_file'});
  await assert.rejects(f.api.preview(f.reader,f.main.id),{code:'supplements_file'});
  const table=f.item(8,'data.csv','text/csv','a,b\n1,2');assert.equal((await f.api.preview(f.reader,table.id)).kind,'external');
  assert.equal((await f.api.open(f.reader,table.id)).opened,true);assert.equal(f.launched.length,1);
}));

test('oversized HTTP bodies abort during transfer and public-source failures reveal no diagnostics', () => using(async f => {
  let aborted=false;
  f.setResponse(async (_method,_url,options) => {
    const events={};options.requestObserver({addEventListener:(name,fn)=>events[name]=fn,abort(){aborted=true;}});
    events.progress({loaded:1000000,lengthComputable:false});throw Error('/private/key.json SECRET');
  });
  const result=await f.api.find(f.reader);assert.equal(aborted,true);assert.equal(result.status,'unavailable');
  assert(!JSON.stringify(result).includes('SECRET'));assert.equal(f.imports.length,0);
}));

test('invalid PDF payloads and private native import diagnostics remain bounded failures', () => using(async f => {
  const found=await f.api.find(f.reader);
  f.archiveEntries.set('support.pdf',Buffer.from('<html>sign in</html>'));
  const invalid=await f.api.download(f.reader,[found.candidates[1].id]);
  assert.equal(invalid.failed[0].reason,'supplements_file');assert.equal(f.imports.length,0);
  f.deps.Zotero.Attachments.importFromFile=async()=>{throw Object.assign(Error('/PRIVATE/SECRET'),{code:'SECRET'});};
  const failed=await f.api.download(f.reader,[found.candidates[0].id]);
  assert.equal(failed.failed[0].id,found.candidates[0].id);assert.equal(failed.failed[0].reason,'supplements_save');
  assert(!JSON.stringify(failed).includes('SECRET'));
}));

test('large existing attachments remain visible and open externally without loading preview bytes', () => using(async f => {
  const item=f.item(4,'large-support.pdf','application/pdf','%PDF-1.4\nfixture',1,'Supporting information');
  fs.truncateSync(await item.getFilePathAsync(),65*1024*1024);
  const listed=await f.api.list(f.reader);assert.equal(listed[0].available,true);
  f.deps.IOUtils.read=async()=>{throw Error('large preview must not read bytes');};
  assert.equal((await f.api.preview(f.reader,item.id)).kind,'external');
  assert.equal((await f.api.open(f.reader,item.id)).opened,true);
}));

test('restarting the backend preserves imported attachment classification and content deduplication', () => using(async f => {
  const found=await f.api.find(f.reader);await f.api.download(f.reader,[found.candidates[1].id]);
  const next=create(f.deps), local=await next.list(f.reader);assert.equal(local.length,1);assert.equal(local[0].managed,true);
  assert.equal((await next.preview(f.reader,local[0].id)).kind,'pdf');
  const again=await next.find(f.reader),saved=await next.download(f.reader,[again.candidates[1].id]);
  assert.equal(saved.added.length,0);assert.equal(saved.skipped.length,1);assert.equal(f.imports.length,1);
}));

function cloud(f, options = {}) {
  const pdf=Buffer.from('%PDF-1.4\ncloud supplement'), digest=crypto.createHash('md5').update(pdf).digest('hex');
  const main=crypto.createHash('md5').update(Buffer.from('%PDF-1.4\nmain')).digest('hex');
  const versions=options.versions || [{version:1,main}];
  const xml=Buffer.from(options.xml || XML), xmlMD5=crypto.createHash('md5').update(xml).digest('hex');
  f.setResponse(async (_method,url) => {
    let payload;
    if(url.endsWith('/supplementaryFiles'))throw Error('public ZIP temporarily unavailable');
    if(url.includes('?list-type=2'))payload='<ListBucketResult><IsTruncated>false</IsTruncated>'+versions.map(v=>`<CommonPrefixes><Prefix>${PMC}.${v.version}/</Prefix></CommonPrefixes>`).join('')+'</ListBucketResult>';
    else if(url.endsWith('.json')) {
      const version=Number(url.match(/PMC1963317\.(\d+)\.json$/)[1]), value=versions.find(v=>v.version===version), prefix=PMC+'.'+version;
      payload=JSON.stringify({pmcid:PMC,version,doi:options.wrongDOI?'10.9999/wrong':DOI,is_pmc_openaccess:true,is_manuscript:false,is_retracted:false,license_code:'CC BY',
        pdf_url:`s3://pmc-oa-opendata/${prefix}/${prefix}.pdf?md5=${value.main}`,
        xml_url:`s3://pmc-oa-opendata/${prefix}/${prefix}.xml?md5=${options.wrongXMLHash?'0'.repeat(32):xmlMD5}`,
        media_urls:[options.wrongURL?'http://127.0.0.1/private.pdf':`s3://pmc-oa-opendata/${prefix}/support.pdf?md5=${options.wrongMD5?'0'.repeat(32):digest}`]});
    } else if(url.endsWith('.xml'))payload=xml;
    else if(url.endsWith('/support.pdf'))payload=pdf;
    else throw Error('Unexpected URL');
    return {status:200,responseURL:url,response:Uint8Array.from(Buffer.from(payload)).buffer};
  });
  return {main,digest};
}

test('unavailable Europe PMC ZIP falls back only to exact JATS PDF in one licensed final PMC version', () => using(async f => {
  const found=await f.api.find(f.reader);cloud(f);
  const result=await f.api.download(f.reader,[found.candidates[1].id]);
  assert.equal(result.added.length,1);assert.equal(result.failed.length,0);
  assert.equal(result.added[0].url,`https://pmc-oa-opendata.s3.amazonaws.com/${PMC}.1/support.pdf`);
  assert.equal((await f.api.preview(f.reader,result.added[0].id)).kind,'pdf');
  assert(f.calls.filter(v=>v.url.includes('s3.amazonaws.com')).every(v=>v.options.followRedirects===false && v.options.anon===true));
}));

test('Cloud fallback rejects wrong DOI, unsupported remote URL and wrong supplement MD5 before importing', async () => {
  for(const options of [{wrongDOI:true},{wrongURL:true},{wrongMD5:true}])await using(async f=>{
    const found=await f.api.find(f.reader);cloud(f,options);
    const result=await f.api.download(f.reader,[found.candidates[1].id]);
    assert.equal(result.added.length,0);assert.equal(result.failed[0].id,found.candidates[1].id);assert.equal(f.imports.length,0);
    assert(!f.calls.some(v=>v.url.includes('127.0.0.1')));
  });
});

test('multiple licensed final versions require a unique current main PDF MD5 match and never pick highest', async () => {
  const main=crypto.createHash('md5').update(Buffer.from('%PDF-1.4\nmain')).digest('hex');
  for(const [versions,expected] of [[[{version:1,main},{version:2,main:'0'.repeat(32)}],1],
    [[{version:1,main:'1'.repeat(32)},{version:2,main:'0'.repeat(32)}],0],
    [[{version:1,main},{version:2,main}],0]])await using(async f=>{
      const found=await f.api.find(f.reader);cloud(f,{versions});
      const result=await f.api.download(f.reader,[found.candidates[1].id]);assert.equal(result.added.length,expected);
      if(expected)assert(result.added[0].url.includes(`${PMC}.1/`));
    });
});

test('malicious ZIP rejection does not trigger Cloud fallback or replay a partial native save', () => using(async f => {
  const found=await f.api.find(f.reader);f.archiveEntries.set('../outside.pdf',Buffer.from('%PDF-1.4\noutside'));
  const result=await f.api.download(f.reader,[found.candidates[1].id]);
  assert.equal(result.added.length,0);assert(!f.calls.some(v=>v.url.includes('s3.amazonaws.com')));
}));


test('official PMC URL discovers verified Cloud JATS first and downloads from cached proven version without Europe PMC', () => using(async f => {
  f.metadata.url=`https://pmc.ncbi.nlm.nih.gov/articles/${PMC}/`;cloud(f);
  const found=await f.api.find(f.reader);assert.equal(found.status,'ready');assert.equal(found.source,'PMC Cloud');
  assert.equal(found.candidates.length,1);assert.equal(found.candidates[0].fileName,'support.pdf');
  assert(f.calls[0].url.includes('s3.amazonaws.com/?list-type=2'));
  assert(!f.calls.some(value=>value.url.includes('ebi.ac.uk')));
  const listed=f.calls.filter(value=>value.url.includes('?list-type=2')).length;
  const saved=await f.api.download(f.reader,[found.candidates[0].id]);assert.equal(saved.added.length,1);
  assert.equal(f.calls.filter(value=>value.url.includes('?list-type=2')).length,listed);
  assert(!f.calls.some(value=>value.url.includes('ebi.ac.uk')));
}));

test('Cloud discovery rejects wrong JATS identity or MD5 and reports only fixed failure codes', async () => {
  for(const options of [{wrongXMLHash:true},{xml:XML.replace(DOI,'10.9999/wrong')}])await using(async f=>{
    f.metadata.url=`https://pmc.ncbi.nlm.nih.gov/articles/${PMC}/`;cloud(f,options);
    const found=await f.api.find(f.reader);assert.equal(found.status,'unavailable');
    assert.equal(found.cloudErrorCode,'supplements_identity');assert.equal(found.errorCode,'supplements_network');
    assert.equal(found.candidates.length,0);assert.equal(f.imports.length,0);
  });
});

test('Cloud metadata must approve the JATS basename; discovery stays read-only even for a locked library', () => using(async f => {
  f.metadata.url=`https://pmc.ncbi.nlm.nih.gov/articles/${PMC}/`;f.library.filesEditable=false;cloud(f,{wrongURL:true});
  const found=await f.api.find(f.reader);assert.equal(found.status,'none');assert.equal(found.source,'PMC Cloud');
  assert.equal(found.candidates.length,0);assert.equal(f.imports.length,0);
  assert(!f.calls.some(value=>value.url.includes('127.0.0.1') || value.url.includes('ebi.ac.uk')));
}));
