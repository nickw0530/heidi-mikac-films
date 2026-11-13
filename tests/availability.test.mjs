import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AVAILABILITY_TIME_ZONE,emptyAvailability,normalizeAvailability,availabilityForDate,matchAvailability} from '../netlify/lib/availability.mjs';

const available=(...windows)=>({status:'available',windows:windows.map(([start,end])=>({start,end}))});
const unavailable=()=>({status:'unavailable',windows:[]});
function monday(...windows){const record=emptyAvailability();record.weekly[1]=available(...windows);return normalizeAvailability(record);}
const ranges=day=>day.windows.map(({start,end})=>[start,end]);

test('a weekly pattern applies only when no date-specific change replaces it',()=>{
 const record=monday(['09:00','17:00']);
 assert.equal(record.timezone,AVAILABILITY_TIME_ZONE);
 assert.deepEqual(ranges(availabilityForDate(record,'2027-01-04')),[['09:00','17:00']]);
 assert.equal(availabilityForDate(record,'2027-01-05').status,'unavailable','Blank dates in a started month count as unavailable.');
 assert.equal(availabilityForDate(record,'2027-01-05').implicit,true);
 record.exceptions['2027-01-04']=unavailable();
 assert.equal(availabilityForDate(normalizeAvailability(record),'2027-01-04').status,'unavailable');
 record.exceptions['2027-01-04']=available(['11:15','15:45']);
 assert.deepEqual(ranges(availabilityForDate(normalizeAvailability(record),'2027-01-04')),[['11:15','15:45']]);
 delete record.exceptions['2027-01-04'];
 assert.deepEqual(ranges(availabilityForDate(normalizeAvailability(record),'2027-01-04')),[['09:00','17:00']],'Removing a change restores the usual week.');
});

test('shared availability intersects every window without inventing availability during breaks',()=>{
 const people=[{id:'a',name:'Actor A',availability:monday(['09:00','12:00'],['13:00','17:00'])},{id:'b',name:'Actor B',availability:monday(['10:00','14:00'])}];
 let result=matchAvailability(people,{from:'2027-01-04',to:'2027-01-04',minMinutes:1});
 assert.deepEqual(ranges(result.matches[0]),[['10:00','12:00'],['13:00','14:00']]);
 assert.deepEqual(result.matches[0].windows.map(window=>window.minutes),[120,60]);
 result=matchAvailability(people,{from:'2027-01-04',to:'2027-01-04',minMinutes:90});
 assert.deepEqual(ranges(result.matches[0]),[['10:00','12:00']],'Minimum shoot duration applies to each continuous shared window.');
 result=matchAvailability(people,{from:'2027-01-04',to:'2027-01-04',minMinutes:121});
 assert.equal(result.matches.length,0,'Separate windows cannot be added together across a break.');
 const touching=matchAvailability([{id:'a',name:'A',availability:monday(['08:00','10:00'])},{id:'b',name:'B',availability:monday(['10:00','12:00'])}],{from:'2027-01-04',to:'2027-01-04',minMinutes:1});
 assert.equal(touching.matches.length,0,'Touching endpoints offer zero filming time.');
});

test('missing answers and explicit unavailability never produce a shared green window',()=>{
 const ready={id:'a',name:'Ready Actor',availability:monday(['09:00','17:00'])};
 let result=matchAvailability([ready,{id:'b',name:'No Answer',availability:null}],{from:'2027-01-04',to:'2027-01-04',minMinutes:30});
 assert.equal(result.matches.length,0);assert.deepEqual(result.days[0].missing.map(person=>person.id),['b']);
 assert.equal(result.days[0].unavailable.length,0);
 const no=emptyAvailability();no.weekly[1]=unavailable();
 result=matchAvailability([ready,{id:'b',name:'Unavailable Actor',availability:normalizeAvailability(no)}],{from:'2027-01-04',to:'2027-01-04',minMinutes:30});
 assert.equal(result.matches.length,0);assert.deepEqual(result.days[0].unavailable.map(person=>person.id),['b']);assert.equal(result.days[0].missing.length,0);
});

test('times, dates, range bounds and required availability states are validated',()=>{
 for(const entry of [{status:'available',windows:[]},available(['17:00','09:00']),available(['12:00','12:00']),available(['24:00','24:00']),available(['09:61','12:00']),{status:'possibly',windows:[]},{status:'unavailable',windows:[{start:'09:00',end:'10:00'}]}]){
  const record=emptyAvailability();record.weekly[1]=entry;assert.throws(()=>normalizeAvailability(record));
 }
 let record=monday(['00:00','24:00']);
 assert.deepEqual(ranges(availabilityForDate(record,'2027-01-04')),[['00:00','24:00']]);
 record=emptyAvailability();record.exceptions['2027-02-30']=unavailable();assert.throws(()=>normalizeAvailability(record));
 assert.throws(()=>normalizeAvailability({...emptyAvailability(),timezone:'America/Los_Angeles'}));
 assert.throws(()=>availabilityForDate(emptyAvailability(),'2027-02-30'));
 const people=[{id:'a',name:'A',availability:monday(['09:00','17:00'])}];
 for(const range of [{from:'2027-01-05',to:'2027-01-04',minMinutes:1},{from:'2027-01-01',to:'2027-04-05',minMinutes:1},{from:'2027-01-04',to:'2027-01-04',minMinutes:0},{from:'2027-01-04',to:'2027-01-04',minMinutes:1441}])assert.throws(()=>matchAvailability(people,range));
 assert.throws(()=>matchAvailability([],{from:'2027-01-04',to:'2027-01-04',minMinutes:1}));
});

test('clock changes cannot silently alter an actor’s exact on-set time',()=>{
 const ambiguousBreak=emptyAvailability();ambiguousBreak.exceptions['2026-11-01']=available(['00:30','01:30'],['01:30','03:30']);
 assert.throws(()=>normalizeAvailability(ambiguousBreak),'Merging adjacent windows must not hide an ambiguous clock-change boundary.');
 const weeklyBreak=emptyAvailability();weeklyBreak.weekly[0]=available(['00:30','01:30'],['01:30','03:30']);
 const normalizedBreak=normalizeAvailability(weeklyBreak);
 assert.equal(availabilityForDate(normalizedBreak,'2026-11-01').status,'needs-confirmation','A weekly pattern cannot merge away a repeated time boundary.');
 assert.deepEqual(ranges(availabilityForDate(normalizedBreak,'2026-11-08')),[['00:30','03:30']],'Adjacent windows remain continuous on an ordinary date.');
 assert.equal(availabilityForDate(normalizedBreak,'2026-11-08').windows[0].minutes,180);
 for(const [date,start,end] of [['2027-03-14','02:30','04:00'],['2027-11-07','01:30','03:00']]){
  const exception=emptyAvailability();exception.exceptions[date]=available([start,end]);
  assert.throws(()=>normalizeAvailability(exception),'A nonexistent or repeated exact date boundary must be corrected.');
  const weekly=emptyAvailability();weekly.weekly[0]=available([start,end]);
  const day=availabilityForDate(normalizeAvailability(weekly),date);
  assert.equal(day.status,'needs-confirmation');assert.deepEqual(day.windows,[]);
  const match=matchAvailability([{id:'a',name:'Clock Change Actor',availability:normalizeAvailability(weekly)}],{from:date,to:date,minMinutes:1});
  assert.equal(match.matches.length,0);assert.equal(match.days[0].needsConfirmation.length,1);
 }
 const record=emptyAvailability();record.weekly[0]=available(['00:30','03:30']);
 assert.equal(availabilityForDate(normalizeAvailability(record),'2027-03-14').windows[0].minutes,120,'Spring-forward duration uses actual elapsed time.');
 assert.equal(availabilityForDate(normalizeAvailability(record),'2026-11-01').windows[0].minutes,240,'Fall-back duration uses actual elapsed time.');
 const result=matchAvailability([{id:'a',name:'A',availability:normalizeAvailability(record)}],{from:'2027-03-14',to:'2027-03-14',minMinutes:150});
 assert.equal(result.matches.length,0,'A two-hour spring-forward window cannot meet a two-and-a-half-hour shoot.');
});

test('an unreadable saved day is flagged for follow-up and never counts as available',()=>{
 const good={weekly:[],exceptions:{'2026-11-16':{status:'available',windows:[{start:'09:00',end:'17:00'}]}}};
 const broken={weekly:[],exceptions:{'2026-11-16':{status:'yes please',windows:[]}}};
 const day=availabilityForDate(broken,'2026-11-16');
 assert.equal(day.status,'needs-confirmation');
 assert.match(day.warning,/could not be read/);
 const result=matchAvailability([{id:'a',name:'Ava',availability:good},{id:'b',name:'Luis',availability:broken}],{from:'2026-11-16',to:'2026-11-16'});
 assert.equal(result.matches.length,0,'One unreadable record does not break the search or create a shared window.');
 assert.deepEqual(result.days[0].needsConfirmation,[{id:'b',name:'Luis'}]);
});

test('shoot-date results say when “unavailable” is a day the person left blank',()=>{
 const answered={weekly:[],exceptions:{'2026-11-16':{status:'unavailable',windows:[]},'2026-11-17':{status:'available',windows:[{start:'09:00',end:'17:00'}]}}};
 const partial={weekly:[],exceptions:{'2026-11-17':{status:'available',windows:[{start:'09:00',end:'17:00'}]}}};
 const result=matchAvailability([{id:'a',name:'Ava',availability:answered},{id:'b',name:'Luis',availability:partial}],{from:'2026-11-16',to:'2026-11-16'});
 assert.deepEqual(result.days[0].unavailable,[{id:'a',name:'Ava'},{id:'b',name:'Luis',implicit:true}]);
 assert.equal(result.matches.length,0);
});

test('a person can keep several years of date-by-date answers',()=>{
 const exceptions={};
 for(let index=0;index<800;index++)exceptions[new Date(Date.UTC(2026,0,1)+index*86400000).toISOString().slice(0,10)]={status:'unavailable',windows:[]};
 assert.equal(Object.keys(normalizeAvailability({weekly:[],exceptions}).exceptions).length,800);
 for(let index=800;index<1101;index++)exceptions[new Date(Date.UTC(2026,0,1)+index*86400000).toISOString().slice(0,10)]={status:'unavailable',windows:[]};
 assert.throws(()=>normalizeAvailability({weekly:[],exceptions}),/1100 dates or fewer/);
});
