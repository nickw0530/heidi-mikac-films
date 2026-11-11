import {getStore} from '@netlify/blobs';
import {deliver} from '../lib/mail.mjs';
import {calendarNoticeValidator} from './calendar-callback.mjs';
export default async function(){
 const store=getStore({name:'hmf-members-v1',consistency:'strong'});
 await deliver(store,{currentCalendarEvent:calendarNoticeValidator(store)});
}
export const config={schedule:'*/5 * * * *'};
