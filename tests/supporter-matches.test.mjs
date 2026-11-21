import test from 'node:test';
import assert from 'node:assert/strict';
import {adminSupporters,publicSupporters,moderateSupporter,saveManualSupporter} from '../netlify/lib/supporters.mjs';

const current='crowdfundr-public:current-reviewed',past='crowdfundr-public:past-reviewed';
const hiddenManual='manual:33333333-3333-4333-8333-333333333333';
const activity=(id,campaignId,name,gross,identity,date=1)=>({id,campaignId,name,gross,identity,date,source:'crowdfundr-public',reference:id,processor:'',
 channel:'Crowdfundr public activity',status:'public',refunded:null,showName:true,showAmount:true,hidden:false});
function fixture(){
 const rows=[activity(current,'e2ozh2','Avery Lane',80000,'public-owner:current-profile',2),activity(past,'b2mXyf','Avery N Lane',200000,'public-owner:past-profile')];
 const state={sales:{},supporterLedger:{transactions:{},moderation:{},publicFeed:{enabled:true,checkedAt:Date.now(),rows:Object.fromEntries(rows.map(row=>[row.id,row])),
  campaigns:[{id:'e2ozh2',title:'Current campaign',active:true,checkedAt:Date.now()},{id:'b2mXyf',title:'Past campaign',active:false,checkedAt:Date.now()}]}}};
 saveManualSupporter(state,{id:hiddenManual,name:'Avery Lane',gross:200000,refunded:null,status:'paid',showName:true,showAmount:true,hidden:true,channel:'Cash',reference:'synthetic-hidden-manual',processor:''});
 return state;
}
function review(state,id,input){
 const row=adminSupporters(state).find(row=>row.id===id);
 return moderateSupporter(state,{id,hidden:row.hidden===true,duplicateOf:row.duplicateOf||'',moderationRevision:row.moderationRevision,...input});
}
const lifetime=state=>publicSupporters(state,{scope:'lifetime'}),active=state=>publicSupporters(state,{scope:'current'});

test('one reviewed spelling-variant match merges lifetime support without changing current amounts, payments or the hidden manual record',()=>{
 const state=fixture(),originalRows=structuredClone(state.supporterLedger.publicFeed.rows),hidden=structuredClone(state.supporterLedger.transactions[hiddenManual]);
 assert.equal(lifetime(state).length,2);
 review(state,past,{sameSupporterAs:current});
 assert.deepEqual(lifetime(state),[{name:'Avery Lane',amount:280000,currency:'USD'}]);
 assert.deepEqual(active(state),[{name:'Avery Lane',amount:80000,currency:'USD'}]);
 assert.equal(adminSupporters(state).length,3);assert.deepEqual(state.supporterLedger.publicFeed.rows,originalRows);
 assert.deepEqual(state.supporterLedger.transactions[hiddenManual],hidden);assert.equal(adminSupporters(state).find(row=>row.id===hiddenManual).hidden,true);
 assert.equal(adminSupporters(state).find(row=>row.id===past).sameSupporterAs,current);
 assert.ok(!JSON.stringify(lifetime(state)).includes('sameSupporterAs'));
});

test('a reviewed identity match covers multiple historical records and new records after complete snapshot replacement',()=>{
 const state=fixture();state.supporterLedger.publicFeed.rows[past].gross=120000;
 const other=activity('crowdfundr-public:other-history','b2mXyf','Avery N Lane',80000,'public-owner:past-profile');
 state.supporterLedger.publicFeed.rows[other.id]=other;
 review(state,past,{sameSupporterAs:current});assert.equal(lifetime(state)[0].amount,280000);assert.equal(lifetime(state).length,1);
 const refreshed=structuredClone(state.supporterLedger.publicFeed),future=activity('crowdfundr-public:future-history','b2mXyf','Avery N Lane',50000,'public-owner:past-profile');
 refreshed.rows[future.id]=future;refreshed.checkedAt=Date.now();for(const row of refreshed.campaigns)row.checkedAt=Date.now();
 state.supporterLedger.publicFeed=refreshed;
 assert.equal(lifetime(state).length,1);assert.equal(lifetime(state)[0].amount,330000);assert.equal(active(state)[0].amount,80000);
 assert.equal(adminSupporters(state).find(row=>row.id===past).sameSupporterAs,current);
 assert.equal(state.supporterLedger.transactions[hiddenManual].hidden,true);
});

test('hide/show and duplicate review preserve a match when the request does not change the match field',()=>{
 const state=fixture();review(state,past,{sameSupporterAs:current});
 review(state,past,{hidden:true});assert.equal(lifetime(state)[0].amount,80000);assert.equal(state.supporterLedger.moderation[past].sameSupporterAs,current);
 review(state,past,{hidden:false});assert.equal(lifetime(state)[0].amount,280000);assert.equal(state.supporterLedger.moderation[past].sameSupporterAs,current);
 review(state,past,{duplicateOf:current});assert.equal(lifetime(state)[0].amount,80000);assert.equal(state.supporterLedger.moderation[past].sameSupporterAs,current);
 review(state,past,{duplicateOf:''});assert.equal(lifetime(state)[0].amount,280000);assert.equal(state.supporterLedger.moderation[past].sameSupporterAs,current);
 review(state,past,{sameSupporterAs:''});assert.equal(lifetime(state).length,2);assert.equal(adminSupporters(state).find(row=>row.id===past).sameSupporterAs,'');
});

test('reviewed matches validate targets, strings, cycles and concurrent same-record revisions before saving',()=>{
 for(const value of [past,'missing-record',null,false,42,{},[], 'x'.repeat(241)]){
  const state=fixture(),before=structuredClone(state);
  assert.throws(()=>review(state,past,{sameSupporterAs:value}),{status:400});assert.deepEqual(state,before);
 }
 const state=fixture(),old=adminSupporters(state).find(row=>row.id===past).moderationRevision;
 review(state,past,{sameSupporterAs:current});
 assert.throws(()=>review(state,current,{sameSupporterAs:past}),/cycle/);
 assert.throws(()=>moderateSupporter(state,{id:past,hidden:false,sameSupporterAs:'',moderationRevision:old}),{status:409});
 assert.equal(state.supporterLedger.moderation[past].sameSupporterAs,current);
});

test('explicit identity matches preserve row-level private names, private amounts and hidden records',()=>{
 const state=fixture();review(state,past,{sameSupporterAs:current});
 const anonymous=activity('crowdfundr-public:private-name','b2mXyf','Must remain private',1000,'public-owner:past-profile');anonymous.showName=false;
 state.supporterLedger.publicFeed.rows[anonymous.id]=anonymous;
 const names=lifetime(state);assert.deepEqual(names.map(row=>[row.name,row.amount]).sort(),[['Anonymous',1000],['Avery Lane',280000]].sort());
 assert.ok(!JSON.stringify(names).includes('Must remain private'));
 state.supporterLedger.publicFeed.rows[past].showAmount=false;
 assert.equal(lifetime(state).find(row=>row.name==='Avery Lane').amount,null);assert.equal(active(state)[0].amount,80000);
 assert.equal(state.supporterLedger.transactions[hiddenManual].hidden,true);
});

test('an explicit cross-authority match retains every verified authority when considering other equal public names',()=>{
 const state=fixture();state.supporterLedger.publicFeed.rows[past].name='Avery Lane';
 const manual='manual:44444444-4444-4444-8444-444444444444';
 saveManualSupporter(state,{id:manual,name:'Avery Lane',gross:2500,refunded:null,status:'paid',showName:true,showAmount:true,hidden:false,channel:'Cash',reference:'',processor:'',identityEmail:'synthetic-verified@example.test'});
 review(state,past,{sameSupporterAs:manual});
 // The approved historical-owner/email component must not lose its public-owner
 // constraint just because its canonical identity happens to be an email key.
 const amounts=lifetime(state).map(row=>row.amount).sort((a,b)=>a-b);
 assert.deepEqual(amounts,[80000,202500]);assert.equal(active(state)[0].amount,80000);
});

test('an approved same-provider alias can still combine an unverified same-name manual payment without adding hidden support',()=>{
 const state=fixture();review(state,past,{sameSupporterAs:current});
 saveManualSupporter(state,{id:'manual:55555555-5555-4555-8555-555555555555',name:'Avery Lane',gross:2500,refunded:null,status:'paid',showName:true,showAmount:true,hidden:false,channel:'Cash',reference:'',processor:''});
 assert.deepEqual(lifetime(state),[{name:'Avery Lane',amount:282500,currency:'USD'}]);
 assert.equal(active(state)[0].amount,80000);assert.equal(state.supporterLedger.transactions[hiddenManual].hidden,true);
});

test('server-derived match proof survives removal of both reviewed anchor payments and covers newly synced owner records',()=>{
 const state=fixture();review(state,past,{sameSupporterAs:current,supporterIdentityPair:['client-forged:source','client-forged:target']});
 assert.deepEqual(state.supporterLedger.moderation[past].supporterIdentityPair,['public-owner:past-profile','public-owner:current-profile']);
 const futureCurrent=activity('crowdfundr-public:new-current','e2ozh2','Avery Lane',30000,'public-owner:current-profile',3);
 const futurePast=activity('crowdfundr-public:new-past','b2mXyf','Avery N Lane',40000,'public-owner:past-profile');
 state.supporterLedger.publicFeed.rows={[futureCurrent.id]:futureCurrent,[futurePast.id]:futurePast};
 assert.deepEqual(lifetime(state),[{name:'Avery Lane',amount:70000,currency:'USD'}]);
 assert.deepEqual(active(state),[{name:'Avery Lane',amount:30000,currency:'USD'}]);
 assert.equal(state.supporterLedger.transactions[hiddenManual].hidden,true);
 for(const encoded of [JSON.stringify(adminSupporters(state)),JSON.stringify(lifetime(state))]){
  for(const secret of ['supporterIdentityPair','public-owner:past-profile','public-owner:current-profile','client-forged'])assert.ok(!encoded.includes(secret));
 }
});

test('clearing or relinking a reviewed match removes or replaces its saved private proof',()=>{
 const state=fixture(),third=activity('crowdfundr-public:third-person','b2mXyf','A different reviewed person',5000,'public-owner:third-profile');
 state.supporterLedger.publicFeed.rows[third.id]=third;
 review(state,past,{sameSupporterAs:current});review(state,past,{sameSupporterAs:third.id});
 assert.deepEqual(state.supporterLedger.moderation[past].supporterIdentityPair,['public-owner:past-profile','public-owner:third-profile']);
 assert.deepEqual(lifetime(state).map(row=>row.amount).sort((a,b)=>a-b),[80000,205000]);
 review(state,past,{sameSupporterAs:''});
 assert.equal(Object.hasOwn(state.supporterLedger.moderation[past],'supporterIdentityPair'),false);
 assert.deepEqual(lifetime(state).map(row=>row.amount).sort((a,b)=>a-b),[5000,80000,200000]);
});

test('manual edits that change an existing moderation match also refresh the server-derived identity proof',()=>{
 const state=fixture();review(state,hiddenManual,{sameSupporterAs:current});
 const row=state.supporterLedger.transactions[hiddenManual];
 saveManualSupporter(state,{...row,sameSupporterAs:past});
 assert.deepEqual(state.supporterLedger.moderation[hiddenManual].supporterIdentityPair,[hiddenManual,'public-owner:past-profile']);
 assert.equal(state.supporterLedger.moderation[hiddenManual].sameSupporterAs,past);
 assert.equal(state.supporterLedger.transactions[hiddenManual].hidden,true);assert.equal(state.supporterLedger.transactions[hiddenManual].gross,200000);
 saveManualSupporter(state,{...row,sameSupporterAs:''});
 assert.equal(Object.hasOwn(state.supporterLedger.moderation[hiddenManual],'supporterIdentityPair'),false);
});
