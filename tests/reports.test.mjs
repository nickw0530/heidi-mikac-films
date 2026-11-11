import assert from 'node:assert/strict';
import {test} from 'node:test';
import {emptyAvailability,availabilityForDate,normalizeAvailability,matchAvailability} from '../netlify/lib/availability.mjs';
import {groupReportPeople,runPeopleReport,personReportValue,normalizedReportConfig,reportCsv} from '../members/report-model.mjs';
import {rawAvailabilityDay} from '../members/availability-state.mjs';

const dark='written-in-the-dark',lies='wherein-lies-continue';
const row=(id,name,productionId,extra={})=>({id:'member/'+id,memberId:id,profileId:id,name,productionId,productionName:productionId===dark?'Written in the Dark':'Wherein Lies Continue',hasAccount:true,accountStatus:'Active',agreementStatus:'No agreement on file',documents:[{title:'Current agreement',status:'No agreement on file'}],bioProvided:true,headshotProvided:true,days:[],openTasks:[],actions:[],...extra});
const settings=extra=>({type:'roster',productions:[dark,lies],audience:'everyone',includeUnassigned:false,selectedPeople:[],status:'all',conditions:[],match:'all',...extra});
test('reports merge linked people without merging ambiguous names, preserve production details and sort by first name',()=>{
 const records=[row('n','Nick Williams',dark,{character:'Therapist',crewTitle:'Executive Producer'}),row('h','Heidi Mikac',dark),row('n','Nick Williams',lies,{character:'',crewTitle:'Producer'}),row('x','Same Name',dark),row('y','Same Name',lies)];
 const result=runPeopleReport([{rows:records}],settings());
 assert.deepEqual(result.people.map(person=>person.name),['Heidi Mikac','Nick Williams','Same Name','Same Name']);
 assert.equal(result.people[1].assignments.length,2);
 assert.equal(result.assignmentCount,5);
 assert.match(personReportValue(result.people[1],'crewTitle'),/Written in the Dark: Executive Producer/);
 assert.match(personReportValue(result.people[1],'crewTitle'),/Wherein Lies Continue: Producer/);
 const noAccount={...row('p','Avery Preview',dark),memberId:null,hasAccount:false,profileId:'shared'};
 assert.equal(groupReportPeople([noAccount,{...noAccount,productionId:lies}]).length,1);
 assert.equal(groupReportPeople([{...noAccount,profileId:null,id:'pending/a'},{...noAccount,profileId:null,id:'pending/b'}]).length,2);
});
test('population is explicit, selected people remain selected, and unassigned records are opt-in and deduplicated',()=>{
 const a=row('a','A',dark),b=row('b','B',dark,{hasAccount:false}),u=row('u','U',null);
 const data=[{rows:[a,b],unassigned:[u]},{rows:[],unassigned:[u]}];
 assert.deepEqual(runPeopleReport(data,settings({audience:'accounts'})).people.map(p=>p.name),['A']);
 assert.deepEqual(runPeopleReport(data,settings({audience:'no-account'})).people.map(p=>p.name),['B']);
 assert.deepEqual(runPeopleReport(data,settings({audience:'selected',selectedPeople:['member/b']})).people.map(p=>p.name),['B']);
 assert.deepEqual(runPeopleReport(data,settings({includeUnassigned:true})).people.map(p=>p.name),['A','B','U']);
});
test('availability reports count any answer within selected dates and do not use answers from another month',()=>{
 const record=emptyAvailability();record.exceptions['2026-12-05']={status:'available',windows:[{start:'00:00',end:'24:00'}]};
 const november=['2026-11-10','2026-11-11'].map(date=>availabilityForDate(record,date));
 const december=['2026-12-05','2026-12-06'].map(date=>availabilityForDate(record,date));
 assert.equal(november[0].status,'unknown');assert.equal(december[1].status,'unavailable');assert.equal(december[1].implicit,true);
 let result=runPeopleReport([{rows:[row('a','Alaine Example',dark,{days:november})]}],settings({type:'availability',status:'unanswered'}));assert.equal(result.total,1);
 result=runPeopleReport([{rows:[row('a','Alaine Example',dark,{days:december})]}],settings({type:'availability',status:'answered'}));assert.equal(result.total,1);
 const maybe=[{date:'2026-12-05',status:'maybe',windows:[]},{date:'2026-12-06',status:'unknown',windows:[]}];
 assert.equal(runPeopleReport([{rows:[row('b','B',dark,{days:maybe})]}],settings({type:'availability',status:'answered'})).total,1,'A single Maybe answer counts as answered.');
});
test('maybe and implicit blank days cannot produce confirmed filming windows; clearing the last answer restores an untouched month',()=>{
 const a=emptyAvailability(),b=emptyAvailability();
 a.exceptions['2026-12-05']={status:'available',windows:[{start:'00:00',end:'24:00'}]};
 b.exceptions['2026-12-05']={status:'maybe',windows:[]};
 const normalized=normalizeAvailability(b);assert.equal(normalized.exceptions['2026-12-05'].status,'maybe');
 let result=matchAvailability([{id:'a',availability:a},{id:'b',availability:b}],{from:'2026-12-05',to:'2026-12-06',minMinutes:120});
 assert.equal(result.matches.length,0);assert.equal(result.days[0].maybe.length,1);assert.equal(result.days[1].unavailable.length,2);
 assert.equal(rawAvailabilityDay(b,'2026-12-06').status,'unknown','The member calendar must leave inferred unavailable dates visually blank.');
 b.exceptions['2026-12-05']={status:'unknown',windows:[]};assert.equal(availabilityForDate(b,'2026-12-06').status,'unknown');
 b.weekly={0:{status:'maybe',windows:[]}};assert.equal(availabilityForDate(b,'2026-12-05').status,'unavailable','Legacy object-shaped weekly schedules use the same rule.');
});
test('custom conditions match within one production and both films stay visible in a matching person’s row',()=>{
 const first=row('a','A',dark,{bioProvided:false,agreementStatus:'Complete'}),second=row('a','A',lies,{bioProvided:true});
 const conditions=[{field:'bio',operator:'is',value:'Missing'},{field:'agreement',operator:'is',value:'No agreement on file'}];
 assert.equal(runPeopleReport([{rows:[first,second]}],settings({type:'custom',conditions})).total,0,'A condition from each film cannot create a false same-film match.');
 const result=runPeopleReport([{rows:[first,second]}],settings({type:'custom',conditions,match:'any'}));assert.equal(result.total,1);assert.equal(result.people[0].assignments.length,2);
 assert.equal(runPeopleReport([{rows:[first,second]}],settings({type:'custom',conditions:[{field:'tasks',operator:'notEmpty',value:''}]})).total,0,'The displayed word None is not an open task.');
 first.openTasks=['Send a headshot'];assert.equal(runPeopleReport([{rows:[first,second]}],settings({type:'custom',conditions:[{field:'tasks',operator:'notEmpty',value:''}]})).total,1);
});
test('saved settings exclude audience, dates, member selection, ownership and arbitrary fields; spreadsheets quote and neutralize formulas',()=>{
 const config=normalizedReportConfig({type:'roster',columns:['name','email'],owner:'Heidi',audience:'everyone',from:'2026-12-01',selectedPeople:['secret'],conditions:[],unknown:'private'});
 assert.deepEqual(Object.keys(config).sort(),['columns','conditions','match','minMinutes','search','status','type','weekendsFirst'].sort());
 assert.throws(()=>normalizedReportConfig({type:'roster',columns:['password']}));assert.throws(()=>normalizedReportConfig({type:'roster',columns:{}}));
 const csv=reportCsv(['Name','Note'],[['=IMPORTXML("x")','a,b\nsecond line'],['@command','"quoted"']]);
 assert.match(csv,/"'=IMPORTXML\(""x""\)"/);assert.match(csv,/"a,b\nsecond line"/);assert.match(csv,/"'@command"/);
});
