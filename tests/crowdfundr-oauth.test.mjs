import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {beginCrowdfundr,completeCrowdfundr,crowdfundrSettings,saveCrowdfundrSettings,disconnectCrowdfundr,
 crowdfundrCallback,crowdfundrConfigKey,crowdfundrConnectionKey,crowdfundrSyncKey,crowdfundrCampaign} from '../netlify/lib/crowdfundr-oauth.mjs';

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
