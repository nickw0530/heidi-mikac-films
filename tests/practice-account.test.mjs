import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {isPractice} from '../netlify/lib/practice.mjs';

// The real portal routes against isolated storage. Every name and ID here is fictional.
const portalFile=new URL('../netlify/functions/portal.mjs',import.meta.url);
let source=await readFile(portalFile,'utf8');
for(const [before,after] of [
 ["import {begin as beginCalendar,events as calendarEvents} from './calendar-callback.mjs';",'const beginCalendar=()=>{},calendarEvents=()=>{};'],
 ["import sharp from 'sharp';",'const sharp=()=>{throw Error("Unexpected image operation");};'],
 ["import { getStore } from '@netlify/blobs';",'const getStore=()=>globalThis.__practiceStore;'],
 ["import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';",'const PDFDocument={},StandardFonts={},rgb=()=>{};']
]){assert.ok(source.includes(before),'Route mock must match the current implementation.');source=source.replace(before,after);}
source=source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_match,_quote,path)=>'from '+JSON.stringify(new URL(path,portalFile).href));
const {default:handle}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

const sha=value=>createHash('sha256').update(value).digest('hex');
const dark='written-in-the-dark';
const rehearsal='00000000-0000-4000-8000-0000000000b1',named='00000000-0000-4000-8000-0000000000b2',real='00000000-0000-4000-8000-0000000000b3';
const adminToken='b'.repeat(64),memberToken='c'.repeat(64);
process.env.HMF_NICK_LOGIN_SHA256='practice-test-nick';

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
 globalThis.__practiceStore=store;
 globalThis.fetch=async()=>{throw Error('No provider may be called.');};
 return store;
}
const person=(id,name,extra={})=>({id,name,email:name.toLowerCase().replace(/\W+/g,'.')+'@example.invalid',productions:{[dark]:{role:'Rehearsal role'}},
 approvedProfiles:{[dark]:{bio:'A fictional biography.',photo:'https://heidimikacfilms.com/fictional.jpg'}},...extra});
async function seed(store){
 await store.setJSON('members/'+rehearsal,person(rehearsal,'Cast Member 0'));
 await store.setJSON('members/'+named,person(named,'Test Actor'));
 await store.setJSON('members/'+real,person(real,'Robin Vale'));
 await store.setJSON('sessions/'+sha(adminToken),{id:'Nick',admin:true,adminDigest:'practice-test-nick',expires:Date.now()+3600000});
 await store.setJSON('sessions/'+sha(memberToken),{id:real,expires:Date.now()+3600000});
}
async function call(action,body,{token=adminToken,id=''}={}){
 const url=new URL('https://heidimikacfilms.com/.netlify/functions/portal');url.search=new URLSearchParams({action,production:dark,id});
 const response=await handle(new Request(url,{method:body?'POST':'GET',headers:{origin:url.origin,'content-type':'application/json',...(token?{cookie:'__Host-hmf='+token}:{})},...(body?{body:JSON.stringify(body)}:{})}),{ip:'198.51.100.9'});
 return {status:response.status,data:await response.json()};
}
const publicNames=async()=>{const feed=(await call('published',null,{token:''})).data;return (Array.isArray(feed)?feed:feed.items||feed.profiles||[]).filter(item=>!item.hidden).map(item=>item.name).sort();};

test('a practice account is recognised by its name or by the admin’s mark',()=>{
 assert.equal(isPractice({name:'Test Actor'}),true);
 assert.equal(isPractice({name:'Cast Member 0',practice:true}),true);
 assert.equal(isPractice({name:'Cast Member 0'}),false);
 assert.equal(isPractice({name:'Robin Vale',practice:'yes'}),false,'Only an explicit true counts.');
 assert.equal(isPractice(null),false);
});

test('marking an account as practice takes it off the public website at once and records who did it',async()=>{
 const store=fixture();await seed(store);
 assert.deepEqual(await publicNames(),['Cast Member 0','Robin Vale'],'A rehearsal account not named “Test” is public until it is marked.');
 const marked=await call('practice',{practice:true},{id:rehearsal});
 assert.equal(marked.status,200,JSON.stringify(marked.data));
 assert.equal((await store.get('members/'+rehearsal)).practice,true);
 assert.deepEqual(await publicNames(),['Robin Vale']);
 const history=(await call('profileActivity',null,{id:rehearsal})).data.items;
 assert.equal(history[0].label,'Marked as a practice account');
 assert.equal(history[0].by,'Nick');

 const undone=await call('practice',{practice:false},{id:rehearsal});
 assert.equal(undone.status,200,JSON.stringify(undone.data));
 assert.equal(Object.hasOwn(await store.get('members/'+rehearsal),'practice'),false);
 assert.deepEqual(await publicNames(),['Cast Member 0','Robin Vale']);
});

test('the practice mark is an admin decision with guard rails',async()=>{
 const store=fixture();await seed(store);
 assert.equal((await call('practice',{practice:true},{id:rehearsal,token:memberToken})).status,403,'A member cannot change it.');
 assert.equal((await call('practice',{practice:'yes'},{id:rehearsal})).status,400,'The choice must be explicit.');
 const locked=await call('practice',{practice:false},{id:named});
 assert.equal(locked.status,400);
 assert.match(locked.data.error,/always a practice account/);
 await store.setJSON('members/'+real,{...person(real,'Robin Vale'),productions:{[dark]:{role:'Lead',filmProfile:'heidi-mikac'}}});
 const linked=await call('practice',{practice:true},{id:real});
 assert.equal(linked.status,400);
 assert.match(linked.data.error,/linked to a website credit/);
 assert.equal((await store.get('members/'+real)).practice,undefined);
});
