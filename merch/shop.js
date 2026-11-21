const endpoint='/.netlify/functions/merch';
const money=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
const usd=cents=>money.format(cents/100);
const cartKey='hmf-merch-cart-v1',pendingKey='hmf-merch-pending-v1';
const validOrder=id=>typeof id==='string'&&/^[A-Z0-9]{12,32}$/.test(id);

function cleanItems(value){
  if(!Array.isArray(value)||value.length>120)return [];
  const items=new Map();
  for(const item of value){
    if(!item||typeof item.sku!=='string'||!/^[-a-z0-9]{1,60}$/.test(item.sku)||!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>20)continue;
    items.set(item.sku,Math.min(20,(items.get(item.sku)||0)+item.quantity));
  }
  return [...items].map(([sku,quantity])=>({sku,quantity}));
}

function chosenName(value){
  const name=value.normalize('NFKC').trim().replace(/\s+/gu,' ');
  if(!name||[...name].length>60||/[<>\p{Cc}\p{Cf}\p{Cs}]/u.test(value)||/[<>\p{Cc}\p{Cf}\p{Cs}]/u.test(name))
    throw Error('Enter a plain-text display name of 60 characters or fewer.');
  return name;
}

export function createMerchShop({doc=document,win=window,fetcher=fetch,sdkLoader}={}){
  const find=selector=>doc.querySelector(selector);
  const dialog=find('#merch-cart'),list=find('[data-cart-items]'),status=find('[data-cart-status]');
  const recognition=find('[data-recognition-form]'),optIn=recognition.elements.public,nameInput=recognition.elements.displayName;
  const paymentSection=find('[data-payment-section]'),buttonArea=find('[data-paypal-buttons]');
  const checkoutButton=find('[data-start-checkout]'),checkButton=find('[data-check-payment]');
  const state={shop:null,cart:[],phase:'editing',generation:0,snapshot:null,pending:null,confirming:false,authorizing:false,instance:null,rendering:false,creating:null,createdIds:new Set(),recovered:false};
  let sdkPromise=null,sdkClientId=null,toastTimer=null;

  function storageRead(kind,key){try{return win[kind].getItem(key);}catch{return null;}}
  function storageWrite(kind,key,value){try{win[kind].setItem(key,value);return win[kind].getItem(key)===value;}catch{return false;}}
  function storageRemove(kind,key){try{win[kind].removeItem(key);}catch{}}
  function storedJson(key){
    for(const kind of ['sessionStorage','localStorage']){
      try{const raw=storageRead(kind,key);if(raw)return JSON.parse(raw);}catch{}
    }
    return null;
  }
  function saveCart(){
    const value=JSON.stringify(state.cart.map(({sku,quantity})=>({sku,quantity})));
    storageWrite('localStorage',cartKey,value);storageWrite('sessionStorage',cartKey,value);
  }
  function savedPending(kind){
    try{const value=JSON.parse(storageRead(kind,pendingKey));return validOrder(value?.orderId)?value:null;}catch{return null;}
  }
  function persistPending(){
    if(!state.pending)return false;
    const value=JSON.stringify({orderId:state.pending.orderId,items:state.pending.items.map(({sku,quantity})=>({sku,quantity}))});
    const sessionSaved=storageWrite('sessionStorage',pendingKey,value);
    const shared=savedPending('localStorage');
    const localSaved=(!shared||shared.orderId===state.pending.orderId)&&storageWrite('localStorage',pendingKey,value);
    return sessionSaved||localSaved;
  }
  function clearPending(){
    const orderId=state.pending?.orderId;
    for(const kind of ['sessionStorage','localStorage'])if(savedPending(kind)?.orderId===orderId)storageRemove(kind,pendingKey);
    state.pending=null;state.recovered=false;
  }
  function recoverPending(){
    if(state.pending)return true;
    const pending=savedPending('sessionStorage')||savedPending('localStorage');
    if(!pending)return false;
    cleanupPayment();
    state.pending={orderId:pending.orderId,items:cleanItems(pending.items)};
    if(!state.pending.items.length)state.pending.items=state.cart.map(item=>({...item}));
    state.phase='pending';state.recovered=true;optIn.checked=false;nameInput.value='';
    setStatus('An earlier payment needs confirmation. Your PayPal order keeps the total you approved. Use Check payment before placing another order.');
    render();return true;
  }
  function recoveryAvailable(){
    const key=pendingKey+'-check';let available=false;
    for(const kind of ['sessionStorage','localStorage']){
      if(storageWrite(kind,key,'1'))available=true;
      storageRemove(kind,key);
    }
    return available;
  }

  async function request(action,input){
    let response,data;
    const controller=new AbortController(),timer=win.setTimeout(()=>controller.abort(),20000);
    try{
      try{
        response=await fetcher(action?endpoint+'?action='+action:endpoint,{
          cache:'no-store',signal:controller.signal,...(input?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}:{})
        });
      }catch{throw Error('The connection was interrupted. Please try again.');}
      try{data=await response.json();}catch{throw Error('The shop could not read the payment response. Please try again.');}
      if(!response.ok){
        const error=Error(typeof data?.error==='string'?data.error:'The shop is temporarily unavailable.');
        error.code=data?.code;error.status=response.status;throw error;
      }
      return data;
    }finally{win.clearTimeout(timer);}
  }

  function loadSdk(clientId){
    if(sdkPromise&&sdkClientId!==clientId)return Promise.reject(Error('Checkout settings changed. Refresh this page before paying.'));
    if(sdkPromise)return sdkPromise;
    sdkClientId=clientId;
    if(sdkLoader){sdkPromise=Promise.resolve().then(()=>sdkLoader(clientId)).catch(error=>{sdkPromise=null;throw error;});return sdkPromise;}
    sdkPromise=new Promise((resolve,reject)=>{
      const script=doc.createElement('script');
      const timer=win.setTimeout(()=>fail(),20000);
      function fail(){win.clearTimeout(timer);script.remove();sdkPromise=null;reject(Error('PayPal checkout could not load. Please try again.'));}
      script.async=true;
      script.src='https://www.paypal.com/sdk/js?'+new URLSearchParams({'client-id':clientId,currency:'USD',intent:'capture',components:'buttons','enable-funding':'card,venmo'});
      script.onload=()=>{win.clearTimeout(timer);if(win.paypal?.Buttons)resolve(win.paypal);else fail();};
      script.onerror=fail;doc.head.append(script);
    });
    return sdkPromise;
  }

  const locked=()=>['refreshing','payment','pending'].includes(state.phase);
  function metadata(sku){
    for(const product of state.shop?.products||[]){
      const variant=product.variants.find(value=>value.id===sku);
      if(variant)return {product,variant};
    }
    return null;
  }
  function totals(items=state.cart){
    let subtotal=0,available=Boolean(state.shop)&&items.length>0;
    for(const item of items){
      const info=metadata(item.sku),price=info?.product.price;
      if(!info?.variant.available||!Number.isInteger(price)||price<=0)available=false;
      if(Number.isInteger(price))subtotal+=price*item.quantity;
    }
    const shipping=items.length&&Number.isInteger(state.shop?.shipping)?state.shop.shipping:0;
    return {subtotal,shipping,total:subtotal+shipping,available:available&&Number.isInteger(state.shop?.shipping)};
  }
  function toast(message){
    const area=find('[data-cart-toast]');area.textContent=message;area.hidden=false;
    if(toastTimer)win.clearTimeout(toastTimer);
    toastTimer=win.setTimeout(()=>{area.hidden=true;},4500);
  }
  function setStatus(message){status.textContent=message;}
  function renderProducts(){
    for(const product of state.shop?.products||[]){
      const card=find('[data-product="'+product.id+'"]');if(!card)continue;
      const options=card.querySelector('[data-options]'),previous=options.querySelector('input:checked')?.value;
      const price=card.querySelector('[data-price]'),delivered=card.querySelector('[data-delivered]'),message=card.querySelector('[data-status]');
      const priced=Number.isInteger(product.price)&&product.price>0,available=product.variants.some(variant=>variant.available);
      price.textContent=priced?usd(product.price):'Coming soon';
      delivered.textContent=priced&&Number.isInteger(state.shop.shipping)?usd(product.price+state.shop.shipping)+' with U.S. shipping':'';
      options.replaceChildren();
      if(product.variants.length>1){
        const sizes=doc.createElement('fieldset'),legend=doc.createElement('legend');
        sizes.className='merch-sizes product-size-options';legend.textContent='Choose your size';sizes.append(legend);
        for(const variant of product.variants){
          const label=doc.createElement('label'),input=doc.createElement('input'),text=doc.createElement('span');
          input.type='radio';input.name=product.id+'-size';input.value=variant.id;input.disabled=locked()||!variant.available;
          input.checked=previous===variant.id&&variant.available;
          text.textContent=variant.label;
          if(variant.soldOut){input.setAttribute('aria-label',variant.label+' · Sold out');label.title=variant.label+' · Sold out';}
          input.addEventListener('change',()=>{message.textContent='';});
          label.append(input,text);sizes.append(label);
        }
        options.append(sizes);
      }
      const add=card.querySelector('[data-add]');add.disabled=locked()||!priced||!available;
      add.onclick=()=>{
        const sku=product.variants.length===1?product.variants[0].id:options.querySelector('input:checked')?.value;
        if(!sku){message.textContent='Choose your shirt size first.';options.querySelector('input:not(:disabled)')?.focus();return;}
        if(addItem(sku))message.textContent=(product.variants.length>1?product.name+' · '+metadata(sku).variant.label:product.name)+' added to your cart.';
      };
      card.classList.toggle('merch-unavailable',!available);
      message.textContent=!available?'Sold out':!priced?'Coming soon':locked()?'Finish or edit your current checkout to change the cart.':'';
    }
    if(Number.isInteger(state.shop?.shipping))for(const note of doc.querySelectorAll('[data-shipping-note]'))
      note.textContent=state.shop.shipping?usd(state.shop.shipping)+' U.S. shipping per order, even with multiple items.':'Free U.S. shipping on your merch order.';
  }
  function renderCart(){
    const items=state.pending?.items||state.cart,hasItems=items.length>0,isSuccess=state.phase==='success';
    for(const count of doc.querySelectorAll('[data-cart-count]'))count.textContent=String(state.cart.reduce((sum,item)=>sum+item.quantity,0));
    find('[data-cart-success]').hidden=!isSuccess;
    find('[data-cart-empty]').hidden=isSuccess||hasItems||Boolean(state.pending);
    find('[data-cart-filled]').hidden=isSuccess||(!hasItems&&!state.pending);
    list.replaceChildren();
    for(const item of items){
      const info=metadata(item.sku),row=doc.createElement('li'),copy=doc.createElement('div'),heading=doc.createElement('h3'),variant=doc.createElement('p');
      row.className='cart-item';copy.className='cart-item-copy';
      heading.textContent=info?.product.name||'Merchandise';variant.textContent=info?.variant.label||'Previously selected item';
      if(info&&!info.variant.available&&!state.pending)variant.textContent+=' · Currently unavailable';
      copy.append(heading,variant);
      const controls=doc.createElement('div'),label=doc.createElement('label'),quantity=doc.createElement('select'),remove=doc.createElement('button'),price=doc.createElement('span');
      controls.className='cart-item-controls';label.textContent='Quantity';quantity.className='cart-quantity';
      quantity.setAttribute('aria-label','Quantity for '+heading.textContent+' '+variant.textContent);
      for(let number=1;number<=20;number++){
        const option=doc.createElement('option');option.value=String(number);option.textContent=String(number);quantity.append(option);
      }
      quantity.value=String(item.quantity);quantity.disabled=locked();
      quantity.addEventListener('change',()=>changeQuantity(item.sku,Number(quantity.value)));
      label.append(quantity);remove.type='button';remove.className='cart-remove';remove.textContent='Remove';remove.disabled=locked();
      remove.setAttribute('aria-label','Remove '+heading.textContent+' '+variant.textContent);remove.addEventListener('click',()=>changeQuantity(item.sku,0));
      controls.append(label,remove);price.className='cart-item-price';
      price.textContent=state.recovered?'In your PayPal order':Number.isInteger(info?.product.price)?usd(info.product.price*item.quantity):'Unavailable';
      row.append(copy,controls,price);list.append(row);
    }
    const amount=state.snapshot&&!state.recovered?state.snapshot.amount:totals(items);
    find('[data-subtotal]').textContent=state.recovered?'See PayPal order':usd(amount.subtotal);
    find('[data-shipping]').textContent=state.recovered?'See PayPal order':usd(amount.shipping);
    find('[data-total]').textContent=state.recovered?'See PayPal order':usd(amount.total);
    optIn.disabled=locked();nameInput.disabled=locked()||!optIn.checked;
    find('[data-recognition-name]').hidden=!optIn.checked;
    recognition.hidden=Boolean(state.pending)&&state.recovered;
    checkoutButton.hidden=state.phase!=='editing';
    checkoutButton.disabled=!state.shop?.clientId||!amount.available||!hasItems;
    find('[data-edit-cart]').disabled=state.phase!=='payment'||state.authorizing||Boolean(state.creating);
    paymentSection.hidden=state.phase!=='payment';
    checkButton.hidden=!state.pending;checkButton.disabled=state.confirming;
    checkButton.textContent=state.confirming?'Checking payment…':'Check payment';
    if(state.phase==='editing'&&hasItems&&!state.shop?.clientId&&!status.textContent)setStatus('Online checkout is currently unavailable. Your cart is saved.');
  }
  function render(){renderProducts();renderCart();}
  function addItem(sku){
    if(locked())return false;
    const info=metadata(sku);if(!info?.variant.available||!Number.isInteger(info.product.price))return false;
    const existing=state.cart.find(item=>item.sku===sku);
    if(existing?.quantity===20){toast('You can add up to 20 of each item or size.');return false;}
    if(existing)existing.quantity++;else state.cart.push({sku,quantity:1});
    state.phase='editing';setStatus('');saveCart();renderCart();toast('Added to your cart.');return true;
  }
  function changeQuantity(sku,quantity){
    if(locked()||!Number.isInteger(quantity)||quantity<0||quantity>20)return;
    state.cart=state.cart.flatMap(item=>item.sku!==sku?[item]:quantity?[{sku,quantity}]:[]);
    setStatus('');saveCart();renderCart();
  }
  function openCart(){
    if(!dialog.open)dialog.showModal();
    if(state.phase==='payment')void renderPayment(state.generation);
  }
  function cleanupPayment(){
    state.generation++;state.rendering=false;state.authorizing=false;state.creating=null;state.createdIds=new Set();
    const previous=state.instance;state.instance=null;
    if(previous?.close)try{Promise.resolve(previous.close()).catch(()=>{});}catch{}
    buttonArea.replaceChildren();paymentSection.hidden=true;state.snapshot=null;
  }
  function editCart(message=''){
    if(state.pending||state.confirming||state.authorizing)return;
    cleanupPayment();state.phase='editing';setStatus(message);render();
  }
  async function refreshShop(){
    const shop=await request();
    if(!Array.isArray(shop.products))throw Error('Product availability could not be loaded.');
    state.shop=shop;return shop;
  }
  async function beginCheckout(){
    if(recoverPending()){openCart();return;}
    if(state.phase!=='editing'||state.pending||!state.cart.length)return;
    if(!state.shop?.clientId){setStatus('Online checkout is currently unavailable. Your cart is saved.');return;}
    let publicName='';
    try{if(optIn.checked)publicName=chosenName(nameInput.value);}catch(error){setStatus(error.message);nameInput.focus();return;}
    if(!recoveryAvailable()){setStatus('Allow this website to use browser storage so your payment can be safely recovered, then try again.');return;}
    const previous=totals(),generation=++state.generation;
    state.phase='refreshing';setStatus('Checking current prices and availability…');render();
    try{
      await refreshShop();
      if(generation!==state.generation)return;
      const amount=totals();
      if(!state.shop.clientId||!amount.available||amount.total!==previous.total||amount.shipping!==previous.shipping){
        state.phase='editing';render();setStatus(!amount.available?'An item is no longer available. Update your cart before checking out.':!state.shop.clientId?'Online checkout is currently unavailable. Your cart is saved.':'Prices or shipping changed. Review the updated total, then continue.');return;
      }
      state.snapshot=Object.freeze({items:Object.freeze(state.cart.map(item=>Object.freeze({...item}))),recognition:Object.freeze({public:optIn.checked,name:optIn.checked?publicName:'',showAmount:true}),amount:Object.freeze(amount)});
      state.phase='payment';setStatus('Loading secure checkout…');render();
      await renderPayment(generation);
    }catch(error){if(generation===state.generation)editCart(error.message);}
  }

  async function renderPayment(generation){
    if(generation!==state.generation||state.phase!=='payment'||state.instance||state.rendering||!dialog.open)return;
    state.rendering=true;
    try{
      const paypal=await loadSdk(state.shop.clientId);
      if(generation!==state.generation||state.phase!=='payment')return;
      if(!dialog.open){state.rendering=false;return;}
      const snapshot=state.snapshot;
      const instance=paypal.Buttons({
        style:{layout:'vertical',label:'checkout'},
        onClick(_data,actions){
          if(recoverPending()){openCart();return actions.reject();}
          if(generation!==state.generation||state.phase!=='payment'||state.pending||state.creating||state.authorizing)return actions.reject();
          state.authorizing=true;renderCart();return actions.resolve();
        },
        async createOrder(){
          if(recoverPending()){openCart();throw Error('An earlier payment needs confirmation.');}
          if(generation!==state.generation||state.phase!=='payment'||state.pending)throw Error('This checkout is no longer active.');
          if(state.creating)return state.creating;
          state.authorizing=true;renderCart();
          state.creating=(async()=>{
            try{
              const result=await request('create',{items:snapshot.items.map(item=>({...item})),donation:0,recognition:{...snapshot.recognition}});
              if(!validOrder(result.id))throw Error('PayPal did not return a valid order. Please try again.');
              if(generation!==state.generation)throw Error('This checkout is no longer active.');
              state.createdIds.add(result.id);return result.id;
            }catch(error){if(generation===state.generation&&!state.pending){state.authorizing=false;editCart(error.message);}throw error;}
            finally{if(generation===state.generation){state.creating=null;renderCart();}}
          })();
          return state.creating;
        },
        async onApprove(data,actions){
          if(generation!==state.generation||!validOrder(data.orderID)||!state.createdIds.has(data.orderID))return;
          if(state.pending&&state.pending.orderId!==data.orderID)return;
          state.pending={orderId:data.orderID,items:snapshot.items.map(item=>({...item}))};state.phase='pending';state.recovered=false;
          persistPending();render();openCart();
          return checkPayment(actions,generation);
        },
        onCancel(){if(generation===state.generation&&!state.pending){state.authorizing=false;renderCart();setStatus('Checkout canceled. Your cart is saved. You can try again or edit it.');}},
        onError(){if(generation===state.generation&&!state.pending){state.authorizing=false;editCart('Checkout could not start. Your cart is saved; please try again.');}}
      });
      state.instance=instance;await instance.render(buttonArea);
      if(generation===state.generation&&state.phase==='payment')setStatus('Review your total above, then choose how to pay.');
    }catch(error){if(generation===state.generation&&!state.pending)editCart(error.message||'PayPal checkout could not load.');}
    finally{if(generation===state.generation)state.rendering=false;}
  }

  async function checkPayment(actions,generation=state.generation){
    if(!state.pending||state.confirming)return;
    if(!persistPending()){setStatus('Payment confirmation is paused. Keep this page open and try Check payment again.');renderCart();return;}
    const pending=state.pending;state.confirming=true;state.phase='pending';setStatus('Confirming your payment…');render();
    try{
      const result=await request('capture',{orderId:pending.orderId});
      if(state.pending?.orderId!==pending.orderId)return;
      if(result.code==='INSTRUMENT_DECLINED'){
        clearPending();state.confirming=false;state.authorizing=false;
        if(actions?.restart&&generation===state.generation&&state.snapshot){
          state.phase='payment';state.authorizing=true;render();setStatus('That payment option was declined. Please choose another.');
          try{return await actions.restart();}catch{state.authorizing=false;editCart('That payment option was declined. Continue to checkout to try another.');}
        }else editCart('That payment option was declined. Continue to checkout to try another.');
        return;
      }
      if(result.status==='paid'){
        const purchased=new Map(pending.items.map(item=>[item.sku,item.quantity]));
        state.cart=state.cart.flatMap(item=>{const quantity=Math.max(0,item.quantity-(purchased.get(item.sku)||0));return quantity?[{sku:item.sku,quantity}]:[];});
        clearPending();saveCart();cleanupPayment();state.phase='success';
        optIn.checked=false;nameInput.value='';
        if(win.dispatchEvent&&win.Event)win.dispatchEvent(new win.Event('hmf-supporters-refresh'));
        find('[data-order-reference]').textContent='Order reference '+(typeof result.reference==='string'?result.reference:pending.orderId)+'.';
        render();openCart();
        try{await refreshShop();render();}catch{}
      }else if(['failed','refunded','partially refunded'].includes(result.status)){
        clearPending();state.confirming=false;state.authorizing=false;
        editCart(result.status==='failed'?'Payment was declined. Your cart is saved; you can choose another payment option.':'PayPal reports this order as '+result.status+'. Contact us if you need help with the order.');
      }else{
        setStatus('Your payment is still being verified. Check it again before placing another order. Order reference '+pending.orderId+'.');
      }
    }catch(error){
      if(error.code==='NOT_CHARGED'){
        clearPending();state.confirming=false;state.authorizing=false;editCart(error.message+' Update your cart before trying again.');
        try{await refreshShop();render();}catch{}
      }else setStatus(error.message+' Your payment may still be processing. Use Check payment before trying another order. Order reference '+pending.orderId+'.');
    }finally{state.confirming=false;renderCart();}
  }

  async function start(){
    state.cart=cleanItems(storedJson(cartKey));
    const pending=savedPending('sessionStorage')||savedPending('localStorage');
    if(validOrder(pending?.orderId)){
      state.pending={orderId:pending.orderId,items:cleanItems(pending.items)};state.phase='pending';state.recovered=true;
      if(!state.pending.items.length)state.pending.items=state.cart.map(item=>({...item}));
    }
    optIn.checked=false;nameInput.value='';
    win.addEventListener?.('focus',()=>{recoverPending();});
    win.addEventListener?.('storage',event=>{if(event.key===pendingKey)recoverPending();});
    for(const button of doc.querySelectorAll('[data-open-cart]'))button.addEventListener('click',openCart);
    for(const button of doc.querySelectorAll('[data-close-cart]'))button.addEventListener('click',()=>dialog.close());
    find('[data-finish-order]').addEventListener('click',()=>{state.phase='editing';setStatus('');render();dialog.close();});
    find('[data-edit-cart]').addEventListener('click',()=>editCart());
    checkoutButton.addEventListener('click',()=>void beginCheckout());
    checkButton.addEventListener('click',()=>void checkPayment());
    recognition.addEventListener('submit',event=>event.preventDefault());
    optIn.addEventListener('change',()=>{find('[data-recognition-name]').hidden=!optIn.checked;nameInput.disabled=!optIn.checked||locked();if(optIn.checked)nameInput.focus();});
    try{
      await refreshShop();
      if(!state.pending){state.cart=state.cart.filter(item=>metadata(item.sku));saveCart();}
      render();
      if(state.pending){setStatus('An earlier payment needs confirmation. Your PayPal order keeps the total you approved. Use Check payment before placing another order.');openCart();}
    }catch(error){
      for(const message of doc.querySelectorAll('[data-product] [data-status]'))message.textContent='Availability could not be loaded. Refresh this page to try again.';
      renderCart();
      if(state.pending){setStatus('An earlier payment needs confirmation. Use Check payment before placing another order.');openCart();}
      else setStatus(error.message);
    }
  }
  return {start,openCart,addItem,changeQuantity,beginCheckout,editCart,checkPayment,inspect:()=>({phase:state.phase,cart:state.cart.map(item=>({...item})),pending:state.pending?.orderId||null,generation:state.generation})};
}

if(typeof document!=='undefined')void createMerchShop().start();
