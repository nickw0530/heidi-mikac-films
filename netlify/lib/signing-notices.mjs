import {AGREEMENT_CYCLE,currentAgreementPrefix} from './agreement-cycle.mjs';
import {enqueue,portalUrl} from './mail.mjs';
import {COUNTERSIGN_EMAIL,refreshAgreement} from './signing.mjs';
import {manualAgreementKey,readAgreementTracking} from './paperwork.mjs';

const productions=[
 {id:'written-in-the-dark',name:'Written in the Dark',prefix:currentAgreementPrefix('written-in-the-dark')},
 {id:'wherein-lies-continue',name:'Wherein Lies Continue',prefix:currentAgreementPrefix('wherein-lies-continue')}
];

// A separate durable receipt prevents repeat notices after the mail worker
// removes a successfully sent message from its outbox.
export async function countersignatureNotice(store,agreement,member,production){
 const email=COUNTERSIGN_EMAIL;
 if(!email||!agreement?.id||agreement.status!=='Waiting on Heidi'||agreement.syncError)return false;
 if(member?.id&&await readAgreementTracking(store,production.id,member.id))return false;
 const key='signing-notices/'+agreement.id+'/heidi';
 const receipt=await store.getWithMetadata(key,{type:'json'});
 if(receipt?.data?.queued||receipt?.data?.leaseUntil>Date.now())return false;
 const lease=await store.setJSON(key,{leaseUntil:Date.now()+120000},receipt?{onlyIfMatch:receipt.etag}:{onlyIfNew:true});
 if(!lease.modified)return false;
 await enqueue(store,{id:'Heidi',email},'countersign-'+agreement.id,'Agreement ready for your signature',
  (member?.name||'A cast or crew member')+' has signed the agreement for '+production.name+'. Please review and add your signature.\n\nOpen your dashboard: '+portalUrl+'?production='+production.id,0,{agreementCycle:AGREEMENT_CYCLE,...(member?.id?{requirementKey:manualAgreementKey(production.id,member.id)}:{})});
 await store.setJSON(key,{queued:true,queuedAt:Date.now()});
 return true;
}

export async function checkSigningNotices(store){
 if(!process.env.SIGNWELL_API_KEY)return;
 const deadline=Date.now()+22000,rows=[];
 for(const production of productions){
  for await(const page of store.list({prefix:production.prefix,paginate:true})){
   for(const {key} of page.blobs){
    if(await readAgreementTracking(store,production.id,key.slice(production.prefix.length)))continue;
    const agreement=await store.get(key,{type:'json'});
    if(agreement?.id&&!['Complete','declined','cancelled','expired'].includes(agreement.status))rows.push({production,key,agreement});
   }
  }
 }
 rows.sort((a,b)=>(a.agreement.checkedAt||0)-(b.agreement.checkedAt||0));
 for(const {production,key} of rows){
  if(Date.now()>deadline-16000)break;
  const agreement=await refreshAgreement(store,key);
  const memberId=key.slice(production.prefix.length),storedMember=await store.get('members/'+memberId,{type:'json'});
  const member=storedMember?{...storedMember,id:memberId}:null;
  await countersignatureNotice(store,agreement,member,production);
 }
}
