import {getStore} from '@netlify/blobs';
import {adminActions,notifyAdmins} from '../lib/admin-actions.mjs';
const productions=[['written-in-the-dark','Written in the Dark'],['wherein-lies-continue','Wherein Lies Continue']];
export default async function(){
 const store=getStore({name:'hmf-members-v1',consistency:'strong'});
 const groups=await Promise.all(productions.map(async([production,name])=>({production,name,actions:await adminActions(store,production,{refresh:true})})));
 await notifyAdmins(store,groups);
}
export const config={schedule:'*/5 * * * *'};
