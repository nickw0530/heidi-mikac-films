import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adminSupporters,publicSupporters,previewSupporterCsv,importSupporterCsv,saveManualSupporter,moderateSupporter,supporterIdentity,parseSupporterCsv} from '../netlify/lib/supporters.mjs';
import {recognitionSettings,supporterNames} from '../netlify/lib/merch.mjs';

const headers=['Date','Contribution amount','Recovered fee','Total amount','Net amount','Currency','Payment status','Transaction ID','Processed by','Contact email','Name','Show name','Show amount'];
const csv=(...rows)=>[headers,...rows.map(row=>headers.map(key=>({Date:'Nov 21, 2026 2:30:24 AM','Contribution amount':'10.00','Recovered fee':'1.12','Total amount':'11.12','Net amount':'9.74',Currency:'USD','Payment status':'Paid','Transaction ID':'TX001','Processed by':'PayPal','Contact email':'fictional@example.test',Name:'Fictional Supporter','Show name':'Yes','Show amount':'Yes',...row}[key])))].map(row=>row.map(value=>'"'+value.replaceAll('"','""')+'"').join(',')).join('\r\n');
const shop=()=>({sales:{}});
const imported=(state,text)=>{const preview=previewSupporterCsv(state,text);importSupporterCsv(state,{csv:text,digest:preview.digest});return preview;};
const manual=(overrides={})=>({id:'manual:11111111-1111-4111-8111-111111111111',name:'Fictional Supporter',gross:2500,refunded:null,status:'paid',showName:true,showAmount:true,hidden:false,channel:'Cash',reference:'',processor:'',...overrides});
const publicActivity=(overrides={})=>({id:'crowdfundr-public:example',source:'crowdfundr-public',reference:'public-activity',processor:'',channel:'Crowdfundr public activity',status:'public',gross:1000,refunded:null,name:'Public Supporter',showName:true,showAmount:true,identity:'public-owner:verified',hidden:false,date:1,...overrides});
const withPublicActivities=(state,rows)=>{
 state.supporterLedger??={transactions:{},moderation:{}};
 state.supporterLedger.publicFeed={enabled:true,checkedAt:Date.now(),rows:Object.fromEntries(rows.map(row=>[row.id,row]))};
 return state;
};

test('public campaign mode replaces CSV recognition while retaining the audit ledger and manual/website credits',()=>{
 const state=shop();imported(state,csv({}));saveManualSupporter(state,manual({gross:50000}));
 state.sales.ORDER={status:'paid',total:4500,shipping:500,recognition:{public:true,name:'Website Buyer',showAmount:true}};
 const original=structuredClone(state.supporterLedger.transactions);
 state.supporterLedger.publicFeed={enabled:true,checkedAt:Date.now(),rows:{example:publicActivity()}};
 const rows=publicSupporters(state);
 assert.equal(rows.length,3);assert.equal(rows.reduce((sum,row)=>sum+row.amount,0),55000);
 assert.deepEqual(state.supporterLedger.transactions,original);assert.equal(adminSupporters(state).length,4);
 state.supporterLedger.publicFeed.enabled=false;
 assert.ok(publicSupporters(state).some(row=>row.name==='Fictional Supporter'&&row.amount===51000));
});
test('private public-feed amounts remain credits without exposing a zero or an imported private value',()=>{
 const state=shop();state.supporterLedger={transactions:{},moderation:{},publicFeed:{enabled:true,checkedAt:Date.now(),rows:{
  example:publicActivity({gross:0,showAmount:false}),anonymous:publicActivity({id:'crowdfundr-public:anon',showName:false,name:'Must never appear',gross:0,showAmount:false})
 }}};
 assert.deepEqual(publicSupporters(state),[{name:'Anonymous',amount:null,currency:'USD'},{name:'Public Supporter',amount:null,currency:'USD'}]);
});
test('public profile identities aggregate repeats without merging unrelated equal display names',()=>{
 const state=shop();state.supporterLedger={transactions:{},moderation:{},publicFeed:{enabled:true,checkedAt:Date.now(),rows:{
  first:publicActivity(),second:publicActivity({id:'crowdfundr-public:second',gross:2500}),third:publicActivity({id:'crowdfundr-public:third',identity:'public-owner:other-verified',gross:500})
 }}};
 assert.deepEqual(publicSupporters(state).map(row=>row.amount).sort((a,b)=>a-b),[500,3500]);
});
test('admin hiding applies to public activity and stale privacy cannot fall back to CSV names',()=>{
 const state=shop();imported(state,csv({}));state.supporterLedger.publicFeed={enabled:true,checkedAt:Date.now(),rows:{example:publicActivity()}};
 moderateSupporter(state,{id:'crowdfundr-public:example',hidden:true});assert.deepEqual(publicSupporters(state),[]);
 moderateSupporter(state,{id:'crowdfundr-public:example',hidden:false});assert.equal(publicSupporters(state).length,1);
 state.supporterLedger.publicFeed.checkedAt=Date.now()-300001;
 assert.deepEqual(publicSupporters(state),[]);assert.equal(adminSupporters(state).length,2);
});

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
test('verified repeat identity aggregates across changed display names while different verified people stay separate',()=>{
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
 assert.deepEqual(publicSupporters(state),[{name:'Fictional Supporter',amount:5000,currency:'USD'}]);
 assert.equal(adminSupporters(state).length,2,'Both distinct payment records remain in the audit ledger.');
 moderateSupporter(state,{id,hidden:false,duplicateOf:manual().id});assert.deepEqual(publicSupporters(state),[{name:'Fictional Supporter',amount:2500,currency:'USD'}]);
 moderateSupporter(state,{id,hidden:false,duplicateOf:''});assert.deepEqual(publicSupporters(state),[{name:'Fictional Supporter',amount:5000,currency:'USD'}]);
 assert.equal(adminSupporters(state).length,2);
 assert.throws(()=>moderateSupporter(state,{id,hidden:false,duplicateOf:id}));
});

test('same public name combines manual and native campaign support for every supporter without changing payments',()=>{
 for(const name of ['Gary Howard','Another Film Supporter']){
  const state=shop();saveManualSupporter(state,manual({name,gross:2000}));
  withPublicActivities(state,[publicActivity({name,gross:800})]);
  const before=structuredClone(state);
  assert.deepEqual(publicSupporters(state),[{name,amount:2800,currency:'USD'}]);
  assert.deepEqual(state,before,'Public name aggregation does not rewrite source transactions or introduce identity links.');
  assert.equal(adminSupporters(state).length,2);
  assert.deepEqual(adminSupporters(state).map(row=>row.gross).sort((a,b)=>a-b),[800,2000]);
 }
});

test('an unambiguous public campaign owner and verified email combine across channels by public name',()=>{
 const state=shop();saveManualSupporter(state,manual({name:'Gary Howard',gross:2000,identityEmail:'gary@example.test'}));
 withPublicActivities(state,[publicActivity({name:'Gary Howard',gross:800,identity:'public-owner:gary'})]);
 assert.deepEqual(publicSupporters(state),[{name:'Gary Howard',amount:2800,currency:'USD'}]);
 assert.equal(adminSupporters(state).length,2);
 const persisted=JSON.parse(JSON.stringify(state));
 assert.deepEqual(publicSupporters(persisted),[{name:'Gary Howard',amount:2800,currency:'USD'}],'Aggregation survives a persisted ledger reload.');
});

test('public-name aggregation normalizes case, NFKC characters and repeated whitespace',()=>{
 const state=shop();saveManualSupporter(state,manual({name:'  Gary   Howard  ',gross:2000}));
 withPublicActivities(state,[publicActivity({name:'ｇＡＲＹ　 ｈＯＷＡＲＤ',gross:800})]);
 const rows=publicSupporters(state);
 assert.equal(rows.length,1);assert.equal(rows[0].amount,2800);
 assert.equal(rows[0].name.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase(),'gary howard');
});

test('repeat native activities add to the same cumulative manual and campaign credit after snapshot replacement',()=>{
 const state=shop();saveManualSupporter(state,manual({name:'Gary Howard',gross:2000}));
 const first=publicActivity({name:'Gary Howard',gross:800,identity:'public-owner:gary'});
 withPublicActivities(state,[first]);assert.equal(publicSupporters(state)[0].amount,2800);
 const second=publicActivity({id:'crowdfundr-public:gary-repeat',reference:'gary-repeat',name:'Gary Howard',gross:500,identity:'public-owner:gary',date:2});
 withPublicActivities(state,[first,second]);
 assert.deepEqual(publicSupporters(state),[{name:'Gary Howard',amount:3300,currency:'USD'}]);
 assert.equal(adminSupporters(state).length,3);
 withPublicActivities(state,[structuredClone(first),structuredClone(second)]);
 assert.equal(publicSupporters(JSON.parse(JSON.stringify(state)))[0].amount,3300,'Replacing or reloading the snapshot does not count an activity twice.');
});

test('different verified email identities with the same public name remain different people',()=>{
 const state=shop();saveManualSupporter(state,manual({name:'Same Public Name',gross:2000,identityEmail:'one@example.test'}));
 saveManualSupporter(state,manual({id:'manual:22222222-2222-4222-8222-222222222222',name:'Same Public Name',gross:800,identityEmail:'two@example.test'}));
 assert.deepEqual(publicSupporters(state).map(row=>row.amount).sort((a,b)=>a-b),[800,2000]);
 assert.equal(adminSupporters(state).length,2);
});

test('different public campaign owner identities with the same name remain different people',()=>{
 const state=withPublicActivities(shop(),[
  publicActivity({name:'Same Public Name',gross:2000,identity:'public-owner:first'}),
  publicActivity({id:'crowdfundr-public:second-owner',reference:'second-owner',name:'Same Public Name',gross:800,identity:'public-owner:second'})
 ]);
 assert.deepEqual(publicSupporters(state).map(row=>row.amount).sort((a,b)=>a-b),[800,2000]);
});

test('name aggregation preserves independent private-name and private-amount choices',()=>{
 const state=shop();saveManualSupporter(state,manual({name:'Gary Howard',gross:2000}));
 const publicRow=publicActivity({name:'Gary Howard',gross:800});
 withPublicActivities(state,[{...publicRow,showAmount:false,gross:0}]);
 assert.deepEqual(publicSupporters(state),[{name:'Gary Howard',amount:null,currency:'USD'}]);
 withPublicActivities(state,[{...publicRow,showName:false,name:'Private source name'}]);
 assert.deepEqual(publicSupporters(state).map(row=>[row.name,row.amount]).sort(),[['Anonymous',800],['Gary Howard',2000]].sort());
 saveManualSupporter(state,manual({name:'Gary Howard',gross:2000,showName:false}));
 withPublicActivities(state,[{...publicRow,showName:false,name:'Another private source name'}]);
 const anonymous=publicSupporters(state);
 assert.equal(anonymous.length,2);assert.ok(anonymous.every(row=>row.name==='Anonymous'));
 assert.deepEqual(anonymous.map(row=>row.amount).sort((a,b)=>a-b),[800,2000]);
 assert.ok(!JSON.stringify(anonymous).includes('Private source name'));
});

test('an explicit supporter match cannot expose an anonymous contribution through a named group-key collision',()=>{
 const anonymous=publicActivity({id:'crowdfundr-public:anonymous-match',reference:'anonymous-match',name:'Private source name',identity:'',showName:false,gross:100});
 const state=withPublicActivities(shop(),[anonymous]);
 saveManualSupporter(state,manual({name:'Named Supporter',gross:50,sameSupporterAs:anonymous.id}));
 const before=structuredClone(state);
 assert.deepEqual(publicSupporters(state).map(row=>[row.name,row.amount]).sort(),[['Anonymous',100],['Named Supporter',50]].sort());
 assert.deepEqual(state,before,'The public projection preserves the explicit admin match without publishing the private contribution under its name.');
 assert.equal(adminSupporters(state).length,2);
});

test('processor duplicate privacy and exclusions cannot create a hidden alias bridge between public credits',async t=>{
 for(const [label,overrides] of [
  ['private-name copy',{showName:false}],['hidden copy',{hidden:true}],['refunded copy',{status:'refunded'}]
 ])await t.test(label,()=>{
  const state=shop(),identity=supporterIdentity('alpha@example.test');
  state.sales.ALPHA={status:'paid',channel:'PayPal checkout',captureId:'ALPHA-PAYMENT',subtotal:2000,supporterIdentity:identity,recognition:{public:true,name:'Alpha',showAmount:true},paidAt:10};
  state.sales.ALIAS={status:'paid',channel:'PayPal checkout',captureId:'ALIAS-PAYMENT',subtotal:1000,supporterIdentity:identity,recognition:{public:true,name:'Beta',showAmount:true},paidAt:20};
  saveManualSupporter(state,manual({name:'Beta',gross:1000,processor:'paypal',reference:'ALIAS-PAYMENT',identityEmail:'alpha@example.test',...overrides}));
  withPublicActivities(state,[publicActivity({name:'Beta',gross:800,identity:'public-owner:unrelated-beta',date:30})]);
  const before=structuredClone(state),rows=publicSupporters(state);
  const expected=[['Alpha',2000],['Beta',800],...(label==='private-name copy'?[['Anonymous',1000]]:[])];
  assert.deepEqual(rows.map(row=>[row.name,row.amount]).sort(),expected.sort(),'An alias removed by effective processor privacy/status cannot join otherwise different public names.');
  assert.equal(adminSupporters(state).length,4,'Duplicate snapshots remain auditable even when their public credit is restricted.');
  assert.deepEqual(state,before,'The public projection does not change payment records.');
 });
});

test('a public alias cannot transitively join two different verified owners from the same provider',()=>{
 const state=shop(),identity=supporterIdentity('alias-person@example.test');
 state.sales.ALPHA={status:'paid',subtotal:2000,supporterIdentity:identity,recognition:{public:true,name:'Alpha',showAmount:true},paidAt:10};
 state.sales.BETA={status:'paid',subtotal:1000,supporterIdentity:identity,recognition:{public:true,name:'Beta',showAmount:true},paidAt:20};
 withPublicActivities(state,[
  publicActivity({name:'Alpha',gross:800,identity:'public-owner:first-person',date:30}),
  publicActivity({id:'crowdfundr-public:beta-person',reference:'beta-person',name:'Beta',gross:500,identity:'public-owner:second-person',date:40})
 ]);
 const rows=publicSupporters(state);
 assert.equal(rows.length,2,'The shared email alias can connect one channel owner while a conflicting owner remains a separate person.');
 assert.equal(rows.reduce((total,row)=>total+row.amount,0),4300);
 assert.ok(rows.every(row=>row.amount<4300),'Transitive name matching cannot merge known different public owners.');
 assert.equal(adminSupporters(state).length,4);
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
