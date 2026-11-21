import test from 'node:test';
import assert from 'node:assert/strict';
import {readShop,updateShop,publicShop,saveSettings,manualSale,check,checkoutCart,orderItems,recognitionSettings,setSupporterVisibility} from '../netlify/lib/merch.mjs';
import {captureOrder,createOrder} from '../netlify/functions/merch.mjs';
import {publicSupporters} from '../netlify/lib/supporters.mjs';

const paypalConfig={base:'https://test.invalid',clientId:'test',secret:'test'};

function memoryStore(){
  const records=new Map();
  let etag=0;
  return {
    async get(key){return structuredClone(records.get(key)?.data);},
    async getWithMetadata(key){return structuredClone(records.get(key));},
    async setJSON(key,data,options={}){
      const current=records.get(key);
      if(options.onlyIfNew&&current||options.onlyIfMatch&&options.onlyIfMatch!==current?.etag)return {modified:false};
      records.set(key,{data:structuredClone(data),etag:String(++etag)});
      return {modified:true};
    }
  };
}

async function fixture(stock=30){
  const store=memoryStore();
  await updateShop(store,shop=>{
    saveSettings(shop,{...shop.settings,enabled:true,shipping:500,stock:{...shop.settings.stock,'blu-ray':stock}},check,{clientId:'test'});
  });
  return store;
}

async function seedCart(store,id,input){
  const order={...checkoutCart((await readShop(store)).shop,input),id:'local-'+id,version:2,createdAt:Date.now()};
  await store.setJSON('checkout/'+id,order);
  return order;
}

function purchaseUnit(order){
  const usd=value=>({currency_code:'USD',value:(value/100).toFixed(2)});
  return {custom_id:order.id,amount:{...usd(order.total),breakdown:{item_total:usd(order.total-order.shipping),shipping:usd(order.shipping)}},
    items:orderItems(order).map(item=>({name:item.name+' · '+item.variant,sku:item.sku,quantity:String(item.quantity),unit_amount:usd(item.unit)}))};
}

function mockPayPal(t,orders=new Map()){
  const mock={orders,calls:[],created:[],captures:new Map(),statuses:new Map(),country:'US',beforeDetails:null,alterDetails:null,captureBehavior:null,alterCreate:null};
  mock.complete=(id,status='COMPLETED')=>{
    const order=orders.get(id),capture={id:'CAPTURE-'+id,status,amount:{currency_code:'USD',value:(order.total/100).toFixed(2)}};
    mock.captures.set(id,capture);mock.statuses.set(id,'COMPLETED');
    return Response.json({purchase_units:[{payments:{captures:[capture]}}]});
  };
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    if(url.endsWith('/token'))return Response.json({access_token:'test'});
    if(url.endsWith('/v2/checkout/orders')){
      const body=JSON.parse(options.body),id='NEWORDER'+String(mock.created.length+1).padStart(6,'0');
      mock.created.push({id,body});
      const data={id,status:'CREATED',...structuredClone(body)};
      return Response.json(mock.alterCreate?mock.alterCreate(data):data,{status:201});
    }
    const id=url.match(/\/orders\/([^/]+)/)?.[1];
    assert.ok(orders.has(id),'mock PayPal order must exist');
    if(url.endsWith('/capture')){
      mock.calls.push({id,requestId:options.headers['PayPal-Request-Id']});
      return mock.captureBehavior?mock.captureBehavior(id):mock.complete(id);
    }
    if(mock.beforeDetails)await mock.beforeDetails(id);
    const unit=purchaseUnit(orders.get(id));
    unit.shipping={address:{country_code:mock.country}};
    if(mock.captures.has(id))unit.payments={captures:[structuredClone(mock.captures.get(id))]};
    const data={id,status:mock.statuses.get(id)||'APPROVED',purchase_units:[unit]};
    return Response.json(mock.alterDetails?mock.alterDetails(data):data);
  });
  return mock;
}

test('opening stock fills unconfirmed inventory once and preserves sold-out stock and sales',async()=>{
  const store=memoryStore();
  await store.setJSON('shop',{
    settings:{enabled:false,shipping:null,prices:{'blu-ray':4000,'peach-tea-lady':2500},
      stock:{'blu-ray':null,'shirt-s':0,'shirt-m':null,'shirt-l':null,'shirt-xl':null,'shirt-xxl':null}},
    sales:{previous:{status:'paid',quantity:1}}
  });
  const [{shop}]=await Promise.all([readShop(store),readShop(store)]);
  assert.deepEqual(shop.settings.stock,{'blu-ray':30,'shirt-s':0,'shirt-m':4,'shirt-l':1,'shirt-xl':4,'shirt-xxl':2});
  assert.equal(shop.settings.shipping,500);
  assert.deepEqual(shop.sales,{previous:{status:'paid',quantity:1}});
  await updateShop(store,current=>{current.settings.stock['shirt-m']=null;current.settings.shipping=0;});
  const later=(await readShop(store)).shop;
  assert.equal(later.settings.stock['shirt-m'],null);
  assert.equal(later.settings.shipping,0);
});

test('stock zero is sold out and recording an offline sale twice consumes one unit',async()=>{
  const store=await fixture(1);
  const input={id:'c42aa717-af49-41fe-86ef-baaf90d03e58',sku:'blu-ray',quantity:1,channel:'Venmo',total:4000};
  await Promise.all([updateShop(store,shop=>manualSale(shop,input)),updateShop(store,shop=>manualSale(shop,input))]);
  const {shop}=await readShop(store);
  assert.equal(Object.keys(shop.sales).length,1);
  assert.equal(publicShop(shop,{clientId:'test'}).products[0].variants[0].soldOut,true);
});

test('only one of two approved PayPal orders can capture the last unit',async t=>{
  const store=await fixture(1), orderIds=['AAAAAAAAAAAA1','AAAAAAAAAAAA2'];
  for(const id of orderIds)await store.setJSON('checkout/'+id,{sku:'blu-ray',name:'Written in the Light',variant:'Blu-ray',quantity:1,unit:4000,total:4500,shipping:500,id});
  let captureCalls=0;
  t.mock.method(globalThis,'fetch',async url=>{
    if(url.endsWith('/token'))return Response.json({access_token:'test'});
    if(url.endsWith('/capture')){
      captureCalls++;
      return Response.json({purchase_units:[{payments:{captures:[{id:'CAPTURE1',status:'COMPLETED',amount:{currency_code:'USD',value:'45.00'}}]}}]});
    }
    return Response.json({status:'APPROVED',purchase_units:[{custom_id:url.split('/').at(-1),amount:{currency_code:'USD',value:'45.00'},shipping:{address:{country_code:'US'}}}]});
  });
  const config={base:'https://test.invalid',clientId:'test',secret:'test'};
  const outcomes=await Promise.allSettled(orderIds.map(id=>captureOrder(store,config,id)));
  const paid=outcomes.findIndex(outcome=>outcome.status==='fulfilled');
  assert.notEqual(paid,-1);
  assert.equal((await outcomes[paid].value.json()).status,'paid');
  assert.equal(outcomes[1-paid].reason.status,409);
  assert.equal((await (await captureOrder(store,config,orderIds[paid])).json()).status,'paid');
  assert.equal(captureCalls,1);
  assert.equal((await readShop(store)).shop.settings.stock['blu-ray'],0);
});

test('a mixed merchandise cart uses server prices, keeps sizes, and charges shipping once',async t=>{
  const store=await fixture(),before=(await readShop(store)).shop,mock=mockPayPal(t);
  const response=await createOrder(store,paypalConfig,{items:[{sku:'blu-ray',quantity:1,unit:1},{sku:'shirt-m',quantity:1},{sku:'shirt-xl',quantity:1}],recognition:{public:true,name:'  Ada   Example  '}});
  const {id}=await response.json(),unit=mock.created[0].body.purchase_units[0];
  assert.equal(unit.amount.value,'95.00');
  assert.equal(unit.amount.breakdown.item_total.value,'90.00');
  assert.equal(unit.amount.breakdown.shipping.value,'5.00');
  assert.deepEqual(unit.items.map(item=>[item.sku,item.name,item.unit_amount.value]),[
    ['blu-ray','Written in the Light · Blu-ray','40.00'],['shirt-m','Peach Tea Lady · M','25.00'],['shirt-xl','Peach Tea Lady · XL','25.00']
  ]);
  const saved=await store.get('checkout/'+id);
  assert.deepEqual(saved.recognition,{public:true,name:'Ada Example',showAmount:true});
  assert.equal(saved.donation,0);
  assert.equal(saved.items.length,3);
  assert.deepEqual((await readShop(store)).shop.settings.stock,before.settings.stock);
  assert.deepEqual((await readShop(store)).shop.sales,{});
  assert.ok(!JSON.stringify(mock.created[0].body).includes('Ada Example'),'display-name preference is not sent as payment identity');
});

test('duplicate SKUs are combined before quantity and stock validation',async()=>{
  const shop=(await readShop(await fixture())).shop;
  const cart=checkoutCart(shop,{items:[{sku:'shirt-m',quantity:1},{sku:'shirt-m',quantity:1}]});
  assert.equal(cart.items.length,1);assert.equal(cart.items[0].quantity,2);assert.equal(cart.total,5500);
  assert.throws(()=>checkoutCart(shop,{items:[{sku:'shirt-s',quantity:1},{sku:'shirt-s',quantity:1}]}),{status:409});
  shop.settings.stock['shirt-m']=100;
  assert.throws(()=>checkoutCart(shop,{items:[{sku:'shirt-m',quantity:20},{sku:'shirt-m',quantity:1}]}),{status:400});
  for(const input of [{items:[]},{items:[{sku:'unknown',quantity:1}]},{items:[{sku:'shirt-m',quantity:1.5}]},{items:[{sku:'shirt-m',quantity:0}]}])
    assert.throws(()=>checkoutCart(shop,input),{status:400});
});

test('the previous single-item create payload still starts the original $45 Blu-ray checkout',async t=>{
  const store=await fixture(),mock=mockPayPal(t);
  const {id}=await (await createOrder(store,paypalConfig,{sku:'blu-ray',quantity:1})).json();
  const order=await store.get('checkout/'+id),unit=mock.created[0].body.purchase_units[0];
  assert.equal(order.sku,'blu-ray');assert.equal(order.quantity,1);assert.equal(order.total,4500);
  assert.equal(unit.amount.value,'45.00');assert.equal(unit.amount.breakdown.shipping.value,'5.00');
  assert.deepEqual(order.recognition,{public:false,name:'',showAmount:true});
});

test('monetary contributions stay outside merchandise PayPal checkout',async t=>{
  const store=await fixture(),mock=mockPayPal(t);
  for(const donation of [-1,99,1.5,'100',1000001])
    await assert.rejects(()=>createOrder(store,paypalConfig,{items:[{sku:'shirt-m',quantity:1}],donation}),/between \$1 and \$10,000/);
  for(const donation of [100,500,1000000])
    await assert.rejects(()=>createOrder(store,paypalConfig,{items:[],donation}),/separate campaign checkout/);
  assert.equal(mock.created.length,0);
  assert.deepEqual((await readShop(store)).shop.sales,{});
});

test('new recognition asks only about the name, defaults support amounts public, and honors explicit legacy privacy',()=>{
  assert.deepEqual(recognitionSettings(),{public:false,name:'',showAmount:true});
  assert.deepEqual(recognitionSettings({public:false,name:'Private payer'}),{public:false,name:'',showAmount:true});
  assert.deepEqual(recognitionSettings({public:true,name:'  Ａda  Example  '}),{public:true,name:'Ada Example',showAmount:true});
  assert.deepEqual(recognitionSettings({public:false,showAmount:false}),{public:false,name:'',showAmount:false});
  assert.deepEqual(recognitionSettings({public:true,name:'Legacy private amount',showAmount:false}),{public:true,name:'Legacy private amount',showAmount:false});
  for(const value of [{public:'true',name:'Ada'},{public:true,name:''},{public:true,name:'x'.repeat(61)},{public:true,name:'<b>Ada</b>'},{public:true,name:'Ada\u202eExample'},{public:true,name:'Ada\u200bExample'},{public:true,name:'Ada\nExample'},
    {public:false,showAmount:'true'},{public:false,showAmount:0},{public:false,showAmount:null}])
    assert.throws(()=>recognitionSettings(value),{status:400});
});

test('a new anonymous merchandise payment publishes the paid subtotal while keeping the buyer name private',async t=>{
  const store=await fixture(),mock=mockPayPal(t);
  const {id}=await (await createOrder(store,paypalConfig,{sku:'blu-ray',quantity:1,recognition:{public:false}})).json();
  const order=await store.get('checkout/'+id);mock.orders.set(id,order);
  assert.deepEqual(order.recognition,{public:false,name:'',showAmount:true});
  assert.deepEqual(publicSupporters((await readShop(store)).shop),[],'An unapproved order is never credited.');
  assert.equal((await (await captureOrder(store,paypalConfig,id)).json()).status,'paid');
  const {shop}=await readShop(store);
  assert.deepEqual(publicSupporters(shop),[{name:'Anonymous',amount:4000,currency:'USD'}]);
  assert.equal(shop.sales[id].total,4500);assert.equal(shop.sales[id].subtotal,4000);assert.equal(shop.sales[id].shipping,500);
  assert.equal(shop.sales[id].donation,0);assert.equal(shop.settings.stock['blu-ray'],29);
});

test('an older client can still explicitly keep a new order amount private',async t=>{
  const store=await fixture(),mock=mockPayPal(t);
  const recognition={public:true,name:'Legacy Client Supporter',showAmount:false};
  const {id}=await (await createOrder(store,paypalConfig,{sku:'blu-ray',quantity:1,recognition})).json();
  const order=await store.get('checkout/'+id);mock.orders.set(id,order);
  assert.deepEqual(order.recognition,recognition);
  await captureOrder(store,paypalConfig,id);
  assert.deepEqual(publicSupporters((await readShop(store)).shop),[{name:'Legacy Client Supporter',amount:null,currency:'USD'}]);
});

test('capturing saved legacy pending orders never upgrades their saved amount privacy',async t=>{
  const choices=[{public:true,name:'Legacy Pending Supporter',showAmount:false},{public:false,name:'',showAmount:false},{public:true,name:'Legacy Missing Amount Flag'}];
  for(let index=0;index<choices.length;index++)await t.test('saved preference '+index,async sub=>{
    const store=await fixture(),id='LEGACYORDER0000'+index,order=await seedCart(store,id,{sku:'blu-ray',quantity:1});
    order.recognition=structuredClone(choices[index]);await store.setJSON('checkout/'+id,order);
    mockPayPal(sub,new Map([[id,order]]));
    assert.equal((await (await captureOrder(store,paypalConfig,id)).json()).status,'paid');
    const {shop}=await readShop(store);assert.deepEqual(shop.sales[id].recognition,choices[index]);
    assert.deepEqual(publicSupporters(shop),[{name:choices[index].public?choices[index].name:'Anonymous',amount:null,currency:'USD'}]);
  });
});

test('new name-only checkout does not migrate a previously paid private-amount record',async t=>{
  const store=await fixture(),old={status:'paid',subtotal:2300,total:2300,shipping:0,paidAt:1,recognition:{public:true,name:'Existing Paid Supporter',showAmount:false}};
  await updateShop(store,shop=>{shop.sales.LEGACYPAID=structuredClone(old);});
  const mock=mockPayPal(t),{id}=await (await createOrder(store,paypalConfig,{sku:'blu-ray',quantity:1,recognition:{public:true,name:'New Named Supporter'}})).json();
  const order=await store.get('checkout/'+id);mock.orders.set(id,order);await captureOrder(store,paypalConfig,id);
  const {shop}=await readShop(store),rows=publicSupporters(shop);
  assert.deepEqual(shop.sales.LEGACYPAID,old);
  assert.equal(rows.find(row=>row.name==='Existing Paid Supporter').amount,null);
  assert.equal(rows.find(row=>row.name==='New Named Supporter').amount,4000);
});

test('PayPal create representations with altered identifiers, totals, currency, or items are rejected',async t=>{
  const store=await fixture(),mock=mockPayPal(t);
  const alterations=[
    data=>{data.purchase_units[0].custom_id='different';},
    data=>{data.purchase_units[0].amount.value='1.00';},
    data=>{data.purchase_units[0].amount.currency_code='EUR';},
    data=>{data.purchase_units[0].amount.breakdown.shipping.value='0.00';},
    data=>{data.purchase_units[0].items[0].sku='shirt-s';}
  ];
  for(const alter of alterations){
    mock.alterCreate=data=>{alter(data);return data;};
    await assert.rejects(()=>createOrder(store,paypalConfig,{sku:'shirt-m',quantity:1}));
  }
  for(const order of mock.created)assert.equal(await store.get('checkout/'+order.id),undefined);
  assert.deepEqual((await readShop(store)).shop.sales,{});
});

test('two competing carts reserve all their items or none',async t=>{
  const store=await fixture(),a='CARTORDER000001',b='CARTORDER000002';
  const orders=new Map([
    [a,await seedCart(store,a,{items:[{sku:'blu-ray',quantity:1},{sku:'shirt-s',quantity:1}]})],
    [b,await seedCart(store,b,{items:[{sku:'shirt-m',quantity:1},{sku:'shirt-s',quantity:1}]})]
  ]);
  const mock=mockPayPal(t,orders),results=await Promise.allSettled([captureOrder(store,paypalConfig,a),captureOrder(store,paypalConfig,b)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.find(result=>result.status==='rejected').reason.status,409);
  const shop=(await readShop(store)).shop,paidId=Object.keys(shop.sales)[0];
  assert.equal(shop.settings.stock['shirt-s'],0);
  assert.equal(shop.settings.stock['blu-ray'],paidId===a?29:30);
  assert.equal(shop.settings.stock['shirt-m'],paidId===b?3:4);
  assert.equal(mock.calls.length,1);
});

test('duplicate capture requests consume a multi-item cart only once',async t=>{
  const store=await fixture(),id='CARTORDER000003';
  const order=await seedCart(store,id,{items:[{sku:'blu-ray',quantity:1},{sku:'shirt-m',quantity:2}],recognition:{public:true,name:'Cart Supporter'}});
  const mock=mockPayPal(t,new Map([[id,order]]));
  await Promise.all([captureOrder(store,paypalConfig,id),captureOrder(store,paypalConfig,id)]);
  const shop=(await readShop(store)).shop;
  assert.equal(mock.calls.length,1);
  assert.equal(shop.settings.stock['blu-ray'],29);assert.equal(shop.settings.stock['shirt-m'],2);
  assert.equal(shop.sales[id].items.length,2);assert.equal(shop.sales[id].total,9500);
  assert.deepEqual(publicShop(shop,paypalConfig).supporters,['Cart Supporter']);
});

test('a cart changed or sold out after order creation is not partly reserved',async t=>{
  const store=await fixture(),id='CARTORDER000004',order=await seedCart(store,id,{items:[{sku:'blu-ray',quantity:1},{sku:'shirt-s',quantity:1}]});
  await updateShop(store,shop=>{shop.settings.stock['shirt-s']=0;});
  const mock=mockPayPal(t,new Map([[id,order]]));
  await assert.rejects(()=>captureOrder(store,paypalConfig,id),{status:409});
  const shop=(await readShop(store)).shop;
  assert.equal(shop.settings.stock['blu-ray'],30);assert.equal(mock.calls.length,0);assert.deepEqual(shop.sales,{});
});

test('non-U.S. shipping and altered PayPal cart totals are rejected before capture',async t=>{
  const store=await fixture(),id='CARTORDER000005',order=await seedCart(store,id,{items:[{sku:'shirt-xl',quantity:1}]});
  const mock=mockPayPal(t,new Map([[id,order]]));
  mock.country='CA';
  await assert.rejects(()=>captureOrder(store,paypalConfig,id),/U.S. addresses only/);
  mock.country='US';mock.alterDetails=data=>{data.purchase_units[0].amount.value='29.00';return data;};
  await assert.rejects(()=>captureOrder(store,paypalConfig,id),/Payment total requires review/);
  assert.equal(mock.calls.length,0);assert.deepEqual((await readShop(store)).shop.sales,{});
});

test('a verified failed capture releases every SKU exactly once',async t=>{
  const store=await fixture(),id='CARTORDER000006',order=await seedCart(store,id,{items:[{sku:'blu-ray',quantity:1},{sku:'shirt-xl',quantity:2}]});
  const mock=mockPayPal(t,new Map([[id,order]]));mock.captureBehavior=()=>mock.complete(id,'DECLINED');
  assert.equal((await (await captureOrder(store,paypalConfig,id)).json()).status,'failed');
  assert.equal((await (await captureOrder(store,paypalConfig,id)).json()).status,'failed');
  const shop=(await readShop(store)).shop;
  assert.equal(shop.settings.stock['blu-ray'],30);assert.equal(shop.settings.stock['shirt-xl'],4);
  assert.equal(shop.sales[id].stockReleased,true);assert.equal(mock.calls.length,1);
});

test('a funding decline releases the cart and permits a fresh funding attempt',async t=>{
  const store=await fixture(),id='CARTORDER000007',order=await seedCart(store,id,{items:[{sku:'blu-ray',quantity:1},{sku:'shirt-m',quantity:2}]});
  const mock=mockPayPal(t,new Map([[id,order]]));
  mock.captureBehavior=()=>Response.json({details:[{issue:'INSTRUMENT_DECLINED'}]},{status:422});
  const responses=await Promise.all([captureOrder(store,paypalConfig,id),captureOrder(store,paypalConfig,id)]);
  const results=await Promise.all(responses.map(response=>response.json()));
  assert.equal(results.filter(result=>result.code==='INSTRUMENT_DECLINED').length,1);
  let shop=(await readShop(store)).shop;
  assert.equal(shop.settings.stock['blu-ray'],30);assert.equal(shop.settings.stock['shirt-m'],4);assert.equal(shop.sales[id],undefined);
  mock.captureBehavior=null;
  assert.equal((await (await captureOrder(store,paypalConfig,id)).json()).status,'paid');
  shop=(await readShop(store)).shop;
  assert.equal(shop.settings.stock['blu-ray'],29);assert.equal(shop.settings.stock['shirt-m'],2);
});

test('unknown capture outcomes retain stock and retries reuse the capture request ID',async t=>{
  const store=await fixture(),id='CARTORDER000008',order=await seedCart(store,id,{items:[{sku:'blu-ray',quantity:1},{sku:'shirt-m',quantity:1}]});
  const mock=mockPayPal(t,new Map([[id,order]]));
  mock.captureBehavior=()=>{throw Error('Network timeout');};
  await assert.rejects(()=>captureOrder(store,paypalConfig,id),/Network timeout/);
  let shop=(await readShop(store)).shop;
  assert.equal(shop.settings.stock['blu-ray'],29);assert.equal(shop.settings.stock['shirt-m'],3);assert.equal(shop.sales[id].status,'processing');
  await updateShop(store,state=>{state.sales[id].captureLease=0;});
  mock.captureBehavior=null;
  assert.equal((await (await captureOrder(store,paypalConfig,id)).json()).status,'paid');
  assert.equal(mock.calls.length,2);assert.equal(mock.calls[0].requestId,mock.calls[1].requestId);
  shop=(await readShop(store)).shop;
  assert.equal(shop.settings.stock['blu-ray'],29);assert.equal(shop.settings.stock['shirt-m'],3);
});

test('a remotely completed capture recovers after its response is lost without another capture',async t=>{
  const store=await fixture(),id='CARTORDER000009',order=await seedCart(store,id,{items:[{sku:'shirt-m',quantity:1}]});
  const mock=mockPayPal(t,new Map([[id,order]]));
  mock.captureBehavior=()=>{mock.complete(id);throw Error('Response lost');};
  await assert.rejects(()=>captureOrder(store,paypalConfig,id),/Response lost/);
  assert.equal((await (await captureOrder(store,paypalConfig,id)).json()).status,'paid');
  assert.equal(mock.calls.length,1);assert.equal((await readShop(store)).shop.settings.stock['shirt-m'],3);
});

test('a voided processing cart restores its reservation once',async t=>{
  const store=await fixture(),id='CARTORDER000010',order=await seedCart(store,id,{items:[{sku:'blu-ray',quantity:1},{sku:'shirt-xxl',quantity:1}]});
  const mock=mockPayPal(t,new Map([[id,order]]));mock.captureBehavior=()=>{throw Error('Network timeout');};
  await assert.rejects(()=>captureOrder(store,paypalConfig,id));
  mock.statuses.set(id,'VOIDED');
  assert.equal((await (await captureOrder(store,paypalConfig,id)).json()).status,'failed');
  assert.equal((await (await captureOrder(store,paypalConfig,id)).json()).status,'failed');
  const shop=(await readShop(store)).shop;
  assert.equal(shop.settings.stock['blu-ray'],30);assert.equal(shop.settings.stock['shirt-xxl'],2);
});

test('pending and refunded payments do not publish a supporter or restock a captured cart',async t=>{
  const store=await fixture(),id='CARTORDER000011',order=await seedCart(store,id,{items:[{sku:'shirt-m',quantity:1}],recognition:{public:true,name:'Public Supporter'}});
  const mock=mockPayPal(t,new Map([[id,order]]));mock.captureBehavior=()=>mock.complete(id,'PENDING');
  assert.equal((await (await captureOrder(store,paypalConfig,id)).json()).status,'pending');
  assert.deepEqual(publicShop((await readShop(store)).shop,paypalConfig).supporters,[]);
  mock.complete(id,'COMPLETED');
  assert.equal((await (await captureOrder(store,paypalConfig,id)).json()).status,'paid');
  assert.deepEqual(publicShop((await readShop(store)).shop,paypalConfig).supporters,['Public Supporter']);
  mock.complete(id,'REFUNDED');
  assert.equal((await (await captureOrder(store,paypalConfig,id,{refresh:true})).json()).status,'refunded');
  const shop=(await readShop(store)).shop;
  assert.deepEqual(publicShop(shop,paypalConfig).supporters,[]);assert.equal(shop.settings.stock['shirt-m'],3);
});

test('concurrent completion observed after PayPal verification returns the current paid sale',async t=>{
  const store=await fixture(),id='CARTORDER000012',order=await seedCart(store,id,{items:[{sku:'shirt-m',quantity:1}]});
  const mock=mockPayPal(t,new Map([[id,order]]));
  mock.beforeDetails=async()=>{
    mock.beforeDetails=null;
    await updateShop(store,shop=>{shop.settings.stock['shirt-m']--;shop.sales[id]={...order,status:'paid',paidAt:Date.now(),captureId:'OTHER-WORKER'};});
    mock.complete(id);
  };
  assert.equal((await (await captureOrder(store,paypalConfig,id)).json()).status,'paid');
  assert.equal(mock.calls.length,0);assert.equal((await readShop(store)).shop.settings.stock['shirt-m'],3);
});

test('public supporters disclose only paid explicit names, dedupe, and honor reversible admin hiding',async()=>{
  const store=await fixture();
  await updateShop(store,shop=>{
    shop.sales={
      legacy:{status:'paid',name:'Legacy buyer',payer:{name:'Private payer',email:'private@example.test'},total:123456,paidAt:100},
      anonymous:{status:'paid',recognition:{public:false,name:'Not public'},paidAt:100},
      pending:{status:'pending',recognition:{public:true,name:'Pending Person'},paidAt:100},
      failed:{status:'failed',recognition:{public:true,name:'Failed Person'},paidAt:100},
      refunded:{status:'refunded',recognition:{public:true,name:'Refunded Person'},paidAt:100},
      hidden:{status:'paid',recognition:{public:true,name:'Hidden Person'},supporterHidden:true,paidAt:100},
      oldAda:{status:'paid',recognition:{public:true,name:'ADA Example'},paidAt:1},
      ada:{status:'paid',recognition:{public:true,name:'Ada Example'},paidAt:2},
      grace:{status:'paid',recognition:{public:true,name:'Grace Example'},paidAt:3}
    };
  });
  let shop=(await readShop(store)).shop;
  assert.deepEqual(publicShop(shop,paypalConfig).supporters,['Grace Example','Ada Example']);
  const payload=JSON.stringify(publicShop(shop,paypalConfig));
  for(const secret of ['private@example.test','Private payer','Not public','Pending Person','Failed Person','Refunded Person','Hidden Person','123456'])assert.ok(!payload.includes(secret));
  await updateShop(store,state=>setSupporterVisibility(state,{orderId:'grace',hidden:true}));
  assert.deepEqual(publicShop((await readShop(store)).shop,paypalConfig).supporters,['Ada Example']);
  await updateShop(store,state=>setSupporterVisibility(state,{orderId:'grace',hidden:false}));
  shop=(await readShop(store)).shop;
  assert.deepEqual(publicShop(shop,paypalConfig).supporters,['Grace Example','Ada Example']);
  assert.throws(()=>setSupporterVisibility(shop,{orderId:'legacy',hidden:false}),{status:404});
  assert.throws(()=>setSupporterVisibility(shop,{orderId:'anonymous',hidden:false}),{status:404});
  assert.throws(()=>setSupporterVisibility(shop,{orderId:'grace',hidden:'false'}),{status:400});
  for(let i=0;i<40;i++)shop.sales['person'+i]={status:'paid',recognition:{public:true,name:'Supporter '+i},paidAt:100+i};
  assert.equal(publicShop(shop,paypalConfig).supporters.length,30);
  assert.equal(publicShop(shop,paypalConfig).supporters[0],'Supporter 39');
});
