const endpoint='/.netlify/functions/merch?action=supporters';
const money=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
export const SUPPORTER_CACHE_TTL=5*60*1000;

export function activeCampaigns(data){
  return (Array.isArray(data?.campaigns)?data.campaigns:[])
    .filter(campaign=>campaign?.active===true&&typeof campaign.title==='string'&&campaign.title.trim()&&campaign.title.length<=240)
    .map(campaign=>({title:campaign.title.trim().replace(/\s+/gu,' ')}));
}

export function currentCampaignHeading(data){
  const campaigns=activeCampaigns(data);
  if(campaigns.length===1&&/^Take Two\b/iu.test(campaigns[0].title))return 'Take Two supporters';
  return campaigns.length>1?'Current campaigns':'Current campaign supporters';
}

// Whitelist the public projection only. Never render payment or identity fields.
export function supporterCredits(data){
  if(!Array.isArray(data?.supporters))throw Error('Supporter credits are unavailable.');
  return data.supporters.map(entry=>({
    name:typeof entry?.name==='string'&&entry.name.trim()?entry.name.trim():'Anonymous',
    amount:Number.isSafeInteger(entry?.amount)&&entry.amount>=0&&entry.currency==='USD'?money.format(entry.amount/100):'Amount private'
  }));
}

export function mountSupporterWall({doc=document,win=window,fetcher=fetch,now=()=>Date.now(),wall=doc.querySelector('[data-supporter-wall]')}={}){
  if(!wall)return null;
  const scope=wall.dataset.supporterScope==='lifetime'?'lifetime':'current';
  const find=selector=>wall.querySelector(selector);
  const viewport=find('[data-supporter-viewport]'),roll=find('[data-supporter-roll]');
  const empty=find('[data-supporters-empty]'),pause=find('[data-supporter-pause]'),status=find('[data-supporter-status]');
  const reduced=win.matchMedia?.('(prefers-reduced-motion: reduce)');
  let paused=false,signature=null,pending=false,destroyed=false,controller,lastSuccess=null;
  function motion(){
    const staticView=paused||reduced?.matches;
    wall.dataset.paused=String(!!staticView);
    pause.setAttribute('aria-pressed',String(paused));
    pause.disabled=!!reduced?.matches;
    pause.textContent=reduced?.matches?'Motion reduced':paused?'Resume credits':'Pause credits';
    const label=scope==='lifetime'?'Lifetime supporter credits.':'Current campaign supporter credits.';
    viewport.setAttribute('aria-label',label+(staticView?' Scroll to browse every supporter.':' Pause the credits to browse every supporter.'));
  }
  function toggle(){paused=!paused;motion();}
  function render(credits){
    empty.textContent=scope==='lifetime'?'No public lifetime supporter credits are available yet.':'No public credits for the current campaigns yet.';
    const next=JSON.stringify(credits);
    if(next===signature)return;
    signature=next;roll.replaceChildren();
    // Both halves have the same height, including bottom padding, so translating
    // half the roll creates a continuous loop. The duplicate is never announced.
    for(let copy=0;copy<2;copy++){
      const list=doc.createElement('ul');list.className='supporter-names';
      list.setAttribute(copy?'aria-hidden':'aria-label',copy?'true':scope==='lifetime'?'Lifetime film supporters':'Current campaign supporters');
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
    motion();
  }
  function expireCache(){
    if(lastSuccess===null||now()-lastSuccess<SUPPORTER_CACHE_TTL)return false;
    render([]);
    empty.textContent='Supporter credits are temporarily unavailable. We’ll try again shortly.';
    status.textContent='';
    return true;
  }
  async function refresh(){
    if(destroyed)return;
    expireCache();
    if(pending||doc.visibilityState==='hidden')return;
    pending=true;controller=new AbortController();
    const timeout=win.setTimeout(()=>controller.abort(),4500);
    try{
      const response=await fetcher(endpoint+'&scope='+scope,{cache:'no-store',signal:controller.signal});
      if(!response.ok)throw Error('Supporter credits are unavailable.');
      const data=await response.json(),credits=supporterCredits(data);
      if(destroyed)return;
      if(scope==='current'){
        const title=find('[data-supporter-title]'),campaignLabel=find('[data-supporter-campaigns]');
        if(title)title.textContent=currentCampaignHeading(data);
        if(campaignLabel)campaignLabel.textContent=activeCampaigns(data).map(campaign=>campaign.title).join(' · ')||'Our community supporting the current film campaigns.';
      }
      render(credits);lastSuccess=now();status.textContent='';
    }catch{
      if(destroyed)return;
      if(expireCache())return;
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

export function mountSupporterWalls(options={}){
  const doc=options.doc??document;
  return [...doc.querySelectorAll('[data-supporter-wall]')].map(wall=>mountSupporterWall({...options,doc,wall}));
}

if(typeof document!=='undefined')mountSupporterWalls();
