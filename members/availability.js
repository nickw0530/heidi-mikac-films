import {comparePeople,sortPeople} from './people-order.mjs';
import {rawAvailabilityDay,effectiveAvailabilityDay} from './availability-state.mjs';
const ZONE='America/Indiana/Indianapolis';
const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const STATUSES={available:'Available',unavailable:'Unavailable',maybe:'Maybe',unknown:'Not answered','needs-confirmation':'Check clock change'};
const clone=value=>JSON.parse(JSON.stringify(value));
const emptyDay=()=>({status:'unknown',windows:[]});
const emptySchedule=()=>({timezone:ZONE,weekly:DAYS.map(emptyDay),exceptions:{}});
const parts=(date,options)=>Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:ZONE,...options}).formatToParts(date).map(part=>[part.type,part.value]));
const today=()=>{const p=parts(new Date(),{year:'numeric',month:'2-digit',day:'2-digit'});return p.year+'-'+p.month+'-'+p.day;};
const addDays=(date,count)=>new Date(Date.parse(date+'T12:00:00Z')+count*86400000).toISOString().slice(0,10);
const shiftMonth=(month,delta)=>{
 const [year,number]=month.split('-').map(Number);
 return new Date(Date.UTC(year,number-1+delta,1,12)).toISOString().slice(0,7);
};
function monthDetails(month){
 const [year,number]=month.split('-').map(Number),first=new Date(Date.UTC(year,number-1,1,12));
 return {count:new Date(Date.UTC(year,number,0)).getUTCDate(),offset:first.getUTCDay(),heading:new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'long',year:'numeric'}).format(first)};
}
const dayLabel=date=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'long',month:'long',day:'numeric',year:'numeric'}).format(new Date(date+'T12:00:00Z'));
const shortDate=date=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric'}).format(new Date(date+'T12:00:00Z'));
const timeLabel=time=>{if(time==='24:00')return 'midnight';const [hours,minutes]=time.split(':').map(Number);return (hours%12||12)+(minutes?':'+String(minutes).padStart(2,'0'):'')+(hours<12?' a.m.':' p.m.');};
const windowsLabel=windows=>windows.map(window=>timeLabel(window.start)+'–'+timeLabel(window.end)).join(', ');
function el(tag,attributes={},...children){
 const node=document.createElement(tag);
 for(const [key,value] of Object.entries(attributes)){
  if(key==='class')node.className=value;
  else if(key==='text')node.textContent=value;
  else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);
  else if(value!==undefined&&value!==null)node.setAttribute(key,String(value));
 }
 for(const child of children.flat())if(child!==undefined&&child!==null)node.append(typeof child==='string'?document.createTextNode(child):child);
 return node;
}
const button=(text,action,attributes={})=>el('button',{type:'button',onclick:action,...attributes},text);
// A day left blank in a month the person has otherwise filled in counts as unavailable.
// Admin screens say so, so a blank is not mistaken for an answer.
const statusText=value=>value.implicit?'Unavailable · left blank':STATUSES[value.status]||STATUSES.unknown;
function field(text,control){return el('label',{},el('span',{},text),control);}
function stamp(date,time){
 if(time==='24:00'){date=addDays(date,1);time='00:00';}
 if(!/^\d{2}:\d{2}$/.test(time))return null;
 const [hours,minutes]=time.split(':').map(Number);
 const base=Date.parse(date+'T00:00:00Z')+hours*3600000+minutes*60000;
 const matches=[240,300].map(offset=>base+offset*60000).filter(value=>{
  const p=parts(new Date(value),{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  return p.year+'-'+p.month+'-'+p.day===date&&p.hour+':'+p.minute===time;
 });
 return matches.length===1?matches[0]:null;
}
function scheduleDay(record,date){
 const entry=effectiveAvailabilityDay(record,date);
 if(entry.status!=='available')return {...entry,status:entry.status||'unknown',windows:[]};
 const windows=entry.windows||[];
 if(!windows.length||windows.some(window=>stamp(date,window.start)===null||stamp(date,window.end)===null))return {status:'needs-confirmation',windows:[],warning:'A time falls within a clock change. Update this date with an unambiguous time.'};
 return {status:'available',windows};
}

/** The request callback uses the portal's authenticated request(action, body, memberId). */
export function mountAvailability(container,options){
 const {request,admin=false,memberId,onSaved}=options;
 let data=null,selectedMember=memberId||'',selectedDate=today(),month=selectedDate.slice(0,7),draft=null,revision=null;
 let teamDate=selectedDate,teamMonth=month;
 let destroyed=false,dirty=false,saving=false,loading=false,weeklyOpen=false,matchingBusy=false,loadSequence=0,matchSequence=0,matchResults=null;
 let quickTimer=null,quickSaving=false,quickVersion=0,quickBlocked=false,lastQuickChange=null,productionDayOpen=false;
 let scene='',matchFrom=today(),matchTo=addDays(today(),29),minimumHours='2',castSearch='';
 let adminView=memberId?'person':'day',unansweredOpen=false;
 const selectedPeople=new Set();
 const notice=el('p',{class:'availability-notice',role:'status','aria-live':'polite'});
 const body=el('div',{class:'availability-body'});
 container.classList.add('availability-widget');
 container.classList.toggle('availability-admin',admin);
 container.setAttribute('data-availability-root','');
 container.replaceChildren(notice,body);
 const markDirty=(quick=false)=>{
  if(!quick){
   lastQuickChange=null;
   const undo=body.querySelector('[data-availability-undo]');
   if(undo)undo.disabled=true;
  }
  dirty=true;container.dataset.availabilityDirty='true';invalidateMatches();
  const discard=body.querySelector('[data-availability-discard]');if(discard)discard.hidden=false;
 };
 const markClean=()=>{dirty=false;delete container.dataset.availabilityDirty;const discard=body.querySelector('[data-availability-discard]');if(discard)discard.hidden=true;};
 const beforeUnload=event=>{if(dirty){event.preventDefault();event.returnValue='';}};
 window.addEventListener('beforeunload',beforeUnload);
 const currentMember=()=>data?.members.find(member=>member.id===selectedMember);
 const canEdit=()=>!!currentMember()?.canEdit;
 const note=(text,error=false)=>{notice.textContent=text;notice.classList.toggle('availability-error',error);};
 function invalidateMatches(){matchSequence++;matchResults=null;body.querySelectorAll('.availability-match-results').forEach(result=>result.remove());}
 function adopt(retainUndo=false){
  clearTimeout(quickTimer);quickBlocked=false;
  if(!retainUndo)lastQuickChange=null;
  const member=currentMember();draft=clone(member?.availability||emptySchedule());
  draft.timezone=ZONE;draft.weekly=DAYS.map((_,index)=>draft.weekly?.[index]||emptyDay());draft.exceptions??={};
  revision=member?.revision??null;markClean();
 }
 function changeAdminView(view){
  if(dirty){if(!confirm('Discard unsaved availability changes?'))return;adopt();}
  adminView=view;render();note('');
 }
 function openPerson(id){
  if(dirty&&!confirm('Discard unsaved availability changes?'))return;
  selectedMember=id;adminView='person';weeklyOpen=false;adopt();render();note('');
 }
 function selectDay(date){
  if(!date)return;
  const previousMonth=month;selectedDate=date;month=date.slice(0,7);render();
  if(month!==previousMonth)refresh(true,true);
 }
 function monthRange(){const [year,number]=month.split('-').map(Number);return {from:month+'-01',to:month+'-'+String(new Date(Date.UTC(year,number,0)).getUTCDate()).padStart(2,'0')};}
 async function refresh(force=false,preserveEdits=false){
  if(destroyed||saving||quickSaving||dirty&&!force)return false;
  const sequence=++loadSequence;loading=true;
  if(!data)body.replaceChildren(el('p',{},'Loading availability…'));
  else if(!preserveEdits)body.querySelectorAll('input,select,button').forEach(control=>{control.disabled=true;});
  try{
   const result=await request('availability',undefined,'','&'+new URLSearchParams(monthRange()));if(destroyed||sequence!==loadSequence)return false;
   data=admin?{...result,members:sortPeople(result.members)}:result;
   invalidateMatches();
   const visibleIds=new Set(data.members.map(member=>member.id));
   for(const id of selectedPeople)if(!visibleIds.has(id))selectedPeople.delete(id);
   if(!data.members.some(member=>member.id===selectedMember))selectedMember=memberId?'':data.members.find(member=>member.id===data.selfId)?.id||data.members[0]?.id||'';
   if(!preserveEdits||!draft)adopt();render();return true;
  }catch(error){if(!destroyed&&sequence===loadSequence){note(error.message||'Availability could not be loaded.',true);if([401,403].includes(error.status)){data=null;draft=null;markClean();body.replaceChildren(el('p',{},'Availability is no longer accessible. Refresh the portal or sign in again.'));}else if(!data)body.replaceChildren(button('Try again',()=>refresh(true)));else render();}return false;}
  finally{if(sequence===loadSequence)loading=false;}
 }
 function viewDay(member,date){
  if(member.id===selectedMember&&dirty)return scheduleDay(draft,date);
  return member.days?.find(day=>day.date===date)||scheduleDay(member.id===selectedMember?draft:member.availability,date);
 }
 function validateDraft(){
  for(const entry of [...draft.weekly,...Object.values(draft.exceptions)]){
   if(entry.status!=='available')continue;
   if(!entry.windows.length)throw Error('Add an arrival and departure time for every Available day.');
   for(const window of entry.windows){
    if(!window.start||!window.end)throw Error('Complete both the earliest arrival and latest departure times.');
    if(window.end<=window.start)throw Error('Departure must be after arrival. For overnight availability, split the hours across the two dates.');
   }
  }
 }
 async function save(success){
  if(saving||quickSaving||!canEdit())return;
  try{
   validateDraft();saving=true;render();note('Saving availability…');
   const saved=await request('saveAvailability',{revision,timezone:ZONE,weekly:draft.weekly,exceptions:draft.exceptions},selectedMember);
   invalidateMatches();
   const member=currentMember();
   if(member&&saved.availability){member.availability=saved.availability;member.revision=saved.revision??null;delete member.days;adopt();}
   else markClean();
   saving=false;const refreshed=await refresh(true);
   note(refreshed?success:success+' The latest production view could not refresh. Try Refresh availability.',!refreshed);onSaved?.();
  }catch(error){saving=false;render();note(error.status===409?'This availability changed in another session. Your edits are still here. Refresh the schedule before saving again.':error.message||'Availability could not be saved.',true);}
 }
 function windowEditor(entry,window,index,label,rerender){
  const midnight=window.end==='24:00';
  const arrival=el('input',{type:'time',value:window.start,'aria-label':label+' earliest arrival '+(index+1),oninput:event=>{window.start=event.target.value;markDirty();}});
  const departure=el('input',{type:'time',value:midnight?'00:00':window.end,'aria-label':label+' latest departure '+(index+1),oninput:event=>{window.end=event.target.value;markDirty();}});
  if(midnight)departure.disabled=true;
  const nextMidnight=el('input',{type:'checkbox','aria-label':label+' departure at midnight '+(index+1),onchange:event=>{window.end=event.target.checked?'24:00':'';markDirty();rerender();}});nextMidnight.checked=midnight;
  return el('div',{class:'availability-window'},field('Earliest arrival on set',arrival),field('Latest departure from set',departure),field('Departure at midnight',nextMidnight),button('Remove window',()=>{entry.windows.splice(index,1);markDirty();rerender();},{class:'availability-small'}));
 }
 function entryEditor(entry,label,changed){
  const host=el('div',{class:'availability-entry'});
  host.addEventListener('input',()=>changed?.());
  host.addEventListener('change',()=>changed?.());
  function redraw(){
   const select=el('select',{'aria-label':label+' availability',onchange:event=>{entry.status=event.target.value;entry.windows=entry.status==='available'?(entry.windows.length?entry.windows:[{start:'',end:''}]):[];markDirty();redraw();changed?.();}});
   for(const status of ['unknown','available','unavailable','maybe']){const option=el('option',{value:status},STATUSES[status]);option.selected=entry.status===status;select.append(option);}
   host.replaceChildren(field('Availability',select));
   if(entry.status==='available'){
    host.append(...entry.windows.map((window,index)=>windowEditor(entry,window,index,label,()=>{redraw();changed?.();})));
    if(entry.windows.length<4)host.append(button('Add another time window',()=>{entry.windows.push({start:'',end:''});markDirty();redraw();changed?.();},{class:'availability-small'}));
   }
  }
  redraw();return host;
 }
 function weeklyEditor(){
  const details=el('details',{class:'availability-weekly'},el('summary',{},'Usual weekly availability'));
  details.open=weeklyOpen;details.addEventListener('toggle',()=>{weeklyOpen=details.open;});
  details.append(el('p',{},'Enter the hours you can physically be on set after allowing for your drive. Change a particular date below when your usual week does not apply.'));
  const week=el('div',{class:'availability-week'});
  DAYS.forEach((name,index)=>week.append(el('section',{class:'availability-weekday'},el('h5',{},name),entryEditor(draft.weekly[index],name))));
  details.append(week,button('Copy Monday to Tuesday–Friday',()=>{for(const index of [2,3,4,5])draft.weekly[index]=clone(draft.weekly[1]);markDirty();render();},{class:'availability-small'}),el('p',{class:'availability-help'},'For overnight availability, enter one window ending at midnight and another starting on the following date. Saving also includes any unsaved date changes.'),button('Save weekly availability',()=>save('Weekly availability saved.'),{disabled:saving||quickSaving?'disabled':null}));
  return details;
 }
 // Exact on-set hours saved earlier are kept. Tapping a day back round to Available restores
 // those hours instead of quietly widening the day to all day.
 const savedHours=new Map();
 const allDay=windows=>windows.length===1&&windows[0].start==='00:00'&&windows[0].end==='24:00';
 function cycleDay(date){
  if(!canEdit()||saving||loading)return;
  selectedDate=date;
  lastQuickChange={date,exception:Object.hasOwn(draft.exceptions,date)?clone(draft.exceptions[date]):null};
  const before=rawAvailabilityDay(draft,date);
  if(!savedHours.has(date)&&before.status==='available'&&before.windows?.length&&!allDay(before.windows))savedHours.set(date,clone(before.windows));
  const cycle=['unknown','available','unavailable','maybe'],current=before.status;
  const status=cycle[(Math.max(0,cycle.indexOf(current))+1)%cycle.length];
  draft.exceptions[date]={status,windows:status==='available'?(savedHours.has(date)?clone(savedHours.get(date)):[{start:'00:00',end:'24:00'}]):[]};
  queueDaySave(dayLabel(date)+' set to '+{unknown:'blank',available:savedHours.has(date)?'available for your saved hours':'available all day',unavailable:'unavailable',maybe:'maybe'}[status]+'.');
 }
 function undoDay(){
  if(!lastQuickChange||saving||quickSaving||loading||!canEdit())return;
  const {date,exception}=lastQuickChange;
  lastQuickChange=null;
  if(exception)draft.exceptions[date]=exception;
  else delete draft.exceptions[date];
  if(date.startsWith(month+'-'))selectedDate=date;
  queueDaySave();
  body.querySelector('[data-availability-date="'+selectedDate+'"]')?.focus({preventScroll:true});
 }
 function queueDaySave(spoken=''){
  quickVersion++;markDirty(true);render();
  if(!quickBlocked)note((spoken?spoken+' ':'')+'Saving calendar changes…');
  clearTimeout(quickTimer);if(!quickBlocked)quickTimer=setTimeout(saveClickedDays,250);
 }
 function retryClickedDays(){
  if(quickBlocked!=='retry')return;
  quickBlocked=false;note('Saving calendar changes…');saveClickedDays();
 }
 async function saveClickedDays(){
  if(destroyed||quickSaving||saving||quickBlocked||!dirty)return;
  const version=quickVersion;
  try{
   validateDraft();quickSaving=true;render();
   const value=clone(draft),saved=await request('saveAvailability',{revision,timezone:ZONE,weekly:value.weekly,exceptions:value.exceptions},selectedMember);
   if(destroyed)return;
   if(!saved.availability)throw Error('The calendar save could not be confirmed.');
   const member=currentMember();member.availability=saved.availability;member.revision=saved.revision??null;delete member.days;revision=member.revision;
   if(version===quickVersion){adopt(true);note('Calendar saved.');onSaved?.();}
   else note('Saving calendar changes…');
  }catch(error){
   if(!destroyed){
    quickBlocked=error.status===409?'conflict':'retry';
    note(quickBlocked==='conflict'?'Your calendar changed in another session. These clicks are not saved. Refresh availability before trying again.':(error.message||'These calendar changes could not be saved.')+' Your changes remain on screen. Use Retry save to try again.',true);
   }
  }finally{
   quickSaving=false;
   if(!destroyed){render();if(dirty&&!quickBlocked&&version!==quickVersion)quickTimer=setTimeout(saveClickedDays,0);}
  }
 }
 function calendar(){
  const {count,offset,heading}=monthDetails(month);
  const shift=delta=>{month=shiftMonth(month,delta);selectedDate=month+'-01';render();refresh(true,true);};
  const section=el('section',{class:'availability-calendar'});
  section.append(el('div',{class:'availability-month-nav'},button('Previous month',()=>shift(-1),{'data-availability-focus':'previous-month'}),el('h4',{},heading),button('Next month',()=>shift(1),{'data-availability-focus':'next-month'})));
  if(admin)section.append(el('p',{class:'availability-help'},'Calendar for '+(currentMember()?.name||'this person')+'. Select a date to see everyone’s availability.'));
  else section.append(el('p',{class:'availability-help'},'Tap a date to cycle through available all day, unavailable, maybe, and blank. Changes save automatically. On a keyboard, the arrow keys move between dates.'));
  const grid=el('div',{class:'availability-month-grid',role:'group','aria-label':heading+' availability'});
  const totals=Object.fromEntries(Object.keys(STATUSES).map(status=>[status,0]));
  DAYS.forEach(name=>grid.append(el('div',{class:'availability-day-heading','aria-label':name},name.slice(0,3))));
  for(let blank=0;blank<offset;blank++)grid.append(el('span',{'aria-hidden':'true'}));
  for(let day=1;day<=count;day++){
   const date=month+'-'+String(day).padStart(2,'0'),value=viewDay(currentMember(),date),raw=rawAvailabilityDay(draft,date);
   totals[value.status]++;
   const status=!admin&&raw.status==='unknown'?'unknown':value.status;
   const label=!admin&&status==='unknown'?(value.implicit?'Blank · counts as unavailable':'Blank'):(STATUSES[status]||STATUSES.unknown);
   const cell=button('',()=>{if(!admin&&canEdit())cycleDay(date);else{selectedDate=date;render();}},{class:'availability-date availability-'+status+(date===selectedDate?' availability-selected':''),'aria-label':dayLabel(date)+' · '+(admin&&value.implicit?statusText(value):label),...(admin?{'aria-pressed':date===selectedDate?'true':'false'}:{}),'data-availability-date':date,
    onkeydown:event=>{
     const delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[event.key];
     if(delta===undefined)return;
     const next=grid.querySelector('[data-availability-date="'+addDays(date,delta)+'"]');
     if(next){event.preventDefault();next.focus();}
    }});
   cell.append(el('b',{},String(day)),el('span',{},admin?(value.implicit?'Left blank':STATUSES[status]||label):({available:'✓',unavailable:'×',maybe:'?','needs-confirmation':'!'}[status]||'')));
   if(admin&&Object.hasOwn(draft.exceptions,date))cell.append(el('span',{class:'availability-changed'},'Changed'));
   grid.append(cell);
  }
  section.append(grid,el('p',{class:'availability-legend'},el('span',{class:'availability-key availability-available'},admin?'Available':'✓ Available'),el('span',{class:'availability-key availability-unavailable'},admin?'Unavailable':'× Unavailable'),el('span',{class:'availability-key availability-maybe'},admin?'Maybe':'? Maybe'),el('span',{class:'availability-key availability-unknown'},admin?'Not answered':'Blank')));
  if(!admin){
   const summary=totals.available+' available · '+totals.unavailable+' unavailable · '+totals.maybe+' maybe · '+totals.unknown+' not answered'+(totals['needs-confirmation']?' · '+totals['needs-confirmation']+' to check':'');
   section.append(el('p',{class:'availability-month-summary'},summary),
    el('p',{class:'availability-help'},totals.unknown===count?'An untouched month is unanswered. Once you set any day in a month, blank dates in that month count as unavailable.':'Blank dates count as unavailable this month.'));
   if(canEdit())section.append(button(lastQuickChange?'Undo '+shortDate(lastQuickChange.date)+' change':'Undo last day change',undoDay,{'data-availability-undo':'',disabled:lastQuickChange?null:'disabled'}));
  }
  return section;
 }
 function dateEditor(){
  const entry=clone(draft.exceptions[selectedDate]||draft.weekly[new Date(selectedDate+'T12:00:00Z').getUTCDay()]||emptyDay());
  const exception=Object.hasOwn(draft.exceptions,selectedDate);
  const section=el('section',{class:'availability-date-editor'},el('h4',{},dayLabel(selectedDate)));
  section.append(el('p',{},exception?'This date has a saved change to the usual week.':'This date currently follows the usual week.'));
  const dateInput=el('input',{type:'date',value:selectedDate,'aria-label':'Date to change','data-availability-focus':'date-input',onchange:event=>{if(event.target.value){const previousMonth=month;selectedDate=event.target.value;month=selectedDate.slice(0,7);render();if(previousMonth!==month)refresh(true,true);}}});
  section.append(field('Choose date',dateInput),entryEditor(entry,dayLabel(selectedDate),()=>{draft.exceptions[selectedDate]=entry;}));
  section.append(button('Save this date',()=>{draft.exceptions[selectedDate]=entry;markDirty();save('Availability saved for '+shortDate(selectedDate)+'.');},{disabled:saving||quickSaving?'disabled':null}));
  if(exception)section.append(button('Use weekly schedule',()=>{delete draft.exceptions[selectedDate];markDirty();save('This date now follows the weekly schedule.');},{disabled:saving||quickSaving?'disabled':null}));
  return section;
 }
 function teamCalendar(){
  const {count,offset,heading}=monthDetails(teamMonth);
  const calendar=el('div',{class:'availability-team-calendar'});
  const shift=delta=>{productionDayOpen=true;teamMonth=shiftMonth(teamMonth,delta);render();};
  const navigation=el('div',{class:'availability-team-month-nav'},
   button('‹',()=>shift(-1),{'aria-label':'Previous month for everyone’s availability','data-availability-focus':'team-previous','data-team-calendar-control':''}),
   el('h5',{},heading),
   button('›',()=>shift(1),{'aria-label':'Next month for everyone’s availability','data-availability-focus':'team-next','data-team-calendar-control':''}));
  const grid=el('div',{class:'availability-team-month-grid',role:'group','aria-label':heading+' · Everyone’s availability dates'});
  DAYS.forEach(name=>grid.append(el('div',{class:'availability-day-heading','aria-label':name},name.slice(0,2))));
  for(let blank=0;blank<offset;blank++)grid.append(el('span',{'aria-hidden':'true'}));
  const focusDate=teamDate.startsWith(teamMonth+'-')?teamDate:teamMonth+'-01';
  function select(date){
   productionDayOpen=true;teamDate=date;teamMonth=date.slice(0,7);render();
   body.querySelector('[data-availability-focus="team-'+date+'"]')?.focus({preventScroll:true});
  }
  for(let day=1;day<=count;day++){
   const date=teamMonth+'-'+String(day).padStart(2,'0');
   grid.append(button(String(day),()=>select(date),{
    class:'availability-team-date','aria-label':dayLabel(date),'aria-pressed':String(date===teamDate),tabindex:date===focusDate?0:-1,
    'data-availability-focus':'team-'+date,'data-team-calendar-control':'',
    onkeydown:event=>{
     const delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[event.key];
     if(delta===undefined)return;
     event.preventDefault();select(addDays(date,delta));
    }
   }));
  }
  calendar.append(navigation,grid);return calendar;
 }
 function productionDay(){
  const section=el('details',{class:'availability-production-day'},el('summary',{'data-availability-focus':'team-summary'},'Everyone’s availability · '+shortDate(teamDate)));
  section.open=productionDayOpen;
  section.addEventListener('toggle',()=>{if(section.isConnected)productionDayOpen=section.open;});
  const list=el('ul',{class:'availability-people-day','aria-label':'Availability for '+dayLabel(teamDate)});
  for(const member of data.members){
   const value=viewDay(member,teamDate);
   const row=el('li',{},el('div',{},el('strong',{},member.name),member.role?el('span',{class:'availability-role'},member.role):null),el('div',{class:'availability-status availability-'+value.status},el('strong',{},statusText(value)),value.status==='available'?el('span',{},windowsLabel(value.windows)):null));
   if(value.warning)row.append(el('small',{},value.warning));
   list.append(row);
  }
  section.append(teamCalendar(),el('p',{class:'availability-help'},'Hours are shown in Eastern time.'),list);return section;
 }
 function dailyAvailability(){
  const section=el('section',{class:'availability-daily'},el('h4',{},dayLabel(selectedDate)));
  const date=el('input',{type:'date',value:selectedDate,'aria-label':'View availability date',onchange:event=>selectDay(event.target.value)});
  section.append(el('div',{class:'availability-daily-nav'},button('Previous day',()=>selectDay(addDays(selectedDate,-1))),field('Choose a date',date),button('Next day',()=>selectDay(addDays(selectedDate,1))),selectedDate!==today()?button('Today',()=>selectDay(today())):null));
  const days=data.members.map(member=>({member,value:viewDay(member,selectedDate)}));
  const totals=Object.fromEntries(Object.keys(STATUSES).map(status=>[status,days.filter(day=>day.value.status===status).length]));
  section.append(el('p',{class:'availability-daily-totals'},totals.available+' available · '+totals.unavailable+' unavailable · '+totals.maybe+' maybe · '+totals.unknown+' not answered'+(totals['needs-confirmation']?' · '+totals['needs-confirmation']+' to check':'')),el('p',{class:'availability-help'},'Click a name to view or edit their schedule.'));
  days.sort((a,b)=>comparePeople(a.member,b.member));
  function row({member,value}){
   const person=el('div',{},button(member.name,()=>openPerson(member.id),{class:'availability-person-link','aria-label':'View or edit availability for '+member.name}),member.role?el('span',{class:'availability-role'},member.role):null);
   const hours=el('div',{class:'availability-daily-hours'},value.status==='available'?el('strong',{},windowsLabel(value.windows)):null,el('span',{class:'availability-badge availability-'+value.status},statusText(value)));
   return el('li',{},person,hours,value.warning?el('small',{class:'availability-daily-warning'},value.warning):null);
  }
  const answered=days.filter(day=>day.value.status!=='unknown'),unanswered=days.filter(day=>day.value.status==='unknown');
  if(answered.length)section.append(el('ul',{class:'availability-daily-list','aria-label':'Submitted availability for '+dayLabel(selectedDate)},answered.map(row)));
  else section.append(el('p',{class:'availability-empty'},'No one has submitted hours for this date yet.'));
  if(unanswered.length){
   const details=el('details',{class:'availability-unanswered'},el('summary',{},'Not answered ('+unanswered.length+')'),el('ul',{class:'availability-daily-list','aria-label':'People who have not answered for '+dayLabel(selectedDate)},unanswered.map(row)));
   details.open=unansweredOpen;details.addEventListener('toggle',()=>{unansweredOpen=details.open;});section.append(details);
  }
  return section;
 }
 function matching(){
  const section=el('section',{class:'availability-matching'},el('h4',{},'Find a shared time'));
  section.append(el('p',{class:'availability-help'},'Choose the people needed and how long you need them on set.'));
  section.append(el('h5',{},'1. Choose the people'));
  const checklist=el('div',{class:'availability-cast','aria-label':'People needed for this scene'});
  const tally=el('p',{class:'availability-selection-count','aria-live':'polite'});
  const clear=button('Clear selection',()=>{selectedPeople.clear();checklist.querySelectorAll('input').forEach(check=>{check.checked=false;});updateCount();invalidateMatches();},{class:'availability-small'});
  function updateCount(){tally.textContent=selectedPeople.size+' '+(selectedPeople.size===1?'person':'people')+' selected';clear.disabled=!selectedPeople.size;}
  for(const member of data.members){
   const check=el('input',{type:'checkbox',value:member.id,onchange:event=>{event.target.checked?selectedPeople.add(member.id):selectedPeople.delete(member.id);updateCount();invalidateMatches();}});check.checked=selectedPeople.has(member.id);
   const label=el('label',{class:'availability-person-option'},check,el('span',{},el('b',{},member.name),member.role?el('small',{},member.role):null));
   label.dataset.search=[member.name,member.role||''].join(' ').toLowerCase();checklist.append(label);
  }
  const noPeople=el('p',{class:'availability-help'},'No names match your search.');
  function filterPeople(){let count=0;for(const label of checklist.children){label.hidden=!label.dataset.search.includes(castSearch.trim().toLowerCase());if(!label.hidden)count++;}noPeople.hidden=!!count;}
  const search=el('input',{type:'search',value:castSearch,'aria-label':'Search people for scene',placeholder:'Search names or roles',oninput:event=>{castSearch=event.target.value;filterPeople();}});
  section.append(field('Search people',search),checklist,noPeople,el('div',{class:'availability-selection-tools'},tally,clear));updateCount();filterPeople();
  section.append(el('h5',{},'2. Choose dates and shoot length'));
  const from=el('input',{type:'date',value:matchFrom,onchange:event=>{matchFrom=event.target.value;invalidateMatches();},'aria-label':'Search from date'}),to=el('input',{type:'date',value:matchTo,onchange:event=>{matchTo=event.target.value;invalidateMatches();},'aria-label':'Search through date'}),hours=el('input',{type:'number',min:0.25,max:24,step:0.25,value:minimumHours,oninput:event=>{minimumHours=event.target.value;invalidateMatches();},'aria-label':'Minimum shared hours'});
  section.append(el('div',{class:'availability-search-fields'},field('Start date',from),field('End date',to),field('Hours needed',hours)));
  const sceneInput=el('input',{type:'text',value:scene,maxlength:120,'aria-label':'Scene name',oninput:event=>{scene=event.target.value;invalidateMatches();}});
  section.append(el('details',{class:'availability-scene-name'},el('summary',{},'Add a scene name (optional)'),field('Scene name',sceneInput)));
  const find=button('Find shared times',async()=>{
   if(dirty){note('Save or discard your availability changes before comparing dates.',true);return;}
   if(!selectedPeople.size){note('Select at least one person needed for this scene.',true);return;}
   const sequence=matchSequence;
   find.disabled=true;matchingBusy=true;note('Comparing availability…');
   try{const result=await request('availabilityMatch',{members:[...selectedPeople],from:matchFrom,to:matchTo,minMinutes:Math.round(Number(minimumHours)*60)});if(destroyed||sequence!==matchSequence)return;matchResults=result;render();note('Availability comparison updated.');}
   catch(error){if(!destroyed&&sequence===matchSequence)note(error.message||'The availability comparison could not be completed.',true);}
   finally{matchingBusy=false;find.disabled=false;}
  },{class:'availability-primary'});section.append(find);
  if(matchResults)section.append(matchOutput());
  return section;
 }
 function matchOutput(){
  const result=el('div',{class:'availability-match-results','aria-live':'polite'},el('h5',{},scene?'Shared windows · '+scene:'Shared windows'));
  const matches=matchResults.matches||[];
  result.append(el('p',{},matches.length?matches.length+' day'+(matches.length===1?' has':'s have')+' a shared window.':'No confirmed shared window meets this duration.'));
  if(matches.length){const list=el('ul');for(const day of matches)list.append(el('li',{},el('strong',{},dayLabel(day.date)),el('span',{},day.windows.map(window=>timeLabel(window.start)+'–'+timeLabel(window.end)+' ('+(Math.round(window.minutes/60*100)/100)+' hours)').join('; '))));result.append(list);}
  const blocked=(matchResults.days||[]).filter(day=>!day.windows?.length);
  if(blocked.length){
   const details=el('details',{},el('summary',{},'Dates needing follow-up ('+blocked.length+')')),list=el('ul');
   for(const day of blocked){
    const reasons=[];
    if(day.missing?.length)reasons.push('Not answered: '+sortPeople(day.missing).map(person=>person.name).join(', '));
    if(day.unavailable?.length)reasons.push('Unavailable: '+sortPeople(day.unavailable).map(person=>person.name+(person.implicit?' (left blank)':'')).join(', '));
    if(day.maybe?.length)reasons.push('Maybe: '+sortPeople(day.maybe).map(person=>person.name).join(', '));
    if(day.needsConfirmation?.length)reasons.push('Check clock change: '+sortPeople(day.needsConfirmation).map(person=>person.name).join(', '));
    list.append(el('li',{},el('strong',{},shortDate(day.date)),el('span',{},reasons.join(' · ')||'Available hours do not overlap for the requested duration.')));
   }
   details.append(list);result.append(details);
  }
  result.append(el('p',{class:'availability-help'},'Availability is a planning aid. A shared window is not a confirmed filming event.'));
  return result;
 }
 function updatedLabel(member){
  if(!member?.availability?.updated)return null;
  const date=new Intl.DateTimeFormat('en-US',{timeZone:ZONE,month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(member.availability.updated));
  return el('p',{class:'availability-help'},'Last updated '+date+(member.availability.updatedByLabel?' · '+member.availability.updatedByLabel:''));
 }
 function renderAdmin(){
  body.append(el('p',{class:'availability-admin-help'},'Eastern time · Hours show arrival on set to departure.'));
  if(!memberId||adminView!=='person'){
   const views=el('div',{class:'availability-admin-tabs',role:'group','aria-label':'Availability views'});
   for(const [view,label] of [['day','Daily availability'],['match','Find shoot dates']])views.append(button(label,()=>changeAdminView(view),{'aria-pressed':adminView===view?'true':'false'}));
   body.append(views);
  }
  if(!data.members.length){body.append(el('p',{},'No cast or crew profiles are assigned to this production yet.'));return;}
  if(adminView==='day')body.append(dailyAvailability());
  else if(adminView==='match')body.append(matching());
  else{
   const member=currentMember();
   body.append(button(memberId?'View everyone’s availability':'Back to daily availability',()=>changeAdminView('day'),{class:'availability-small'}));
   if(!member){body.append(el('p',{},'This person is no longer available in this production.'));return;}
   body.append(el('h4',{class:'availability-edit-name'},member.name+' · Edit availability'));
   const updated=updatedLabel(member);if(updated)body.append(updated);
   if(!canEdit()){body.append(el('p',{},'This schedule cannot be edited.'));return;}
   body.append(weeklyEditor(),dateEditor(),el('details',{class:'availability-month-picker'},el('summary',{},'Browse month'),calendar()));
  }
  body.append(el('p',{class:'availability-help'},'Members of this production can see these hours. Availability does not book a shoot.'));
 }
 function render(){
  if(destroyed||!data)return;
  const focused=body.contains(document.activeElement)?document.activeElement.dataset:null;
  const member=currentMember();
  const header=el('div',{class:'availability-heading'},el('h3',{},admin?'Availability':'Availability · '+data.film),button('Refresh availability',()=>{if(!dirty||confirm('Discard unsaved availability changes and refresh?')){clearTimeout(quickTimer);markClean();refresh(true);}},{disabled:saving||quickSaving?'disabled':null}));
  body.replaceChildren(header);
  body.append(button('Discard unsaved changes',()=>{adopt();render();note('Unsaved availability changes discarded.');},{class:'availability-discard','data-availability-discard':'',hidden:dirty?null:'hidden',disabled:saving||quickSaving?'disabled':null}));
  if(admin){renderAdmin();if(saving)body.querySelectorAll('button,input,select').forEach(control=>{control.disabled=true;});return;}
  if(!data.members.length){body.append(el('p',{},'No cast or crew profiles are assigned to this production yet.'));return;}
  if(canEdit()&&quickBlocked==='retry')body.append(button('Retry save',retryClickedDays));
  const updated=updatedLabel(member);if(updated)body.append(updated);
  body.append(calendar(),productionDay());
  if(saving)body.querySelectorAll('button,input,select').forEach(control=>{control.disabled=true;});
  else if(quickSaving)body.querySelectorAll('input,select,button:not(.availability-date):not([data-team-calendar-control])').forEach(control=>{control.disabled=true;});
  const focusSelector=focused?.availabilityDate?'[data-availability-date="'+focused.availabilityDate+'"]':
   focused?.availabilityFocus?'[data-availability-focus="'+focused.availabilityFocus+'"]':null;
  if(focusSelector)body.querySelector(focusSelector)?.focus({preventScroll:true});
 }
 refresh();
 return {
  refresh:()=>refresh(),
  busy:()=>dirty||saving||quickSaving||loading||matchingBusy,
  destroy(){destroyed=true;clearTimeout(quickTimer);loadSequence++;window.removeEventListener('beforeunload',beforeUnload);delete container.dataset.availabilityDirty;container.replaceChildren();}
 };
}
