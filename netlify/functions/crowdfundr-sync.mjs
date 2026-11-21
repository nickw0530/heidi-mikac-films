import {getStore} from '@netlify/blobs';
import {merchStore} from '../lib/merch.mjs';
import {syncCrowdfundr} from '../lib/crowdfundr-sync.mjs';

export const config={schedule:'*/2 * * * *'};
export default async function run(req,context){
 if(process.env.NETLIFY_DEV==='true'||(process.env.CONTEXT&&process.env.CONTEXT!=='production')||context?.deploy?.published===false)return;
 const store=getStore({name:'hmf-members-v1',consistency:'strong'});
 await syncCrowdfundr(store,merchStore(true));
}
