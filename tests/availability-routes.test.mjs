import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {emptyAvailability} from '../netlify/lib/availability.mjs';

// Run the actual portal routes with private, isolated storage and no network.
const portalFile=new URL('../netlify/functions/portal.mjs',import.meta.url);
let source=await readFile(portalFile,'utf8');
for(const [before,after] of [
 ["import {begin as beginCalendar,events as calendarEvents} from './calendar-callback.mjs';",'const beginCalendar=()=>{throw Error("Unexpected Outlook write");},calendarEvents=()=>{throw Error("Unexpected Outlook read");};'],
 ["import sharp from 'sharp';",'const sharp=()=>{throw Error("Unexpected image operation");};'],
 ["import { getStore } from '@netlify/blobs';",'const getStore=()=>globalThis.__availabilityFixture.store;'],
 ["import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';",'const PDFDocument={},StandardFonts={},rgb=()=>{};'],
 ["import {enqueue, mailReady, portalUrl} from '../lib/mail.mjs';",'const enqueue=async(...args)=>{globalThis.__availabilityFixture.notifications.push(args);},mailReady=()=>true,portalUrl="https://heidimikacfilms.com/members/";']
]){assert.ok(source.includes(before),'Route mocks must match the current portal.');source=source.replace(before,after);}
const packetStart=source.indexOf('async function packet(bytes, terms) {'),handlerStart=source.indexOf('export default async function handle(req)');
assert.ok(packetStart>=0&&handlerStart>packetStart);
source=source.slice(0,packetStart)+"async function packet(){throw Error('Unexpected contract generation');}\n"+source.slice(handlerStart);
source=source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_match,_quote,path)=>'from '+JSON.stringify(new URL(path,portalFile).href));
const {default:handle}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const dark='written-in-the-dark',lies='wherein-lies-continue';
const ids={a:'00000000-0000-4000-8000-000000000101',b:'00000000-0000-4000-8000-000000000102',otherFilm:'00000000-0000-4000-8000-000000000103',contact:'00000000-0000-4000-8000-000000000104',revoked:'00000000-0000-4000-8000-000000000105',unassigned:'00000000-0000-4000-8000-000000000106',practice:'00000000-0000-4000-8000-000000000107'};
const tokens={Nick:'a'.repeat(64),Heidi:'b'.repeat(64),a:'c'.repeat(64),b:'d'.repeat(64),otherFilm:'e'.repeat(64),revoked:'f'.repeat(64),unassigned:'1'.repeat(64),practice:'2'.repeat(64)};
const digest=value=>createHash('sha256').update(value).digest('hex');
const clone=value=>value===undefined?undefined:structuredClone(value);
process.env.HMF_NICK_LOGIN_SHA256='availability-nick';process.env.HMF_HEIDI_LOGIN_SHA256='availability-heidi';delete process.env.SIGNWELL_API_KEY;

async function fixture(){
 const records=new Map();let revision=0;
 const store={records,
  async get(key){return clone(records.get(key)?.value)??null;},
  async getMetadata(key){const r=records.get(key);return r?{etag:r.etag,metadata:clone(r.metadata)}:null;},
  async getWithMetadata(key){const r=records.get(key);return r?{data:clone(r.value),etag:r.etag,metadata:clone(r.metadata)}:null;},
  async set(key,value,options={}){const old=records.get(key);if(options.onlyIfNew&&old||options.onlyIfMatch&&old?.etag!==options.onlyIfMatch)return {modified:false};records.set(key,{value:clone(value),metadata:clone(options.metadata)||{},etag:String(++revision)});return {modified:true};},
  async setJSON(key,value,options){return this.set(key,value,options);},
  async delete(key){records.delete(key);},
  list({prefix,paginate}){const page={blobs:[...records.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key}))};return paginate?(async function*(){yield page;})():Promise.resolve(page);}
 };
 const context={store,notifications:[],requests:[]};globalThis.__availabilityFixture=context;
 for(const [who,token] of Object.entries(tokens))await store.setJSON('sessions/'+digest(token),{id:ids[who]||who,admin:who==='Nick'||who==='Heidi',adminDigest:who==='Nick'?'availability-nick':who==='Heidi'?'availability-heidi':null,expires:Date.now()+3600000});
 for(const [key,name,productions] of [['a','Actor A',[dark,lies]],['b','Actor B',[dark]],['otherFilm','Other Film Actor',[lies]],['contact','Private Contact',[dark]],['revoked','Revoked Actor',[dark]],['unassigned','Unassigned Actor',[]],['practice','Test Testerson',[dark]]]){
  await store.setJSON('members/'+ids[key],{id:ids[key],name,...(key==='contact'?{pendingContact:true,generalInvite:true}:{email:key+'-private@example.invalid'}),ticket:'private-invitation-secret',draftProfile:{bio:'private-draft-biography'},revoked:key==='revoked',productions:Object.fromEntries(productions.map(production=>[production,{role:'Actor'}]))});
 }
 globalThis.fetch=async(input,options)=>{context.requests.push({url:String(input),method:options?.method});throw Error('Availability tests cannot call any external provider.');};
 return context;
}
async function call(action,{body,who='Nick',production=dark,id='',origin,method,params={}}={}){
 const url=new URL('https://heidimikacfilms.com/.netlify/functions/portal');url.search=new URLSearchParams({action,production,...(id?{id}:{}),...params});
 const response=await handle(new Request(url,{method:method||(body===undefined?'GET':'POST'),headers:{origin:origin||url.origin,'content-type':'application/json',...(who?{cookie:'__Host-hmf='+tokens[who]}:{})},body:body===undefined?undefined:JSON.stringify(body)}));
 return {status:response.status,data:await response.json()};
}
function monday(...windows){const record=emptyAvailability();record.weekly[1]={status:'available',windows:windows.map(([start,end])=>({start,end}))};return record;}
const save=(id,record,options={})=>call('saveAvailability',{id,body:{...record,revision:null},...options});

test('availability is authenticated and shared only with the current production roster',async()=>{
 const context=await fixture();
 assert.equal((await call('availability',{who:null})).status,401);
 let result=await call('availability',{who:'a'});assert.equal(result.status,200);
 assert.deepEqual(new Set(result.data.members.map(member=>member.id)),new Set([ids.a,ids.b]));
 assert.equal(result.data.members.find(member=>member.id===ids.a).canEdit,true);
 assert.equal(result.data.members.find(member=>member.id===ids.b).canEdit,false);
 const serialized=JSON.stringify(result.data);
 for(const privateValue of ['@example.invalid','private-invitation-secret','private-draft-biography'])assert.ok(!serialized.includes(privateValue));
 result=await call('availability');assert.equal(result.status,200);assert.ok(result.data.members.some(member=>member.id===ids.contact),'Admins may enter availability for a no-email private profile.');
 assert.ok(!result.data.members.some(member=>[ids.otherFilm,ids.revoked,ids.unassigned].includes(member.id)));
 assert.equal((await call('availability',{who:'b',production:lies})).status,403);
 assert.equal((await call('availability',{who:'unassigned'})).status,403);
 assert.equal((await call('availability',{who:'revoked'})).status,401);
 result=await call('availability',{who:'a',production:lies});assert.deepEqual(new Set(result.data.members.map(member=>member.id)),new Set([ids.a,ids.otherFilm]));
 const member=await context.store.get('members/'+ids.a);delete member.productions[dark];await context.store.setJSON('members/'+ids.a,member);
 assert.equal((await call('availability',{who:'a'})).status,403,'A removed production assignment loses access immediately.');
 assert.ok(!(await call('availability',{who:'b'})).data.members.some(member=>member.id===ids.a));
 assert.equal(context.notifications.length,0);assert.equal(context.requests.length,0);
});

test('members edit only themselves, while either admin may edit an assigned private profile',async()=>{
 const context=await fixture(),record=monday(['09:00','17:00']);
 assert.equal((await save(ids.a,record,{who:'a'})).status,200);
 assert.equal((await save(ids.b,record,{who:'a'})).status,403);
 assert.equal((await save(ids.contact,record,{who:'Heidi'})).status,200);
 assert.ok([403,404].includes((await save(ids.unassigned,record)).status),'An unassigned private profile is unavailable for this production.');
 assert.ok((await save(ids.otherFilm,record)).status>=400);
 assert.equal((await save(ids.b,record,{who:null})).status,401);
 assert.equal((await save(ids.b,record,{origin:'https://other.invalid'})).status,403);
 const admin=(await call('availability')).data.members.find(member=>member.id===ids.contact);
 assert.equal(admin.availability.updatedByLabel,'Production');
 assert.equal(admin.availability.weekly[1].windows[0].start,'09:00');
 assert.ok(!(await call('availability',{who:'a'})).data.members.some(member=>member.id===ids.contact),'Private no-email identities stay out of member-visible rosters.');
 assert.equal(context.notifications.length,0);assert.equal(context.requests.length,0);
});

test('conditional saves prevent stale tabs from overwriting another edit',async()=>{
 const context=await fixture(),first=monday(['09:00','12:00']),second=monday(['13:00','17:00']);
 const attempts=await Promise.all([save(ids.a,first,{who:'a'}),save(ids.a,second,{who:'Heidi'})]);
 assert.equal(attempts.filter(result=>result.status===200).length,1);assert.equal(attempts.filter(result=>result.status===409).length,1);
 let row=(await call('availability',{who:'a'})).data.members.find(member=>member.id===ids.a);assert.ok(row.revision);
 const oldRevision=row.revision;
 assert.equal((await call('saveAvailability',{who:'a',id:ids.a,body:{...second,revision:oldRevision}})).status,200);
 assert.equal((await call('saveAvailability',{who:'a',id:ids.a,body:{...first,revision:oldRevision}})).status,409);
 row=(await call('availability',{who:'a'})).data.members.find(member=>member.id===ids.a);
 assert.deepEqual(row.availability.weekly[1].windows,[{start:'13:00',end:'17:00'}]);
 assert.equal((await call('availability',{who:'a',production:lies})).data.members.find(member=>member.id===ids.a).availability,null,'A different production is not silently populated.');
 assert.equal((await call('availability',{who:'b'})).data.members.find(member=>member.id===ids.b).availability,null,'A different person is untouched.');
 assert.equal(context.notifications.length,0);assert.equal(context.requests.length,0);
});

test('match requests require visible production members and confirmed continuous overlap',async()=>{
 const context=await fixture();
 await save(ids.a,monday(['09:00','12:00'],['13:00','17:00']));await save(ids.b,monday(['10:00','14:00']));
 const body={members:[ids.a,ids.b],from:'2027-01-04',to:'2027-01-04',minMinutes:90};
 let result=await call('availabilityMatch',{who:'a',body});assert.equal(result.status,200);
 assert.deepEqual(result.data.matches[0].windows.map(({start,end})=>[start,end]),[['10:00','12:00']]);
 for(const members of [[],[ids.a,ids.otherFilm],[ids.a,ids.revoked],[ids.a,ids.contact]])assert.ok((await call('availabilityMatch',{who:'a',body:{...body,members}})).status>=400);
 assert.equal((await call('availabilityMatch',{who:'b',production:lies,body})).status,403);
 assert.equal((await call('availabilityMatch',{body:{...body,to:'2027-05-01'}})).status,400);
 await context.store.delete('availability/'+dark+'/'+ids.b);
 result=await call('availabilityMatch',{body});assert.equal(result.status,200);assert.equal(result.data.matches.length,0);assert.deepEqual(result.data.days[0].missing.map(person=>person.id),[ids.b]);
 assert.equal(context.notifications.length,0);assert.equal(context.requests.length,0);
});

test('invalid payloads and wrong methods cannot change stored availability',async()=>{
 const context=await fixture();
 for(const body of [monday(['09:00','17:00']),{...monday(['17:00','09:00']),revision:null},{...emptyAvailability(),timezone:'UTC',revision:null}])assert.equal((await call('saveAvailability',{id:ids.a,body})).status,400);
 assert.equal((await call('availability',{body:{}})).status,405);
 assert.equal((await call('saveAvailability',{id:ids.a})).status,405);
 assert.equal((await call('availabilityMatch')).status,405);
 assert.equal([...context.store.records.keys()].filter(key=>key.startsWith('availability/')).length,0);
 assert.equal(context.notifications.length,0);assert.equal(context.requests.length,0);
});

test('calendar projections use the same clock-change rules as matching',async()=>{
 const context=await fixture(),record=emptyAvailability();
 record.weekly[0]={status:'available',windows:[{start:'02:30',end:'04:00'}]};
 assert.equal((await save(ids.a,record,{who:'a'})).status,200);
 const result=await call('availability',{who:'b',params:{from:'2027-03-14',to:'2027-03-14'}});
 assert.equal(result.status,200);assert.equal(result.data.from,'2027-03-14');assert.equal(result.data.to,'2027-03-14');
 const day=result.data.members.find(member=>member.id===ids.a).days[0];
 assert.equal(day.status,'needs-confirmation');assert.deepEqual(day.windows,[],'The calendar cannot show a green nonexistent arrival time.');
 assert.equal((await call('availability',{who:'a',params:{from:'2027-03-14'}})).status,400);
 assert.equal((await call('availability',{who:'a',params:{from:'2027-03-14',to:'2027-07-14'}})).status,400);
 assert.equal(context.notifications.length,0);assert.equal(context.requests.length,0);
});

test('saving availability does not add private schedules to home, websites, emails, contracts or Outlook',async()=>{
 const context=await fixture();
 const record=monday(['09:00','17:00']);record.exceptions['2027-01-04']={status:'unavailable',windows:[]};
 const before=[...context.store.records].filter(([key])=>key.startsWith('members/'));
 assert.equal((await save(ids.a,record,{who:'a'})).status,200);
 const home=await call('home',{who:'a'});assert.equal(home.status,200);assert.ok(!JSON.stringify(home.data).includes('"weekly"'));
 const feed=await call('published',{who:null});assert.equal(feed.status,200);assert.ok(!JSON.stringify(feed.data).includes('"weekly"'));
 for(const [key,value] of before)assert.deepEqual(context.store.records.get(key),value,'Availability cannot alter member identity, membership or publication.');
 assert.equal([...context.store.records.keys()].filter(key=>key.startsWith('outbox/')).length,0);
 assert.equal([...context.store.records.keys()].filter(key=>key.includes('agreements/')).length,0);
 assert.equal(context.notifications.length,0);assert.equal(context.requests.length,0);
});
