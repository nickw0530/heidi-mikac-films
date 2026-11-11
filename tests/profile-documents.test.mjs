import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,scryptSync} from 'node:crypto';
import {test} from 'node:test';
import sharp from 'sharp';
import {AGREEMENT_CYCLE,currentAgreementKey} from '../netlify/lib/agreement-cycle.mjs';
import {adminActions} from '../netlify/lib/admin-actions.mjs';
import {checkSigningNotices} from '../netlify/lib/signing-notices.mjs';
import {refreshAgreement} from '../netlify/lib/signing.mjs';
import {enqueue,deliver} from '../netlify/lib/mail.mjs';
import darkCatalog from '../netlify/lib/film-profiles.mjs';

// Exercise the real routes with isolated storage, provider calls, and notifications.
// This test must never create a real document or deliver an email.
const portalFile=new URL('../netlify/functions/portal.mjs',import.meta.url);
let source=await readFile(portalFile,'utf8');
for(const [before,after] of [
 ["import {begin as beginCalendar,events as calendarEvents} from './calendar-callback.mjs';",'const beginCalendar=()=>{},calendarEvents=()=>{};'],
 ["import sharp from 'sharp';",'const sharp=(...args)=>globalThis.__profileDocumentFixture.sharp(...args);'],
 ["import { getStore } from '@netlify/blobs';",'const getStore=()=>globalThis.__profileDocumentFixture.store;'],
 ["import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';",'const PDFDocument={},StandardFonts={},rgb=()=>{};'],
 ["import {enqueue, mailReady, portalUrl} from '../lib/mail.mjs';",'const enqueue=async(...args)=>{globalThis.__profileDocumentFixture.notifications.push(args);},mailReady=()=>true,portalUrl="https://heidimikacfilms.com/members/";']
]){assert.ok(source.includes(before),'Route mock must match the current implementation.');source=source.replace(before,after);}
const packetStart=source.indexOf('async function packet(bytes, terms) {');
const handlerStart=source.indexOf('export default async function handle(req');
assert.ok(packetStart>=0&&handlerStart>packetStart);
source=source.slice(0,packetStart)+"async function packet(){return Buffer.from('%PDF-test-preview');}\n"+source.slice(handlerStart);
source=source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_match,_quote,path)=>'from '+JSON.stringify(new URL(path,portalFile).href));
const {default:handle}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

const dark='written-in-the-dark',lies='wherein-lies-continue';
const actor='00000000-0000-4000-8000-000000000041',other='00000000-0000-4000-8000-000000000042';
const pdfId='00000000-0000-4000-8000-000000000043',privatePdfId='00000000-0000-4000-8000-000000000044';
const owners={Nick:'00000000-0000-4000-8000-000000000051',Heidi:'00000000-0000-4000-8000-000000000052'};
const tokens={Nick:'a'.repeat(64),Heidi:'b'.repeat(64),member:'c'.repeat(64)};
const digest=value=>createHash('sha256').update(value).digest('hex');
const profile=darkCatalog.find(person=>person.name==='Rachel DeMicco');assert.ok(profile);
const originalPdf=Buffer.from('%PDF-1.7\nOriginal agreement and audit pages\n%%EOF');
const resourcePdf=Buffer.from('%PDF-1.7\nOriginal assigned document\n%%EOF');
const trackingKey=(production,member,document='agreement-'+AGREEMENT_CYCLE)=>'document-tracking/'+production+'/'+member+'/'+document;
const clone=value=>value===undefined?undefined:structuredClone(value);
process.env.HMF_NICK_LOGIN_SHA256='test-docs-nick';
process.env.HMF_HEIDI_LOGIN_SHA256='test-docs-heidi';
process.env.SIGNWELL_API_KEY='test-only-key';
process.env.HMF_SIGNWELL_LIVE='yes';

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
 const context={store,sharp,calls:[],notifications:[],documents:new Map()};
 globalThis.__profileDocumentFixture=context;
 for(const [who,token] of Object.entries(tokens))await store.setJSON('sessions/'+digest(token),{id:who==='member'?actor:who,admin:who!=='member',adminDigest:who==='member'?null:'test-docs-'+who.toLowerCase(),expires:Date.now()+3600000});
 for(const [id,name] of [[actor,'Rachel DeMicco'],[other,'Another Member']])await store.setJSON('members/'+id,{id,name,email:id+'@example.invalid',productions:{[dark]:{role:'Actor',filmProfile:id===actor?profile.id:''},[lies]:{role:'Crew',filmProfile:''}}});
 await store.setJSON('agreements/'+actor,{id:'historical-doc',status:'Complete'});
 await store.setJSON('paperwork/'+dark+'/'+actor,{reason:'hard-copy',by:'Nick',at:1});
 await store.set('offline/'+profile.id,originalPdf,{metadata:{status:'Complete'}});
 await store.setJSON('resources/'+pdfId,{id:pdfId,title:'Assigned document',type:'PDF',audience:[actor,other],created:1});
 await store.set('files/'+pdfId,resourcePdf);
 await store.setJSON('resources/'+privatePdfId,{id:privatePdfId,title:'Other person document',type:'PDF',audience:[other],created:1});
 globalThis.fetch=async(input,options={})=>{
  const url=new URL(input);assert.equal(url.origin,'https://www.signwell.com','Provider calls stay on the mocked SignWell host.');
  const body=options.body?JSON.parse(options.body):undefined;
  context.calls.push({path:url.pathname,method:options.method||'GET',body});
  if(url.pathname.endsWith('/completed_pdf'))return new Response(originalPdf,{headers:{'content-type':'application/pdf'}});
  const id=decodeURIComponent(url.pathname.split('/')[4]);
  assert.ok(context.documents.has(id),'Unexpected provider document '+id);
  const document=context.documents.get(id);
  if((options.method||'GET')==='GET')return Response.json(clone(document));
  assert.equal(url.pathname,'/api/v1/documents/'+id+'/send','Only an explicit draft-send action may mutate the mocked provider.');
  document.status='sent';return Response.json(clone(document));
 };
 return context;
}
async function call(action,{body,who='Nick',production=dark,id=actor,params={},method,origin}={}){
 const url=new URL('https://heidimikacfilms.com/.netlify/functions/portal');url.search=new URLSearchParams({action,production,id,...params});
 const raw=body instanceof FormData||body instanceof Blob;
 const response=await handle(new Request(url,{method:method||(body===undefined?'GET':'POST'),headers:{origin:origin||url.origin,...(raw?{}:{'content-type':'application/json'}),...(who?{cookie:'__Host-hmf='+tokens[who]}:{})},body:body===undefined||raw?body:JSON.stringify(body)}));
 const data=response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());
 return {status:response.status,response,data};
}
async function row(production=dark,who='Nick',id=actor){const result=await call('home',{production,who});assert.equal(result.status,200);return result.data.members.find(member=>member.id===id);}
async function setAgreement(context,{id='active-doc',production=dark,status='Waiting on actor',providerStatus='sent'}={}){
 const agreement={id,cycle:AGREEMENT_CYCLE,name:(production===dark?'Written in the Dark':'Wherein Lies Continue')+' — Rachel DeMicco · '+AGREEMENT_CYCLE,status,providerStatus,created:Date.now(),checkedAt:Date.now()};
 await context.store.setJSON(currentAgreementKey(production,actor),agreement);
 context.documents.set(id,{id,name:agreement.name,status:providerStatus,recipients:[{id:'1',name:'Rachel DeMicco',email:actor+'@example.invalid',status:'pending'},{id:'2',name:'Heidi Mikac',email:'hello@heidimikacfilms.com',status:'pending'}]});
 return agreement;
}
async function ownerFixture({linked=true}={}){
 const context=await fixture(),{store}=context;
 if(linked)await store.setJSON('settings/admin-profiles',owners);
 const names={Nick:'Nick Williams',Heidi:'Heidi Mikac'};
 for(const [owner,id] of Object.entries(owners)){
  const productions={
   [dark]:{role:'Producer',filmProfile:owner==='Nick'?'nick':'heidi'},
   [lies]:{role:'Producer',filmProfile:owner==='Nick'?'nick-williams':'heidi'},
  };
  await store.setJSON('members/'+id,{id,name:names[owner],email:owner.toLowerCase()+'-profile@example.invalid',productions,
   productionRequests:{[dark]:'stale-request-'+owner}});
  await store.setJSON('tasks/'+id+'/old-task',{id:'old-task',title:'Old personal task',done:false});
  await store.setJSON('portal-pending/'+id,{id,memberId:id,name:names[owner]});
  await store.setJSON(currentAgreementKey(dark,id),{id:'pending-'+owner,cycle:AGREEMENT_CYCLE,status:'Waiting on Heidi'});
  await store.setJSON('agreements/'+id,{id:'archived-'+owner,status:'Complete'});
 }
 return context;
}

test('either administrator can see and complete tasks assigned to either administrator',async()=>{
 const context=await fixture();
 for(const [who,owner,production] of [['Heidi','Nick',dark],['Nick','Heidi',lies]]){
  const title='Follow up with production';
  const created=await call('adminTask',{who,production,body:{owner,title}});
  assert.equal(created.status,200);
  const pending=async viewer=>(await call('home',{who:viewer,production})).data.waiting.filter(item=>item.taskId);
  const [task]=await pending(owner);
  assert.equal(task.owner,owner);
  assert.equal(task.label,title);
  assert.deepEqual(await pending(who),[task]);
  assert.deepEqual(await pending('member'),[]);

  const body={owner,task:task.taskId};
  assert.equal((await call('finishAdminTask',{who:'member',production,body})).status,403);
  assert.equal((await call('finishAdminTask',{who,production:production===dark?lies:dark,body})).status,400);
  assert.equal((await call('finishAdminTask',{who,production,body:{...body,owner:actor}})).status,400);
  assert.deepEqual(await pending(owner),[task]);
  assert.equal((await call('finishAdminTask',{who,production,body})).status,200);
  assert.deepEqual(await pending(owner),[]);
  assert.deepEqual(await pending(who),[]);
 }
 assert.deepEqual(context.notifications,[]);
});

test('administrator linking accepts only the verified pair of existing cast profile IDs',async()=>{
 const {store}=await ownerFixture({linked:false});
 assert.equal((await call('linkAdminProfiles',{who:'member',body:owners})).status,403);
 assert.equal((await call('linkAdminProfiles',{body:{...owners,Nick:other}})).status,409);
 assert.equal(await store.get('settings/admin-profiles'),null);
 assert.equal((await call('linkAdminProfiles',{body:owners})).status,200);
 assert.deepEqual(await store.get('settings/admin-profiles'),owners);
 assert.equal((await call('linkAdminProfiles',{who:'Heidi',body:owners})).status,200);
 assert.equal((await call('linkAdminProfiles',{body:{Nick:owners.Heidi,Heidi:owners.Nick}})).status,409);
 assert.deepEqual(await store.get('settings/admin-profiles'),owners);
});

test('both administrators see the linked personal profiles and can edit either of them',async()=>{
 const {store,notifications}=await ownerFixture();
 for(const [who,id] of Object.entries(owners)){
  const home=await call('home',{who});
  assert.equal(home.status,200);
  assert.equal(home.data.adminProfileId,id);
  for(const [owner,memberId] of Object.entries(owners)){
   const member=home.data.members.find(row=>row.id===memberId);
   assert.equal(member.adminProfile,owner);
   assert.equal(member.paperworkExempt,true);
   assert.equal(member.needsEmail,false);
   assert.deepEqual(member.tasks,[]);
   assert.ok(member.documents.some(document=>document.kind==='previous-signed'));
   assert.ok(!home.data.waiting.some(action=>action.member===memberId));
   assert.ok(!home.data.productionReviews.some(review=>review.id===memberId));
   assert.ok(!home.data.pendingPeople.some(person=>person.profileId===memberId));
  }
 }
 const photo=await sharp({create:{width:12,height:16,channels:3,background:'#ffc344'}}).jpeg().toBuffer();
 for(const [who,target] of [['Heidi',owners.Nick],['Nick',owners.Heidi]]){
  assert.equal((await call('bio',{who,id:target,body:{bio:'Edited by '+who}})).status,200);
  assert.equal((await call('photo',{who,id:target,body:new Blob([photo],{type:'image/jpeg'})})).status,200);
  const member=await store.get('members/'+target);
  assert.deepEqual(member.draftProfile,{bio:'Edited by '+who,imageVersion:digest(photo)});
  assert.equal((await call('memberDocument',{who,id:target,params:{kind:'previous-signed'}})).status,200);
 }
 const details={name:'Nick Williams (fixture)',email:'updated-profile@example.invalid'};
 assert.equal((await call('saveAdminProfileDetails',{who:'Heidi',id:owners.Nick,body:details})).status,200);
 const updated=await row(dark,'Nick',owners.Nick);
 assert.equal(updated.adminProfile,'Nick');
 assert.equal(updated.name,details.name);
 assert.equal(updated.email,details.email);
 assert.equal(updated.filmProfile,'nick');
 assert.equal((await call('home',{who:'Nick'})).data.adminProfileId,owners.Nick);
 assert.equal((await call('saveAdminProfileDetails',{who:'member',id:owners.Nick,body:details})).status,403);
 assert.deepEqual(notifications,[]);
});

test('linked personal profiles cannot sign in separately or trigger portal requirements',async()=>{
 const context=await ownerFixture(),{store}=context;
 const id=owners.Nick,password='A unique former member password',salt='old-member-password-salt';
 const code='old-member-key-'.repeat(4),ticket='d'.repeat(64),resetTicket='e'.repeat(64);
 const credential={salt,digest:scryptSync(password,salt,64).toString('hex')};
 await store.setJSON('passwords/'+id,credential);
 await store.setJSON('keys/'+digest(code),{id});
 await store.setJSON('sessions/'+digest(tokens.member),{id,admin:false,expires:Date.now()+3600000});
 await store.setJSON('resets/'+digest(resetTicket),{id,passwordDigest:credential.digest,expires:Date.now()+3600000});
 await store.setJSON('members/'+owners.Heidi,{...(await store.get('members/'+owners.Heidi)),ticket:digest(ticket)});
 await store.setJSON('tickets/'+digest(ticket),{id:owners.Heidi,expires:Date.now()+3600000});
 const isDenied=response=>assert.ok([401,403,409].includes(response.status),JSON.stringify(response.data));
 const username=(await store.get('members/'+id)).email;
 isDenied(await call('passwordLogin',{who:null,body:{username,password}}));
 isDenied(await call('login',{who:null,body:{code}}));
 isDenied(await call('activate',{who:null,body:{ticket,password}}));
 isDenied(await call('home',{who:'member',id}));
 await call('requestReset',{who:null,body:{username}});
 const reset=await call('resetPassword',{who:null,body:{ticket:resetTicket,password:'Another formerly valid password'}});
 assert.ok([400,401,403,409].includes(reset.status));
 assert.deepEqual(await store.get('passwords/'+id),credential);
 for(const [action,body] of [
  ['agreement',{preview:true}],['sendAgreement',{documentId:'pending-Nick'}],['trackPaperwork',{document:'agreement',reason:'reopen'}],
  ['task',{title:'An unnecessary task'}],['resend',{}]
 ])isDenied(await call(action,{who:'Heidi',id,body}));
 const status=await call('status',{who:'Heidi',id,params:{document:'pending-Nick'}});
 if(status.status===200){
  assert.equal(status.data.url,null);
  assert.match(status.data.paperworkStatus||status.data.status,/not required/i);
 }else isDenied(status);
 assert.deepEqual(context.calls,[],'Exempt personal requirements must never reach SignWell.');
 assert.deepEqual(context.notifications,[]);
});

test('a member saves their headshot and biography together before website approval',async()=>{
 const context=await fixture();
 const jpeg=await sharp({create:{width:12,height:16,channels:3,background:'#ffc344'}}).jpeg().toBuffer();
 const edits=new FormData();
 edits.set('bio','  Saved member biography.  ');
 edits.set('file',new Blob([jpeg],{type:'image/jpeg'}),'Headshot.jpg');
 const saved=await call('memberProfile',{who:'member',body:edits});
 assert.equal(saved.status,200);
 assert.deepEqual(saved.data,{ok:true,imageVersion:digest(jpeg)});
 const member=await context.store.get('members/'+actor);
 assert.deepEqual(member.draftProfile,{bio:'Saved member biography.',imageVersion:digest(jpeg)});
 assert.deepEqual(Object.keys(member.productionRequests).sort(),[dark,lies].sort());
 assert.equal(member.approvedProfiles,undefined);
 const photo=await call('photo',{who:'member'});
 assert.equal(photo.response.headers.get('content-type'),'image/jpeg');
 assert.deepEqual(photo.data,jpeg);
 assert.equal((await row(dark,'member')).photoName,'Headshot.jpg');
 assert.equal((await call('memberProfile',{who:'member',id:other,body:edits})).status,403);
});

test('bad headshots produce a specific error without saving the accompanying biography',async()=>{
 const context=await fixture();
 const edits=new FormData();
 edits.set('bio','Do not save this with a broken headshot.');
 edits.set('file',new Blob([Buffer.from('ffd8ff','hex')],{type:'image/jpeg'}),'Broken.jpg');
 const failed=await call('memberProfile',{who:'member',body:edits});
 assert.equal(failed.status,400);
 assert.match(failed.data.error,/headshot could not be read/i);
 assert.equal((await context.store.get('members/'+actor)).draftProfile,undefined);
 assert.ok(![...context.store.records.keys()].some(key=>key.startsWith('profile-images/')));

 const member=await context.store.get('members/'+actor);
 await context.store.setJSON('members/'+actor,{...member,productions:{}});
 edits.delete('file');
 edits.set('bio','An unassigned member can save a biography on its own.');
 assert.equal((await call('memberProfile',{who:'member',body:edits})).status,200);
 const saved=await context.store.get('members/'+actor);
 assert.equal(saved.draftProfile.bio,edits.get('bio'));
 assert.deepEqual(saved.productionRequests,{});
});

test('admin biography and headshot saves publish to both assigned films without creating reviews',async()=>{
 const {store}=await fixture();
 const original=await store.get('members/'+actor);
 const darkPhoto='https://example.invalid/dark-approved.jpg';
 const liesPhoto='https://example.invalid/lies-approved.jpg';
 await store.setJSON('members/'+actor,{...original,approvedProfiles:{
  [dark]:{bio:'Previously published for Written in the Dark.',photo:darkPhoto},
  [lies]:{bio:'Previously published for Wherein Lies Continue.',photo:liesPhoto}
 }});
 const publicProfile=async production=>{
  const response=await call('published',{who:null,production});
  assert.equal(response.status,200);
  return response.data.find(item=>item.name===original.name);
 };
 assert.match((await publicProfile(dark)).bio,/Previously published/);
 assert.match((await publicProfile(lies)).bio,/Previously published/);
 const saveBio=await call('bio',{who:'Heidi',body:{bio:'  Updated by production.  '}});
 assert.equal(saveBio.status,200);
 assert.deepEqual([...saveBio.data.publishedProductions].sort(),[dark,lies].sort());
 assert.equal((await publicProfile(dark)).bio,'Updated by production.');
 assert.equal((await publicProfile(lies)).bio,'Updated by production.');
 assert.equal((await publicProfile(dark)).photo,darkPhoto);
 assert.equal((await publicProfile(lies)).photo,liesPhoto);

 const jpeg=await sharp({create:{width:12,height:16,channels:3,background:'#a1805e'}}).jpeg().toBuffer();
 const savePhoto=await call('photo',{body:new Blob([jpeg],{type:'image/jpeg'}),params:{filename:'Studio headshot.jpg'}});
 assert.equal(savePhoto.status,200);
 assert.deepEqual([...savePhoto.data.publishedProductions].sort(),[dark,lies].sort());
 const imageVersion=digest(jpeg);
 assert.equal(savePhoto.data.imageVersion,imageVersion);
 const member=await store.get('members/'+actor);
 assert.deepEqual(member.draftProfile,{bio:'Updated by production.',imageVersion});
 assert.deepEqual(member.productions,original.productions);
 assert.deepEqual(member.productionRequests??{},{});
 const publicDark=await publicProfile(dark),publicLies=await publicProfile(lies);
 assert.equal(publicDark.bio,'Updated by production.');
 assert.equal(publicLies.bio,'Updated by production.');
 assert.equal(publicDark.photo,publicLies.photo);
 const photoUrl=new URL(publicDark.photo);
 assert.equal(photoUrl.searchParams.get('v'),imageVersion);
 const downloaded=await call('memberPhoto',{who:null,params:Object.fromEntries(photoUrl.searchParams)});
 assert.equal(downloaded.status,200);
 assert.equal(downloaded.response.headers.get('content-type'),'image/webp');
 assert.equal((await sharp(downloaded.data).metadata()).width,12);
});

test('an admin save supersedes only its field and preserves unrelated member reviews and credits',async()=>{
 const {store}=await fixture();
 const original=await store.get('members/'+actor);
 const livePhoto='https://example.invalid/approved-headshot.jpg';
 const approved={bio:'The original public biography.',photo:livePhoto};
 const proposedCredits={[lies]:{character:'A proposed character',crewTitle:''}};
 await store.setJSON('members/'+actor,{...original,approvedProfiles:{[dark]:approved,[lies]:approved},proposedCredits});
 const draftPhoto=await sharp({create:{width:12,height:16,channels:3,background:'#aaccff'}}).png().toBuffer();
 const draft=new FormData();
 draft.set('bio','The member’s unpublished biography.');
 draft.set('file',new Blob([draftPhoto],{type:'image/png'}),'Member draft.png');
 assert.equal((await call('memberProfile',{who:'member',body:draft})).status,200);
 const publicProfile=async production=>(await call('published',{who:null,production})).data.find(item=>item.name===original.name);
 assert.equal((await publicProfile(dark)).bio,approved.bio);
 assert.equal((await publicProfile(lies)).photo,livePhoto);

 assert.equal((await call('bio',{body:{bio:'The administrator’s biography.'}})).status,200);
 const withAdminBio=await store.get('members/'+actor);
 assert.equal(withAdminBio.draftProfile.imageVersion,digest(draftPhoto));
 assert.deepEqual(Object.keys(withAdminBio.productionRequests).sort(),[dark,lies].sort(),'The member’s photo still needs review in both films.');
 assert.equal((await publicProfile(dark)).bio,'The administrator’s biography.');
 assert.equal((await publicProfile(dark)).photo,livePhoto);
 assert.equal((await publicProfile(lies)).photo,livePhoto);

 const adminPhoto=await sharp({create:{width:12,height:16,channels:3,background:'#eeeaaa'}}).png().toBuffer();
 assert.equal((await call('photo',{body:new Blob([adminPhoto],{type:'image/png'})})).status,200);
 const saved=await store.get('members/'+actor);
 assert.equal(saved.draftProfile.imageVersion,digest(adminPhoto));
 assert.deepEqual(Object.keys(saved.productionRequests),[lies],'Only the outstanding credit proposal still needs review.');
 assert.deepEqual(saved.proposedCredits,proposedCredits);
 assert.deepEqual(saved.productions,original.productions);
 assert.equal((await publicProfile(lies)).role,original.productions[lies].role);
 assert.ok((await publicProfile(dark)).photo.endsWith('v='+digest(adminPhoto)));
});

test('admin saves respect hidden films and do not publish to unassigned films',async()=>{
 const {store}=await fixture();
 const original=await store.get('members/'+other);
 await store.setJSON('members/'+other,{...original,generalInvite:true,publication:{[lies]:false}});
 const emptySave=await call('bio',{id:other,body:{bio:''}});
 assert.deepEqual(emptySave.data.publishedProductions,[]);
 assert.equal((await call('published',{who:null,production:dark})).data.some(item=>item.name===original.name),false);
 const options={id:other,body:{bio:'First production biography.'}};
 const hiddenSave=await call('bio',options);
 assert.equal(hiddenSave.status,200);
 assert.deepEqual(hiddenSave.data.publishedProductions,[dark]);
 const publicProfile=async production=>(await call('published',{who:null,production})).data.find(item=>item.name===original.name);
 assert.equal((await publicProfile(dark)).bio,options.body.bio);
 assert.equal(await publicProfile(lies),undefined);
 assert.equal((await store.get('members/'+other)).publication[lies],false);

 const assigned=await store.get('members/'+other);
 await store.setJSON('members/'+other,{...assigned,productions:{[dark]:original.productions[dark]},approvedProfiles:{[dark]:assigned.approvedProfiles[dark]}});
 const unassignedSave=await call('bio',{id:other,production:lies,body:{bio:'Saved for the assigned film only.'}});
 assert.equal(unassignedSave.status,200);
 assert.deepEqual(unassignedSave.data.publishedProductions,[dark]);
 assert.equal((await publicProfile(dark)).bio,'Saved for the assigned film only.');
 assert.equal(await publicProfile(lies),undefined);
 assert.equal((await store.get('members/'+other)).approvedProfiles[lies],undefined);
});

test('only administrators can change an active assigned member document requirement',async()=>{
 const context=await fixture();
 assert.equal((await row()).paperworkStatus,'No agreement on file','Historical hard-copy waivers do not satisfy this signing round.');
 for(const options of [{who:null},{who:'member'},{who:'Nick',origin:'https://other.invalid'}]){
  const result=await call('trackPaperwork',{body:{document:'agreement',reason:'complete'},...options});
  assert.ok([401,403].includes(result.status));
 }
 assert.equal((await call('trackPaperwork',{body:{document:'agreement',reason:'bogus'}})).status,400);
 await context.store.setJSON('members/'+other,{...await context.store.get('members/'+other),revoked:true});
 assert.ok((await call('trackPaperwork',{id:other,body:{document:'agreement',reason:'complete'}})).status>=400);
 const member=await context.store.get('members/'+actor);delete member.productions[lies];await context.store.setJSON('members/'+actor,member);
 assert.equal((await call('trackPaperwork',{production:lies,body:{document:'agreement',reason:'complete'}})).status,403);
 assert.equal(context.calls.length,0);assert.equal(context.notifications.length,0);
});

test('agreement overrides belong only to the current signing round and support the existing hard-copy choice',async()=>{
 const context=await fixture();
 await context.store.setJSON(trackingKey(dark,actor),{document:'agreement',agreementCycle:'previous-round',reason:'not-required',by:'Nick',at:1});
 assert.equal((await row()).paperworkStatus,'No agreement on file','A stale round record cannot waive the new requirement.');
 assert.equal((await call('trackPaperwork',{who:'Heidi',body:{reason:'hard-copy'}})).status,200,'Omitted document means the current agreement requirement.');
 const saved=await context.store.get(trackingKey(dark,actor));
 assert.equal(saved.agreementCycle,AGREEMENT_CYCLE);assert.equal(saved.reason,'complete');assert.equal(saved.by,'Heidi');
 assert.equal((await row()).paperworkStatus,'Complete');
 assert.equal(context.calls.length,0);assert.equal(context.notifications.length,0);
});

test('manual agreement completion and N/A are reversible, scoped, and never signatures',async()=>{
 const context=await fixture(),agreement=await setAgreement(context);
 const result=await call('trackPaperwork',{body:{document:'agreement',reason:'complete'}});assert.equal(result.status,200);
 let member=await row();assert.equal(member.paperworkStatus,'Complete');assert.equal(member.paperworkTracking.reason,'complete');
 assert.equal(member.agreement.status,'Waiting on actor');
 assert.deepEqual(await context.store.get(currentAgreementKey(dark,actor)),agreement,'A manual decision does not alter provider signing state.');
 assert.equal((await row(lies)).paperworkStatus,'No agreement on file');
 assert.equal((await row(dark,'Nick',other)).paperworkStatus,'No agreement on file');
 assert.equal(context.calls.length,0);assert.equal(context.notifications.length,0,'Manual tracking sends no notifications.');
 assert.ok(!(await adminActions(context.store,dark)).some(action=>action.member===actor),'Manual completion clears only the agreement follow-up.');
 member=await row(dark,'member');assert.equal(member.paperworkStatus,'Complete');assert.ok(!member.documents.some(document=>document.kind==='signed'),'Manual completion must not invent a signed PDF.');
 assert.equal((await call('memberDocument',{who:'member',params:{kind:'signed'}})).status,404);
 assert.deepEqual(Buffer.from(await context.store.get('offline/'+profile.id)),originalPdf);
 assert.equal((await call('trackPaperwork',{who:'Heidi',body:{document:'agreement',reason:'not-required'}})).status,200);
 member=await row();assert.equal(member.paperworkStatus,'Document N/A');assert.equal(member.paperworkTracking.reason,'not-required');
 assert.equal((await call('trackPaperwork',{body:{document:'agreement',reason:'reopen'}})).status,200);
 assert.equal(await context.store.get(trackingKey(dark,actor)),null);
 assert.equal((await row()).paperworkStatus,'Waiting on actor');
 await context.store.delete(currentAgreementKey(dark,actor));
 assert.ok((await adminActions(context.store,dark)).some(action=>action.member===actor),'Reopening an unsent requirement restores the preparation action.');
});

test('resource tracking separates Complete and Document N/A for each person and production',async()=>{
 const context=await fixture();
 assert.equal((await call('trackPaperwork',{body:{document:pdfId,reason:'complete'}})).status,200);
 const adminRow=await row(),memberRow=await row(dark,'member');
 assert.equal(adminRow.documentTracking[pdfId],'complete');
 assert.equal(adminRow.documentTrackingDetails[pdfId].by,'Nick');
 assert.ok(Number.isFinite(adminRow.documentTrackingDetails[pdfId].at));
 assert.equal(memberRow.documentTracking[pdfId],'complete','Members see the same resource disposition.');
 assert.equal(memberRow.documentTrackingDetails,undefined,'Members do not receive internal override audit details.');
 assert.equal((await row(dark,'Nick',other)).documentTracking[pdfId],undefined);
 assert.equal((await row(lies)).documentTracking[pdfId],undefined);
 assert.equal((await call('trackPaperwork',{body:{document:privatePdfId,reason:'complete'}})).status,404,'An admin cannot attach someone else’s resource to this person.');
 assert.equal((await call('trackPaperwork',{production:lies,body:{document:pdfId,reason:'complete'}})).status,404);
 assert.equal((await call('trackPaperwork',{body:{document:pdfId,reason:'not-required'}})).status,200);
 assert.equal((await row()).documentTracking[pdfId],'not-required');
 assert.equal((await call('trackPaperwork',{body:{document:pdfId,reason:'reopen'}})).status,200);
 assert.equal((await row()).documentTracking[pdfId],undefined);
 assert.deepEqual(Buffer.from(await context.store.get('files/'+pdfId)),resourcePdf,'Tracking must preserve the original PDF bytes.');
 assert.equal(context.calls.length,0);assert.equal(context.notifications.length,0);
});

test('manual disposition survives provider refresh and suppresses obsolete countersign follow-up',async()=>{
 const context=await fixture();await setAgreement(context,{status:'Waiting on Heidi'});
 context.documents.get('active-doc').recipients[0].status='signed';
 assert.equal((await call('trackPaperwork',{body:{document:'agreement',reason:'complete'}})).status,200);
 const callsBefore=context.calls.length;await checkSigningNotices(context.store);
 assert.equal(context.calls.length,callsBefore,'A manually satisfied requirement needs no unattended provider poll.');
 assert.equal([...context.store.records.keys()].filter(key=>key.startsWith('outbox/')).length,0,'No Heidi signature notice should be queued for a manually satisfied requirement.');
 await refreshAgreement(context.store,currentAgreementKey(dark,actor),true);
 assert.equal((await context.store.get(currentAgreementKey(dark,actor))).status,'Waiting on Heidi');
 assert.equal((await row()).paperworkStatus,'Complete','Provider polling cannot overwrite the manual portal disposition.');
 const active=(await adminActions(context.store,dark)).find(action=>action.member===actor&&action.signature);
 assert.equal(active?.owner,'any','Both admins can still find the active countersignature.');
 assert.equal(active?.suppressNotice,true,'An override still suppresses the automatic notice.');
 assert.equal((await call('trackPaperwork',{body:{document:'agreement',reason:'reopen'}})).status,200);
 assert.equal((await adminActions(context.store,dark)).find(action=>action.member===actor&&action.signature)?.suppressNotice,undefined);
});

test('a queued portal notice is suppressed when its document requirement is completed before delivery',async()=>{
 const context=await fixture();
 process.env.RESEND_API_KEY='test-only-mail-key';process.env.HMF_MAIL_FROM='test@example.invalid';
 const member=await context.store.get('members/'+actor);
 await enqueue(context.store,member,'queued-before-override','Agreement ready for your signature','A test notice.',0,{agreementCycle:AGREEMENT_CYCLE,requirementKey:trackingKey(dark,actor)});
 assert.equal([...context.store.records.keys()].filter(key=>key.startsWith('outbox/')).length,1);
 assert.equal((await call('trackPaperwork',{body:{document:'agreement',reason:'complete'}})).status,200);
 await deliver(context.store);
 assert.equal([...context.store.records.keys()].filter(key=>key.startsWith('outbox/')).length,0);
 assert.ok([...context.store.records.values()].some(record=>record.value?.status==='Not sent — document requirement completed'));
 assert.equal(context.calls.length,0,'No provider or email request may leave the suppressed queue.');
});

test('individual admin profiles expose existing signed and uploaded documents',async()=>{
 const context=await fixture();
 const member=await row();
 assert.ok(member.documents.some(document=>document.kind==='previous-signed'));
 assert.ok(member.documents.some(document=>document.kind==='uploaded'));
 assert.deepEqual((await call('memberDocument',{params:{kind:'uploaded'}})).data,originalPdf);
 assert.equal(context.calls.length,0,'Listing historical documents does not download them from the provider.');
});

test('sending a pending draft is current-cycle admin-only and never resends a sent request',async()=>{
 const context=await fixture();
 const id='00000000-0000-4000-8000-000000000045';
 await setAgreement(context,{id,status:'Draft ready to send',providerStatus:'draft'});
 assert.equal((await call('sendAgreement',{who:'member',body:{documentId:id}})).status,403);
 assert.ok((await call('sendAgreement',{body:{documentId:'00000000-0000-4000-8000-000000000046'}})).status>=400);
 assert.equal(context.calls.length,0,'Unauthorized or stale IDs cannot reach SignWell.');
 const attempts=await Promise.all([call('sendAgreement',{body:{documentId:id}}),call('sendAgreement',{who:'Heidi',body:{documentId:id}})]);
 assert.equal(attempts.filter(result=>result.status===200).length,1,'Only one concurrent admin may send the same draft.');
 assert.ok(attempts.every(result=>[200,409].includes(result.status)));
 assert.equal(context.calls.filter(call=>call.method==='POST').length,1);
 assert.equal(context.calls.find(call=>call.method==='POST').path,'/api/v1/documents/'+id+'/send');
 assert.equal((await context.store.get(currentAgreementKey(dark,actor))).id,id,'Sending keeps the existing provider document ID.');
 assert.equal((await context.store.get(currentAgreementKey(dark,actor))).status,'Waiting on actor');
 await call('sendAgreement',{body:{documentId:id}});
 assert.equal(context.calls.filter(call=>call.method==='POST').length,1,'A repeat action must not resend a sent document.');
 assert.deepEqual(Buffer.from(await context.store.get('offline/'+profile.id)),originalPdf);
});

test('draft sending rejects mismatched identities, signed recipients, and manually satisfied requirements',async()=>{
 const id='00000000-0000-4000-8000-000000000045';
 for(const mutate of [
  document=>{document.name='Wherein Lies Continue — Rachel DeMicco · '+AGREEMENT_CYCLE;},
  document=>{document.recipients[0].email='someone-else@example.invalid';},
  document=>{document.recipients[1].email='wrong-producer@example.invalid';},
  document=>{document.recipients[0].status='signed';},
  document=>{document.status='sent';},
  document=>{document.test_mode=true;}
 ]){
  const context=await fixture();await setAgreement(context,{id,status:'Draft ready to send',providerStatus:'draft'});mutate(context.documents.get(id));
  const result=await call('sendAgreement',{body:{documentId:id}});
  assert.ok(result.status>=400&&result.status<500,'Unsafe drafts must be rejected before sending.');
  assert.equal(context.calls.filter(call=>call.method==='POST').length,0);
 }
 const context=await fixture();await setAgreement(context,{id,status:'Draft ready to send',providerStatus:'draft'});
 assert.equal((await call('trackPaperwork',{body:{document:'agreement',reason:'not-required'}})).status,200);
 const before=context.calls.length;
 assert.equal((await call('sendAgreement',{body:{documentId:id}})).status,409);
 assert.equal(context.calls.length,before,'An N/A requirement must be reopened before sending a draft.');
 assert.equal(context.notifications.length,0);
});

test('active signing access is separate from manual tracking and scoped to the designated recipient',async()=>{
 const context=await fixture();await setAgreement(context);
 const document=context.documents.get('active-doc');
 document.recipients[0].embedded_signing_url='https://www.signwell.com/sign/actor';
 document.recipients[1].embedded_signing_url='https://www.signwell.com/sign/heidi';
 const params={document:'active-doc'};
 assert.equal((await call('trackPaperwork',{body:{document:'agreement',reason:'not-required'}})).status,200);
 const member=await call('status',{who:'member',params});
 assert.equal(member.data.status,'Waiting on actor');
 assert.equal(member.data.paperworkStatus,'Document N/A');
 assert.equal(member.data.url,'https://www.signwell.com/sign/actor','An override does not hide a pending signature.');
 assert.equal((await call('status',{who:'Nick',params})).data.url,null,'Admins cannot sign as the cast or crew recipient.');
 assert.equal((await call('status',{who:'member',id:other,params})).status,403);
 document.recipients[0].status='signed';
 const nick=await call('status',{who:'Nick',params});
 assert.equal(nick.status,200);assert.equal(nick.data.status,'Waiting on Heidi');
 assert.equal(nick.data.url,'https://www.signwell.com/sign/heidi');
 assert.equal(nick.data.recipientName,'Heidi Mikac');
 assert.equal((await call('status',{who:'member',params})).data.url,null,'The member has no link once their part is signed.');
 assert.equal((await call('status',{who:'Heidi',params})).data.url,'https://www.signwell.com/sign/heidi');
 const actions=await adminActions(context.store,dark);
 assert.deepEqual(actions.filter(action=>action.signature).map(action=>action.owner),['any']);
 assert.ok((await call('home',{who:'Nick'})).data.waiting.some(action=>action.signature));
 assert.ok((await call('home',{who:'Heidi'})).data.waiting.some(action=>action.signature));
 document.recipients[1].email='wrong@example.invalid';
 const mismatched=await call('status',{who:'Nick',params});
 assert.equal(mismatched.status,409);assert.equal(mismatched.data.url,undefined);
 assert.ok(context.calls.every(call=>call.method==='GET'),'Opening a request does not modify SignWell.');
});

test('the public feed never names hidden people who have no card on a film website',async()=>{
 const context=await fixture();
 for(const id of [actor,other]){
  await context.store.setJSON('profiles/'+id,{bio:'A biography.'});
  await context.store.set('photos/'+id,Buffer.from('photo'),{metadata:{mime:'image/jpeg'}});
 }
 let feed=(await call('published',{who:null})).data;
 assert.ok(feed.some(item=>item.name==='Another Member'&&!item.hidden)&&feed.some(item=>item.id===profile.id&&!item.hidden));
 for(const id of [actor,other])assert.equal((await call('publication',{body:{visible:false},id})).status,200);
 feed=(await call('published',{who:null})).data;
 assert.ok(!JSON.stringify(feed).includes('Another Member')&&!JSON.stringify(feed).includes(other),'A portal-only person hidden from the website is absent, not listed as hidden.');
 assert.deepEqual(feed.find(item=>item.id===profile.id),{id:profile.id,name:profile.name,hidden:true},'A hidden catalog profile keeps only what the film site needs to suppress its printed card.');
 await context.store.setJSON('members/'+other,{...(await context.store.get('members/'+other)),revoked:true,keepPublic:false});
 await context.store.setJSON('public-revision','changed');
 assert.ok(!JSON.stringify((await call('published',{who:null})).data).includes('Another Member'),'Revoking access does not publish the name either.');
});

test('either admin can set independent website placement without publishing private profiles',async()=>{
 const {store}=await fixture();
 const save=({who='Nick',production=dark,id=actor,castPlacement='lead',billingOrder='2',expectedRevision=''}={})=>
  call('saveWebsitePlacement',{who,production,id,body:{castPlacement,billingOrder,expectedRevision}});
 const feed=async production=>(await call('published',{who:null,production})).data;
 const original=await store.get('members/'+actor);
 assert.equal((await save({who:'member'})).status,403);
 assert.equal((await save({billingOrder:0})).status,400);
 assert.equal((await save({castPlacement:'unrecognized'})).status,400);
 const published=(await feed(dark)).find(item=>item.id===profile.id);
 assert.equal((await save()).status,200);
 assert.deepEqual((await feed(dark)).find(item=>item.id===profile.id),{...published,castPlacement:'lead',billingOrder:2});
 const {revision}=(await row(dark,'Heidi')).websitePlacement;
 assert.equal((await save({who:'Heidi',castPlacement:'supporting'})).status,409);
 assert.equal((await save({who:'Heidi',castPlacement:'supporting',expectedRevision:revision})).status,200);
 assert.equal((await save({who:'Heidi',production:lies,castPlacement:'additional'})).status,200);
 assert.equal((await row(lies,'Nick')).websitePlacement.castPlacement,'additional');
 assert.equal((await row(dark,'Nick')).websitePlacement.castPlacement,'supporting');
 assert.equal((await save({id:other,production:lies,castPlacement:'additional'})).status,200);
 assert.ok(!(await feed(lies)).some(item=>item.id==='member-'+other),'A placement alone cannot publish a new member profile.');
 assert.deepEqual(await store.get('members/'+actor),original,'Website placement is separate from the member’s profile and credits.');
 assert.equal((await call('publication',{body:{visible:false}})).status,200);
 assert.deepEqual((await feed(dark)).find(item=>item.id===profile.id),{id:profile.id,name:profile.name,hidden:true});

 const catalog=darkCatalog.find(person=>person.id!==profile.id);
 assert.equal((await save({who:'Heidi',id:catalog.id})).status,200);
 const catalogRow=(await call('home',{who:'Nick'})).data.catalog.find(person=>person.id===catalog.id);
 assert.deepEqual((await feed(dark)).find(item=>item.id===catalog.id),{id:catalog.id,castPlacement:'lead',billingOrder:2});
 assert.equal((await save({id:catalog.id,castPlacement:'',expectedRevision:catalogRow.websitePlacement.revision})).status,200);
 assert.ok(!(await feed(dark)).some(item=>item.id===catalog.id),'Website default clears the layout override.');
});

test('downloads use the posted title and administrators can remove a posted file or message',async()=>{
 const context=await fixture();
 await context.store.setJSON('resources/'+pdfId,{...(await context.store.get('resources/'+pdfId)),title:'Call sheet · Day 3 / rev 11/08: "final"?'});
 const download=await call('resource',{who:'member',id:pdfId});
 assert.equal(download.status,200);
 const disposition=download.response.headers.get('content-disposition');
 assert.ok(disposition.startsWith('attachment; filename="Call sheet - Day 3 - rev 11-08- -final.pdf"; filename*=UTF-8\'\''),disposition);
 assert.ok(disposition.endsWith(encodeURIComponent('Call sheet · Day 3 - rev 11-08- -final.pdf')),disposition);
 await context.store.setJSON('resources/'+privatePdfId,{...(await context.store.get('resources/'+privatePdfId)),title:'../..\\\r\n'});
 await context.store.set('files/'+privatePdfId,resourcePdf);
 assert.ok((await call('resource',{who:'Nick',id:privatePdfId})).response.headers.get('content-disposition').startsWith('attachment; filename="production-document.pdf"'),'An unusable title falls back to a safe name.');

 const noteId='00000000-0000-4000-8000-000000000045';
 await context.store.setJSON('resources/'+noteId,{id:noteId,title:'Parking',text:'Side door.',type:'Update',audience:null,created:2});
 await context.store.setJSON('outbox/'+digest(actor+'/'+pdfId),{id:actor,to:'x@example.invalid',subject:'New production file'});
 await context.store.setJSON(trackingKey(dark,actor,pdfId),{document:pdfId,reason:'complete',by:'Nick',at:1});
 for(const options of [{who:null},{who:'member'},{who:'Nick',origin:'https://other.invalid'},{who:'Nick',method:'GET'}]){
  const refused=await call('removeResource',{body:options.method?undefined:{},id:pdfId,...options});
  if(!options.method)assert.ok([401,403].includes(refused.status));
  assert.ok(await context.store.get('files/'+pdfId)&&await context.store.get('resources/'+pdfId),'Only an administrator’s own POST removes anything.');
 }
 assert.equal((await call('removeResource',{body:{},id:pdfId,production:lies})).status,404,'Another production’s workspace cannot remove it.');
 assert.equal((await call('removeResource',{body:{},id:pdfId})).status,200);
 for(const key of ['resources/'+pdfId,'files/'+pdfId,'outbox/'+digest(actor+'/'+pdfId),trackingKey(dark,actor,pdfId)])assert.equal(await context.store.get(key),null,key);
 assert.equal((await call('resource',{who:'member',id:pdfId})).status,404);
 assert.ok(!(await call('home',{who:'member'})).data.resources.some(item=>item.id===pdfId));
 assert.equal((await call('removeResource',{body:{},id:noteId})).status,200);
 assert.equal(await context.store.get('resources/'+noteId),null);
 assert.equal((await call('removeResource',{body:{},id:noteId})).status,404,'Removing twice reports that it is already gone.');
 assert.ok(await context.store.get('members/'+actor),'Removing a board item leaves people untouched.');
});
