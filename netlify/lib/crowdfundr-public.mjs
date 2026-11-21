import {createHash,randomUUID} from 'node:crypto';
import {updateShop} from './merch.mjs';

const campaign='e2ozh2',configKey='crowdfundr/config',stateKey='crowdfundr/public-sync',leaseKey='crowdfundr/public-lease';
const endpoint='https://crowdfundr.com/api/campaigns/'+campaign+'/donations';
const agent='HeidiMikacFilms-SupporterSync/1.0 (+https://heidimikacfilms.com)';
const hash=value=>createHash('sha256').update(value).digest('hex');
export const PUBLIC_CROWDFUNDR_TTL=300000;
const failure=Symbol('publicCrowdfundrFailure');
const messages={
 unavailable:'The Crowdfundr public activity feed is temporarily unavailable. The next scheduled check will retry.',
 invalid_data:'Crowdfundr public activity could not be fully verified. The last complete snapshot was retained.',
 privacy:'Crowdfundr public privacy choices are missing or changed format. Automatic public updates are paused.',
 capacity:'The Crowdfundr public feed exceeds the supported complete snapshot limit. Administrator review is required.',
 connection_changed:'The Crowdfundr public-feed setting changed during synchronization. Retry with the current setting.',
 busy:'A Crowdfundr public-feed synchronization is already running. Try again shortly.',
 save:'The verified Crowdfundr public snapshot could not be saved. Try again.'
};
const check=(ok,code='invalid_data')=>{if(!ok)throw Object.assign(Error(messages[code]||messages.invalid_data),{[failure]:code});};
const safeError=error=>Object.hasOwn(messages,error?.[failure])?error[failure]:'unavailable';
const validTime=value=>Number.isSafeInteger(value)&&value>0;
const plain=(value,max=120)=>{
 check(typeof value==='string'&&value.length<=max*4);
 const text=value.normalize('NFKC').trim().replace(/\s+/gu,' ');
 check([...text].length<=max&&!/[<>\p{Cc}\p{Cf}\p{Cs}]/u.test(value+text));return text;
};
const amount=value=>{
 check(typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=1000000&&Math.abs(value*100-Math.round(value*100))<0.00001);
 return Math.round(value*100);
};
const date=value=>{
 check(typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value));
 const parsed=Date.parse(value);check(Number.isFinite(parsed)&&parsed>0);return parsed;
};

function donationRecord(entry){
 const donation=entry?.donation;check(donation&&typeof donation==='object'&&!Array.isArray(donation));
 for(const key of ['isAnonymous','showAmount','deleted','isPreapproval','offline'])check(typeof donation[key]==='boolean','privacy');
 check(donation.campaign?.campaignId===campaign&&donation.currency==='USD');
 const reference=plain(donation.activityId,100);check(reference&&/^[A-Za-z0-9_-]+$/.test(reference));
 // These are public activities, not processor-confirmed payments. Offline
 // support is credited separately in admin; pledges and removed entries count
 // toward pagination coverage but never become active supporter credits.
 if(donation.deleted||donation.isPreapproval||donation.offline)return {reference,excluded:true};
 const showName=!donation.isAnonymous,name=showName?plain(donation.owner?.name||'',120):'';
 const ownerId=showName&&donation.owner?.isUser===true&&typeof donation.owner.userId==='string'?plain(donation.owner.userId,100):'';
 return {reference,record:{id:'crowdfundr-public:'+hash(reference),source:'crowdfundr-public',reference,processor:'',channel:'Crowdfundr public activity',
  status:'public',gross:donation.showAmount?amount(donation.amount):0,refunded:null,name,showName:showName&&!!name,showAmount:donation.showAmount,
  identity:ownerId?'public-owner:'+hash(ownerId):'',date:date(donation.paymentCreated??donation.created),hidden:false}};
}

async function snapshot(fetcher,deadline){
 const rows={},seen=new Set(),cursors=new Set();let total=null,before;
 for(let page=0;page<20;page++){
  const remaining=deadline-Date.now();check(remaining>500,'unavailable');
  const query=new URLSearchParams({v:'1','max-results':'25',...(before?{before}:{})});
  const response=await fetcher(endpoint+'?'+query,{headers:{Accept:'application/json','User-Agent':agent},redirect:'error',signal:AbortSignal.timeout(Math.min(5000,remaining))});
  check(response.ok,'unavailable');
  const body=await response.text();check(body.length<=2000000);
  let data;try{data=JSON.parse(body);}catch{check(false);}
  const activities=data?.activities;
  check(activities&&activities.campaignId===campaign&&Number.isSafeInteger(activities.totalResults)&&activities.totalResults>=0);
  check(activities.totalResults<=500,'capacity');
  if(total===null)total=activities.totalResults;else check(total===activities.totalResults);
  const entries=activities.entries==null?[]:Array.isArray(activities.entries)?activities.entries:[activities.entries];
  check(entries.length<=25&&seen.size+entries.length<=total);
  for(const entry of entries){
   const parsed=donationRecord(entry);check(!seen.has(parsed.reference));seen.add(parsed.reference);
   if(parsed.record)rows[parsed.record.id]=parsed.record;
  }
  if(seen.size===total)return {rows,count:Object.keys(rows).length,totalResults:total};
  check(entries.length>0);
  const cursor=activities.lastEntryId;
  check((typeof cursor==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(cursor)||Number.isSafeInteger(cursor)&&cursor>0)&&!cursors.has(String(cursor)));
  before=String(cursor);cursors.add(before);
 }
 check(false,'capacity');
}

export async function safePublicCrowdfundrStatus(store){
 const state=await store.get(stateKey,{type:'json'})||{};
 const errorCode=Object.hasOwn(messages,state.errorCode)?state.errorCode:state.lastError?'unavailable':'';
 return {mode:'public',active:state.active===true&&validTime(state.lastSync)&&Date.now()-state.lastSync<=PUBLIC_CROWDFUNDR_TTL,
  lastSync:validTime(state.lastSync)?state.lastSync:null,lastAttempt:validTime(state.lastAttempt)?state.lastAttempt:null,
  nextSync:validTime(state.nextSync)?state.nextSync:null,count:Number.isSafeInteger(state.count)&&state.count>=0?state.count:0,
  errorCode,lastError:errorCode?messages[errorCode]:''};
}

async function lease(store){
 const old=await store.getWithMetadata(leaseKey,{type:'json'}),now=Date.now();
 if(old?.data?.until>now)return null;
 const id=randomUUID(),result=await store.setJSON(leaseKey,{id,until:now+30000},old?{onlyIfMatch:old.etag}:{onlyIfNew:true});
 return result.modified?id:null;
}
async function release(store,id){
 try{const current=await store.getWithMetadata(leaseKey,{type:'json'});if(current?.data?.id===id)await store.setJSON(leaseKey,{until:0},{onlyIfMatch:current.etag});}catch{}
}
async function saveSnapshot(shopStore,result,enabled,now){
 return updateShop(shopStore,shop=>{
  const ledger=shop.supporterLedger??={transactions:{},moderation:{}};
  ledger.publicFeed={enabled,rows:result.rows,checkedAt:now,lastSync:now,totalResults:result.totalResults};
 });
}

export async function syncPublicCrowdfundr(store,shopStore,{force=false,fetcher=fetch}={}){
 const config=await store.getWithMetadata(configKey,{type:'json'}),previous=await safePublicCrowdfundrStatus(store),now=Date.now();
 if(config?.data?.publicFeedEnabled!==true)return {...previous,enabled:false,active:false};
 if(!force&&previous.nextSync>now)return {...previous,enabled:true};
 const id=await lease(store);if(!id)return {...previous,enabled:true,busy:true};
 let outcome={...previous,mode:'public',active:false,lastAttempt:now,nextSync:now+120000};
 try{
  const result=await snapshot(fetcher,now+20000),current=await store.getWithMetadata(configKey,{type:'json'});
  check(current?.data?.publicFeedEnabled===true&&current.etag===config.etag,'connection_changed');
  await saveSnapshot(shopStore,result,true,Date.now());
  outcome={...outcome,active:true,lastSync:Date.now(),count:result.count,errorCode:'',lastError:''};
 }catch(error){const errorCode=safeError(error);outcome={...outcome,errorCode,lastError:messages[errorCode]};}
 await store.setJSON(stateKey,outcome);await release(store,id);
 return {...outcome,enabled:true};
}

export async function configurePublicCrowdfundr(store,shopStore,{enabled,revision,fetcher=fetch}={}){
 check(typeof enabled==='boolean');
 const config=await store.getWithMetadata(configKey,{type:'json'}),previous=await safePublicCrowdfundrStatus(store),now=Date.now();
 if(revision!==undefined)check(revision===(config?.etag||''),'connection_changed');
 const id=await lease(store);if(!id)return {...previous,enabled:config?.data?.publicFeedEnabled===true,busy:true};
 let outcome={...previous,mode:'public',active:false,lastAttempt:now,nextSync:now+120000},writtenConfig;
 try{
  // Probe every page before enabling either setting; a failed first probe
  // leaves the existing CSV/manual supporter wall as it was.
  const result=enabled?await snapshot(fetcher,now+20000):null;
  writtenConfig=await store.setJSON(configKey,{...config?.data,publicFeedEnabled:enabled,publicFeedChangedAt:Date.now()},config?{onlyIfMatch:config.etag}:{onlyIfNew:true});
  check(writtenConfig.modified,'connection_changed');
  if(enabled)await saveSnapshot(shopStore,result,true,Date.now());
  else await updateShop(shopStore,shop=>{
   if(!shop.supporterLedger?.publicFeed?.enabled)return {unchanged:true};
   shop.supporterLedger.publicFeed.enabled=false;
  });
  outcome={...outcome,active:enabled,lastSync:enabled?Date.now():previous.lastSync,count:enabled?result.count:previous.count,errorCode:'',lastError:''};
  await store.setJSON(stateKey,outcome);await release(store,id);
  return {...outcome,enabled};
 }catch(error){
  if(writtenConfig?.modified){
   // A failed shop write must not leave the scheduler switched on after a
   // failed first activation. Never roll back a newer administrator change.
   const current=await store.getWithMetadata(configKey,{type:'json'});
   if(current?.data?.publicFeedChangedAt&&current.etag===writtenConfig.etag)await store.setJSON(configKey,{...current.data,publicFeedEnabled:config?.data?.publicFeedEnabled===true},{onlyIfMatch:current.etag});
  }
  const errorCode=safeError(error);outcome={...outcome,errorCode,lastError:messages[errorCode]};
  await store.setJSON(stateKey,outcome);await release(store,id);
  return {...outcome,enabled:config?.data?.publicFeedEnabled===true};
 }
}
