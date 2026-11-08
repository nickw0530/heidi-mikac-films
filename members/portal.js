const app=document.querySelector('#app'), message=document.querySelector('#message');
const endpoint='/.netlify/functions/portal';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let activeView=new URLSearchParams(location.search).get('view')==='people'?'people':'overview',peopleSearch='',peopleFilter='all',lastState,offlineBulkInProgress=false;
const dirty=()=>[...app.querySelectorAll('form[data-dirty]')];
window.addEventListener('beforeunload',e=>{if(dirty().length){e.preventDefault();e.returnValue='';}});
let selectedProduction=new URLSearchParams(location.search).get('production')||'';
const url=(action,id='',production=selectedProduction)=>endpoint+'?'+new URLSearchParams({action,id,...(production?{production}:{})});
async function request(action,body,id='',suffix='',production=selectedProduction){
 const raw=body instanceof File;
 const r=await fetch(url(action,id,production)+suffix,{method:body===undefined?'GET':'POST',headers:raw?{}:{'Content-Type':'application/json'},body:raw?body:JSON.stringify(body),cache:'no-store'});
 if(!r.ok){let failure=await r.json().catch(()=>({}));throw Object.assign(new Error(failure.error||'Request failed.'),{status:r.status});}
 return r.headers.get('content-type')?.includes('application/json')?r.json():r.blob();
}
let signingLibrary,signingSession,signingRequest=0;
function clearSigning(){
 signingRequest++;
 const session=signingSession;signingSession=null;
 if(!session)return;
 clearTimeout(session.timeout);
 try{if(typeof session.embed?.close==='function')session.embed.close();}catch{}
 session.container.replaceChildren();
}
function loadSigningLibrary(){
 if(typeof window.SignWellEmbed==='function')return Promise.resolve(window.SignWellEmbed);
 if(!signingLibrary)signingLibrary=new Promise((resolve,reject)=>{
  const script=document.createElement('script');
  const fail=()=>{clearTimeout(timer);script.remove();reject(Error('Signing window unavailable.'));};
  const timer=setTimeout(fail,15000);
  script.src='https://static.signwell.com/assets/embedded.js';script.async=true;
  script.onload=()=>{clearTimeout(timer);if(typeof window.SignWellEmbed==='function')resolve(window.SignWellEmbed);else fail();};
  script.onerror=fail;document.head.append(script);
 }).catch(error=>{signingLibrary=null;throw error;});
 return signingLibrary;
}
async function showSigning(rawUrl,id,container,attempt){
 const u=new URL(rawUrl);
 if(u.protocol!=='https:'||u.username||u.password||!(u.hostname==='signwell.com'||u.hostname.endsWith('.signwell.com')))throw Error('Unexpected signing address.');
 const session={container};signingSession=session;
 const options=document.createElement('p'),link=document.createElement('a'),refresh=document.createElement('button');
 link.href=u.href;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open agreement in a new tab';
 refresh.type='button';refresh.dataset.status=id;refresh.textContent='Refresh agreement status';
 options.append(link,document.createTextNode(' '),refresh);
 const note=document.createElement('p');note.setAttribute('role','status');note.textContent='Loading your agreement… You can open it in a new tab at any time.';
 const mount=document.createElement('div');mount.id='signwell-agreement-'+attempt;
 container.replaceChildren(options,note,mount);container.scrollIntoView({block:'start'});
 const current=()=>signingSession===session&&attempt===signingRequest&&container.isConnected;
 const fallback=()=>{
  if(!current()||session.completed||session.failed)return;
  session.failed=true;clearTimeout(session.timeout);
  note.textContent='The agreement could not open inside the portal. Use “Open agreement in a new tab” above, then return here to refresh its status.';
  try{if(typeof session.embed?.close==='function')session.embed.close();}catch{}
  mount.replaceChildren();mount.hidden=true;
 };
 session.timeout=setTimeout(fallback,20000);
 try{
  const Embed=await loadSigningLibrary();if(!current()||session.failed)return;
  session.embed=new Embed({url:u.href,containerId:mount.id,allowRedirect:false,events:{
   documentLoaded:()=>{if(current()&&!session.failed&&!session.completed){clearTimeout(session.timeout);note.textContent='Review and sign your agreement below, or use the new-tab link above.';}},
   error:fallback,
   closed:()=>{if(current()&&!session.failed&&!session.completed){session.failed=true;clearTimeout(session.timeout);mount.replaceChildren();note.textContent='Signing window closed. Open the agreement in a new tab or refresh its status above.';}},
   completed:async()=>{
    if(!current()||session.failed||session.completed)return;
    const production=selectedProduction;
    session.completed=true;clearTimeout(session.timeout);note.textContent='Signature submitted. Refreshing your agreement status…';
    try{await request('status',undefined,id);if(!current())return;await load();message.textContent='Agreement status refreshed.';}
    catch{const text='Your signature was submitted. Refresh the page to check the latest agreement status.';if(current())note.textContent=text;if(selectedProduction===production&&container.isConnected)message.textContent=text;}
   }
  }});
  session.embed.open();
 }catch{fallback();}
}
const input=(name,label,type='text',value='')=>'<label>'+label+'<input required name="'+name+'" type="'+type+'" value="'+escape(value)+'"></label>';
const file=(label,accept)=>'<label>'+label+'<input required type="file" name="file" accept="'+accept+'"></label>';
const form=(action,fields,button,id='')=>'<form data-action="'+action+'" data-id="'+id+'">'+fields+'<button>'+button+'</button></form>';
const panel=(name,body)=>'<details><summary>'+name+'</summary>'+body+'</details>';
function profile(m){
 return panel('Headshot &amp; biography · '+((m.hasPhoto||m.referencePhoto)?'photo received':'photo needed')+' · '+(m.profile?.bio?'bio received':'bio needed'),form('bio','<label>Biography<textarea name="bio" rows="5" maxlength="5000">'+escape(m.profile?.bio)+'</textarea></label>','Save biography',m.id)+form('photo',file('Headshot · JPG or PNG, up to 4 MB','image/jpeg,image/png'),'Upload headshot',m.id)+(m.hasPhoto?'<button data-photo="'+m.id+'">View current headshot</button><div class="portrait"></div>':''));
}
function agreement(m){
 const fields=input('legal','Legal name','text',m.name)+input('character','Character','text',m.role)+input('credit','Screen credit / professional name','text',m.name)+input('rate','Agreed daily rate (USD)')+input('date','Agreement date','date')+input('start','First shoot date','date');
 return panel('Prepare agreement for '+escape(lastState.film),'<form data-action="agreement" data-id="'+m.id+'">'+fields+'<button value="preview">Preview agreement</button><button value="send">Create signing request</button></form>');
}
const ticket=new URLSearchParams(location.hash.slice(1)).get('invite');
const resetTicket=new URLSearchParams(location.hash.slice(1)).get('reset');
const newPassword='<label>Choose a password (12 or more characters)<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label>';
function profileStatus(f,text){
 let note=f.querySelector('output');
 if(!note){note=document.createElement('output');note.style.display='block';f.append(note);}
 note.textContent=text;
}
app.addEventListener('input',e=>{
 const f=e.target.form;if(f)f.dataset.dirty='true';
 if(f?.dataset.action==='bio')profileStatus(f,'Unsaved changes');
 if(f?.dataset.action==='photo'&&e.target.files?.length)profileStatus(f,'Selected · '+e.target.files[0].name+' (not saved yet)');
});
function login(){
 clearSigning();
 app.innerHTML='<section><h2>Welcome back</h2>'+form('passwordLogin','<label>Email or admin name<input name="username" autocomplete="username" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label>','Sign in')+'</section>'+panel('Forgot your password?',form('requestReset','<label>Email or admin name<input name="username" autocomplete="username" required></label>','Email reset link'))+(new URLSearchParams(location.search).has('setup')?panel('First-time admin setup',form('login',input('code','Existing access key','password'),'Continue to password setup')):'');
}
function adminProductionPicker(productions, selected){
 const all=selected.length===productions.length;
 const checkbox=(value,label,checked)=>'<label><input style="width:auto;display:inline" type="checkbox" data-office-film="'+escape(value)+'" '+(checked?'checked':'')+'> '+escape(label)+'</label>';
 return '<fieldset class="production-picker"><legend>Productions</legend>'+checkbox('all','All productions',all)+productions.map(p=>checkbox(p.id,p.name,selected.includes(p.id))).join('')+'</fieldset>';
}

function combinedPeople(states){
 const people=new Map();
 for(const state of states){
  const linked=new Set(state.members.map(m=>m.filmProfile).filter(Boolean));
  const add=(key,person)=>{
   if(!people.has(key))people.set(key,{name:person.name,films:[]});
   people.get(key).films.push({id:state.productionId,name:state.film,role:person.role});
  };
  for(const member of state.members)add('account/'+member.id,member);
  for(const profile of state.catalog){
   if(!linked.has(profile.id))add(state.productionId+'/'+profile.id,profile);
  }
 }
 return [...people.values()].sort((a,b)=>a.name.localeCompare(b.name));
}

function renderCombinedOffice(states,picker){
 const people=combinedPeople(states);
 const query=app.querySelector('[data-roster-search]')?.value||'';
 const rows=people.map(person=>'<section data-roster-name="'+escape([person.name,...person.films.map(f=>f.role)].join(' ').toLowerCase())+'"><strong>'+escape(person.name)+'</strong>'+person.films.map(f=>'<p>'+escape(f.name)+(f.role?' · '+escape(f.role):'')+'</p>').join('')+'</section>').join('');
 app.innerHTML='<div class="office-header">'+picker+form('logout','','Sign out')+'</div><p>Manage profiles and paperwork in '+states.map(f=>'<a href="?'+escape(new URLSearchParams({production:f.productionId,view:'people'}).toString())+'">'+escape(f.film)+'</a>').join(' or ')+'.</p><h2>People &amp; profiles <span class="count">'+people.length+'</span></h2><label>Search name or role<input type="search" data-roster-search value="'+escape(query)+'"></label>'+rows;
 if(query)app.querySelector('[data-roster-search]').dispatchEvent(new Event('input',{bubbles:true}));
}

async function load(){
 clearSigning();
 const savedForms=dirty().map(f=>({action:f.dataset.action,id:f.dataset.id,node:f}));
 const openDetails=[...app.querySelectorAll('details[open]')].map(d=>d.dataset.person||d.querySelector(':scope > summary')?.textContent);
 if(resetTicket&&location.hash){app.innerHTML='<section><h2>Reset your password</h2>'+form('resetPassword',newPassword,'Save new password')+'</section>';return;}
 if(ticket&&location.hash){app.innerHTML='<section><h2>Welcome to the cast &amp; crew</h2><p>Choose your password to open your dashboard. Next time, sign in with the email where you received this invitation.</p>'+form('activate',newPassword,'Create my account')+'</section>';return;}
 let s;try{s=await request('home');}catch(e){if(e.status===401)return login();throw e;}
 lastState=s;let admin=s.admin;
 selectedProduction=s.productionId;
 const requested=new URLSearchParams(location.search).getAll('films');
 const selected=s.productions.filter(p=>requested.includes(p.id)).map(p=>p.id);
 if(!selected.length)selected.push(s.productionId);
 const productionPicker=admin?adminProductionPicker(s.productions,selected):s.productions.length?'<label class="production-picker">Production<select data-production>'+s.productions.map(p=>'<option value="'+escape(p.id)+'" '+(p.id===s.productionId?'selected':'')+'>'+escape(p.name)+'</option>').join('')+'</select></label>':'<p>No productions assigned yet. Production will add them to your account.</p>';
 if(admin&&selected.length>1){
  const states=await Promise.all(selected.map(id=>id===s.productionId?s:request('home',undefined,'','',id)));
  renderCombinedOffice(states,productionPicker);
  return;
 }
 const reviews=(s.productionReviews||[]).map(r=>panel(escape(r.name),'<p>'+escape(r.bio||'Biography needed')+'</p>'+(r.photo?'<img alt="Headshot submitted for approval" style="width:8rem;max-width:100%" src="'+escape(r.photo==='uploaded'?url('photo',r.id)+'&v='+r.revision:r.photo)+'">':'<p>Headshot needed</p>')+'<form data-action="reviewProduction" data-id="'+escape(r.id)+'"><input type="hidden" name="requestId" value="'+escape(r.requestId)+'"><input type="hidden" name="revision" value="'+escape(r.revision)+'"><label>Character or crew title<input required name="role" value="'+escape(r.role)+'"></label><button value="approve" '+(r.bio.trim()&&r.photo?'':'disabled')+'>Approve for '+escape(s.film)+'</button> <button formnovalidate value="decline">Decline</button></form>')).join('');
 const assignmentsPanel=admin?panel('Manage production assignments ('+s.accounts.length+')','<p>One account, one shared biography and headshot. Check each production this person belongs to. Saved profiles appear automatically on the selected film websites. Named Test accounts stay private.</p>'+s.accounts.map(m=>panel(escape(m.name),'<form data-action="enrollments" data-id="'+m.id+'">'+s.productions.map(p=>{
  const assigned=m.productions[p.id];
  const role=assigned?.role||'';
  return '<fieldset><label><input style="width:auto;display:inline" type="checkbox" name="production" value="'+p.id+'" '+(assigned?'checked':'')+'> '+escape(p.name)+'</label><label>Character / crew title for this production<input name="role_'+p.id+'" value="'+escape(role)+'" required '+(assigned?'':'disabled')+'></label></fieldset>';
 }).join('')+'<button>Save productions</button></form>')).join('')):'';
 const library=s.catalog||[];
 const available=library.filter(x=>!s.members.some(m=>m.filmProfile===x.id));
 const offline=x=>{
  if(!x.offline)return panel('File a signed paper agreement',form('offline',file('Returned agreement PDF','application/pdf')+'<label>Paperwork status<select name="status"><option>Waiting on Heidi</option><option>Missing page 1 · waiting on Heidi</option><option>Complete</option></select></label>','File privately',x.id));
  const signing=x.offlineSigning;
  let controls='';
  if(signing){
   controls='<p><strong>'+escape(signing.status)+'</strong>'+(signing.testMode?' · Test draft':'')+'</p>';
   if(signing.sourceChanged)controls+='<p>The uploaded file has changed. Review the existing request before proceeding.</p>';
   if(signing.syncError)controls+='<p>'+escape(signing.syncError)+'</p>';
   if(signing.id)controls+='<button type="button" data-offline-status="'+escape(x.id)+'">'+(signing.status==='Draft prepared'?'Review countersignature draft':'Check countersignature status')+'</button>';
   else controls+='<p>Check SignWell before preparing another request.</p>';
  }else if(x.offline==='Waiting on Heidi'){
   controls=form('prepareOfflineCountersign','<p>Prepare an unsent draft for Heidi using this uploaded agreement. Existing signatures stay intact; Heidi receives a separate signature page.</p>','Prepare Heidi countersignature draft',x.id);
  }else if(/missing/i.test(x.offline))controls='<p>Upload the complete agreement before preparing Heidi’s signature request.</p>';
  return '<div data-offline-profile="'+escape(x.id)+'"><p><b>Signed offline</b> · '+escape(x.offlineSigning?.status||x.offline)+' · <a href="'+escape(url('offline',x.id))+'">Download original agreement</a></p>'+controls+'<div data-offline-links></div></div>';
 };
 const uploaded=library.filter(x=>x.offline),eligibleUploads=uploaded.filter(x=>x.offline==='Waiting on Heidi'&&!x.offlineSigning);
 const uploadedDocuments=admin?'<section><h2>Uploaded agreements</h2><p>Prepare Heidi-only drafts from the signed files already on record. Drafts are not sent automatically.</p>'+(eligibleUploads.length?'<button type="button" data-prepare-offline>Prepare all eligible drafts ('+eligibleUploads.length+')</button>':'')+(uploaded.length?uploaded.map(x=>panel(escape(x.name)+' · '+escape(x.offlineSigning?.status||x.offline),offline(x))).join(''):'<p>No signed agreements have been uploaded for this production.</p>')+'</section>':'';
 const people=[...available,...s.members];
 function outstanding(person){
  const source=library.find(x=>x.id===(person.filmProfile||person.id));
  const status=person.paperworkStatus||source?.offline||person.agreement?.status||'No agreement on file';
  const gaps=[];
  if(!(person.profile?.bio??source?.bio)?.trim())gaps.push('Bio');
  if(!(person.hasPhoto||person.referencePhoto||source?.photo))gaps.push('Headshot');
  if(person.tasks?.some(t=>!t.done))gaps.push('Open tasks');
  const exempt=/^(?:nick williams|nicholas williams|heidi mikac)$/i.test(person.name.trim().replace(/\s+/g,' '));
  return {name:person.name,status,gaps,exempt};
 }
 const waiting=s.waiting||[];
 const personal='<section class="audit" style="border:2px solid #a35c68;padding:1.25rem;margin-bottom:1.5rem" aria-labelledby="waiting-heading"><h2 id="waiting-heading">Waiting on you <span class="count">'+waiting.length+'</span></h2><p>'+escape(s.self)+' · '+escape(s.film)+'</p>'+(waiting.length?'<ul>'+waiting.map(a=>'<li><strong>'+escape(a.label)+'</strong> · '+(a.owner==='any'?'Any admin':'Assigned to you')+' '+(a.taskId?form('finishAdminTask','<input type="hidden" name="owner" value="'+escape(a.owner)+'"><input type="hidden" name="task" value="'+escape(a.taskId)+'">','Mark done'):a.member?'<button data-open-person="'+escape(a.member)+'">Open paperwork</button>':'<button data-view-button="'+escape(a.view)+'">'+(a.view==='settings'?'Review request':'Open documents')+'</button>')+'</li>').join('')+'</ul>':'<p>You’re caught up for this production.</p>')+panel('Assign an admin task',form('adminTask',input('title','Task','text')+'<label>Assigned to<select name="owner"><option value="any">Any admin</option><option>Nick</option><option>Heidi</option></select></label>','Assign task'))+'</section>';
 const audit=people.map(outstanding);
 const group=(label,items,detail)=>'<details class="audit-group"><summary>'+label+' <b>'+items.length+'</b></summary>'+(items.length?'<ul>'+items.map(x=>'<li><strong>'+escape(x.name)+'</strong><span>'+escape(detail(x))+'</span></li>').join('')+'</ul>':'<p>Nothing outstanding.</p>')+'</details>';
 const attention='<section class="audit"><small>'+escape(s.film)+' · PRODUCTION OFFICE</small><h2>Needs attention</h2><p>Open a category to see who needs follow-up.</p>'+group('No agreement on file',audit.filter(x=>!x.exempt&&x.status==='No agreement on file'),x=>x.status)+group('Paperwork in progress',audit.filter(x=>(!x.exempt||/waiting on Heidi/i.test(x.status))&&!['Complete','Not required','No agreement on file'].includes(x.status)),x=>x.status)+group('Missing profile items or open tasks',audit.filter(x=>x.gaps.length),x=>x.gaps.join(' · '))+'</section>';
 const directory=admin?'<p>Profiles available to invite</p>'+available.map(x=>panel(escape(x.name)+' · '+escape(x.role),'<img loading="lazy" alt="Approved headshot" src="'+escape(x.photo)+'"><p style="white-space:pre-line">'+escape(x.bio)+'</p>'+offline(x)+(s.mailReady?form('invite',input('email','Invitation email','email')+['name','role','filmProfile'].map((k,i)=>'<input type="hidden" name="'+k+'" value="'+escape([x.name,x.role,x.id][i])+'">').join(''),'Invite '+escape(x.name)):'') )).join(''):'';
 const linkControls=m=>m.practice?'':m.filmProfile?'<p>Biography and headshot sync automatically to assigned film websites.</p>':panel('Link an existing film profile',form('linkProfile','<label>Approved profile<select name="filmProfile" required><option value="">Select person</option>'+available.map(x=>'<option value="'+escape(x.id)+'" '+(x.name===m.name?'selected':'')+'>'+escape(x.name)+'</option>').join('')+'</select></label>','Confirm profile match',m.id));
 const audience='<fieldset><legend>Who should receive this?</legend><select name="audience" aria-label="Audience"><option value="all">Include all cast and crew</option><option value="selected">Select individuals</option></select><div data-recipients hidden>'+s.members.map(m=>'<label><input type="checkbox" style="width:auto;display:inline" name="recipient" value="'+escape(m.id)+'"> '+escape(m.name)+' · '+escape(m.role)+'</label>').join('')+'<small>Choose from the portal roster.</small></div></fieldset>';
 const setup=panel('Welcome video',form('welcomeSettings','<label>Direct video URL (MP4)<input type="url" name="video" value="'+escape(s.welcome?.video)+'"></label><label>Thumbnail URL (optional)<input type="url" name="poster" value="'+escape(s.welcome?.poster)+'"></label><label>English captions URL (.vtt)<input type="url" name="captions" value="'+escape(s.welcome?.captions)+'"></label>','Save welcome video'))+panel('Invite cast or crew',s.mailReady?form('invite',input('name','Name')+input('role','Character or crew title')+input('email','Email','email'),'Email invitation'):'<p>Email invitations are waiting for the production sender to be connected.</p>')+
 panel('Post a message',form('notice',audience+input('title','Subject')+'<label>Message<textarea required name="text"></textarea></label>','Post message'))+
 panel('Share a script or call sheet',form('resource',audience+input('title','Title and revision date')+file('Production PDF · up to 4 MB','application/pdf'),'Post file'))+
 (s.agreementSupported?panel('Agreement setup',form('master','<p>'+(s.agreementReady?'Approved master installed.':'Install the approved master before previewing or sending.')+'</p>'+file('Approved '+s.film+' contract master','application/pdf'),'Install agreement master')):'<p>Actor agreement sending for this production needs its own approved template.</p>');
 function tasks(m){return (m.tasks||[]).map(t=>'<div><strong>'+escape(t.title)+'</strong> '+(t.done?'Completed':admin?'Outstanding':form('finishTask','<input type="hidden" name="task" value="'+escape(t.id)+'">','Mark complete',m.id))+'</div>').join('');}
 function memberView(m){
  const choices=m.practice?'':form('requestProductions','<fieldset><legend>Productions for my bio and headshot</legend>'+s.productionChoices.map(p=>{
   const approved=!!m.productions[p.id]&&m.publication?.[p.id]?.visible!==false;
   const pending=!!m.productionRequests?.[p.id];
   return '<label><input style="width:auto;display:inline" type="checkbox" name="selection" value="'+escape(p.id)+'" '+(approved||pending?'checked ':'')+(approved?'disabled':'')+'> '+escape(p.name)+(approved?' · Approved':pending?' · Awaiting approval':'')+'</label>';
  }).join('')+'</fieldset>','Save production requests');

  const download=(href,title)=>'<li><a href="'+escape(href)+'">'+escape(title)+'</a></li>';
  const documents=(m.documents||[]).map(d=>{
   const params=new URLSearchParams({kind:d.kind});
   if(d.version)params.set('version',d.version);
   return download(url('memberDocument',m.id)+'&'+params,d.title);
  });
  for(const file of s.resources.filter(r=>r.type==='PDF'))documents.push(download(url('resource',file.id),file.title));
  let agreementControls='';
  if(m.agreement?.id){
   const status=m.agreement.status;
   agreementControls='<p>'+escape(status==='Waiting on Heidi'?'Your signature is saved. Waiting on Heidi.':status)+'</p>';
   if(status==='Waiting on actor')agreementControls+='<button data-status="'+escape(m.id)+'">Review my agreement</button>';
  }
  const items=[...(m.tasks||[])].sort((a,b)=>Number(a.done)-Number(b.done));
  const count=items.filter(t=>!t.done).length;
  const taskList=items.map(t=>'<div class="task-row '+(t.done?'task-done':'')+'"><span class="task-state">'+(t.done?'✓ Completed':'To do')+'</span><strong>'+escape(t.title)+'</strong>'+(t.done?'':form('finishTask','<input type="hidden" name="task" value="'+escape(t.id)+'">','Mark complete',m.id))+'</div>').join('');
  const photo=m.hasPhoto?url('photo',m.id):m.referencePhoto;
  return '<section class="member-panel member-tasks"><h2>My tasks</h2><p>'+(items.length?(count?count+' to complete':'All tasks completed.'):'No tasks assigned yet.')+'</p>'+taskList+'</section>'+
   '<section class="member-panel member-paperwork"><h2>My documents</h2>'+agreementControls+(documents.length?'<ul>'+documents.join('')+'</ul>':(agreementControls?'':'<p>No documents assigned yet.</p>'))+'<div id="signing"></div></section>'+
   '<section class="member-panel member-profile"><h2>My profile</h2><p>Your biography and headshot are shared across your approved productions.</p>'+choices+'<p>'+escape(m.name)+' · '+escape(m.role)+'</p>'+(photo?'<img data-headshot src="'+escape(photo)+'" alt="Your headshot">':'')+form('photo',file(m.hasPhoto?'Replace your headshot':'Upload your headshot · JPG or PNG, up to 4 MB','image/jpeg,image/png'),'Save headshot',m.id)+form('bio','<label>My bio<textarea name="bio" rows="5" maxlength="5000">'+escape(m.profile?.bio)+'</textarea></label>','Save bio',m.id)+'</section>';
 }
 const publication=m=>'<div class="publication-status"><h4>Website publishing</h4>'+Object.entries(m.publication||{}).map(([pid,p])=>'<p>'+escape(s.productions.find(x=>x.id===pid)?.name||pid)+' · <strong>'+escape(p.state)+'</strong></p>').join('')+(m.practice?'':form('publication','<label><input type="checkbox" name="visible" '+(m.publication?.[s.productionId]?.visible?'checked':'')+'> Show on this production’s website</label>','Save website visibility',m.id))+'</div>';
 const recover=m=>m.agreement&&!m.agreement.id&&!m.agreement.cleared?panel('Recover interrupted signing request','<p>Check SignWell first. Link the existing document below, or confirm that no document was created. This action never sends a contract.</p>'+form('recoverAgreement','<label>Existing SignWell document ID (if found)<input name="documentId"></label><label><input type="checkbox" name="confirmAbsent"> I checked SignWell; no document exists</label>','Recover request',m.id)):'';
 const rows=s.members.map(m=>'<details class="person-card" data-person="'+m.id+'" data-search="'+escape((m.name+' '+m.role+' '+m.email).toLowerCase())+'" data-gaps="'+escape(outstanding(m).gaps.join(' ').toLowerCase())+'" data-paperwork="'+escape(m.paperworkStatus)+'"><summary><img loading="lazy" alt="" src="'+escape(m.hasPhoto?url('photo',m.id):m.referencePhoto||'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 80%22%3E%3Crect width=%2264%22 height=%2280%22 fill=%22%2353434a%22/%3E%3Ccircle cx=%2232%22 cy=%2226%22 r=%2213%22 fill=%22%23cbb9be%22/%3E%3Cellipse cx=%2232%22 cy=%2269%22 rx=%2226%22 ry=%2223%22 fill=%22%23cbb9be%22/%3E%3C/svg%3E')+'"><span><b>'+escape(m.name)+'</b><span>'+escape(m.role)+'</span></span><span class="status-pill">'+escape(m.paperworkStatus)+'</span><span class="open-profile">Open profile</span></summary><section><h3>'+escape(admin?m.name:'My dashboard')+'</h3><p>'+escape(m.role)+' · '+escape(m.email)+'</p>'+
 (admin?'<strong>'+escape(m.paperworkStatus)+'</strong> ':'')+
 (m.agreement?.id?'<button data-status="'+m.id+'">'+(admin?(m.agreement.status==='Waiting on Heidi'?'Open for Heidi’s signature':'Check agreement status'):'Review my agreement')+'</button>':'')+
 ((m.referencePhoto||m.hasPhoto)?'<img data-headshot src="'+escape(m.hasPhoto?url('photo',m.id):m.referencePhoto)+'" alt="Saved headshot">':'')+(admin?profile(m):(m.hasPhoto?'<img data-headshot alt="Your saved headshot" src="'+escape(url('photo',m.id))+'">':'')+form('photo',file(m.hasPhoto?'Replace your headshot':'Upload your headshot · JPG or PNG, up to 4 MB','image/jpeg,image/png'),'Save headshot',m.id)+form('bio','<label>My bio<textarea name="bio" rows="4" maxlength="5000" placeholder="Tell us a little about yourself.">'+escape(m.profile?.bio)+'</textarea></label>','Save bio',m.id))+
 tasks(m)+(admin&&m.filmProfile&&library.find(x=>x.id===m.filmProfile)?offline(library.find(x=>x.id===m.filmProfile)):'')+(admin?linkControls(m):'')+(admin?panel('Assign a task',form('task',input('title','What needs to be done?'),'Assign task',m.id)):'')+
 (admin&&s.agreementReady&&(!m.agreement||m.agreement.cleared)?agreement(m):'')+(admin?publication(m)+recover(m)+(m.agreement?.syncError?'<p>'+escape(m.agreement.syncError)+'</p>':''):'')+(admin?panel('Manage access',(!m.activated&&s.mailReady?form('resend','','Resend invitation',m.id):'')+form('revoke','<label><input type="checkbox" name="keepPublic" checked> Keep public film credits and profile visible</label><p>Uncheck to also remove this account’s public profiles. Access is revoked immediately.</p>','Revoke portal access',m.id)):'')+'</section></details>').join('');
 const account=s.passwordSet?'':'<section><h2>Set your password</h2><p>Your sign-in name is <strong>'+escape(admin?s.self:s.members[0].email)+'</strong>.</p>'+form('choosePassword',newPassword,'Save my password')+'</section>';
 const updates=s.resources.map(r=>'<section><small>'+escape(new Date(r.created).toLocaleDateString())+' · '+escape(r.type)+'</small><h3>'+escape(r.title)+'</h3>'+(r.type==='PDF'?'<a href="'+escape(url('resource',r.id))+'">Download PDF</a>':'<p>'+escape(r.text)+'</p>')+'</section>').join('');
 const counts='<div class="metrics"><div><b>'+people.length+'</b><span>Production roster</span></div><div><b>'+s.members.length+'</b><span>Portal accounts</span></div><div><b>'+s.members.filter(m=>m.activated).length+'</b><span>Activated accounts</span></div><div><b>'+s.members.filter(m=>!outstanding(m).gaps.some(x=>['Bio','Headshot'].includes(x))).length+'</b><span>Complete account profiles</span></div></div>';
 const mailRows=[...(s.mailQueue||[]).map(x=>({...x,status:x.lastError?'Retry scheduled':'Queued'})),...(s.mailLog||[])];
 const mailPanel='<section><h2>Email delivery</h2><p>Provider acceptance is not proof of inbox delivery. Delivery updates appear when available.</p>'+(mailRows.length?'<div class="table-scroll"><table><thead><tr><th>Recipient</th><th>Subject</th><th>Status</th></tr></thead><tbody>'+mailRows.map(x=>'<tr><td>'+escape(x.to)+'</td><td>'+escape(x.subject)+'</td><td>'+escape(x.status)+(x.lastError||x.error?'<br>'+escape(x.lastError||x.error):'')+'</td></tr>').join('')+'</tbody></table></div>':'<p>No email activity recorded yet.</p>')+'</section>';
 const tabs=[['overview','Overview'],['people','People'],['documents','Documents'],['messages','Messages & files'],['calendar','Calendar'],['settings','Settings']];
 clearSigning();
 if(admin){
  app.innerHTML='<div class="office-header">'+productionPicker+form('logout','','Sign out')+'</div>'+account+'<nav class="office-nav" aria-label="Production office">'+tabs.map(([id,label])=>'<button type="button" data-view-button="'+id+'">'+label+'</button>').join('')+'<div class="office-layout"><div class="office-main">'+
   '<div data-view="overview">'+personal+counts+attention+'<p>Roster includes existing film profiles and portal accounts, counted once per linked person.</p></div>'+
   '<div data-view="people"><h2>People & profiles <span class="count">'+people.length+'</span></h2><div class="people-toolbar"><label>Search name, role or email<input data-people-search type="search" value="'+escape(peopleSearch)+'"></label><label>Show<select data-people-filter><option value="all">All portal accounts</option><option value="missing">No agreement</option><option value="progress">Paperwork in progress</option><option value="bio">Missing bio</option><option value="headshot">Missing headshot</option><option value="tasks">Open tasks</option></select></label></div><p data-results></p>'+rows+'<h2>Browse film profiles <span class="count">'+people.length+'</span></h2>'+panel('Profiles without a portal account ('+available.length+')',directory)+'</div>'+
   '<div data-view="documents"><h2>Paperwork</h2><p>'+(s.test?'Signing is in test mode.':'Live signing is enabled.')+'</p>'+attention+uploadedDocuments+'<div class="document-list">'+s.members.map(m=>'<p><b>'+escape(m.name)+'</b> · '+escape(m.paperworkStatus)+' <button data-open-person="'+m.id+'">Open paperwork</button></p>').join('')+'</div><div data-tool-zone="documents"></div><div id="signing"></div></div>'+
   '<div data-view="messages"><h2>Messages & files</h2><div data-tool-zone="messages"></div>'+mailPanel+'<h2>Production board</h2>'+updates+'</div>'+
   '<div data-view="calendar"><h2>Production calendar</h2><p>Your connected Exchange calendar appears alongside this workspace. It shows the next 30 days in Eastern time.</p></div>'+
   '<div data-view="settings"><h2>Production settings</h2>'+(reviews?'<section><h3>Production requests</h3>'+reviews+'</section>':'')+assignmentsPanel+panel('Revoked portal accounts',s.revokedAccounts?.length?s.revokedAccounts.filter(m=>m.productions[s.productionId]).map(m=>'<section><h3>'+escape(m.name)+'</h3><p>Portal access revoked. Public profile '+(m.keepPublic?'retained':'removed')+'.</p>'+form('publication','<label><input type="checkbox" name="visible" '+(m.keepPublic&&m.publication[s.productionId]!==false?'checked':'')+'> Show on this production website</label>','Save website visibility',m.id)+'</section>').join(''):'<p>No revoked accounts.</p>')+'<div data-tool-zone="settings"></div></div></div><div id="calendar-slot"></div></div>';
  const staging=document.createElement('div');staging.innerHTML=setup;
  for(const tool of [...staging.children]){const action=tool.querySelector('form')?.dataset.action;const zone=['notice','resource'].includes(action)?'messages':action==='master'?'documents':'settings';app.querySelector('[data-tool-zone="'+zone+'"]').append(tool);}
  applyView();mountCalendar();
 }
 if(!admin)app.innerHTML=productionPicker+'<p>Cast &amp; crew · One shared profile for all your productions</p>'+form('logout','','Sign out')+account+s.members.map(memberView).join('')+'<section class="member-panel member-board"><h2>Production board</h2>'+(updates||'<p>No updates posted yet.</p>')+'</section>';
 if(!admin&&s.welcome?.video){
  const section=document.createElement('section');section.className='member-panel';section.innerHTML='<small>CAST &amp; CREW ORIENTATION</small><h2>Welcome to Heidi Mikac Films</h2><div style="background:linear-gradient(125deg,#492430,#15161a);padding:16px"><video controls playsinline preload="metadata" style="width:100%;display:none"></video><button type="button">▶ Play welcome video</button></div><p data-audio hidden>Sound is off. Use the speaker control to hear Heidi and Nick.</p>';
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
 for(const saved of savedForms){const replacement=[...app.querySelectorAll('form')].find(f=>f.dataset.action===saved.action&&f.dataset.id===saved.id);if(replacement)replacement.replaceWith(saved.node);}
 for(const d of app.querySelectorAll('details'))if(openDetails.includes(d.dataset.person||d.querySelector(':scope > summary')?.textContent))d.open=true;
 applyPeopleFilter();

}
app.addEventListener('input',e=>{
 if(!e.target.matches('[data-roster-search]'))return;
 const query=e.target.value.trim().toLowerCase();
 for(const row of app.querySelectorAll('[data-roster-name]'))row.hidden=!row.dataset.rosterName.includes(query);
});
app.addEventListener('change',e=>{
 const box=e.target.closest('[data-office-film]');
 if(box){
  if(offlineBulkInProgress||(dirty().length&&!confirm('Discard unsaved edits and change productions?'))){box.checked=!box.checked;return;}
  const films=lastState.productions;
  const selected=box.dataset.officeFilm==='all'
   ?(box.checked?films.map(p=>p.id):[selectedProduction])
   :[...app.querySelectorAll('[data-office-film]:checked')].map(input=>input.dataset.officeFilm).filter(id=>id!=='all');
  if(!selected.length){box.checked=true;return;}
  const params=new URLSearchParams({production:selected.includes(selectedProduction)?selectedProduction:selected[0]});
  if(selected.length>1)for(const id of selected)params.append('films',id);
  if(activeView==='people'||selected.length>1)params.set('view','people');
  for(const f of dirty())delete f.dataset.dirty;
  location.assign(location.pathname+'?'+params);
  return;
 }
 if(e.target.name==='audience')e.target.form.querySelector('[data-recipients]').hidden=e.target.value!=='selected';
 if(e.target.name==='production')e.target.form.elements['role_'+e.target.value].disabled=!e.target.checked;
 if(e.target.matches('[data-production]')){
  if(dirty().length&&!confirm('You have unsaved changes. Switch productions and discard them?')){e.target.value=selectedProduction;return;}
  selectedProduction=e.target.value;
  history.replaceState(null,'',location.pathname+'?'+new URLSearchParams({production:selectedProduction}));
  app.textContent='Loading production…';
  load().catch(error=>{message.textContent=error.message;});
 }
});
app.addEventListener('submit',async e=>{
 e.preventDefault();const f=e.target,a=f.dataset.action,id=f.dataset.id,data=Object.fromEntries(new FormData(f));const button=e.submitter;
 if(a==='publishProfile'&&!confirm('Publish this member’s saved biography and headshot on the public Written in the Dark website?'))return;
 if((a==='revoke'||(a==='agreement'&&button.value==='send'))&&!confirm(a==='revoke'?'Revoke this member’s access immediately?':'Create a signing request for this actor and Heidi?'))return;
 button.disabled=true;message.textContent='';
 try{
  if(a==='logout'){
   try{await request('logout',{});}catch(error){if(error.status!==401)throw error;}
   login();
   message.textContent='Signed out.';
   location.replace(location.pathname);
   return;
  }
  if(data.file&&data.file.size>4*1024*1024)throw Error('Choose a file up to 4 MB.');
  if(a==='agreement')data.preview=button.value==='preview';
  if(a==='activate')data.ticket=ticket;
  if(a==='resetPassword')data.ticket=resetTicket;
  if(a==='revoke')data.keepPublic=f.elements.keepPublic.checked;
  if(a==='publication')data.visible=f.elements.visible.checked;
  if(a==='recoverAgreement')data.confirmAbsent=f.elements.confirmAbsent.checked;
  if(a==='requestProductions')data.selections=new FormData(f).getAll('selection');
  if(a==='reviewProduction')data.decision=button.value;
  if(a==='enrollments'){data.productions=new FormData(f).getAll('production');data.roles=Object.fromEntries(data.productions.map(id=>[id,data['role_'+id]]));}
  const targetParams=new URLSearchParams({title:data.title||''});
  if(data.audience){data.recipients=new FormData(f).getAll('recipient');if(data.audience==='selected'&&!data.recipients.length)throw Error('Select at least one recipient.');targetParams.set('audience',data.audience);for(const who of data.recipients)targetParams.append('recipient',who);}
  const result=await request(a,data.file||data,id,a==='offline'?'&'+new URLSearchParams({status:data.status}):a==='photo'?'&'+new URLSearchParams({filename:data.file.name}):data.title&&data.file?'&'+targetParams:'');
  delete f.dataset.dirty;
  if(a==='requestReset'){message.textContent=result.message;return;}
  if(a==='resetPassword'){history.replaceState(null,'',location.pathname);login();message.textContent='Password updated. Sign in with your new password.';return;}
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
   message.textContent=(a==='photo'?'Headshot saved.':'Bio saved.')+' Your shared profile appears on approved film websites once both items are saved.';
   const publicationInfo=await request('home');lastState=publicationInfo;
   const member=publicationInfo.members.find(m=>m.id===id);
   if(member)message.textContent+=' '+Object.entries(member.publication||{}).map(([pid,p])=>(publicationInfo.productions.find(x=>x.id===pid)?.name||pid)+': '+p.state).join(' · ');
   return;
  }
  if(a==='activate')history.replaceState(null,'',location.pathname);
  if(a==='agreement'&&data.preview){const href=URL.createObjectURL(result);const link=document.createElement('a');link.href=href;link.download='Agreement-preview.pdf';link.click();setTimeout(()=>URL.revokeObjectURL(href),60000);return;}
  if(a==='prepareOfflineCountersign'){await load();message.textContent=result.created?(result.status==='Draft prepared'?'Heidi’s countersignature draft is prepared.':'SignWell is preparing Heidi’s countersignature draft.')+' Review its status under Documents → Uploaded agreements. No signing request has been sent.':'An existing preparation record was found. Review its status under Documents → Uploaded agreements.';return;}
  await load();message.textContent=['invite','resend'].includes(a)?'Invitation queued for email delivery.':['login','passwordLogin','activate'].includes(a)?'':a==='logout'?'Signed out.':'Saved.';
 }catch(e){message.textContent=e.message;}finally{button.disabled=false;}
});
app.addEventListener('click',async e=>{
 const b=e.target;if(!b.dataset.status&&!b.dataset.photo)return;
 let attempt;
 try{if(b.dataset.photo){const blob=await request('photo',undefined,b.dataset.photo);const img=new Image();img.alt='Submitted headshot';const src=URL.createObjectURL(blob);img.onload=()=>URL.revokeObjectURL(src);img.src=src;b.nextElementSibling.replaceChildren(img);return;}
 const paperwork=b.closest('.member-paperwork');
 const status=paperwork?.querySelector('strong')||(b.previousElementSibling?.tagName==='STRONG'?b.previousElementSibling:null);
 const container=paperwork?.querySelector('#signing')||document.querySelector('#signing');
 const review=paperwork?.querySelector('button[data-status]');
 clearSigning();attempt=signingRequest;b.disabled=true;message.textContent='Checking agreement status…';
 const r=await request('status',undefined,b.dataset.status);if(attempt!==signingRequest||!container?.isConnected)return;
 if(paperwork&&r.status==='Waiting on Heidi'){r.status='Complete';if(review)review.hidden=true;}
 if(status)status.textContent=r.status;message.textContent=r.status;
 if(!container)return;
 const view=container.closest('[data-view]');if(view&&r.url){activeView=view.dataset.view;applyView();}
 if(r.url)await showSigning(r.url,b.dataset.status,container,attempt);
 else{const note=document.createElement('p');note.textContent=r.status==='Complete'?'Your part is complete.':'No signing link is available for this account right now. Check the agreement status again or contact production.';container.replaceChildren(note);}
 }catch(e){if(attempt===undefined||attempt===signingRequest)message.textContent=e.message;}finally{b.disabled=false;}
});
app.addEventListener('click',async e=>{
 const button=e.target.closest('[data-prepare-offline],[data-offline-status]');if(!button||offlineBulkInProgress)return;
 if(button.hasAttribute('data-prepare-offline')){
  if(!lastState?.admin)return;
  const productionId=selectedProduction,items=lastState.catalog.filter(x=>x.offline==='Waiting on Heidi'&&!x.offlineSigning),failures=[];
  let created=0,existing=0;
  offlineBulkInProgress=true;button.disabled=true;
  const picker=app.querySelector('[data-production]');if(picker)picker.disabled=true;
  try{
   for(const [index,item] of items.entries()){
    if(selectedProduction!==productionId)break;
    message.textContent='Preparing draft '+(index+1)+' of '+items.length+' · '+item.name;
    try{const result=await request('prepareOfflineCountersign',{},item.id);if(result.created)created++;else existing++;}
    catch(error){failures.push(item.name+': '+error.message);if([401,403].includes(error.status))break;}
   }
   if(selectedProduction===productionId){await load();message.textContent='Started '+created+' countersignature draft'+(created===1?'':'s')+' for Heidi. '+(existing?existing+' existing preparation record'+(existing===1?' was':'s were')+' retained. ':'')+'Review each draft’s status below. No signing requests have been sent.'+(failures.length?'\nNeeds review:\n'+failures.join('\n'):'');}
  }catch(error){message.textContent=error.message;}
  finally{offlineBulkInProgress=false;button.disabled=false;if(picker?.isConnected)picker.disabled=false;}
  return;
 }
 const container=button.closest('[data-offline-profile]'),links=container?.querySelector('[data-offline-links]');if(!links)return;
 button.disabled=true;links.textContent='Checking countersignature request…';
 try{
  const result=await request('offlineCountersignStatus',undefined,button.dataset.offlineStatus);if(!container.isConnected)return;
  links.replaceChildren();const note=document.createElement('p');note.textContent=result.status;links.append(note);
  if(result.offlineSigning?.sourceChanged||result.offlineSigning?.syncError){note.textContent=result.offlineSigning.sourceChanged?'The uploaded file changed. Review the existing request before continuing.':result.offlineSigning.syncError;return;}
  const raw=result.editUrl||result.url;
  if(raw){
   const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||!(u.hostname==='signwell.com'||u.hostname.endsWith('.signwell.com')))throw Error('Unexpected signing address.');
   const link=document.createElement('a');link.href=u.href;link.target='_blank';link.rel='noopener noreferrer';link.textContent=result.editUrl?'Open countersignature draft in SignWell':'Open agreement for Heidi to sign';links.append(link);
   const hint=document.createElement('p');hint.textContent=result.editUrl?'Review the original pages and Heidi’s signature page before sending. To reopen a used draft link, click Review countersignature draft again.':'The portal updates automatically after the final signature.';links.append(hint);
  }else if(result.status==='Waiting on Heidi')note.textContent='Waiting on Heidi. Either admin can open the agreement for Heidi to sign.';
 }catch(error){if(links.isConnected)links.textContent=error.message;}finally{button.disabled=false;}
});
load().catch(e=>{app.textContent='Portal unavailable.';message.textContent=e.message;});


async function mountCalendar(){
 const panel=document.createElement('aside');
 panel.className='exchange-calendar';panel.innerHTML='<h2>Production calendar</h2><p>Loading calendar…</p>';
 app.querySelector('#calendar-slot')?.append(panel);
 const refresh=async()=>{
  try{
   const result=await request('calendarEvents');
   if(!panel.isConnected)return;
   if(!result.connected){

    const connect=document.createElement('button');
    connect.textContent='Connect Outlook calendar';
    connect.onclick=async()=>{try{location.assign((await request('calendarConnect',{})).url);}catch{message.textContent='Calendar connection unavailable. Check the production calendar secret.';}};
    const heading=document.createElement('h2');heading.textContent='Production calendar';const note=document.createElement('p');note.textContent='Connect the hello@ Exchange calendar.';panel.replaceChildren(heading,note,connect);
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
  }catch{panel.innerHTML='<h2>Production calendar</h2><p>Calendar unavailable. Your connection may need attention.</p>';const retry=document.createElement('button');retry.textContent='Try again';retry.onclick=refresh;const reconnect=document.createElement('button');reconnect.textContent='Reconnect Outlook';reconnect.onclick=async()=>{try{location.assign((await request('calendarConnect',{})).url);}catch(e){message.textContent=e.message;}};panel.append(retry,reconnect);}

 };
 await refresh();
 const timer=setInterval(()=>{if(!panel.isConnected)clearInterval(timer);else if(!document.hidden&&!panel.hidden)refresh();},300000);
}



function applyView(){
 app.querySelectorAll('[data-view]').forEach(el=>el.hidden=el.dataset.view!==activeView);
 app.querySelectorAll('[data-view-button]').forEach(b=>b.setAttribute('aria-current',b.dataset.viewButton===activeView?'page':'false'));
}
function applyPeopleFilter(){
 const search=app.querySelector('[data-people-search]'),filter=app.querySelector('[data-people-filter]');if(!search)return;
 search.value=peopleSearch;filter.value=peopleFilter;let shown=0;
 for(const card of app.querySelectorAll('[data-person]')){
  const status=card.dataset.paperwork,gaps=card.dataset.gaps;
  const match=peopleFilter==='all'||peopleFilter==='missing'&&status==='No agreement on file'||peopleFilter==='progress'&&!['Complete','Not required','No agreement on file'].includes(status)||peopleFilter==='bio'&&gaps.includes('bio')||peopleFilter==='headshot'&&gaps.includes('headshot')||peopleFilter==='tasks'&&gaps.includes('tasks');
  card.hidden=!match||!card.dataset.search.includes(peopleSearch.toLowerCase());if(!card.hidden)shown++;
 }
 app.querySelector('[data-results]').textContent=shown+' portal account'+(shown===1?'':'s')+' shown';
}
app.addEventListener('click',e=>{
 const tab=e.target.closest('[data-view-button]');if(tab){activeView=tab.dataset.viewButton;applyView();}
 const open=e.target.closest('[data-open-person]');if(open){activeView='people';peopleFilter='all';peopleSearch='';applyView();applyPeopleFilter();const card=app.querySelector('[data-person="'+open.dataset.openPerson+'"]');card.open=true;card.scrollIntoView({block:'start'});}
});
app.addEventListener('input',e=>{if(e.target.matches('[data-people-search]')){peopleSearch=e.target.value;applyPeopleFilter();}});
app.addEventListener('change',e=>{if(e.target.form)e.target.form.dataset.dirty='true';if(e.target.matches('[data-people-filter]')){peopleFilter=e.target.value;applyPeopleFilter();}});
setInterval(()=>{if(lastState&&!document.hidden&&!dirty().length&&!signingSession&&!offlineBulkInProgress)load().catch(()=>{});},300000);
