import {AGREEMENT_CYCLE,currentAgreementKey} from '../lib/agreement-cycle.mjs';
import {manualAgreementKey,resourceTrackingKey,normalizePaperworkReason,manualPaperworkStatus,readAgreementTracking} from '../lib/paperwork.mjs';
import {COUNTERSIGN_EMAIL} from '../lib/signing.mjs';
import {adminActions} from '../lib/admin-actions.mjs';
import {AVAILABILITY_TIME_ZONE,normalizeAvailability,availabilityForDate,listDates,matchAvailability} from '../lib/availability.mjs';
import {begin as beginCalendar,events as calendarEvents} from './calendar-callback.mjs';
import sharp from 'sharp';
import {signwell,documentStatus,refreshAgreement,completedAgreementPdf} from '../lib/signing.mjs';
import {offlineSigningKey,refreshOfflineCountersign} from '../lib/offline-signing.mjs';
import darkCatalog, {whereinCatalog} from '../lib/film-profiles.mjs';
import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import {promisify} from 'node:util';
import {enqueue, mailReady, portalUrl} from '../lib/mail.mjs';
const derive=promisify(scrypt);
async function credential(password){
 requireThat(typeof password==='string'&&password.length>=12&&password.length<=128,'Choose a password between 12 and 128 characters.');
 const salt=token();return {salt,digest:(await derive(password,salt,64)).toString('hex')};
}
const hash = x => createHash('sha256').update(x).digest('hex');
const token = () => randomBytes(32).toString('hex');
// Practice accounts must never be linked to or published on a public film website.
const practiceName=name=>/^test(?:\s+testers[oe]n)?$/i.test(name.trim());
const allowPublicProfile=m=>requireThat(!practiceName(m.name),'Practice accounts cannot appear on a public website.',403);
const productions=[{id:'written-in-the-dark',name:'Written in the Dark'},{id:'wherein-lies-continue',name:'Wherein Lies Continue'}];
const catalogs={'written-in-the-dark':darkCatalog,'wherein-lies-continue':whereinCatalog};
const normalizeName=name=>name.trim().toLowerCase().replace(/[^a-z0-9]/g,'');
const normalizePendingName=name=>name.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]/gu,'');
function publicCredit(profile) {
  if (typeof profile.role !== 'string' || !profile.role.includes(',')) return profile;
  const titles = profile.role.split(/[,·]/).map(title => title.trim()).filter(Boolean);
  return {...profile, role: titles.join(' · ')};
}
function credits(value={}){
 const field=k=>{const v=value[k]??'';requireThat(typeof v==='string'&&v.trim().length<=120,'Keep each character or crew title within 120 characters.');return v.trim();};
 return {character:field('character'),crewTitle:field('crewTitle')};
}
const creditLine=c=>[c.character,c.crewTitle].filter(Boolean).join(' · ');
const assignments=m=>m.productions??{'written-in-the-dark':{role:m.role,filmProfile:m.filmProfile||''}};
const findProfile=(m,productionId)=>{
 const assigned=assignments(m)[productionId];
 const rows=catalogs[productionId];
 return rows.find(x=>x.id===(assigned?.filmProfile||m.profileLinks?.[productionId]||(productionId==='written-in-the-dark'?m.filmProfile:'')))||rows.find(x=>normalizeName(x.name)===normalizeName(m.name));
};
const sharedBase=m=>darkCatalog.find(x=>x.id===m.filmProfile)||Object.keys(assignments(m)).map(id=>findProfile(m,id)).find(Boolean);

const uuid = /^[a-f0-9-]{36}$/;
// A signature made from SignWell's own email never passes through the portal, so an
// open dashboard re-checks agreements still in progress after this many milliseconds.
const AGREEMENT_STATUS_MAX_AGE=30000;
const LOGIN_ATTEMPTS=20,LOGIN_ATTEMPTS_PER_ACCOUNT=200;
function requireThat(ok, message, status=400) {
  if (!ok) throw Object.assign(new Error(message), {status});
}
function string(value, max=200) {
  requireThat(typeof value==='string' && value.trim() && value.length<=max,'Please complete all required fields.');
  return value.trim();
}
function email(value) {
  const address=string(value).toLowerCase();
  requireThat(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address),'Enter a valid email.');
  return address;
}
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
const cookie=(key,age)=>'__Host-hmf='+key+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age='+age;
const json=(value,extra={})=>Response.json(value,{headers:{...headers,...extra}});
// Downloads carry the title production gave them, made safe for any filesystem.
function attachment(title,fallback='production-document'){
  const clean=String(title||'').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/[\\/:*?"<>|]/g,'-').replace(/\s+/g,' ').replace(/^[\s.-]+|[\s.-]+$/g,'').slice(0,120).trim()||fallback;
  const name=/\.pdf$/i.test(clean)?clean:clean+'.pdf';
  const ascii=name.replace(/[·–—]/g,'-').replace(/[^\x20-\x7e]/g,'_');
  return 'attachment; filename="'+ascii+'"; filename*=UTF-8\'\''+encodeURIComponent(name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
}

async function packet(bytes, terms) {
  const doc=await PDFDocument.load(bytes), pages=doc.getPages(), form=doc.getForm();
  const font=await doc.embedFont(StandardFonts.Helvetica);
  for(const [key,value] of [['Actor name or professional name',terms.credit],['Role or character',terms.character],['Daily rate (USD)',terms.rate]]) form.getTextField(key).setText(value);
  form.updateFieldAppearances(font);form.flatten();
  function write(page,x,top,width,value,background) {
    const size=Math.min(9,width/font.widthOfTextAtSize(value,1));
    requireThat(size>=5,'One entry is too long for the contract. Please shorten it.');
    const y=page.getHeight()-top-9.6;
    page.drawRectangle({x,y:y-2,width,height:15,color:background});
    page.drawText(value,{x,y:y+1,size,font});
  }
  const white=rgb(1,1,1), gray=rgb(.97,.98,.98);
  write(pages[0],340.5,143.3,31.4,terms.date,gray);
  write(pages[0],208.8,156.8,103,terms.legal,gray);
  write(pages[0],51,526.6,489,"This Agreement covers Actor's services already performed for the Picture and any future services mutually agreed.",white);
  write(pages[1],51,270.8,131,terms.credit,white);
  // Clear the master placeholder; SignWell fills the separate printed-name line.
  write(pages[1],310,383.3,150,'',white);
  for(const [x,signer] of [[310,1],[52,2]]) {
    pages[1].drawText('{{s:'+signer+':y          }}',{x,y:pages[1].getHeight()-414,size:12,font,color:white});
    pages[1].drawText('{{af_n:'+signer+':y          }}',{x,y:pages[1].getHeight()-457,size:12,font,color:white});
    // Each date is filled from that recipient's actual signing date and locked.
    pages[1].drawText('{{d:'+signer+':y::::120:24:y:mm/dd/yyyy}}',{x,y:pages[1].getHeight()-500,size:9,font,color:white});
  }
  return Buffer.from(await doc.save());
}
export default async function handle(req, context) {
 try {
  // Netlify supplies the visitor address; a client cannot set either source.
  const clientAddress=context?.ip||req.headers.get('x-nf-client-connection-ip')||'unknown';
  const url=new URL(req.url), action=url.searchParams.get('action')||'home';
  const production=['heidimikacfilms.com','www.heidimikacfilms.com'].includes(url.hostname);
  let productionId=url.searchParams.get('production')||'written-in-the-dark';
  requireThat(catalogs[productionId],'Unknown production.');
  const rawStore=getStore({name:production?'hmf-members-v1':'hmf-preview-'+(process.env.DEPLOY_ID||'local'),consistency:'strong'});
  // Each contract round has independent signing state. Prior files and records stay in their original scope.
  const legacyScoped=key=>productionId!=='written-in-the-dark'&&/^(tasks|agreements|agreement-history|resources|files|offline|offline-history|contract)\//.test(key)?'productions/'+productionId+'/'+key:key;
  const scoped=key=>/^(agreements|agreement-history)\//.test(key)?'contract-cycles/'+AGREEMENT_CYCLE+'/'+legacyScoped(key):legacyScoped(key);
  const store={};
  for(const method of ['get','getWithMetadata','getMetadata','set','setJSON','delete'])store[method]=(key,...args)=>rawStore[method](scoped(key),...args);
  store.list=async(options)=>{const result=await rawStore.list({...options,prefix:scoped(options.prefix)});const prefix=(/^(agreements|agreement-history)\//.test(options.prefix)?'contract-cycles/'+AGREEMENT_CYCLE+'/':'')+(productionId==='written-in-the-dark'?'':'productions/'+productionId+'/');return {...result,blobs:result.blobs.map(b=>({...b,key:prefix&&b.key.startsWith(prefix)?b.key.slice(prefix.length):b.key}))};};
  let catalog=catalogs[productionId], film=productions.find(p=>p.id===productionId).name;
  const get=k=>store.get(k,{type:'json'});
  const set=(k,v)=>store.setJSON(k,v);
  const list=async prefix=>Promise.all((await store.list({prefix})).blobs.map(b=>get(b.key)));
  const globalRecords=async prefix=>{
    const records=[];
    for await(const page of rawStore.list({prefix,paginate:true}))for(const {key} of page.blobs){const record=await rawStore.get(key,{type:'json'});if(record)records.push(record);}
    return records;
  };
  const pendingKey=id=>'portal-pending/'+id;
  const pendingNameKey=name=>'portal-pending-names/'+hash(normalizePendingName(name));
  async function releasePendingName(name,id){
    const key=pendingNameKey(name),owner=await rawStore.get(key,{type:'json'}),current=await rawStore.get(pendingKey(id),{type:'json'});
    if(owner?.id===id&&(!current||current.archived||normalizePendingName(current.name)!==normalizePendingName(name)))await rawStore.delete(key);
  }
  const invalidate=()=>set('public-revision',token());
  const active=m=>m&&!m.revoked;
  const publicPhotoHeaders={'Cache-Control':'public, max-age=60','Access-Control-Allow-Origin':'*'};
  async function publicItems(pid=productionId){
    const revision=await get('public-revision')||'initial',key='public-cache/'+pid;
    const cached=await get(key);if(cached?.revision===revision)return cached.items;
    const items=pid==='written-in-the-dark'?(await list('published/')).filter(Boolean):[];
    for(const m of (await list('members/')).filter(Boolean).sort((a,b)=>Number(!!b.revoked)-Number(!!a.revoked))){
      if(practiceName(m.name))continue;
      const membership=assignments(m)[pid],base=findProfile(m,pid),id=base?.id||'member-'+m.id;
      if(m.generalInvite&&!m.approvedProfiles?.[pid])continue;
      const index=items.findIndex(x=>x.id===id);if(index>=0)items.splice(index,1);
      if(practiceName(m.name)||!membership||m.publication?.[pid]===false||(m.revoked&&!m.keepPublic)){
        if(base||membership)items.push({id,name:m.name,hidden:true});continue;
      }
      const [profile,photo]=await Promise.all([get('profiles/'+m.id),store.getMetadata('photos/'+m.id)]),fallback=sharedBase(m);
      const bio=profile?.bio??fallback?.bio??'',image=photo?'https://heidimikacfilms.com/.netlify/functions/portal?action=memberPhoto&id='+m.id+'&v='+(photo.metadata?.version||'original'):fallback?.photo;
      const approved=m.approvedProfiles?.[pid];
      if(approved||bio.trim()&&image)items.push({id,name:m.name,role:membership.role??base?.role??'',bio:approved?.bio??bio,photo:approved?.photo??image});
    }
    // Revision-keyed snapshots cannot overwrite a later profile edit.
    if((await get('public-revision')||'initial')===revision)await set(key,{revision,items,updated:Date.now()});
    return items;
  }
  const post=req.method==='POST';
  requireThat(post||req.method==='GET','Unsupported method.',405);
  if(post) requireThat(req.headers.get('origin')===url.origin,'Origin rejected.',403);
  const entry=id=>catalog.find(item=>item.id===id);
  if(!post&&action==='published'){
    // Hidden entries exist only to suppress a card already printed on a film website.
    // People without such a card are left out, so hiding someone never names them here.
    const items=(await publicItems()).filter(x=>!x.hidden||entry(x.id)).map(x=>x.hidden?{id:x.id,name:entry(x.id).name,hidden:true}:publicCredit(x));
    return json(items,{'Access-Control-Allow-Origin':'*','Cache-Control':'public, max-age=30'});
  }
  if(!post&&action==='memberPhoto'){
    const id=url.searchParams.get('id');requireThat(uuid.test(id),'Invalid image.');
    const m=await get('members/'+id);
    requireThat(m&&(!m.revoked||m.keepPublic)&&!practiceName(m.name)&&Object.keys(assignments(m)).some(id=>m.publication?.[id]!==false),'Image unavailable.',404);
    const versionRequested=url.searchParams.get('v');
    const approvedImage=Object.keys(assignments(m)).some(pid=>m.publication?.[pid]!==false&&m.approvedProfiles?.[pid]?.imageVersion===versionRequested&&!!versionRequested);
    const file=await store.getWithMetadata(approvedImage?'profile-images/'+id+'/'+versionRequested:'photos/'+id,{type:'arrayBuffer'});requireThat(file,'Image unavailable.',404);
    const version=file.metadata?.version||hash(Buffer.from(file.data)),key='web-photos/'+id+'/'+version;
    let web=await store.get(key,{type:'arrayBuffer'});
    if(!web){web=await sharp(Buffer.from(file.data),{limitInputPixels:40000000}).rotate().resize(720,900,{fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer();await store.set(key,web);}
    return new Response(web,{headers:{...headers,...publicPhotoHeaders,'Content-Type':'image/webp'}});
  }
  if(!post&&action==='publicPhoto'){
    const version=url.searchParams.get('id');requireThat(/^[a-f0-9]{64}$/.test(version),'Invalid image.');
    const photo=await store.getWithMetadata('public-images/'+version,{type:'arrayBuffer'});
    requireThat(photo,'Image unavailable.',404);return new Response(photo.data,{headers:{...headers,'Content-Type':photo.metadata.mime}});
  }
  const raw=req.headers.get('cookie')?.match(/(?:^|; )__Host-hmf=([a-f0-9]{64})(?:;|$)/)?.[1];
  const sessionKey=raw&&'sessions/'+hash(raw);
  const session=sessionKey&&await get(sessionKey);
  const body=post&&req.headers.get('content-type')?.startsWith('application/json')?await req.json():{};
  const uid=url.searchParams.get('id')||body.id;
  const adminKeys=[['Nick',process.env.HMF_NICK_LOGIN_SHA256],['Heidi',process.env.HMF_HEIDI_LOGIN_SHA256]];
  async function signedIn(id,adminDigest=null){
    const secret=token();
    await set('sessions/'+hash(secret),{id,admin:!!adminDigest,adminDigest,passwordVersion:(await get('passwords/'+id))?.version||0,expires:Date.now()+8*3600000});
    return json({ok:true},{'Set-Cookie':cookie(secret,28800)});
  }
  async function notify(m,event,subject,text,agreementCycle){
    if(production&&m.email)await enqueue(store,m,event,subject,text+'\n\nOpen your dashboard: '+portalUrl+'?production='+productionId,0,agreementCycle?{agreementCycle,requirementKey:manualAgreementKey(productionId,m.id)}:{});
  }
  const recoveryAddress=id=>process.env['HMF_'+id.toUpperCase()+'_RECOVERY_EMAIL']||(id==='Nick'?'nick@heidimikacfilms.com':'heidi@heidimikacfilms.com');
  if(action==='requestReset'&&post){
    requireThat(production&&mailReady(),'Password recovery email is unavailable. Contact production.',503);
    const who=string(body.username).toLowerCase(),bucket='recovery-limit/'+hash(who)+'/'+Math.floor(Date.now()/900000);
    const allowed=await store.setJSON(bucket,true,{onlyIfNew:true});
    if(allowed.modified){
      const adm=adminKeys.find(([id])=>id.toLowerCase()===who||recoveryAddress(id).toLowerCase()===who);
      const m=adm?{id:adm[0],email:recoveryAddress(adm[0])}:(await list('members/')).find(m=>active(m)&&m.email===who);
      const old=m&&await get('passwords/'+m.id);
      if(old&&(!adm||old.adminDigest===adm[1])){
        const ticket=token(),expires=Date.now()+3600000;
        await set('resets/'+hash(ticket),{id:m.id,expires,passwordDigest:old.digest,adminDigest:adm?.[1]||null});
        await enqueue(store,m,'reset/'+hash(ticket),'Reset your portal password','Use this link within one hour to choose a new password. If you did not request this, ignore this message.\n\n'+portalUrl+'#reset='+ticket,expires);
      }else if(!adm&&m&&!old){
        // Invited but never set a password: there is nothing to reset, so send a fresh invitation instead of silence.
        const record=await store.getWithMetadata('members/'+m.id,{type:'json'});
        if(active(record?.data)&&record.data.email===who){
          const ticket=token(),expires=Date.now()+7*86400000;
          await set('tickets/'+hash(ticket),{id:m.id,expires});
          if((await store.setJSON('members/'+m.id,{...record.data,ticket:hash(ticket)},{onlyIfMatch:record.etag})).modified)
            await enqueue(store,m,'invite/'+hash(ticket),'Heidi Mikac Films — finish setting up your account','Hi '+m.name+',\n\nYour cast and crew account has no password yet. Choose one here to open your dashboard:\n'+portalUrl+'#invite='+ticket+'\n\nThis link expires in seven days. If you did not ask for it, ignore this message.',expires);
        }
      }
    }
    return json({ok:true,message:'If that account is eligible, a password reset email will arrive shortly. Check spam too.'});
  }
  if(action==='resetPassword'&&post){
    requireThat(/^[a-f0-9]{64}$/.test(body.ticket),'Invalid reset link.');
    const key='resets/'+hash(body.ticket),rec=await store.getWithMetadata(key,{type:'json'}),r=rec?.data;
    requireThat(r?.expires>Date.now(),'This reset link expired or was used. Request a new one.');
    const adm=adminKeys.find(([id])=>id===r.id),m=adm?null:await get('members/'+r.id);
    requireThat(adm?adm[1]===r.adminDigest:active(m),'This account is unavailable.');
    const old=await store.getWithMetadata('passwords/'+r.id,{type:'json'});
    requireThat(old?.data?.digest===r.passwordDigest,'This reset link has been replaced.');
    const pass=await credential(body.password);
    requireThat((await store.setJSON(key,{expires:0},{onlyIfMatch:rec.etag})).modified,'This link was already used.');
    requireThat((await store.setJSON('passwords/'+r.id,{...pass,adminDigest:adm?.[1]||null,version:token()},{onlyIfMatch:old.etag})).modified,'Password changed elsewhere. Request a new reset link.');
    return json({ok:true});
  }
  if(action==='activate'&&post){
    requireThat(/^[a-f0-9]{64}$/.test(body.ticket),'Invalid invitation.');
    const key='tickets/'+hash(body.ticket), rec=await store.getWithMetadata(key,{type:'json'});
    requireThat(rec?.data?.expires>Date.now(),'Invitation expired. Ask production to resend it.');
    const m=await get('members/'+rec.data.id);
    requireThat(active(m)&&m.ticket===hash(body.ticket),'This invitation has been replaced.');
    const pass=await credential(body.password);
    const result=await store.setJSON('passwords/'+m.id,pass,{onlyIfNew:true});
    requireThat(result.modified,'This account already has a password. Sign in instead.');
    await store.delete(key);return signedIn(m.id);
  }
  if(action==='passwordLogin'&&post){
    const who=string(body.username).toLowerCase();
    requireThat(typeof body.password==='string'&&body.password.length<=128,'Invalid login.',401);
    const admin=adminKeys.find(([id])=>id.toLowerCase()===who||recoveryAddress(id).toLowerCase()===who);
    const members=admin?[]:await list('members/');
    const id=admin?.[0]||members.find(m=>active(m)&&m.email===who)?.id;
    const pass=id&&await get('passwords/'+id);
    requireThat(pass&&(!admin||pass.adminDigest===admin[1]),'Invalid login.',401);
    // Failed guesses are counted per account and visitor address, so someone
    // hammering a known sign-in name locks out only themselves. A much higher
    // ceiling per account still slows guessing spread across many addresses.
    const window=Math.floor(Date.now()/600000);
    const mine='attempts/'+hash(id+'|'+clientAddress)+'/'+window,everyone='attempts/'+hash(id)+'/'+window;
    const count=async key=>(await store.get(key,{type:'json'}))||0;
    const bump=async(key,delta)=>{
      for(let attempt=0;attempt<5;attempt++){
        const record=await store.getWithMetadata(key,{type:'json'}),next=Math.max(0,(record?.data||0)+delta);
        if((await store.setJSON(key,next,record?{onlyIfMatch:record.etag}:{onlyIfNew:true})).modified)return;
      }
    };
    requireThat(await count(mine)<LOGIN_ATTEMPTS&&await count(everyone)<LOGIN_ATTEMPTS_PER_ACCOUNT,'Too many attempts. Try again in ten minutes.',429);
    // Reserve the attempt before the slow password check so parallel guesses cannot slip past the limit.
    await Promise.all([bump(mine,1),bump(everyone,1)]);
    const attempt=await derive(body.password,pass.salt,64);
    requireThat(timingSafeEqual(attempt,Buffer.from(pass.digest,'hex')),'Invalid login.',401);
    // A correct password is not a failed guess.
    await Promise.all([store.delete(mine),bump(everyone,-1)]);
    return signedIn(id,admin?.[1]);
  }
  if(action==='login'&&post){
    const code=string(body.code,200);
    requireThat(code.length>=32,'Invalid access key.',401);
    const digest=hash(code), admin=adminKeys.find(([,k])=>k?.length===64&&k===digest);
    const member=admin?null:await get('keys/'+digest);
    requireThat(admin||(member&&active(await get('members/'+member.id))),'Access key is invalid or revoked.',401);
    requireThat(!await get('passwords/'+(admin?admin[0]:member.id)),'A password is already configured. Sign in or use Forgot your password.',409);
    return signedIn(admin?admin[0]:member.id,admin?.[1]);
  }
  requireThat(session?.expires>Date.now(),'Please sign in.',401);
  const admin=session.admin, self=session.id;
  requireThat(admin?adminKeys.some(([id,k])=>id===self&&k&&k===session.adminDigest):active(await get('members/'+self)),'Access revoked.',401);
  requireThat((session.passwordVersion||0)===((await get('passwords/'+self))?.version||0),'Please sign in again.',401);
  if(action==='logout'&&post){await store.delete(sessionKey);return json({}, {'Set-Cookie':cookie('',0)});}
  const onlyAdmin=()=>requireThat(admin,'Administrator access required.',403);
  const account=admin?null:await get('members/'+self);
  const memberProductions=account?assignments(account):null;
  if(!admin&&action==='home'&&!url.searchParams.has('production')&&Object.keys(memberProductions).length){
    productionId=Object.keys(memberProductions)[0];catalog=catalogs[productionId];film=productions.find(p=>p.id===productionId).name;
  }
  if(!admin&&!['home','bio','photo','choosePassword','welcomePlayed','requestProductions','calendarEvents'].includes(action))requireThat(memberProductions[productionId],'You are not assigned to this production.',403);
  if(!admin&&action==='home'&&Object.keys(memberProductions).length)requireThat(memberProductions[productionId],'You are not assigned to this production.',403);
  if(['availability','saveAvailability','availabilityMatch'].includes(action)){
    requireThat(admin||memberProductions?.[productionId],'You are not assigned to this production.',403);
    requireThat(action==='availability'?!post:post,action==='availability'?'Use GET to view availability.':'Use POST to update or compare availability.',405);
    // Availability is private to the current production and deliberately has a
    // smaller response than member administration. No email, profile draft,
    // invitation, document or authentication fields belong in this projection.
    const roster=(await globalRecords('members/')).filter(m=>active(m)&&uuid.test(m.id)&&assignments(m)[productionId]&&(admin||!!m.email)&&(admin||m.id===self||!practiceName(m.name))).sort((a,b)=>a.name.localeCompare(b.name));
    const key=id=>'availability/'+productionId+'/'+id;
    const schedule=record=>record?{
      ...normalizeAvailability(record),
      updated:Number.isFinite(record.updated)?record.updated:null,
      updatedByLabel:typeof record.updatedByLabel==='string'?record.updatedByLabel.slice(0,200):'Member'
    }:null;
    if(action==='saveAvailability'){
      const id=uid||self;
      requireThat(uuid.test(id)&&(admin||id===self),'You can update only your own availability.',403);
      const member=roster.find(m=>m.id===id);requireThat(member,'This person is not available in the selected production.',404);
      requireThat(Object.hasOwn(body,'revision')&&(body.revision===null||typeof body.revision==='string'&&body.revision.length<=300),'Refresh availability before saving.');
      const value=normalizeAvailability(body),record=await rawStore.getWithMetadata(key(id),{type:'json'});
      requireThat(body.revision===(record?.etag??null),'Availability changed in another window. Reload before saving.',409);
      const updated={...value,updated:Date.now(),updatedByLabel:admin?'Production':member.name};
      const saved=await rawStore.setJSON(key(id),updated,record?{onlyIfMatch:record.etag}:{onlyIfNew:true});
      requireThat(saved.modified,'Availability changed in another window. Reload before saving.',409);
      const current=await rawStore.getWithMetadata(key(id),{type:'json'});
      return json({ok:true,id,productionId,availability:schedule(current?.data||updated),revision:current?.etag??null});
    }
    if(action==='availabilityMatch'){
      requireThat(Array.isArray(body.members)&&body.members.length>0&&body.members.length<=100&&body.members.every(id=>typeof id==='string'&&roster.some(m=>m.id===id)),'Select people from this production (up to 100).');
      const ids=[...new Set(body.members)];
      const people=await Promise.all(ids.map(async id=>({id,name:roster.find(m=>m.id===id).name,availability:await rawStore.get(key(id),{type:'json'})})));
      return json({productionId,film,...matchAvailability(people,{from:body.from,to:body.to,minMinutes:body.minMinutes})});
    }
    const from=url.searchParams.get('from'),to=url.searchParams.get('to');
    const dates=from||to?listDates(from,to):null;
    const members=await Promise.all(roster.map(async member=>{
      const record=await rawStore.getWithMetadata(key(member.id),{type:'json'});
      const availability=schedule(record?.data);
      return {id:member.id,name:member.name,role:assignments(member)[productionId].role||'',needsEmail:!member.email,availability,revision:record?.etag??null,canEdit:admin||member.id===self,...(dates?{days:dates.map(date=>availabilityForDate(availability,date))}:{})};
    }));
    return json({productionId,film,timezone:AVAILABILITY_TIME_ZONE,selfId:self,admin,members,...(dates?{from,to}:{})});
  }
  if(action==='calendarConnect'||action==='calendarEvents'){
    requireThat(url.origin==='https://heidimikacfilms.com','Production only.',403);
    if(action==='calendarConnect'){onlyAdmin();requireThat(post,'Use the connect button.',405);return await beginCalendar(store,sessionKey);}
    return await calendarEvents(store,admin,url.searchParams.get('event'),account);
  }
  const target=async()=>{requireThat(uuid.test(uid)&& (admin||uid===self),'Access denied.',403);const m=await get('members/'+uid);requireThat(m,'Member unavailable.',404);if(!['bio','photo','revoke','enrollments','resend'].includes(action))requireThat(assignments(m)[productionId],'Member is not assigned to this production.',403);return m};
  if(action==='choosePassword'&&post){
    const pass=await credential(body.password);
    const result=await store.setJSON('passwords/'+self,{...pass,adminDigest:session.adminDigest},{onlyIfNew:true});
    requireThat(result.modified,'A password is already configured.');return json({ok:true});
  }
  // A public roster name match alone does not establish ownership of private paperwork.
  function documentProfile(member){
    const assignment=assignments(member)[productionId];
    if(!assignment)return null;
    const id=assignment.filmProfile||member.profileLinks?.[productionId]||(productionId==='written-in-the-dark'?member.filmProfile:null);
    return id&&entry(id)?id:null;
  }
  async function ownedProfile(member,accounts){
    const id=documentProfile(member);
    if(!id)return null;
    const others=accounts||await list('members/');
    return others.some(m=>active(m)&&m.id!==member.id&&documentProfile(m)===id)?null:id;
  }
  if(action==='memberDocument'){
    requireThat(req.method==='GET','Use GET to download a document.',405);
    const member=await target(),kind=url.searchParams.get('kind');
    let bytes,label;
    if(kind==='previous-signed'){
      const agreement=await rawStore.get(legacyScoped('agreements/'+member.id),{type:'json'});
      requireThat(agreement?.id&&agreement.status==='Complete','No previous completed agreement available.',404);
      bytes=await completedAgreementPdf(agreement.id);label='previous-signed-agreement';
    }else if(kind==='signed'){
      const agreement=await refreshAgreement(store,'agreements/'+member.id,true);
      requireThat(agreement?.id&&agreement.status==='Complete','No completed agreement available.',404);
      bytes=await completedAgreementPdf(agreement.id);label='signed-agreement';
    }else{
      const profile=await ownedProfile(member);
      requireThat(profile,'No linked paperwork available.',404);
      if(kind==='countersigned'||kind==='previous-countersigned'){
        const agreement=await refreshOfflineCountersign({store:rawStore,profileId:profile,productionId});
        requireThat(agreement?.id&&!agreement.sourceChanged&&agreement.status==='Complete','No countersigned agreement available.',404);
        bytes=await completedAgreementPdf(agreement.id);label='countersigned-agreement';
      }else{
        requireThat(kind==='uploaded'||kind==='previous','Unknown document.',404);
        const version=url.searchParams.get('version');
        if(kind==='previous')requireThat(/^[a-f0-9]{64}$/.test(version||''),'Unknown document version.',404);
        bytes=await store.get(kind==='uploaded'?'offline/'+profile:'offline-history/'+profile+'/'+version,{type:'arrayBuffer'});
        requireThat(bytes,'Document unavailable.',404);label=kind==='uploaded'?'filed-agreement':'previous-agreement-'+version.slice(0,8);
      }
    }
    return new Response(bytes,{headers:{...headers,'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="'+productionId+'-'+label+'.pdf"'}});
  }
  if(action==='offline'){
    onlyAdmin();requireThat(entry(uid),'Unknown film profile.');
    const key='offline/'+uid;
    requireThat(!post,'A new electronic agreement is required. Previous paper agreements are archived.',409);
    const file=await store.getWithMetadata(key,{type:'arrayBuffer'});requireThat(file,'No agreement on file.',404);
    return new Response(file.data,{headers:{...headers,'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="'+uid+'-offline-agreement.pdf"'}});
  }
  if(['prepareOfflineCountersign','offlineCountersignStatus'].includes(action)){
    onlyAdmin();requireThat(false,'Previous paper agreements have been replaced. Prepare a new agreement from this member’s profile.',409);
  }
  const canReadResource=r=>r&&(admin||(memberProductions[productionId]&&(r.audience==null||r.audience.includes(self))));
  async function recipients(mode,ids){
    const roster=(await list('members/')).filter(m=>active(m)&&assignments(m)[productionId]);
    if(mode==='all'||mode==null)return {audience:null,recipients:roster};
    requireThat(mode==='selected'&&Array.isArray(ids)&&ids.length&&ids.every(id=>roster.some(m=>m.id===id)),'Select at least one current member.');
    return {audience:[...new Set(ids)],recipients:roster.filter(m=>ids.includes(m.id))};
  }
  if(action==='welcomeSettings'&&post){
    onlyAdmin();
    const https=v=>{if(!v)return '';let u;try{u=new URL(v)}catch{}requireThat(u?.protocol==='https:'&&!u.username&&!u.password,'Enter a direct HTTPS media URL.');return u.href;};
    await set('settings/welcome',{video:https(body.video),poster:https(body.poster),captions:https(body.captions)});return json({ok:true});
  }
  if(action==='welcomePlayed'&&post){await set('welcome-played/'+self,true);return json({ok:true});}
  if(action==='savePendingPerson'&&post){
    onlyAdmin();const name=string(body.name),normalized=normalizePendingName(name);
    requireThat(normalized,'Enter the person’s name.');
    const selections=body.productions??[];
    requireThat(Array.isArray(selections)&&selections.every(id=>productions.some(p=>p.id===id)),'Choose valid productions.');
    const id=uid||randomUUID();requireThat(uuid.test(id),'Invalid saved person.');
    const key=pendingKey(id),record=await rawStore.getWithMetadata(key,{type:'json'}),prior=record?.data;
    const memberKey='members/'+id,memberRecord=await rawStore.getWithMetadata(memberKey,{type:'json'}),member=memberRecord?.data;
    if(uid)requireThat(prior&&(!prior.archived||active(member)&&member.pendingContact&&!member.email),'Saved person unavailable.',404);
    requireThat(!(prior?.inviteLeaseUntil>Date.now()),'This person is being updated or invited. Refresh before editing.',409);
    requireThat(!member?.email||name===prior.name,'This person already has an invitation. Keep the saved name unchanged.',409);
    const accounts=await globalRecords('members/');
    requireThat(!accounts.some(m=>active(m)&&m.id!==id&&normalizePendingName(m.name)===normalized),'A person profile already exists under this name. Open that profile instead.',409);
    const index=pendingNameKey(name),owner=await rawStore.get(index,{type:'json'});
    if(owner?.id!==id){
      const reserved=await rawStore.setJSON(index,{id},{onlyIfNew:true});
      requireThat(reserved.modified,'This name is already in Awaiting portal setup. Open the saved entry instead.',409);
    }
    const selected=[...new Set(selections)],lease=token();
    const updated={...prior,id,name,productions:selected,created:prior?.created||Date.now(),updated:Date.now(),...(member?.email?{memberId:member.id,archived:false}:{}),inviteLeaseToken:lease,inviteLeaseUntil:Date.now()+120000};
    let profileSaved=false;
    try{
      const saved=await rawStore.setJSON(key,updated,record?{onlyIfMatch:record.etag}:{onlyIfNew:true});
      requireThat(saved.modified,'This saved person changed. Refresh before trying again.',409);
      if(!member?.email){
        const assignmentsNext=Object.fromEntries(selected.map(pid=>[pid,assignments(member||{productions:{}})[pid]||{role:'',filmProfile:''}]));
        const profile={...member,id,name,pendingContact:true,pendingPersonId:id,generalInvite:true,productions:assignmentsNext};
        const written=await rawStore.setJSON(memberKey,profile,memberRecord?{onlyIfMatch:memberRecord.etag}:{onlyIfNew:true});
        requireThat(written.modified,'This person’s profile changed. Refresh before trying again.',409);
      }
      profileSaved=true;
      const latest=await rawStore.getWithMetadata(key,{type:'json'});
      requireThat(latest?.data?.inviteLeaseToken===lease,'This saved person changed. Refresh before trying again.',409);
      const {inviteLeaseToken,inviteLeaseUntil,...complete}=latest.data;
      requireThat((await rawStore.setJSON(key,complete,{onlyIfMatch:latest.etag})).modified,'This saved person changed. Refresh before trying again.',409);
    }catch(error){
      const latest=await rawStore.getWithMetadata(key,{type:'json'});
      if(latest?.data?.inviteLeaseToken===lease){
        if(profileSaved){const {inviteLeaseToken,inviteLeaseUntil,...complete}=latest.data;await rawStore.setJSON(key,complete,{onlyIfMatch:latest.etag});}
        else if(prior)await rawStore.setJSON(key,prior,{onlyIfMatch:latest.etag});else await rawStore.delete(key);
      }
      await releasePendingName(name,id);throw error;
    }
    if(prior&&normalizePendingName(prior.name)!==normalized)await releasePendingName(prior.name,id);
    return json({ok:true,id});
  }
  if(action==='removePendingPerson'&&post){
    onlyAdmin();requireThat(uuid.test(uid),'Invalid saved person.');
    const key=pendingKey(uid),record=await rawStore.getWithMetadata(key,{type:'json'}),person=record?.data;
    requireThat(person&&!person.archived,'Saved person unavailable.',404);
    requireThat(!(person.inviteLeaseUntil>Date.now()),'An invitation is being prepared. Refresh before removing this entry.',409);
    const saved=await rawStore.setJSON(key,{...person,archived:true,archivedAt:Date.now(),archivedBy:self},{onlyIfMatch:record.etag});
    requireThat(saved.modified,'This saved person changed. Refresh before trying again.',409);
    await releasePendingName(person.name,uid);return json({ok:true});
  }
  if(action==='home'){
    const allAccounts=(await list('members/')).filter(Boolean);
    const accounts=allAccounts.filter(active);
    const rosterCatalog=catalog.filter(x=>{const matches=allAccounts.filter(m=>(!m.generalInvite||assignments(m)[productionId]||m.approvedProfiles?.[productionId])&&findProfile(m,productionId)?.id===x.id);return !matches.length||matches.some(m=>assignments(m)[productionId]&&(!m.revoked||m.keepPublic));});
    const members=admin?accounts.filter(m=>assignments(m)[productionId]||!Object.keys(assignments(m)).length):[account];
    const offlineRequests=new Map();
    const offlineFor=profileId=>{
      if(!offlineRequests.has(profileId))offlineRequests.set(profileId,rawStore.get(offlineSigningKey(profileId,productionId),{type:'json'}));
      return offlineRequests.get(profileId);
    };
    const rows=await Promise.all(members.filter(Boolean).map(async m=>({...m,needsEmail:!m.email,role:assignments(m)[productionId]?.role||'',filmProfile:assignments(m)[productionId]?findProfile(m,productionId)?.id||'':'',productions:assignments(m),profile:m.draftProfile?.bio!==undefined?{bio:m.draftProfile.bio}:await get('profiles/'+m.id),...(await (async()=>{const photo=await store.getMetadata(m.draftProfile?.imageVersion?'profile-images/'+m.id+'/'+m.draftProfile.imageVersion:'photos/'+m.id);return {hasPhoto:!!photo,photoName:photo?.metadata?.filename||''};})()),agreement:assignments(m)[productionId]?await refreshAgreement(store,'agreements/'+m.id,false,AGREEMENT_STATUS_MAX_AGE):null,tasks:assignments(m)[productionId]?(await list('tasks/'+m.id+'/')).filter(Boolean):[],activated:!!await get('passwords/'+m.id)})));
    for(const row of rows){
      const original=accounts.find(m=>m.id===row.id);
      const base=sharedBase(original);
      row.paperworkExempt=false;
      const published=base?await get('published/'+base.id):null;
      row.previousOfflineStatus=assignments(original)[productionId]&&row.filmProfile?(await store.getMetadata("offline/"+row.filmProfile))?.metadata?.status||null:null;
      row.offlineStatus=null;
      const previous=await rawStore.get(legacyScoped('agreements/'+row.id),{type:'json'});
      row.previousAgreement=previous?.id?{status:previous.status,completed:previous.status==='Complete'}:null;
      {
        const profile=await ownedProfile(original,accounts);
        row.documents=[];
        if(row.agreement?.id&&row.agreement.status==='Complete')row.documents.push({kind:'signed',title:'Signed agreement and audit record'});
        if(previous?.id&&previous.status==='Complete')row.documents.push({kind:'previous-signed',title:'Previous signed agreement and audit record · replaced'});
        if(profile){
          if(row.previousOfflineStatus)row.documents.push({kind:'uploaded',title:'Previous paper agreement · replaced'});
          const signed=await offlineFor(profile);
          if(signed?.id&&!signed.sourceChanged&&signed.status==='Complete')row.documents.push({kind:'previous-countersigned',title:'Previous countersigned agreement and audit record · replaced'});
          const history=await store.list({prefix:'offline-history/'+profile+'/'});
          for(const file of history.blobs){
            const version=file.key.split('/').pop();
            if(/^[a-f0-9]{64}$/.test(version))row.documents.push({kind:'previous',version,title:'Previous filed agreement · '+version.slice(0,8)});
          }
        }
      }
      row.referencePhoto=published?.photo||base?.photo;
      row.profile??={bio:published?.bio??base?.bio??''};
      const memberPaperwork=row.agreement&&!row.agreement.cleared?row.agreement.status:'No agreement on file';
      const tracking=await readAgreementTracking(rawStore,productionId,row.id);
      row.paperworkTracking=tracking?{reason:tracking.reason,at:tracking.at,...(admin?{by:tracking.by}:{})}:null;
      row.tracking=row.paperworkTracking;
      row.documentTracking=Object.fromEntries((await list('document-tracking/'+productionId+'/'+row.id+'/')).filter(item=>item&&uuid.test(item.document)&&normalizePaperworkReason(item.reason)).map(item=>[item.document,normalizePaperworkReason(item.reason)]));
      row.paperworkStatus=manualPaperworkStatus(tracking)||memberPaperwork;
      row.memberPaperworkStatus=row.paperworkStatus;
      row.publication=Object.fromEntries(await Promise.all(Object.keys(assignments(original)).map(async pid=>{
        const id=findProfile(original,pid)?.id||'member-'+row.id;
        const ready=!!original.approvedProfiles?.[pid]||!!row.profile.bio?.trim()&&!!(row.hasPhoto||row.referencePhoto);
        const hidden=practiceName(row.name)||original.publication?.[pid]===false;
        if(original.generalInvite&&!original.approvedProfiles?.[pid])return [pid,{state:'Awaiting approval',visible:false}];
        let state=hidden?'Hidden from website':ready?'Sync failed':'Needs bio and headshot';
        if(!hidden&&ready){try{state=(await publicItems(pid)).some(x=>x.id===id&&!x.hidden)?'Published':'Sync failed';}catch{}}
        return [pid,{state,visible:!hidden}];
      })));

    }
    const adminCatalog=admin?await Promise.all(rosterCatalog.map(async x=>{
      const previousOffline=(await store.getMetadata('offline/'+x.id))?.metadata?.status||null;
      return {...x,offline:null,previousOffline,offlineSigning:null,paperworkStatus:rows.find(row=>row.filmProfile===x.id)?.paperworkStatus||'No agreement on file'};
    })):[];
    const waiting=admin?(await adminActions(rawStore,productionId)).filter(a=>a.owner==='any'||a.owner===self):[];
    const productionReviews=admin?await Promise.all(accounts.filter(m=>m.productionRequests?.[productionId]).map(async m=>({id:m.id,name:m.name,role:assignments(m)[productionId]?.role||findProfile(m,productionId)?.role||'',credits:m.proposedCredits?.[productionId]||assignments(m)[productionId]||{},requestId:m.productionRequests[productionId],...await reviewProfile(m)}))):[];
    const tracking=admin?await get('mail-status/tracking'):null,mailTracking=tracking?.blocked?{status:tracking.status}:null;
    const pendingPeople=admin?await Promise.all((await globalRecords('portal-pending/')).filter(p=>!p.archived).map(async p=>{
      const member=allAccounts.find(m=>m.id===(p.memberId||p.id)),activated=!!member?.email&&!!await get('passwords/'+member.id);
      return {id:p.id,name:member?.name||p.name,profileId:member?.id||p.id,productions:member?Object.keys(assignments(member)):p.productions||[],created:p.created,updated:p.updated,...(member?.email?{memberId:member.id,archived:false}:{}),activated,status:member?.email?(member.revoked?'Access revoked':activated?'Account created':'Invitation pending'):'Email needed'};
    })):[];
    return json({pendingPeople,unassignedProfiles:admin?rows.filter(row=>!Object.keys(assignments(row)).length).map(({ticket,...row})=>({...row,practice:practiceName(row.name)})):[],agreementCycle:AGREEMENT_CYCLE,unassigned:admin?await Promise.all(accounts.filter(m=>!Object.keys(assignments(m)).length).map(async m=>({id:m.id,name:m.name,needsEmail:!m.email,pendingPersonId:m.pendingPersonId,activated:!!m.email&&!!await get('passwords/'+m.id)}))):[],productionReviews,productionChoices:productions,waiting,productionId,productions:admin?productions:productions.filter(p=>memberProductions[p.id]),revokedAccounts:admin?allAccounts.filter(m=>m.revoked).map(m=>({id:m.id,name:m.name,keepPublic:m.keepPublic,productions:assignments(m),publication:m.publication||{}})):[],accounts:admin?accounts.map(m=>({id:m.id,name:m.name,needsEmail:!m.email,pendingPersonId:m.pendingPersonId,productions:assignments(m)})):[],agreementReady:!!await store.getMetadata('contract/master'),agreementSupported:true,welcome:await get('settings/welcome'),welcomePlayed:!!await get('welcome-played/'+self),catalog:adminCatalog,admin,self,film,passwordSet:!!await get('passwords/'+self),mailReady:production&&mailReady(),mailTracking,mailLog:admin?(await list('mail-log/')).filter(Boolean).sort((a,b)=>b.updated-a.updated).slice(0,30).map(row=>mailTracking&&/^Delivery status unavailable/.test(row.error||'')?{...row,error:null}:row):[],mailQueue:admin?(await list('outbox/')).filter(Boolean).map(({to,subject,attempts,nextAttempt,lastError})=>({to,subject,attempts,nextAttempt,lastError})):[],members:rows.filter(row=>!admin||assignments(row)[productionId]).map(({ticket,...row})=>({...row,practice:practiceName(row.name)})),resources:(await list('resources/')).filter(canReadResource).map(r=>admin?r:({...r,audience:undefined})).sort((a,b)=>b.created-a.created),test:!(production&&process.env.HMF_SIGNWELL_LIVE==='yes')});
  }
  if((action==='invite'||action==='resend')&&post){
    onlyAdmin();requireThat(production&&mailReady(),'Invitation email is awaiting sender setup. No invitation was sent.',503);
    let m,pending,invitationLease,contact;
    try{
      if(action==='invite'){
        const address=email(body.email),accounts=await globalRecords('members/');
        requireThat(!accounts.some(m=>active(m)&&m.email===address),'This person already has an account. Use Manage production assignments to add another production.',409);
        if(body.pendingId){
          requireThat(uuid.test(body.pendingId),'Invalid saved person.');
          const key=pendingKey(body.pendingId),record=await rawStore.getWithMetadata(key,{type:'json'}),person=record?.data;
          requireThat(person,'Saved person unavailable.',404);
          contact=accounts.find(m=>m.id===person.id);
          requireThat(!person.archived||active(contact)&&contact.pendingContact&&!contact.email,'Saved person unavailable.',404);
          requireThat(!person.memberId&&!contact?.email,'An invitation already exists for this person. Refresh and use Resend invitation if needed.',409);
          requireThat(!contact||contact.pendingContact&&!contact.revoked,'This saved person is unavailable for invitation.',409);
          requireThat(!(person.inviteLeaseUntil>Date.now()),'An invitation is already being prepared for this person. Refresh before retrying.',409);
          requireThat(!accounts.some(m=>active(m)&&m.id!==person.id&&normalizePendingName(m.name)===normalizePendingName(person.name)),'An active portal account already exists under this name. Open that person’s profile instead.',409);
          invitationLease=token();
          const reserved=await rawStore.setJSON(key,{...person,inviteLeaseToken:invitationLease,inviteLeaseUntil:Date.now()+120000},{onlyIfMatch:record.etag});
          requireThat(reserved.modified,'This saved person changed or is already being invited. Refresh before trying again.',409);
          pending=person;
        }
        const hex=hash(address),index='active-email/'+hex;
        // A saved person keeps the same private identity when invited later.
        m={...contact,id:pending?.id||randomUUID(),email:address,name:pending?.name||string(body.name),role:contact?.role||'',generalInvite:true,productions:contact?.productions||{},...(pending?{pendingContact:false,pendingPersonId:pending.id}:{})};
        if(body.filmProfile&&!pending){const base=entry(body.filmProfile);requireThat(base,'Unknown film profile.');m.profileLinks={[productionId]:base.id};}
        const reserved=await store.setJSON(index,{id:m.id},{onlyIfNew:true});
        if(!reserved.modified){const owner=await get(index);requireThat(pending&&owner?.id===m.id,'An invitation already exists.',409);}
        try{
          const existing=await store.getWithMetadata('members/'+m.id,{type:'json'});
          if(existing){
            requireThat(pending&&existing.data.pendingContact&&!existing.data.email&&!existing.data.revoked,'An account already exists for this saved person. Refresh and use Resend invitation.',409);
            m={...existing.data,email:address,name:pending.name,pendingContact:false,pendingPersonId:pending.id,generalInvite:true};
          }
          const saved=await store.setJSON('members/'+m.id,m,existing?{onlyIfMatch:existing.etag}:{onlyIfNew:true});
          requireThat(saved.modified,'This person’s profile changed. Refresh before inviting them.',409);
        }catch(error){if(!await get('members/'+m.id))await store.delete(index);throw error;}
        if(pending){
          const key=pendingKey(pending.id),record=await rawStore.getWithMetadata(key,{type:'json'});
          requireThat(record?.data?.inviteLeaseToken===invitationLease,'This saved person changed. Refresh before continuing.',409);
          const {inviteLeaseToken,inviteLeaseUntil,...person}=record.data;
          const saved=await rawStore.setJSON(key,{...person,memberId:m.id,archived:false,updated:Date.now()},{onlyIfMatch:record.etag});
          requireThat(saved.modified,'The invitation record changed. Refresh and use Resend invitation if needed.',409);
        }
      }else m=await target();
      requireThat(m.email,'Add an email address before sending an invitation.',409);
      requireThat(!await get('passwords/'+m.id),'This person already has a password.');
      const ticket=token(),expires=Date.now()+7*86400000;
      await set('tickets/'+hash(ticket),{id:m.id,expires});
      const current=await store.getWithMetadata('members/'+m.id,{type:'json'});
      requireThat(current?.data?.email===m.email,'This person’s profile changed. Refresh before inviting them.',409);
      requireThat((await store.setJSON('members/'+m.id,{...current.data,ticket:hash(ticket)},{onlyIfMatch:current.etag})).modified,'This person’s profile changed. Refresh and use Resend invitation.',409);await invalidate();
      await enqueue(store,m,'invite/'+hash(ticket),'Heidi Mikac Films — your cast & crew invitation','Hi '+m.name+',\n\nCreate your cast and crew account, choose your productions, and add your biography, headshot and credits here:\n'+portalUrl+'#invite='+ticket+'\n\nThis invitation expires in seven days.',expires);
      return json({ok:true});
    }catch(error){
      if(pending&&invitationLease){
        const key=pendingKey(pending.id),record=await rawStore.getWithMetadata(key,{type:'json'});
        if(record?.data?.inviteLeaseToken===invitationLease){
          const {inviteLeaseToken,inviteLeaseUntil,...person}=record.data,member=await get('members/'+pending.id);
          await rawStore.setJSON(key,{...person,...(member?.email?{memberId:member.id,archived:false}:{}),updated:Date.now()},{onlyIfMatch:record.etag});
        }
      }
      throw error;
    }
  }

  async function reviewProfile(m){
    const [draft,image]=await Promise.all([get('profiles/'+m.id),store.getMetadata('photos/'+m.id)]);
    const fallback=sharedBase(m),bio=m.draftProfile?.bio??draft?.bio??fallback?.bio??'';
    const imageVersion=m.draftProfile?.imageVersion||'';
    const photo=imageVersion||image?'uploaded':fallback?.photo||'';
    const publicImage=photo==='uploaded'?'https://heidimikacfilms.com/.netlify/functions/portal?action=memberPhoto&id='+m.id+'&v='+(imageVersion||image.metadata?.version||'original'):photo;
    return {bio,photo,imageVersion,publicImage,revision:hash(JSON.stringify([bio,imageVersion||image?.etag||photo]))};
  }
  async function saveDraft(change){
    const key='members/'+uid;
    for(let attempt=0;attempt<4;attempt++){
      const rec=await store.getWithMetadata(key,{type:'json'}),m=rec?.data;
      requireThat(active(m),'Account unavailable.',403);
      const pending={...m.productionRequests};
      if(!practiceName(m.name))for(const pid of Object.keys(assignments(m)))pending[pid]??=randomUUID();
      const updated={...m,draftProfile:{...m.draftProfile,...change},productionRequests:pending};
      if((await store.setJSON(key,updated,{onlyIfMatch:rec.etag})).modified)return;
    }
    requireThat(false,'Your profile changed. Please save again.',409);
  }
  if(action==='requestProductions'&&post){
    requireThat(!admin,'Use a cast or crew account.',403);
    const record=await store.getWithMetadata('members/'+self,{type:'json'}),m=record?.data;
    requireThat(active(m),'Account unavailable.',403);allowPublicProfile(m);
    requireThat(Array.isArray(body.selections)&&body.selections.every(id=>productions.some(p=>p.id===id)),'Choose valid productions.');
    const pending={},proposed={};
    for(const id of new Set([...Object.keys(assignments(m)),...body.selections])){
      const existing=assignments(m)[id],prior=m.proposedCredits?.[id]||existing||{};
      const value=credits(body.credits?.[id]||prior);
      const changed=JSON.stringify(value)!==JSON.stringify(credits(prior));
      if(!existing||changed||m.productionRequests?.[id]){
        pending[id]=changed?randomUUID():m.productionRequests?.[id]||randomUUID();
        proposed[id]=value;
      }
    }
    requireThat((await store.setJSON('members/'+self,{...m,proposedCredits:proposed,productionRequests:pending},{onlyIfMatch:record.etag})).modified,'Your assignments changed. Reload and try again.',409);
    return json({ok:true});
  }
  if(action==='reviewProduction'&&post){
    onlyAdmin();requireThat(uuid.test(uid),'Invalid member.');
    const record=await store.getWithMetadata('members/'+uid,{type:'json'}),m=record?.data;
    requireThat(active(m)&&m.productionRequests?.[productionId]&&m.productionRequests[productionId]===body.requestId,'This request changed. Reload the portal.',409);
    const pending={...m.productionRequests};delete pending[productionId];
    let next={...m,productionRequests:pending,proposedCredits:{...m.proposedCredits}};delete next.proposedCredits[productionId];
    if(body.decision==='approve'){
      allowPublicProfile(m);
      const profile=await reviewProfile(m);
      requireThat(profile.revision===body.revision,'Review the latest saved biography and headshot before approval.',409);
      const fields=credits(body),role=creditLine(fields)||((body.clearLegacy||'character' in (assignments(m)[productionId]||{}))?'':body.role||assignments(m)[productionId]?.role||''),base=findProfile(m,productionId);
      if(base)requireThat(!(await list('members/')).some(other=>active(other)&&other.id!==uid&&assignments(other)[productionId]&&findProfile(other,productionId)?.id===base.id),'This production profile is already assigned to someone else.',409);
      const previous=assignments(m)[productionId];
      next.productions={...assignments(m),[productionId]:{...previous,...fields,role,filmProfile:previous?.filmProfile||''}};
      next.approvedProfiles={...m.approvedProfiles,[productionId]:{bio:profile.bio,photo:profile.publicImage,imageVersion:profile.imageVersion}};
      next.publication={...m.publication,[productionId]:m.publication?.[productionId]!==false};
    }else requireThat(body.decision==='decline','Choose an approval decision.');
    requireThat((await store.setJSON('members/'+uid,next,{onlyIfMatch:record.etag})).modified,'The request changed. Reload and try again.',409);
    await invalidate();return json({ok:true});
  }
  if(action==='enrollments'&&post){
    onlyAdmin();const m=await target();
    requireThat(Array.isArray(body.productions)&&body.productions.every(id=>catalogs[id]),'Choose valid productions.');
    const next={};
    for(const id of new Set(body.productions)){
      const role=(body.roles?.[id]||'').trim().slice(0,240);
      const base=findProfile(m,id);
      if(base)requireThat(!(await list('members/')).some(other=>active(other)&&other.id!==m.id&&assignments(other)[id]&&findProfile(other,id)?.id===base.id),'This film profile is already assigned to another account.',409);
      const prev=assignments(m)[id];next[id]={...prev,...(prev&&prev.role!==role?{character:'',crewTitle:role}:{}),role,filmProfile:base?.id||''};
    }
    const requests={...m.productionRequests};for(const pid of Object.keys(next))if(m.generalInvite&&!m.approvedProfiles?.[pid])requests[pid]??=randomUUID();
    await set('members/'+m.id,{...m,productions:next,productionRequests:requests,profileLinks:{...m.profileLinks,...Object.fromEntries(Object.entries(assignments(m)).filter(([,value])=>value.filmProfile).map(([id,value])=>[id,value.filmProfile])),...Object.fromEntries(Object.entries(next).filter(([,value])=>value.filmProfile).map(([id,value])=>[id,value.filmProfile]))}});await invalidate();return json({ok:true});
  }
  if(action==='linkProfile'&&post){
    onlyAdmin();const m=await target();allowPublicProfile(m);const base=entry(body.filmProfile);requireThat(base&&!assignments(m)[productionId]?.filmProfile,'Choose an unlinked member and a valid film profile.');
    requireThat(!(await list('members/')).some(x=>active(x)&&assignments(x)[productionId]?.filmProfile===base.id),'Profile already linked.');
    await set('members/'+uid,{...m,...(productionId==='written-in-the-dark'?{filmProfile:base.id}:{}),productions:{...assignments(m),[productionId]:{...assignments(m)[productionId],filmProfile:base.id}}});await invalidate();return json({ok:true});
  }
  if(action==='publishProfile'&&post){
    requireThat(productionId==='written-in-the-dark','Profiles now synchronize automatically.');
    onlyAdmin();const m=await target(),base=findProfile(m,productionId);allowPublicProfile(m);requireThat(base,'Link the film profile first.');
    const previous=await get('published/'+base.id);
    const draft=await get('profiles/'+uid), image=await store.getWithMetadata('photos/'+uid,{type:'arrayBuffer'});
    requireThat(draft||image,'No submitted changes to publish.');
    let photo=previous?.photo||base.photo;
    if(image){const version=hash(Buffer.from(image.data));await store.set('public-images/'+version,image.data,{metadata:{mime:image.metadata.mime}});photo='https://heidimikacfilms.com/.netlify/functions/portal?action=publicPhoto&id='+version;}
    await set('published/'+base.id,{id:base.id,bio:draft?.bio??previous?.bio??base.bio,photo});await invalidate();return json({ok:true});
  }
  if(action==='task'&&post){
    onlyAdmin();const m=await target(),id=randomUUID(),title=string(body.title);
    await set('tasks/'+uid+'/'+id,{id,title,done:false});
    await notify(m,productionId+'/'+id,'New production task','You have a new task for '+film+'.');return json({ok:true});
  }
  if(action==='adminTask'&&post){
    onlyAdmin();const owner=body.owner;requireThat(['Nick','Heidi','any'].includes(owner),'Select an administrator.');
    const id=randomUUID();await set('tasks/'+owner+'/'+id,{id,title:string(body.title,160),done:false});return json({ok:true});
  }
  if(action==='finishAdminTask'&&post){
    onlyAdmin();requireThat((body.owner===self||body.owner==='any')&&uuid.test(body.task),'Invalid task.');
    const key='tasks/'+body.owner+'/'+body.task,t=await get(key);requireThat(t,'Task unavailable.');
    await set(key,{...t,done:true});return json({ok:true});
  }
  if(action==='trackPaperwork'&&post){
    onlyAdmin();const member=await target();requireThat(active(member),'Member unavailable.',404);
    const document=body.document||'agreement';
    let key=manualAgreementKey(productionId,uid);
    if(document!=='agreement'){
      requireThat(uuid.test(document),'Invalid document.');
      const resource=await get('resources/'+document);
      requireThat(resource?.type==='PDF'&&(!resource.audience||resource.audience.includes(uid)),'Document unavailable for this member.',404);
      key=resourceTrackingKey(productionId,uid,document);
    }
    const reason=normalizePaperworkReason(body.reason);
    requireThat(body.reason==='reopen'||reason,'Choose Complete, Document N/A, or Reopen.');
    if(body.reason==='reopen')await rawStore.delete(key);else await rawStore.setJSON(key,{document,reason,by:self,at:Date.now(),...(document==='agreement'?{agreementCycle:AGREEMENT_CYCLE}:{})});
    if(document==='agreement'&&reason){
      // Suppress exact, already queued portal notices from the earlier build.
      // SignWell's independent request and signed bytes remain untouched.
      const agreement=await get('agreements/'+uid),agreementKey=currentAgreementKey(productionId,uid);
      const events=[agreementKey+'/prepare/initial',agreementKey+'/prepare/'+(agreement?.created||'initial')];
      if(agreement){events.push(agreementKey+'/'+(agreement.id||agreement.created)+'/review');if(agreement.id)events.push(agreementKey+'/countersign/'+agreement.id,agreementKey+'/countersign/'+agreement.id+'/'+COUNTERSIGN_EMAIL,agreementKey+'/send/'+agreement.id);}
      const notices=[...['Nick','Heidi'].flatMap(id=>events.map(event=>[id,event]))];
      if(agreement?.id)notices.push([uid,agreement.id],['Heidi','countersign-'+agreement.id]);
      for(const [id,event] of notices){
        const noticeKey='outbox/'+hash(id+'/'+event),notice=await rawStore.get(noticeKey,{type:'json'});
        if(notice?.agreementCycle===AGREEMENT_CYCLE&&['Waiting on you · Heidi Mikac Films','Document ready for signature','Agreement ready for your signature'].includes(notice.subject))await rawStore.delete(noticeKey);
      }
    }
    return json({ok:true});
  }
  if(action==='finishTask'&&post){
    await target();requireThat(uuid.test(body.task),'Invalid task.');
    const key='tasks/'+uid+'/'+body.task,item=await get(key);requireThat(item,'Task unavailable.');
    await set(key,{...item,done:true});return json({ok:true});
  }
  if(action==='revoke'&&post){onlyAdmin();const m=await target();await set('members/'+uid,{...m,revoked:true,revokedAt:Date.now(),keepPublic:body.keepPublic===true});if(m.email)await store.delete('active-email/'+hash(m.email));await invalidate();return json({ok:true});}
  if(action==='publication'&&post){onlyAdmin();const m=await target();if(body.visible)allowPublicProfile(m);await set('members/'+uid,{...m,...(m.revoked&&body.visible?{keepPublic:true}:{}),publication:{...m.publication,[productionId]:body.visible===true}});await invalidate();return json({ok:true});} 
  if(action==='bio'&&post){
    await target();requireThat(typeof body.bio==='string'&&body.bio.length<=5000,'Bio limit is 5,000 characters.');
    await saveDraft({bio:body.bio.trim()});return json({ok:true});
  }
  if(['photo','resource','master'].includes(action)&&post){
    if(action==='photo')await target();else onlyAdmin();

    const bytes=Buffer.from(await req.arrayBuffer());
    requireThat(bytes.length>0&&bytes.length<=4*1024*1024,'Choose a file up to 4 MB.');
    const jpeg=bytes.subarray(0,3).toString('hex')==='ffd8ff',png=bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a';
    if(action==='photo'){requireThat(jpeg||png,'Choose a JPG or PNG.');try{await sharp(bytes,{limitInputPixels:40000000}).metadata();}catch{requireThat(false,'This image could not be read. Choose another JPG or PNG.');}await store.set('profile-images/'+uid+'/'+hash(bytes),bytes,{metadata:{version:hash(bytes),filename:(url.searchParams.get('filename')||'').split(/[\\/]/).pop().slice(0,255),mime:jpeg?'image/jpeg':'image/png'}});await saveDraft({imageVersion:hash(bytes)});}
    else if(action==='master'){requireThat(hash(bytes)===(productionId==='written-in-the-dark'?'8437469c10b4a2ebd322adb8fd4c4e246abb2a0e26043a7c4129dffee92e6626':'0777d2cf63f99e584091be91442d9c77f8fe835e738c56308e82c328a49a2be8'),'Choose the approved contract master for this production.');await store.set('contract/master',bytes);}
    else {requireThat(bytes.subarray(0,5).toString()==='%PDF-','Choose a PDF.');const group=await recipients(url.searchParams.get('audience'),url.searchParams.getAll('recipient'));const id=randomUUID(),title=string(url.searchParams.get('title'));await store.set('files/'+id,bytes);await set('resources/'+id,{id,title,audience:group.audience,type:'PDF',created:Date.now()});await Promise.all(group.recipients.map(m=>notify(m,id,'New production file','Production posted a new file for '+film+'.')));}
    return json({ok:true});
  }
  if(action==='notice'&&post){onlyAdmin();const group=await recipients(body.audience,body.recipients);const id=randomUUID();await set('resources/'+id,{id,title:string(body.title),text:string(body.text,5000),audience:group.audience,type:'Update',created:Date.now()});await Promise.all(group.recipients.map(m=>notify(m,id,'New production message','You have a new message from production.')));return json({ok:true});}
  if(action==='removeResource'&&post){
    onlyAdmin();requireThat(uuid.test(uid),'Invalid message or file.');
    const resource=await get('resources/'+uid);requireThat(resource,'This message or file was already removed.',404);
    // The board entry goes first so nobody can open the file while the rest is cleared.
    await store.delete('resources/'+uid);
    if(resource.type==='PDF')await store.delete('files/'+uid);
    const accounts=(await list('members/')).filter(Boolean);
    await Promise.all(accounts.flatMap(m=>[
      // Unsent notices about it are withdrawn; delivered email cannot be recalled.
      rawStore.delete('outbox/'+hash(m.id+'/'+uid)),
      rawStore.delete(resourceTrackingKey(productionId,m.id,uid))
    ]));
    return json({ok:true,removed:resource.type});
  }
  if(action==='photo'||action==='resource'){
    let resource=null;
    if(action==='photo')await target();else{resource=uuid.test(uid)?await get('resources/'+uid):null;requireThat(canReadResource(resource)&&resource.type==='PDF','File unavailable.',404);}
    const version=action==='photo'?(await get('members/'+uid))?.draftProfile?.imageVersion:null;
    const r=await store.getWithMetadata(version?'profile-images/'+uid+'/'+version:(action==='photo'?'photos/':'files/')+uid,{type:'arrayBuffer'});
    requireThat(r,'File unavailable.',404);return new Response(r.data,{headers:{...headers,'Content-Type':r.metadata?.mime||'application/pdf','Content-Disposition':action==='photo'?'inline':attachment(resource.title)}});
  }
  if(action==='agreement'&&post){

    onlyAdmin();const m=await target(),t={};
    requireThat(body.preview||m.email,'Add an email address and invite this person before sending a contract.',409);
    requireThat(active(m),'Member unavailable.',404);
    requireThat(body.preview||!await readAgreementTracking(rawStore,productionId,uid),'Reopen this agreement requirement before sending a contract.',409);

    const fields=credits(body);t.character=creditLine(fields);
    requireThat(t.character&&t.character.length<=120,'Enter a character or crew title for this agreement (120 characters total).');
    for(const k of ['legal','credit','rate','date'])t[k]=string(body[k],120);
    requireThat(/^\d{1,5}(\.\d{1,2})?$/.test(t.rate),'Enter a daily rate.');
    requireThat(/^\d{4}-\d{2}-\d{2}$/.test(t.date)&&!Number.isNaN(Date.parse(t.date))&&new Date(t.date).toISOString().slice(0,10)===t.date,'Enter a valid agreement date.');
    const heidi=COUNTERSIGN_EMAIL;
    requireThat(heidi!==m.email,'The signer and the countersigner need separate email addresses.');
    const master=await store.get('contract/master',{type:'arrayBuffer'});requireThat(master,'Upload the private agreement master first.');
    const bytes=await packet(master,t);
    const memberKey='members/'+uid,record=await store.getWithMetadata(memberKey,{type:'json'}),current=record?.data;
    requireThat(active(current)&&assignments(current)[productionId]&&JSON.stringify(assignments(current)[productionId])===JSON.stringify(assignments(m)[productionId]),'Credits changed. Reload before drafting.',409);
    const updated={...current,productions:{...assignments(current),[productionId]:{...assignments(current)[productionId],...fields,role:t.character}}};
    if(current.productionRequests?.[productionId]){
      updated.proposedCredits={...current.proposedCredits,[productionId]:fields};
      updated.productionRequests={...current.productionRequests,[productionId]:randomUUID()};
    }
    requireThat((await store.setJSON(memberKey,updated,{onlyIfMatch:record.etag})).modified,'Member updated. Reload before drafting.',409);
    await invalidate();
    if(body.preview)return new Response(bytes,{headers:{...headers,'Content-Type':'application/pdf'}});
    requireThat(process.env.SIGNWELL_API_KEY,'Signing setup required.',503);
    const key='agreements/'+uid;
    const existing=await store.getWithMetadata(key,{type:'json'});
    const lock=await store.setJSON(key,{cycle:AGREEMENT_CYCLE,status:'Preparing — check SignWell before retrying',created:Date.now(),recipientEmail:heidi,name:film+' — '+t.legal+' · '+AGREEMENT_CYCLE},existing?.data?.cleared?{onlyIfMatch:existing.etag}:{onlyIfNew:true});
    requireThat(lock.modified,'An agreement already exists or is being prepared.',409);
    let d;try{
      // The cycle-specific reservation allows one current request per person and film.

      d=await signwell('documents/',{test_mode:!(production&&process.env.HMF_SIGNWELL_LIVE==='yes'),name:film+' — '+t.legal+' · '+AGREEMENT_CYCLE,files:[{name:'Agreement.pdf',file_base64:bytes.toString('base64')}],recipients:[{id:'1',name:t.legal,email:m.email,send_email:true},{id:'2',name:'Heidi Mikac',email:heidi,send_email:true}],apply_signing_order:true,embedded_signing:true,text_tags:true});
    }catch(e){await set(key,{cycle:AGREEMENT_CYCLE,status:'Needs recovery — check SignWell',created:Date.now(),recipientEmail:heidi,name:film+' — '+t.legal+' · '+AGREEMENT_CYCLE});throw e;}
    await set(key,{id:d.id,cycle:AGREEMENT_CYCLE,status:documentStatus(d),providerStatus:String(d.status||'').toLowerCase(),testMode:!(production&&process.env.HMF_SIGNWELL_LIVE==='yes'),name:film+' — '+t.legal+' · '+AGREEMENT_CYCLE,recipientEmail:heidi,created:Date.now(),checkedAt:Date.now()});
    if(documentStatus(d)!=='Draft ready to send')await notify(m,d.id,'Document ready for signature','Your new agreement is ready to review and sign.',AGREEMENT_CYCLE);return json({ok:true});
  }
  if(action==='sendAgreement'&&post){
    onlyAdmin();const member=await target();requireThat(active(member),'Member unavailable.',404);
    requireThat(member.email,'Add an email address and invite this person before sending a contract.',409);
    requireThat(!await readAgreementTracking(rawStore,productionId,uid),'Reopen this agreement requirement before sending a contract.',409);
    const key='agreements/'+uid,record=await store.getWithMetadata(key,{type:'json'}),agreement=record?.data;
    requireThat(agreement?.id&&agreement.cycle===AGREEMENT_CYCLE&&body.documentId===agreement.id,'This agreement changed. Reload the profile before sending.',409);
    requireThat(!(agreement.sendLeaseUntil>Date.now()),'This agreement is already being sent. Refresh its status before retrying.',409);
    const draft=await signwell('documents/'+encodeURIComponent(agreement.id)+'/');
    const providerStatus=String(draft.status||'').trim().toLowerCase();
    requireThat(['created','draft'].includes(providerStatus),'This agreement has already been sent or is no longer a draft. Refresh its status.',409);
    const recipients=draft.recipients||[],recipientEmail=agreement.recipientEmail||COUNTERSIGN_EMAIL;
    requireThat(draft.name?.startsWith(film+' — ')&&draft.name.endsWith(' · '+AGREEMENT_CYCLE)&&(!agreement.name||draft.name===agreement.name)&&recipients.length===2&&recipients.some(r=>String(r.id)==='1'&&r.email?.toLowerCase()===member.email.toLowerCase())&&recipients.some(r=>String(r.id)==='2'&&r.email?.toLowerCase()===recipientEmail.toLowerCase()),'The draft does not match this person and production.',409);
    requireThat(!recipients.some(r=>r.signed_at||['signed','completed'].includes(String(r.status||'').toLowerCase())),'A signed document cannot be sent as a new draft.',409);
    const testMode=!(production&&process.env.HMF_SIGNWELL_LIVE==='yes');
    requireThat((typeof draft.test_mode!=='boolean'||draft.test_mode===testMode)&&(typeof agreement.testMode!=='boolean'||agreement.testMode===testMode),'This draft uses a different signing mode. Review it in SignWell before sending.',409);
    const sendLeaseUntil=Date.now()+120000;
    const lease=await store.setJSON(key,{...agreement,sendLeaseUntil},{onlyIfMatch:record.etag});
    requireThat(lease.modified,'The agreement changed or is already being sent. Refresh before retrying.',409);
    if(await readAgreementTracking(rawStore,productionId,uid)){
      const latest=await store.getWithMetadata(key,{type:'json'});
      if(latest?.data?.id===agreement.id&&latest.data.sendLeaseUntil===sendLeaseUntil)await store.setJSON(key,{...latest.data,sendLeaseUntil:0},{onlyIfMatch:latest.etag});
      requireThat(false,'Reopen this agreement requirement before sending a contract.',409);
    }
    let sent;
    try{
      sent=await signwell('documents/'+encodeURIComponent(agreement.id)+'/send',{test_mode:testMode,apply_signing_order:true,embedded_signing:true});
    }catch(error){
      const latest=await store.getWithMetadata(key,{type:'json'});
      if(latest?.data?.id===agreement.id)await store.setJSON(key,{...latest.data,status:'Send status unknown — check SignWell',providerStatus:null,syncError:'Refresh the agreement status before attempting another send.'},{onlyIfMatch:latest.etag});
      throw error;
    }
    requireThat(!sent.id||sent.id===agreement.id,'SignWell returned a different document. Review its status before continuing.',502);
    const latest=await store.getWithMetadata(key,{type:'json'});
    requireThat(latest?.data?.id===agreement.id,'The agreement changed. Reload its status.',409);
    const status=documentStatus(sent);
    const saved=await store.setJSON(key,{...latest.data,status,providerStatus:String(sent.status||'sent').toLowerCase(),testMode,checkedAt:Date.now(),sendLeaseUntil:0,syncError:null},{onlyIfMatch:latest.etag});
    requireThat(saved.modified,'The request was sent. Refresh the profile to see its latest status.',409);
    if(status!=='Draft ready to send')await notify(member,agreement.id,'Document ready for signature','Your new agreement is ready to review and sign.',AGREEMENT_CYCLE);
    return json({ok:true,status});
  }
  if(action==='recoverAgreement'&&post){
    onlyAdmin();const m=await target(),key='agreements/'+uid,rec=await store.getWithMetadata(key,{type:'json'});
    requireThat(rec?.data&&!rec.data.id,'No interrupted request to recover.');
    if(body.documentId){
      const id=string(body.documentId);requireThat(uuid.test(id),'Enter the SignWell document ID.');
      const d=await signwell('documents/'+id+'/');
      const previous=await rawStore.get(legacyScoped('agreements/'+uid),{type:'json'});
      const previousOffline=profile=>rawStore.get(offlineSigningKey(profile,productionId),{type:'json'});
      const profileId=findProfile(m,productionId)?.id;
      const legacy=profileId?await previousOffline(profileId):null;
      requireThat(id!==previous?.id&&id!==legacy?.id,'Choose the new agreement, not a previous signing request.',409);
      requireThat(d.name===rec.data.name&&d.name.endsWith(' · '+AGREEMENT_CYCLE),'The recovery document must belong to the new agreement round.',409);
      requireThat(d.name?.startsWith(film+' — ')&&d.recipients?.some(r=>String(r.id)==='1'&&r.email?.toLowerCase()===m.email)&&d.recipients?.some(r=>String(r.id)==='2'&&r.email?.toLowerCase()===(rec.data.recipientEmail||process.env.HMF_HEIDI_SIGNING_EMAIL||'heidi@heidimikacfilms.com').toLowerCase()),'Document does not match this person and production.');
      requireThat((await store.setJSON(key,{id,cycle:AGREEMENT_CYCLE,name:d.name,recipientEmail:rec.data.recipientEmail||COUNTERSIGN_EMAIL,...(typeof d.test_mode==='boolean'?{testMode:d.test_mode}:{}),created:rec.data.created,status:documentStatus(d),providerStatus:String(d.status||'').toLowerCase(),checkedAt:Date.now()},{onlyIfMatch:rec.etag})).modified,'Record changed; reload.');
    }else{
      requireThat(body.confirmAbsent===true,'Check SignWell and confirm no document exists first.');
      requireThat(Date.now()-(rec.data.created||0)>600000,'Wait ten minutes after the interrupted request before clearing it.');
      await set('agreement-history/'+uid+'/'+token(),rec.data);
      requireThat((await store.setJSON(key,{...rec.data,status:'Cleared after SignWell review',cleared:true},{onlyIfMatch:rec.etag})).modified,'Record changed; reload.');
    }
    return json({ok:true});
  }
  if(action==='status'){
    await target();
    const tracking=await readAgreementTracking(rawStore,productionId,uid);
    const key='agreements/'+uid,record=await store.getWithMetadata(key,{type:'json'}),a=record?.data;
    requireThat(a?.id,'No new signing request has been prepared yet.');
    requireThat(url.searchParams.get('document')===a.id,'This agreement changed. Reload the portal before opening it.',409);
    if(a.status==='Complete')return json({status:'Complete',paperworkStatus:manualPaperworkStatus(tracking)||'Complete',url:null});
    const d=await signwell('documents/'+encodeURIComponent(a.id)+'/');
    const [actor,producer]=['1','2'].map(id=>d.recipients?.find(r=>String(r.id)===id));
    const status=documentStatus(d);
    const saved=await store.setJSON(key,{...a,status,providerStatus:String(d.status||'').toLowerCase(),...(typeof d.test_mode==='boolean'?{testMode:d.test_mode}:{}),checkedAt:Date.now(),syncError:null},{onlyIfMatch:record.etag});
    if(!saved.modified){const latestStatus=(await get(key))?.status||status,latestTracking=await readAgreementTracking(rawStore,productionId,uid);return json({status:latestStatus,paperworkStatus:manualPaperworkStatus(latestTracking)||latestStatus,url:null});}
    // The countersignature is Heidi's alone: no other session, admin or not, receives her signing link.
    const signer=admin?(self==='Heidi'&&status==='Waiting on Heidi'?producer:null):(status==='Waiting on actor'?actor:null);
    const latestTracking=await readAgreementTracking(rawStore,productionId,uid);
    return json({status,paperworkStatus:manualPaperworkStatus(latestTracking)||status,url:latestTracking?null:signer?.embedded_signing_url||null});
  }
  return json({error:'Unknown action.'});
 }catch(e){return Response.json({error:e.status?e.message:'The request could not be completed.'},{status:e.status||500,headers});}
}



