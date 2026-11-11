import {comparePeople} from './people-order.mjs';

export function monthRange(month){
 const [year,number]=month.split('-').map(Number);
 return {from:month+'-01',to:month+'-'+String(new Date(Date.UTC(year,number,0)).getUTCDate()).padStart(2,'0')};
}
export function filmingDayState(day){
 if(!day)return 'waiting';
 const missing=(day.missing?.length||0)+(day.maybe?.length||0),unavailable=day.unavailable?.length||0,check=day.needsConfirmation?.length||0;
 if(day.selectedCount>0&&day.availableCount===day.selectedCount&&!missing&&!unavailable&&!check&&day.windows?.length)return 'free';
 if(unavailable)return 'no';
 if(missing||check)return 'waiting';
 return 'no';
}
export function filmingSuggestions(result,{today,includeWeekdays=false,limit=3}={}){
 const weekend=date=>[0,5,6].includes(new Date(date+'T12:00:00Z').getUTCDay());
 return (result?.days||[]).filter(day=>(!today||day.date>=today)&&filmingDayState(day)==='free'&&(includeWeekdays||weekend(day.date)))
  .sort((a,b)=>Number(!weekend(a.date))-Number(!weekend(b.date))||a.date.localeCompare(b.date)).slice(0,limit);
}
export function peopleForFilmingDay(members,selectedIds,date,filter='available'){
 const selected=new Set(selectedIds);
 return (members||[]).filter(member=>selected.has(member.id)).map(member=>({member,day:member.days?.find(day=>day.date===date)||{date,status:'unknown',windows:[]}}))
  .filter(({day})=>filter==='available'?day.status==='available':filter==='unavailable'?day.status==='unavailable':filter==='maybe'?day.status==='maybe':!['available','unavailable','maybe'].includes(day.status))
  .sort((a,b)=>comparePeople(a.member,b.member));
}
