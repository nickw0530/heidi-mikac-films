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

export async function notifyAdmins(store,production,actions){
 for(const a of actions)for(const id of a.owner==='any'?['Nick','Heidi']:[a.owner]){
  const email=id==='Heidi'?(a.signature?COUNTERSIGN_EMAIL:'heidi@heidimikacfilms.com'):'nick@heidimikacfilms.com';
  const event=a.signature&&id==='Heidi'?a.key+'/'+COUNTERSIGN_EMAIL:a.key;
  const hash=createHash('sha256').update(id+'/'+event).digest('hex');
  const receipt='admin-notices/'+hash;
  if(await store.getMetadata(receipt)||await store.getMetadata('mail-log/'+hash))continue;
  await enqueue(store,{id,email},event,'Waiting on you · Heidi Mikac Films',a.label+'\n\n'+portalUrl+'?production='+production,0,a.agreementCycle?{agreementCycle:a.agreementCycle,requirementKey:a.requirementKey}:{});
  await store.setJSON(receipt,{queued:Date.now()});
 }
}
