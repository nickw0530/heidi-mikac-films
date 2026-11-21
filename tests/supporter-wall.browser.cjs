const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
// Optional isolated browser smoke test. APIs and PayPal are synthetic; no
// production data, browser profile, credentials, or payments are used.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const repo=path.resolve(__dirname,'..');
const screenshotDir=process.env.SCREENSHOT_DIR||os.tmpdir();
const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.webp':'image/webp','.jpg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml'};
const products=[{id:'blu-ray',name:'Written in the Light',price:4000,variants:[{id:'blu-ray',label:'Blu-ray',available:true}]},{id:'peach-tea-lady',name:'Peach Tea Lady',price:2500,variants:['S','M','L','XL','XXL'].map(size=>({id:'shirt-'+size.toLowerCase(),label:size,available:true}))}];
const sdk=`window.paypal={Buttons:config=>({render:async target=>{const button=document.createElement('button');button.type='button';button.textContent='Simulate approved PayPal';button.onclick=async()=>{await config.onClick({}, {resolve:()=>true,reject:()=>false});const id=await config.createOrder();await config.onApprove({orderID:id},{});};target.append(button);},close:async()=>{}})};`;
(async()=>{
 fs.mkdirSync(screenshotDir,{recursive:true});
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 try{
  const errors=[],requests=[],scopes=[];
  let supporters=Array.from({length:41},(_,index)=>({name:index===0?'<img src=x onerror="window.PWNED=true">':index===1?'Anonymous':'Film Supporter '+index,amount:index===1?null:1000+index*100,currency:'USD'}));
  let lifetimeSupporters=[{name:'Lifetime-only Supporter',amount:2000,currency:'USD'},...supporters];
  const campaigns=[{id:'e2ozh2',title:'Take Two: Written in the Dark Retake Fundraiser!',active:true},{id:'old',title:'An earlier film campaign',active:false}];
  async function open(options,pathname='/merch/'){
   const page=await browser.newPage(options);
   page.on('pageerror',error=>errors.push(error.message));
   await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname==='www.paypal.com')return route.fulfill({contentType:'text/javascript',body:sdk});
    if(url.hostname!=='localhost')return route.fulfill({contentType:'text/css',body:''});
    if(url.pathname==='/.netlify/functions/merch'){
     const action=url.searchParams.get('action');
     if(action==='supporters'){
      const scope=url.searchParams.get('scope');scopes.push(scope);assert.ok(['lifetime','current'].includes(scope));
      return route.fulfill({json:{supporters:scope==='lifetime'?lifetimeSupporters:supporters,campaigns}});
     }
     if(action==='create'){requests.push(route.request().postDataJSON());return route.fulfill({json:{id:'TESTORDER0000001'}});}
     if(action==='capture'){lifetimeSupporters=[...lifetimeSupporters,{name:'New Supporter',amount:4000,currency:'USD'}];return route.fulfill({json:{status:'paid',reference:'SYNTHETIC-CAPTURE'}});}
     return route.fulfill({json:{clientId:'synthetic-test-client',shipping:500,products,supporters:[]}});
    }
    if(url.pathname.startsWith('/.netlify/'))return route.fulfill({json:{}});
    const filename=path.join(repo,url.pathname.endsWith('/')?url.pathname+'index.html':url.pathname);
    if(!filename.startsWith(repo+path.sep)||!fs.existsSync(filename))return route.fulfill({status:404,body:'Missing test asset'});
    return route.fulfill({contentType:mime[path.extname(filename)]||'application/octet-stream',body:fs.readFileSync(filename)});
   });
   await page.goto('http://localhost:43124'+pathname);
   await page.locator('.supporter-names:not([aria-hidden]) li').last().waitFor();
   return page;
  }
  const desktop=await open({viewport:{width:1440,height:1050}});
  assert.equal(await desktop.locator('[data-supporter-title]').textContent(),'Take Two supporters');
  assert.equal(await desktop.locator('[data-supporter-wall]').count(),1);
  assert.deepEqual(await desktop.locator('.support-films img').evaluateAll(images=>images.map(image=>image.getAttribute('src'))),['/assets/dark-poster.webp','/assets/wherein-poster.webp'],'Both approved overlapping hero posters remain.');
  assert.ok(await desktop.evaluate(()=>!!(document.querySelector('#supporters').compareDocumentPosition(document.querySelector('.support-content'))&Node.DOCUMENT_POSITION_FOLLOWING)),'Current credits precede products and perks.');
  assert.ok(await desktop.locator('[data-supporter-viewport]').evaluate(node=>node.clientHeight<=168),'Credits use a compact three-row viewport.');
  assert.equal(await desktop.locator('.supporter-names:not([aria-hidden]) li').count(),41);
  assert.equal(await desktop.locator('[data-supporter-wall] img, [data-supporter-wall] script').count(),0);
  assert.equal(await desktop.evaluate(()=>window.PWNED),undefined);
  const heights=await desktop.locator('.supporter-names').evaluateAll(lists=>lists.map(list=>list.getBoundingClientRect().height));
  assert.equal(heights[0],heights[1],'Equal roll halves make the animation seamless.');
  await desktop.locator('[data-supporter-wall]').scrollIntoViewIfNeeded();
  await desktop.mouse.move(0,0);
  const before=await desktop.locator('[data-supporter-roll]').evaluate(node=>getComputedStyle(node).transform);
  await desktop.waitForTimeout(250);
  const after=await desktop.locator('[data-supporter-roll]').evaluate(node=>getComputedStyle(node).transform);
  assert.notEqual(before,after,'The credits continuously advance.');
  await desktop.getByRole('button',{name:'Pause credits',exact:true}).click();
  assert.equal(await desktop.locator('[data-supporter-roll]').evaluate(node=>getComputedStyle(node).animationName),'none');
  assert.equal(await desktop.locator('.supporter-names[aria-hidden]').evaluate(node=>getComputedStyle(node).display),'none');
  await desktop.locator('[data-supporter-viewport]').evaluate(node=>{node.scrollTop=node.scrollHeight;});
  assert.ok(await desktop.locator('[data-supporter-viewport]').evaluate(node=>node.scrollTop>0));
  await desktop.locator('[data-supporter-viewport]').evaluate(node=>{node.scrollTop=0;});
  await desktop.locator('#supporters').screenshot({path:path.join(screenshotDir,'hmf-supporter-wall-desktop.png')});
  await desktop.getByRole('button',{name:'Resume credits',exact:true}).click();
  assert.equal(await desktop.getByRole('button',{name:'Pause credits',exact:true}).evaluate(node=>document.activeElement===node),true);
  assert.equal(await desktop.locator('[data-supporter-roll]').evaluate(node=>getComputedStyle(node).animationPlayState),'running','Resume runs immediately while the control retains focus outside the credit viewport.');
  await desktop.locator('[data-product="blu-ray"] [data-add]').click();
  await desktop.locator('[data-open-cart]').click();
  assert.equal(await desktop.locator('#merch-cart').evaluate(node=>node.open),true);
  assert.equal(await desktop.locator('[data-subtotal]').textContent(),'$40.00');
  assert.equal(await desktop.locator('[data-total]').textContent(),'$45.00');
  assert.equal(await desktop.locator('[name=showAmount]').count(),0,'Checkout asks only whether to show the supporter name.');
  assert.equal(await desktop.locator('[name=public]').isChecked(),false);
  await desktop.locator('[name=public]').check();
  await desktop.locator('[name=displayName]').fill('New Supporter');
  await desktop.locator('[data-start-checkout]').click();
  await desktop.getByRole('button',{name:'Simulate approved PayPal',exact:true}).click();
  await desktop.locator('[data-cart-success]:not([hidden])').waitFor();
  await desktop.locator('[data-finish-order]').click();
  assert.deepEqual(requests[0].recognition,{public:true,name:'New Supporter',showAmount:true});
  assert.equal(requests[0].donation,0,'Merch remains a purchase.');
  assert.equal(await desktop.locator('[name=showAmount]').count(),0);
  assert.equal(await desktop.locator('.supporter-credit-name').filter({hasText:'New Supporter'}).count(),0,'Unassigned website purchases belong to lifetime support, not an active campaign.');
  const imageState=await desktop.locator('img').evaluateAll(images=>images.map(image=>({source:image.getAttribute('src'),loaded:image.complete&&image.naturalWidth>0})));
  assert.ok(imageState.every(image=>image.loaded),JSON.stringify(imageState));

  const homepage=await open({viewport:{width:1440,height:1050}},'/');
  assert.equal(await homepage.locator('[data-supporter-wall]').getAttribute('data-supporter-scope'),'lifetime');
  assert.ok(await homepage.evaluate(()=>{
   const hero=document.querySelector('#top'),credits=document.querySelector('#lifetime-supporters'),featured=document.querySelector('#featured');
   return !!(hero.compareDocumentPosition(credits)&Node.DOCUMENT_POSITION_FOLLOWING)&&!!(credits.compareDocumentPosition(featured)&Node.DOCUMENT_POSITION_FOLLOWING);
  }),'Lifetime credits follow the opening and precede Current Production.');
  assert.deepEqual(await homepage.locator('.hero-montage img').evaluateAll(images=>images.map(image=>image.getAttribute('src'))),['assets/wherein-poster.webp','assets/heidi-film.webp','assets/dark-poster.webp']);
  assert.equal(await homepage.locator('#homepage-promo .promo-media').count(),1,'The existing promo remains intact.');
  assert.equal(await homepage.locator('#featured img').getAttribute('src'),'assets/dark-poster.webp');
  assert.equal(await homepage.locator('#films .film-card img').count(),2);
  assert.equal(await homepage.locator('.supporter-names:not([aria-hidden]) .supporter-credit-name').filter({hasText:'New Supporter'}).count(),1,'Paid website purchases appear in lifetime credits.');
  await homepage.locator('#lifetime-supporters').screenshot({path:path.join(screenshotDir,'hmf-lifetime-supporters-desktop.png')});

  const mobile=await open({viewport:{width:390,height:844}});
  await mobile.locator('[data-supporter-wall]').scrollIntoViewIfNeeded();
  assert.ok(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No mobile document overflow.');
  assert.ok(await mobile.locator('[data-supporter-viewport]').evaluate(node=>node.clientHeight<=156));
  await mobile.locator('[data-supporter-wall]').screenshot({path:path.join(screenshotDir,'hmf-supporter-wall-mobile.png')});
  await mobile.locator('[data-product="peach-tea-lady"] input[value="shirt-m"]').check();
  await mobile.locator('[data-product="peach-tea-lady"] [data-add]').click();
  await mobile.locator('[data-open-cart]').click();
  assert.equal(await mobile.locator('[data-total]').textContent(),'$30.00');
  assert.ok(await mobile.locator('#merch-cart').evaluate(node=>node.scrollWidth<=node.clientWidth));
  await mobile.locator('.cart-remove').click();
  assert.equal(await mobile.locator('[data-cart-empty]').isVisible(),true);
  await mobile.locator('#merch-cart [data-close-cart]').first().click();

  const mobileHome=await open({viewport:{width:390,height:844}},'/');
  assert.ok(await mobileHome.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(await mobileHome.locator('.hero-montage img').count(),3);
  assert.equal(await mobileHome.locator('#featured img').getAttribute('src'),'assets/dark-poster.webp');
  await mobileHome.locator('#lifetime-supporters').screenshot({path:path.join(screenshotDir,'hmf-lifetime-supporters-mobile.png')});

  const reduced=await open({viewport:{width:390,height:844},reducedMotion:'reduce'});
  assert.equal(await reduced.locator('[data-supporter-roll]').evaluate(node=>getComputedStyle(node).animationName),'none');
  assert.equal(await reduced.getByRole('button',{name:'Motion reduced'}).isDisabled(),true);
  assert.equal(await reduced.locator('.supporter-names[aria-hidden]').evaluate(node=>getComputedStyle(node).display),'none');
  assert.equal(await reduced.locator('[data-supporter-viewport]').evaluate(node=>getComputedStyle(node).overflowY),'auto');
  await reduced.locator('[data-supporter-viewport]').evaluate(node=>{node.scrollTop=node.scrollHeight;});
  assert.ok(await reduced.locator('[data-supporter-viewport]').evaluate(node=>node.scrollTop>0));
  await reduced.locator('[data-supporter-wall]').screenshot({path:path.join(screenshotDir,'hmf-supporter-wall-reduced.png')});
  assert.deepEqual(errors,[]);
  assert.ok(scopes.includes('lifetime')&&scopes.includes('current'));
  console.log(JSON.stringify({result:'passed',checks:['1440px desktop','390px mobile without overflow','homepage lifetime/current merch scopes stay separate','approved posters/promo/featured artwork preserved','balanced strip placement','compact three-row credits','continuous seamless credits','all 41 supporters accessible','pause and browse','reduced motion static browse','text-only hostile name','all images load','desktop cart and synthetic checkout','name-only checkout with anonymous default','website purchases appear in lifetime credits','mobile shirt size/cart/remove'],screenshots:screenshotDir}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
