// Runs the Apps Script backend against in-memory mocks of Google services: node tests/backend.test.js
const fs = require('fs'), vm = require('vm');
// ---- tiny Apps Script mocks ----
class Range { constructor(sh,r,c,nr,nc){Object.assign(this,{sh,r,c,nr,nc});}
  getValues(){const o=[];for(let i=0;i<this.nr;i++){const row=[];for(let j=0;j<this.nc;j++){const v=(this.sh.data[this.r-1+i]||[])[this.c-1+j];row.push(v===undefined?'':v);}o.push(row);}return o;}
  getDisplayValues(){return this.getValues().map(r=>r.map(v=>v instanceof Date?v.toLocaleString():String(v)));}
  setValues(v){v.forEach((row,i)=>{const t=this.sh.data[this.r-1+i]||(this.sh.data[this.r-1+i]=[]);row.forEach((x,j)=>t[this.c-1+j]=x);});return this;}
  setFontWeight(){return this;} }
let sid=100;
class Sheet { constructor(name,data=[]){this.name=name;this.data=data;this.id=sid++;this.formUrl=null;}
  getName(){return this.name} setName(n){this.name=n} getSheetId(){return this.id} getFormUrl(){return this.formUrl}
  getLastRow(){return this.data.length} getLastColumn(){return Math.max(0,...this.data.map(r=>r.length))}
  getRange(r,c,nr=1,nc=1){return new Range(this,r,c,nr,nc)} setFrozenRows(){}
  appendRow(row){this.data.push(row)} deleteRow(r){this.data.splice(r-1,1)} }
const files={};
class SS { constructor(name){this.name=name;this.id='ss'+Object.keys(files).length+'xxxxxxxxxxxxxxxxxxxxxx';this.sheets=[new Sheet('Sheet1')];files[this.id]=this;}
  getId(){return this.id} getName(){return this.name} getUrl(){return 'https://docs.google.com/spreadsheets/d/'+this.id}
  getSheets(){return this.sheets} getSheetByName(n){return this.sheets.find(s=>s.name===n)||null} insertSheet(n){const s=new Sheet(n);this.sheets.push(s);return s;} }
const forms={};
const props={};
const triggers=[];
const sent=[]; const fetched=[];
const ctx = {
  console, JSON, Math, Date, String, Number, Array, Object, Error, isNaN,
  Logger:{log:m=>console.log('  LOG',m)},
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]??null,setProperty:(k,v)=>props[k]=String(v),deleteProperty:k=>delete props[k]})},
  Utilities:{getUuid:()=>require('crypto').randomUUID()},
  Session:{getEffectiveUser:()=>({getEmail:()=>'me@example.com'})},
  SpreadsheetApp:{create:n=>new SS(n),openById:id=>{if(!files[id])throw new Error('nf');return files[id];}},
  FormApp:{openById:id=>{if(!forms[id])throw new Error('nf');return forms[id];}},
  ScriptApp:{getProjectTriggers:()=>triggers,deleteTrigger:t=>triggers.splice(triggers.indexOf(t),1),
    newTrigger:fn=>{const t={fn,src:null,uid:'u'+triggers.length};const b={forForm:id=>(t.src=id,b),forSpreadsheet:x=>(t.src=typeof x==='string'?x:x.getId(),b),onFormSubmit:()=>b,timeBased:()=>b,everyMinutes:()=>b,
      create:()=>{triggers.push({getHandlerFunction:()=>t.fn,getTriggerSourceId:()=>t.src,getUniqueId:()=>t.uid});}};return b;}},
  LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
  MailApp:{sendEmail:o=>sent.push(o),getRemainingDailyQuota:()=>99},
  UrlFetchApp:{fetch:(u,o)=>{fetched.push([u,JSON.parse(o.payload)]);return{getResponseCode:()=>200,getContentText:()=>''};}},
  ContentService:{MimeType:{JSON:'json'},createTextOutput:t=>({t,setMimeType(){return JSON.parse(this.t);}})},
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(require('path').join(__dirname, '../apps-script/Code.gs'),'utf8'), ctx);
const call=(action,extra={})=>ctx.doPost({postData:{contents:JSON.stringify({key:props.API_KEY,action,...extra})}});
const assert=(c,m)=>{if(!c){console.error('FAIL',m);process.exitCode=1;}else console.log('ok',m);};

ctx.setup();
assert(triggers.some(t=>t.getHandlerFunction()==='syncAll'),'sync trigger created');
assert(ctx.doPost({postData:{contents:JSON.stringify({key:'nope',action:'status'})}}).code==='auth','bad key rejected');

// a form with 2 existing responses
const mkResp=(id,t,ans)=>({getId:()=>id,getTimestamp:()=>new Date(t),getRespondentEmail:()=>'',getItemResponses:()=>ans.map(([q,a])=>({getItem:()=>({getTitle:()=>q}),getResponse:()=>a}))});
const FID='FORMID_aaaaaaaaaaaaaaaaaaaaaa';
const fresp=[mkResp('a',1000,[['Name','A'],['Gear',['Tripod','Mic']]]),mkResp('b',2000,[['Name','B'],['Gear',['Cam']]])];
forms[FID]={getTitle:()=>'Gear Request',getEditUrl:()=>'https://docs.google.com/forms/d/'+FID+'/edit',getResponses:d=>fresp.filter(r=>!d||r.getTimestamp()>=d)};

assert(/edit mode/.test(call('addSource',{url:'https://docs.google.com/forms/d/e/1FAIpQLSf/viewform'}).error),'viewform link explained');
let r=call('addSource',{url:'https://docs.google.com/forms/d/'+FID+'/edit'});
assert(r.ok && r.result.count===2,'form linked, 2 imported '+JSON.stringify(r));
assert(call('addSource',{url:'https://docs.google.com/forms/d/'+FID+'/edit'}).error.includes('already linked'),'duplicate rejected');
let list=call('listResponses').result;
assert(list.total===2 && list.unread===0 && list.items[0].id==='b','imported marked read, newest first');
assert(list.items[1].data[1][1]==='Tripod, Mic','checkbox answers joined');

// new submission via trigger
call('saveSettings',{settings:{ntfyEnabled:true,ntfyTopic:'t1',webhookEnabled:true,webhookUrl:'https://discord.com/api/webhooks/1/x',appUrl:'https://app'}});
fresp.push(mkResp('c',3000,[['Name','C'],['Gear','Light']]));
const ft=triggers.find(t=>t.getTriggerSourceId()===FID);
ctx.handleFormSubmit({triggerUid:ft.getUniqueId()});
list=call('listResponses').result;
assert(list.total===3 && list.unread===1 && list.items[0].id==='c','new response stored unread');
assert(sent.length===1 && sent[0].subject.includes('Gear Request') && sent[0].to==='me@example.com','email sent');
assert(fetched.length===2 && fetched[0][1].topic==='t1' && fetched[0][1].click==='https://app' && 'content' in fetched[1][1],'ntfy + discord sent');
ctx.syncAll();
assert(call('listResponses').result.total===3,'no duplicates on resync');

// sheet source with manual rows
const ss=new SS('Signups'); ss.sheets[0].data=[['Timestamp','Name','Shift'],[new Date(5000),'Sam','AM']];
r=call('addSource',{url:ss.getUrl()+'/edit#gid='+ss.sheets[0].id,importExisting:false});
assert(r.ok && r.result.count===0 && r.result.name==='Signups › Sheet1','sheet linked without import');
ss.sheets[0].data.push([new Date(6000),'Jo','PM'],['','','']);
const before=sent.length; ctx.syncAll();
list=call('listResponses',{sourceId:r.result.id}).result;
assert(list.total===1 && list.items[0].data[1][1]==='Jo','new sheet row picked up, blank skipped');
assert(sent.length===before+1,'notified for sheet row');
call('updateSource',{id:r.result.id,notify:false});
ss.sheets[0].data.push([new Date(7000),'Kim','AM']); ctx.syncAll();
assert(sent.length===before+1,'notify off respected');

// search, mark read, delete, remove
assert(call('listResponses',{q:'kim'}).result.total===1,'search');
assert(call('markRead',{all:true}).ok && call('listResponses').result.unread===0,'mark all read');
const cid=call('listResponses',{q:'light'}).result.items[0].id;
call('deleteResponses',{ids:[cid]}); assert(call('listResponses').result.total===4,'delete one');
call('removeSource',{id:r.result.id,deleteResponses:true});
assert(call('listResponses').result.total===2 && !triggers.some(t=>t.getTriggerSourceId()===ss.id),'remove source + trigger + responses');
assert(call('testNotification').result.sentTo.length===3,'test notification');
assert(call('status').ok,'status');
