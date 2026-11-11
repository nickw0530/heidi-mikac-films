import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import darkCatalog, {whereinCatalog} from '../netlify/lib/film-profiles.mjs';

// Exercise the real portal routes and signing helper with an isolated store/provider.
// No generated test-handle file, credentials, live provider calls, or email deliveries.
const portalFile=new URL('../netlify/functions/portal.mjs',import.meta.url);
let source=await readFile(portalFile,'utf8');
for(const [before,after] of [
  ["import {begin as beginCalendar,events as calendarEvents} from './calendar-callback.mjs';",'const beginCalendar=()=>{},calendarEvents=()=>{};'],
  ["import sharp from 'sharp';",'const sharp=()=>{throw Error("Unexpected image operation");};'],
  ["import { getStore } from '@netlify/blobs';",'const getStore=()=>globalThis.__offlineRouteStore;'],
  ["import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';",'const PDFDocument={},StandardFonts={},rgb=()=>{};'],
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

function makeStore(){
  const records=new Map();let revision=0;
  const store={records,
    async get(key){return records.has(key)?structuredClone(records.get(key).data):null;},
    async getMetadata(key){return records.has(key)?{metadata:structuredClone(records.get(key).metadata||{})}:null;},
    async getWithMetadata(key){return records.has(key)?structuredClone(records.get(key)):null;},
    list({prefix,paginate}){
      const page={blobs:[...records.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key}))};
      return paginate?(async function*(){yield page;})():Promise.resolve(page);
    },
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
  const store=makeStore(),calls=[];
  globalThis.__offlineRouteStore=store;
  for(const name of ['Nick','Heidi','member'])await store.setJSON('sessions/'+hash(keys[name]),{
    id:name==='member'?memberId:name,admin:name!=='member',adminDigest:name==='member'?null:'test-'+name.toLowerCase()+'-digest',expires:Date.now()+3600000
  });
  await store.setJSON('members/'+memberId,{id:memberId,name:linked?profile.name:'Unrelated member',email:'member@example.com',role:'Actor',productions:{[productionId]:{role:'Actor',filmProfile:linked?profile.id:''}}});
  await store.set('offline/'+profile.id,original,{metadata:{status:'Waiting on Heidi'}});
  globalThis.fetch=async input=>{calls.push(String(input));throw Error('Archived files must not trigger a signing-provider request.');};
  return {store,calls};
}
async function call(action,{body,who='Nick',id=profile.id,production=productionId,method,origin,params={}}={}){
  const u=new URL('https://heidimikacfilms.com/.netlify/functions/portal');u.search=new URLSearchParams({action,id,production,...params});
  const raw=body instanceof Uint8Array;
  const response=await handle(new Request(u,{method:method||(body===undefined?'GET':'POST'),headers:{origin:origin||u.origin,'content-type':raw?'application/pdf':'application/json',...(who?{cookie:'__Host-hmf='+keys[who]}:{})},body:body===undefined?undefined:raw?body:JSON.stringify(body)}));
  const data=response.headers.get('content-type')==='application/pdf'?Buffer.from(await response.arrayBuffer()):await response.json();
  return {status:response.status,data};
}
const prepare=options=>call('prepareOfflineCountersign',{body:{},...options});

test('archived paper agreement routes enforce authentication and disable new signing drafts',async()=>{
  const {calls}=await fixture();
  assert.equal((await prepare({who:null})).status,401);
  assert.equal((await prepare({who:'member'})).status,403);
  assert.equal((await call('offlineCountersignStatus',{who:'member'})).status,403);
  assert.equal((await call('prepareOfflineCountersign')).status,409);
  assert.equal((await prepare()).status,409);
  assert.equal((await call('offlineCountersignStatus',{body:{}})).status,409);
  assert.equal((await prepare({origin:'https://other.example'})).status,403);
  assert.equal(calls.length,0);
});

test('the original bytes remain downloadable from the archive without satisfying the current requirement',async()=>{
  const {calls}=await fixture({linked:true});
  assert.equal((await call('offline',{body:Buffer.from('%PDF-replacement')})).status,409);
  const adminCopy=await call('offline');
  assert.equal(adminCopy.status,200);assert.deepEqual(adminCopy.data,original);
  const memberCopy=await call('memberDocument',{who:'member',id:memberId,params:{kind:'uploaded'}});
  assert.equal(memberCopy.status,200);assert.deepEqual(memberCopy.data,original);
  for(const who of ['Nick','member']){
    const result=await call('home',{who});
    assert.equal(result.status,200);
    const member=result.data.members.find(row=>row.id===memberId);
    assert.equal(member.previousOfflineStatus,'Waiting on Heidi');
    assert.equal(member.paperworkStatus,'No agreement on file');
    assert(member.documents.some(doc=>doc.kind==='uploaded'));
  }
  assert.equal(calls.length,0);
});

test('archived documents require an owned profile and remain isolated by production',async()=>{
  const {store,calls}=await fixture();
  assert.equal((await call('memberDocument',{who:'member',id:memberId,params:{kind:'uploaded'}})).status,404);
  const other=whereinCatalog[0],otherProduction='wherein-lies-continue';
  assert.equal((await call('offline',{id:other.id,production:otherProduction})).status,404);
  const otherCopy=Buffer.from('%PDF-1.7\nSeparate production\n%%EOF');
  await store.set('productions/'+otherProduction+'/offline/'+other.id,otherCopy,{metadata:{status:'Waiting on Heidi'}});
  assert.deepEqual((await call('offline',{id:other.id,production:otherProduction})).data,otherCopy);
  assert.deepEqual((await call('offline')).data,original);
  assert.equal(calls.length,0);
});
