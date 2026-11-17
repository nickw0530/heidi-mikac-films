import test from 'node:test';
import assert from 'node:assert/strict';
import {readShop,updateShop,publicShop,saveSettings,manualSale,check} from '../netlify/lib/merch.mjs';
import {captureOrder} from '../netlify/functions/merch.mjs';

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

async function fixture(stock){
  const store=memoryStore();
  await updateShop(store,shop=>{
    saveSettings(shop,{...shop.settings,enabled:true,shipping:500,stock:{...shop.settings.stock,'blu-ray':stock}},check,{clientId:'test'});
  });
  return store;
}

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
    return Response.json({status:'APPROVED',purchase_units:[{custom_id:url.split('/').at(-1),shipping:{address:{country_code:'US'}}}]});
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
