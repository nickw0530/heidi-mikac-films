import test from 'node:test';
import assert from 'node:assert/strict';
import {adminSupporters,importSupporterCsv,moderateSupporter,previewSupporterCsv,publicSupporters,saveManualSupporter} from '../netlify/lib/supporters.mjs';

const nativeId='crowdfundr-public:anonymous-verified';
const manualId='manual:11111111-1111-4111-8111-111111111111';
const native=(overrides={})=>({id:nativeId,source:'crowdfundr-public',campaignId:'e2ozh2',reference:'synthetic-public-reference',processor:'',
 channel:'Crowdfundr public activity',status:'public',gross:0,refunded:null,name:'Private native name',showName:false,showAmount:false,identity:'',date:1,hidden:false,...overrides});
const blank=()=>({sales:{},supporterLedger:{transactions:{},moderation:{}}});
function withNative(row=native()){
 const shop=blank();shop.supporterLedger.publicFeed={enabled:true,checkedAt:Date.now(),rows:{[row.id]:row}};return shop;
}
const manual=(overrides={})=>({id:manualId,name:'Private manual name',gross:2500,refunded:null,status:'paid',showName:false,showAmount:false,hidden:false,channel:'Cash',reference:'',processor:'',...overrides});
function review(shop,id,changes){
 const row=adminSupporters(shop).find(row=>row.id===id);
 return moderateSupporter(shop,{id,hidden:row.hidden===true,moderationRevision:row.moderationRevision,...changes});
}
function importCsv(shop){
 const csv='Contribution amount,Currency,Payment status,Transaction ID,Name,Show name,Show amount\n12.34,USD,Paid,SYNTHETIC-PRIVATE-CSV,Private CSV name,No,No';
 const {digest}=previewSupporterCsv(shop,csv);importSupporterCsv(shop,{csv,digest});
}

test('known anonymous website, manual and imported gross balances show amounts without exposing their private names or changing stored choices',()=>{
 const shop=blank();
 shop.sales.ORDER={status:'paid',subtotal:4000,total:4500,shipping:500,recognition:{public:false,name:'Private website name',showAmount:false}};
 saveManualSupporter(shop,manual({status:'partially refunded',refunded:500}));importCsv(shop);
 const before=structuredClone(shop),rows=publicSupporters(shop);
 assert.deepEqual(rows.map(row=>[row.name,row.amount]).sort((a,b)=>a[1]-b[1]),[['Anonymous',1234],['Anonymous',2000],['Anonymous',4000]]);
 assert.deepEqual(shop,before,'Projection preserves original flags and financial records.');
 assert.ok(!JSON.stringify(rows).includes('Private'));assert.ok(rows.every(row=>Object.keys(row).sort().join(',')==='amount,currency,name'));
 shop.sales.ORDER.recognition={public:false};assert.equal(publicSupporters(shop).find(row=>row.amount===4000)?.name,'Anonymous','Old missing amount flags do not conceal a known anonymous balance.');
});

test('named private amounts remain private while anonymous native amount sentinels remain unknown',()=>{
 const shop=withNative();saveManualSupporter(shop,manual({showName:true,name:'Public named supporter'}));
 shop.sales.NAMED={status:'paid',subtotal:1000,recognition:{public:true,name:'Named website supporter',showAmount:false}};
 const rows=publicSupporters(shop);assert.equal(rows.length,3);assert.ok(rows.every(row=>row.amount===null));
 shop.supporterLedger.publicFeed.rows[nativeId].gross=9999;
 assert.equal(publicSupporters(shop).find(row=>row.name==='Anonymous').amount,null,'A hidden native amount is not treated as known without verification.');
 assert.equal(adminSupporters(shop).find(row=>row.id===nativeId).amountVerified,false);
});

test('verified anonymous native amounts are scoped, server managed and preserved through a complete source refresh',()=>{
 const shop=withNative(),source=structuredClone(shop.supporterLedger.publicFeed.rows[nativeId]);
 review(shop,nativeId,{anonymousGross:5678,amountVerified:false,gross:999999,name:'Forged public name',showName:true});
 assert.deepEqual(publicSupporters(shop),[{name:'Anonymous',amount:5678,currency:'USD'}]);
 assert.deepEqual(publicSupporters(shop,{scope:'current'}),[{name:'Anonymous',amount:5678,currency:'USD'}]);
 const row=adminSupporters(shop).find(row=>row.id===nativeId);
 assert.equal(row.anonymousGross,5678);assert.equal(row.amountVerified,true);assert.equal(row.gross,5678);assert.equal(row.amount,5678);
 assert.equal(row.showName,false);assert.equal(row.showAmount,false);assert.deepEqual(shop.supporterLedger.publicFeed.rows[nativeId],source);
 shop.supporterLedger.publicFeed={enabled:true,checkedAt:Date.now(),rows:{[nativeId]:structuredClone(source)}};
 assert.equal(publicSupporters(shop)[0].amount,5678);assert.equal(adminSupporters(shop)[0].amountVerified,true);
 assert.equal(JSON.stringify(publicSupporters(shop)).includes('anonymousGross'),false);
 assert.equal(JSON.stringify(publicSupporters(shop)).includes('Private native name'),false);
});

test('fresh native public amounts supersede verification and changing to a named private payment disables the anonymous override',()=>{
 const shop=withNative();review(shop,nativeId,{anonymousGross:5000});
 const source=shop.supporterLedger.publicFeed.rows[nativeId];source.showAmount=true;source.gross=7000;
 assert.equal(publicSupporters(shop)[0].amount,7000);assert.equal(adminSupporters(shop)[0].amountVerified,false);
 assert.equal(adminSupporters(shop)[0].anonymousGross,5000,'Stored verification is retained separately from fresh source amounts.');
 source.showAmount=false;source.gross=0;source.showName=true;source.name='Public source name';
 assert.deepEqual(publicSupporters(shop),[{name:'Public source name',amount:null,currency:'USD'}]);
 assert.equal(adminSupporters(shop)[0].amountVerified,false);assert.equal(adminSupporters(shop)[0].gross,0);
 source.showName=false;assert.deepEqual(publicSupporters(shop),[{name:'Anonymous',amount:5000,currency:'USD'}]);
});

test('ordinary moderation preserves verification, explicit null clears it, and same-record verification changes reject stale edits',()=>{
 const shop=withNative();review(shop,nativeId,{anonymousGross:1000});
 const before=adminSupporters(shop)[0];
 shop.supporterLedger.publicFeed.checkedAt=Date.now();
 moderateSupporter(shop,{id:nativeId,hidden:true,moderationRevision:before.moderationRevision});
 assert.deepEqual(publicSupporters(shop),[]);assert.equal(shop.supporterLedger.moderation[nativeId].anonymousGross,1000);
 review(shop,nativeId,{hidden:false});assert.equal(publicSupporters(shop)[0].amount,1000);
 const stale=adminSupporters(shop)[0].moderationRevision;review(shop,nativeId,{anonymousGross:2000});
 assert.throws(()=>moderateSupporter(shop,{id:nativeId,hidden:false,moderationRevision:stale,anonymousGross:3000}),{status:409});
 assert.equal(publicSupporters(shop)[0].amount,2000);
 review(shop,nativeId,{anonymousGross:null});assert.equal(publicSupporters(shop)[0].amount,null);assert.equal(adminSupporters(shop)[0].amountVerified,false);
 assert.equal(adminSupporters(shop)[0].anonymousGross,null);
});

test('verification rejects invalid amounts and nonanonymous or nonnative targets before any mutation',()=>{
 for(const value of [0,-1,1.5,100000001,Infinity,NaN,'100',true,{},[]]){
  const shop=withNative(),before=structuredClone(shop);
  assert.throws(()=>review(shop,nativeId,{anonymousGross:value}),{status:400});assert.deepEqual(shop,before);
 }
 for(const kind of ['named native','manual','website','CSV']){
  const shop=withNative();let id=nativeId;
  if(kind==='named native'){shop.supporterLedger.publicFeed.rows[nativeId].showName=true;shop.supporterLedger.publicFeed.rows[nativeId].name='Named person';}
  if(kind==='manual'){saveManualSupporter(shop,manual());id=manualId;}
  if(kind==='website'){shop.sales.ORDER={status:'paid',subtotal:1000,recognition:{public:false}};id='website:ORDER';}
  if(kind==='CSV'){importCsv(shop);id=Object.keys(shop.supporterLedger.transactions)[0];}
  for(const value of [1000,null]){const before=structuredClone(shop);assert.throws(()=>review(shop,id,{anonymousGross:value}),{status:400});assert.deepEqual(shop,before);}
 }
});

test('anonymous amount projection cannot bypass duplicate references, refunds, hidden moderation, or source freshness',()=>{
 const shop=blank();shop.sales.ORDER={status:'paid',channel:'PayPal checkout',captureId:'SHARED',subtotal:2000,total:2500,shipping:500,recognition:{public:false,showAmount:false}};
 saveManualSupporter(shop,manual({gross:2000,processor:'paypal',reference:'SHARED',showName:true,name:'Must not replace the private website name',showAmount:true}));
 assert.deepEqual(publicSupporters(shop),[{name:'Anonymous',amount:2000,currency:'USD'}]);
 shop.supporterLedger.transactions[manualId].status='refunded';assert.deepEqual(publicSupporters(shop),[]);
 shop.supporterLedger.transactions[manualId].status='paid';review(shop,manualId,{hidden:true});assert.deepEqual(publicSupporters(shop),[]);
 const nativeShop=withNative();review(nativeShop,nativeId,{anonymousGross:1200});
 saveManualSupporter(nativeShop,manual({gross:1000}));
 review(nativeShop,nativeId,{duplicateOf:manualId});assert.deepEqual(publicSupporters(nativeShop),[{name:'Anonymous',amount:1000,currency:'USD'}]);
 assert.equal(nativeShop.supporterLedger.moderation[nativeId].anonymousGross,1200);
 review(nativeShop,nativeId,{duplicateOf:''});nativeShop.supporterLedger.publicFeed.checkedAt=Date.now()-1200001;
 assert.deepEqual(publicSupporters(nativeShop),[{name:'Anonymous',amount:1000,currency:'USD'}]);
 nativeShop.supporterLedger.publicFeed.checkedAt=Date.now();nativeShop.supporterLedger.publicFeed.rows[nativeId].status='refunded';
 assert.deepEqual(publicSupporters(nativeShop),[{name:'Anonymous',amount:1000,currency:'USD'}]);
});

test('verified named aliases still total historical and active support while the archived manual duplicate stays excluded',()=>{
 const current=native({id:'crowdfundr-public:current-person',name:'Sample Supporter',showName:true,showAmount:true,gross:80000,identity:'public-owner:current-person',date:2});
 const past=native({id:'crowdfundr-public:past-person',campaignId:'b2mXyf',name:'Sample N Supporter',showName:true,showAmount:true,gross:200000,identity:'public-owner:past-person'});
 const shop=withNative(current);shop.supporterLedger.publicFeed.rows[past.id]=past;
 shop.supporterLedger.publicFeed.campaigns=[{id:'e2ozh2',title:'Current',active:true,checkedAt:Date.now()},{id:'b2mXyf',title:'Past',active:false,checkedAt:Date.now()}];
 saveManualSupporter(shop,manual({name:'Sample Supporter',gross:200000,showName:true,showAmount:true,hidden:true}));
 review(shop,manualId,{archived:true});review(shop,past.id,{sameSupporterAs:current.id});
 const before=structuredClone(shop);assert.deepEqual(publicSupporters(shop),[{name:'Sample Supporter',amount:280000,currency:'USD'}]);
 assert.deepEqual(publicSupporters(shop,{scope:'current'}),[{name:'Sample Supporter',amount:80000,currency:'USD'}]);
 assert.equal(adminSupporters(shop).find(row=>row.id===manualId).archived,true);assert.equal(adminSupporters(shop).find(row=>row.id===manualId).hidden,true);
 assert.deepEqual(shop,before);
});
