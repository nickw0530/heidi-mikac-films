import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bulkCandidates,mountBulkActions} from '../members/bulk-actions.js';

const productions=[{id:'dark',name:'Written in the Dark'},{id:'lies',name:'Wherein Lies Continue'}];
function person(id,name,activated,films=['dark']){
 const email=id==='name-only'?'':id+'@example.invalid';
 const member={id,name,email,activated,productions:Object.fromEntries(films.map(film=>[film,{}]))};
 return {hasMemberProfile:true,hasAccount:!!email,member,films:films.map(id=>({id,name:productions.find(p=>p.id===id).name,member:{...member}}))};
}

test('bulk choices include only pending accounts and individually eligible agreement preparations',()=>{
 const people=[person('d','Dawn',false,['dark','lies']),person('b','Bryce',false,[]),person('a','Alex',true),person('name-only','Chris',false),person('e','Ellie',true)];
 people[2].films[0].member.agreement={id:'already-created'};
 people[4].films[0].member.paperworkTracking={reason:'complete'};
 const options=bulkCandidates(people,productions,{mailReady:true,agreementReady:()=>true});
 assert.deepEqual(options.invitations.map(r=>r.id),['b','d']);
 assert.equal(options.invitations[0].context,'No production assigned');
 assert.match(options.invitations[1].context,/Written in the Dark/);
 assert.deepEqual(options.agreements.map(r=>r.key),['name-only/dark','d/lies','d/dark']);
 assert.deepEqual(bulkCandidates(people,productions,{mailReady:false,agreementReady:()=>false}),{invitations:[],agreements:[]});
});

// Keep mail and form navigation isolated while exercising the actual dialog listeners.
class FixtureElement{
 constructor(tag){this.tag=tag;this.dataset={};this.attributes={};this.children=[];this.listeners={};this.isConnected=true;}
 setAttribute(key,value){this.attributes[key]=value;}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=children;}
 addEventListener(event,listener){this.listeners[event]=listener;}
 fire(event){return this.listeners[event]?.({target:this,preventDefault(){}});}
 get textContent(){return this.children.map(child=>child instanceof FixtureElement?child.textContent:child).join(' ');}
 set textContent(value){this.children=[value];}
 *walk(){yield this;for(const child of this.children)if(child instanceof FixtureElement)yield* child.walk();}
 querySelector(tag){return [...this.walk()].find(node=>node.tag===tag);}
 focus(){}
 showModal(){this.open=true;}
 close(){this.open=false;this.fire('close');}
}

test('review gates the serial invitation requests and detects changed recipients',async()=>{
 const originalDocument=globalThis.document;
 globalThis.document={createElement:tag=>new FixtureElement(tag)};
 try{
  const people=[person('b','Bryce',false,[]),person('d','Dawn',false)];
  const slot=new FixtureElement('div'),sends=[],preparations=[];
  let release,refreshes=0;
  const bulk=mountBulkActions(slot,{getPeople:()=>people,getProductions:()=>productions,canSend:()=>true,canPrepare:()=>true,
   resend(row){
    sends.push(row.id);
    if(row.id==='d')throw Object.assign(Error('Already activated'),{status:409});
    return new Promise(resolve=>{release=()=>resolve({ok:true});});
   },openPreparation:row=>preparations.push(row.key),onQueued:()=>refreshes++
  });
  const find=(tag,content='')=>[...slot.walk()].find(node=>node.tag===tag&&node.textContent.startsWith(content));
  function selectAll(){for(const node of slot.walk())if(node.attributes.type==='checkbox'){node.checked=true;node.fire('change');}}
  find('button','Bulk actions').fire('click');
  selectAll();find('button','Review selected').fire('click');
  assert.deepEqual(sends,[]);
  assert.match(slot.textContent,/b@example.invalid/);
  const pending=find('button','Send selected invitations').fire('click');
  assert.deepEqual(sends,['b']);
  assert.equal(bulk.busy(),true);
  assert.equal(find('button','Close').disabled,true);
  release();await pending;
  assert.deepEqual(sends,['b','d']);
  assert.match(slot.textContent,/1 of 2 invitations queued/);
  assert.match(slot.textContent,/Could not queue · Already activated/);
  find('button','Close').fire('click');
  assert.equal(refreshes,1);
  find('button','Bulk actions').fire('click');
  selectAll();find('button','Review selected').fire('click');
  people[1].member.email='other@example.invalid';
  await find('button','Send selected invitations').fire('click');
  assert.deepEqual(sends,['b','d']);
  assert.match(slot.textContent,/Review the selected recipients again/);
  const action=find('select');action.value='agreements';action.fire('change');
  selectAll();find('button','Review selected').fire('click');
  find('button','Open preparation').fire('click');
  assert.deepEqual(preparations,['d/dark']);
  assert.deepEqual(sends,['b','d']);
 }finally{globalThis.document=originalDocument;}
});
