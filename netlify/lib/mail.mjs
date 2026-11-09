import {supersededContractNotice} from './agreement-cycle.mjs';
import {manualPaperworkStatus} from './paperwork.mjs';
import {includesMember} from './calendar-audience.mjs';
import {createHash} from 'node:crypto';
export const mailReady=()=>Boolean(process.env.RESEND_API_KEY&&process.env.HMF_MAIL_FROM);
export const portalUrl='https://heidimikacfilms.com/members/';
export async function enqueue(store, member, event, subject, text, expires=0, options={}){
 const key='outbox/'+createHash('sha256').update(member.id+'/'+event).digest('hex');
 if(event.startsWith('calendar/')&&(await store.getMetadata('mail-log/'+key.split('/')[1])||await store.getMetadata('failed-mail/'+key.split('/')[1])))return;
 await store.setJSON(key,{id:member.id,to:member.email,...(event.startsWith('calendar/')?{calendarEvent:event.slice(9)}:{}),subject,text,expires,...(options.agreementCycle?{agreementCycle:options.agreementCycle}:{}),...(options.requirementKey?{requirementKey:options.requirementKey}:{}),created:Date.now(),attempts:0,nextAttempt:0},{onlyIfNew:true});
}

const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function emailHtml(message){
 const paragraphs=String(message.text).split(/\n\n+/).map(paragraph=>{
  const escaped=escapeHtml(paragraph);
  const linked=escaped.replace(/https:\/\/heidimikacfilms\.com\/members\/(?:\?(?:production=[a-z-]+|event=[\w-]{43}))?(?:#(?:invite|reset)=[a-f0-9]{64})?(?=\s|$)/g,link=>{
   const label=link.includes('#invite=')?'Set up your account':link.includes('#reset=')?'Reset your password':link.includes('?event=')?'View event':'Open your dashboard';
   return '<a href="'+link+'" style="display:inline-block;background:#803d48;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold">'+label+'</a>';
  });
  return '<p style="margin:0 0 20px">'+linked.replace(/\n/g,'<br>')+'</p>';
 }).join('');
 return '<!doctype html><html><body style="margin:0;background:#f5f3f0;color:#252122;font-family:Arial,sans-serif"><div style="max-width:560px;margin:0 auto;padding:28px 20px"><p style="font-size:14px;color:#6b343e">HEIDI MIKAC FILMS</p><h1 style="font-size:24px;line-height:1.3">'+escapeHtml(message.subject)+'</h1><div style="font-size:16px;line-height:1.6">'+paragraphs+'</div></div></body></html>';
}

export async function deliver(store){
 if(!mailReady())return;
 const entries=(await store.list({prefix:'outbox/'})).blobs;
 let processed=0;const deadline=Date.now()+22000;let lastRequest=0;
 const pace=async()=>{const delay=600-(Date.now()-lastRequest);if(delay>0)await new Promise(r=>setTimeout(r,delay));lastRequest=Date.now();};
 for(const {key} of entries){
  if(processed>=20||Date.now()>deadline-5000)break;
  const record=await store.getWithMetadata(key,{type:'json'}),msg=record?.data;if(!msg||msg.nextAttempt>Date.now())continue;
  const member=['Nick','Heidi'].includes(msg.id)?{id:msg.id}:await store.get('members/'+msg.id,{type:'json'});
  const logKey='mail-log/'+key.split('/')[1];
  const log=async(status,extra={})=>store.setJSON(logKey,{to:msg.to,subject:msg.subject,updated:Date.now(),status,...extra});
  if(supersededContractNotice(msg)){await log('Not sent — replaced agreement');await store.delete(key);continue;}
  if(msg.requirementKey&&manualPaperworkStatus(await store.get(msg.requirementKey,{type:'json'}))){await log('Not sent — document requirement completed');await store.delete(key);continue;}
  if((msg.expires&&msg.expires<Date.now())||!member||member.revoked){await log('Not sent — expired or access revoked');await store.delete(key);continue;}
  if(msg.calendarEvent||msg.subject==='New event on the production calendar'){
   const audience=msg.calendarEvent&&await store.get('calendar/audiences/'+msg.calendarEvent,{type:'json'});
   if(!Array.isArray(audience)||!includesMember(audience,member)||member.email!==msg.to){await store.delete(key);continue;}
  }
  // Lease the queue item; overlapping workers still share the provider idempotency key.
  if(!(await store.setJSON(key,{...msg,nextAttempt:Date.now()+120000},{onlyIfMatch:record.etag})).modified)continue;
  processed++;
  let response;
  try{await pace();response=await fetch('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(5000),headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':key.split('/')[1]},body:JSON.stringify({from:process.env.HMF_MAIL_FROM,to:[msg.to],subject:msg.subject,text:msg.text,html:emailHtml(msg)})});}catch{}
  if(response?.ok){const sent=await response.json().catch(()=>({}));await log('Accepted by email provider',{providerId:sent.id});await store.delete(key);continue;}
  const attempts=(msg.attempts||0)+1,retry=!response||response.status===429||response.status>=500;
  const error=response?'Email provider returned '+response.status:'Email provider did not respond';
  if(!retry||attempts>=6){await store.setJSON('failed-mail/'+key.split('/')[1],{...msg,attempts,lastError:error});await log('Failed — needs attention',{error});await store.delete(key);}
  else{await store.setJSON(key,{...msg,attempts,lastError:error,nextAttempt:Date.now()+Math.min(3600000,60000*2**attempts)});await log('Retry scheduled',{error});}
 }
 // Check recent provider acceptances for delivered/bounced/complained status.
 const logs=await Promise.all((await store.list({prefix:'mail-log/'})).blobs.map(async b=>({key:b.key,value:await store.get(b.key,{type:'json'})})));
 for(const {key,value:v} of logs.filter(x=>x.value?.providerId&&['Accepted by email provider','delivery_delayed'].includes(x.value.status)&&Date.now()-x.value.updated<7*86400000).sort((a,b)=>(a.value.lastProviderCheck||0)-(b.value.lastProviderCheck||0)).slice(0,10)){
  if(Date.now()>deadline-5000)break;
  try{await pace();const r=await fetch('https://api.resend.com/emails/'+encodeURIComponent(v.providerId),{signal:AbortSignal.timeout(5000),headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY}});if(!r.ok){await store.setJSON(key,{...v,lastProviderCheck:Date.now(),error:'Delivery status unavailable; check Resend.'});continue;}const data=await r.json();const status=['delivered','bounced','complained','failed','suppressed','delivery_delayed'].includes(data.last_event)?data.last_event:v.status;await store.setJSON(key,{...v,status,error:null,lastProviderCheck:Date.now(),updated:status===v.status?v.updated:Date.now()});}catch{}
 }
}
