// The official basic viewer supplies the native macOS titlebar and window controls.
(function(root){
  'use strict';
  const VIEWER='chrome://zotero/content/standalone/basicViewer.xhtml';
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  let sequence=0;
  function open(options={}){
    return new Promise((resolve,reject)=>{
      const Services=options.Services||root.Services;
      let outer=null,browser=null,doc=null,contentWindow=null,ready=false,closed=false,fitted=false;
      const removers=[],initialRemovers=[],timers=new Set(),subscribers=new Set();
      const uri='about:blank#askgpt-preview-'+Date.now()+'-'+(++sequence);
      const trace=phase=>{try{options.reportDiagnostic?.(phase);}catch(_){}};
      const current=()=>typeof options.isCurrent!=='function'||options.isCurrent()!==false;
      const viewerDocument=()=>{const value=outer?.document;return (value?.documentURI||value?.URL)===VIEWER;};
      const exported=callback=>{
        const target=options.timerWindow||outer;
        if(options.exportCallback)return options.exportCallback(callback,target);
        const Cu=(options.Components||root.Components)?.utils;
        return Cu?.exportFunction?Cu.exportFunction(callback,target):callback;
      };
      function removeAll(bucket){for(const remove of bucket.splice(0)){try{remove();}catch(_){}}}
      function clearTimers(){for(const id of timers){try{(options.timerWindow||outer).clearTimeout(id);}catch(_){}}timers.clear();}
      function listen(target,type,callback,bucket=removers){
        const handler=exported(callback);target.addEventListener(type,handler,false);
        bucket.push(()=>target.removeEventListener(type,handler,false));
      }
      function schedule(callback,delay){
        let id;const handler=exported(()=>{timers.delete(id);if(closed)return;try{callback();}catch(_){retire('figure_window_content',true);}});
        id=(options.timerWindow||outer).setTimeout(handler,delay);timers.add(id);
      }
      function notify(callback){try{callback();}catch(_){}}
      function retire(code,closeWindow){
        if(closed)return false;trace(({figure_window_closed:11,figure_window_stale:12,figure_window_navigation:13,figure_window_timeout:14,figure_window_content:15,figure_window_open:16})[code]||19);closed=true;removeAll(initialRemovers);removeAll(removers);clearTimers();
        if(!ready)reject(new Error(code||'figure_window_closed'));
        for(const callback of subscribers)notify(callback);subscribers.clear();
        if(closeWindow&&outer&&!outer.closed){try{outer.close();}catch(_){}}
        return true;
      }
      function fit(width,height,toolbarHeight=36){
        if(closed||outer.closed)return null;
        if(!finite(width)||!finite(height)||width<=0||height<=0||!finite(toolbarHeight)||toolbarHeight<0)throw new Error('figure_window_dimensions');
        if(!fitted){
          fitted=true;const element=outer.document.documentElement,wasMaximized=element.getAttribute('sizemode')==='maximized'||finite(outer.STATE_MAXIMIZED)&&outer.windowState===outer.STATE_MAXIMIZED;
          element.removeAttribute('sizemode');if(wasMaximized&&typeof outer.restore==='function')outer.restore();
        }
        const screen=outer.screen||{},availableWidth=finite(screen.availWidth)&&screen.availWidth>0?screen.availWidth:1024,availableHeight=finite(screen.availHeight)&&screen.availHeight>0?screen.availHeight:768;
        const frameWidth=Math.max(0,(outer.outerWidth||0)-(outer.innerWidth||0)),frameHeight=Math.max(0,(outer.outerHeight||0)-(outer.innerHeight||0));
        const maxWidth=Math.max(1,Math.floor(availableWidth-64-frameWidth)),maxHeight=Math.max(1,Math.floor(availableHeight-64-frameHeight)),bar=Math.ceil(toolbarHeight);
        if(maxHeight<=bar)return null;
        const hasDisplaySize=finite(options.displayWidth)&&options.displayWidth>0&&finite(options.displayHeight)&&options.displayHeight>0;
        // Enlarge both image dimensions together for reading; backing pixels
        // and later refinement must not change the initial window size.
        const targetScale=hasDisplaySize?Math.min(options.displayWidth/width,options.displayHeight/height)*1.35:1;
        const scale=Math.min(targetScale,maxWidth/width,(maxHeight-bar)/height);
        const result={width:Math.min(maxWidth,Math.max(Math.min(180,maxWidth),Math.floor(width*scale))),height:Math.min(maxHeight,Math.max(1,Math.floor(height*scale))+bar)};
        const totalWidth=result.width+frameWidth,totalHeight=result.height+frameHeight;
        outer.resizeTo(totalWidth,totalHeight);
        if(typeof outer.moveTo==='function')outer.moveTo((finite(screen.availLeft)?screen.availLeft:0)+(availableWidth-totalWidth)/2,(finite(screen.availTop)?screen.availTop:0)+(availableHeight-totalHeight)/2);
        return result;
      }
      const host={
        get doc(){return doc;},get win(){return contentWindow;},get window(){return outer;},
        fit,close:()=>retire('figure_window_closed',true),
        onClose(callback){
          if(typeof callback!=='function')return ()=>{};
          if(closed){notify(callback);return ()=>{};}
          subscribers.add(callback);return ()=>subscribers.delete(callback);
        }
      };
      function probe(){
        if(closed)return;if(outer.closed){retire('figure_window_closed',false);return;}
        if(!current()){retire('figure_window_stale',true);return;}
        const next=browser.contentDocument,spec=browser.currentURI?.spec||next?.documentURI||next?.URL;
        if(ready){if(next!==doc||spec!==uri)retire('figure_window_navigation',true);return;}
        if(spec==='about:blank')return;
        if(spec!==uri){retire('figure_window_navigation',true);return;}
        if(!next||next.readyState!=='complete'||!next.body)return;
        doc=next;contentWindow=browser.contentWindow||doc.defaultView;
        if(!contentWindow){retire('figure_window_content',true);return;}
        doc.title='Preview';outer.document.title='Preview';doc.body.style.setProperty('margin','0');
        trace(5);ready=true;removeAll(initialRemovers);clearTimers();resolve(host);
      }
      function attachBrowser(){
        trace(4);
        if(!current()){retire('figure_window_stale',true);return;}
        browser=outer.document.querySelector('browser');
        if(!browser){retire('figure_window_content',true);return;}
        listen(browser,'pageshow',()=>{try{probe();}catch(_){retire('figure_window_content',true);}});
        probe();
      }
      function loaded(event){
        if(closed||event?.target&&event.target!==outer.document||!viewerDocument())return;
        if(!current()){retire('figure_window_stale',true);return;}
        trace(3);const element=outer.document.documentElement;
        element.style.removeProperty('min-width');element.style.removeProperty('min-height');element.removeAttribute('persist');outer.document.title='Preview';
        removeAll(initialRemovers);
        // basicViewer.js configures its browser in its own window load callback.
        schedule(attachBrowser,0);
      }
      try{
        if(!Services?.ww?.openWindow||!current())throw new Error('unavailable');
        // Keep the official script policy so exported UI listeners can run.
        // This owned browser is only given a unique local about:blank URI.
        const args={uri,options:{}};args.wrappedJSObject=args;
        const width=finite(options.width)&&options.width>=180?Math.ceil(options.width):640,height=finite(options.height)&&options.height>=100?Math.ceil(options.height):480;
        outer=Services.ww.openWindow(null,VIEWER,'_blank','chrome,dialog=no,resizable,centerscreen,width='+width+',height='+height,args);
        if(!outer)throw new Error('unavailable');trace(1);
        if(outer.closed){retire('figure_window_closed',false);return;}
        listen(outer,'unload',event=>{if(outer.closed||ready&&(!event?.target||event.target===outer.document))retire('figure_window_closed',false);else trace(2);});
        listen(outer,'load',event=>{try{loaded(event);}catch(_){retire('figure_window_content',true);}},initialRemovers);
        const timeout=finite(options.timeoutMs)?Math.max(1,Math.min(5000,options.timeoutMs)):5000;
        schedule(()=>retire('figure_window_timeout',true),timeout);
        if(viewerDocument()&&outer.document.readyState==='complete')loaded();
      }catch(_){retire('figure_window_open',true);}
    });
  }
  const api={open};root.AskGPTPDFFigureWindow=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(this);
