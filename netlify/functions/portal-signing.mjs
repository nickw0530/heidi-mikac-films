import {getStore} from '@netlify/blobs';
import {adminActions,notifyAdmins} from '../lib/admin-actions.mjs';
export default async function(){
 const store=getStore({name:'hmf-members-v1',consistency:'strong'});
 await Promise.all(['written-in-the-dark','wherein-lies-continue'].map(async production=>{
  await notifyAdmins(store,production,await adminActions(store,production,true));
 }));
}
export const config={schedule:'*/5 * * * *'};
