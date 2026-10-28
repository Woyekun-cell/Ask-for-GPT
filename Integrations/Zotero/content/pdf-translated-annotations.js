(function(root){
  'use strict';
  const clone=value=>JSON.parse(JSON.stringify(value));
  const key=value=>typeof value==='string'&&/^[A-Z0-9]{8}$/.test(value);
  function failure(){const error=new Error('Translated PDF annotations could not be saved');error.code='translated_annotation';return error;}
  async function create({Zotero,item}={}){
    if(!Zotero?.Items?.get||!Zotero.Items.getByLibraryAndKey||!Zotero?.Annotations?.toJSONSync||!Zotero.Annotations.saveFromJSON||!Zotero?.Notifier?.Queue||!Zotero.Notifier.commit)return null;
    const identity={id:item?.id,libraryID:item?.libraryID,key:item?.key};
    function attachment(){
      const current=Zotero.Items.get(identity.id);
      if(!Number.isSafeInteger(identity.id)||identity.id<=0||!Number.isSafeInteger(identity.libraryID)||identity.libraryID<=0||!key(identity.key)||!current||current.deleted||current.id!==identity.id||current.libraryID!==identity.libraryID||current.key!==identity.key||current.isAttachment?.()!==true||current.attachmentContentType!=='application/pdf')throw failure();
      return current;
    }
    function owned(value){if(!value||value.deleted||value.isAnnotation?.()!==true||value.libraryID!==identity.libraryID||value.parentID!==identity.id||!key(value.key))throw failure();return value;}
    function editable(){const current=attachment();if(current.isEditable?.()!==true)throw failure();return current;}
    function fromItem(value){
      owned(value);const result=clone(Zotero.Annotations.toJSONSync(value));result.id=value.key;delete result.key;
      // Match Zotero Reader's own _getAnnotation normalization.
      for(const name in result)result[name]=result[name]||'';
      result.tags=result.tags||[];return result;
    }
    const current=attachment(),initial=await current.getAnnotations(),values=[];
    if(!Array.isArray(initial))throw failure();
    for(const annotation of initial){owned(annotation);if(typeof annotation.loadAllData==='function')await annotation.loadAllData();values.push(fromItem(annotation));}
    let annotations=values,queue=Promise.resolve();
    const enqueue=operation=>{const task=queue.then(operation);queue=task.catch(()=>{});return task;};
    function existing(id){const value=Zotero.Items.getByLibraryAndKey(identity.libraryID,id);return value?owned(value):null;}
    function checkWritable(value){if(value&&(value.isEditable?.()!==true||Zotero.Annotations.toJSONSync(value).readOnly))throw failure();}
    async function notified(operation){const notifierQueue=new Zotero.Notifier.Queue();try{return await operation(notifierQueue);}finally{await Zotero.Notifier.commit(notifierQueue);}}
    const instanceID=Zotero.Utilities?.randomString?.()||'askgpt-translated-annotations';
    return {
      get annotations(){return clone(annotations);},
      get readOnly(){try{return attachment().isEditable?.()!==true;}catch(_){return true;}},
      save(input,callback){
        let captured,error;try{captured=clone(input);}catch(caught){error=caught;}
        const task=enqueue(async()=>{
          if(error)throw error;const target=editable();
          if(!Array.isArray(captured))throw failure();
          const seen=new Set();for(const annotation of captured){
            if(!key(annotation?.id)||seen.has(annotation.id)||annotation.key!==undefined&&annotation.key!==annotation.id||annotation.libraryID!==undefined&&annotation.libraryID!==identity.libraryID||annotation.parentID!==undefined&&annotation.parentID!==identity.id||!['highlight','underline','note','text','image','ink'].includes(annotation.type)||!annotation.position||!Number.isSafeInteger(annotation.position.pageIndex)||annotation.position.pageIndex<0)throw failure();
            seen.add(annotation.id);checkWritable(existing(annotation.id));
          }
          return notified(async notifierQueue=>{
            for(const annotation of captured){
              // Recheck ownership immediately before each async write. The
              // stock saveFromJSON reparents an existing key without checking.
              editable();checkWritable(existing(annotation.id));
              const value={...annotation,key:annotation.id};delete value.authorName;
              const notifierData={instanceID};if(value.onlyTextOrComment&&Zotero.Notes?.AUTO_SYNC_DELAY!==undefined)notifierData.autoSyncDelay=Zotero.Notes.AUTO_SYNC_DELAY;
              const saved=owned(await Zotero.Annotations.saveFromJSON(target,value,{notifierQueue,notifierData})),normalized=fromItem(saved);
              annotations=[...annotations.filter(value=>value.id!==normalized.id),normalized];
            }
          });
        });
        return task.finally(()=>{if(typeof callback==='function')try{callback();}catch(caught){Zotero.logError?.(caught);}});
      },
      remove(input){
        let captured,error;try{captured=clone(input);}catch(caught){error=caught;}
        return enqueue(async()=>{
          if(error)throw error;editable();if(!Array.isArray(captured)||captured.some(id=>!key(id)))throw failure();
          const ids=[...new Set(captured)];for(const id of ids)checkWritable(existing(id));
          return notified(async notifierQueue=>{for(const id of ids){editable();const value=existing(id);checkWritable(value);if(value)await value.eraseTx({notifierQueue});annotations=annotations.filter(annotation=>annotation.id!==id);}});
        });
      },
      flush(){return queue;}
    };
  }
  const api={create};root.AskGPTPDFTranslatedAnnotations=api;if(typeof module!=='undefined')module.exports=api;
})(this);
