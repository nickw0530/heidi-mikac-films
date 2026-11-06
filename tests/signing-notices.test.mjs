import assert from 'node:assert/strict';
import {countersignatureNotice,checkSigningNotices} from '../netlify/lib/signing-notices.mjs';

const data=new Map();let revision=0;
const store={
 async get(k){return data.get(k)?.value||null},
 async getWithMetadata(k){const r=data.get(k);return r?{data:r.value,etag:r.etag}:null},
 async setJSON(k,v,options={}){const old=data.get(k);if(options.onlyIfNew&&old||options.onlyIfMatch&&old?.etag!==options.onlyIfMatch)return {modified:false};data.set(k,{value:v,etag:String(++revision)});return {modified:true}},
 list({prefix,paginate}){const page={blobs:[...data.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))};return paginate?(async function*(){yield page})():Promise.resolve(page)}
};
process.env.HMF_HEIDI_SIGNING_EMAIL='heidi@example.com';process.env.SIGNWELL_API_KEY='mock';
const production={id:'wherein-lies-continue',name:'Wherein Lies Continue'},member={name:'Example Actor'};
assert.equal(await countersignatureNotice(store,{id:'doc1',status:'Waiting on actor'},member,production),false);
assert.equal(await countersignatureNotice(store,{id:'doc1',status:'Waiting on Heidi',syncError:'failed'},member,production),false);
const agreement={id:'doc1',status:'Waiting on Heidi'};
const results=await Promise.all([countersignatureNotice(store,agreement,member,production),countersignatureNotice(store,agreement,member,production)]);
assert.equal(results.filter(Boolean).length,1);
let queued=[...data].filter(([key])=>key.startsWith('outbox/'));
assert.equal(queued.length,1);assert(queued[0][1].value.text.includes('?production=wherein-lies-continue'));
data.delete(queued[0][0]);assert.equal(await countersignatureNotice(store,agreement,member,production),false,'Already delivered notices must not be requeued');
await store.setJSON('productions/wherein-lies-continue/agreements/person',{id:'doc2',status:'Waiting on actor'});
await store.setJSON('members/person',member);
globalThis.fetch=async()=>Response.json({status:'sent',recipients:[{id:'1',status:'signed'}]});
await checkSigningNotices(store);
assert.equal((await store.get('productions/wherein-lies-continue/agreements/person')).status,'Waiting on Heidi');
queued=[...data].filter(([key])=>key.startsWith('outbox/'));assert.equal(queued.length,1);assert(queued[0][1].value.text.includes('Example Actor'));
console.log('PASS: actor-first notifications, failure protection, concurrent/repeated delivery deduplication and unattended production status checks. No external requests.');
