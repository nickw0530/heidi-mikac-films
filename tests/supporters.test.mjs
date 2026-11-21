import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adminSupporters,publicSupporters,previewSupporterCsv,importSupporterCsv,saveManualSupporter,moderateSupporter,supporterIdentity,parseSupporterCsv} from '../netlify/lib/supporters.mjs';
import {recognitionSettings,supporterNames} from '../netlify/lib/merch.mjs';

const headers=['Date','Contribution amount','Recovered fee','Total amount','Net amount','Currency','Payment status','Transaction ID','Processed by','Contact email','Name','Show name','Show amount'];
const csv=(...rows)=>[headers,...rows.map(row=>headers.map(key=>({Date:'Nov 21, 2026 2:30:24 AM','Contribution amount':'10.00','Recovered fee':'1.12','Total amount':'11.12','Net amount':'9.74',Currency:'USD','Payment status':'Paid','Transaction ID':'TX001','Processed by':'PayPal','Contact email':'fictional@example.test',Name:'Fictional Supporter','Show name':'Yes','Show amount':'Yes',...row}[key])))].map(row=>row.map(value=>'"'+value.replaceAll('"','""')+'"').join(',')).join('\r\n');
const shop=()=>({sales:{}});
const imported=(state,text)=>{const preview=previewSupporterCsv(state,text);importSupporterCsv(state,{csv:text,digest:preview.digest});return preview;};
const manual=(overrides={})=>({id:'manual:11111111-1111-4111-8111-111111111111',name:'Fictional Supporter',gross:2500,refunded:null,status:'paid',showName:true,showAmount:true,hidden:false,channel:'Cash',reference:'',processor:'',...overrides});

test('CSV uses contribution gross, stores separate transactions and imports idempotently',()=>{
 const state=shop(),text=csv({}, {'Transaction ID':'TX002','Contribution amount':'25.00'});
 assert.equal(imported(state,text).summary.new,2);
 assert.deepEqual(publicSupporters(state),[{name:'Fictional Supporter',amount:3500,currency:'USD'}]);
 assert.equal(imported(state,text).summary.unchanged,2);
 assert.equal(adminSupporters(state).length,2);
 const data=JSON.stringify(state);
 for(const privateField of ['fictional@example.test','Recovered fee','Net amount','Total amount'])assert.ok(!data.includes(privateField));
 const publicData=JSON.stringify(publicSupporters(state));
 for(const secret of ['TX001','TX002','identity','reference','email','source'])assert.ok(!publicData.includes(secret));
});
test('verified repeat identity aggregates across changed display names, names alone never merge',()=>{
 const state=shop();
 imported(state,csv({}, {'Transaction ID':'TX002',Name:'Updated Public Name'}, {'Transaction ID':'TX003','Contact email':'other@example.test'}));
 const rows=publicSupporters(state);
 assert.equal(rows.length,2);assert.equal(rows.reduce((sum,row)=>sum+row.amount,0),3000);
 assert.deepEqual(rows.map(row=>row.amount).sort((a,b)=>a-b),[1000,2000]);
});
test('independent privacy flags fail closed and private contributions cannot identify public supporters',()=>{
 const state=shop();
 imported(state,csv({}, {'Transaction ID':'TX002','Show amount':'No'}, {'Transaction ID':'TX003','Show name':'No'}, {'Transaction ID':'TX004',Name:'','Show name':'Yes','Show amount':''}));
 const rows=publicSupporters(state);
 assert.equal(rows.length,3);
 assert.equal(rows.find(row=>row.name==='Fictional Supporter').amount,null);
 assert.deepEqual(rows.filter(row=>row.name==='Anonymous').map(row=>row.amount).sort(),[1000,null].sort());
});
test('refund/status reimports update instead of duplicating; unknown and partial refunds fail closed',()=>{
 const state=shop();imported(state,csv({}));
 assert.equal(imported(state,csv({'Payment status':'Refunded'})).summary.updated,1);
 assert.deepEqual(publicSupporters(state),[]);
 for(const status of ['Pending','Declined','Cancelled','reversed','Partially refunded','Unknown status']){
  const preview=imported(state,csv({'Payment status':status}));
  assert.equal(preview.summary.excluded,1);assert.deepEqual(publicSupporters(state),[]);
 }
 assert.equal(adminSupporters(state).length,1);
});
test('processor references dedupe website/import/manual and stale refunds never resurrect support',()=>{
 const state=shop();
 state.sales.ORDER={status:'paid',channel:'PayPal checkout',captureId:'TX001',subtotal:1000,total:1500,shipping:500,recognition:{public:true,name:'Public Buyer',showAmount:true}};
 imported(state,csv({}));
 saveManualSupporter(state,manual({gross:1000,processor:'paypal',reference:'TX001'}));
 assert.equal(publicSupporters(state).length,1);assert.equal(publicSupporters(state)[0].amount,1000);
 assert.equal(adminSupporters(state).length,3);
 imported(state,csv({'Payment status':'Refunded'}));assert.deepEqual(publicSupporters(state),[]);
});
test('a duplicate cannot bypass the original payment privacy or hidden setting',()=>{
 const state=shop();
 state.sales.ORDER={status:'paid',channel:'PayPal checkout',captureId:'TX001',subtotal:1000,recognition:{public:false}};
 imported(state,csv({}));assert.deepEqual(publicSupporters(state),[{name:'Anonymous',amount:null,currency:'USD'}]);
 moderateSupporter(state,{id:'website:ORDER',hidden:true});assert.deepEqual(publicSupporters(state),[]);
 moderateSupporter(state,{id:'website:ORDER',hidden:false});assert.equal(publicSupporters(state).length,1);
});
test('manual support supports verified cross-channel matches, edits, refund amounts and hide/unhide',()=>{
 const state=shop();imported(state,csv({}));
 saveManualSupporter(state,manual({identityEmail:' FICTIONAL@example.test '}));
 assert.equal(publicSupporters(state)[0].amount,3500);
 saveManualSupporter(state,manual({status:'partially refunded',refunded:500}));
 assert.equal(publicSupporters(state)[0].amount,3000);
 const importedId=adminSupporters(state).find(row=>row.source==='crowdfundr').id;
 saveManualSupporter(state,manual({sameSupporterAs:importedId}));
 saveManualSupporter(state,manual({gross:3000}));
 assert.equal(state.supporterLedger.transactions[manual().id].sameSupporterAs,importedId);
 moderateSupporter(state,{id:manual().id,hidden:true});assert.equal(publicSupporters(state)[0].amount,1000);
 moderateSupporter(state,{id:manual().id,hidden:false});assert.equal(publicSupporters(state)[0].amount,4000);
 assert.throws(()=>saveManualSupporter(state,manual({status:'partially refunded'})),{status:400});
 assert.throws(()=>saveManualSupporter(state,manual({showName:true,name:''})),{status:400});
 assert.throws(()=>saveManualSupporter(state,manual({identityEmail:'invalid'})),{status:400});
});
test('explicit duplicate review excludes one payment and can be reversed',()=>{
 const state=shop();saveManualSupporter(state,manual());
 const id='manual:22222222-2222-4222-8222-222222222222';saveManualSupporter(state,manual({id}));
 assert.equal(publicSupporters(state).length,2);
 moderateSupporter(state,{id,hidden:false,duplicateOf:manual().id});assert.equal(publicSupporters(state).length,1);
 moderateSupporter(state,{id,hidden:false,duplicateOf:''});assert.equal(publicSupporters(state).length,2);
 assert.throws(()=>moderateSupporter(state,{id,hidden:false,duplicateOf:id}));
});
test('CSV parser supports BOM, escaped quotes and multiline quoted fields; rejects malformed/ambiguous uploads atomically',()=>{
 const text='\uFEFF'+csv({Name:'Fictional, "Friend"'});
 assert.equal(parseSupporterCsv(text)[0].Name,'Fictional, "Friend"');
 assert.throws(()=>parseSupporterCsv('a,b\r\n"line\nline",two'),/Missing CSV column/);
 const multiline=csv({})+',extra';assert.throws(()=>parseSupporterCsv(multiline),/column count/);
});
test('invalid CSV files leave ledger unchanged and duplicate IDs are conflict checked',()=>{
 const state=shop();
 for(const text of [csv({Currency:'EUR'}),csv({'Transaction ID':''}),csv({'Contribution amount':'1e3'}),csv({Name:'<script>'}),csv({'Contact email':'bad'}),'a,a\n1,2',csv({})+'\n"unfinished']){
  assert.throws(()=>imported(state,text));assert.deepEqual(state,shop());
 }
 assert.equal(imported(state,csv({},{})).summary.duplicates,1);
 assert.throws(()=>previewSupporterCsv(state,csv({}, {'Contribution amount':'20.00'})),/Conflicting/);
 assert.throws(()=>importSupporterCsv(state,{csv:csv({}),digest:'wrong'}),{status:409});
});
test('website amounts require separate consent and exclude shipping; no hard limit on supporters',()=>{
 const state=shop();
 for(let i=0;i<45;i++)state.sales['ORDER'+i]={status:'paid',total:4500,shipping:500,recognition:{public:true,name:'Person '+i,showAmount:i!==0}};
 const rows=publicSupporters(state);assert.equal(rows.length,45);assert.equal(rows.find(row=>row.name==='Person 0').amount,null);assert.equal(rows.find(row=>row.name==='Person 1').amount,4000);
 assert.deepEqual(recognitionSettings({public:false,showAmount:true}),{public:false,name:'',showAmount:true});
 assert.throws(()=>recognitionSettings({public:false,showAmount:'yes'}));
 assert.equal(supporterIdentity(' Test@EXAMPLE.test '),supporterIdentity('test@example.test'));
});
test('legacy names response cannot bypass cross-channel privacy, refunds or moderation',()=>{
 const state=shop();
 state.sales.ORDER={status:'paid',channel:'PayPal checkout',captureId:'TX001',subtotal:1000,recognition:{public:true,name:'Public Buyer',showAmount:true}};
 assert.deepEqual(supporterNames(state),['Public Buyer']);
 imported(state,csv({'Show name':'No'}));
 assert.deepEqual(supporterNames(state),[]);
 assert.deepEqual(publicSupporters(state),[{name:'Anonymous',amount:1000,currency:'USD'}]);
 imported(state,csv({'Payment status':'Refunded'}));
 assert.deepEqual(supporterNames(state),[]);
});
test('normalization cannot introduce forbidden markup into CSV or manual names',()=>{
 const state=shop();
 assert.throws(()=>imported(state,csv({Name:'\uFF1Cscript\uFF1E'})),/plain text/);
 assert.deepEqual(state,shop());
 assert.throws(()=>saveManualSupporter(state,manual({name:'\uFF1Cscript\uFF1E'})),/plain text/);
});
test('opaque processor reference case remains significant',()=>{
 const state=shop();
 const preview=imported(state,csv({'Processed by':'Stripe','Transaction ID':'ch_AbC'},{'Processed by':'Stripe','Transaction ID':'ch_abc'}));
 assert.equal(preview.summary.new,2);assert.equal(preview.summary.duplicates,0);
 assert.equal(adminSupporters(state).length,2);assert.equal(publicSupporters(state)[0].amount,2000);
 assert.equal(imported(state,csv({'Processed by':'Stripe','Transaction ID':'ch_AbC'},{'Processed by':'Stripe','Transaction ID':'ch_abc'})).summary.unchanged,2);
});
test('manual form can unhide a record previously hidden with the table action',()=>{
 const state=shop();saveManualSupporter(state,manual());
 moderateSupporter(state,{id:manual().id,hidden:true});assert.deepEqual(publicSupporters(state),[]);
 saveManualSupporter(state,manual({hidden:false}));
 assert.deepEqual(publicSupporters(state),[{name:'Fictional Supporter',amount:2500,currency:'USD'}]);
});
test('stale CSV reimports cannot reverse terminal refunds and preview explains retention',()=>{
 for(const status of ['Refunded','Partially refunded']){
  const state=shop();imported(state,csv({'Payment status':status}));
  const preview=previewSupporterCsv(state,csv({}));
  assert.match(preview.rows[0].warning,/refund was retained/);
  assert.equal(preview.rows[0].status,status.toLowerCase());assert.equal(preview.summary.excluded,1);
  imported(state,csv({}));assert.deepEqual(publicSupporters(state),[]);
  imported(state,csv({'Payment status':'Refunded'}));
  imported(state,csv({'Payment status':'Partially refunded'}));
  assert.equal(adminSupporters(state)[0].status,'refunded');
 }
});
test('manual refund fields cannot silently contradict payment status',()=>{
 for(const status of ['paid','pending','failed'])assert.throws(()=>saveManualSupporter(shop(),manual({status,refunded:500})),/refunded status/);
 assert.throws(()=>saveManualSupporter(shop(),manual({status:'refunded',refunded:500})),/original gross amount/);
 const state=shop();saveManualSupporter(state,manual({status:'refunded',refunded:2500}));assert.deepEqual(publicSupporters(state),[]);
 saveManualSupporter(state,manual({status:'refunded',refunded:null}));assert.deepEqual(publicSupporters(state),[]);
 saveManualSupporter(state,manual({status:'partially refunded',refunded:500}));assert.equal(publicSupporters(state)[0].amount,2000);
});
