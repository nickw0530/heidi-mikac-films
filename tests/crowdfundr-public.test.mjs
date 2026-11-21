import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readShop,updateShop} from '../netlify/lib/merch.mjs';
import {configurePublicCrowdfundr,syncPublicCrowdfundr,safePublicCrowdfundrStatus,PUBLIC_CROWDFUNDR_TTL,DEFAULT_PUBLIC_CROWDFUNDR_CAMPAIGNS,normalizePublicCampaigns,publicCampaignsFromConfig,savePublicCampaigns} from '../netlify/lib/crowdfundr-public.mjs';

function memoryStore(){
 const records=new Map();let revision=0,writes=0;
 return {
  get writes(){return writes;},
  async get(key){return structuredClone(records.get(key)?.data);},
  async getWithMetadata(key){return structuredClone(records.get(key));},
  async setJSON(key,data,options={}){
   const current=records.get(key);
   if(options.onlyIfNew&&current||options.onlyIfMatch&&current?.etag!==options.onlyIfMatch)return {modified:false};
   const etag=String(++revision);records.set(key,{data:structuredClone(data),etag});writes++;return {modified:true,etag};
  },
  async delete(key){records.delete(key);}
 };
}
const hash=value=>createHash('sha256').update(value).digest('hex');
const donation=(overrides={})=>({activityId:'ACTIVITY1',campaign:{campaignId:'e2ozh2',currency:'USD'},activityPageUrl:'https://crowdfundr.com/contributions/ACTIVITY1',currency:'USD',amount:10,isAnonymous:false,showAmount:true,owner:{name:'Fictional Supporter',isUser:true,userId:'PUBLIC-USER-1'},deleted:false,isPreapproval:false,offline:false,paymentType:'DONATION',created:'2026-11-21T02:30:44+00:00',paymentCreated:'2026-11-21T02:30:24Z',...overrides});
const page=(entries,totalResults,extra={})=>({activities:{campaignId:'e2ozh2',maxResults:25,totalResults, ...(entries===undefined?{}:{entries}),...extra}});
const response=entries=>async()=>Response.json(page(entries,Array.isArray(entries)?entries.length:entries?1:0));
async function fixture({enabled=true,snapshot=true,campaigns=[DEFAULT_PUBLIC_CROWDFUNDR_CAMPAIGNS[0]]}={}){
 const raw=memoryStore(),shop=memoryStore();
 await raw.setJSON('crowdfundr/config',{clientId:'123',publicFeedEnabled:enabled,...(campaigns===null?{}:{publicCampaigns:campaigns})});
 // Deliberately no connection/access token: public mode must not need one.
 await updateShop(shop,state=>{
  state.supporterLedger={transactions:{audit:{id:'audit',source:'crowdfundr',reference:'PRIVATE-PROCESSOR-REFERENCE',identity:'PRIVATE-AUDIT-IDENTITY',gross:1000,showName:true,showAmount:true,name:'Old CSV Name'}},moderation:{}};
  if(snapshot)state.supporterLedger.publicFeed={enabled,rows:{old:{id:'old',source:'crowdfundr-public',status:'public',name:'Last confirmed public credit',showName:true,showAmount:true,gross:1000}},checkedAt:1700000000000,lastSync:1700000000000};
 });
 return {raw,shop,state:async()=>(await readShop(shop)).shop};
}
const synchronize=(f,fetcher)=>syncPublicCrowdfundr(f.raw,f.shop,{force:true,fetcher});
const snapshot=async f=>(await f.state()).supporterLedger.publicFeed;
const retainedSnapshot=feed=>({enabled:feed.enabled,checkedAt:feed.checkedAt,lastSync:feed.lastSync,
 rows:Object.fromEntries(Object.entries(feed.rows).map(([id,{campaignId,...row}])=>[id,row]))});

test('public feed fetches every page, handles singleton rows, preserves native IDs and requires no credentials',async()=>{
 const f=await fixture(),requests=[];
 const first=Array.from({length:25},(_,index)=>({donation:donation({activityId:'ACTIVITY'+index})}));
 const last={donation:donation({activityId:'ACTIVITY25'})};
 const result=await synchronize(f,async(url,options)=>{
  requests.push({url,options});const parsed=new URL(url),headers=new Headers(options.headers);
  assert.equal(parsed.origin,'https://crowdfundr.com');assert.equal(parsed.pathname,'/api/campaigns/e2ozh2/donations');
  assert.equal(parsed.searchParams.get('v'),'1');assert.equal(parsed.searchParams.get('max-results'),'25');
  assert.equal(headers.get('Accept'),'application/json');assert.ok(headers.get('User-Agent'));
  assert.equal(headers.has('Authorization'),false);assert.equal(headers.has('Cookie'),false);
  assert.ok([...headers.keys()].every(key=>['accept','user-agent'].includes(key)),'Public requests whitelist headers.');
  assert.equal(options.redirect,'error');
  return Response.json(parsed.searchParams.has('before')?page(last,26,{lastEntryId:24}):page(first,26,{lastEntryId:25}));
 });
 assert.equal(result.active,true);assert.equal(requests.length,2);assert.equal(new URL(requests[1].url).searchParams.get('before'),'25');
 const feed=await snapshot(f);assert.equal(feed.enabled,true);assert.equal(Object.keys(feed.rows).length,26);
 const row=feed.rows['crowdfundr-public:'+hash('ACTIVITY25')];
 assert.equal(row.reference,'ACTIVITY25');assert.equal(row.status,'public');assert.equal(row.source,'crowdfundr-public');
 assert.equal(row.identity,'public-owner:'+hash('PUBLIC-USER-1'));assert.equal(row.gross,1000);
 assert.equal(await f.raw.get('crowdfundr/connection'),undefined);
 assert.equal((await f.state()).supporterLedger.transactions.audit.reference,'PRIVATE-PROCESSOR-REFERENCE');
});

test('zero-result terminal shape with omitted entries is a complete empty snapshot',async()=>{
 const f=await fixture();const result=await synchronize(f,async()=>Response.json(page(undefined,0)));
 assert.equal(result.active,true);assert.deepEqual((await snapshot(f)).rows,{});
});

test('current independent privacy flags discard all hidden name/amount source values',async()=>{
 const f=await fixture();
 const privateName='DO NOT STORE THIS NAME',privateUserId='DO NOT STORE THIS USER',privateAmount=98765.43;
 const hidden=donation({isAnonymous:true,showAmount:false,amount:privateAmount,owner:{name:privateName,userId:privateUserId,isUser:true},message:'private message',claimedRewards:{price:privateAmount,description:'private perk body'},hasSenderEmail:true});
 const result=await synchronize(f,response([{donation:hidden}]));assert.equal(result.active,true);
 const row=Object.values((await snapshot(f)).rows)[0];
 assert.equal(row.name,'');assert.equal(row.identity,'');assert.equal(row.gross,0);assert.equal(row.showName,false);assert.equal(row.showAmount,false);
 const serialized=JSON.stringify(row);
 for(const secret of [privateName,privateUserId,String(privateAmount),'private message','private perk body','hasSenderEmail','claimedRewards'])assert.ok(!serialized.includes(secret),secret);
 await synchronize(f,response([{donation:donation({showAmount:false,amount:'nonpublic value may be omitted'})}]));
 const named=Object.values((await snapshot(f)).rows)[0];assert.equal(named.name,'Fictional Supporter');assert.equal(named.gross,0);assert.equal(named.showAmount,false);
 await synchronize(f,response([{donation:donation({isAnonymous:true,owner:null})}]));
 const anonymous=Object.values((await snapshot(f)).rows)[0];assert.equal(anonymous.name,'');assert.equal(anonymous.gross,1000);
});

test('offline, deleted and preapproved records never become paid supporter credits',async()=>{
 const f=await fixture();const entries=[{donation:donation()},...['offline','deleted','isPreapproval'].map((flag,index)=>({donation:donation({activityId:'EXCLUDED'+index,[flag]:true})}))];
 const result=await synchronize(f,response(entries));assert.equal(result.active,true);
 assert.equal(Object.keys((await snapshot(f)).rows).length,1);
});

test('successive complete snapshots are idempotent by activity ID and missing records disappear',async()=>{
 const f=await fixture(),rows=[{donation:donation()},{donation:donation({activityId:'ACTIVITY2',amount:25})}];
 await synchronize(f,response(rows));const first=(await snapshot(f)).rows;
 await synchronize(f,response(rows));assert.deepEqual((await snapshot(f)).rows,first);
 await synchronize(f,response([rows[1]]));const next=(await snapshot(f)).rows;
 assert.equal(Object.keys(next).length,1);assert.equal(Object.values(next)[0].reference,'ACTIVITY2');
 assert.ok((await f.state()).supporterLedger.transactions.audit,'Private CSV audit remains.');
});

test('malformed native contracts fail closed without changing the last complete snapshot',async t=>{
 const invalidDonation=(overrides={})=>page([{donation:donation(overrides)}],1);
 const absentFlag=donation();delete absentFlag.showAmount;
 const cases=[
  ['absent privacy',page([{donation:absentFlag}],1)],['string privacy',invalidDonation({isAnonymous:'false'})],
  ['missing envelope',{entries:[]}],['foreign wrapper',page([{donation:donation()}],1,{campaignId:'another'})],
  ['foreign donation',invalidDonation({campaign:{campaignId:'another'}})],['currency',invalidDonation({currency:'EUR'})],
  ['fractional cents',invalidDonation({amount:1.001})],['missing activity ID',invalidDonation({activityId:''})],
  ['missing preapproval flag',invalidDonation({isPreapproval:undefined})],['invalid timestamp',invalidDonation({paymentCreated:'not-a-date'})],
  ['timestamp without zone',invalidDonation({paymentCreated:'2026-11-21T02:30:24'})],['feed capacity',page(undefined,501)],
  ['duplicate activity IDs',page([{donation:donation()},{donation:donation()}],2)],
  ['wrong total type',page([{donation:donation()}],'1')],['count exceeds total',page([{donation:donation()}],0)],
  ['no entries before total',page(undefined,2)],['entry type',{activities:{campaignId:'e2ozh2',entries:'bad',totalResults:1,maxResults:25}}]
 ];
 for(const [label,body] of cases)await t.test(label,async()=>{
  const f=await fixture(),before=await snapshot(f);const result=await synchronize(f,async()=>Response.json(body));
  assert.equal(result.active,false);assert.ok(result.lastError);assert.deepEqual(retainedSnapshot(await snapshot(f)),retainedSnapshot(before));
 });
});

test('pagination loops, incomplete pages and partial HTTP failure never replace the complete snapshot',async t=>{
 for(const mode of ['cursor-loop','partial-empty','partial-403'])await t.test(mode,async()=>{
  const f=await fixture(),before=await snapshot(f);let calls=0;
  const result=await synchronize(f,async()=>{
   calls++;
   if(calls===2&&mode==='partial-empty')return Response.json(page(undefined,30));
   if(calls===2&&mode==='partial-403')return new Response('PRIVATE PROVIDER ERROR BODY',{status:403});
   return Response.json(page([{donation:donation({activityId:'PAGE'+calls})}],30,{lastEntryId:123}));
  });
  assert.equal(result.active,false);assert.ok(result.lastError);assert.deepEqual(retainedSnapshot(await snapshot(f)),retainedSnapshot(before));
  assert.ok(calls<=3,'A repeated cursor stops promptly.');assert.ok(!JSON.stringify(result).includes('PRIVATE PROVIDER ERROR BODY'));
 });
});

test('public status never exposes source bodies, private values, row IDs or arbitrary exception messages',async()=>{
 const f=await fixture();
 await synchronize(f,response([{donation:donation({message:'PRIVATE MESSAGE',contact_email:'PRIVATE CONTACT',secret:'PRIVATE SECRET'})}]));
 const failed=await synchronize(f,async()=>{throw Object.assign(Error('PRIVATE SECRET PRIVATE CONTACT RAW PROVIDER BODY'),{status:503});});
 assert.equal(failed.active,false);
 for(const payload of [failed,await f.raw.get('crowdfundr/public-sync')]){
  const serialized=JSON.stringify(payload);
  for(const secret of ['ACTIVITY1','PUBLIC-USER-1','PRIVATE SECRET','PRIVATE CONTACT','RAW PROVIDER BODY','PRIVATE MESSAGE','PRIVATE-PROCESSOR-REFERENCE','PRIVATE-AUDIT-IDENTITY'])assert.ok(!serialized.includes(secret),secret);
 }
});

test('first enable is committed only after a complete valid fetch and needs no app credentials',async()=>{
 const f=await fixture({enabled:false,snapshot:false}),before=await f.state();
 const failed=await configurePublicCrowdfundr(f.raw,f.shop,{enabled:true,fetcher:async()=>new Response('PRIVATE RESPONSE',{status:403})});
 assert.equal(failed.active,false);assert.equal((await f.raw.get('crowdfundr/config')).publicFeedEnabled,false);assert.deepEqual(await f.state(),before);
 const enabled=await configurePublicCrowdfundr(f.raw,f.shop,{enabled:true,fetcher:response([{donation:donation()}])});
 assert.equal(enabled.active,true);assert.equal((await f.raw.get('crowdfundr/config')).publicFeedEnabled,true);assert.equal((await snapshot(f)).enabled,true);
});

test('disabled public mode makes no provider requests',async()=>{
 const f=await fixture({enabled:false});let calls=0;
 await f.raw.setJSON('crowdfundr/public-sync',{active:true,mode:'public',lastSync:Date.now(),nextSync:Date.now()+120000});
 const result=await syncPublicCrowdfundr(f.raw,f.shop,{force:true,fetcher:async()=>{calls++;}});
 assert.equal(calls,0);assert.equal(result.active,false);
});

test('public sync CAS lease allows one request and scheduled intervals avoid duplicate fetches',async()=>{
 const f=await fixture();let begin,release,calls=0;
 const started=new Promise(resolve=>{begin=resolve;}),paused=new Promise(resolve=>{release=resolve;});
 const fetcher=async()=>{calls++;begin();await paused;return Response.json(page([{donation:donation()}],1));};
 const first=synchronize(f,fetcher);await started;
 const second=await synchronize(f,fetcher);assert.equal(second.busy,true);assert.equal(calls,1);
 release();assert.equal((await first).active,true);
 const scheduled=await syncPublicCrowdfundr(f.raw,f.shop,{fetcher});assert.equal(scheduled.active,true);assert.equal(calls,1);
 assert.equal((await f.raw.get('crowdfundr/public-lease')).until,0);
});

test('changed public-feed configuration cannot commit a snapshot fetched under the old setting',async()=>{
 const f=await fixture(),before=await snapshot(f);
 const result=await synchronize(f,async()=>{
  await f.raw.setJSON('crowdfundr/config',{publicFeedEnabled:false});
  return Response.json(page([{donation:donation()}],1));
 });
 assert.equal(result.active,false);assert.equal(result.errorCode,'connection_changed');assert.deepEqual(await snapshot(f),before);
});

test('failed first snapshot persistence rolls back scheduler activation without changing the ledger',async()=>{
 const f=await fixture({enabled:false,snapshot:false}),before=await f.state();
 const failingShop={...f.shop,async setJSON(key,data,options){
  if(data.supporterLedger?.publicFeed?.enabled)throw Object.assign(Error('PRIVATE PERSISTENCE DETAIL'),{status:503});
  return f.shop.setJSON(key,data,options);
 }};
 const result=await configurePublicCrowdfundr(f.raw,failingShop,{enabled:true,fetcher:response([{donation:donation()}])});
 assert.equal(result.active,false);assert.equal((await f.raw.get('crowdfundr/config')).publicFeedEnabled,false);
 assert.deepEqual(await f.state(),before);assert.ok(!JSON.stringify(result).includes('PRIVATE PERSISTENCE DETAIL'));
});

test('safe public status expires stale activity and never echoes arbitrary saved provider text',async()=>{
 const f=await fixture();
 await f.raw.setJSON('crowdfundr/public-sync',{active:true,lastSync:Date.now()-PUBLIC_CROWDFUNDR_TTL-1000,lastError:'PRIVATE PROVIDER BODY',raw:{secret:'PRIVATE SECRET'},activityId:'PRIVATE ACTIVITY ID',count:2});
 const safe=await safePublicCrowdfundrStatus(f.raw);assert.equal(safe.active,false);
 for(const secret of ['PRIVATE PROVIDER BODY','PRIVATE SECRET','PRIVATE ACTIVITY ID'])assert.ok(!JSON.stringify(safe).includes(secret));
});

const campaignResponse=(id,entries)=>Response.json(page(entries,Array.isArray(entries)?entries.length:entries?1:0,{campaignId:id}));
const campaignDonation=(id,overrides={})=>({donation:donation({campaign:{campaignId:id,currency:'USD'},...overrides})});
const requestedCampaign=url=>new URL(url).pathname.split('/')[3];

test('default registry covers the four verified campaigns and supports multiple current campaigns safely',()=>{
 const defaults=publicCampaignsFromConfig({});
 assert.deepEqual(defaults.map(row=>[row.id,row.active]),[['e2ozh2',true],['b2mXyf',false],['62gpI9',false],['f2jVO7',false]]);
 const multiple=normalizePublicCampaigns(defaults.map(row=>({...row,active:['e2ozh2','b2mXyf'].includes(row.id)})));
 assert.equal(multiple.filter(row=>row.active).length,2);
 defaults[0].title='Local copy';assert.notEqual(publicCampaignsFromConfig({})[0].title,'Local copy');
 for(const rows of [[],Array.from({length:13},(_,i)=>({id:'ID00'+i,title:'Title',active:false})),
  [{id:'https://outside.invalid/',title:'Title',active:true}],
  [{id:'goodID',title:'<script>',active:true}],[{id:'goodID',title:'\uFF1Cscript\uFF1E',active:true}],
  [{id:'goodID',title:'Title',active:'true'}],[{id:'goodID',title:'Title',active:true},{id:'goodID',title:'Duplicate',active:false}]])
  assert.throws(()=>normalizePublicCampaigns(rows),{status:400});
});

test('all-time snapshots retain current moderation IDs and isolate identical activity IDs across campaigns',async()=>{
 const f=await fixture({campaigns:null}),legacyId='crowdfundr-public:'+hash('ACTIVITY1');
 await updateShop(f.shop,state=>{state.supporterLedger.moderation[legacyId]={hidden:true,duplicateOf:''};});
 const requested=[];
 const result=await synchronize(f,async url=>{
  const id=requestedCampaign(url);requested.push(id);
  // This historical all-or-nothing campaign contains only uncharged pledges.
  const entries=id==='f2jVO7'?Array.from({length:10},(_,i)=>campaignDonation(id,{activityId:'PLEDGE'+i,isPreapproval:true})):campaignDonation(id);
  return campaignResponse(id,entries);
 });
 assert.equal(result.active,true);assert.equal(result.partial,false);assert.equal(result.count,3);assert.equal(result.currentCount,1);
 assert.deepEqual(requested.sort(),DEFAULT_PUBLIC_CROWDFUNDR_CAMPAIGNS.map(row=>row.id).sort());
 const feed=await snapshot(f);assert.equal(feed.campaigns.length,4);assert.equal(Object.keys(feed.rows).length,3);
 assert.equal(feed.rows[legacyId].campaignId,'e2ozh2');
 assert.ok(feed.rows['crowdfundr-public:'+hash('b2mXyf:ACTIVITY1')]);
 assert.ok(feed.rows['crowdfundr-public:'+hash('62gpI9:ACTIVITY1')]);
 assert.equal(feed.campaigns.find(row=>row.id==='f2jVO7').count,0);
 assert.equal(feed.campaigns.find(row=>row.id==='f2jVO7').totalResults,10);
 assert.equal((await f.state()).supporterLedger.moderation[legacyId].hidden,true);
 assert.equal((await f.state()).supporterLedger.transactions.audit.reference,'PRIVATE-PROCESSOR-REFERENCE');
});

test('one failing campaign cannot refresh its old privacy timestamp or block another successful campaign',async()=>{
 const registry=DEFAULT_PUBLIC_CROWDFUNDR_CAMPAIGNS.slice(0,2),f=await fixture({campaigns:registry});
 await synchronize(f,async url=>campaignResponse(requestedCampaign(url),campaignDonation(requestedCampaign(url))));
 await updateShop(f.shop,state=>{
  const current=state.supporterLedger.publicFeed.campaigns.find(row=>row.id==='e2ozh2');
  current.checkedAt=Date.now()-PUBLIC_CROWDFUNDR_TTL-1000;current.lastSync=current.checkedAt;
 });
 const expiredAt=(await snapshot(f)).campaigns.find(row=>row.id==='e2ozh2').checkedAt;
 const result=await synchronize(f,async url=>{
  const id=requestedCampaign(url);
  if(id==='e2ozh2')throw Error('PRIVATE PROVIDER DETAIL');
  return campaignResponse(id,campaignDonation(id,{amount:25}));
 });
 assert.equal(result.active,true);assert.equal(result.partial,true);assert.equal(result.count,1);assert.equal(result.currentCount,0);
 const feed=await snapshot(f),failed=feed.campaigns.find(row=>row.id==='e2ozh2'),updated=feed.campaigns.find(row=>row.id==='b2mXyf');
 assert.equal(failed.checkedAt,expiredAt);assert.match(failed.lastError,/temporarily unavailable/);
 assert.ok(updated.checkedAt>expiredAt);assert.equal(updated.lastError,'');
 assert.equal(Object.values(feed.rows).find(row=>row.campaignId==='b2mXyf').gross,2500);
 const safe=await safePublicCrowdfundrStatus(f.raw);
 assert.equal(safe.campaigns.find(row=>row.id==='e2ozh2').fresh,false);assert.equal(safe.campaigns.find(row=>row.id==='b2mXyf').fresh,true);
 assert.equal(safe.count,1);assert.ok(!JSON.stringify(safe).includes('PRIVATE PROVIDER DETAIL'));
});

test('a failed historical source retains its own fresh snapshot only until its independent TTL',async()=>{
 const registry=DEFAULT_PUBLIC_CROWDFUNDR_CAMPAIGNS.slice(0,2),f=await fixture({campaigns:registry});
 await synchronize(f,async url=>campaignResponse(requestedCampaign(url),campaignDonation(requestedCampaign(url))));
 const prior=(await snapshot(f)).campaigns.find(row=>row.id==='b2mXyf').checkedAt;
 await synchronize(f,async url=>{
  const id=requestedCampaign(url);return id==='b2mXyf'?new Response('private',{status:503}):campaignResponse(id,campaignDonation(id));
 });
 assert.equal((await snapshot(f)).campaigns.find(row=>row.id==='b2mXyf').checkedAt,prior);
 let safe=await safePublicCrowdfundrStatus(f.raw);assert.equal(safe.count,2);
 const state=await f.raw.get('crowdfundr/public-sync');state.campaigns.find(row=>row.id==='b2mXyf').checkedAt=Date.now()-PUBLIC_CROWDFUNDR_TTL-1;
 await f.raw.setJSON('crowdfundr/public-sync',state);safe=await safePublicCrowdfundrStatus(f.raw);
 assert.equal(safe.count,1);assert.equal(safe.currentCount,1);
});

test('registry saves use config and shop CAS, remove omitted sources, keep private audit/moderation and invalidate old previews',async()=>{
 const f=await fixture({campaigns:DEFAULT_PUBLIC_CROWDFUNDR_CAMPAIGNS.slice(0,2)});
 await synchronize(f,async url=>campaignResponse(requestedCampaign(url),campaignDonation(requestedCampaign(url))));
 const config=await f.raw.getWithMetadata('crowdfundr/config'),shopBefore=await readShop(f.shop),legacyId='crowdfundr-public:'+hash('ACTIVITY1');
 await updateShop(f.shop,state=>{state.supporterLedger.moderation[legacyId]={hidden:true};});
 const next=[{...DEFAULT_PUBLIC_CROWDFUNDR_CAMPAIGNS[0],active:false},{id:'futureCampaign',title:'Next film',active:true}];
 const result=await savePublicCampaigns(f.raw,f.shop,{revision:config.etag,campaigns:next});assert.equal(result.saved,true);
 const current=await readShop(f.shop);assert.notEqual(current.revision,shopBefore.revision);
 const feed=current.shop.supporterLedger.publicFeed;
 assert.deepEqual(feed.campaigns.map(row=>[row.id,row.active]),next.map(row=>[row.id,row.active]));
 assert.equal(feed.campaigns.find(row=>row.id==='futureCampaign').checkedAt,null);
 assert.ok(Object.values(feed.rows).every(row=>row.campaignId==='e2ozh2'));
 assert.equal(current.shop.supporterLedger.moderation[legacyId].hidden,true);assert.ok(current.shop.supporterLedger.transactions.audit);
 assert.equal((await f.raw.get('crowdfundr/config')).clientId,'123');
 assert.equal((await f.raw.get('crowdfundr/public-sync')).nextSync,0);
 await assert.rejects(()=>savePublicCampaigns(f.raw,f.shop,{revision:config.etag,campaigns:next}),{status:409});
});

test('registry changes cannot race an in-flight source fetch or leak persistence failure details',async()=>{
 const f=await fixture(),config=await f.raw.getWithMetadata('crowdfundr/config');let begin,release;
 const started=new Promise(resolve=>{begin=resolve;}),paused=new Promise(resolve=>{release=resolve;});
 const run=synchronize(f,async()=>{begin();await paused;return campaignResponse('e2ozh2',campaignDonation('e2ozh2'));});
 await started;
 await assert.rejects(()=>savePublicCampaigns(f.raw,f.shop,{revision:config.etag,campaigns:DEFAULT_PUBLIC_CROWDFUNDR_CAMPAIGNS}),{status:409});
 release();await run;
 const before=await f.raw.getWithMetadata('crowdfundr/config'),failing={...f.shop,async setJSON(){throw Error('PRIVATE STORE FAILURE');}};
 await assert.rejects(()=>savePublicCampaigns(f.raw,failing,{revision:before.etag,campaigns:DEFAULT_PUBLIC_CROWDFUNDR_CAMPAIGNS}),error=>error.status===503&&!error.message.includes('PRIVATE'));
 assert.deepEqual(await f.raw.get('crowdfundr/config'),before.data);
 assert.equal((await f.raw.get('crowdfundr/public-lease')).until,0);
});

test('registry primary commits remain consistent when ancillary status persistence fails',async()=>{
 const f=await fixture();
 await synchronize(f,response([{donation:donation()}]));
 const config=await f.raw.getWithMetadata('crowdfundr/config'),write=f.raw.setJSON.bind(f.raw);
 f.raw.setJSON=async(key,...args)=>{if(key==='crowdfundr/public-sync')throw Error('PRIVATE STATUS STORAGE DETAIL');return write(key,...args);};
 const campaigns=[{...DEFAULT_PUBLIC_CROWDFUNDR_CAMPAIGNS[0],active:false},{...DEFAULT_PUBLIC_CROWDFUNDR_CAMPAIGNS[1],active:true}];
 const result=await savePublicCampaigns(f.raw,f.shop,{revision:config.etag,campaigns});
 assert.equal(result.saved,true);assert.equal(result.statusPending,true);assert.match(result.warning,/status could not be refreshed/);
 assert.deepEqual((await f.raw.get('crowdfundr/config')).publicCampaigns,campaigns);
 assert.deepEqual((await snapshot(f)).campaigns.map(({id,title,active})=>({id,title,active})),campaigns);
 assert.equal((await f.raw.get('crowdfundr/public-lease')).until,0);
 assert.ok(!JSON.stringify(result).includes('PRIVATE STATUS STORAGE DETAIL'));
});

test('enable and disable primary commits are not rolled back by a failed status write',async()=>{
 const f=await fixture({enabled:false,snapshot:false}),write=f.raw.setJSON.bind(f.raw);
 f.raw.setJSON=async(key,...args)=>{if(key==='crowdfundr/public-sync')throw Error('PRIVATE STATUS WRITE FAILURE');return write(key,...args);};
 const enabled=await configurePublicCrowdfundr(f.raw,f.shop,{enabled:true,fetcher:response([{donation:donation()}])});
 assert.equal(enabled.active,true);assert.equal(enabled.enabled,true);assert.equal(enabled.statusPending,true);
 assert.equal((await f.raw.get('crowdfundr/config')).publicFeedEnabled,true);assert.equal((await snapshot(f)).enabled,true);
 assert.equal((await f.raw.get('crowdfundr/public-lease')).until,0);
 const disabled=await configurePublicCrowdfundr(f.raw,f.shop,{enabled:false});
 assert.equal(disabled.active,false);assert.equal(disabled.enabled,false);assert.equal(disabled.statusPending,true);
 assert.equal((await f.raw.get('crowdfundr/config')).publicFeedEnabled,false);assert.equal((await snapshot(f)).enabled,false);
 assert.equal((await f.raw.get('crowdfundr/public-lease')).until,0);
 assert.ok(!JSON.stringify([enabled,disabled]).includes('PRIVATE STATUS WRITE FAILURE'));
});

test('scheduled source commits return a safe status warning and always release the lease during a status outage',async()=>{
 const f=await fixture(),write=f.raw.setJSON.bind(f.raw);
 f.raw.setJSON=async(key,...args)=>{if(key==='crowdfundr/public-sync')throw Error('PRIVATE PROGRESS STORE');return write(key,...args);};
 const result=await synchronize(f,response([{donation:donation({amount:25})}]));
 assert.equal(result.active,true);assert.equal(result.statusPending,true);assert.equal(Object.values((await snapshot(f)).rows)[0].gross,2500);
 assert.equal((await f.raw.get('crowdfundr/public-lease')).until,0);
 const failed=await synchronize(f,async()=>new Response('PRIVATE PROVIDER BODY',{status:503}));
 assert.equal(failed.active,false);assert.equal(failed.statusPending,true);assert.equal((await f.raw.get('crowdfundr/public-lease')).until,0);
 assert.ok(!JSON.stringify([result,failed]).includes('PRIVATE'));
});
