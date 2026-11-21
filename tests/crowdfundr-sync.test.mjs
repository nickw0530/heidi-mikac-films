import test from 'node:test';
import assert from 'node:assert/strict';
import {readShop,updateShop} from '../netlify/lib/merch.mjs';
import {adminSupporters,publicSupporters,previewSupporterCsv,importSupporterCsv} from '../netlify/lib/supporters.mjs';
import {syncCrowdfundr,safeSyncStatus,crowdfundrPayment} from '../netlify/lib/crowdfundr-sync.mjs';

function memoryStore(){
 const records=new Map();let version=0,writes=0;
 return {
  get writes(){return writes;},
  async get(key){return structuredClone(records.get(key)?.data);},
  async getWithMetadata(key){return structuredClone(records.get(key));},
  async setJSON(key,data,options={}){
   const old=records.get(key);
   if(options.onlyIfNew&&old||options.onlyIfMatch&&old?.etag!==options.onlyIfMatch)return {modified:false};
   const etag=String(++version);records.set(key,{data:structuredClone(data),etag});writes++;
   return {modified:true,etag};
  },
  async delete(key){records.delete(key);}
 };
}
const payment=(changes={})=>({id:'PAYMENT-1',transaction_id:'REFERENCE-1',campaign_id:'e2ozh2',account:'paypal',currency:'USD',amount:10,status:'completed',created:1700000000,payer_name:'Fictional Supporter',contact_email:'fictional@example.test',show_name:true,show_amount:true,...changes});
const csv=(reference='REFERENCE-1')=>'Date,Contribution amount,Currency,Payment status,Transaction ID,Processed by,Contact email,Name,Show name,Show amount\n"Nov 21, 2026 2:30:24 AM",10.00,USD,Paid,'+reference+',PayPal,fictional@example.test,Fictional Supporter,Yes,Yes';
async function fixture({imported=false,connected=true}={}){
 const raw=memoryStore(),shop=memoryStore();
 await readShop(shop);
 await raw.setJSON('crowdfundr/config',{clientId:'123'});
 if(connected)await raw.setJSON('crowdfundr/connection',{accessToken:'super-secret-access-token',clientId:'123',campaignId:'e2ozh2',connectedAt:1700000000000});
 if(imported)await updateShop(shop,state=>{const text=csv(),preview=previewSupporterCsv(state,text);importSupporterCsv(state,{csv:text,digest:preview.digest});});
 return {raw,shop,state:async()=>(await readShop(shop)).shop};
}
const onePage=rows=>async()=>Response.json({entries:rows});
const deferred=()=>{let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve:value=>resolve(value)};};

test('complete API pagination reconciles canonical CSV IDs and repeats without duplicate credits or writes',async()=>{
 const f=await fixture({imported:true}),requests=[];
 const second=payment({id:'PAYMENT-2',transaction_id:'REFERENCE-2',amount:25});
 const fetcher=async(url,options)=>{
  const query=new URL(url);requests.push(query);
  assert.equal(query.origin,'https://api.connectionpoint.com');assert.equal(query.searchParams.get('campaign'),'e2ozh2');
  assert.equal(query.searchParams.get('limit'),'50');assert.equal(options.headers.Authorization,'Bearer super-secret-access-token');assert.equal(options.redirect,'error');
  return Response.json(query.searchParams.has('after')?{entries:[second]}:{entries:[payment()],after_cursor:'page-two'});
 };
 const result=await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher});
 assert.equal(result.active,true);assert.equal(result.paymentCount,2);
 assert.equal(requests.length,2);assert.equal(requests[1].searchParams.get('after'),'page-two');
 let state=await f.state();
 assert.equal(Object.keys(state.supporterLedger.transactions)[0],crowdfundrPayment(payment()).id);
 assert.equal(adminSupporters(state).length,2);assert.deepEqual(publicSupporters(state),[{name:'Fictional Supporter',amount:3500,currency:'USD'}]);
 const writes=f.shop.writes;
 const repeat=await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher});
 assert.equal(repeat.added,0);assert.equal(repeat.updated,0);assert.equal(f.shop.writes,writes);
 state=await f.state();assert.equal(adminSupporters(state).length,2);
 assert.ok(!JSON.stringify(state).includes('fictional@example.test'),'Contacts are hashed before persistence.');
});

test('current API name and amount choices independently replace imported consent',async()=>{
 const f=await fixture({imported:true});
 await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:onePage([payment()])});
 await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:onePage([payment({show_name:false})])});
 assert.deepEqual(publicSupporters(await f.state()),[{name:'Anonymous',amount:1000,currency:'USD'}]);
 await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:onePage([payment({show_amount:false})])});
 assert.deepEqual(publicSupporters(await f.state()),[{name:'Fictional Supporter',amount:null,currency:'USD'}]);
 await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:onePage([payment({show_name:false,show_amount:false})])});
 assert.deepEqual(publicSupporters(await f.state()),[{name:'Anonymous',amount:null,currency:'USD'}]);
});

test('initial missing privacy fields preserve the CSV ledger exactly and do not activate public synchronization',async()=>{
 const f=await fixture({imported:true}),before=await f.state(),writes=f.shop.writes;
 const row=payment();delete row.show_amount;
 const result=await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:onePage([row])});
 assert.equal(result.privacyReady,false);assert.equal(result.active,false);assert.match(result.lastError,/privacy fields|privacy|Show name/);
 assert.deepEqual(await f.state(),before);assert.equal(f.shop.writes,writes);
 assert.deepEqual(publicSupporters(await f.state()),[{name:'Fictional Supporter',amount:1000,currency:'USD'}]);
});

test('loss of current flags after API activation withholds managed credits until privacy returns',async()=>{
 const f=await fixture({imported:true});
 await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:onePage([payment()])});
 const row=payment();delete row.show_name;
 await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:onePage([row])});
 assert.deepEqual(publicSupporters(await f.state()),[]);
 assert.equal(adminSupporters(await f.state())[0].hidden,true);
 assert.match(adminSupporters(await f.state())[0].warning,/withheld/);
 await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:onePage([payment({show_name:false})])});
 assert.deepEqual(publicSupporters(await f.state()),[{name:'Anonymous',amount:1000,currency:'USD'}]);
});

test('full-ledger reconciliation revisits older refunds/statuses and never resurrects confirmed refunds',async()=>{
 const f=await fixture(),second=payment({id:'PAYMENT-2',transaction_id:'REFERENCE-2',contact_email:'other@example.test'});
 await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:onePage([payment(),second])});
 assert.equal(publicSupporters(await f.state()).length,2);
 await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:onePage([payment({status:'refunded'}),{...second,status:'preapproved'}])});
 assert.deepEqual(publicSupporters(await f.state()),[]);
 await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:onePage([payment(),second])});
 const rows=adminSupporters(await f.state());
 assert.equal(rows.find(row=>row.reference==='REFERENCE-1').status,'refunded');
 assert.deepEqual(publicSupporters(await f.state()),[{name:'Fictional Supporter',amount:1000,currency:'USD'}]);
 for(const status of ['cancelled','partially_refunded','unrecognized-future-status']){
  await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:onePage([payment({id:'STATUS-'+status,transaction_id:'STATUS-'+status,status})])});
  assert.deepEqual(publicSupporters(await f.state()),[]);
 }
});

test('a previously managed payment missing from a later complete response is withheld',async()=>{
 const f=await fixture({imported:true});
 await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:onePage([payment()])});
 const result=await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:onePage([])});
 assert.equal(result.unavailable,1);assert.deepEqual(publicSupporters(await f.state()),[]);
 assert.equal(adminSupporters(await f.state()).length,1);
});

test('malformed amounts/currencies/campaigns/references and conflicting provider IDs fail atomically',async t=>{
 const cases=[
  ['fractional cents',payment({id:'INVALID',transaction_id:'INVALID',amount:1.001})],['string amount',payment({id:'INVALID',transaction_id:'INVALID',amount:'10.00'})],['currency',payment({id:'INVALID',transaction_id:'INVALID',currency:'CAD'})],
  ['campaign',payment({id:'INVALID',transaction_id:'INVALID',campaign_id:'different'})],['missing reference',payment({id:'INVALID',transaction_id:''})],['markup name',payment({id:'INVALID',transaction_id:'INVALID',payer_name:'<img>'})],
  ['same API ID',payment()],['conflicting processor reference',payment({id:'PAYMENT-2'})]
 ];
 for(const [label,invalid] of cases)await t.test(label,async()=>{
  const f=await fixture({imported:true}),before=await f.state(),writes=f.shop.writes;
  const result=await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:onePage([payment(),invalid])});
  assert.equal(result.active,false);assert.ok(result.lastError);
  assert.deepEqual(await f.state(),before);assert.equal(f.shop.writes,writes);
 });
});

test('repeated pagination and more than ten pages fail without committing a partial ledger',async t=>{
 for(const repeat of [true,false])await t.test(repeat?'repeated cursor':'page cap',async()=>{
  const f=await fixture({imported:true}),before=await f.state();let calls=0;
  const result=await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:async()=>{
   calls++;return Response.json({entries:[payment({id:'PAGE-'+calls,transaction_id:'PAGE-'+calls})],after_cursor:repeat?'same-cursor':'cursor-'+calls});
  }});
  assert.equal(result.active,false);assert.ok(result.lastError);assert.equal(calls,repeat?2:10);assert.deepEqual(await f.state(),before);
 });
});

test('safe status contains only progress, schema field names, and sanitized errors',async()=>{
 const f=await fixture();
 await f.raw.setJSON('crowdfundr/sync',{accessToken:'super-secret-access-token',contact_email:'contact@example.test',rawBody:'private provider body',transactionId:'PRIVATE-REFERENCE',fieldNames:['amount']});
 const row=payment({private_payload:'raw private body',private_email:'contact@example.test'});
 const result=await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:onePage([row])});
 const safe=JSON.stringify(await safeSyncStatus(f.raw));
 assert.equal(result.active,true);assert.ok(safe.includes('private_payload'));
 for(const secret of ['super-secret-access-token','fictional@example.test','contact@example.test','raw private body','private provider body','REFERENCE-1','PAYMENT-1','PRIVATE-REFERENCE'])assert.ok(!safe.includes(secret),secret);
 const network=await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:async()=>{throw Error('super-secret-access-token contact@example.test private body');}});
 for(const secret of ['super-secret-access-token','contact@example.test','private body'])assert.ok(!network.lastError.includes(secret));
 const statusError=await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:async()=>{throw Object.assign(Error('super-secret-access-token contact@example.test private body'),{status:503});}});
 for(const secret of ['super-secret-access-token','contact@example.test','private body'])assert.ok(!statusError.lastError.includes(secret),'A status-bearing transport error must remain private: '+secret);
});

test('one concurrent reconciliation owns the CAS lease and scheduled retry respects nextSync',async()=>{
 const f=await fixture(),started=deferred(),release=deferred();let calls=0;
 const fetcher=async()=>{calls++;started.resolve();await release.promise;return Response.json({entries:[payment()]});};
 const first=syncCrowdfundr(f.raw,f.shop,{force:true,fetcher});await started.promise;
 const second=await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher});
 assert.equal(second.busy,true);assert.equal(calls,1);
 release.resolve();assert.equal((await first).active,true);
 const scheduled=await syncCrowdfundr(f.raw,f.shop,{fetcher});assert.equal(calls,1);assert.equal(scheduled.active,true);
 const lease=await f.raw.get('crowdfundr/lease');assert.equal(lease.until,0);
});

test('disconnects and changed connections cannot apply a stale reconciliation or leak credentials',async t=>{
 await t.test('already disconnected',async()=>{
  const f=await fixture({connected:false});let calls=0;
  assert.equal((await syncCrowdfundr(f.raw,f.shop,{fetcher:async()=>{calls++;}})).connected,false);assert.equal(calls,0);
 });
 for(const disconnected of [true,false])await t.test(disconnected?'disconnected during fetch':'token replaced during fetch',async()=>{
  const f=await fixture({imported:true}),before=await f.state(),started=deferred(),release=deferred();
  const running=syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:async()=>{started.resolve();await release.promise;return Response.json({entries:[payment({show_name:false})]});}});
  await started.promise;
  if(disconnected)await f.raw.delete('crowdfundr/connection');else await f.raw.setJSON('crowdfundr/connection',{accessToken:'replacement-secret',campaignId:'e2ozh2'});
  release.resolve();const result=await running;
  assert.match(result.lastError,/connection changed/);assert.deepEqual(await f.state(),before);
  assert.equal(await f.raw.get('crowdfundr/sync'),undefined,'The stale attempt cannot overwrite current connection status.');
  assert.ok(!JSON.stringify(result).includes('replacement-secret'));
 });
});

test('unapproved client configuration and expired authorization never fetch provider records',async t=>{
 for(const [label,prepare] of [
  ['client ID mismatch',async f=>f.raw.setJSON('crowdfundr/config',{clientId:'different'})],
  ['missing client configuration',async f=>f.raw.delete('crowdfundr/config')],
  ['expired authorization',async f=>f.raw.setJSON('crowdfundr/connection',{accessToken:'super-secret-access-token',clientId:'123',campaignId:'e2ozh2',connectedAt:1700000000000,expiresAt:Date.now()-1})]
 ])await t.test(label,async()=>{
  const f=await fixture({imported:true}),before=await f.state();let calls=0;
  await prepare(f);
  const result=await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:async()=>{calls++;}});
  assert.equal(calls,0);assert.equal(result.active,false);assert.equal(result.connected,false);assert.deepEqual(await f.state(),before);
 });
});

test('changing approved client configuration while fetching prevents stale ledger writes',async()=>{
 const f=await fixture({imported:true}),before=await f.state(),started=deferred(),release=deferred();
 const running=syncCrowdfundr(f.raw,f.shop,{force:true,fetcher:async()=>{started.resolve();await release.promise;return Response.json({entries:[payment({show_name:false})]});}});
 await started.promise;await f.raw.setJSON('crowdfundr/config',{clientId:'replacement-client'});
 release.resolve();const result=await running;
 assert.equal(result.active,false);assert.match(result.lastError,/connection changed/);assert.deepEqual(await f.state(),before);
});

test('provider HTTP failures, invalid JSON and repeated IDs across pages retain the complete last ledger',async t=>{
 const cases=[
  ['401',async()=>new Response('private provider body token=super-secret-access-token',{status:401})],
  ['429',async()=>new Response('private provider body contact@example.test',{status:429})],
  ['invalid JSON',async()=>new Response('private provider body contact@example.test',{status:200})],
  ['invalid page',async()=>Response.json({entries:{private:'private provider body'}})],
  ['duplicate ID across pages',async url=>Response.json(new URL(url).searchParams.has('after')?{entries:[payment()]}:{entries:[payment()],after_cursor:'next'})]
 ];
 for(const [label,fetcher] of cases)await t.test(label,async()=>{
  const f=await fixture({imported:true}),before=await f.state();
  const result=await syncCrowdfundr(f.raw,f.shop,{force:true,fetcher});
  assert.equal(result.active,false);assert.ok(result.lastError);assert.deepEqual(await f.state(),before);
  const safe=JSON.stringify(await safeSyncStatus(f.raw));
  for(const secret of ['private provider body','super-secret-access-token','contact@example.test'])assert.ok(!safe.includes(secret));
 });
});

test('scheduled function rejects local, preview, and unpublished deploys before opening production stores',async()=>{
 const {default:run,config}=await import('../netlify/functions/crowdfundr-sync.mjs');
 assert.equal(config.schedule,'*/2 * * * *');
 const oldContext=process.env.CONTEXT,oldDev=process.env.NETLIFY_DEV;
 try{
  process.env.NETLIFY_DEV='true';assert.equal(await run(),undefined);
  delete process.env.NETLIFY_DEV;process.env.CONTEXT='deploy-preview';assert.equal(await run(),undefined);
  process.env.CONTEXT='production';assert.equal(await run(null,{deploy:{published:false}}),undefined);
 }finally{
  if(oldContext===undefined)delete process.env.CONTEXT;else process.env.CONTEXT=oldContext;
  if(oldDev===undefined)delete process.env.NETLIFY_DEV;else process.env.NETLIFY_DEV=oldDev;
 }
});
