export async function signwell(path, body) {
 if(!process.env.SIGNWELL_API_KEY)throw Object.assign(Error('Signing setup required.'),{status:503});
 const response=await fetch('https://www.signwell.com/api/v1/'+path,{method:body?'POST':'GET',signal:AbortSignal.timeout(15000),headers:{'X-Api-Key':process.env.SIGNWELL_API_KEY,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});
 if(!response.ok)throw Object.assign(Error('SignWell could not confirm this request. Check the SignWell dashboard.'),{status:502,providerStatus:response.status});
 return response.json();
}
export function documentStatus(d){
 const actor=d.recipients?.find(r=>String(r.id)==='1');
 return d.status==='completed'?'Complete':['declined','cancelled','expired'].includes(d.status)?d.status:actor?.status==='signed'?'Waiting on Heidi':'Waiting on actor';
}
export async function refreshAgreement(store,key,force=false){
 const record=await store.getWithMetadata(key,{type:'json'}),a=record?.data;
 if(!a?.id||(!force&&Date.now()-(a.checkedAt||0)<300000))return a;
 try{
  const d=await signwell('documents/'+encodeURIComponent(a.id)+'/');
  const next={...a,status:documentStatus(d),checkedAt:Date.now(),syncError:null};
  await store.setJSON(key,next,{onlyIfMatch:record.etag});return next;
 }catch{const next={...a,checkedAt:Date.now(),syncError:'Status could not be refreshed. Last known status shown.'};await store.setJSON(key,next,{onlyIfMatch:record.etag});return next;}
}
