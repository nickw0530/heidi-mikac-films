import {createHash} from 'node:crypto';
export const mailReady=()=>Boolean(process.env.RESEND_API_KEY&&process.env.HMF_MAIL_FROM);
export const portalUrl='https://heidimikacfilms.com/members/';
export async function enqueue(store, member, event, subject, text, expires=0){
 const key='outbox/'+createHash('sha256').update(member.id+'/'+event).digest('hex');
 await store.setJSON(key,{id:member.id,to:member.email,subject,text,expires},{onlyIfNew:true});
}
export async function deliver(store){
 if(!mailReady())return;
 // Keep each scheduled run bounded. The provider deduplicates overlapping deliveries.
 for(const {key} of (await store.list({prefix:'outbox/'})).blobs.slice(0,20)){
  const msg=await store.get(key,{type:'json'});if(!msg)continue;
  if((msg.expires&&msg.expires<Date.now())||!await store.get('members/'+msg.id)){await store.delete(key);continue;}
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':key.split('/')[1]},body:JSON.stringify({from:process.env.HMF_MAIL_FROM,to:[msg.to],subject:msg.subject,text:msg.text})});
  if(response.ok)await store.delete(key);
  else if(response.status===429||response.status>=500)break;
 }
}
