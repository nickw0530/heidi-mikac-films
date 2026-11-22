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
  after(node){const parent=this.parentNode;node.remove();parent.children.splice(parent.children.indexOf(this)+1,0,node);node.parentNode=parent;}
  replaceChildren(...nodes){for(const child of [...this.children])child.remove();this.append(...nodes);}
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
    this.mute=()=>this.calls.push('mute');this.unMute=()=>this.calls.push('unmute');this.playVideo=()=>this.calls.push('play');this.pauseVideo=()=>this.calls.push('pause');this.getIframe=()=>this.iframe;
    this.destroy=()=>{this.calls.push('destroy');this.iframe.remove();};
    this.ready=()=>options.events.onReady({target:this});
    this.block=()=>options.events.onAutoplayBlocked({target:this});
    this.state=data=>options.events.onStateChange({target:this,data});
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
    const frame=doc.createElement('div');frame.className='promo-player';media.append(frame);
    const controls=doc.createElement('div');controls.className='promo-controls';
    const motion=doc.createElement('button');motion.className='promo-motion';motion.hidden=true;motion.textContent='Play preview';
    const sound=doc.createElement('button');sound.className='promo-sound';sound.hidden=true;sound.textContent='Unmute preview';controls.append(motion,sound);
    const button=doc.createElement('a');button.setAttribute('data-promo-button','');button.hidden=true;
    promo.append(headline,media,controls,button);
    return {promo,frame,motion,sound,media,controls,headline,button};
  };
  return {...makePromo(),...functions,doc,window,created,players,timers,fetches,makePromo,installApi,
    runTimer(delay){const entry=[...timers].find(([,timer])=>timer.delay===delay);assert.ok(entry,'Expected a pending timeout.');timers.delete(entry[0]);entry[1].run();}};
}

test('a click-mode YouTube frame remains a noninteractive still and never loads an API or navigation on click',()=>{
  const f=fixture({api:false});
  assert.equal(f.mountPromoVideo(f.promo,id,''),true);
  assert.equal(f.frame.querySelector('img').src,`https://i.ytimg.com/vi/${id}/mqdefault.jpg`);
  for(const properties of [{},{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1}])f.frame.emit('click',properties);
  assert.equal(f.frame.tagName,'DIV');assert.equal(f.frame.href,undefined);assert.equal(f.frame.events.has('click'),false);
  assert.equal(f.media.querySelector('a'),null);assert.equal(f.media.querySelector('button'),null);
  assert.equal(f.doc.head.children.length,0);assert.equal(f.players.length,0);assert.equal(f.frame.hidden,false);
  assert.equal(f.motion.hidden,false);assert.equal(f.motion.textContent,'Play preview');assert.equal(f.sound.disabled,true);
});

test('only the separate Play button starts YouTube and its iframe cannot receive keyboard or direct interactions',async()=>{
  const f=fixture();f.mountPromoVideo(f.promo,id,'',{playback:'click',thumbnail:'2'});
  assert.equal(f.frame.querySelector('img').src,`https://i.ytimg.com/vi/${id}/2.jpg`);
  f.frame.emit('click');assert.equal(f.players.length,0);
  f.motion.emit('click');assert.equal(f.motion.disabled,true);await flush();
  assert.equal(f.players.length,1);const player=f.players[0];player.ready();
  assert.deepEqual(player.calls,['mute','play']);
  assert.equal(f.frame.hidden,true);assert.equal(f.frame.querySelector('iframe'),null);
  assert.equal(player.iframe.parentNode.className,'promo-youtube');assert.equal(player.iframe.parentNode.inert,true);
  assert.equal(player.options.playerVars.controls,0);assert.equal(player.options.playerVars.disablekb,1);assert.equal(player.options.playerVars.fs,0);
  assert.equal(player.options.playerVars.cc_load_policy,1);assert.equal(player.options.playerVars.playsinline,1);
  assert.equal(player.iframe.inert,true);assert.equal(player.iframe.getAttribute('tabindex'),'-1');assert.equal(player.iframe.getAttribute('aria-hidden'),'true');
  assert.equal(player.iframe.getAttribute('allowfullscreen'),null);assert.doesNotMatch(player.iframe.getAttribute('allow'),/fullscreen/);
  assert.equal(f.media.querySelector('a'),null);assert.equal(f.media.querySelector('button'),null);
  assert.equal(f.motion.parentNode,f.controls);assert.equal(f.sound.parentNode,f.controls);assert.equal(f.motion.hidden,false);assert.equal(f.sound.disabled,false);
});

test('muted YouTube autoplay can be paused, resumed and unmuted only using the separate controls',async()=>{
  const f=fixture();f.mountPromoVideo(f.promo,id,'',{playback:'autoplay',thumbnail:'hqdefault'});await flush();
  const player=f.players[0];assert.ok(player);player.ready();
  assert.deepEqual(player.calls,['mute','play']);
  assert.equal(player.options.playerVars.autoplay,0,'No player-driven start may run before the onReady mute call.');
  assert.equal(player.options.playerVars.loop,1);assert.equal(player.options.playerVars.playlist,id);
  assert.equal(player.options.playerVars.enablejsapi,1);assert.equal(player.options.playerVars.origin,origin);
  assert.equal(f.timers.size,0);
  player.state(1);assert.equal(f.motion.textContent,'Pause preview');assert.equal(f.motion.getAttribute('aria-pressed'),'true');
  f.sound.emit('click');assert.equal(player.calls.at(-1),'unmute');assert.equal(f.sound.textContent,'Mute preview');assert.equal(f.sound.getAttribute('aria-pressed'),'true');
  f.motion.emit('click');assert.equal(player.calls.at(-1),'pause');assert.equal(f.motion.textContent,'Resume preview');
  f.motion.emit('click');assert.equal(player.calls.at(-1),'play');assert.equal(f.motion.textContent,'Pause preview');
  f.sound.emit('click');assert.equal(player.calls.at(-1),'mute');assert.equal(f.sound.textContent,'Unmute preview');
  player.state(2);assert.equal(f.motion.textContent,'Resume preview');assert.equal(f.motion.getAttribute('aria-pressed'),'false');
  assert.equal(f.promo.querySelector('.promo-youtube-fallback'),null);
});

test('blocked YouTube autoplay leaves an enabled Play button without external fallback links',async()=>{
  const f=fixture();f.mountPromoVideo(f.promo,id,'',{playback:'autoplay'});await flush();
  const player=f.players[0];player.ready();player.block();
  assert.equal(f.motion.disabled,false);assert.equal(f.motion.textContent,'Play preview');
  assert.match(f.promo.querySelector('.promo-youtube-status').textContent,/Select Play preview/);
  assert.equal(f.media.querySelector('a'),null);f.motion.emit('click');assert.equal(player.calls.at(-1),'play');
  assert.equal(f.players.length,1);player.state(1);assert.equal(f.promo.querySelector('.promo-youtube-status').hidden,true);
});

test('reduced motion overrides both autoplay types while the separate Play button starts a muted inline preview',async()=>{
  const f=fixture({reduced:true});f.mountPromoVideo(f.promo,id,'',{playback:'autoplay',thumbnail:'1'});
  assert.equal(f.players.length,0);assert.equal(f.frame.hidden,false);assert.equal(f.frame.querySelector('img').src,`https://i.ytimg.com/vi/${id}/1.jpg`);
  f.motion.emit('click');await flush();f.players[0].ready();assert.deepEqual(f.players[0].calls,['mute','play']);
  const native=fixture({reduced:true});native.mountPromoVideo(native.promo,'f8t4gAIy5t0','',{playback:'autoplay'});
  assert.equal(native.frame.querySelector('video').autoplay,false);assert.equal(native.frame.querySelector('video').playCalls,0);
  native.frame.emit('click');assert.equal(native.frame.querySelector('video').playCalls,0);
  native.motion.emit('click');assert.equal(native.frame.querySelector('video').playCalls,1);
});

test('missing max-resolution posters fall back to HQ for HTTP errors and small successful placeholders',()=>{
  for(const kind of ['error','placeholder']){
    const f=fixture();f.mountPromoVideo(f.promo,id,'',{thumbnail:'maxresdefault'});
    const image=f.frame.querySelector('img');assert.match(image.src,/maxresdefault.jpg$/);
    if(kind==='error')image.emit('error');else{image.naturalWidth=120;image.emit('load');}
    assert.equal(image.src,`https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
    image.emit('error');assert.equal(f.frame.querySelector('img'),null);assert.equal(f.frame.href,undefined);assert.equal(f.media.querySelector('a'),null);
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

test('API errors and timeout retain the selected still and provide a working in-page retry instead of navigation',async()=>{
  for(const kind of ['error','timeout']){
    const f=fixture({api:false});f.mountPromoVideo(f.promo,id,'',{playback:'autoplay',thumbnail:'3'});
    if(kind==='error')f.doc.head.children[0].emit('error');else f.runTimer(10000);
    await flush();assert.equal(f.frame.hidden,false);assert.match(f.frame.querySelector('img').src,/3.jpg$/);
    assert.equal(f.promo.querySelector('.promo-youtube').hidden,true);
    assert.equal(f.media.querySelector('a'),null);assert.equal(f.motion.disabled,false);assert.equal(f.motion.textContent,'Play preview');
    assert.match(f.promo.querySelector('.promo-youtube-status').textContent,/unavailable/);
    f.frame.emit('click');assert.equal(f.players.length,0);
    assert.equal(f.doc.head.children.length,0);assert.equal(f.timers.size,0);
    f.installApi();f.motion.emit('click');await flush();f.players[0].ready();assert.deepEqual(f.players[0].calls,['mute','play']);
  }
});

test('embed rejection or readiness timeout cannot leave a dead player or start a late hidden video',async()=>{
  for(const kind of ['error','timeout']){
    const f=fixture();f.mountPromoVideo(f.promo,id,'',{playback:'autoplay'});await flush();
    const player=f.players[0];if(kind==='error')player.error();else f.runTimer(12000);
    player.ready();assert.deepEqual(player.calls,['destroy']);assert.equal(f.frame.hidden,false);
    assert.equal(f.promo.querySelector('.promo-youtube').hidden,true);assert.equal(f.timers.size,0);
    f.motion.emit('click');await flush();const retry=f.players[1];retry.ready();assert.deepEqual(retry.calls,['mute','play']);
    player.block();player.state(2);assert.equal(f.motion.textContent,'Pause preview','Late events from the failed player cannot change a retried preview.');
  }
});

test('the existing Blu-ray preview keeps its local video, captions, poster and muted autoplay by default',()=>{
  const f=fixture();f.mountPromoVideo(f.promo,'f8t4gAIy5t0','');
  const video=f.frame.querySelector('video'),track=video.querySelector('track');
  assert.equal(video.src,'/assets/written-in-the-light-promo-preview.mp4');assert.equal(video.poster,'/assets/written-in-the-light-promo-poster.webp');
  assert.equal(video.autoplay,true);assert.equal(video.muted,true);assert.equal(video.defaultMuted,true);assert.equal(video.loop,true);
  assert.equal(track.src,'/assets/written-in-the-light-promo-preview.en.vtt');assert.equal(track.track.mode,'showing');
  assert.equal(f.promo.querySelector('.promo-youtube'),null);
  assert.equal(video.controls,false);assert.equal(video.getAttribute('tabindex'),'-1');assert.equal(video.disablePictureInPicture,true);
  assert.equal(f.frame.events.has('click'),false);assert.equal(f.media.querySelector('a'),null);
});

test('explicit click and supplied still apply to a native preview, including HQ poster fallback',()=>{
  const f=fixture();f.mountPromoVideo(f.promo,'f8t4gAIy5t0','',{playback:'click',thumbnail:'maxresdefault'});
  const video=f.frame.querySelector('video');assert.equal(video.autoplay,false);assert.match(video.poster,/maxresdefault.jpg$/);
  const probe=f.created.find(node=>node.tagName==='IMG');probe.emit('error');assert.match(video.poster,/hqdefault.jpg$/);
  f.motion.emit('click');assert.equal(video.playCalls,1);assert.equal(f.motion.textContent,'Pause preview');
  f.motion.emit('click');assert.equal(video.paused,true);
  f.sound.emit('click');assert.equal(video.muted,false);assert.equal(f.sound.textContent,'Mute preview');
  f.sound.emit('click');assert.equal(video.muted,true);assert.equal(f.sound.textContent,'Unmute preview');
});

test('uploaded previews never open a dialog or link and keep the existing twelve-second loop',async()=>{
  const f=fixture();f.mountPromoVideo(f.promo,'','/uploaded.mp4');
  const preview=f.frame.querySelector('video');
  assert.equal(preview.autoplay,true);assert.equal(preview.src,'/uploaded.mp4');
  f.frame.emit('click');assert.equal(preview.playCalls,0);assert.equal(f.frame.href,undefined);
  assert.equal(f.promo.querySelector('dialog'),null);assert.equal(f.media.querySelector('a'),null);
  f.motion.emit('click');assert.equal(preview.playCalls,1);assert.equal(f.motion.textContent,'Pause preview');
  f.sound.emit('click');assert.equal(preview.muted,false);
  f.motion.emit('click');assert.equal(preview.paused,true);assert.equal(f.motion.textContent,'Resume preview');
  preview.currentTime=12.5;preview.emit('timeupdate');assert.equal(preview.currentTime,0);
  const paused=fixture();paused.mountPromoVideo(paused.promo,'','/uploaded.mp4',{playback:'click'});
  assert.equal(paused.frame.querySelector('video').autoplay,false);paused.frame.emit('click');
  assert.equal(paused.frame.querySelector('video').playCalls,0);
});

test('native errors preserve a poster and allow inline retry while rejected play remains actionable',async()=>{
  const f=fixture();f.mountPromoVideo(f.promo,'f8t4gAIy5t0','');const video=f.frame.querySelector('video');
  video.emit('error');assert.equal(video.hidden,true);assert.ok(f.frame.querySelector('img'));assert.equal(f.sound.disabled,true);
  assert.equal(f.motion.textContent,'Play preview');assert.match(f.promo.querySelector('.promo-youtube-status').textContent,/unavailable/);
  f.frame.emit('click');assert.equal(video.playCalls,0);assert.equal(f.media.querySelector('a'),null);
  f.motion.emit('click');assert.equal(video.hidden,false);assert.equal(video.loadCalls,1);assert.equal(video.playCalls,1);
  assert.equal(video.muted,true);assert.equal(f.sound.disabled,false);assert.equal(f.frame.querySelector('img'),null);
  video.pause();video.play=()=>Promise.reject(Error('Playback blocked'));f.motion.emit('click');await flush();
  assert.match(f.promo.querySelector('.promo-youtube-status').textContent,/Select Play preview/);assert.equal(f.motion.disabled,undefined);
});

test('rendering consumes normalized options and only hides the regular hero for a valid enabled promo',async()=>{
  const f=fixture({payload:{enabled:true,title:'Get your Blu-ray',videoId:id,playback:'click',thumbnail:'2',buttonLabel:'Shop',buttonPath:'/merch/'}});
  f.doc.activePromo=f.promo;await f.renderHomepagePromo();
  assert.equal(f.doc.hero.hidden,true);assert.equal(f.promo.hidden,false);assert.equal(f.headline.textContent,'Get your Blu‑ray');
  assert.match(f.frame.querySelector('img').src,/2.jpg$/);assert.equal(f.players.length,0);assert.equal(f.button.href,'/merch/');
  assert.equal(f.media.querySelector('a'),null);
  assert.equal(f.fetches[0].options.credentials,'omit');assert.equal(f.fetches[0].options.cache,'no-store');
  for(const payload of [{enabled:false},{enabled:true,title:'Unsafe source',videoId:'not-an-id',videoPath:'https://external.invalid/video.mp4'}]){
    const fallback=fixture({payload});fallback.doc.activePromo=fallback.promo;await fallback.renderHomepagePromo();
    assert.equal(fallback.doc.hero.hidden,false);assert.equal(fallback.promo.hidden,true);assert.equal(fallback.players.length,0);
  }
});
