import {getStore} from '@netlify/blobs';
import {adminActions,notifyAdmins} from '../lib/admin-actions.mjs';
const productions=[['written-in-the-dark','Written in the Dark'],['wherein-lies-continue','Wherein Lies Continue']];
// Netlify runs schedules only on the published deploy, but a manual "Run now" on a preview
// would otherwise run preview code against live records.
const published=context=>context?.deploy?.published!==false;
export default async function(req,context){
 if(!published(context))return;
 const store=getStore({name:'hmf-members-v1',consistency:'strong'});
 const groups=await Promise.all(productions.map(async([production,name])=>({production,name,actions:await adminActions(store,production,{refresh:true})})));
 await notifyAdmins(store,groups);
}
export const config={schedule:'*/5 * * * *'};
