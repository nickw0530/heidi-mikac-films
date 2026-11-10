import assert from 'node:assert/strict';
import {test} from 'node:test';
import {emptyAvailability,matchAvailability} from '../netlify/lib/availability.mjs';
import {monthRange,filmingDayState,filmingSuggestions,peopleForFilmingDay} from '../members/filming-calendar.mjs';

test('green calendar days require a continuous two-hour overlap for every selected person',()=>{
 const a=emptyAvailability(),b=emptyAvailability();
 a.weekly[5]={status:'available',windows:[{start:'00:00',end:'04:00'}]};
 b.weekly[5]={status:'available',windows:[{start:'02:00',end:'04:00'}]};
 const people=[{id:'a',name:'A',availability:a},{id:'b',name:'B',availability:b}];
 let result=matchAvailability(people,{from:'2026-11-13',to:'2026-11-13',minMinutes:120});
 assert.equal(filmingDayState(result.days[0]),'free','No arbitrary Friday evening cutoff may exclude the supplied hours.');
 b.weekly[5].windows[0].end='03:59';
 result=matchAvailability(people,{from:'2026-11-13',to:'2026-11-13',minMinutes:120});
 assert.equal(filmingDayState(result.days[0]),'no');
 b.weekly[5]={status:'unknown',windows:[]};
 result=matchAvailability(people,{from:'2026-11-13',to:'2026-11-13',minMinutes:120});
 assert.equal(filmingDayState(result.days[0]),'waiting');
 assert.notEqual(filmingDayState({...result.days[0],windows:[{start:'02:00',end:'04:00',minutes:120}]}),'free','An incomplete response cannot produce a false green day.');
});
test('suggestions prioritize upcoming Friday-Sunday dates without time-of-day limits',()=>{
 const free=date=>({date,windows:[{start:'01:00',end:'04:00',minutes:180}],selectedCount:2,availableCount:2,missing:[],unavailable:[],needsConfirmation:[]});
 const days=['2026-11-09','2026-11-10','2026-11-13','2026-11-14','2026-11-15','2026-11-16'].map(free);
 assert.deepEqual(filmingSuggestions({days},{today:'2026-11-10'}).map(d=>d.date),['2026-11-13','2026-11-14','2026-11-15']);
 assert.deepEqual(filmingSuggestions({days},{today:'2026-11-10',includeWeekdays:true,limit:5}).map(d=>d.date),['2026-11-13','2026-11-14','2026-11-15','2026-11-10','2026-11-16']);
 assert.deepEqual(filmingSuggestions({days},{today:'2026-11-16'}),[]);
 assert.equal(days[0].date,'2026-11-09','Suggestion ranking must not rearrange the calendar.');
});
test('selected-day radio filters show only required people and keep missing or ambiguous hours separate',()=>{
 const date='2026-11-13';
 const person=(id,status)=>({id,name:id,days:[{date,status,windows:[]}]});
 const members=[person('A','available'),person('B','unavailable'),person('C','unknown'),person('D','needs-confirmation'),person('Outside selection','available')];
 const selected=['A','B','C','D'];
 assert.deepEqual(peopleForFilmingDay(members,selected,date).map(row=>row.member.id),['A']);
 assert.deepEqual(peopleForFilmingDay(members,selected,date,'unavailable').map(row=>row.member.id),['B']);
 assert.deepEqual(peopleForFilmingDay(members,selected,date,'unknown').map(row=>row.member.id),['C','D']);
 assert.deepEqual(peopleForFilmingDay(members,[],date),[]);
 assert.deepEqual(monthRange('2028-02'),{from:'2028-02-01',to:'2028-02-29'});
});
