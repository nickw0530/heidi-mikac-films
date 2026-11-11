import {comparePeople} from './people-order.mjs';
import {answeredStatus} from './availability-state.mjs';

export const REPORT_TYPES=[
 {id:'availability',name:'Availability responses',description:'Who has answered for the dates you select?',columns:['name','productions','availability','answeredDays','availableDays','maybeDays']},
 {id:'documents',name:'Contracts & documents',description:'Current agreements, assigned documents, Complete and Document N/A.',columns:['name','productions','agreement','documents']},
 {id:'profiles',name:'Biographies & headshots',description:'Find missing profile items and see approval status.',columns:['name','productions','bio','headshot','approval']},
 {id:'accounts',name:'Accounts & invitations',description:'See who has activated, is awaiting setup, or needs an email.',columns:['name','productions','email','account']},
 {id:'pending',name:'Approvals & unfinished tasks',description:'Pending profile reviews and open tasks in one place.',columns:['name','productions','approval','tasks','actions']},
 {id:'roster',name:'Production roster & credits',description:'Characters and crew titles, with one row per person.',columns:['name','productions','character','crewTitle','role','account']},
 {id:'shared',name:'Shared filming dates',description:'Confirmed time together for the people you select.',columns:['name','productions','character','crewTitle']},
 {id:'custom',name:'Build my own',description:'Choose columns and combine your own conditions.',columns:['name','productions','account','agreement','availability']}
];
export const REPORT_COLUMNS={name:'Name',productions:'Productions',character:'Character',crewTitle:'Crew title',role:'Combined credit',email:'Account email',account:'Portal / invitation',agreement:'Current agreement',documents:'Assigned documents',bio:'Biography',headshot:'Headshot',approval:'Profile approval',tasks:'Open member tasks',actions:'Admin actions',availability:'Availability response',answeredDays:'Answered dates',availableDays:'Available dates',unavailableDays:'Unavailable dates',maybeDays:'Maybe dates',updated:'Availability updated'};
export const FILTER_FIELDS={name:'Name',email:'Account email',character:'Character',crewTitle:'Crew title',role:'Combined credit',account:'Portal / invitation',agreement:'Current agreement',documents:'Assigned documents and statuses',bio:'Biography',headshot:'Headshot',approval:'Profile approval',tasks:'Open member tasks',actions:'Admin actions',availability:'Availability response'};
export const FILTER_OPERATORS={contains:'contains',notContains:'does not contain',is:'is',isNot:'is not',empty:'is empty',notEmpty:'is not empty'};
export const ANSWER_LABELS={answered:'Answered',unanswered:'No answer in selected dates'};
const text=value=>String(value??'');
const folded=value=>text(value).normalize('NFKC').toLocaleLowerCase('en-US').trim();
const identity=row=>JSON.stringify([row.profileId,folded(row.name)]);
export function availabilityCounts(row){
 const days=row.days||[],answered=days.filter(day=>answeredStatus(day.status)).length;
 return {answered,total:days.length,available:days.filter(day=>day.status==='available').length,unavailable:days.filter(day=>day.status==='unavailable').length,maybe:days.filter(day=>day.status==='maybe').length,check:days.filter(day=>day.status==='needs-confirmation').length};
}
export function reportField(row,field){
 const counts=availabilityCounts(row);
 switch(field){
  case 'name':case 'email':case 'character':case 'crewTitle':case 'role':return text(row[field]);
  case 'productions':return row.productionName||'Not assigned';
  case 'account':return row.accountStatus||'Website profile only';
  case 'agreement':return row.agreementStatus||'No agreement on file';
  case 'documents':return (row.documents||[]).map(d=>d.title+': '+d.status).join('\n')||'No assigned documents';
  case 'bio':return row.bioProvided?'Provided':'Missing';
  case 'headshot':return row.headshotProvided?'Provided':'Missing';
  case 'approval':return row.approvalPending?'Approval needed':row.productionId?'No pending approval':'Not assigned';
  case 'tasks':return (row.openTasks||[]).join('\n')||'None';
  case 'actions':return (row.actions||[]).join('\n')||'None';
  case 'availability':return counts.answered?ANSWER_LABELS.answered:ANSWER_LABELS.unanswered;
  case 'answeredDays':return counts.answered+' / '+counts.total;
  case 'availableDays':return String(counts.available);
  case 'unavailableDays':return String(counts.unavailable);
  case 'maybeDays':return String(counts.maybe);
  case 'updated':return row.availabilityUpdated?new Intl.DateTimeFormat('en-US',{timeZone:'America/Indiana/Indianapolis',month:'short',day:'numeric',year:'numeric'}).format(new Date(row.availabilityUpdated)):'Not saved';
  default:return '';
 }
}
export function groupReportPeople(rows){
 const unique=[...new Map(rows.map(row=>[(row.productionId||'unassigned')+'/'+row.id,row])).values()],owners=new Map(),people=new Map();
 for(const row of unique)if(row.memberId&&row.profileId){const key=identity(row);if(!owners.has(key))owners.set(key,new Set());owners.get(key).add(row.memberId);}
 for(const row of unique){
  const linked=row.profileId?owners.get(identity(row)):null;
  const member=row.memberId||(linked?.size===1?[...linked][0]:null);
  const key=member?'member/'+member:row.profileId?'profile/'+identity(row):'record/'+row.id;
  if(!people.has(key))people.set(key,{id:key,name:row.name,memberId:member,assignments:[]});
  const person=people.get(key);if(row.memberId){person.name=row.name;person.memberId=row.memberId;}
  person.assignments.push(row);
 }
 return [...people.values()].sort(comparePeople);
}
export function compareCondition(row,condition){
 const value=folded(reportField(row,condition.field)),wanted=folded(condition.value);
 const empty=condition.field==='tasks'?!row.openTasks?.length:condition.field==='actions'?!row.actions?.length:condition.field==='documents'?!row.documents?.length:condition.field==='bio'?!row.bioProvided:condition.field==='headshot'?!row.headshotProvided:condition.field==='approval'?!row.approvalPending:condition.field==='availability'?!availabilityCounts(row).answered:condition.field==='account'?!row.hasAccount:!value;
 switch(condition.operator){
  case 'contains':return value.includes(wanted);
  case 'notContains':return !value.includes(wanted);
  case 'is':return value===wanted;
  case 'isNot':return value!==wanted;
  case 'empty':return empty;
  case 'notEmpty':return !empty;
  default:return false;
 }
}
function readyMatch(row,settings){
 const counts=availabilityCounts(row),status=settings.status||'all';
 if(settings.type==='availability')return status==='all'||status==='answered'&&counts.answered>0||status==='unanswered'&&counts.answered===0||status==='available'&&counts.available>0||status==='maybe'&&counts.maybe>0;
 if(settings.type==='documents')return status==='all'||status==='outstanding'&&(row.documents||[]).some(d=>!['Complete','Document N/A'].includes(d.status))||reportField(row,'agreement')===status;
 if(settings.type==='profiles')return status==='all'||status==='missing'&&(!row.bioProvided||!row.headshotProvided)||status==='bio'&&!row.bioProvided||status==='headshot'&&!row.headshotProvided||status==='complete'&&row.bioProvided&&row.headshotProvided;
 if(settings.type==='accounts')return status==='all'||status==='no-account'&&!row.hasAccount||row.accountStatus===status;
 if(settings.type==='pending')return status==='all'||status==='needed'&&(row.approvalPending||row.openTasks?.length)||status==='approvals'&&row.approvalPending||status==='tasks'&&row.openTasks?.length||status==='actions'&&row.actions?.length;
 return true;
}
export function runPeopleReport(snapshots,settings){
 let rows=snapshots.flatMap(snapshot=>[...(snapshot.rows||[]),...(settings.includeUnassigned?snapshot.unassigned||[]:[])]);
 rows=rows.filter(row=>settings.productions.includes(row.productionId)||settings.includeUnassigned&&!row.productionId);
 let people=groupReportPeople(rows);
 if(settings.audience==='accounts')people=people.filter(p=>p.assignments.some(r=>r.hasAccount));
 if(settings.audience==='no-account')people=people.filter(p=>!p.assignments.some(r=>r.hasAccount));
 if(settings.audience==='selected'){const chosen=new Set(settings.selectedPeople||[]);people=people.filter(p=>chosen.has(p.id));}
 const query=folded(settings.search);
 people=people.filter(person=>{
  if(query&&!folded([person.name,...person.assignments.map(row=>[row.email,row.role,row.character,row.crewTitle].join(' '))].join(' ')).includes(query))return false;
  const matching=person.assignments.filter(row=>{
   if(!readyMatch(row,settings))return false;
   const conditions=settings.conditions||[];
   return !conditions.length||(settings.match==='any'?conditions.some(c=>compareCondition(row,c)):conditions.every(c=>compareCondition(row,c)));
  });
  person.matchingProductions=matching.map(row=>row.productionId);return matching.length>0;
 });
 return {people,total:people.length,assignmentCount:people.reduce((sum,p)=>sum+p.assignments.length,0)};
}
export function personReportValue(person,field){
 if(field==='name')return person.name;
 if(field==='email')return [...new Set(person.assignments.map(row=>row.email).filter(Boolean))].join('\n');
 const values=person.assignments.map(row=>({production:row.productionName||'Not assigned',value:reportField(row,field)}));
 if(field==='productions')return values.map(row=>row.production).join('\n');
 const distinct=[...new Set(values.map(row=>row.value))];
 return distinct.length===1?distinct[0]:values.map(row=>row.production+': '+row.value).join('\n');
}
export function normalizedReportConfig(value){
 const fail=message=>{throw Object.assign(new Error(message),{status:400});};
 if(!value||typeof value!=='object'||Array.isArray(value)||!REPORT_TYPES.some(type=>type.id===value.type))fail('Choose a report type.');
 if(!Array.isArray(value.columns))fail('Choose valid report columns.');
 const columns=[...new Set(value.columns)];
 if(!columns.length||columns.some(key=>!Object.hasOwn(REPORT_COLUMNS,key)))fail('Choose valid report columns.');
 if(value.match!==undefined&&!['all','any'].includes(value.match))fail('Choose whether all or any conditions must match.');
 const conditions=value.conditions||[];
 if(!Array.isArray(conditions)||conditions.length>24||conditions.some(c=>!c||!Object.hasOwn(FILTER_FIELDS,c.field)||!Object.hasOwn(FILTER_OPERATORS,c.operator)||typeof c.value!=='string'||c.value.length>200))fail('Choose valid report conditions.');
 const status=typeof value.status==='string'&&value.status.length<=100?value.status:'all';
 const minMinutes=value.minMinutes??120;
 if(!Number.isInteger(minMinutes)||minMinutes<15||minMinutes>1440)fail('Choose between 15 minutes and 24 hours together.');
 return {type:value.type,columns:['name',...columns.filter(key=>key!=='name')],status,match:value.match||'all',conditions:conditions.map(({field,operator,value})=>({field,operator,value})),search:typeof value.search==='string'?value.search.slice(0,200):'',minMinutes,weekendsFirst:value.weekendsFirst!==false};
}
export function reportCsv(headers,rows){
 const cell=value=>{let s=text(value);if(/^[\s\uFEFF]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
 return '\uFEFF'+[headers,...rows].map(row=>row.map(cell).join(',')).join('\r\n');
}
