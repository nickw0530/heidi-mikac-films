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
