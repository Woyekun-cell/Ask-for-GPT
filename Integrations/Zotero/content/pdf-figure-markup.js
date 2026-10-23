(function(root){
  'use strict';
  const MAX_BYTES=2*1024*1024,COLORS=['#FF3B30','#FF9500','#FFCC00','#34C759','#007AFF','#AF52DE','#FFFFFF','#000000'];
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  const clone=value=>JSON.parse(JSON.stringify(value));
  function size(value){let bytes=0;for(const c of JSON.stringify(value)){const n=c.codePointAt(0);bytes+=n<128?1:n<2048?2:n<65536?3:4;}return bytes;}
  function validateBinding(value){try{
    if(!value||!Number.isSafeInteger(value.libraryID)||value.libraryID<0||typeof value.itemKey!=='string'||!/^[A-Z0-9]{8}$/.test(value.itemKey)||typeof value.fingerprint!=='string'||!/^[a-f0-9]{16,128}$/.test(value.fingerprint)||!Number.isInteger(value.pageIndex)||value.pageIndex<0||value.pageIndex>=2000||!Array.isArray(value.rect)||value.rect.length!==4)return null;
    const rect=[value.rect[0],value.rect[1],value.rect[2],value.rect[3]];if(!rect.every(n=>finite(n)&&Math.abs(n)<=10000000)||rect[2]<=rect[0]||rect[3]<=rect[1])return null;
    return {libraryID:value.libraryID,itemKey:value.itemKey,fingerprint:value.fingerprint,pageIndex:value.pageIndex,rect};
  }catch(_){return null;}}
  function validateMark(value){
    if(!value||!['pen','rect','arrow','text'].includes(value.type)||typeof value.color!=='string'||!/^#[a-f0-9]{6}$/i.test(value.color)||!finite(value.width)||value.width<.001||value.width>.05||!Array.isArray(value.points))return null;
    const count=value.points.length;if(value.type==='pen'?(count<1||count>4096):count!==(value.type==='text'?1:2))return null;
    const points=[];for(let i=0;i<count;i++){const point=value.points[i];if(!Array.isArray(point)||point.length!==2)return null;const local=[point[0],point[1]];if(!local.every(n=>finite(n)&&n>=0&&n<=1))return null;points.push(local);}
    if(value.type==='rect'&&(points[0][0]===points[1][0]||points[0][1]===points[1][1])||value.type==='arrow'&&points[0][0]===points[1][0]&&points[0][1]===points[1][1])return null;
    const result={type:value.type,color:value.color.toUpperCase(),width:value.width,points};
    if(value.type==='text'){if(typeof value.text!=='string'||!value.text.trim()||value.text.length>1000||Array.from(value.text).length>500||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.text))return null;result.text=value.text.replace(/\r\n?/g,'\n');}return result;
  }
  function validateMarks(value){try{if(!Array.isArray(value)||value.length>256)return null;const result=[];let bytes=2;for(let i=0;i<value.length;i++){const checked=validateMark(value[i]);if(!checked)return null;bytes+=size(checked)+(i?1:0);if(bytes>MAX_BYTES)return null;result.push(checked);}return result;}catch(_){return null;}}
  function validateRecord(value){try{if(value?.schema!==1)return null;const binding=validateBinding(value.binding),marks=validateMarks(value.marks);if(!binding||!marks)return null;const result={schema:1,binding,marks};return size(result)<=MAX_BYTES?result:null;}catch(_){return null;}}
  function createHistory(initial=[]){
    let states=[validateMarks(initial)||[]],index=0,total=size(states[0]),sizes=[total];
    function push(next){const bytes=size(next);if(bytes>MAX_BYTES)return false;states=states.slice(0,index+1);sizes=sizes.slice(0,index+1);total=sizes.reduce((sum,value)=>sum+value,0);states.push(next);sizes.push(bytes);total+=bytes;index++;
      while(states.length>1&&(states.length>101||total>MAX_BYTES)){states.shift();total-=sizes.shift();index--;}return true;}
    return {get marks(){return clone(states[index]);},get canUndo(){return index>0;},get canRedo(){return index+1<states.length;},
      commit(value){try{const mark=validateMark(value);if(!mark||states[index].length>=256)return false;return push([...states[index],mark]);}catch(_){return false;}},
      undo(){if(index<1)return false;index--;return true;},redo(){if(index+1>=states.length)return false;index++;return true;},clear(){return states[index].length?push([]):false;}};
  }
  function paint(ctx,width,height,values){
    const marks=validateMarks(values);if(!marks||!finite(width)||!finite(height)||width<=0||height<=0||width*height>16777216||!ctx)return false;
    const short=Math.min(width,height);let saved=false;
    try{ctx.save();saved=true;ctx.lineCap='round';ctx.lineJoin='round';for(const mark of marks){const points=mark.points.map(p=>[p[0]*width,p[1]*height]),line=mark.width*short;ctx.strokeStyle=mark.color;ctx.fillStyle=mark.color;ctx.lineWidth=line;
      if(mark.type==='rect'){const [a,b]=points;ctx.strokeRect(Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.abs(b[0]-a[0]),Math.abs(b[1]-a[1]));}
      else if(mark.type==='text'){const font=Math.max(8,short*mark.width*4);ctx.font=font+'px -apple-system, BlinkMacSystemFont, sans-serif';ctx.textBaseline='top';for(const [i,text] of mark.text.split('\n').entries())ctx.fillText(text,points[0][0],points[0][1]+i*font*1.25);}
      else{ctx.beginPath();ctx.moveTo(...points[0]);for(let i=1;i<points.length;i++)ctx.lineTo(...points[i]);if(points.length===1){ctx.arc(points[0][0],points[0][1],line/2,0,Math.PI*2);ctx.fill();}else{if(mark.type==='arrow'){const [a,b]=points,angle=Math.atan2(b[1]-a[1],b[0]-a[0]),length=Math.hypot(b[0]-a[0],b[1]-a[1]),head=Math.min(length*.4,Math.max(line*4,short*.02));for(const turn of [-Math.PI/6,Math.PI/6]){ctx.moveTo(...b);ctx.lineTo(b[0]-head*Math.cos(angle+turn),b[1]-head*Math.sin(angle+turn));}}ctx.stroke();}}
    }return true;}catch(_){return false;}finally{if(saved)try{ctx.restore();}catch(_){}}
  }
  const api={COLORS:COLORS.slice(),validateBinding,validateRecord,createHistory,paint};root.AskGPTPDFFigureMarkup=api;if(typeof module!=='undefined')module.exports=api;
})(this);
