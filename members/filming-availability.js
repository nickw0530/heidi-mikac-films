import {monthRange,filmingDayState,filmingSuggestions,peopleForFilmingDay} from './filming-calendar.mjs';

const ZONE='America/Indiana/Indianapolis';
const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
let instance=0;
const today=()=>{const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(p=>[p.type,p.value]));return parts.year+'-'+parts.month+'-'+parts.day;};
const dateLabel=(date,short=false)=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:short?'short':'long',month:short?'short':'long',day:'numeric',...(short?{}:{year:'numeric'})}).format(new Date(date+'T12:00:00Z'));
const monthLabel=month=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'long',year:'numeric'}).format(new Date(month+'-01T12:00:00Z'));
const timeLabel=time=>{if(time==='24:00')return 'midnight';const [h,m]=time.split(':').map(Number);return (h%12||12)+(m?':'+String(m).padStart(2,'0'):'')+(h<12?' a.m.':' p.m.');};
const windowLabel=window=>timeLabel(window.start)+'–'+timeLabel(window.end);
const hoursLabel=minutes=>String(Math.round(minutes/60*100)/100)+'h';
function el(tag,attributes={},...children){
 const node=document.createElement(tag);
 for(const [key,value] of Object.entries(attributes)){
  if(key==='class')node.className=value;
  else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);
  else if(value!==null&&value!==undefined)node.setAttribute(key,String(value));
 }
 for(const child of children.flat())if(child!==null&&child!==undefined)node.append(typeof child==='string'?document.createTextNode(child):child);
 return node;
}
const button=(text,action,attributes={})=>el('button',{type:'button',onclick:action,...attributes},text);
const field=(label,control)=>el('label',{},el('span',{},label),control);

export function mountFilmingAvailability(container,{request,productions,productionId}){
 const choices=productions||[];
 let production=choices.some(p=>p.id===productionId)?productionId:choices[0]?.id||'';
 let data=null,result=null,month=today().slice(0,7),selectedDate='',hours='2',search='',filter='available';
 let pickerOpen=true,includeWeekdays=false,loading=false,checking=false,destroyed=false,sequence=0;
 const selected=new Set(),filterName='filming-status-'+(++instance);
 const notice=el('p',{class:'availability-notice',role:'status','aria-live':'polite'}),body=el('div'),board=el('div',{class:'filming-board'});
 container.classList.add('availability-widget','filming-widget');container.dataset.availabilityRoot='';container.replaceChildren(notice,body);
 const note=(message,error=false)=>{notice.textContent=message;notice.classList.toggle('availability-error',error);};
 const roster=()=>data?.members||[];
 const selectedNames=()=>roster().filter(m=>selected.has(m.id)).map(m=>m.name);
 function invalidate(){sequence++;checking=false;result=null;selectedDate='';filter='available';board.replaceChildren();note('');const select=body.querySelector('[aria-label="Filming production"]'),refreshButton=body.querySelector('.filming-heading button');if(select)select.disabled=loading;if(refreshButton)refreshButton.disabled=loading;}
 async function loadRoster(reopen=true){
  const token=++sequence;loading=true;result=null;selectedDate='';if(reopen)pickerOpen=true;render();
  try{
   const response=await request('availability',undefined,'','',production);
   if(destroyed||token!==sequence)return false;
   data=response;
   for(const id of selected)if(!roster().some(m=>m.id===id))selected.delete(id);
   return true;
  }catch(error){if(!destroyed&&token===sequence){data=null;selected.clear();pickerOpen=true;note(error.message||'Availability could not be loaded.',true);}return false;}
  finally{if(!destroyed&&token===sequence){loading=false;render();}}
 }
 async function compare(){
  const minutes=Number(hours)*60;
  if(!selected.size){note('Choose the people needed first.',true);return;}
  if(!Number.isInteger(minutes)||minutes<15||minutes>1440){note('Choose between 0.25 and 24 hours together.',true);return;}
  const token=++sequence,ids=[...selected],film=production,range=monthRange(month);
  checking=true;result=null;selectedDate='';filter='available';pickerOpen=false;render();note('Checking shared availability…');
  try{
   const response=await request('availabilityMatch',{members:ids,...range,minMinutes:minutes},'','',film);
   if(destroyed||token!==sequence)return;
   if(response.productionId!==film||response.from!==range.from||response.to!==range.to||!Array.isArray(response.members))throw Error('Refresh the portal to load the updated filming calendar.');
   result=response;note('');
  }catch(error){if(!destroyed&&token===sequence){pickerOpen=true;note(error.message||'Shared availability could not be checked.',true);}}
  finally{if(!destroyed&&token===sequence){checking=false;render();}}
 }
 async function refresh(){
  if(loading||checking)return;
  const wasShowing=!!result;
  if(await loadRoster(!wasShowing)&&wasShowing&&selected.size)await compare();
 }
 function chooseDate(date){
  selectedDate=date;filter='available';renderBoard();
  const heading=board.querySelector('[data-filming-detail-heading]');
  heading?.focus({preventScroll:true});
  if(window.matchMedia('(max-width:800px)').matches)heading?.scrollIntoView({block:'start',behavior:'smooth'});
 }
 function peoplePicker(){
  const details=el('details',{class:'filming-picker'}),summary=el('summary');
  details.open=pickerOpen;details.addEventListener('toggle',()=>{pickerOpen=details.open;});details.append(summary);
  const checklist=el('div',{class:'filming-people-grid'}),count=el('p',{class:'filming-selection-count','aria-live':'polite'});
  const show=button('Show calendar',compare,{class:'filming-primary'});
  function update(){
   summary.textContent=selected.size?selected.size+' '+(selected.size===1?'person':'people')+' needed · Change selection':'Choose who’s needed';
   count.textContent=selected.size+' selected';show.disabled=!selected.size||loading||checking;
  }
  const noMatch=el('p',{class:'availability-help'},'No names match your search.');
  function filterNames(){let found=0;for(const label of checklist.children){label.hidden=!label.dataset.search.includes(search.trim().toLowerCase());if(!label.hidden)found++;}noMatch.hidden=!!found;}
  for(const member of roster()){
   const check=el('input',{type:'checkbox',value:member.id,onchange:event=>{event.target.checked?selected.add(member.id):selected.delete(member.id);invalidate();update();}});check.checked=selected.has(member.id);
   const label=el('label',{},check,el('span',{},member.name));label.dataset.search=[member.name,member.role||''].join(' ').toLowerCase();checklist.append(label);
  }
  const searchInput=el('input',{type:'search',value:search,placeholder:'Find a name','aria-label':'Find people needed for filming',oninput:event=>{search=event.target.value;filterNames();}});
  const length=el('input',{type:'number',min:0.25,max:24,step:0.25,value:hours,'aria-label':'Minimum shared hours',oninput:event=>{hours=event.target.value;invalidate();update();}});
  details.append(field('People needed',searchInput),checklist,noMatch,el('div',{class:'filming-picker-tools'},count,button('Clear selection',()=>{selected.clear();checklist.querySelectorAll('input').forEach(check=>{check.checked=false;});invalidate();update();},{class:'availability-small'})),el('div',{class:'filming-picker-submit'},field('Hours together',length),show));
  update();filterNames();return details;
 }
 function calendar(){
  const section=el('section',{class:'filming-month','aria-label':'Shared filming calendar'}),[year,number]=month.split('-').map(Number);
  const change=delta=>{month=new Date(Date.UTC(year,number-1+delta,1,12)).toISOString().slice(0,7);compare();};
  section.append(el('div',{class:'filming-month-nav'},button('‹',()=>change(-1),{'aria-label':'Previous filming month'}),el('h3',{},monthLabel(month)),button('›',()=>change(1),{'aria-label':'Next filming month'})));
  const grid=el('div',{class:'filming-month-grid',role:'group','aria-label':monthLabel(month)+' shared availability'});
  DAYS.forEach(day=>grid.append(el('span',{class:'filming-weekday'},day)));
  const offset=new Date(month+'-01T12:00:00Z').getUTCDay();
  for(let i=0;i<offset;i++)grid.append(el('span',{'aria-hidden':'true'}));
  for(const day of result.days||[]){
   const state=filmingDayState(day),label=state==='free'?'All free':state==='waiting'?'Waiting':'No overlap';
   const best=Math.max(0,...(day.windows||[]).map(window=>window.minutes));
   const cell=button('',()=>chooseDate(day.date),{class:'filming-date filming-'+state+(day.date===selectedDate?' filming-selected':'')+(day.date<today()?' filming-past':''),'aria-label':dateLabel(day.date)+' · '+(state==='free'?'Everyone selected is free for at least '+hours+' hours':state==='waiting'?'Availability is missing or needs confirmation':'No shared '+hours+'-hour window'),'aria-pressed':day.date===selectedDate?'true':'false'});
   cell.append(el('b',{},String(Number(day.date.slice(-2)))),el('span',{},label));if(state==='free')cell.append(el('small',{},hoursLabel(best)+' shared'));grid.append(cell);
  }
  section.append(grid,el('p',{class:'filming-legend'},el('span',{class:'filming-free'},'Everyone free'),el('span',{class:'filming-waiting'},'Missing / check hours'),el('span',{class:'filming-no'},'No '+hours+'h overlap')));
  return section;
 }
 function dayDetails(){
  const section=el('section',{class:'filming-day-details','aria-label':'Selected day availability'});
  if(!selectedDate){section.append(el('h3',{},'Who’s available?'),el('p',{},'Click a day on the calendar to see your selected people.'));return section;}
  const day=result.days.find(day=>day.date===selectedDate),state=filmingDayState(day);
  section.append(el('h3',{'data-filming-detail-heading':'',tabindex:'-1'},dateLabel(selectedDate)),el('div',{class:'filming-day-summary filming-'+state},el('strong',{},state==='free'?'Everyone selected is free':state==='waiting'?'Some hours are missing or need checking':'No shared '+hours+'-hour window'),state==='free'?el('p',{},day.windows.map(windowLabel).join(' · ')):null));
  const list=el('div',{class:'filming-day-people'});
  function showPeople(){
   const rows=peopleForFilmingDay(result.members,selected,selectedDate,filter);
   const label=filter==='available'?'available':filter==='unavailable'?'marked unavailable':'without confirmed hours';
   list.replaceChildren(el('p',{class:'availability-help'},rows.length+' of '+selected.size+' selected '+(selected.size===1?'person':'people')+' '+label));
   if(!rows.length){list.append(el('p',{},'No selected people in this group.'));return;}
   const ul=el('ul');
   for(const {member,day} of rows)ul.append(el('li',{},el('strong',{},member.name),el('span',{},day.status==='available'?day.windows.map(windowLabel).join(' · '):day.status==='unavailable'?'Unavailable':day.status==='needs-confirmation'?'Confirm hours around the clock change':'No availability given')));
   list.append(ul);
  }
  const filters=el('fieldset',{class:'filming-filters'},el('legend',{},'Selected people'));
  for(const [value,label] of [['available','Available'],['unavailable','Unavailable'],['unknown','No availability given']]){
   const radio=el('input',{type:'radio',name:filterName,value,onchange:()=>{filter=value;showPeople();}});radio.checked=filter===value;filters.append(el('label',{},radio,el('span',{},label)));
  }
  section.append(filters,list);showPeople();return section;
 }
 function suggestions(){
  const section=el('section',{class:'filming-suggestions'},el('h3',{},'Suggested filming times'),el('p',{class:'availability-help'},'Friday–Sunday first · No time-of-day limits · At least '+hours+' hours together'));
  const weekdays=el('input',{type:'checkbox',onchange:event=>{includeWeekdays=event.target.checked;renderBoard();}});weekdays.checked=includeWeekdays;
  section.append(el('label',{class:'filming-weekday-option'},weekdays,el('span',{},'Include weekdays (for holiday weeks, etc.)')));
  const options=filmingSuggestions(result,{today:today(),includeWeekdays});
  if(!options.length)section.append(el('p',{},includeWeekdays?'No upcoming shared times in this month. Try another month.':'No shared Friday–Sunday dates this month. Try another month or include weekdays.'));
  else{
   const list=el('div',{class:'filming-suggestion-list'});
   for(const day of options){const best=[...day.windows].sort((a,b)=>b.minutes-a.minutes||a.start.localeCompare(b.start))[0];list.append(button('',()=>chooseDate(day.date),{class:'filming-suggestion','aria-label':'View suggested filming time '+dateLabel(day.date)}));const item=list.lastElementChild;item.append(el('strong',{},dateLabel(day.date,true)),el('span',{},windowLabel(best)),el('small',{},hoursLabel(best.minutes)+' together'));}
   section.append(list);
  }
  return section;
 }
 function renderBoard(){
  board.replaceChildren();
  if(checking){board.append(el('p',{role:'status'},'Checking '+monthLabel(month)+'…'));return;}
  if(!result)return;
  board.append(el('div',{class:'filming-layout'},calendar(),dayDetails()),suggestions(),el('p',{class:'availability-help'},'Eastern time · On-set arrival to departure · These are available times, not confirmed shoots.'));
 }
 function render(){
  if(destroyed)return;
  const select=el('select',{'aria-label':'Filming production',onchange:event=>{production=event.target.value;selected.clear();search='';invalidate();data=null;loadRoster();}});
  for(const choice of choices){const option=el('option',{value:choice.id},choice.name);option.selected=choice.id===production;select.append(option);}
  select.disabled=loading||checking;
  body.replaceChildren(el('div',{class:'filming-heading'},el('h2',{},'Filming Availability'),button('Refresh',refresh,{disabled:loading||checking?'disabled':null})),field('Production',select));
  if(loading)body.append(el('p',{role:'status'},'Loading names…'));
  else if(!data)body.append(button('Try again',()=>loadRoster()));
  else if(!roster().length)body.append(el('p',{},'No cast or crew profiles are assigned to this production yet.'));
  else{
   body.append(peoplePicker());
   if(result)body.append(el('p',{class:'filming-selected-names'},selectedNames().join(' · ')));
   else if(!checking)body.append(el('p',{class:'availability-help'},'Choose who’s needed, then show the calendar.'));
  }
  body.append(board);renderBoard();
 }
 if(production)loadRoster();else{body.append(el('p',{},'No productions are available.'));}
 return {refresh,busy:()=>loading||checking,destroy(){destroyed=true;sequence++;container.replaceChildren();}};
}
