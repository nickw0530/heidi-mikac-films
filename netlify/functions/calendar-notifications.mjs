import {getStore} from '@netlify/blobs';
import {notifyNewEvents} from './calendar-callback.mjs';
import {enqueue,portalUrl} from '../lib/mail.mjs';

export const config={schedule:'*/5 * * * *'};
export default async function run(){
 if(process.env.NETLIFY_DEV==='true'||(process.env.CONTEXT&&process.env.CONTEXT!=='production'))return;
 const store=getStore({name:'hmf-members-v1',consistency:'strong'});
 await notifyNewEvents(store,enqueue,portalUrl);
}
