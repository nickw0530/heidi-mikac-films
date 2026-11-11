import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const portalFile=new URL('../netlify/functions/portal.mjs',import.meta.url);
const records=new Map(), metadata=new Map();
const mockStore={
 async get(k,o){return records.get(k)??null;},
 async getMetadata(k){return records.has(k)?{metadata:metadata.get(k)||{}}:null;},
 async getWithMetadata(k){return records.has(k)?{data:records.get(k),metadata:metadata.get(k)||{},etag:'1'}:null;},
 list({prefix,paginate}){
  const page={blobs:[...records.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))};
  return paginate?(async function*(){yield page;})():Promise.resolve(page);
 },
 async setJSON(k,v,opts){if(opts?.onlyIfNew&&records.has(k))return {modified:false};records.set(k,structuredClone(v));return {modified:true};},
 async set(k,v,opts){records.set(k,v);metadata.set(k,opts?.metadata||{});return {modified:true};},
 async delete(k){records.delete(k);metadata.delete(k);}
};
globalThis.__store=mockStore;
let source=await fs.readFile(portalFile,'utf8');
source=source.replace("import {begin as beginCalendar,events as calendarEvents} from './calendar-callback.mjs';",'const beginCalendar=()=>{},calendarEvents=()=>{};')
 .replace("import { getStore } from '@netlify/blobs';",'const getStore=()=>globalThis.__store;')
 .replace("import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';",'const PDFDocument={},StandardFonts={},rgb=()=>{};')
 .replace("import {enqueue, mailReady, portalUrl} from '../lib/mail.mjs';","const enqueue=async()=>{},mailReady=()=>true,portalUrl='https://heidimikacfilms.com/members/';");
source=source.replace("import sharp from 'sharp';",'const sharp=()=>{throw Error("Unexpected image operation");};')
 .replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_match,_quote,path)=>'from '+JSON.stringify(new URL(path,portalFile).href));
export const {default:handle}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const adminKey='a'.repeat(64),memberKey='b'.repeat(64),secondKey='c'.repeat(64);
const harpa='00000000-0000-4000-8000-000000000001',second='00000000-0000-4000-8000-000000000002',test='00000000-0000-4000-8000-000000000003';
process.env.HMF_NICK_LOGIN_SHA256='admin-digest';
const digest=s=>createHash('sha256').update(s).digest('hex');
for(const [key,id,admin] of [[adminKey,'Nick',true],[memberKey,harpa,false],[secondKey,second,false]])records.set('sessions/'+digest(key),{id,admin,adminDigest:admin?'admin-digest':null,expires:Date.now()+60000});
records.set('members/'+harpa,{id:harpa,name:'Harpa',email:'test@example.com',role:'Mommy Dearest'});
records.set('members/'+second,{id:second,name:'Second',email:'second@example.com',role:'Other'});
records.set('members/'+test,{id:test,name:'Test Testersen',email:'practice@example.com',role:'Practice'});
for(const id of [harpa,test]){records.set('profiles/'+id,{bio:'Shared biography'});records.set('photos/'+id,Buffer.from('photo'));metadata.set('photos/'+id,{mime:'image/jpeg'});}
records.set('resources/old',{id:'old',title:'Dark only',audience:null});
records.set('tasks/'+harpa+'/old-task',{id:'old-task',title:'Dark task'});
async function call(action,body,key=adminKey,prod='written-in-the-dark',id=''){
 const u=new URL('https://heidimikacfilms.com/.netlify/functions/portal');u.search=new URLSearchParams({action,...(prod?{production:prod}:{}),id});
 const req=new Request(u,{method:body===undefined?'GET':'POST',headers:{origin:u.origin,'content-type':'application/json',...(key?{cookie:'__Host-hmf='+key}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 const response=await handle(req);const data=await response.json().catch(()=>null);return {status:response.status,data};
}
let r=await call('published',undefined,null);assert.equal(r.status,200);assert(r.data.some(x=>x.name==='Harpa'));assert(!r.data.some(x=>x.name?.includes('Test')));assert(!JSON.stringify(r.data).includes('test@example.com'));
r=await call('home',undefined,memberKey);assert.equal(r.data.members[0].tasks[0].title,'Dark task');
r=await call('home',undefined,memberKey,'wherein-lies-continue');assert.equal(r.status,403);
r=await call('enrollments',{productions:['written-in-the-dark','wherein-lies-continue'],roles:{'written-in-the-dark':'Mommy Dearest','wherein-lies-continue':'Guest'}},adminKey,'written-in-the-dark',harpa);assert.equal(r.status,200);
r=await call('home',undefined,memberKey,'wherein-lies-continue');assert.equal(r.status,200);assert.equal(r.data.members[0].role,'Guest');assert.equal(r.data.members[0].tasks.length,0);assert.equal(r.data.resources.length,0);
r=await call('notice',{audience:'all',title:'WLC only',text:'Private WLC'},adminKey,'wherein-lies-continue');assert.equal(r.status,200);assert([...records.keys()].some(k=>k.startsWith('productions/wherein-lies-continue/resources/')));
r=await call('home',undefined,secondKey,'wherein-lies-continue');assert.equal(r.status,403);
r=await call('bio',{bio:'Updated shared bio'},memberKey,'wherein-lies-continue',harpa);assert.equal(r.status,200);
const one=await call('published',undefined,null),two=await call('published',undefined,null,'wherein-lies-continue');
assert.equal(one.data.find(x=>x.name==='Harpa').bio,two.data.find(x=>x.name==='Harpa').bio);assert.equal(one.data.find(x=>x.name==='Harpa').photo,two.data.find(x=>x.name==='Harpa').photo);
r=await call('enrollments',{productions:[],roles:{}},memberKey,'written-in-the-dark',harpa);assert.equal(r.status,403);
r=await call('enrollments',{productions:['wherein-lies-continue'],roles:{'wherein-lies-continue':'Guest'}},adminKey,'written-in-the-dark',harpa);assert.equal(r.status,200);
r=await call('published',undefined,null);assert(!r.data.some(x=>x.name==='Harpa'&&!x.hidden));
r=await call('home',undefined,memberKey,'');assert.equal(r.data.productionId,'wherein-lies-continue');
r=await call('home',undefined,memberKey,'written-in-the-dark');assert.equal(r.status,403);
r=await call('revoke',{},adminKey,'wherein-lies-continue',harpa);assert.equal(r.status,200);
r=await call('published',undefined,null,'wherein-lies-continue');assert(!r.data.some(x=>x.name==='Harpa'&&!x.hidden));
r=await call('memberPhoto',undefined,null,'written-in-the-dark',harpa);assert.equal(r.status,404);
r=await call('home',undefined,memberKey,'wherein-lies-continue');assert.equal(r.status,401);
console.log('PASS: legacy data, shared profile sync, new public cards, test exclusions, production isolation, assignment permissions, default workspace, unassignment and revocation. No external requests or emails.');
