import test from 'node:test';
import assert from 'node:assert/strict';
import {adminSupporters,moderateSupporter,publicSupporters,saveManualSupporter,supporterCampaigns} from '../netlify/lib/supporters.mjs';

const currentId='e2ozh2',pastId='b2mXyf';
const id='manual:11111111-1111-4111-8111-111111111111';
const otherId='manual:22222222-2222-4222-8222-222222222222';
const input=(overrides={})=>({id,name:'Manual Campaign Supporter',gross:2500,status:'paid',refunded:null,showName:true,showAmount:true,hidden:false,
 channel:'Alternative payment',processor:'',reference:'',...overrides});
function fixture(){return {sales:{},supporterLedger:{transactions:{},moderation:{},publicFeed:{enabled:true,rows:{},checkedAt:Date.now(),campaigns:[
 {id:currentId,title:'Current synthetic campaign',active:true,checkedAt:Date.now(),privateField:'NEVER-EXPOSE'},
 {id:pastId,title:'Past synthetic campaign',active:false,checkedAt:Date.now()}
]}}};}
const current=shop=>publicSupporters(shop,{scope:'current'}),lifetime=shop=>publicSupporters(shop,{scope:'lifetime'});
const credit=(amount,name='Manual Campaign Supporter')=>[{name,amount,currency:'USD'}];
function review(shop,changes){const row=adminSupporters(shop).find(row=>row.id===id);return moderateSupporter(shop,{id,hidden:row.hidden===true,moderationRevision:row.moderationRevision,...changes});}

test('manual support is lifetime-only until explicitly assigned to a registered active campaign',()=>{
 const shop=fixture();saveManualSupporter(shop,input());
 assert.equal(shop.supporterLedger.transactions[id].campaignId,'');assert.deepEqual(current(shop),[]);assert.deepEqual(lifetime(shop),credit(2500));
 saveManualSupporter(shop,input({campaignId:currentId}));assert.deepEqual(current(shop),credit(2500));assert.deepEqual(lifetime(shop),credit(2500));
 saveManualSupporter(shop,input({id:otherId,gross:1000}));assert.deepEqual(current(shop),credit(2500));assert.deepEqual(lifetime(shop),credit(3500));
 const row=adminSupporters(shop).find(row=>row.id===id);
 assert.equal(row.campaignId,currentId);assert.equal(row.campaignTitle,'Current synthetic campaign');assert.equal('identity' in row,false);
 assert.deepEqual(supporterCampaigns(shop),[{id:currentId,title:'Current synthetic campaign',active:true},{id:pastId,title:'Past synthetic campaign',active:false}]);
 assert.ok(!JSON.stringify(supporterCampaigns(shop)).includes('NEVER-EXPOSE'));
 assert.deepEqual(Object.keys(current(shop)[0]).sort(),['amount','currency','name']);
});

test('manual edits preserve an omitted campaign assignment and explicit blank clears it without changing lifetime support',()=>{
 const shop=fixture();saveManualSupporter(shop,input({campaignId:currentId}));
 saveManualSupporter(shop,input({gross:3000}));assert.equal(shop.supporterLedger.transactions[id].campaignId,currentId);assert.deepEqual(current(shop),credit(3000));
 saveManualSupporter(shop,input({gross:3000,campaignId:''}));assert.equal(shop.supporterLedger.transactions[id].campaignId,'');assert.deepEqual(current(shop),[]);assert.deepEqual(lifetime(shop),credit(3000));
 saveManualSupporter(shop,input({gross:3000,campaignId:pastId}));assert.deepEqual(current(shop),[]);assert.deepEqual(lifetime(shop),credit(3000));
 assert.equal(adminSupporters(shop)[0].campaignTitle,'Past synthetic campaign');
});

test('registered campaign activity controls manual current membership without rewriting payments or lifetime totals',()=>{
 const shop=fixture();saveManualSupporter(shop,input({campaignId:currentId}));saveManualSupporter(shop,input({id:otherId,campaignId:pastId,gross:1000}));
 const payments=structuredClone(shop.supporterLedger.transactions);
 shop.supporterLedger.publicFeed.campaigns.find(row=>row.id===pastId).active=true;assert.deepEqual(current(shop),credit(3500));
 for(const campaign of shop.supporterLedger.publicFeed.campaigns)campaign.active=false;
 assert.deepEqual(current(shop),[]);assert.deepEqual(lifetime(shop),credit(3500));assert.deepEqual(shop.supporterLedger.transactions,payments);
});

test('invalid explicit manual campaign IDs fail before mutation on new and existing records',()=>{
 for(const value of [null,false,0,{},[],['e2ozh2'],'unknown123',' e2ozh2','https://crowdfundr.com/e2ozh2']){
  for(const existing of [false,true]){
   const shop=existing?fixture():{sales:{}};
   if(existing)saveManualSupporter(shop,input({campaignId:currentId}));
   const before=structuredClone(shop);assert.throws(()=>saveManualSupporter(shop,input({campaignId:value})),{status:400});assert.deepEqual(shop,before);
  }
 }
});

test('an omitted removed campaign remains in the audit record but cannot become current or silently acquire another assignment',()=>{
 const shop=fixture();saveManualSupporter(shop,input({campaignId:pastId}));shop.supporterLedger.publicFeed.campaigns=shop.supporterLedger.publicFeed.campaigns.filter(row=>row.id!==pastId);
 saveManualSupporter(shop,input({gross:3000}));assert.equal(shop.supporterLedger.transactions[id].campaignId,pastId);
 assert.deepEqual(current(shop),[]);assert.deepEqual(lifetime(shop),credit(3000));assert.equal(adminSupporters(shop)[0].campaignTitle,undefined);
 const before=structuredClone(shop);assert.throws(()=>saveManualSupporter(shop,input({campaignId:pastId})),{status:400});assert.deepEqual(shop,before);
 saveManualSupporter(shop,input({campaignId:''}));assert.equal(shop.supporterLedger.transactions[id].campaignId,'');
});

test('assigned manual amounts keep name privacy, named amount privacy, payment eligibility and confirmed refund remainders',async t=>{
 for(const [label,changes,expected] of [
  ['anonymous known amount',{showName:false,showAmount:false,name:'PRIVATE MANUAL NAME'},credit(2500,'Anonymous')],
  ['named private amount',{showAmount:false},credit(null)],
  ['hidden',{hidden:true},[]],['pending',{status:'pending'},[]],['failed',{status:'failed'},[]],['refunded',{status:'refunded'},[]],
  ['confirmed partial refund',{status:'partially refunded',refunded:500},credit(2000)]
 ])await t.test(label,()=>{const shop=fixture();saveManualSupporter(shop,input({campaignId:currentId,...changes}));assert.deepEqual(current(shop),expected);assert.deepEqual(lifetime(shop),expected);assert.ok(!JSON.stringify(current(shop)).includes('PRIVATE MANUAL NAME'));});
});

test('campaign-assigned manual copies deduplicate against website captures before either scope and cannot bypass private, hidden or refunded copies',()=>{
 const shop=fixture();shop.sales.ORDER={status:'paid',channel:'PayPal checkout',captureId:'SYNTHETIC-CAPTURE',subtotal:2500,total:3000,shipping:500,
  recognition:{public:true,name:'Manual Campaign Supporter',showAmount:true}};
 saveManualSupporter(shop,input({campaignId:currentId,processor:'paypal',reference:'SYNTHETIC-CAPTURE'}));
 assert.deepEqual(current(shop),credit(2500));assert.deepEqual(lifetime(shop),credit(2500));
 shop.sales.ORDER.recognition.showAmount=false;assert.deepEqual(current(shop),credit(null));assert.deepEqual(lifetime(shop),credit(null));
 shop.sales.ORDER.recognition.public=false;assert.deepEqual(current(shop),credit(2500,'Anonymous'));assert.deepEqual(lifetime(shop),credit(2500,'Anonymous'));
 shop.sales.ORDER.supporterHidden=true;assert.deepEqual(current(shop),[]);assert.deepEqual(lifetime(shop),[]);
 shop.sales.ORDER.supporterHidden=false;shop.sales.ORDER.status='refunded';assert.deepEqual(current(shop),[]);assert.deepEqual(lifetime(shop),[]);
});

test('deleted or explicitly duplicate assigned manual payments stay excluded and assignment edits invalidate stale moderation tokens',()=>{
 const shop=fixture();saveManualSupporter(shop,input({campaignId:currentId}));saveManualSupporter(shop,input({id:otherId,name:'Other supporter',gross:1000}));
 const old=adminSupporters(shop).find(row=>row.id===id).moderationRevision;
 saveManualSupporter(shop,input({campaignId:pastId}));
 assert.throws(()=>moderateSupporter(shop,{id,hidden:false,moderationRevision:old}),{status:409});
 saveManualSupporter(shop,input({campaignId:currentId}));review(shop,{duplicateOf:otherId});assert.deepEqual(current(shop),[]);
 review(shop,{duplicateOf:''});assert.deepEqual(current(shop),credit(2500));
 review(shop,{archived:true});assert.deepEqual(current(shop),[]);assert.equal(shop.supporterLedger.transactions[id].campaignId,currentId);
 assert.throws(()=>saveManualSupporter(shop,input({campaignId:pastId})),{status:409});
 review(shop,{archived:false});assert.deepEqual(current(shop),credit(2500));
});

test('confirmed manual campaign support does not inherit public-feed freshness failures and website purchases remain lifetime-only',()=>{
 const shop=fixture();saveManualSupporter(shop,input({campaignId:currentId}));
 shop.supporterLedger.publicFeed.campaigns[0].checkedAt=Date.now()-1200001;
 shop.sales.ORDER={status:'paid',subtotal:1000,recognition:{public:true,name:'Website-only supporter',showAmount:true},campaignId:currentId};
 assert.deepEqual(current(shop),credit(2500));assert.equal(lifetime(shop).length,2);
 assert.equal(adminSupporters(shop).find(row=>row.id==='website:ORDER').campaignTitle,undefined);
});
