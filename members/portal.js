import {comparePeople,sortPeople,orderAdminPeople} from './people-order.mjs';
import {mountAvailability} from './availability.js';
import {mountFilmingAvailability} from './filming-availability.js';
import {mountReports} from './reports.js';
import {mountBulkActions} from './bulk-actions.js';
import {selectHeadshot,prepareHeadshot,clearHeadshotPreview} from './headshot-editor.js';
const officeTabs=[['overview','Overview'],['people','People'],['documents','Documents'],['messages','Messages & files'],['availability','Filming availability'],['calendar','Events'],['reports','Reports'],['settings','Settings']];
const directoryFilters=[
 ['all','Everyone'],['setup','Account setup needed'],['catalog','Website profiles to link'],
 ['missing','No agreement on file'],['progress','Signing in progress'],['bio','Biography needed'],
 ['headshot','Headshot needed'],['tasks','Open tasks']
];
function matchesDirectoryFilter(person,filter){
 if(filter==='all')return true;
 if(filter==='setup')return person.hasMemberProfile&&(!person.hasAccount||!person.member.activated||person.unassigned);
 if(filter==='catalog')return !person.hasMemberProfile;
 const profiles=person.films.map(film=>film.member||film.profile);
 if(!profiles.length&&person.member)profiles.push(person.member);
 if(filter==='bio')return profiles.some(profile=>!(profile.profile?.bio??profile.bio)?.trim());
 if(filter==='headshot')return profiles.some(profile=>!(profile.hasPhoto||profile.referencePhoto||profile.photo));
 if(filter==='tasks')return profiles.some(profile=>profile.tasks?.some(task=>!task.done));
 if(filter==='missing')return person.films.some(film=>(film.member?.paperworkStatus||film.profile?.paperworkStatus)==='No agreement on file');
 if(filter==='progress')return person.films.some(({member})=>member?.agreement&&!member.agreement.cleared&&member.agreement.status!=='Complete');
 return true;
}
function startPortal(app, office=null){
const message=document.querySelector('#message');
let combined=null;
function listen(type,handler){
 app.addEventListener(type,event=>{
  if(event.target.closest('[data-office-root]')===app&&!event.target.closest('[data-availability-root],[data-reports-root],[data-bulk-root]'))handler(event);
 });
}
app.dataset.officeRoot='';
const endpoint='/.netlify/functions/portal';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const routeParams=new URLSearchParams(location.search);
let activeView=officeTabs.some(([id])=>id===routeParams.get('view'))?routeParams.get('view'):'overview';
let lastState,offlineBulkInProgress=false,renderOfficePerson;
let memberViewName='';
const memberViews=[['home','Home'],['profile','Profile'],['documents','Documents'],['availability','Availability'],['events','Events']];
const memberButton=(view,label)=>'<button type="button" data-member-tab="'+view+'">'+escape(label)+'</button>';
function showMemberView(name,{navigate=false,scroll=false}={}){
 const panes=[...app.querySelectorAll('[data-member-view]')];
 const pane=panes.find(node=>node.dataset.memberView===name)||panes[0];
 if(!pane)return;
 memberViewName=pane.dataset.memberView;
 for(const node of panes)node.hidden=node!==pane;
 for(const button of app.querySelectorAll('nav [data-member-tab]')){
  if(button.dataset.memberTab===memberViewName)button.setAttribute('aria-current','page');
  else button.removeAttribute('aria-current');
 }
 if(memberViewName==='availability')openAvailability(pane.querySelector('[data-availability-slot]'));
 if(navigate){
  const params=new URLSearchParams(location.search);
  params.set('memberView',memberViewName);
  if(memberViewName!=='events')params.delete('event');
  history.replaceState(null,'',location.pathname+'?'+params);
  const heading=pane.querySelector('h2');
  if(heading){
   heading.setAttribute('tabindex','-1');
   heading.focus({preventScroll:true});
   if(scroll)heading.scrollIntoView({block:'start'});
  }
 }
}
function memberPublishing(member,productions){
 if(member.practice)return '<p>This practice account stays private.</p>';
 const rows=productions.flatMap(production=>{
  const status=member.publication?.[production.id]?.state;
  const pending=!!member.productionRequests?.[production.id];
  if(!status&&!pending)return [];
  const labels={'Hidden from website':'Hidden','Needs bio and headshot':'Missing profile information','Awaiting approval':'Awaiting approval','Sync failed':'Sync needs attention'};
  const current=labels[status]||status||'Awaiting approval';
  const display=status==='Published'&&pending?'Published · Changes awaiting approval':current;
  return ['<li><span>'+escape(production.name)+'</span><strong>'+escape(display)+'</strong></li>'];
 });
 return rows.length?'<ul>'+rows.join('')+'</ul>':'<p>Choose a production to request approval for its website.</p>';
}
const dirty=()=>[...app.querySelectorAll('form[data-dirty]')];
const availabilityViews=new Map();
const reportViews=new Map();
const reportsBusy=()=>[...reportViews.values()].some(view=>view.busy());
function clearReports(){for(const view of reportViews.values())view.destroy();reportViews.clear();}
function openReports(slot){
 if(!slot||!lastState?.admin||reportViews.has(slot))return;
 reportViews.set(slot,mountReports(slot,{request:(action,body,id,suffix,production)=>request(action,body,id,suffix,production||selectedProduction),productions:lastState.productionChoices||lastState.productions,owner:lastState.self}));
}
const availabilityBusy=()=>[...availabilityViews.values()].some(view=>view.busy());
const availabilityOpen=()=>[...availabilityViews.keys()].some(slot=>slot.isConnected&&slot.getBoundingClientRect().height>0);
function clearAvailability(){for(const view of availabilityViews.values())view.destroy();availabilityViews.clear();clearReports();}
function openAvailability(slot,memberId){
 if(!slot||!lastState||availabilityViews.has(slot))return;
 slot.dataset.availabilityRoot='';
 const view=lastState.admin&&!memberId?mountFilmingAvailability(slot,{request:(action,body,id,suffix,production)=>request(action,body,id,suffix,production||selectedProduction),productions:lastState.productionChoices||lastState.productions,productionId:lastState.productionId}):mountAvailability(slot,{request:(action,body,id,suffix)=>request(action,body,id,suffix),productionId:lastState.productionId,admin:lastState.admin,selfId:lastState.self,memberId});
 availabilityViews.set(slot,view);
}
function ensureAvailability(){
 const board=app.querySelector('[data-view="availability"] [data-availability-slot]');
 if(activeView==='availability'&&board)openAvailability(board);
 if(activeView==='reports')openReports(app.querySelector('[data-view="reports"] [data-reports-slot]'));
 for(const details of app.querySelectorAll('details[data-availability-panel][open]'))openAvailability(details.querySelector('[data-availability-slot]'),details.dataset.availabilityPerson||undefined);
}
app.addEventListener('toggle',event=>{const details=event.target;if(details.closest('[data-office-root]')===app&&details.matches('details[data-availability-panel]')&&details.open)openAvailability(details.querySelector('[data-availability-slot]'),details.dataset.availabilityPerson||undefined);},true);
window.addEventListener('beforeunload',e=>{if(dirty().length||availabilityBusy()||reportsBusy()||combined?.busy()){e.preventDefault();e.returnValue='';}});
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
async function showSigning(rawUrl,id,container,attempt,recipientName){
 const u=new URL(rawUrl);
 if(u.protocol!=='https:'||u.username||u.password||!(u.hostname==='signwell.com'||u.hostname.endsWith('.signwell.com')))throw Error('Unexpected signing address.');
 const session={container};signingSession=session;
 const options=document.createElement('p'),link=document.createElement('a'),refresh=document.createElement('button');
 link.href=u.href;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open agreement in a new tab';
 refresh.type='button';refresh.dataset.status=id;refresh.textContent='Refresh agreement status';
 options.append(link,document.createTextNode(' '),refresh);
 const note=document.createElement('p');note.setAttribute('role','status');note.textContent='Loading your agreement… You can open it in a new tab at any time.';
 const mount=document.createElement('div');mount.id='signwell-agreement-'+attempt;
 container.replaceChildren(options,note,mount);
 if(recipientName){
  const recipient=document.createElement('p');
  recipient.textContent='SignWell lists '+recipientName+' as the countersigner.';
  container.prepend(recipient);
 }
 container.scrollIntoView({block:'start'});
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
   documentLoaded:()=>{if(current()&&!session.failed&&!session.completed){clearTimeout(session.timeout);note.textContent=recipientName?'Open the agreement below or in a new tab for '+recipientName+' to review and sign.':'Review and sign your agreement below, or use the new-tab link above.';}},
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
function detailKey(details){
 if(details.hasAttribute('data-profile-activity'))return 'activity/'+details.dataset.activityProduction+'/'+details.dataset.profileActivity;
 if(details.matches('[data-availability-panel]'))return 'availability/'+(details.dataset.availabilityPerson||'self');
 return details.dataset.person||details.querySelector(':scope > summary')?.textContent;
}
function profileActivityPanel(member,production){
 return '<details data-profile-activity="'+escape(member.id)+'" data-activity-production="'+escape(production)+'">'+
  '<summary>Activity history</summary><p>Shows the latest changes since activity tracking began.</p>'+
  '<div data-activity-content></div></details>';
}
app.addEventListener('toggle',async event=>{
 const details=event.target;
 if(!details.matches('details[data-profile-activity]')||!details.open||details.closest('[data-office-root]')!==app||details.dataset.activityLoad)return;
 const content=details.querySelector('[data-activity-content]');
 details.dataset.activityLoad='loading';
 content.innerHTML='<p role="status">Loading activity…</p>';
 try{
  const result=await request('profileActivity',undefined,details.dataset.profileActivity,'',details.dataset.activityProduction);
  if(!details.isConnected)return;
  const dateFormat=new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Indiana/Indianapolis'});
  content.innerHTML=result.items.length?'<ul class="profile-activity-list">'+result.items.map(item=>{
   const date=new Date(item.at);
   return '<li><strong>'+escape(item.label)+'</strong> · '+escape(item.by)+' · <time datetime="'+date.toISOString()+'">'+escape(dateFormat.format(date))+' ET</time></li>';
  }).join('')+'</ul>':'<p>No activity recorded yet.</p>';
  details.dataset.activityLoad='loaded';
 }catch{
  if(details.isConnected)content.textContent='Activity history unavailable. Close and reopen to retry.';
  delete details.dataset.activityLoad;
 }
},true);
const trackingLabel=reason=>['complete','hard-copy'].includes(reason)?'Recorded complete':reason==='not-required'?'Not required':'';
function signingLabel(status,member=false){
 if(status==='Complete')return 'Signed by both';
 if(status==='Waiting on actor')return member?'Awaiting your signature':'Awaiting cast or crew signature';
 if(status==='Waiting on Heidi')return 'Awaiting Heidi Mikac’s signature';
 return status||'No agreement on file';
}
function paperworkSummary(member){
 const recorded=trackingLabel(member.paperworkTracking?.reason);
 const signing=member.agreement?.id&&!member.agreement.cleared?signingLabel(member.agreement.status):'';
 return [recorded,signing].filter(Boolean).join(' · ')||signingLabel(member.paperworkStatus);
}
function recordedDetails(record){
 const by=record?.by?'Recorded by '+record.by:'Recorded by an admin';
 const date=Number.isFinite(record?.at)?new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Indiana/Indianapolis'}).format(record.at):'';
 return date?by+' · '+date+' ET':by;
}
function profile(m){
 return panel('Headshot &amp; biography · '+((m.hasPhoto||m.referencePhoto)?'photo received':'photo needed')+' · '+(m.profile?.bio?'bio received':'bio needed'),form('bio','<label>Biography<textarea name="bio" rows="5" maxlength="5000">'+escape(m.profile?.bio)+'</textarea></label>','Save biography',m.id)+form('photo',file('Headshot · JPG or PNG, up to 4 MB','image/jpeg,image/png'),'Upload headshot',m.id)+(m.hasPhoto?'<button data-photo="'+m.id+'">View current headshot</button><div class="portrait"></div>':''));
}
function creditFields(value={},suffix=''){
 const field=(key,label)=>'<label>'+label+'<input maxlength="120" name="'+key+suffix+'" value="'+escape(value[key]||'')+'"></label>';
 return field('character','Character')+field('crewTitle','Crew title');
}
const creditSnapshot=assignment=>JSON.stringify([assignment?.role||'',assignment?.character||'',assignment?.crewTitle||'']);
function agreement(m){
 const assignment=m.productions[lastState.productionId];
 const fields='<input type="hidden" name="expectedCredit" value="'+escape(creditSnapshot(assignment))+'">'+input('legal','Legal name','text',m.name)+
  '<p>Enter at least one character or crew title for this agreement.</p>'+
  creditFields(m.proposedCredits?.[lastState.productionId]||m.productions[lastState.productionId]||{})+
  '<p>Saved production credit · <span data-current-credit>'+escape(m.role||'None')+'</span></p>'+
  '<p>Save credits updates the production profile and any credit already published for '+escape(lastState.film)+'.</p>'+
  input('credit','Screen credit / professional name','text',m.name)+input('rate','Agreed daily rate (USD)')+input('date','Agreement date','date')+
  '<p>This agreement covers services already performed for this film and any future services mutually agreed. Each signer’s date is filled automatically when they sign.</p>';
 return panel('Prepare agreement for '+escape(lastState.film),'<form data-action="agreement" data-id="'+m.id+'">'+fields+
  '<button value="preview">Preview agreement</button><button value="credits" formnovalidate>Save credits</button><button value="send"'+(m.needsEmail?' disabled':'')+'>Create signing request</button>'+
  (m.needsEmail?'<p>Add this person’s email to send a signing request.</p>':'')+'</form>');
}
const ticket=new URLSearchParams(location.hash.slice(1)).get('invite');
const resetTicket=new URLSearchParams(location.hash.slice(1)).get('reset');
const newPassword='<label>Choose a password (12 or more characters)<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label>';
function profileStatus(f,text,error=false){
 let note=f.querySelector('output');
 if(!note){note=document.createElement('output');note.style.display='block';f.append(note);}
 note.textContent=text;
 note.classList.toggle('profile-save-error',error);
}
listen('input',e=>{
 const f=e.target.form;if(f)f.dataset.dirty='true';
 if(f?.dataset.action==='bio')profileStatus(f,'Unsaved changes');
 if(f?.dataset.action==='photo'&&e.target.files?.length)profileStatus(f,'Selected · '+e.target.files[0].name+' (not saved yet)');
});
function login(){
 clearSigning();
 clearAvailability();
 app.classList.remove('member-workspace');
 app.innerHTML='<section><h2>Welcome back</h2>'+form('passwordLogin','<label>Email or admin name<input name="username" autocomplete="username" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label>','Sign in')+'<p>First time here? Open the newest cast &amp; crew invitation and choose a password.</p></section>'+panel('Forgot your password?',form('requestReset','<label>Email or admin name<input name="username" autocomplete="username" required></label>','Email reset link'))+(new URLSearchParams(location.search).has('setup')?panel('First-time admin setup',form('login',input('code','Existing access key','password'),'Continue to password setup')):'');
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
   if(!people.has(key))people.set(key,{key,name:person.name,memberId:null,hasMemberProfile:false,hasAccount:false,films:[]});
   if(target==='person')Object.assign(people.get(key),{name:person.name,memberId:person.id,hasMemberProfile:true,hasAccount:!person.needsEmail,needsEmail:!!person.needsEmail,member:person});
   people.get(key).films.push({id:state.productionId,name:state.film,role:person.role,profileId:person.id,target,...(target==='person'?{member:person}:{profile:person})});
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
  if(!people.has(key))people.set(key,{key,name:member.name,memberId:member.id,hasMemberProfile:true,hasAccount:!member.needsEmail,needsEmail:!!member.needsEmail,unassigned:true,member,films:[]});
 }
 return [...people.values()].sort(comparePeople);
}

function productionAssignments(accounts,productions,label='Manage production assignments ('+accounts.length+' '+(accounts.length===1?'person':'people')+')'){
 return panel(label,'<p>One profile, one shared biography and headshot. Check each production this person belongs to. Review member submissions before publishing them. Named Test accounts stay private.</p>'+sortPeople(accounts).map(m=>panel(escape(m.name),'<form data-action="enrollments" data-id="'+m.id+'">'+
  '<input type="hidden" name="expectedAssignments" value="'+escape(JSON.stringify(Object.fromEntries(Object.entries(m.productions).map(([id,assignment])=>[id,creditSnapshot(assignment)]))))+'">'+productions.map(p=>{
  const assigned=m.productions[p.id];
  const existingCredit=assigned?.role&&!assigned.character&&!assigned.crewTitle?
   '<p>Current credit · '+escape(assigned.role)+'. Enter a character or crew title to replace it.</p>':'';
  return '<fieldset><legend>'+escape(p.name)+'</legend>'+
   '<label><input type="checkbox" name="production" value="'+escape(p.id)+'" '+(assigned?'checked':'')+'> Assigned to '+escape(p.name)+'</label>'+
   '<div data-assignment-credit-fields'+(assigned?'':' hidden')+'>'+creditFields(assigned,'_'+p.id)+existingCredit+'</div></fieldset>';
 }).join('')+'<button>Save productions</button></form>')).join(''));
}

function pendingPeoplePanel(state,selected){
 const choices=state.productionChoices||state.productions;
 const fields=values=>'<fieldset><legend>Productions (optional)</legend>'+choices.map(p=>'<label><input type="checkbox" name="pendingProduction" value="'+escape(p.id)+'" '+(values.includes(p.id)?'checked':'')+'> '+escape(p.name)+'</label>').join('')+'</fieldset>';
 const records=sortPeople(state.pendingPeople).filter(p=>!p.productions.length||p.productions.some(id=>selected.includes(id)));
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
function accessControls(m,state){
 return panel('Manage access',(!m.needsEmail&&!m.activated&&state.mailReady?form('resend','','Resend invitation',m.id):'')+
  form('revoke','<label><input type="checkbox" name="keepPublic" checked> Keep public film credits and profile visible</label><p>Uncheck to also remove this account’s public profiles. Access is revoked immediately.</p>','Revoke portal access',m.id));
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
 let pendingState=states[0],people=[],editor=null;
 let search=sessionStorage.getItem('hmf-directory-search')||'';
 let filter=directoryFilters.some(([value])=>value===routeParams.get('filter'))?routeParams.get('filter'):'all';
 const nav=officeTabs.map(([id,label])=>'<button type="button" data-main-tab="'+id+'">'+label+'</button>').join('');
 const options=directoryFilters.map(([value,label])=>'<option value="'+value+'">'+label+'</option>').join('');
 app.classList.add('admin-workspace');
 app.innerHTML='<div class="office-header">'+picker+form('logout','','Sign out')+'</div>'+
  (!pendingState.passwordSet?'<section><h2>Set your password</h2>'+form('choosePassword',newPassword,'Save my password')+'</section>':'')+
  '<nav class="office-nav" aria-label="Production office">'+nav+'</nav><section class="action-inbox" data-main-inbox></section>'+
  '<section data-shared-settings hidden><h2>Account settings</h2>'+
  panel('Invite cast or crew',pendingState.mailReady?form('invite',input('name','Name')+input('email','Email','email'),'Email invitation'):'<p>Email invitations are waiting for the production sender to be connected.</p>')+
  '<div data-shared-assignments></div></section>'+
  '<div data-main-people><div data-directory><div class="directory-heading"><h2>People &amp; profiles</h2><div data-bulk-actions></div></div>'+
  '<div class="people-toolbar"><label>Search name, role or email<input type="search" data-roster-search></label><label>Show<select data-roster-filter>'+options+'</select></label></div>'+
  '<p class="directory-count" data-roster-count role="status"></p><ul class="people-directory" data-accounts></ul><div data-pending-people></div>'+
  '<details data-combined-directory><summary></summary><ul class="people-directory" data-catalog></ul></details></div><div data-person-editor></div></div>'+
  '<div data-main-filming hidden><div data-availability-slot></div></div><div data-main-reports hidden><div data-reports-slot></div></div><div data-offices></div>';
 const find=selector=>app.querySelector(selector);
 const inbox=find('[data-main-inbox]');
 const personEditor=find('[data-person-editor]');
 const directory=find('[data-directory]');
 const matchingMember=id=>id?people.find(person=>person.memberId===id):undefined;
 function syncRoute(){
  const params=new URLSearchParams(location.search);
  if(activeView==='overview')params.delete('view');else params.set('view',activeView);
  params.delete('search');
  if(filter==='all')params.delete('filter');else params.set('filter',filter);
  for(const key of ['person','profile','pending','editFilm'])params.delete(key);
  if(activeView==='people'&&editor){
   const person=people.find(row=>row.key===editor.key);
   if(person?.memberId)params.set('person',person.memberId);
   else if(person){const film=person.films.find(item=>item.id===editor.filmId)||person.films[0];if(film)params.set('profile',film.profileId);}
   if(editor.filmId)params.set('editFilm',editor.filmId);
  }
  const query=params.toString();
  history.replaceState(null,'',location.pathname+(query?'?'+query:''));
 }
 function renderAssignments(state){
  const host=find('[data-shared-assignments]');
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
 function renderInbox(){
  if(inbox.querySelector('form[data-dirty]'))return;
  const openGroups=new Set([...inbox.querySelectorAll('details[open] > summary')].map(summary=>summary.dataset.group));
  const hadApprovals=!!inbox.querySelector('[data-group="approvals"]');
  const groups=[...snapshots.values()];
  const items=[];
  for(const state of groups){
   for(const review of state.productionReviews||[])items.push({name:review.name,label:'Review profile for publication',id:review.id,state,kind:'review'});
   for(const item of state.waiting||[]){
    if(item.key?.startsWith('production-request/')||(item.view==='settings'&&!item.member&&!item.taskId))continue;
    const name=matchingMember(item.member)?.name||item.label;
    items.push({name,label:item.label,id:item.member,state,item,kind:item.taskId?'task':item.signature?'signature':item.member?'person':'section'});
   }
  }
  const ordered=items.sort(comparePeople);
  const actionRow=entry=>{
   const {name,label,id,state,item,kind}=entry;
   const film=escape(state.productionId);
   let action='';
   if(kind==='task'){
    action='<form data-action="finishAdminTask" data-production="'+film+'"><input type="hidden" name="owner" value="'+escape(item.owner)+'"><input type="hidden" name="task" value="'+escape(item.taskId)+'"><button>Mark done</button></form>';
   }else if(kind==='review')action='<button type="button" data-inbox-review="'+escape(id)+'" data-inbox-film="'+film+'">Review</button>';
   else if(id){
    const area=item.key?.startsWith('portal-contact/')?'shared':item.key?.includes('/prepare/')?'prepare':'paperwork';
    const buttonText=kind==='signature'?'Open agreement':area==='shared'?'Open profile':area==='prepare'?'Prepare agreement':'Open paperwork';
    action='<button type="button" data-inbox-person="'+escape(id)+'" data-inbox-film="'+film+'" data-inbox-area="'+area+'">'+buttonText+'</button>';
   }
   else action='<button type="button" data-inbox-view="'+escape(item.view)+'" data-inbox-film="'+film+'">Open '+(item.view==='settings'?'settings':'documents')+'</button>';
   return '<li class="action-row"><div><strong>'+escape(name)+'</strong>'+(name!==label?'<span>'+escape(label)+'</span>':'')+'<small>'+escape(state.film)+(item?.owner&&item.owner!=='any'?' · Assigned to you':'')+'</small></div>'+action+'</li>';
  };
  const approvals=ordered.filter(row=>row.kind==='review');
  const paperwork=ordered.filter(row=>['person','signature','section'].includes(row.kind));
  const tasks=ordered.filter(row=>row.kind==='task');
  const group=(key,title,rows)=>rows.length?'<details class="action-group"'+(openGroups.has(key)||(!hadApprovals&&key==='approvals')?' open':'')+
   '><summary data-group="'+key+'">'+title+' <span class="count">'+rows.length+'</span></summary><ul>'+rows.map(actionRow).join('')+'</ul></details>':'';
  const films=groups.map(state=>'<option value="'+escape(state.productionId)+'">'+escape(state.film)+'</option>').join('');
  inbox.innerHTML='<h2>Action inbox <span class="count">'+ordered.length+'</span></h2>'+
   (ordered.length?group('approvals','Profile approvals',approvals)+group('agreements','Agreements &amp; account setup',paperwork)+group('tasks','Admin tasks',tasks):'<p>You’re caught up.</p>')+
   panel('Assign an admin task',form('adminTask','<label>Production<select name="actionProduction">'+films+'</select></label>'+input('title','Task')+'<label>Assigned to<select name="owner"><option value="any">Any admin</option><option>Heidi</option><option>Nick</option></select></label>','Assign task'));
 }
 function statusLabels(person){
  const member=person.member;
  const labels=[];
  if(!person.hasAccount)labels.push(person.hasMemberProfile?'Email needed':'Website profile only');
  else if(!member?.activated)labels.push('Invitation pending');
  if(person.unassigned&&person.hasAccount)labels.push('No production selected');
  for(const film of person.films)if(film.member){
   const status=paperworkSummary(film.member);
   if(!labels.includes(status))labels.push(status);
  }
  return labels;
 }
 function renderDirectory(){
  renderPendingPeople(find('[data-pending-people]'),pendingState,[...snapshots.keys()]);
  const row=(person,index)=>'<li class="directory-row" data-roster-row="'+index+'"><button type="button" data-person-index="'+index+'"><strong>'+escape(person.name)+'</strong></button>'+
   '<div class="production-badges">'+person.films.map(film=>'<span title="'+escape(film.role)+'">'+escape(film.name)+'</span>').join('')+'</div>'+
   '<div class="directory-status">'+statusLabels(person).map(label=>'<span>'+escape(label)+'</span>').join('')+'</div></li>';
  find('[data-accounts]').innerHTML=people.map((person,index)=>person.hasMemberProfile?row(person,index):'').join('');
  find('[data-catalog]').innerHTML=people.map((person,index)=>person.hasMemberProfile?'':row(person,index)).join('');
  applyDirectoryFilter();
 }
 function applyDirectoryFilter(){
  find('[data-roster-search]').value=search;
  find('[data-roster-filter]').value=filter;
  let count=0,catalogCount=0;
  const query=search.trim().toLowerCase();
  for(const row of app.querySelectorAll('[data-roster-row]')){
   const person=people[Number(row.dataset.rosterRow)];
   const haystack=[person.name,person.member?.email,...person.films.map(film=>film.role)].join(' ').toLowerCase();
   row.hidden=!haystack.includes(query)||!matchesDirectoryFilter(person,filter);
   if(!row.hidden){count++;if(!person.hasMemberProfile)catalogCount++;}
  }
  const catalog=find('[data-combined-directory]');
  catalog.querySelector('summary').textContent='Website profiles to link ('+catalogCount+')';
  catalog.hidden=catalogCount===0;
  if((query||filter!=='all')&&catalogCount)catalog.open=true;
  find('[data-roster-count]').textContent=count+' of '+people.length+' '+(people.length===1?'person':'people')+' shown';
 }
 function sharedEditor(person){
  const m=person.member;
  const photo=m.hasPhoto?url('photo',m.id):m.referencePhoto;
  return '<section class="shared-person-profile" aria-label="Shared profile and access">'+
   '<div class="shared-profile-contact">'+accountEmail(m)+'<p>'+escape(m.needsEmail?'Email needed':m.activated?'Account active':'Invitation pending')+'</p></div>'+
   contactName(m)+contactEmail(m)+(photo?'<img data-headshot src="'+escape(photo)+'" alt="Saved headshot">':'')+
   profile(m)+productionAssignments([m],pendingState.productions,'Manage production assignments')+
   accessControls(m,pendingState)+'</section>';
 }
 function renderEditor(){
  const person=editor&&people.find(row=>row.key===editor.key);
  if(!person){editor=null;personEditor.replaceChildren();directory.hidden=false;return;}
  directory.hidden=true;
  if(editor.filmId&&!person.films.some(film=>film.id===editor.filmId))editor.filmId=person.hasMemberProfile?null:person.films[0]?.id;
  const expanded=[...personEditor.querySelectorAll('details[open]')].map(detailKey);
  const drafts=[...personEditor.querySelectorAll('form[data-dirty],form:has(button:disabled)')];
  const tab=(value,label,selected)=>'<button type="button" data-person-film="'+escape(value)+'"'+(selected?' aria-current="page"':'')+'>'+escape(label)+'</button>';
  personEditor.innerHTML='<section class="person-editor-heading"><button class="quiet-button" type="button" data-back-directory>← Back to people</button><h2 tabindex="-1">'+escape(person.name)+'</h2>'+
   '<nav class="person-editor-tabs" aria-label="Profile sections">'+
   (person.hasMemberProfile?tab('','Profile & access',!editor.filmId):'')+
   person.films.map(film=>tab(film.id,film.name,editor.filmId===film.id)).join('')+'</nav></section>'+
   (person.hasMemberProfile&&!editor.filmId?sharedEditor(person):'');
  for(const draft of drafts){
   const replacement=[...personEditor.querySelectorAll('form')].find(f=>f.dataset.action===draft.dataset.action&&f.dataset.id===draft.dataset.id);
   if(replacement)replacement.replaceWith(draft);
  }
  for(const details of personEditor.querySelectorAll('details'))if(expanded.includes(detailKey(details)))details.open=true;
 }
 function show(view){
  activeView=view;
  const person=editor&&people.find(row=>row.key===editor.key);
  const film=person?.films.find(item=>item.id===editor.filmId);
  find('[data-main-people]').hidden=view!=='people';
  find('[data-main-inbox]').hidden=view!=='overview';
  find('[data-shared-settings]').hidden=view!=='settings';
  find('[data-main-filming]').hidden=view!=='availability';
  find('[data-main-reports]').hidden=view!=='reports';
  find('[data-offices]').hidden=['availability','reports'].includes(view)||(view==='people'&&!film);
  const picker=find('.office-header .production-picker');
  if(picker)picker.hidden=['availability','reports'].includes(view);
  for(const button of app.querySelectorAll('[data-main-tab]'))button.setAttribute('aria-current',button.dataset.mainTab===view?'page':'false');
  if(view==='availability')openAvailability(find('[data-main-filming] [data-availability-slot]'));
  else if(view==='reports')openReports(find('[data-main-reports] [data-reports-slot]'));
  else{
   for(const child of offices.values())child.show(view);
   if(view==='people'&&film)offices.get(film.id)?.open(film,false);
  }
  syncRoute();
 }
 function openPerson(person,filmId=null,section=''){
  if(!person)return;
  editor={key:person.key,filmId:filmId||(!person.hasMemberProfile?person.films[0]?.id:null)};
  renderEditor();
  show('people');
  const child=editor.filmId&&offices.get(editor.filmId);
  const target=child?.sectionTarget(section)||personEditor.querySelector('h2');
  target?.scrollIntoView({block:'start'});
  target?.focus({preventScroll:true});
 }
 function refreshRows(next){
  if(next){snapshots.set(next.productionId,next);pendingState=next;}
  people=combinedPeople([...snapshots.values()].map(state=>({...state,unassignedProfiles:pendingState.unassignedProfiles})));
  renderDirectory();
  renderInbox();
  if(editor){
   const previousFilm=editor.filmId;
   renderEditor();
   if(activeView==='people'&&(!editor||editor.filmId!==previousFilm))show('people');
  }
  if(next)renderAssignments(next);
 }
 const bulk=mountBulkActions(find('[data-bulk-actions]'),{
  getPeople:()=>people,
  getProductions:()=>pendingState.productionChoices||pendingState.productions,
  canSend:()=>pendingState.mailReady,
  canPrepare:pid=>!!snapshots.get(pid)?.agreementReady,
  resend:({id,email})=>request('resend',{expectedEmail:email},id),
  openPreparation:({id,productionId})=>openPerson(matchingMember(id),productionId,'prepare'),
  onQueued:()=>combined.refresh(),
  canOpen:canNavigate
 });
 combined={
  show,
  busy:()=>bulk.busy()||[...offices.values()].some(child=>child.busy()),
  async refresh(){await Promise.all([...offices.values()].map(child=>child.refresh()));}
 };
 for(const state of states){
  const section=document.createElement('section');
  section.className='production-workspace';
  section.innerHTML='<h2>'+escape(state.film)+'</h2><div></div>';
  find('[data-offices]').append(section);
  const child=startPortal(section.lastElementChild,{id:state.productionId,state,section,first:state===states[0],show,
   openPerson(id,area){if(canNavigate())openPerson(matchingMember(id),state.productionId,area);},
   openCatalog(id){
    const person=people.find(row=>row.films.some(film=>film.id===state.productionId&&film.target==='profile'&&film.profileId===id));
    if(canNavigate())openPerson(person,state.productionId);
   },
   update:refreshRows,
   changed(){for(const [id,other] of offices)if(id!==state.productionId)other.refresh();}});
  offices.set(state.productionId,child);
 }
 function canNavigate(){
  if(combined.busy()||availabilityBusy()){message.textContent='Finish the open signing or availability action before leaving.';return false;}
  const changes=dirty();
  if(changes.length&&!confirm('Discard unsaved changes?'))return false;
  for(const form of changes){form.reset();delete form.dataset.dirty;}
  return true;
 }
 listen('click',event=>{
  const b=event.target.closest('[data-main-tab],[data-person-index],[data-open-setup-profile],[data-person-film],[data-back-directory],[data-inbox-person],[data-inbox-review],[data-inbox-view]');
  if(!b||!canNavigate())return;
  if(b.dataset.mainTab){show(b.dataset.mainTab);return;}
  if(b.hasAttribute('data-back-directory')){
   const index=people.findIndex(person=>person.key===editor?.key);
   editor=null;renderEditor();show('people');
   const row=find('[data-person-index="'+index+'"]');
   (row&&!row.closest('[hidden]')?row:find('[data-roster-search]'))?.focus();
   return;
  }
  if(b.hasAttribute('data-person-film')){
   openPerson(people.find(person=>person.key===editor?.key),b.dataset.personFilm);return;
  }
  if(b.dataset.inboxReview){
   const id=b.dataset.inboxReview,film=b.dataset.inboxFilm,person=matchingMember(id);
   if(person?.films.some(item=>item.id===film&&item.target==='person'))openPerson(person,film,'review');
   else{show('settings');offices.get(film)?.review(id);}
   return;
  }
  if(b.dataset.inboxPerson){
   const area=b.dataset.inboxArea;
   openPerson(matchingMember(b.dataset.inboxPerson),area==='shared'?null:b.dataset.inboxFilm,area);
   return;
  }
  if(b.dataset.inboxView){show(b.dataset.inboxView);offices.get(b.dataset.inboxFilm)?.sectionTarget('')?.scrollIntoView({block:'start'});return;}
  if(b.dataset.openSetupProfile){openPerson(matchingMember(b.dataset.openSetupProfile));return;}
  openPerson(people[Number(b.dataset.personIndex)]);
 });
 listen('input',event=>{
  if(!event.target.matches('[data-roster-search]'))return;
  search=event.target.value;sessionStorage.setItem('hmf-directory-search',search);applyDirectoryFilter();
 });
 listen('change',event=>{
  if(!event.target.matches('[data-roster-filter]'))return;
  filter=event.target.value;applyDirectoryFilter();syncRoute();
 });
 refreshRows();
 renderAssignments(states[0]);
 const requestedMember=matchingMember(routeParams.get('person'));
 const requestedProfile=people.find(person=>person.films.some(film=>film.profileId===routeParams.get('profile')&&film.target==='profile'));
 if(requestedMember||requestedProfile)openPerson(requestedMember||requestedProfile,routeParams.get('editFilm')||routeParams.get('production'));
 else{
  show(activeView);
  const pending=routeParams.get('pending');
  if(pending){const card=[...app.querySelectorAll('[data-pending-person]')].find(node=>node.dataset.pendingPerson===pending);if(card){card.open=true;card.scrollIntoView({block:'start'});}}
 }
}

async function load(initial){
 if(combined||availabilityBusy()||reportsBusy())return;
 clearSigning();
 const savedForms=dirty().map(f=>({action:f.dataset.action,id:f.dataset.id,node:f}));
 const openDetails=[...app.querySelectorAll('details[open]')].map(detailKey);
 if(resetTicket&&location.hash){app.innerHTML='<section><h2>Reset your password</h2>'+form('resetPassword',newPassword,'Save new password')+'</section>';return;}
 if(ticket&&location.hash){app.innerHTML='<section><h2>Set up your cast &amp; crew account</h2><p>Choose a password now. The next time you sign in, use the email address that received this invitation.</p>'+form('activate',newPassword,'Create my account')+'<p>If the link expired or was replaced, open the newest invitation or ask production to resend it.</p></section>';return;}
 let s;try{s=initial||await request('home');}catch(e){if(e.status===401){if(office)return location.reload();return login();}throw e;}
 if(availabilityBusy())return;
 clearAvailability();
 if(office&&!s.admin){location.reload();return;}
 s=orderAdminPeople(s);
 lastState=s;let admin=s.admin;
 app.classList.toggle('member-workspace',!admin);
 selectedProduction=s.productionId;
 const params=new URLSearchParams(location.search);
 const requested=params.getAll('films');
 const selected=s.productions.filter(p=>requested.includes(p.id)).map(p=>p.id);
 if(office)selected.splice(0,selected.length,office.id);
 else if(!requested.length){
  if(params.has('production'))selected.push(s.productionId);
  else if(admin)selected.push(...s.productions.map(p=>p.id));
 }
 const productionPicker=admin?adminProductionPicker(s.productions,selected):s.productions.length>1?'<label class="production-picker">Production<select data-production>'+s.productions.map(p=>'<option value="'+escape(p.id)+'" '+(p.id===s.productionId?'selected':'')+'>'+escape(p.name)+'</option>').join('')+'</select></label>':s.productions.length?'<p class="member-production">'+escape(s.productions[0].name)+'</p>':'';
 if(admin&&!office){
  document.querySelector('main > h1').textContent='Admin dashboard';
  document.querySelector('main > small').hidden=true;
 }
 if(admin&&!selected.length){
  app.innerHTML='<div class="office-header">'+productionPicker+form('logout','','Sign out')+'</div><h2>People &amp; profiles <span class="count">0</span></h2><p>Select a production to see its cast and crew.</p>';
  return;
 }
 if(admin&&!office){
  const states=await Promise.all(selected.map(id=>id===s.productionId?s:request('home',undefined,'','',id)));
  renderCombinedOffice(states.map(orderAdminPeople),productionPicker);
  return;
 }
 const reviewCard=r=>panel(escape(r.name)+' · Approval needed','<p>'+escape(r.bio||'No biography submitted')+'</p>'+(r.photo?'<img alt="Headshot submitted for approval" style="width:8rem;max-width:100%" src="'+escape(r.photo==='uploaded'?url('photo',r.id)+'&v='+r.revision:r.photo)+'">':'<p>No headshot submitted</p>')+'<form data-action="reviewProduction" data-id="'+escape(r.id)+'"><input type="hidden" name="requestId" value="'+escape(r.requestId)+'"><input type="hidden" name="revision" value="'+escape(r.revision)+'">'+creditFields(r.credits)+(r.role?'<p>Current credit · '+escape(r.role)+'</p>':'')+'<button value="approve">Approve for '+escape(s.film)+'</button> <button formnovalidate value="decline">Decline</button></form>');
 const reviews=(s.productionReviews||[]).map(reviewCard).join('');
 const library=s.catalog||[];
 const available=library.filter(x=>!s.members.some(m=>m.filmProfile===x.id));
 const offline=x=>x.previousOffline?panel('Previous paper agreement · replaced','<p>A new electronic agreement is required.</p><a href="'+escape(url('offline',x.id))+'">Download previous paper agreement</a>'):'';
 const uploaded=library.filter(x=>x.previousOffline);
 const previousOnline=s.members.filter(m=>m.previousAgreement?.completed);
 const previousDocuments=sortPeople([...uploaded.map(x=>({name:x.name,html:panel(escape(x.name),offline(x))})),...previousOnline.map(m=>({name:m.name,html:'<p>'+escape(m.name)+' · <a href="'+escape(url('memberDocument',m.id)+'&kind=previous-signed')+'">Download previous signed agreement and audit record</a></p>'}))]);
 const uploadedDocuments=admin&&previousDocuments.length?'<section><h2>Previous agreements</h2><p>These records have been replaced for portal tracking. Everyone requires a new signed agreement.</p>'+previousDocuments.map(document=>document.html).join('')+'</section>':'';
 const people=sortPeople([...available,...s.members]);
 function outstanding(person){
  const source=library.find(x=>x.id===(person.filmProfile||person.id));
  const status=person.paperworkStatus||source?.offline||person.agreement?.status||'No agreement on file';
  const gaps=[];
  if(!(person.profile?.bio??source?.bio)?.trim())gaps.push('Bio');
  if(!(person.hasPhoto||person.referencePhoto||source?.photo))gaps.push('Headshot');
  if(person.tasks?.some(t=>!t.done))gaps.push('Open tasks');
  const exempt=false;
  return {name:person.name,id:person.id,member:s.members.some(member=>member.id===person.id),status,gaps,exempt};
 }
 const audit=people.map(outstanding);
 const group=(label,items,detail)=>'<details class="audit-group"><summary>'+label+' <b>'+items.length+'</b></summary>'+
  (items.length?'<ul>'+sortPeople(items).map(row=>'<li><button type="button" '+(row.member?'data-open-person':'data-open-catalog')+'="'+escape(row.id)+'">'+escape(row.name)+'</button><span>'+escape(detail(row))+'</span></li>').join('')+'</ul>':'<p>Nothing outstanding.</p>')+'</details>';
 const attention='<section class="audit"><p><strong>New contracts are required unless an admin marks the requirement Complete or Document N/A.</strong> Earlier agreements remain in Previous agreements.</p><small>'+escape(s.film)+' · PRODUCTION OFFICE</small><h2>Needs attention</h2><p>Open a category to see who needs follow-up.</p>'+group('No agreement on file',audit.filter(x=>!x.exempt&&x.status==='No agreement on file'),x=>x.status)+group('Paperwork in progress',audit.filter(x=>(!x.exempt||/waiting on Heidi/i.test(x.status))&&!['Complete','Document N/A','Not required','No agreement on file'].includes(x.status)),x=>x.status)+group('Missing profile items or open tasks',audit.filter(x=>x.gaps.length),x=>x.gaps.join(' · '))+'</section>';
 const catalogCard=profile=>'<section class="catalog-editor"><h3>Website profile</h3>'+
  (profile.photo?'<img loading="lazy" alt="Approved headshot" src="'+escape(profile.photo)+'">':'')+
  '<p>'+escape(profile.role)+'</p><p class="profile-bio">'+escape(profile.bio)+'</p>'+offline(profile)+
  (s.mailReady?form('invite',input('email','Invitation email','email')+['name','role','filmProfile'].map((key,i)=>'<input type="hidden" name="'+key+'" value="'+escape([profile.name,profile.role,profile.id][i])+'">').join(''),'Invite '+escape(profile.name)):'')+'</section>';
 const linkControls=m=>m.practice?'':m.filmProfile?'<p>Approved biography and headshot appear on the assigned film websites.</p>':panel('Link an existing film profile',form('linkProfile','<label>Approved profile<select name="filmProfile" required><option value="">Select person</option>'+available.map(x=>'<option value="'+escape(x.id)+'" '+(x.name===m.name?'selected':'')+'>'+escape(x.name)+'</option>').join('')+'</select></label>','Confirm profile match',m.id));
 const audience='<fieldset><legend>Who should receive this?</legend><select name="audience" aria-label="Audience"><option value="all">Include all cast and crew</option><option value="selected">Select individuals</option></select><div data-recipients hidden>'+s.members.map(m=>'<label><input type="checkbox" style="width:auto;display:inline" name="recipient" value="'+escape(m.id)+'"> '+escape(m.name)+' · '+escape(m.role)+'</label>').join('')+'<small>Choose from the portal roster.</small></div></fieldset>';
 const setup=panel('Welcome video',form('welcomeSettings','<label>Direct video URL (MP4)<input type="url" name="video" value="'+escape(s.welcome?.video)+'"></label><label>Thumbnail URL (optional)<input type="url" name="poster" value="'+escape(s.welcome?.poster)+'"></label><label>English captions URL (.vtt)<input type="url" name="captions" value="'+escape(s.welcome?.captions)+'"></label>','Save welcome video'))+
 panel('Post a message',form('notice',audience+input('title','Subject')+'<label>Message<textarea required name="text"></textarea></label>','Post message'))+
 panel('Share a script or call sheet',form('resource',audience+input('title','Title and revision date')+file('Production PDF · up to 4 MB','application/pdf'),'Post file'))+
 (s.agreementSupported?panel('Agreement setup',form('master','<p>'+(s.agreementReady?'Approved master installed.':'Install the approved master before previewing or sending.')+'</p>'+file('Approved '+s.film+' contract master','application/pdf'),'Install agreement master')):'<p>Actor agreement sending for this production needs its own approved template.</p>');
 function tasks(m){return (m.tasks||[]).map(t=>'<div><strong>'+escape(t.title)+'</strong> '+(t.done?'Completed':form('finishTask','<input type="hidden" name="task" value="'+escape(t.id)+'">','Mark complete',m.id))+'</div>').join('');}
 function memberView(m){
  const assigned=!!m.productions[s.productionId];
  const choices=m.practice?'':form('requestProductions','<fieldset class="member-productions"><legend>Productions</legend>'+s.productionChoices.map(p=>{
   const assigned=m.productions[p.id],pending=!!m.productionRequests?.[p.id];
   const selected=!!assigned||pending;
   return '<fieldset><label><input type="checkbox" name="selection" value="'+escape(p.id)+'" '+(selected?'checked ':'')+(assigned?'disabled':'')+'> '+escape(p.name)+(pending?' · Awaiting review':assigned?' · Assigned':'')+'</label><div data-credit-fields '+(selected?'':'hidden')+'>'+creditFields(m.proposedCredits?.[p.id]||assigned,'_'+p.id)+(assigned?.role?'<p>Current credit · '+escape(assigned.role)+'</p>':'')+'</div></fieldset>';
  }).join('')+'</fieldset>','Save productions and credits');

  const download=(href,title)=>'<li><a href="'+escape(href)+'">'+escape(title)+'</a></li>';
  const documents=(m.documents||[]).map(d=>{
   const params=new URLSearchParams({kind:d.kind});
   if(d.version)params.set('version',d.version);
   return download(url('memberDocument',m.id)+'&'+params,d.title);
  });
  for(const file of s.resources.filter(r=>r.type==='PDF'))documents.push(download(url('resource',file.id),file.title+(trackingLabel(m.documentTracking?.[file.id])?' · '+trackingLabel(m.documentTracking[file.id]):'')));
  let agreementControls='';
  if(m.productions[s.productionId]){
   if(m.paperworkTracking)agreementControls='<p>Agreement requirement · '+escape(trackingLabel(m.paperworkTracking.reason))+'</p>';
   if(m.agreement?.id&&!m.agreement.cleared){
    const status=m.agreement.status;
    agreementControls+='<p>Signing request · <strong data-signing-status>'+escape(signingLabel(status,true))+'</strong></p>';
    if(status==='Waiting on actor')agreementControls+='<button data-status="'+escape(m.id)+'">Review and sign my agreement</button>';
   }else if(!m.paperworkTracking){
    agreementControls='<p>A new agreement is required for '+escape(s.film)+'. Production will prepare your signing request.</p>';
   }
  }
  const items=m.tasks||[],openTasks=items.filter(task=>!task.done),completed=items.filter(task=>task.done);
  const count=openTasks.length;
  const taskList=openTasks.map(task=>'<div class="task-row"><strong>'+escape(task.title)+'</strong>'+
   form('finishTask','<input type="hidden" name="task" value="'+escape(task.id)+'">','Mark complete',m.id)+'</div>').join('');
  const photo=m.hasPhoto?url('photo',m.id):m.referencePhoto;
  const needsSignature=assigned&&m.agreement?.status==='Waiting on actor';
  const profileGaps=[!m.profile?.bio?.trim()?'biography':'',!photo?'headshot':''].filter(Boolean);
  const attention='<section class="member-panel member-tasks"><h2>Needs your attention</h2>'+
   (needsSignature?'<p>Your agreement is ready to sign.</p>'+memberButton('documents','Review agreement'):'')+
   (count?'<p>'+count+' open '+(count===1?'task':'tasks')+'</p>':'')+
   (!count&&!needsSignature?'<p>You’re caught up.</p>':'')+taskList+
   (completed.length?panel('Completed tasks ('+completed.length+')','<ul>'+completed.map(task=>'<li>'+escape(task.title)+'</li>').join('')+'</ul>'):'')+'</section>';
  const home='<div data-member-view="home"><h2>Welcome, '+escape(m.name)+'</h2>'+attention+
   '<div class="member-home-grid"><section><h3>Next event</h3><p data-member-next-event>Loading events…</p>'+memberButton('events','View events')+'</section>'+
   '<section><h3>Availability</h3><p>Share when you can be on set.</p>'+memberButton('availability','Update availability')+'</section>'+
   (profileGaps.length?'<section><h3>My profile</h3><p>Add your '+escape(profileGaps.join(' and '))+'.</p>'+memberButton('profile','Open profile')+'</section>':'')+
   '</div></div>';
  const profilePane='<section class="member-panel member-profile" data-member-view="profile"><h2>'+(assigned?'My profile':'Set up your profile')+'</h2>'+
   (!assigned&&!m.practice?'<p>Choose your productions and save your credits. The character, crew title, bio, and headshot are optional. Production will review your selection.</p>':'')+
   '<div class="member-publishing"><h3>Website status</h3><div data-member-publication>'+memberPublishing(m,s.productionChoices)+'</div></div>'+
   choices+'<p><strong>'+escape(m.name)+'</strong>'+(m.role?' · '+escape(m.role):'')+'</p>'+
   '<p>Your biography and headshot are shared across your approved productions.</p>'+
   (photo?'<img data-headshot src="'+escape(photo)+'" alt="Your headshot">':'')+
   form('photo',file(m.hasPhoto?'Replace your headshot (JPG or PNG)':'Upload a headshot (JPG or PNG)','image/jpeg,image/png'),'Save headshot',m.id)+
   form('bio','<label>My biography<textarea name="bio" rows="5" maxlength="5000">'+escape(m.profile?.bio)+'</textarea></label><label>Import biography (.txt)<input type="file" accept=".txt,text/plain" data-bio-file></label>','Save biography',m.id)+'</section>';
  const documentsPane=assigned||documents.length?'<section class="member-panel member-paperwork" data-member-view="documents"><h2>My documents</h2>'+agreementControls+
   (documents.length?'<ul>'+documents.join('')+'</ul>':(agreementControls?'':'<p>No documents assigned yet.</p>'))+'<div id="signing" data-signing></div></section>':'';
  const availabilityPane='<section class="member-panel member-availability" data-member-view="availability"><h2>My availability</h2><p>Share your earliest arrival and latest departure with cast and crew of '+escape(s.film)+'.</p><div data-availability-slot></div></section>';
  const eventsPane='<div data-member-view="events"><h2>Events &amp; updates</h2><div id="calendar-slot"></div><section class="member-panel member-board"><h3>Production board</h3>'+(updates||'<p>No updates posted yet.</p>')+'</section></div>';
  const tabs=memberViews.filter(([view])=>assigned||view==='profile'||view==='documents'&&documentsPane);
  return '<nav class="office-nav member-nav" aria-label="Member dashboard">'+tabs.map(([view,label])=>memberButton(view,label)).join('')+'</nav>'+
   (assigned?home:'')+profilePane+documentsPane+(assigned?availabilityPane+eventsPane:'');
 }
 const publication=m=>'<div class="publication-status"><h4>Website publishing</h4>'+Object.entries(m.publication||{}).map(([pid,p])=>'<p>'+escape(s.productions.find(x=>x.id===pid)?.name||pid)+' · <strong>'+escape(p.state)+'</strong></p>').join('')+(m.practice?'':form('publication','<label><input type="checkbox" name="visible" '+(m.publication?.[s.productionId]?.visible?'checked':'')+'> Show on this production’s website</label>','Save website visibility',m.id))+'</div>';
 const recover=m=>m.agreement&&!m.agreement.id&&!m.agreement.cleared?panel('Recover interrupted signing request','<p>Check SignWell first. Link the existing document below, or confirm that no document was created. This action never sends a contract.</p>'+form('recoverAgreement','<label>Existing SignWell document ID (if found)<input name="documentId"></label><label><input type="checkbox" name="confirmAbsent"> I checked SignWell; no document exists</label>','Recover request',m.id)):'';
 function documentControls(m,document,reason){
  return '<form data-action="trackPaperwork" data-id="'+escape(m.id)+'"><input type="hidden" name="document" value="'+escape(document)+'"><button value="complete"'+(['complete','hard-copy'].includes(reason)?' disabled':'')+'>Complete</button> <button value="not-required"'+(reason==='not-required'?' disabled':'')+'>Document N/A</button>'+(reason?' <button value="reopen">Reopen requirement</button>':'')+'</form>';
 }
 function trackDocument(m,d){
  const done=m.documentTracking?.[d.id];
  return panel(escape(d.title)+(done?' · '+trackingLabel(done):''),'<p><a href="'+escape(url('resource',d.id))+'">Download PDF</a></p><p>'+(done?escape(trackingLabel(done)+' · '+recordedDetails(m.documentTrackingDetails?.[d.id])):'Pending document requirement.')+'</p>'+documentControls(m,d.id,done));
 }
 function personPaperwork(m){
  const tracked=m.paperworkTracking,actual=m.agreement?.cleared?null:m.agreement?.status;
  const downloads=(m.documents||[]).map(d=>'<li><a href="'+escape(url('memberDocument',m.id)+'&'+new URLSearchParams({kind:d.kind,...(d.version?{version:d.version}:{})}))+'">'+escape(d.title)+'</a></li>').join('');
  const draft=m.agreement?.id&&actual==='Draft ready to send'&&!tracked&&!m.needsEmail?form('sendAgreement','<input type="hidden" name="documentId" value="'+escape(m.agreement.id)+'"><p>Send this prepared contract to '+escape(m.name)+'.</p>','Send pending contract',m.id):'';
  const requirement=tracked?'<p>Agreement requirement · <strong>'+escape(trackingLabel(tracked.reason))+'</strong> · '+escape(recordedDetails(tracked))+'</p>':'';
  const signing='<p>Signing request · <strong data-signing-status>'+escape(signingLabel(actual))+'</strong></p>';
  const review=m.agreement?.id&&actual&&actual!=='Complete'?'<button data-status="'+escape(m.id)+'">'+(actual==='Waiting on Heidi'?'Open for Heidi’s signature':'Check signing request status')+'</button>':'';
  return '<section class="member-paperwork"><h4>Documents &amp; agreements</h4>'+requirement+signing+review+'<p>Use Complete for paperwork handled outside the portal, or Document N/A when it is not needed. An existing SignWell request stays active.</p>'+documentControls(m,'agreement',tracked?.reason)+(tracked?'<p>Reopen the requirement to prepare or send a new contract.</p>':'')+draft+(!tracked&&s.agreementReady&&(!m.agreement||m.agreement.cleared)?agreement(m):'')+recover(m)+(m.agreement?.syncError?'<p>'+escape(m.agreement.syncError)+'</p>':'')+(downloads?'<h5>Saved agreements</h5><ul>'+downloads+'</ul>':'')+s.resources.filter(d=>d.type==='PDF'&&(!d.audience||d.audience.includes(m.id))).map(d=>trackDocument(m,d)).join('')+'<div data-signing></div></section>';
 }
 const personalReview=m=>(s.productionReviews||[]).filter(r=>r.id===m.id).map(reviewCard).join('');
 const personalMessage=m=>panel(m.needsEmail?'Save a message for this person':'Send a message',form('notice','<p>For '+escape(m.name)+' · '+escape(s.film)+'</p><input type="hidden" name="audience" value="selected"><input type="hidden" name="recipient" value="'+escape(m.id)+'">'+input('title','Subject')+'<label>Message<textarea required name="text"></textarea></label>',m.needsEmail?'Save message':'Send to '+escape(m.name),m.id));
 function filmPersonCard(member){
  const documentFields='<p>For '+escape(member.name)+' · '+escape(s.film)+'</p>'+
   '<input type="hidden" name="audience" value="selected"><input type="hidden" name="recipient" value="'+escape(member.id)+'">'+input('title','Document title')+file('PDF · up to 4 MB','application/pdf');
  const availability='<details data-availability-panel data-availability-person="'+escape(member.id)+'"><summary>Availability calendar</summary><div data-availability-slot></div></details>';
  const assignment=member.productions[s.productionId];
  const credits=[assignment?.character&&'Character · '+assignment.character,assignment?.crewTitle&&'Crew title · '+assignment.crewTitle].filter(Boolean);
  const heading='<p class="film-credits">'+escape(credits.join(' / ')||member.role||'Credits not entered')+'</p>';
  const activity=profileActivityPanel(member,s.productionId);
  return '<div class="film-person-card" data-person="'+escape(member.id)+'">'+heading+personalReview(member)+personPaperwork(member)+
   availability+panel(member.needsEmail?'Save a document for this person':'Send a document',form('resource',documentFields,member.needsEmail?'Save document':'Send to '+escape(member.name),member.id))+
   personalMessage(member)+tasks(member)+(member.filmProfile&&library.find(x=>x.id===member.filmProfile)?offline(library.find(x=>x.id===member.filmProfile)):'')+linkControls(member)+
   panel('Assign a task',form('task',input('title','Task')+'','Assign task',member.id))+publication(member)+activity+'</div>';
 }
 renderOfficePerson=film=>{
  if(film.target==='person'){
   const member=s.members.find(row=>row.id===film.profileId);
   return member?filmPersonCard(member):'<p>This account is no longer assigned to this production.</p>';
  }
  const profile=available.find(row=>row.id===film.profileId);
  return profile?catalogCard(profile):'<p>This website profile is now linked. Return to People to open the account.</p>';
 };
 const account=s.passwordSet?'':'<section><h2>Set your password</h2><p>Your sign-in name is <strong>'+escape(admin?s.self:s.members[0].email)+'</strong>.</p>'+form('choosePassword',newPassword,'Save my password')+'</section>';
 const updates=s.resources.map(r=>'<section><small>'+escape(new Date(r.created).toLocaleDateString())+' · '+escape(r.type)+'</small><h3>'+escape(r.title)+'</h3>'+(r.type==='PDF'?'<a href="'+escape(url('resource',r.id))+'">Download PDF</a>':'<p>'+escape(r.text)+'</p>')+(admin?form('removeResource','',r.type==='PDF'?'Remove file':'Remove message',r.id):'')+'</section>').join('');
 const counts='<div class="metrics"><div><b>'+people.length+'</b><span>Production roster</span></div><div><b>'+s.members.filter(m=>!m.needsEmail).length+'</b><span>Portal accounts</span></div><div><b>'+s.members.filter(m=>!m.needsEmail&&m.activated).length+'</b><span>Activated accounts</span></div><div><b>'+s.members.filter(m=>!m.needsEmail&&!outstanding(m).gaps.some(x=>['Bio','Headshot'].includes(x))).length+'</b><span>Complete account profiles</span></div></div>';
 const mailRows=[...(s.mailQueue||[]).map(x=>({...x,status:x.lastError?'Retry scheduled':'Queued'})),...(s.mailLog||[])];
 const mailPanel='<section><h2>Email delivery</h2><p>Provider acceptance is not proof of inbox delivery. Delivery updates appear when available.</p>'+(s.mailTracking?'<p><strong>Delivery updates are switched off at Resend.</strong> Email is still being sent, but Resend refuses this site’s requests to look up what happened to each message (HTTP '+escape(s.mailTracking.status)+'). This usually means the API key is limited to sending. Replace RESEND_API_KEY in Netlify with a full-access key to see delivered and bounced statuses here.</p>':'')+(mailRows.length?'<div class="table-scroll"><table><thead><tr><th>Recipient</th><th>Subject</th><th>Status</th></tr></thead><tbody>'+mailRows.map(x=>'<tr><td>'+escape(x.to)+'</td><td>'+escape(x.subject)+'</td><td>'+escape(x.status)+(x.lastError||x.error?'<br>'+escape(x.lastError||x.error):'')+'</td></tr>').join('')+'</tbody></table></div>':'<p>No email activity recorded yet.</p>')+'</section>';
 clearSigning();
 if(admin){
  app.innerHTML='<div class="office-layout"><div class="office-main">'+
   '<div data-view="overview">'+counts+attention+'</div>'+
   '<div data-view="people" data-film-person></div>'+
   '<div data-view="documents"><h3>Paperwork</h3><p>'+(s.test?'Signing is in test mode.':'Live signing is enabled.')+'</p>'+uploadedDocuments+
   '<ul class="people-directory document-list">'+s.members.map(m=>'<li class="directory-row"><strong>'+escape(m.name)+'</strong><span>'+escape(paperworkSummary(m))+'</span><button data-open-person="'+escape(m.id)+'">Open paperwork</button></li>').join('')+'</ul><div data-tool-zone="documents"></div></div>'+
   '<div data-view="messages"><h3>Messages &amp; files</h3><div data-tool-zone="messages"></div>'+(office.first?mailPanel:'')+'<h3>Production board</h3>'+updates+'</div>'+
   '<div data-view="calendar"><p>Upcoming events from Outlook. Use the production categories in Outlook to share events with members.</p></div>'+
   '<div data-view="settings">'+(reviews?'<section data-review-list><h3>Review profiles for publication</h3>'+reviews+'</section>':'')+
   panel('Revoked portal accounts',s.revokedAccounts?.length?s.revokedAccounts.filter(m=>m.productions[s.productionId]).map(m=>'<section><h3>'+escape(m.name)+'</h3><p>Portal access revoked. Public profile '+(m.keepPublic?'retained':'removed')+'.</p>'+form('publication','<label><input type="checkbox" name="visible" '+(m.keepPublic&&m.publication[s.productionId]!==false?'checked':'')+'> Show on this production website</label>','Save website visibility',m.id)+'</section>').join(''):'<p>No revoked accounts.</p>')+
   '<div data-tool-zone="settings"></div></div></div>'+(office.first?'<div id="calendar-slot"></div>':'')+'</div>';
  const staging=document.createElement('div');
  staging.innerHTML=setup;
  for(const tool of [...staging.children]){
   const action=tool.querySelector('form')?.dataset.action;
   const zone=['notice','resource'].includes(action)?'messages':action==='master'?'documents':'settings';
   app.querySelector('[data-tool-zone="'+zone+'"]').append(tool);
  }
  applyView();syncOffice();
 }
 if(!admin){
  app.innerHTML='<div class="member-header">'+productionPicker+form('logout','','Sign out')+'</div>'+account+s.members.map(memberView).join('');
  showMemberView(memberViewName||(params.has('event')?'events':params.get('memberView'))||'home');
  if(app.querySelector('#calendar-slot'))mountCalendar(false);
 }
 if(!admin&&s.welcome?.video&&app.querySelector('[data-member-view="home"]')){
  const section=document.createElement('section');section.className='member-panel';section.innerHTML='<small>CAST &amp; CREW ORIENTATION</small><h2>Welcome to Heidi Mikac Films</h2><div style="background:linear-gradient(125deg,#492430,#15161a);padding:16px"><video controls playsinline preload="metadata" style="width:100%;display:none"></video><button type="button">▶ Play welcome video</button></div><p data-audio hidden>Sound is off. Use the speaker control to hear Heidi and Nick.</p>';
  app.querySelector('[data-member-view="home"]')?.append(section);
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
 }
 for(const m of s.members){
  const photo=app.querySelector('form[data-action="photo"][data-id="'+m.id+'"]'), bio=app.querySelector('form[data-action="bio"][data-id="'+m.id+'"]');
  if(photo&&m.hasPhoto)profileStatus(photo,m.photoName?'Saved · '+m.photoName:'Headshot saved');
  if(bio&&m.profile)profileStatus(bio,'Saved');
 }
 for(const saved of savedForms){const replacement=[...app.querySelectorAll('form')].find(f=>f.dataset.action===saved.action&&f.dataset.id===saved.id);if(replacement)replacement.replaceWith(saved.node);}
 for(const d of app.querySelectorAll('details'))if(openDetails.includes(detailKey(d)))d.open=true;

 if(office){office.update(s);syncOffice();}

}
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
  if(activeView!=='overview')params.set('view',activeView);
  const filter=new URLSearchParams(location.search).get('filter');
  if(filter)params.set('filter',filter);
  for(const f of dirty())delete f.dataset.dirty;
  location.assign(location.pathname+'?'+params);
  return;
 }
 if(e.target.name==='selection')e.target.closest('fieldset').querySelector('[data-credit-fields]').hidden=!e.target.checked;
 if(e.target.type==='file'&&e.target.form?.dataset.action==='photo'){
  const form=e.target.form;
  selectHeadshot(form).catch(error=>profileStatus(form,error.message,true));
 }
 if(e.target.matches('[data-bio-file]')&&e.target.files?.[0]){
  const field=e.target.form.elements.bio;
  e.target.files[0].text().then(value=>{if(value.length>5000)throw Error('Biography limit is 5,000 characters.');field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));}).catch(error=>{message.textContent=error.message;});
 }
 if(e.target.name==='audience')e.target.form.querySelector('[data-recipients]').hidden=e.target.value!=='selected';
 if(e.target.matches('form[data-action="enrollments"] input[name="production"]')){
  e.target.closest('fieldset').querySelector('[data-assignment-credit-fields]').hidden=!e.target.checked;
 }
 if(e.target.matches('[data-production]')){
  if((dirty().length||availabilityBusy())&&!confirm('You have unsaved changes. Switch productions and discard them?')){e.target.value=selectedProduction;return;}
  clearAvailability();
  selectedProduction=e.target.value;
  const params=new URLSearchParams(location.search);
  params.set('production',selectedProduction);
  params.delete('event');
  if(memberViewName)params.set('memberView',memberViewName);
  history.replaceState(null,'',location.pathname+'?'+params);
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
 const photoInputs=a==='photo'?[...f.querySelectorAll('input,select')].filter(control=>!control.disabled):[];
 for(const control of photoInputs)control.disabled=true;
 try{
  if(a==='logout'){
   try{await request('logout',{});}catch(error){if(error.status!==401)throw error;}
   sessionStorage.removeItem('hmf-directory-search');
   login();
   message.textContent='Signed out.';
   location.replace(location.pathname);
   return;
  }
  const selectedPhoto=a==='photo'?data.file:null;
  if(selectedPhoto)data.file=await prepareHeadshot(f,selectedPhoto);
  if(data.file&&data.file.size>4*1024*1024)throw Error('Choose a file up to 4 MB.');
  if(a==='agreement'&&button.value==='credits'){
   const film=lastState.film;
   const result=await request('saveProductionCredits',{character:data.character,crewTitle:data.crewTitle,expectedCredit:data.expectedCredit},id);
   f.querySelector('[data-current-credit]').textContent=result.role||'None';
   if(result.creditSnapshot)f.elements.expectedCredit.value=result.creditSnapshot;
   await load();
   office?.changed();
   message.textContent='Credits saved for '+film+'.';
   return;
  }
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
  if(a==='enrollments'){
   data.productions=new FormData(f).getAll('production');
   data.credits=Object.fromEntries(data.productions.map(id=>[id,{character:data['character_'+id],crewTitle:data['crewTitle_'+id]}]));
   data.expectedAssignments=JSON.parse(data.expectedAssignments);
  }
  if(a==='savePendingPerson')data.productions=new FormData(f).getAll('pendingProduction');
  const targetParams=new URLSearchParams({title:data.title||''});
  if(data.audience){data.recipients=new FormData(f).getAll('recipient');if(data.audience==='selected'&&!data.recipients.length)throw Error('Select at least one recipient.');targetParams.set('audience',data.audience);for(const who of data.recipients)targetParams.append('recipient',who);}
  const actionProduction=(a==='adminTask'?data.actionProduction:f.dataset.production)||selectedProduction;
  const result=await request(a,data.file||data,id,a==='offline'?'&'+new URLSearchParams({status:data.status}):a==='photo'?'&'+new URLSearchParams({filename:data.file.name}):data.title&&data.file?'&'+targetParams:'',actionProduction);
  if(a==='agreement'&&data.preview){
   const href=URL.createObjectURL(result),link=document.createElement('a');
   link.href=href;
   link.download='Agreement-preview.pdf';
   link.click();
   setTimeout(()=>URL.revokeObjectURL(href),60000);
   message.textContent='Agreement preview ready.';
   return;
  }
  delete f.dataset.dirty;
  if(a==='savePendingPerson'&&!id)f.reset();
  if(office&&!data.preview)office.changed();
  if(combined&&a==='choosePassword'){location.reload();return;}
  if(combined&&['enrollments','savePendingPerson','removePendingPerson','invite','resend','revoke','adminTask','finishAdminTask'].includes(a))await combined.refresh();
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
   if(a==='photo'&&f.elements.file.files[0]===selectedPhoto){
    clearHeadshotPreview(f);
    f.elements.file.value='';
    profileStatus(f,'Saved · '+data.file.name);
   }
   if(a==='bio')profileStatus(f,f.elements.bio.value===data.bio?'Saved':'Unsaved changes');
   message.textContent=(a==='photo'?'Headshot saved.':'Bio saved.')+' An admin reviews updates for each selected film.';
   const publicationInfo=await request('home').catch(()=>null);
   if(!publicationInfo){message.textContent+=' Refresh to check website status.';return;}
   lastState=publicationInfo;
   const member=[...publicationInfo.members,...(publicationInfo.unassignedProfiles||[])].find(m=>m.id===id);
   const memberStatus=app.querySelector('[data-member-publication]');
   if(member&&memberStatus)memberStatus.innerHTML=memberPublishing(member,publicationInfo.productionChoices);
   if(member)message.textContent+=' '+Object.entries(member.publication||{}).map(([pid,p])=>(publicationInfo.productions.find(x=>x.id===pid)?.name||pid)+': '+p.state).join(' · ');
   return;
  }
  if(a==='activate')history.replaceState(null,'',location.pathname);
  if(a==='prepareOfflineCountersign'){await load();message.textContent=result.created?(result.status==='Draft prepared'?'Heidi’s countersignature draft is prepared.':'SignWell is preparing Heidi’s countersignature draft.')+' Review its status under Documents → Uploaded agreements. No signing request has been sent.':'An existing preparation record was found. Review its status under Documents → Uploaded agreements.';return;}
  await load();message.textContent=['invite','resend'].includes(a)?'Invitation queued for email delivery.':a==='savePendingPerson'?'Name saved. Add their email here when you have it.':a==='removePendingPerson'?'Removed from the setup list.':a==='removeResource'?'Removed from the production board.':['login','passwordLogin','activate'].includes(a)?'':a==='logout'?'Signed out.':'Saved.';
 }catch(e){
  if(a==='photo'||a==='bio')profileStatus(f,e.message,true);
  else message.textContent=e.message;
 }finally{
  button.disabled=false;
  for(const control of photoInputs)control.disabled=false;
 }
});
listen('click',async e=>{
 const b=e.target;if(!b.dataset.status&&!b.dataset.photo)return;
 let attempt;
 try{if(b.dataset.photo){const blob=await request('photo',undefined,b.dataset.photo);const img=new Image();img.alt='Submitted headshot';const src=URL.createObjectURL(blob);img.onload=()=>URL.revokeObjectURL(src);img.src=src;b.nextElementSibling.replaceChildren(img);return;}
 const paperwork=b.closest('.member-paperwork');
 const status=paperwork?.querySelector('[data-signing-status]');
 const container=paperwork?.querySelector('[data-signing],#signing')||app.querySelector('#signing');
 const review=paperwork?.querySelector('button[data-status]');
 clearSigning();attempt=signingRequest;b.disabled=true;message.textContent='Checking agreement status…';
 const r=await request('status',undefined,b.dataset.status);if(attempt!==signingRequest||!container?.isConnected)return;
 const admin=lastState?.admin,label=signingLabel(r.status,!admin);
 if(review){
  if(!admin&&r.status!=='Waiting on actor')review.hidden=true;
  if(admin)review.textContent=r.status==='Waiting on Heidi'?'Open for Heidi’s signature':'Check signing request status';
 }
 if(status)status.textContent=label;
 message.textContent=label;
 if(!r.url&&['Draft ready to send','Complete'].includes(r.status)){await load();message.textContent=label;return;}
 if(!container)return;
 const view=container.closest('[data-view]');if(view&&r.url){activeView=view.dataset.view;applyView();}
 if(r.url)await showSigning(r.url,b.dataset.status,container,attempt,r.recipientName);
 else if((admin&&r.status==='Waiting on Heidi')||(!admin&&r.status==='Waiting on actor')){
  const note=document.createElement('p');
  note.textContent=admin?'SignWell has no active countersignature link for this request. Check the agreement in SignWell.':'Your signing link is unavailable. Ask production to check the request.';
  container.replaceChildren(note);
 }
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
const calendarDate=value=>new Date(value&&/(?:Z|[+-]\d\d:\d\d)$/i.test(value)?value:value+'Z');
const easternEventTime=new Intl.DateTimeFormat('en-US',{
 timeZone:'America/Indiana/Indianapolis',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'
});
const allDayEventDate=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric'});
function eventWhen(event){
 const start=calendarDate(event.start),end=calendarDate(event.end);
 if(!Number.isFinite(+start))return 'Time not listed';
 if(event.allDay){
  const finalDay=Number.isFinite(+end)&&end>start?new Date(+end-1):start;
  return allDayEventDate.formatRange(start,finalDay)+' · All day';
 }
 return Number.isFinite(+end)&&end>start?easternEventTime.formatRange(start,end):easternEventTime.format(start);
}
async function mountCalendar(admin=true){
 const panel=document.createElement('aside');
 panel.className='exchange-calendar';panel.innerHTML='<h2>Production calendar</h2><p>Loading calendar…</p>';
 app.querySelector('#calendar-slot')?.append(panel);
 const showNextEvent=text=>{
  if(admin)return;
  const next=app.querySelector('[data-member-next-event]');
  if(next)next.textContent=text;
 };
 const connectButton=label=>{
  const button=document.createElement('button');
  button.type='button';
  button.textContent=label;
  button.onclick=async()=>{
   button.disabled=true;
   try{location.assign((await request('calendarConnect',{})).url);}
   catch(error){message.textContent=error.message;button.disabled=false;}
  };
  return button;
 };
 function attachNotes(detail,eventKey){
  const region=document.createElement('div');
  region.hidden=true;
  detail.append(region);
  let loading=false,loaded=false;
  const status=text=>{
   const note=document.createElement('p');
   note.setAttribute('role','status');
   note.textContent=text;
   return note;
  };
  const load=async()=>{
   if(!detail.open||!detail.isConnected||loading||loaded)return;
   loading=true;
   region.hidden=false;
   region.replaceChildren(status('Loading Outlook notes…'));
   try{
    const result=await request('calendarNotes',undefined,'','&event='+encodeURIComponent(eventKey));
    if(!detail.isConnected)return;
    loaded=true;
    const notes=typeof result.notes==='string'?result.notes.trim():'';
    if(!notes){region.hidden=true;region.replaceChildren();return;}
    const heading=document.createElement('strong');
    heading.textContent='Outlook notes';
    const body=document.createElement('p');
    body.style.whiteSpace='pre-wrap';
    body.style.overflowWrap='anywhere';
    body.textContent=notes;
    region.replaceChildren(heading,body);
    if(result.truncated){
     const hint=document.createElement('small');
     hint.textContent='Additional text is available in Outlook.';
     region.append(hint);
    }
   }catch(error){
    if(!detail.isConnected)return;
    if(error.status===404){loaded=true;region.hidden=true;region.replaceChildren();return;}
    const retry=document.createElement('button');
    retry.type='button';
    retry.textContent='Try notes again';
    retry.onclick=load;
    region.replaceChildren(status('Outlook notes are temporarily unavailable.'),retry);
   }finally{loading=false;}
  };
  detail.addEventListener('toggle',load);
  return load;
 }
 const refresh=async()=>{
  const key=new URLSearchParams(location.search).get('event');
  const eventKey=/^[\w-]{43}$/.test(key||'')?key:'';
  try{
   const result=await request('calendarEvents',undefined,'',eventKey?'&event='+encodeURIComponent(eventKey):'');
   if(!panel.isConnected)return;
   if(!result.connected){
    if(!admin){
     showNextEvent('Calendar unavailable.');
     panel.innerHTML='<h2>Production calendar</h2><p>The calendar is currently unavailable.</p>';
     return;
    }

    const heading=document.createElement('h2');heading.textContent='Production calendar';const note=document.createElement('p');note.textContent='Connect the hello@ Exchange calendar.';panel.replaceChildren(heading,note,connectButton('Connect Outlook calendar'));
   }else{
    const openKeys=new Set([...panel.querySelectorAll('details[open]')].map(detail=>detail.dataset.eventKey));
    const next=result.items.filter(event=>!event.cancelled&&Number.isFinite(+calendarDate(event.start)))
     .sort((a,b)=>calendarDate(a.start)-calendarDate(b.start))[0];
    showNextEvent(next?eventWhen(next)+' · '+next.title:'No upcoming events in the next 30 days.');
    const list=document.createElement('ul');
    const loadOpenedNotes=[];
    const rows=result.selected?[result.selected,...result.items.filter(e=>e.key!==eventKey)]:result.items;
    for(const event of rows){
     const item=document.createElement('li');
     if(event.cancelled){
      const label=document.createElement('strong');label.textContent='Event cancelled';
      const note=document.createElement('p');note.textContent='The event linked in your email is no longer scheduled.';
      item.append(label,note);
     }else{
      const detail=document.createElement('details');detail.dataset.eventKey=event.key;
      const selected=event.key===eventKey&&result.selected;
      detail.open=!!selected||openKeys.has(event.key);
      const title=document.createElement('summary');title.textContent=eventWhen(event)+' · '+(event.title||'Production event');
      detail.append(title);
      const productions=(event.productions||[]).map(id=>
       (lastState?.productionChoices||lastState?.productions||[]).find(production=>production.id===id)?.name
      ).filter(Boolean);
      if(productions.length){
       const production=document.createElement('p');production.textContent=productions.join(' · ');
       detail.append(production);
      }
      if(event.location){
       const place=document.createElement('p');place.textContent='Location · '+event.location;
       detail.append(place);
      }
      if(result.notesEnabled&&event.productions?.length){
       const load=attachNotes(detail,event.key);
       if(detail.open)loadOpenedNotes.push(load);
      }
      item.append(detail);
     }
     list.append(item);
    }
    const heading=document.createElement('h2');heading.textContent='Production calendar';
    const note=document.createElement('p');note.textContent=result.items.length?'Next 30 days · Eastern time':'No upcoming events in the next 30 days.';
    if(eventKey&&!result.selected)note.textContent='The linked event is no longer available. '+note.textContent;
    if(result.selected&&!result.selected.cancelled)note.textContent='The linked event is listed first. Upcoming events follow in Eastern time.';
    panel.replaceChildren(heading,note);
    if(admin&&!result.notesEnabled){
     const description=document.createElement('p');
     description.textContent='Reconnect to allow the portal to read event descriptions. Members see descriptions only for events shared with their production.';
     panel.append(description,connectButton('Reconnect Outlook to show notes'));
    }
    if(admin){
     const notifications=document.createElement('p');
     notifications.textContent='In Outlook, use the film’s category to email its members when an event is added or updated. Select both categories to notify both casts.';
     panel.append(notifications);
    }
    panel.append(list);
    for(const load of loadOpenedNotes)load();
    if(eventKey&&focusedCalendarEvent!==eventKey){focusedCalendarEvent=eventKey;panel.scrollIntoView({block:'start'});}
   }
   panel.className='exchange-calendar';panel.hidden=false;
  }catch{
   if(!panel.isConnected)return;
   showNextEvent('Calendar unavailable.');
   panel.innerHTML='<h2>Production calendar</h2><p>Calendar unavailable. Your connection may need attention.</p>';
   const retry=document.createElement('button');
   retry.type='button';
   retry.textContent='Try again';
   retry.onclick=refresh;
   panel.append(retry);
   if(admin)panel.append(connectButton('Reconnect Outlook'));
  }

 };
 await refresh();
 const timer=setInterval(()=>{if(!panel.isConnected)clearInterval(timer);else if(!document.hidden&&!panel.hidden)refresh();},300000);
}



function applyView(){
 app.classList.toggle('reports-active',activeView==='reports');
 if(lastState?.admin&&!office){const picker=app.querySelector('.office-header .production-picker');if(picker)picker.hidden=['availability','reports'].includes(activeView);}
 app.querySelectorAll('[data-view]').forEach(el=>el.hidden=el.dataset.view!==activeView);
 app.querySelectorAll('[data-view-button]').forEach(b=>b.setAttribute('aria-current',b.dataset.viewButton===activeView?'page':'false'));
 ensureAvailability();
}
listen('click',e=>{
 const memberTab=e.target.closest('[data-member-tab]');
 if(memberTab){showMemberView(memberTab.dataset.memberTab,{navigate:true,scroll:!memberTab.closest('nav')});return;}
 const open=e.target.closest('[data-open-person],[data-open-catalog]');
 if(open&&office){
  if(open.dataset.openPerson)office.openPerson(open.dataset.openPerson,open.dataset.personArea||'paperwork');
  else office.openCatalog(open.dataset.openCatalog);
 }
});
setInterval(()=>{if(!combined&&lastState&&activeView!=='reports'&&!document.hidden&&!dirty().length&&!availabilityBusy()&&!availabilityOpen()&&!signingSession&&!offlineBulkInProgress)load().catch(()=>{});},300000);
let focusFilm=null;
function syncOffice(){
 if(!office)return;
 office.section.hidden=(activeView==='people'&&!focusFilm)||(activeView==='calendar'&&!office.first);
 office.section.classList.toggle('production-person-editor',activeView==='people'&&focusFilm?.target==='person');
 const slot=app.querySelector('#calendar-slot');
 if(slot){
  slot.hidden=activeView!=='calendar';
  if(!slot.hidden&&!slot.firstElementChild)mountCalendar();
 }
 office.section.querySelector(':scope > h2').textContent=activeView==='calendar'?'Events':lastState.film;
 if(activeView!=='people'||!focusFilm)return;
 const area=app.querySelector('[data-film-person]');
 const key=focusFilm.target+'/'+focusFilm.profileId;
 if(area&&area.dataset.rendered!==key){
  area.innerHTML=renderOfficePerson(focusFilm);
  area.dataset.rendered=key;
 }
 ensureAvailability();

}
load(office?.state).catch(e=>{app.textContent='Portal unavailable.';message.textContent=e.message;});
return {
 review(id){
  const list=app.querySelector('[data-review-list]');
  const panel=id?[...list?.querySelectorAll('form[data-action="reviewProduction"]')||[]].find(form=>form.dataset.id===id)?.closest('details'):list?.querySelector('details');
  if(panel){panel.open=true;panel.scrollIntoView({block:'start'});panel.querySelector('summary')?.focus({preventScroll:true});}
 },
 show(view){activeView=view;focusFilm=null;applyView();syncOffice();},
 open(film,scroll){focusFilm=film;syncOffice();if(scroll)office.section.scrollIntoView({block:'start'});},
 refresh(){if(!dirty().length&&!availabilityBusy()&&!availabilityOpen()&&!offlineBulkInProgress&&!signingSession)return load().catch(e=>{message.textContent=e.message;});},
 sectionTarget(area){
  if(!office)return null;
  const card=focusFilm?.target==='person'&&app.querySelector('[data-person="'+focusFilm.profileId+'"]');
 if(area==='review'||area==='prepare'){
   const action=area==='review'?'reviewProduction':'agreement';
   const panel=card?.querySelector('form[data-action="'+action+'"]')?.closest('details');
   if(panel){panel.open=true;return panel.querySelector('summary');}
  }
  const target=area==='paperwork'&&card?.querySelector('.member-paperwork')||office.section;
  target.tabIndex=-1;
  return target;
 },
 busy(){return offlineBulkInProgress||!!signingSession||availabilityBusy();}
};
}
startPortal(document.querySelector('#app'));
