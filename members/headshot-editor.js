const MAX_UPLOAD=4*1024*1024;
const MAX_PIXELS=40_000_000;
const PHOTO_TYPES=new Set(['image/jpeg','image/png']);
const selections=new WeakMap();

function photoType(file){
 if(PHOTO_TYPES.has(file.type))return file.type;
 if(file.type&&file.type!=='application/octet-stream')return '';
 if(/\.jpe?g$/i.test(file.name))return 'image/jpeg';
 if(/\.png$/i.test(file.name))return 'image/png';
 return '';
}

function loadImage(file){
 if(!photoType(file))return Promise.reject(new Error('Choose a JPG or PNG headshot.'));
 return new Promise((resolve,reject)=>{
  const image=new Image();
  const url=URL.createObjectURL(file);
  image.onload=()=>{URL.revokeObjectURL(url);resolve(image);};
  image.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('This photo could not be opened. Try another JPG or PNG.'));};
  image.src=url;
 });
}

function needsResize(file,image){
 return file.size>MAX_UPLOAD||image.naturalWidth*image.naturalHeight>MAX_PIXELS;
}

function cropFor(image,portrait,position){
 const width=image.naturalWidth,height=image.naturalHeight;
 if(!portrait)return {left:0,top:0,width,height};
 const ratio=4/5;
 if(width/height>ratio){
  const croppedWidth=height*ratio;
  return {left:(width-croppedWidth)*position,top:0,width:croppedWidth,height};
 }
 const croppedHeight=width/ratio;
 return {left:0,top:(height-croppedHeight)*position,width,height:croppedHeight};
}

function draw(canvas,image,crop,maxEdge){
 const scale=Math.min(1,maxEdge/Math.max(crop.width,crop.height));
 canvas.width=Math.max(1,Math.round(crop.width*scale));
 canvas.height=Math.max(1,Math.round(crop.height*scale));
 const context=canvas.getContext('2d');
 if(!context)throw new Error('Photo editing is unavailable in this browser.');
 context.drawImage(image,crop.left,crop.top,crop.width,crop.height,0,0,canvas.width,canvas.height);
}

function labeled(text,control){
 const label=document.createElement('label');
 label.append(text,control);
 return label;
}

export function clearHeadshotPreview(form){
 selections.delete(form);
 form.querySelector('[data-headshot-preview]')?.remove();
}

export async function selectHeadshot(form){
 clearHeadshotPreview(form);
 const file=form.elements.file.files[0];
 if(!file)return;
 const state={file,image:loadImage(file),portrait:false,position:0.5};
 selections.set(form,state);
 let image;
 try{image=await state.image;}
 catch(error){
  if(selections.get(form)===state&&form.isConnected)throw error;
  return;
 }
 if(selections.get(form)!==state||!form.isConnected)return;
 const section=document.createElement('div');
 section.dataset.headshotPreview='';
 const canvas=document.createElement('canvas');
 canvas.setAttribute('role','img');
 canvas.setAttribute('aria-label','Preview of the headshot to save');
 const crop=document.createElement('select');
 for(const [value,text] of [['original','Original framing'],['portrait','Portrait crop (4:5)']]){
  const option=document.createElement('option');
  option.value=value;option.textContent=text;crop.append(option);
 }
 const position=document.createElement('input');
 position.type='range';position.min='0';position.max='100';position.value='50';
 const positionLabel=labeled(image.naturalWidth/image.naturalHeight>4/5?'Move crop left or right':'Move crop up or down',position);
 const note=document.createElement('p');
 note.textContent=needsResize(file,image)?'This large image will be resized for upload.':'';
 const refresh=()=>{
  state.portrait=crop.value==='portrait';
  state.position=Number(position.value)/100;
  positionLabel.hidden=!state.portrait;
  draw(canvas,image,cropFor(image,state.portrait,state.position),480);
 };
 crop.addEventListener('change',refresh);
 position.addEventListener('input',refresh);
 refresh();
 section.append(canvas,labeled('Photo framing',crop),positionLabel,note);
 const submit=form.querySelector('button[type="submit"],button:not([type])');
 form.insertBefore(section,submit);
}

export async function prepareHeadshot(form,file){
 const selection=selections.get(form);
 const state=selection?.file===file?selection:{image:loadImage(file),portrait:false,position:0.5};
 const image=await state.image;
 if(!state.portrait&&!needsResize(file,image))return file;
 const canvas=document.createElement('canvas');
 const crop=cropFor(image,state.portrait,state.position);
 const type=photoType(file);
 for(const edge of [1600,1200,900,600]){
  draw(canvas,image,crop,edge);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,type,0.9));
  if(blob?.type===type&&blob.size<=MAX_UPLOAD)return new File([blob],file.name,{type});
 }
 throw new Error('This photo could not be resized for upload. Try a smaller JPG or PNG.');
}
