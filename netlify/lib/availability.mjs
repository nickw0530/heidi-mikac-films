// Availability is expressed in local shoot dates and Eastern wall-clock times.
// No member identity, storage, permissions, or notifications belong in this module.
import {monthHasAvailability} from '../../members/availability-state.mjs';
export const AVAILABILITY_TIMEZONE='America/Indiana/Indianapolis';
export const AVAILABILITY_TIME_ZONE=AVAILABILITY_TIMEZONE;
const MAX_EXCEPTIONS=1100,MAX_WINDOWS=8,MAX_MATCH_DAYS=93,MAX_PEOPLE=100;
const DAY_MS=86400000;
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function requireThat(condition,message){if(!condition)throw Object.assign(new Error(message),{status:400});}
const unknown=()=>({status:'unknown',windows:[]});
export function emptyAvailability(){return {timezone:AVAILABILITY_TIMEZONE,weekly:Array.from({length:7},unknown),exceptions:{}};}

export function validateDate(value){
 requireThat(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value),'Choose a valid date.');
 const [year,month,day]=value.split('-').map(Number),stamp=Date.UTC(year,month-1,day);
 requireThat(year>=2020&&year<=2100&&new Date(stamp).toISOString().slice(0,10)===value,'Choose a valid date between 2020 and 2100.');
 return value;
}
function nextDate(value){return new Date(Date.parse(value+'T00:00:00Z')+DAY_MS).toISOString().slice(0,10);}
export function listDates(from,to,maxDays=MAX_MATCH_DAYS){
 validateDate(from);validateDate(to);
 const count=(Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/DAY_MS+1;
 requireThat(Number.isInteger(count)&&count>=1&&count<=maxDays,'Choose a date range of up to '+maxDays+' days.');
 return Array.from({length:count},(_,index)=>new Date(Date.parse(from+'T00:00:00Z')+index*DAY_MS).toISOString().slice(0,10));
}
function timeMinute(value,end=false){
 requireThat(typeof value==='string'&&/^\d{2}:\d{2}$/.test(value),'Enter arrival and departure times as HH:mm.');
 if(end&&value==='24:00')return 1440;
 const [hour,minute]=value.split(':').map(Number);
 requireThat(hour>=0&&hour<24&&minute>=0&&minute<60,'Choose a valid arrival or departure time.');
 return hour*60+minute;
}
const timeText=value=>value===1440?'24:00':String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');
function mergeIntervals(windows){
 const result=[];
 for(const [start,end] of windows.sort((a,b)=>a[0]-b[0]||a[1]-b[1])){
  const previous=result.at(-1);
  if(previous&&start<=previous[1])previous[1]=Math.max(previous[1],end);else result.push([start,end]);
 }
 return result;
}
function normalizeDay(value){
 if(value===undefined)return unknown();
 requireThat(object(value)&&['available','unavailable','maybe','unknown'].includes(value.status),'Choose Available, Unavailable, Maybe, or Not answered for each day.');
 const windows=value.windows??[];
 requireThat(Array.isArray(windows)&&windows.length<=MAX_WINDOWS,'Keep each day to '+MAX_WINDOWS+' availability windows or fewer.');
 if(value.status!=='available'){
  requireThat(windows.length===0,'Only an available day may contain time windows.');
  return {status:value.status,windows:[]};
 }
 requireThat(windows.length>0,'Add an arrival and departure time for an available day.');
 const intervals=windows.map(window=>{
  requireThat(object(window),'Choose a valid availability window.');
  const start=timeMinute(window.start),end=timeMinute(window.end,true);
  requireThat(end>start,'Departure must be after arrival. For overnight availability, end at midnight and add the remaining hours on the next date.');
  return [start,end];
 });
 // Retain each submitted boundary until a concrete date is known. Merging a
 // recurring pattern here could hide an ambiguous clock-change boundary.
 return {status:'available',windows:intervals.sort((a,b)=>a[0]-b[0]||a[1]-b[1]).map(([start,end])=>({start:timeText(start),end:timeText(end)}))};
}

const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:AVAILABILITY_TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function localParts(stamp){
 const parts=Object.fromEntries(formatter.formatToParts(new Date(stamp)).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
 return {date:parts.year+'-'+parts.month+'-'+parts.day,time:parts.hour+':'+parts.minute,utc:Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute))};
}
// Cache only public timezone calculations, with fixed memory bounds.
const offsetCache=new Map(),instantCache=new Map();
function offsetsFor(date){
 if(offsetCache.has(date))return offsetCache.get(date);
 const stamp=Date.parse(date+'T12:00:00Z'),offsets=new Set();
 for(const hours of [-36,0,36]){const probe=stamp+hours*3600000;offsets.add(localParts(probe).utc-probe);}
 if(offsetCache.size>=256)offsetCache.clear();
 const result=[...offsets];offsetCache.set(date,result);return result;
}
function instantsFor(date,time){
 if(time==='24:00'){date=nextDate(date);time='00:00';}
 const key=date+'/'+time;
 if(instantCache.has(key))return instantCache.get(key);
 const [year,month,day]=date.split('-').map(Number),[hour,minute]=time.split(':').map(Number),nominal=Date.UTC(year,month-1,day,hour,minute);
 const result=[];
 for(const offset of offsetsFor(date)){
  const candidate=nominal-offset,actual=localParts(candidate);
  if(actual.date===date&&actual.time===time&&!result.includes(candidate))result.push(candidate);
 }
 result.sort((a,b)=>a-b);
 if(instantCache.size>=10000)instantCache.clear();
 instantCache.set(key,result);return result;
}
function elapsedMinutes(date,start,end){
 const starts=instantsFor(date,start),ends=instantsFor(date,end);
 requireThat(starts.length===1&&ends.length===1,'This time falls in an Eastern clock change. Choose an unambiguous arrival or departure time.');
 const minutes=(ends[0]-starts[0])/60000;
 requireThat(minutes>0,'Departure must be after arrival.');
 return minutes;
}
export function normalizeAvailability(value){
 requireThat(object(value),'Choose a valid availability schedule.');
 requireThat(value.timezone===undefined||value.timezone===AVAILABILITY_TIMEZONE,'Availability must use Eastern time.');
 const weekly=value.weekly??[];
 requireThat(Array.isArray(weekly)?weekly.length<=7:object(weekly)&&Object.keys(weekly).every(key=>/^[0-6]$/.test(key)),'Use one weekly entry for each day from Sunday through Saturday.');
 const exceptions=value.exceptions??{};
 requireThat(object(exceptions)&&Object.keys(exceptions).length<=MAX_EXCEPTIONS,'Keep date-specific changes to '+MAX_EXCEPTIONS+' dates or fewer.');
 const result={timezone:AVAILABILITY_TIMEZONE,weekly:Array.from({length:7},(_,day)=>normalizeDay(weekly[day])),exceptions:{}};
 for(const [date,entry] of Object.entries(exceptions)){
  validateDate(date);const normalized=normalizeDay(entry);
  // Validate submitted boundaries before merging adjacent windows, so a clock-
  // change ambiguity cannot disappear when two entries happen to touch.
  if(normalized.status==='available')for(const window of entry.windows)elapsedMinutes(date,window.start,window.end);
  for(const window of normalized.windows)elapsedMinutes(date,window.start,window.end);
  result.exceptions[date]=normalized;
 }
 return result;
}
export const validateAvailability=normalizeAvailability;

export function availabilityForDate(record,date){
 validateDate(date);
 const exception=object(record?.exceptions)&&own(record.exceptions,date);
 const weekday=new Date(date+'T12:00:00Z').getUTCDay();
 let entry;
 try{entry=normalizeDay(exception?record.exceptions[date]:record?.weekly?.[weekday]);}
 catch(error){
  if(error.status!==400)throw error;
  // One unreadable saved day is flagged for follow-up. It never counts as available.
  return {date,status:'needs-confirmation',source:exception?'exception':'weekly',windows:[],warning:'This saved day could not be read. Ask this person to set it again.'};
 }
 const result={date,status:entry.status,source:exception?'exception':'weekly',windows:[]};
 if(entry.status==='unknown'&&monthHasAvailability(record,date.slice(0,7)))return {...result,status:'unavailable',implicit:true};
 if(entry.status!=='available')return result;
 try{
  for(const window of entry.windows)elapsedMinutes(date,window.start,window.end);
  result.windows=mergeIntervals(entry.windows.map(window=>[timeMinute(window.start),timeMinute(window.end,true)])).map(([start,end])=>({start:timeText(start),end:timeText(end),minutes:elapsedMinutes(date,timeText(start),timeText(end))}));
 }catch(error){
  if(error.status!==400)throw error;
  return {...result,status:'needs-confirmation',windows:[],warning:'Check availability around the Eastern clock change.'};
 }
 return result;
}
function intersect(left,right){
 const result=[];let a=0,b=0;
 while(a<left.length&&b<right.length){
  const start=Math.max(left[a][0],right[b][0]),end=Math.min(left[a][1],right[b][1]);
  if(end>start)result.push([start,end]);
  if(left[a][1]<right[b][1])a++;else b++;
 }
 return result;
}
export function matchAvailability(people,{from,to,minMinutes=60}={}){
 requireThat(Array.isArray(people)&&people.length>0&&people.length<=MAX_PEOPLE,'Select between 1 and '+MAX_PEOPLE+' people for this scene.');
 requireThat(people.every(person=>object(person)&&typeof person.id==='string'&&person.id.length>0&&person.id.length<=100)&&new Set(people.map(person=>person.id)).size===people.length,'Select each person only once.');
 requireThat(Number.isInteger(minMinutes)&&minMinutes>=1&&minMinutes<=1440,'Choose a minimum shared window between 1 minute and 24 hours.');
 const days=listDates(from,to).map(date=>{
  const evaluated=people.map(person=>({person,day:availabilityForDate(person.availability,date)}));
  const rows=status=>evaluated.filter(row=>row.day.status===status).map(({person,day})=>({id:person.id,name:person.name||'Member',...(day.implicit?{implicit:true}:{})}));
  const missing=rows('unknown'),unavailable=rows('unavailable'),maybe=rows('maybe'),needsConfirmation=rows('needs-confirmation');
  let common=[];
  if(!missing.length&&!unavailable.length&&!maybe.length&&!needsConfirmation.length){
   for(const {day} of evaluated){const windows=day.windows.map(window=>[timeMinute(window.start),timeMinute(window.end,true)]);common=common.length?intersect(common,windows):windows;if(!common.length)break;}
  }
  const windows=common.map(([start,end])=>({start:timeText(start),end:timeText(end),minutes:elapsedMinutes(date,timeText(start),timeText(end))})).filter(window=>window.minutes>=minMinutes);
  return {date,windows,missing,unavailable,maybe,needsConfirmation,availableCount:evaluated.filter(row=>row.day.status==='available').length,selectedCount:people.length,status:windows.length?'all-available':missing.length||maybe.length||needsConfirmation.length?'missing-responses':'no-common-time'};
 });
 return {timezone:AVAILABILITY_TIMEZONE,from,to,minMinutes,days,matches:days.filter(day=>day.windows.length)};
}
