import {getStore} from '@netlify/blobs';
import {publicSupporters} from './supporters.mjs';

const key='shop';
export const products=[
  {id:'blu-ray',name:'Written in the Light',description:'Autographed Blu-ray · Signed by Heidi Mikac',image:'/assets/light-poster.webp',variants:[['blu-ray','Blu-ray']]},
  {id:'peach-tea-lady',name:'Peach Tea Lady',description:'T-shirt',image:'/assets/peach-tea-lady-shirt.webp',variants:['S','M','L','XL','XXL'].map(size=>['shirt-'+size.toLowerCase(),size])}
];
const initial={
  settings:{enabled:false,shipping:500,prices:{'blu-ray':4000,'peach-tea-lady':2500},
    stock:{'blu-ray':30,'shirt-s':1,'shirt-m':4,'shirt-l':1,'shirt-xl':4,'shirt-xxl':2}},
  sales:{}
};

export function merchStore(production){
  return getStore({name:production?'hmf-merch-v1':'hmf-merch-preview-'+(process.env.DEPLOY_ID||'local'),consistency:'strong'});
}

export function check(ok,message,status=400){
  if(!ok)throw Object.assign(new Error(message),{status});
}

export async function readShop(store){
  for(let attempt=0;attempt<8;attempt++){
    const record=await store.getWithMetadata(key,{type:'json'});
    if(record?.data.openingInventorySet)return {shop:record.data,revision:record.etag};
    const shop=record?.data??structuredClone(initial);
    // Apply confirmed opening quantities once, preserving recorded stock and sales.
    for(const [sku,quantity] of Object.entries(initial.settings.stock))shop.settings.stock[sku]??=quantity;
    shop.settings.shipping??=initial.settings.shipping;
    shop.openingInventorySet=true;
    await store.setJSON(key,shop,record?{onlyIfMatch:record.etag}:{onlyIfNew:true});
  }
  check(false,'The shop is busy. Please try again.',409);
}

export async function updateShop(store,change){
  for(let attempt=0;attempt<8;attempt++){
    const {shop,revision}=await readShop(store);
    const result=change(shop,revision);
    if(result?.unchanged)return result.value;
    const saved=await store.setJSON(key,shop,revision?{onlyIfMatch:revision}:{onlyIfNew:true});
    if(saved.modified)return result;
  }
  check(false,'The shop is busy. Please try again.',409);
}

export function paypalConfig(production){
  const mode=process.env.HMF_PAYPAL_MODE;
  const clientId=process.env.HMF_PAYPAL_CLIENT_ID,secret=process.env.HMF_PAYPAL_SECRET;
  const ready=clientId&&secret&&mode===(production?'live':'sandbox');
  return ready?{clientId,secret,base:production?'https://api-m.paypal.com':'https://api-m.sandbox.paypal.com'}:null;
}
export const dollars=cents=>(cents/100).toFixed(2);

export function recognitionName(value){
  check(typeof value==='string'&&value.length<=240,'Enter a display name of 60 characters or fewer.');
  const name=value.normalize('NFKC').trim().replace(/\s+/gu,' ');
  check(name&&[...name].length<=60&&!/[<>\p{Cc}\p{Cf}\p{Cs}]/u.test(value)&&!/[<>\p{Cc}\p{Cf}\p{Cs}]/u.test(name),
    'Enter a plain-text display name of 60 characters or fewer.');
  return name;
}

export function recognitionSettings(input){
  if(input===undefined)return {public:false,name:''};
  check(input&&typeof input==='object'&&!Array.isArray(input)&&typeof input.public==='boolean','Choose whether to show your display name.');
  if(input.showAmount!==undefined)check(typeof input.showAmount==='boolean','Choose whether to show your support amount.');
  return {...(input.public?{public:true,name:recognitionName(input.name)}:{public:false,name:''}),
    ...(input.showAmount!==undefined?{showAmount:input.showAmount}:{})};
}

// Old orders and offline sales contain one item at the top level.
export function orderItems(order){
  return Array.isArray(order.items)?order.items:order.sku?[{
    sku:order.sku,name:order.name,variant:order.variant,quantity:order.quantity,unit:order.unit
  }]:[];
}

export function supporterNames(shop){
  const seen=new Set(),names=[];
  // Keep this legacy names-only response compatible, while applying the same
  // cross-channel refund, duplicate and privacy decisions as the public wall.
  const allowed=shop.supporterLedger?new Set(publicSupporters(shop).filter(row=>row.name!=='Anonymous').map(row=>row.name)):null;
  const sales=Object.values(shop.sales).filter(sale=>sale.status==='paid'&&sale.recognition?.public===true&&!sale.supporterHidden)
    .sort((a,b)=>(b.paidAt||0)-(a.paidAt||0));
  for(const sale of sales){
    let name;
    try{name=recognitionName(sale.recognition.name);}catch{continue;}
    if(allowed&&!allowed.has(name))continue;
    const key=name.toLocaleLowerCase('en-US');
    if(seen.has(key))continue;
    seen.add(key);names.push(name);
    if(names.length===30)break;
  }
  return names;
}

export function setSupporterVisibility(shop,input){
  check(input&&typeof input.orderId==='string'&&input.orderId.length<=80&&typeof input.hidden==='boolean','Choose a supporter and visibility.');
  const sale=Object.hasOwn(shop.sales,input.orderId)?shop.sales[input.orderId]:null;
  check(sale&&sale.recognition?.public===true,'This order has no public display-name permission.',404);
  recognitionName(sale.recognition.name);
  // Moderation cannot create consent or replace the display name the buyer chose.
  sale.supporterHidden=input.hidden;
  return {ok:true,orderId:input.orderId,hidden:input.hidden};
}

export function publicShop(shop,config){
  const {settings}=shop;
  return {
    clientId:settings.enabled?config?.clientId??null:null,
    shipping:settings.shipping,
    supporters:supporterNames(shop),
    products:products.map(product=>({...product,price:settings.prices[product.id],
      variants:product.variants.map(([id,label])=>({id,label,available:settings.stock[id]>0,soldOut:settings.stock[id]===0}))
    }))
  };
}

export function saveSettings(shop,input,requireThat,config){
  const integer=(value,max)=>Number.isInteger(value)&&value>=0&&value<=max;
  const prices={},stock={};
  for(const product of products){
    const price=input.prices?.[product.id];
    requireThat(price===null||integer(price,100000)&&price>0,'Enter a valid price.');
    prices[product.id]=price;
    for(const [sku] of product.variants){
      const count=input.stock?.[sku];
      requireThat(count===null||integer(count,100000),'Use whole numbers for stock quantities.');
      stock[sku]=count;
    }
  }
  requireThat(input.shipping===null||integer(input.shipping,100000),'Enter a shipping amount.');
  if(input.enabled){
    requireThat(config,'Connect PayPal in Netlify before enabling online checkout.');
    requireThat(input.shipping!==null,'Set a U.S. shipping rate. Enter 0 for free shipping.');
    requireThat(stock['blu-ray']!==null,'Set the Blu-ray stock quantity.');
    for(const product of products)
      requireThat(prices[product.id]||product.variants.every(([sku])=>!stock[sku]),'Set a price for each product with stock.');
  }
  shop.settings={enabled:input.enabled===true,shipping:input.shipping,prices,stock};
}

export function lineItem(shop,sku,quantity){
  const product=products.find(item=>item.variants.some(([id])=>id===sku));
  check(product&&Number.isInteger(quantity)&&quantity>=1&&quantity<=20,'Choose an item and a quantity from 1 to 20.');
  const unit=shop.settings.prices[product.id];
  check(unit&&shop.settings.stock[sku]>=quantity,'This quantity is no longer available.',409);
  return {sku,name:product.name,variant:product.variants.find(([id])=>id===sku)[1],quantity,unit};
}

export function checkoutCart(shop,input){
  check(input&&typeof input==='object'&&!Array.isArray(input),'Choose your merchandise.');
  const donation=input.donation??0;
  check(Number.isInteger(donation)&&(donation===0||donation>=100&&donation<=1000000),'Contributions must be between $1 and $10,000.');
  // Monetary contributions use the campaign checkout. Never disguise a donation
  // as goods or mix PayPal's restricted DONATION category with merchandise.
  check(donation===0,'Please use the separate campaign checkout for a contribution.');
  const requested=input.items===undefined?[{sku:input.sku,quantity:input.quantity}]:input.items;
  check(Array.isArray(requested)&&requested.length>0&&requested.length<=120,'Choose at least one merchandise item.');
  const quantities=new Map();
  for(const item of requested){
    check(item&&typeof item.sku==='string'&&Number.isInteger(item.quantity)&&item.quantity>=1&&item.quantity<=20,
      'Choose an item and a quantity from 1 to 20.');
    quantities.set(item.sku,(quantities.get(item.sku)||0)+item.quantity);
  }
  const items=[...quantities].map(([sku,quantity])=>lineItem(shop,sku,quantity));
  const shipping=shop.settings.shipping;
  check(Number.isInteger(shipping)&&shipping>=0,'U.S. shipping is not configured.',503);
  const subtotal=items.reduce((sum,item)=>sum+item.unit*item.quantity,0);
  const summary=items.length===1?items[0]:{name:'Merch order',variant:'Multiple items',quantity:items.reduce((sum,item)=>sum+item.quantity,0)};
  return {...summary,items,donation:0,recognition:recognitionSettings(input.recognition),shipping,subtotal,total:subtotal+shipping};
}

export function manualSale(shop,input){
  check(typeof input.id==='string'&&/^[a-f0-9-]{36}$/.test(input.id),'Reload the sale form and retry.');
  if(Object.hasOwn(shop.sales,input.id))return {unchanged:true};
  const item=lineItem(shop,input.sku,input.quantity);
  check(['Venmo','Other'].includes(input.channel),'Choose a payment method.');
  check(Number.isInteger(input.total)&&input.total>0&&input.total<=2000000,'Enter the amount received.');
  shop.settings.stock[item.sku]-=item.quantity;
  shop.sales[input.id]={...item,status:'paid',channel:input.channel,total:input.total,shipping:null,paidAt:Date.now()};
}
