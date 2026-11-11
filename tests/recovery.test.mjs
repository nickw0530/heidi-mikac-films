import {handle} from './portal.test.mjs';
import assert from 'node:assert/strict';
import {createHash,scryptSync} from 'node:crypto';
const store=globalThis.__store,digest=s=>createHash('sha256').update(s).digest('hex');
const adminKey='a'.repeat(64),uid='00000000-0000-4000-8000-000000000002';
async function call(action,body,key=adminKey,prod='written-in-the-dark',id=uid){const u=new URL('https://heidimikacfilms.com/.netlify/functions/portal');u.search=new URLSearchParams({action,production:prod,id});return handle(new Request(u,{method:body===undefined?'GET':'POST',headers:{origin:u.origin,'content-type':'application/json',...(key?{cookie:'__Host-hmf='+key}:{})},body:body===undefined?undefined:JSON.stringify(body)}));}
const pass={salt:'salt',digest:scryptSync('old-password-long','salt',64).toString('hex')};
await store.setJSON('passwords/'+uid,pass);await store.setJSON('resets/'+digest('d'.repeat(64)),{id:uid,passwordDigest:pass.digest,expires:Date.now()+100000});
let r=await call('resetPassword',{ticket:'d'.repeat(64),password:'new-password-long'},null);assert.equal(r.status,200);
r=await call('home',undefined,'c'.repeat(64));assert.equal(r.status,401,'Old sessions invalidated');
r=await call('resetPassword',{ticket:'d'.repeat(64),password:'other-password-long'},null);assert.equal(r.status,400,'Reset single use');
r=await call('passwordLogin',{username:'second@example.com',password:'new-password-long'},null);assert.equal(r.status,200);assert(r.headers.get('set-cookie').includes('HttpOnly'));
// A retained public profile is independent from revoked portal access.
await store.setJSON('profiles/'+uid,{bio:'A real bio'});await store.set('photos/'+uid,Buffer.from('photo'),{metadata:{mime:'image/jpeg'}});
r=await call('revoke',{keepPublic:true});assert.equal(r.status,200);
r=await call('published',undefined,null);assert((await r.json()).some(x=>x.name==='Second'&&!x.hidden));
r=await call('publication',{visible:false});assert.equal(r.status,200);
r=await call('published',undefined,null);assert(!(await r.json()).some(x=>x.name==='Second'&&!x.hidden));
// Archived paper agreements remain visible and do not satisfy the current signing round.
const rachel='00000000-0000-4000-8000-000000000004';
await store.setJSON('members/'+rachel,{id:rachel,name:'Rachel DeMicco',role:'Megan',email:'rachel@example.com'});
r=await call('home');assert.equal(r.status,200);let state=await r.json();const row=state.members.find(x=>x.id===rachel);assert(row.filmProfile);
await store.set('offline/'+row.filmProfile,Buffer.from('pdf'),{metadata:{status:'Waiting on Heidi'}});
r=await call('home');state=await r.json();const archived=state.members.find(x=>x.id===rachel);
assert.equal(archived.previousOfflineStatus,'Waiting on Heidi');
assert.equal(archived.paperworkStatus,'No agreement on file');
assert.equal(archived.memberPaperworkStatus,'No agreement on file');
// Both productions support their own approved masters.
await store.set('productions/wherein-lies-continue/contract/master',Buffer.from('pdf'));
r=await call('home',undefined,adminKey,'wherein-lies-continue');assert.equal((await r.json()).agreementReady,true);
console.log('PASS: password reset, single use, session revocation, independent publication and paperwork consistency.');
