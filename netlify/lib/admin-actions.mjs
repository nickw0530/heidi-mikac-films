import {createHash} from 'node:crypto';
import {enqueue,portalUrl} from './mail.mjs';
import {refreshAgreement} from './signing.mjs';
import {refreshOfflineCountersign} from './offline-signing.mjs';
import dark,{whereinCatalog} from './film-profiles.mjs';

export async function adminActions(store,production,refresh=false){
 const prefix=production==='written-in-the-dark'?'':'productions/'+production+'/';
 const catalog=prefix?whereinCatalog:dark;
 const result=[];
 const records=async(path)=> (await store.list({prefix:path})).blobs;
 function add(owner,label,key,view='documents',member=null){
  result.push({owner,label,key,view,member});
 }
 const offline=new Set();
 for(const {key} of await records(prefix+'offline/')){
  const id=key.split('/').pop(),meta=await store.getMetadata(key);
  offline.add(id);
  const rec=refresh?await refreshOfflineCountersign({store,profileId:id,productionId:production}):await store.get(prefix+'offline-signing/'+id,{type:'json'});
  const status=rec?.status||meta?.metadata?.status;
  const name=rec?.name||catalog.find(x=>x.id===id)?.name||id;
  const event=key+'/'+(rec?.id||meta?.etag||id)+'/';
  if(rec?.sourceChanged||rec?.syncError)add('any','Review the signing request for '+name,event+'review');
  else if(status==='Waiting on Heidi'&&rec?.id)add('Heidi','Sign the agreement for '+name,event+'sign');
  else if(status==='Waiting on Heidi')add('any','Prepare the countersignature draft for '+name,event+'prepare');
  else if(status==='Draft prepared')add('any','Review and send the countersignature draft for '+name,event+'draft');
  else if(status&&/missing|recovery|failed|bounced|declined|cancel|expired/i.test(status))add('any','Review paperwork for '+name+' · '+status,event+status);
 }
 for(const {key} of await records('members/')){
  const m=await store.get(key,{type:'json'});
  if(!m||m.revoked||/^test(?:\s|$)/i.test(m.name))continue;
  const assignment=(m.productions??{'written-in-the-dark':{filmProfile:m.filmProfile}})[production];
  if(!assignment)continue;
  const k=prefix+'agreements/'+m.id;
  const a=refresh?await refreshAgreement(store,k):await store.get(k,{type:'json'});
  if(a?.status==='Waiting on Heidi'&&!a.syncError)add('Heidi','Sign the agreement for '+m.name,'countersign-'+a.id,'people',m.id);
  else if(a?.syncError||/recovery|declined|cancel|expired|bounced|failed/i.test(a?.status||''))add('any','Review the signing request for '+m.name,k+'/'+(a.id||a.created)+'/review','people',m.id);
  else if((!a||a.cleared)&&!offline.has(assignment.filmProfile||catalog.find(x=>x.name.toLowerCase()===m.name.toLowerCase())?.id)&&! /^(nick williams|nicholas williams|heidi mikac)$/i.test(m.name.trim()))add('any','Prepare an agreement for '+m.name,k+'/prepare/'+(a?.created||'initial'),'people',m.id);
 }
 for(const owner of ['Nick','Heidi','any'])for(const {key} of await records(prefix+'tasks/'+owner+'/')){
  const t=await store.get(key,{type:'json'});if(t&&!t.done){add(owner,t.title,key,'overview');result.at(-1).taskId=t.id;}
 }
 return result;
}

export async function notifyAdmins(store,production,actions){
 for(const a of actions)for(const id of a.owner==='any'?['Nick','Heidi']:[a.owner]){
  const email=id==='Heidi'?(process.env.HMF_HEIDI_SIGNING_EMAIL||'heidi@heidimikacfilms.com'):'nick@heidimikacfilms.com';
  const hash=createHash('sha256').update(id+'/'+a.key).digest('hex');
  const receipt='admin-notices/'+hash;
  if(await store.getMetadata(receipt)||await store.getMetadata('mail-log/'+hash))continue;
  await enqueue(store,{id,email},a.key,'Waiting on you · Heidi Mikac Films',a.label+'\n\n'+portalUrl+'?production='+production);
  await store.setJSON(receipt,{queued:Date.now()});
 }
}
