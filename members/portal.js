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
 const fields=input('legal','Legal name','text',m.name)+input('character','Character','text',m.role)+input('credit','Screen credit / professional name','text',m.name)+input('rate','Agreed daily rate (USD)')+input('date','Agreement date','date')+input('start','First shoot date','date');
 return panel('Prepare actor agreement','<form data-action="agreement" data-id="'+m.id+'">'+fields+'<button value="preview">Preview agreement</button><button value="send">Create signing request</button></form>');
}
const ticket=new URLSearchParams(location.hash.slice(1)).get('invite');
const newPassword='<label>Choose a password (12 or more characters)<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label>';
function profileStatus(f,text){
 let note=f.querySelector('output');
 if(!note){note=document.createElement('output');note.style.display='block';f.append(note);}
 note.textContent=text;
}
app.addEventListener('input',e=>{
 const f=e.target.form;
 if(f?.dataset.action==='bio')profileStatus(f,'Unsaved changes');
 if(f?.dataset.action==='photo'&&e.target.files?.length)profileStatus(f,'Selected · '+e.target.files[0].name+' (not saved yet)');
});
function login(){
 app.innerHTML='<section><h2>Welcome back</h2>'+form('passwordLogin','<label>Email or admin name<input name="username" autocomplete="username" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label>','Sign in')+'</section>'+panel('Already have an access key?',form('login',input('code','Existing access key','password'),'Continue to password setup'));
}
async function load(){
 if(ticket&&location.hash){app.innerHTML='<section><h2>Welcome to the cast &amp; crew</h2><p>Choose your password to open your dashboard. Next time, sign in with the email where you received this invitation.</p>'+form('activate',newPassword,'Create my account')+'</section>';return;}
 let s;try{s=await request('home');}catch(e){if(e.status===401)return login();throw e;}
 let admin=s.admin;
 const library=s.catalog||[];
 const available=library.filter(x=>!s.members.some(m=>m.filmProfile===x.id));
 const directory=admin?'<h2>Film profiles ('+available.length+' available)</h2>'+available.map(x=>panel(escape(x.name)+' · '+escape(x.role),'<img loading="lazy" alt="Approved headshot" src="'+escape(x.photo)+'"><p style="white-space:pre-line">'+escape(x.bio)+'</p>'+(s.mailReady?form('invite',input('email','Invitation email','email')+['name','role','filmProfile'].map((k,i)=>'<input type="hidden" name="'+k+'" value="'+escape([x.name,x.role,x.id][i])+'">').join(''),'Invite '+escape(x.name)):'') )).join(''):'';
 const linkControls=m=>m.filmProfile?form('publishProfile','','Approve & publish bio and headshot to film website',m.id):panel('Link an existing film profile',form('linkProfile','<label>Approved profile<select name="filmProfile" required><option value="">Select person</option>'+available.map(x=>'<option value="'+escape(x.id)+'" '+(x.name===m.name?'selected':'')+'>'+escape(x.name)+'</option>').join('')+'</select></label>','Confirm profile match',m.id));
 const setup=panel('Invite cast or crew',s.mailReady?form('invite',input('name','Name')+input('role','Character or crew title')+input('email','Email','email'),'Email invitation'):'<p>Email invitations are waiting for the production sender to be connected.</p>')+
 panel('Post a message',form('notice',input('title','Subject')+'<label>Message<textarea required name="text"></textarea></label>','Post message'))+
 panel('Share a script or call sheet',form('resource',input('title','Title and revision date')+file('Production PDF · up to 4 MB','application/pdf'),'Post file'))+
 panel('Agreement setup',form('master',file('Approved contract master','application/pdf'),'Install agreement master'));
 function tasks(m){return (m.tasks||[]).map(t=>'<div><strong>'+escape(t.title)+'</strong> '+(t.done?'Completed':admin?'Outstanding':form('finishTask','<input type="hidden" name="task" value="'+escape(t.id)+'">','Mark complete',m.id))+'</div>').join('');}
 function memberView(m){
  const items=[...(m.tasks||[])].sort((a,b)=>Number(a.done)-Number(b.done));
  const count=items.filter(t=>!t.done).length;
  const taskList=items.map(t=>'<div class="task-row '+(t.done?'task-done':'')+'"><span class="task-state">'+(t.done?'✓ Completed':'To do')+'</span><strong>'+escape(t.title)+'</strong>'+(t.done?'':form('finishTask','<input type="hidden" name="task" value="'+escape(t.id)+'">','Mark complete',m.id))+'</div>').join('');
  const photo=m.hasPhoto?url('photo',m.id):m.referencePhoto;
  return '<section class="member-panel member-tasks"><h2>My tasks</h2><p>'+(items.length?(count?count+' to complete':'All tasks completed.'):'No tasks assigned yet.')+'</p>'+taskList+'</section>'+
   '<section class="member-panel member-paperwork"><h2>My documents</h2>'+(m.agreement?.id?'<strong>'+escape(m.agreement.status)+'</strong> <button data-status="'+m.id+'">Review my agreement</button>':'No documents assigned yet.')+'<div id="signing"></div></section>'+
   '<section class="member-panel member-profile"><h2>My profile</h2><p>'+escape(m.name)+' · '+escape(m.role)+'</p>'+(photo?'<img data-headshot src="'+escape(photo)+'" alt="Your headshot">':'')+form('photo',file(m.hasPhoto?'Replace your headshot':'Upload your headshot · JPG or PNG, up to 4 MB','image/jpeg,image/png'),'Save headshot',m.id)+form('bio','<label>My bio<textarea name="bio" rows="5" maxlength="5000">'+escape(m.profile?.bio)+'</textarea></label>','Save bio',m.id)+'</section>';
 }
 const rows=s.members.map(m=>'<section><h3>'+escape(admin?m.name:'My dashboard')+'</h3><p>'+escape(m.role)+' · '+escape(m.email)+'</p>'+
 (admin?'<strong>'+escape(m.agreement?.status||'Agreement not sent')+'</strong> ':'')+
 (m.agreement?.id?'<button data-status="'+m.id+'">'+(admin?'Check agreement status':'Review my agreement')+'</button>':'')+
 (m.referencePhoto&&!m.hasPhoto?'<img data-headshot src="'+escape(m.referencePhoto)+'" alt="Approved film headshot">':'')+(admin?profile(m):(m.hasPhoto?'<img data-headshot alt="Your saved headshot" src="'+escape(url('photo',m.id))+'">':'')+form('photo',file(m.hasPhoto?'Replace your headshot':'Upload your headshot · JPG or PNG, up to 4 MB','image/jpeg,image/png'),'Save headshot',m.id)+form('bio','<label>My bio<textarea name="bio" rows="4" maxlength="5000" placeholder="Tell us a little about yourself.">'+escape(m.profile?.bio)+'</textarea></label>','Save bio',m.id))+
 tasks(m)+(admin?linkControls(m):'')+(admin?panel('Assign a task',form('task',input('title','What needs to be done?'),'Assign task',m.id)):'')+
 (admin&&!m.agreement?agreement(m):'')+(admin?panel('Manage access',(!m.activated&&s.mailReady?form('resend','','Resend invitation',m.id):'')+form('revoke','','Revoke access',m.id)):'')+'</section>').join('');
 const account=s.passwordSet?'':'<section><h2>Set your password</h2><p>Your sign-in name is <strong>'+escape(admin?s.self:s.members[0].email)+'</strong>.</p>'+form('choosePassword',newPassword,'Save my password')+'</section>';
 const updates=s.resources.map(r=>'<section><small>'+escape(new Date(r.created).toLocaleDateString())+' · '+escape(r.type)+'</small><h3>'+escape(r.title)+'</h3>'+(r.type==='PDF'?'<a href="'+escape(url('resource',r.id))+'">Download PDF</a>':'<p>'+escape(r.text)+'</p>')+'</section>').join('');
 app.innerHTML='<p>'+escape(s.film)+' · '+(admin?'Production administrator':'Cast &amp; crew')+'</p>'+form('logout','','Sign out')+account+(admin?setup+directory:'')+'<h2>'+(admin?'Paperwork &amp; profiles':'My paperwork &amp; profile')+'</h2>'+(admin&&s.test?'<p>Signing is in test mode.</p>':'')+(rows||'<p>Your roster is empty. Use Invite cast or crew to get started.</p>')+'<div id="signing"></div><h2>Production board</h2>'+(updates||'<p>Scripts, call sheets and updates will appear here.</p>');
 if(!admin)app.innerHTML='<p>'+escape(s.film)+' · Cast &amp; crew</p>'+form('logout','','Sign out')+account+s.members.map(memberView).join('')+'<section class="member-panel member-board"><h2>Production board</h2>'+(updates||'<p>No updates posted yet.</p>')+'</section>';
 for(const m of s.members){
  const photo=app.querySelector('form[data-action="photo"][data-id="'+m.id+'"]'), bio=app.querySelector('form[data-action="bio"][data-id="'+m.id+'"]');
  if(photo&&m.hasPhoto)profileStatus(photo,m.photoName?'Saved · '+m.photoName:'Headshot saved');
  if(bio&&m.profile)profileStatus(bio,'Saved');
 }
}
app.addEventListener('submit',async e=>{
 e.preventDefault();const f=e.target,a=f.dataset.action,id=f.dataset.id,data=Object.fromEntries(new FormData(f));const button=e.submitter;
 if(a==='publishProfile'&&!confirm('Publish this member’s saved biography and headshot on the public Written in the Dark website?'))return;
 if((a==='revoke'||(a==='agreement'&&button.value==='send'))&&!confirm(a==='revoke'?'Revoke this member’s access immediately?':'Create a signing request for this actor and Heidi?'))return;
 button.disabled=true;message.textContent='';
 try{
  if(data.file&&data.file.size>4*1024*1024)throw Error('Choose a file up to 4 MB.');
  if(a==='agreement')data.preview=button.value==='preview';
  if(a==='activate')data.ticket=ticket;
  const result=await request(a,data.file||data,id,a==='photo'?'&'+new URLSearchParams({filename:data.file.name}):data.title&&data.file?'&'+new URLSearchParams({title:data.title}):'');
  if(a==='photo'||a==='bio'){
   const section=f.closest('section'), details=f.closest('details');
   if(a==='photo'){
    let img=section.querySelector('[data-headshot]');
    if(!img){img=document.createElement('img');img.dataset.headshot='';img.alt='Saved headshot';f.before(img);}
    img.src=url('photo',id)+'&updated='+Date.now();
   }
   if(details){const summary=details.querySelector('summary');summary.textContent=summary.textContent.replace(a==='photo'?'photo needed':'bio needed',a==='photo'?'photo received':data.bio.trim()?'bio received':'bio needed');}
   if(a==='photo'&&f.elements.file.files[0]===data.file)profileStatus(f,'Saved · '+data.file.name);
   if(a==='bio')profileStatus(f,f.elements.bio.value===data.bio?'Saved':'Unsaved changes');
   message.textContent=a==='photo'?'Headshot saved.':'Bio saved.';
   return;
  }
  if(a==='activate')history.replaceState(null,'',location.pathname);
  if(a==='agreement'&&data.preview){const href=URL.createObjectURL(result);const link=document.createElement('a');link.href=href;link.download='Agreement-preview.pdf';link.click();setTimeout(()=>URL.revokeObjectURL(href),60000);return;}
  await load();message.textContent=['invite','resend'].includes(a)?'Invitation queued for email delivery.':['login','passwordLogin','activate'].includes(a)?'':a==='logout'?'Signed out.':'Saved.';
 }catch(e){message.textContent=e.message;}finally{button.disabled=false;}
});
app.addEventListener('click',async e=>{
 const b=e.target;if(!b.dataset.status&&!b.dataset.photo)return;
 try{if(b.dataset.photo){const blob=await request('photo',undefined,b.dataset.photo);const img=new Image();img.alt='Submitted headshot';const src=URL.createObjectURL(blob);img.onload=()=>URL.revokeObjectURL(src);img.src=src;b.nextElementSibling.replaceChildren(img);return;}
 const r=await request('status',undefined,b.dataset.status);if(b.previousElementSibling?.tagName==='STRONG')b.previousElementSibling.textContent=r.status;message.textContent=r.status;
 if(r.url){const u=new URL(r.url);if(u.protocol!=='https:'||!(u.hostname==='signwell.com'||u.hostname.endsWith('.signwell.com')))throw Error('Unexpected signing address.');
 const frame=document.createElement('iframe');frame.title='Private SignWell signing session';frame.src=u.href;document.querySelector('#signing').replaceChildren(frame);frame.scrollIntoView();}
 }catch(e){message.textContent=e.message;}
});
load().catch(e=>{app.textContent='Portal unavailable.';message.textContent=e.message;});

