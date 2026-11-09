import {AGREEMENT_CYCLE} from './agreement-cycle.mjs';

export const manualAgreementKey=(production,member)=>'document-tracking/'+production+'/'+member+'/agreement-'+AGREEMENT_CYCLE;
export const resourceTrackingKey=(production,member,document)=>'document-tracking/'+production+'/'+member+'/'+document;
export function normalizePaperworkReason(reason){
 return reason==='complete'||reason==='hard-copy'?'complete':reason==='not-required'?'not-required':null;
}
export function manualPaperworkStatus(record){
 if(record?.document==='agreement'&&record.agreementCycle!==AGREEMENT_CYCLE)return null;
 const reason=normalizePaperworkReason(record?.reason);
 return reason==='complete'?'Complete':reason==='not-required'?'Document N/A':null;
}
export async function readAgreementTracking(store,production,member){
 const record=await store.get(manualAgreementKey(production,member),{type:'json'});
 return record?.document==='agreement'&&record.agreementCycle===AGREEMENT_CYCLE&&manualPaperworkStatus(record)?{...record,reason:normalizePaperworkReason(record.reason)}:null;
}
