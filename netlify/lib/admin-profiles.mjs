export const adminProfilesKey='settings/admin-profiles';
const identities={
 Nick:{name:'Nick Williams',films:{'written-in-the-dark':'nick','wherein-lies-continue':'nick-williams'}},
 Heidi:{name:'Heidi Mikac',films:{'written-in-the-dark':'heidi','wherein-lies-continue':'heidi'}}
};
const memberId=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export async function loadAdminProfiles(store){
 const value=await store.get(adminProfilesKey,{type:'json'});
 if(!memberId.test(value?.Nick||'')||!memberId.test(value?.Heidi||'')||value.Nick===value.Heidi)return {};
 return {Nick:value.Nick,Heidi:value.Heidi};
}

export function adminProfileOwner(bindings,member){
 const id=typeof member==='string'?member:member?.id;
 return id&&Object.keys(identities).find(owner=>bindings[owner]===id)||null;
}

export function adminProfileCandidates(members,assignments,findProfile){
 const candidates={};
 for(const [owner,{name,films}] of Object.entries(identities)){
  const named=members.filter(member=>!member.revoked&&!member.pendingContact&&memberId.test(member.id)&&member.name.trim().toLowerCase()===name.toLowerCase());
  if(named.length!==1)return null;
  const member=named[0],assigned=Object.keys(assignments(member));
  if(!assigned.length||assigned.some(id=>findProfile(member,id)?.id!==films[id]))return null;
  candidates[owner]=member.id;
 }
 return candidates;
}
