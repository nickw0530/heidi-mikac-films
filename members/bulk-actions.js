import {comparePeople} from './people-order.mjs';

function el(tag,attributes={},...children){
 const node=document.createElement(tag);
 for(const [name,value] of Object.entries(attributes))node.setAttribute(name,value);
 node.append(...children);
 return node;
}

function button(label,action,className=''){
 const node=el('button',{type:'button',class:className},label);
 node.addEventListener('click',action);
 return node;
}

export function bulkCandidates(people,productions,{mailReady,agreementReady}){
 const titles=new Map(productions.map(production=>[production.id,production.name]));
 const invitations=new Map(),agreements=new Map();
 for(const person of people){
  const member=person.member;
  if(!person.hasMemberProfile||!member||member.revoked)continue;
  const {id,name}=member;
  if(mailReady&&person.hasAccount&&member.email&&member.activated===false){
   const context=Object.keys(member.productions||{}).map(id=>titles.get(id)||id).sort().join(' · ')||'No production assigned';
   invitations.set(id,{key:id,id,name,email:member.email,context});
  }
  for(const film of person.films){
   const assignment=film.member;
   if(!assignment||!agreementReady(film.id)||assignment.paperworkTracking||(assignment.agreement&&!assignment.agreement.cleared))continue;
   const key=id+'/'+film.id;
   agreements.set(key,{key,id,name,email:member.email||'',productionId:film.id,context:film.name});
  }
 }
 return {
  invitations:[...invitations.values()].sort(comparePeople),
  agreements:[...agreements.values()].sort((a,b)=>comparePeople(a,b)||a.context.localeCompare(b.context))
 };
}

export function mountBulkActions(container,{getPeople,getProductions,canSend,canPrepare,resend,openPreparation,onQueued,canOpen=()=>true}){
 container.dataset.bulkRoot='';
 const dialog=el('dialog',{class:'bulk-dialog','aria-labelledby':'bulk-actions-title'});
 const title=el('h2',{id:'bulk-actions-title',tabindex:'-1'},'Bulk actions');
 const notice=el('p',{class:'bulk-notice',role:'status'}),content=el('div');
 const close=button('Close',()=>dialog.close(),'quiet-button');
 dialog.append(el('div',{class:'bulk-dialog-header'},title,close),notice,content);
 const open=button('Bulk actions',()=>{
  if(!canOpen())return;
  render();dialog.showModal();title.focus();
 },'quiet-button');
 container.append(open,dialog);

 let mode='invitations',step='choose',query='',reviewed=[],sending=false,queued=0;
 const chosen=new Set();
 const candidates=()=>bulkCandidates(getPeople(),getProductions(),{mailReady:canSend(),agreementReady:canPrepare})[mode];
 const sameInvite=(current,row)=>current?.email===row.email&&current.context===row.context&&current.name===row.name;
 const explain=message=>{notice.textContent=message;};
 function move(next){step=next;explain('');render();title.focus({preventScroll:true});}

 dialog.addEventListener('cancel',event=>{if(sending)event.preventDefault();});
 dialog.addEventListener('close',()=>{
  if(step==='results'){
   const shouldRefresh=queued>0;
   queued=0;chosen.clear();reviewed=[];query='';step='choose';
   if(shouldRefresh)onQueued?.();
  }
  open.focus({preventScroll:true});
 });

 function render(){
  close.disabled=sending;
  title.textContent=step==='choose'?'Bulk actions':step==='review'?(mode==='invitations'?'Review invitation recipients':'Review agreements to prepare'):'Invitation results';
  if(step==='choose')renderChoices();
  else if(step==='review')renderReview();
 }

 function renderChoices(){
  const modeSelect=el('select',{},el('option',{value:'invitations'},'Resend pending invitations'),el('option',{value:'agreements'},'Prepare agreements'));
  modeSelect.value=mode;
  modeSelect.addEventListener('change',()=>{mode=modeSelect.value;chosen.clear();query='';explain('');render();content.querySelector('select')?.focus();});
  const modeLabel=el('label',{},'Action',modeSelect);
  const options=candidates();
  const allowed=new Set(options.map(row=>row.key));
  for(const key of chosen)if(!allowed.has(key))chosen.delete(key);
  if(!options.length){
   const empty=mode==='agreements'?'No agreements are ready to prepare in this production scope.':canSend()?'No pending invitations in this production scope.':'The invitation email sender is unavailable.';
   content.replaceChildren(modeLabel,el('p',{},empty));return;
  }
  const search=el('input',{type:'search',placeholder:'Find a name or production'});
  search.value=query;
  const list=el('ul',{class:'bulk-list bulk-select-list','aria-label':'People to select'});
  const count=el('p',{class:'bulk-count',role:'status'});
  const review=button('Review selected',()=>{
   const latest=candidates().filter(row=>chosen.has(row.key));
   if(latest.length!==chosen.size){render();explain('The roster changed. Review the remaining selections.');return;}
   reviewed=latest;move('review');
  },'bulk-primary');
  const updateCount=()=>{count.textContent=chosen.size+' selected';review.disabled=chosen.size===0;};
  const searchRows=[];
  for(const row of options){
   const check=el('input',{type:'checkbox'});
   check.checked=chosen.has(row.key);
   check.addEventListener('change',()=>{
    if(check.checked)chosen.add(row.key);else chosen.delete(row.key);
    updateCount();
   });
   const label=el('label',{},check,el('span',{},el('strong',{},row.name),el('small',{},row.context)));
   const item=el('li',{},label);
   list.append(item);searchRows.push([item,(row.name+' '+row.context).toLocaleLowerCase()]);
  }
  const noMatches=el('p',{class:'bulk-count'},'No matching names or productions.');
  const applySearch=()=>{
   query=search.value;
   const wanted=query.trim().toLocaleLowerCase();
   for(const [item,terms] of searchRows)item.hidden=!terms.includes(wanted);
   noMatches.hidden=searchRows.some(([item])=>!item.hidden);
  };
  search.addEventListener('input',applySearch);
  applySearch();updateCount();
  content.replaceChildren(modeLabel,el('label',{},'Search people',search),list,noMatches,el('div',{class:'bulk-footer'},count,review));
 }

 function recipientRow(row){
  return el('div',{class:'bulk-recipient'},el('strong',{},row.name),el('small',{},row.email||'Email needed'),el('small',{},row.context));
 }

 function renderReview(){
  const list=el('ul',{class:'bulk-list','aria-label':mode==='invitations'?'Invitation recipients':'Agreements to prepare'});
  for(const row of reviewed){
   const item=el('li',{},recipientRow(row));
   if(mode==='agreements')item.append(button('Open preparation',()=>{
    if(!candidates().some(candidate=>candidate.key===row.key)){
     explain('This agreement is no longer ready to prepare. Go back and review the list.');return;
    }
    dialog.close();openPreparation(row);
   },'quiet-button'));
   list.append(item);
  }
  const actions=el('div',{class:'bulk-footer'},button('Back to selection',()=>move('choose'),'quiet-button'));
  const instruction=mode==='invitations'?'Each new invitation replaces that person’s previous setup link.':'Open each agreement to check credits and terms before creating its signing request.';
  if(mode==='invitations')actions.append(button('Send selected invitations ('+reviewed.length+')',sendInvitations,'bulk-primary'));
  content.replaceChildren(el('p',{class:'bulk-instructions'},instruction),list,actions);
 }

 async function sendInvitations(){
  if(sending||step!=='review'||mode!=='invitations'||!reviewed.length)return;
  const latest=new Map(candidates().map(row=>[row.id,row]));
  if(reviewed.some(row=>!sameInvite(latest.get(row.id),row))){
   move('choose');explain('An account changed. Review the selected recipients again.');return;
  }

  sending=true;step='results';render();title.focus({preventScroll:true});
  const list=el('ul',{class:'bulk-list','aria-label':'Invitation results'});
  const statuses=reviewed.map(row=>{
   const status=el('span',{class:'bulk-row-status'},'Waiting');
   list.append(el('li',{},recipientRow(row),status));return status;
  });
  content.replaceChildren(list);
  let stopped=false;
  try{
   for(const [index,row] of reviewed.entries()){
    if(!container.isConnected)break;
    const status=statuses[index];
    if(stopped){status.textContent='Not attempted · sign in and review again';continue;}
    const current=candidates().find(candidate=>candidate.id===row.id);
    if(!sameInvite(current,row)){status.textContent='Skipped · account changed';continue;}
    explain('Queuing invitation '+(index+1)+' of '+reviewed.length+'…');
    status.textContent='Queuing…';
    try{
     const result=await resend(row);
     if(result?.ok!==true)throw Error('Unknown invitation result');
     status.textContent='Queued';queued++;
    }catch(error){
     if(error?.status>=400&&error.status<500){
      status.textContent='Could not queue · '+(error.message||'Check this account');
      stopped=[401,403].includes(error.status);
     }else status.textContent='Queue status unknown · check Email delivery before trying again';
    }
   }
  }finally{
   sending=false;close.disabled=false;
   explain(queued+' of '+reviewed.length+' invitations queued. Check Email delivery for provider status.');
  }
 }

 return {busy:()=>sending};
}
