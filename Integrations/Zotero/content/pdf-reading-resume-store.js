(function(root){
  'use strict';
  const PREFIX='extensions.askgpt-inline.readingResume.',LIMIT=16384;
  const integer=value=>Number.isSafeInteger(value)&&value>=0;
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  const byteLength=text=>encodeURIComponent(text).replace(/%[A-F\d]{2}/gi,'_').length;
  function pick(value){
    if(!value||typeof value!=='object'||value.schema!==1||typeof value.fingerprint!=='string'||!value.fingerprint
      ||!integer(value.pageCount)||value.pageCount<1||!integer(value.pageIndex)||value.pageIndex>=value.pageCount
      ||!integer(value.start)||!integer(value.end)||value.end<=value.start||typeof value.signature!=='string'||!/^[a-f0-9]{64}$/.test(value.signature)
      ||!integer(value.capturedAt)||value.capturedAt<1||!Array.isArray(value.rects)||!value.rects.length||value.rects.length>1000)return null;
    const rects=[];
    for(const valueRect of value.rects){
      if(!Array.isArray(valueRect)||valueRect.length!==4)return null;
      const rect=[valueRect[0],valueRect[1],valueRect[2],valueRect[3]];
      if(!rect.every(finite)||rect[2]<=rect[0]||rect[3]<=rect[1])return null;rects.push(rect);
    }
    const result={schema:1,fingerprint:value.fingerprint,pageCount:value.pageCount,pageIndex:value.pageIndex,start:value.start,end:value.end,rects,signature:value.signature,capturedAt:value.capturedAt};
    return byteLength(JSON.stringify(result))<=LIMIT?result:null;
  }
  function create({Zotero,validateAnchor}={}){
    function identity(reader){
      function key(item){
        if(!item||typeof item.isAttachment!=='function'||item.isAttachment()!==true||!integer(item.libraryID)||typeof item.key!=='string'||!/^[A-Z0-9]{8}$/.test(item.key))return null;
        return PREFIX+item.libraryID+'.'+item.key;
      }
      try{
        const own=key(reader?._item);if(own)return own;
        const id=reader?.itemID;if(!integer(id)||id<1)return null;
        return key(Zotero?.Items?.get?.(id));
      }catch(_){return null;}
    }
    function checked(value){
      if(typeof validateAnchor!=='function')return null;
      const candidate=pick(value);if(!candidate)return null;
      const result=validateAnchor(candidate);return result?pick(result===true?candidate:result):null;
    }
    function read(key){
      if(typeof Zotero?.Prefs?.get!=='function')throw new Error('preferences unavailable');
      const raw=Zotero.Prefs.get(key,true);
      if(raw==null)return {present:false,anchor:null};
      if(typeof raw!=='string'||byteLength(raw)>LIMIT)return {present:true,anchor:null};
      try{return {present:true,anchor:checked(JSON.parse(raw))};}catch(_){return {present:true,anchor:null};}
    }
    return {
      load(reader){
        try{const key=identity(reader);return key?read(key).anchor:null;}catch(_){return null;}
      },
      save(reader,value){
        try{
          const key=identity(reader);if(!key||typeof Zotero?.Prefs?.set!=='function')return false;
          const anchor=checked(value);if(!anchor)return false;
          const previous=read(key);
          // Preserve malformed existing settings and a newer window's progress.
          if(previous.present&&(!previous.anchor||previous.anchor.capturedAt>=anchor.capturedAt))return false;
          Zotero.Prefs.set(key,JSON.stringify(anchor),true);return true;
        }catch(_){return false;}
      }
    };
  }
  const api={create};root.AskGPTPDFReadingResumeStore=api;if(typeof module!=='undefined')module.exports=api;
})(this);
