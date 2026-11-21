import {mountCrowdfundr} from './crowdfundr.js';
const currency=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
const money=value=>Number.isInteger(value)?currency.format(value/100):'Not confirmed';
const cents=value=>value===''?null:Math.round(Number(value)*100);
const statuses=['paid','pending','failed','refunded','partially refunded'];
const needsAnonymousAmount=row=>row.source==='crowdfundr-public'&&row.showName===false&&row.showAmount===false;
const anonymousAmount=row=>Number.isSafeInteger(row.anonymousGross)&&row.anonymousGross>0?row.anonymousGross:null;

export function importSummary(summary={}){
  return ['new','updated','unchanged','excluded','duplicates'].map(key=>(summary[key]||0)+' '+key).join(' · ');
}

export function transactionLabel(row){
  return [row.name||'Anonymous supporter',row.source,row.campaignTitle,row.reference||row.id].filter(Boolean).join(' · ');
}

// All personal data stays within the existing authenticated portal. Dynamic
// values are assigned as text, never interpolated into markup or persisted.
export async function mountSupporters(host,request){
  const doc=host.ownerDocument;
  host.innerHTML=`
    <h3>Supporter wall management</h3>
    <p>Paid website merchandise appears here automatically as support, not a charitable donation. Do not record the same purchase again. Crowdfundr imports and manual support are combined with those orders, with each payment kept separately for duplicate checks.</p>
    <p>New website purchases offer a public-name choice and publish the merchandise support amount. Anonymous contributions show their verified amounts while keeping names private. Existing private amount choices for named supporters remain preserved. Pending, failed, refunded, hidden and duplicate payments do not count. A partial refund needs a confirmed refund amount before its remainder can count.</p>
    <button type="button" data-supporter-refresh>Refresh supporters</button>
    <p data-supporter-status role="status" aria-live="polite"></p>
    <details data-supporter-import>
      <summary>Import Crowdfundr transactions CSV</summary>
      <p>Export an all-time transactions report from Crowdfundr. This is a manual import, not a live Crowdfundr connection. Private names stay protected. Anonymous contribution amounts are public; named supporters retain their saved amount preferences. Fees and contact details never appear on the public wall. Importing an existing transaction updates it instead of counting it again.</p>
      <form data-supporter-preview-form>
        <label>Transactions CSV<input type="file" name="file" accept=".csv,text/csv" required></label>
        <button type="submit">Preview import</button>
      </form>
      <p data-supporter-import-status role="status" aria-live="polite"></p>
      <div data-supporter-preview hidden>
        <p data-supporter-preview-summary></p>
        <div class="merch-admin-scroll" tabindex="0" aria-label="Crowdfundr import preview">
          <table><thead><tr><th>Change</th><th>Transaction</th><th>Supporter</th><th>Gross support</th><th>Status</th><th>Public preferences</th><th>Review</th></tr></thead><tbody data-supporter-preview-rows></tbody></table>
        </div>
        <p>Review the records and privacy choices above before importing. Website payments with the same payment-provider reference are counted once.</p>
        <button type="button" data-supporter-import-confirm>Confirm CSV import</button>
        <button type="button" data-supporter-import-cancel>Cancel preview</button>
      </div>
    </details>
    <details data-supporter-manual>
      <summary>Add or edit offline / alternative support</summary>
      <form data-supporter-manual-form>
        <p data-supporter-edit-label>New manual support record</p>
        <div class="merch-admin-grid">
          <label>Supporter name<input name="name" maxlength="60" autocomplete="off"></label>
          <label>Gross support before fees ($)<input name="gross" type="number" min=".01" max="20000" step=".01" required></label>
          <label>Payment method<input name="channel" maxlength="80" placeholder="Cash, Venmo, bank transfer…" required></label>
          <label>Payment provider<select name="processor"><option value="">Other / offline</option><option value="paypal">PayPal</option><option value="stripe">Stripe</option></select></label>
          <label>Transaction reference<input name="reference" maxlength="100" autocomplete="off"></label>
          <label>Payment status<select name="status">${statuses.map(value=>'<option>'+value+'</option>').join('')}</select></label>
          <label>Confirmed amount refunded ($)<input name="refunded" type="number" min="0" max="20000" step=".01" placeholder="Blank if unknown"></label>
          <label>Verified supporter email (optional; private)<input name="identityEmail" type="email" maxlength="254" autocomplete="off"></label>
          <label>Verified same supporter as (optional)<select name="sameSupporterAs"><option value="">Keep current identity / separate supporter</option></select></label>
        </div>
        <p>Use the actual provider transaction reference to catch payments already recorded through another channel. Only enter a verified email or choose a matching supporter after confirming they are the same person. A name alone is not proof. Leaving identity fields blank when editing retains the existing identity.</p>
        <label><input name="showName" type="checkbox"> Supporter gave permission to show this name</label>
        <label><input name="showAmount" type="checkbox"> Named supporter gave permission to show the amount</label>
        <label><input name="hidden" type="checkbox"> Hide this payment from the supporter wall</label>
        <button type="submit">Save manual support</button>
        <button type="button" data-supporter-new>Start new record</button>
        <p data-supporter-manual-status role="status" aria-live="polite"></p>
      </form>
    </details>
    <form data-supporter-moderation hidden>
      <h4>Supporter and payment review</h4>
      <p data-supporter-moderation-label></p>
      <label>Verified same supporter as<select name="sameSupporterAs"><option value="">Separate supporter / no verified match</option></select></label>
      <p>Choose only after confirming these names belong to the same person. Their eligible support totals combine; each payment keeps its own privacy and visibility settings.</p>
      <label>This is the same payment as<select name="duplicateOf"><option value="">Not a duplicate payment</option></select></label>
      <p>Choose only if these records describe the same payment. Repeat payments from one supporter are separate transactions and should both count.</p>
      <div data-supporter-anonymous-amount hidden>
        <label>Verified anonymous contribution amount ($)<input name="anonymousGross" type="number" min=".01" max="20000" step=".01" disabled></label>
        <p>Enter the exact amount from the campaign owner’s transaction report. Leave blank when it is not verified. Do not enter an estimate or a placeholder zero. Clearing a saved amount removes this verification without changing the private name.</p>
      </div>
      <button type="submit">Save supporter review</button>
      <button type="button" data-supporter-moderation-cancel>Cancel</button>
      <p data-supporter-moderation-status role="status" aria-live="polite"></p>
    </form>
    <h4>All support records</h4>
    <p data-supporter-count></p>
    <div class="merch-admin-scroll" tabindex="0" aria-label="Support transaction ledger">
      <table><thead><tr><th>Source / date</th><th>Supporter</th><th>Gross / refunded</th><th>Status / wall</th><th>Payment reference</th><th>Public preferences</th><th>Manage</th></tr></thead><tbody data-supporter-ledger-rows></tbody></table>
    </div>
    <details data-supporter-deleted hidden>
      <summary>Deleted manual records</summary>
      <p>Deleted manual records do not count toward supporter totals. Restoring a record keeps its previous privacy and visibility settings.</p>
      <div class="merch-admin-scroll" tabindex="0" aria-label="Deleted manual support records">
        <table><thead><tr><th>Supporter</th><th>Gross support</th><th>Reference</th><th>Manage</th></tr></thead><tbody data-supporter-deleted-rows></tbody></table>
      </div>
    </details>`;
  const find=selector=>host.querySelector(selector);
  const overall=find('[data-supporter-status]'),manual=find('[data-supporter-manual-form]'),fields=manual.elements;
  const moderation=find('[data-supporter-moderation]'),importForm=find('[data-supporter-preview-form]');
  const preview=find('[data-supporter-preview]'),confirm=find('[data-supporter-import-confirm]');
  let revision,transactions=[],manualId='manual:'+crypto.randomUUID(),moderating=null,importState=null,previewGeneration=0;
  let pending=0;
  const rowNotices=new Map(),rowStatuses=new Map();
  function element(tag,text){const node=doc.createElement(tag);if(text!==undefined)node.textContent=String(text);return node;}
  function rowNotice(id,message){rowNotices.set(id,message);const status=rowStatuses.get(id);if(status)status.textContent=message;}
  function button(label,run,status=overall,rowId=''){const node=element('button',label);node.type='button';node.onclick=()=>busy(node,status,run,rowId);return node;}
  async function busy(trigger,status,run,rowId=''){
    if(trigger.disabled)return;
    const message=text=>rowId?rowNotice(rowId,text):status.textContent=text;
    trigger.disabled=true;pending++;message('');
    try{await run();}
    catch(error){message(error.message||'Supporter management is temporarily unavailable. Please try again.');}
    finally{pending--;trigger.disabled=false;}
  }
  function cancelPreview(){previewGeneration++;importState=null;preview.hidden=true;confirm.disabled=true;find('[data-supporter-preview-rows]').replaceChildren();}
  function populate(select,exclude=''){
    const previous=select.value;
    select.replaceChildren(element('option',select.name==='sameSupporterAs'?(select===fields.sameSupporterAs?'Keep current identity / separate supporter':'Separate supporter / no verified match'):'Not a duplicate payment'));
    select.firstElementChild.value='';
    for(const row of transactions){
      if(row.id===exclude||row.archived)continue;
      const option=element('option',transactionLabel(row));option.value=row.id;select.append(option);
    }
    select.value=previous;
  }
  function resetManual(){
    manual.reset();manualId='manual:'+crypto.randomUUID();
    find('[data-supporter-edit-label]').textContent='New manual support record';
    fields.status.value='paid';populate(fields.sameSupporterAs,manualId);
    find('[data-supporter-manual-status]').textContent='';
  }
  function edit(row){
    resetManual();manualId=row.id;
    find('[data-supporter-edit-label]').textContent='Editing '+transactionLabel(row);
    for(const key of ['name','channel','reference','processor','status'])fields[key].value=row[key]||'';
    fields.gross.value=Number.isInteger(row.gross)?(row.gross/100).toFixed(2):'';
    fields.refunded.value=Number.isInteger(row.refunded)?(row.refunded/100).toFixed(2):'';
    for(const key of ['showName','showAmount','hidden'])fields[key].checked=row[key]===true;
    populate(fields.sameSupporterAs,row.id);
    find('[data-supporter-manual]').open=true;fields.name.focus();
  }
  function review(row){
    moderating=row;moderation.hidden=false;
    find('[data-supporter-moderation-label]').textContent=transactionLabel(row);
    populate(moderation.elements.sameSupporterAs,row.id);
    if(row.sameSupporterAs&&!transactions.some(record=>record.id===row.sameSupporterAs&&!record.archived)){
      const option=element('option','Existing verified match — record currently unavailable');option.value=row.sameSupporterAs;moderation.elements.sameSupporterAs.append(option);
    }
    moderation.elements.sameSupporterAs.value=row.sameSupporterAs||'';
    populate(moderation.elements.duplicateOf,row.id);moderation.elements.duplicateOf.value=row.duplicateOf||'';
    const verifyAmount=needsAnonymousAmount(row),verified=anonymousAmount(row);
    find('[data-supporter-anonymous-amount]').hidden=!verifyAmount;
    moderation.elements.anonymousGross.disabled=!verifyAmount;
    moderation.elements.anonymousGross.value=verifyAmount&&verified!==null?(verified/100).toFixed(2):'';
    find('[data-supporter-moderation-status]').textContent='';moderation.elements.duplicateOf.focus();
  }
  async function archiveManual(record,archived){
    await request('supporterModerate',{id:record.id,revision,moderationRevision:record.moderationRevision,hidden:record.hidden===true,archived});
    await reload();
    if(transactions.find(row=>row.id===record.id)?.archived!==archived)throw Error('The manual record change could not be confirmed. Refresh supporters to review it.');
    overall.textContent=archived?'Manual record deleted. It can be restored under Deleted manual records.':'Manual record restored with its previous visibility settings.';
  }
  function render(){
    const rows=find('[data-supporter-ledger-rows]');rows.replaceChildren();
    rowStatuses.clear();
    const active=transactions.filter(record=>!record.archived),deleted=transactions.filter(record=>record.source==='manual'&&record.archived);
    find('[data-supporter-count]').textContent=active.length+' payment and public activity records. Public campaign activity replaces Crowdfundr imports on the wall when enabled; imported copies remain here for reference.';
    for(const record of active){
      const row=rows.insertRow();
      const date=new Date(record.date),dateText=Number.isFinite(date.valueOf())?date.toLocaleString():'';
      row.insertCell().textContent=[record.source==='crowdfundr-public'?'Crowdfundr public activity':record.source,record.campaignTitle,dateText].filter(Boolean).join(' · ');
      row.insertCell().textContent=record.name||'Anonymous supporter';
      const unknownPublicAmount=record.source==='crowdfundr-public'&&!record.showAmount&&!record.amountVerified;
      row.insertCell().textContent=(unknownPublicAmount?needsAnonymousAmount(record)?'Amount not verified':'Private amount':money(record.gross))+' / '+(record.source==='crowdfundr-public'?'not reported':record.refunded==null?'unknown':money(record.refunded));
      row.insertCell().textContent=[record.status,record.hidden?'Hidden':'',record.duplicateOf?'Duplicate — excluded':'',record.sameSupporterAs?'Verified supporter match':'',record.warning||''].filter(Boolean).join(' · ');
      row.insertCell().textContent=[record.channel,record.processor,record.reference||record.id].filter(Boolean).join(' · ');
      const anonymousPublic=!record.showName&&record.gross>0&&(record.source!=='crowdfundr-public'||record.showAmount||record.amountVerified);
      row.insertCell().textContent='Name: '+(record.showName?'allowed':'private')+' · Amount: '+(record.amountVerified?'verified public':record.showAmount||anonymousPublic?'public':needsAnonymousAmount(record)?'verification needed':'private');
      const actions=row.insertCell();
      const visibilityStatus=element('p',rowNotices.get(record.id)||'');
      visibilityStatus.dataset.supporterRowStatus=record.id;
      visibilityStatus.setAttribute('role','status');visibilityStatus.setAttribute('aria-live','polite');
      rowStatuses.set(record.id,visibilityStatus);
      actions.append(button(record.hidden?'Show payment':'Hide payment',async()=>{
        overall.textContent='';
        const hidden=!record.hidden;
        await request('supporterModerate',{id:record.id,revision,moderationRevision:record.moderationRevision,hidden,duplicateOf:record.duplicateOf||''});
        await reload();
        const updated=transactions.find(transaction=>transaction.id===record.id);
        if(!updated||updated.hidden!==hidden)throw Error('Visibility could not be confirmed. Refresh supporters to review this payment.');
        rowNotice(record.id,hidden?'Payment hidden.':'Payment shown.');
        overall.textContent='Supporter visibility saved. The public wall refreshes within a few seconds.';
      },visibilityStatus,record.id));
      actions.append(' ',button('Review supporter / duplicate',async()=>review(record)));
      if(record.source==='manual')actions.append(' ',button('Edit',async()=>edit(record)),' ',button('Delete manual record',async()=>archiveManual(record,true)));
      actions.append(visibilityStatus);
    }
    if(!active.length){const cell=rows.insertRow().insertCell();cell.colSpan=7;cell.textContent='No support transactions yet.';}
    const deletedRows=find('[data-supporter-deleted-rows]');deletedRows.replaceChildren();find('[data-supporter-deleted]').hidden=!deleted.length;
    for(const record of deleted){
      const row=deletedRows.insertRow();
      for(const value of [record.name||'Anonymous supporter',money(record.gross),record.reference||record.id])row.insertCell().textContent=value;
      row.insertCell().append(button('Restore manual record',async()=>archiveManual(record,false)));
    }
    populate(fields.sameSupporterAs,manualId);
  }
  async function reload(){
    const data=await request('supporterLedger');revision=data.revision;transactions=data.transactions||[];
    cancelPreview();moderation.hidden=true;moderating=null;render();
  }
  importForm.elements.file.onchange=()=>{cancelPreview();find('[data-supporter-import-status]').textContent='';};
  importForm.onsubmit=event=>{
    event.preventDefault();
    return busy(event.submitter,find('[data-supporter-import-status]'),async()=>{
      cancelPreview();const generation=previewGeneration,file=importForm.elements.file.files[0];
      if(!file)throw Error('Choose a Crowdfundr transactions CSV.');
      if(file.size>2*1024*1024)throw Error('Choose a CSV smaller than 2 MB.');
      const csv=await file.text(),data=await request('supporterPreview',{csv});
      if(generation!==previewGeneration)return;
      importState={csv,digest:data.digest,revision:data.revision};
      find('[data-supporter-preview-summary]').textContent=importSummary(data.summary);
      const rows=find('[data-supporter-preview-rows]');rows.replaceChildren();
      for(const record of data.rows||[]){
        const row=rows.insertRow();
        for(const value of [record.change,record.reference||record.id,record.name||'Anonymous supporter',money(record.gross),record.status,
          'Name: '+(record.showName?'allowed':'private')+' · Amount: '+(!record.showName?'public':record.showAmount?'allowed':'private'),record.warning||''])row.insertCell().textContent=value??'';
      }
      preview.hidden=false;confirm.disabled=false;
      find('[data-supporter-import-status]').textContent='Preview ready. No records have been imported yet.';
    });
  };
  confirm.onclick=()=>busy(confirm,find('[data-supporter-import-status]'),async()=>{
    const state=importState;if(!state)throw Error('Preview this CSV before importing.');
    const result=await request('supporterImport',state);
    await reload();importForm.reset();
    find('[data-supporter-import-status]').textContent='Import saved: '+importSummary(result.summary)+'. The public wall refreshes within a few seconds.';
  });
  find('[data-supporter-import-cancel]').onclick=()=>{cancelPreview();find('[data-supporter-import-status]').textContent='Preview cancelled. No records imported.';};
  manual.onsubmit=event=>{
    event.preventDefault();
    return busy(event.submitter,find('[data-supporter-manual-status]'),async()=>{
      const input={id:manualId,revision,name:fields.name.value,gross:cents(fields.gross.value),refunded:cents(fields.refunded.value),
        channel:fields.channel.value,processor:fields.processor.value,reference:fields.reference.value,status:fields.status.value,
        showName:fields.showName.checked,showAmount:fields.showAmount.checked,hidden:fields.hidden.checked};
      if(fields.identityEmail.value.trim())input.identityEmail=fields.identityEmail.value.trim();
      if(fields.sameSupporterAs.value)input.sameSupporterAs=fields.sameSupporterAs.value;
      if(input.showName&&!input.name.trim())throw Error('Enter the permitted public name, or leave name permission unchecked.');
      if(input.status==='partially refunded'&&input.refunded===null)throw Error('Enter the confirmed refund amount for a partially refunded payment.');
      await request('supporterSave',input);await reload();resetManual();
      find('[data-supporter-manual-status]').textContent='Manual support saved. The public wall refreshes within a few seconds.';
    });
  };
  find('[data-supporter-new]').onclick=resetManual;
  moderation.onsubmit=event=>{
    event.preventDefault();
    return busy(event.submitter,find('[data-supporter-moderation-status]'),async()=>{
      if(!moderating)throw Error('Choose a payment to review.');
      const input={id:moderating.id,revision,moderationRevision:moderating.moderationRevision,hidden:moderating.hidden===true,duplicateOf:moderation.elements.duplicateOf.value};
      if(moderation.elements.sameSupporterAs.value!==(moderating.sameSupporterAs||''))input.sameSupporterAs=moderation.elements.sameSupporterAs.value;
      if(needsAnonymousAmount(moderating)){
        const verified=cents(moderation.elements.anonymousGross.value);
        if(verified!==null&&(!Number.isSafeInteger(verified)||verified<=0||verified>2000000))throw Error('Enter the exact verified amount between $0.01 and $20,000, or leave it blank.');
        if(verified!==anonymousAmount(moderating))input.anonymousGross=verified;
      }
      await request('supporterModerate',input);
      await reload();overall.textContent='Supporter review saved. The public wall refreshes within a few seconds.';
    });
  };
  find('[data-supporter-moderation-cancel]').onclick=()=>{moderation.hidden=true;moderating=null;};
  find('[data-supporter-refresh]').onclick=event=>busy(event.currentTarget,overall,async()=>{await reload();overall.textContent='Support transactions refreshed.';});
  resetManual();
  const connectionHost=doc.createElement('section');
  connectionHost.dataset.crowdfundrAdmin='';
  host.prepend(connectionHost);
  await mountCrowdfundr(connectionHost,request);
  try{await reload();}
  catch(error){overall.textContent=error.message+' Use Refresh supporters to try again.';}
  return {reload,get pending(){return pending;}};
}
