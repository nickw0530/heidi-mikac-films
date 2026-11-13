import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {deliver} from '../netlify/lib/mail.mjs';

// The real sign-in, invitation and mail-queue code against isolated storage.
// Every address and ID here is fictional, and the email provider is mocked.
const portalFile=new URL('../netlify/functions/portal.mjs',import.meta.url);
let source=await readFile(portalFile,'utf8');
for(const [before,after] of [
 ["import {begin as beginCalendar,events as calendarEvents} from './calendar-callback.mjs';",'const beginCalendar=()=>{},calendarEvents=()=>{};'],
 ["import sharp from 'sharp';",'const sharp=()=>{throw Error("Unexpected image operation");};'],
 ["import { getStore } from '@netlify/blobs';",'const getStore=()=>globalThis.__invitationRecoveryStore;'],
 ["import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';",'const PDFDocument={},StandardFonts={},rgb=()=>{};']
]){assert.ok(source.includes(before),'Route mock must match the current implementation.');source=source.replace(before,after);}
source=source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_match,_quote,path)=>'from '+JSON.stringify(new URL(path,portalFile).href));
const {default:handle}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

const sha=value=>createHash('sha256').update(value).digest('hex');
const dark='written-in-the-dark';
const invited='00000000-0000-4000-8000-0000000000a1',older='00000000-0000-4000-8000-0000000000a2',newer='00000000-0000-4000-8000-0000000000a3';
const adminToken='a'.repeat(64),day=86400000;
const generic='If that account is eligible, a password reset email will arrive shortly. Check spam too.';
process.env.HMF_NICK_LOGIN_SHA256='recovery-test-nick';
process.env.RESEND_API_KEY='test-only';
process.env.HMF_MAIL_FROM='Production <test@example.invalid>';

function fixture(){
 const data=new Map();let revision=0;
 const clone=value=>value===undefined?undefined:structuredClone(value);
 const store={data,
  async get(key){return clone(data.get(key)?.value)??null;},
  async getMetadata(key){const r=data.get(key);return r?{etag:r.etag,metadata:{}}:null;},
  async getWithMetadata(key){const r=data.get(key);return r?{data:clone(r.value),etag:r.etag,metadata:{}}:null;},
  async set(key,value,options={}){const old=data.get(key);if(options.onlyIfNew&&old||options.onlyIfMatch&&old?.etag!==options.onlyIfMatch)return {modified:false};data.set(key,{value:clone(value),etag:String(++revision)});return {modified:true};},
  async setJSON(key,value,options){return this.set(key,value,options);},
  async delete(key){data.delete(key);},
  list({prefix,paginate}){const page={blobs:[...data.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key}))};return paginate?(async function*(){yield page;})():Promise.resolve(page);}
 };
 globalThis.__invitationRecoveryStore=store;
 const sent=[];
 globalThis.fetch=async(input,options={})=>{
  assert.equal(new URL(input).origin,'https://api.resend.com','Only the mocked email provider may be called.');
  if(options.method==='POST'){sent.push(JSON.parse(options.body));return Response.json({id:'provider-'+sent.length});}
  return Response.json({last_event:'delivered'});
 };
 return {store,sent};
}
async function seedInvited(store,{id=invited,name='New Actor',email='new@example.invalid',ticket='1'.repeat(64),issuedAt=Date.now()-5*day,extra={}}={}){
 await store.setJSON('members/'+id,{id,name,email,generalInvite:true,productions:{},ticket:sha(ticket),inviteIssuedAt:issuedAt,...extra});
 await store.setJSON('active-email/'+sha(email),{id});
 await store.setJSON('tickets/'+sha(ticket),{id,email,issuedAt,expires:issuedAt+7*day});
 return ticket;
}
async function call(action,body,{admin=false,id=''}={}){
 const url=new URL('https://heidimikacfilms.com/.netlify/functions/portal');url.search=new URLSearchParams({action,production:dark,id});
 const response=await handle(new Request(url,{method:'POST',headers:{origin:url.origin,'content-type':'application/json',...(admin?{cookie:'__Host-hmf='+adminToken}:{})},body:JSON.stringify(body)}),{ip:'198.51.100.7'});
 return {status:response.status,data:await response.json()};
}
// A fresh request is allowed once per address every fifteen minutes; tests clear that window.
async function forgot(store,username){
 for(const key of [...store.data.keys()])if(key.startsWith('recovery-limit/'))store.data.delete(key);
 return call('requestReset',{username});
}
const outbox=store=>[...store.data].filter(([key])=>key.startsWith('outbox/')).map(([,record])=>record.value);
const mailLog=store=>[...store.data].filter(([key])=>key.startsWith('mail-log/')).map(([,record])=>record.value);
const linkIn=text=>text.match(/#invite=([a-f0-9]{64})/)[1];
async function adminSession(store){
 await store.setJSON('sessions/'+sha(adminToken),{id:'Nick',admin:true,adminDigest:'recovery-test-nick',expires:Date.now()+3600000});
}

test('account recovery renews an unactivated invitation with the same freshness tracking as People',async()=>{
 const {store,sent}=fixture(),old=await seedInvited(store);
 const answer=await forgot(store,'NEW@example.invalid');
 assert.deepEqual(answer,{status:200,data:{ok:true,message:generic}});
 const [queued]=outbox(store);
 assert.equal(outbox(store).length,1);
 const link=linkIn(queued.text),member=await store.get('members/'+invited);
 assert.equal(member.ticket,sha(link),'The new link replaces the earlier one on the account.');
 assert.equal(queued.invitationDigest,sha(link),'The queued email carries the digest the mail worker uses to drop a replaced link.');
 assert.equal((await store.get('tickets/'+sha(link))).email,'new@example.invalid','The link is bound to the address it was sent to.');
 assert.equal((await store.get('invitation-lease/'+sha('newactor'))).until,0,'The shared reservation is released afterwards.');
 assert.equal((await call('activate',{ticket:old,password:'a long enough password'})).status,409,'The earlier link no longer works.');
 await deliver(store);
 assert.deepEqual(sent.map(mail=>mail.subject),['Heidi Mikac Films — finish setting up your account']);
 assert.equal((await call('activate',{ticket:link,password:'a long enough password'})).status,200,'The emailed link sets up the account.');
});

test('a recovery email replaced by a newer invitation is never delivered',async()=>{
 const {store,sent}=fixture();await seedInvited(store);await adminSession(store);
 await forgot(store,'new@example.invalid');
 const stale=linkIn(outbox(store)[0].text);
 const resent=await call('resend',{expectedEmail:'new@example.invalid'},{admin:true,id:invited});
 assert.equal(resent.status,200,JSON.stringify(resent.data));
 assert.equal(outbox(store).length,2);
 await deliver(store);
 assert.deepEqual(sent.map(mail=>mail.subject),['Heidi Mikac Films — your Film Portal invitation'],'Only the newest link is emailed.');
 assert.ok(!sent[0].text.includes(stale));
 assert.ok(mailLog(store).some(row=>row.subject==='Heidi Mikac Films — finish setting up your account'&&row.status==='Not sent — invitation replaced or used'));
 assert.equal((await call('activate',{ticket:stale,password:'a long enough password'})).status,409);
});

test('a recovery email is dropped if the account is set up before it is sent',async()=>{
 const {store,sent}=fixture();await seedInvited(store);
 await forgot(store,'new@example.invalid');
 const link=linkIn(outbox(store)[0].text);
 assert.equal((await call('activate',{ticket:link,password:'a long enough password'})).status,200);
 await deliver(store);
 assert.equal(sent.length,0,'No setup email goes to an account that already has a password.');
});

test('recovery stays silent while another invitation step holds the reservation',async()=>{
 const {store}=fixture(),old=await seedInvited(store);
 await store.setJSON('invitation-lease/'+sha('newactor'),{lease:'in-flight',until:Date.now()+60000});
 const answer=await forgot(store,'new@example.invalid');
 assert.deepEqual(answer,{status:200,data:{ok:true,message:generic}},'A busy account answers exactly like an unknown one.');
 assert.equal(outbox(store).length,0);
 assert.equal((await store.get('members/'+invited)).ticket,sha(old),'The link being sent or used elsewhere is left alone.');
});

test('the public reply never shows whether an address has an account',async()=>{
 const {store}=fixture();await seedInvited(store);
 await seedInvited(store,{id:older,name:'Gone Person',email:'gone@example.invalid',ticket:'2'.repeat(64),extra:{revoked:true}});
 await seedInvited(store,{id:newer,name:'Name Only',email:'saved@example.invalid',ticket:'3'.repeat(64),extra:{pendingContact:true}});
 for(const username of ['nobody@example.invalid','gone@example.invalid','saved@example.invalid'])
  assert.deepEqual(await forgot(store,username),{status:200,data:{ok:true,message:generic}});
 assert.equal(outbox(store).length,0,'Unknown, revoked and unfinished contacts receive nothing.');
});

// Inspired by a real report: an invitation first went to a wrong address, and a corrected one
// followed under a second pending record for the same film credit.
test('an older record for the same film credit cannot use recovery to get ahead of the corrected invitation',async()=>{
 const {store}=fixture();
 const credit={profileLinks:{[dark]:'margaret'}};
 const wrongLink=await seedInvited(store,{id:older,name:'Morgan Reyes-Cole',email:'wrong@example.invalid',ticket:'4'.repeat(64),issuedAt:Date.now()-6*day,extra:credit});
 const rightLink=await seedInvited(store,{id:newer,name:'Morgan Reyes-Cole',email:'right@example.invalid',ticket:'5'.repeat(64),issuedAt:Date.now()-2*day,extra:credit});

 assert.deepEqual(await forgot(store,'wrong@example.invalid'),{status:200,data:{ok:true,message:generic}});
 assert.equal(outbox(store).length,0,'The wrong address gets no new link.');
 assert.equal((await store.get('members/'+older)).ticket,sha(wrongLink));
 assert.equal((await call('activate',{ticket:wrongLink,password:'a long enough password'})).status,409,'Its old link was already replaced by the corrected invitation.');

 await forgot(store,'right@example.invalid');
 assert.equal(outbox(store).length,1);
 const renewed=linkIn(outbox(store)[0].text);
 assert.equal((await call('activate',{ticket:rightLink,password:'a long enough password'})).status,409,'Renewing rotates the corrected record’s own earlier link.');
 assert.equal((await call('activate',{ticket:renewed,password:'a long enough password'})).status,200,'Only the newest eligible link completes setup.');

 await forgot(store,'wrong@example.invalid');
 assert.equal(outbox(store).length,1,'Once the credit has an account, the older record still gets nothing.');
 assert.equal(await store.get('passwords/'+older),null);
});
