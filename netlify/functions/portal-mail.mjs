import {getStore} from '@netlify/blobs';
import {deliver} from '../lib/mail.mjs';
import {calendarNoticeValidator} from './calendar-callback.mjs';
// Netlify runs schedules only on the published deploy, but a manual "Run now" on a preview
// would otherwise run preview code against live records.
const published=context=>context?.deploy?.published!==false;
export default async function(req,context){
 if(!published(context))return;
 const store=getStore({name:'hmf-members-v1',consistency:'strong'});
 await deliver(store,{currentCalendarEvent:calendarNoticeValidator(store)});
}
export const config={schedule:'*/5 * * * *'};
