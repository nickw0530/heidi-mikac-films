// A blank date is unavailable only in a month containing at least one answer.
export const answeredStatus=status=>['available','unavailable','maybe','needs-confirmation'].includes(status);
export function rawAvailabilityDay(record,date){
 return record?.exceptions?.[date]||record?.weekly?.[new Date(date+'T12:00:00Z').getUTCDay()]||{status:'unknown',windows:[]};
}
export function monthHasAvailability(record,month){
 if(Object.values(record?.weekly||{}).some(day=>answeredStatus(day?.status)))return true;
 return Object.entries(record?.exceptions||{}).some(([date,day])=>date.startsWith(month+'-')&&answeredStatus(day?.status));
}
export function effectiveAvailabilityDay(record,date){
 const entry=rawAvailabilityDay(record,date);
 return entry.status==='unknown'&&monthHasAvailability(record,date.slice(0,7))?{...entry,status:'unavailable',implicit:true}:entry;
}
