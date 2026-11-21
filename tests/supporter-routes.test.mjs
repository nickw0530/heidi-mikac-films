import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {practiceName} from '../netlify/lib/practice.mjs';
import {adminActions} from '../netlify/lib/admin-actions.mjs';

// The real portal routes against isolated storage. Every person here is fictional.
const portalFile=new URL('../netlify/functions/portal.mjs',import.meta.url);
let source=await readFile(portalFile,'utf8');
for(const [before,after] of [
 ["import {begin as beginCalendar,events as calendarEvents} from './calendar-callback.mjs';",'const beginCalendar=()=>{},calendarEvents=()=>{};'],
 ["import sharp from 'sharp';",'const sharp=()=>{throw Error("Unexpected image operation");};'],
 ["import { getStore } from '@netlify/blobs';",'const getStore=()=>globalThis.__portalSafetyStore;'],
 ["import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';",'const PDFDocument={},StandardFonts={},rgb=()=>{};'],
 ["import {enqueue, mailReady, portalUrl} from '../lib/mail.mjs';",'const enqueue=async()=>{},mailReady=()=>true,portalUrl="https://heidimikacfilms.com/members/";']
]){assert.ok(source.includes(before),'Route mock must match the current implementation.');source=source.replace(before,after);}
source=source.replace('manualSale,merchStore,orderItems','manualSale,orderItems');
source='const merchStore=()=>globalThis.__portalSafetyStore;\n'+source;
source=source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_match,_quote,path)=>'from '+JSON.stringify(new URL(path,portalFile).href));
const {default:handle}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

const sha=value=>createHash('sha256').update(value).digest('hex');
const dark='written-in-the-dark';
const tokens={Nick:'a'.repeat(64),Heidi:'b'.repeat(64),member:'c'.repeat(64)};
const practice='00000000-0000-4000-8000-0000000000b1',real='00000000-0000-4000-8000-0000000000b2';
process.env.HMF_NICK_LOGIN_SHA256='safety-test-nick';
process.env.HMF_HEIDI_LOGIN_SHA256='safety-test-heidi';

async function fixture(){
 const data=new Map();let revision=0;
 const clone=value=>value===undefined?undefined:structuredClone(value);
 const store={data,
  async get(key){return clone(data.get(key)?.value)??null;},
  async getMetadata(key){const r=data.get(key);return r?{etag:r.etag,metadata:clone(r.metadata)}:null;},
  async getWithMetadata(key){const r=data.get(key);return r?{data:clone(r.value),etag:r.etag,metadata:clone(r.metadata)}:null;},
  async set(key,value,options={}){const old=data.get(key);if(options.onlyIfNew&&old||options.onlyIfMatch&&old?.etag!==options.onlyIfMatch)return {modified:false};const etag=String(++revision);data.set(key,{value:clone(value),metadata:clone(options.metadata)||{},etag});return {etag,modified:true};},
  async setJSON(key,value,options){return this.set(key,value,options);},
  async delete(key){data.delete(key);},
  list({prefix,paginate}){const page={blobs:[...data.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key}))};return paginate?(async function*(){yield page;})():Promise.resolve(page);}
 };
 globalThis.__portalSafetyStore=store;
 await store.setJSON('sessions/'+sha(tokens.Nick),{id:'Nick',admin:true,adminDigest:'safety-test-nick',expires:Date.now()+3600000});
 await store.setJSON('sessions/'+sha(tokens.Heidi),{id:'Heidi',admin:true,adminDigest:'safety-test-heidi',expires:Date.now()+3600000});
 await store.setJSON('sessions/'+sha(tokens.member),{id:real,admin:false,adminDigest:null,expires:Date.now()+3600000});
 const profile={bio:'A fictional biography.',photo:'https://heidimikacfilms.com/assets/logo.webp',imageVersion:''};
 const member=(id,name)=>({id,name,email:id+'@example.invalid',generalInvite:true,productions:{[dark]:{role:'Extra',character:'Extra',crewTitle:'',filmProfile:''}},approvedProfiles:{[dark]:profile},publication:{[dark]:true}});
 // A rehearsal account whose name is not exactly "Test": an admin saved its profile, which publishes directly.
 await store.setJSON('members/'+practice,member(practice,'Test Cast Member'));
 await store.setJSON('members/'+real,member(real,'Robin Vale'));
 return store;
}
async function call(action,{who='Nick',body,id='',method,origin,production=dark}={}){
 const url=new URL('https://heidimikacfilms.com/.netlify/functions/portal');url.search=new URLSearchParams({action,production,id});
 const response=await handle(new Request(url,{method:method||(body===undefined?'GET':'POST'),headers:{origin:origin??url.origin,'content-type':'application/json',...(who?{cookie:'__Host-hmf='+tokens[who]}:{})},body:body===undefined?undefined:JSON.stringify(body)}),{ip:'198.51.100.7'});
 return {status:response.status,data:await response.json()};
}

test('support ledger, imports and moderation require an authenticated admin and same-origin POST',async()=>{
 await fixture();
 const text='Contribution amount,Currency,Payment status,Transaction ID,Name,Show name,Show amount\n10.00,USD,Paid,TEST-ONLY,Fictional Supporter,Yes,Yes';
 const actions=['supporterLedger','supporterPreview','supporterImport','supporterSave','supporterModerate'];
 for(const action of actions){
  for(const [who,status] of [[null,401],['member',403]])assert.equal((await call(action,{who,body:action==='supporterLedger'?undefined:{csv:text}})).status,status);
  if(action!=='supporterLedger'){
   assert.equal((await call(action)).status,405);
   assert.equal((await call(action,{body:{csv:text},origin:'https://elsewhere.example'})).status,403);
  }
 }
 const ledger=await call('supporterLedger');assert.equal(ledger.status,200);assert.deepEqual(ledger.data.transactions,[]);
 const preview=await call('supporterPreview',{body:{csv:text}});assert.equal(preview.status,200);assert.equal(preview.data.summary.new,1);
 assert.equal((await call('supporterLedger')).data.transactions.length,0,'preview must not write transactions');
 assert.equal((await call('supporterImport',{body:{csv:text,digest:preview.data.digest,revision:'stale'}})).status,409);
 assert.equal((await call('supporterImport',{body:{csv:text,digest:'changed',revision:preview.data.revision}})).status,409);
 const result=await call('supporterImport',{body:{csv:text,digest:preview.data.digest,revision:preview.data.revision}});assert.equal(result.status,200);
 let after=(await call('supporterLedger')).data;assert.equal(after.transactions.length,1);assert.equal(after.transactions[0].gross,1000);
 assert.ok(!JSON.stringify(after).includes('identity'));
 const again=await call('supporterPreview',{body:{csv:text}});assert.equal(again.data.summary.unchanged,1);
 const id=after.transactions[0].id;
 assert.equal((await call('supporterModerate',{body:{id,revision:after.revision,hidden:true}})).status,200);
 assert.equal((await call('supporterModerate',{body:{id,revision:after.revision,hidden:false}})).status,409,'concurrent changes cannot be overwritten');
 after=(await call('supporterLedger')).data;assert.equal(after.transactions[0].hidden,true);
 assert.equal((await call('supporterModerate',{body:{id,revision:after.revision,hidden:false}})).status,200);
 after=(await call('supporterLedger')).data;
 const input={id:'manual:11111111-1111-4111-8111-111111111111',revision:after.revision,name:'Manual Supporter',gross:2500,refunded:null,status:'paid',channel:'Cash',reference:'',processor:'',showName:false,showAmount:false,hidden:false};
 assert.equal((await call('supporterSave',{body:input})).status,200);
 after=(await call('supporterLedger')).data;assert.equal(after.transactions.length,2);
 assert.equal((await call('supporterSave',{body:{...input,revision:after.revision,gross:3500}})).status,200);
 after=(await call('supporterLedger')).data;assert.equal(after.transactions.length,2);assert.equal(after.transactions.find(row=>row.source==='manual').gross,3500);
});
