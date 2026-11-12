import {eventProductions,includesMember} from '../lib/calendar-audience.mjs';
import {calendarInvitationAccepted} from '../lib/mail.mjs';
import {createHash, randomBytes} from 'node:crypto';
import {getStore} from '@netlify/blobs';

const origin='https://heidimikacfilms.com';
const redirect=origin+'/.netlify/functions/calendar-callback';
const tenant='7b0dc2ce-48a2-4703-987f-9bbca1bf0089';
const authority='https://login.microsoftonline.com/'+tenant+'/oauth2/v2.0';
const client='858bc951-de5f-4423-8602-acf4923ba964';
const mailbox='hello@heidimikacfilms.com';
const scope='offline_access User.Read Calendars.Read';
const binding='calendar/connection';
const calendarRowsVersion=3;
const calendarWindow=30*86400000;
const maxNoteLength=12000;
const eventStateKey=key=>'calendar/event-state/'+key;
const nonce=()=>randomBytes(32).toString('base64url');
const digest=value=>createHash('sha256').update(value).digest('base64url');
const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'};
const cookie=(value,seconds)=>'__Host-hmf-cal='+value+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age='+seconds;

export async function begin(store,sessionKey){
 if(!process.env.HMF_CALENDAR_CLIENT_SECRET)throw new Error('Calendar credential missing');
 const state=nonce(),browser=nonce(),verifier=nonce();
 await store.setJSON('calendar/state/'+state,{sessionKey,browser:digest(browser),verifier,expires:Date.now()+600000});
 const params=new URLSearchParams({client_id:client,response_type:'code',redirect_uri:redirect,scope,state,code_challenge:digest(verifier),code_challenge_method:'S256',login_hint:mailbox});
 return Response.json({url:authority+'/authorize?'+params},{headers:{...headers,'Set-Cookie':cookie(browser,600)}});
}

async function exchange(fields){
 const response=await fetch(authority+'/token',{method:'POST',signal:AbortSignal.timeout(15000),body:new URLSearchParams({client_id:client,client_secret:process.env.HMF_CALENDAR_CLIENT_SECRET,...fields})});
 if(!response.ok)throw new Error('Microsoft authorization failed');
 return response.json();
}
async function graph(path,token,timeout=15000,preferText=false){
 const requestHeaders={Authorization:'Bearer '+token};
 if(preferText)requestHeaders.Prefer='outlook.body-content-type="text"';
 const response=await fetch('https://graph.microsoft.com/v1.0/'+path,{signal:AbortSignal.timeout(timeout),headers:requestHeaders});
 if(!response.ok)throw Object.assign(new Error('Calendar unavailable'),{status:response.status});
 return response.json();
}
const fields='id,subject,start,end,isAllDay,isCancelled,sensitivity,categories,location';
const trackingFields=fields+',createdDateTime,lastModifiedDateTime,recurrence';
const utcTime=value=>{
 if(!value)return NaN;
 return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(value)?value:value+'Z');
};
function display(event,includeOutlookId=false){
 const productions=eventProductions(event);
 return {
  key:digest(event.id),title:event.subject,start:event.start?.dateTime,end:event.end?.dateTime,
  allDay:!!event.isAllDay,productions,
  location:productions.length?String(event.location?.displayName||'').trim().slice(0,300):'',
  ...(includeOutlookId&&productions.length?{outlookId:event.id}:{})
 };
}
async function* pages(path,token){
 while(path){
  const data=await graph(path,token);
  yield data.value;
  const next=data['@odata.nextLink'];
  if(!next)break;
  const u=new URL(next);
  if(u.origin!=='https://graph.microsoft.com'||!u.pathname.startsWith('/v1.0/'))throw Error('Unexpected calendar page');
  path=u.pathname.slice('/v1.0/'.length)+u.search;
 }
}
async function upcoming(token){
 const now=Date.now();
 const params=new URLSearchParams({startDateTime:new Date(now).toISOString(),endDateTime:new Date(now+calendarWindow).toISOString(),'$select':fields,'$orderby':'start/dateTime','$top':'100'});
 const rows=[];
 for await(const page of pages('me/calendarView?'+params,token))rows.push(...page.filter(e=>!e.isCancelled));
 return rows.map(event=>display(event,true));
}
async function access(store,record){
 const token=await exchange({grant_type:'refresh_token',refresh_token:record.data.refresh});
 const updated={...record.data,refresh:token.refresh_token||record.data.refresh};
 await store.setJSON(binding,updated,{onlyIfMatch:record.etag});
 return token.access_token;
}
export async function events(store,admin,eventKey,member,{notesOnly=false}={}){
 if(notesOnly)return eventNotes(store,admin,eventKey,member);
 const record=await store.getWithMetadata(binding,{type:'json'});
 if(!record)return Response.json({connected:false,notesEnabled:false},{headers});
 let token;
 let rows=record.data.productionCalendarRows;
 if(!rows||record.data.calendarRowsVersion!==calendarRowsVersion||record.data.cachedUntil<=Date.now()){
  token=await access(store,record);
  rows=await upcoming(token);
  const latest=await store.getWithMetadata(binding,{type:'json'});
  if(latest)await store.setJSON(binding,{...latest.data,productionCalendarRows:rows,calendarRowsVersion,cachedUntil:Date.now()+120000},{onlyIfMatch:latest.etag});
 }
 let items=rows.filter(event=>admin||includesMember(event.productions,member));
 let selected=null;
 if(/^[\w-]{43}$/.test(eventKey||'')){
  const id=await store.get('calendar/event-links/'+eventKey);
  if(id){
   // A fresh direct lookup supersedes any cached copy of the selected event.
   items=items.filter(event=>event.key!==eventKey);
   token??=await access(store,await store.getWithMetadata(binding,{type:'json'}));
   const cancelled=async()=>{
    const state=await store.get(eventStateKey(eventKey),{type:'json'});
    const previousAudience=state?.cancelledAudience||state?.audience||
      await store.get('calendar/audiences/'+eventKey,{type:'json'});
    if(admin||includesMember(previousAudience,member))selected={key:eventKey,cancelled:true};
   };
   try{
    const event=await graph('me/calendar/events/'+encodeURIComponent(id)+'?$select='+fields,token);
    if(event.isCancelled)await cancelled();
    else if(admin||includesMember(eventProductions(event),member))selected=display(event);
   }catch(error){
    if(error.status!==404&&error.status!==410)throw error;
    await cancelled();
   }
  }
 }
 return Response.json({
  connected:true,notesEnabled:record.data.notesEnabled===true,
  items:items.map(({outlookId,...event})=>event),selected
 },{headers});
}

const entities=new Map(Object.entries({
 amp:'&',apos:"'",quot:'"',lt:'<',gt:'>',nbsp:' ',ndash:'–',mdash:'—',hellip:'…',
 lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”',bull:'•'
}));
function plainOutlookNote(event){
 const content=typeof event.body?.content==='string'?event.body.content:'';
 if(event.body?.contentType?.toLowerCase()!=='html')return content||event.bodyPreview||'';
 return content
  .replace(/<!--[\s\S]*?-->/g,'')
  .replace(/<(head|script|style|template|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'')
  .replace(/<br\b[^>]*>|<\/(?:p|div|li|tr|h[1-6])\s*>/gi,'\n')
  .replace(/<[^>]*>/g,'')
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi,(match,name)=>{
   if(!name.startsWith('#'))return entities.get(name)||match;
   const hexadecimal=name[1].toLowerCase()==='x';
   const number=Number.parseInt(name.slice(hexadecimal?2:1),hexadecimal?16:10);
   return number>0&&number<=0x10ffff&&!(number>=0xd800&&number<=0xdfff)?String.fromCodePoint(number):'�';
  });
}

export async function eventNotes(store,admin,eventKey,member){
 const empty=()=>Response.json({notes:'',truncated:false},{headers});
 if(!/^[\w-]{43}$/.test(eventKey||''))return empty();
 const record=await store.getWithMetadata(binding,{type:'json'});
 if(record?.data?.notesEnabled!==true)return empty();
 const known=record.data.productionCalendarRows?.find(event=>event.key===eventKey);
 if(known&&(!known.productions.length||!admin&&!includesMember(known.productions,member)))return empty();
 let id=known?.outlookId;
 if(!id){
  id=await store.get('calendar/event-links/'+eventKey);
  if(!id)return empty();
  const state=await store.get(eventStateKey(eventKey),{type:'json'});
  const audience=state?.audience??await store.get('calendar/audiences/'+eventKey,{type:'json'});
  if(!audience?.length||!admin&&!includesMember(audience,member))return empty();
 }
 const token=await access(store,record);
 let event;
 try{
  const params=new URLSearchParams({'$select':'id,categories,sensitivity,isCancelled,body,bodyPreview'});
  event=await graph('me/calendar/events/'+encodeURIComponent(id)+'?'+params,token,15000,true);
 }catch(error){
  if(error.status===404||error.status===410)return empty();
  throw error;
 }
 const productions=eventProductions(event);
 if(event.id!==id||!productions.length||!admin&&!includesMember(productions,member))return empty();
 const note=plainOutlookNote(event).replace(/\r\n?/g,'\n').replace(/\u00a0/g,' ').trim();
 const characters=Array.from(note);
 return Response.json({notes:characters.slice(0,maxNoteLength).join(''),truncated:characters.length>maxNoteLength},{headers});
}
const notices={
 new:['New event on the production calendar','A new event has been added to your Heidi Mikac Films Film Portal.'],
 updated:['Production calendar event updated','An event in your Heidi Mikac Films Film Portal has changed.'],
 cancelled:['Production calendar event cancelled','A previously announced Heidi Mikac Films calendar event has been cancelled. Sign in to see its status.']
};

const easternEventTime=new Intl.DateTimeFormat('en-US',{
 timeZone:'America/Indiana/Indianapolis',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'
});
const allDayEventDate=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric'});

function eventSummary(event){
 const title=String(event.title||'').replace(/\s+/g,' ').trim().slice(0,300)||'Production event';
 const start=utcTime(event.start),end=utcTime(event.end);
 if(!Number.isFinite(start))return title;
 const hasEnd=Number.isFinite(end)&&end>start;
 const when=event.allDay
  ?allDayEventDate.formatRange(start,hasEnd?end-1:start)+' · All day'
  :(hasEnd?easternEventTime.formatRange(start,end):easternEventTime.format(start))+' (Eastern time)';
 return title+'\n'+when;
}

async function observeEvent(store,event,{deletedAt,windowStart}={}){
 const key=digest(event.id);
 const path=eventStateKey(key);
 const record=await store.getWithMetadata(path,{type:'json'});
 const previous=record?.data;
 const revision=deletedAt||event.lastModifiedDateTime;
 if(!revision||previous?.revision>revision)return null;
 if(previous?.revision===revision)return previous;

 const cancelled=!!(event.isCancelled||deletedAt);
 const details=cancelled?null:display(event);
 const audience=details?.productions||[];
 const legacyAudience=previous?[]:await store.get('calendar/audiences/'+key,{type:'json'});
 if(!audience.length&&!previous&&!legacyAudience?.length)return null;
 const previousAudience=previous?.audience??legacyAudience??[];
 const cancelledAudience=cancelled?(previous?.cancelledAudience||previousAudience):null;
 const upcoming=!!(event.recurrence||utcTime(details?.end)>=Date.now());
 const formerEnd=utcTime(previous?.upcomingUntil);
 const wasUpcoming=previous?.recurring||formerEnd>=Date.now();
 let notice=null;
 const legacyEnd=utcTime(event.end?.dateTime);
 if(cancelled&&cancelledAudience.length&&!previous?.cancelled&&(wasUpcoming||!previous&&(event.recurrence||!Number.isFinite(legacyEnd)||legacyEnd>=Date.now())))notice='cancelled';
 else if(audience.length&&(upcoming||wasUpcoming)){
  // Graph revisions cover notes and other edits without copying the body into the mail queue.
  const existing=previousAudience.length>0||!previous&&(event.type==='exception'||utcTime(event.createdDateTime)<utcTime(windowStart));
  notice=existing?'updated':'new';
 }
 const state={
  key,revision,audience,cancelled,cancelledAudience,notice,
  ...(notice&&!cancelled?{summary:eventSummary(details),previousAudience:previous?previousAudience:null,firstNotice:!previous&&!previousAudience.length}:{}),
  upcomingUntil:audience.length?details.end:null,recurring:!!(audience.length&&event.recurrence),checkedAt:Date.now()
 };
 if(notice)await store.set('calendar/event-links/'+key,event.id,{onlyIfNew:true});
 const saved=await store.setJSON(path,state,record?{onlyIfMatch:record.etag}:{onlyIfNew:true});
 if(!saved.modified)throw new Error('Calendar event changed during the notification run');
 return state;
}

async function queueEventNotice(store,enqueue,portalUrl,state,members){
 if(!state?.notice)return;
 const recipients=state.cancelled?state.cancelledAudience:state.audience;
 const version=digest(state.revision);
 const noticeEvent='calendar/'+state.key;
 const addressed=new Set();
 for(const member of members.filter(member=>includesMember(recipients,member))){
  const email=member.email.trim().toLowerCase();
  if(!email||addressed.has(email))continue;
  if(state.cancelled&&!await calendarInvitationAccepted(store,member,state.key))continue;
  const newlyEligible=state.previousAudience&&!includesMember(state.previousAudience,member);
  const kind=state.notice==='updated'&&newlyEligible?'new':state.notice;
  const event=kind==='new'&&(state.firstNotice||!state.summary)?noticeEvent:noticeEvent+'/'+kind+'/'+version;
  const [subject,body]=notices[kind];
  const summary=state.cancelled?'':state.summary;
  const text=[body,summary,!state.cancelled?'Sign in to view the event details.':'',portalUrl+'?event='+state.key].filter(Boolean).join('\n\n');
  await enqueue(store,member,event,subject,text,0,summary?{calendarRevision:state.revision}:{});
  addressed.add(email);
 }
}

export function calendarNoticeValidator(store){
 let token;
 const events=new Map();
 return async(key,revision,member)=>{
  if(!events.has(key))events.set(key,(async()=>{
   const id=await store.get('calendar/event-links/'+key);
   if(!id)return null;
   token??=(async()=>{
    const connection=await store.getWithMetadata(binding,{type:'json'});
    if(!connection)throw Error('Outlook calendar is disconnected');
    return access(store,connection);
   })();
   try{
    const params=new URLSearchParams({'$select':'id,categories,sensitivity,isCancelled,lastModifiedDateTime'});
    return await graph('me/calendar/events/'+encodeURIComponent(id)+'?'+params,await token,5000);
   }catch(error){
    if(error.status===404||error.status===410)return null;
    throw error;
   }
  })());
  const event=await events.get(key);
  return event?.lastModifiedDateTime===revision&&includesMember(eventProductions(event),member);
 };
}

async function checkRemovedEvents(store,token,now,observe,queue){
 const states=await store.list({prefix:'calendar/event-state/'});
 const records=await Promise.all(states.blobs.map(blob=>store.getWithMetadata(blob.key,{type:'json'})));
 for(const {data} of records.filter(row=>row?.data?.notice&&!row.data.noticeQueued))await queue(data);
 const candidates=records
  .filter(row=>row?.data?.audience?.length&&!row.data.cancelled&&
   (row.data.recurring||utcTime(row.data.upcomingUntil)>=now)&&row.data.checkedAt<=now-600000)
  .sort((a,b)=>a.data.checkedAt-b.data.checkedAt).slice(0,8);
 await Promise.all(candidates.map(async row=>{
  const {key}=row.data;
  const id=await store.get('calendar/event-links/'+key);
  if(!id)return;
  let event;
  try{
   event=await graph('me/calendar/events/'+encodeURIComponent(id)+'?$select='+trackingFields,token,5000);
  }catch(error){
   if(error.status===404||error.status===410){
    await observe({id},{deletedAt:new Date(now).toISOString()});
    return;
   }
   // A transient read failure does not indicate a cancellation.
  }
  if(event&&(event.isCancelled||event.lastModifiedDateTime>row.data.revision))await observe(event);
  else await store.setJSON(eventStateKey(key),{...row.data,checkedAt:now},{onlyIfMatch:row.etag});
 }));
}

export async function notifyNewEvents(store,enqueue,portalUrl){
 const checkpoint='calendar/notification-cursor';
 const now=Date.now(),end=new Date(now-60000).toISOString();
 const cursor=await store.getWithMetadata(checkpoint,{type:'json'});
 if(!cursor){await store.setJSON(checkpoint,end,{onlyIfNew:true});return;}
 if(cursor.data>=end)return;
 const connection=await store.getWithMetadata(binding,{type:'json'});
 if(!connection)return;
 const token=await access(store,connection);
 const query=new URLSearchParams({'$select':trackingFields,'$filter':'lastModifiedDateTime ge '+cursor.data+' and lastModifiedDateTime lt '+end,'$top':'100'});
 let membersPromise;
 let changed=false;
 const queue=async state=>{
  if(!state.notice||state.noticeQueued)return;
  membersPromise??=store.list({prefix:'members/'}).then(async({blobs})=>
   (await Promise.all(blobs.map(blob=>store.get(blob.key,{type:'json'})))).filter(member=>member&&!member.revoked&&member.email));
  await queueEventNotice(store,enqueue,portalUrl,state,await membersPromise);
  const path=eventStateKey(state.key),record=await store.getWithMetadata(path,{type:'json'});
  if(record?.data?.revision===state.revision)await store.setJSON(path,{...record.data,noticeQueued:true},{onlyIfMatch:record.etag});
 };
 const observe=async(event,options)=>{
  const state=await observeEvent(store,event,{windowStart:cursor.data,...options});
  if(!state)return;
  changed=true;
  await queue(state);
 };
 for await(const page of pages('me/calendar/events?'+query,token))for(const event of page)await observe(event);
 // The event list returns series masters. The calendar view exposes edits to a single occurrence.
 const instances=new URLSearchParams({startDateTime:new Date(now).toISOString(),endDateTime:new Date(now+calendarWindow).toISOString(),'$select':trackingFields+',type','$top':'100'});
 for await(const page of pages('me/calendarView?'+instances,token))for(const event of page){
  if(event.type==='exception'&&event.lastModifiedDateTime>=cursor.data&&event.lastModifiedDateTime<end)await observe(event);
 }
 await checkRemovedEvents(store,token,now,observe,queue);
 if(changed){
  const latest=await store.getWithMetadata(binding,{type:'json'});
  if(latest)await store.setJSON(binding,{...latest.data,cachedUntil:0},{onlyIfMatch:latest.etag});
 }
 await store.setJSON(checkpoint,end,{onlyIfMatch:cursor.etag});
}
export default async function callback(req){
 try{
  const url=new URL(req.url),state=url.searchParams.get('state');
  if(url.origin!==origin||req.method!=='GET'||!/^[\w-]{43}$/.test(state||''))throw Error();
  const store=getStore({name:'hmf-members-v1',consistency:'strong'});
  const key='calendar/state/'+state,record=await store.getWithMetadata(key,{type:'json'});
  const pending=record?.data;
  const browser=req.headers.get('cookie')?.match(/(?:^|; )__Host-hmf-cal=([\w-]{43})(?:;|$)/)?.[1];
  if(!browser||!pending||pending.expires<Date.now()||pending.browser!==digest(browser))throw Error();
  const session=await store.get(pending.sessionKey,{type:'json'});
  if(!session?.admin||session.expires<Date.now()||!['Nick','Heidi'].includes(session.id)||session.adminDigest!==process.env['HMF_'+session.id.toUpperCase()+'_LOGIN_SHA256'])throw Error();
  if((session.passwordVersion||0)!==((await store.get('passwords/'+session.id,{type:'json'}))?.version||0))throw Error();
  if(!(await store.setJSON(key,{expires:0},{onlyIfMatch:record.etag})).modified)throw Error();
  const token=await exchange({grant_type:'authorization_code',code:url.searchParams.get('code'),redirect_uri:redirect,code_verifier:pending.verifier});
  const user=await graph('me?$select=userPrincipalName',token.access_token);
  if(user.userPrincipalName?.toLowerCase()!==mailbox||!token.refresh_token)throw Error();
  const scopes=String(token.scope||'').split(/\s+/).map(value=>value.split('/').at(-1));
  if(!scopes.includes('Calendars.Read')&&!scopes.includes('Calendars.ReadWrite'))throw Error();
  const rows=await upcoming(token.access_token);
  await store.setJSON(binding,{refresh:token.refresh_token,notesEnabled:true,
   productionCalendarRows:rows,calendarRowsVersion,cachedUntil:Date.now()+120000});
  return new Response(null,{status:303,headers:{...headers,'Set-Cookie':cookie('',0),Location:'/members/?view=calendar'}});
 }catch{return new Response('Calendar connection did not finish. Return to the admin portal and connect again using hello@heidimikacfilms.com.',{status:400,headers});}
}
