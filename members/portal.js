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
 const offline=x=>x.offline?'<p><b>Signed offline</b> · '+escape(x.offline)+' · <a href="'+escape(url('offline',x.id))+'">Download private agreement</a></p>':panel('File a signed paper agreement',form('offline',file('Returned agreement PDF','application/pdf')+'<label>Paperwork status<select name="status"><option>Waiting on Heidi</option><option>Missing page 1 · waiting on Heidi</option><option>Complete</option></select></label>','File privately',x.id));
 const people=[...available,...s.members];
 function outstanding(person){
  const source=library.find(x=>x.id===(person.filmProfile||person.id));
  const status=source?.offline||person.agreement?.status||'No agreement on file';
  const gaps=[];
  if(!(person.profile?.bio??source?.bio)?.trim())gaps.push('Bio');
  if(!(person.hasPhoto||person.referencePhoto||source?.photo))gaps.push('Headshot');
  if(person.tasks?.some(t=>!t.done))gaps.push('Open tasks');
  const exempt=source?['nick','heidi'].includes(source.id):/^(?:nick williams|nicholas williams|heidi mikac)$/i.test(person.name.trim().replace(/\s+/g,' '));
  return {name:person.name,status,gaps,exempt};
 }
 const audit=people.map(outstanding);
 const group=(label,items,detail)=>'<details class="audit-group"><summary>'+label+' <b>'+items.length+'</b></summary>'+(items.length?'<ul>'+items.map(x=>'<li><strong>'+escape(x.name)+'</strong><span>'+escape(detail(x))+'</span></li>').join('')+'</ul>':'<p>Nothing outstanding.</p>')+'</details>';
 const attention='<section class="audit"><small>WRITTEN IN THE DARK · PRODUCTION OFFICE</small><h2>Needs attention</h2><p>Open a category to see who needs follow-up.</p>'+group('No agreement on file',audit.filter(x=>!x.exempt&&x.status==='No agreement on file'),x=>x.status)+group('Paperwork in progress',audit.filter(x=>(!x.exempt||/waiting on Heidi/i.test(x.status))&&!['Complete','No agreement on file'].includes(x.status)),x=>x.status)+group('Missing profile items or open tasks',audit.filter(x=>x.gaps.length),x=>x.gaps.join(' · '))+'</section>';
 const directory=admin?'<p>Profiles available to invite</p>'+available.map(x=>panel(escape(x.name)+' · '+escape(x.role),'<img loading="lazy" alt="Approved headshot" src="'+escape(x.photo)+'"><p style="white-space:pre-line">'+escape(x.bio)+'</p>'+offline(x)+(s.mailReady?form('invite',input('email','Invitation email','email')+['name','role','filmProfile'].map((k,i)=>'<input type="hidden" name="'+k+'" value="'+escape([x.name,x.role,x.id][i])+'">').join(''),'Invite '+escape(x.name)):'') )).join(''):'';
 const linkControls=m=>m.practice?'':m.filmProfile?form('publishProfile','','Approve & publish bio and headshot to film website',m.id):panel('Link an existing film profile',form('linkProfile','<label>Approved profile<select name="filmProfile" required><option value="">Select person</option>'+available.map(x=>'<option value="'+escape(x.id)+'" '+(x.name===m.name?'selected':'')+'>'+escape(x.name)+'</option>').join('')+'</select></label>','Confirm profile match',m.id));
 const audience='<fieldset><legend>Who should receive this?</legend><select name="audience" aria-label="Audience"><option value="all">Include all cast and crew</option><option value="selected">Select individuals</option></select><div data-recipients hidden>'+s.members.map(m=>'<label><input type="checkbox" style="width:auto;display:inline" name="recipient" value="'+escape(m.id)+'"> '+escape(m.name)+' · '+escape(m.role)+'</label>').join('')+'<small>Choose from the portal roster.</small></div></fieldset>';
 const setup=panel('Welcome video',form('welcomeSettings','<label>Direct video URL (MP4)<input type="url" name="video" value="'+escape(s.welcome?.video)+'"></label><label>Thumbnail URL (optional)<input type="url" name="poster" value="'+escape(s.welcome?.poster)+'"></label><label>English captions URL (.vtt)<input type="url" name="captions" value="'+escape(s.welcome?.captions)+'"></label>','Save welcome video'))+panel('Invite cast or crew',s.mailReady?form('invite',input('name','Name')+input('role','Character or crew title')+input('email','Email','email'),'Email invitation'):'<p>Email invitations are waiting for the production sender to be connected.</p>')+
 panel('Post a message',form('notice',audience+input('title','Subject')+'<label>Message<textarea required name="text"></textarea></label>','Post message'))+
 panel('Share a script or call sheet',form('resource',audience+input('title','Title and revision date')+file('Production PDF · up to 4 MB','application/pdf'),'Post file'))+
 panel('Agreement setup',form('master',file('Approved contract master','application/pdf'),'Install agreement master'));
 function tasks(m){return (m.tasks||[]).map(t=>'<div><strong>'+escape(t.title)+'</strong> '+(t.done?'Completed':admin?'Outstanding':form('finishTask','<input type="hidden" name="task" value="'+escape(t.id)+'">','Mark complete',m.id))+'</div>').join('');}
 function memberView(m){
  const items=[...(m.tasks||[])].sort((a,b)=>Number(a.done)-Number(b.done));
  const count=items.filter(t=>!t.done).length;
  const taskList=items.map(t=>'<div class="task-row '+(t.done?'task-done':'')+'"><span class="task-state">'+(t.done?'✓ Completed':'To do')+'</span><strong>'+escape(t.title)+'</strong>'+(t.done?'':form('finishTask','<input type="hidden" name="task" value="'+escape(t.id)+'">','Mark complete',m.id))+'</div>').join('');
  const photo=m.hasPhoto?url('photo',m.id):m.referencePhoto;
  return '<section class="member-panel member-tasks"><h2>My tasks</h2><p>'+(items.length?(count?count+' to complete':'All tasks completed.'):'No tasks assigned yet.')+'</p>'+taskList+'</section>'+
   '<section class="member-panel member-paperwork"><h2>My documents</h2>'+(['Complete','Waiting on Heidi'].includes(m.offlineStatus||m.agreement?.status)?'<strong>Complete</strong><p>Your part is complete.</p>':m.offlineStatus?'<strong>'+escape(m.offlineStatus)+'</strong>':m.agreement?.id?'<strong>'+escape(m.agreement.status)+'</strong> <button data-status="'+m.id+'">Review my agreement</button>':'No documents assigned yet.')+'<div id="signing"></div></section>'+
   '<section class="member-panel member-profile"><h2>My profile</h2><p>'+escape(m.name)+' · '+escape(m.role)+'</p>'+(photo?'<img data-headshot src="'+escape(photo)+'" alt="Your headshot">':'')+form('photo',file(m.hasPhoto?'Replace your headshot':'Upload your headshot · JPG or PNG, up to 4 MB','image/jpeg,image/png'),'Save headshot',m.id)+form('bio','<label>My bio<textarea name="bio" rows="5" maxlength="5000">'+escape(m.profile?.bio)+'</textarea></label>','Save bio',m.id)+'</section>';
 }
 const rows=s.members.map(m=>'<section><h3>'+escape(admin?m.name:'My dashboard')+'</h3><p>'+escape(m.role)+' · '+escape(m.email)+'</p>'+
 (admin?'<strong>'+escape(m.agreement?.status||'Agreement not sent')+'</strong> ':'')+
 (m.agreement?.id?'<button data-status="'+m.id+'">'+(admin?'Check agreement status':'Review my agreement')+'</button>':'')+
 (m.referencePhoto&&!m.hasPhoto?'<img data-headshot src="'+escape(m.referencePhoto)+'" alt="Approved film headshot">':'')+(admin?profile(m):(m.hasPhoto?'<img data-headshot alt="Your saved headshot" src="'+escape(url('photo',m.id))+'">':'')+form('photo',file(m.hasPhoto?'Replace your headshot':'Upload your headshot · JPG or PNG, up to 4 MB','image/jpeg,image/png'),'Save headshot',m.id)+form('bio','<label>My bio<textarea name="bio" rows="4" maxlength="5000" placeholder="Tell us a little about yourself.">'+escape(m.profile?.bio)+'</textarea></label>','Save bio',m.id))+
 tasks(m)+(admin&&m.filmProfile&&library.find(x=>x.id===m.filmProfile)?offline(library.find(x=>x.id===m.filmProfile)):'')+(admin?linkControls(m):'')+(admin?panel('Assign a task',form('task',input('title','What needs to be done?'),'Assign task',m.id)):'')+
 (admin&&!m.agreement?agreement(m):'')+(admin?panel('Manage access',(!m.activated&&s.mailReady?form('resend','','Resend invitation',m.id):'')+form('revoke','','Revoke access',m.id)):'')+'</section>').join('');
 const account=s.passwordSet?'':'<section><h2>Set your password</h2><p>Your sign-in name is <strong>'+escape(admin?s.self:s.members[0].email)+'</strong>.</p>'+form('choosePassword',newPassword,'Save my password')+'</section>';
 const updates=s.resources.map(r=>'<section><small>'+escape(new Date(r.created).toLocaleDateString())+' · '+escape(r.type)+'</small><h3>'+escape(r.title)+'</h3>'+(r.type==='PDF'?'<a href="'+escape(url('resource',r.id))+'">Download PDF</a>':'<p>'+escape(r.text)+'</p>')+'</section>').join('');
 app.innerHTML='<p>'+escape(s.film)+' · '+(admin?'Production administrator':'Cast &amp; crew')+'</p>'+form('logout','','Sign out')+account+(admin?attention+'<h2>Production tools</h2>'+setup+panel('Browse film profiles ('+people.length+')',directory):'')+'<h2>'+(admin?'Paperwork &amp; profiles':'My paperwork &amp; profile')+'</h2>'+(admin&&s.test?'<p>Signing is in test mode.</p>':'')+(rows||'<p>Your roster is empty. Use Invite cast or crew to get started.</p>')+'<div id="signing"></div><h2>Production board</h2>'+(updates||'<p>Scripts, call sheets and updates will appear here.</p>');
 if(admin) mountCalendar();
 if(!admin)app.innerHTML='<p>'+escape(s.film)+' · Cast &amp; crew</p>'+form('logout','','Sign out')+account+s.members.map(memberView).join('')+'<section class="member-panel member-board"><h2>Production board</h2>'+(updates||'<p>No updates posted yet.</p>')+'</section>';
 if(!admin&&s.welcome?.video){
  const section=document.createElement('section');section.className='member-panel';section.innerHTML='<small>CAST &amp; CREW ORIENTATION</small><h2>Welcome to Written in the Dark</h2><div style="background:linear-gradient(125deg,#492430,#15161a);padding:16px"><video controls playsinline preload="metadata" style="width:100%;display:none"></video><button type="button">▶ Play welcome video</button></div><p data-audio hidden>Sound is off. Use the speaker control to hear Heidi and Nick.</p>';
  app.querySelector('.member-tasks')?.before(section);
  const video=section.querySelector('video'),play=section.querySelector('button'),hint=section.querySelector('[data-audio]');
  if(s.welcome.captions){
    const captions=document.createElement('track');
    captions.kind='captions';captions.label='English';captions.srclang='en';captions.default=true;
    if(new URL(s.welcome.captions).origin!==location.origin)video.crossOrigin='anonymous';
    captions.src=s.welcome.captions;video.append(captions);captions.track.mode='showing';
  }
  video.src=s.welcome.video;
  const card=()=>{video.style.display=s.welcome.poster?'block':'none';play.hidden=false;hint.hidden=true;};
  if(s.welcome.poster)video.poster=s.welcome.poster;card();
  let recorded=s.welcomePlayed;
  video.addEventListener('playing',()=>{video.style.display='block';play.hidden=true;hint.hidden=!video.muted;if(!recorded){recorded=true;request('welcomePlayed',{}).catch(()=>{recorded=false;});}});
  video.addEventListener('volumechange',()=>{hint.hidden=!video.muted||video.paused;});
  video.addEventListener('ended',()=>{video.load();card();});
  play.onclick=()=>{video.muted=false;video.play().catch(()=>{message.textContent='Video unavailable. Please try again.';card();});};
  if(!recorded){video.play().catch(()=>{if(!section.isConnected)return;video.muted=true;video.play().catch(card);});}
 }
 for(const m of s.members){
  const photo=app.querySelector('form[data-action="photo"][data-id="'+m.id+'"]'), bio=app.querySelector('form[data-action="bio"][data-id="'+m.id+'"]');
  if(photo&&m.hasPhoto)profileStatus(photo,m.photoName?'Saved · '+m.photoName:'Headshot saved');
  if(bio&&m.profile)profileStatus(bio,'Saved');
 }
}
app.addEventListener('change',e=>{if(e.target.name==='audience')e.target.form.querySelector('[data-recipients]').hidden=e.target.value!=='selected';});
app.addEventListener('submit',async e=>{
 e.preventDefault();const f=e.target,a=f.dataset.action,id=f.dataset.id,data=Object.fromEntries(new FormData(f));const button=e.submitter;
 if(a==='publishProfile'&&!confirm('Publish this member’s saved biography and headshot on the public Written in the Dark website?'))return;
 if((a==='revoke'||(a==='agreement'&&button.value==='send'))&&!confirm(a==='revoke'?'Revoke this member’s access immediately?':'Create a signing request for this actor and Heidi?'))return;
 button.disabled=true;message.textContent='';
 try{
  if(data.file&&data.file.size>4*1024*1024)throw Error('Choose a file up to 4 MB.');
  if(a==='agreement')data.preview=button.value==='preview';
  if(a==='activate')data.ticket=ticket;
  const targetParams=new URLSearchParams({title:data.title||''});
  if(data.audience){data.recipients=new FormData(f).getAll('recipient');if(data.audience==='selected'&&!data.recipients.length)throw Error('Select at least one recipient.');targetParams.set('audience',data.audience);for(const who of data.recipients)targetParams.append('recipient',who);}
  const result=await request(a,data.file||data,id,a==='offline'?'&'+new URLSearchParams({status:data.status}):a==='photo'?'&'+new URLSearchParams({filename:data.file.name}):data.title&&data.file?'&'+targetParams:'');
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
 const r=await request('status',undefined,b.dataset.status);if(b.closest('.member-paperwork')&&r.status==='Waiting on Heidi'){r.status='Complete';b.hidden=true;}if(b.previousElementSibling?.tagName==='STRONG')b.previousElementSibling.textContent=r.status;message.textContent=r.status;
 if(r.url){const u=new URL(r.url);if(u.protocol!=='https:'||!(u.hostname==='signwell.com'||u.hostname.endsWith('.signwell.com')))throw Error('Unexpected signing address.');
 const frame=document.createElement('iframe');frame.title='Private SignWell signing session';frame.src=u.href;document.querySelector('#signing').replaceChildren(frame);frame.scrollIntoView();}
 }catch(e){message.textContent=e.message;}
});
load().catch(e=>{app.textContent='Portal unavailable.';message.textContent=e.message;});


async function mountCalendar(){
 const panel=document.createElement('aside');
 panel.hidden=true;
 app.prepend(panel);
 const refresh=async()=>{
  try{
   const result=await request('calendarEvents');
   if(!panel.isConnected)return;
   if(!result.connected){
    if(!new URLSearchParams(location.search).has('connectCalendar'))return;
    const connect=document.createElement('button');
    connect.textContent='Connect Outlook calendar';
    connect.onclick=async()=>{try{location.assign((await request('calendarConnect',{})).url);}catch{message.textContent='Calendar connection unavailable. Check the production calendar secret.';}};
    panel.replaceChildren(connect);
   }else{
    const list=document.createElement('ul');
    for(const event of result.items){
     const item=document.createElement('li');
     const date=new Date(event.start+'Z');
     const when=event.allDay?event.start.slice(0,10)+' · All day':date.toLocaleString('en-US',{timeZone:'America/Indiana/Indianapolis',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
     item.textContent=when+' — '+event.title;
     list.append(item);
    }
    const heading=document.createElement('h2');heading.textContent='Production calendar';
    const note=document.createElement('p');note.textContent=result.items.length?'Next 30 days · Eastern time':'No upcoming events in the next 30 days.';
    panel.replaceChildren(heading,note,list);
   }
   panel.className='exchange-calendar';panel.hidden=false;
  }catch{if(!panel.hidden)panel.textContent='Calendar unavailable. Refresh to try again.';}
 };
 await refresh();
 const timer=setInterval(()=>{if(!panel.isConnected)clearInterval(timer);else if(!document.hidden&&!panel.hidden)refresh();},300000);
}
