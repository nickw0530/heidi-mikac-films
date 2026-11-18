import assert from 'node:assert/strict';
import {test} from 'node:test';
import {onboardingDraft,onboardingChanged,saveOnboarding} from '../members/onboarding.js';

const film=id=>({id,name:'Production '+id,assigned:true,selected:true,character:'',crewTitle:'',visible:true,
 placement:{castPlacement:'',billingOrder:null,revision:''},paperwork:{reason:'',status:'No agreement on file'}});
const setup=()=>({memberRevision:'member-1',profileRevision:'profile-1',productions:['one','two','future'].map(film)});

test('onboarding saves a future third production without narrowing the shared profile to the current two films',async()=>{
 const state=setup(),draft=onboardingDraft(state),current=structuredClone(state),calls=[];
 draft[2].character='Future character';draft[2].crewTitle='Director';draft[2].approve=true;draft[2].paperwork='not-required';
 const request=async(action,body,id,suffix,production)=>{
  if(body)calls.push({action,body,id,production});
  if(action==='onboarding'&&body){
   current.memberRevision='member-2';
   for(const row of body.productions)Object.assign(current.productions.find(film=>film.id===row.id),row,{assigned:row.selected});
  }
  if(action==='trackPaperwork')current.productions.find(film=>film.id===production).paperwork.reason=body.reason;
  return body?{ok:true}:structuredClone(current);
 };
 const saved=await saveOnboarding({id:'person-1',request,state,draft});
 assert.equal(calls[0].body.productions.length,3);
 assert.equal(calls[0].body.productions[2].character,'Future character');
 assert.equal(calls[0].body.productions[2].crewTitle,'Director');
 assert.equal(calls[0].body.productions[2].approve,true);
 assert.equal(calls[1].production,'future');
 assert.equal(saved.state.productions[2].paperwork.reason,'not-required');
 assert.equal(onboardingChanged(saved.state,onboardingDraft(saved.state)),false);
});

test('retry recognizes a successful secondary write whose response was lost and does not submit it twice',async()=>{
 const state=setup(),draft=onboardingDraft(state),current=structuredClone(state),writes=[];
 draft[0].castPlacement='lead';draft[0].billingOrder='2';draft[1].paperwork='complete';
 let losePlacementResponse=true;
 const request=async(action,body,id,suffix,production)=>{
  if(body)writes.push({action,production});
  if(action==='saveWebsitePlacement'){
   current.productions[0].placement={castPlacement:body.castPlacement,billingOrder:body.billingOrder,revision:'placement-2'};
   if(losePlacementResponse){losePlacementResponse=false;throw Error('Connection interrupted after the write');}
  }
  if(action==='trackPaperwork')current.productions[1].paperwork.reason=body.reason;
  return body?{ok:true}:structuredClone(current);
 };
 const interrupted=await saveOnboarding({id:'person-1',request,state,draft});
 assert.equal(interrupted.results[0].ok,false);
 assert.equal(interrupted.results[1].ok,true,'Independent agreement tracking still saves.');
 const retried=await saveOnboarding({id:'person-1',request,state,draft});
 assert.equal(retried.results.every(result=>result.ok),true);
 assert.deepEqual(writes,[{action:'saveWebsitePlacement',production:'one'},{action:'trackPaperwork',production:'two'}]);
});

test('onboarding refuses to replace concurrently changed agreement tracking while saving an independent production',async()=>{
 const state=setup(),draft=onboardingDraft(state),current=structuredClone(state),writes=[];
 draft[0].paperwork='complete';draft[2].paperwork='not-required';
 current.productions[0].paperwork.reason='not-required';
 const request=async(action,body,id,suffix,production)=>{
  if(body){writes.push({action,production});current.productions.find(film=>film.id===production).paperwork.reason=body.reason;}
  return body?{ok:true}:structuredClone(current);
 };
 const saved=await saveOnboarding({id:'person-1',request,state,draft});
 assert.equal(saved.results[0].ok,false);
 assert.match(saved.results[0].error,/updated elsewhere/);
 assert.equal(saved.results[1].ok,true);
 assert.deepEqual(writes,[{action:'trackPaperwork',production:'future'}]);
 assert.equal(saved.state.productions[0].paperwork.reason,'not-required');
});
