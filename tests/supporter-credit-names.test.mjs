import test from 'node:test';
import assert from 'node:assert/strict';
import {adminSupporters,moderateSupporter,publicSupporters,saveManualSupporter} from '../netlify/lib/supporters.mjs';

const current='crowdfundr-public:current-credit-name',past='crowdfundr-public:past-credit-name';
const activity=(id,campaignId,name,identity,date)=>({id,campaignId,name,identity,date,source:'crowdfundr-public',reference:id,processor:'',channel:'Crowdfundr public activity',
 status:'public',gross:2500,refunded:null,showName:true,showAmount:true,hidden:false});
function fixture(){
 const rows=[activity(current,'e2ozh2','Original Current Name','public-owner:current-name-owner',1),activity(past,'22kyI8','Short Name','public-owner:past-name-owner',2)];
 return {sales:{},supporterLedger:{transactions:{},moderation:{},publicFeed:{enabled:true,checkedAt:Date.now(),rows:Object.fromEntries(rows.map(row=>[row.id,row])),campaigns:[
  {id:'e2ozh2',title:'Current campaign',active:true,checkedAt:Date.now()},{id:'22kyI8',title:'Past campaign',active:false,checkedAt:Date.now()}
 ]}}};
}
function review(shop,id,changes){const row=adminSupporters(shop).find(row=>row.id===id);return moderateSupporter(shop,{id,hidden:row.hidden===true,moderationRevision:row.moderationRevision,...changes});}
function matched(){const shop=fixture();review(shop,past,{sameSupporterAs:current});return shop;}
const credits=(name,amount)=>[{name,amount,currency:'USD'}];
const lifetime=shop=>publicSupporters(shop),active=shop=>publicSupporters(shop,{scope:'current'});

test('a reviewed public credit name changes the combined label after grouping, retaining source names and independent scope amounts',()=>{
 const shop=matched(),source=structuredClone(shop.supporterLedger.publicFeed.rows);
 assert.deepEqual(lifetime(shop),credits('Short Name',5000));
 review(shop,past,{displayName:'  Preferred   Full Name  '});
 assert.deepEqual(lifetime(shop),credits('Preferred Full Name',5000));assert.deepEqual(active(shop),credits('Preferred Full Name',2500));
 assert.deepEqual(shop.supporterLedger.publicFeed.rows,source,'Source names, identities, permissions and amounts remain untouched.');
 const row=adminSupporters(shop).find(row=>row.id===past);
 assert.equal(row.name,'Short Name');assert.equal(row.displayName,'Preferred Full Name');
 assert.equal('identity' in row,false);assert.equal('displayNameUpdatedAt' in row,false);
 for(const record of lifetime(shop))assert.deepEqual(Object.keys(record).sort(),['amount','currency','name']);
});

test('a preferred name survives complete feed replacement and a newer repeat payment without overriding its source name',()=>{
 const shop=matched();review(shop,past,{displayName:'Preferred Full Name'});
 const next=activity('crowdfundr-public:new-repeat-credit-name','e2ozh2','Newest Short Spelling','public-owner:past-name-owner',10);
 const feed=structuredClone(shop.supporterLedger.publicFeed);feed.rows[next.id]=next;feed.checkedAt=Date.now();for(const campaign of feed.campaigns)campaign.checkedAt=Date.now();
 shop.supporterLedger.publicFeed=feed;
 assert.deepEqual(lifetime(shop),credits('Preferred Full Name',7500));assert.deepEqual(active(shop),credits('Preferred Full Name',5000));
 assert.equal(shop.supporterLedger.publicFeed.rows[next.id].name,'Newest Short Spelling');
 review(shop,current,{hidden:true});assert.deepEqual(lifetime(shop),credits('Preferred Full Name',5000));
 assert.equal(shop.supporterLedger.moderation[past].displayName,'Preferred Full Name');
});

test('private-name payments remain individually anonymous and cannot supply an existing public name preference',()=>{
 const shop=matched();review(shop,past,{displayName:'Must Not Reveal This Preference'});
 shop.supporterLedger.publicFeed.rows[past].showName=false;
 assert.deepEqual(lifetime(shop).map(row=>[row.name,row.amount]).sort(),[['Anonymous',2500],['Original Current Name',2500]].sort());
 assert.deepEqual(active(shop),credits('Original Current Name',2500));assert.ok(!JSON.stringify(lifetime(shop)).includes('Must Not Reveal'));
 assert.throws(()=>review(shop,past,{displayName:'Another Public Name'}),{status:400});
 review(shop,past,{displayName:null});assert.equal(adminSupporters(shop).find(row=>row.id===past).displayName,null);
});

test('amount privacy alone retains an existing preferred name while withholding the named cumulative amount',()=>{
 const shop=matched();review(shop,past,{displayName:'Preferred Full Name'});
 shop.supporterLedger.publicFeed.rows[past].showAmount=false;shop.supporterLedger.publicFeed.rows[past].gross=0;
 assert.deepEqual(lifetime(shop),credits('Preferred Full Name',null));assert.deepEqual(active(shop),credits('Preferred Full Name',2500));
 assert.equal(adminSupporters(shop).find(row=>row.id===past).displayName,'Preferred Full Name');
 shop.supporterLedger.publicFeed.rows[past].showName=false;
 assert.deepEqual(lifetime(shop).map(row=>[row.name,row.amount]).sort(),[['Anonymous',null],['Original Current Name',2500]].sort());
 assert.deepEqual(active(shop),credits('Original Current Name',2500));
});

test('hidden, refunded and duplicate preference anchors cannot rename another visible credit; omitted preference survives ordinary moderation',()=>{
 for(const exclusion of ['hidden','refunded','duplicate']){
  const shop=matched();review(shop,past,{displayName:'Preferred Full Name'});
  if(exclusion==='hidden')review(shop,past,{hidden:true});
  if(exclusion==='refunded')shop.supporterLedger.publicFeed.rows[past].status='refunded';
  if(exclusion==='duplicate')review(shop,past,{duplicateOf:current});
  assert.deepEqual(lifetime(shop),credits('Original Current Name',2500));assert.deepEqual(active(shop),credits('Original Current Name',2500));
  assert.equal(shop.supporterLedger.moderation[past].displayName,'Preferred Full Name');
  assert.throws(()=>review(shop,past,{displayName:'New Hidden Preference'}),{status:400});
  if(exclusion==='hidden')review(shop,past,{hidden:false});
  if(exclusion==='refunded')shop.supporterLedger.publicFeed.rows[past].status='public';
  if(exclusion==='duplicate')review(shop,past,{duplicateOf:''});
  assert.deepEqual(lifetime(shop),credits('Preferred Full Name',5000));
 }
});

test('archiving a manual preference excludes that preference and payment, while restore preserves previous hidden and preference settings',()=>{
 const shop=fixture(),manualId='manual:77777777-7777-4777-8777-777777777777';delete shop.supporterLedger.publicFeed.rows[past];
 saveManualSupporter(shop,{id:manualId,name:'Original Current Name',gross:1000,refunded:null,status:'paid',showName:true,showAmount:true,hidden:false,channel:'Cash',reference:'',processor:'',sameSupporterAs:current});
 review(shop,manualId,{displayName:'Manual Reviewed Full Name'});assert.deepEqual(lifetime(shop),credits('Manual Reviewed Full Name',3500));
 review(shop,manualId,{archived:true});assert.deepEqual(lifetime(shop),credits('Original Current Name',2500));assert.deepEqual(active(shop),credits('Original Current Name',2500));
 assert.equal(shop.supporterLedger.moderation[manualId].displayName,'Manual Reviewed Full Name');
 review(shop,manualId,{archived:false});assert.deepEqual(lifetime(shop),credits('Manual Reviewed Full Name',3500));
 review(shop,manualId,{hidden:true});assert.deepEqual(lifetime(shop),credits('Original Current Name',2500));
});

test('preferred text cannot bridge identities, publish a named private amount or defeat processor-copy privacy',()=>{
 const shop=fixture();review(shop,past,{displayName:'Original Current Name'});
 assert.equal(lifetime(shop).length,2);assert.deepEqual(lifetime(shop).map(row=>row.amount),[2500,2500]);
 const manualId='manual:88888888-8888-4888-8888-888888888888';
 saveManualSupporter(shop,{id:manualId,name:'Public Private-Amount Person',gross:1000,refunded:null,status:'paid',showName:true,showAmount:false,hidden:false,channel:'Cash',reference:'',processor:''});
 review(shop,manualId,{displayName:'Private Amount Preferred Name'});assert.equal(lifetime(shop).find(row=>row.name==='Private Amount Preferred Name').amount,null);
 const copies={sales:{ORDER:{status:'paid',subtotal:3000,captureId:'SAME-PAYMENT',channel:'PayPal checkout',recognition:{public:true,name:'Website Public Name',showAmount:true}}},supporterLedger:{transactions:{},moderation:{}}};
 review(copies,'website:ORDER',{displayName:'Website Preferred Name'});
 saveManualSupporter(copies,{id:manualId,name:'Private name must stay private',gross:3000,refunded:null,status:'paid',showName:false,showAmount:true,hidden:false,channel:'PayPal',reference:'SAME-PAYMENT',processor:'paypal'});
 assert.deepEqual(lifetime(copies),credits('Anonymous',3000));assert.ok(!JSON.stringify(lifetime(copies)).includes('Preferred'));
});

test('the most recently updated eligible preference wins deterministically, with fallback after clear and no metadata leakage',()=>{
 const shop=matched(),originalNow=Date.now;let time=originalNow();
 try{
  Date.now=()=>time;review(shop,current,{displayName:'First Preference'});time++;
  review(shop,past,{displayName:'Second Preference'});
  assert.deepEqual(lifetime(shop),credits('Second Preference',5000));assert.deepEqual(active(shop),credits('Second Preference',2500));
  review(shop,past,{displayName:null});assert.deepEqual(lifetime(shop),credits('First Preference',5000));
  review(shop,current,{displayName:''});assert.deepEqual(lifetime(shop),credits('Short Name',5000));
  assert.equal(adminSupporters(shop).find(row=>row.id===current).displayName,null);
 }finally{Date.now=originalNow;}
 const encoded=JSON.stringify(lifetime(shop));for(const field of ['displayName','updatedAt','supporterIdentityPair','public-owner','reference'])assert.ok(!encoded.includes(field));
});

test('preferred names validate plain text and current eligibility before mutation, and reject stale record revisions',()=>{
 for(const value of [false,42,{},[], 'x'.repeat(121),'<b>Unsafe</b>','Hidden\u0000Name','Hidden\u202eName']){
  const shop=matched(),before=structuredClone(shop);assert.throws(()=>review(shop,past,{displayName:value}),{status:400});assert.deepEqual(shop,before);
 }
 const shop=matched(),before=adminSupporters(shop).find(row=>row.id===past);
 review(shop,past,{displayName:'Verified Full Name'});
 assert.throws(()=>moderateSupporter(shop,{id:past,hidden:false,moderationRevision:before.moderationRevision,displayName:'Stale Full Name'}),{status:409});
 assert.equal(adminSupporters(shop).find(row=>row.id===past).displayName,'Verified Full Name');
 const after=adminSupporters(shop).find(row=>row.id===past);shop.supporterLedger.publicFeed.rows[past].showName=false;
 assert.throws(()=>moderateSupporter(shop,{id:past,hidden:false,moderationRevision:after.moderationRevision,displayName:'Private Name Attempt'}),{status:409});
 review(shop,past,{displayName:null});assert.equal(adminSupporters(shop).find(row=>row.id===past).displayName,null);
 const unknown=fixture();unknown.supporterLedger.publicFeed.rows[past].showAmount=false;unknown.supporterLedger.publicFeed.rows[past].gross=0;
 assert.throws(()=>review(unknown,past,{displayName:'Unverified Amount Name'}),{status:400});
});
