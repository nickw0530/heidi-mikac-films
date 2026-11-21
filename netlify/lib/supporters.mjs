import {createHash} from 'node:crypto';

const fail=(ok,message,status=400)=>{if(!ok)throw Object.assign(Error(message),{status});};
const hash=value=>createHash('sha256').update(value).digest('hex');
const states=new Set(['paid','pending','failed','refunded','partially refunded']);
const own=(object,key)=>Object.hasOwn(object||{},key)?object[key]:undefined;
const money=value=>Number.isSafeInteger(value)&&value>=0&&value<=100000000;
const plain=(value,max=120)=>{
 fail(typeof value==='string'&&value.length<=max*4,'Enter plain text within the field limit.');
 const text=value.normalize('NFKC').trim().replace(/\s+/gu,' ');
 fail([...text].length<=max&&!/[<>\p{Cc}\p{Cf}\p{Cs}]/u.test(value)&&!/[<>\p{Cc}\p{Cf}\p{Cs}]/u.test(text),'Enter plain text within the field limit.');
 return text;
};
export function supporterIdentity(email){
 if(typeof email!=='string'||!email.trim())return '';
 const normalized=email.normalize('NFKC').trim().toLowerCase();
 fail(normalized.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized),'Enter a valid verified contact email.');
 // Only stored internally. Neither email nor this digest is sent to the wall.
 return 'email:'+hash(normalized);
}
export function paymentIdentity(payer){
 try{if(payer?.email_address)return supporterIdentity(payer.email_address);}catch{}
 return typeof payer?.payer_id==='string'?'paypal:'+hash(payer.payer_id):'';
}
const referenceKey=row=>row.reference&&row.processor?row.processor+':'+row.reference.trim():'';
const balance=row=>row.status==='paid'||row.source==='crowdfundr-public'&&row.status==='public'?row.gross:row.status==='partially refunded'&&money(row.refunded)&&row.refunded>0&&row.refunded<row.gross?row.gross-row.refunded:0;
const publicName=row=>{if(row.showName){try{return plain(row.name,120)||'Anonymous';}catch{}}return 'Anonymous';};
// Native public activity intentionally contains no amount when the donor hid
// it. Its zero sentinel is unknown, unlike stored website/manual/CSV balances.
const amountKnown=row=>row.source!=='crowdfundr-public'||row.showAmount===true||row.amountVerified===true;
const legacyCampaign={id:'e2ozh2',title:'Take Two: Written in the Dark Retake Fundraiser!',active:true};
export function supporterCampaigns(shop){
 const configured=shop.supporterLedger?.publicFeed?.campaigns;
 if(!Array.isArray(configured))return [{...legacyCampaign}];
 const seen=new Set(),campaigns=[];
 for(const entry of configured){
  if(!entry||typeof entry.id!=='string'||!/^[A-Za-z0-9_-]{4,40}$/.test(entry.id)||seen.has(entry.id)||typeof entry.active!=='boolean')continue;
  let title;try{title=plain(entry.title,120);}catch{continue;}
  if(!title)continue;
  seen.add(entry.id);campaigns.push({id:entry.id,title,active:entry.active});
 }
 return campaigns;
}

// The payment ledger remains the source of truth for website orders. Imported
// and manual support never mutate inventory or invent a merchandise sale.
export function supporterTransactions(shop,{includeArchived=false}={}){
 const website=Object.entries(shop.sales||{}).map(([id,sale])=>({
  id:'website:'+id,source:'website',reference:sale.captureId||'',processor:sale.channel==='PayPal checkout'?'paypal':'',
  channel:sale.channel||'Website merchandise',status:sale.status,
  gross:Number.isSafeInteger(sale.subtotal)?sale.subtotal:Number.isSafeInteger(sale.total)?Math.max(0,sale.total-(sale.shipping||0)):0,
  refunded:null,name:sale.recognition?.public===true?sale.recognition.name||'':'',
  showName:sale.recognition?.public===true,showAmount:sale.recognition?.showAmount===true,
  hidden:sale.supporterHidden===true,identity:sale.supporterIdentity||'',date:sale.paidAt||sale.createdAt||0
 }));
 const external=new Map(Object.values(shop.supporterLedger?.transactions||{}).map(row=>[row.id,row]));
 for(const row of Object.values(shop.supporterLedger?.apiRecords||{}))external.set(row.id,{...external.get(row.id),...row});
 const publicFeed=shop.supporterLedger?.publicFeed;
 if(publicFeed?.enabled)for(const row of Object.values(publicFeed.rows||{})){
  const campaignId=row.campaignId||legacyCampaign.id;
  const checkedAt=Array.isArray(publicFeed.campaigns)?publicFeed.campaigns.find(campaign=>campaign.id===campaignId)?.checkedAt:publicFeed.checkedAt;
  external.set(row.id,{...row,campaignId,publicStale:!Number.isFinite(checkedAt)||checkedAt>Date.now()+1000||Date.now()-checkedAt>300000});
 }
 return [...website,...external.values()].filter(row=>includeArchived||row.source!=='manual'||row.archived!==true).map(row=>{
  const override=own(shop.supporterLedger?.moderation,row.id)||{};
  const anonymousGross=row.source==='crowdfundr-public'&&money(override.anonymousGross)&&override.anonymousGross>0?override.anonymousGross:null;
  const amountVerified=anonymousGross!==null&&row.showAmount!==true&&publicName(row)==='Anonymous';
  return {...row,...(row.source==='crowdfundr-public'?{anonymousGross}:{}),amountVerified,...(amountVerified?{gross:anonymousGross}:{}),hidden:row.hidden||override.hidden===true||row.apiUnavailable===true||row.publicStale===true,duplicateOf:override.duplicateOf||'',sameSupporterAs:own(override,'sameSupporterAs')??row.sameSupporterAs??'',...(row.apiUnavailable||row.publicStale?{warning:'Current campaign privacy information is unavailable; credit is withheld until the next complete check.'}:{})};
 });
}

// Administrator-reviewed matches connect identities, not just the selected
// transaction. Other and future payments carrying that same verified identity
// remain together. Public privacy and eligibility are still applied per row.
function matchedIdentities(rows,moderation){
 const byId=new Map(rows.map(row=>[row.id,row])),parents=new Map(),authorities=new Map();
 const raw=row=>row.identity||row.id;
 const root=key=>{let current=key;while(parents.has(current)&&parents.get(current)!==current)current=parents.get(current);return current;};
 const pair=entry=>entry?.sameSupporterAs&&Array.isArray(entry.supporterIdentityPair)&&entry.supporterIdentityPair.length===2&&
  entry.supporterIdentityPair.every(key=>typeof key==='string'&&key&&key.length<=400)?entry.supporterIdentityPair:null;
 const join=(a,b)=>{
  if(!parents.has(a))parents.set(a,a);if(!parents.has(b))parents.set(b,b);
  const keys=[root(a),root(b)].sort();parents.set(keys[1],keys[0]);
 };
 for(const row of rows)parents.set(raw(row),raw(row));
 // Saved, server-derived proof remains valid when either reviewed payment is
 // later absent from a complete feed. It never keeps that payment credited.
 for(const entry of Object.values(moderation||{})){const saved=pair(entry);if(saved)join(...saved);}
 for(const row of rows){
  if(pair(own(moderation,row.id)))continue;
  const target=byId.get(row.sameSupporterAs);if(!target)continue;
  join(raw(row),raw(target));
 }
 for(const key of parents.keys()){
  const authority=/^(email|paypal|public-owner):/.exec(key)?.[1];if(!authority)continue;
  const canonical=root(key);if(!authorities.has(canonical))authorities.set(canonical,new Map());
  // Approved aliases are one person within every identity authority they carry.
  // Retaining all authorities prevents an unrelated matching display name from
  // bridging another verified owner after a cross-channel explicit match.
  authorities.get(canonical).set(authority,new Set([canonical]));
 }
 return {identity:row=>root(raw(row)),authorities:key=>authorities.get(root(key))||new Map()};
}

function creditIdentities(rows,identity,verifiedAuthorities){
 const parents=new Map(),authorities=new Map(),names=new Map();
 const root=key=>{
  let current=key;
  while(parents.has(current)&&parents.get(current)!==current)current=parents.get(current);
  return current;
 };
 for(const row of rows){
  if(!row.showName||row.hidden||row.duplicateOf||!money(row.gross)||!(balance(row)>0||row.source==='crowdfundr-public'&&row.status==='public'))continue;
  let name;try{name=plain(row.name,120).toLocaleLowerCase('en-US');}catch{continue;}
  if(!name||name==='anonymous')continue;
  const key=identity(row);
  if(!parents.has(key)){
   parents.set(key,key);
   authorities.set(key,new Map(verifiedAuthorities(key)));
  }
  if(!names.has(name))names.set(name,new Set());
  names.get(name).add(key);
 }
 for(const [,keys] of [...names].sort(([a],[b])=>a.localeCompare(b))){
  const roots=[...new Set([...keys].map(root))].sort();
  if(roots.length<2)continue;
  const combined=new Map();
  for(const key of roots)for(const [authority,values] of authorities.get(key)||[]){
   if(!combined.has(authority))combined.set(authority,new Set());
   for(const value of values)combined.get(authority).add(value);
  }
  // Public names connect manual entries and different payment channels. Two
  // different verified identities from the same provider remain distinct.
  // Component checks also prevent an alias from bridging conflicting people.
  if([...combined.values()].some(values=>values.size>1))continue;
  for(const key of roots)parents.set(key,roots[0]);
  authorities.set(roots[0],combined);
 }
 return row=>root(identity(row));
}

export function publicSupporters(shop,{scope='lifetime'}={}){
 fail(scope==='lifetime'||scope==='current','Choose lifetime or current campaign supporters.');
 const all=supporterTransactions(shop),publicMode=shop.supporterLedger?.publicFeed?.enabled===true;
 const activeCampaigns=new Set(supporterCampaigns(shop).filter(campaign=>campaign.active).map(campaign=>campaign.id));
 const inCurrentCampaign=row=>['crowdfundr','crowdfundr-public'].includes(row.source)&&activeCampaigns.has(row.campaignId||legacyCampaign.id);
 // The native public feed replaces imported/API Crowdfundr recognition as a
 // whole. Private transaction records remain available for administration.
 const rows=all.filter(row=>!publicMode||row.source!=='crowdfundr'),groups=new Map(),seen=new Set(),refs=new Map();
 for(const row of rows){const ref=referenceKey(row);if(ref&&!row.duplicateOf)refs.set(ref,[...(refs.get(ref)||[]),row]);}
 // Prefer verified website captures over imports, then imports over manual.
 rows.sort((a,b)=>({website:0,'crowdfundr-public':1,crowdfundr:2,manual:3}[a.source]-{website:0,'crowdfundr-public':1,crowdfundr:2,manual:3}[b.source])||a.id.localeCompare(b.id));
 const matched=matchedIdentities(all,shop.supporterLedger?.moderation);
 const credits=[];
 for(const original of rows){
  let row=original,anonymousAmountKnown=amountKnown(row);const ref=referenceKey(row);
  if(row.duplicateOf||ref&&seen.has(ref))continue;
  // Reserve even refunded/hidden canonical references so a stale import cannot
  // resurrect a refunded website payment or bypass moderation.
  if(ref)seen.add(ref);
  const copies=refs.get(ref);
  if(copies?.length>1){
   // Conflicting snapshots fail closed for status and privacy. A refunded
   // provider reference cannot be counted through an older CSV/manual copy.
   if(copies.some(copy=>!balance(copy)))continue;
   anonymousAmountKnown=copies.every(amountKnown);
   row={...row,gross:Math.min(...copies.map(balance)),status:'paid',showName:copies.every(copy=>copy.showName),showAmount:copies.every(copy=>copy.showAmount),hidden:copies.some(copy=>copy.hidden)};
  }
  const publicCredit=row.source==='crowdfundr-public'&&row.status==='public';
  if(row.hidden||!money(row.gross)||!publicCredit&&!balance(row))continue;
  // Reconcile copies before applying a display scope. A hidden/refunded or
  // private copy in another channel cannot be bypassed by a current-only view.
  if(scope==='current'&&!inCurrentCampaign(row)&&!copies?.some(inCurrentCampaign))continue;
  credits.push({...row,anonymousAmountKnown});
 }
 const creditIdentity=creditIdentities(credits,matched.identity,matched.authorities);
 for(const row of credits){
  const name=publicName(row);
  // A private-name transaction cannot be tied to a named transaction publicly.
  const groupKey=name==='Anonymous'?'anonymous:'+row.id:'named:'+creditIdentity(row);
  const group=groups.get(groupKey)||{name,amount:0,currency:'USD',date:0};
  if((row.date||0)>=group.date)group.name=name;
  const showAmount=name==='Anonymous'?row.anonymousAmountKnown:row.showAmount;
  group.amount=group.amount===null||!showAmount?null:group.amount+balance(row);
  group.date=Math.max(group.date,row.date||0);groups.set(groupKey,group);
 }
 return [...groups.values()].sort((a,b)=>b.date-a.date||a.name.localeCompare(b.name)).map(({date,...publicRow})=>publicRow);
}
// Moderation depends on the selected record, not the shop-wide revision that
// changes whenever a scheduled public-feed check refreshes its timestamp.
// Explicit keys keep this stable across object serialization and feed refreshes.
function moderationRevision(row){
 const fields=['id','source','reference','processor','channel','status','gross','refunded','name','showName','showAmount','hidden',
  'identity','date','duplicateOf','sameSupporterAs','apiUnavailable','publicStale','campaignId','archived','anonymousGross','amountVerified'];
 return hash(JSON.stringify(fields.map(key=>[key,row[key]??null])));
}
export function adminSupporters(shop){
 const campaigns=new Map(supporterCampaigns(shop).map(campaign=>[campaign.id,campaign]));
 return supporterTransactions(shop,{includeArchived:true}).map(row=>{
  const {identity,...safe}=row;
  const campaign=['crowdfundr','crowdfundr-public'].includes(row.source)?campaigns.get(row.campaignId||legacyCampaign.id):null;
  return {...safe,...(campaign?{campaignTitle:campaign.title}:{}),amount:balance(row),moderationRevision:moderationRevision(row)};
 }).sort((a,b)=>b.date-a.date||a.id.localeCompare(b.id));
}

// RFC 4180 quoting, BOM, CRLF, embedded commas and quoted newlines. Strict
// limits keep private uploads bounded and reject malformed or ambiguous input.
export function parseSupporterCsv(csv){
 fail(typeof csv==='string'&&Buffer.byteLength(csv,'utf8')<=2000000&&csv.length>0,'Choose a CSV file up to 2 MB.');
 csv=csv.replace(/^\uFEFF/,'');
 const rows=[];let row=[],field='',quoted=false,closed=false;
 const finishField=()=>{row.push(field);field='';closed=false;};
 const finishRow=()=>{finishField();if(row.some(value=>value.trim()))rows.push(row);row=[];fail(rows.length<=5001,'Import no more than 5,000 transactions at a time.');};
 for(let i=0;i<csv.length;i++){
  const c=csv[i];
  if(quoted){if(c==='"'){if(csv[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
  if(c==='"'){fail(!field&&!closed,'Malformed CSV quoting.');quoted=true;}
  else if(c===',')finishField();
  else if(c==='\n'||c==='\r'){if(c==='\r'&&csv[i+1]==='\n')i++;finishRow();}
  else{fail(!closed,'Malformed CSV quoting.');field+=c;}
 }
 fail(!quoted,'The CSV has an unclosed quoted field.');
 if(field||row.length||closed)finishRow();
 fail(rows.length>=2,'The CSV contains no transactions.');
 const headers=rows.shift().map(value=>value.trim());
 fail(new Set(headers).size===headers.length,'The CSV contains duplicate column names.');
 for(const required of ['Contribution amount','Currency','Payment status','Transaction ID','Name','Show name','Show amount'])fail(headers.includes(required),'Missing CSV column: '+required);
 return rows.map((values,index)=>{fail(values.length===headers.length,'CSV column count differs on row '+(index+2)+'.');return Object.fromEntries(headers.map((header,i)=>[header,values[i]]));});
}
const csvMoney=value=>{
 fail(typeof value==='string'&&/^\d{1,7}(?:\.\d{1,2})?$/.test(value.trim()),'CSV contribution amounts must be positive decimal USD values.');
 const [whole,fraction='']=value.trim().split('.'),amount=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 fail(money(amount)&&amount>0,'CSV contribution amount is outside the supported range.');return amount;
};
const csvStatus=value=>({paid:'paid',completed:'paid',pending:'pending',preapproved:'pending',failed:'failed',declined:'failed',cancelled:'failed',canceled:'failed',refunded:'refunded',reversed:'refunded','partially refunded':'partially refunded','partially_refunded':'partially refunded'}[value.trim().toLowerCase()]||'pending');
const ledger=shop=>shop.supporterLedger??={transactions:{},moderation:{}};
function validateSupporterMatch(rows,id,sameSupporterAs){
 fail(typeof sameSupporterAs==='string'&&sameSupporterAs.length<=240,'Choose an existing verified supporter.');
 if(!sameSupporterAs)return '';
 const byId=new Map(rows.map(row=>[row.id,row]));
 fail(byId.has(sameSupporterAs)&&sameSupporterAs!==id,'Choose an existing verified supporter.');
 let target=sameSupporterAs;const seen=new Set([id]);
 while(target){
  fail(!seen.has(target),'Supporter matches cannot form a cycle.');seen.add(target);
  target=byId.get(target)?.sameSupporterAs||'';
 }
 return sameSupporterAs;
}
function saveSupporterMatchProof(state,rows,id,sameSupporterAs){
 const override=state.moderation[id];
 if(!sameSupporterAs){delete override.supporterIdentityPair;return;}
 const source=rows.find(row=>row.id===id),target=rows.find(row=>row.id===sameSupporterAs);
 // The request chooses existing records; their private identity keys are always
 // derived here. No identity pair or identity value is accepted from the client.
 override.supporterIdentityPair=[source.identity||source.id,target.identity||target.id];
}
export function previewSupporterCsv(shop,csv){
 const parsed=parseSupporterCsv(csv),seen=new Map(),rows=[],summary={new:0,updated:0,unchanged:0,excluded:0,duplicates:0};
 const existingRefs=new Map(supporterTransactions(shop).map(row=>[referenceKey(row),row.id]).filter(([ref])=>ref));
 for(const input of parsed){
  const reference=plain(input['Transaction ID'],100);fail(reference&&reference!=='-','Every imported payment needs a transaction ID.');
  fail(input.Currency.trim().toUpperCase()==='USD','Only USD CSV transactions are supported. No currencies were converted.');
  const processor=({paypal:'paypal',stripe:'stripe'}[input['Processed by']?.trim().toLowerCase()]||'');
  const id='crowdfundr:'+hash((processor||'crowdfundr')+':'+reference);
  const name=input.Name.trim()==='-'?'':plain(input.Name,120),status=csvStatus(input['Payment status']);
  const row={id,source:'crowdfundr',reference,processor,channel:'Crowdfundr',status,gross:csvMoney(input['Contribution amount']),refunded:null,
   name,showName:input['Show name'].trim().toLowerCase()==='yes'&&!!name,showAmount:input['Show amount'].trim().toLowerCase()==='yes',
   identity:input['Contact email']&&input['Contact email'].trim()!=='-'?supporterIdentity(input['Contact email']):'',hidden:false,date:Date.parse(input.Date)||0};
  const fingerprint=JSON.stringify(row);
  if(seen.has(id)){fail(seen.get(id)===fingerprint,'Conflicting duplicate transaction IDs in this CSV. Export again before importing.');summary.duplicates++;continue;}
  seen.set(id,fingerprint);
  const previous=own(shop.supporterLedger?.transactions,id);
  // CSV exports do not provide a modification timestamp. A previously observed
  // refund must not be reversed by re-importing an older paid snapshot.
  const retainedRefund=previous&&(previous.status==='refunded'&&row.status!=='refunded'||previous.status==='partially refunded'&&!['partially refunded','refunded'].includes(row.status));
  if(retainedRefund)Object.assign(row,{status:previous.status,gross:previous.gross,refunded:previous.refunded??null});
  const change=!previous?'new':JSON.stringify(previous)===JSON.stringify(row)?'unchanged':'updated';summary[change]++;
  const duplicate=existingRefs.get(referenceKey(row));
  const warning=[retainedRefund?'Earlier CSV status ignored; the recorded refund was retained.':'',
   duplicate&&duplicate!==id?'Same processor reference as '+duplicate+'; counted only once.':'',
   row.status==='partially refunded'?'Partial refund amount unavailable; excluded until reviewed.':row.status==='pending'?'Unconfirmed or unknown payment status; excluded.':''].filter(Boolean).join(' ');
  if(!balance(row))summary.excluded++;
  rows.push({...row,change,warning});
 }
 return {digest:hash(csv),summary,rows};
}
export function importSupporterCsv(shop,input){
 fail(typeof input.csv==='string','Preview a CSV before importing.');
 fail(input.digest===hash(input.csv),'The preview no longer matches this file. Preview it again.',409);
 const preview=previewSupporterCsv(shop,input.csv),state=ledger(shop);
 for(const {change,warning,...row} of preview.rows)state.transactions[row.id]=row;
 return {saved:true,summary:preview.summary};
}
export function saveManualSupporter(shop,input){
 fail(typeof input.id==='string'&&/^manual:[a-f0-9-]{36}$/.test(input.id),'Reload the manual support form.');
 const state=ledger(shop),old=own(state.transactions,input.id);
 fail(!old||old.source==='manual','Only manual support can be edited here.');
 fail(old?.archived!==true,'Restore this deleted manual record before editing it.',409);
 fail(states.has(input.status)&&money(input.gross)&&input.gross>0,'Enter a valid status and gross USD amount.');
 fail(input.refunded==null||money(input.refunded)&&input.refunded<=input.gross,'Enter a refund within the original gross amount.');
 fail(input.status!=='partially refunded'||money(input.refunded)&&input.refunded>0&&input.refunded<input.gross,'Enter the confirmed partial refund amount.');
 fail(!['paid','pending','failed'].includes(input.status)||input.refunded==null||input.refunded===0,'Choose a refunded status when a refund amount is recorded.');
 fail(input.status!=='refunded'||input.refunded==null||input.refunded===input.gross,'A fully refunded payment must match its original gross amount.');
 for(const key of ['showName','showAmount','hidden'])fail(typeof input[key]==='boolean','Choose the supporter privacy settings.');
 const name=plain(input.name||'',120);fail(!input.showName||name,'Enter a name or keep it anonymous.');
 const processor=input.processor||'';fail(['','paypal','stripe'].includes(processor),'Choose a supported payment processor.');
 const reference=plain(input.reference||'',100),channel=plain(input.channel||'Offline / other',80);
 const sameSupporterAs=input.sameSupporterAs===undefined?old?.sameSupporterAs||'':input.sameSupporterAs||'';
 validateSupporterMatch(supporterTransactions(shop),input.id,sameSupporterAs);
 state.transactions[input.id]={id:input.id,source:'manual',reference,processor,channel,status:input.status,gross:input.gross,refunded:input.refunded??null,
  name,showName:input.showName,showAmount:input.showAmount,hidden:input.hidden,identity:input.identityEmail?supporterIdentity(input.identityEmail):old?.identity||'',sameSupporterAs,date:old?.date||Date.now()};
 if(own(state.moderation,input.id))state.moderation[input.id].hidden=input.hidden;
 if(input.sameSupporterAs!==undefined&&(sameSupporterAs||own(state.moderation,input.id))){
  state.moderation[input.id]??={hidden:input.hidden,duplicateOf:''};
  state.moderation[input.id].sameSupporterAs=sameSupporterAs;
  saveSupporterMatchProof(state,supporterTransactions(shop),input.id,sameSupporterAs);
 }
 return {saved:true};
}
export function moderateSupporter(shop,input){
 const rows=supporterTransactions(shop,{includeArchived:true}),row=rows.find(row=>row.id===input.id);
 fail(row,'Support transaction not found.',404);fail(typeof input.hidden==='boolean','Choose supporter visibility.');
 if(input.moderationRevision!==undefined)fail(typeof input.moderationRevision==='string'&&input.moderationRevision===moderationRevision(row),
  'This supporter changed. Refresh supporters and review this record before saving again.',409);
 if(input.archived!==undefined)fail(row.source==='manual'&&typeof input.archived==='boolean','Only manual records can be deleted or restored.');
 if(input.anonymousGross!==undefined)fail(row.source==='crowdfundr-public'&&publicName(row)==='Anonymous'&&
  (input.anonymousGross===null||money(input.anonymousGross)&&input.anonymousGross>0),'Enter a verified positive USD amount for an anonymous Crowdfundr payment, or clear the verification.');
 const duplicateOf=input.duplicateOf===undefined?row.duplicateOf||'':input.duplicateOf||'';
 fail(!duplicateOf||duplicateOf!==input.id&&rows.some(row=>row.id===duplicateOf&&!row.duplicateOf),'Choose a different original transaction.');
 const sameSupporterAs=input.sameSupporterAs===undefined?row.sameSupporterAs||'':validateSupporterMatch(rows.filter(record=>!record.archived),input.id,input.sameSupporterAs);
 // Restore cannot grant missing name/amount permission. Manual visibility is
 // edited on its form; moderation also applies to anonymous website orders.
 const state=ledger(shop);
 state.moderation[input.id]={...own(state.moderation,input.id),hidden:input.hidden,duplicateOf,sameSupporterAs};
 if(input.anonymousGross!==undefined)state.moderation[input.id].anonymousGross=input.anonymousGross;
 if(input.sameSupporterAs!==undefined)saveSupporterMatchProof(state,rows,input.id,sameSupporterAs);
 if(row.source==='manual')shop.supporterLedger.transactions[input.id].hidden=input.hidden;
 if(input.archived!==undefined)shop.supporterLedger.transactions[input.id].archived=input.archived;
 if(row.source==='website')shop.sales[input.id.slice(8)].supporterHidden=input.hidden;
 return {saved:true};
}
