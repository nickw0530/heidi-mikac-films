import {createHash} from 'node:crypto';
export const mailReady=()=>Boolean(process.env.RESEND_API_KEY&&process.env.HMF_MAIL_FROM);
export const portalUrl='https://heidimikacfilms.com/members/';
export async function enqueue(store, member, event, subject, text, expires=0){
 const key='outbox/'+createHash('sha256').update(member.id+'/'+event).digest('hex');
 await store.setJSON(key,{id:member.id,to:member.email,subject,text,expires},{onlyIfNew:true});
}

const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function emailHtml(message){
 const paragraphs=String(message.text).split(/\n\n+/).map(paragraph=>{
  const escaped=escapeHtml(paragraph);
  const linked=escaped.replace(/https:\/\/heidimikacfilms\.com\/members\/(?:#invite=[a-f0-9]{64})?(?=\s|$)/g,link=>{
   const label=link.includes('#invite=')?'Set up your account':'Open your dashboard';
   return '<a href="'+link+'" style="display:inline-block;background:#803d48;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold">'+label+'</a>';
  });
  return '<p style="margin:0 0 20px">'+linked.replace(/\n/g,'<br>')+'</p>';
 }).join('');
 return '<!doctype html><html><body style="margin:0;background:#f5f3f0;color:#252122;font-family:Arial,sans-serif"><div style="max-width:560px;margin:0 auto;padding:28px 20px"><p style="font-size:14px;color:#6b343e">HEIDI MIKAC FILMS</p><h1 style="font-size:24px;line-height:1.3">'+escapeHtml(message.subject)+'</h1><div style="font-size:16px;line-height:1.6">'+paragraphs+'</div></div></body></html>';
}

export async function deliver(store){
 if(!mailReady())return;
 // Keep each scheduled run bounded. The provider deduplicates overlapping deliveries.
 for(const {key} of (await store.list({prefix:'outbox/'})).blobs.slice(0,20)){
  const msg=await store.get(key,{type:'json'});if(!msg)continue;
  if((msg.expires&&msg.expires<Date.now())||!await store.get('members/'+msg.id)){await store.delete(key);continue;}
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':key.split('/')[1]},body:JSON.stringify({from:process.env.HMF_MAIL_FROM,to:[msg.to],subject:msg.subject,text:msg.text,html:emailHtml(msg)})});
  if(response.ok)await store.delete(key);
  else if(response.status===429||response.status>=500)break;
 }
}
