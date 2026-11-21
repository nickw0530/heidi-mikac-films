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
   <p>Automatic public credits follow the online contributions Crowdfundr makes public, including anonymous names and private amounts. The site checks the complete campaign feed about every two minutes. Imported transactions stay in your records and are not counted again on the wall.</p>
   <p>This mirrors public campaign activity. It does not confirm bank settlement or refund accounting. Record offline payments here, and use Hide payment if a refunded contribution remains in Crowdfundr’s public activity.</p>
   <button type="button" data-crowdfundr-public-enable>Enable automatic public credits</button>
   <button type="button" data-crowdfundr-public-sync disabled>Check public credits now</button>
   <button type="button" data-crowdfundr-public-disable disabled>Use CSV credits instead</button>
   <p data-crowdfundr-public-error role="status" aria-live="polite"></p>
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
 let settings=null;
 find('[data-crowdfundr-callback]').textContent=callback;
 function fill(data){
  settings=data;form.elements.clientId.value=data.clientId||'';
  publicEnable.disabled=data.publicFeedEnabled===true&&data.publicActive===true;
  publicSync.disabled=!data.publicFeedEnabled;publicDisable.disabled=!data.publicFeedEnabled;
  publicEnable.textContent=data.publicFeedEnabled?data.publicActive?'Automatic public credits enabled':'Retry public connection':'Enable automatic public credits';
  find('[data-crowdfundr-api]').open=!data.publicFeedEnabled;
  find('[data-crowdfundr-public-state]').textContent=data.publicFeedEnabled?
   data.publicActive?'Automatic public credits are connected. No new CSV is needed for public online Crowdfundr contributions.':'Automatic public credits need attention. Outdated privacy information is withheld after five minutes.':
   'Automatic public credits are not enabled. The wall currently uses imported Crowdfundr records.';
  find('[data-crowdfundr-public-time]').textContent='Last public campaign check: '+time(data.publicLastSync)+(Number.isInteger(data.publicCount)?' · '+data.publicCount+' public online credits':'');
  find('[data-crowdfundr-public-error]').textContent=data.publicLastError||'';
  connect.disabled=!data.clientId;sync.disabled=!data.connected;disconnect.disabled=!data.connected;
  connect.textContent=data.connected?'Reauthorize read-only access':'Authorize read-only access';
  find('[data-crowdfundr-setup]').open=!data.clientId;
  find('[data-crowdfundr-state]').textContent=!data.connected?'Not connected. Use the CSV importer below until the automatic connection is authorized.':
   data.active?'Connected read-only. Automatic checks run about every two minutes; verified changes appear on the wall within a few seconds after synchronization.':
   data.privacyReady?'Connected read-only. Automatic publication is paused because the latest check did not finish. Use Sync now to retry; the last confirmed supporter records remain in place.':
   'Connected read-only. Automatic publication is not activated because the name and amount privacy fields have not been validated. Existing CSV credits remain in place; use a newer CSV to update them.';
  find('[data-crowdfundr-sync-time]').textContent='Last completed synchronization: '+time(data.lastSync);
  find('[data-crowdfundr-error]').textContent=data.lastError||'';
 }
 async function refresh(){fill(await request('crowdfundrSettings'));}
 async function busy(button,run){
  if(button.disabled)return;
  button.disabled=true;status.textContent='';
  try{await run();}
  catch(error){status.textContent=error.message||'The Crowdfundr connection could not be updated.';}
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
 publicEnable.onclick=()=>busy(publicEnable,async()=>{
  await request('crowdfundrPublicMode',{enabled:true,revision:settings?.revision||''});await refresh();
  status.textContent=settings.publicActive?'Automatic public credits are connected. Future public online contributions update without CSV imports.':
   'The public campaign connection could not be activated. The previous credits were retained.';
 });
 publicSync.onclick=()=>busy(publicSync,async()=>{
  await request('crowdfundrPublicSync',{});await refresh();
  status.textContent=settings.publicActive?'Public campaign credits checked. The wall refreshes within a few seconds.':'The public check did not finish. Review the connection status above.';
 });
 publicDisable.onclick=()=>busy(publicDisable,async()=>{
  await request('crowdfundrPublicMode',{enabled:false,revision:settings?.revision||''});await refresh();
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
