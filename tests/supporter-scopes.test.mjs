import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {publicSupporters,supporterCampaigns,saveManualSupporter} from '../netlify/lib/supporters.mjs';

const active='e2ozh2',past='b2mXyf',pledges='f2jVO7';
const manualId='manual:11111111-1111-4111-8111-111111111111';
const campaign=(id,isActive,overrides={})=>({id,title:id===active?'Current campaign':'Past campaign',active:isActive,checkedAt:Date.now(),...overrides});
const activity=(id,campaignId,gross,overrides={})=>({id:'crowdfundr-public:'+id,source:'crowdfundr-public',campaignId,reference:'activity-'+id,processor:'',channel:'Crowdfundr public activity',
 status:'public',gross,refunded:null,name:'Scope Supporter',showName:true,showAmount:true,identity:'public-owner:verified-scope-person',date:1,hidden:false,...overrides});
const legacy=(id,campaignId,gross,overrides={})=>({id:'crowdfundr:'+id,source:'crowdfundr',campaignId,reference:'transaction-'+id,processor:'paypal',channel:'Crowdfundr',
 status:'paid',gross,refunded:null,name:'Scope Supporter',showName:true,showAmount:true,identity:'email:verified-scope-person',date:1,hidden:false,...overrides});
const blank=()=>({sales:{},supporterLedger:{transactions:{},moderation:{}}});
function feed(state,rows,metadata=[campaign(active,true),campaign(past,false),campaign(pledges,false)]){
 state.supporterLedger.publicFeed={enabled:true,checkedAt:Date.now(),rows:Object.fromEntries(rows.map(row=>[row.id,row])),campaigns:metadata};return state;
}
function manual(state,overrides={}){
 saveManualSupporter(state,{id:manualId,name:'Scope Supporter',gross:2500,refunded:null,status:'paid',showName:true,showAmount:true,hidden:false,channel:'Cash',reference:'manual-scope-reference',processor:'',...overrides});
}
const current=state=>publicSupporters(state,{scope:'current'});
const lifetime=state=>publicSupporters(state,{scope:'lifetime'});

test('current credits contain active Crowdfundr only; lifetime combines history, paid merchandise and visible manual support',()=>{
 const state=feed(blank(),[activity('current',active,10000),activity('past',past,5000)]);
 manual(state);
 manual(state,{id:'manual:22222222-2222-4222-8222-222222222222',gross:200000,hidden:true});
 state.sales.ORDER={status:'paid',channel:'PayPal checkout',subtotal:4000,total:4500,shipping:500,paidAt:2,recognition:{public:true,name:'Scope Supporter',showAmount:true}};
 const original=structuredClone(state);
 assert.deepEqual(current(state),[{name:'Scope Supporter',amount:10000,currency:'USD'}]);
 assert.deepEqual(lifetime(state),[{name:'Scope Supporter',amount:21500,currency:'USD'}]);
 assert.deepEqual(publicSupporters(state),lifetime(state),'Default behavior remains lifetime.');
 assert.deepEqual(state,original,'Display scopes never rewrite payment records or the hidden manual payment.');
});

test('current membership supports multiple active campaigns or none without changing lifetime amounts',()=>{
 const state=feed(blank(),[activity('current',active,10000),activity('past',past,5000)]);
 state.supporterLedger.publicFeed.campaigns.find(row=>row.id===past).active=true;
 assert.equal(current(state)[0].amount,15000);assert.equal(lifetime(state)[0].amount,15000);
 for(const row of state.supporterLedger.publicFeed.campaigns)row.active=false;
 assert.deepEqual(current(state),[]);assert.equal(lifetime(state)[0].amount,15000);
});

test('CSV and API legacy recognition works without public mode and assigns missing legacy campaign IDs only to the original current campaign',()=>{
 const state=blank(),first=legacy('current',undefined,10000),second=legacy('past',past,5000);
 state.supporterLedger.transactions={[first.id]:first,[second.id]:second};
 assert.equal(current(state)[0].amount,10000);assert.equal(lifetime(state)[0].amount,15000);
 state.supporterLedger.apiRecords={[first.id]:{...first,gross:12000}};
 assert.equal(current(state)[0].amount,12000);assert.equal(lifetime(state)[0].amount,17000);
 assert.equal(Object.values(state.supporterLedger.transactions)[0].gross,10000,'API overlay does not alter the imported audit record.');
});

test('processor-reference deduplication retains current membership when its canonical record is a website purchase',()=>{
 const state=blank(),copy=legacy('copy',active,10000,{reference:'SHARED-CAPTURE'});
 state.supporterLedger.transactions[copy.id]=copy;
 state.sales.ORDER={status:'paid',channel:'PayPal checkout',captureId:'SHARED-CAPTURE',subtotal:10000,total:10500,shipping:500,paidAt:2,recognition:{public:true,name:'Scope Supporter',showAmount:true}};
 assert.deepEqual(current(state),[{name:'Scope Supporter',amount:10000,currency:'USD'}]);
 assert.deepEqual(lifetime(state),current(state),'The same processor payment is credited once, including in lifetime scope.');
});

test('an excluded or private cross-channel copy cannot be bypassed using the current campaign scope',async t=>{
 for(const [label,changes,expected] of [
  ['private amount',{recognition:{public:true,name:'Scope Supporter',showAmount:false}},[{name:'Scope Supporter',amount:null,currency:'USD'}]],
  ['private name',{recognition:{public:false,name:'Must remain private',showAmount:true}},[{name:'Anonymous',amount:10000,currency:'USD'}]],
  ['hidden original',{supporterHidden:true},[]],['refunded original',{status:'refunded'},[]],['unverified original',{status:'pending'},[]]
 ])await t.test(label,()=>{
  const state=blank(),copy=legacy('copy',active,10000,{reference:'SHARED-CAPTURE'});
  state.supporterLedger.transactions[copy.id]=copy;
  state.sales.ORDER={status:'paid',channel:'PayPal checkout',captureId:'SHARED-CAPTURE',subtotal:10000,total:10500,shipping:500,paidAt:2,
   recognition:{public:true,name:'Scope Supporter',showAmount:true},...changes};
  assert.deepEqual(current(state),expected);assert.deepEqual(lifetime(state),expected);
  assert.ok(!JSON.stringify(current(state)).includes('Must remain private'));
 });
});

test('privacy is independent between scopes for separate payments, while mixed lifetime amounts stay private',()=>{
 const state=feed(blank(),[activity('current',active,10000),activity('past',past,0,{showAmount:false})]);
 assert.equal(current(state)[0].amount,10000);assert.equal(lifetime(state)[0].amount,null);
 state.supporterLedger.publicFeed.rows['crowdfundr-public:past']={...activity('past',past,5000),showName:false,name:'Private source name'};
 assert.deepEqual(current(state),[{name:'Scope Supporter',amount:10000,currency:'USD'}]);
 assert.deepEqual(lifetime(state).map(row=>[row.name,row.amount]).sort(),[['Anonymous',5000],['Scope Supporter',10000]].sort());
 assert.ok(!JSON.stringify(lifetime(state)).includes('Private source name'));
});

test('per-campaign freshness withholds only the stale source and never revives its imported private snapshot',()=>{
 const state=feed(blank(),[activity('current',active,10000),activity('past',past,5000)],
  [campaign(active,true),campaign(past,false,{checkedAt:Date.now()-1200001})]);
 const copy=legacy('stale-copy',past,5000,{name:'Stale imported name'});state.supporterLedger.transactions[copy.id]=copy;
 manual(state);
 assert.equal(current(state)[0].amount,10000);assert.equal(lifetime(state)[0].amount,12500);
 assert.ok(!JSON.stringify(lifetime(state)).includes('Stale imported name'));
 state.supporterLedger.publicFeed.campaigns.find(row=>row.id===active).checkedAt=Date.now()-1200001;
 assert.deepEqual(current(state),[]);assert.deepEqual(lifetime(state),[{name:'Scope Supporter',amount:2500,currency:'USD'}]);
});

test('a missing source timestamp cannot inherit freshness from another campaign or the parent snapshot',()=>{
 const state=feed(blank(),[activity('current',active,10000),activity('past',past,5000)],
  [campaign(active,true),campaign(past,false,{checkedAt:null})]);
 assert.equal(lifetime(state)[0].amount,10000);
 state.supporterLedger.publicFeed.rows['crowdfundr-public:unknown']=activity('unknown','Other123',9000);
 assert.equal(lifetime(state)[0].amount,10000,'An unregistered public source is withheld.');
});

test('failed and preapproved historical campaign transactions remain excluded from both scopes',()=>{
 const state=blank();
 for(const [index,status] of ['pending','failed','refunded','partially refunded'].entries()){
  const row=legacy('excluded-'+index,pledges,10000,{status});state.supporterLedger.transactions[row.id]=row;
 }
 assert.deepEqual(current(state),[]);assert.deepEqual(lifetime(state),[]);
});

test('verified public owners aggregate across campaigns while conflicting same-provider profiles remain separate',()=>{
 const state=feed(blank(),[activity('current',active,10000),activity('past',past,5000),activity('other-person',past,7000,{identity:'public-owner:different-person'})]);
 assert.deepEqual(current(state),[{name:'Scope Supporter',amount:10000,currency:'USD'}]);
 assert.deepEqual(lifetime(state).map(row=>row.amount).sort((a,b)=>a-b),[7000,15000]);
});

test('campaign metadata contains only public whitelisted fields and invalid scopes fail explicitly',()=>{
 const state=feed(blank(),[],[campaign(active,true,{privateEmail:'secret@example.invalid',accessToken:'PRIVATE-TOKEN',lastError:'PRIVATE-ERROR',count:1})]);
 assert.deepEqual(supporterCampaigns(state),[{id:active,title:'Current campaign',active:true}]);
 const encoded=JSON.stringify(supporterCampaigns(state));for(const secret of ['secret@example.invalid','PRIVATE-TOKEN','PRIVATE-ERROR','checkedAt','count'])assert.ok(!encoded.includes(secret));
 for(const scope of ['all','unknown','',null])assert.throws(()=>publicSupporters(state,{scope}),{status:400});
});

const merchFile=new URL('../netlify/functions/merch.mjs',import.meta.url);
let source=await readFile(merchFile,'utf8');
assert.ok(source.includes('dollars,merchStore,orderItems'));
source='const merchStore=()=>globalThis.__supporterScopeApiStore;\n'+source.replace('dollars,merchStore,orderItems','dollars,orderItems');
source=source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_match,_quote,path)=>'from '+JSON.stringify(new URL(path,merchFile).href));
const {default:merch}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
function apiStore(state){
 let version=0;const data=new Map([['shop',{data:{...structuredClone(state),openingInventorySet:true},etag:String(++version)}]]);
 return {async getWithMetadata(key){return structuredClone(data.get(key));},async setJSON(key,value,options={}){
  const old=data.get(key);if(options.onlyIfNew&&old||options.onlyIfMatch&&old?.etag!==options.onlyIfMatch)return {modified:false};
  data.set(key,{data:structuredClone(value),etag:String(++version)});return {modified:true};
 }};
}
test('the public supporters API serves each scope and safe campaign metadata without payment or admin details',async()=>{
 const state=feed(blank(),[activity('current',active,10000),activity('past',past,5000)]);manual(state,{gross:200000,hidden:true});
 globalThis.__supporterScopeApiStore=apiStore(state);
 for(const [scope,expected] of [['current',10000],['lifetime',15000]]){
  const response=await merch(new Request('https://heidimikacfilms.com/.netlify/functions/merch?action=supporters&scope='+scope));
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const data=await response.json();assert.equal(data.supporters[0].amount,expected);assert.deepEqual(Object.keys(data).sort(),['campaigns','supporters']);
  for(const row of data.supporters)assert.deepEqual(Object.keys(row).sort(),['amount','currency','name']);
  const encoded=JSON.stringify(data);for(const secret of ['200000','manual-scope-reference','moderationRevision','verified-scope-person','activity-current','transactions','publicStale'])assert.ok(!encoded.includes(secret));
 }
 const bad=await merch(new Request('https://heidimikacfilms.com/.netlify/functions/merch?action=supporters&scope=unknown'));
 assert.equal(bad.status,400);assert.deepEqual(Object.keys(await bad.json()),['error']);
});
