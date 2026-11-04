import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const hash = x => createHash('sha256').update(x).digest('hex');
const token = () => randomBytes(32).toString('hex');
const film = 'Written in the Dark';
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
async function packet(bytes, terms) {
  const doc=await PDFDocument.load(bytes), pages=doc.getPages(), form=doc.getForm();
  const font=await doc.embedFont(StandardFonts.Helvetica);
  for(const [key,value] of [['Actor name or professional name',terms.credit],['Role or character',terms.character],['Daily rate (USD)',terms.rate]]) form.getTextField(key).setText(value);
  form.updateFieldAppearances(font);form.flatten();
  function write(page,x,top,width,value,background) {
    const size=Math.min(9,width/font.widthOfTextAtSize(value,1));
    requireThat(size>=5,'One entry is too long for the contract. Please shorten it.');
    const y=page.getHeight()-top-9.6;
    page.drawRectangle({x,y:y-1,width,height:11,color:background});
    page.drawText(value,{x,y:y+1,size,font});
  }
  const white=rgb(1,1,1), gray=rgb(.97,.98,.98);
  write(pages[0],340.5,143.3,31.4,terms.date,gray);
  write(pages[0],208.8,156.8,103,terms.legal,gray);
  write(pages[0],400.3,526.6,58,terms.start,white);
  write(pages[0],478.7,526.6,53.6,terms.end,white);
  write(pages[1],51,270.8,131,terms.credit,white);
  write(pages[1],310,383.3,150,terms.legal,white);
  for(const [x,top,field] of [[310,414,'s:1:y'],[310,457,'af_n:1:y'],[310,500,'af_d_s:1:y'],[52,414,'s:2:y'],[52,500,'af_d_s:2:y']]) {
    pages[1].drawText('{{'+field+'          }}',{x,y:pages[1].getHeight()-top,size:12,font,color:white});
  }
  return Buffer.from(await doc.save());
}
async function signwell(path, body) {
  requireThat(process.env.SIGNWELL_API_KEY,'Signing is awaiting private account setup.',503);
  const res=await fetch('https://www.signwell.com/api/v1/'+path,{method:body?'POST':'GET',headers:{'X-Api-Key':process.env.SIGNWELL_API_KEY,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});
  requireThat(res.ok,'SignWell could not confirm this request. Check the SignWell dashboard.',502);
  return res.json();
}
export default async function handle(req) {
 try {
  const url=new URL(req.url), action=url.searchParams.get('action')||'home';
  const production=['heidimikacfilms.com','www.heidimikacfilms.com'].includes(url.hostname);
  const store=getStore({name:production?'hmf-members-v1':'hmf-preview-'+(process.env.DEPLOY_ID||'local'),consistency:'strong'});
  const get=k=>store.get(k,{type:'json'});
  const set=(k,v)=>store.setJSON(k,v);
  const list=async prefix=>Promise.all((await store.list({prefix})).blobs.map(b=>get(b.key)));
  const post=req.method==='POST';
  requireThat(post||req.method==='GET','Unsupported method.',405);
  if(post) requireThat(req.headers.get('origin')===url.origin,'Origin rejected.',403);
  const raw=req.headers.get('cookie')?.match(/(?:^|; )__Host-hmf=([a-f0-9]{64})(?:;|$)/)?.[1];
  const sessionKey=raw&&'sessions/'+hash(raw);
  const session=sessionKey&&await get(sessionKey);
  const body=post&&req.headers.get('content-type')?.startsWith('application/json')?await req.json():{};
  const uid=url.searchParams.get('id')||body.id;
  const adminKeys=[['Nick',process.env.HMF_NICK_LOGIN_SHA256],['Heidi',process.env.HMF_HEIDI_LOGIN_SHA256]];
  if(action==='login'&&post){
    const code=string(body.code,200);
    requireThat(code.length>=32,'Invalid access key.',401);
    const digest=hash(code), admin=adminKeys.find(([,k])=>k?.length===64&&k===digest);
    const member=admin?null:await get('keys/'+digest);
    requireThat(admin||(member&&await get('members/'+member.id)),'Access key is invalid or revoked.',401);
    const secret=token();
    await set('sessions/'+hash(secret),{id:admin?admin[0]:member.id,admin:!!admin,expires:Date.now()+8*3600000,adminDigest:admin?digest:null});
    return json({ok:true},{'Set-Cookie':cookie(secret,28800)});
  }
  requireThat(session?.expires>Date.now(),'Please sign in.',401);
  const admin=session.admin, self=session.id;
  requireThat(admin?adminKeys.some(([id,k])=>id===self&&k&&k===session.adminDigest):await get('members/'+self),'Access revoked.',401);
  if(action==='logout'&&post){await store.delete(sessionKey);return json({}, {'Set-Cookie':cookie('',0)});}
  const onlyAdmin=()=>requireThat(admin,'Administrator access required.',403);
  const target=async()=>{requireThat(uuid.test(uid)&& (admin||uid===self),'Access denied.',403);const m=await get('members/'+uid);requireThat(m,'Member unavailable.',404);return m};
  if(action==='home'){
    const members=admin?await list('members/'):[await get('members/'+self)];
    const rows=await Promise.all(members.filter(Boolean).map(async m=>({...m,profile:await get('profiles/'+m.id),hasPhoto:!!await store.getMetadata('photos/'+m.id),agreement:await get('agreements/'+m.id)})));
    return json({admin,self,film,members:rows,resources:(await list('resources/')).filter(Boolean).sort((a,b)=>b.created-a.created),test:!(production&&process.env.HMF_SIGNWELL_LIVE==='yes')});
  }
  if(action==='invite'&&post){
    onlyAdmin();const id=randomUUID(),code=token(),m={id,name:string(body.name),email:email(body.email),role:string(body.role)};
    await set('members/'+id,m);await set('keys/'+hash(code),{id});return json({code});
  }
  if(action==='revoke'&&post){onlyAdmin();await target();await store.delete('members/'+uid);return json({ok:true});}
  if(action==='bio'&&post){
    await target();requireThat(typeof body.bio==='string'&&body.bio.length<=5000,'Bio limit is 5,000 characters.');
    await set('profiles/'+uid,{bio:body.bio.trim()});return json({ok:true});
  }
  if(['photo','resource','master'].includes(action)&&post){
    if(action==='photo')await target();else onlyAdmin();
    const bytes=Buffer.from(await req.arrayBuffer());
    requireThat(bytes.length>0&&bytes.length<=4*1024*1024,'Choose a file up to 4 MB.');
    const jpeg=bytes.subarray(0,3).toString('hex')==='ffd8ff',png=bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a';
    if(action==='photo'){requireThat(jpeg||png,'Choose a JPG or PNG.');await store.set('photos/'+uid,bytes,{metadata:{mime:jpeg?'image/jpeg':'image/png'}});}
    else if(action==='master'){requireThat(hash(bytes)==='8437469c10b4a2ebd322adb8fd4c4e246abb2a0e26043a7c4129dffee92e6626','Choose the approved WrittenDarkContract-CastTemplate.pdf.');await store.set('contract/master',bytes);}
    else {requireThat(bytes.subarray(0,5).toString()==='%PDF-','Choose a PDF.');const id=randomUUID(),title=string(url.searchParams.get('title'));await store.set('files/'+id,bytes);await set('resources/'+id,{id,title,type:'PDF',created:Date.now()});}
    return json({ok:true});
  }
  if(action==='notice'&&post){onlyAdmin();const id=randomUUID();await set('resources/'+id,{id,title:string(body.title),text:string(body.text,5000),type:'Update',created:Date.now()});return json({ok:true});}
  if(action==='photo'||action==='resource'){
    if(action==='photo')await target();else requireThat(uuid.test(uid)&&await get('resources/'+uid),'File unavailable.',404);
    const r=await store.getWithMetadata((action==='photo'?'photos/':'files/')+uid,{type:'arrayBuffer'});
    requireThat(r,'File unavailable.',404);return new Response(r.data,{headers:{...headers,'Content-Type':r.metadata?.mime||'application/pdf','Content-Disposition':action==='photo'?'inline':'attachment; filename="production-document.pdf"'}});
  }
  if(action==='agreement'&&post){
    onlyAdmin();const m=await target(),t={};
    for(const k of ['legal','character','credit','rate','date','start','end'])t[k]=string(body[k],120);
    requireThat(/^\d{1,5}(\.\d{1,2})?$/.test(t.rate),'Enter a daily rate.');
    for(const k of ['date','start','end'])requireThat(/^\d{4}-\d{2}-\d{2}$/.test(t[k]),'Enter valid dates.');
    requireThat(t.end>=t.start,'Check the shoot dates.');
    const heidi=email(process.env.HMF_HEIDI_SIGNING_EMAIL||'');
    requireThat(heidi!==m.email,'Actor and countersigner need separate addresses.');
    const master=await store.get('contract/master',{type:'arrayBuffer'});requireThat(master,'Upload the private agreement master first.');
    const bytes=await packet(master,t);
    if(body.preview)return new Response(bytes,{headers:{...headers,'Content-Type':'application/pdf'}});
    requireThat(process.env.SIGNWELL_API_KEY,'Signing setup required.',503);
    const key='agreements/'+uid;
    const lock=await store.setJSON(key,{status:'Preparing — check SignWell before retrying'},{onlyIfNew:true});
    requireThat(lock.modified,'An agreement already exists or is being prepared.',409);
    const d=await signwell('documents/',{test_mode:!(production&&process.env.HMF_SIGNWELL_LIVE==='yes'),name:film+' — '+t.legal,files:[{name:'Actor Agreement.pdf',file_base64:bytes.toString('base64')}],recipients:[{id:'1',name:t.legal,email:m.email},{id:'2',name:'Heidi Mikac',email:heidi}],apply_signing_order:true,embedded_signing:true,text_tags:true});
    await set(key,{id:d.id,status:'Waiting on actor'});return json({ok:true});
  }
  if(action==='status'){
    await target();const a=await get('agreements/'+uid);requireThat(a?.id,'No active signing request.');
    const d=await signwell('documents/'+encodeURIComponent(a.id)+'/');
    const [actor,producer]=['1','2'].map(id=>d.recipients?.find(r=>String(r.id)===id));
    const status=d.status==='completed'?'Complete':['declined','cancelled','expired'].includes(d.status)?d.status:actor?.status==='signed'?'Waiting on Heidi':'Waiting on actor';
    await set('agreements/'+uid,{id:a.id,status});
    const signer=admin?(self==='Heidi'&&status==='Waiting on Heidi'?producer:null):(status==='Waiting on actor'?actor:null);
    return json({status,url:signer?.embedded_signing_url||null});
  }
  return json({error:'Unknown action.'});
 }catch(e){return Response.json({error:e.status?e.message:'The request could not be completed.'},{status:e.status||500,headers});}
}
