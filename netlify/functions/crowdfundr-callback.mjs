import {getStore} from '@netlify/blobs';
import {completeCrowdfundr,crowdfundrHeaders,crowdfundrCookie} from '../lib/crowdfundr-oauth.mjs';

export default async function callback(req){
 const headers={...crowdfundrHeaders,'Set-Cookie':crowdfundrCookie('',0)};
 try{
  if(process.env.NETLIFY_DEV==='true'||process.env.CONTEXT&&process.env.CONTEXT!=='production')throw Error();
  const store=getStore({name:'hmf-members-v1',consistency:'strong'});
  await completeCrowdfundr(store,req);
  // Payment reconciliation runs through Sync now or the scheduled function,
  // keeping this callback bounded and successful authorization independent of
  // the provider's payment/privacy response contract.
  return new Response(null,{status:303,headers:{...headers,Location:'/members/?view=website&crowdfundr=connected'}});
 }catch{
  return new Response('Crowdfundr connection did not finish. Return to Website settings in the administrator portal and try connecting again.',{status:400,headers});
 }
}
