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
const balance=row=>row.status==='paid'?row.gross:row.status==='partially refunded'&&money(row.refunded)&&row.refunded>0&&row.refunded<row.gross?row.gross-row.refunded:0;

// The payment ledger remains the source of truth for website orders. Imported
// and manual support never mutate inventory or invent a merchandise sale.
export function supporterTransactions(shop){
 const website=Object.entries(shop.sales||{}).map(([id,sale])=>({
  id:'website:'+id,source:'website',reference:sale.captureId||'',processor:sale.channel==='PayPal checkout'?'paypal':'',
  channel:sale.channel||'Website merchandise',status:sale.status,
  gross:Number.isSafeInteger(sale.subtotal)?sale.subtotal:Number.isSafeInteger(sale.total)?Math.max(0,sale.total-(sale.shipping||0)):0,
  refunded:null,name:sale.recognition?.public===true?sale.recognition.name||'':'',
  showName:sale.recognition?.public===true,showAmount:sale.recognition?.showAmount===true,
  hidden:sale.supporterHidden===true,identity:sale.supporterIdentity||'',date:sale.paidAt||sale.createdAt||0
 }));
 return [...website,...Object.values(shop.supporterLedger?.transactions||{})].map(row=>{
  const override=own(shop.supporterLedger?.moderation,row.id)||{};
  return {...row,hidden:row.hidden||override.hidden===true,duplicateOf:override.duplicateOf||'',sameSupporterAs:row.sameSupporterAs||''};
 });
}
export function publicSupporters(shop){
 const rows=supporterTransactions(shop),byId=new Map(rows.map(row=>[row.id,row])),groups=new Map(),seen=new Set(),refs=new Map();
 for(const row of rows){const ref=referenceKey(row);if(ref&&!row.duplicateOf)refs.set(ref,[...(refs.get(ref)||[]),row]);}
 // Prefer verified website captures over imports, then imports over manual.
 rows.sort((a,b)=>({website:0,crowdfundr:1,manual:2}[a.source]-{website:0,crowdfundr:1,manual:2}[b.source])||a.id.localeCompare(b.id));
 const identity=row=>{
  const visited=new Set();let current=row;
  while(current.sameSupporterAs&&byId.has(current.sameSupporterAs)&&!visited.has(current.id)){
   visited.add(current.id);current=byId.get(current.sameSupporterAs);
  }
  return current.identity||current.id;
 };
 for(const original of rows){
  let row=original;const ref=referenceKey(row);
  if(row.duplicateOf||ref&&seen.has(ref))continue;
  // Reserve even refunded/hidden canonical references so a stale import cannot
  // resurrect a refunded website payment or bypass moderation.
  if(ref)seen.add(ref);
  const copies=refs.get(ref);
  if(copies?.length>1){
   // Conflicting snapshots fail closed for status and privacy. A refunded
   // provider reference cannot be counted through an older CSV/manual copy.
   if(copies.some(copy=>!balance(copy)))continue;
   row={...row,gross:Math.min(...copies.map(balance)),status:'paid',showName:copies.every(copy=>copy.showName),showAmount:copies.every(copy=>copy.showAmount),hidden:copies.some(copy=>copy.hidden)};
  }
  if(row.hidden||!money(row.gross)||!balance(row))continue;
  let name='Anonymous';
  if(row.showName){try{name=plain(row.name,120)||'Anonymous';}catch{}}
  // A private-name transaction cannot be tied to a named transaction publicly.
  const groupKey=name==='Anonymous'?row.id:identity(row);
  const group=groups.get(groupKey)||{name,amount:0,currency:'USD',date:0};
  if((row.date||0)>=group.date)group.name=name;
  group.amount=group.amount===null||!row.showAmount?null:group.amount+balance(row);
  group.date=Math.max(group.date,row.date||0);groups.set(groupKey,group);
 }
 return [...groups.values()].sort((a,b)=>b.date-a.date||a.name.localeCompare(b.name)).map(({date,...publicRow})=>publicRow);
}
export function adminSupporters(shop){
 return supporterTransactions(shop).map(({identity,...row})=>({...row,amount:balance(row)})).sort((a,b)=>b.date-a.date||a.id.localeCompare(b.id));
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
 if(sameSupporterAs){
  const rows=new Map(supporterTransactions(shop).map(row=>[row.id,row]));
  fail(rows.has(sameSupporterAs)&&sameSupporterAs!==input.id,'Choose an existing verified supporter.');
  let target=rows.get(sameSupporterAs),seen=new Set([input.id]);
  while(target){fail(!seen.has(target.id),'Supporter matches cannot form a cycle.');seen.add(target.id);target=rows.get(target.sameSupporterAs);}
 }
 state.transactions[input.id]={id:input.id,source:'manual',reference,processor,channel,status:input.status,gross:input.gross,refunded:input.refunded??null,
  name,showName:input.showName,showAmount:input.showAmount,hidden:input.hidden,identity:input.identityEmail?supporterIdentity(input.identityEmail):old?.identity||'',sameSupporterAs,date:old?.date||Date.now()};
 if(own(state.moderation,input.id))state.moderation[input.id].hidden=input.hidden;
 return {saved:true};
}
export function moderateSupporter(shop,input){
 const rows=supporterTransactions(shop),row=rows.find(row=>row.id===input.id);
 fail(row,'Support transaction not found.',404);fail(typeof input.hidden==='boolean','Choose supporter visibility.');
 const duplicateOf=input.duplicateOf||'';
 fail(!duplicateOf||duplicateOf!==input.id&&rows.some(row=>row.id===duplicateOf&&!row.duplicateOf),'Choose a different original transaction.');
 // Restore cannot grant missing name/amount permission. Manual visibility is
 // edited on its form; moderation also applies to anonymous website orders.
 ledger(shop).moderation[input.id]={hidden:input.hidden,duplicateOf};
 if(row.source==='manual')shop.supporterLedger.transactions[input.id].hidden=input.hidden;
 if(row.source==='website')shop.sales[input.id.slice(8)].supporterHidden=input.hidden;
 return {saved:true};
}
