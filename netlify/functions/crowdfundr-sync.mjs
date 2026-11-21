import {getStore} from '@netlify/blobs';
import {merchStore} from '../lib/merch.mjs';
import {syncCrowdfundr} from '../lib/crowdfundr-sync.mjs';
import {syncPublicCrowdfundr} from '../lib/crowdfundr-public.mjs';

export const config={schedule:'*/2 * * * *'};
export default async function run(req,context){
 if(process.env.NETLIFY_DEV==='true'||(process.env.CONTEXT&&process.env.CONTEXT!=='production')||context?.deploy?.published===false)return;
 const store=getStore({name:'hmf-members-v1',consistency:'strong'});
 if((await store.get('crowdfundr/config',{type:'json'}))?.publicFeedEnabled===true){await syncPublicCrowdfundr(store,merchStore(true));return;}
 await syncCrowdfundr(store,merchStore(true));
}
