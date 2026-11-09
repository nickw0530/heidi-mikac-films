import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {eventWhen,eventNotice} from '../netlify/functions/calendar-callback.mjs';
import {emailHtml} from '../netlify/lib/mail.mjs';

test('calendar notices state the day, time and place in Eastern time',()=>{
 const event={subject:'Table read',isAllDay:false,start:{dateTime:'2026-11-14T19:00:00.0000000'},end:{dateTime:'2026-11-14T22:30:00.0000000'},location:{displayName:'Studio B, 12 Main St'}};
 assert.equal(eventWhen(event),'Sat, Nov 14 · 2:00 PM – 5:30 PM Eastern');
 const link='https://heidimikacfilms.com/members/?event='+'a'.repeat(43),text=eventNotice(event,link);
 assert.ok(text.startsWith('Table read\nSat, Nov 14 · 2:00 PM – 5:30 PM Eastern\nStudio B, 12 Main St\n\n'),text);
 assert.ok(emailHtml({subject:'New event on the production calendar',text}).includes('>View event</a>'));
 assert.equal(eventWhen({isAllDay:true,start:{dateTime:'2026-11-14T00:00:00.0000000'},end:{dateTime:'2026-11-15T00:00:00.0000000'}}),'Sat, Nov 14 · All day');
 assert.equal(eventWhen({isAllDay:true,start:{dateTime:'2026-11-14T00:00:00.0000000'},end:{dateTime:'2026-11-16T00:00:00.0000000'}}),'Sat, Nov 14 – Sun, Nov 15 · All day');
 assert.equal(eventWhen({isAllDay:false,start:{dateTime:'2026-11-14T23:00:00'},end:{dateTime:'2026-11-15T07:00:00'}}),'Sat, Nov 14 · 6:00 PM – Sun, Nov 15 2:00 AM Eastern','An overnight shoot names both days.');
 assert.ok(eventNotice({...event,recurrence:{},location:null},link).includes('\nRepeats. First: Sat, Nov 14'));
});

// The real recovery route against isolated storage; the mail queue is captured, never sent.
const portalFile=new URL('../netlify/functions/portal.mjs',import.meta.url);
let source=await readFile(portalFile,'utf8');
for(const [before,after] of [
 ["import {begin as beginCalendar,events as calendarEvents} from './calendar-callback.mjs';",'const beginCalendar=()=>{},calendarEvents=()=>{};'],
 ["import sharp from 'sharp';",'const sharp=()=>{throw Error("Unexpected image operation");};'],
 ["import { getStore } from '@netlify/blobs';",'const getStore=()=>globalThis.__recoveryFixture;'],
 ["import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';",'const PDFDocument={},StandardFonts={},rgb=()=>{};'],
 ["import {enqueue, mailReady, portalUrl} from '../lib/mail.mjs';",'const enqueue=async(_store,member,event,subject,text)=>{globalThis.__recoveryMail.push({to:member.email,event,subject,text});},mailReady=()=>true,portalUrl="https://heidimikacfilms.com/members/";']
]){assert.ok(source.includes(before),'Route mock must match the current implementation.');source=source.replace(before,after);}
source=source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_m,_q,path)=>'from '+JSON.stringify(new URL(path,portalFile).href));
const {default:handle}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const invited='00000000-0000-4000-8000-000000000061',revoked='00000000-0000-4000-8000-000000000062';
function fixture(){
 const data=new Map();let revision=0;
 const store={data,
  async get(k){return data.get(k)?.value??null;},
  async getMetadata(k){return data.has(k)?{metadata:{}}:null;},
  async getWithMetadata(k){const r=data.get(k);return r?{data:structuredClone(r.value),etag:r.etag,metadata:{}}:null;},
  async setJSON(k,v,o={}){const old=data.get(k);if(o.onlyIfNew&&old||o.onlyIfMatch&&old?.etag!==o.onlyIfMatch)return {modified:false};data.set(k,{value:structuredClone(v),etag:String(++revision)});return {modified:true};},
  async delete(k){data.delete(k);},
  list({prefix,paginate}){const page={blobs:[...data.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))};return paginate?(async function*(){yield page;})():Promise.resolve(page);}
 };
 data.set('members/'+invited,{value:{id:invited,name:'New Actor',email:'new@example.invalid',ticket:'expired-ticket',productions:{}},etag:'a'});
 data.set('members/'+revoked,{value:{id:revoked,name:'Gone',email:'gone@example.invalid',revoked:true,productions:{}},etag:'b'});
 globalThis.__recoveryFixture=store;globalThis.__recoveryMail=[];return store;
}
async function post(action,body){
 const url='https://heidimikacfilms.com/.netlify/functions/portal?action='+action;
 const response=await handle(new Request(url,{method:'POST',headers:{origin:'https://heidimikacfilms.com','content-type':'application/json'},body:JSON.stringify(body)}),{ip:'198.51.100.7'});
 return {status:response.status,data:await response.json()};
}

test('forgot-password sends a fresh invitation to someone who never set a password',async()=>{
 const store=fixture(),mail=globalThis.__recoveryMail;
 const answer=await post('requestReset',{username:'New@Example.invalid'});
 assert.equal(answer.status,200);
 assert.equal(mail.length,1);assert.equal(mail[0].to,'new@example.invalid');
 assert.equal(mail[0].subject,'Heidi Mikac Films — finish setting up your account');
 const ticket=mail[0].text.match(/#invite=([a-f0-9]{64})/)[1];
 assert.ok(emailHtml(mail[0]).includes('>Set up your account</a>'));
 const activated=await post('activate',{ticket,password:'a long enough password'});
 assert.equal(activated.status,200,'The emailed link really creates the account.');
 assert.ok(await store.get('passwords/'+invited));
 for(const username of ['gone@example.invalid','nobody@example.invalid']){
  const silent=await post('requestReset',{username});
  assert.deepEqual(silent.data,answer.data,'The reply never reveals whether an address has an account.');
 }
 assert.equal(mail.length,1,'Revoked and unknown addresses receive nothing.');
});
