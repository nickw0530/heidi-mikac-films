import {REPORT_TYPES,REPORT_COLUMNS,FILTER_FIELDS,FILTER_OPERATORS,groupReportPeople,runPeopleReport,personReportValue,normalizedReportConfig,reportCsv,availabilityCounts} from './report-model.mjs';

const ZONE='America/Indiana/Indianapolis';
const today=()=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]));return p.year+'-'+p.month+'-'+p.day;};
const plusDays=(date,n)=>new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const dayLabel=date=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric',year:'numeric'}).format(new Date(date+'T12:00:00Z'));
const timeLabel=time=>{if(time==='24:00')return 'midnight';const [h,m]=time.split(':').map(Number);return (h%12||12)+(m?':'+String(m).padStart(2,'0'):'')+(h<12?' a.m.':' p.m.');};
function el(tag,attributes={},...children){const node=document.createElement(tag);for(const [key,value] of Object.entries(attributes)){if(key==='class')node.className=value;else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);else if(value!==null&&value!==undefined)node.setAttribute(key,String(value));}for(const child of children.flat())if(child!==null&&child!==undefined)node.append(typeof child==='string'?document.createTextNode(child):child);return node;}
const button=(label,action,attributes={})=>el('button',{type:'button',onclick:action,...attributes},label);
const field=(label,control)=>el('label',{},el('span',{},label),control);
function selectControl(label,value,choices,change){const select=el('select',{'aria-label':label,onchange:event=>change(event.target.value)});for(const [id,name] of choices){const option=el('option',{value:id},name);option.selected=id===value;select.append(option);}return select;}
const DEFAULT_STATUS={availability:'all',documents:'outstanding',profiles:'missing',accounts:'all',pending:'needed',roster:'all',shared:'matches',custom:'all'};
const STATUS_CHOICES={availability:[['all','Everyone'],['answered','Answered at least one selected date'],['unanswered','No answer for selected dates'],['available','Has a green day'],['maybe','Has a Maybe day']],documents:[['all','All document statuses'],['outstanding','Has outstanding paperwork'],['No agreement on file','No current agreement'],['Draft ready to send','Draft ready to send'],['Waiting on actor','Waiting on member signature'],['Waiting on Heidi','Waiting on Heidi signature'],['Complete','Agreement complete'],['Document N/A','Agreement not required']],profiles:[['all','Everyone'],['missing','Missing bio or headshot'],['bio','Missing biography'],['headshot','Missing headshot'],['complete','Both provided']],accounts:[['all','Everyone'],['Active','Active portal accounts'],['Admin profile','Admin profiles'],['Invitation pending','Invitation pending'],['Email needed','Email needed'],['Website profile only','Website profiles without an account'],['no-account','All people without an account']],pending:[['needed','Pending approval or open member task'],['approvals','Approval needed'],['tasks','Open member tasks'],['actions','Admin action needed'],['all','Everyone']],shared:[['matches','Confirmed shared times'],['follow-up','Dates needing responses / confirmation'],['all','All selected dates']]};
const DATE_COLUMNS=new Set(['availability','answeredDays','availableDays','unavailableDays','maybeDays','updated']);
const usesDates=config=>['availability','shared'].includes(config.type)||config.columns.some(key=>DATE_COLUMNS.has(key))||config.conditions.some(condition=>condition.field==='availability');

function resultTable(headers,rows,label){
 const head=el('thead',{role:'rowgroup'},el('tr',{role:'row'},...headers.map(header=>el('th',{scope:'col',role:'columnheader'},header))));
 const body=el('tbody',{role:'rowgroup'});
 for(const cells of rows){
  body.append(el('tr',{role:'row'},...cells.map((cell,index)=>el('td',{role:'cell'},
   el('span',{class:'reports-cell-label','aria-hidden':'true'},headers[index]),el('div',{class:'reports-cell-content'},cell)
  ))));
 }
 return el('div',{class:'reports-table-scroll',tabindex:'0',role:'region','aria-label':label},el('table',{role:'table'},head,body));
}

export function mountReports(container,{request,productions,owner}){
 const choices=productions||[],chosenFilms=new Set(choices.map(p=>p.id)),chosenPeople=new Set();
 let config={type:'availability',columns:[...REPORT_TYPES[0].columns],status:'all',match:'all',conditions:[],search:'',minMinutes:120,weekendsFirst:true};
 let from=today(),to=plusDays(from,29),audience='',includeUnassigned=false,peopleSearch='',snapshots=[],snapshotKey='',rosterKey='',presets=[],presetId='',presetName='',loading=false,saving=false,destroyed=false,sequence=0,result=null,shared=[];
 const notice=el('p',{class:'reports-notice',role:'status','aria-live':'polite'}),controls=el('div',{class:'reports-controls'}),output=el('div',{class:'reports-output'});
 container.classList.add('reports-widget');container.dataset.reportsRoot='';container.replaceChildren(el('h2',{},'Reports'),notice,controls,output);
 const note=(message,error=false)=>{notice.textContent=message;notice.classList.toggle('reports-error',error);};
 const isShared=()=>config.type==='shared';
 const selectedPresets=()=>presets.find(p=>p.id===presetId);
 function invalidate(){sequence++;result=null;shared=[];output.replaceChildren();note('');}
 function resetPopulation(){snapshotKey='';rosterKey='';snapshots=[];chosenPeople.clear();invalidate();}
 const currentRoster=()=>JSON.stringify([[...chosenFilms],includeUnassigned]);
 const currentRange=()=>{
  if(usesDates(config))return {from,to};
  const date=today();return {from:date,to:date};
 };
 const currentSnapshot=()=>JSON.stringify([currentRoster(),currentRange()]);
 function settings(){return {...config,productions:[...chosenFilms],includeUnassigned,audience,selectedPeople:[...chosenPeople]};}
 function validateScope(requireAudience=true){
  if(!chosenFilms.size&&!includeUnassigned)throw Error('Choose at least one production or people without a production.');
  const range=currentRange();
  const days=(Date.parse(range.to+'T12:00:00Z')-Date.parse(range.from+'T12:00:00Z'))/86400000+1;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(range.from)||!/^\d{4}-\d{2}-\d{2}$/.test(range.to)||!Number.isInteger(days)||days<1||days>93)throw Error('Choose an availability date range of 1–93 days.');
  if(requireAudience&&!audience)throw Error('Choose who to include before running the report.');
  if(isShared()&&!chosenFilms.size)throw Error('Choose a production for shared filming dates.');
 }
 async function fetchSnapshots(force=false){
  validateScope(false);
  const key=currentSnapshot(),roster=currentRoster(),range=currentRange();
  if(!force&&snapshotKey===key)return snapshots;
  const ids=chosenFilms.size?[...chosenFilms]:[choices[0].id];
  const data=await Promise.all(ids.map(id=>request('reportData',undefined,'','&'+new URLSearchParams(range),id)));
  if(destroyed||currentSnapshot()!==key)throw Error('The report parameters changed. Run it again.');
  snapshots=data;snapshotKey=key;rosterKey=roster;return data;
 }
 function scopePeople(){return groupReportPeople(snapshots.flatMap(snapshot=>[...(chosenFilms.has(snapshot.productionId)?snapshot.rows:[]),...(includeUnassigned?snapshot.unassigned:[])]));}
 async function choosePeople(){
  if(loading||rosterKey===currentRoster())return;
  const token=++sequence;loading=true;note('Loading names…');renderControls();
  try{await fetchSnapshots();if(destroyed||token!==sequence)return;note('');}
  catch(error){if(!destroyed&&token===sequence)note(error.message,true);}
  finally{if(!destroyed){loading=false;renderControls();}}
 }
 async function run(){
  if(loading||saving)return;
  const token=++sequence;loading=true;result=null;shared=[];output.replaceChildren();note('Running report…');renderControls();
  try{
   validateScope();normalizedReportConfig(config);
   if(audience==='selected'&&!chosenPeople.size)throw Error('Select at least one person.');
   const range=currentRange();
   const data=await fetchSnapshots(true);if(destroyed||token!==sequence)return;
   if(audience==='selected'){
    const availableIds=new Set(scopePeople().map(person=>person.id));
    const departed=[...chosenPeople].filter(id=>!availableIds.has(id));
    if(departed.length){
     departed.forEach(id=>chosenPeople.delete(id));
     throw Error('The roster changed. Review the remaining selected names, then run again.');
    }
   }
   const report=runPeopleReport(data,settings());
   if(isShared()){
    if(audience!=='selected')throw Error('Select the people needed for filming.');
    if(!report.people.length)throw Error('Select at least one person.');
    const comparisons=[];
    for(const id of chosenFilms){
     const rows=report.people.flatMap(person=>person.assignments.filter(row=>row.productionId===id));
     if(!rows.length)continue;
     comparisons.push(await request('reportMatch',{people:rows.map(row=>row.id),from,to,minMinutes:config.minMinutes},'','',id));
     if(destroyed||token!==sequence)return;
    }
    shared=comparisons;
   }
   result={...report,settings:structuredClone(settings()),generated:new Date(),...range,shared:structuredClone(shared)};note('Report ready.');renderResults();
  }catch(error){if(!destroyed&&token===sequence)note(error.message||'The report could not be run.',true);}
  finally{if(!destroyed){loading=false;renderControls();}}
 }
 async function loadPresets(){
  const data=await request('reportPresets');if(!destroyed){presets=data.presets||[];renderControls();}
 }
 function changeType(type){
  const definition=REPORT_TYPES.find(p=>p.id===type);
  config={...config,type,columns:[...definition.columns],status:DEFAULT_STATUS[type],conditions:[],search:''};
  if(type==='shared'){
   audience='selected';
   if(includeUnassigned){includeUnassigned=false;resetPopulation();}
  }
  invalidate();renderControls();if(audience==='selected')choosePeople();
 }
 function savedControls(){
  const details=el('details',{class:'reports-saved'},el('summary',{},(owner||'My')+'’s saved report setups'));
  const select=selectControl('My saved report',presetId,[['','Choose a saved setup'],...presets.map(p=>[p.id,p.name])],value=>{presetId=value;const preset=selectedPresets();presetName=preset?.name||'';renderControls(true);});
  const load=button('Load setup',()=>{const preset=selectedPresets();if(!preset)return;config=normalizedReportConfig(preset.config);audience=config.type==='shared'?'selected':'';if(isShared())includeUnassigned=false;resetPopulation();renderControls(true);note('Setup loaded. Choose who to include for this run.');if(audience==='selected')choosePeople();},{disabled:!presetId||loading||saving?'disabled':null});
  const name=el('input',{type:'text',value:presetName,maxlength:80,'aria-label':'Saved report name',placeholder:'e.g. Missing WITD paperwork',oninput:event=>{presetName=event.target.value;}});
  const save=async update=>{
   if(saving)return;
   try{saving=true;renderControls(true);note('Saving your report setup…');const current=update?selectedPresets():null;const saved=await request('saveReportPreset',{name:presetName,config:normalizedReportConfig(config),...(current?{id:current.id,revision:current.revision}:{})});presetId=saved.id;await loadPresets();note('Saved for '+(owner||'your admin account')+'.');}
   catch(error){note(error.message||'Setup could not be saved.',true);}
   finally{saving=false;if(!destroyed)renderControls(true);}
  };
  details.append(el('p',{class:'reports-help'},'Private to your admin account. Saves report type, conditions and columns. Productions, people and dates are chosen each run.'),field('Saved setup',select),load,field('Setup name',name),button('Save as new setup',()=>save(false),{disabled:saving||loading?'disabled':null}));
  if(presetId)details.append(button('Update this setup',()=>save(true),{disabled:saving||loading?'disabled':null}),button('Remove setup',async()=>{const preset=selectedPresets();if(!preset||!confirm('Remove this saved report setup?'))return;try{saving=true;await request('removeReportPreset',{id:preset.id,revision:preset.revision});presetId='';presetName='';await loadPresets();note('Saved setup removed.');}catch(error){note(error.message,true);}finally{saving=false;if(!destroyed)renderControls(true);}},{disabled:saving||loading?'disabled':null}));
  return details;
 }
 function conditionEditor(){
  const details=el('div',{class:'reports-conditions'},el('h3',{},'Conditions'));
  details.append(field('Match conditions',selectControl('Match conditions',config.match,[['all','All conditions in the same production'],['any','Any condition']],value=>{config.match=value;invalidate();})));
  config.conditions.forEach((condition,index)=>{
   const row=el('div',{class:'reports-condition'});
   const set=(key,value)=>{condition[key]=value;invalidate();};
   row.append(field('Field',selectControl('Filter field '+(index+1),condition.field,Object.entries(FILTER_FIELDS),value=>{set('field',value);renderControls();})),field('Comparison',selectControl('Filter comparison '+(index+1),condition.operator,Object.entries(FILTER_OPERATORS),value=>{set('operator',value);renderControls();})),field('Value',el('input',{type:'text',value:condition.value,maxlength:200,'aria-label':'Filter value '+(index+1),disabled:['empty','notEmpty'].includes(condition.operator)?'disabled':null,oninput:event=>set('value',event.target.value)})),button('Remove filter',()=>{config.conditions.splice(index,1);invalidate();renderControls();},{'aria-label':'Remove filter '+(index+1)}));details.append(row);
  });
  details.append(button('Add condition',()=>{config.conditions.push({field:'name',operator:'contains',value:''});invalidate();renderControls();},{disabled:config.conditions.length>=24?'disabled':null}),el('p',{class:'reports-help'},'Examples: Biography is Missing · Current agreement is No agreement on file · Crew title contains Producer. Conditions match within a production; the results keep both films’ details together.'));
  return details;
 }
 function peoplePicker(){
  const box=el('div',{class:'reports-people-picker'});
  if(rosterKey!==currentRoster()){box.append(button(loading?'Loading names…':'Load names to select',choosePeople,{disabled:loading?'disabled':null}));return box;}
  const people=scopePeople(),list=el('div',{class:'reports-people-list'}),count=el('p',{class:'reports-help'});
  const update=()=>{count.textContent=chosenPeople.size+' selected';};
  const search=el('input',{type:'search',value:peopleSearch,'aria-label':'Search report people',placeholder:'Find a name',oninput:event=>{peopleSearch=event.target.value;for(const label of list.children)label.hidden=!label.dataset.search.includes(peopleSearch.toLowerCase().trim());}});
  for(const person of people){const check=el('input',{type:'checkbox',onchange:event=>{event.target.checked?chosenPeople.add(person.id):chosenPeople.delete(person.id);invalidate();update();}});check.checked=chosenPeople.has(person.id);const label=el('label',{},check,el('span',{},person.name));label.dataset.search=person.name.toLowerCase();label.hidden=!label.dataset.search.includes(peopleSearch.toLowerCase().trim());list.append(label);}
  box.append(field('Select people',search),list,count,button('Select all shown',()=>{for(const [index,label] of [...list.children].entries())if(!label.hidden){chosenPeople.add(people[index].id);label.querySelector('input').checked=true;}invalidate();update();}),button('Clear people',()=>{chosenPeople.clear();list.querySelectorAll('input').forEach(input=>input.checked=false);invalidate();update();}));update();return box;
 }
 function renderControls(savedOpen=false){
  if(destroyed)return;
  const oldSaved=controls.querySelector('.reports-saved')?.open;
  const advancedOpen=controls.querySelector('.reports-advanced')?.open;
  const columnsOpen=controls.querySelector('.reports-columns')?.open;
  const focusLabel=controls.contains(document.activeElement)?document.activeElement.getAttribute('aria-label'):null;
  const type=selectControl('Report type',config.type,REPORT_TYPES.map(type=>[type.id,type.name]),changeType);
  controls.replaceChildren(el('div',{class:'reports-start'},field('Report type',type),el('p',{class:'reports-help'},REPORT_TYPES.find(type=>type.id===config.type).description)));
  const films=el('fieldset',{class:'reports-production-picker'},el('legend',{},'Productions'));
  const changeScope=()=>{resetPopulation();renderControls();};
  const all=el('input',{type:'checkbox',onchange:event=>{chosenFilms.clear();if(event.target.checked)choices.forEach(p=>chosenFilms.add(p.id));changeScope();}});
  all.checked=chosenFilms.size===choices.length;all.indeterminate=chosenFilms.size>0&&!all.checked;
  films.append(el('label',{},all,'All productions'));
  for(const production of choices){const check=el('input',{type:'checkbox',onchange:event=>{event.target.checked?chosenFilms.add(production.id):chosenFilms.delete(production.id);changeScope();}});check.checked=chosenFilms.has(production.id);films.append(el('label',{},check,production.name));}
  if(!isShared()){const unassigned=el('input',{type:'checkbox',onchange:event=>{includeUnassigned=event.target.checked;changeScope();}});unassigned.checked=includeUnassigned;films.append(el('label',{},unassigned,'Include people without a production'));}
  controls.append(films);
  const who=selectControl('Who to include',audience,[['','Choose who to include'],['everyone','Everyone in this scope'],['accounts','People with portal accounts'],['no-account','People without portal accounts'],['selected','Select individual people']],value=>{audience=value;chosenPeople.clear();invalidate();renderControls();if(value==='selected')choosePeople();});who.disabled=isShared()||loading;
  controls.append(field('Who to include',who));
  if(audience==='selected')controls.append(peoplePicker());
  const dates=el('fieldset',{class:'reports-dates'},el('legend',{},'Availability date range'));
  if(usesDates(config)){
   for(const [key,label,value] of [['from','From',from],['to','Through',to]]){
    dates.append(field(label,el('input',{type:'date',value,'aria-label':'Report '+key,onchange:event=>{
     if(key==='from')from=event.target.value;else to=event.target.value;
     invalidate();
    }})));
   }
   dates.append(el('p',{class:'reports-help'},'Up to 93 days. Blank dates in a month with responses count as unavailable.'));
   controls.append(dates);
  }
  if(STATUS_CHOICES[config.type])controls.append(field('Show',selectControl('Report status filter',config.status,STATUS_CHOICES[config.type],value=>{config.status=value;invalidate();})));
  if(isShared()){
   controls.append(field('Minimum hours together',el('input',{type:'number',min:0.25,max:24,step:0.25,value:config.minMinutes/60,'aria-label':'Report minimum shared hours',oninput:event=>{config.minMinutes=Number(event.target.value)*60;invalidate();}})));
   const weekends=el('input',{type:'checkbox',onchange:event=>{config.weekendsFirst=event.target.checked;invalidate();}});weekends.checked=config.weekendsFirst;controls.append(el('label',{},weekends,'Show Friday–Sunday first'),el('p',{class:'reports-help'},'Maybe and unanswered dates never count as confirmed shared availability. No time-of-day restrictions.'));
  }
  const advanced=el('details',{class:'reports-advanced'},el('summary',{},'Advanced filters & columns'));
  advanced.open=!!advancedOpen||config.type==='custom';
  if(!isShared())advanced.append(field('Search names, email or credits',el('input',{type:'search',value:config.search,'aria-label':'Report search',oninput:event=>{config.search=event.target.value;invalidate();}})),conditionEditor());
  const columns=el('details',{class:'reports-columns'},el('summary',{},'Choose columns ('+config.columns.length+')'));columns.open=columnsOpen;
  const grid=el('div',{class:'reports-column-grid'});
  for(const [key,label] of Object.entries(REPORT_COLUMNS)){const check=el('input',{type:'checkbox','aria-label':'Show column '+label,disabled:key==='name'?'disabled':null,onchange:event=>{config.columns=event.target.checked?[...config.columns,key]:config.columns.filter(id=>id!==key);invalidate();renderControls();}});check.checked=config.columns.includes(key);grid.append(el('label',{},check,label));}
  columns.append(grid);advanced.append(columns);controls.append(advanced);
  const clearFilters=()=>{
   config.status='all';config.search='';config.conditions=[];config.match='all';
   invalidate();renderControls();note('Filters cleared.');
  };
  controls.append(el('div',{class:'reports-run-actions'},button(loading?'Running…':'Run report',run,{class:'reports-primary',disabled:loading||saving?'disabled':null}),button('Clear filters',clearFilters)));
  const saved=savedControls();saved.open=!!(savedOpen||oldSaved);controls.append(saved);
  if(loading||saving)controls.querySelectorAll('input,select,button').forEach(control=>{control.disabled=true;});
  if(focusLabel&&!loading&&!saving)[...controls.querySelectorAll('[aria-label]')].find(node=>node.getAttribute('aria-label')===focusLabel)?.focus({preventScroll:true});
 }
 function personLink(person){
  const row=person.assignments.find(row=>row.memberId)||person.assignments[0];
  const params=new URLSearchParams({view:'people',production:row.profileProductionId||row.productionId||choices[0].id,...(row.pendingId?{pending:row.pendingId}:row.memberId||person.memberId?{person:row.memberId||person.memberId}:{profile:row.profileId})});
  return el('a',{href:'/members/?'+params,target:'_blank',rel:'noopener noreferrer'},person.name);
 }
 function sharedDays(){
  const {status,weekendsFirst}=result.settings;
  const rows=result.shared.flatMap(comparison=>comparison.days.filter(day=>status==='all'||status==='follow-up'&&(day.missing.length||day.maybe?.length||day.needsConfirmation.length)||status==='matches'&&day.windows.length).map(day=>({...day,productionId:comparison.productionId,productionName:comparison.film})));
  return rows.sort((a,b)=>(weekendsFirst?Number(![0,5,6].includes(new Date(a.date+'T12:00:00Z').getUTCDay()))-Number(![0,5,6].includes(new Date(b.date+'T12:00:00Z').getUTCDay())):0)||a.date.localeCompare(b.date)||a.productionName.localeCompare(b.productionName));
 }
 // Each film is compared using only the selected people who are on that film.
 const coveredPeople=productionId=>result.people.filter(person=>person.assignments.some(row=>row.productionId===productionId));
 const coversEveryone=productionId=>coveredPeople(productionId).length===result.people.length;
 function sharedStatus(day){
  if(day.windows.length)return coversEveryone(day.productionId)?'Confirmed':'Confirmed for '+coveredPeople(day.productionId).length+' of '+result.people.length+' selected';
  return day.maybe?.length?'Maybe / needs confirmation':day.missing.length||day.needsConfirmation.length?'Missing / check hours':'No shared window';
 }
 const windowText=day=>day.windows.map(window=>timeLabel(window.start)+'–'+timeLabel(window.end)+' ('+Math.round(window.minutes/60*100)/100+'h)').join('\n');
 function exportReport(){
  if(!result)return;
  const type=REPORT_TYPES.find(type=>type.id===result.settings.type),rows=result.settings.type==='shared'?sharedDays().map(day=>[day.date,day.productionName,windowText(day),sharedStatus(day),coveredPeople(day.productionId).map(p=>p.name).join('; ')]):result.people.map(person=>result.settings.columns.map(key=>personReportValue(person,key)));
  const headers=result.settings.type==='shared'?['Date','Production','Shared filming windows','Status','Selected people']:result.settings.columns.map(key=>REPORT_COLUMNS[key]);
  const range=usesDates(result.settings)?result.from+'_to_'+result.to:today();
  const blob=new Blob([reportCsv(headers,rows)],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=el('a',{href:url,download:'Heidi-Mikac-Films-'+type.id+'-'+range+'.csv'});document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 function adminTasks(){
  if(result?.settings.type!=='pending'||result.settings.conditions.length||result.settings.audience==='selected'||result.settings.audience==='no-account'||result.settings.status==='approvals')return [];
  return snapshots.filter(snapshot=>result.settings.productions.includes(snapshot.productionId)).flatMap(snapshot=>(snapshot.adminTasks||[]).map(task=>({...task,productionName:snapshot.film}))).filter(task=>!result.settings.search||[task.owner,task.title].join(' ').toLowerCase().includes(result.settings.search.toLowerCase())).sort((a,b)=>a.owner.localeCompare(b.owner)||a.productionName.localeCompare(b.productionName));
 }
 function renderAdminTasks(){
  const tasks=adminTasks();if(!tasks.length)return;
  const section=el('section',{class:'reports-admin-tasks'},el('h3',{},'Production admin tasks'),el('p',{class:'reports-help'},'These tasks belong to an admin rather than a cast or crew member. They are separate from the people total.'));
  const headers=['Assigned to','Production','Task'];
  const rows=tasks.map(task=>[task.owner==='any'?'Any admin':task.owner,task.productionName,task.title]);
  section.append(resultTable(headers,rows,'Admin tasks'));
  section.append(button('Download admin tasks (.csv)',()=>{const blob=new Blob([reportCsv(headers,rows)],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=el('a',{href:url,download:'Heidi-Mikac-Films-admin-tasks-'+today()+'.csv'});document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}));output.append(section);
 }
 function printReport(){
  if(!result)return;
  const frame=el('iframe',{title:'Print report',class:'reports-print-frame'});document.body.append(frame);const doc=frame.contentDocument;doc.open();doc.write('<!doctype html><html><head><meta charset="utf-8"><title>Heidi Mikac Films report</title></head><body></body></html>');doc.close();
  const style=doc.createElement('style');style.textContent='body{font:11px/1.4 Arial;color:#111;margin:20px}h2{font-size:22px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #888;padding:7px;text-align:left;vertical-align:top;white-space:pre-line;overflow-wrap:anywhere}thead{display:table-header-group}tr{break-inside:avoid}a{color:#111;text-decoration:none}.reports-result-actions{display:none}.reports-metrics{display:flex;gap:24px}small{color:#444}@page{size:landscape;margin:12mm}';doc.head.append(style);
  const content=output.cloneNode(true);content.querySelectorAll('button,.reports-result-actions,.reports-cell-label').forEach(node=>node.remove());doc.body.append(content);
  frame.contentWindow.addEventListener('afterprint',()=>frame.remove(),{once:true});frame.contentWindow.focus();frame.contentWindow.print();setTimeout(()=>frame.remove(),60000);
 }
 function renderResults(){
  if(!result||destroyed)return;
  const type=REPORT_TYPES.find(type=>type.id===result.settings.type),heading=el('div',{class:'reports-result-heading'},el('h3',{},type.name));
  heading.append(el('p',{},'Generated '+result.generated.toLocaleString('en-US',{timeZone:ZONE})+' · Eastern time'),el('p',{},'Scope: '+result.settings.productions.map(id=>choices.find(p=>p.id===id)?.name||id).concat(result.settings.includeUnassigned?['People without a production']:[]).join(' · ')),el('p',{},'Who: '+({everyone:'Everyone in this scope',accounts:'Portal accounts', 'no-account':'People without portal accounts',selected:'Selected individuals'}[result.settings.audience]||'')));
  if(usesDates(result.settings))heading.append(el('p',{},'Availability dates: '+dayLabel(result.from)+' – '+dayLabel(result.to)));
  const status=STATUS_CHOICES[result.settings.type]?.find(([value])=>value===result.settings.status)?.[1];
  if(status)heading.append(el('p',{},'Show: '+status));
  if(result.settings.search)heading.append(el('p',{},'Search: '+result.settings.search));
  if(result.settings.conditions.length)heading.append(el('p',{},'Filters ('+result.settings.match+'): '+result.settings.conditions.map(c=>FILTER_FIELDS[c.field]+' '+FILTER_OPERATORS[c.operator]+(['empty','notEmpty'].includes(c.operator)?'':' '+c.value)).join(' · ')));
  const metrics=el('div',{class:'reports-metrics'},el('div',{},el('b',{},String(result.total)),el('span',{},'People')),el('div',{},el('b',{},String(result.assignmentCount)),el('span',{},'Production entries')));
  output.replaceChildren(heading,metrics,el('div',{class:'reports-result-actions'},button('Download spreadsheet (.csv)',exportReport),button('Print / Save PDF',printReport)));
  if(!result.people.length){output.append(el('p',{class:'reports-empty'},'No people match these parameters.'));renderAdminTasks();return;}
  if(result.settings.type==='shared'){
   const days=sharedDays();metrics.append(el('div',{},el('b',{},String(result.shared.filter(comparison=>coversEveryone(comparison.productionId)).reduce((sum,comparison)=>sum+comparison.matches.length,0))),el('span',{},'Dates confirmed for everyone selected')));
   if(result.shared.some(comparison=>!coversEveryone(comparison.productionId)))output.append(el('p',{class:'reports-note'},'Each film is compared using only the selected people who are on that film. The “Compared” column shows who each row covers.'));
   const people=el('p',{class:'reports-participants'},'People selected: ');result.people.forEach((person,index)=>{if(index)people.append(' · ');people.append(personLink(person));});output.append(people);
   if(!days.length)output.append(el('p',{class:'reports-empty'},'No dates match this view. Maybe and unanswered days do not count as confirmed time. Choose “Dates needing responses / confirmation” to see missing answers.'));
   else output.append(resultTable(['Date','Production','Shared time','Status','Compared'],days.map(day=>{
    const names=[...day.missing,...day.maybe||[],...day.needsConfirmation].map(person=>person.name).sort((a,b)=>a.localeCompare(b));
    return [dayLabel(day.date),day.productionName,windowText(day)||'—',el('div',{},sharedStatus(day),names.length?el('small',{},names.join(' · ')):null),coveredPeople(day.productionId).map(person=>person.name).join(' · ')];
   }),'Shared filming dates'));
  }else{
   if(result.settings.type==='availability'){
    const unanswered=result.people.filter(person=>!person.assignments.some(row=>availabilityCounts(row).answered));
    const optional=unanswered.filter(person=>person.assignments.every(row=>row.adminProfile)).length;
    metrics.append(el('div',{},el('b',{},String(result.total-unanswered.length)),el('span',{},'Answered')),el('div',{},el('b',{},String(unanswered.length-optional)),el('span',{},'No answer')));
    if(optional)metrics.append(el('div',{},el('b',{},String(optional)),el('span',{},'Optional')));
   }
   const columns=result.settings.columns;
   output.append(resultTable(columns.map(key=>REPORT_COLUMNS[key]),result.people.map(person=>columns.map(key=>key==='name'?personLink(person):personReportValue(person,key))),'Report results'));
  }
  if(result.settings.type==='shared'){
   const columns=result.settings.columns;
   output.append(el('h3',{},'People included'),resultTable(columns.map(key=>REPORT_COLUMNS[key]),result.people.map(person=>columns.map(key=>key==='name'?personLink(person):personReportValue(person,key))),'People included'));
   output.append(button('Download selected people (.csv)',()=>{const blob=new Blob([reportCsv(columns.map(key=>REPORT_COLUMNS[key]),result.people.map(person=>columns.map(key=>personReportValue(person,key))))],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=el('a',{href:url,download:'Heidi-Mikac-Films-selected-people-'+today()+'.csv'});document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}));
  }
  renderAdminTasks();output.append(el('p',{class:'reports-help'},'One row per person; different production details stay labeled. Agreement status comes from the current contract round. “Complete” may be recorded by an admin; it does not by itself prove digital signatures. This report does not send messages or change profiles, documents or schedules.'));
 }
 renderControls();loadPresets().catch(error=>{if(!destroyed)note(error.message||'Saved setups could not be loaded.',true);});
 return {busy:()=>loading||saving,destroy(){destroyed=true;sequence++;container.replaceChildren();}};
}
