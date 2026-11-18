const placementChoices=[['','Website default'],['lead','Lead Cast'],['supporting','Supporting Cast'],['additional','Additional Cast'],['crew','Creative Team & Crew']];
const coreFields=['selected','character','crewTitle','visible'];
const clone=value=>structuredClone(value);
const samePlacement=(left,right)=>left.castPlacement===right.castPlacement&&(left.castPlacement!=='lead'||Number(left.billingOrder)===Number(right.billingOrder));
const placement=production=>({castPlacement:production.placement?.castPlacement||'',billingOrder:production.placement?.billingOrder??''});

export function onboardingDraft(state){
 return state.productions.map(production=>({id:production.id,selected:!!production.selected,character:production.character||'',crewTitle:production.crewTitle||'',
  visible:production.visible!==false,approve:false,...placement(production),paperwork:''}));
}

export function onboardingChanged(state,draft){
 const original=onboardingDraft(state);
 return draft.some((row,index)=>coreFields.some(field=>row[field]!==original[index][field])||row.approve||row.selected&&(!samePlacement(row,original[index])||row.paperwork));
}

export function rebaseOnboardingProfile(previous,next,draft){
 const rows=new Map(previous.productions.map(row=>[row.id,row]));
 const unchanged=next.productions.length===previous.productions.length&&next.productions.every(row=>{
  const old=rows.get(row.id);
  return old&&['assigned','selected','character','crewTitle','visible','role'].every(field=>(old[field]??'')===(row[field]??''));
 });
 if(!unchanged)throw Error('Production settings changed while the shared profile was saved. Your onboarding choices are still here. Reload the saved setup before continuing.');
 const profileChanged=previous.profileRevision!==next.profileRevision;
 const changes=new Map(draft.map(row=>[row.id,row]));
 const rebased=next.productions.map(row=>{
  const wanted=clone(changes.get(row.id)),before=rows.get(row.id);
  const placementChanged=!samePlacement(wanted,placement(before));
  const newPlacement=!samePlacement(placement(before),placement(row))||(before.placement?.revision||'')!==(row.placement?.revision||'');
  if(placementChanged&&newPlacement&&!samePlacement(wanted,placement(row)))throw Error('Website placement changed while the shared profile was saved. Your onboarding choices are still here. Reload the saved setup before continuing.');
  if(wanted.paperwork){
   const desired=wanted.paperwork==='reopen'?'':wanted.paperwork;
   const previousReason=before.paperwork?.reason||'',nextReason=row.paperwork?.reason||'';
   if(nextReason!==previousReason&&nextReason!==desired)throw Error('Agreement tracking changed while the shared profile was saved. Your onboarding choices are still here. Reload the saved setup before continuing.');
   if(nextReason===desired)wanted.paperwork='';
  }
  if(profileChanged||row.canApprove===false)wanted.approve=false;
  if(!placementChanged)Object.assign(wanted,placement(row));
  return wanted;
 });
 return {state:next,draft:rebased,profileChanged};
}

// Assignments and approvals share one member revision. Billing and paperwork retain
// their existing routes and expose each independent result if a save is interrupted.
export async function saveOnboarding({id,request,state,draft,onProgress=()=>{}}){
 const original=onboardingDraft(state),rows=new Map(state.productions.map((row,index)=>[row.id,{row,draft:original[index]}]));
 const coreChanged=draft.some(row=>row.selected!==(rows.get(row.id).row.assigned??rows.get(row.id).row.selected)||row.approve||coreFields.some(field=>row[field]!==rows.get(row.id).draft[field]));
 const operations=[];
 for(const row of draft.filter(row=>row.selected)){
  const before=rows.get(row.id);
  if(!samePlacement(row,before.draft))operations.push({kind:'placement',row,before:before.row});
  if(row.paperwork)operations.push({kind:'paperwork',row,before:before.row});
 }
 if(coreChanged){
  onProgress('Saving assignments, credits and approvals…');
  await request('onboarding',{memberRevision:state.memberRevision,profileRevision:state.profileRevision,
   productions:draft.map(row=>Object.fromEntries(['id',...coreFields,'approve'].map(field=>[field,row[field]])))},id);
 }
 let current;
 try{current=await request('onboarding',undefined,id);}catch(error){
  const failure=Error((coreChanged?'Assignments and approvals were submitted. ':'')+'Saved status could not be refreshed. Reload the saved setup before continuing.');
  failure.coreSaved=coreChanged;throw failure;
 }
 const results=[];
 for(const operation of operations){
  const {kind,row,before}=operation,production=current.productions.find(film=>film.id===row.id);
  const label=(kind==='placement'?'Website placement':'Agreement requirement')+' · '+before.name;
  onProgress('Saving '+label.toLocaleLowerCase()+'…');
  try{
   if(!(production?.assigned??production?.selected))throw Error('This person is no longer assigned to this production. Reload the setup.');
   if(kind==='placement'){
    if(!samePlacement(row,placement(production))){
     if((production.placement?.revision||'')!==(before.placement?.revision||''))throw Error('The website placement changed elsewhere. Reload before changing it.');
     await request('saveWebsitePlacement',{castPlacement:row.castPlacement,billingOrder:row.castPlacement==='lead'?row.billingOrder:'',expectedRevision:production.placement?.revision||''},id,'',row.id);
    }
   }else{
    const currentReason=production.paperwork?.reason||'',previousReason=before.paperwork?.reason||'';
    const desired=row.paperwork==='reopen'?'':row.paperwork;
    if(currentReason!==desired){
     if(currentReason!==previousReason)throw Error('The paperwork was updated elsewhere. Reload before changing it.');
     await request('trackPaperwork',{document:'agreement',reason:row.paperwork},id,'',row.id);
    }
   }
   results.push({productionId:row.id,kind,label,ok:true});
  }catch(error){results.push({productionId:row.id,kind,label,ok:false,error:error.message||'The save could not be confirmed.'});}
 }
 try{current=await request('onboarding',undefined,id);}catch(error){return {state:current,results,refreshError:error.message||'Saved status could not be refreshed.'};}
 return {state:current,results};
}

function el(tag,attributes={},...children){
 const node=document.createElement(tag);
 for(const [key,value] of Object.entries(attributes))if(value!==undefined&&value!==false)node.setAttribute(key,value===true?'':value);
 node.append(...children.filter(child=>child!=null));
 return node;
}
function button(text,action,className=''){
 const node=el('button',{type:'button',class:className},text);
 node.addEventListener('click',action);return node;
}
function label(text,field){return el('label',{},el('span',{},text),field);}
function statusLabel(status){
 return ({Complete:'Signed by both','Waiting on actor':'Awaiting cast or crew signature','Waiting on Heidi':'Awaiting Heidi’s signature'})[status]||status||'No signing request';
}

export function mountOnboarding(container,{id,request,onSaved,onOpenFilm,beforeSave}){
 container.dataset.onboardingRoot='';container.classList.add('onboarding-workspace');
 let state=null,draft=[],loading=false,saving=false,destroyed=false,reloadRequired=false,pendingFocus='',sequence=0;
 const status=el('p',{class:'onboarding-notice',role:'status','aria-live':'polite'}),body=el('div'),results=el('ul',{class:'onboarding-results'});
 container.replaceChildren(status,body);
 const dirty=()=>!!state&&onboardingChanged(state,draft);
 const notice=(text,error=false)=>{status.textContent=text;status.classList.toggle('onboarding-error',error);};
 async function load(){
  const run=++sequence;loading=true;notice('Loading onboarding…');
  const disabled=[...body.querySelectorAll('input,select,button')].map(field=>[field,field.disabled]);
  for(const [field] of disabled)field.disabled=true;
  try{
   const value=await request('onboarding',undefined,id);
   if(destroyed||run!==sequence)return;
   state=value;draft=onboardingDraft(state);reloadRequired=false;notice('');render();
   if(pendingFocus)focusProduction(pendingFocus);
  }catch(error){if(!destroyed&&run===sequence){notice(error.message||'Onboarding could not be loaded.',true);body.replaceChildren(button('Try again',load));}}
  finally{if(run===sequence){loading=false;for(const [field,wasDisabled] of disabled)if(field.isConnected)field.disabled=wasDisabled;sync();}}
 }
 function sync(){
  const form=body.querySelector('form');
  if(form){if(dirty())form.dataset.dirty='true';else delete form.dataset.dirty;}
  const save=body.querySelector('[data-save-onboarding]');
  if(save)save.disabled=loading||saving||reloadRequired||!dirty();
  for(const open of body.querySelectorAll('[data-open-onboarding-film]'))open.disabled=loading||saving||reloadRequired||dirty()||!state.productions.find(film=>film.id===open.dataset.openOnboardingFilm)?.assigned;
  const note=body.querySelector('[data-onboarding-save-state]');
  if(note)note.textContent=reloadRequired?'Reload saved setup to confirm the last save':dirty()?'Unsaved onboarding changes':'All onboarding changes saved';
 }
 function profilePreview(){
  const details=el('details',{class:'onboarding-profile-preview'},el('summary',{},'Review biography & headshot'));
  const profile=state.profile||{},photo=profile.photo==='uploaded'?'/.netlify/functions/portal?'+new URLSearchParams({action:'photo',id,v:state.profileRevision||''}):profile.photo;
  const contents=el('div',{class:'onboarding-profile-copy'});
  if(photo)contents.append(el('img',{src:photo,alt:'Profile headshot for approval',loading:'lazy'}));
  contents.append(el('p',{},profile.bio||'No biography saved yet.'));
  if(!photo)contents.append(el('p',{},'No headshot saved yet.'));
  details.append(contents);return details;
 }
 function productionCard(production,row){
  const card=el('fieldset',{class:'onboarding-production',tabindex:'-1','data-onboarding-production':production.id}),legend=el('legend',{},production.name);
  const assigned=el('input',{type:'checkbox'});assigned.checked=row.selected;
  const controls=el('div',{class:'onboarding-production-fields'});controls.hidden=!row.selected;
  const assignment=label('Include in '+production.name,assigned);assignment.classList.add('onboarding-assignment');
  card.append(legend,assignment,controls);
  assigned.addEventListener('change',()=>{
   row.selected=assigned.checked;controls.hidden=!row.selected;
   if(!row.selected){row.approve=false;approval.checked=false;row.paperwork='';paperwork.value='';}
   billing.disabled=!row.selected||row.castPlacement!=='lead';billing.required=!billing.disabled;sync();
  });
  const current=el('p',{class:'onboarding-production-status'},el('span',{},'Website · '+(production.publicationState||'Not published')),
   el('span',{},'Agreement · '+(production.paperwork?.exempt?'Exempt from personal paperwork':production.paperwork?.status||statusLabel(production.agreementStatus))));
  const fields=el('div',{class:'onboarding-field-grid'});
  for(const [key,text] of [['character','Character'],['crewTitle','Crew title or titles']]){
   const field=el('input',{type:'text',maxlength:'120',value:row[key]});
   field.addEventListener('input',()=>{row[key]=field.value;sync();});fields.append(label(text,field));
  }
  const credit=production.role&&!production.character&&!production.crewTitle?el('p',{class:'onboarding-help'},'Current credit · '+production.role):null;
  const placement=el('select',{},...placementChoices.map(([value,text])=>el('option',{value},text)));placement.value=row.castPlacement;
  const billing=el('input',{type:'number',min:'1',max:'999',step:'1',value:row.billingOrder});
  const orderLabel=label('Lead billing order · 1 appears first',billing);orderLabel.hidden=row.castPlacement!=='lead';billing.disabled=!row.selected||orderLabel.hidden;billing.required=!billing.disabled;
  placement.addEventListener('change',()=>{row.castPlacement=placement.value;orderLabel.hidden=row.castPlacement!=='lead';billing.disabled=!row.selected||orderLabel.hidden;billing.required=!billing.disabled;sync();});
  billing.addEventListener('input',()=>{row.billingOrder=billing.value;sync();});
  fields.append(label('Website section',placement),orderLabel);
  const visible=el('input',{type:'checkbox'});visible.checked=row.visible;
  visible.addEventListener('change',()=>{row.visible=visible.checked;sync();});
  const approval=el('input',{type:'checkbox'});approval.checked=row.approve;approval.disabled=production.canApprove===false;
  approval.addEventListener('change',()=>{row.approve=approval.checked;sync();});
  const publish=el('div',{class:'onboarding-publishing'},label('Show on this production’s website',visible),label('Approve saved profile for '+production.name,approval));
  if(production.canApprove===false)publish.append(el('p',{class:'onboarding-help'},production.approvalReason||'Profile approval is unavailable for this person.'));
  else if(production.needsApproval)publish.append(el('p',{class:'onboarding-approval-needed'},'Profile approval needed'));
  else if(production.approved)publish.append(el('p',{class:'onboarding-help'},'The saved profile is already approved. Select approval to publish the current saved version again.'));
  const paperwork=el('select',{},el('option',{value:''},'Keep current status'),el('option',{value:'complete'},'Mark Complete'),el('option',{value:'not-required'},'Mark N/A'),
   ...(production.paperwork?.reason?[el('option',{value:'reopen'},'Reopen requirement')]:[]));
  paperwork.value=row.paperwork;paperwork.disabled=!!production.paperwork?.exempt;
  paperwork.addEventListener('change',()=>{row.paperwork=paperwork.value;sync();});
  const agreement=el('div',{class:'onboarding-paperwork'},label('Agreement requirement',paperwork));
  if(!production.paperwork?.exempt)agreement.append(el('p',{class:'onboarding-help'},'Complete or N/A updates portal tracking. An existing signing request stays active.'));
  const open=button('Open paperwork',()=>onOpenFilm?.(production.id),'quiet-button');open.dataset.openOnboardingFilm=production.id;
  agreement.append(open);
  controls.append(current,fields,credit,publish,agreement);
  return card;
 }
 function render(){
  const form=el('form',{class:'onboarding-form'}),cards=el('div',{class:'onboarding-productions'});
  for(const [index,production] of state.productions.entries())cards.append(productionCard(production,draft[index]));
  const save=el('button',{type:'submit',class:'onboarding-primary','data-save-onboarding':''},'Save onboarding');
  const reload=button('Reload saved setup',()=>{if(!dirty()||confirm('Discard unsaved onboarding changes and reload?'))load();},'quiet-button');
  const footer=el('div',{class:'onboarding-save-bar'},el('p',{'data-onboarding-save-state':'',role:'status'}),el('div',{},reload,save));
  form.append(el('h3',{},'Production setup'),el('p',{class:'onboarding-intro'},'Set assignments, credits, billing, approvals and agreement requirements for every production, then save once.'),profilePreview(),cards,footer,results);
  form.addEventListener('submit',event=>{event.preventDefault();saveAll();});
  body.replaceChildren(form);sync();
 }
 async function saveAll(){
  if(saving||reloadRequired||!dirty())return;
  const blocked=beforeSave?.();
  if(blocked){notice(blocked,true);return;}
  const wanted=clone(draft);
  for(const row of wanted.filter(row=>row.selected&&row.castPlacement==='lead')){
   if(!/^[1-9][0-9]{0,2}$/.test(String(row.billingOrder))){notice('Enter a lead billing order from 1 to 999 for '+state.productions.find(film=>film.id===row.id).name+'.',true);return;}
  }
  saving=true;results.replaceChildren();sync();
  for(const field of body.querySelectorAll('input,select,button'))field.disabled=true;
  try{
   const saved=await saveOnboarding({id,request,state,draft:wanted,onProgress:text=>notice(text)});
   if(destroyed)return;
   state=saved.state;draft=onboardingDraft(state);reloadRequired=!!saved.refreshError;
   for(const result of saved.results.filter(result=>!result.ok)){
    const row=draft.find(item=>item.id===result.productionId),desired=wanted.find(item=>item.id===result.productionId);
    if(!row)continue;
    if(result.kind==='placement'){row.castPlacement=desired.castPlacement;row.billingOrder=desired.billingOrder;}
    else row.paperwork=desired.paperwork;
   }
   results.replaceChildren(...saved.results.map(result=>el('li',{class:result.ok?'onboarding-result-saved':'onboarding-result-error'},result.label+' · '+(result.ok?'Saved':result.error))));
   const failures=saved.results.filter(result=>!result.ok).length;
   notice(saved.refreshError?'Changes were submitted, but saved status could not be refreshed. Reload the saved setup to check.':failures?'Assignments and approvals saved. '+failures+' '+(failures===1?'item needs':'items need')+' attention below.':'Onboarding saved for all productions.',!!failures||!!saved.refreshError);
   render();
   try{await onSaved?.();}catch{notice('Onboarding was saved. Refresh the page to update the rest of the dashboard.',true);}
  }catch(error){
   if(!destroyed){reloadRequired=true;notice(error.message||'The onboarding save could not be confirmed. Reload the saved setup to check.',true);render();}
  }finally{saving=false;if(!destroyed)sync();}
 }
 function focusProduction(productionId){
  pendingFocus=productionId;
  const card=[...body.querySelectorAll('[data-onboarding-production]')].find(node=>node.dataset.onboardingProduction===productionId);
  if(card){pendingFocus='';card.scrollIntoView({block:'start'});card.focus({preventScroll:true});}
 }
 async function refreshSharedProfile(){
  if(destroyed||saving)return;
  if(!state)return load();
  if(reloadRequired){notice('Reload the saved setup to confirm its current status before continuing.',true);return;}
  const run=++sequence;loading=true;
  const controls=[...body.querySelectorAll('input,select,button')].map(field=>[field,field.disabled]);
  for(const [field] of controls)field.disabled=true;
  notice('Refreshing the shared profile…');
  try{
   const next=await request('onboarding',undefined,id);
   if(destroyed||run!==sequence)return;
   const rebased=rebaseOnboardingProfile(state,next,draft);
   state=rebased.state;draft=rebased.draft;render();
   notice(rebased.profileChanged?'Shared profile saved. Review the updated biography and headshot, then select the approvals again.':'Shared profile refreshed. Your onboarding choices are retained.');
  }catch(error){if(!destroyed&&run===sequence){reloadRequired=true;notice(error.message||'The shared profile could not be refreshed. Reload the saved setup before continuing.',true);render();}}
  finally{
   if(run===sequence){loading=false;for(const [field,wasDisabled] of controls)if(field.isConnected)field.disabled=wasDisabled;sync();}
  }
 }
 load();
 return {busy:()=>loading||saving,dirty,destroy(){destroyed=true;sequence++;},refresh(){if(!dirty()&&!saving&&!loading)return load();},
  discard(){if(state&&!saving){draft=onboardingDraft(state);render();}},
  focusProduction,refreshSharedProfile
 };
}
