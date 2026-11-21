import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const portalFile=new URL('../netlify/functions/portal.mjs',import.meta.url);
let source=await readFile(portalFile,'utf8');
for(const [before,after] of [
 ["import {begin as beginCalendar,events as calendarEvents} from './calendar-callback.mjs';",'const beginCalendar=()=>{},calendarEvents=()=>{};'],
 ["import sharp from 'sharp';",'const sharp=()=>{throw Error("Unexpected image operation");};'],
 ["import { getStore } from '@netlify/blobs';",'const getStore=()=>globalThis.__crowdfundrRoutesStore;'],
 ["import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';",'const PDFDocument={},StandardFonts={},rgb=()=>{};']
]){assert.ok(source.includes(before));source=source.replace(before,after);}
source=source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_match,_quote,path)=>'from '+JSON.stringify(new URL(path,portalFile).href));
const {default:handle}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const tokens={admin:'a'.repeat(64),member:'b'.repeat(64)},member='00000000-0000-4000-8000-0000000000d1';
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
 const old=process.env.HMF_NICK_LOGIN_SHA256,oldContext=process.env.CONTEXT;process.env.HMF_NICK_LOGIN_SHA256='crowdfundr-route-admin';delete process.env.CONTEXT;
 t.after(()=>{if(old===undefined)delete process.env.HMF_NICK_LOGIN_SHA256;else process.env.HMF_NICK_LOGIN_SHA256=old;if(oldContext===undefined)delete process.env.CONTEXT;else process.env.CONTEXT=oldContext;});
 const data=new Map();let revision=0;
 const store={data,
  async get(key){return structuredClone(data.get(key)?.data??null);},
  async getWithMetadata(key){return structuredClone(data.get(key)??null);},
  async getMetadata(key){return data.has(key)?{}:null;},
  async setJSON(key,value,options={}){const old=data.get(key);if(options.onlyIfNew&&old||options.onlyIfMatch&&old?.etag!==options.onlyIfMatch)return {modified:false};data.set(key,{data:structuredClone(value),etag:String(++revision)});return {modified:true};},
  async delete(key){data.delete(key);}
 };
 globalThis.__crowdfundrRoutesStore=store;
 await store.setJSON('sessions/'+hash(tokens.admin),{id:'Nick',admin:true,adminDigest:'crowdfundr-route-admin',expires:Date.now()+3600000});
 await store.setJSON('sessions/'+hash(tokens.member),{id:member,admin:false,expires:Date.now()+3600000});
 await store.setJSON('members/'+member,{id:member,name:'Fictional Member',productions:{}});
 return store;
}
async function call(action,{who='admin',body,host='heidimikacfilms.com',origin,method}={}){
 const url='https://'+host+'/.netlify/functions/portal?action='+action;
 return handle(new Request(url,{method:method||(body===undefined?'GET':'POST'),
  headers:{origin:origin||'https://'+host,'content-type':'application/json',...(who?{cookie:'__Host-hmf='+tokens[who]}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)})}),{ip:'198.51.100.17'});
}

test('Crowdfundr connection controls require production, a current admin session and same-origin POST',async t=>{
 const store=await fixture(t);
 for(const action of ['crowdfundrSettings','crowdfundrConnect','crowdfundrSync','crowdfundrDisconnect']){
  for(const [who,status] of [[null,401],['member',403]])assert.equal((await call(action,{who,body:action==='crowdfundrSettings'?undefined:{}})).status,status);
  assert.equal((await call(action,{host:'preview.netlify.app',body:action==='crowdfundrSettings'?undefined:{}})).status,403);
  assert.equal((await call(action,{body:{},origin:'https://elsewhere.example'})).status,403);
  if(action!=='crowdfundrSettings')assert.equal((await call(action)).status,405);
 }
 const initial=await (await call('crowdfundrSettings')).json();assert.equal(initial.connected,false);assert.equal(initial.clientId,'');
 const saved=await call('crowdfundrSettings',{body:{clientId:'approved-app',revision:initial.revision}});assert.equal(saved.status,200);
 const connection=await call('crowdfundrConnect',{body:{}});assert.equal(connection.status,200);
 const consent=await connection.json();assert.equal(new URL(consent.url).searchParams.get('scope'),'read_only');
 assert.ok(connection.headers.get('set-cookie').includes('SameSite=Lax'));
 assert.equal((await call('crowdfundrConnect',{host:'www.heidimikacfilms.com',body:{}})).status,400,'The callback cookie is bound to the canonical website host.');
 process.env.CONTEXT='deploy-preview';assert.equal((await call('crowdfundrSettings')).status,403);delete process.env.CONTEXT;
 assert.equal((await call('crowdfundrDisconnect',{body:{}})).status,200);
 assert.equal(await store.get('crowdfundr/connection'),null);
});
