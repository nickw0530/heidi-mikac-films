import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {AGREEMENT_CYCLE,currentAgreementKey,currentAgreementPrefix,supersededContractNotice} from '../netlify/lib/agreement-cycle.mjs';
import {adminActions} from '../netlify/lib/admin-actions.mjs';
import {checkSigningNotices} from '../netlify/lib/signing-notices.mjs';
import darkCatalog from '../netlify/lib/film-profiles.mjs';

const data=new Map();let revision=0;
const clone=value=>value===undefined?undefined:structuredClone(value);
const store={
 async get(key){return clone(data.get(key)?.value)??null;},
 async getMetadata(key){const record=data.get(key);return record?{etag:record.etag,metadata:clone(record.metadata)}:null;},
 async getWithMetadata(key){const record=data.get(key);return record?{data:clone(record.value),etag:record.etag,metadata:clone(record.metadata)}:null;},
 async set(key,value,options={}){const prior=data.get(key);if(options.onlyIfNew&&prior||options.onlyIfMatch&&prior?.etag!==options.onlyIfMatch)return {modified:false};data.set(key,{value:clone(value),metadata:clone(options.metadata)||{},etag:String(++revision)});return {modified:true};},
 async setJSON(key,value,options){return this.set(key,value,options);},
 async delete(key){data.delete(key);},
 list({prefix,paginate}){const page={blobs:[...data.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key}))};return paginate?(async function*(){yield page;})():Promise.resolve(page);}
};

globalThis.__contractCycleStore=store;
globalThis.__contractCyclePackets=[];
globalThis.__contractCycleEnqueued=[];
const portalUrl=new URL('../netlify/functions/portal.mjs',import.meta.url);
let source=await fs.readFile(portalUrl,'utf8');
source=source.replace("import {begin as beginCalendar,events as calendarEvents} from './calendar-callback.mjs';",'const beginCalendar=()=>{},calendarEvents=()=>{};')
 .replace("import { getStore } from '@netlify/blobs';",'const getStore=()=>globalThis.__contractCycleStore;')
 .replace("import sharp from 'sharp';",'const sharp=()=>{};')
 .replace("import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';",'const PDFDocument={},StandardFonts={},rgb=()=>{};')
 .replace("import {enqueue, mailReady, portalUrl} from '../lib/mail.mjs';","const enqueue=async(...args)=>{globalThis.__contractCycleEnqueued.push(args);},mailReady=()=>true,portalUrl='https://heidimikacfilms.com/members/';");
const packetStart=source.indexOf('async function packet(bytes, terms) {');
const handlerStart=source.indexOf('export default async function handle(req)');
assert.ok(packetStart>=0&&handlerStart>packetStart,'Packet stub must replace only the PDF rendering helper.');
source=source.slice(0,packetStart)+"async function packet(bytes,terms){globalThis.__contractCyclePackets.push(structuredClone(terms));return Buffer.from('%PDF-current');}\n"+source.slice(handlerStart);
source=source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_match,_quote,path)=>'from '+JSON.stringify(new URL(path,portalUrl).href));
const {default:handle}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

const dark='written-in-the-dark',lies='wherein-lies-continue';
const id='00000000-0000-4000-8000-000000000011';
const heidi='00000000-0000-4000-8000-000000000012';
const nick='00000000-0000-4000-8000-000000000013';
const profile=darkCatalog.find(person=>person.name==='Rachel DeMicco');assert.ok(profile);
const adminToken='a'.repeat(64),memberToken='b'.repeat(64);
const digest=value=>createHash('sha256').update(value).digest('hex');
process.env.HMF_NICK_LOGIN_SHA256='cycle-admin';process.env.SIGNWELL_API_KEY='mock';
await store.setJSON('sessions/'+digest(adminToken),{id:'Nick',admin:true,adminDigest:'cycle-admin',expires:Date.now()+60000});
await store.setJSON('sessions/'+digest(memberToken),{id,admin:false,expires:Date.now()+60000});
for(const [memberId,name] of [[id,'Rachel DeMicco'],[heidi,'Heidi Mikac'],[nick,'Nick Williams']]){
 await store.setJSON('members/'+memberId,{id:memberId,name,email:memberId+'@example.invalid',productions:{[dark]:{role:'Actor',filmProfile:memberId===id?profile.id:''},[lies]:{role:'Producer',filmProfile:''}}});
 await store.setJSON('agreements/'+memberId,{id:'old-'+memberId,status:'Complete',created:1});
 await store.setJSON('paperwork/'+dark+'/'+memberId,{reason:'hard-copy',at:1});
}
await store.setJSON('productions/'+lies+'/agreements/'+id,{id:'old-lies',status:'Waiting on actor',created:1});
const oldPdf=Buffer.from('%PDF-old-original');
await store.set('offline/'+profile.id,oldPdf,{metadata:{status:'Complete'}});
await store.setJSON('offline-signing/'+profile.id,{id:'old-counter',profileId:profile.id,productionId:dark,status:'Complete'});
const before=clone([...data]);
const providerReads=[],providerCreates=[];
globalThis.fetch=async(url,options)=>{
 if(options?.method==='POST'){
  providerCreates.push({url:String(url),body:JSON.parse(options.body)});
  return Response.json({id:providerCreates.at(-1).body.name.startsWith('Wherein Lies Continue')?'new-lies':'new-dark',status:'sent'});
 }
 providerReads.push(String(url));return Response.json({status:'completed',recipients:[{id:'1',status:'completed'},{id:'2',status:'completed'}]});
};
async function call(action,body,production=dark,token=adminToken,memberId=id,document){
 const url=new URL('https://heidimikacfilms.com/.netlify/functions/portal');url.search=new URLSearchParams({action,production,id:memberId,...(document?{document}:{})});
 const response=await handle(new Request(url,{method:body===undefined?'GET':'POST',headers:{origin:url.origin,'content-type':'application/json',cookie:'__Host-hmf='+token},body:body===undefined?undefined:JSON.stringify(body)}));
 return {response,data:response.headers.get('content-type')?.includes('application/json')?await response.json():await response.arrayBuffer()};
}

assert.equal(AGREEMENT_CYCLE,'2026-11-09');
assert.equal(supersededContractNotice({subject:'Document ready for signature',text:'Old agreement'}),true);
assert.equal(supersededContractNotice({subject:'Agreement ready for your signature',agreementCycle:AGREEMENT_CYCLE}),false,'Fresh agreement email must survive queue cleanup.');
assert.equal(supersededContractNotice({subject:'New production message',text:'Unrelated update'}),false);
assert.equal(supersededContractNotice({subject:'Waiting on you · Heidi Mikac Films',text:'Review production request from Example'}),false);
assert.ok(currentAgreementKey(dark,id).startsWith(currentAgreementPrefix(dark)));
assert.notEqual(currentAgreementKey(dark,id),currentAgreementKey(lies,id));
let result=await call('home');assert.equal(result.response.status,200);
for(const memberId of [id,heidi,nick]){
 const row=result.data.members.find(member=>member.id===memberId);assert.ok(row);
 assert.equal(row.paperworkStatus,'No agreement on file','All prior paperwork and exemptions require a fresh contract.');
 assert.ok(!row.agreement?.id,'Historical provider IDs must not become the current agreement.');
}
const actions=await adminActions(store,dark);
for(const memberId of [id,heidi,nick])assert.ok(actions.some(action=>action.member===memberId),'Every assigned member needs a new agreement action.');
assert.equal(providerReads.length,0,'Legacy status is not polled while rendering the new requirement.');

for(const [action,body,memberId] of [['status',undefined,id],['prepareOfflineCountersign',{},profile.id],['offlineCountersignStatus',undefined,profile.id],['offline',{},profile.id]]){
 result=await call(action,body,dark,adminToken,memberId);
 assert.ok(result.response.status>=400&&result.response.status<500,action+' must reject the replaced workflow.');
}
assert.equal(providerReads.length,0,'Stale signing buttons cannot resume or poll a previous request.');
for(const [key,record] of before)if(key.startsWith('agreements/')||key.startsWith('offline/')||key.startsWith('offline-signing/')||key.startsWith('paperwork/'))assert.deepEqual(data.get(key),record,'Original record preserved at '+key);

const currentKey=currentAgreementKey(dark,id);
await store.set('contract/master',Buffer.from('%PDF-approved-master'));
await store.set('productions/'+lies+'/contract/master',Buffer.from('%PDF-approved-master-lies'));
const terms={legal:'Rachel DeMicco',character:'Megan',crewTitle:'',credit:'Rachel DeMicco',rate:'100',date:'2026-11-09'};
for(const production of [dark,lies]){
 const packetsBefore=globalThis.__contractCyclePackets.length;
 for(const invalid of [{date:'2026-02-30'},{rate:'not agreed'},{character:'',crewTitle:''}]){
  result=await call('agreement',{...terms,...invalid,preview:true},production);
  assert.equal(result.response.status,400,'Agreement date, daily rate and at least one credit remain required for '+production);
 }
 assert.equal(globalThis.__contractCyclePackets.length,packetsBefore,'Invalid terms cannot reach PDF generation.');
 const notificationsBefore=globalThis.__contractCycleEnqueued.length;
 for(const request of [{...terms,preview:true},{...terms,start:'not a valid historical date',preview:true}]){
  result=await call('agreement',request,production);
  assert.equal(result.response.status,200,'Preview needs no first shoot date for '+production);
  assert.equal(Buffer.from(result.data).toString(),'%PDF-current');
  assert.equal(Object.hasOwn(globalThis.__contractCyclePackets.at(-1),'start'),false,'Stale first shoot dates must not enter the contract.');
 }
 assert.equal(globalThis.__contractCycleEnqueued.length,notificationsBefore,'Preview cannot notify signers.');
 assert.equal(await store.get(currentAgreementKey(production,id)),null,'Preview cannot reserve a signing request.');
}
assert.equal(providerCreates.length,0,'Preview cannot create a SignWell document.');
assert.equal(providerReads.length,0,'Preview does not contact SignWell.');
for(const [key,record] of before)if(key.startsWith('agreements/')||key.startsWith('offline/')||key.startsWith('offline-signing/')||key.startsWith('paperwork/'))assert.deepEqual(data.get(key),record,'Preview preserves prior contract records at '+key);
const sends=await Promise.all([call('agreement',terms),call('agreement',terms)]);
assert.equal(sends.filter(result=>result.response.status===200).length,1,'One concurrent send creates the new agreement.');
assert.ok(sends.some(result=>[400,409].includes(result.response.status)),'Concurrent duplicate is rejected.');
assert.equal(providerCreates.length,1,'Legacy records allow one fresh provider request without duplicate sends.');
assert.equal(providerCreates[0].body.name,'Written in the Dark — Rachel DeMicco · '+AGREEMENT_CYCLE);
assert.equal(Buffer.from(providerCreates[0].body.files[0].file_base64,'base64').toString(),'%PDF-current');
let current=await store.get(currentKey);
assert.equal(current.id,'new-dark');assert.equal(current.cycle,AGREEMENT_CYCLE);assert.equal(current.status,'Waiting on actor');
result=await call('agreement',terms);assert.ok([400,409].includes(result.response.status));
assert.equal(providerCreates.length,1,'Rerunning a successful send preserves its original provider request.');
for(const [key,record] of before)if(key.startsWith('agreements/')||key.startsWith('offline/')||key.startsWith('offline-signing/')||key.startsWith('paperwork/'))assert.deepEqual(data.get(key),record,'Sending preserves prior contract records at '+key);
result=await call('status',undefined,dark,adminToken,id,'old-'+id);
assert.equal(result.response.status,409,'A stale tab cannot open a newer signing request using the old provider ID.');
assert.equal(providerReads.length,0);
await store.setJSON(currentKey,{...await store.get(currentKey),checkedAt:0});
await checkSigningNotices(store);
assert.equal((await store.get(currentKey)).status,'Complete');
result=await call('status',undefined,dark,adminToken,id,'new-dark');assert.equal(result.response.status,200);assert.equal(result.data.status,'Complete');
assert.equal((await store.get('productions/'+lies+'/agreements/'+id)).status,'Waiting on actor','Legacy provider completion cannot update old production state.');
assert.ok(providerReads.every(url=>url.includes('/new-dark/')),'Only the current document is polled.');
result=await call('home');assert.equal(result.data.members.find(member=>member.id===id).paperworkStatus,'Complete');
result=await call('home',undefined,lies);assert.equal(result.data.members.find(member=>member.id===id).paperworkStatus,'No agreement on file','Completion in one production does not satisfy another.');
result=await call('agreement',terms,lies);assert.equal(result.response.status,200,'Wherein Lies Continue can send without a first shoot date.');
assert.equal(providerCreates.length,2,'Each production gets one separate signing request.');
assert.equal(providerCreates[1].body.name,'Wherein Lies Continue — Rachel DeMicco · '+AGREEMENT_CYCLE);
assert.equal((await store.get(currentAgreementKey(lies,id))).id,'new-lies');
assert.equal(Object.hasOwn(globalThis.__contractCyclePackets.at(-1),'start'),false);
assert.equal((await store.get('productions/'+lies+'/agreements/'+id)).id,'old-lies','New production send preserves the original provider record.');

result=await call('home',undefined,dark,memberToken);assert.equal(result.response.status,200);
assert.ok(result.data.members[0].documents.some(document=>document.kind==='previous-signed'),'Members retain access to previously completed agreements.');
assert.deepEqual(Buffer.from(await store.get('offline/'+profile.id)),oldPdf,'Reset preserves original PDF bytes.');
console.log('PASS: date-free previews/sends for both films, stale shoot dates ignored, required terms validated, old contract/waiver isolation, stale route protection, current-cycle provider polling, concurrent/repeated sends, per-film completion and historical files. No external requests or emails.');
