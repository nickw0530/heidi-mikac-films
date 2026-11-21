import {randomUUID} from 'node:crypto';
import {check,checkoutCart,dollars,merchStore,orderItems,paypalConfig,publicShop,readShop,updateShop} from '../lib/merch.mjs';
import {paymentIdentity,publicSupporters} from '../lib/supporters.mjs';

const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const json=(data,status=200)=>Response.json(data,{status,headers});
const usd=cents=>({currency_code:'USD',value:dollars(cents)});
const beforeCharge=(ok,message,status=400)=>{
  if(!ok)throw Object.assign(new Error(message),{status,code:'NOT_CHARGED'});
};

async function paypalClient(config){
  const auth=await fetch(config.base+'/v1/oauth2/token',{
    method:'POST',headers:{Authorization:'Basic '+Buffer.from(config.clientId+':'+config.secret).toString('base64'),
      'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials',signal:AbortSignal.timeout(7000)
  });
  check(auth.ok,'PayPal is temporarily unavailable.',502);
  const {access_token}=await auth.json();
  return async (path,{id,body}={})=>{
    const response=await fetch(config.base+'/v2/checkout/orders'+path,{
      method:body?'POST':'GET',
      headers:{Authorization:'Bearer '+access_token,...(body?{'Content-Type':'application/json','PayPal-Request-Id':id,Prefer:'return=representation'}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(7000)
    });
    const data=await response.json();
    return {ok:response.ok,data};
  };
}

export async function createOrder(store,config,input){
  const {shop}=await readShop(store);
  check(shop.settings.enabled&&config,'Online checkout is currently unavailable.',503);
  const cart=checkoutCart(shop,input);
  const id=randomUUID(),paypal=await paypalClient(config);
  const order={...cart,id,version:2,createdAt:Date.now()};
  const result=await paypal('',{id,body:{
    intent:'CAPTURE',
    purchase_units:[{custom_id:id,amount:{...usd(cart.total),breakdown:{item_total:usd(cart.subtotal),shipping:usd(cart.shipping)}},
      items:cart.items.map(item=>({name:item.name+' · '+item.variant,sku:item.sku,category:'PHYSICAL_GOODS',
        unit_amount:usd(item.unit),quantity:String(item.quantity)}))}]
  }});
  check(result.ok&&result.data.id,'PayPal could not start checkout. Try again.',502);
  verifyOrder(result.data,order);
  // Unapproved checkout sessions stay outside the sales and inventory ledger.
  await store.setJSON('checkout/'+result.data.id,order);
  return json({id:result.data.id});
}

function matchesAmount(amount,cents){
  return amount?.currency_code==='USD'&&amount.value===dollars(cents);
}

function verifyOrder(data,order){
  const unit=data.purchase_units?.[0],items=orderItems(order);
  check(data.purchase_units?.length===1&&unit?.custom_id===order.id,'Order could not be verified.',409);
  check(matchesAmount(unit.amount,order.total),'Payment total requires review.',502);
  // New carts require the full representation. Historical single-item orders
  // retain their original verification behavior if PayPal omits item details.
  if(order.version===2||unit.amount.breakdown){
    check(matchesAmount(unit.amount.breakdown?.item_total,order.total-order.shipping)&&
      (matchesAmount(unit.amount.breakdown?.shipping,order.shipping)||order.shipping===0&&!unit.amount.breakdown?.shipping),
      'Payment breakdown requires review.',502);
  }
  if(order.version===2||unit.items){
    check(unit.items?.length===items.length&&items.every(item=>unit.items.some(actual=>
      actual.sku===item.sku&&actual.quantity===String(item.quantity)&&matchesAmount(actual.unit_amount,item.unit))),
      'Order items require review.',502);
  }
  return unit;
}

function releaseStock(state,sale){
  if(sale.stockReleased||sale.stockReserved===false)return;
  for(const item of orderItems(sale))state.settings.stock[item.sku]=(state.settings.stock[item.sku]??0)+item.quantity;
  sale.stockReleased=true;
}

function captureResult(data,order){
  const captures=data.purchase_units?.[0]?.payments?.captures;
  const capture=captures?.[0];
  if(!capture)return null;
  check(captures.length===1&&matchesAmount(capture.amount,order.total),'Payment total requires review.',502);
  if(['COMPLETED','PENDING','DECLINED','FAILED','REFUNDED','PARTIALLY_REFUNDED'].includes(capture.status))return capture;
  return null;
}

function paymentResponse(sale){
  return json({status:sale?.status||'processing',reference:sale?.captureId||null});
}

export async function captureOrder(store,config,orderId,{refresh=false}={}){
  check(config,'Online checkout is currently unavailable.',503);
  check(typeof orderId==='string'&&/^[A-Z0-9]{12,32}$/.test(orderId),'Invalid PayPal order.');
  const order=await store.get('checkout/'+orderId,{type:'json'});
  check(order,'Order not found.',404);
  let existing=(await readShop(store)).shop.sales[orderId];
  if(existing&&['paid','failed','refunded','partially refunded'].includes(existing.status)&&!refresh)return paymentResponse(existing);
  const paypal=await paypalClient(config), detail=await paypal('/'+orderId);
  check(detail.ok,'PayPal could not verify this order. Try again.',502);
  const unit=verifyOrder(detail.data,order),items=orderItems(order);
  // Another request may have completed this order during PayPal verification.
  existing=(await readShop(store)).shop.sales[orderId];
  if(existing&&['paid','failed','refunded','partially refunded'].includes(existing.status)&&!refresh)return paymentResponse(existing);

  if(!existing){
    check(detail.data.status==='APPROVED','Approve your payment in PayPal first.',409);
    if(items.length)beforeCharge(unit.shipping?.address?.country_code==='US','Checkout currently ships to U.S. addresses only.');
    existing=await updateShop(store,state=>{
      if(state.sales[orderId])return {unchanged:true,value:state.sales[orderId]};
      beforeCharge(state.settings.enabled,'Online checkout is currently unavailable.',503);
      // Validate the whole cart before changing any quantity; the conditional
      // write commits every reservation and its sale record together.
      for(const item of items)beforeCharge(state.settings.stock[item.sku]>=item.quantity,'An item sold out during checkout. You were not charged.',409);
      for(const item of items)state.settings.stock[item.sku]-=item.quantity;
      state.sales[orderId]={...order,items,donation:order.donation??0,channel:'PayPal checkout',status:'processing',stockReserved:true,stockReleased:false};
      return state.sales[orderId];
    });
  }

  let capture=captureResult(detail.data,order);
  if(existing?.paidAt){
    if(!refresh||!capture||!['REFUNDED','PARTIALLY_REFUNDED'].includes(capture.status))return paymentResponse(existing);
    const sale=await updateShop(store,state=>{
      const current=state.sales[orderId];
      current.status=capture.status==='REFUNDED'?'refunded':'partially refunded';
      return current;
    });
    return paymentResponse(sale);
  }
  if(existing?.status==='failed')return paymentResponse(existing);
  if(!capture&&detail.data.status==='APPROVED'){
    // Retrying the same capture uses the same PayPal idempotency key.
    const claim=await updateShop(store,state=>{
      const sale=state.sales[orderId];
      if(sale?.status!=='processing'||sale.captureLease>Date.now())return {unchanged:true,value:null};
      sale.captureLease=Date.now()+30000;
      sale.attemptId??=randomUUID();
      return sale.attemptId;
    });
    if(!claim)return paymentResponse((await readShop(store)).shop.sales[orderId]);
    const result=await paypal('/'+orderId+'/capture',{id:claim,body:{}});
    capture=captureResult(result.data,order);
    if(!capture){
      const verified=await paypal('/'+orderId);
      if(verified.ok)capture=captureResult(verified.data,order);
      if(!capture&&verified.ok&&verified.data.status==='APPROVED'&&result.data.details?.some(issue=>issue.issue==='INSTRUMENT_DECLINED')){
        // A funding decline releases the reservation so the buyer can retry.
        const released=await updateShop(store,state=>{
          const sale=state.sales[orderId];
          if(sale?.status!=='processing'||sale.attemptId!==claim)return {unchanged:true,value:false};
          releaseStock(state,sale);
          delete state.sales[orderId];
          return true;
        });
        if(released)return json({code:'INSTRUMENT_DECLINED'});
        return paymentResponse((await readShop(store)).shop.sales[orderId]);
      }
    }
  }
  if(!capture&&existing&&detail.data.status==='VOIDED'){
    const sale=await updateShop(store,state=>{
      const sale=state.sales[orderId];
      if(sale?.status!=='processing')return {unchanged:true,value:sale};
      releaseStock(state,sale);
      sale.status='failed';
      return sale;
    });
    return paymentResponse(sale);
  }
  if(!capture)return paymentResponse({status:'processing'});
  const final=await updateShop(store,state=>{
    const sale=state.sales[orderId];
    if(!sale||!['processing','pending'].includes(sale.status))return {unchanged:true,value:sale};
    const status={COMPLETED:'paid',PENDING:'pending',DECLINED:'failed',FAILED:'failed',REFUNDED:'refunded',PARTIALLY_REFUNDED:'partially refunded'}[capture.status];
    if(status==='failed')releaseStock(state,sale);
    Object.assign(sale,{status,captureId:capture.id,supporterIdentity:paymentIdentity(detail.data.payer),...(['paid','refunded','partially refunded'].includes(status)?{paidAt:Date.parse(capture.create_time)||Date.now()}:{}),orderId});
    return sale;
  });
  return paymentResponse(final||{status:'processing'});
}

export default async function handle(req){
  try{
    const url=new URL(req.url),action=url.searchParams.get('action');
    const production=['heidimikacfilms.com','www.heidimikacfilms.com'].includes(url.hostname);
    const config=paypalConfig(production),store=merchStore(production);
    if(req.method==='GET'&&action==='supporters')return json({supporters:publicSupporters((await readShop(store)).shop)});
    if(req.method==='GET'&&!action)return json(publicShop((await readShop(store)).shop,config));
    check(req.method==='POST','Unsupported method.',405);
    check(req.headers.get('origin')===url.origin,'Origin rejected.',403);
    const input=await req.json();
    if(action==='create')return await createOrder(store,config,input);
    if(action==='capture')return await captureOrder(store,config,input.orderId);
    check(false,'Unknown action.',404);
  }catch(error){
    if(!error.status)console.error('Merch checkout failed',error.name);
    return json({error:error.status?error.message:'The shop is temporarily unavailable. Please try again.',...(error.code==='NOT_CHARGED'?{code:error.code}:{})},error.status||500);
  }
}
