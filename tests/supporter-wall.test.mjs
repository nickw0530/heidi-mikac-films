import test from 'node:test';
import assert from 'node:assert/strict';
import {mountSupporterWall,supporterCredits} from '../merch/supporters.js';

class Node{
  constructor(tag='div'){this.tag=tag;this.children=[];this.attributes={};this.events=new Map();this.dataset={};this.hidden=false;this.textContent='';this.replacements=0;this.style={setProperty(){}};}
  setAttribute(key,value){this.attributes[key]=String(value);}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;this.replacements++;}
  addEventListener(type,listener){this.events.set(type,listener);}
  removeEventListener(type){this.events.delete(type);}
  emit(type){return this.events.get(type)?.();}
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(fetcher,{reduced=false,hidden=false}={}){
  const elements=Object.fromEntries(['supporter-wall','supporter-viewport','supporter-roll','supporters-empty','supporter-pause','supporter-status'].map(name=>['[data-'+name+']',new Node()]));
  const wall=elements['[data-supporter-wall]'];wall.querySelector=selector=>elements[selector];
  const doc=new Node();doc.visibilityState=hidden?'hidden':'visible';doc.querySelector=selector=>elements[selector];doc.createElement=tag=>new Node(tag);
  const media=new Node();media.matches=reduced;
  const win=new Node();win.matchMedia=()=>media;win.setTimeout=()=>1;win.clearTimeout=()=>{};win.setInterval=(callback,delay)=>{win.tick=callback;win.interval=delay;return 2;};win.clearInterval=()=>{};
  const mounted=mountSupporterWall({doc,win,fetcher});
  return {elements,wall,doc,media,win,mounted};
}
const credits=()=>({supporters:[{name:'Ada Example',amount:1000,currency:'USD'}]});

test('public credits whitelist fields and never substitute private identity or amount',()=>{
  assert.deepEqual(supporterCredits({supporters:[
    {name:'',amount:null,currency:'USD',email:'private@example.invalid',identity:'secret',transactionId:'secret'},
    {name:'Ada',amount:1000,currency:'USD'},
    {name:'Private amount',amount:1000,currency:'EUR'}
  ]}),[{name:'Anonymous',amount:'Amount private'},{name:'Ada',amount:'$10.00'},{name:'Private amount',amount:'Amount private'}]);
  assert.throws(()=>supporterCredits({error:'Unavailable'}));
});

test('wall renders all supporters as plain text with an inaccessible animation duplicate',async()=>{
  const payload={supporters:Array.from({length:41},(_,i)=>({name:i===0?'<img src=x onerror=alert(1)>':'Person '+i,amount:i*100,currency:'USD',email:'private@example.invalid'}))};
  const view=fixture(async()=>Response.json(payload));await flush();
  const roll=view.elements['[data-supporter-roll]'];
  assert.equal(roll.children.length,2);
  const [list,copy]=roll.children;
  assert.equal(list.children.length,41,'Every supporter remains available; credits are not capped at 30.');
  assert.equal(list.children[0].children[0].textContent,payload.supporters[0].name);
  assert.equal(list.children[0].children[0].children.length,0,'Names create no markup.');
  assert.equal(copy.attributes['aria-hidden'],'true');assert.equal(copy.attributes.inert,'');
  assert.ok(!JSON.stringify(roll).includes('private@example.invalid'));
  assert.equal(view.elements['[data-supporter-viewport]'].hidden,false);
  view.mounted.destroy();
});

test('five-second polling updates changed credits without restarting an unchanged roll',async()=>{
  let data=credits(),calls=0;
  const view=fixture(async(_url,options)=>{calls++;assert.equal(options.cache,'no-store');return Response.json(data);});await flush();
  const roll=view.elements['[data-supporter-roll]'],first=roll.replacements;
  assert.equal(view.win.interval,5000);
  await view.mounted.refresh();assert.equal(roll.replacements,first);
  data={supporters:[{name:'Ada Example',amount:2500,currency:'USD'}]};
  await view.mounted.refresh();assert.equal(roll.children[0].children[0].children[1].textContent,'$25.00');
  view.doc.visibilityState='hidden';await view.mounted.refresh();assert.equal(calls,3);
  view.doc.visibilityState='visible';view.win.emit('hmf-supporters-refresh');await flush();assert.equal(calls,4);
  view.mounted.destroy();await view.mounted.refresh();assert.equal(calls,4);
});

test('pause and reduced-motion choices offer a static browsable list and survive refresh',async()=>{
  const view=fixture(async()=>Response.json(credits()));await flush();
  const button=view.elements['[data-supporter-pause]'];button.emit('click');
  assert.equal(view.wall.dataset.paused,'true');assert.equal(button.attributes['aria-pressed'],'true');
  assert.equal(button.textContent,'Resume credits');
  await view.mounted.refresh();assert.equal(view.wall.dataset.paused,'true');
  button.emit('click');assert.equal(view.wall.dataset.paused,'false');
  view.media.matches=true;view.media.emit('change');
  assert.equal(view.wall.dataset.paused,'true');assert.equal(button.disabled,true);
  assert.match(view.elements['[data-supporter-viewport]'].attributes['aria-label'],/Scroll to browse every supporter/);
  view.mounted.destroy();
});

test('failed refresh preserves last confirmed credits and reports stale updates',async()=>{
  let fails=false;
  const view=fixture(async()=>{if(fails)throw Error('Offline');return Response.json(credits());});await flush();
  const roll=view.elements['[data-supporter-roll]'],original=roll.children[0];fails=true;
  await view.mounted.refresh();
  assert.equal(roll.children[0],original);
  assert.match(view.elements['[data-supporter-status]'].textContent,/Showing the last loaded credits/);
  fails=false;await view.mounted.refresh();assert.equal(view.elements['[data-supporter-status]'].textContent,'');
  view.mounted.destroy();
});
