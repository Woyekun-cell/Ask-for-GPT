(function(root){
  'use strict';
  const XHTML='http://www.w3.org/1999/xhtml';
  function create(options){
    const {doc,win,anchor}=options,removers=[],rowRemovers=[];
    let disposed=false,entries=[],done=false,failed=false,completed=0,total=0,side='source',renderKey=null;
    const element=(name,text)=>{const node=doc.createElementNS(XHTML,name);if(text!=null)node.textContent=text;return node;};
    const panel=element('section'),heading=element('div','图表定位'),choices=element('div'),list=element('div'),status=element('div'),style=element('style');
    panel.className='askgpt-figure-panel';panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','图表定位');heading.className='askgpt-figure-heading';choices.className='askgpt-figure-targets';choices.setAttribute('role','group');choices.setAttribute('aria-label','定位到哪一侧');list.className='askgpt-figure-list';status.className='askgpt-figure-status';status.setAttribute('role','status');
    style.textContent='.askgpt-figure-panel{position:fixed;z-index:91;box-sizing:border-box;width:300px;max-width:calc(100vw - 16px);padding:9px;border:var(--material-panedivider,1px solid #8883);border-radius:8px;background:var(--material-toolbar,Canvas);color:var(--fill-primary,CanvasText);font:12px -apple-system,sans-serif;box-shadow:0 4px 18px #0003}.askgpt-figure-panel[hidden]{display:none!important}.askgpt-figure-heading{font-weight:600;margin:1px 3px 8px}.askgpt-figure-targets{display:flex;gap:3px;padding:2px;border-radius:6px;background:var(--fill-quinary,#8881)}.askgpt-figure-panel button{font:inherit;color:inherit;border:0;border-radius:4px;background:transparent;cursor:default;text-align:left}.askgpt-figure-targets button{flex:1;min-height:25px;text-align:center}.askgpt-figure-targets button[aria-pressed=true]{background:var(--material-background,Canvas);box-shadow:0 1px 3px #0002}.askgpt-figure-list{max-height:330px;overflow:auto;margin-top:7px}.askgpt-figure-list button{display:block;width:100%;padding:7px}.askgpt-figure-list button:hover{background:var(--fill-quinary,#8882)}.askgpt-figure-panel button:disabled{opacity:.4}.askgpt-figure-panel button:focus-visible{outline:2px solid var(--accent-blue,#007aff);outline-offset:-2px}.askgpt-figure-list strong,.askgpt-figure-list small{display:block}.askgpt-figure-list small{margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.65}.askgpt-figure-status{font-size:11px;opacity:.65;margin:7px 3px 2px}';
    const listen=(node,type,callback,capture=false,bucket=removers)=>{try{const handler=options.exportCallback?options.exportCallback(callback):callback;node.addEventListener(type,handler,capture);bucket.push(()=>node.removeEventListener(type,handler,capture));}catch(error){disposed=true;for(const remove of [...rowRemovers.splice(0),...removers.splice(0)])remove();panel.remove();style.remove();throw error;}};
    const left=element('button','左侧'),right=element('button','右侧');for(const node of [left,right])node.setAttribute('type','button');choices.append(left,right);panel.append(heading,choices,list,status);doc.head.appendChild(style);doc.body.appendChild(panel);
    function close(){panel.hidden=true;anchor.setAttribute('aria-expanded','false');}
    function position(){const box=anchor.getBoundingClientRect?.(),bounds=panel.getBoundingClientRect?.(),width=win.innerWidth||1024,height=win.innerHeight||768;panel.style.setProperty('left',Math.max(8,Math.min(width-(bounds?.width||300)-8,(box?.right||width-8)-(bounds?.width||300)))+'px');panel.style.setProperty('top',Math.max(8,Math.min(height-(bounds?.height||380)-8,(box?.bottom||0)+4))+'px');}
    function render(){
      if(disposed||panel.hidden)return;const state=options.getState?.()||{};left.disabled=!state.source;right.disabled=!state.target;
      if(side==='source'&&left.disabled&&state.target)side='target';else if(side==='target'&&right.disabled&&state.source)side='source';
      const key=JSON.stringify([entries,side,Boolean(state.source),Boolean(state.target),state.pages]);
      if(key!==renderKey){renderKey=key;for(const remove of rowRemovers.splice(0))remove();
      left.setAttribute('aria-pressed',String(side==='source'));right.setAttribute('aria-pressed',String(side==='target'));list.textContent='';
      for(const entry of entries){const node=element('button'),title=element('strong',entry.label+' · '+(entry.pageIndex+1)),caption=element('small',(entry.captionPageIndex!==undefined&&entry.captionPageIndex!==entry.pageIndex?'说明 · '+(entry.captionPageIndex+1)+' 页 · ':'')+(entry.caption||''));node.setAttribute('type','button');node.setAttribute('data-figure-id',entry.id);node.setAttribute('aria-label',entry.label+'，第 '+(entry.pageIndex+1)+' 页，'+(side==='source'?'左侧':'右侧'));node.disabled=side==='source'?!state.source:!state.target||!state.pages?.includes(entry.pageIndex);node.append(title,caption);listen(node,'click',()=>{if(disposed||node.disabled)return;close();options.onJump?.(entry,side);},false,rowRemovers);list.appendChild(node);}
      }
      status.textContent=failed?'无法读取图表标题':!done?'读取图表'+(total?' · '+completed+' / '+total:'…'):entries.length?'选择一侧后定位，另一侧位置保留':'未识别到图表标题';
      if(!panel.hidden)position();
    }
    listen(left,'click',()=>{if(!left.disabled){side='source';render();}});listen(right,'click',()=>{if(!right.disabled){side='target';render();}});
    listen(panel,'keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();anchor.focus?.();}});
    listen(win,'resize',()=>{if(!panel.hidden)position();});listen(win,'blur',close);
    return {element:panel,close,get open(){return !panel.hidden;},refresh:render,
      toggle(){if(disposed)return;if(!panel.hidden){close();return;}const state=options.getState?.()||{};side=state.side==='target'?'target':'source';panel.hidden=false;anchor.setAttribute('aria-expanded','true');render();position();try{const pending=options.onOpen?.();Promise.resolve(pending).catch(()=>{if(!disposed){failed=true;render();}});}catch(_){failed=true;render();}},
      setEntries(value,progress={}){if(disposed)return;entries=Array.isArray(value)?value.slice(0,2000):[];done=progress.done===true;failed=progress.failed===true;completed=progress.completed||0;total=progress.total||0;render();},
      dispose(){if(disposed)return;disposed=true;close();for(const remove of rowRemovers.splice(0))remove();for(const remove of removers.splice(0))remove();panel.remove();style.remove();}
    };
  }
  const api={create};root.AskGPTPDFFigurePanel=api;if(typeof module!=='undefined')module.exports=api;
})(this);
