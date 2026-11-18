const items=[['blu-ray','Written in the Light Blu-ray'],...['S','M','L','XL','XXL'].map(size=>['shirt-'+size.toLowerCase(),'Peach Tea Lady · '+size])];
const currency=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
const money=cents=>currency.format(cents/100);
const cents=value=>value===''?null:Math.round(Number(value)*100);
const csv=value=>{
  const text=String(value??'');
  const safe=/^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(text)||/^[\t\r\n]/u.test(text)?"'"+text:text;
  return '"'+safe.replaceAll('"','""')+'"';
};
const saleItems=sale=>Array.isArray(sale.items)?sale.items:[{
  name:sale.product,variant:sale.variant,quantity:sale.quantity,unit:null
}];
const quantity=sale=>saleItems(sale).reduce((sum,item)=>sum+item.quantity,0);
const lineSummary=item=>item.quantity+' × '+[item.name,item.variant].filter(Boolean).join(' · ')
  +(Number.isFinite(item.unit)?' · '+money(item.unit)+' each':'');
const hasPublicPermission=sale=>sale.recognition?.public===true&&typeof sale.recognition.name==='string'&&!!sale.recognition.name.trim();

export async function mountMerch(panel,request){
  if(panel.dataset.mounted)return;
  panel.dataset.mounted='true';
  const template=panel.querySelector('[data-merch-content]');
  template.textContent='Loading inventory and sales…';
  try{
    const [settings,{sales}]=await Promise.all([request('merchSettings'),request('merchSales')]);
    template.innerHTML=`
      <form data-inventory>
        <h3>Inventory and checkout</h3><p data-paypal></p>
        <label><input type="checkbox" name="enabled"> Enable PayPal and card checkout</label>
        <label>U.S. shipping per order ($)<input name="shipping" type="number" min="0" max="1000" step=".01"></label>
        <label>Blu-ray price ($)<input name="blu-ray-price" type="number" min=".01" max="1000" step=".01" required></label>
        <label>T-shirt price ($)<input name="shirt-price" type="number" min=".01" max="1000" step=".01"></label>
        <p>Set a stock count to 0 to mark it sold out. Leave it blank if stock is unconfirmed.</p>
        <div class="merch-admin-grid">${items.map(([id,label])=>`<label>${label}<input name="${id}" type="number" min="0" max="100000" step="1"></label>`).join('')}</div>
        <button type="submit">Save merch settings</button><p data-save role="status"></p>
      </form>
      <form data-sale>
        <h3>Record an offline sale</h3>
        <p>Record a Venmo or other offline payment here to deduct stock and include it in reports.</p>
        <div class="merch-admin-grid">
          <label>Item<select name="sku">${items.map(([id,label])=>`<option value="${id}">${label}</option>`).join('')}</select></label>
          <label>Quantity<input name="quantity" type="number" min="1" max="20" value="1" required></label>
          <label>Payment method<select name="channel"><option>Venmo</option><option>Other</option></select></label>
          <label>Amount received ($)<input name="total" type="number" min=".01" max="20000" step=".01" required></label>
        </div>
        <button type="submit">Record sale</button><p data-sale-status role="status"></p>
      </form>
      <h3>Sales report</h3>
      <div class="merch-admin-grid">
        <label>From<input type="date" data-from></label>
        <label>Through<input type="date" data-through></label>
        <label>Item<select data-product><option value="">All items</option><option>Written in the Light</option><option>Peach Tea Lady</option></select></label>
      </div>
      <button type="button" data-refresh>Refresh sales</button> <button type="button" data-export>Export CSV</button>
      <p data-report-status role="status"></p><p data-total></p>
      <p>Item filters include the full order and its total. Public names require the buyer's recorded permission and a paid order.</p>
      <div class="merch-admin-scroll" tabindex="0" aria-label="Sales report table">
        <table><thead><tr><th>Date</th><th>Items</th><th>Qty</th><th>Payment</th><th>Status</th><th>Order total</th><th>Reference</th><th>Supporter name</th></tr></thead><tbody></tbody></table>
      </div>`;
    const find=selector=>template.querySelector(selector);
    const inventory=find('[data-inventory]'), fields=inventory.elements;
    const offline=find('[data-sale]'), rows=find('tbody');
    const reportStatus=find('[data-report-status]');
    let revision,all=sales,filtered=[],manualId=crypto.randomUUID();
    function fill(values){
      revision=values.revision;
      fields.enabled.disabled=!values.paypalReady;
      fields.enabled.checked=values.enabled;
      find('[data-paypal]').textContent=values.paypalReady?'PayPal is configured for this site.':'PayPal account setup is pending.';
      const amounts={shipping:values.shipping,'blu-ray-price':values.prices['blu-ray'],'shirt-price':values.prices['peach-tea-lady']};
      for(const [name,value] of Object.entries(amounts))fields[name].value=value===null?'':(value/100).toFixed(2);
      for(const [id] of items)fields[id].value=values.stock[id]??'';
    }
    function render(){
      const from=find('[data-from]').value, through=find('[data-through]').value, product=find('[data-product]').value;
      const start=from?new Date(from+'T00:00:00').valueOf():0;
      const end=through?new Date(through+'T23:59:59.999').valueOf():Infinity;
      filtered=all.filter(sale=>sale.date>=start&&sale.date<=end&&(!product||saleItems(sale).some(item=>item.name===product)));
      const paid=filtered.filter(sale=>['paid','refunded','partially refunded'].includes(sale.status));
      find('[data-total]').textContent=paid.length+' captured orders · '+paid.reduce((n,sale)=>n+quantity(sale),0)+' units · '+money(paid.reduce((n,sale)=>n+sale.total,0))+' gross collected';
      rows.replaceChildren();
      for(const sale of filtered){
        const row=rows.insertRow();
        row.insertCell().textContent=new Date(sale.date).toLocaleString();
        const lines=row.insertCell(),orderItems=saleItems(sale);
        for(const item of orderItems){
          const line=document.createElement('div');
          line.textContent=lineSummary(item);
          lines.append(line);
        }
        if(!orderItems.length)lines.textContent=sale.product||'No merchandise';
        for(const value of [quantity(sale),sale.channel,sale.status,money(sale.total),sale.captureId||sale.id]){
          row.insertCell().textContent=value;
        }
        const reference=row.lastElementChild;
        if(sale.channel==='PayPal checkout'){
          const button=document.createElement('button');
          button.type='button';
          button.textContent='Check PayPal';
          button.onclick=()=>busy(button,reportStatus,async ()=>{
            await request('merchCheckPayment',{orderId:sale.id});
            await reload();
            reportStatus.textContent='PayPal status checked.';
          });
          reference.append(' ',button);
        }
        const recognition=row.insertCell();
        if(hasPublicPermission(sale)){
          const name=document.createElement('div'),visibility=document.createElement('div'),button=document.createElement('button');
          name.textContent=sale.recognition.name;
          visibility.textContent=sale.supporterHidden?'Hidden':sale.status==='paid'?'Public display allowed':'Not shown — order is not paid';
          button.type='button';
          button.textContent=sale.supporterHidden?'Show public name':'Hide public name';
          button.onclick=()=>busy(button,reportStatus,async ()=>{
            const result=await request('merchSupporterVisibility',{orderId:sale.id,hidden:!sale.supporterHidden});
            sale.supporterHidden=result.hidden;
            render();
            reportStatus.textContent=result.hidden?'Public supporter name hidden.':'Public display allowed for this opted-in name when the order is paid.';
          });
          recognition.append(name,visibility,button);
        }else{
          recognition.textContent='No public-name permission';
        }
      }
      if(!filtered.length){const empty=rows.insertRow().insertCell();empty.colSpan=8;empty.textContent='No sales in this range.';}
    }
    async function reload(){
      all=(await request('merchSales')).sales;
      render();
    }
    async function busy(button,status,operation){
      button.disabled=true;status.textContent='';
      try{await operation();}
      catch(error){status.textContent=error.message;}
      finally{button.disabled=false;}
    }
    inventory.onsubmit=event=>{
      event.preventDefault();
      const input={
        revision,enabled:fields.enabled.checked,shipping:cents(fields.shipping.value),
        prices:{'blu-ray':cents(fields['blu-ray-price'].value),'peach-tea-lady':cents(fields['shirt-price'].value)},
        stock:Object.fromEntries(items.map(([id])=>[id,fields[id].value===''?null:fields[id].valueAsNumber]))
      };
      const status=find('[data-save]');
      return busy(event.submitter,status,async ()=>{
        fill(await request('merchSettings',input));
        status.textContent='Merch settings saved.';
      });
    };
    offline.oninput=()=>{manualId=crypto.randomUUID();};
    offline.onsubmit=event=>{
      event.preventDefault();
      const status=find('[data-sale-status]'), form=offline.elements;
      return busy(event.submitter,status,async ()=>{
        await request('merchManualSale',{id:manualId,sku:form.sku.value,quantity:form.quantity.valueAsNumber,total:cents(form.total.value),channel:form.channel.value});
        manualId=crypto.randomUUID();
        offline.reset();
        status.textContent='Sale recorded.';
        try{fill(await request('merchSettings'));await reload();}
        catch{status.textContent='Sale recorded. Reload this page to refresh inventory and reports.';}
      });
    };
    template.onchange=event=>{if(event.target.matches('[data-from],[data-through],[data-product]'))render();};
    find('[data-refresh]').onclick=event=>busy(event.target,reportStatus,reload);
    find('[data-export]').onclick=()=>{
      const data=[['Date','Line items','Quantity','Payment','Status','Gross USD','Shipping USD','PayPal capture ID','Order ID','Public name opt-in','Display name','Public name hidden'],
        ...filtered.map(sale=>[new Date(sale.date).toISOString(),saleItems(sale).map(lineSummary).join('; '),quantity(sale),sale.channel,sale.status,
          (sale.total/100).toFixed(2),sale.shipping==null?'':(sale.shipping/100).toFixed(2),sale.captureId,sale.id,
          hasPublicPermission(sale)?'Yes':'No',hasPublicPermission(sale)?sale.recognition.name:'',hasPublicPermission(sale)?(sale.supporterHidden?'Yes':'No'):''])];
      const url=URL.createObjectURL(new Blob([data.map(row=>row.map(csv).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
      const link=document.createElement('a');
      link.href=url;link.download='heidi-mikac-films-merch-sales.csv';link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    fill(settings);render();
  }catch(error){
    delete panel.dataset.mounted;
    const retry=document.createElement('button');
    retry.type='button';retry.textContent='Retry';
    retry.onclick=()=>mountMerch(panel,request);
    template.replaceChildren(error.message+' ',retry);
  }
}
