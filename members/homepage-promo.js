export const promoThumbnailChoices=Object.freeze([
  {value:'auto',label:'Existing / default thumbnail'},
  {value:'maxresdefault',label:'YouTube thumbnail — high resolution'},
  {value:'hqdefault',label:'YouTube thumbnail — standard'},
  {value:'1',label:'YouTube still 1 (lower resolution)'},
  {value:'2',label:'YouTube still 2 (lower resolution)'},
  {value:'3',label:'YouTube still 3 (lower resolution)'}
]);
const thumbnailValues=new Set(promoThumbnailChoices.map(choice=>choice.value));
const builtInVideo='f8t4gAIy5t0';

export function promoYouTubeId(value){
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.port||url.username||url.password)return '';
    let id='';
    if(url.hostname==='youtu.be')id=url.pathname.match(/^\/([\w-]+)\/?$/)?.[1];
    else if(['youtube.com','www.youtube.com','m.youtube.com','www.youtube-nocookie.com'].includes(url.hostname))
      id=url.pathname==='/watch'?url.searchParams.get('v'):url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)\/?$/)?.[1];
    return /^[\w-]{11}$/.test(id||'')?id:'';
  }catch{return '';}
}

export function promoEditorOptions(settings={}){
  const playback=['click','autoplay'].includes(settings.playback)?settings.playback:
    settings.uploadedVideo||promoYouTubeId(settings.videoUrl)===builtInVideo?'autoplay':'click';
  return {playback,thumbnail:thumbnailValues.has(settings.thumbnail)?settings.thumbnail:'auto'};
}

export function promoThumbnailPreview(videoUrl,thumbnail='auto'){
  const id=promoYouTubeId(videoUrl);if(!id)return null;
  const choice=thumbnailValues.has(thumbnail)?thumbnail:'auto';
  const local=choice==='auto'&&id===builtInVideo;
  return {src:local?'/assets/written-in-the-light-promo-poster.webp':
    'https://i.ytimg.com/vi/'+id+'/'+(choice==='auto'?'mqdefault':choice)+'.jpg',
    label:promoThumbnailChoices.find(option=>option.value===choice).label,
    highResolution:choice==='maxresdefault'};
}

const previews=new WeakMap();
export function refreshPromoThumbnail(form){
  const image=form.querySelector('[data-promo-thumbnail-image]'),note=form.querySelector('[data-promo-thumbnail-note]');
  const preview=promoThumbnailPreview(form.elements.videoUrl.value,form.elements.thumbnail.value);
  const token={};previews.set(form,token);
  image.onload=null;image.onerror=null;
  if(!preview){
    image.hidden=true;image.removeAttribute('src');
    note.textContent='Add a valid YouTube link to preview its supplied cover and video stills.';
    return;
  }
  const unavailable=()=>{
    if(previews.get(form)!==token)return;
    image.hidden=true;
    note.textContent='This YouTube thumbnail is unavailable. Choose another supplied image.';
  };
  image.onload=()=>{if(previews.get(form)===token&&preview.highResolution&&image.naturalWidth<480)unavailable();};
  image.onerror=unavailable;
  image.hidden=false;image.alt=preview.label+' preview';image.src=preview.src;
  note.textContent=preview.label+'. YouTube supplies these images; an exact timestamp cannot be selected here.';
}

export function bindPromoOptions(form){
  form.elements.videoUrl.addEventListener('input',()=>refreshPromoThumbnail(form));
  form.elements.thumbnail.addEventListener('change',()=>refreshPromoThumbnail(form));
}
