import {getStore} from '@netlify/blobs';

const key='shop';
export const products=[
  {id:'blu-ray',name:'Written in the Light',description:'Autographed Blu-ray · Signed by Heidi Mikac',image:'/assets/light-poster.webp',variants:[['blu-ray','Blu-ray']]},
  {id:'peach-tea-lady',name:'Peach Tea Lady',description:'T-shirt',image:'',variants:['S','M','L','XL','XXL'].map(size=>['shirt-'+size.toLowerCase(),size])}
];
const initial={
  settings:{enabled:false,shipping:null,prices:{'blu-ray':4000,'peach-tea-lady':null},
    stock:{'blu-ray':null,'shirt-s':null,'shirt-m':null,'shirt-l':null,'shirt-xl':null,'shirt-xxl':null}},
  sales:{}
};

export function merchStore(production){
  return getStore({name:production?'hmf-merch-v1':'hmf-merch-preview-'+(process.env.DEPLOY_ID||'local'),consistency:'strong'});
}

export function check(ok,message,status=400){
  if(!ok)throw Object.assign(new Error(message),{status});
}

export async function readShop(store){
  const record=await store.getWithMetadata(key,{type:'json'});
  return {shop:record?.data??structuredClone(initial),revision:record?.etag??''};
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

export function publicShop(shop,config){
  const {settings}=shop;
  return {
    clientId:settings.enabled?config?.clientId??null:null,
    shipping:settings.shipping,
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

export function manualSale(shop,input){
  check(typeof input.id==='string'&&/^[a-f0-9-]{36}$/.test(input.id),'Reload the sale form and retry.');
  if(Object.hasOwn(shop.sales,input.id))return {unchanged:true};
  const item=lineItem(shop,input.sku,input.quantity);
  check(['Venmo','Other'].includes(input.channel),'Choose a payment method.');
  check(Number.isInteger(input.total)&&input.total>0&&input.total<=2000000,'Enter the amount received.');
  shop.settings.stock[item.sku]-=item.quantity;
  shop.sales[input.id]={...item,status:'paid',channel:input.channel,total:input.total,shipping:null,paidAt:Date.now()};
}
