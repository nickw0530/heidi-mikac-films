import {getStore} from '@netlify/blobs';
import {deliver} from '../lib/mail.mjs';
export default async function(){await deliver(getStore({name:'hmf-members-v1',consistency:'strong'}));}
export const config={schedule:'*/5 * * * *'};
