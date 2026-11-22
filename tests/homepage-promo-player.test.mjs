import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the real classic script against isolated DOM/media/API doubles.
// No browser, YouTube request, real video, or production service is used.
const source=await readFile(new URL('../site.js',import.meta.url),'utf8');
const id='3BBwFYbe09M',origin='https://example.invalid';
const flush=()=>new Promise(resolve=>setImmediate(resolve));

class Element {
  constructor(tag){
    this.tagName=tag.toUpperCase();this.children=[];this.events=new Map();this.attributes=new Map();this.hidden=false;
    this.className='';this.textContent='';this.naturalWidth=1280;
    if(tag==='video'){
      this.paused=true;this.played={length:0};this.playCalls=0;this.pauseCalls=0;this.loadCalls=0;
      this.play=()=>{this.playCalls++;this.paused=false;this.played.length=1;this.emit('playing');return Promise.resolve();};
      this.pause=()=>{this.pauseCalls++;this.paused=true;this.emit('pause');};
      this.load=()=>{this.loadCalls++;};
    }
    if(tag==='track')this.track={mode:'disabled'};
  }
  append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
  prepend(node){node.remove();node.parentNode=this;this.children.unshift(node);}
  remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(node=>node!==this);this.parentNode=null;}}
  replaceWith(node){const parent=this.parentNode,index=parent.children.indexOf(this);node.remove();parent.children[index]=node;node.parentNode=parent;this.parentNode=null;}
  setAttribute(key,value){this.attributes.set(key,String(value));}
  getAttribute(key){return this.attributes.get(key)??null;}
  removeAttribute(key){this.attributes.delete(key);delete this[key];}
  addEventListener(type,run,options={}){if(!this.events.has(type))this.events.set(type,[]);this.events.get(type).push({run,once:options.once});}
  removeEventListener(type,run){this.events.set(type,(this.events.get(type)||[]).filter(item=>item.run!==run));}
  emit(type,properties={}){
    const event={target:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...properties};
    for(const item of [...(this.events.get(type)||[])]){if(item.once)this.removeEventListener(type,item.run);item.run(event);}
    return event;
  }
  matches(selector){
    if(selector.startsWith('.'))return this.className.split(' ').includes(selector.slice(1));
    if(selector==='[data-promo-button]')return this.attributes.has('data-promo-button');
    if(selector.startsWith('script['))return this.tagName==='SCRIPT'&&this.src==='https://www.youtube.com/iframe_api';
    return this.tagName===selector.toUpperCase();
  }
  querySelector(selector){
    const [first,...rest]=selector.split(' ');
    for(const child of this.children){
      if(child.matches(first)){if(!rest.length)return child;const nested=child.querySelector(rest.join(' '));if(nested)return nested;}
      const found=child.querySelector(selector);if(found)return found;
    }
    return null;
  }
}

function fixture({reduced=false,api=true,payload}={}){
  const created=[],timers=new Map(),players=[],fetches=[];let timerId=0;
  const doc={head:new Element('head'),activePromo:null,hero:new Element('section'),
    createElement(tag){const element=new Element(tag);created.push(element);return element;},
    querySelector(selector){if(selector==='#homepage-promo')return this.activePromo;if(selector==='#top')return this.hero;return this.head.querySelector(selector);},
    addEventListener(){}
  };
  const window={SITE_CONTENT:{}};
  const installApi=()=>{window.YT={Player:function(target,options){
    this.options=options;this.calls=[];this.iframe=doc.createElement('iframe');target.replaceWith(this.iframe);
    this.mute=()=>this.calls.push('mute');this.playVideo=()=>this.calls.push('play');this.getIframe=()=>this.iframe;
    this.destroy=()=>{this.calls.push('destroy');this.iframe.remove();};
    this.ready=()=>options.events.onReady({target:this});
    this.block=()=>options.events.onAutoplayBlocked({target:this});
    this.error=()=>options.events.onError({target:this,data:101});
    players.push(this);
  }};};
  if(api)installApi();
  const context=vm.createContext({window,document:doc,location:{origin},URL,AbortSignal,
    matchMedia:()=>({matches:reduced}),
    setTimeout(run,delay){const key=++timerId;timers.set(key,{run,delay});return key;},clearTimeout(key){timers.delete(key);},
    async fetch(url,options){fetches.push({url,options});return {ok:true,json:async()=>payload};}
  });
  vm.runInContext(source,context);
  const functions=vm.runInContext('({mountPromoVideo,renderHomepagePromo,loadYouTubeApi})',context);
  const makePromo=()=>{
    const promo=doc.createElement('section');promo.hidden=true;
    const headline=doc.createElement('h1'),media=doc.createElement('div');media.className='promo-media';
    const link=doc.createElement('a');link.className='promo-player';
    const watch=doc.createElement('span');watch.className='promo-watch';watch.textContent='Watch full video';link.append(watch);
    const motion=doc.createElement('button');motion.className='promo-motion';motion.hidden=true;motion.textContent='Play preview';media.append(link,motion);
    const viewer=doc.createElement('dialog');viewer.className='promo-viewer';viewer.showModal=()=>{viewer.open=true;};viewer.append(doc.createElement('video'));
    const button=doc.createElement('a');button.setAttribute('data-promo-button','');button.hidden=true;
    promo.append(headline,media,button,viewer);
    return {promo,link,motion,media,viewer,headline,button};
  };
  return {...makePromo(),...functions,doc,window,created,players,timers,fetches,makePromo,installApi,
    runTimer(delay){const entry=[...timers].find(([,timer])=>timer.delay===delay);assert.ok(entry,'Expected a pending timeout.');timers.delete(entry[0]);entry[1].run();}};
}

test('legacy generic YouTube keeps its click poster and modifier navigation without loading the player API',()=>{
  const f=fixture({api:false});
  assert.equal(f.mountPromoVideo(f.promo,id,''),true);
  assert.equal(f.link.querySelector('img').src,`https://i.ytimg.com/vi/${id}/mqdefault.jpg`);
  assert.equal(f.link.href,`https://www.youtube.com/watch?v=${id}`);
  for(const properties of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1}])assert.equal(f.link.emit('click',properties).defaultPrevented,false);
  assert.equal(f.doc.head.children.length,0);assert.equal(f.players.length,0);assert.equal(f.link.hidden,false);
});

test('selected YouTube still starts an inline player on click without an anchor or custom control overlay',async()=>{
  const f=fixture();f.mountPromoVideo(f.promo,id,'',{playback:'click',thumbnail:'2'});
  assert.equal(f.link.querySelector('img').src,`https://i.ytimg.com/vi/${id}/2.jpg`);
  assert.equal(f.link.emit('click').defaultPrevented,true);await flush();
  assert.equal(f.players.length,1);const player=f.players[0];player.ready();
  assert.deepEqual(player.calls,['play']);
  assert.equal(f.link.hidden,true);assert.equal(f.link.querySelector('iframe'),null);
  assert.equal(player.iframe.parentNode.className,'promo-youtube');assert.equal(f.motion.hidden,true);
  assert.equal(player.options.playerVars.controls,1);assert.equal(player.options.playerVars.playsinline,1);
  assert.equal(player.iframe.getAttribute('allowfullscreen'),'');assert.match(player.iframe.getAttribute('allow'),/autoplay/);
});

test('YouTube autoplay is muted before play and has native controls, loop and a safe origin',async()=>{
  const f=fixture();f.mountPromoVideo(f.promo,id,'',{playback:'autoplay',thumbnail:'hqdefault'});await flush();
  const player=f.players[0];assert.ok(player);player.ready();
  assert.deepEqual(player.calls,['mute','play']);
  assert.equal(player.options.playerVars.autoplay,0,'No player-driven start may run before the onReady mute call.');
  assert.equal(player.options.playerVars.loop,1);assert.equal(player.options.playerVars.playlist,id);
  assert.equal(player.options.playerVars.enablejsapi,1);assert.equal(player.options.playerVars.origin,origin);
  assert.equal(f.promo.querySelector('.promo-youtube-fallback').href,`https://www.youtube.com/watch?v=${id}`);
  assert.equal(f.timers.size,0);
  player.block();assert.equal(f.promo.querySelector('.promo-youtube-status').hidden,false);
  assert.match(f.promo.querySelector('.promo-youtube-status').textContent,/Play button/);
  assert.equal(player.iframe.parentNode.hidden,false,'Blocked autoplay keeps native controls reachable.');
  player.options.events.onStateChange({data:1});assert.equal(f.promo.querySelector('.promo-youtube-status').hidden,true);
});

test('reduced motion overrides YouTube and native autoplay while leaving user-initiated playback available',async()=>{
  const f=fixture({reduced:true});f.mountPromoVideo(f.promo,id,'',{playback:'autoplay',thumbnail:'1'});
  assert.equal(f.players.length,0);assert.equal(f.link.hidden,false);assert.equal(f.link.querySelector('img').src,`https://i.ytimg.com/vi/${id}/1.jpg`);
  f.link.emit('click');await flush();f.players[0].ready();assert.deepEqual(f.players[0].calls,['play']);
  const native=fixture({reduced:true});native.mountPromoVideo(native.promo,'f8t4gAIy5t0','',{playback:'autoplay'});
  assert.equal(native.link.querySelector('video').autoplay,false);assert.equal(native.link.querySelector('video').playCalls,0);
});

test('missing max-resolution posters fall back to HQ for HTTP errors and small successful placeholders',()=>{
  for(const kind of ['error','placeholder']){
    const f=fixture();f.mountPromoVideo(f.promo,id,'',{thumbnail:'maxresdefault'});
    const image=f.link.querySelector('img');assert.match(image.src,/maxresdefault.jpg$/);
    if(kind==='error')image.emit('error');else{image.naturalWidth=120;image.emit('load');}
    assert.equal(image.src,`https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
    image.emit('error');assert.equal(f.link.querySelector('img'),null);assert.equal(f.link.href,`https://www.youtube.com/watch?v=${id}`);
  }
});

test('one shared API loader preserves an existing ready callback and constructs both players',async()=>{
  const f=fixture({api:false}),second=f.makePromo();let previousCalled=0;
  const previous=()=>previousCalled++;f.window.onYouTubeIframeAPIReady=previous;
  f.mountPromoVideo(f.promo,id,'',{playback:'autoplay'});f.mountPromoVideo(second.promo,'abcdefghijk','',{playback:'autoplay'});
  assert.equal(f.doc.head.children.length,1);assert.equal(f.doc.head.children[0].src,'https://www.youtube.com/iframe_api');
  f.installApi();f.window.onYouTubeIframeAPIReady();await flush();
  assert.equal(previousCalled,1);assert.equal(f.window.onYouTubeIframeAPIReady,previous);assert.equal(f.players.length,2);
});

test('API errors and timeout restore the selected still and working external YouTube navigation',async()=>{
  for(const kind of ['error','timeout']){
    const f=fixture({api:false});f.mountPromoVideo(f.promo,id,'',{playback:'autoplay',thumbnail:'3'});
    if(kind==='error')f.doc.head.children[0].emit('error');else f.runTimer(10000);
    await flush();assert.equal(f.link.hidden,false);assert.match(f.link.querySelector('img').src,/3.jpg$/);
    assert.equal(f.promo.querySelector('.promo-youtube').hidden,true);
    assert.equal(f.promo.querySelector('.promo-youtube-fallback').hidden,false);
    assert.equal(f.link.emit('click').defaultPrevented,false,'A failed inline player falls through to its safe YouTube URL.');
    assert.equal(f.doc.head.children.length,0);assert.equal(f.timers.size,0);
  }
});

test('embed rejection or readiness timeout cannot leave a dead player or start a late hidden video',async()=>{
  for(const kind of ['error','timeout']){
    const f=fixture();f.mountPromoVideo(f.promo,id,'',{playback:'autoplay'});await flush();
    const player=f.players[0];if(kind==='error')player.error();else f.runTimer(12000);
    player.ready();assert.deepEqual(player.calls,['destroy']);assert.equal(f.link.hidden,false);
    assert.equal(f.promo.querySelector('.promo-youtube').hidden,true);assert.equal(f.timers.size,0);
  }
});

test('the existing Blu-ray preview keeps its local video, captions, poster and muted autoplay by default',()=>{
  const f=fixture();f.mountPromoVideo(f.promo,'f8t4gAIy5t0','');
  const video=f.link.querySelector('video'),track=video.querySelector('track');
  assert.equal(video.src,'/assets/written-in-the-light-promo-preview.mp4');assert.equal(video.poster,'/assets/written-in-the-light-promo-poster.webp');
  assert.equal(video.autoplay,true);assert.equal(video.muted,true);assert.equal(video.defaultMuted,true);assert.equal(video.loop,true);
  assert.equal(track.src,'/assets/written-in-the-light-promo-preview.en.vtt');assert.equal(track.track.mode,'showing');
  assert.equal(f.promo.querySelector('.promo-youtube'),null);
});

test('explicit click and supplied still apply to a native preview, including HQ poster fallback',()=>{
  const f=fixture();f.mountPromoVideo(f.promo,'f8t4gAIy5t0','',{playback:'click',thumbnail:'maxresdefault'});
  const video=f.link.querySelector('video');assert.equal(video.autoplay,false);assert.match(video.poster,/maxresdefault.jpg$/);
  const probe=f.created.find(node=>node.tagName==='IMG');probe.emit('error');assert.match(video.poster,/hqdefault.jpg$/);
  f.motion.emit('click');assert.equal(video.playCalls,1);assert.equal(f.motion.textContent,'Pause preview');
  f.motion.emit('click');assert.equal(video.paused,true);
});

test('uploaded previews preserve the full-video dialog and resume only a previously playing preview',async()=>{
  const f=fixture();f.mountPromoVideo(f.promo,'','/uploaded.mp4');
  const preview=f.link.querySelector('video'),full=f.viewer.querySelector('video');
  assert.equal(preview.autoplay,true);assert.equal(preview.src,'/uploaded.mp4');
  await preview.play();assert.equal(f.link.emit('click').defaultPrevented,true);assert.equal(f.viewer.open,true);
  assert.equal(preview.paused,true);assert.equal(full.src,'/uploaded.mp4');assert.equal(full.playCalls,1);
  f.viewer.emit('close');assert.equal(full.src,undefined);assert.equal(full.loadCalls,1);assert.equal(preview.playCalls,2);
  preview.currentTime=12.5;preview.emit('timeupdate');assert.equal(preview.currentTime,0);
  const paused=fixture();paused.mountPromoVideo(paused.promo,'','/uploaded.mp4',{playback:'click'});
  assert.equal(paused.link.querySelector('video').autoplay,false);paused.link.emit('click');paused.viewer.emit('close');
  assert.equal(paused.link.querySelector('video').playCalls,0);
});

test('rendering consumes normalized options and only hides the regular hero for a valid enabled promo',async()=>{
  const f=fixture({payload:{enabled:true,title:'Get your Blu-ray',videoId:id,playback:'click',thumbnail:'2',buttonLabel:'Shop',buttonPath:'/merch/'}});
  f.doc.activePromo=f.promo;await f.renderHomepagePromo();
  assert.equal(f.doc.hero.hidden,true);assert.equal(f.promo.hidden,false);assert.equal(f.headline.textContent,'Get your Blu‑ray');
  assert.match(f.link.querySelector('img').src,/2.jpg$/);assert.equal(f.players.length,0);assert.equal(f.button.href,'/merch/');
  assert.equal(f.fetches[0].options.credentials,'omit');assert.equal(f.fetches[0].options.cache,'no-store');
  for(const payload of [{enabled:false},{enabled:true,title:'Unsafe source',videoId:'not-an-id',videoPath:'https://external.invalid/video.mp4'}]){
    const fallback=fixture({payload});fallback.doc.activePromo=fallback.promo;await fallback.renderHomepagePromo();
    assert.equal(fallback.doc.hero.hidden,false);assert.equal(fallback.promo.hidden,true);assert.equal(fallback.players.length,0);
  }
});
