import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {scryptSync} from 'node:crypto';
import {test} from 'node:test';

// The real login route against isolated storage. No network, no email.
const portalFile=new URL('../netlify/functions/portal.mjs',import.meta.url);
let source=await readFile(portalFile,'utf8');
for(const [before,after] of [
 ["import {begin as beginCalendar,events as calendarEvents} from './calendar-callback.mjs';",'const beginCalendar=()=>{},calendarEvents=()=>{};'],
 ["import sharp from 'sharp';",'const sharp=()=>{throw Error("Unexpected image operation");};'],
 ["import { getStore } from '@netlify/blobs';",'const getStore=()=>globalThis.__loginFixture;'],
 ["import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';",'const PDFDocument={},StandardFonts={},rgb=()=>{};']
]){assert.ok(source.includes(before),'Route mock must match the current implementation.');source=source.replace(before,after);}
source=source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_m,_q,path)=>'from '+JSON.stringify(new URL(path,portalFile).href));
const {default:handle}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

const member='00000000-0000-4000-8000-000000000051',password='correct horse battery';
process.env.HMF_HEIDI_LOGIN_SHA256='heidi-digest';
function fixture(){
 const data=new Map();let revision=0;
 const store={data,
  async get(k){return data.get(k)?.value??null;},
  async getMetadata(k){return data.has(k)?{metadata:{}}:null;},
  async getWithMetadata(k){const r=data.get(k);return r?{data:structuredClone(r.value),etag:r.etag,metadata:{}}:null;},
  async setJSON(k,v,o={}){const old=data.get(k);if(o.onlyIfNew&&old||o.onlyIfMatch&&old?.etag!==o.onlyIfMatch)return {modified:false};data.set(k,{value:structuredClone(v),etag:String(++revision)});return {modified:true};},
  async set(k,v,o){return this.setJSON(k,v,o);},
  async delete(k){data.delete(k);},
  list({prefix,paginate}){const page={blobs:[...data.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))};return paginate?(async function*(){yield page;})():Promise.resolve(page);}
 };
 const hashed=()=>({salt:'salt',digest:scryptSync(password,'salt',64).toString('hex')});
 data.set('members/'+member,{value:{id:member,name:'Sample Actor',email:'actor@example.invalid',productions:{}},etag:'m'});
 data.set('passwords/'+member,{value:hashed(),etag:'p'});
 data.set('passwords/Heidi',{value:{...hashed(),adminDigest:'heidi-digest'},etag:'h'});
 globalThis.__loginFixture=store;return store;
}
async function login(username,pass,ip){
 const url='https://heidimikacfilms.com/.netlify/functions/portal?action=passwordLogin';
 return (await handle(new Request(url,{method:'POST',headers:{origin:'https://heidimikacfilms.com','content-type':'application/json'},body:JSON.stringify({username,password:pass})}),{ip})).status;
}

test('bad guesses from one address lock out only that address',async()=>{
 fixture();
 for(let n=0;n<20;n++)assert.equal(await login('Heidi','wrong guess '+n,'203.0.113.9'),401);
 assert.equal(await login('Heidi','wrong again','203.0.113.9'),429,'The guessing address is stopped.');
 assert.equal(await login('heidi@heidimikacfilms.com',password,'203.0.113.9'),429,'Switching to the email form of the name does not reset it.');
 assert.equal(await login('Heidi',password,'198.51.100.7'),200,'Heidi signs in normally from her own address.');
 assert.equal(await login('actor@example.invalid',password,'203.0.113.9'),200,'Other accounts are unaffected.');
});

test('successful sign-ins are not counted, and typos are forgiven once the password is right',async()=>{
 const store=fixture();
 for(let n=0;n<30;n++)assert.equal(await login('actor@example.invalid',password,'198.51.100.7'),200);
 for(let n=0;n<19;n++)assert.equal(await login('actor@example.invalid','typo','198.51.100.7'),401);
 assert.equal(await login('actor@example.invalid',password,'198.51.100.7'),200);
 for(let n=0;n<19;n++)assert.equal(await login('actor@example.invalid','typo','198.51.100.7'),401);
 assert.equal(await login('actor@example.invalid',password,'198.51.100.7'),200);
 assert.ok([...store.data.keys()].some(k=>k.startsWith('sessions/')));
});

test('a per-account ceiling still slows guessing spread across many addresses',async()=>{
 fixture();
 for(let n=0;n<200;n++)assert.equal(await login('Heidi','wrong','10.0.'+Math.floor(n/15)+'.'+(n%15)),401);
 assert.equal(await login('Heidi','wrong','10.9.9.9'),429);
});
