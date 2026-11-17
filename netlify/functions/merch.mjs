import {randomUUID} from 'node:crypto';
import {check,dollars,lineItem,merchStore,paypalConfig,publicShop,readShop,updateShop} from '../lib/merch.mjs';

const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const json=(data,status=200)=>Response.json(data,{status,headers});
const usd=cents=>({currency_code:'USD',value:dollars(cents)});

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

async function createOrder(store,config,input){
  const {shop}=await readShop(store);
  check(shop.settings.enabled&&config,'Online checkout is currently unavailable.',503);
  const item=lineItem(shop,input.sku,input.quantity);
  const shipping=shop.settings.shipping, subtotal=item.unit*item.quantity, total=subtotal+shipping;
  const id=randomUUID(),paypal=await paypalClient(config);
  const result=await paypal('',{id,body:{
    intent:'CAPTURE',
    purchase_units:[{custom_id:id,amount:{...usd(total),breakdown:{item_total:usd(subtotal),shipping:usd(shipping)}},
      items:[{name:item.name+' · '+item.variant,sku:item.sku,category:'PHYSICAL_GOODS',
        unit_amount:usd(item.unit),quantity:String(item.quantity)}]}]
  }});
  check(result.ok&&result.data.id,'PayPal could not start checkout. Try again.',502);
  // Unapproved checkout sessions stay outside the sales and inventory ledger.
  await store.setJSON('checkout/'+result.data.id,{...item,id,shipping,total,createdAt:Date.now()});
  return json({id:result.data.id});
}

function captureResult(data,order){
  const capture=data.purchase_units?.[0]?.payments?.captures?.[0];
  if(!capture)return null;
  check(capture.amount?.currency_code==='USD'&&capture.amount?.value===dollars(order.total),'Payment total requires review.',502);
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
  const {shop}=await readShop(store), existing=shop.sales[orderId];
  if(existing&&['paid','failed','refunded','partially refunded'].includes(existing.status)&&!refresh)return paymentResponse(existing);
  const paypal=await paypalClient(config), detail=await paypal('/'+orderId);
  check(detail.ok,'PayPal could not verify this order. Try again.',502);
  const unit=detail.data.purchase_units?.[0];
  check(unit?.custom_id===order.id,'Order could not be verified.',409);

  if(!existing){
    check(detail.data.status==='APPROVED','Approve your payment in PayPal first.',409);
    check(unit.shipping?.address?.country_code==='US','Checkout currently ships to U.S. addresses only.');
    await updateShop(store,state=>{
      if(state.sales[orderId])return {unchanged:true};
      check(state.settings.enabled,'Online checkout is currently unavailable.',503);
      check(state.settings.stock[order.sku]>=order.quantity,'This item sold out during checkout. You were not charged.',409);
      state.settings.stock[order.sku]-=order.quantity;
      state.sales[orderId]={...order,channel:'PayPal checkout',status:'processing'};
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
        await updateShop(store,state=>{
          const sale=state.sales[orderId];
          if(sale?.status!=='processing'||sale.attemptId!==claim)return {unchanged:true};
          state.settings.stock[order.sku]+=order.quantity;
          delete state.sales[orderId];
        });
        return json({code:'INSTRUMENT_DECLINED'});
      }
    }
  }
  if(!capture&&existing&&detail.data.status==='VOIDED'){
    const sale=await updateShop(store,state=>{
      const sale=state.sales[orderId];
      if(sale?.status!=='processing')return {unchanged:true,value:sale};
      state.settings.stock[order.sku]+=order.quantity;
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
    if(status==='failed')state.settings.stock[order.sku]+=order.quantity;
    Object.assign(sale,{status,captureId:capture.id,...(['paid','refunded','partially refunded'].includes(status)?{paidAt:Date.parse(capture.create_time)||Date.now()}:{}),orderId});
    return sale;
  });
  return paymentResponse(final||{status:'processing'});
}

export default async function handle(req){
  try{
    const url=new URL(req.url),action=url.searchParams.get('action');
    const production=['heidimikacfilms.com','www.heidimikacfilms.com'].includes(url.hostname);
    const config=paypalConfig(production),store=merchStore(production);
    if(req.method==='GET'&&!action)return json(publicShop((await readShop(store)).shop,config));
    check(req.method==='POST','Unsupported method.',405);
    check(req.headers.get('origin')===url.origin,'Origin rejected.',403);
    const input=await req.json();
    if(action==='create')return await createOrder(store,config,input);
    if(action==='capture')return await captureOrder(store,config,input.orderId);
    check(false,'Unknown action.',404);
  }catch(error){
    if(!error.status)console.error('Merch checkout failed',error.name);
    return json({error:error.status?error.message:'The shop is temporarily unavailable. Please try again.'},error.status||500);
  }
}
