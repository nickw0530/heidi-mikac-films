import {practiceName} from './practice.mjs';
import {createHash} from 'node:crypto';
import {enqueue,portalUrl} from './mail.mjs';
import {COUNTERSIGN_EMAIL,refreshAgreement,SIGNING_REFRESH_INTERVAL,ENDED_STATUSES,transientSyncError} from './signing.mjs';
import {AGREEMENT_CYCLE,currentAgreementPrefix,currentAgreementKey} from './agreement-cycle.mjs';
import {manualAgreementKey,readAgreementTracking} from './paperwork.mjs';
import {adminProfileOwner,loadAdminProfiles} from './admin-profiles.mjs';

export async function adminActions(store,production,{refresh=false,members,memberRows}={}){
 const prefix=production==='written-in-the-dark'?'':'productions/'+production+'/';
 const result=[];
 const records=async(path)=> (await store.list({prefix:path})).blobs;
 function add(owner,label,key,view='documents',member=null,signature=false){
  result.push({owner,label,key,view,member,signature,...(key.startsWith(currentAgreementPrefix(production))?{agreementCycle:AGREEMENT_CYCLE,requirementKey:manualAgreementKey(production,member)}:{})});
 }
 const roster=members??await Promise.all((await records('members/')).map(({key})=>store.get(key,{type:'json'})));
 const adminProfiles=await loadAdminProfiles(store);
 const agreementReads=[];
 const rowsById=new Map((memberRows||[]).map(row=>[row.id,row]));
 for(const m of roster){
  if(!m||m.revoked||adminProfileOwner(adminProfiles,m)||practiceName(m.name))continue;
  const assignment=(m.productions??{'written-in-the-dark':{filmProfile:m.filmProfile}})[production];
  if(m.productionRequests?.[production])add('any','Review production request from '+m.name,'production-request/'+production+'/'+m.productionRequests[production],'settings',m.id);
  if(!assignment)continue;
  if(!m.email){add('any','Add email and invite '+m.name,'portal-contact/'+m.id,'people',m.id);continue;}
  const k=currentAgreementKey(production,m.id);
  const row=rowsById.get(m.id);
  agreementReads.push((async()=>{
   const [a,tracked]=row?[row.agreement,row.paperworkTracking]:await Promise.all([
    store.get(k,{type:'json'}),readAgreementTracking(store,production,m.id),
   ]);
   return {m,k,a,tracked};
  })());
 }
 const agreements=await Promise.all(agreementReads);
 if(refresh){
  // Oldest checked documents go first. Two short batches leave time for the notification pass.
  const now=Date.now(),cutoff=now-SIGNING_REFRESH_INTERVAL;
  const due=agreements.filter(({a})=>a?.id&&!a.cleared&&a.status!=='Complete'&&!(a.sendLeaseUntil>now)&&(a.checkedAt||0)<=cutoff)
   .sort((x,y)=>(x.a.checkedAt||0)-(y.a.checkedAt||0)||(x.a.created||0)-(y.a.created||0)).slice(0,4);
  for(let i=0;i<due.length;i+=2){
   await Promise.all(due.slice(i,i+2).map(async row=>{
    row.a=await refreshAgreement(store,row.k,false,5000);
   }));
  }
 }
 for(const {m,k,a,tracked} of agreements){
  // A brief failure to reach SignWell is not something to act on; the last known status still stands.
  const syncProblem=a?.syncError&&!transientSyncError(a);
  if(a?.id&&!a.cleared&&a.status==='Waiting on Heidi'&&!syncProblem){
   add('any','Open for Heidi’s signature · '+m.name,k+'/countersign/'+a.id,'people',m.id,true);
   if(tracked)result.at(-1).suppressNotice=true;
   continue;
  }
  if(tracked)continue;
  // A reservation that never received a document, and has sat for ten minutes, was interrupted.
  const interrupted=a&&!a.id&&!a.cleared&&/^Preparing/.test(a.status||'')&&Date.now()-(a.created||0)>600000;
  if(a?.status==='Draft ready to send'&&!syncProblem)add('any','Send the pending agreement for '+m.name,k+'/send/'+a.id,'people',m.id);
  // An ended request has its own notice, so an earlier connection problem never uses it up.
  else if(a?.id&&!a.cleared&&ENDED_STATUSES.has(a.status))add('any','Signing request '+a.status+' · review for '+m.name,k+'/'+a.id+'/ended/'+a.status,'people',m.id);
  else if(syncProblem||interrupted||/recovery|bounced|failed|^error$/i.test(a?.status||''))add('any','Review the signing request for '+m.name,k+'/'+(a.id||a.created)+'/review','people',m.id);
  else if(!a||a.cleared)add('any','Prepare a new agreement for '+m.name,k+'/prepare/'+(a?.created||'initial'),'people',m.id);
 }
 const adminTasks=await Promise.all(['Nick','Heidi','any'].map(async owner=>{
  const entries=await records(prefix+'tasks/'+owner+'/');
  return Promise.all(entries.map(async({key})=>({owner,key,task:await store.get(key,{type:'json'})})));
 }));
 for(const {owner,key,task} of adminTasks.flat()){
  if(task&&!task.done){add(owner,task.title,key,'overview');result.at(-1).taskId=task.id;}
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
     // Both admins can open the request, but its notice belongs to Heidi alone.
     if(id!=='Heidi'||a.suppressNotice)continue;
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
