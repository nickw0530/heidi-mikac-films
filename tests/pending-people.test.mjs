import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {comparePeople} from '../members/people-order.mjs';

// Exercise the real portal routes without using production storage or email.
const portalFile=new URL('../netlify/functions/portal.mjs',import.meta.url);
let source=await readFile(portalFile,'utf8');
for(const [before,after] of [
 ["import {begin as beginCalendar,events as calendarEvents} from './calendar-callback.mjs';",'const beginCalendar=()=>{},calendarEvents=()=>{};'],
 ["import sharp from 'sharp';",'const sharp=()=>{throw Error("Unexpected image operation");};'],
 ["import { getStore } from '@netlify/blobs';",'const getStore=()=>globalThis.__pendingPeopleFixture.store;'],
 ["import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';",'const PDFDocument={},StandardFonts={},rgb=()=>{};'],
 ["import {enqueue, mailReady, portalUrl} from '../lib/mail.mjs';",'const enqueue=async(...args)=>{globalThis.__pendingPeopleFixture.notifications.push(args);},mailReady=()=>true,portalUrl="https://heidimikacfilms.com/members/";']
]){assert.ok(source.includes(before),'Mocks must match the current route imports.');source=source.replace(before,after);}
const packetStart=source.indexOf('async function packet(bytes, terms) {');
const handlerStart=source.indexOf('export default async function handle(req');
assert.ok(packetStart>=0&&handlerStart>packetStart);
source=source.slice(0,packetStart)+"async function packet(bytes,terms){globalThis.__pendingPeopleFixture.packets.push(structuredClone(terms));return Buffer.from('%PDF-private-preview');}\n"+source.slice(handlerStart);
source=source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_match,_quote,path)=>'from '+JSON.stringify(new URL(path,portalFile).href));
const {default:handle}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

const dark='written-in-the-dark',lies='wherein-lies-continue';
const existingId='00000000-0000-4000-8000-000000000081';
const tokens={Nick:'a'.repeat(64),Heidi:'b'.repeat(64),member:'c'.repeat(64)};
const digest=value=>createHash('sha256').update(value).digest('hex');
const clone=value=>value===undefined?undefined:structuredClone(value);

test('the shared people list keeps private profiles discoverable across productions',async()=>{
 const frontend=await readFile(new URL('../members/portal.js',import.meta.url),'utf8');
 const start=frontend.indexOf('function combinedPeople('),end=frontend.indexOf('\nfunction productionAssignments(',start);
 assert.ok(start>=0&&end>start);
 const combinedPeople=new Function('comparePeople',frontend.slice(start,end)+'\nreturn combinedPeople;')(comparePeople);
 const profile={id:'shared-profile',name:'Shared Private Person',role:'Crew'};
 const unassigned={id:'unassigned-private',name:'Unassigned Private Person',needsEmail:true,productions:{}};
 const states=[{productionId:dark,film:'Written in the Dark',catalog:[profile],members:[],unassignedProfiles:[unassigned]},{productionId:lies,film:'Wherein Lies Continue',catalog:[profile],members:[{id:'private-person',name:profile.name,filmProfile:profile.id,needsEmail:true,role:'Crew'}],unassignedProfiles:[unassigned]}];
 const people=combinedPeople(states);
 assert.equal(people.length,2,'A cross-film website profile and an unassigned contact each represent one person.');
 const shared=people.find(person=>person.name===profile.name);
 assert.equal(shared.memberId,'private-person','The actual profile ID must be retained even if a website entry was encountered first.');
 assert.equal(shared.hasMemberProfile,true);assert.equal(shared.hasAccount,false);assert.equal(shared.needsEmail,true);
 const waiting=people.find(person=>person.name===unassigned.name);
 assert.equal(waiting.unassigned,true);assert.equal(waiting.memberId,unassigned.id);assert.equal(waiting.hasMemberProfile,true);
});
process.env.HMF_NICK_LOGIN_SHA256='pending-nick';
process.env.HMF_HEIDI_LOGIN_SHA256='pending-heidi';
delete process.env.SIGNWELL_API_KEY;

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
 const context={store,notifications:[],requests:[],packets:[]};globalThis.__pendingPeopleFixture=context;
 for(const [who,token] of Object.entries(tokens))await store.setJSON('sessions/'+digest(token),{id:who==='member'?existingId:who,admin:who!=='member',adminDigest:who==='member'?null:'pending-'+who.toLowerCase(),expires:Date.now()+3600000});
 await store.setJSON('members/'+existingId,{id:existingId,name:'Existing Member',email:'existing@example.invalid',generalInvite:true,productions:{[dark]:{role:'Actor'},[lies]:{role:'Crew'}}});
 globalThis.fetch=async(input,options)=>{context.requests.push({url:String(input),method:options?.method});throw Error('No external calls are allowed in pending-person tests.');};
 return context;
}
async function call(action,{body,who='Nick',production=dark,id='',origin,params={}}={}){
 const url=new URL('https://heidimikacfilms.com/.netlify/functions/portal');url.search=new URLSearchParams({action,production,...(id?{id}:{}),...params});
 const raw=body instanceof Uint8Array;
 const response=await handle(new Request(url,{method:body===undefined?'GET':'POST',headers:{origin:origin||url.origin,'content-type':raw?'application/pdf':'application/json',...(who?{cookie:'__Host-hmf='+tokens[who]}:{})},body:body===undefined?undefined:raw?body:JSON.stringify(body)}));
 return {status:response.status,data:response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer())};
}
async function home(production=dark,who='Nick'){const result=await call('home',{production,who});assert.equal(result.status,200);return result.data;}
async function add(name='Pending Performer',productions=[]){const result=await call('savePendingPerson',{body:{name,productions}});assert.equal(result.status,200,JSON.stringify(result.data));return (await home()).pendingPeople.find(person=>person.name===name);}
const memberRecords=context=>[...context.store.records].filter(([key])=>key.startsWith('members/'));
const accountRecords=context=>memberRecords(context).filter(([,record])=>!!record.value.email&&!record.value.pendingContact);

test('a name-only record is private, global, and sends no invitation',async()=>{
 const context=await fixture(),before=clone(await context.store.get('members/'+existingId));
 const person=await add('Pending Performer',[dark,lies]);assert.ok(person?.id);
 assert.equal(person.status,'Email needed');
 assert.deepEqual(person.productions,[dark,lies]);
 assert.ok((await home(lies)).pendingPeople.some(row=>row.id===person.id),'The tracker is global across production requests.');
 const contact=await context.store.get('members/'+person.id);
 assert.ok(contact?.pendingContact,'A name-only record creates a private person profile.');
 assert.ok(!contact.email,'The private person has no fabricated email address.');
 assert.equal(accountRecords(context).length,1,'A saved name does not create an authenticated portal account.');
 assert.ok(!(await context.store.get('passwords/'+person.id))&&!contact.ticket);
 assert.ok((await home()).members.some(row=>row.id===person.id),'A saved person is available in the production People profiles.');
 assert.deepEqual(await context.store.get('members/'+existingId),before);
 assert.equal(context.notifications.length,0);assert.equal(context.requests.length,0);
 const publicFeed=await call('published',{who:null});assert.equal(publicFeed.status,200);
 assert.ok(!publicFeed.data.some(row=>row.name==='Pending Performer'),'Private tracking cannot publish a cast profile.');
 const memberHome=await home(dark,'member');assert.ok(!Object.hasOwn(memberHome,'pendingPeople')||memberHome.pendingPeople.length===0,'Regular members cannot read the private pending-name list.');
 const key='portal-pending/'+person.id;
 await context.store.setJSON(key,{...await context.store.get(key),inviteLeaseToken:'fixture-private-lease',inviteLeaseUntil:Date.now()+120000});
 const sanitized=(await home()).pendingPeople.find(row=>row.id===person.id);
 assert.ok(!Object.hasOwn(sanitized,'inviteLeaseToken')&&!Object.hasOwn(sanitized,'inviteLeaseUntil'),'Invitation reservation details are never returned to the browser.');
});

test('only administrators can add, update, or archive pending names',async()=>{
 const context=await fixture(),person=await add();
 for(const who of [null,'member'])for(const [action,body,id] of [
  ['savePendingPerson',{name:'Unauthorized Name',productions:[]},''],
  ['savePendingPerson',{name:'Changed Name',productions:[]},person.id],
  ['removePendingPerson',{},person.id]
 ])assert.ok([401,403].includes((await call(action,{who,body,id})).status));
 assert.equal((await call('savePendingPerson',{id:person.id,body:{name:'Changed Name',productions:[]},origin:'https://other.invalid'})).status,403);
 assert.equal((await home()).pendingPeople.find(row=>row.id===person.id).name,'Pending Performer');
 assert.equal(context.notifications.length,0);assert.equal(context.requests.length,0);
});

test('name and production validation leaves an empty tracker unchanged',async()=>{
 const context=await fixture();
 for(const body of [{name:'',productions:[]},{name:' '.repeat(5),productions:[]},{name:'A'.repeat(201),productions:[]},{name:'Pending Performer',productions:['unknown-production']},{name:'Pending Performer',productions:'all'}]){
  assert.equal((await call('savePendingPerson',{body})).status,400);
 }
 assert.equal((await home()).pendingPeople.length,0);
 const person=await add('Unassigned Performer');assert.deepEqual(person.productions,[],'Production labels may be left empty when not known.');
 assert.equal(context.notifications.length,0);assert.equal(accountRecords(context).length,1);
 assert.ok((await home()).unassignedProfiles.some(row=>row.id===person.id),'A person with no production remains available as a private profile.');
});

test('normalized duplicates are rejected without guessing aliases or merging people',async()=>{
 const context=await fixture();
 assert.equal((await call('savePendingPerson',{body:{name:'existing-member',productions:[]}})).status,409);
 const person=await add("Morgan O'Neil",[dark]);
 assert.equal((await call('savePendingPerson',{body:{name:'morgan o neil',productions:[lies]}})).status,409);
 const different=await add('Morgan Stage Name',[lies]);assert.notEqual(different.id,person.id,'Different names are separate records rather than inferred aliases.');
 const results=await Promise.all([call('savePendingPerson',{body:{name:'Concurrent Performer',productions:[]}}),call('savePendingPerson',{who:'Heidi',body:{name:'concurrent-performer',productions:[]}})]);
 assert.equal(results.filter(result=>result.status===200).length,1,'The normalized name index reserves a single new entry.');
 assert.ok(results.some(result=>result.status===409));
 assert.equal((await home()).pendingPeople.length,3);
 assert.equal(accountRecords(context).length,1);assert.equal(context.notifications.length,0);
});

test('saved names can be corrected or archived without changing member accounts',async()=>{
 const context=await fixture(),person=await add('Misspelled Performer',[dark]);
 const before=clone(await context.store.get('members/'+existingId));
 assert.equal((await call('savePendingPerson',{who:'Heidi',id:person.id,body:{name:'Corrected Performer',productions:[lies]}})).status,200);
 let listed=(await home()).pendingPeople.find(row=>row.id===person.id);
 assert.equal(listed.name,'Corrected Performer');assert.deepEqual(listed.productions,[lies]);
 assert.equal((await call('savePendingPerson',{id:person.id,body:{name:'Existing Member',productions:[]}})).status,409);
 assert.equal((await home()).pendingPeople.find(row=>row.id===person.id).name,'Corrected Performer');
 assert.equal((await call('removePendingPerson',{id:person.id,body:{}})).status,200);
 assert.ok(!(await home()).pendingPeople.some(row=>row.id===person.id));
 assert.ok((await context.store.get('portal-pending/'+person.id)).archived,'Removal preserves a soft-archived tracking record.');
 assert.equal((await call('savePendingPerson',{body:{name:'Corrected Performer',productions:[]}})).status,409,'Archiving the setup reminder cannot create a duplicate of the preserved private profile.');
 assert.deepEqual(await context.store.get('members/'+existingId),before);
 assert.equal(context.notifications.length,0);assert.equal(context.requests.length,0);
});

test('inviting a saved private person preserves their profile and creates one invitation',async()=>{
 const context=await fixture(),person=await add('Invited Performer',[dark,lies]);
 const privateProfile=await context.store.get('members/'+person.id);
 const bio={bio:'Saved biography before an email is known.'};
 const photo=Buffer.from('private-photo-original-bytes');
 await context.store.setJSON('profiles/'+person.id,bio);
 await context.store.set('photos/'+person.id,photo,{metadata:{mime:'image/jpeg',version:'private-original'}});
 await context.store.setJSON('tasks/'+person.id+'/private-task',{id:'private-task',title:'Saved task',done:false});
 const body={pendingId:person.id,email:'new-person@example.invalid',name:'Do Not Use This Posted Name'};
 const results=await Promise.all([call('invite',{body}),call('invite',{who:'Heidi',body})]);
 assert.equal(results.filter(result=>result.status===200).length,1,'Concurrent invitations for one tracking entry must create only one account: '+JSON.stringify(results));
 assert.ok(results.every(result=>[200,409].includes(result.status)),JSON.stringify(results));
 assert.equal(context.notifications.length,1);assert.equal(context.requests.length,0);
 assert.equal(memberRecords(context).length,2);
 const pending=(await home()).pendingPeople.find(row=>row.id===person.id);
 assert.equal(pending.status,'Invitation pending');assert.ok(pending.memberId);
 const member=await context.store.get('members/'+pending.memberId);
 assert.equal(member.name,'Invited Performer','The saved identity wins over a tampered invite name.');
 assert.equal(member.email,'new-person@example.invalid');assert.equal(member.generalInvite,true);
 assert.equal(member.pendingContact,false);
 assert.deepEqual(member.productions,privateProfile.productions,'Inviting preserves the production assignments already prepared privately.');
 assert.deepEqual(await context.store.get('profiles/'+member.id),bio);
 assert.deepEqual(Buffer.from(await context.store.get('photos/'+member.id)),photo);
 assert.equal((await context.store.get('tasks/'+member.id+'/private-task')).title,'Saved task');
 assert.equal((await call('published',{who:null})).data.some(row=>row.name==='Invited Performer'),false,'An invitation cannot approve or publish a private profile.');
 assert.equal(context.notifications[0][1].id,member.id);
 assert.equal((await call('invite',{body})).status,409);
 assert.equal(context.notifications.length,1,'A repeated invite action must not issue another invitation.');
 assert.equal((await call('savePendingPerson',{id:person.id,body:{name:'Different Identity',productions:[]}})).status,409,'An invitation cannot be reassigned to another person by renaming its tracker entry.');
 await context.store.setJSON('passwords/'+member.id,{digest:'fixture-password-record'});
 assert.equal((await home()).pendingPeople.find(row=>row.id===person.id).status,'Account created');
 assert.equal((await call('removePendingPerson',{id:person.id,body:{}})).status,200);
 assert.deepEqual(await context.store.get('members/'+member.id),member,'Archiving tracking never revokes or removes an invited account.');
});

test('an invalid or unavailable invite target cannot create an account or invitation',async()=>{
 const context=await fixture(),person=await add('Email Needed',[dark]);
 assert.equal((await call('invite',{body:{pendingId:person.id,email:'not-an-email'}})).status,400);
 assert.equal((await call('invite',{body:{pendingId:person.id,email:'existing@example.invalid'}})).status,409,'A saved name cannot create a duplicate account at an existing email address.');
 assert.ok((await call('invite',{body:{pendingId:'not-a-uuid',email:'new@example.invalid'}})).status>=400);
 assert.equal((await call('invite',{who:'member',body:{pendingId:person.id,email:'new@example.invalid'}})).status,403);
 assert.equal((await call('removePendingPerson',{id:person.id,body:{}})).status,200);
 const contact=await context.store.get('members/'+person.id);
 await context.store.setJSON('members/'+person.id,{...contact,revoked:true});
 assert.ok((await call('invite',{body:{pendingId:person.id,email:'new@example.invalid'}})).status>=400);
 assert.equal(accountRecords(context).length,1);assert.equal(context.notifications.length,0);assert.equal(context.requests.length,0);
});

test('resending to either email replaces older setup links on the same account',async()=>{
 const context=await fixture();
 const previousEmail='original-performer@example.invalid',email='corrected-performer@example.invalid';
 const name='Invited Performer',password='fixture-password-321';
 assert.equal((await call('invite',{body:{name,email:previousEmail}})).status,200);
 const id=context.notifications[0][1].id;
 const ticket=index=>context.notifications[index][4].match(/#invite=([a-f0-9]{64})/)[1];
 const activate=value=>call('activate',{who:null,body:{ticket:value,password}});
 assert.equal((await call('resend',{id,body:{email:previousEmail,expectedEmail:previousEmail}})).status,200);
 assert.notEqual(ticket(1),ticket(0));
 assert.ok((await activate(ticket(0))).status>=400,'Same-address resend invalidates the first link before the new link is used.');

 assert.equal((await call('resend',{id,who:'Heidi',body:{email,expectedEmail:previousEmail}})).status,200);
 assert.equal(context.notifications.length,3);
 assert.notEqual(ticket(2),ticket(1));
 assert.deepEqual(context.notifications.map(([,member])=>[member.id,member.email]),[[id,previousEmail],[id,previousEmail],[id,email]]);
 assert.equal((await context.store.get('members/'+id)).email,email);
 assert.equal(await context.store.get('active-email/'+digest(previousEmail)),null);
 assert.equal((await context.store.get('active-email/'+digest(email))).id,id);
 assert.equal(accountRecords(context).length,2);
 assert.equal((await call('resend',{id,body:{email:previousEmail,expectedEmail:previousEmail}})).status,409,'A stale form cannot switch the address back.');
 for(const older of [ticket(0),ticket(1)])assert.ok((await activate(older)).status>=400,'Earlier links remain invalid after the address changes.');
 assert.equal(await context.store.get('passwords/'+id),null);
 assert.equal((await activate(ticket(2))).status,200);
 assert.ok((await activate(ticket(2))).status>=400,'The newest link is single-use.');
 assert.equal((await call('passwordLogin',{who:null,body:{username:email,password}})).status,200);
 assert.equal((await call('passwordLogin',{who:null,body:{username:previousEmail,password}})).status,401);
 assert.equal(context.notifications.length,3);
});

test('a direct invite to a corrected address cannot create a second same-name account',async()=>{
 const context=await fixture();
 const result=await call('invite',{body:{name:'Existing-Member',email:'different-address@example.invalid'}});
 assert.equal(result.status,409);
 assert.equal(accountRecords(context).length,1);
 assert.equal(context.notifications.length,0);
});

test('an old invite cannot create a password while its replacement is being issued',async()=>{
 const context=await fixture(),{store}=context;
 assert.equal((await call('resend',{id:existingId,body:{}})).status,200);
 const ticket=context.notifications[0][4].match(/#invite=([a-f0-9]{64})/)[1];
 const activation=()=>call('activate',{who:null,body:{ticket,password:'fixture-password-321'}});
 const save=store.setJSON.bind(store),paused=Promise.withResolvers(),resume=Promise.withResolvers();
 store.setJSON=async(key,value,options)=>{
  if(key.startsWith('tickets/')){paused.resolve();await resume.promise;}
  return save(key,value,options);
 };
 const replacing=call('resend',{id:existingId,body:{}});
 try{
  await paused.promise;
  assert.equal((await activation()).status,409);
  assert.equal(await store.get('passwords/'+existingId),null);
 }finally{resume.resolve();}
 assert.equal((await replacing).status,200);
 assert.equal((await activation()).status,409);
 assert.equal(await store.get('passwords/'+existingId),null);
});

test('only the latest legacy invitation works across unactivated accounts linked to the same catalog profile',async()=>{
 const context=await fixture();
 const latest='00000000-0000-4000-8000-000000000082';
 const previousTicket='d'.repeat(64),latestTicket='e'.repeat(64);
 const olderExpiry=Date.now()+6*86400000;
 for(const {id,name,email,ticket,expires} of [
  {id:existingId,name:'Rachel DeMicco',email:'earlier@example.invalid',ticket:previousTicket,expires:olderExpiry},
  {id:latest,name:'Rachel DeMicco',email:'correct@example.invalid',ticket:latestTicket,expires:olderExpiry+3600000}
 ]){
  const link=digest(ticket);
  await context.store.setJSON('members/'+id,{id,name,email,ticket:link,generalInvite:true,productions:{},profileLinks:{[dark]:'rachel'}});
  await context.store.setJSON('tickets/'+link,{id,expires});
 }
 const activate=ticket=>call('activate',{who:null,body:{ticket,password:'fixture-password-321'}});
 assert.ok((await activate(previousTicket)).status>=400,'An older legacy invite fails even before the newer account has been activated.');
 assert.equal(await context.store.get('passwords/'+existingId),null);
 assert.equal((await activate(latestTicket)).status,200);
 assert.ok((await activate(previousTicket)).status>=400,'Activating the corrected account cannot revive the legacy invite.');
 assert.equal(await context.store.get('passwords/'+existingId),null);
 assert.equal(context.notifications.length,0);
});

test('a private no-email profile supports biography, tasks and documents without notifications',async()=>{
 const context=await fixture(),person=await add('Private Profile Performer',[dark]);
 assert.equal((await call('bio',{id:person.id,body:{bio:'A privately saved biography.'}})).status,200);
 assert.equal((await call('task',{id:person.id,body:{title:'Bring wardrobe'}})).status,200);
 const original=Buffer.from('%PDF-1.7\nPrivate assigned document bytes\n%%EOF');
 assert.equal((await call('resource',{id:person.id,body:original,params:{title:'Private call sheet',audience:'selected',recipient:person.id}})).status,200);
 const state=await home(),row=state.members.find(member=>member.id===person.id),resource=state.resources.find(file=>file.title==='Private call sheet');
 assert.ok(resource);assert.ok(resource.audience.includes(person.id));
 assert.equal(row.profile.bio,'A privately saved biography.');assert.ok(row.tasks.some(task=>task.title==='Bring wardrobe'));
 assert.deepEqual((await call('resource',{params:{id:resource.id}})).data,original);
 assert.equal((await call('trackPaperwork',{id:person.id,body:{document:resource.id,reason:'complete'}})).status,200);
 assert.equal((await call('trackPaperwork',{id:person.id,body:{document:'agreement',reason:'not-required'}})).status,200);
 const updated=(await home()).members.find(member=>member.id===person.id);
 assert.equal(updated.documentTracking[resource.id],'complete');assert.equal(updated.paperworkStatus,'Document N/A');
 assert.equal(context.notifications.length,0,'Saving private tasks and documents must not queue email to a missing address.');
 assert.equal(context.requests.length,0);assert.equal(accountRecords(context).length,1);
 assert.equal((await call('memberPhoto',{id:person.id,who:null})).status,404,'A private no-email profile cannot expose an image publicly.');
 assert.equal((await call('published',{who:null})).data.some(member=>member.name==='Private Profile Performer'),false);
});

test('contracts can be previewed privately but require an email before sending',async()=>{
 const context=await fixture(),person=await add('Private Contract Performer',[dark]);
 await context.store.set('contract/master',Buffer.from('%PDF-unsigned-master'));
 const terms={legal:'Private Contract Performer',credit:'Private Contract Performer',character:'Supporting actor',crewTitle:'',rate:'0',date:'2026-11-09'};
 const preview=await call('agreement',{id:person.id,body:{...terms,preview:true}});
 assert.equal(preview.status,200);assert.equal(preview.data.toString(),'%PDF-private-preview');
 assert.equal(context.packets.length,1);
 assert.equal((await call('agreement',{id:person.id,body:terms})).status,409,'No signing request can be sent without a recipient email.');
 assert.equal((await call('sendAgreement',{id:person.id,body:{documentId:'00000000-0000-4000-8000-000000000099'}})).status,409);
 assert.equal(context.packets.length,1,'Blocked sending cannot generate an extra contract.');
 assert.equal(context.notifications.length,0);assert.equal(context.requests.length,0);
});

test('an archived setup reminder retains a usable private profile for later correction and invitation',async()=>{
 const context=await fixture(),person=await add('Archived Private Performer',[dark]);
 await context.store.setJSON('profiles/'+person.id,{bio:'Preserved while the setup reminder is archived.'});
 assert.equal((await call('removePendingPerson',{id:person.id,body:{}})).status,200);
 assert.equal((await call('savePendingPerson',{id:person.id,body:{name:'Corrected Archived Performer',productions:[dark]}})).status,200);
 assert.ok((await context.store.get('portal-pending/'+person.id)).archived,'Editing the private profile does not silently restore its setup reminder.');
 assert.equal((await home()).members.find(row=>row.id===person.id).name,'Corrected Archived Performer');
 assert.equal((await call('invite',{body:{pendingId:person.id,email:'restored@example.invalid'}})).status,200);
 const row=(await home()).pendingPeople.find(row=>row.id===person.id);
 assert.ok(row);assert.equal(row.memberId,person.id);assert.equal(row.status,'Invitation pending');
 assert.equal((await home()).members.find(member=>member.id===person.id).profile.bio,'Preserved while the setup reminder is archived.');
 assert.equal(memberRecords(context).length,2);assert.equal(accountRecords(context).length,2);
 assert.equal(context.notifications.length,1);assert.equal(context.requests.length,0);
});
