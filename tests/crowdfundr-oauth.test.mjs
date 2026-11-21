import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {beginCrowdfundr,completeCrowdfundr,crowdfundrSettings,saveCrowdfundrSettings,disconnectCrowdfundr,
 crowdfundrCallback,crowdfundrConfigKey,crowdfundrConnectionKey,crowdfundrSyncKey,crowdfundrCampaign,publicCrowdfundrAuthError} from '../netlify/lib/crowdfundr-oauth.mjs';

const callbackFile=new URL('../netlify/functions/crowdfundr-callback.mjs',import.meta.url);
const callbackSource=(await readFile(callbackFile,'utf8'))
 .replace("import {getStore} from '@netlify/blobs';",'const getStore=()=>globalThis.__crowdfundrCallbackStore;')
 .replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_match,_quote,path)=>'from '+JSON.stringify(new URL(path,callbackFile).href));
const {default:callback}=await import('data:text/javascript;base64,'+Buffer.from(callbackSource).toString('base64'));

const sessionKey='sessions/'+'a'.repeat(64);
const digest=value=>createHash('sha256').update(value).digest('base64url');
function memoryStore(){
 const records=new Map();let revision=0;
 return {records,
  async get(key){return structuredClone(records.get(key)?.data??null);},
  async getWithMetadata(key){return structuredClone(records.get(key)??null);},
  async setJSON(key,data,options={}){
   const old=records.get(key);
   if(options.onlyIfNew&&old||options.onlyIfMatch&&old?.etag!==options.onlyIfMatch)return {modified:false};
   records.set(key,{data:structuredClone(data),etag:String(++revision)});return {modified:true};
  },
  async delete(key){records.delete(key);}
 };
}
async function fixture(t){
 const old=process.env.HMF_NICK_LOGIN_SHA256;
 process.env.HMF_NICK_LOGIN_SHA256='test-admin-digest';
 t.after(()=>{if(old===undefined)delete process.env.HMF_NICK_LOGIN_SHA256;else process.env.HMF_NICK_LOGIN_SHA256=old;});
 const store=memoryStore();
 await store.setJSON(sessionKey,{admin:true,id:'Nick',adminDigest:'test-admin-digest',passwordVersion:'v1',expires:Date.now()+3600000});
 await store.setJSON('passwords/Nick',{version:'v1'});
 await saveCrowdfundrSettings(store,{clientId:'approved-test-client'});
 return store;
}
async function flow(store){
 const response=await beginCrowdfundr(store,sessionKey),data=await response.json();
 const authorization=new URL(data.url),cookie=response.headers.get('set-cookie').split(';')[0];
 const request=()=>new Request(crowdfundrCallback+'?'+new URLSearchParams({state:authorization.searchParams.get('state'),code:'provider-authorization-code'}),{headers:{cookie}});
 return {response,data,authorization,cookie,request};
}
function provider({campaign=crowdfundrCampaign,currency='usd',token='server-only-access-token',scope,beforeCampaign}={}){
 const requests=[];
 const fetcher=async(url,options)=>{
  requests.push({url,options});
  if(url==='https://api.connectionpoint.com/v1/oauth2/token')return Response.json({access_token:token,token_type:'Bearer',user_id:'private-account-id',...(scope===undefined?{}:{scope})});
  assert.equal(url,'https://api.connectionpoint.com/v1/campaigns/'+crowdfundrCampaign);
  await beforeCampaign?.();
  return Response.json({id:campaign,currency});
 };
 return {requests,fetcher};
}

test('Crowdfundr uses browser-bound read-only OAuth PKCE and keeps token material server-side',async t=>{
 const store=await fixture(t),f=await flow(store),remote=provider();
 assert.equal(f.authorization.origin,'https://connectionpoint.com');assert.equal(f.authorization.pathname,'/oauth2/authorize');
 assert.equal(f.authorization.searchParams.get('scope'),'read_only');assert.equal(f.authorization.searchParams.get('code_challenge_method'),'S256');
 assert.equal(f.authorization.searchParams.get('redirect_uri'),crowdfundrCallback);
 const pending=await store.get('crowdfundr/state/'+f.authorization.searchParams.get('state'));
 assert.equal(f.authorization.searchParams.get('code_challenge'),digest(pending.verifier));
 assert.notEqual(pending.browser,f.cookie.split('=')[1]);assert.equal(pending.sessionKey,sessionKey);
 for(const flag of ['HttpOnly','Secure','SameSite=Lax','Path=/','Max-Age=600'])assert.ok(f.response.headers.get('set-cookie').includes(flag));
 const result=await completeCrowdfundr(store,f.request(),{fetcher:remote.fetcher});
 assert.deepEqual(result,{connected:true,campaignId:crowdfundrCampaign});
 const body=remote.requests[0].options.body;
 assert.equal(body.get('grant_type'),'authorization_code');assert.equal(body.get('code_verifier'),pending.verifier);assert.equal(body.has('client_secret'),false);
 assert.equal(remote.requests[1].options.headers.Authorization,'Bearer server-only-access-token');
 const stored=await store.get(crowdfundrConnectionKey);assert.equal(stored.accessToken,'server-only-access-token');assert.equal(stored.scope,'read_only');
 const settings=await crowdfundrSettings(store);assert.equal(settings.connected,true);assert.equal(settings.privacyReady,false);
 const publicJson=JSON.stringify([settings,result,f.data]);
 for(const secret of ['server-only-access-token','private-account-id',pending.verifier,sessionKey])assert.ok(!publicJson.includes(secret));
 await assert.rejects(completeCrowdfundr(store,f.request(),{fetcher:remote.fetcher}));
 assert.equal(remote.requests.length,2,'A replay never exchanges the authorization code again.');
});

test('OAuth access-token punctuation passes from JSON to the bearer header without encoding or escaping',async t=>{
 const store=await fixture(t),f=await flow(store),token='synthetic+/._~-token==',remote=provider({token});
 await completeCrowdfundr(store,f.request(),{fetcher:remote.fetcher});
 assert.equal(remote.requests[1].options.headers.Authorization,'Bearer '+token);
 assert.equal((await store.get(crowdfundrConnectionKey)).accessToken,token);
});

test('wrong browser, origin, expired state and non-admin sessions cannot authorize Crowdfundr',async t=>{
 const store=await fixture(t),f=await flow(store);let requests=0;
 const options={fetcher:async()=>{requests++;throw Error('Unexpected provider request');}};
 await assert.rejects(completeCrowdfundr(store,new Request(f.request().url,{headers:{cookie:'__Host-hmf-crowdfundr='+'x'.repeat(43)}}),options));
 await assert.rejects(completeCrowdfundr(store,new Request(f.request().url.replace('heidimikacfilms.com','preview.netlify.app'),{headers:{cookie:f.cookie}}),options));
 await store.setJSON('crowdfundr/state/'+f.authorization.searchParams.get('state'),{...(await store.get('crowdfundr/state/'+f.authorization.searchParams.get('state'))),expires:0});
 await assert.rejects(completeCrowdfundr(store,f.request(),options));
 await store.setJSON(sessionKey,{admin:false,id:'Nick',expires:Date.now()+3600000});
 await assert.rejects(beginCrowdfundr(store,sessionKey),{status:401});
 assert.equal(requests,0);
});

test('session revocation and password changes invalidate a pending authorization',async t=>{
 const store=await fixture(t),f=await flow(store);
 await store.setJSON('passwords/Nick',{version:'new-password-version'});
 await assert.rejects(completeCrowdfundr(store,f.request(),{fetcher:provider().fetcher}),{status:401});
 await store.delete(sessionKey);
 await assert.rejects(completeCrowdfundr(store,f.request(),{fetcher:provider().fetcher}),{status:401});
 assert.equal(await store.get(crowdfundrConnectionKey),null);
});

test('campaign and currency mismatches fail before credentials are stored',async t=>{
 const store=await fixture(t);
 for(const mismatch of [{campaign:'another-campaign'},{currency:'cad'}]){
  const f=await flow(store);
  await assert.rejects(completeCrowdfundr(store,f.request(),{fetcher:provider(mismatch).fetcher}),{status:403});
  assert.equal(await store.get(crowdfundrConnectionKey),null);
 }
});

test('a reported OAuth scope must retain read-only access without granting write access',async t=>{
 const store=await fixture(t);
 for(const scope of ['read_write','read_only read_write','',null]){
  const f=await flow(store),remote=provider({scope});
  await assert.rejects(completeCrowdfundr(store,f.request(),{fetcher:remote.fetcher}),{status:403});
  assert.equal(remote.requests.length,1,'A scope mismatch never accesses campaign data.');
  assert.equal(await store.get(crowdfundrConnectionKey),null);
 }
 const f=await flow(store);
 await completeCrowdfundr(store,f.request(),{fetcher:provider({scope:'read_only'}).fetcher});
 assert.equal((await store.get(crowdfundrConnectionKey)).scope,'read_only');
});

test('local disconnect removes credentials and invalidates pending callbacks while preserving supporter data',async t=>{
 const store=await fixture(t),f=await flow(store),remote=provider();
 await store.setJSON('supporter-ledger-example',{names:['Existing CSV supporter one','Existing CSV supporter two']});
 await store.setJSON(crowdfundrConnectionKey,{accessToken:'private-existing-token',clientId:'approved-test-client',campaignId:crowdfundrCampaign});
 await disconnectCrowdfundr(store);
 assert.equal(await store.get(crowdfundrConnectionKey),null);
 await assert.rejects(completeCrowdfundr(store,f.request(),{fetcher:remote.fetcher}),{status:409});
 assert.equal(remote.requests.length,0);
 assert.deepEqual(await store.get('supporter-ledger-example'),{names:['Existing CSV supporter one','Existing CSV supporter two']});
});

test('app changes and disconnects during provider validation cannot reconnect a stale authorization',async t=>{
 const store=await fixture(t),f=await flow(store);
 const remote=provider({beforeCampaign:()=>disconnectCrowdfundr(store)});
 await assert.rejects(completeCrowdfundr(store,f.request(),{fetcher:remote.fetcher}),{status:409});
 assert.equal(await store.get(crowdfundrConnectionKey),null);
 const config=await store.getWithMetadata(crowdfundrConfigKey);
 await assert.rejects(saveCrowdfundrSettings(store,{clientId:'new-app',revision:'stale'}),{status:409});
 assert.equal((await store.getWithMetadata(crowdfundrConfigKey)).etag,config.etag);
});

test('safe connection settings expose specific sync status only for the current authorization',async t=>{
 const store=await fixture(t);
 await store.setJSON(crowdfundrConnectionKey,{accessToken:'private-token',clientId:'approved-test-client',campaignId:crowdfundrCampaign,connectedAt:100});
 await store.setJSON(crowdfundrSyncKey,{connectionAt:100,lastSync:123,privacyReady:true,active:false,
  lastError:'Crowdfundr is temporarily unavailable. The next scheduled check will retry.',fieldNames:['id','amount','show_name','show_amount'],paymentCount:2});
 const data=await crowdfundrSettings(store),encoded=JSON.stringify(data);
 assert.equal(data.privacyReady,true);assert.equal(data.active,false);assert.equal(data.lastSync,123);
 assert.equal(data.lastError,'Crowdfundr is temporarily unavailable. The next scheduled check will retry.');
 assert.deepEqual(data.fieldNames,['id','amount','show_name','show_amount']);assert.equal(data.paymentCount,2);
 assert.ok(!encoded.includes('private-token'));assert.ok(!encoded.includes('contact@example.test'));
 await store.setJSON(crowdfundrConnectionKey,{accessToken:'new-private-token',clientId:'approved-test-client',campaignId:crowdfundrCampaign,connectedAt:200});
 const stale=await crowdfundrSettings(store);assert.equal(stale.active,false);assert.equal(stale.privacyReady,false);assert.equal(stale.lastSync,null);assert.equal(stale.lastError,'');
 await assert.rejects(beginCrowdfundr(store,sessionKey,'https://www.heidimikacfilms.com'));
 for(const value of ['',null,'x'.repeat(241),'bad\nclient'])await assert.rejects(saveCrowdfundrSettings(store,{clientId:value}));
});

test('stored legacy or arbitrary provider error text cannot appear in connection settings',async t=>{
 const store=await fixture(t);
 await store.setJSON(crowdfundrConnectionKey,{accessToken:'server-only-secret',clientId:'approved-test-client',campaignId:crowdfundrCampaign,connectedAt:100});
 await store.setJSON(crowdfundrSyncKey,{connectionAt:100,lastError:'server-only-secret private-contact@example.test',lastErrorCode:'unknown-provider-error',
  fieldNames:['id','amount','payer_email','secret-value@example.test']});
 const data=await crowdfundrSettings(store),encoded=JSON.stringify(data);
 assert.equal(data.lastError,'Crowdfundr is temporarily unavailable. The next scheduled check will retry.');
 for(const secret of ['server-only-secret','private-contact@example.test','secret-value@example.test'])assert.ok(!encoded.includes(secret));
 assert.deepEqual(data.fieldNames,['id','amount','payer_email']);
});

test('OAuth app changes and local OAuth disconnect preserve an enabled public feed',async t=>{
 const store=await fixture(t),config=await store.get(crowdfundrConfigKey);
 await store.setJSON(crowdfundrConfigKey,{...config,publicFeedEnabled:true});
 await saveCrowdfundrSettings(store,{clientId:'another-approved-app'});
 assert.equal((await store.get(crowdfundrConfigKey)).publicFeedEnabled,true);
 await disconnectCrowdfundr(store);
 assert.equal((await store.get(crowdfundrConfigKey)).publicFeedEnabled,true);
 assert.equal((await crowdfundrSettings(store)).publicFeedEnabled,true);
});

test('OAuth token failure diagnostics contain only safe HTTP status and allowlisted error codes',async t=>{
 const store=await fixture(t);
 for(const code of ['invalid_client','unauthorized_client','invalid_grant','invalid_request','access_denied','invalid_scope','unsupported_grant_type']){
  const f=await flow(store);
  try{
   await completeCrowdfundr(store,f.request(),{fetcher:async()=>Response.json({error:code,error_description:'DO-NOT-SHOW private-token contact@example.test',access_token:'private-token'},{status:403})});
   assert.fail('The token error must fail authorization.');
  }catch(error){assert.equal(publicCrowdfundrAuthError(error),'Crowdfundr token exchange failed (HTTP 403; '+code+'). Start the connection again.');}
 }
 const f=await flow(store);
 try{
  await completeCrowdfundr(store,f.request(),{fetcher:async()=>({ok:false,status:'DO-NOT-SHOW-private-token',text:async()=>JSON.stringify({error:'DO-NOT-SHOW-private-token',error_description:'contact@example.test'})})});
  assert.fail('The malformed token error must fail authorization.');
 }catch(error){assert.equal(publicCrowdfundrAuthError(error),'Crowdfundr token exchange failed (HTTP unknown). Start the connection again.');}
 assert.equal(await store.get(crowdfundrConnectionKey),null);
});

test('unbranded provider exceptions and mutable error messages cannot bypass the diagnostic boundary',async t=>{
 const store=await fixture(t),f=await flow(store);
 try{
  await completeCrowdfundr(store,f.request(),{fetcher:async()=>{throw Object.assign(Error('DO-NOT-SHOW private-token contact@example.test'),{status:403,safeCrowdfundrAuthError:true});}});
  assert.fail('The provider exception must fail authorization.');
 }catch(error){assert.equal(publicCrowdfundrAuthError(error),'Crowdfundr connection did not finish.');}
 try{
  await completeCrowdfundr(store,new Request(crowdfundrCallback+'?state=invalid&code=private-code'));
  assert.fail('The invalid state must fail authorization.');
 }catch(error){
  const safe=publicCrowdfundrAuthError(error);error.message='DO-NOT-SHOW private-token';
  assert.equal(publicCrowdfundrAuthError(error),safe);assert.ok(!safe.includes('private-code'));
 }
});

test('the callback shows fixed failure stages with privacy headers and never exposes provider payloads',async t=>{
 const store=await fixture(t);globalThis.__crowdfundrCallbackStore=store;
 const oldContext=process.env.CONTEXT,oldDev=process.env.NETLIFY_DEV;delete process.env.CONTEXT;delete process.env.NETLIFY_DEV;
 t.after(()=>{if(oldContext===undefined)delete process.env.CONTEXT;else process.env.CONTEXT=oldContext;if(oldDev===undefined)delete process.env.NETLIFY_DEV;else process.env.NETLIFY_DEV=oldDev;});
 const missing=await flow(store);
 let response=await callback(new Request(missing.request().url));
 assert.match(await response.text(),/browser verification cookie was missing/);assert.equal(response.status,400);
 for(const [name,value] of [['cache-control','private, no-store'],['referrer-policy','no-referrer']])assert.equal(response.headers.get(name),value);
 assert.ok(response.headers.get('set-cookie').includes('Max-Age=0'));
 const tokenFailure=await flow(store);
 t.mock.method(globalThis,'fetch',async()=>Response.json({error:'unauthorized_client',error_description:'DO-NOT-SHOW contact@example.test',access_token:'private-token'},{status:403}));
 response=await callback(tokenFailure.request());const body=await response.text();
 assert.match(body,/token exchange failed \(HTTP 403; unauthorized_client\)/);
 for(const value of ['DO-NOT-SHOW','contact@example.test','private-token','provider-authorization-code'])assert.ok(!body.includes(value));
 const campaignFailure=await flow(store);
 t.mock.method(globalThis,'fetch',async url=>url.includes('/oauth2/token')?Response.json({access_token:'private-token',token_type:'Bearer'}):Response.json({error:'DO-NOT-SHOW contact@example.test'},{status:401}));
 response=await callback(campaignFailure.request());const campaignBody=await response.text();
 assert.match(campaignBody,/campaign verification failed \(HTTP 401\)/);assert.ok(!campaignBody.includes('DO-NOT-SHOW'));assert.ok(!campaignBody.includes('private-token'));
 const exception=await flow(store);
 t.mock.method(globalThis,'fetch',async()=>{throw Object.assign(Error('DO-NOT-SHOW private-token'),{status:403});});
 response=await callback(exception.request());const fallback=await response.text();
 assert.match(fallback,/Crowdfundr connection did not finish/);assert.ok(!fallback.includes('DO-NOT-SHOW'));assert.ok(!fallback.includes('private-token'));
});
