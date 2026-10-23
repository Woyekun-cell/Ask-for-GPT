(function(root){
  'use strict';
  const Markup=root.AskGPTPDFFigureMarkup||(typeof require==='function'?require('./pdf-figure-markup.js'):null);
  const MAX_JSON=2*1024*1024,MAX_PNG=32*1024*1024;
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  function utf8Size(text){let result=0;for(const c of text){const n=c.codePointAt(0);result+=n<128?1:n<2048?2:n<65536?3:4;}return result;}
  function decode(bytes){let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.slice(i,i+16384));return decodeURIComponent(escape(binary));}
  function create(deps={}){
    const {Services,Components,IOUtils,ChromeUtils,Zotero}=deps,tails=new Map();let exporting=false;
    const reportExport=(phase,result)=>{try{deps.reportExportDiagnostic?.({phase,result});}catch(_){}};
    const home=()=>Services.dirsvc.get('Home',Components.interfaces.nsIFile).clone();
    const normalFile=Components?.interfaces?.nsIFile?.NORMAL_FILE_TYPE??0,directory=Components?.interfaces?.nsIFile?.DIRECTORY_TYPE??1;
    function target(binding,createDirs){
      const file=home(),parts=['Library','Application Support','AskGPTReader','FigureMarkup',String(binding.libraryID),binding.itemKey,binding.fingerprint];
      for(const [index,part] of parts.entries()){file.append(part);if(file.exists()){if(file.isSymlink()||!file.isDirectory())throw Error('invalid local directory');}else{if(!createDirs)return null;file.create(directory,0o700);}if(createDirs&&index>=3)file.permissions=0o700;}
      file.append('p'+binding.pageIndex+'-'+binding.rect.map(n=>String(Object.is(n,-0)?0:n).replace(/\./g,'d').replace(/\+/g,'p')).join('_')+'.json');
      if(file.exists()&&(file.isSymlink()||!file.isFile()))throw Error('invalid local record');return file;
    }
    async function read(file,binding){
      if(!file?.exists()||file.isSymlink()||!file.isFile()||file.fileSize>MAX_JSON)return null;
      const bytes=await IOUtils.read(file.path,{maxBytes:MAX_JSON+1});if(bytes.length>MAX_JSON)return null;
      const value=Markup.validateRecord(JSON.parse(decode(bytes)));return value&&same(value.binding,binding)?value:null;
    }
    async function atomic(file,value,binary,noOverwrite=false){
      if(file.exists()&&(file.isSymlink()||!file.isFile()))return false;
      const temporary=file.parent;temporary.append('.'+file.leafName+'.askgpt-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+'.tmp');let owned=false;
      try{
        temporary.create(normalFile,0o600);owned=true;
        if(binary)await IOUtils.write(temporary.path,value,{mode:'overwrite',flush:true});else await IOUtils.writeUTF8(temporary.path,value,{mode:'overwrite',flush:true});
        temporary.permissions=0o600;if(file.exists()&&(file.isSymlink()||!file.isFile()))return false;
        await IOUtils.move(temporary.path,file.path,{noOverwrite});owned=false;file.permissions=0o600;return true;
      }finally{if(owned)try{if(temporary.exists()&&!temporary.isSymlink()&&temporary.isFile())await IOUtils.remove(temporary.path,{ignoreAbsent:true});}catch(_){}}
    }
    function png(value){
      let phase=7;reportExport(phase,0);
      try{
        if(!value){reportExport(phase,2);return null;}
        const unwrapped=ArrayBuffer.isView(value)?value:Components?.utils?.waiveXrays?Components.utils.waiveXrays(value):value;
        const length=unwrapped?.byteLength;if(!Number.isSafeInteger(length)||length<33||length>MAX_PNG){reportExport(phase,2);return null;}reportExport(phase,1);phase=8;reportExport(phase,0);
        let bytes;if(ArrayBuffer.isView(unwrapped)&&unwrapped.BYTES_PER_ELEMENT===1)bytes=new Uint8Array(unwrapped);else{
          const getter=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;if(Reflect.apply(getter,unwrapped,[])!==length){reportExport(phase,2);return null;}bytes=new Uint8Array(new Uint8Array(unwrapped,0,length));
        }
        if(bytes.byteLength!==length){reportExport(phase,2);return null;}
        reportExport(phase,1);phase=9;reportExport(phase,0);if(bytes.byteLength>MAX_PNG||![137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82].every((n,i)=>bytes[i]===n)){reportExport(phase,2);return null;}
        reportExport(phase,1);phase=10;reportExport(phase,0);const number=i=>bytes[i]*16777216+bytes[i+1]*65536+bytes[i+2]*256+bytes[i+3],width=number(16),height=number(20);if(!width||!height||width>8192||height>8192||width*height>16777216){reportExport(phase,2);return null;}
        reportExport(phase,1);return bytes;
      }catch(_){reportExport(phase,2);return null;}
    }
    return {
      async load(value){try{const binding=Markup.validateBinding(value);if(!binding)return null;const key=JSON.stringify(binding);if(tails.has(key))await tails.get(key);return await read(target(binding,false),binding);}catch(_){return null;}},
      save(value){
        const record=Markup?.validateRecord(value);if(!record)return Promise.resolve(false);const key=JSON.stringify(record.binding),previous=tails.get(key)||Promise.resolve();
        const pending=previous.catch(()=>{}).then(async()=>{try{const file=target(record.binding,true);if(file.exists()&&!await read(file,record.binding))return false;const text=JSON.stringify({...record,updatedAt:Date.now()});return utf8Size(text)<=MAX_JSON&&await atomic(file,text,false);}catch(_){return false;}});
        tails.set(key,pending);void pending.finally(()=>{if(tails.get(key)===pending)tails.delete(key);});return pending;
      },
      async exportPNG(value,record,suggestedName='Figure'){
        if(exporting){reportExport(1,4);return {saved:false,cancelled:false};}reportExport(1,0);reportExport(6,0);let checked;try{checked=Markup?.validateRecord(record);}catch(_){}reportExport(6,checked?1:2);const bytes=checked&&png(value);if(!bytes){reportExport(1,2);return {saved:false,cancelled:false};}reportExport(1,1);exporting=true;let phase=2;
        try{
          reportExport(phase,0);
          const picker=deps.createFilePicker?deps.createFilePicker():new (ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs').FilePicker)();
          reportExport(phase,1);phase=3;reportExport(phase,0);
          picker.init(deps.getWindow?.(),Zotero?.getString?.('reader-save-image-as')||'导出标注图片',picker.modeSave);picker.appendFilter('PNG','*.png');picker.defaultExtension='png';
          let name=typeof suggestedName==='string'?suggestedName:'Figure';name=name.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/^\.+/,'').trim().replace(/\.png$/i,'').slice(0,80)||'Figure';picker.defaultString=name+'.png';
          reportExport(phase,1);phase=4;reportExport(phase,0);const answer=await picker.show();if(answer!==picker.returnOK&&answer!==picker.returnReplace){reportExport(phase,3);return {saved:false,cancelled:true};}
          reportExport(phase,1);phase=5;reportExport(phase,0);
          if(typeof picker.file!=='string'||!(/^(?:\/|[A-Za-z]:[\\/])/.test(picker.file))){reportExport(phase,2);return {saved:false,cancelled:false};}
          const file=home();file.initWithPath(picker.file);if(!file.parent.exists()||!file.parent.isDirectory()){reportExport(phase,2);return {saved:false,cancelled:false};}
          const saved=await atomic(file,bytes,true,answer!==picker.returnReplace);reportExport(phase,saved?1:2);return {saved,cancelled:false};
        }catch(_){reportExport(phase,2);return {saved:false,cancelled:false};}finally{exporting=false;}
      }
    };
  }
  const api={create};root.AskGPTPDFFigureMarkupStore=api;if(typeof module!=='undefined')module.exports=api;
})(this);
