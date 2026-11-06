import {getStore} from '@netlify/blobs';
import {checkSigningNotices} from '../lib/signing-notices.mjs';

export default async function(){
 await checkSigningNotices(getStore({name:'hmf-members-v1',consistency:'strong'}));
}
export const config={schedule:'*/5 * * * *'};
