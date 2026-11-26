const callback='https://heidimikacfilms.com/.netlify/functions/crowdfundr-callback';
const time=value=>{
 const date=new Date(value);
 return value&&Number.isFinite(date.valueOf())?date.toLocaleString():'Not yet completed';
};

export async function mountCrowdfundr(host,request){
 host.innerHTML=`
   <h3>Crowdfundr automatic connection</h3>
   <p data-crowdfundr-public-state role="status" aria-live="polite">Checking public campaign updates…</p>
   <p data-crowdfundr-public-time></p>
   <p>All-time credits combine the listed past and current Crowdfundr campaigns. Current credits use only campaigns marked Current below. Names follow each contribution’s current privacy choices. Anonymous amounts can be verified from the owner's transaction records when Crowdfundr withholds them from the public feed. Complete feeds are checked about every 15 minutes; imported copies stay in your records and are not counted again.</p>
   <p>This mirrors public campaign activity. It does not confirm bank settlement or refund accounting. Record offline payments here, and use Hide payment if a refunded contribution remains in Crowdfundr’s public activity.</p>
   <button type="button" data-crowdfundr-public-enable>Enable automatic public credits</button>
   <button type="button" data-crowdfundr-public-sync disabled>Check public credits now</button>
   <button type="button" data-crowdfundr-public-disable disabled>Use CSV credits instead</button>
   <p data-crowdfundr-public-error role="status" aria-live="polite"></p>
   <p data-crowdfundr-campaign-summary></p>
   <ul data-crowdfundr-campaign-status aria-label="Campaign synchronization status"></ul>
   <details data-crowdfundr-campaigns>
    <summary>Manage past and current campaigns</summary>
    <p>Use each campaign’s public ID, not its full URL. Every listed campaign belongs in all-time credits. Mark one or more as Current to include them in current credits. Uncharged pledges, offline and deleted contributions remain excluded.</p>
    <form data-crowdfundr-campaign-form>
     <div class="merch-admin-scroll" tabindex="0" aria-label="Crowdfundr campaign registry">
      <table><thead><tr><th>Campaign ID</th><th>Public title</th><th>Current</th><th>Manage</th></tr></thead><tbody data-crowdfundr-campaign-rows></tbody></table>
     </div>
     <button type="button" data-crowdfundr-campaign-add>Add campaign</button>
     <button type="submit">Save campaign list</button>
     <button type="button" data-crowdfundr-campaign-reload>Reload saved list</button>
     <p data-crowdfundr-campaign-save-status role="status" aria-live="polite"></p>
    </form>
   </details>
   <details data-crowdfundr-api>
   <summary>Advanced: transaction API connection</summary>
   <p data-crowdfundr-state role="status" aria-live="polite">Checking the connection…</p>
   <p data-crowdfundr-sync-time></p>
   <p data-crowdfundr-error role="status" aria-live="polite"></p>
   <details data-crowdfundr-setup>
     <summary>Connection setup</summary>
     <p>ConnectionPoint requires an approved app before Crowdfundr can authorize access. Register it in <a href="https://connectionpoint.com/apps" target="_blank" rel="noopener noreferrer">ConnectionPoint Apps</a>, using this exact callback URL:</p>
     <p><code data-crowdfundr-callback></code></p>
     <p>Only read-only campaign access is requested. No client secret or Crowdfundr password is needed here. Access credentials stay on the server and are never included in the supporter wall.</p>
     <form data-crowdfundr-config>
       <label>Approved app Client ID<input name="clientId" maxlength="240" autocomplete="off" spellcheck="false" required></label>
       <button type="submit">Save Client ID</button>
     </form>
   </details>
   <p>This connection is limited to the Written in the Dark retake campaign. Automatic publication activates only when the API supplies verified name and amount privacy choices. Existing CSV credits remain in place while that contract is being validated.</p>
   <button type="button" data-crowdfundr-connect disabled>Authorize read-only access</button>
   <button type="button" data-crowdfundr-sync disabled>Sync now</button>
   <button type="button" data-crowdfundr-disconnect disabled>Disconnect locally</button>
   <button type="button" data-crowdfundr-refresh>Refresh connection status</button>
   </details>
   <p data-crowdfundr-action-status role="status" aria-live="polite"></p>`;
 const find=selector=>host.querySelector(selector),form=find('[data-crowdfundr-config]'),status=find('[data-crowdfundr-action-status]');
 const connect=find('[data-crowdfundr-connect]'),sync=find('[data-crowdfundr-sync]'),disconnect=find('[data-crowdfundr-disconnect]');
 const publicEnable=find('[data-crowdfundr-public-enable]'),publicSync=find('[data-crowdfundr-public-sync]'),publicDisable=find('[data-crowdfundr-public-disable]');
 const campaignForm=find('[data-crowdfundr-campaign-form]'),campaignRows=find('[data-crowdfundr-campaign-rows]'),campaignSaveStatus=find('[data-crowdfundr-campaign-save-status]');
 const doc=host.ownerDocument;
 let settings=null,campaignsDirty=false,campaignRevision='';
 function campaignRow(campaign={id:'',title:'',active:false}){
  const row=doc.createElement('tr');
  function input(name,label,value,maxLength){
   const cell=row.insertCell(),field=doc.createElement('input');field.name=name;field.setAttribute('aria-label',label);
   if(name==='active'){field.type='checkbox';field.checked=value===true;}
   else{field.type='text';field.value=value;field.maxLength=maxLength;field.required=true;field.autocomplete='off';}
   field.addEventListener('input',()=>{campaignsDirty=true;});cell.append(field);return field;
  }
  input('id','Campaign ID',campaign.id,40);input('title','Campaign public title',campaign.title,120);input('active','Include in current credits',campaign.active);
  const remove=doc.createElement('button');remove.type='button';remove.textContent='Remove';remove.setAttribute('aria-label','Remove campaign');
  remove.onclick=()=>{row.remove();campaignsDirty=true;};row.insertCell().append(remove);campaignRows.append(row);
 }
 find('[data-crowdfundr-callback]').textContent=callback;
 function fill(data){
  settings=data;form.elements.clientId.value=data.clientId||'';
  publicEnable.disabled=data.publicFeedEnabled===true&&data.publicActive===true;
  publicSync.disabled=!data.publicFeedEnabled;publicDisable.disabled=!data.publicFeedEnabled;
  publicEnable.textContent=data.publicFeedEnabled?data.publicActive?'Automatic public credits enabled':'Retry public connection':'Enable automatic public credits';
  find('[data-crowdfundr-api]').open=!data.publicFeedEnabled;
  find('[data-crowdfundr-public-state]').textContent=data.publicFeedEnabled?
   data.publicActive?data.publicPartial?'Automatic public credits are connected for available campaigns. Some sources need attention below.':'Automatic public credits are connected. No new CSV is needed for public online Crowdfundr contributions.':'Automatic public credits need attention. Outdated privacy information is withheld after five minutes.':
   'Automatic public credits are not enabled. The wall currently uses imported Crowdfundr records.';
  find('[data-crowdfundr-public-time]').textContent='Last public campaign check: '+time(data.publicLastSync)+(Number.isInteger(data.publicCount)?' · '+data.publicCount+' all-time public online credits':'')+(Number.isInteger(data.publicCurrentCount)?' · '+data.publicCurrentCount+' current public online credits':'');
  find('[data-crowdfundr-public-error]').textContent=data.publicLastError||'';
  const campaigns=Array.isArray(data.publicCampaigns)?data.publicCampaigns:[];
  if(!campaignsDirty){campaignRevision=data.revision||'';campaignRows.replaceChildren();for(const campaign of campaigns)campaignRow(campaign);}
  find('[data-crowdfundr-campaign-summary]').textContent=campaigns.length+' campaigns in all-time credits · '+campaigns.filter(row=>row.active).length+' marked current'+(data.publicPartial?' · Some sources need attention.':'');
  const campaignStatus=find('[data-crowdfundr-campaign-status]');campaignStatus.replaceChildren();
  for(const campaign of Array.isArray(data.publicCampaignStatus)?data.publicCampaignStatus:[]){
   const row=doc.createElement('li');row.textContent=campaign.title+' — '+(campaign.active?'Current':'Past')+' · '+
    (campaign.fresh?'Last complete check: '+time(campaign.lastSync):'Privacy needs a successful check.')+
    (campaign.lastError?' '+campaign.lastError:'');campaignStatus.append(row);
  }
  connect.disabled=!data.clientId;sync.disabled=!data.connected;disconnect.disabled=!data.connected;
  connect.textContent=data.connected?'Reauthorize read-only access':'Authorize read-only access';
  find('[data-crowdfundr-setup]').open=!data.clientId;
  find('[data-crowdfundr-state]').textContent=!data.connected?'Not connected. Use the CSV importer below until the automatic connection is authorized.':
   data.active?'Connected read-only. Automatic checks run about every 15 minutes; verified changes appear on the wall within a few seconds after synchronization.':
   data.privacyReady?'Connected read-only. Automatic publication is paused because the latest check did not finish. Use Sync now to retry; the last confirmed supporter records remain in place.':
   'Connected read-only. Automatic publication is not activated because the name and amount privacy fields have not been validated. Existing CSV credits remain in place; use a newer CSV to update them.';
  find('[data-crowdfundr-sync-time]').textContent='Last completed synchronization: '+time(data.lastSync);
  find('[data-crowdfundr-error]').textContent=data.lastError||'';
 }
 async function refresh(){fill(await request('crowdfundrSettings'));}
 async function busy(button,run,notice=status){
  if(button.disabled)return;
  button.disabled=true;notice.textContent='';
  try{await run();}
  catch(error){notice.textContent=error.message||'The Crowdfundr connection could not be updated.';}
  finally{
   if(settings){connect.disabled=!settings.clientId;sync.disabled=!settings.connected;disconnect.disabled=!settings.connected;
    publicEnable.disabled=settings.publicFeedEnabled===true&&settings.publicActive===true;publicSync.disabled=!settings.publicFeedEnabled;publicDisable.disabled=!settings.publicFeedEnabled;}
   if(![connect,sync,disconnect,publicEnable,publicSync,publicDisable].includes(button))button.disabled=false;
  }
 }
 form.onsubmit=event=>{
  event.preventDefault();
  return busy(event.submitter,async()=>{
   fill(await request('crowdfundrSettings',{clientId:form.elements.clientId.value,revision:settings?.revision||''}));
   status.textContent='Client ID saved. Continue with Authorize read-only access.';
  });
 };
 find('[data-crowdfundr-campaign-add]').onclick=()=>{campaignRow();campaignsDirty=true;};
 campaignForm.onsubmit=event=>{
  event.preventDefault();
  return busy(event.submitter,async()=>{
   campaignSaveStatus.textContent='';
   const campaigns=[...campaignRows.querySelectorAll('tr')].map(row=>({id:row.querySelector('[name=id]').value.trim(),title:row.querySelector('[name=title]').value.trim(),active:row.querySelector('[name=active]').checked}));
   const result=await request('crowdfundrCampaigns',{revision:campaignRevision,campaigns});campaignsDirty=false;
   try{await refresh();}catch{campaignSaveStatus.textContent='Campaign list saved. Refresh connection status to verify the latest settings.';return;}
   campaignSaveStatus.textContent=result.statusPending?'Campaign list saved. '+result.warning:'Campaign list saved. Use Check public credits now to load new campaigns.';
  },campaignSaveStatus);
 };
 find('[data-crowdfundr-campaign-reload]').onclick=event=>busy(event.currentTarget,async()=>{
  campaignsDirty=false;await refresh();campaignSaveStatus.textContent='Saved campaign list reloaded.';
 },campaignSaveStatus);
 publicEnable.onclick=()=>busy(publicEnable,async()=>{
  const result=await request('crowdfundrPublicMode',{enabled:true,revision:settings?.revision||''});
  try{await refresh();}catch{status.textContent='Public campaign setting saved. Refresh connection status to verify activation.';return;}
  if(result.statusPending){status.textContent='Public campaign setting saved. '+result.warning;return;}
  status.textContent=settings.publicActive?'Automatic public credits are connected. Future public online contributions update without CSV imports.':
   'The public campaign connection could not be activated. The previous credits were retained.';
 });
 publicSync.onclick=()=>busy(publicSync,async()=>{
  const result=await request('crowdfundrPublicSync',{});
  try{await refresh();}catch{status.textContent='Public campaign check finished. Refresh connection status to review the result.';return;}
  if(result.statusPending){status.textContent='Public campaign check finished. '+result.warning;return;}
  status.textContent=settings.publicActive?'Public campaign credits checked. The wall refreshes within a few seconds.':'The public check did not finish. Review the connection status above.';
 });
 publicDisable.onclick=()=>busy(publicDisable,async()=>{
  const result=await request('crowdfundrPublicMode',{enabled:false,revision:settings?.revision||''});
  try{await refresh();}catch{status.textContent='Public campaign setting saved. Refresh connection status to verify the latest setting.';return;}
  if(result.statusPending){status.textContent='Public campaign setting saved. '+result.warning;return;}
  status.textContent='Automatic public credits are off. Crowdfundr recognition uses the saved CSV records again.';
 });
 connect.onclick=()=>busy(connect,async()=>{
  const result=await request('crowdfundrConnect',{}),url=new URL(result.url);
  if(url.origin!=='https://connectionpoint.com'||url.pathname!=='/oauth2/authorize')throw Error('Crowdfundr did not return the expected authorization page.');
  host.ownerDocument.defaultView.location.assign(url.href);
 });
 sync.onclick=()=>busy(sync,async()=>{
  await request('crowdfundrSync',{});await refresh();
  status.textContent=settings.active?'Crowdfundr synchronization completed. The supporter wall refreshes within a few seconds.':settings.privacyReady?
   'Automatic publication remains paused. Review the connection status above and use Sync now to retry.':
   'Automatic publication remains inactive until privacy fields are verified. Existing CSV supporters were preserved. Review the connection status above.';
 });
 disconnect.onclick=()=>busy(disconnect,async()=>{
  await request('crowdfundrDisconnect',{});await refresh();
  status.textContent='Local access credentials removed. Existing supporter records were preserved. To revoke the app at Crowdfundr too, remove its authorization in your ConnectionPoint account.';
 });
 find('[data-crowdfundr-refresh]').onclick=event=>busy(event.currentTarget,refresh);
 try{await refresh();}
 catch(error){status.textContent=error.message+' Use Refresh connection status to try again.';}
 return {refresh};
}
