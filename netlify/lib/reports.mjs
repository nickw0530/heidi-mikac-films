import {currentAgreementPrefix,AGREEMENT_CYCLE} from './agreement-cycle.mjs';
import {manualAgreementKey,resourceTrackingKey,manualPaperworkStatus} from './paperwork.mjs';
import {availabilityForDate,listDates,matchAvailability} from './availability.mjs';
import {normalizedReportConfig} from '../../members/report-model.mjs';
import {comparePeople} from '../../members/people-order.mjs';

const scope=production=>production==='written-in-the-dark'?'':'productions/'+production+'/';
const safe=value=>typeof value==='string'?value.slice(0,500):'';
const jsonGet=(store,key)=>store.get(key,{type:'json'});
export async function reportRecords(store,prefix){
 const rows=[];
 for await(const page of store.list({prefix,paginate:true}))for(const {key} of page.blobs){const value=await jsonGet(store,key);if(value)rows.push({key,value});}
 return rows;
}
export async function reportSnapshot({store,productionId,film,catalog,assignments,findProfile,sharedBase,from,to}){
 const dates=listDates(from,to),all=(await reportRecords(store,'members/')).map(row=>row.value),accounts=all.filter(member=>member&&!member.revoked);
 for(const {value:person} of await reportRecords(store,'portal-pending/'))if(!person.archived&&!all.some(member=>member.id===(person.memberId||person.id)))accounts.push({id:person.id,name:person.name,reportPending:true,productions:Object.fromEntries((person.productions||[]).map(id=>[id,{role:''}]))});
 const [agreements,resources,taskRecords,tracking]=await Promise.all([reportRecords(store,currentAgreementPrefix(productionId)),reportRecords(store,scope(productionId)+'resources/'),reportRecords(store,scope(productionId)+'tasks/'),reportRecords(store,'document-tracking/'+productionId+'/')]);
 const agreementMap=new Map(agreements.map(row=>[row.key.split('/').at(-1),row.value])),trackingMap=new Map(tracking.map(row=>[row.key,row.value]));
 const visibleCatalog=catalog.filter(profile=>{const matches=all.filter(member=>(!member.generalInvite||assignments(member)[productionId]||member.approvedProfiles?.[productionId])&&findProfile(member,productionId)?.id===profile.id);return !matches.length||matches.some(member=>assignments(member)[productionId]&&(!member.revoked||member.keepPublic));});
 async function project(member,assigned=true){
  const membership=assigned?assignments(member)[productionId]:null,base=assigned?findProfile(member,productionId):sharedBase(member),fallback=sharedBase(member);
  const [profile,photo,password,schedule]=await Promise.all([jsonGet(store,'profiles/'+member.id),store.getMetadata(member.draftProfile?.imageVersion?'profile-images/'+member.id+'/'+member.draftProfile.imageVersion:'photos/'+member.id),store.getMetadata('passwords/'+member.id),assigned?jsonGet(store,'availability/'+productionId+'/'+member.id):null]);
  const tracking=trackingMap.get(manualAgreementKey(productionId,member.id)),currentTracking=tracking?.document==='agreement'&&tracking.agreementCycle===AGREEMENT_CYCLE?tracking:null;
  const agreement=agreementMap.get(member.id),agreementStatus=assigned?(manualPaperworkStatus(currentTracking)||(!agreement?.cleared&&agreement?.status)||'No agreement on file'):'Not assigned';
  const openTasks=assigned?taskRecords.filter(row=>row.key.startsWith(scope(productionId)+'tasks/'+member.id+'/')&&!row.value.done).map(row=>safe(row.value.title)):[];
  const documents=assigned?[{title:'Current agreement',status:agreementStatus},...resources.map(row=>row.value).filter(resource=>resource.type==='PDF'&&(!resource.audience||resource.audience.includes(member.id))).map(resource=>({title:safe(resource.title),status:manualPaperworkStatus(trackingMap.get(resourceTrackingKey(productionId,member.id,resource.id)))||'Outstanding'}))]:[];
  const approvalPending=assigned&&!!member.productionRequests?.[productionId],actions=[];
  if(approvalPending)actions.push('Review profile for publication');
  if(!member.email)actions.push('Add email and invite');
  if(assigned&&agreementStatus==='Draft ready to send')actions.push('Send pending agreement');
  else if(assigned&&agreementStatus==='Waiting on Heidi')actions.push('Heidi signature needed');
  else if(assigned&&agreementStatus==='No agreement on file')actions.push('Prepare new agreement');
  else if(assigned&&/recovery|declined|cancel|expired|bounced|failed/i.test(agreementStatus))actions.push('Review signing request');
  const proposed=member.proposedCredits?.[productionId],credit=membership||proposed||{};
  return {id:(member.reportPending?'pending/':'member/')+member.id,memberId:member.reportPending?null:member.id,pendingId:member.reportPending?member.id:null,profileId:membership?base?.id||null:null,name:safe(member.name),email:safe(member.email),hasAccount:!!member.email,accountStatus:!member.email?'Email needed':password?'Active':'Invitation pending',productionId:assigned?productionId:null,productionName:assigned?film:'Not assigned',profileProductionId:membership?productionId:Object.keys(assignments(member))[0]||productionId,character:safe(credit.character),crewTitle:safe(credit.crewTitle),role:safe(credit.role||[credit.character,credit.crewTitle].filter(Boolean).join(' · ')),bioProvided:!!(member.draftProfile?.bio??profile?.bio??base?.bio??fallback?.bio??'').trim(),headshotProvided:!!(photo||base?.photo||fallback?.photo),approvalPending,agreementStatus,documents,openTasks,actions,days:assigned?dates.map(date=>{const day=availabilityForDate(schedule,date);return {date:day.date,status:day.status,windows:day.windows,...(day.implicit?{implicit:true}:{})};}):[],availabilityUpdated:Number.isFinite(schedule?.updated)?schedule.updated:null,practice:/^test(?:\s|$)/i.test(member.name||'')};
 }
 const members=accounts.filter(member=>assignments(member)[productionId]||member.productionRequests?.[productionId]);
 const rows=await Promise.all(members.map(member=>project(member)));
 const linked=new Set(rows.filter(row=>row.profileId).map(row=>row.profileId));
 for(const profile of visibleCatalog)if(!linked.has(profile.id))rows.push({id:'profile/'+profile.id,memberId:null,profileId:profile.id,name:safe(profile.name),email:'',hasAccount:false,accountStatus:'Website profile only',productionId,productionName:film,profileProductionId:productionId,character:'',crewTitle:'',role:safe(profile.role),bioProvided:!!profile.bio?.trim(),headshotProvided:!!profile.photo,approvalPending:false,agreementStatus:'No agreement on file',documents:[{title:'Current agreement',status:'No agreement on file'}],openTasks:[],actions:['Add email and invite'],days:dates.map(date=>({date,status:'unknown',windows:[]})),availabilityUpdated:null,practice:false});
 const unassigned=await Promise.all(accounts.filter(member=>!Object.keys(assignments(member)).length).map(member=>project(member,false)));
 const adminTasks=taskRecords.filter(row=>['Nick','Heidi','any'].includes(row.key.slice((scope(productionId)+'tasks/').length).split('/')[0])&&!row.value.done).map(row=>({owner:row.key.slice((scope(productionId)+'tasks/').length).split('/')[0],title:safe(row.value.title)}));
 return {productionId,film,from,to,generatedAt:Date.now(),rows:rows.sort(comparePeople),unassigned:unassigned.sort(comparePeople),adminTasks};
}
export async function reportMatch(store,snapshot,ids,{from,to,minMinutes}){
 if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(id=>!snapshot.rows.some(row=>row.id===id)))throw Object.assign(new Error('Choose people from this production (up to 100).'),{status:400});
 const people=await Promise.all([...new Set(ids)].map(async id=>{const row=snapshot.rows.find(row=>row.id===id);return {id,name:row.name,availability:row.memberId?await jsonGet(store,'availability/'+snapshot.productionId+'/'+row.memberId):null};}));
 return {productionId:snapshot.productionId,film:snapshot.film,...matchAvailability(people,{from,to,minMinutes})};
}
export function validateSavedReport(body){
 if(typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>80)throw Object.assign(new Error('Name the saved report in 80 characters or fewer.'),{status:400});
 return {name:body.name.trim(),config:normalizedReportConfig(body.config)};
}
