import {createHash} from 'node:crypto';
import {enqueue,portalUrl} from './mail.mjs';
import {COUNTERSIGN_EMAIL,refreshAgreement} from './signing.mjs';
import {AGREEMENT_CYCLE,currentAgreementPrefix,currentAgreementKey} from './agreement-cycle.mjs';
import {manualAgreementKey,readAgreementTracking} from './paperwork.mjs';

export async function adminActions(store,production,refresh=false){
 const prefix=production==='written-in-the-dark'?'':'productions/'+production+'/';
 const result=[];
 const records=async(path)=> (await store.list({prefix:path})).blobs;
 function add(owner,label,key,view='documents',member=null,signature=false){
  result.push({owner,label,key,view,member,signature,...(key.startsWith(currentAgreementPrefix(production))?{agreementCycle:AGREEMENT_CYCLE,requirementKey:manualAgreementKey(production,member)}:{})});
 }
 for(const {key} of await records('members/')){
  const m=await store.get(key,{type:'json'});
  if(!m||m.revoked||/^test(?:\s|$)/i.test(m.name))continue;
  const assignment=(m.productions??{'written-in-the-dark':{filmProfile:m.filmProfile}})[production];
  if(m.productionRequests?.[production])add('any','Review production request from '+m.name,'production-request/'+production+'/'+m.productionRequests[production],'settings');
  if(!assignment)continue;
  if(!m.email){add('any','Add email and invite '+m.name,'portal-contact/'+m.id,'people',m.id);continue;}
  if(await readAgreementTracking(store,production,m.id))continue;
  const k=currentAgreementKey(production,m.id);
  const a=refresh?await refreshAgreement(store,k):await store.get(k,{type:'json'});
  if(a?.status==='Draft ready to send'&&!a.syncError)add('any','Send the pending agreement for '+m.name,k+'/send/'+a.id,'people',m.id);
  else if(a?.status==='Waiting on Heidi'&&!a.syncError)add('Heidi','Open for Heidi’s signature · '+m.name,k+'/countersign/'+a.id,'people',m.id,true);
  else if(a?.syncError||/recovery|declined|cancel|expired|bounced|failed/i.test(a?.status||''))add('any','Review the signing request for '+m.name,k+'/'+(a.id||a.created)+'/review','people',m.id);
  else if(!a||a.cleared)add('any','Prepare a new agreement for '+m.name,k+'/prepare/'+(a?.created||'initial'),'people',m.id);
 }
 for(const owner of ['Nick','Heidi','any'])for(const {key} of await records(prefix+'tasks/'+owner+'/')){
  const t=await store.get(key,{type:'json'});if(t&&!t.done){add(owner,t.title,key,'overview');result.at(-1).taskId=t.id;}
 }
 return result;
}

const DIGEST_INTERVAL=20*3600000;
const address=id=>id==='Heidi'?'heidi@heidimikacfilms.com':'nick@heidimikacfilms.com';

// One email per administrator, at most about once a day, listing what is newly
// waiting on them across every production. Two things are not held for the
// digest: Heidi's countersignature, which keeps its own immediate notice to the
// signing inbox, and a task assigned to one administrator by name, which sends
// that administrator's digest straight away.
export async function notifyAdmins(store,groups,now=Date.now()){
 for(const id of ['Nick','Heidi']){
  const fresh=[];let open=0,urgent=false;
  for(const {production,name,actions} of groups){
   for(const a of actions){
    if(a.owner!=='any'&&a.owner!==id)continue;
    if(a.signature){
     const event=a.key+'/'+COUNTERSIGN_EMAIL,hash=createHash('sha256').update(id+'/'+event).digest('hex');
     if(await store.getMetadata('admin-notices/'+hash)||await store.getMetadata('mail-log/'+hash))continue;
     await enqueue(store,{id,email:COUNTERSIGN_EMAIL},event,'Waiting on you · Heidi Mikac Films',a.label+'\n\n'+portalUrl+'?production='+production,0,a.agreementCycle?{agreementCycle:a.agreementCycle,requirementKey:a.requirementKey}:{});
     await store.setJSON('admin-notices/'+hash,{queued:now});
     continue;
    }
    open++;
    const receipt='admin-notices/'+createHash('sha256').update(id+'/'+a.key).digest('hex');
    if(await store.getMetadata(receipt)||await store.getMetadata('mail-log/'+receipt.split('/')[1]))continue;
    fresh.push({production,name,label:a.label,receipt});
    if(a.taskId&&a.owner===id)urgent=true;
   }
  }
  if(!fresh.length)continue;
  const stateKey='admin-digest/'+id,state=await store.getWithMetadata(stateKey,{type:'json'});
  if(!urgent&&now-(state?.data?.sent||0)<DIGEST_INTERVAL)continue;
  // The claim keeps overlapping scheduled runs from sending the same digest twice.
  const claim=await store.setJSON(stateKey,{sent:now,items:fresh.length},state?{onlyIfMatch:state.etag}:{onlyIfNew:true});
  if(!claim.modified)continue;
  const sections=groups.map(({production,name})=>{
   const lines=fresh.filter(item=>item.production===production).map(item=>'• '+item.label);
   return lines.length?name+'\n'+lines.join('\n'):'';
  }).filter(Boolean);
  const count=fresh.length+' new item'+(fresh.length===1?'':'s');
  const text=count+' waiting on you'+(open>fresh.length?', '+open+' open in total':'')+'.\n\n'+sections.join('\n\n')+'\n\n'+portalUrl;
  await enqueue(store,{id,email:address(id)},'digest/'+now,'Waiting on you · '+count+' · Heidi Mikac Films',text);
  for(const item of fresh)await store.setJSON(item.receipt,{queued:now,digest:true});
 }
}
