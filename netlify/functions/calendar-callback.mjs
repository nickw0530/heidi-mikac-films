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
 const response=await fetch(authority+'/token',{method:'POST',body:new URLSearchParams({client_id:client,client_secret:process.env.HMF_CALENDAR_CLIENT_SECRET,...fields})});
 if(!response.ok)throw new Error('Microsoft authorization failed');
 return response.json();
}
async function graph(path,token){
 const response=await fetch('https://graph.microsoft.com/v1.0/'+path,{headers:{Authorization:'Bearer '+token}});
 if(!response.ok)throw new Error('Calendar unavailable');
 return response.json();
}
async function upcoming(token){
 const now=Date.now();
 const params=new URLSearchParams({startDateTime:new Date(now).toISOString(),endDateTime:new Date(now+30*86400000).toISOString(),'$select':'subject,start,end,isAllDay,isCancelled','$orderby':'start/dateTime','$top':'100'});
 const data=await graph('me/calendarView?'+params,token);
 return data.value.filter(e=>!e.isCancelled).map(e=>({title:e.subject,start:e.start.dateTime,allDay:e.isAllDay}));
}
export async function events(store){
 const record=await store.getWithMetadata(binding,{type:'json'});
 if(!record)return Response.json({connected:false},{headers});
 const token=await exchange({grant_type:'refresh_token',refresh_token:record.data.refresh});
 const items=await upcoming(token.access_token);
 if(token.refresh_token)await store.setJSON(binding,{refresh:token.refresh_token},{onlyIfMatch:record.etag});
 return Response.json({connected:true,items},{headers});
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
  if(!(await store.setJSON(key,{expires:0},{onlyIfMatch:record.etag})).modified)throw Error();
  const token=await exchange({grant_type:'authorization_code',code:url.searchParams.get('code'),redirect_uri:redirect,code_verifier:pending.verifier});
  const user=await graph('me?$select=userPrincipalName',token.access_token);
  if(user.userPrincipalName?.toLowerCase()!==mailbox||!token.refresh_token)throw Error();
  await upcoming(token.access_token);
  await store.setJSON(binding,{refresh:token.refresh_token});
  return new Response(null,{status:303,headers:{...headers,'Set-Cookie':cookie('',0),Location:'/members/'}});
 }catch{return new Response('Calendar connection did not finish. Return to the admin portal and connect again using hello@heidimikacfilms.com.',{status:400,headers});}
}
