const app=document.querySelector('#app'), message=document.querySelector('#message');
const endpoint='/.netlify/functions/portal';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const url=(action,id='')=>endpoint+'?'+new URLSearchParams({action,id});
async function request(action,body,id='',suffix=''){
 const raw=body instanceof File;
 const r=await fetch(url(action,id)+suffix,{method:body===undefined?'GET':'POST',headers:raw?{}:{'Content-Type':'application/json'},body:raw?body:JSON.stringify(body),cache:'no-store'});
 if(!r.ok){let failure=await r.json().catch(()=>({}));throw Object.assign(new Error(failure.error||'Request failed.'),{status:r.status});}
 return r.headers.get('content-type')?.includes('application/json')?r.json():r.blob();
}
const input=(name,label,type='text',value='')=>'<label>'+label+'<input required name="'+name+'" type="'+type+'" value="'+escape(value)+'"></label>';
const file=(label,accept)=>'<label>'+label+'<input required type="file" name="file" accept="'+accept+'"></label>';
const form=(action,fields,button,id='')=>'<form data-action="'+action+'" data-id="'+id+'">'+fields+'<button>'+button+'</button></form>';
const panel=(name,body)=>'<details><summary>'+name+'</summary>'+body+'</details>';
function profile(m){
 return panel('Headshot &amp; biography · '+(m.hasPhoto?'photo received':'photo needed')+' · '+(m.profile?.bio?'bio received':'bio needed'),form('bio','<label>Biography<textarea name="bio" rows="5" maxlength="5000">'+escape(m.profile?.bio)+'</textarea></label>','Save biography',m.id)+form('photo',file('Headshot · JPG or PNG, up to 4 MB','image/jpeg,image/png'),'Upload headshot',m.id)+'<button data-photo="'+m.id+'">View current headshot</button><div class="portrait"></div>');
}
function agreement(m){
 const fields=input('legal','Legal name','text',m.name)+input('character','Character','text',m.role)+input('credit','Screen credit / professional name','text',m.name)+input('rate','Agreed daily rate (USD)')+input('date','Agreement date','date')+input('start','First shoot date','date')+input('end','Last shoot date','date');
 return panel('Prepare actor agreement','<form data-action="agreement" data-id="'+m.id+'">'+fields+'<button value="preview">Preview agreement</button><button value="send">Create signing request</button></form>');
}
function login(){app.innerHTML='<section><h2>Cast &amp; crew login</h2><p>Enter the private access key provided by production.</p>'+form('login',input('code','Access key','password'),'Sign in')+'</section>';}
async function load(){
 let s;try{s=await request('home');}catch(e){if(e.status===401)return login();throw e;}
 let admin=s.admin;
 const setup=panel('Production controls',form('invite',input('name','Name')+input('email','Email','email')+input('role','Character or crew position'),'Create access key')+'<div id="invite"></div>'+form('resource',input('title','File title and revision date')+file('Script or call sheet · PDF, up to 4 MB','application/pdf'),'Post production PDF')+form('notice',input('title','Update title')+'<label>Production update<textarea required name="text"></textarea></label>','Post update')+form('master',file('Approved WrittenDarkContract-CastTemplate.pdf','application/pdf'),'Install private agreement master'));
 const rows=s.members.map(m=>'<section><h3>'+escape(m.name)+'</h3><p>'+escape(m.role)+' · '+escape(m.email)+'</p><strong>'+escape(m.agreement?.status||'Not sent')+'</strong> '+(m.agreement?.id?'<button data-status="'+m.id+'">Check status / open signing</button>':'')+profile(m)+(admin&&!m.agreement?agreement(m):'')+(admin?form('revoke','','Revoke portal access',m.id):'')+'</section>').join('');
 const updates=s.resources.map(r=>'<section><small>'+escape(new Date(r.created).toLocaleDateString())+' · '+escape(r.type)+'</small><h3>'+escape(r.title)+'</h3>'+(r.type==='PDF'?'<a href="'+escape(url('resource',r.id))+'">Download PDF</a>':'<p>'+escape(r.text)+'</p>')+'</section>').join('');
 app.innerHTML='<p>'+escape(s.film)+' · '+(admin?'Production administrator':'Cast &amp; crew')+'</p>'+form('logout','','Sign out')+(admin?setup:'')+'<h2>'+(admin?'Paperwork &amp; profiles':'My paperwork &amp; profile')+'</h2>'+(admin&&s.test?'<p>Signing is in test mode.</p>':'')+(rows||'<p>Your roster is empty. Create the first access key in Production controls.</p>')+'<div id="signing"></div><h2>Production board</h2>'+(updates||'<p>Scripts, call sheets and updates will appear here.</p>');
}
app.addEventListener('submit',async e=>{
 e.preventDefault();const f=e.target,a=f.dataset.action,id=f.dataset.id,data=Object.fromEntries(new FormData(f));const button=e.submitter;
 if((a==='revoke'||(a==='agreement'&&button.value==='send'))&&!confirm(a==='revoke'?'Revoke this member’s access immediately?':'Create a signing request for this actor and Heidi?'))return;
 button.disabled=true;message.textContent='';
 try{
  if(data.file&&data.file.size>4*1024*1024)throw Error('Choose a file up to 4 MB.');
  if(a==='agreement')data.preview=button.value==='preview';
  const result=await request(a,data.file||data,id,data.title&&data.file?'&'+new URLSearchParams({title:data.title}):'');
  if(a==='invite'){const box=document.querySelector('#invite');box.textContent='Share this key privately with '+data.name+' and direct them to /members/. Copy it before leaving: ';const code=document.createElement('code');code.textContent=result.code;box.append(code);f.reset();message.textContent='Access created. The key is displayed below.';return;}
  if(a==='agreement'&&data.preview){const href=URL.createObjectURL(result);const link=document.createElement('a');link.href=href;link.download='Agreement-preview.pdf';link.click();setTimeout(()=>URL.revokeObjectURL(href),60000);return;}
  await load();message.textContent=a==='login'?'':a==='logout'?'Signed out.':'Saved.';
 }catch(e){message.textContent=e.message;}finally{button.disabled=false;}
});
app.addEventListener('click',async e=>{
 const b=e.target;if(!b.dataset.status&&!b.dataset.photo)return;
 try{if(b.dataset.photo){const blob=await request('photo',undefined,b.dataset.photo);const img=new Image();img.alt='Submitted headshot';const src=URL.createObjectURL(blob);img.onload=()=>URL.revokeObjectURL(src);img.src=src;b.nextElementSibling.replaceChildren(img);return;}
 const r=await request('status',undefined,b.dataset.status);b.previousElementSibling.textContent=r.status;message.textContent=r.status;
 if(r.url){const u=new URL(r.url);if(u.protocol!=='https:'||!(u.hostname==='signwell.com'||u.hostname.endsWith('.signwell.com')))throw Error('Unexpected signing address.');
 const frame=document.createElement('iframe');frame.title='Private SignWell signing session';frame.src=u.href;document.querySelector('#signing').replaceChildren(frame);frame.scrollIntoView();}
 }catch(e){message.textContent=e.message;}
});
load().catch(e=>{app.textContent='Portal unavailable.';message.textContent=e.message;});
