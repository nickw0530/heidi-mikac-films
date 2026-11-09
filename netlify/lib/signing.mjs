export const COUNTERSIGN_EMAIL = 'hello@heidimikacfilms.com';

export async function signwell(path, body) {
 if(!process.env.SIGNWELL_API_KEY)throw Object.assign(Error('Signing setup required.'),{status:503});
 const response=await fetch('https://www.signwell.com/api/v1/'+path,{method:body?'POST':'GET',signal:AbortSignal.timeout(15000),headers:{'X-Api-Key':process.env.SIGNWELL_API_KEY,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});
 if(!response.ok)throw Object.assign(Error('SignWell could not confirm this request. Check the SignWell dashboard.'),{status:502,providerStatus:response.status});
 return response.json();
}
export function hasSigned(recipient){
 return Boolean(recipient?.signed_at)||['signed','completed'].includes(String(recipient?.status||'').trim().toLowerCase());
}
export function documentStatus(d){
 const status=String(d.status||'').trim().toLowerCase();
 if(status==='completed')return 'Complete';
 if(['declined','canceled','cancelled','expired','bounced','error'].includes(status))return status;
 if(['created','draft'].includes(status))return 'Draft ready to send';
 const recipients=d.recipients||[];
 const actor=recipients.find(r=>String(r.id)==='1');
 const producer=recipients.find(r=>String(r.id)==='2');
 if(!['created','draft'].includes(status)&&hasSigned(actor)&&hasSigned(producer)&&recipients.every(hasSigned))return 'Complete';
 return hasSigned(actor)?'Waiting on Heidi':'Waiting on actor';
}
// maxAge is how long a stored status is trusted before asking SignWell again.
// Pages people are looking at pass a short one; unattended jobs keep five minutes.
export async function refreshAgreement(store,key,force=false,maxAge=300000){
 const record=await store.getWithMetadata(key,{type:'json'}),a=record?.data;
 if(!a?.id||a.status==='Complete'||(!force&&Date.now()-(a.checkedAt||0)<maxAge))return a;
 try{
  const d=await signwell('documents/'+encodeURIComponent(a.id)+'/');
  const next={...a,status:documentStatus(d),providerStatus:String(d.status||'').toLowerCase(),...(typeof d.test_mode==='boolean'?{testMode:d.test_mode}:{}),checkedAt:Date.now(),syncError:null};
  await store.setJSON(key,next,{onlyIfMatch:record.etag});return next;
 }catch{const next={...a,checkedAt:Date.now(),syncError:'Status could not be refreshed. Last known status shown.'};await store.setJSON(key,next,{onlyIfMatch:record.etag});return next;}
}

export async function completedAgreementPdf(id){
 if(!process.env.SIGNWELL_API_KEY)throw Object.assign(Error('Signing service unavailable.'),{status:503});
 const response=await fetch('https://www.signwell.com/api/v1/documents/'+encodeURIComponent(id)+'/completed_pdf?audit_page=true&url_only=false',{
  headers:{'X-Api-Key':process.env.SIGNWELL_API_KEY,Accept:'application/pdf'},signal:AbortSignal.timeout(20000)
 });
 if(response.status===404||response.status===410)throw Object.assign(Error('SignWell no longer holds this agreement, so it cannot be downloaded here. Ask production for a copy.'),{status:404});
 if(!response.ok)throw Object.assign(Error('The signed PDF is unavailable from SignWell right now (SignWell returned '+response.status+'). Please try again shortly.'),{status:503});
 const bytes=new Uint8Array(await response.arrayBuffer());
 if(String.fromCharCode(...bytes.subarray(0,5))!=='%PDF-')throw Object.assign(Error('The signed PDF is still being prepared. Please try again shortly.'),{status:503});
 return bytes;
}
