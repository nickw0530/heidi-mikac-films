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
source=source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_match,_quote,path)=>'from '+JSON.stringify(new URL(path,portalFile).href));
const {default:handle}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

const sha=value=>createHash('sha256').update(value).digest('hex');
const dark='written-in-the-dark';
const tokens={Nick:'a'.repeat(64),member:'c'.repeat(64)};
const practice='00000000-0000-4000-8000-0000000000b1',real='00000000-0000-4000-8000-0000000000b2';
process.env.HMF_NICK_LOGIN_SHA256='safety-test-nick';

async function fixture(){
 const data=new Map();let revision=0;
 const clone=value=>value===undefined?undefined:structuredClone(value);
 const store={data,
  async get(key){return clone(data.get(key)?.value)??null;},
  async getMetadata(key){const r=data.get(key);return r?{etag:r.etag,metadata:clone(r.metadata)}:null;},
  async getWithMetadata(key){const r=data.get(key);return r?{data:clone(r.value),etag:r.etag,metadata:clone(r.metadata)}:null;},
  async set(key,value,options={}){const old=data.get(key);if(options.onlyIfNew&&old||options.onlyIfMatch&&old?.etag!==options.onlyIfMatch)return {modified:false};data.set(key,{value:clone(value),metadata:clone(options.metadata)||{},etag:String(++revision)});return {modified:true};},
  async setJSON(key,value,options){return this.set(key,value,options);},
  async delete(key){data.delete(key);},
  list({prefix,paginate}){const page={blobs:[...data.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key}))};return paginate?(async function*(){yield page;})():Promise.resolve(page);}
 };
 globalThis.__portalSafetyStore=store;
 await store.setJSON('sessions/'+sha(tokens.Nick),{id:'Nick',admin:true,adminDigest:'safety-test-nick',expires:Date.now()+3600000});
 await store.setJSON('sessions/'+sha(tokens.member),{id:real,admin:false,adminDigest:null,expires:Date.now()+3600000});
 const profile={bio:'A fictional biography.',photo:'https://heidimikacfilms.com/assets/logo.webp',imageVersion:''};
 const member=(id,name)=>({id,name,email:id+'@example.invalid',generalInvite:true,productions:{[dark]:{role:'Extra',character:'Extra',crewTitle:'',filmProfile:''}},approvedProfiles:{[dark]:profile},publication:{[dark]:true}});
 // A rehearsal account whose name is not exactly "Test": an admin saved its profile, which publishes directly.
 await store.setJSON('members/'+practice,member(practice,'Test Cast Member'));
 await store.setJSON('members/'+real,member(real,'Robin Vale'));
 return store;
}
async function call(action,{who='Nick',body,id='',method}={}){
 const url=new URL('https://heidimikacfilms.com/.netlify/functions/portal');url.search=new URLSearchParams({action,production:dark,id});
 const response=await handle(new Request(url,{method:method||(body===undefined?'GET':'POST'),headers:{origin:url.origin,'content-type':'application/json',...(who?{cookie:'__Host-hmf='+tokens[who]}:{})},body:body===undefined?undefined:JSON.stringify(body)}),{ip:'198.51.100.7'});
 return {status:response.status,data:await response.json()};
}

test('any name that starts with the word Test is a practice account everywhere',async()=>{
 for(const name of ['Test','test','Test Testerson','Test Cast Member','TEST actor 2','  Test  '])assert.equal(practiceName(name),true,name);
 for(const name of ['Tess Day','Testa Rossi','Contest Winner','Robin Vale','',undefined])assert.equal(practiceName(name),false,String(name));
 const store=await fixture();
 const feed=(await call('published',{who:null})).data;
 assert.deepEqual(feed.map(item=>item.name),['Robin Vale'],'A practice account never reaches a film website, even with an approved profile.');
 const home=(await call('home')).data;
 assert.equal(home.members.find(member=>member.id===practice).practice,true);
 assert.equal(home.members.find(member=>member.id===real).practice,false);
 const actions=await adminActions(store,dark,{members:[await store.get('members/'+practice),await store.get('members/'+real)]});
 assert.ok(actions.every(action=>action.member!==practice),'Practice accounts never create follow-up work.');
 assert.equal((await call('publication',{body:{visible:true},id:practice})).status,403,'A practice account cannot be switched to public.');
});

test('a request the portal does not understand is an error, never a silent success',async()=>{
 await fixture();
 const unknown=await call('noSuchAction',{body:{}});
 assert.equal(unknown.status,404);assert.match(unknown.data.error,/did not recognise/);
 const wrongMethod=await call('revoke',{id:real});
 assert.equal(wrongMethod.status,405,'Reading a change-only address is refused.');
 assert.equal((await globalThis.__portalSafetyStore.get('members/'+real)).revoked,undefined);
 assert.equal((await call('noSuchAction',{who:null,body:{}})).status,401,'Signed-out visitors learn nothing about which requests exist.');
 assert.equal((await call('noSuchAction',{who:'member',body:{}})).status,404);
});

test('scheduled jobs refuse to run from a deploy that is not the published one',async()=>{
 const request=new Request('https://heidimikacfilms.com/.netlify/functions/scheduled');
 for(const file of ['portal-mail.mjs','portal-signing.mjs','calendar-notifications.mjs']){
  const {default:run}=await import('../netlify/functions/'+file);
  assert.equal(await run(request,{deploy:{context:'deploy-preview',published:false}}),undefined,file+' returns before opening live storage.');
  // On the published deploy the job goes on to open storage, which is unavailable in a test run.
  await assert.rejects(run(request,{deploy:{context:'production',published:true}}),undefined,file+' proceeds only when published.');
 }
});

test('a name that matches a website profile never unlocks that profile’s archived paperwork by itself',async()=>{
 const store=await fixture();
 const {default:catalog}=await import('../netlify/lib/film-profiles.mjs');
 const profile=catalog.find(item=>!['nick','heidi'].includes(item.id));
 const sameName='00000000-0000-4000-8000-0000000000b3';
 // An account that happens to carry a credited name, with no confirmed link to the website profile.
 await store.setJSON('members/'+sameName,{id:sameName,name:profile.name,email:'same.name@example.invalid',generalInvite:true,productions:{}});
 await store.setJSON('sessions/'+sha('d'.repeat(64)),{id:sameName,admin:false,adminDigest:null,expires:Date.now()+3600000});
 tokens.sameName='d'.repeat(64);
 await store.set('offline/'+profile.id,'%PDF-1.7 archived paper agreement',{metadata:{status:'Complete'}});

 const assigned=await call('enrollments',{id:sameName,body:{productions:[dark],credits:{[dark]:{character:'Extra',crewTitle:''}}}});
 assert.equal(assigned.status,200,JSON.stringify(assigned.data));
 assert.equal((await store.get('members/'+sameName)).productions[dark].filmProfile,'','Assigning a production does not turn a name match into a link.');

 const own=(await call('home',{who:'sameName'})).data.members[0];
 assert.equal(own.previousOfflineStatus,null,'The member is not told an archived agreement exists.');
 assert.deepEqual(own.documents,[]);
 const blocked=await call('memberDocument',{who:'sameName',id:sameName,method:'GET'});
 assert.equal(blocked.status,404);
 const url=new URL('https://heidimikacfilms.com/.netlify/functions/portal');url.search=new URLSearchParams({action:'memberDocument',production:dark,id:sameName,kind:'uploaded'});
 const download=()=>handle(new Request(url,{headers:{cookie:'__Host-hmf='+tokens.sameName}}),{ip:'198.51.100.7'});
 assert.equal((await download()).status,404,'The archived paper agreement stays locked.');

 const adminRow=(await call('home')).data.members.find(member=>member.id===sameName);
 assert.equal(adminRow.filmProfile,profile.id,'Admins still see which website profile the name matches.');
 assert.equal(adminRow.confirmedProfile,'','and that nobody has confirmed it.');

 // The existing explicit control is the only way to connect the two.
 assert.equal((await call('linkProfile',{id:sameName,body:{filmProfile:profile.id}})).status,200);
 assert.equal((await download()).status,200,'After an admin confirms the match, the member can download it.');
 assert.equal((await call('home')).data.members.find(member=>member.id===sameName).confirmedProfile,profile.id);

 // A link that was already confirmed survives a later change of productions.
 const again=await call('enrollments',{id:sameName,body:{productions:[dark],credits:{[dark]:{character:'Extra',crewTitle:'Grip'}}}});
 assert.equal(again.status,200,JSON.stringify(again.data));
 assert.equal((await store.get('members/'+sameName)).productions[dark].filmProfile,profile.id);
});
