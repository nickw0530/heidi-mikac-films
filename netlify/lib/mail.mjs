import {supersededContractNotice} from './agreement-cycle.mjs';
import {manualPaperworkStatus} from './paperwork.mjs';
import {includesMember} from './calendar-audience.mjs';
import {adminProfileOwner,loadAdminProfiles} from './admin-profiles.mjs';
import {createHash} from 'node:crypto';
export const mailReady=()=>Boolean(process.env.RESEND_API_KEY&&process.env.HMF_MAIL_FROM);
export const portalUrl='https://heidimikacfilms.com/members/';
export const TRACKING_KEY='mail-status/tracking';
const TRACKING_PAUSE=6*3600000;
const FILE_SENDS_PER_RUN=3;
const invitationSubjects=new Set(['Heidi Mikac Films — your Film Portal invitation','Heidi Mikac Films — finish setting up your account','Heidi Mikac Films — your cast & crew invitation','Written in the Dark — your cast & crew invitation','Wherein Lies Continue — your cast & crew invitation','Your invitation to Heidi Mikac Films']);
const personalNotices=new Set([...invitationSubjects,'Reset your Film Portal password','Reset your portal password','New production task','Document ready for signature','Agreement ready for your signature']);
const mailKey=(member,event)=>createHash('sha256').update(member.id+'/'+event).digest('hex');
const calendarReceipt=(email,event)=>'calendar/recipients/'+event+'/'+createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
export async function calendarInvitationAccepted(store,member,eventKey){
 if(await store.getMetadata(calendarReceipt(member.email,eventKey)))return true;
 const log=await store.get('mail-log/'+mailKey(member,'calendar/'+eventKey),{type:'json'});
 return log?.to===member.email&&['Accepted by email provider','delivered','delivery_delayed'].includes(log.status);
}
export async function enqueue(store, member, event, subject, text, expires=0, options={}){
 if(!member?.email)return;
 const id=mailKey(member,event),key='outbox/'+id;
 const [,calendarEvent,notice]=event.startsWith('calendar/')?event.split('/'):[];
 if(calendarEvent&&(await store.getMetadata('mail-log/'+id)||await store.getMetadata('failed-mail/'+id)))return;
 await store.setJSON(key,{id:member.id,to:member.email,...(calendarEvent?{calendarEvent,...(notice==='cancelled'?{calendarCancellation:true}:{}),...(options.calendarRevision?{calendarRevision:options.calendarRevision}:{})}:{}),subject,text,expires,...(options.invitationDigest?{invitationDigest:options.invitationDigest}:{}),...(options.agreementCycle?{agreementCycle:options.agreementCycle}:{}),...(options.requirementKey?{requirementKey:options.requirementKey}:{}),...(options.attachmentKey?{attachmentKey:options.attachmentKey,attachmentName:options.attachmentName}:{}),...(options.resourceKey?{resourceKey:options.resourceKey,production:options.production}:{}),created:Date.now(),attempts:0,nextAttempt:0},{onlyIfNew:true});
}

function queuedInvitationDigest(message){
 if(message.invitationDigest)return message.invitationDigest;
 const legacyToken=message.text?.match(/https:\/\/heidimikacfilms\.com\/members\/#invite=([a-f0-9]{64})(?=\s|$)/)?.[1];
 return legacyToken?createHash('sha256').update(legacyToken).digest('hex'):null;
}

const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function emailHtml(message){
 const paragraphs=String(message.text).split(/\n\n+/).map(paragraph=>{
  const escaped=escapeHtml(paragraph);
  const linked=escaped.replace(/https:\/\/heidimikacfilms\.com\/members\/(?:\?(?:production=[a-z-]+|event=[\w-]{43}))?(?:#(?:invite|reset)=[a-f0-9]{64})?(?=\s|$)/g,link=>{
   const label=link.includes('#invite=')?'Set up your account':link.includes('#reset=')?'Reset your password':link.includes('?event=')?'View event':['Nick','Heidi'].includes(message.id)?'Open your dashboard':'Open your Film Portal';
   return '<a href="'+link+'" style="display:inline-block;background:#803d48;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold">'+label+'</a>';
  });
  return '<p style="margin:0 0 20px">'+linked.replace(/\n/g,'<br>')+'</p>';
 }).join('');
 return '<!doctype html><html><body style="margin:0;background:#f5f3f0;color:#252122;font-family:Arial,sans-serif"><div style="max-width:560px;margin:0 auto;padding:28px 20px"><p style="font-size:14px;color:#6b343e">HEIDI MIKAC FILMS</p><h1 style="font-size:24px;line-height:1.3">'+escapeHtml(message.subject)+'</h1><div style="font-size:16px;line-height:1.6">'+paragraphs+'</div></div></body></html>';
}

export async function deliver(store,{currentCalendarEvent}={}){
 if(!mailReady())return;
 const entries=(await store.list({prefix:'outbox/'})).blobs;
 const adminProfiles=entries.length?await loadAdminProfiles(store):{};
 let processed=0,sentWithFile=0;const deadline=Date.now()+22000;let lastRequest=0;
 const pace=async()=>{const delay=600-(Date.now()-lastRequest);if(delay>0)await new Promise(r=>setTimeout(r,delay));lastRequest=Date.now();};
 // Email without attachments goes first. A sign-in or signing email is short-lived and must
 // never wait behind a file that is being sent to a whole production.
 for(const withFile of [false,true])for(const {key} of entries){
  if(processed>=20||Date.now()>deadline-5000)break;
  if(withFile&&sentWithFile>=FILE_SENDS_PER_RUN)break; // Large sends are spread over later runs to stay inside the time limit.
  const record=await store.getWithMetadata(key,{type:'json'}),msg=record?.data;if(!msg||msg.nextAttempt>Date.now()||!!msg.attachmentKey!==withFile)continue;
  const member=!msg.calendarEvent&&['Nick','Heidi'].includes(msg.id)?{id:msg.id}:await store.get('members/'+msg.id,{type:'json'});
  const logKey='mail-log/'+key.split('/')[1];
  const log=async(status,extra={})=>store.setJSON(logKey,{to:msg.to,subject:msg.subject,updated:Date.now(),status,...extra});
  const invitation=invitationSubjects.has(msg.subject)||!!msg.invitationDigest;
  const inviteDigest=invitation?queuedInvitationDigest(msg):null;
  const currentInvitation=person=>!!inviteDigest&&person?.ticket===inviteDigest&&person.email===msg.to&&!person.revoked&&(!msg.expires||msg.expires>Date.now());
  const discardInvitation=async()=>{await log('Not sent — invitation replaced or used');await store.delete(key);};
  if(supersededContractNotice(msg)){await log('Not sent — replaced agreement');await store.delete(key);continue;}
  const requirementOwner=msg.requirementKey?.startsWith('document-tracking/')?msg.requirementKey.split('/')[2]:null;
  if((requirementOwner&&adminProfileOwner(adminProfiles,requirementOwner))||(personalNotices.has(msg.subject)&&adminProfileOwner(adminProfiles,msg.id))){await log('Not sent — admin profile exempt');await store.delete(key);continue;}
  if(msg.requirementKey&&manualPaperworkStatus(await store.get(msg.requirementKey,{type:'json'}))){await log('Not sent — document requirement completed');await store.delete(key);continue;}
  if((msg.expires&&msg.expires<Date.now())||!member||member.revoked){await log('Not sent — expired or access revoked');await store.delete(key);continue;}
  if(invitation&&!currentInvitation(member)){await discardInvitation();continue;}
  // Anything queued for an address that was corrected afterwards stays out of the old inbox.
  if(!invitation&&member.email&&msg.to&&member.email!==msg.to){await log('Not sent — email address changed');await store.delete(key);continue;}
  if(msg.resourceKey){
   // A posted message or file is only for the people it is still shared with when the email is sent.
   const resource=await store.get(msg.resourceKey,{type:'json'});
   const assigned=member.productions??{'written-in-the-dark':{}};
   if(!resource||!Object.hasOwn(assigned,msg.production)||(resource.audience&&!resource.audience.includes(member.id))){await log('Not sent — no longer shared with this person');await store.delete(key);continue;}
  }
  if(msg.calendarEvent||msg.subject==='New event on the production calendar'){
   const state=msg.calendarEvent&&await store.get('calendar/event-state/'+msg.calendarEvent,{type:'json'});
   const audience=msg.calendarCancellation?(state?.cancelled?state.cancelledAudience:[]):
    (state?.audience??(msg.calendarEvent&&await store.get('calendar/audiences/'+msg.calendarEvent,{type:'json'})));
   if(!Array.isArray(audience)||!includesMember(audience,member)||member.email!==msg.to){await store.delete(key);continue;}
   if(msg.calendarRevision){
    if(state?.revision!==msg.calendarRevision){await store.delete(key);continue;}
    try{
     // Outlook may have changed the audience or privacy since the last scheduled scan.
     if(!currentCalendarEvent)continue;
     if(!await currentCalendarEvent(msg.calendarEvent,msg.calendarRevision,member)){await store.delete(key);continue;}
    }catch{continue;}
   }
  }
  // Lease the queue item; overlapping workers still share the provider idempotency key.
  if(!(await store.setJSON(key,{...msg,nextAttempt:Date.now()+120000},{onlyIfMatch:record.etag})).modified)continue;
  processed++;if(msg.attachmentKey)sentWithFile++;
  let response;
  try{
   await pace();
   if(invitation){
    const password=await store.get('passwords/'+msg.id,{type:'json'});
    const current=await store.get('members/'+msg.id,{type:'json'});
    if(password||!currentInvitation(current)){await discardInvitation();continue;}
   }
   // A file posted with the message travels with the email. It is read when the
   // email is sent, so a file removed from the board in the meantime is never mailed.
   let attachments;
   if(msg.attachmentKey){
    const file=await store.get(msg.attachmentKey,{type:'arrayBuffer'});
    if(!file){await log('Not sent — file removed');await store.delete(key);continue;}
    attachments=[{filename:msg.attachmentName||'document.pdf',content:Buffer.from(file).toString('base64')}];
   }
   response=await fetch('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(attachments?20000:5000),headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':key.split('/')[1]},body:JSON.stringify({from:process.env.HMF_MAIL_FROM,to:[msg.to],subject:msg.subject,text:msg.text,html:emailHtml(msg),...(attachments?{attachments}:{})})});
  }catch{}
  if(response?.ok){
   const sent=await response.json().catch(()=>({}));
   if(msg.calendarEvent&&!msg.calendarCancellation)await store.setJSON(calendarReceipt(msg.to,msg.calendarEvent),true,{onlyIfNew:true});
   await log('Accepted by email provider',{providerId:sent.id});await store.delete(key);continue;
  }
  const attempts=(msg.attempts||0)+1,retry=!response||response.status===429||response.status>=500;
  const error=response?'Email provider returned '+response.status:'Email provider did not respond';
  if(!retry||attempts>=6){await store.setJSON('failed-mail/'+key.split('/')[1],{...msg,attempts,lastError:error});await log('Failed — needs attention',{error});await store.delete(key);}
  else{await store.setJSON(key,{...msg,attempts,lastError:error,nextAttempt:Date.now()+Math.min(3600000,60000*2**attempts)});await log('Retry scheduled',{error});}
 }
 // Check recent provider acceptances for delivered/bounced/complained status.
 let tracking=await store.get(TRACKING_KEY,{type:'json'});
 if(tracking?.blocked&&Date.now()-tracking.at<TRACKING_PAUSE)return;
 const logs=await Promise.all((await store.list({prefix:'mail-log/'})).blobs.map(async b=>({key:b.key,value:await store.get(b.key,{type:'json'})})));
 for(const {key,value:v} of logs.filter(x=>x.value?.providerId&&['Accepted by email provider','delivery_delayed'].includes(x.value.status)&&Date.now()-x.value.updated<7*86400000).sort((a,b)=>(a.value.lastProviderCheck||0)-(b.value.lastProviderCheck||0)).slice(0,10)){
  if(Date.now()>deadline-5000)break;
  try{await pace();const r=await fetch('https://api.resend.com/emails/'+encodeURIComponent(v.providerId),{signal:AbortSignal.timeout(5000),headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY}});
   if(r.status===401||r.status===403){
    // The key may send but not read. Every lookup would fail the same way, so
    // record it once for the admin page and stop asking until the pause ends.
    await store.setJSON(TRACKING_KEY,{blocked:true,status:r.status,at:Date.now()});break;
   }
   if(!r.ok){await store.setJSON(key,{...v,lastProviderCheck:Date.now(),error:'Delivery status unavailable (Resend returned '+r.status+').'});continue;}
   if(tracking?.blocked){await store.delete(TRACKING_KEY);tracking=null;}
   const data=await r.json();
   // Opened or clicked means it arrived; record it as delivered so it stops being re-checked.
   const event=['opened','clicked'].includes(data.last_event)?'delivered':data.last_event;
   const status=['delivered','bounced','complained','failed','suppressed','delivery_delayed'].includes(event)?event:v.status;await store.setJSON(key,{...v,status,error:null,lastProviderCheck:Date.now(),updated:status===v.status?v.updated:Date.now()});}catch{}
 }
}
