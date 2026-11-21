import {createHash,randomUUID} from 'node:crypto';
import {updateShop} from './merch.mjs';
import {supporterIdentity} from './supporters.mjs';

const campaign='e2ozh2',connectionKey='crowdfundr/connection',syncKey='crowdfundr/sync',leaseKey='crowdfundr/lease';
const hash=value=>createHash('sha256').update(value).digest('hex');
const safeError=Symbol('safeCrowdfundrError');
const check=(ok,message,status=502)=>{if(!ok)throw Object.assign(Error(message),{status,[safeError]:true});};
const syncMessages={
 privacy:'API access is connected, but current Show name / Show amount fields are missing. Automatic public synchronization is not activated; existing CSV credits remain from the last import.',
 expired:'Crowdfundr authorization expired. Reconnect the approved app.',
 access:'Crowdfundr access is unavailable. The app may still be awaiting ConnectionPoint approval. Reconnect the approved app.',
 rate_limit:'Crowdfundr rate limit reached. The next scheduled check will retry.',
 connection_changed:'The Crowdfundr connection changed during reconciliation. Retry with the current connection.',
 capacity:'Crowdfundr needs more than 500 payments reconciled. Automatic updates are paused for administrator review.',
 invalid_data:'Crowdfundr returned payment information that could not be safely verified. The last confirmed ledger was retained.',
 unavailable:'Crowdfundr is temporarily unavailable. The next scheduled check will retry.'
};
export const publicSyncError=code=>syncMessages[code]||syncMessages.unavailable;
const text=(value,max=120)=>{
 check(typeof value==='string'&&value.length<=max*4,'Crowdfundr returned an invalid text field.');
 const clean=value.normalize('NFKC').trim().replace(/\s+/gu,' ');
 check([...clean].length<=max&&!/[<>\p{Cc}\p{Cf}\p{Cs}]/u.test(value+clean),'Crowdfundr returned an invalid text field.');
 return clean;
};
const cents=value=>{
 check(typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=1000000&&Math.abs(value*100-Math.round(value*100))<0.00001,'Crowdfundr returned an invalid USD amount.');
 return Math.round(value*100);
};
const status=value=>({completed:'paid',preapproved:'pending',cancelled:'failed',refunded:'refunded',reversed:'refunded','partially_refunded':'partially refunded'}[value]||'pending');
export function crowdfundrPayment(payment){
 check(payment&&typeof payment==='object'&&!Array.isArray(payment),'Crowdfundr returned an invalid payment.');
 check(typeof payment.show_name==='boolean'&&typeof payment.show_amount==='boolean','Current name/amount privacy fields are unavailable.');
 check(payment.campaign_id===campaign,'Crowdfundr returned a payment outside the connected campaign.');
 check(payment.currency?.toLowerCase()==='usd','Crowdfundr returned a non-USD payment.');
 const apiPaymentId=text(payment.id,100),reference=text(payment.transaction_id,100);
 check(apiPaymentId&&reference,'Crowdfundr returned a payment without stable payment and transaction references.');
 const processor=['paypal','stripe'].includes(payment.account)?payment.account:'';
 const name=payment.show_name?text(payment.payer_name||'',120):'';
 let identity='';try{identity=supporterIdentity(payment.contact_email||payment.payer_email||'');}catch{}
 return {id:'crowdfundr:'+hash((processor||'crowdfundr')+':'+reference),source:'crowdfundr',reference,processor,channel:'Crowdfundr',
  status:status(payment.status),gross:cents(payment.amount),refunded:null,name,showName:payment.show_name&&!!name,showAmount:payment.show_amount,
  identity,hidden:false,date:Number.isFinite(payment.created)&&payment.created>0?payment.created*1000:0,apiPaymentId};
}
export async function safeSyncStatus(store){
 const state=await store.get(syncKey,{type:'json'})||{};
 // Never return source payloads, contact info, tokens, or arbitrary provider errors.
 const safe={};
 for(const field of ['connectionAt','lastSync','lastAttempt','nextSync','privacyReady','active','paymentCount','fieldNames','added','updated','unavailable'])if(Object.hasOwn(state,field))safe[field]=state[field];
 const errorCode=Object.hasOwn(syncMessages,state.lastErrorCode)?state.lastErrorCode:state.lastError?'unavailable':'';
 safe.lastErrorCode=errorCode;safe.lastError=errorCode?publicSyncError(errorCode):'';
 return safe;
}
async function payments(token,fetcher,deadline){
 const rows=[],cursors=new Set(),ids=new Set();let after;
 for(let page=0;page<10;page++){
  const remaining=deadline-Date.now();check(remaining>500,'Crowdfundr reconciliation timed out; the last confirmed ledger was retained.');
  const query=new URLSearchParams({campaign,limit:'50',...(after?{after}:{} )});
  const response=await fetcher('https://api.connectionpoint.com/v1/payments?'+query,{
   headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(Math.min(5000,remaining))
  });
  check(response.ok,response.status===401||response.status===403?'Crowdfundr access is unavailable. Reconnect the approved app.':response.status===429?'Crowdfundr rate limit reached. The next scheduled check will retry.':'Crowdfundr did not return payments. The last confirmed ledger was retained.',response.status===401||response.status===403?409:502);
  const body=await response.text();check(body.length<=2000000,'Crowdfundr returned an oversized response.');
  let data;try{data=JSON.parse(body);}catch{check(false,'Crowdfundr returned an unreadable response.');}
  check(Array.isArray(data?.entries)&&data.entries.length<=50,'Crowdfundr returned an invalid payment page.');
  for(const row of data.entries){
   check(row&&typeof row==='object'&&typeof row.id==='string'&&!ids.has(row.id),'Crowdfundr returned duplicate or invalid payment IDs. Retry reconciliation.');
   ids.add(row.id);rows.push(row);
  }
  const cursor=data.after_cursor;
  if(cursor===undefined||cursor===null||cursor===''||cursor===0||cursor===false)return rows;
  check((typeof cursor==='string'||typeof cursor==='number')&&String(cursor).length<=200&&!cursors.has(String(cursor)),'Crowdfundr returned a repeated or invalid pagination cursor.');
  after=String(cursor);cursors.add(after);
 }
 check(false,'Crowdfundr needs more than 500 payments reconciled. Automatic updates are paused for administrator review.');
}
export async function syncCrowdfundr(store,shopStore,{force=false,fetcher=fetch}={}){
 const connection=await store.getWithMetadata(connectionKey,{type:'json'}),previous=await safeSyncStatus(store),now=Date.now();
 if(!connection?.data?.accessToken)return {connected:false,...previous,active:false};
 const config=await store.getWithMetadata('crowdfundr/config',{type:'json'});
 if(!config?.data?.clientId||config.data.clientId!==connection.data.clientId)return {connected:false,...previous,active:false};
 if(connection.data.expiresAt&&connection.data.expiresAt<=now){
  const expired={...previous,active:false,lastAttempt:now,lastErrorCode:'expired',lastError:publicSyncError('expired')};
  await store.setJSON(syncKey,expired);return {connected:false,...expired};
 }
 check(connection.data.campaignId===campaign,'The Crowdfundr campaign configuration needs review.',409);
 if(!force&&previous.connectionAt===connection.data.connectedAt&&previous.nextSync>now)return {connected:true,...previous};
 const oldLease=await store.getWithMetadata(leaseKey,{type:'json'});
 if(oldLease?.data?.until>now)return {connected:true,...previous,busy:true};
 const lease=await store.setJSON(leaseKey,{id:randomUUID(),until:now+30000},oldLease?{onlyIfMatch:oldLease.etag}:{onlyIfNew:true});
 if(!lease.modified)return {connected:true,...previous,busy:true};
 let outcome={connectionAt:connection.data.connectedAt,lastAttempt:now,nextSync:now+120000,active:false,privacyReady:false};
 try{
  const raw=await payments(connection.data.accessToken,fetcher,now+20000);
  const fieldNames=[...new Set(raw.flatMap(row=>Object.keys(row)))].filter(key=>/^[a-z_]{1,60}$/.test(key)).sort();
  const privacyReady=raw.every(row=>typeof row.show_name==='boolean'&&typeof row.show_amount==='boolean');
  outcome={...outcome,paymentCount:raw.length,fieldNames,privacyReady};
  const fresh=await store.getWithMetadata(connectionKey,{type:'json'});
  const freshConfig=await store.getWithMetadata('crowdfundr/config',{type:'json'});
  check(fresh?.etag===connection.etag&&freshConfig?.etag===config.etag,'Crowdfundr connection changed during reconciliation. Retry with the current connection.',409);
  if(!privacyReady){
   // An initial probe never replaces CSV consent. Once API-managed records
   // exist, unavailable current privacy must hide them rather than reuse consent.
   await updateShop(shopStore,shop=>{
    const rows=shop.supporterLedger?.apiRecords;if(!rows)return {unchanged:true};
    let changed=false;for(const row of Object.values(rows)){if(!row.apiUnavailable){row.apiUnavailable=true;changed=true;}}
    if(!changed)return {unchanged:true};
   });
   outcome.lastErrorCode='privacy';outcome.lastError=publicSyncError('privacy');
  }else{
   const rows=raw.map(crowdfundrPayment),ids=new Set();
   for(const row of rows){check(!ids.has(row.id),'Crowdfundr returned conflicting transaction references.');ids.add(row.id);}
   const summary=await updateShop(shopStore,shop=>{
    const ledger=shop.supporterLedger??={transactions:{},moderation:{}},old=ledger.apiRecords||{},next={};
    let added=0,updated=0,unavailable=0;
    for(const row of rows){
     // No stale API observation can reverse a previously confirmed refund.
     const prior=old[row.id]||ledger.transactions[row.id];
     if(prior?.status==='refunded'||prior?.status==='partially refunded'&&!['refunded','partially refunded'].includes(row.status))Object.assign(row,{status:prior.status,gross:prior.gross,refunded:prior.refunded??null});
     next[row.id]=row;
     if(!old[row.id]&&!ledger.transactions[row.id])added++;
     else if(JSON.stringify(old[row.id])!==JSON.stringify(row))updated++;
    }
    for(const [id,row] of Object.entries(old))if(!ids.has(id)){next[id]={...row,apiUnavailable:true};unavailable++;}
    if(JSON.stringify(old)===JSON.stringify(next))return {unchanged:true,value:{added:0,updated:0,unavailable}};
    ledger.apiRecords=next;return {added,updated,unavailable};
   });
   outcome={...outcome,...summary,active:true,lastSync:Date.now(),lastErrorCode:'',lastError:''};
  }
 }catch(error){
  // Provider/network failures never expose their raw messages or payloads. A
  // stale connection is visible as paused in admin; the last valid snapshot stays.
  const message=error?.[safeError]===true?error.message:'';
  outcome.lastErrorCode=!message?'unavailable':message.includes('rate limit')?'rate_limit':message.includes('access is unavailable')?'access':message.includes('connection changed')?'connection_changed':message.includes('500 payments')?'capacity':'invalid_data';
  outcome.lastError=publicSyncError(outcome.lastErrorCode);
 }
 const current=await store.getWithMetadata(connectionKey,{type:'json'});
 if(current?.etag===connection.etag)await store.setJSON(syncKey,{...previous,...outcome});
 await store.setJSON(leaseKey,{until:0},{onlyIfMatch:lease.etag});
 return {connected:!!current,...previous,...outcome};
}
