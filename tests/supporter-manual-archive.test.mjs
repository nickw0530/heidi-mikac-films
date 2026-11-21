import test from 'node:test';
import assert from 'node:assert/strict';
import {adminSupporters,moderateSupporter,publicSupporters,saveManualSupporter,supporterTransactions} from '../netlify/lib/supporters.mjs';

const id='manual:11111111-1111-4111-8111-111111111111';
const input={id,name:'Gary Sparks',gross:200000,refunded:null,status:'paid',showName:true,showAmount:true,hidden:true,channel:'Venmo',processor:'',reference:'duplicate-offline-entry'};
function fixture(hidden=true){
 const shop={sales:{},supporterLedger:{transactions:{},moderation:{}}};
 saveManualSupporter(shop,{...input,hidden});
 return shop;
}
function archive(shop,archived){
 const row=adminSupporters(shop).find(row=>row.id===id);
 return moderateSupporter(shop,{id,hidden:row.hidden,moderationRevision:row.moderationRevision,archived});
}

test('deleting a hidden manual duplicate removes it from active records and remains recoverable without making it public',()=>{
 const shop=fixture(),original=structuredClone(shop.supporterLedger.transactions[id]);
 archive(shop,true);
 assert.equal(shop.supporterLedger.transactions[id].archived,true);
 assert.deepEqual(supporterTransactions(shop),[]);
 assert.deepEqual(publicSupporters(shop),[]);
 const deleted=adminSupporters(shop).find(row=>row.id===id);
 assert.equal(deleted.archived,true);assert.equal(deleted.hidden,true);assert.equal(deleted.gross,200000);
 assert.deepEqual(Object.fromEntries(Object.entries(shop.supporterLedger.transactions[id]).filter(([key])=>key!=='archived')),original,'The private audit record is retained.');
 assert.throws(()=>saveManualSupporter(shop,{...input,hidden:false}),error=>error.status===409,'A stale edit cannot restore a deleted entry.');
 archive(shop,false);
 assert.equal(supporterTransactions(shop).length,1);assert.equal(shop.supporterLedger.transactions[id].hidden,true);
 assert.deepEqual(publicSupporters(shop),[],'Restoring a previously hidden entry does not publish it.');
});

test('deleted visible manual support is excluded until explicitly restored and privacy choices are retained',()=>{
 const shop=fixture(false);
 assert.equal(publicSupporters(shop)[0].amount,200000);
 archive(shop,true);assert.deepEqual(publicSupporters(shop),[]);
 archive(shop,false);
 assert.deepEqual(publicSupporters(shop),[{name:'Gary Sparks',amount:200000,currency:'USD'}]);
 assert.equal(shop.supporterLedger.transactions[id].showName,true);assert.equal(shop.supporterLedger.transactions[id].showAmount,true);
});

test('deletion is restricted to manual records, valid booleans and a current record revision',()=>{
 const shop=fixture(),row=adminSupporters(shop)[0];
 assert.throws(()=>moderateSupporter(shop,{id,hidden:true,archived:'yes',moderationRevision:row.moderationRevision}),error=>error.status===400);
 archive(shop,true);
 assert.throws(()=>moderateSupporter(shop,{id,hidden:true,archived:false,moderationRevision:row.moderationRevision}),error=>error.status===409);
 shop.sales.ORDER={status:'paid',subtotal:4000,recognition:{public:true,name:'Website supporter',showAmount:true}};
 const website=adminSupporters(shop).find(record=>record.source==='website');
 assert.throws(()=>moderateSupporter(shop,{id:website.id,hidden:false,archived:true,moderationRevision:website.moderationRevision}),error=>error.status===400);
 assert.equal(shop.sales.ORDER.supporterHidden,undefined,'An invalid archive attempt does not mutate a website order.');
});
