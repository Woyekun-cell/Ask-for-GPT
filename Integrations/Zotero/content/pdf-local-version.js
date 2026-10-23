(function(root){
  'use strict';
  const PREFIX='extensions.askgpt-inline.localPDF.',MAX_PDF=450*1024*1024;
  const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  function create({Zotero,Services,Components,IOUtils,hashFile}={}){
    // Native attachment discovery currently uses the macOS cache layout.
    if(Zotero?.isWin||Zotero?.isLinux)return null;
    if(!Zotero?.Items?.get||!Zotero?.Attachments?.importFromFile||!Zotero?.File?.pathToFile||!IOUtils?.readUTF8)return null;
    const pending=new Map();
    function file(path){return Zotero.File.pathToFile(path);}
    function regular(value,maximum){return value.exists()&&!value.isSymlink()&&value.isFile()&&value.fileSize>0&&value.fileSize<=maximum;}
    function sha(value){
      if(hashFile)return hashFile(value);
      const stream=Components.classes['@mozilla.org/network/file-input-stream;1'].createInstance(Components.interfaces.nsIFileInputStream);
      try{
        stream.init(value,0x01,0o444,0);
        const hash=Components.classes['@mozilla.org/security/hash;1'].createInstance(Components.interfaces.nsICryptoHash);
        hash.init(hash.SHA256);hash.updateFromStream(stream,0xffffffff);
        return Array.from(hash.finish(false),c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');
      }finally{stream.close();}
    }
    async function itemFile(item){
      if(!item||item.deleted||item.isAttachment?.()!==true||item.attachmentContentType!=='application/pdf')return null;
      const path=await item.getFilePathAsync();if(!path)return null;const value=file(path);
      return regular(value,MAX_PDF)?value:null;
    }
    function rootDirectory(){
      const value=Services.dirsvc.get('Home',Components.interfaces.nsIFile).clone();
      for(const part of ['Library','Application Support','AskGPTReader','PDFLayout','jobs']){
        value.append(part);if(!value.exists()||value.isSymlink()||!value.isDirectory())return null;
      }return value;
    }
    async function matchingItem(source,key,checksum){
      if(typeof key!=='string'||!/^[A-Z0-9]{8}$/.test(key))return null;
      const item=Zotero.Items.getByLibraryAndKey(source.libraryID,key);
      if(!item||item.libraryID!==source.libraryID||item.parentID!==source.parentID)return null;
      const value=await itemFile(item);return value&&sha(value)===checksum?item:null;
    }
    function remember(source,direction,sourceSHA,item,targetSHA){
      const value={schema:1,sourceSHA256:sourceSHA,targetSHA256:targetSHA,targetKey:item.key};
      Zotero.Prefs?.set(PREFIX+source.libraryID+'.'+source.key+'.'+direction,JSON.stringify(value),true);
      Zotero.Prefs?.set(PREFIX+item.libraryID+'.'+item.key+'.'+direction,JSON.stringify({...value,sourceSHA256:targetSHA}),true);
    }
    async function findVersion(source,direction){
      const input=await itemFile(source);if(!input)return null;
      const sourceSHA=sha(input),target=direction==='zh-en'?'en':'zh-Hans';
      const prefKey=PREFIX+source.libraryID+'.'+source.key+'.'+direction;
      let previous;try{const raw=Zotero.Prefs?.get(prefKey,true);if(typeof raw==='string'&&raw.length<=4096)previous=JSON.parse(raw);}catch(_){}
      if(previous?.schema===1&&previous.sourceSHA256===sourceSHA&&digest(previous.targetSHA256)){
        const item=await matchingItem(source,previous.targetKey,previous.targetSHA256);if(item)return item;
      }
      const directory=rootDirectory();if(!directory)return null;
      const entries=directory.directoryEntries;let selected=null;
      while(entries.hasMoreElements()){
        const entry=entries.getNext().QueryInterface(Components.interfaces.nsIFile);
        if(!/^[a-f0-9]{32}$/.test(entry.leafName)||entry.isSymlink()||!entry.isDirectory())continue;
        const metadata=entry.clone();metadata.append('cache.json');if(!regular(metadata,65536))continue;
        let info;try{info=JSON.parse(await IOUtils.readUTF8(metadata.path));}catch(_){continue;}
        if(info?.schema!==1||info.state!=='complete'||info.babeldoc!=='0.6.4'||info.target!==target
          ||info.source!==(target==='en'?'zh-Hans':'en')||!digest(info.sourceSHA256)
          ||!Number.isInteger(info.pageCount)||info.pageCount<1||info.pageCount>2000
          ||!Array.isArray(info.sourcePages)||info.sourcePages.length!==info.pageCount
          ||info.sourcePages.some((page,index)=>page!==index))continue;
        const output=info.outputs?.mono;
        if(!digest(output?.sha256)||!Number.isInteger(output.bytes)||output.bytes<5||output.bytes>MAX_PDF
          ||info.sourceSHA256!==sourceSHA&&output.sha256!==sourceSHA)continue;
        const mono=entry.clone();mono.append('mono.pdf');
        if(!regular(mono,MAX_PDF)||mono.fileSize!==output.bytes||sha(mono)!==output.sha256)continue;
        // Exported translations remain ordinary native PDFs, including when
        // the user clicks Translate while already reading that attachment.
        if(output.sha256===sourceSHA){remember(source,direction,sourceSHA,source,sourceSHA);return source;}
        const parent=source.parentID?Zotero.Items.get(source.parentID):null;
        let item=null;
        for(const id of parent?.getAttachments?.()||[]){
          const candidate=Zotero.Items.get(id);if(!candidate||candidate.id===source.id)continue;
          const value=await itemFile(candidate);
          if(value&&candidate.libraryID===source.libraryID&&candidate.parentID===source.parentID
            &&value.fileSize===output.bytes&&sha(value)===output.sha256){item=candidate;break;}
        }
        if(item){remember(source,direction,sourceSHA,item,output.sha256);return item;}
        const modified=Number(entry.lastModifiedTime)||0;
        if(!selected||modified>selected.modified)selected={mono,output,modified};
      }
      if(!selected)return null;
      const {mono,output}=selected,parent=source.parentID?Zotero.Items.get(source.parentID):null;
      const suffix=target==='en'?'English translation':'中文译文';
      const title=String(parent?.getField?.('title')||source.getField('title')||'PDF').replace(/\.pdf$/i,'')+' - '+suffix;
      const options={file:mono.path,libraryID:source.libraryID,title,contentType:'application/pdf',
        fileBaseName:Zotero.File.getValidFileName(title).slice(0,180)};
      if(source.parentID)options.parentItemID=source.parentID;
      else options.collections=source.getCollections?.()||[];
      const item=await Zotero.Attachments.importFromFile(options),saved=await itemFile(item);
      if(!saved||sha(saved)!==output.sha256)throw Error('local_version_save_failed');
      remember(source,direction,sourceSHA,item,output.sha256);
      return item;
    }
    const api={find(reader,direction='en-zh'){
      const source=reader?._item||Zotero.Items.get(reader?.itemID);
      if(!source||!Number.isSafeInteger(source.libraryID)||!/^[A-Z0-9]{8}$/.test(source.key)
        ||!['en-zh','zh-en'].includes(direction))return Promise.resolve(null);
      const key=source.libraryID+'.'+source.key+'.'+direction;
      if(pending.has(key))return pending.get(key);
      const task=findVersion(source,direction).finally(()=>{if(pending.get(key)===task)pending.delete(key);});
      pending.set(key,task);return task;
    },async load(reader,direction='en-zh'){
      const item=await api.find(reader,direction);if(!item)return null;
      const source=reader?._item||Zotero.Items.get(reader?.itemID);
      if(item.id===source.id)return {alreadyTranslated:true};
      const input=await itemFile(source),saved=await itemFile(item),directory=rootDirectory();
      if(!input||!saved||!directory)throw Error('local_version_mapping_unavailable');
      const sourceSHA=sha(input),targetSHA=sha(saved),target=direction==='zh-en'?'en':'zh-Hans';
      const entries=directory.directoryEntries;
      while(entries.hasMoreElements()){
        const entry=entries.getNext().QueryInterface(Components.interfaces.nsIFile);
        if(!/^[a-f0-9]{32}$/.test(entry.leafName)||entry.isSymlink()||!entry.isDirectory())continue;
        const metadata=entry.clone();metadata.append('cache.json');if(!regular(metadata,65536))continue;
        let info;try{info=JSON.parse(await IOUtils.readUTF8(metadata.path));}catch(_){continue;}
        if(info?.schema!==1||info.state!=='complete'||info.babeldoc!=='0.6.4'||info.sourceSHA256!==sourceSHA
          ||info.target!==target||info.source!==(target==='en'?'zh-Hans':'en')
          ||info.outputs?.mono?.sha256!==targetSHA||info.outputs.mono.bytes!==saved.fileSize
          ||!Number.isInteger(info.pageCount)||info.pageCount<1||info.pageCount>2000
          ||!Array.isArray(info.sourcePages)||info.sourcePages.length!==info.pageCount
          ||info.sourcePages.some((page,index)=>page!==index))continue;
        const output=await IOUtils.read(saved.path);
        if(output.byteLength!==info.outputs.mono.bytes||sha(saved)!==targetSHA)throw Error('local_version_changed');
        return {item,output,job:{id:entry.leafName,state:'complete',sourcePages:info.sourcePages,pageCount:info.pageCount}};
      }
      // A saved PDF must not trigger a paid replacement job because its
      // original correspondence metadata is temporarily unavailable.
      throw Error('local_version_mapping_unavailable');
    }};return api;
  }
  const api={create};root.AskGPTPDFLocalVersion=api;if(typeof module!=='undefined')module.exports=api;
})(this);
