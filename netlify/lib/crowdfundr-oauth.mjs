import {createHash,randomBytes} from 'node:crypto';
import {safeSyncStatus} from './crowdfundr-sync.mjs';

export const crowdfundrOrigin='https://heidimikacfilms.com';
export const crowdfundrCallback=crowdfundrOrigin+'/.netlify/functions/crowdfundr-callback';
export const crowdfundrCampaign='e2ozh2';
export const crowdfundrConfigKey='crowdfundr/config';
export const crowdfundrConnectionKey='crowdfundr/connection';
export const crowdfundrSyncKey='crowdfundr/sync';
const authorize='https://connectionpoint.com/oauth2/authorize';
const tokenEndpoint='https://api.connectionpoint.com/v1/oauth2/token';
const api='https://api.connectionpoint.com/v1';
const nonce=()=>randomBytes(32).toString('base64url');
const digest=value=>createHash('sha256').update(value).digest('base64url');
const fail=(ok,message,status=400)=>{if(!ok)throw Object.assign(Error(message),{status});};
export const crowdfundrHeaders={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
export const crowdfundrCookie=(value,seconds)=>'__Host-hmf-crowdfundr='+value+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age='+seconds;
const clientId=value=>{
 fail(typeof value==='string'&&value.trim()&&value.length<=240&&!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value),'Enter the Client ID issued for your approved ConnectionPoint app.');
 return value.trim();
};

async function activeAdmin(store,sessionKey){
 fail(typeof sessionKey==='string'&&/^sessions\/[a-f0-9]{64}$/.test(sessionKey),'Please sign in as an administrator.',401);
 const session=await store.get(sessionKey,{type:'json'});
 const configured=session&&['Nick','Heidi'].includes(session.id)&&process.env['HMF_'+session.id.toUpperCase()+'_LOGIN_SHA256'];
 fail(session?.admin===true&&session.expires>Date.now()&&configured&&session.adminDigest===configured,'Please sign in as an administrator.',401);
 const password=await store.get('passwords/'+session.id,{type:'json'});
 fail((session.passwordVersion||0)===(password?.version||0),'Please sign in again.',401);
 return session;
}

export async function crowdfundrSettings(store){
 const [config,connection,sync]=await Promise.all([
  store.getWithMetadata(crowdfundrConfigKey,{type:'json'}),
  store.get(crowdfundrConnectionKey,{type:'json'}),
  safeSyncStatus(store)
 ]);
 const connected=!!(connection?.accessToken&&connection.clientId===config?.data?.clientId&&connection.campaignId===crowdfundrCampaign);
 const current=connected&&sync?.connectionAt===connection.connectedAt;
 return {clientId:config?.data?.clientId||'',revision:config?.etag||'',campaignId:crowdfundrCampaign,callbackUrl:crowdfundrCallback,
  connected,readOnly:true,connectedAt:connected?connection.connectedAt||null:null,lastSync:current?sync?.lastSync||null:null,
  lastError:current?sync?.lastError||'':'',privacyReady:current&&sync?.privacyReady===true,active:current&&sync?.active===true,
  lastAttempt:current?sync?.lastAttempt||null:null,paymentCount:current&&Number.isInteger(sync?.paymentCount)?sync.paymentCount:null,
  fieldNames:current&&Array.isArray(sync?.fieldNames)?sync.fieldNames.filter(value=>typeof value==='string'&&/^[a-z_]{1,60}$/.test(value)):[]};
}

export async function saveCrowdfundrSettings(store,input){
 const id=clientId(input.clientId),old=await store.getWithMetadata(crowdfundrConfigKey,{type:'json'});
 if(input.revision!==undefined)fail(input.revision===(old?.etag||''),'Crowdfundr settings changed. Refresh before saving again.',409);
 if(old?.data?.clientId===id)return crowdfundrSettings(store);
 const saved=await store.setJSON(crowdfundrConfigKey,{clientId:id,updatedAt:Date.now()},old?{onlyIfMatch:old.etag}:{onlyIfNew:true});
 fail(saved.modified,'Crowdfundr settings changed. Refresh before saving again.',409);
 // A prior token remains private but cannot be used for a different app ID.
 // Avoid deleting a newer callback's token during simultaneous configuration.
 return crowdfundrSettings(store);
}

export async function beginCrowdfundr(store,sessionKey,origin=crowdfundrOrigin){
 fail(origin===crowdfundrOrigin,'Open the administrator portal at heidimikacfilms.com to connect Crowdfundr.',400);
 await activeAdmin(store,sessionKey);
 const config=await store.getWithMetadata(crowdfundrConfigKey,{type:'json'});
 const id=clientId(config?.data?.clientId);
 const state=nonce(),browser=nonce(),verifier=nonce();
 await store.setJSON('crowdfundr/state/'+state,{sessionKey,browser:digest(browser),verifier,clientId:id,configRevision:config.etag,
  campaignId:crowdfundrCampaign,expires:Date.now()+600000},{onlyIfNew:true});
 const params=new URLSearchParams({client_id:id,response_type:'code',redirect_uri:crowdfundrCallback,scope:'read_only',state,
  code_challenge:digest(verifier),code_challenge_method:'S256'});
 return Response.json({url:authorize+'?'+params},{headers:{...crowdfundrHeaders,'Set-Cookie':crowdfundrCookie(browser,600)}});
}

export async function completeCrowdfundr(store,req,{fetcher=fetch}={}){
 const url=new URL(req.url),state=url.searchParams.get('state'),code=url.searchParams.get('code');
 fail(req.method==='GET'&&url.origin===crowdfundrOrigin&&/^[\w-]{43}$/.test(state||'')&&!url.searchParams.has('error'),'Crowdfundr authorization could not be verified.');
 fail(typeof code==='string'&&code.length>0&&code.length<=4096&&!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(code),'Crowdfundr authorization could not be verified.');
 const key='crowdfundr/state/'+state,record=await store.getWithMetadata(key,{type:'json'}),pending=record?.data;
 const browser=req.headers.get('cookie')?.match(/(?:^|; )__Host-hmf-crowdfundr=([\w-]{43})(?:;|$)/)?.[1];
 fail(browser&&pending&&pending.expires>Date.now()&&pending.browser===digest(browser)&&pending.campaignId===crowdfundrCampaign,'Crowdfundr authorization could not be verified.');
 await activeAdmin(store,pending.sessionKey);
 const config=await store.getWithMetadata(crowdfundrConfigKey,{type:'json'});
 fail(config?.etag===pending.configRevision&&config.data.clientId===pending.clientId,'Crowdfundr settings changed. Start the connection again.',409);
 fail((await store.setJSON(key,{expires:0},{onlyIfMatch:record.etag})).modified,'This authorization was already used. Start the connection again.',409);
 const exchanged=await fetcher(tokenEndpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
  headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({grant_type:'authorization_code',client_id:pending.clientId,redirect_uri:crowdfundrCallback,code,code_verifier:pending.verifier})});
 fail(exchanged.ok,'Crowdfundr could not complete authorization. Start the connection again.',502);
 const token=await exchanged.json();
 fail(typeof token.access_token==='string'&&token.access_token.length>0&&token.access_token.length<=8192&&(!token.token_type||token.token_type.toLowerCase()==='bearer'),
  'Crowdfundr returned an unsupported authorization response.',502);
 if(token.scope!==undefined){
  const scopes=typeof token.scope==='string'?token.scope.split(/[\s,]+/):[];
  fail(scopes.includes('read_only')&&!scopes.includes('read_write'),'Crowdfundr did not grant the requested read-only permission.',403);
 }
 const response=await fetcher(api+'/campaigns/'+crowdfundrCampaign,{headers:{Accept:'application/json',Authorization:'Bearer '+token.access_token},
  redirect:'error',signal:AbortSignal.timeout(8000)});
 fail(response.ok,'This Crowdfundr account could not access the configured campaign.',403);
 const campaign=await response.json();
 fail(campaign.id===crowdfundrCampaign&&String(campaign.currency).toUpperCase()==='USD','This Crowdfundr connection does not match the USD retake campaign.',403);
 // Recheck after external calls so a disconnect, app change, password change,
 // or revoked admin session cannot complete an authorization already in flight.
 await activeAdmin(store,pending.sessionKey);
 fail((await store.getWithMetadata(crowdfundrConfigKey,{type:'json'}))?.etag===pending.configRevision,'Crowdfundr settings changed. Start the connection again.',409);
 const connection={accessToken:token.access_token,clientId:pending.clientId,userId:typeof token.user_id==='string'?token.user_id:'',
  campaignId:crowdfundrCampaign,connectedAt:Date.now(),scope:'read_only',
  ...(Number.isFinite(token.expires_in)&&token.expires_in>0?{expiresAt:Date.now()+token.expires_in*1000}:{})};
 await store.setJSON(crowdfundrConnectionKey,connection);
 return {connected:true,campaignId:crowdfundrCampaign};
}

export async function disconnectCrowdfundr(store){
 // Changing the config revision invalidates pending callbacks as well as
 // deleting the locally stored access token. No provider campaign is changed.
 const config=await store.getWithMetadata(crowdfundrConfigKey,{type:'json'});
 if(config){
  fail((await store.setJSON(crowdfundrConfigKey,{...config.data,disconnectedAt:Date.now()},
   {onlyIfMatch:config.etag})).modified,'Crowdfundr settings changed. Refresh before disconnecting.',409);
 }
 await store.delete(crowdfundrConnectionKey);
 return {disconnected:true};
}
