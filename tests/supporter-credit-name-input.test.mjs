import test from 'node:test';
import assert from 'node:assert/strict';
import {publicCreditNameEditable,publicCreditNameChange} from '../members/supporters.js';
import {adminSupporters,moderateSupporter,publicSupporters} from '../netlify/lib/supporters.mjs';

const named=changes=>({name:'Dale',showName:true,amount:2500,hidden:false,duplicateOf:'',displayName:null,...changes});

test('a preferred public credit name is a separate changed-only moderation field',()=>{
  const row=named(),before=structuredClone(row);
  assert.equal(publicCreditNameEditable(row),true);
  assert.deepEqual(publicCreditNameChange(row,'  Dale   Freeman  '),{displayName:'Dale Freeman'});
  assert.deepEqual(row,before,'Preparing recognition input never rewrites a transaction, privacy choice or amount.');
  assert.deepEqual(publicCreditNameChange(row,''),{});
  assert.deepEqual(publicCreditNameChange(named({displayName:'Dale Freeman'}),'Dale Freeman'),{});
  assert.deepEqual(publicCreditNameChange(named({displayName:'Dale Freeman'}),'  Dale   Freeman  '),{});
});

test('clearing a stored preference is explicit while unrelated review fields preserve it',()=>{
  const row=named({displayName:'Dale Freeman',hidden:true});
  assert.deepEqual(publicCreditNameChange(row,'  '),{displayName:null},'Clearing does not require unhiding a payment.');
  const input={id:'synthetic-payment',hidden:true,duplicateOf:'',...publicCreditNameChange(row,'Dale Freeman')};
  assert.equal(Object.hasOwn(input,'displayName'),false);
  assert.equal(input.hidden,true);
});

test('private, missing, invalid and Anonymous source names never offer or emit a preferred name',()=>{
  for(const row of [named({showName:false,name:'PRIVATE NAME',displayName:'PRIVATE PREFERENCE'}),named({name:''}),named({name:'Anonymous'}),named({name:' anonymous '}),named({name:'<img src=x>'}),named({name:'Bad\u202ename'}),named({name:'x'.repeat(121)}),null]){
    assert.equal(publicCreditNameEditable(row),false);
    assert.deepEqual(publicCreditNameChange(row,'Never expose this name'),{});
  }
});

test('an excluded or unknown-balance payment cannot acquire a new preference',()=>{
  for(const row of [named({hidden:true}),named({duplicateOf:'original-payment'}),named({archived:true}),named({amount:0}),named({amount:null})]){
    assert.throws(()=>publicCreditNameChange(row,'Dale Freeman'),/visible, eligible payment/);
    assert.deepEqual(publicCreditNameChange({...row,displayName:'Dale Freeman'},''),{displayName:null});
  }
});

test('public credit name input accepts normalized plain text and rejects markup or control characters',()=>{
  assert.deepEqual(publicCreditNameChange(named(),'Ｄａｌｅ Freeman'),{displayName:'Dale Freeman'});
  assert.deepEqual(publicCreditNameChange(named(),'Zoë Freeman'),{displayName:'Zoë Freeman'});
  for(const value of ['<script>alert(1)</script>','Dale\u0000 Freeman','Dale\u202eFreeman','x'.repeat(121),null])assert.throws(()=>publicCreditNameChange(named(),value),/plain-text public credit name/);
});

test('review input round-trips a public preference without changing the source payments',()=>{
  const contribution=(id,name,date)=>({id,source:'crowdfundr-public',reference:id,status:'public',gross:2500,name,showName:true,showAmount:true,hidden:false,identity:'public-owner:synthetic-supporter',date});
  const shop={sales:{},supporterLedger:{transactions:{},moderation:{},publicFeed:{enabled:true,checkedAt:Date.now(),rows:{first:contribution('public:first','Dale Freeman',1),second:contribution('public:second','Dale',2)}}}};
  const source=structuredClone(shop.supporterLedger.publicFeed.rows);
  let row=adminSupporters(shop).find(row=>row.id==='public:second');
  moderateSupporter(shop,{id:row.id,hidden:row.hidden,moderationRevision:row.moderationRevision,...publicCreditNameChange(row,'Dale Freeman')});
  assert.deepEqual(publicSupporters(shop),[{name:'Dale Freeman',amount:5000,currency:'USD'}]);
  assert.deepEqual(shop.supporterLedger.publicFeed.rows,source);
  row=adminSupporters(shop).find(row=>row.id==='public:second');
  assert.equal(row.name,'Dale');assert.equal(row.displayName,'Dale Freeman');
  const unrelated={id:row.id,hidden:false,moderationRevision:row.moderationRevision,...publicCreditNameChange(row,'Dale Freeman')};
  assert.equal(Object.hasOwn(unrelated,'displayName'),false);
  moderateSupporter(shop,unrelated);
  assert.equal(adminSupporters(shop).find(row=>row.id==='public:second').displayName,'Dale Freeman');
  row=adminSupporters(shop).find(row=>row.id==='public:second');
  moderateSupporter(shop,{id:row.id,hidden:false,moderationRevision:row.moderationRevision,...publicCreditNameChange(row,'')});
  assert.deepEqual(publicSupporters(shop),[{name:'Dale',amount:5000,currency:'USD'}]);
  assert.deepEqual(shop.supporterLedger.publicFeed.rows,source);
});
