import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {enqueue,deliver,portalUrl} from '../netlify/lib/mail.mjs';

const calendarFile=new URL('../netlify/functions/calendar-callback.mjs',import.meta.url);
const source=(await readFile(calendarFile,'utf8'))
 .replace("import {getStore} from '@netlify/blobs';","const getStore=()=>{throw new Error('Unexpected real store access');};")
 .replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_match,_quote,path)=>'from '+JSON.stringify(new URL(path,calendarFile).href));
const {events,eventNotes,notifyNewEvents,calendarNoticeValidator}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const eventKey=id=>createHash('sha256').update(id).digest('base64url');
const firstFilm='written-in-the-dark',secondFilm='wherein-lies-continue';
const actor={id:'actor',email:'actor@example.test',productions:{[firstFilm]:{}}};
const other={id:'other',email:'other@example.test',productions:{[secondFilm]:{}}};

async function fixture(t,{notesEnabled=false}={}){
 let clock=Date.parse('2026-11-11T14:00:00Z'),version=0;
 const originalNow=Date.now;
 const originalFetch=globalThis.fetch;
 const mailKey=process.env.RESEND_API_KEY,mailFrom=process.env.HMF_MAIL_FROM;
 t.after(()=>{
  Date.now=originalNow;
  globalThis.fetch=originalFetch;
  if(mailKey===undefined)delete process.env.RESEND_API_KEY;else process.env.RESEND_API_KEY=mailKey;
  if(mailFrom===undefined)delete process.env.HMF_MAIL_FROM;else process.env.HMF_MAIL_FROM=mailFrom;
 });
 Date.now=()=>clock;
 process.env.RESEND_API_KEY='test';process.env.HMF_MAIL_FROM='test@example.test';
 const data=new Map(),calendar=new Map(),sent=[],graphRequests=[];
 const store={
  async get(key){return structuredClone(data.get(key)?.value)??null;},
  async getMetadata(key){return data.has(key)?{}:null;},
  async getWithMetadata(key){
   const record=data.get(key);
   return record?{data:structuredClone(record.value),etag:record.etag}:null;
  },
  async setJSON(key,value,{onlyIfNew=false,onlyIfMatch}={}){
   if(onlyIfNew&&data.has(key)||onlyIfMatch&&data.get(key)?.etag!==onlyIfMatch)return {modified:false};
   data.set(key,{value:structuredClone(value),etag:String(++version)});
   return {modified:true};
  },
  async set(...args){return this.setJSON(...args);},
  async list({prefix}){return {blobs:[...data.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key}))};},
  async delete(key){data.delete(key);}
 };
 globalThis.fetch=async(input,options)=>{
  const url=new URL(input);
  if(url.hostname==='login.microsoftonline.com')return Response.json({access_token:'mock'});
  if(url.hostname==='api.resend.com'){
   if(options.method==='POST'){
    sent.push(JSON.parse(options.body));
    return Response.json({id:'delivery-'+sent.length});
   }
   return Response.json({last_event:'delivered'});
  }
  assert.equal(url.hostname,'graph.microsoft.com');
  graphRequests.push({path:url.pathname,fields:url.searchParams.get('$select')?.split(',')||[],prefer:new Headers(options.headers).get('Prefer')});
  if(url.pathname==='/v1.0/me/calendarView')return Response.json({value:[...calendar.values()]});
  if(url.pathname==='/v1.0/me/calendar/events'){
   const filter=url.searchParams.get('$filter');
   const [,from,to]=filter.match(/^lastModifiedDateTime ge (.+) and lastModifiedDateTime lt (.+)$/);
   return Response.json({value:[...calendar.values()].filter(event=>event.type!=='exception'&&event.type!=='occurrence'&&event.lastModifiedDateTime>=from&&event.lastModifiedDateTime<to)});
  }
  const id=decodeURIComponent(url.pathname.split('/').at(-1));
  return calendar.has(id)?Response.json(calendar.get(id)):new Response(null,{status:404});
 };
 await store.setJSON('calendar/connection',{refresh:'mock',...(notesEnabled?{notesEnabled:true}:{})});
 await store.setJSON('calendar/notification-cursor',new Date(clock-300000).toISOString());
 await store.setJSON('members/'+actor.id,actor);
 await store.setJSON('members/'+other.id,other);
 const change=(updates={},id='shoot')=>{
  const event=calendar.get(id)||{
   id,createdDateTime:new Date(clock-120000).toISOString(),
   subject:'Mock filming day',start:{dateTime:'2026-11-14T15:00:00.000'},
   end:{dateTime:'2026-11-14T17:00:00.000'},isAllDay:false,
   sensitivity:'normal',categories:['Written in the Dark'],location:{displayName:'Studio A'}
  };
  calendar.set(id,{...event,...updates,lastModifiedDateTime:new Date(clock-120000).toISOString()});
 };
 const messages=()=>[...data.entries()].filter(([key])=>key.startsWith('outbox/')).map(([,record])=>record.value);
 return {store,calendar,sent,change,messages,graphRequests,advance:minutes=>{clock+=minutes*60000;},
  poll:()=>notifyNewEvents(store,enqueue,portalUrl),mail:()=>deliver(store,{currentCalendarEvent:calendarNoticeValidator(store)})};
}

test('upcoming events show the location and production only to eligible members',async t=>{
 const f=await fixture(t);
 f.change();
 f.change({sensitivity:'private',subject:'Private fixture',location:{displayName:'Private location'}},'private');
 const member=(await (await events(f.store,false,null,actor)).json()).items;
 assert.deepEqual(member,[{
  key:eventKey('shoot'),title:'Mock filming day',start:'2026-11-14T15:00:00.000',
  end:'2026-11-14T17:00:00.000',allDay:false,productions:[firstFilm],location:'Studio A'
 }]);
 assert.deepEqual((await (await events(f.store,false,null,other)).json()).items,[]);
 const admin=(await (await events(f.store,true,null)).json()).items;
 assert.equal(admin.find(event=>event.key===eventKey('private')).location,'');
});

test('a new event email includes the event name, Eastern time and portal link for eligible members',async t=>{
 const f=await fixture(t,{notesEnabled:true});
 await f.store.setJSON('members/revoked',{...actor,id:'revoked',email:'revoked@example.test',revoked:true});
 await f.store.setJSON('members/no-address',{...actor,id:'no-address',email:''});
 f.change({body:{contentType:'text',content:'Fictional notes available in the portal only.'}});
 await f.poll();
 assert.deepEqual(f.messages().map(message=>message.to),[actor.email]);
 await f.mail();
 assert.equal(f.sent.length,1);
 const [email]=f.sent;
 assert.deepEqual(email.to,[actor.email]);
 assert.match(email.subject,/new event/i);
 assert.match(email.text,/Mock filming day/);
 assert.match(email.text,/Nov(?:ember)?\.? 14/i);
 assert.match(email.text,/10(?::00)?\s*AM/i);
 assert.match(email.text,/\b(?:ET|EST|Eastern)\b/i);
 assert.ok(email.text.includes(portalUrl+'?event='+eventKey('shoot')));
 assert.doesNotMatch(email.text,/Fictional notes available in the portal only/);
});

test('title, notes and time edits each send one scoped update and cancellation remains scoped',async t=>{
 const f=await fixture(t,{notesEnabled:true});
 f.change();
 await f.poll();
 await f.mail();
 f.advance(5);
 f.change({subject:'Renamed fixture'});
 await f.poll();
 assert.deepEqual(f.messages().map(message=>message.subject),['Production calendar event updated']);
 await f.mail();
 assert.equal(f.sent.length,2);
 assert.match(f.sent[1].text,/Renamed fixture/);
 f.advance(5);
 f.change({body:{contentType:'text',content:'Revised fictional notes.'}});
 await f.poll();
 assert.deepEqual(f.messages().map(message=>message.subject),['Production calendar event updated']);
 await f.mail();
 assert.equal(f.sent.length,3);
 assert.doesNotMatch(f.sent[2].text,/Revised fictional notes/);
 f.advance(5);
 f.change({start:{dateTime:'2026-11-14T16:00:00.000'},end:{dateTime:'2026-11-14T18:00:00.000'}});
 await f.poll();
 assert.deepEqual(f.messages().map(message=>message.subject),['Production calendar event updated']);
 await f.mail();
 assert.equal(f.sent.length,4);
 assert.match(f.sent[3].text,/11(?::00)?\s*AM/i);
 await f.store.setJSON('calendar/notification-cursor','2026-11-11T14:10:00.000Z');
 await f.poll();
 assert.equal(f.messages().length,0,'Processing the same revision again does not queue a second notice.');
 const id=eventKey('shoot');
 await events(f.store,false,null,actor);
 f.advance(1);
 f.change({isCancelled:true});
 const cancelled=await (await events(f.store,false,id,actor)).json();
 assert.deepEqual(cancelled.selected,{key:id,cancelled:true});
 assert.deepEqual(cancelled.items,[],'The cancelled event cannot reappear from the upcoming cache.');
 assert.equal((await (await events(f.store,false,id,other)).json()).selected,null);
 assert.deepEqual((await (await events(f.store,true,id)).json()).selected,{key:id,cancelled:true});
 f.advance(5);
 await f.poll();
 assert.deepEqual(f.messages().map(message=>message.subject),['Production calendar event cancelled']);
 await f.mail();
 assert.equal(f.sent.length,5);
 assert.ok(f.sent.every(message=>message.to.length===1&&message.to[0]===actor.email));
 assert.equal(f.sent[4].text.includes('Studio A'),false);
 await f.store.setJSON('calendar/notification-cursor','2026-11-11T14:10:00.000Z');
 await f.poll();
 assert.equal(f.messages().length,0);
});

test('an edited event predating the first scan can send an update without a prior new-event email',async t=>{
 const f=await fixture(t);
 f.change({createdDateTime:'2026-11-01T16:00:00Z'});
 await f.poll();
 assert.deepEqual(f.messages().map(message=>[message.to,message.subject]),[
  [actor.email,'Production calendar event updated']
 ]);
});

test('a changed occurrence gets an update without announcing ordinary occurrences again',async t=>{
 const f=await fixture(t);
 f.change({type:'occurrence'},'regular-shoot');
 f.change({type:'exception',subject:'One rehearsal moved'},'changed-shoot');
 await f.poll();
 assert.deepEqual(f.messages().map(message=>message.subject),['Production calendar event updated']);
 await f.mail();
 assert.match(f.sent[0].text,/One rehearsal moved/);
});

test('an event moved to the other production sends only to its new audience',async t=>{
 const f=await fixture(t);
 f.change();
 await f.poll();
 await f.mail();
 f.advance(5);
 f.change({categories:['Wherein Lies Continue']});
 await f.poll();
 assert.deepEqual(f.messages().map(message=>message.to),[other.email]);
 await f.mail();
 assert.deepEqual(f.sent.map(message=>message.to),[[actor.email],[other.email]]);
});

test('making an event private after queuing it prevents its summary from being sent',async t=>{
 const f=await fixture(t);
 f.change();
 await f.poll();
 assert.equal(f.messages().length,1);
 f.advance(1);
 f.change({sensitivity:'private'});
 await f.mail();
 assert.equal(f.sent.length,0);
 assert.equal(f.messages().length,0);
});

test('dual categories reach both casts once while private and uncategorized events send nothing',async t=>{
 const f=await fixture(t);
 const both={id:'both',email:'both@example.test',productions:{[firstFilm]:{},[secondFilm]:{}}};
 await f.store.setJSON('members/'+both.id,both);
 f.change({categories:['Written in the Dark','Wherein Lies Continue']});
 f.change({sensitivity:'private'},'private');
 f.change({categories:[]},'uncategorized');
 await f.poll();
 assert.deepEqual(f.messages().map(message=>message.to).sort(),[actor.email,both.email,other.email].sort());
 assert.ok(f.messages().every(message=>message.text.includes(portalUrl+'?event='+eventKey('shoot'))));
});

test('a hard-deleted upcoming event is verified before its cancellation notice is queued',async t=>{
 const f=await fixture(t);
 f.change();
 await f.poll();
 await f.mail();
 f.calendar.delete('shoot');
 f.advance(15);
 await f.poll();
 assert.deepEqual(f.messages().map(message=>message.subject),['Production calendar event cancelled']);
 const result=await (await events(f.store,false,eventKey('shoot'),actor)).json();
 assert.deepEqual(result.selected,{key:eventKey('shoot'),cancelled:true});
 assert.equal(result.items.length,0);
});

test('an existing basic Outlook connection keeps events available and skips note retrieval',async t=>{
 const f=await fixture(t);
 f.change({body:{contentType:'text',content:'Example event instructions'}});
 const listing=await (await events(f.store,true,null)).json();
 assert.equal(listing.connected,true);
 assert.equal(listing.notesEnabled,false);
 assert.equal(listing.items.length,1);
 assert.deepEqual(await (await eventNotes(f.store,true,eventKey('shoot'))).json(),{notes:'',truncated:false});
 assert.equal(f.graphRequests.some(request=>request.fields.includes('body')||request.fields.includes('bodyPreview')),false);
});

test('event descriptions load only when requested and stay out of member and admin event lists',async t=>{
 const f=await fixture(t,{notesEnabled:true});
 const description='Park at Studio A.\nBring the revised script and water.';
 const id='fictional-outlook-identifier';
 f.change({body:{contentType:'text',content:description}},id);
 await f.store.setJSON('calendar/event-links/'+eventKey(id),id);
 for(const admin of [false,true]){
  const response=await events(f.store,admin,eventKey(id),actor);
  const json=await response.json();
  assert.equal(json.notesEnabled,true);
  assert.equal(json.selected.key,eventKey(id));
  assert.doesNotMatch(JSON.stringify(json),/fictional-outlook-identifier|Park at Studio A|bodyPreview|"notes"/);
 }
 assert.equal(f.graphRequests.some(request=>request.fields.includes('body')||request.fields.includes('bodyPreview')),false);
 const response=await eventNotes(f.store,false,eventKey(id),actor);
 assert.deepEqual(await response.json(),{notes:description,truncated:false});
 assert.match(response.headers.get('Cache-Control'),/no-store/);
 const request=f.graphRequests.at(-1);
 assert.ok(request.fields.includes('body'));
 assert.match(request.prefer,/outlook\.body-content-type="text"/);
 assert.doesNotMatch(JSON.stringify(await f.store.get('calendar/connection')),/Park at Studio A/,'Notes are not cached in the connection record.');

 // An email can link to an event that is outside the currently cached list.
 const linkedId='older-linked-event';
 f.change({start:{dateTime:'2026-11-10T15:00:00.000'},end:{dateTime:'2026-11-10T17:00:00.000'},body:{contentType:'text',content:description}},linkedId);
 await f.store.setJSON('calendar/event-links/'+eventKey(linkedId),linkedId);
 await f.store.setJSON('calendar/audiences/'+eventKey(linkedId),[firstFilm]);
 assert.equal((await (await eventNotes(f.store,false,eventKey(linkedId),actor)).json()).notes,description);
 assert.deepEqual(await (await eventNotes(f.store,false,eventKey(linkedId),other)).json(),{notes:'',truncated:false});
});

test('notes apply the current production, privacy and cancellation checks to cached and linked events',async t=>{
 const f=await fixture(t,{notesEnabled:true});
 const body={contentType:'text',content:'Only this production should read these instructions.'};
 f.change({body});
 f.change({body,categories:[]},'uncategorized');
 f.change({body,sensitivity:'private'},'private');
 f.change({body,isCancelled:true},'cancelled');
 await events(f.store,true,null);
 for(const id of ['shoot','uncategorized','private','cancelled']){
  await f.store.setJSON('calendar/event-links/'+eventKey(id),id);
  await f.store.setJSON('calendar/audiences/'+eventKey(id),[firstFilm]);
 }
 const denied={notes:'',truncated:false};
 assert.deepEqual(await (await eventNotes(f.store,false,eventKey('shoot'),other)).json(),denied);
 assert.deepEqual(await (await eventNotes(f.store,false,eventKey('shoot'),{...actor,revoked:true})).json(),denied);
 for(const id of ['uncategorized','private','cancelled','unknown']){
  for(const admin of [false,true])assert.deepEqual(await (await eventNotes(f.store,admin,eventKey(id),actor)).json(),denied,id);
 }
 assert.equal((await (await eventNotes(f.store,false,eventKey('shoot'),actor)).json()).notes,body.content);
 f.change({categories:['Wherein Lies Continue']});
 assert.deepEqual(await (await eventNotes(f.store,false,eventKey('shoot'),actor)).json(),denied,'An old cache or email link must not preserve access after recategorization.');
 f.change({categories:['Written in the Dark'],sensitivity:'private'});
 assert.deepEqual(await (await eventNotes(f.store,false,eventKey('shoot'),actor)).json(),denied,'A cached event that was made private must not expose its notes.');
 f.change({sensitivity:'normal',isCancelled:true});
 assert.deepEqual(await (await eventNotes(f.store,false,eventKey('shoot'),actor)).json(),denied,'Cancelling an event immediately hides its notes.');
 f.calendar.delete('shoot');
 assert.deepEqual(await (await eventNotes(f.store,false,eventKey('shoot'),actor)).json(),denied);
});

test('Outlook HTML becomes plain notes and very long descriptions are capped by Unicode character',async t=>{
 const f=await fixture(t,{notesEnabled:true});
 f.change({body:{contentType:'html',content:'<html><head><style>.hidden { color: red }</style></head><body><p>Meet &amp; check in.</p><p>Bring &#x1f4d6; scripts.<br>Use Gate A.</p><script>secretScript()</script><img src="https://example.test/tracker"></body></html>'}});
 await events(f.store,false,null,actor);
 const key=eventKey('shoot');
 const html=await (await eventNotes(f.store,false,key,actor)).json();
 assert.match(html.notes,/^Meet & check in\.\n+Bring 📖 scripts\.\n+Use Gate A\.$/);
 assert.equal(html.truncated,false);
 f.change({body:{contentType:'text',content:'🎬'.repeat(12001)}});
 const long=await (await eventNotes(f.store,false,key,actor)).json();
 assert.equal(long.notes,'🎬'.repeat(12000));
 assert.equal(long.truncated,true);
});
