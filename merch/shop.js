const endpoint='/.netlify/functions/merch';
const money=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
const usd=cents=>money.format(cents/100);

async function request(action,input){
  const response=await fetch(action?endpoint+'?action='+action:endpoint,input?{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)
  }:undefined);
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'The shop is temporarily unavailable.');
  return data;
}

function paypalSdk(clientId){
  return new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src='https://www.paypal.com/sdk/js?'+new URLSearchParams({
      'client-id':clientId,currency:'USD',intent:'capture',components:'buttons','enable-funding':'card'
    });
    script.onload=()=>resolve(window.paypal);
    script.onerror=()=>reject(Error('PayPal checkout could not load.'));
    document.head.append(script);
  });
}

function mountProduct(product,shop,sdk){
  const card=document.querySelector('[data-product="'+product.id+'"]');
  const buy=card.querySelector('[data-buy]'), status=card.querySelector('[data-status]');
  const price=card.querySelector('[data-price]');
  const available=product.variants.some(variant=>variant.available);
  const soldOut=product.variants.every(variant=>variant.soldOut);
  card.querySelector('[data-shirt-loading]')?.remove();
  price.hidden=product.price===null;
  price.textContent=product.price===null?'':usd(product.price);
  card.classList.toggle('merch-unavailable',soldOut);
  for(const link of card.querySelectorAll('[data-venmo]'))link.hidden=soldOut;
  const hostedPayPal=card.querySelector('[data-paypal-link]');
  if(hostedPayPal)hostedPayPal.hidden=Boolean(sdk)||!available||product.price!==4000||shop.shipping!==500;
  buy.replaceChildren();

  const sizes=document.createElement('fieldset');
  sizes.className='merch-sizes';
  if(product.variants.length>1){
    const legend=document.createElement('legend');
    legend.textContent='Size';
    sizes.append(legend);
    for(const variant of product.variants){
      const label=document.createElement('label'), input=document.createElement('input');
      input.type='radio';
      input.name='shirt-size';
      input.value=variant.id;
      input.disabled=!variant.available;
      label.append(input,' '+variant.label+(variant.soldOut?' · Sold out':''));
      sizes.append(label);
    }
    buy.append(sizes);
  }
  if(soldOut){status.textContent='Sold out';return;}
  if(shop.shipping!==null){
    const shipping=document.createElement('p');
    shipping.className='merch-note';
    shipping.textContent=shop.shipping?usd(shop.shipping)+' shipping per order · U.S. only':'Free U.S. shipping';
    buy.append(shipping);
  }
  if(!sdk||!available||!product.price){
    if(product.id==='peach-tea-lady')status.textContent=available&&product.price?'Online ordering is currently unavailable.':'Coming soon';
    return;
  }

  const quantityLabel=document.createElement('label');
  quantityLabel.className='merch-quantity';
  quantityLabel.textContent='Quantity';
  const quantity=document.createElement('input');
  Object.assign(quantity,{type:'number',min:'1',max:'20',value:'1',required:true});
  quantityLabel.append(quantity);

  const buttons=document.createElement('div');
  buttons.className='merch-checkout';
  buy.append(quantityLabel,buttons);

  let specificError=false;
  const selection=()=>product.variants.length===1?product.variants[0].id:sizes.querySelector(':checked')?.value;
  function paymentRetry(data,actions){
    buttons.replaceChildren();
    const retry=document.createElement('button');
    retry.type='button';
    retry.textContent='Check payment';
    retry.onclick=()=>{retry.disabled=true;return confirmPayment(data,actions);};
    buttons.append(retry);
  }

  async function confirmPayment(data,actions){
    try{
      status.textContent='Confirming your payment…';
      const result=await request('capture',{orderId:data.orderID});
      if(result.code==='INSTRUMENT_DECLINED')return actions.restart();
      if(result.status==='paid'){
        buttons.replaceChildren();
        status.textContent='Payment received. Order reference '+result.reference+'.';
        for(const input of buy.querySelectorAll('input'))input.disabled=true;
      }else if(result.status==='failed'){
        buttons.replaceChildren();
        status.textContent='Payment was declined. Refresh the page to start a new order.';
      }else{
        status.textContent='Payment is being verified. Order reference '+data.orderID+'.';
        paymentRetry(data,actions);
      }
    }catch(error){
      status.textContent=error.message+' Order reference '+data.orderID+'.';
      paymentRetry(data,actions);
    }
  }
  sdk.then(paypal=>paypal.Buttons({
    style:{layout:'vertical',label:'checkout'},
    onClick(_data,actions){
      specificError=false;
      status.textContent='';
      if(!selection()||!quantity.checkValidity()){
        status.textContent='Choose an available size and enter a quantity from 1 to 20.';
        return actions.reject();
      }
      return actions.resolve();
    },
    async createOrder(){
      try{
        return (await request('create',{sku:selection(),quantity:quantity.valueAsNumber})).id;
      }catch(error){
        specificError=true;
        status.textContent=error.message;
        throw error;
      }
    },
    onApprove:confirmPayment,
    onCancel(){status.textContent='Checkout canceled.';},
    onError(){if(!specificError)status.textContent='Checkout could not start. Please try again.';}
  }).render(buttons)).catch(()=>{status.textContent='PayPal checkout could not load. Please refresh to try again.';});
}

async function start(){
  const shop=await request();
  const sdk=shop.clientId?paypalSdk(shop.clientId):null;
  // Handle SDK failure even when no product currently has stock.
  sdk?.catch(()=>{});
  for(const product of shop.products)mountProduct(product,shop,sdk);
}
start().catch(()=>{
  document.querySelector('[data-product="peach-tea-lady"] [data-status]').textContent='Availability could not be loaded. Please refresh to try again.';
});
