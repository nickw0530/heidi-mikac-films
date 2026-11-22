import test from 'node:test';
import assert from 'node:assert/strict';
import {initialHomepagePromo,promoPresentation,promoSettings,validatePromo} from '../netlify/lib/homepage-promo.mjs';

const requireThat=(ok,message)=>{if(!ok)throw Object.assign(Error(message),{status:400});};
const base={enabled:true,videoUrl:'https://youtu.be/abcdefghijk',title:'Fictional trailer',buttonLabel:'',buttonPath:''};
const video={id:'00000000-0000-4000-8000-0000000000c1',size:20,name:'Fictional.mp4'};

test('legacy promo defaults preserve local video previews and ordinary YouTube click behavior',()=>{
 assert.deepEqual(promoPresentation(initialHomepagePromo),{playback:'autoplay',thumbnail:'auto'});
 assert.deepEqual(promoPresentation({videoId:'abcdefghijk'}),{playback:'click',thumbnail:'auto'});
 assert.deepEqual(promoPresentation({videoId:'abcdefghijk',video}),{playback:'autoplay',thumbnail:'auto'});
 const settings=promoSettings({data:{...initialHomepagePromo,video},etag:'revision'});
 assert.equal(settings.playback,'autoplay');assert.equal(settings.thumbnail,'auto');
 assert.deepEqual(settings.uploadedVideo,{name:video.name,size:video.size});
 assert.equal(Object.hasOwn(settings,'video'),false,'Storage upload identifiers stay outside the admin settings DTO.');
});

test('validated playback and YouTube still selections round-trip while excluding arbitrary media URLs',()=>{
 for(const playback of ['click','autoplay'])for(const thumbnail of ['auto','maxresdefault','hqdefault','1','2','3']){
  const saved=validatePromo({...base,playback,thumbnail,thumbnailUrl:'https://outside.example/image.jpg'},requireThat);
  assert.equal(saved.playback,playback);assert.equal(saved.thumbnail,thumbnail);assert.equal(Object.hasOwn(saved,'thumbnailUrl'),false);
  const settings=promoSettings({data:saved});assert.equal(settings.playback,playback);assert.equal(settings.thumbnail,thumbnail);
 }
 for(const playback of ['',null,false,{},'AUTOPLAY','unmuted'])assert.throws(()=>validatePromo({...base,playback},requireThat),{status:400});
 for(const thumbnail of ['',null,false,{},'0','4','../hqdefault','https://i.ytimg.com/vi/abcdefghijk/1.jpg'])assert.throws(()=>validatePromo({...base,thumbnail},requireThat),{status:400});
});

test('older saves preserve explicit settings, while legacy omissions follow the effective video source',()=>{
 const prior={...initialHomepagePromo,playback:'click',thumbnail:'3',video};
 const preserved=validatePromo(base,requireThat,video,prior);
 assert.equal(preserved.playback,'click');assert.equal(preserved.thumbnail,'3');assert.deepEqual(preserved.video,video);
 const uploaded=validatePromo({...base,videoUrl:'',upload:video},requireThat);
 assert.equal(uploaded.playback,'autoplay');assert.equal(uploaded.thumbnail,'auto');
 const youtube=validatePromo(base,requireThat);
 assert.equal(youtube.playback,'click');assert.equal(youtube.thumbnail,'auto');
 const removed=validatePromo({...base,removeVideo:true},requireThat,video,{...initialHomepagePromo,video});
 assert.equal(Object.hasOwn(removed,'video'),false);assert.equal(removed.playback,'click');
});
