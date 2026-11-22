import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {promoYouTubeId,promoEditorOptions,promoThumbnailChoices,promoThumbnailPreview,refreshPromoThumbnail,bindPromoOptions} from '../members/homepage-promo.js';

const id='AbCdEfG_h-1',other='ZyXwVuT_s-2';
function editor(videoUrl='https://youtu.be/'+id,thumbnail='auto'){
  const events={};
  const control=(name,value)=>({value,addEventListener(type,handler){events[name+':'+type]=handler;}});
  const image={hidden:true,naturalWidth:1280,removeAttribute(name){delete this[name];}},note={textContent:''};
  const form={elements:{videoUrl:control('videoUrl',videoUrl),thumbnail:control('thumbnail',thumbnail)},querySelector(selector){return selector==='[data-promo-thumbnail-image]'?image:note;}};
  return {form,image,note,events};
}

test('promo editor preserves explicit saved choices and the distinct legacy upload, built-in preview and generic YouTube behaviors',()=>{
  assert.deepEqual(promoEditorOptions({videoUrl:'https://youtu.be/'+id}),{playback:'click',thumbnail:'auto'});
  assert.deepEqual(promoEditorOptions({uploadedVideo:{name:'previous.mp4'}}),{playback:'autoplay',thumbnail:'auto'});
  assert.deepEqual(promoEditorOptions({videoUrl:'https://youtu.be/f8t4gAIy5t0'}),{playback:'autoplay',thumbnail:'auto'});
  assert.deepEqual(promoEditorOptions({uploadedVideo:{name:'previous.mp4'},playback:'click',thumbnail:'2'}),{playback:'click',thumbnail:'2'});
  assert.deepEqual(promoEditorOptions({videoUrl:'https://youtu.be/'+id,playback:'autoplay',thumbnail:'hqdefault'}),{playback:'autoplay',thumbnail:'hqdefault'});
});

test('only recognized HTTPS YouTube links can generate preview image requests',()=>{
  for(const url of ['https://youtu.be/'+id,'https://www.youtube.com/watch?v='+id+'&t=60','https://m.youtube.com/shorts/'+id,'https://youtube.com/live/'+id,'https://www.youtube-nocookie.com/embed/'+id])assert.equal(promoYouTubeId(url),id);
  for(const url of ['http://youtu.be/'+id,'https://youtube.com.evil.invalid/watch?v='+id,'https://youtube.com@evil.invalid/watch?v='+id,'https://user@youtube.com/watch?v='+id,'https://youtu.be:8443/'+id,'https://evil.invalid/'+id,'javascript:alert(1)','https://youtu.be/short','https://youtu.be/'+id+'/extra']){
    assert.equal(promoYouTubeId(url),'');assert.equal(promoThumbnailPreview(url,'1'),null);
  }
  const guarded=promoThumbnailPreview('https://youtu.be/'+id,'../../foreign-host');
  assert.equal(guarded.src,'https://i.ytimg.com/vi/'+id+'/mqdefault.jpg');
});

test('all supplied thumbnail choices are image previews, preserve default artwork, and never promise arbitrary frames',()=>{
  assert.deepEqual(promoThumbnailChoices.map(choice=>choice.value),['auto','maxresdefault','hqdefault','1','2','3']);
  assert.equal(promoThumbnailPreview('https://youtu.be/f8t4gAIy5t0','auto').src,'/assets/written-in-the-light-promo-poster.webp');
  for(const choice of promoThumbnailChoices.slice(1))assert.equal(promoThumbnailPreview('https://youtu.be/'+id,choice.value).src,'https://i.ytimg.com/vi/'+id+'/'+choice.value+'.jpg');
  assert.ok(promoThumbnailChoices.filter(choice=>/^[123]$/.test(choice.value)).every(choice=>choice.label.includes('lower resolution')));
});

test('changing the YouTube URL or thumbnail updates the current image without changing either selected value',()=>{
  const {form,image,note,events}=editor();bindPromoOptions(form);refreshPromoThumbnail(form);
  assert.equal(image.src,'https://i.ytimg.com/vi/'+id+'/mqdefault.jpg');assert.equal(image.hidden,false);
  form.elements.thumbnail.value='3';events['thumbnail:change']();assert.equal(image.src,'https://i.ytimg.com/vi/'+id+'/3.jpg');
  form.elements.videoUrl.value='https://www.youtube.com/watch?v='+other;events['videoUrl:input']();
  assert.equal(image.src,'https://i.ytimg.com/vi/'+other+'/3.jpg');assert.equal(form.elements.thumbnail.value,'3');
  assert.equal(form.elements.videoUrl.value,'https://www.youtube.com/watch?v='+other);assert.ok(note.textContent.includes('exact timestamp cannot be selected'));
  form.elements.videoUrl.value='';events['videoUrl:input']();assert.equal(image.hidden,true);assert.equal(image.src,undefined);assert.match(note.textContent,/valid YouTube link/);
});

test('unavailable images and placeholder high-resolution covers are identified rather than silently showing another selected still',()=>{
  const {form,image,note}=editor('https://youtu.be/'+id,'1');refreshPromoThumbnail(form);image.onerror();
  assert.equal(image.hidden,true);assert.equal(image.src,'https://i.ytimg.com/vi/'+id+'/1.jpg');assert.match(note.textContent,/unavailable/);
  form.elements.thumbnail.value='maxresdefault';refreshPromoThumbnail(form);image.naturalWidth=120;image.onload();
  assert.equal(image.hidden,true);assert.match(note.textContent,/unavailable/);
  form.elements.thumbnail.value='hqdefault';refreshPromoThumbnail(form);image.naturalWidth=480;image.onload();assert.equal(image.hidden,false);
});

test('an old video image completion cannot replace the preview state after the link changes',()=>{
  const {form,image,note}=editor();refreshPromoThumbnail(form);const previousError=image.onerror,previousLoad=image.onload;
  form.elements.videoUrl.value='https://youtu.be/'+other;refreshPromoThumbnail(form);const message=note.textContent;
  previousError();previousLoad();assert.equal(image.hidden,false);assert.equal(image.src,'https://i.ytimg.com/vi/'+other+'/mqdefault.jpg');assert.equal(note.textContent,message);
});

test('portal thumbnail previews add only the exact image origin and keep script, connection and framing restrictions',async()=>{
  const config=await readFile(new URL('../netlify.toml',import.meta.url),'utf8');
  const csp=config.match(/Content-Security-Policy = "([^"]+)"/)[1];
  const directives=new Map(csp.split(';').map(value=>value.trim().split(/\s+/)).filter(parts=>parts[0]).map(([key,...values])=>[key,values]));
  assert.deepEqual(directives.get('img-src'),["'self'",'data:','blob:','https://heidimikacfilms.com','https://writteninthedarkfilm.com','https://whereinliescontinue.net','https://i.ytimg.com']);
  assert.deepEqual(directives.get('script-src'),["'self'",'https://static.signwell.com']);
  assert.deepEqual(directives.get('connect-src'),["'self'",'https://*.signwell.com']);
  assert.deepEqual(directives.get('frame-src'),['https://signwell.com','https://*.signwell.com']);
  assert.deepEqual(directives.get('frame-ancestors'),["'none'"]);assert.deepEqual(directives.get('object-src'),["'none'"]);
});
