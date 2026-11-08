import {createHash, randomBytes} from 'node:crypto';
import {getStore} from '@netlify/blobs';

const origin='https://heidimikacfilms.com';
const redirect=origin+'/.netlify/functions/calendar-callback';
const tenant='7b0dc2ce-48a2-4703-987f-9bbca1bf0089';
const authority='https://login.microsoftonline.com/'+tenant+'/oauth2/v2.0';
const client='858bc951-de5f-4423-8602-acf4923ba964';
const mailbox='hello@heidimikacfilms.com';
const scope='offline_access User.Read Calendars.ReadBasic';
const binding='calendar/connection';
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
async function graph(path,token){
 const response=await fetch('https://graph.microsoft.com/v1.0/'+path,{signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+token}});
 if(!response.ok)throw Object.assign(new Error('Calendar unavailable'),{status:response.status});
 return response.json();
}
const fields='id,subject,start,end,isAllDay,isCancelled,sensitivity';
const visible=e=>!e.isCancelled&&e.sensitivity==='normal';
const display=e=>({key:digest(e.id),title:e.subject,start:e.start.dateTime,end:e.end.dateTime,allDay:e.isAllDay});
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
 const params=new URLSearchParams({startDateTime:new Date(now).toISOString(),endDateTime:new Date(now+30*86400000).toISOString(),'$select':fields,'$orderby':'start/dateTime','$top':'100'});
 const rows=[];
 for await(const page of pages('me/calendarView?'+params,token))rows.push(...page.filter(e=>!e.isCancelled));
 return rows.map(e=>({...display(e),memberVisible:visible(e)}));
}
async function access(store,record){
 const token=await exchange({grant_type:'refresh_token',refresh_token:record.data.refresh});
 const updated={...record.data,refresh:token.refresh_token||record.data.refresh};
 await store.setJSON(binding,updated,{onlyIfMatch:record.etag});
 return token.access_token;
}
export async function events(store,admin,eventKey){
 const record=await store.getWithMetadata(binding,{type:'json'});
 if(!record)return Response.json({connected:false},{headers});
 let token;
 let rows=record.data.calendarRows;
 if(!rows||record.data.cachedUntil<=Date.now()){
  token=await access(store,record);
  rows=await upcoming(token);
  const latest=await store.getWithMetadata(binding,{type:'json'});
  if(latest)await store.setJSON(binding,{...latest.data,calendarRows:rows,cachedUntil:Date.now()+120000},{onlyIfMatch:latest.etag});
 }
 const items=rows.filter(e=>admin||e.memberVisible).map(({memberVisible,...e})=>e);
 let selected=null;
 if(/^[\w-]{43}$/.test(eventKey||'')){
  const id=await store.get('calendar/event-links/'+eventKey);
  if(id){
   token??=await access(store,await store.getWithMetadata(binding,{type:'json'}));
   try{
    const event=await graph('me/calendar/events/'+encodeURIComponent(id)+'?$select='+fields,token);
    if(admin?!event.isCancelled:visible(event))selected=display(event);
   }catch(error){if(error.status!==404&&error.status!==410)throw error;}
  }
 }
 return Response.json({connected:true,items,selected},{headers});
}
export async function notifyNewEvents(store,enqueue,portalUrl){
 const checkpoint='calendar/notification-cursor';
 const end=new Date(Date.now()-60000).toISOString();
 const cursor=await store.getWithMetadata(checkpoint,{type:'json'});
 if(!cursor){await store.setJSON(checkpoint,end,{onlyIfNew:true});return;}
 if(cursor.data>=end)return;
 const connection=await store.getWithMetadata(binding,{type:'json'});
 if(!connection)return;
 const token=await access(store,connection);
 const query=new URLSearchParams({'$select':fields+',createdDateTime','$filter':'createdDateTime ge '+cursor.data+' and createdDateTime lt '+end,'$top':'100'});
 let members;
 for await(const page of pages('me/calendar/events?'+query,token)){
  for(const event of page.filter(visible)){
   if(!members){
    const {blobs}=await store.list({prefix:'members/'});
    members=(await Promise.all(blobs.map(b=>store.get(b.key,{type:'json'})))).filter(m=>m&&!m.revoked&&m.email);
   }
   const key=digest(event.id);
   await store.set('calendar/event-links/'+key,event.id,{onlyIfNew:true});
   for(const member of members){
    await enqueue(store,member,'calendar/'+key,'New event on the production calendar','An event has been added to the Heidi Mikac Films calendar. Sign in to see the event and its scheduled time.\n\n'+portalUrl+'?event='+key);
   }
  }
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
  await upcoming(token.access_token);
  await store.setJSON(binding,{refresh:token.refresh_token});
  return new Response(null,{status:303,headers:{...headers,'Set-Cookie':cookie('',0),Location:'/members/'}});
 }catch{return new Response('Calendar connection did not finish. Return to the admin portal and connect again using hello@heidimikacfilms.com.',{status:400,headers});}
}

