import {COUNTERSIGN_EMAIL} from '../lib/signing.mjs';
import {adminActions} from '../lib/admin-actions.mjs';
import {begin as beginCalendar,events as calendarEvents} from './calendar-callback.mjs';
import sharp from 'sharp';
import {signwell,documentStatus,refreshAgreement,completedAgreementPdf} from '../lib/signing.mjs';
import {offlineSigningKey,prepareOfflineCountersign,refreshOfflineCountersign} from '../lib/offline-signing.mjs';
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
const assignments=m=>m.productions??{'written-in-the-dark':{role:m.role,filmProfile:m.filmProfile||''}};
const findProfile=(m,productionId)=>{
 const assigned=assignments(m)[productionId];
 const rows=catalogs[productionId];
 return rows.find(x=>x.id===(assigned?.filmProfile||m.profileLinks?.[productionId]||(productionId==='written-in-the-dark'?m.filmProfile:'')))||rows.find(x=>normalizeName(x.name)===normalizeName(m.name));
};
const sharedBase=m=>darkCatalog.find(x=>x.id===m.filmProfile)||Object.keys(assignments(m)).map(id=>findProfile(m,id)).find(Boolean);

const uuid = /^[a-f0-9-]{36}$/;
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
const offlineSigningSummary=agreement=>agreement?Object.fromEntries(['id','status','providerStatus','sourceChanged','syncError','testMode','createdAt','checkedAt'].map(key=>[key,agreement[key]])):null;
function signingUrl(value){
  if(typeof value!=='string')return null;
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(u.hostname==='signwell.com'||u.hostname.endsWith('.signwell.com'))?u.href:null;}catch{return null;}
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
  write(pages[0],51,526.6,489,"Actor's services shall be rendered during principal photography scheduled to begin on "+terms.start+".",white);
  write(pages[1],51,270.8,131,terms.credit,white);
  write(pages[1],310,383.3,150,terms.legal,white);
  for(const [x,top,field] of [[310,414,'s:1:y'],[310,457,'af_n:1:y'],[310,500,'af_d_s:1:y'],[52,414,'s:2:y'],[52,500,'af_d_s:2:y']]) {
    pages[1].drawText('{{'+field+'          }}',{x,y:pages[1].getHeight()-top,size:12,font,color:white});
  }
  return Buffer.from(await doc.save());
}
export default async function handle(req) {
 try {
  const url=new URL(req.url), action=url.searchParams.get('action')||'home';
  const production=['heidimikacfilms.com','www.heidimikacfilms.com'].includes(url.hostname);
  let productionId=url.searchParams.get('production')||'written-in-the-dark';
  requireThat(catalogs[productionId],'Unknown production.');
  const rawStore=getStore({name:production?'hmf-members-v1':'hmf-preview-'+(process.env.DEPLOY_ID||'local'),consistency:'strong'});
  // Preserve all existing Written in the Dark keys; isolate other productions' paperwork and resources.
  const scoped=key=>productionId!=='written-in-the-dark'&&/^(tasks|agreements|agreement-history|resources|files|offline|offline-history|contract)\//.test(key)?'productions/'+productionId+'/'+key:key;
  const store={};
  for(const method of ['get','getWithMetadata','getMetadata','set','setJSON','delete'])store[method]=(key,...args)=>rawStore[method](scoped(key),...args);
  store.list=async(options)=>{const result=await rawStore.list({...options,prefix:scoped(options.prefix)});const prefix=productionId==='written-in-the-dark'?'':'productions/'+productionId+'/';return {...result,blobs:result.blobs.map(b=>({...b,key:prefix&&b.key.startsWith(prefix)?b.key.slice(prefix.length):b.key}))};};
  let catalog=catalogs[productionId], film=productions.find(p=>p.id===productionId).name;
  const get=k=>store.get(k,{type:'json'});
  const set=(k,v)=>store.setJSON(k,v);
  const list=async prefix=>Promise.all((await store.list({prefix})).blobs.map(b=>get(b.key)));
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
      const index=items.findIndex(x=>x.id===id);if(index>=0)items.splice(index,1);
      if(practiceName(m.name)||!membership||m.publication?.[pid]===false||(m.revoked&&!m.keepPublic)){
        if(base||membership)items.push({id,name:m.name,hidden:true});continue;
      }
      const [profile,photo]=await Promise.all([get('profiles/'+m.id),store.getMetadata('photos/'+m.id)]),fallback=sharedBase(m);
      const bio=profile?.bio??fallback?.bio??'',image=photo?'https://heidimikacfilms.com/.netlify/functions/portal?action=memberPhoto&id='+m.id+'&v='+(photo.metadata?.version||'original'):fallback?.photo;
      if(bio.trim()&&image)items.push({id,name:m.name,role:membership.role||base?.role||'',bio,photo:image});
    }
    // Revision-keyed snapshots cannot overwrite a later profile edit.
    if((await get('public-revision')||'initial')===revision)await set(key,{revision,items,updated:Date.now()});
    return items;
  }
  const post=req.method==='POST';
  requireThat(post||req.method==='GET','Unsupported method.',405);
  if(post) requireThat(req.headers.get('origin')===url.origin,'Origin rejected.',403);
  const entry=id=>catalog.find(item=>item.id===id);
  if(!post&&action==='published')return json(await publicItems(),{'Access-Control-Allow-Origin':'*','Cache-Control':'public, max-age=30'});
  if(!post&&action==='memberPhoto'){
    const id=url.searchParams.get('id');requireThat(uuid.test(id),'Invalid image.');
    const m=await get('members/'+id);
    requireThat(m&&(!m.revoked||m.keepPublic)&&!practiceName(m.name)&&Object.keys(assignments(m)).some(id=>m.publication?.[id]!==false),'Image unavailable.',404);
    const file=await store.getWithMetadata('photos/'+id,{type:'arrayBuffer'});requireThat(file,'Image unavailable.',404);
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
  async function notify(m,event,subject,text){
    if(production)await enqueue(store,m,event,subject,text+'\n\nOpen your dashboard: '+portalUrl+'?production='+productionId);
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
    const bucket='attempts/'+hash(who)+'/'+Math.floor(Date.now()/600000);
    const previous=await store.getWithMetadata(bucket,{type:'json'});
    requireThat((previous?.data||0)<20,'Too many attempts. Try again in ten minutes.',429);
    const increment=await store.setJSON(bucket,(previous?.data||0)+1,previous?{onlyIfMatch:previous.etag}:{onlyIfNew:true});
    requireThat(increment.modified,'Please try again.',429);
    const attempt=await derive(body.password,pass.salt,64);
    requireThat(timingSafeEqual(attempt,Buffer.from(pass.digest,'hex')),'Invalid login.',401);
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
  if(!admin&&!['home','bio','photo','choosePassword','welcomePlayed','requestProductions'].includes(action))requireThat(memberProductions[productionId],'You are not assigned to this production.',403);
  if(!admin&&action==='home'&&Object.keys(memberProductions).length)requireThat(memberProductions[productionId],'You are not assigned to this production.',403);
  if(action==='calendarConnect'||action==='calendarEvents'){
    onlyAdmin(); requireThat(url.origin==='https://heidimikacfilms.com','Production only.',403);
    if(action==='calendarConnect'){requireThat(post,'Use the connect button.',405);return await beginCalendar(store,sessionKey);}
    return await calendarEvents(store);
  }
  const target=async()=>{requireThat(uuid.test(uid)&& (admin||uid===self),'Access denied.',403);const m=await get('members/'+uid);requireThat(m,'Member unavailable.',404);if(!['bio','photo','revoke','enrollments','resend'].includes(action))requireThat(assignments(m)[productionId],'Member is not assigned to this production.',403);return m};
  const hasOfflineSigning=profileId=>rawStore.getMetadata(offlineSigningKey(profileId,productionId));
  async function hasOnlineAgreement(profileId){
    const linked=(await list('members/')).filter(m=>m&&findProfile(m,productionId)?.id===profileId);
    const agreements=await Promise.all(linked.map(m=>get('agreements/'+m.id)));
    return agreements.some(agreement=>agreement&&!agreement.cleared);
  }
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
    if(kind==='signed'){
      const agreement=await refreshAgreement(store,'agreements/'+member.id);
      requireThat(agreement?.id&&agreement.status==='Complete','No completed agreement available.',404);
      bytes=await completedAgreementPdf(agreement.id);label='signed-agreement';
    }else{
      const profile=await ownedProfile(member);
      requireThat(profile,'No linked paperwork available.',404);
      if(kind==='countersigned'){
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
    if(post){
      requireThat(!await hasOfflineSigning(uid),'This uploaded agreement has a countersignature request. Review that request before replacing its source.',409);
      const bytes=Buffer.from(await req.arrayBuffer());
      requireThat(bytes.length<=4*1024*1024&&bytes.subarray(0,5).toString()==='%PDF-','Choose a PDF up to 4 MB.');
      const status=url.searchParams.get('status');requireThat(['Waiting on Heidi','Missing page 1 · waiting on Heidi','Complete'].includes(status),'Choose the signature status.');
      const expected=url.searchParams.get('replaceHash');
      let options={onlyIfNew:true};
      if(expected){
        const previous=await store.getWithMetadata(key,{type:'arrayBuffer'});
        requireThat(previous&&hash(Buffer.from(previous.data))===expected,'The filed agreement changed. Reload before replacing it.',409);
        await store.set('offline-history/'+uid+'/'+expected,previous.data,{onlyIfNew:true,metadata:previous.metadata});
        options={onlyIfMatch:previous.etag};
      }
      requireThat(!await hasOfflineSigning(uid),'A countersignature request was prepared while this file was being uploaded. Reload before continuing.',409);
      const result=await store.set(key,bytes,{...options,metadata:{status}});requireThat(result.modified,'An offline agreement is already filed.',409);return json({ok:true});
    }
    const file=await store.getWithMetadata(key,{type:'arrayBuffer'});requireThat(file,'No agreement on file.',404);
    return new Response(file.data,{headers:{...headers,'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="'+uid+'-offline-agreement.pdf"'}});
  }
  if(action==='prepareOfflineCountersign'){
    onlyAdmin();requireThat(post,'Use POST to prepare a countersignature draft.',405);
    const profile=entry(uid);requireThat(profile,'Unknown film profile.',404);
    requireThat(process.env.SIGNWELL_API_KEY,'Signing setup required.',503);
    const noOnlineAgreement=async()=>requireThat(!await hasOnlineAgreement(profile.id),'An online agreement already exists for this profile. Reconcile it before preparing another request.',409);
    const {agreement,created}=await prepareOfflineCountersign({store:rawStore,profile,productionId,film,live:production&&process.env.HMF_SIGNWELL_LIVE==='yes',existingOnlineAgreement:await hasOnlineAgreement(profile.id),beforeCreate:noOnlineAgreement});
    return json({ok:true,created,status:agreement.status,offlineSigning:offlineSigningSummary(agreement)});
  }
  if(action==='offlineCountersignStatus'){
    onlyAdmin();requireThat(!post,'Use GET to check a countersignature request.',405);requireThat(entry(uid),'Unknown film profile.',404);
    let document;
    const agreement=await refreshOfflineCountersign({store:rawStore,profileId:uid,productionId,force:true,onDocument:value=>{document=value;}});
    requireThat(agreement,'No countersignature request exists for this uploaded agreement.',404);
    const ready=document&&!agreement.syncError&&!agreement.sourceChanged;
    const providerStatus=String(document?.status||'').trim().toLowerCase();
    const editUrl=ready&&providerStatus==='draft'?signingUrl(document.embedded_edit_url):null;
    const url=ready&&agreement.status==='Waiting on Heidi'&&['sent','pending','viewed','in_progress'].includes(providerStatus)?signingUrl(document.recipients[0].embedded_signing_url):null;
    return json({status:agreement.status,offlineSigning:offlineSigningSummary(agreement),editUrl,url});
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
  if(action==='home'){
    const allAccounts=(await list('members/')).filter(Boolean);
    const accounts=allAccounts.filter(active);
    const rosterCatalog=catalog.filter(x=>{const matches=allAccounts.filter(m=>findProfile(m,productionId)?.id===x.id);return !matches.length||matches.some(m=>assignments(m)[productionId]&&(!m.revoked||m.keepPublic));});
    const members=admin?accounts.filter(m=>assignments(m)[productionId]):[account];
    const offlineRequests=new Map();
    const offlineFor=profileId=>{
      if(!offlineRequests.has(profileId))offlineRequests.set(profileId,refreshOfflineCountersign({store:rawStore,profileId,productionId}));
      return offlineRequests.get(profileId);
    };
    const rows=await Promise.all(members.filter(Boolean).map(async m=>({...m,role:assignments(m)[productionId]?.role||'',filmProfile:findProfile(m,productionId)?.id||'',productions:assignments(m),profile:await get('profiles/'+m.id),...(await (async()=>{const photo=await store.getMetadata('photos/'+m.id);return {hasPhoto:!!photo,photoName:photo?.metadata?.filename||''};})()),agreement:assignments(m)[productionId]?await refreshAgreement(store,'agreements/'+m.id):null,tasks:assignments(m)[productionId]?(await list('tasks/'+m.id+'/')).filter(Boolean):[],activated:!!await get('passwords/'+m.id)})));
    for(const row of rows){
      const original=accounts.find(m=>m.id===row.id);
      const base=sharedBase(original);
      row.paperworkExempt=/^(nick williams|nicholas williams|heidi mikac)$/i.test(row.name.trim());
      const published=base?await get('published/'+base.id):null;
      row.offlineStatus=assignments(original)[productionId]&&row.filmProfile?(await store.getMetadata("offline/"+row.filmProfile))?.metadata?.status||null:null;
      if(admin&&row.filmProfile)row.offlineSigning=offlineSigningSummary(await offlineFor(row.filmProfile));
      if(!admin){
        const profile=await ownedProfile(original,accounts);
        row.documents=[];
        if(row.agreement?.id&&row.agreement.status==='Complete')row.documents.push({kind:'signed',title:'Signed agreement and audit record'});
        if(profile){
          if(row.offlineStatus)row.documents.push({kind:'uploaded',title:'Filed agreement'});
          const signed=await offlineFor(profile);
          if(signed?.id&&!signed.sourceChanged&&signed.status==='Complete')row.documents.push({kind:'countersigned',title:'Countersigned agreement and audit record'});
          const history=await store.list({prefix:'offline-history/'+profile+'/'});
          for(const file of history.blobs){
            const version=file.key.split('/').pop();
            if(/^[a-f0-9]{64}$/.test(version))row.documents.push({kind:'previous',version,title:'Previous filed agreement · '+version.slice(0,8)});
          }
        }
      }
      row.referencePhoto=published?.photo||base?.photo;
      row.profile??={bio:published?.bio??base?.bio??''};
      const memberPaperwork=row.offlineStatus||row.agreement?.status||(row.paperworkExempt?'Not required':'No agreement on file');
      row.paperworkStatus=row.offlineSigning?.status||memberPaperwork;
      row.memberPaperworkStatus=['Complete','Waiting on Heidi','Not required'].includes(memberPaperwork)?'Complete':memberPaperwork;
      row.publication=Object.fromEntries(await Promise.all(Object.keys(assignments(original)).map(async pid=>{
        const id=findProfile(original,pid)?.id||'member-'+row.id;
        const ready=!!row.profile.bio?.trim()&&!!(row.hasPhoto||row.referencePhoto);
        const hidden=practiceName(row.name)||original.publication?.[pid]===false;
        let state=hidden?'Hidden from website':ready?'Sync failed':'Needs bio and headshot';
        if(!hidden&&ready){try{state=(await publicItems(pid)).some(x=>x.id===id&&!x.hidden)?'Published':'Sync failed';}catch{}}
        return [pid,{state,visible:!hidden}];
      })));

    }
    const adminCatalog=admin?await Promise.all(rosterCatalog.map(async x=>{
      const offline=(await store.getMetadata('offline/'+x.id))?.metadata?.status||null;
      const offlineSigning=offlineSigningSummary(await offlineFor(x.id));
      return {...x,offline,offlineSigning,paperworkStatus:offlineSigning?.status||offline||rows.find(row=>row.filmProfile===x.id)?.paperworkStatus||'No agreement on file'};
    })):[];
    const waiting=admin?(await adminActions(rawStore,productionId)).filter(a=>a.owner==='any'||a.owner===self):[];
    const productionReviews=admin?await Promise.all(accounts.filter(m=>m.productionRequests?.[productionId]).map(async m=>({id:m.id,name:m.name,role:assignments(m)[productionId]?.role||findProfile(m,productionId)?.role||'',requestId:m.productionRequests[productionId],...await reviewProfile(m)}))):[];
    return json({productionReviews,productionChoices:productions,waiting,productionId,productions:admin?productions:productions.filter(p=>memberProductions[p.id]),revokedAccounts:admin?allAccounts.filter(m=>m.revoked).map(m=>({id:m.id,name:m.name,keepPublic:m.keepPublic,productions:assignments(m),publication:m.publication||{}})):[],accounts:admin?accounts.map(m=>({id:m.id,name:m.name,productions:assignments(m)})):[],agreementReady:!!await store.getMetadata('contract/master'),agreementSupported:true,welcome:await get('settings/welcome'),welcomePlayed:!!await get('welcome-played/'+self),catalog:adminCatalog,admin,self,film,passwordSet:!!await get('passwords/'+self),mailReady:production&&mailReady(),mailLog:admin?(await list('mail-log/')).filter(Boolean).sort((a,b)=>b.updated-a.updated).slice(0,30):[],mailQueue:admin?(await list('outbox/')).filter(Boolean).map(({to,subject,attempts,nextAttempt,lastError})=>({to,subject,attempts,nextAttempt,lastError})):[],members:rows.map(({ticket,...row})=>({...row,practice:practiceName(row.name)})),resources:(await list('resources/')).filter(canReadResource).map(r=>admin?r:({...r,audience:undefined})).sort((a,b)=>b.created-a.created),test:!(production&&process.env.HMF_SIGNWELL_LIVE==='yes')});
  }
  if((action==='invite'||action==='resend')&&post){
    onlyAdmin();requireThat(production&&mailReady(),'Invitation email is awaiting sender setup. No invitation was sent.',503);
    let m;
    if(action==='invite'){
      const address=email(body.email);
      requireThat(!(await list('members/')).some(m=>active(m)&&m.email===address),'This person already has an account. Use Manage production assignments to add another production.');
      const hex=hash(address);
      // A revoked account must receive a fresh identity on re-invitation.
      const index='active-email/'+hex;
      m={id:randomUUID(),email:address,name:string(body.name),role:string(body.role)};
      m.publication={[productionId]:false};
      m.productions={[productionId]:{role:m.role,filmProfile:''}};
      if(body.filmProfile){allowPublicProfile(m);const base=entry(body.filmProfile);requireThat(base,'Unknown film profile.');m.productions[productionId].filmProfile=base.id;if(productionId==='written-in-the-dark')m.filmProfile=base.id;}
      const reserved=await store.setJSON(index,{id:m.id},{onlyIfNew:true});requireThat(reserved.modified,'An invitation already exists.');
      try{await set('members/'+m.id,m);}catch(e){await store.delete(index);throw e;}
    }else m=await target();
    requireThat(!await get('passwords/'+m.id),'This person already has a password.');
    const ticket=token(),expires=Date.now()+7*86400000;
    await set('tickets/'+hash(ticket),{id:m.id,expires});
    await set('members/'+m.id,{...m,ticket:hash(ticket)});await invalidate();
    await enqueue(store,m,'invite/'+hash(ticket),film+' — your cast & crew invitation','Hi '+m.name+',\n\nYou’re invited to '+film+' as '+m.role+'. Choose your password and finish your profile here:\n'+portalUrl+'#invite='+ticket+'\n\nThis invitation expires in seven days.',expires);
    return json({ok:true});
  }
  async function reviewProfile(m){
    const [draft,image]=await Promise.all([get('profiles/'+m.id),store.getMetadata('photos/'+m.id)]);
    const fallback=sharedBase(m),bio=draft?.bio??fallback?.bio??'',photo=image?'uploaded':fallback?.photo||'';
    return {bio,photo,revision:hash(JSON.stringify([bio,image?.etag||image?.metadata?.version||photo]))};
  }
  if(action==='requestProductions'&&post){
    requireThat(!admin,'Use a cast or crew account.',403);
    const record=await store.getWithMetadata('members/'+self,{type:'json'}),m=record?.data;
    requireThat(active(m),'Account unavailable.',403);allowPublicProfile(m);
    requireThat(Array.isArray(body.selections)&&body.selections.every(id=>productions.some(p=>p.id===id)),'Choose valid productions.');
    const pending={};
    for(const id of new Set(body.selections)){
      if(!assignments(m)[id]||m.publication?.[id]===false)pending[id]=m.productionRequests?.[id]||randomUUID();
    }
    requireThat((await store.setJSON('members/'+self,{...m,productionRequests:pending},{onlyIfMatch:record.etag})).modified,'Your assignments changed. Reload and try again.',409);
    return json({ok:true});
  }
  if(action==='reviewProduction'&&post){
    onlyAdmin();requireThat(uuid.test(uid),'Invalid member.');
    const record=await store.getWithMetadata('members/'+uid,{type:'json'}),m=record?.data;
    requireThat(active(m)&&m.productionRequests?.[productionId]&&m.productionRequests[productionId]===body.requestId,'This request changed. Reload the portal.',409);
    const pending={...m.productionRequests};delete pending[productionId];
    let next={...m,productionRequests:pending};
    if(body.decision==='approve'){
      allowPublicProfile(m);
      const profile=await reviewProfile(m);
      requireThat(profile.bio.trim()&&profile.photo&&profile.revision===body.revision,'Review the latest saved biography and headshot before approval.',409);
      const role=string(body.role),base=findProfile(m,productionId);
      if(base)requireThat(!(await list('members/')).some(other=>active(other)&&other.id!==uid&&assignments(other)[productionId]&&findProfile(other,productionId)?.id===base.id),'This production profile is already assigned to someone else.',409);
      const previous=assignments(m)[productionId];
      next.productions={...assignments(m),[productionId]:{...previous,role,filmProfile:previous?.filmProfile||''}};
      next.publication={...m.publication,[productionId]:true};
    }else requireThat(body.decision==='decline','Choose an approval decision.');
    requireThat((await store.setJSON('members/'+uid,next,{onlyIfMatch:record.etag})).modified,'The request changed. Reload and try again.',409);
    await invalidate();return json({ok:true});
  }
  if(action==='enrollments'&&post){
    onlyAdmin();const m=await target();
    requireThat(Array.isArray(body.productions)&&body.productions.every(id=>catalogs[id]),'Choose valid productions.');
    const next={};
    for(const id of new Set(body.productions)){
      const role=string(body.roles?.[id]);
      const base=findProfile(m,id);
      if(base)requireThat(!(await list('members/')).some(other=>active(other)&&other.id!==m.id&&assignments(other)[id]&&findProfile(other,id)?.id===base.id),'This film profile is already assigned to another account.',409);
      next[id]={role,filmProfile:base?.id||''};
    }
    await set('members/'+m.id,{...m,productions:next,profileLinks:{...m.profileLinks,...Object.fromEntries(Object.entries(assignments(m)).filter(([,value])=>value.filmProfile).map(([id,value])=>[id,value.filmProfile])),...Object.fromEntries(Object.entries(next).filter(([,value])=>value.filmProfile).map(([id,value])=>[id,value.filmProfile]))}});await invalidate();return json({ok:true});
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
  if(action==='finishTask'&&post){
    await target();requireThat(uuid.test(body.task),'Invalid task.');
    const key='tasks/'+uid+'/'+body.task,item=await get(key);requireThat(item,'Task unavailable.');
    await set(key,{...item,done:true});return json({ok:true});
  }
  if(action==='revoke'&&post){onlyAdmin();const m=await target();await set('members/'+uid,{...m,revoked:true,revokedAt:Date.now(),keepPublic:body.keepPublic===true});await store.delete('active-email/'+hash(m.email));await invalidate();return json({ok:true});}
  if(action==='publication'&&post){onlyAdmin();const m=await target();if(body.visible)allowPublicProfile(m);await set('members/'+uid,{...m,...(m.revoked&&body.visible?{keepPublic:true}:{}),publication:{...m.publication,[productionId]:body.visible===true}});await invalidate();return json({ok:true});} 
  if(action==='bio'&&post){
    await target();requireThat(typeof body.bio==='string'&&body.bio.length<=5000,'Bio limit is 5,000 characters.');
    await set('profiles/'+uid,{bio:body.bio.trim()});await invalidate();return json({ok:true});
  }
  if(['photo','resource','master'].includes(action)&&post){
    if(action==='photo')await target();else onlyAdmin();

    const bytes=Buffer.from(await req.arrayBuffer());
    requireThat(bytes.length>0&&bytes.length<=4*1024*1024,'Choose a file up to 4 MB.');
    const jpeg=bytes.subarray(0,3).toString('hex')==='ffd8ff',png=bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a';
    if(action==='photo'){requireThat(jpeg||png,'Choose a JPG or PNG.');try{await sharp(bytes,{limitInputPixels:40000000}).metadata();}catch{requireThat(false,'This image could not be read. Choose another JPG or PNG.');}await store.set('photos/'+uid,bytes,{metadata:{version:hash(bytes),filename:(url.searchParams.get('filename')||'').split(/[\\/]/).pop().slice(0,255),mime:jpeg?'image/jpeg':'image/png'}});await invalidate();}
    else if(action==='master'){requireThat(hash(bytes)===(productionId==='written-in-the-dark'?'8437469c10b4a2ebd322adb8fd4c4e246abb2a0e26043a7c4129dffee92e6626':'0777d2cf63f99e584091be91442d9c77f8fe835e738c56308e82c328a49a2be8'),'Choose the approved contract master for this production.');await store.set('contract/master',bytes);}
    else {requireThat(bytes.subarray(0,5).toString()==='%PDF-','Choose a PDF.');const group=await recipients(url.searchParams.get('audience'),url.searchParams.getAll('recipient'));const id=randomUUID(),title=string(url.searchParams.get('title'));await store.set('files/'+id,bytes);await set('resources/'+id,{id,title,audience:group.audience,type:'PDF',created:Date.now()});await Promise.all(group.recipients.map(m=>notify(m,id,'New production file','Production posted a new file for '+film+'.')));}
    return json({ok:true});
  }
  if(action==='notice'&&post){onlyAdmin();const group=await recipients(body.audience,body.recipients);const id=randomUUID();await set('resources/'+id,{id,title:string(body.title),text:string(body.text,5000),audience:group.audience,type:'Update',created:Date.now()});await Promise.all(group.recipients.map(m=>notify(m,id,'New production message','You have a new message from production.')));return json({ok:true});}
  if(action==='photo'||action==='resource'){
    if(action==='photo')await target();else requireThat(uuid.test(uid)&&canReadResource(await get('resources/'+uid)),'File unavailable.',404);
    const r=await store.getWithMetadata((action==='photo'?'photos/':'files/')+uid,{type:'arrayBuffer'});
    requireThat(r,'File unavailable.',404);return new Response(r.data,{headers:{...headers,'Content-Type':r.metadata?.mime||'application/pdf','Content-Disposition':action==='photo'?'inline':'attachment; filename="production-document.pdf"'}});
  }
  if(action==='agreement'&&post){

    onlyAdmin();const m=await target(),t={},profile=findProfile(m,productionId);
    if(!body.preview&&profile)requireThat(!await hasOfflineSigning(profile.id),'This profile already has an uploaded agreement in countersigning. Use its existing request.',409);
    for(const k of ['legal','character','credit','rate','date','start'])t[k]=string(body[k],120);
    requireThat(/^\d{1,5}(\.\d{1,2})?$/.test(t.rate),'Enter a daily rate.');
    for(const k of ['date','start'])requireThat(/^\d{4}-\d{2}-\d{2}$/.test(t[k])&&!Number.isNaN(Date.parse(t[k]))&&new Date(t[k]).toISOString().slice(0,10)===t[k],'Enter valid dates.');
    const heidi=COUNTERSIGN_EMAIL;
    requireThat(heidi!==m.email,'Actor and countersigner need separate addresses.');
    const master=await store.get('contract/master',{type:'arrayBuffer'});requireThat(master,'Upload the private agreement master first.');
    const bytes=await packet(master,t);
    if(body.preview)return new Response(bytes,{headers:{...headers,'Content-Type':'application/pdf'}});
    requireThat(process.env.SIGNWELL_API_KEY,'Signing setup required.',503);
    const key='agreements/'+uid;
    const existing=await store.getWithMetadata(key,{type:'json'});
    const lock=await store.setJSON(key,{status:'Preparing — check SignWell before retrying',created:Date.now(),recipientEmail:heidi,name:film+' — '+t.legal},existing?.data?.cleared?{onlyIfMatch:existing.etag}:{onlyIfNew:true});
    requireThat(lock.modified,'An agreement already exists or is being prepared.',409);
    let d;try{
      // Reciprocal checks after each route's reservation prevent simultaneous regular and offline requests.
      if(profile)requireThat(!await hasOfflineSigning(profile.id),'A countersignature request was prepared for the uploaded agreement. Use its existing request.',409);
      d=await signwell('documents/',{test_mode:!(production&&process.env.HMF_SIGNWELL_LIVE==='yes'),name:film+' — '+t.legal,files:[{name:'Actor Agreement.pdf',file_base64:bytes.toString('base64')}],recipients:[{id:'1',name:t.legal,email:m.email},{id:'2',name:'Heidi Mikac',email:heidi,send_email:true}],apply_signing_order:true,embedded_signing:true,text_tags:true});
    }catch(e){await set(key,{status:'Needs recovery — check SignWell',created:Date.now(),recipientEmail:heidi,name:film+' — '+t.legal});throw e;}
    await set(key,{id:d.id,status:'Waiting on actor',checkedAt:Date.now()});await notify(m,d.id,'Document ready for signature','Your agreement is ready to review and sign.');return json({ok:true});
  }
  if(action==='recoverAgreement'&&post){
    onlyAdmin();const m=await target(),key='agreements/'+uid,rec=await store.getWithMetadata(key,{type:'json'});
    requireThat(rec?.data&&!rec.data.id,'No interrupted request to recover.');
    if(body.documentId){
      const id=string(body.documentId);requireThat(uuid.test(id),'Enter the SignWell document ID.');
      const d=await signwell('documents/'+id+'/');
      requireThat(d.name?.startsWith(film+' — ')&&d.recipients?.some(r=>String(r.id)==='1'&&r.email?.toLowerCase()===m.email)&&d.recipients?.some(r=>String(r.id)==='2'&&r.email?.toLowerCase()===(rec.data.recipientEmail||process.env.HMF_HEIDI_SIGNING_EMAIL||'heidi@heidimikacfilms.com').toLowerCase()),'Document does not match this person and production.');
      requireThat((await store.setJSON(key,{id,status:documentStatus(d),checkedAt:Date.now()},{onlyIfMatch:rec.etag})).modified,'Record changed; reload.');
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
    const key='agreements/'+uid,record=await store.getWithMetadata(key,{type:'json'}),a=record?.data;
    requireThat(a?.id,'No active signing request.');
    if(a.status==='Complete')return json({status:'Complete',url:null});
    const d=await signwell('documents/'+encodeURIComponent(a.id)+'/');
    const [actor,producer]=['1','2'].map(id=>d.recipients?.find(r=>String(r.id)===id));
    const status=documentStatus(d);
    const saved=await store.setJSON(key,{...a,status,checkedAt:Date.now(),syncError:null},{onlyIfMatch:record.etag});
    if(!saved.modified)return json({status:(await get(key))?.status||status,url:null});
    const signer=admin?(status==='Waiting on Heidi'?producer:null):(status==='Waiting on actor'?actor:null);
    return json({status,url:signer?.embedded_signing_url||null});
  }
  return json({error:'Unknown action.'});
 }catch(e){return Response.json({error:e.status?e.message:'The request could not be completed.'},{status:e.status||500,headers});}
}



