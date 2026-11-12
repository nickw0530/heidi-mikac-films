import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {emailHtml,deliver,enqueue} from '../netlify/lib/mail.mjs';
import {refreshAgreement} from '../netlify/lib/signing.mjs';
const records=new Map(),store={async get(k){return records.get(k)||null},async getWithMetadata(k){return records.has(k)?{data:records.get(k),etag:'1'}:null},async list({prefix}){return {blobs:[...records.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))}},async setJSON(k,v,o){if(o?.onlyIfNew&&records.has(k))return {modified:false};records.set(k,v);return {modified:true}},async delete(k){records.delete(k)}};
const link='https://heidimikacfilms.com/members/?production=wherein-lies-continue';
assert(emailHtml({text:link,subject:'<unsafe>'}).includes('href="'+link+'"'));assert(emailHtml({text:link,subject:'<unsafe>'}).includes('&lt;unsafe&gt;'));
assert(emailHtml({text:'https://heidimikacfilms.com/members/#reset='+'a'.repeat(64),subject:'Reset'}).includes('Reset your password'));
process.env.RESEND_API_KEY='mock';process.env.HMF_MAIL_FROM='test@example.com';process.env.SIGNWELL_API_KEY='mock';
records.set('members/a',{id:'a'});records.set('members/b',{id:'b'});
await enqueue(store,{id:'a',email:'bad@example.com'},'event','Bad','Message');await enqueue(store,{id:'b',email:'good@example.com'},'event','Good','Message');
let sends=0;globalThis.fetch=async(u,o)=>{if(o?.method==='POST'){sends++;return new Response(JSON.parse(o.body).to[0]==='bad@example.com'?'{}':'{"id":"sent-1"}',{status:JSON.parse(o.body).to[0]==='bad@example.com'?422:200});}return Response.json({last_event:'delivered'});};
await deliver(store);assert.equal(sends,2,'A permanent error does not starve the next recipient');assert.equal([...records.keys()].filter(k=>k.startsWith('failed-mail/')).length,1);assert([...records.values()].some(v=>v.status==='delivered'));assert.equal([...records.keys()].filter(k=>k.startsWith('outbox/')).length,0);

const invitationSubject='Heidi Mikac Films — your cast & crew invitation';
const hash=value=>createHash('sha256').update(value).digest('hex');
const current='a'.repeat(64),superseded='b'.repeat(64);
const validRecipient='valid@example.invalid',oldRecipient='old@example.invalid';
const invitee={id:'invitee',email:validRecipient,ticket:hash(current)};
records.set('members/'+invitee.id,invitee);
async function queueInvite(person,ticket,options={}){
 const digest=hash(ticket),event='invite/'+digest;
 const body='Choose your password.\n\nhttps://heidimikacfilms.com/members/#invite='+ticket+'\n\nThis invitation expires in seven days.';
 await enqueue(store,person,event,options.subject||invitationSubject,body,Date.now()+3600000,options.legacy?{}:{invitationDigest:digest});
 return hash(person.id+'/'+event);
}
const replaced=await queueInvite(invitee,superseded,{legacy:true,subject:'Written in the Dark — your cast & crew invitation'});
const wrongAddress=await queueInvite({...invitee,email:oldRecipient},current);
const activeInvitee={...invitee,id:'active-invitee'};
records.set('members/'+activeInvitee.id,activeInvitee);
records.set('passwords/'+activeInvitee.id,{digest:'already-configured'});
const activated=await queueInvite(activeInvitee,current);
const racingInvitee={...invitee,id:'racing-invitee'};
records.set('members/'+racingInvitee.id,racingInvitee);
const racing=await queueInvite(racingInvitee,current);
const legacyInvitee={...invitee,id:'legacy-invitee',email:'legacy@example.invalid'};
records.set('members/'+legacyInvitee.id,legacyInvitee);
await queueInvite(legacyInvitee,current,{legacy:true});
const freshInvitee={...invitee,id:'fresh-invitee',email:'fresh@example.invalid'};
records.set('members/'+freshInvitee.id,freshInvitee);
await queueInvite(freshInvitee,current);

const sentTo=[];
globalThis.fetch=async(_url,options)=>{
 if(options?.method!=='POST')return Response.json({last_event:'delivered'});
 sentTo.push(JSON.parse(options.body).to[0]);
 return Response.json({id:'invite-'+sentTo.length});
};
const racingStore={...store,async setJSON(key,value,options){
 const result=await store.setJSON(key,value,options);
 if(key==='outbox/'+racing&&value.nextAttempt>0)records.set('members/'+racingInvitee.id,{...racingInvitee,ticket:hash(superseded)});
 return result;
}};
await deliver(racingStore);
assert.deepEqual(sentTo,[legacyInvitee.email,freshInvitee.email],'Only the current invitation reaches the provider, including invitations queued by an older release.');
for(const key of [replaced,wrongAddress,activated,racing]){
 assert.equal(records.get('mail-log/'+key)?.status,'Not sent — invitation replaced or used');
 assert.ok(!records.has('outbox/'+key));
}

records.set('agreements/a',{id:'doc',status:'Waiting on actor'});globalThis.fetch=async()=>Response.json({status:'sent',recipients:[{id:'1',status:'signed'}]});assert.equal((await refreshAgreement(store,'agreements/a')).status,'Waiting on Heidi');
globalThis.fetch=async()=>{throw Error('Network down')};assert.equal((await refreshAgreement(store,'agreements/a',true)).status,'Waiting on Heidi');assert((await store.get('agreements/a')).syncError);
console.log('PASS: contextual email buttons, escaping, reset links, stale invitation suppression, queue isolation, delivery logs and signing refresh failures. No external requests.');
