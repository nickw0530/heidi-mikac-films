import assert from 'node:assert/strict';
import {test} from 'node:test';
import {adminActions,notifyAdmins} from '../netlify/lib/admin-actions.mjs';
import {deliver,emailHtml,enqueue,TRACKING_KEY} from '../netlify/lib/mail.mjs';
import {AGREEMENT_CYCLE,currentAgreementKey} from '../netlify/lib/agreement-cycle.mjs';
import {manualAgreementKey} from '../netlify/lib/paperwork.mjs';

// Isolated storage and a mocked provider: nothing here sends email.
function fixture(){
 const data=new Map();let revision=0;
 const store={data,
  async get(k){return data.get(k)?.value??null;},
  async getMetadata(k){const r=data.get(k);return r?{etag:r.etag,metadata:{}}:null;},
  async getWithMetadata(k){const r=data.get(k);return r?{data:structuredClone(r.value),etag:r.etag}:null;},
  async setJSON(k,v,options={}){const old=data.get(k);if(options.onlyIfNew&&old||options.onlyIfMatch&&old?.etag!==options.onlyIfMatch)return {modified:false};data.set(k,{value:structuredClone(v),etag:String(++revision)});return {modified:true};},
  async delete(k){data.delete(k);},
  async list({prefix}){return {blobs:[...data.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))};}
 };
 return store;
}
const outbox=store=>[...store.data].filter(([key])=>key.startsWith('outbox/')).map(([,record])=>record.value);
const action=(label,key,extra={})=>({owner:'any',label,key,view:'people',member:null,signature:false,...extra});
const groups=(dark,lies=[])=>[{production:'written-in-the-dark',name:'Written in the Dark',actions:dark},{production:'wherein-lies-continue',name:'Wherein Lies Continue',actions:lies}];
const hour=3600000;

test('the signing sweep refreshes the oldest agreements in bounded batches',async()=>{
 const store=fixture(),production='written-in-the-dark';
 for(let i=0;i<7;i++){
  const id='actor-'+i;
  await store.setJSON('members/'+id,{id,name:'Actor '+i,email:id+'@example.invalid',productions:{[production]:{role:'Actor'}}});
  await store.setJSON(currentAgreementKey(production,id),{
   id:'doc-'+i,status:i===0?'Complete':'Waiting on actor',checkedAt:Date.now()-hour+i*1000,
  });
 }
 process.env.SIGNWELL_API_KEY='mock-signing-key';
 const originalFetch=globalThis.fetch,requests=[];
 let active=0,maxActive=0;
 globalThis.fetch=async input=>{
  requests.push(String(input).split('/').filter(Boolean).at(-1));
  maxActive=Math.max(maxActive,++active);
  await Promise.resolve();
  active--;
  return Response.json({status:'sent',recipients:[{id:'1',status:'signed'},{id:'2',status:'sent'}]});
 };
 try{
  const actions=await adminActions(store,production,{refresh:true});
  assert.deepEqual(requests,['doc-1','doc-2','doc-3','doc-4']);
  assert.equal(maxActive,2);
  assert.deepEqual(actions.filter(action=>action.signature).map(action=>action.member),['actor-1','actor-2','actor-3','actor-4']);
  await adminActions(store,production,{refresh:true});
  assert.deepEqual(requests.slice(4),['doc-5','doc-6'],'Unprocessed agreements are checked first on the next sweep.');
 }finally{
  globalThis.fetch=originalFetch;
  delete process.env.SIGNWELL_API_KEY;
 }
});

test('new items arrive as one email per administrator, about once a day',async()=>{
 const store=fixture(),start=Date.UTC(2026,10,10,15);
 const first=[action('Prepare a new agreement for Ada','k/ada'),action('Prepare a new agreement for Ben','k/ben')],other=[action('Add email and invite Cy','k/cy')];
 await notifyAdmins(store,groups(first,other),start);
 let mail=outbox(store);
 assert.equal(mail.length,2,'One digest each, not one email per item.');
 assert.deepEqual(mail.map(m=>m.to).sort(),['heidi@heidimikacfilms.com','nick@heidimikacfilms.com']);
 const nick=mail.find(m=>m.id==='Nick');
 assert.equal(nick.subject,'Waiting on you · 3 new items · Heidi Mikac Films');
 for(const expected of ['Written in the Dark\n• Prepare a new agreement for Ada\n• Prepare a new agreement for Ben','Wherein Lies Continue\n• Add email and invite Cy'])assert.ok(nick.text.includes(expected),nick.text);
 assert.ok(emailHtml(nick).includes('>Open your dashboard</a>'));

 await notifyAdmins(store,groups(first,other),start+5*60000);
 assert.equal(outbox(store).length,2,'Items already reported are never repeated.');
 const later=[...first,action('Prepare a new agreement for Dee','k/dee')];
 await notifyAdmins(store,groups(later,other),start+2*hour);
 assert.equal(outbox(store).length,2,'A new routine item waits for the next daily digest.');
 await notifyAdmins(store,groups(later,other),start+21*hour);
 mail=outbox(store);assert.equal(mail.length,4);
 const next=mail.filter(m=>m.id==='Nick').find(m=>m.subject.includes('1 new item'));
 assert.ok(next.text.startsWith('1 new item waiting on you, 4 open in total.')&&next.text.includes('• Prepare a new agreement for Dee')&&!next.text.includes('Ada'),next.text);
});

test('a task assigned by name goes out at once and only to that administrator',async()=>{
 const store=fixture(),start=Date.UTC(2026,10,10,15);
 await notifyAdmins(store,groups([action('Prepare a new agreement for Ada','k/ada')]),start);
 const task=action('Call the location owner','tasks/Nick/1',{owner:'Nick',taskId:'1',view:'overview'});
 await notifyAdmins(store,groups([action('Prepare a new agreement for Ada','k/ada'),action('Prepare a new agreement for Eve','k/eve'),task]),start+hour);
 const mail=outbox(store);
 assert.equal(mail.filter(m=>m.id==='Nick').length,2);assert.equal(mail.filter(m=>m.id==='Heidi').length,1,'Heidi’s routine item still waits.');
 const sent=mail.filter(m=>m.id==='Nick')[1];
 assert.ok(sent.text.includes('Call the location owner')&&sent.text.includes('Eve'),'An immediate digest carries everything new.');
});

test('Heidi’s countersignature keeps its own immediate notice to the signing inbox',async()=>{
 const store=fixture(),start=Date.UTC(2026,10,10,15);
 const sign=action('Open for Heidi’s signature · Ada','k/ada/countersign/doc',{owner:'any',signature:true,member:'m1'});
 await notifyAdmins(store,groups([{...sign,suppressNotice:true}]),start);
 assert.equal(outbox(store).length,0);
 await notifyAdmins(store,groups([sign]),start);await notifyAdmins(store,groups([sign]),start+hour);
 const mail=outbox(store);
 assert.equal(mail.length,1);assert.equal(mail[0].to,'hello@heidimikacfilms.com');assert.equal(mail[0].id,'Heidi');
 assert.ok(mail[0].text.startsWith('Open for Heidi’s signature · Ada'));
});

test('bound admin profiles have no personal actions, while same-name members and admin work retain theirs',async()=>{
 const store=fixture(),production='written-in-the-dark';
 const nick='00000000-0000-4000-8000-000000000071',heidi='00000000-0000-4000-8000-000000000072';
 await store.setJSON('settings/admin-profiles',{Nick:nick,Heidi:heidi});
 for(const [id,name,email] of [[nick,'Nick Williams','nick@example.invalid'],[heidi,'Heidi Mikac',''],['other','Nick Williams','other@example.invalid']]){
  await store.setJSON('members/'+id,{id,name,email,productions:{[production]:{}},productionRequests:{[production]:'request-'+id}});
 }
 await store.setJSON(currentAgreementKey(production,nick),{id:'old-owner-doc',status:'Waiting on Heidi'});
 await store.setJSON('tasks/Heidi/admin-task',{id:'admin-task',title:'Review the production calendar'});
 const actions=await adminActions(store,production);
 assert.deepEqual(actions.map(item=>item.member),['other','other',null]);
 assert.equal(actions.at(-1).label,'Review the production calendar');
 assert.equal(actions.at(-1).owner,'Heidi');
});

test('queued personal requirements for bound admins are skipped without suppressing production notices',async t=>{
 const store=fixture(),production='written-in-the-dark';
 const nick='00000000-0000-4000-8000-000000000073',heidi='00000000-0000-4000-8000-000000000074';
 const member={id:nick,email:'nick@example.invalid'};
 await store.setJSON('settings/admin-profiles',{Nick:nick,Heidi:heidi});
 await store.setJSON('members/'+nick,member);
 await enqueue(store,member,'owner-task','New production task','Personal task');
 await enqueue(store,{id:'Heidi',email:'signing@example.invalid'},'owner-countersign','Agreement ready for your signature','Personal contract',0,{agreementCycle:AGREEMENT_CYCLE,requirementKey:manualAgreementKey(production,nick)});
 await enqueue(store,member,'production-update','New production message','General production news');
 const fetch=globalThis.fetch,key=process.env.RESEND_API_KEY,from=process.env.HMF_MAIL_FROM;
 t.after(()=>{globalThis.fetch=fetch;if(key===undefined)delete process.env.RESEND_API_KEY;else process.env.RESEND_API_KEY=key;if(from===undefined)delete process.env.HMF_MAIL_FROM;else process.env.HMF_MAIL_FROM=from;});
 process.env.RESEND_API_KEY='test-only';process.env.HMF_MAIL_FROM='Production <test@example.invalid>';
 const sent=[];globalThis.fetch=async(input,options)=>{assert.equal(String(input),'https://api.resend.com/emails');sent.push(JSON.parse(options.body).subject);return Response.json({});};
 await deliver(store);
 assert.deepEqual(sent,['New production message']);
 assert.equal([...store.data.values()].filter(record=>record.value.status==='Not sent — admin profile exempt').length,2);
});

test('a send-only provider key is reported once instead of on every row',async()=>{
 const store=fixture();process.env.RESEND_API_KEY='test-only';process.env.HMF_MAIL_FROM='Production <test@example.invalid>';
 for(const n of [1,2,3])await store.setJSON('mail-log/'+n,{to:'a@example.invalid',subject:'s',status:'Accepted by email provider',providerId:'p'+n,updated:Date.now()});
 let calls=0,status=401;
 globalThis.fetch=async()=>{calls++;return status===200?Response.json({last_event:'delivered'}):new Response('{}',{status});};
 await deliver(store);
 assert.equal(calls,1,'One refusal is enough; the rest would fail the same way.');
 assert.deepEqual({...(await store.get(TRACKING_KEY)),at:0},{blocked:true,status:401,at:0});
 for(const n of [1,2,3])assert.equal((await store.get('mail-log/'+n)).error,undefined);
 await deliver(store);assert.equal(calls,1,'Lookups pause while the key is refused.');
 await store.setJSON(TRACKING_KEY,{blocked:true,status:401,at:Date.now()-7*hour});status=200;
 await deliver(store);
 assert.equal(await store.get(TRACKING_KEY),null,'A working key clears the notice.');
 assert.equal((await store.get('mail-log/1')).status,'delivered');
});

test('a queued file notice is sent with its PDF attached, and never after the file is removed',async()=>{
 const store=fixture();process.env.RESEND_API_KEY='test-only';process.env.HMF_MAIL_FROM='Production <test@example.invalid>';
 const member={id:'00000000-0000-4000-8000-000000000071',name:'Sample Actor',email:'actor@example.invalid',productions:{}};
 await store.setJSON('members/'+member.id,member);
 const bytes=Buffer.from('%PDF-1.7\nCall sheet\n%%EOF');
 store.data.set('files/one',{value:bytes,etag:'f1'});
 await enqueue(store,member,'one','New file on your Film Portal · Call sheet','The following file is on your Film Portal for Written in the Dark:\n\nCall sheet\n\nhttps://heidimikacfilms.com/members/?production=written-in-the-dark',0,{attachmentKey:'files/one',attachmentName:'Call sheet.pdf'});
 await enqueue(store,member,'two','New file on your Film Portal · Removed','Body',0,{attachmentKey:'files/gone',attachmentName:'Removed.pdf'});
 await enqueue(store,member,'three','New message on your Film Portal · Parking','Body\n\nhttps://heidimikacfilms.com/members/?production=written-in-the-dark');
 const sent=[];
 globalThis.fetch=async(url,options)=>{if(options?.method==='POST')sent.push(JSON.parse(options.body));return Response.json({id:'provider-'+sent.length});};
 await deliver(store);
 assert.deepEqual(sent.map(mail=>mail.subject).sort(),['New file on your Film Portal · Call sheet','New message on your Film Portal · Parking']);
 const withFile=sent.find(mail=>mail.subject.includes('Call sheet'));
 assert.deepEqual(withFile.attachments,[{filename:'Call sheet.pdf',content:bytes.toString('base64')}]);
 assert.ok(withFile.html.includes('>Open your Film Portal</a>'));
 assert.equal(sent.find(mail=>mail.subject.includes('Parking')).attachments,undefined);
 const logs=[...store.data].filter(([key])=>key.startsWith('mail-log/')).map(([,record])=>record.value);
 assert.ok(logs.some(log=>log.subject.includes('Removed')&&log.status==='Not sent — file removed'));
 assert.equal([...store.data.keys()].filter(key=>key.startsWith('outbox/')).length,0);
});

test('a short-lived email is never held behind files being sent to a whole production',async()=>{
 const store=fixture();process.env.RESEND_API_KEY='test-only';process.env.HMF_MAIL_FROM='Production <test@example.invalid>';
 store.data.set('files/sheet',{value:Buffer.from('%PDF-1.7\nCall sheet\n%%EOF'),etag:'f1'});
 await store.setJSON('resources/sheet',{id:'sheet',title:'Call sheet',type:'PDF',audience:null});
 const people=[];
 for(let n=0;n<5;n++){
  const person={id:'00000000-0000-4000-8000-00000000008'+n,name:'Crew '+n,email:'crew'+n+'@example.invalid',productions:{'written-in-the-dark':{}}};
  people.push(person);await store.setJSON('members/'+person.id,person);
  await enqueue(store,person,'sheet','New file on your Film Portal · Call sheet','Body',0,{attachmentKey:'files/sheet',attachmentName:'Call sheet.pdf',resourceKey:'resources/sheet',production:'written-in-the-dark'});
 }
 // Queued last, so the earlier limit on file emails used to stop the run before reaching it.
 await enqueue(store,people[0],'reset/abc','Reset your Film Portal password','Use this link within one hour.',Date.now()+3600000);
 const sent=[];
 globalThis.fetch=async(url,options)=>{if(options?.method==='POST')sent.push(JSON.parse(options.body));return Response.json({id:'provider-'+sent.length});};
 await deliver(store);
 assert.equal(sent[0].subject,'Reset your Film Portal password','Email without an attachment is sent first.');
 assert.equal(sent.filter(mail=>mail.attachments).length,3,'File emails are still spread across runs.');
 await deliver(store);
 assert.equal(sent.filter(mail=>mail.attachments).length,5,'The rest follow on the next run.');
 assert.equal(sent.length,6);
});

test('a posted file or message is emailed only to people it is still shared with when it is sent',async()=>{
 const store=fixture();process.env.RESEND_API_KEY='test-only';process.env.HMF_MAIL_FROM='Production <test@example.invalid>';
 const dark='written-in-the-dark';
 const person=(n,productions)=>({id:'00000000-0000-4000-8000-00000000009'+n,name:'Person '+n,email:'person'+n+'@example.invalid',productions});
 const stays=person(1,{[dark]:{}}),left=person(2,{}),dropped=person(3,{[dark]:{}}),legacy=person(4,undefined);
 for(const member of [stays,left,dropped,legacy])await store.setJSON('members/'+member.id,member);
 store.data.set('files/script',{value:Buffer.from('%PDF-1.7\nScript\n%%EOF'),etag:'f1'});
 // The audience was narrowed after the notices were queued.
 await store.setJSON('resources/script',{id:'script',title:'Script',type:'PDF',audience:[stays.id,left.id,legacy.id]});
 const options={attachmentKey:'files/script',attachmentName:'Script.pdf',resourceKey:'resources/script',production:dark};
 for(const member of [stays,left,dropped,legacy])await enqueue(store,member,'script','New file on your Film Portal · Script','Body',0,options);
 await enqueue(store,stays,'gone','New message on your Film Portal · Removed','Body',0,{resourceKey:'resources/gone',production:dark});
 const sent=[];
 globalThis.fetch=async(url,options)=>{if(options?.method==='POST')sent.push(JSON.parse(options.body));return Response.json({id:'provider-'+sent.length});};
 await deliver(store);
 assert.deepEqual(sent.map(mail=>mail.to[0]).sort(),[legacy.email,stays.email].sort(),'Only people still on the production and in the audience receive it. Older profiles without a production list count as Written in the Dark.');
 const skipped=[...store.data].filter(([key])=>key.startsWith('mail-log/')).map(([,record])=>record.value).filter(row=>row.status==='Not sent — no longer shared with this person');
 assert.deepEqual(skipped.map(row=>row.to).sort(),[dropped.email,left.email,stays.email].sort(),'Each skipped email is recorded with its reason, including the message that was removed from the board.');
 assert.equal([...store.data.keys()].filter(key=>key.startsWith('outbox/')).length,0);
});

test('email queued before an address was corrected never goes to the old address',async()=>{
 const store=fixture();process.env.RESEND_API_KEY='test-only';process.env.HMF_MAIL_FROM='Production <test@example.invalid>';
 const member={id:'00000000-0000-4000-8000-0000000000a9',name:'Sample Actor',email:'wrong@example.invalid',productions:{'written-in-the-dark':{}}};
 await store.setJSON('members/'+member.id,member);
 await enqueue(store,member,'task-1','New production task','You have a new task.');
 await store.setJSON('members/'+member.id,{...member,email:'right@example.invalid'});
 await enqueue(store,{...member,email:'right@example.invalid'},'task-2','New production task','You have another task.');
 const sent=[];
 globalThis.fetch=async(url,options)=>{if(options?.method==='POST')sent.push(JSON.parse(options.body));return Response.json({id:'provider-'+sent.length});};
 await deliver(store);
 assert.deepEqual(sent.map(mail=>mail.to[0]),['right@example.invalid']);
 const log=[...store.data].filter(([key])=>key.startsWith('mail-log/')).map(([,record])=>record.value);
 assert.ok(log.some(row=>row.to==='wrong@example.invalid'&&row.status==='Not sent — email address changed'));
});

test('the action inbox ignores a brief SignWell outage and surfaces ended or stuck requests',async()=>{
 const store=fixture(),production='written-in-the-dark',now=Date.now();
 const person=async(id,agreement)=>{
  await store.setJSON('members/'+id,{id,name:'Person '+id,email:id+'@example.invalid',productions:{[production]:{role:'Actor'}}});
  if(agreement)await store.setJSON(currentAgreementKey(production,id),agreement);
 };
 const refreshError='Status could not be refreshed. Last known status shown.';
 await person('blip',{id:'doc-blip',status:'Waiting on actor',syncError:refreshError,syncErrorSince:now-60000});
 await person('down',{id:'doc-down',status:'Waiting on actor',syncError:refreshError,syncErrorSince:now-45*60000});
 await person('countersign',{id:'doc-counter',status:'Waiting on Heidi',syncError:refreshError,syncErrorSince:now-60000});
 await person('declined',{id:'doc-declined',status:'declined'});
 await person('expired',{id:'doc-expired',status:'expired'});
 await person('fresh',{status:'Preparing — check SignWell before retrying',created:now-60000});
 await person('stuck',{status:'Preparing — check SignWell before retrying',created:now-11*60000});
 await person('error',{id:'doc-error',status:'error'});
 await person('unknown',{id:'doc-unknown',status:'Send status unknown — check SignWell',syncError:'Refresh the agreement status before attempting another send.'});
 const actions=await adminActions(store,production);
 const labelFor=id=>actions.filter(item=>item.member===id).map(item=>item.label);
 assert.deepEqual(labelFor('blip'),[],'One failed status check is not something to act on.');
 assert.deepEqual(labelFor('down'),['Review the signing request for Person down'],'A problem that lasts is.');
 assert.deepEqual(labelFor('countersign'),['Open for Heidi’s signature · Person countersign'],'A brief outage does not hide the countersignature step.');
 assert.deepEqual(labelFor('declined'),['Signing request declined · review for Person declined']);
 assert.deepEqual(labelFor('expired'),['Signing request expired · review for Person expired']);
 assert.deepEqual(labelFor('fresh'),[],'A request being prepared right now is left alone.');
 assert.deepEqual(labelFor('stuck'),['Review the signing request for Person stuck'],'A reservation that never got a document is surfaced after ten minutes.');
 assert.deepEqual(labelFor('error'),['Review the signing request for Person error']);
 assert.deepEqual(labelFor('unknown'),['Review the signing request for Person unknown'],'An uncertain send still needs review straight away.');
 // The ended request has its own notice key, so an earlier connection problem never uses it up.
 const ended=actions.find(item=>item.member==='declined'),review=actions.find(item=>item.member==='down');
 assert.ok(ended.key.endsWith('/doc-declined/ended/declined'));assert.ok(review.key.endsWith('/doc-down/review'));
});
