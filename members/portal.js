import {mountAvailability} from './availability.js';
import {mountFilmingAvailability} from './filming-availability.js';
const officeTabs=[['overview','Overview'],['people','People'],['documents','Documents'],['messages','Messages & files'],['availability','Filming availability'],['calendar','Calendar'],['settings','Settings']];
function startPortal(app, office=null){
const message=document.querySelector('#message');
let combined=null;
function listen(type,handler){
 app.addEventListener(type,event=>{
  if(event.target.closest('[data-office-root]')===app&&!event.target.closest('[data-availability-root]'))handler(event);
 });
}
app.dataset.officeRoot='';
const endpoint='/.netlify/functions/portal';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let activeView=new URLSearchParams(location.search).get('view')==='people'?'people':'overview',peopleSearch='',peopleFilter='all',lastState,offlineBulkInProgress=false;
const dirty=()=>[...app.querySelectorAll('form[data-dirty]')];
const availabilityViews=new Map();
const availabilityBusy=()=>[...availabilityViews.values()].some(view=>view.busy());
const availabilityOpen=()=>[...availabilityViews.keys()].some(slot=>slot.isConnected&&slot.getBoundingClientRect().height>0);
function clearAvailability(){for(const view of availabilityViews.values())view.destroy();availabilityViews.clear();}
function openAvailability(slot,memberId){
 if(!slot||!lastState||availabilityViews.has(slot))return;
 slot.dataset.availabilityRoot='';
 const view=lastState.admin&&!memberId?mountFilmingAvailability(slot,{request:(action,body,id,suffix,production)=>request(action,body,id,suffix,production||selectedProduction),productions:lastState.productionChoices||lastState.productions,productionId:lastState.productionId}):mountAvailability(slot,{request:(action,body,id,suffix)=>request(action,body,id,suffix),productionId:lastState.productionId,admin:lastState.admin,selfId:lastState.self,memberId});
 availabilityViews.set(slot,view);
}
function ensureAvailability(){
 const board=app.querySelector('[data-view="availability"] [data-availability-slot]');
 if(activeView==='availability'&&board)openAvailability(board);
 for(const details of app.querySelectorAll('details[data-availability-panel][open]'))openAvailability(details.querySelector('[data-availability-slot]'),details.dataset.availabilityPerson||undefined);
}
app.addEventListener('toggle',event=>{const details=event.target;if(details.closest('[data-office-root]')===app&&details.matches('details[data-availability-panel]')&&details.open)openAvailability(details.querySelector('[data-availability-slot]'),details.dataset.availabilityPerson||undefined);},true);
window.addEventListener('beforeunload',e=>{if(dirty().length||availabilityBusy()||combined?.busy()){e.preventDefault();e.returnValue='';}});
let selectedProduction=office?.id||new URLSearchParams(location.search).get('production')||'';
const url=(action,id='',production=selectedProduction)=>endpoint+'?'+new URLSearchParams({action,id,...(production?{production}:{})});
async function request(action,body,id='',suffix='',production=selectedProduction){
 const raw=body instanceof File;
 const documentId=action==='status'?lastState?.members.find(member=>member.id===id)?.agreement?.id:null;
 if(documentId)suffix+='&'+new URLSearchParams({document:documentId});
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
  session.embed=new Embed({url:u.href,containerId:mount.id,allowRedirect:false,signatureDefaultName:true,events:{
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
const detailKey=details=>details.matches('[data-availability-panel]')?'availability/'+(details.dataset.availabilityPerson||'self'):details.dataset.person||details.querySelector(':scope > summary')?.textContent;
const trackingLabel=reason=>['complete','hard-copy'].includes(reason)?'Complete':reason==='not-required'?'Document N/A':'';
function profile(m){
 return panel('Headshot &amp; biography · '+((m.hasPhoto||m.referencePhoto)?'photo received':'photo needed')+' · '+(m.profile?.bio?'bio received':'bio needed'),form('bio','<label>Biography<textarea name="bio" rows="5" maxlength="5000">'+escape(m.profile?.bio)+'</textarea></label>','Save biography',m.id)+form('photo',file('Headshot · JPG or PNG, up to 4 MB','image/jpeg,image/png'),'Upload headshot',m.id)+(m.hasPhoto?'<button data-photo="'+m.id+'">View current headshot</button><div class="portrait"></div>':''));
}
function creditFields(value={},suffix=''){
 const field=(key,label)=>'<label>'+label+'<input maxlength="120" name="'+key+suffix+'" value="'+escape(value[key]||'')+'"></label>';
 return field('character','Character')+field('crewTitle','Crew title');
}
function agreement(m){
 const fields=input('legal','Legal name','text',m.name)+'<p>Enter at least one character or crew title. Previewing or creating the agreement saves these credits for '+escape(lastState.film)+'.</p>'+creditFields(m.proposedCredits?.[lastState.productionId]||m.productions[lastState.productionId]||{})+(m.role?'<p>Current credit · '+escape(m.role)+'</p>':'')+input('credit','Screen credit / professional name','text',m.name)+input('rate','Agreed daily rate (USD)')+input('date','Agreement date','date')+'<p>This agreement covers services already performed for this film and any future services mutually agreed. Each signer’s date is filled automatically when they sign.</p>';
 return panel('Prepare agreement for '+escape(lastState.film),'<form data-action="agreement" data-id="'+m.id+'">'+fields+'<button value="preview">Preview agreement</button><button value="send"'+(m.needsEmail?' disabled':'')+'>Create signing request</button>'+(m.needsEmail?'<p>Add this person’s email to send a signing request.</p>':'')+'</form>');
}
const ticket=new URLSearchParams(location.hash.slice(1)).get('invite');
const resetTicket=new URLSearchParams(location.hash.slice(1)).get('reset');
const newPassword='<label>Choose a password (12 or more characters)<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label>';
function profileStatus(f,text){
 let note=f.querySelector('output');
 if(!note){note=document.createElement('output');note.style.display='block';f.append(note);}
 note.textContent=text;
}
listen('input',e=>{
 const f=e.target.form;if(f)f.dataset.dirty='true';
 if(f?.dataset.action==='bio')profileStatus(f,'Unsaved changes');
 if(f?.dataset.action==='photo'&&e.target.files?.length)profileStatus(f,'Selected · '+e.target.files[0].name+' (not saved yet)');
});
function login(){
 clearSigning();
 clearAvailability();
 app.innerHTML='<section><h2>Welcome back</h2>'+form('passwordLogin','<label>Email or admin name<input name="username" autocomplete="username" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label>','Sign in')+'</section>'+panel('Forgot your password?',form('requestReset','<label>Email or admin name<input name="username" autocomplete="username" required></label>','Email reset link'))+(new URLSearchParams(location.search).has('setup')?panel('First-time admin setup',form('login',input('code','Existing access key','password'),'Continue to password setup')):'');
}
function adminProductionPicker(productions, selected){
 const all=selected.length>0&&selected.length===productions.length;
 const checkbox=(value,label,checked)=>'<label><input style="width:auto;display:inline" type="checkbox" data-office-film="'+escape(value)+'" '+(checked?'checked':'')+'> '+escape(label)+'</label>';
 return '<fieldset class="production-picker"><legend>Productions</legend>'+checkbox('all','All productions',all)+productions.map(p=>checkbox(p.id,p.name,selected.includes(p.id))).join('')+'</fieldset>';
}

function combinedPeople(states){
 const people=new Map();
 const owners=new Map();
 // Film catalogs reuse a profile ID for many returning cast and crew members.
 // Include the credited name because short IDs alone can coincide across films.
 const identity=profile=>JSON.stringify([profile.id,profile.name.trim().toLowerCase()]);
 for(const state of states){
  const catalog=new Map(state.catalog.map(profile=>[profile.id,profile]));
  for(const member of state.members){
   const profile=catalog.get(member.filmProfile);
   if(!profile)continue;
   const key=identity(profile);
   if(!owners.has(key))owners.set(key,new Set());
   owners.get(key).add(member.id);
  }
 }
 for(const state of states){
  const linked=new Set(state.members.map(m=>m.filmProfile).filter(Boolean));
  const add=(key,person,target='profile')=>{
   if(!people.has(key))people.set(key,{name:person.name,memberId:target==='person'?person.id:null,hasMemberProfile:key.startsWith('account/'),hasAccount:key.startsWith('account/')&&!person.needsEmail,needsEmail:!!person.needsEmail,films:[]});
   if(target==='person')Object.assign(people.get(key),{name:person.name,memberId:person.id,hasMemberProfile:true,hasAccount:!person.needsEmail,needsEmail:!!person.needsEmail,email:person.email||''});
   people.get(key).films.push({id:state.productionId,name:state.film,role:person.role,profileId:person.id,target});
  };
  for(const member of state.members)add('account/'+member.id,member,'person');
  for(const profile of state.catalog){
   if(linked.has(profile.id))continue;
   const key=identity(profile),accounts=owners.get(key);
   if(accounts?.size===1)add('account/'+[...accounts][0],profile);
   else if(accounts?.size>1)add(state.productionId+'/'+key,profile);
   else add('catalog/'+key,profile);
  }
 }
 for(const member of states[0].unassignedProfiles||[]){
  const key='account/'+member.id;
  if(!people.has(key))people.set(key,{name:member.name,memberId:member.id,hasMemberProfile:true,hasAccount:!member.needsEmail,needsEmail:!!member.needsEmail,unassigned:true,member,films:[]});
 }
 return [...people.values()].sort((a,b)=>a.name.localeCompare(b.name));
}

function productionAssignments(accounts,productions,label='Manage production assignments ('+accounts.length+' '+(accounts.length===1?'person':'people')+')'){
 return panel(label,'<p>One profile, one shared biography and headshot. Check each production this person belongs to. Review member submissions before publishing them. Named Test accounts stay private.</p>'+accounts.map(m=>panel(escape(m.name),'<form data-action="enrollments" data-id="'+m.id+'">'+productions.map(p=>{
  const assigned=m.productions[p.id];
  const role=assigned?.role||'';
  return '<fieldset><label><input style="width:auto;display:inline" type="checkbox" name="production" value="'+p.id+'" '+(assigned?'checked':'')+'> '+escape(p.name)+'</label><label>Character / crew title for this production<input name="role_'+p.id+'" value="'+escape(role)+'" '+(assigned?'':'disabled')+'></label></fieldset>';
 }).join('')+'<button>Save productions</button></form>')).join(''));
}

function pendingPeoplePanel(state,selected){
 const choices=state.productionChoices||state.productions;
 const fields=values=>'<fieldset><legend>Productions (optional)</legend>'+choices.map(p=>'<label><input type="checkbox" name="pendingProduction" value="'+escape(p.id)+'" '+(values.includes(p.id)?'checked':'')+'> '+escape(p.name)+'</label>').join('')+'</fieldset>';
 const records=(state.pendingPeople||[]).filter(p=>!p.productions.length||p.productions.some(id=>selected.includes(id)));
 const row=person=>{
  const films=person.productions.map(id=>choices.find(p=>p.id===id)?.name||id).join(' · ')||'Production not selected';
  const edit=person.memberId?'':panel('Edit saved name',form('savePendingPerson',input('name','Name','text',person.name)+fields(person.productions),'Save name',person.id));
  const invite=person.status==='Email needed'?form('invite','<input type="hidden" name="pendingId" value="'+escape(person.id)+'">'+input('email','Email address','email'),'Add email & send invitation',person.id):person.status==='Invitation pending'?'<p>Invitation sent. Waiting for this person to create their password.</p>'+form('resend','','Resend invitation',person.memberId):'<p>'+escape(person.status)+(person.status==='Account created'?'. Production assignments are available in Settings.':'. Review this account in Settings.')+'</p>';
  return '<details data-pending-person="'+escape(person.id)+'"><summary>'+escape(person.name)+' · '+escape(person.status)+'</summary><p>'+escape(films)+'</p><button type="button" data-open-setup-profile="'+escape(person.profileId||person.memberId||person.id)+'">Open profile</button>'+edit+invite+form('removePendingPerson','<input type="hidden" name="id" value="'+escape(person.id)+'">','Remove from this list',person.id)+'</details>';
 };
 const outstanding=records.filter(p=>p.status!=='Account created'),completed=records.filter(p=>p.status==='Account created');
 return '<section class="pending-people"><h2>Awaiting portal setup <span class="count">'+outstanding.length+'</span></h2><p>Save a name while you wait for their email address. These names stay private and are tracked separately from portal accounts.</p>'+panel('Add a name without an email',form('savePendingPerson',input('name','Name')+fields([]),'Add name'))+(outstanding.length?outstanding.map(row).join(''):'<p>No saved names are waiting for portal setup.</p>')+(completed.length?panel('Completed setup ('+completed.length+')',completed.map(row).join('')):'')+'</section>';
}
function contactEmail(m){
 return !m.needsEmail?'':panel('Add email & invite',form('invite','<input type="hidden" name="pendingId" value="'+escape(m.pendingPersonId||m.id)+'">'+input('email','Email address','email'),'Add email & send invitation',m.id));
}
function accountEmail(m){
 return '<p class="account-email"><strong>Account email</strong><br>'+(m.email?'<code>'+escape(m.email)+'</code>':'<span>Email not added yet</span>')+'</p>';
}
function contactName(m){
 return !m.needsEmail?'':panel('Edit name',form('savePendingPerson',input('name','Name','text',m.name)+Object.keys(m.productions).map(id=>'<input type="hidden" name="pendingProduction" value="'+escape(id)+'">').join(''),'Save name',m.pendingPersonId||m.id));
}
function unassignedProfile(m,state){
 const image=m.hasPhoto?url('photo',m.id):m.referencePhoto||'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2264%22 height=%2280%22%3E%3Crect width=%2264%22 height=%2280%22 fill=%22%2353434a%22/%3E%3C/svg%3E';
 return '<details class="person-card" data-unassigned-person="'+escape(m.id)+'" data-roster-name="'+escape([m.name,m.email||''].join(' ').toLowerCase())+'"><summary><img alt="" src="'+escape(image)+'"><span><b>'+escape(m.name)+'</b><span>Production not selected'+(m.needsEmail?' · Email needed':'')+'</span></span><span class="open-profile">Open profile</span></summary><section><h3>'+escape(m.name)+'</h3>'+accountEmail(m)+'<p>Choose a production below to manage its contracts, documents and tasks.</p>'+contactName(m)+profile(m)+contactEmail(m)+productionAssignments([m],state.productionChoices||state.productions,'Manage production assignments')+panel('Manage access',(!m.needsEmail&&!m.activated&&state.mailReady?form('resend','','Resend invitation',m.id):'')+form('revoke','<label><input type="checkbox" name="keepPublic" checked> Keep public film credits and profile visible</label>','Revoke portal access',m.id))+'</section></details>';
}
function renderPendingPeople(host,state,selected){
 const drafts=[...host.querySelectorAll('form')].filter(f=>f.hasAttribute('data-dirty')||f.querySelector('button:disabled'));
 const expanded=[...host.querySelectorAll('details[open]')].map(d=>d.dataset.pendingPerson||d.querySelector(':scope > summary')?.textContent);
 host.innerHTML=pendingPeoplePanel(state,selected);
 for(const draft of drafts){const replacement=[...host.querySelectorAll('form')].find(f=>f.dataset.action===draft.dataset.action&&f.dataset.id===draft.dataset.id);if(replacement)replacement.replaceWith(draft);}
 for(const details of host.querySelectorAll('details'))if(expanded.includes(details.dataset.pendingPerson||details.querySelector(':scope > summary')?.textContent))details.open=true;
}

function renderCombinedOffice(states,picker){
 const offices=new Map();
 const snapshots=new Map(states.map(state=>[state.productionId,state]));
 let pendingState=states[0];
 const nav=officeTabs.map(([id,label])=>'<button type="button" data-main-tab="'+id+'">'+label+'</button>').join('');
 app.innerHTML='<div class="office-header">'+picker+form('logout','','Sign out')+'</div><nav class="office-nav" aria-label="Production office">'+nav+'</nav><div data-main-reviews></div><section data-shared-settings hidden><h2>All productions · account settings</h2><div data-shared-assignments></div></section><div data-main-people><div data-pending-people></div><h2>People &amp; profiles <span class="count" data-total></span></h2><label>Search name, role or email<input type="search" data-roster-search></label><div data-accounts></div><details data-combined-directory><summary></summary><div data-catalog></div></details></div><section data-main-filming hidden><div data-availability-slot></div></section><div data-offices></div>';
 function renderAssignments(state){
  const host=app.querySelector('[data-shared-assignments]');
  const expanded=[...host.querySelectorAll('details[open] > summary')].map(node=>node.textContent);
  const open=host.firstElementChild?.open;
  const drafts=[...host.querySelectorAll('form')].filter(form=>form.hasAttribute('data-dirty')||form.querySelector('button:disabled'));
  const accounts=[...new Map(state.accounts.map(account=>[account.id,account])).values()];
  host.innerHTML=productionAssignments(accounts,state.productions);
  for(const draft of drafts){
   const replacement=[...host.querySelectorAll('form')].find(form=>form.dataset.id===draft.dataset.id);
   if(replacement)replacement.replaceWith(draft);
  }
  for(const details of host.querySelectorAll('details'))if(expanded.includes(details.firstElementChild.textContent))details.open=true;
  host.firstElementChild.open=!!open;
 }
 let people=[];
 const roster=()=>{
  renderPendingPeople(app.querySelector('[data-pending-people]'),pendingState,[...snapshots.keys()]);
  const alerts=[...snapshots.values()].filter(s=>s.productionReviews?.length);
  app.querySelector('[data-main-reviews]').innerHTML=alerts.length?'<section style="border-left:5px solid #df8e9b;padding:1rem;background:#322329"><h2>Profiles awaiting approval</h2>'+alerts.map(s=>'<button data-review-film="'+escape(s.productionId)+'">Review '+escape(s.film)+' ('+s.productionReviews.length+')</button>').join(' ')+'</section>':'';
  const openUnassigned=[...app.querySelectorAll('[data-unassigned-person][open]')].map(card=>card.dataset.unassignedPerson);
  const contactDrafts=[...app.querySelectorAll('[data-unassigned-person] form')].filter(f=>f.hasAttribute('data-dirty')||f.querySelector('button:disabled'));
  const contactPanels=[...app.querySelectorAll('[data-unassigned-person] details[open]')].map(d=>({id:d.closest('[data-unassigned-person]').dataset.unassignedPerson,summary:d.querySelector(':scope > summary')?.textContent}));
  people=combinedPeople([...snapshots.values()].map(state=>({...state,unassignedProfiles:pendingState.unassignedProfiles})));
  const row=(person,index)=>{
   if(person.unassigned)return unassignedProfile(person.member,pendingState);
   const links=person.films.map((film,n)=>'<button type="button" data-person-index="'+index+'" data-film-index="'+n+'">'+escape(film.name)+'</button>'+(film.role?' · '+escape(film.role):'')).join('<br>');
   return '<section data-roster-name="'+escape([person.name,person.email||'',...person.films.map(f=>f.role)].join(' ').toLowerCase())+'"><button type="button" data-person-index="'+index+'"><strong>'+escape(person.name)+'</strong></button>'+(person.needsEmail?'<span class="status-pill">Email needed</span>':'')+(person.hasMemberProfile?accountEmail(person):'')+'<p>'+links+'</p></section>';
  };
  const rows=people.map(row);
  app.querySelector('[data-total]').textContent=people.length;
  app.querySelector('[data-accounts]').innerHTML=rows.filter((_,i)=>people[i].hasMemberProfile).join('');
  app.querySelector('[data-catalog]').innerHTML=rows.filter((_,i)=>!people[i].hasMemberProfile).join('');
  app.querySelector('[data-combined-directory] summary').textContent='Website profiles to link ('+people.filter(p=>!p.hasMemberProfile).length+')';
  for(const draft of contactDrafts){const replacement=[...app.querySelectorAll('[data-unassigned-person] form')].find(f=>f.dataset.action===draft.dataset.action&&f.dataset.id===draft.dataset.id);if(replacement)replacement.replaceWith(draft);}
  for(const saved of contactPanels)for(const details of app.querySelectorAll('[data-unassigned-person="'+saved.id+'"] details'))if(details.querySelector(':scope > summary')?.textContent===saved.summary)details.open=true;
  for(const id of openUnassigned){const person=people.find(p=>p.memberId===id);if(person?.unassigned)app.querySelector('[data-unassigned-person="'+id+'"]').open=true;else if(person&&activeView==='people')person.films.forEach((film,i)=>offices.get(film.id)?.open(film,i===0));}
  app.querySelector('[data-roster-search]').dispatchEvent(new Event('input',{bubbles:true}));
 };
 function show(view){
  activeView=view;
  app.querySelector('[data-main-people]').hidden=view!=='people';
  app.querySelector('[data-shared-settings]').hidden=view!=='settings';
  app.querySelector('[data-main-filming]').hidden=view!=='availability';
  app.querySelector('[data-offices]').hidden=view==='availability';
  app.querySelector('[data-main-reviews]').hidden=view==='availability';
  const picker=app.querySelector('.office-header .production-picker');if(picker)picker.hidden=view==='availability';
  app.querySelectorAll('[data-main-tab]').forEach(b=>b.setAttribute('aria-current',b.dataset.mainTab===view?'page':'false'));
  if(view==='availability')openAvailability(app.querySelector('[data-main-filming] [data-availability-slot]'));
  else for(const child of offices.values())child.show(view);
 }
 combined={show,busy:()=>[...offices.values()].some(child=>child.busy()),refresh(){for(const child of offices.values())child.refresh();}};
 for(const state of states){
  const section=document.createElement('section');
  section.innerHTML='<h2>'+escape(state.film)+'</h2><div></div>';
  app.querySelector('[data-offices]').append(section);
  const child=startPortal(section.lastElementChild,{id:state.productionId,state,section,first:state===states[0],show,
   update(next){snapshots.set(next.productionId,next);pendingState=next;roster();renderAssignments(next);},
   changed(){for(const [id,other] of offices)if(id!==state.productionId)other.refresh();}});
  offices.set(state.productionId,child);
 }
 listen('click',event=>{
  const button=event.target.closest('[data-main-tab],[data-person-index],[data-review-film],[data-open-setup-profile]');
  if(!button)return;
  if(button.dataset.reviewFilm){show('settings');offices.get(button.dataset.reviewFilm).review();return;}
  if(button.dataset.mainTab){show(button.dataset.mainTab);return;}
  if(button.dataset.openSetupProfile){
   const person=people.find(p=>p.memberId===button.dataset.openSetupProfile);if(!person)return;
   show('people');
   if(person.unassigned){const card=app.querySelector('[data-unassigned-person="'+person.memberId+'"]');card.open=true;card.scrollIntoView({block:'start'});}
   else person.films.forEach((film,i)=>offices.get(film.id).open(film,i===0));
   return;
  }
  const person=people[Number(button.dataset.personIndex)];
  const films=button.hasAttribute('data-film-index')?[person.films[Number(button.dataset.filmIndex)]]:person.films;
  show('people');
  films.forEach((film,i)=>offices.get(film.id).open(film,i===0));
 });
 roster();renderAssignments(states[0]);show(activeView);
}

async function load(initial){
 if(combined||availabilityBusy())return;
 clearSigning();
 const savedForms=dirty().map(f=>({action:f.dataset.action,id:f.dataset.id,node:f}));
 const openDetails=[...app.querySelectorAll('details[open]')].map(detailKey);
 if(resetTicket&&location.hash){app.innerHTML='<section><h2>Reset your password</h2>'+form('resetPassword',newPassword,'Save new password')+'</section>';return;}
 if(ticket&&location.hash){app.innerHTML='<section><h2>Welcome to the cast &amp; crew</h2><p>Choose your password to open your dashboard. Next time, sign in with the email where you received this invitation.</p>'+form('activate',newPassword,'Create my account')+'</section>';return;}
 let s;try{s=initial||await request('home');}catch(e){if(e.status===401){if(office)return location.reload();return login();}throw e;}
 if(availabilityBusy())return;
 clearAvailability();
 if(office&&!s.admin){location.reload();return;}
 lastState=s;let admin=s.admin;
 selectedProduction=s.productionId;
 const params=new URLSearchParams(location.search);
 const requested=params.getAll('films');
 const selected=s.productions.filter(p=>requested.includes(p.id)).map(p=>p.id);
 if(office)selected.splice(0,selected.length,office.id);
 else if(!requested.length){
  if(params.has('production'))selected.push(s.productionId);
  else if(admin)selected.push(...s.productions.map(p=>p.id));
 }
 const productionPicker=admin?adminProductionPicker(s.productions,selected):s.productions.length?'<label class="production-picker">Production<select data-production>'+s.productions.map(p=>'<option value="'+escape(p.id)+'" '+(p.id===s.productionId?'selected':'')+'>'+escape(p.name)+'</option>').join('')+'</select></label>':'<p>Choose your productions under My profile.</p>';
 if(admin&&!selected.length){
  app.innerHTML='<div class="office-header">'+productionPicker+form('logout','','Sign out')+'</div><h2>People &amp; profiles <span class="count">0</span></h2><p>Select a production to see its cast and crew.</p>';
  return;
 }
 if(admin&&selected.length>1){
  const states=await Promise.all(selected.map(id=>id===s.productionId?s:request('home',undefined,'','',id)));
  renderCombinedOffice(states,productionPicker);
  return;
 }
 const reviewCard=r=>panel(escape(r.name)+' · Approval needed','<p>'+escape(r.bio||'No biography submitted')+'</p>'+(r.photo?'<img alt="Headshot submitted for approval" style="width:8rem;max-width:100%" src="'+escape(r.photo==='uploaded'?url('photo',r.id)+'&v='+r.revision:r.photo)+'">':'<p>No headshot submitted</p>')+'<form data-action="reviewProduction" data-id="'+escape(r.id)+'"><input type="hidden" name="requestId" value="'+escape(r.requestId)+'"><input type="hidden" name="revision" value="'+escape(r.revision)+'">'+creditFields(r.credits)+(r.role?'<p>Current credit · '+escape(r.role)+'</p>':'')+'<button value="approve">Approve for '+escape(s.film)+'</button> <button formnovalidate value="decline">Decline</button></form>');
 const reviews=(s.productionReviews||[]).map(reviewCard).join('');
 const assignmentsPanel=admin&&!office?productionAssignments(s.accounts,s.productions):'';
 const library=s.catalog||[];
 const available=library.filter(x=>!s.members.some(m=>m.filmProfile===x.id));
 const offline=x=>x.previousOffline?panel('Previous paper agreement · replaced','<p>A new electronic agreement is required.</p><a href="'+escape(url('offline',x.id))+'">Download previous paper agreement</a>'):'';
 const uploaded=library.filter(x=>x.previousOffline);
 const previousOnline=s.members.filter(m=>m.previousAgreement?.completed);
 const uploadedDocuments=admin&&(uploaded.length||previousOnline.length)?'<section><h2>Previous agreements</h2><p>These records have been replaced for portal tracking. Everyone requires a new signed agreement.</p>'+uploaded.map(x=>panel(escape(x.name),offline(x))).join('')+previousOnline.map(m=>'<p>'+escape(m.name)+' · <a href="'+escape(url('memberDocument',m.id)+'&kind=previous-signed')+'">Download previous signed agreement and audit record</a></p>').join('')+'</section>':'';
 const people=[...available,...s.members];
 function outstanding(person){
  const source=library.find(x=>x.id===(person.filmProfile||person.id));
  const status=person.paperworkStatus||source?.offline||person.agreement?.status||'No agreement on file';
  const gaps=[];
  if(!(person.profile?.bio??source?.bio)?.trim())gaps.push('Bio');
  if(!(person.hasPhoto||person.referencePhoto||source?.photo))gaps.push('Headshot');
  if(person.tasks?.some(t=>!t.done))gaps.push('Open tasks');
  const exempt=false;
  return {name:person.name,status,gaps,exempt};
 }
 const waiting=s.waiting||[];
 const personal='<section class="audit" style="border:2px solid #a35c68;padding:1.25rem;margin-bottom:1.5rem" aria-labelledby="waiting-heading"><h2 id="waiting-heading">Waiting on you <span class="count">'+waiting.length+'</span></h2><p>'+escape(s.self)+' · '+escape(s.film)+'</p>'+(waiting.length?'<ul>'+waiting.map(a=>'<li><strong>'+escape(a.label)+'</strong> · '+(a.owner==='any'?'Any admin':'Assigned to you')+' '+(a.taskId?form('finishAdminTask','<input type="hidden" name="owner" value="'+escape(a.owner)+'"><input type="hidden" name="task" value="'+escape(a.taskId)+'">','Mark done'):a.member?'<button data-open-person="'+escape(a.member)+'">Open paperwork</button>':'<button data-view-button="'+escape(a.view)+'">'+(a.view==='settings'?'Review request':'Open documents')+'</button>')+'</li>').join('')+'</ul>':'<p>You’re caught up for this production.</p>')+panel('Assign an admin task',form('adminTask',input('title','Task','text')+'<label>Assigned to<select name="owner"><option value="any">Any admin</option><option>Nick</option><option>Heidi</option></select></label>','Assign task'))+'</section>';
 const audit=people.map(outstanding);
 const group=(label,items,detail)=>'<details class="audit-group"><summary>'+label+' <b>'+items.length+'</b></summary>'+(items.length?'<ul>'+items.map(x=>'<li><strong>'+escape(x.name)+'</strong><span>'+escape(detail(x))+'</span></li>').join('')+'</ul>':'<p>Nothing outstanding.</p>')+'</details>';
 const attention='<section class="audit"><p><strong>New contracts are required unless an admin marks the requirement Complete or Document N/A.</strong> Earlier agreements remain in Previous agreements.</p><small>'+escape(s.film)+' · PRODUCTION OFFICE</small><h2>Needs attention</h2><p>Open a category to see who needs follow-up.</p>'+group('No agreement on file',audit.filter(x=>!x.exempt&&x.status==='No agreement on file'),x=>x.status)+group('Paperwork in progress',audit.filter(x=>(!x.exempt||/waiting on Heidi/i.test(x.status))&&!['Complete','Document N/A','Not required','No agreement on file'].includes(x.status)),x=>x.status)+group('Missing profile items or open tasks',audit.filter(x=>x.gaps.length),x=>x.gaps.join(' · '))+'</section>';
 const directory=admin?'<p>Profiles available to invite</p>'+available.map(x=>'<div data-catalog-profile="'+escape(x.id)+'">'+panel(escape(x.name)+' · '+escape(x.role),'<img loading="lazy" alt="Approved headshot" src="'+escape(x.photo)+'"><p style="white-space:pre-line">'+escape(x.bio)+'</p>'+offline(x)+(s.mailReady?form('invite',input('email','Invitation email','email')+['name','role','filmProfile'].map((k,i)=>'<input type="hidden" name="'+k+'" value="'+escape([x.name,x.role,x.id][i])+'">').join(''),'Invite '+escape(x.name)):'') )+'</div>').join(''):'';
 const linkControls=m=>m.practice?'':m.filmProfile?'<p>Approved biography and headshot appear on the assigned film websites.</p>':panel('Link an existing film profile',form('linkProfile','<label>Approved profile<select name="filmProfile" required><option value="">Select person</option>'+available.map(x=>'<option value="'+escape(x.id)+'" '+(x.name===m.name?'selected':'')+'>'+escape(x.name)+'</option>').join('')+'</select></label>','Confirm profile match',m.id));
 const audience='<fieldset><legend>Who should receive this?</legend><select name="audience" aria-label="Audience"><option value="all">Include all cast and crew</option><option value="selected">Select individuals</option></select><div data-recipients hidden>'+s.members.map(m=>'<label><input type="checkbox" style="width:auto;display:inline" name="recipient" value="'+escape(m.id)+'"> '+escape(m.name)+' · '+escape(m.role)+'</label>').join('')+'<small>Choose from the portal roster.</small></div></fieldset>';
 const waitingAccounts=(s.unassigned||[]).map(m=>'<div><strong>'+escape(m.name)+'</strong> · '+(m.activated?'Account created':('Invitation pending'+(s.mailReady?form('resend','','Resend invitation',m.id):'')))+'</div>').join('');
 const setup=panel('Welcome video',form('welcomeSettings','<label>Direct video URL (MP4)<input type="url" name="video" value="'+escape(s.welcome?.video)+'"></label><label>Thumbnail URL (optional)<input type="url" name="poster" value="'+escape(s.welcome?.poster)+'"></label><label>English captions URL (.vtt)<input type="url" name="captions" value="'+escape(s.welcome?.captions)+'"></label>','Save welcome video'))+panel('Invite cast or crew · all productions',s.mailReady?form('invite',input('name','Name')+input('email','Email','email'),'Email invitation'):'<p>Email invitations are waiting for the production sender to be connected.</p>')+
 panel('Post a message',form('notice',audience+input('title','Subject')+'<label>Message<textarea required name="text"></textarea></label>','Post message'))+
 panel('Share a script or call sheet',form('resource',audience+input('title','Title and revision date')+file('Production PDF · up to 4 MB','application/pdf'),'Post file'))+
 (s.agreementSupported?panel('Agreement setup',form('master','<p>'+(s.agreementReady?'Approved master installed.':'Install the approved master before previewing or sending.')+'</p>'+file('Approved '+s.film+' contract master','application/pdf'),'Install agreement master')):'<p>Actor agreement sending for this production needs its own approved template.</p>');
 function tasks(m){return (m.tasks||[]).map(t=>'<div><strong>'+escape(t.title)+'</strong> '+(t.done?'Completed':form('finishTask','<input type="hidden" name="task" value="'+escape(t.id)+'">','Mark complete',m.id))+'</div>').join('');}
 function memberView(m){
  const choices=m.practice?'':form('requestProductions','<fieldset><legend>Productions for my bio and headshot</legend>'+s.productionChoices.map(p=>{
   const assigned=m.productions[p.id],pending=!!m.productionRequests?.[p.id];
   const selected=!!assigned||pending;
   return '<fieldset><label><input type="checkbox" style="width:auto;display:inline" name="selection" value="'+escape(p.id)+'" '+(selected?'checked ':'')+(assigned?'disabled':'')+'> '+escape(p.name)+(pending?' · Awaiting review':assigned?' · Assigned':'')+'</label><div data-credit-fields '+(selected?'':'hidden')+'>'+creditFields(m.proposedCredits?.[p.id]||assigned,'_'+p.id)+(assigned?.role?'<p>Current credit · '+escape(assigned.role)+'</p>':'')+'</div></fieldset>';
  }).join('')+'</fieldset>','Save productions and credits');

  const download=(href,title)=>'<li><a href="'+escape(href)+'">'+escape(title)+'</a></li>';
  const documents=(m.documents||[]).map(d=>{
   const params=new URLSearchParams({kind:d.kind});
   if(d.version)params.set('version',d.version);
   return download(url('memberDocument',m.id)+'&'+params,d.title);
  });
  for(const file of s.resources.filter(r=>r.type==='PDF'))documents.push(download(url('resource',file.id),file.title+(trackingLabel(m.documentTracking?.[file.id])?' · '+trackingLabel(m.documentTracking[file.id]):'')));
  let agreementControls='<p>A new agreement is required for '+escape(s.film)+'. Production will prepare your signing request.</p>';
  if(m.paperworkTracking){
   agreementControls='<p>'+escape(m.paperworkStatus)+' · Recorded by production.</p>';
  }else if(m.agreement?.id){
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
   (m.productions[s.productionId]?'<section class="member-panel"><h2>Availability</h2><p>Share your earliest arrival on set and latest departure with the cast and crew of '+escape(s.film)+'. All times are Eastern.</p><details data-availability-panel><summary>Open availability calendar</summary><div data-availability-slot></div></details></section>':'')+
   '<section class="member-panel member-profile"><h2>My profile</h2><p>Your biography and headshot are shared across your approved productions.</p>'+choices+'<p>'+escape(m.name)+' · '+escape(m.role)+'</p>'+(photo?'<img data-headshot src="'+escape(photo)+'" alt="Your headshot">':'')+form('photo',file(m.hasPhoto?'Replace your headshot':'Upload your headshot · JPG or PNG, up to 4 MB','image/jpeg,image/png'),'Save headshot',m.id)+form('bio','<label>Import biography (.txt)<input type="file" accept=".txt,text/plain" data-bio-file></label><label>My bio<textarea name="bio" rows="5" maxlength="5000">'+escape(m.profile?.bio)+'</textarea></label>','Save bio',m.id)+'</section>';
 }
 const publication=m=>'<div class="publication-status"><h4>Website publishing</h4>'+Object.entries(m.publication||{}).map(([pid,p])=>'<p>'+escape(s.productions.find(x=>x.id===pid)?.name||pid)+' · <strong>'+escape(p.state)+'</strong></p>').join('')+(m.practice?'':form('publication','<label><input type="checkbox" name="visible" '+(m.publication?.[s.productionId]?.visible?'checked':'')+'> Show on this production’s website</label>','Save website visibility',m.id))+'</div>';
 const recover=m=>m.agreement&&!m.agreement.id&&!m.agreement.cleared?panel('Recover interrupted signing request','<p>Check SignWell first. Link the existing document below, or confirm that no document was created. This action never sends a contract.</p>'+form('recoverAgreement','<label>Existing SignWell document ID (if found)<input name="documentId"></label><label><input type="checkbox" name="confirmAbsent"> I checked SignWell; no document exists</label>','Recover request',m.id)):'';
 function documentControls(m,document,reason){
  return '<form data-action="trackPaperwork" data-id="'+escape(m.id)+'"><input type="hidden" name="document" value="'+escape(document)+'"><button value="complete"'+(trackingLabel(reason)==='Complete'?' disabled':'')+'>Complete</button> <button value="not-required"'+(reason==='not-required'?' disabled':'')+'>Document N/A</button>'+(reason?' <button value="reopen">Reopen requirement</button>':'')+'</form>';
 }
 function trackDocument(m,d){
  const done=m.documentTracking?.[d.id];
  return panel(escape(d.title)+(done?' · '+trackingLabel(done):''),'<p><a href="'+escape(url('resource',d.id))+'">Download PDF</a></p><p>'+(done?escape(trackingLabel(done))+' · Recorded by an admin.':'Pending document requirement.')+'</p>'+documentControls(m,d.id,done));
 }
 function personPaperwork(m){
  const tracked=m.paperworkTracking,actual=m.agreement?.status;
  const downloads=(m.documents||[]).map(d=>'<li><a href="'+escape(url('memberDocument',m.id)+'&'+new URLSearchParams({kind:d.kind,...(d.version?{version:d.version}:{})}))+'">'+escape(d.title)+'</a></li>').join('');
  const draft=m.agreement?.id&&actual==='Draft ready to send'&&!tracked&&!m.needsEmail?form('sendAgreement','<input type="hidden" name="documentId" value="'+escape(m.agreement.id)+'"><p>Send this prepared contract to '+escape(m.name)+'.</p>','Send pending contract',m.id):'';
  return '<section class="member-paperwork"><h4>Documents &amp; agreements</h4><p><strong>'+escape(m.paperworkStatus)+'</strong>'+(tracked?' · Recorded by an admin.':'')+'</p>'+(tracked&&actual?'<p>Signing request status · <span data-signing-status>'+escape(actual)+'</span></p>':'')+'<p>Use Complete for paperwork handled outside the portal, or Document N/A when it is not needed. An existing SignWell request stays active.</p>'+documentControls(m,'agreement',tracked?.reason)+(tracked?'<p>Reopen the requirement to prepare or send a new contract.</p>':'')+(m.agreement?.id?'<button data-status="'+escape(m.id)+'">'+(!tracked&&actual==='Waiting on Heidi'&&s.self==='Heidi'?'Open for Heidi’s signature':'Check signing request status')+'</button>':'')+draft+(!tracked&&s.agreementReady&&(!m.agreement||m.agreement.cleared)?agreement(m):'')+recover(m)+(m.agreement?.syncError?'<p>'+escape(m.agreement.syncError)+'</p>':'')+(downloads?'<h5>Saved agreements</h5><ul>'+downloads+'</ul>':'')+s.resources.filter(d=>d.type==='PDF'&&(!d.audience||d.audience.includes(m.id))).map(d=>trackDocument(m,d)).join('')+'<div data-signing></div></section>';
 }
 const personalReview=m=>(s.productionReviews||[]).filter(r=>r.id===m.id).map(reviewCard).join('');
 const personalMessage=m=>panel(m.needsEmail?'Save a message for this person':'Send a message',form('notice','<p>For '+escape(m.name)+' · '+escape(s.film)+'</p><input type="hidden" name="audience" value="selected"><input type="hidden" name="recipient" value="'+escape(m.id)+'">'+input('title','Subject')+'<label>Message<textarea required name="text"></textarea></label>',m.needsEmail?'Save message':'Send to '+escape(m.name),m.id));
 const rows=s.members.map(m=>'<details class="person-card" data-person="'+m.id+'" data-search="'+escape((m.name+' '+m.role+' '+(m.email||'')).toLowerCase())+'" data-gaps="'+escape(outstanding(m).gaps.join(' ').toLowerCase())+'" data-paperwork="'+escape(m.paperworkStatus)+'"><summary><img loading="lazy" alt="" src="'+escape(m.hasPhoto?url('photo',m.id):m.referencePhoto||'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 80%22%3E%3Crect width=%2264%22 height=%2280%22 fill=%22%2353434a%22/%3E%3Ccircle cx=%2232%22 cy=%2226%22 r=%2213%22 fill=%22%23cbb9be%22/%3E%3Cellipse cx=%2232%22 cy=%2269%22 rx=%2226%22 ry=%2223%22 fill=%22%23cbb9be%22/%3E%3C/svg%3E')+'"><span><b>'+escape(m.name)+'</b><span>'+escape(m.role)+'</span></span><span class="status-pill">'+escape(m.paperworkStatus)+'</span><span class="open-profile">Open profile</span></summary><section><h3>'+escape(admin?m.name:'My dashboard')+'</h3><p>'+escape(admin?m.role:[m.role,m.needsEmail?'Email needed':m.email].filter(Boolean).join(' · '))+'</p>'+
 (admin?accountEmail(m)+'<strong>'+escape(m.paperworkStatus)+'</strong>'+contactName(m)+contactEmail(m):'')+
 (!admin&&m.agreement?.id?'<button data-status="'+m.id+'">Review my agreement</button>':'')+
 ((m.referencePhoto||m.hasPhoto)?'<img data-headshot src="'+escape(m.hasPhoto?url('photo',m.id):m.referencePhoto)+'" alt="Saved headshot">':'')+(admin?profile(m):(m.hasPhoto?'<img data-headshot alt="Your saved headshot" src="'+escape(url('photo',m.id))+'">':'')+form('photo',file(m.hasPhoto?'Replace your headshot':'Upload your headshot · JPG or PNG, up to 4 MB','image/jpeg,image/png'),'Save headshot',m.id)+form('bio','<label>Import biography (.txt)<input type="file" accept=".txt,text/plain" data-bio-file></label><label>My bio<textarea name="bio" rows="4" maxlength="5000" placeholder="Tell us a little about yourself.">'+escape(m.profile?.bio)+'</textarea></label>','Save bio',m.id))+
 (admin?'<details data-availability-panel data-availability-person="'+escape(m.id)+'"><summary>Availability calendar</summary><div data-availability-slot></div></details>'+panel(m.needsEmail?'Save a document for this person':'Send a document',form('resource','<p>For '+escape(m.name)+' · '+escape(s.film)+'</p><input type="hidden" name="audience" value="selected"><input type="hidden" name="recipient" value="'+escape(m.id)+'">'+input('title','Document title')+file('PDF · up to 4 MB','application/pdf'),m.needsEmail?'Save document':'Send to '+escape(m.name),m.id)):'')+
 (admin?personPaperwork(m)+personalMessage(m)+personalReview(m)+productionAssignments([m],s.productions,'Manage production assignments'):'')+tasks(m)+(admin&&m.filmProfile&&library.find(x=>x.id===m.filmProfile)?offline(library.find(x=>x.id===m.filmProfile)):'')+(admin?linkControls(m):'')+(admin?panel('Assign a task',form('task',input('title','What needs to be done?'),'Assign task',m.id)):'')+
 (admin?publication(m):'')+(admin?panel('Manage access',(!m.needsEmail&&!m.activated&&s.mailReady?form('resend','','Resend invitation',m.id):'')+form('revoke','<label><input type="checkbox" name="keepPublic" checked> Keep public film credits and profile visible</label><p>Uncheck to also remove this account’s public profiles. Access is revoked immediately.</p>','Revoke portal access',m.id)):'')+'</section></details>').join('');
 const account=s.passwordSet?'':'<section><h2>Set your password</h2><p>Your sign-in name is <strong>'+escape(admin?s.self:s.members[0].email)+'</strong>.</p>'+form('choosePassword',newPassword,'Save my password')+'</section>';
 const updates=s.resources.map(r=>'<section><small>'+escape(new Date(r.created).toLocaleDateString())+' · '+escape(r.type)+'</small><h3>'+escape(r.title)+'</h3>'+(r.type==='PDF'?'<a href="'+escape(url('resource',r.id))+'">Download PDF</a>':'<p>'+escape(r.text)+'</p>')+(admin?form('removeResource','',r.type==='PDF'?'Remove file':'Remove message',r.id):'')+'</section>').join('');
 const counts='<div class="metrics"><div><b>'+people.length+'</b><span>Production roster</span></div><div><b>'+s.members.filter(m=>!m.needsEmail).length+'</b><span>Portal accounts</span></div><div><b>'+s.members.filter(m=>!m.needsEmail&&m.activated).length+'</b><span>Activated accounts</span></div><div><b>'+s.members.filter(m=>!m.needsEmail&&!outstanding(m).gaps.some(x=>['Bio','Headshot'].includes(x))).length+'</b><span>Complete account profiles</span></div></div>';
 const mailRows=[...(s.mailQueue||[]).map(x=>({...x,status:x.lastError?'Retry scheduled':'Queued'})),...(s.mailLog||[])];
 const mailPanel='<section><h2>Email delivery</h2><p>Provider acceptance is not proof of inbox delivery. Delivery updates appear when available.</p>'+(s.mailTracking?'<p><strong>Delivery updates are switched off at Resend.</strong> Email is still being sent, but Resend refuses this site’s requests to look up what happened to each message (HTTP '+escape(s.mailTracking.status)+'). This usually means the API key is limited to sending. Replace RESEND_API_KEY in Netlify with a full-access key to see delivered and bounced statuses here.</p>':'')+(mailRows.length?'<div class="table-scroll"><table><thead><tr><th>Recipient</th><th>Subject</th><th>Status</th></tr></thead><tbody>'+mailRows.map(x=>'<tr><td>'+escape(x.to)+'</td><td>'+escape(x.subject)+'</td><td>'+escape(x.status)+(x.lastError||x.error?'<br>'+escape(x.lastError||x.error):'')+'</td></tr>').join('')+'</tbody></table></div>':'<p>No email activity recorded yet.</p>')+'</section>';
 const urgent=reviews?'<section role="region" aria-label="Pending profile approvals" style="border-left:5px solid #df8e9b;padding:1rem;background:#322329"><strong>'+s.productionReviews.length+' pending profile approval'+(s.productionReviews.length===1?'':'s')+' · '+escape(s.film)+'</strong> <button data-view-button="settings" data-review-jump>Review now</button></section>':'';
 const tabs=officeTabs;
 clearSigning();
 if(admin){
  app.innerHTML='<div class="office-header">'+productionPicker+form('logout','','Sign out')+'</div>'+account+'<nav class="office-nav" aria-label="Production office">'+tabs.map(([id,label])=>'<button type="button" data-view-button="'+id+'">'+label+'</button>').join('')+'</nav>'+(office?'':urgent)+'<div class="office-layout"><div class="office-main">'+
   '<div data-view="overview">'+personal+counts+attention+'<p>Roster includes existing film profiles and portal accounts, counted once per linked person.</p></div>'+
   '<div data-view="people">'+(!office?pendingPeoplePanel(s,[s.productionId])+(s.unassignedProfiles?.length?'<h3>Profiles without a production</h3>'+s.unassignedProfiles.map(m=>unassignedProfile(m,s)).join(''):''):'')+'<h2>People & profiles <span class="count">'+people.length+'</span></h2><div class="people-toolbar"><label>Search name, role or email<input data-people-search type="search" value="'+escape(peopleSearch)+'"></label><label>Show<select data-people-filter><option value="all">All profiles</option><option value="missing">No agreement</option><option value="progress">Paperwork in progress</option><option value="bio">Missing bio</option><option value="headshot">Missing headshot</option><option value="tasks">Open tasks</option></select></label></div><p data-results></p>'+rows+'<h2>Browse film profiles <span class="count">'+people.length+'</span></h2>'+panel('Website profiles to link ('+available.length+')',directory)+'</div>'+
   '<div data-view="documents"><h2>Paperwork</h2><p>'+(s.test?'Signing is in test mode.':'Live signing is enabled.')+'</p>'+attention+uploadedDocuments+'<div class="document-list">'+s.members.map(m=>'<p><b>'+escape(m.name)+'</b> · '+escape(m.paperworkStatus)+' <button data-open-person="'+m.id+'">Open paperwork</button></p>').join('')+'</div><div data-tool-zone="documents"></div><div id="signing"></div></div>'+
   '<div data-view="messages"><h2>Messages & files</h2><div data-tool-zone="messages"></div>'+mailPanel+'<h2>Production board</h2>'+updates+'</div>'+
   '<div data-view="availability"><div data-availability-slot></div></div>'+
   '<div data-view="calendar"><h2>Production calendar</h2><p>Your connected Exchange calendar appears alongside this workspace. It shows the next 30 days in Eastern time. In Outlook, categorize a member event as Written in the Dark, Wherein Lies Continue, or both. Events without a film category stay in the admin calendar.</p></div>'+
   '<div data-view="settings"><h2>Production settings</h2>'+(reviews?'<section data-review-list><h3>Review profiles for publication</h3>'+reviews+'</section>':'')+assignmentsPanel+panel('Revoked portal accounts',s.revokedAccounts?.length?s.revokedAccounts.filter(m=>m.productions[s.productionId]).map(m=>'<section><h3>'+escape(m.name)+'</h3><p>Portal access revoked. Public profile '+(m.keepPublic?'retained':'removed')+'.</p>'+form('publication','<label><input type="checkbox" name="visible" '+(m.keepPublic&&m.publication[s.productionId]!==false?'checked':'')+'> Show on this production website</label>','Save website visibility',m.id)+'</section>').join(''):'<p>No revoked accounts.</p>')+(waitingAccounts?panel('Accounts without a production',waitingAccounts):'')+'<div data-tool-zone="settings"></div></div></div><div id="calendar-slot"></div></div>';
  const staging=document.createElement('div');staging.innerHTML=setup;
  for(const tool of [...staging.children]){const action=tool.querySelector('form')?.dataset.action;const zone=['notice','resource'].includes(action)?'messages':action==='master'?'documents':'settings';app.querySelector('[data-tool-zone="'+zone+'"]').append(tool);}
  if(office){
   app.querySelector('.office-header').remove();
   app.querySelector('nav.office-nav').remove();
   if(!office.first)app.querySelector('#calendar-slot').remove();
  }
  applyView();if(!office||office.first)mountCalendar();
  const params=new URLSearchParams(location.search);
  if(!office&&params.has('person')){
   const card=[...app.querySelectorAll('[data-person]')].find(node=>node.dataset.person===params.get('person'));
   if(card){
    card.open=true;
    card.scrollIntoView({block:'start'});
    params.delete('person');history.replaceState(null,'',location.pathname+'?'+params);
   }
  }
  if(!office&&params.has('profile')){
   const profile=[...app.querySelectorAll('[data-catalog-profile]')].find(node=>node.dataset.catalogProfile===params.get('profile'));
   if(profile){
    profile.closest('details').open=true;
    profile.querySelector('details').open=true;
    profile.scrollIntoView({block:'start'});
    params.delete('profile');history.replaceState(null,'',location.pathname+'?'+params);
   }
  }
 }
 if(!admin)app.innerHTML=productionPicker+'<p>Cast &amp; crew · One shared profile for all your productions</p>'+form('logout','','Sign out')+account+s.members.map(memberView).join('')+'<section class="member-panel member-board"><h2>Production board</h2>'+(updates||'<p>No updates posted yet.</p>')+'</section>';
 if(!admin){app.insertAdjacentHTML('beforeend','<div id="calendar-slot"></div>');mountCalendar(false);}
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
 for(const d of app.querySelectorAll('details'))if(openDetails.includes(detailKey(d)))d.open=true;
 applyPeopleFilter();
 if(office){office.update(s);syncOffice();}

}
listen('input',e=>{
 if(!e.target.matches('[data-roster-search]'))return;
 const query=e.target.value.trim().toLowerCase();
 for(const row of app.querySelectorAll('[data-roster-name]'))row.hidden=!row.dataset.rosterName.includes(query);
 const directory=app.querySelector('[data-combined-directory]');
 if(query&&directory?.querySelector('[data-roster-name]:not([hidden])'))directory.open=true;
});
listen('change',e=>{
 const box=e.target.closest('[data-office-film]');
 if(box){
  if(availabilityBusy()||combined?.busy()){message.textContent='Save or discard open availability changes before changing productions.';box.checked=!box.checked;return;}
  if(offlineBulkInProgress||combined?.busy()||(dirty().length&&!confirm('Discard unsaved edits and change productions?'))){box.checked=!box.checked;return;}
  const films=lastState.productions;
  const selected=box.dataset.officeFilm==='all'
   ?(box.checked?films.map(p=>p.id):[])
   :[...app.querySelectorAll('[data-office-film]:checked')].map(input=>input.dataset.officeFilm).filter(id=>id!=='all');
  const params=new URLSearchParams({production:selected.includes(selectedProduction)?selectedProduction:(selected[0]||selectedProduction)});
  if(!selected.length)params.set('films','none');
  if(selected.length>1)for(const id of selected)params.append('films',id);
  if(activeView==='people'||selected.length!==1)params.set('view','people');
  for(const f of dirty())delete f.dataset.dirty;
  location.assign(location.pathname+'?'+params);
  return;
 }
 if(e.target.name==='selection')e.target.closest('fieldset').querySelector('[data-credit-fields]').hidden=!e.target.checked;
 if(e.target.matches('[data-bio-file]')&&e.target.files?.[0]){
  const field=e.target.form.elements.bio;
  e.target.files[0].text().then(value=>{if(value.length>5000)throw Error('Biography limit is 5,000 characters.');field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));}).catch(error=>{message.textContent=error.message;});
 }
 if(e.target.name==='audience')e.target.form.querySelector('[data-recipients]').hidden=e.target.value!=='selected';
 if(e.target.name==='production')e.target.form.elements['role_'+e.target.value].disabled=!e.target.checked;
 if(e.target.matches('[data-production]')){
  if((dirty().length||availabilityBusy())&&!confirm('You have unsaved changes. Switch productions and discard them?')){e.target.value=selectedProduction;return;}
  clearAvailability();
  selectedProduction=e.target.value;
  history.replaceState(null,'',location.pathname+'?'+new URLSearchParams({production:selectedProduction}));
  app.textContent='Loading production…';
  load().catch(error=>{message.textContent=error.message;});
 }
});
listen('submit',async e=>{
 e.preventDefault();const f=e.target,a=f.dataset.action,id=f.dataset.id,data=Object.fromEntries(new FormData(f));const button=e.submitter;
 if(a==='publishProfile'&&!confirm('Publish this member’s saved biography and headshot on the public Written in the Dark website?'))return;
 if(a==='removeResource'&&!confirm('Remove this from the production board for everyone? Email already delivered about it cannot be recalled.'))return;
 if((a==='revoke'||a==='sendAgreement'||(a==='agreement'&&button.value==='send'))&&!confirm(a==='revoke'?'Revoke this member’s access immediately?':a==='sendAgreement'?'Send this pending contract to its recipients?':'Create a signing request for this actor and Heidi?'))return;
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
  if(a==='trackPaperwork')data.reason=button.value;
  if(a==='activate')data.ticket=ticket;
  if(a==='resetPassword')data.ticket=resetTicket;
  if(a==='revoke')data.keepPublic=f.elements.keepPublic.checked;
  if(a==='publication')data.visible=f.elements.visible.checked;
  if(a==='recoverAgreement')data.confirmAbsent=f.elements.confirmAbsent.checked;
  if(a==='requestProductions'){
   data.selections=[...f.querySelectorAll('[name="selection"]:checked')].map(box=>box.value);
   data.credits=Object.fromEntries(data.selections.map(pid=>[pid,{character:data['character_'+pid],crewTitle:data['crewTitle_'+pid]}]));
  }
  if(a==='reviewProduction')data.decision=button.value;
  if(a==='enrollments'){data.productions=new FormData(f).getAll('production');data.roles=Object.fromEntries(data.productions.map(id=>[id,data['role_'+id]]));}
  if(a==='savePendingPerson')data.productions=new FormData(f).getAll('pendingProduction');
  const targetParams=new URLSearchParams({title:data.title||''});
  if(data.audience){data.recipients=new FormData(f).getAll('recipient');if(data.audience==='selected'&&!data.recipients.length)throw Error('Select at least one recipient.');targetParams.set('audience',data.audience);for(const who of data.recipients)targetParams.append('recipient',who);}
  const result=await request(a,data.file||data,id,a==='offline'?'&'+new URLSearchParams({status:data.status}):a==='photo'?'&'+new URLSearchParams({filename:data.file.name}):data.title&&data.file?'&'+targetParams:'');
  delete f.dataset.dirty;
  if(a==='savePendingPerson'&&!id)f.reset();
  if(office&&!data.preview)office.changed();
  if(combined&&['enrollments','savePendingPerson','removePendingPerson','invite','resend'].includes(a))combined.refresh();
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
   message.textContent=(a==='photo'?'Headshot saved.':'Bio saved.')+' An admin reviews updates for each selected film.';
   const publicationInfo=await request('home');lastState=publicationInfo;
   const member=[...publicationInfo.members,...(publicationInfo.unassignedProfiles||[])].find(m=>m.id===id);
   if(member)message.textContent+=' '+Object.entries(member.publication||{}).map(([pid,p])=>(publicationInfo.productions.find(x=>x.id===pid)?.name||pid)+': '+p.state).join(' · ');
   return;
  }
  if(a==='activate')history.replaceState(null,'',location.pathname);
  if(a==='agreement'&&data.preview){message.textContent='Preview ready. Credits saved for '+lastState.film+'.';const href=URL.createObjectURL(result);const link=document.createElement('a');link.href=href;link.download='Agreement-preview.pdf';link.click();setTimeout(()=>URL.revokeObjectURL(href),60000);return;}
  if(a==='prepareOfflineCountersign'){await load();message.textContent=result.created?(result.status==='Draft prepared'?'Heidi’s countersignature draft is prepared.':'SignWell is preparing Heidi’s countersignature draft.')+' Review its status under Documents → Uploaded agreements. No signing request has been sent.':'An existing preparation record was found. Review its status under Documents → Uploaded agreements.';return;}
  await load();message.textContent=['invite','resend'].includes(a)?'Invitation queued for email delivery.':a==='savePendingPerson'?'Name saved. Add their email here when you have it.':a==='removePendingPerson'?'Removed from the setup list.':a==='removeResource'?'Removed from the production board.':['login','passwordLogin','activate'].includes(a)?'':a==='logout'?'Signed out.':'Saved.';
 }catch(e){message.textContent=e.message;}finally{button.disabled=false;}
});
listen('click',async e=>{
 const b=e.target;if(!b.dataset.status&&!b.dataset.photo)return;
 let attempt;
 try{if(b.dataset.photo){const blob=await request('photo',undefined,b.dataset.photo);const img=new Image();img.alt='Submitted headshot';const src=URL.createObjectURL(blob);img.onload=()=>URL.revokeObjectURL(src);img.src=src;b.nextElementSibling.replaceChildren(img);return;}
 const paperwork=b.closest('.member-paperwork');
 const status=paperwork?.querySelector('strong')||(b.previousElementSibling?.tagName==='STRONG'?b.previousElementSibling:null);
 const container=paperwork?.querySelector('[data-signing],#signing')||app.querySelector('#signing');
 const review=paperwork?.querySelector('button[data-status]');
 clearSigning();attempt=signingRequest;b.disabled=true;message.textContent='Checking agreement status…';
 const r=await request('status',undefined,b.dataset.status);if(attempt!==signingRequest||!container?.isConnected)return;
 if(paperwork&&r.status==='Waiting on Heidi'&&review)review.hidden=true;
 if(status)status.textContent=r.paperworkStatus||r.status;const actualStatus=paperwork?.querySelector('[data-signing-status]');if(actualStatus)actualStatus.textContent=r.status;message.textContent=r.paperworkStatus&&r.paperworkStatus!==r.status?r.paperworkStatus+' · Signing request: '+r.status:r.status;
 if(!r.url&&['Draft ready to send','Complete'].includes(r.status)){await load();message.textContent=r.paperworkStatus||r.status;return;}
 if(!container)return;
 const view=container.closest('[data-view]');if(view&&r.url){activeView=view.dataset.view;applyView();}
 if(r.url)await showSigning(r.url,b.dataset.status,container,attempt);
 else{const note=document.createElement('p');note.textContent=r.status==='Complete'?'Your part is complete.':lastState?.admin&&r.status==='Waiting on Heidi'?'Waiting on Heidi. Only Heidi can open this agreement to sign, from her own sign-in.':'No signing link is available for this account right now. Check the agreement status again or contact production.';container.replaceChildren(note);}
 }catch(e){if(attempt===undefined||attempt===signingRequest)message.textContent=e.message;}finally{b.disabled=false;}
});
listen('click',async e=>{
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
  }else if(result.status==='Waiting on Heidi')note.textContent='Waiting on Heidi. Only Heidi can open the agreement to sign.';
 }catch(error){if(links.isConnected)links.textContent=error.message;}finally{button.disabled=false;}
});



let focusedCalendarEvent='';
async function mountCalendar(admin=true){
 const key=new URLSearchParams(location.search).get('event');
 const eventKey=/^[\w-]{43}$/.test(key||'')?key:'';
 const panel=document.createElement('aside');
 panel.className='exchange-calendar';panel.innerHTML='<h2>Production calendar</h2><p>Loading calendar…</p>';
 app.querySelector('#calendar-slot')?.append(panel);
 const refresh=async()=>{
  try{
   const result=await request('calendarEvents',undefined,'',eventKey?'&event='+encodeURIComponent(eventKey):'');
   if(!panel.isConnected)return;
   if(!result.connected){
    if(!admin){panel.innerHTML='<h2>Production calendar</h2><p>The calendar is currently unavailable.</p>';return;}

    const connect=document.createElement('button');
    connect.textContent='Connect Outlook calendar';
    connect.onclick=async()=>{try{location.assign((await request('calendarConnect',{})).url);}catch{message.textContent='Calendar connection unavailable. Check the production calendar secret.';}};
    const heading=document.createElement('h2');heading.textContent='Production calendar';const note=document.createElement('p');note.textContent='Connect the hello@ Exchange calendar.';panel.replaceChildren(heading,note,connect);
   }else{
    const list=document.createElement('ul');
    const rows=result.selected?[result.selected,...result.items.filter(e=>e.key!==eventKey)]:result.items;
    for(const event of rows){
     const item=document.createElement('li');
     const date=new Date(event.start+'Z');
     const when=event.allDay?event.start.slice(0,10)+' · All day':date.toLocaleString('en-US',{timeZone:'America/Indiana/Indianapolis',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
     item.textContent=when+' — '+event.title;
     if(event.key===eventKey&&result.selected){const label=document.createElement('strong');label.textContent='Selected event · ';item.prepend(label);}
     list.append(item);
    }
    const heading=document.createElement('h2');heading.textContent='Production calendar';
    const note=document.createElement('p');note.textContent=result.items.length?'Next 30 days · Eastern time':'No upcoming events in the next 30 days.';
    if(eventKey&&!result.selected)note.textContent='The linked event is no longer available. '+note.textContent;
    if(result.selected)note.textContent='The linked event is listed first. Upcoming events follow in Eastern time.';
    panel.replaceChildren(heading,note,list);
    if(eventKey&&focusedCalendarEvent!==eventKey){focusedCalendarEvent=eventKey;panel.scrollIntoView({block:'start'});}
   }
   panel.className='exchange-calendar';panel.hidden=false;
  }catch{panel.innerHTML='<h2>Production calendar</h2><p>Calendar unavailable. Your connection may need attention.</p>';const retry=document.createElement('button');retry.textContent='Try again';retry.onclick=refresh;const reconnect=document.createElement('button');reconnect.textContent='Reconnect Outlook';reconnect.onclick=async()=>{try{location.assign((await request('calendarConnect',{})).url);}catch(e){message.textContent=e.message;}};panel.append(retry);if(admin)panel.append(reconnect);}

 };
 await refresh();
 const timer=setInterval(()=>{if(!panel.isConnected)clearInterval(timer);else if(!document.hidden&&!panel.hidden)refresh();},300000);
}



function applyView(){
 if(lastState?.admin&&!office){const picker=app.querySelector('.office-header .production-picker');if(picker)picker.hidden=activeView==='availability';}
 app.querySelectorAll('[data-view]').forEach(el=>el.hidden=el.dataset.view!==activeView);
 app.querySelectorAll('[data-view-button]').forEach(b=>b.setAttribute('aria-current',b.dataset.viewButton===activeView?'page':'false'));
 ensureAvailability();
}
function applyPeopleFilter(){
 const search=app.querySelector('[data-people-search]'),filter=app.querySelector('[data-people-filter]');if(!search)return;
 search.value=peopleSearch;filter.value=peopleFilter;let shown=0;
 for(const card of app.querySelectorAll('[data-person]')){
  const status=card.dataset.paperwork,gaps=card.dataset.gaps;
  const match=peopleFilter==='all'||peopleFilter==='missing'&&status==='No agreement on file'||peopleFilter==='progress'&&!['Complete','Document N/A','Not required','No agreement on file'].includes(status)||peopleFilter==='bio'&&gaps.includes('bio')||peopleFilter==='headshot'&&gaps.includes('headshot')||peopleFilter==='tasks'&&gaps.includes('tasks');
  card.hidden=!match||!card.dataset.search.includes(peopleSearch.toLowerCase());if(!card.hidden)shown++;
 }
 app.querySelector('[data-results]').textContent=shown+' profile'+(shown===1?'':'s')+' shown';
}
listen('click',e=>{
 const tab=e.target.closest('[data-view-button]');if(tab){if(office)office.show(tab.dataset.viewButton);else{activeView=tab.dataset.viewButton;applyView();}if(tab.hasAttribute('data-review-jump')){const queue=app.querySelector('[data-review-list]');if(queue){queue.querySelector('details').open=true;queue.scrollIntoView({block:'start'});}}}
 const setup=e.target.closest('[data-open-setup-profile]');if(setup&&!combined){activeView='people';applyView();const id=setup.dataset.openSetupProfile,card=app.querySelector('[data-person="'+id+'"],[data-unassigned-person="'+id+'"]');if(card){card.hidden=false;card.open=true;card.scrollIntoView({block:'start'});}return;}
 const open=e.target.closest('[data-open-person]');if(open){if(office){office.show('people');focusFilm={target:'person',profileId:open.dataset.openPerson};syncOffice();}activeView='people';peopleFilter='all';peopleSearch='';applyView();applyPeopleFilter();if(office)syncOffice();const card=app.querySelector('[data-person="'+open.dataset.openPerson+'"]');card.open=true;card.scrollIntoView({block:'start'});}
});
listen('input',e=>{if(e.target.matches('[data-people-search]')){peopleSearch=e.target.value;applyPeopleFilter();}});
listen('change',e=>{if(e.target.form)e.target.form.dataset.dirty='true';if(e.target.matches('[data-people-filter]')){peopleFilter=e.target.value;applyPeopleFilter();}});
setInterval(()=>{if(!combined&&lastState&&!document.hidden&&!dirty().length&&!availabilityBusy()&&!availabilityOpen()&&!signingSession&&!offlineBulkInProgress)load().catch(()=>{});},300000);
let focusFilm=null;
function syncOffice(){
 if(!office)return;
 office.section.hidden=(activeView==='people'&&!focusFilm)||(activeView==='calendar'&&!office.first);
 const slot=app.querySelector('#calendar-slot');
 if(slot)slot.hidden=activeView!=='calendar';
 if(activeView!=='people'||!focusFilm)return;
 const area=app.querySelector('[data-view="people"]');
 if(!area)return;
 const selector=focusFilm.target==='person'?'[data-person]':'[data-catalog-profile]';
 const card=[...area.querySelectorAll(selector)].find(el=>(el.dataset.person||el.dataset.catalogProfile)===focusFilm.profileId);
 for(const child of area.children)child.hidden=!card||!(child===card||child.contains(card));
 if(card){
  for(const peer of area.querySelectorAll(selector))peer.hidden=peer!==card;
  for(let el=card;el&&el!==area;el=el.parentElement){el.hidden=false;if(el.tagName==='DETAILS')el.open=true;}
  const details=card.querySelector('details');if(focusFilm.target==='profile'&&details)details.open=true;
 }
}
load(office?.state).catch(e=>{app.textContent='Portal unavailable.';message.textContent=e.message;});
return {
 review(){const list=app.querySelector('[data-review-list]');if(list){list.querySelector('details').open=true;list.scrollIntoView({block:'start'});}},
 show(view){activeView=view;focusFilm=null;applyView();syncOffice();},
 open(film,scroll){focusFilm=film;syncOffice();if(scroll)office.section.scrollIntoView({block:'start'});},
 refresh(){if(!dirty().length&&!availabilityBusy()&&!availabilityOpen()&&!offlineBulkInProgress&&!signingSession)load().catch(e=>{message.textContent=e.message;});},
 busy(){return offlineBulkInProgress||!!signingSession||availabilityBusy();}
};
}
startPortal(document.querySelector('#app'));
