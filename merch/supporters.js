const endpoint='/.netlify/functions/merch?action=supporters';
const money=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});

// Whitelist the public projection only. Never render payment or identity fields.
export function supporterCredits(data){
  if(!Array.isArray(data?.supporters))throw Error('Supporter credits are unavailable.');
  return data.supporters.map(entry=>({
    name:typeof entry?.name==='string'&&entry.name.trim()?entry.name.trim():'Anonymous',
    amount:Number.isSafeInteger(entry?.amount)&&entry.amount>=0&&entry.currency==='USD'?money.format(entry.amount/100):'Amount private'
  }));
}

export function mountSupporterWall({doc=document,win=window,fetcher=fetch}={}){
  const wall=doc.querySelector('[data-supporter-wall]');
  if(!wall)return null;
  const find=selector=>wall.querySelector(selector);
  const viewport=find('[data-supporter-viewport]'),roll=find('[data-supporter-roll]');
  const empty=find('[data-supporters-empty]'),pause=find('[data-supporter-pause]'),status=find('[data-supporter-status]');
  const reduced=win.matchMedia?.('(prefers-reduced-motion: reduce)');
  let paused=false,signature=null,pending=false,destroyed=false,controller;
  function motion(){
    const staticView=paused||reduced?.matches;
    wall.dataset.paused=String(!!staticView);
    pause.setAttribute('aria-pressed',String(paused));
    pause.disabled=!!reduced?.matches;
    pause.textContent=reduced?.matches?'Motion reduced':paused?'Resume credits':'Pause credits';
    viewport.setAttribute('aria-label',staticView?'Supporter credits. Scroll to browse every supporter.':'Supporter credits. Pause the credits to browse every supporter.');
  }
  function toggle(){paused=!paused;motion();}
  function render(credits){
    const next=JSON.stringify(credits);
    if(next===signature)return;
    signature=next;roll.replaceChildren();
    // Both halves have the same height, including bottom padding, so translating
    // half the roll creates a continuous loop. The duplicate is never announced.
    for(let copy=0;copy<2;copy++){
      const list=doc.createElement('ul');list.className='supporter-names';
      list.setAttribute(copy?'aria-hidden':'aria-label',copy?'true':'Our film supporters');
      if(copy)list.setAttribute('inert','');
      for(const entry of credits){
        const row=doc.createElement('li'),name=doc.createElement('span'),amount=doc.createElement('span');
        name.className='supporter-credit-name';amount.className='supporter-credit-amount';
        name.textContent=entry.name;amount.textContent=entry.amount;
        row.append(name,amount);list.append(row);
      }
      roll.append(list);
    }
    roll.style.setProperty('--credits-duration',Math.max(24,credits.length*4)+'s');
    const hasCredits=credits.length>0;
    viewport.hidden=!hasCredits;empty.hidden=hasCredits;pause.hidden=!hasCredits;
    empty.textContent='Our next chapter starts with you. Supporter credits appear here after payments are confirmed.';
    motion();
  }
  async function refresh(){
    if(destroyed||pending||doc.visibilityState==='hidden')return;
    pending=true;controller=new AbortController();
    const timeout=win.setTimeout(()=>controller.abort(),4500);
    try{
      const response=await fetcher(endpoint,{cache:'no-store',signal:controller.signal});
      if(!response.ok)throw Error('Supporter credits are unavailable.');
      const credits=supporterCredits(await response.json());
      if(destroyed)return;
      render(credits);status.textContent='';
    }catch{
      if(destroyed)return;
      if(signature===null)empty.textContent='Supporter credits could not load. We’ll try again shortly.';
      else status.textContent='Updates are temporarily unavailable. Showing the last loaded credits.';
    }finally{win.clearTimeout(timeout);pending=false;}
  }
  function visible(){if(doc.visibilityState!=='hidden')void refresh();}
  pause.addEventListener('click',toggle);
  reduced?.addEventListener?.('change',motion);
  doc.addEventListener('visibilitychange',visible);
  win.addEventListener('hmf-supporters-refresh',refresh);
  win.addEventListener('focus',visible);
  const timer=win.setInterval(()=>void refresh(),5000);
  motion();void refresh();
  return {refresh,destroy(){
    destroyed=true;controller?.abort();win.clearInterval(timer);
    pause.removeEventListener('click',toggle);
    reduced?.removeEventListener?.('change',motion);
    doc.removeEventListener('visibilitychange',visible);
    win.removeEventListener('hmf-supporters-refresh',refresh);
    win.removeEventListener('focus',visible);
  }};
}

if(typeof document!=='undefined')mountSupporterWall();
