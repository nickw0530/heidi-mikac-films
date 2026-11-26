import {createHash,randomUUID} from 'node:crypto';
import {updateShop} from './merch.mjs';

const legacyCampaign='e2ozh2',configKey='crowdfundr/config',stateKey='crowdfundr/public-sync',leaseKey='crowdfundr/public-lease';
export const DEFAULT_PUBLIC_CROWDFUNDR_CAMPAIGNS=Object.freeze([
 Object.freeze({id:'e2ozh2',title:'Take Two: Written in the Dark Retake Fundraiser!',active:true}),
 Object.freeze({id:'b2mXyf',title:'Double Feature Fundraiser!',active:false}),
 Object.freeze({id:'62gpI9',title:'Wherein Lies Continue — organization campaign',active:false}),
 Object.freeze({id:'f2jVO7',title:'Wherein Lies Continue — past pledge campaign',active:false})
]);
const agent='HeidiMikacFilms-SupporterSync/1.0 (+https://heidimikacfilms.com)';
const hash=value=>createHash('sha256').update(value).digest('hex');
export const PUBLIC_CROWDFUNDR_TTL=1200000;
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
const statusWarning='Connection status could not be refreshed. The next scheduled check will retry.';
async function persistStatus(store,outcome){
 try{return (await store.setJSON(stateKey,outcome))?.modified!==false;}catch{return false;}
}
const statusResult=(outcome,statusPending)=>({...outcome,...(statusPending?{statusPending:true,warning:statusWarning}:{})});
const validTime=value=>Number.isSafeInteger(value)&&value>0;
const fresh=value=>validTime(value)&&value<=Date.now()+1000&&Date.now()-value<=PUBLIC_CROWDFUNDR_TTL;
const registryError=(ok,message,status=400)=>{if(!ok)throw Object.assign(Error(message),{status});};
export function normalizePublicCampaigns(campaigns){
 registryError(Array.isArray(campaigns)&&campaigns.length>0&&campaigns.length<=12,'Choose between one and twelve Crowdfundr campaigns.');
 const seen=new Set();
 return campaigns.map(row=>{
  registryError(row&&typeof row==='object'&&!Array.isArray(row),'Enter a campaign ID, title and current-campaign choice.');
  registryError(typeof row.id==='string'&&/^[A-Za-z0-9_-]{4,40}$/.test(row.id),'Enter the public Crowdfundr campaign ID, not a URL.');
  registryError(!seen.has(row.id),'Each Crowdfundr campaign ID must appear only once.');seen.add(row.id);
  registryError(typeof row.title==='string'&&row.title.length<=480,'Enter a plain-text campaign title of at most 120 characters.');
  const title=row.title.normalize('NFKC').trim().replace(/\s+/gu,' ');
  registryError(title&&[...title].length<=120&&!/[<>\p{Cc}\p{Cf}\p{Cs}]/u.test(row.title+title),'Enter a plain-text campaign title of at most 120 characters.');
  registryError(typeof row.active==='boolean','Choose whether each campaign belongs in the current-campaign credits.');
  return {id:row.id,title,active:row.active};
 });
}
export const publicCampaignsFromConfig=config=>normalizePublicCampaigns(config?.publicCampaigns??DEFAULT_PUBLIC_CROWDFUNDR_CAMPAIGNS);
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

function donationRecord(entry,campaign){
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
 // Preserve the original campaign's IDs so its existing hide/duplicate choices
 // survive migration. Other campaign IDs namespace otherwise identical activity IDs.
 const id='crowdfundr-public:'+hash(campaign===legacyCampaign?reference:campaign+':'+reference);
 return {reference,record:{id,campaignId:campaign,source:'crowdfundr-public',reference,processor:'',channel:'Crowdfundr public activity',
  status:'public',gross:donation.showAmount?amount(donation.amount):0,refunded:null,name,showName:showName&&!!name,showAmount:donation.showAmount,
  identity:ownerId?'public-owner:'+hash(ownerId):'',date:date(donation.paymentCreated??donation.created),hidden:false}};
}

async function snapshot(campaign,fetcher,deadline){
 const rows={},seen=new Set(),cursors=new Set();let total=null,before;
 for(let page=0;page<20;page++){
  const remaining=deadline-Date.now();check(remaining>500,'unavailable');
  const query=new URLSearchParams({v:'1','max-results':'25',...(before?{before}:{})});
  const endpoint='https://crowdfundr.com/api/campaigns/'+encodeURIComponent(campaign)+'/donations';
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
   const parsed=donationRecord(entry,campaign);check(!seen.has(parsed.reference));seen.add(parsed.reference);
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
 const campaigns=Array.isArray(state.campaigns)?state.campaigns.flatMap(row=>{
  try{const [campaign]=normalizePublicCampaigns([row]),code=Object.hasOwn(messages,row.errorCode)?row.errorCode:row.lastError?'unavailable':'';
   return [{...campaign,checkedAt:validTime(row.checkedAt)?row.checkedAt:null,lastSync:validTime(row.lastSync)?row.lastSync:null,
    count:Number.isSafeInteger(row.count)&&row.count>=0?row.count:0,totalResults:Number.isSafeInteger(row.totalResults)&&row.totalResults>=0?row.totalResults:0,
    errorCode:code,lastError:code?messages[code]:'',fresh:fresh(row.checkedAt)}];
  }catch{return [];}
 }):[];
 const count=campaigns.length?campaigns.filter(row=>row.fresh).reduce((sum,row)=>sum+row.count,0):Number.isSafeInteger(state.count)&&state.count>=0?state.count:0;
 return {mode:'public',active:state.active===true&&(campaigns.length?campaigns.some(row=>row.fresh):fresh(state.lastSync)),
  lastSync:validTime(state.lastSync)?state.lastSync:null,lastAttempt:validTime(state.lastAttempt)?state.lastAttempt:null,
  nextSync:validTime(state.nextSync)?state.nextSync:null,count,currentCount:campaigns.filter(row=>row.active&&row.fresh).reduce((sum,row)=>sum+row.count,0),
  partial:campaigns.some(row=>!!row.errorCode||!row.fresh),campaigns,errorCode,lastError:errorCode?messages[errorCode]:''};
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
function previousCampaigns(feed){
 const entries=new Map((Array.isArray(feed?.campaigns)?feed.campaigns:[]).map(row=>[row.id,row]));
 if(feed&&!entries.has(legacyCampaign))entries.set(legacyCampaign,{id:legacyCampaign,checkedAt:feed.checkedAt,lastSync:feed.lastSync,
  totalResults:feed.totalResults||0,count:Object.values(feed.rows||{}).filter(row=>(row.campaignId||legacyCampaign)===legacyCampaign).length});
 return entries;
}
async function campaignSnapshots(campaigns,fetcher,deadline){
 const results=await Promise.allSettled(campaigns.map(async campaign=>({...campaign,result:await snapshot(campaign.id,fetcher,deadline),checkedAt:Date.now()})));
 return results.map((result,index)=>result.status==='fulfilled'?result.value:{...campaigns[index],errorCode:safeError(result.reason)});
}
async function saveSnapshots(shopStore,results,enabled){
 return updateShop(shopStore,shop=>{
  const ledger=shop.supporterLedger??={transactions:{},moderation:{}},previous=ledger.publicFeed,old=previousCampaigns(previous),rows={},campaigns=[];
  for(const campaign of results){
   const prior=old.get(campaign.id)||{};
   const meta={id:campaign.id,title:campaign.title,active:campaign.active,checkedAt:prior.checkedAt||null,lastSync:prior.lastSync||null,
    totalResults:prior.totalResults||0,count:prior.count||0,errorCode:campaign.errorCode||'',lastError:campaign.errorCode?messages[campaign.errorCode]:''};
   if(campaign.result){
    Object.assign(rows,campaign.result.rows);
    Object.assign(meta,{checkedAt:campaign.checkedAt,lastSync:campaign.checkedAt,totalResults:campaign.result.totalResults,count:campaign.result.count});
   }else{
    // A failed source retains only its own last complete snapshot and timestamp.
    // Other campaigns can refresh independently. The public model enforces TTL.
    for(const row of Object.values(previous?.rows||{}))if((row.campaignId||legacyCampaign)===campaign.id)rows[row.id]={...row,campaignId:campaign.id};
   }
   campaigns.push(meta);
  }
  const checkedAt=Math.max(0,...campaigns.map(row=>row.checkedAt||0));
  ledger.publicFeed={enabled,rows,campaigns,checkedAt,lastSync:checkedAt,totalResults:campaigns.reduce((sum,row)=>sum+row.totalResults,0)};
  return campaigns;
 });
}
function outcomeFor(previous,results,campaigns,now){
 const successes=results.filter(row=>row.result),errors=results.filter(row=>row.errorCode),errorCode=errors[0]?.errorCode||'';
 return {...previous,mode:'public',active:successes.length>0,lastAttempt:now,nextSync:now+900000,
  lastSync:successes.length?Date.now():previous.lastSync,count:campaigns.filter(row=>fresh(row.checkedAt)).reduce((sum,row)=>sum+row.count,0),
  currentCount:campaigns.filter(row=>row.active&&fresh(row.checkedAt)).reduce((sum,row)=>sum+row.count,0),
  partial:errors.length>0,campaigns,errorCode,lastError:errorCode?messages[errorCode]:''};
}

export async function syncPublicCrowdfundr(store,shopStore,{force=false,fetcher=fetch}={}){
 const config=await store.getWithMetadata(configKey,{type:'json'}),previous=await safePublicCrowdfundrStatus(store),now=Date.now();
 if(config?.data?.publicFeedEnabled!==true)return {...previous,enabled:false,active:false};
 if(!force&&previous.nextSync>now)return {...previous,enabled:true};
 const id=await lease(store);if(!id)return {...previous,enabled:true,busy:true};
 let outcome={...previous,mode:'public',active:false,lastAttempt:now,nextSync:now+900000};
 try{
  try{
   const results=await campaignSnapshots(publicCampaignsFromConfig(config.data),fetcher,now+20000),current=await store.getWithMetadata(configKey,{type:'json'});
   check(current?.data?.publicFeedEnabled===true&&current.etag===config.etag,'connection_changed');
   const campaigns=await saveSnapshots(shopStore,results,true);
   outcome=outcomeFor(previous,results,campaigns,now);
  }catch(error){const errorCode=safeError(error);outcome={...outcome,errorCode,lastError:messages[errorCode]};}
  return statusResult({...outcome,enabled:true},!await persistStatus(store,outcome));
 }finally{await release(store,id);}
}

export async function configurePublicCrowdfundr(store,shopStore,{enabled,revision,fetcher=fetch}={}){
 check(typeof enabled==='boolean');
 const config=await store.getWithMetadata(configKey,{type:'json'}),previous=await safePublicCrowdfundrStatus(store),now=Date.now();
 if(revision!==undefined)check(revision===(config?.etag||''),'connection_changed');
 const id=await lease(store);if(!id)return {...previous,enabled:config?.data?.publicFeedEnabled===true,busy:true};
 let outcome={...previous,mode:'public',active:false,lastAttempt:now,nextSync:now+900000},writtenConfig,shopCommitted=false;
 try{
  // Probe every page before enabling either setting; a failed first probe
  // leaves the existing CSV/manual supporter wall as it was.
  const results=enabled?await campaignSnapshots(publicCampaignsFromConfig(config?.data),fetcher,now+20000):null;
  if(enabled&&!results.some(row=>row.result))check(false,results[0]?.errorCode||'unavailable');
  writtenConfig=await store.setJSON(configKey,{...config?.data,publicFeedEnabled:enabled,publicFeedChangedAt:Date.now()},config?{onlyIfMatch:config.etag}:{onlyIfNew:true});
  check(writtenConfig.modified,'connection_changed');
  let campaigns;
  if(enabled)campaigns=await saveSnapshots(shopStore,results,true);
  else await updateShop(shopStore,shop=>{
   if(!shop.supporterLedger?.publicFeed?.enabled)return {unchanged:true};
   shop.supporterLedger.publicFeed.enabled=false;
  });
  shopCommitted=true;
  outcome=enabled?outcomeFor(previous,results,campaigns,now):{...outcome,active:false,errorCode:'',lastError:''};
  return statusResult({...outcome,enabled},!await persistStatus(store,outcome));
 }catch(error){
  if(writtenConfig?.modified&&!shopCommitted){
   // A failed shop write must not leave the scheduler switched on after a
   // failed first activation. Never roll back a newer administrator change.
   const current=await store.getWithMetadata(configKey,{type:'json'});
   if(current?.data?.publicFeedChangedAt&&current.etag===writtenConfig.etag)await store.setJSON(configKey,{...current.data,publicFeedEnabled:config?.data?.publicFeedEnabled===true},{onlyIfMatch:current.etag});
  }
  const errorCode=safeError(error);outcome={...outcome,errorCode,lastError:messages[errorCode]};
  return statusResult({...outcome,enabled:shopCommitted?enabled:config?.data?.publicFeedEnabled===true},!await persistStatus(store,outcome));
 }finally{await release(store,id);}
}

export async function savePublicCampaigns(store,shopStore,input){
 const campaigns=normalizePublicCampaigns(input?.campaigns),config=await store.getWithMetadata(configKey,{type:'json'});
 registryError(typeof input.revision==='string'&&input.revision===(config?.etag||''),'Crowdfundr campaign settings changed. Refresh and review before saving again.',409);
 const id=await lease(store);registryError(id,messages.busy,409);
 let written,shopCommitted=false,previous={};
 try{
  // Status is secondary to the authoritative configuration and shop ledger.
  // A status read/write outage must not turn a completed primary save into a
  // reported failure or roll back just one half of that completed operation.
  try{previous=await safePublicCrowdfundrStatus(store);}catch{}
  written=await store.setJSON(configKey,{...config?.data,publicCampaigns:campaigns,publicCampaignsChangedAt:Date.now()},config?{onlyIfMatch:config.etag}:{onlyIfNew:true});
  registryError(written.modified,'Crowdfundr campaign settings changed. Refresh and review before saving again.',409);
  // Immediately remove omitted sources and update current/all-time membership.
  // New sources have no timestamp until their first complete successful check.
  const metadata=await saveSnapshots(shopStore,campaigns,config?.data?.publicFeedEnabled===true);
  shopCommitted=true;
  const statusPending=!await persistStatus(store,{...previous,campaigns:metadata,active:metadata.some(row=>fresh(row.checkedAt)),nextSync:0});
  return statusResult({saved:true,revision:written.etag,campaigns},statusPending);
 }catch(error){
  if(written?.modified&&!shopCommitted){
   const current=await store.getWithMetadata(configKey,{type:'json'});
   if(current?.etag===written.etag)await store.setJSON(configKey,config?.data||{}, {onlyIfMatch:current.etag});
  }
  if(error.status===400||error.status===409)throw error;
  throw Object.assign(Error(messages.save),{status:503});
 }finally{await release(store,id);}
}
