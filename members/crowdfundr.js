const callback='https://heidimikacfilms.com/.netlify/functions/crowdfundr-callback';
const time=value=>{
 const date=new Date(value);
 return value&&Number.isFinite(date.valueOf())?date.toLocaleString():'Not yet completed';
};

export async function mountCrowdfundr(host,request){
 host.innerHTML=`
   <h3>Crowdfundr automatic connection</h3>
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
   <p data-crowdfundr-action-status role="status" aria-live="polite"></p>`;
 const find=selector=>host.querySelector(selector),form=find('[data-crowdfundr-config]'),status=find('[data-crowdfundr-action-status]');
 const connect=find('[data-crowdfundr-connect]'),sync=find('[data-crowdfundr-sync]'),disconnect=find('[data-crowdfundr-disconnect]');
 let settings=null;
 find('[data-crowdfundr-callback]').textContent=callback;
 function fill(data){
  settings=data;form.elements.clientId.value=data.clientId||'';
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
   if(settings){connect.disabled=!settings.clientId;sync.disabled=!settings.connected;disconnect.disabled=!settings.connected;}
   if(![connect,sync,disconnect].includes(button))button.disabled=false;
  }
 }
 form.onsubmit=event=>{
  event.preventDefault();
  return busy(event.submitter,async()=>{
   fill(await request('crowdfundrSettings',{clientId:form.elements.clientId.value,revision:settings?.revision||''}));
   status.textContent='Client ID saved. Continue with Authorize read-only access.';
  });
 };
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
