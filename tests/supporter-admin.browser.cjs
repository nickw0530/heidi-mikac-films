const fs=require('node:fs');
const assert=require('node:assert/strict');
// Optional browser smoke test. Set PLAYWRIGHT_MODULE to a Playwright install
// and CHROME_PATH to a Chrome executable when its bundled browser is absent.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const repo=require('node:path').resolve(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('http://localhost:43123/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/members/admin-workspace.css"><style>body{background:#17131a;color:#fff;font-family:sans-serif}label{display:block}input,select{display:block;box-sizing:border-box;max-width:100%}td,th{overflow-wrap:anywhere}form{max-width:100%}</style><main class="admin-workspace"><section data-merch-root><div id="host"></div></section></main>'});
  route.fulfill({contentType:path.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(repo+path,'utf8')});
 });
 await page.goto('http://localhost:43123/');
 await page.evaluate(async()=>{
  window.calls=[];window.revision='r1';window.crowdfundr={clientId:'',revision:'c1',connected:false,privacyReady:false,active:false,lastSync:null,lastError:'',publicFeedEnabled:false,publicActive:false,publicLastSync:null,publicCount:0,publicLastError:''};
  window.transactions=[{id:'website:ORDER1',source:'website',reference:'PAYPAL1',processor:'paypal',status:'paid',gross:4000,refunded:0,name:'<img src=x onerror="window.PWNED=true">',showName:true,showAmount:false,hidden:false,duplicateOf:'',channel:'PayPal checkout',date:Date.now()},{id:'manual:11111111-1111-4111-8111-111111111111',source:'manual',reference:'OFFLINE1',status:'paid',gross:1000,refunded:0,name:'Ada Example',showName:true,showAmount:true,hidden:false,duplicateOf:'',channel:'Cash',date:Date.now()}];
  const request=async(action,input)=>{
   window.calls.push({action,input});
   if(action==='crowdfundrSettings'){
    if(input){window.crowdfundr.clientId=input.clientId;window.crowdfundr.revision='c2';}
    return structuredClone(window.crowdfundr);
   }
   if(action==='crowdfundrPublicMode'){
    assertPublicRevision(input);
    Object.assign(window.crowdfundr,{publicFeedEnabled:input.enabled,publicActive:input.enabled,publicLastSync:input.enabled?Date.now():window.crowdfundr.publicLastSync,publicCount:input.enabled?2:window.crowdfundr.publicCount,publicLastError:'',revision:input.enabled?'public-on':'public-off'});
    return {enabled:input.enabled,active:input.enabled};
   }
   if(action==='crowdfundrPublicSync'){window.crowdfundr.publicLastSync=Date.now();return {enabled:true,active:true};}
   if(action==='crowdfundrSync')return {connected:true};
   if(action==='crowdfundrDisconnect'){window.crowdfundr.connected=false;window.crowdfundr.active=false;window.crowdfundr.privacyReady=false;return {disconnected:true};}
   if(action==='supporterLedger')return {revision:window.revision,transactions:structuredClone(window.transactions)};
   if(action==='supporterPreview')return {revision:window.revision,digest:'digest',summary:{new:1,unchanged:0,updated:0,excluded:0,duplicates:0},rows:[{id:'crowdfundr:T1',reference:'T1',gross:1000,name:'<script>window.PWNED=true</script>',status:'paid',showName:false,showAmount:false,change:'new'}]};
   if(action==='supporterImport'){window.revision='r2';return {saved:true,summary:{new:1}};}
   if(action==='supporterSave'){window.savedManual=structuredClone(input);window.revision='r3';return {saved:true};}
   if(action==='supporterModerate'){const row=window.transactions.find(row=>row.id===input.id);Object.assign(row,input);window.revision='r4';return {saved:true};}
   throw Error('Unknown action');
  };
  function assertPublicRevision(input){if(input.revision!==window.crowdfundr.revision)throw Error('Public mode revision mismatch');}
  const {mountSupporters}=await import('/members/supporters.js');
  window.management=await mountSupporters(document.querySelector('#host'),request);
 });
 assert.equal(await page.locator('[data-supporter-ledger-rows] tr').count(),2);
 assert.match(await page.locator('[data-crowdfundr-state]').innerText(),/^Not connected/);
 assert.equal(await page.getByRole('button',{name:'Sync now',exact:true}).isDisabled(),true);
 assert.equal(await page.locator('#host img, #host script').count(),0);
 assert.match(await page.locator('[data-crowdfundr-public-state]').innerText(),/not enabled/);
 assert.equal(await page.getByRole('button',{name:'Check public credits now',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Enable automatic public credits',exact:true}).click();
 await page.getByText('Automatic public credits are connected. Future public online contributions update without CSV imports.',{exact:true}).waitFor();
 assert.match(await page.locator('[data-crowdfundr-public-state]').innerText(),/No new CSV is needed/);
 assert.match(await page.locator('[data-crowdfundr-public-time]').innerText(),/2 public online credits/);
 assert.equal(await page.locator('[data-crowdfundr-api]').evaluate(node=>node.open),false);
 await page.locator('[data-crowdfundr-api] > summary').click();
 assert.equal(await page.getByRole('button',{name:'Sync now',exact:true}).isVisible(),true,'Advanced API controls remain reachable while public mode is active.');
 await page.getByRole('button',{name:'Check public credits now',exact:true}).click();
 await page.getByText('Public campaign credits checked. The wall refreshes within a few seconds.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.action==='crowdfundrPublicSync').length),1);
 await page.getByRole('button',{name:'Use CSV credits instead',exact:true}).click();
 await page.getByText('Automatic public credits are off. Crowdfundr recognition uses the saved CSV records again.',{exact:true}).waitFor();
 assert.match(await page.locator('[data-crowdfundr-public-state]').innerText(),/not enabled/);
 assert.equal(await page.locator('[data-supporter-ledger-rows] tr').count(),2,'Switching public mode preserves private supporter records.');
 await page.locator('[data-supporter-import] summary').click();
 await page.locator('input[type=file]').setInputFiles({name:'transactions.csv',mimeType:'text/csv',buffer:Buffer.from('Transaction ID,Contribution amount\nT1,10.00')});
 await page.getByRole('button',{name:'Preview import',exact:true}).click();
 await page.getByText('Preview ready. No records have been imported yet.').waitFor();
 assert.equal(await page.locator('[data-supporter-preview-rows] tr').count(),1);
 assert.equal((await page.evaluate(()=>window.calls.filter(call=>call.action==='supporterImport').length)),0);
 await page.getByRole('button',{name:'Confirm CSV import',exact:true}).click();
 await page.getByText(/Import saved: 1 new/).waitFor();
 const imported=await page.evaluate(()=>window.calls.find(call=>call.action==='supporterImport').input);
 assert.equal(imported.digest,'digest');assert.equal(imported.revision,'r1');assert.ok(imported.csv.includes('T1,10.00'));
 await page.locator('[data-supporter-manual] summary').click();
 const form=page.locator('[data-supporter-manual-form]');
 await form.locator('[name=name]').fill('Repeat Supporter');
 await form.locator('[name=gross]').fill('15.50');
 await form.locator('[name=channel]').fill('Venmo');
 await form.locator('[name=reference]').fill('VENMO-123');
 await form.locator('[name=identityEmail]').fill('verified@example.test');
 await form.locator('[name=showName]').check();
 await form.locator('[name=showAmount]').check();
 await form.getByRole('button',{name:'Save manual support',exact:true}).click();
 await form.getByText(/Manual support saved/).waitFor();
 const saved=await page.evaluate(()=>window.savedManual);
 assert.equal(saved.gross,1550);assert.equal(saved.showName,true);assert.equal(saved.showAmount,true);assert.equal(saved.identityEmail,'verified@example.test');assert.equal(saved.revision,'r2');
 await page.locator('[data-supporter-ledger-rows] tr').first().getByRole('button',{name:'Hide payment',exact:true}).click();
 await page.getByText(/Supporter visibility saved/).waitFor();
 assert.equal(await page.evaluate(()=>window.transactions[0].hidden),true);
 await page.locator('[data-supporter-ledger-rows] tr').first().getByRole('button',{name:'Review duplicate',exact:true}).click();
 const moderation=page.locator('[data-supporter-moderation]');
 await moderation.locator('select').selectOption('manual:11111111-1111-4111-8111-111111111111');
 await moderation.getByRole('button',{name:'Save duplicate review',exact:true}).click();
 await page.getByText('Duplicate review saved.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.transactions[0].duplicateOf),'manual:11111111-1111-4111-8111-111111111111');
 await page.locator('[data-crowdfundr-config] [name=clientId]').fill('approved-client');
 await page.getByRole('button',{name:'Save Client ID',exact:true}).click();
 await page.getByText('Client ID saved. Continue with Authorize read-only access.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Authorize read-only access',exact:true}).isEnabled(),true);
 await page.evaluate(()=>{window.crowdfundr.connected=true;window.crowdfundr.lastError='Current Show name / Show amount fields are missing.';});
 await page.getByRole('button',{name:'Refresh connection status',exact:true}).click();
 assert.match(await page.locator('[data-crowdfundr-state]').innerText(),/Automatic publication is not activated/);
 await page.getByRole('button',{name:'Sync now',exact:true}).click();
 await page.getByText(/Automatic publication remains inactive until privacy fields are verified/).waitFor();
 assert.equal(await page.locator('[data-crowdfundr-action-status]').innerText().then(value=>value.includes('synchronization completed')),false);
 await page.evaluate(()=>{Object.assign(window.crowdfundr,{privacyReady:true,active:true,lastSync:Date.now(),lastError:''});});
 await page.getByRole('button',{name:'Sync now',exact:true}).click();
 await page.getByText('Crowdfundr synchronization completed. The supporter wall refreshes within a few seconds.',{exact:true}).waitFor();
 assert.match(await page.locator('[data-crowdfundr-state]').innerText(),/Automatic checks run about every two minutes/);
 await page.evaluate(()=>{Object.assign(window.crowdfundr,{active:false,lastError:'Crowdfundr access is unavailable. Reconnect the approved app.'});});
 await page.getByRole('button',{name:'Sync now',exact:true}).click();
 await page.getByText(/Automatic publication remains paused/).waitFor();
 assert.match(await page.locator('[data-crowdfundr-state]').innerText(),/Automatic publication is paused/);
 assert.equal(await page.locator('[data-crowdfundr-action-status]').innerText().then(value=>value.includes('synchronization completed')),false);
 await page.getByRole('button',{name:'Disconnect locally',exact:true}).click();
 await page.getByText(/Local access credentials removed/).waitFor();
 assert.match(await page.locator('[data-crowdfundr-state]').innerText(),/^Not connected/);
 assert.equal(await page.locator('[data-supporter-ledger-rows] tr').count(),2,'Disconnect preserves the supporter records.');
 assert.equal(await page.evaluate(()=>window.PWNED),undefined);
 assert.deepEqual(errors,[]);
 const dimensions=await page.evaluate(()=>({width:innerWidth,body:document.documentElement.scrollWidth}));
 assert.equal(dimensions.body<=dimensions.width,true,JSON.stringify(dimensions));
 console.log(JSON.stringify({result:'passed',checks:['ledger loading','text-only hostile names','automatic public credits enable/check/disable','public mode revision and private ledger preservation','advanced API controls reachable during public mode','CSV preview before commit','digest/revision import confirmation','manual amount/privacy/verified identity payload','hide payment','duplicate review','Crowdfundr app configuration','disconnected vs privacy missing vs active vs paused state','no false synchronization completion','disconnect preserves supporters','390px no document overflow','no browser errors']}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
