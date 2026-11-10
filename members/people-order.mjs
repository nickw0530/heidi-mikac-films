// Shared ordering for every admin list of people. Never mutates source records.
const collator=new Intl.Collator('en-US',{sensitivity:'base',ignorePunctuation:true,numeric:true});
const nameOf=person=>String(typeof person==='string'?person:person?.name||'').normalize('NFKC').trim().replace(/\s+/g,' ');
export function comparePeople(a,b){
 const left=nameOf(a),right=nameOf(b);
 if(!left||!right)return Number(!left)-Number(!right);
 return collator.compare(left.split(' ')[0],right.split(' ')[0])||collator.compare(left,right);
}
export const sortPeople=people=>[...(people||[])].sort(comparePeople);

export function orderAdminPeople(state){
 if(!state?.admin)return state;
 const ordered={...state};
 for(const key of ['members','catalog','accounts','unassignedProfiles','unassigned','productionReviews','pendingPeople','revokedAccounts'])ordered[key]=sortPeople(state[key]);
 const people=new Map(['members','accounts','unassignedProfiles','unassigned','pendingPeople'].flatMap(key=>ordered[key]).map(person=>[person.id,person]));
 const reviews=new Map(ordered.productionReviews.map(person=>['production-request/'+state.productionId+'/'+person.requestId,person]));
 ordered.waiting=(state.waiting||[]).map(action=>({action,name:people.get(action.member)?.name||reviews.get(action.key)?.name||''}))
  .sort(comparePeople).map(({action})=>action);
 return ordered;
}
