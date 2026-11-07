import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import darkCatalog, {whereinCatalog} from '../netlify/lib/film-profiles.mjs';
import {offlineSigningKey} from '../netlify/lib/offline-signing.mjs';

// Exercise the real portal routes and signing helper with an isolated store/provider.
// No generated test-handle file, credentials, live provider calls, or email deliveries.
const portalFile=new URL('../netlify/functions/portal.mjs',import.meta.url);
let source=await readFile(portalFile,'utf8');
for(const [before,after] of [
  ["import {begin as beginCalendar,events as calendarEvents} from './calendar-callback.mjs';",'const beginCalendar=()=>{},calendarEvents=()=>{};'],
  ["import sharp from 'sharp';",'const sharp=()=>{throw Error("Unexpected image operation");};'],
  ["import { getStore } from '@netlify/blobs';",'const getStore=()=>globalThis.__offlineRouteStore;'],
  ["import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';",'const PDFDocument={load:async()=>globalThis.__offlineRoutePdf},StandardFonts={Helvetica:"Helvetica"},rgb=()=>{};'],
  ["import {enqueue, mailReady, portalUrl} from '../lib/mail.mjs';",'const enqueue=async()=>{throw Error("Unexpected email delivery");},mailReady=()=>false,portalUrl="https://heidimikacfilms.com/members/";']
]){assert(source.includes(before),'Test seam must match the current source');source=source.replace(before,after);}
source=source.replace(/from '(\.\.?\/[^']+)'/g,(_,path)=>'from '+JSON.stringify(new URL(path,portalFile).href));
const {default:handle}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const keys={Nick:'a'.repeat(64),Heidi:'b'.repeat(64),member:'c'.repeat(64)};
const memberId='00000000-0000-4000-8000-000000000001';
const original=Buffer.from('%PDF-1.7\nOriginal uploaded actor-signed agreement\n%%EOF');
const productionId='written-in-the-dark',profile=darkCatalog[0];
process.env.HMF_NICK_LOGIN_SHA256='test-nick-digest';
process.env.HMF_HEIDI_LOGIN_SHA256='test-heidi-digest';
process.env.SIGNWELL_API_KEY='test-only-provider-key';
process.env.HMF_HEIDI_SIGNING_EMAIL='heidi@heidimikacfilms.com';
process.env.HMF_SIGNWELL_LIVE='yes';
globalThis.__offlineRoutePdf={
  getPages:()=>Array.from({length:2},()=>({getHeight:()=>792,drawRectangle:()=>{},drawText:()=>{}})),
  getForm:()=>({getTextField:()=>({setText:()=>{}}),updateFieldAppearances:()=>{},flatten:()=>{}}),
  embedFont:async()=>({widthOfTextAtSize:()=>1}),save:async()=>original
};

function makeStore(){
  const records=new Map();let revision=0;
  const store={records,
    async get(key){return records.has(key)?structuredClone(records.get(key).data):null;},
    async getMetadata(key){return records.has(key)?{metadata:structuredClone(records.get(key).metadata||{})}:null;},
    async getWithMetadata(key){return records.has(key)?structuredClone(records.get(key)):null;},
    async list({prefix}){return {blobs:[...records.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key}))};},
    async set(key,data,options={}){
      const old=records.get(key);
      if((options.onlyIfNew&&old)||(options.onlyIfMatch&&old?.etag!==options.onlyIfMatch))return {modified:false};
      records.set(key,{data:structuredClone(data),metadata:structuredClone(options.metadata||{}),etag:String(++revision)});
      return {modified:true};
    },
    async setJSON(key,data,options){return this.set(key,data,options);},
    async delete(key){records.delete(key);}
  };
  return store;
}
async function fixture({linked=false}={}){
  const store=makeStore(),calls=[],documents=new Map();
  globalThis.__offlineRouteStore=store;
  for(const name of ['Nick','Heidi','member'])await store.setJSON('sessions/'+hash(keys[name]),{
    id:name==='member'?memberId:name,admin:name!=='member',adminDigest:name==='member'?null:'test-'+name.toLowerCase()+'-digest',expires:Date.now()+3600000
  });
  await store.setJSON('members/'+memberId,{id:memberId,name:linked?profile.name:'Unrelated member',email:'member@example.com',role:'Actor',productions:{[productionId]:{role:'Actor',filmProfile:linked?profile.id:''}}});
  await store.set('offline/'+profile.id,original,{metadata:{status:'Waiting on Heidi'}});
  globalThis.fetch=async(input,options={})=>{
    const u=new URL(input);assert.equal(u.origin,'https://www.signwell.com');
    const body=options.body?JSON.parse(options.body):undefined;
    calls.push({path:u.pathname,method:options.method,body});
    if(options.method==='POST'){
      assert.equal(u.pathname,'/api/v1/documents/','No send or other provider mutation is allowed');
      const id='test-draft-'+documents.size;
      const document={id,status:'draft',embedded_edit_url:'https://www.signwell.com/app/edit/document/test-token/',recipients:body.recipients.map(recipient=>({...recipient,embedded_signing_url:'https://www.signwell.com/docs/test-token/'}))};
      documents.set(id,document);return Response.json(document);
    }
    assert.equal(options.method,'GET');
    const id=decodeURIComponent(u.pathname.split('/')[4]);
    assert(documents.has(id),'Unexpected provider document');
    return Response.json(documents.get(id));
  };
  return {store,calls,documents};
}
async function call(action,{body,who='Nick',id=profile.id,production=productionId,method,origin}={}){
  const u=new URL('https://heidimikacfilms.com/.netlify/functions/portal');u.search=new URLSearchParams({action,id,production});
  const raw=body instanceof Uint8Array;
  const response=await handle(new Request(u,{method:method||(body===undefined?'GET':'POST'),headers:{origin:origin||u.origin,'content-type':raw?'application/pdf':'application/json',...(who?{cookie:'__Host-hmf='+keys[who]}:{})},body:body===undefined?undefined:raw?body:JSON.stringify(body)}));
  return {status:response.status,data:await response.json().catch(()=>null)};
}
const prepare=options=>call('prepareOfflineCountersign',{body:{},...options});

test('offline routes enforce authentication, administrator access, method, and origin',async()=>{
  const {calls}=await fixture();
  assert.equal((await prepare({who:null})).status,401);
  assert.equal((await prepare({who:'member'})).status,403);
  assert.equal((await call('offlineCountersignStatus',{who:'member'})).status,403);
  assert.equal((await call('prepareOfflineCountersign')).status,405);
  assert.equal((await call('offlineCountersignStatus',{body:{}})).status,405);
  assert.equal((await prepare({origin:'https://other.example'})).status,403);
  assert.equal(calls.length,0);
});

test('preparation creates one unsent draft and blocks source replacement and the regular route',async()=>{
  const {store,calls}=await fixture({linked:true});
  const first=await prepare();assert.equal(first.status,200);assert.equal(first.data.created,true);
  assert.equal(first.data.offlineSigning.status,'Draft prepared');
  assert.equal((await prepare()).data.created,false);assert.equal(calls.length,1);
  assert.equal(calls[0].body.draft,true);
  assert.deepEqual(calls[0].body.recipients,[{id:'2',name:'Heidi Mikac',email:'heidi@heidimikacfilms.com',send_email:true}]);
  assert.deepEqual(Buffer.from(calls[0].body.files[0].file_base64,'base64'),original);
  assert.equal((await call('offline',{body:Buffer.from('%PDF-replacement')})).status,409);
  assert.equal((await call('agreement',{id:memberId,body:{}})).status,409);
  assert.deepEqual(Buffer.from(await store.get('offline/'+profile.id)),original);
  assert.equal(calls.length,1);
});

test('status exposes only a fresh draft edit URL or the authorized Heidi signing URL',async()=>{
  const {store,documents}=await fixture();const created=await prepare(),id=created.data.offlineSigning.id;
  const recordBefore=await store.get(offlineSigningKey(profile.id,productionId)),document=documents.get(id);
  let result;
  for(const status of ['draft','Draft']){
    document.status=status;
    result=await call('offlineCountersignStatus');assert.equal(result.data.status,'Draft prepared');assert.equal(result.data.editUrl,document.embedded_edit_url);assert.equal(result.data.url,null);
  }
  document.status='Created';
  result=await call('offlineCountersignStatus',{who:'Heidi'});assert.equal(result.data.editUrl,null);assert.equal(result.data.url,null);
  for(const status of ['sent','Sent','pending','Pending']){
    document.status=status;
    result=await call('offlineCountersignStatus');assert.equal(result.data.editUrl,null);assert.equal(result.data.url,null);
    result=await call('offlineCountersignStatus',{who:'Heidi'});assert.equal(result.data.status,'Waiting on Heidi');assert.equal(result.data.url,document.recipients[0].embedded_signing_url);
  }
  document.recipients[0].embedded_signing_url='https://signwell.com.evil.example/docs/token';
  assert.equal((await call('offlineCountersignStatus',{who:'Heidi'})).data.url,null);
  document.recipients[0].email='wrong@example.com';
  result=await call('offlineCountersignStatus',{who:'Heidi'});assert.equal(result.data.url,null);assert(result.data.offlineSigning.syncError);
  const recordAfter=await store.get(offlineSigningKey(profile.id,productionId));
  assert.equal(recordAfter.sourceHash,recordBefore.sourceHash);assert.equal(recordAfter.profileId,profile.id);
  assert(!JSON.stringify(recordAfter).includes('signwell.com'));
});

test('admin paperwork follows the draft while the member’s original signed upload stays complete',async()=>{
  await fixture({linked:true});await prepare();
  let result=await call('home');
  const catalogRow=result.data.catalog.find(row=>row.id===profile.id),member=result.data.members.find(row=>row.id===memberId);
  assert.equal(catalogRow.offline,'Waiting on Heidi');assert.equal(catalogRow.offlineSigning.status,'Draft prepared');assert.equal(catalogRow.paperworkStatus,'Draft prepared');
  assert.equal(member.paperworkStatus,'Draft prepared');assert.equal(member.memberPaperworkStatus,'Complete');
  result=await call('home',{who:'member'});
  assert.equal(result.data.members[0].memberPaperworkStatus,'Complete');assert.equal(result.data.members[0].offlineSigning,undefined);
  assert.deepEqual(result.data.catalog,[]);
});

test('incomplete uploads and linked online records block creation; another production stays isolated',async()=>{
  const {store,calls}=await fixture({linked:true});
  await store.set('offline/'+profile.id,original,{metadata:{status:'Missing page 1 · waiting on Heidi'}});
  assert.equal((await prepare()).status,409);assert.equal(calls.length,0);
  await store.set('offline/'+profile.id,original,{metadata:{status:'Waiting on Heidi'}});
  await store.setJSON('agreements/'+memberId,{id:'existing-online',status:'Waiting on actor',checkedAt:Date.now()});
  assert.equal((await prepare()).status,409);assert.equal(calls.length,0);
  const other=whereinCatalog[0],otherProduction='wherein-lies-continue';
  await store.set('productions/'+otherProduction+'/offline/'+other.id,original,{metadata:{status:'Waiting on Heidi'}});
  const result=await prepare({id:other.id,production:otherProduction});assert.equal(result.status,200);
  assert(await store.get(offlineSigningKey(other.id,otherProduction)));
  assert.equal(await store.get(offlineSigningKey(profile.id,productionId)),null);
});

test('post-reservation checks block each route when the other route reserves during preparation',async()=>{
  let context=await fixture({linked:true}),save=context.store.set.bind(context.store);
  context.store.set=async(key,value,options)=>{
    const result=await save(key,value,options);
    if(key.startsWith('offline-signing-sources/'))await save('agreements/'+memberId,{status:'Preparing regular request'});
    return result;
  };
  assert.equal((await prepare()).status,409);assert.equal(context.calls.length,0);
  assert.equal((await context.store.get(offlineSigningKey(profile.id,productionId))).status,'Needs recovery');
  context=await fixture({linked:true});save=context.store.set.bind(context.store);
  await context.store.set('contract/master',original);
  context.store.set=async(key,value,options)=>{
    const result=await save(key,value,options);
    if(key==='agreements/'+memberId&&options?.onlyIfNew)await save(offlineSigningKey(profile.id,productionId),{profileId:profile.id,productionId,status:'Preparing draft'});
    return result;
  };
  const result=await call('agreement',{id:memberId,body:{legal:profile.name,character:'Actor',credit:profile.name,rate:'100',date:'2026-11-07',start:'2026-12-01'}});
  assert.equal(result.status,409,JSON.stringify(result.data));assert.equal(context.calls.length,0);
});
