const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');

test('native amber migration runs once and then respects manual palette choices',{timeout:120000},()=>{
  const source=fs.readFileSync(path.join(__dirname,'../../../Sources/AskGPT/WordWritingPopoverView.swift'),'utf8');
  const start=source.indexOf('enum WordWritingMarkPalette:'),end=source.indexOf('\nenum WordWritingPopoverContent');
  assert.ok(start>=0&&end>start,'test must compile the actual production palette declaration');
  const palette=source.slice(start,end);assert.match(palette,/static func preferred\(/,'production preference migration must exist');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'askgpt-palette-test-'));
  try{
    const harness=`import AppKit\nimport SwiftUI\n${palette}\n
let name="AskGPTPaletteTests-"+UUID().uuidString
let defaults=UserDefaults(suiteName:name)!
defer { defaults.removePersistentDomain(forName:name) }
func reset() { defaults.removePersistentDomain(forName:name) }
reset()
assert(WordWritingMarkPalette.preferred(defaults:defaults) == .amber)
assert(defaults.string(forKey:"WritingMarkPalette") == "amber")
assert(defaults.integer(forKey:"WritingMarkPaletteRevision") == 1)
for old in ["rose","ocean","mint"] {
 reset();defaults.set(old,forKey:"WritingMarkPalette")
 assert(WordWritingMarkPalette.preferred(defaults:defaults) == .amber)
 defaults.set(old,forKey:"WritingMarkPalette")
 assert(WordWritingMarkPalette.preferred(defaults:defaults).rawValue == old)
 assert(defaults.string(forKey:"WritingMarkPalette") == old)
}
reset();defaults.set(2,forKey:"WritingMarkPaletteRevision");defaults.set("mint",forKey:"WritingMarkPalette")
assert(WordWritingMarkPalette.preferred(defaults:defaults) == .mint)
assert(defaults.integer(forKey:"WritingMarkPaletteRevision") == 2)
defaults.set("invalid",forKey:"WritingMarkPalette")
assert(WordWritingMarkPalette.preferred(defaults:defaults) == .amber)
assert(Set(WordWritingMarkPalette.allCases.map(\\.rawValue)) == Set(["amber","rose","ocean","mint"]))
assert(WordWritingMarkPalette.amber.fillOpacity >= 0.30 && WordWritingMarkPalette.amber.fillOpacity <= 0.34)
assert([WordWritingMarkPalette.rose,.ocean,.mint].allSatisfy { $0.fillOpacity == 0.20 })
print("native palette migration assertions passed")
`;
    const input=path.join(directory,'main.swift'),binary=path.join(directory,'palette-test');fs.writeFileSync(input,harness);
    const compiled=spawnSync('/usr/bin/swiftc',[input,'-o',binary],{encoding:'utf8',timeout:90000});assert.equal(compiled.status,0,compiled.stderr||compiled.error?.message);
    const result=spawnSync(binary,[],{encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/migration assertions passed/);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
