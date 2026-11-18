import assert from 'node:assert/strict';
import {test} from 'node:test';
import {onboardingDraft,onboardingChanged,saveOnboarding,rebaseOnboardingProfile} from '../members/onboarding.js';

function fixture(){
 const production=id=>({id,name:id==='dark'?'Written in the Dark':'Wherein Lies Continue',assigned:true,selected:true,character:'',crewTitle:'',visible:true,
  placement:{castPlacement:'',billingOrder:null,revision:''},paperwork:{reason:'',status:'No agreement on file'},needsApproval:true});
 return {memberRevision:'first',profileRevision:'profile-first',profile:{bio:'Approved review copy',photo:''},productions:[production('dark'),production('lies')]};
}

test('onboarding saves all production credits and approvals once, then only changed film-specific settings',async()=>{
 const state=fixture(),draft=onboardingDraft(state),current=structuredClone(state),calls=[];
 draft[0].character='Detective';draft[0].approve=true;draft[0].castPlacement='lead';draft[0].billingOrder='1';draft[1].paperwork='not-required';
 const request=async(action,body,id,suffix,production)=>{
  calls.push({action,body,id,production});
  if(action==='onboarding'&&body){
   current.memberRevision='saved';
   for(const row of body.productions){const film=current.productions.find(film=>film.id===row.id);Object.assign(film,row,{assigned:row.selected});}
  }
  if(action==='saveWebsitePlacement')current.productions.find(film=>film.id===production).placement={...body,revision:'saved-placement'};
  if(action==='trackPaperwork')current.productions.find(film=>film.id===production).paperwork.reason=body.reason;
  return body?{ok:true}:structuredClone(current);
 };
 assert.equal(onboardingChanged(state,draft),true);
 const saved=await saveOnboarding({id:'person',request,state,draft});
 const writes=calls.filter(call=>call.body);
 assert.deepEqual(writes.map(({action,production})=>[action,production]),[['onboarding',undefined],['saveWebsitePlacement','dark'],['trackPaperwork','lies']]);
 assert.equal(writes[0].body.productions[0].approve,true);
 assert.ok(!Object.hasOwn(writes[0].body.productions[0],'paperwork'));
 assert.equal(writes[1].body.expectedRevision,'');
 assert.equal(writes[2].body.reason,'not-required');
 assert.equal(saved.results.every(result=>result.ok),true);
 assert.equal(onboardingChanged(saved.state,onboardingDraft(saved.state)),false);
});

test('onboarding detects a changed billing revision and still saves independent paperwork',async()=>{
 const state=fixture(),draft=onboardingDraft(state),current=structuredClone(state),calls=[];
 draft[0].castPlacement='lead';draft[0].billingOrder='3';draft[1].paperwork='complete';
 current.productions[0].placement={castPlacement:'supporting',revision:'other-admin'};
 const request=async(action,body,id,suffix,production)=>{
  if(body)calls.push({action,body,production});
  if(action==='trackPaperwork')current.productions[1].paperwork.reason=body.reason;
  return body?{ok:true}:structuredClone(current);
 };
 const saved=await saveOnboarding({id:'person',request,state,draft});
 assert.deepEqual(calls.map(call=>call.action),['trackPaperwork']);
 assert.equal(saved.results[0].ok,false);assert.match(saved.results[0].error,/changed elsewhere/);
 assert.equal(saved.results[1].ok,true);assert.equal(saved.state.productions[1].paperwork.reason,'complete');
});

test('a pending production request becomes assigned before its billing and tracking are saved',async()=>{
 const state=fixture();state.productions[1].assigned=false;
 const draft=onboardingDraft(state),current=structuredClone(state),writes=[];
 draft[1].paperwork='not-required';
 assert.equal(onboardingChanged(state,onboardingDraft(state)),false,'Opening a pending request does not create unsaved edits.');
 const request=async(action,body,id,suffix,production)=>{
  if(body)writes.push(action);
  if(action==='onboarding'&&body)current.productions[1].assigned=true;
  if(action==='trackPaperwork')assert.equal(current.productions[1].assigned,true);
  return body?{ok:true}:structuredClone(current);
 };
 await saveOnboarding({id:'person',request,state,draft});
 assert.deepEqual(writes,['onboarding','trackPaperwork']);
});

test('an interrupted post-save refresh identifies the submitted assignment step',async()=>{
 const state=fixture(),draft=onboardingDraft(state);draft[0].approve=true;
 const request=async(action,body)=>{if(body)return {ok:true};throw Error('Network unavailable');};
 await assert.rejects(saveOnboarding({id:'person',request,state,draft}),error=>error.coreSaved&&/Assignments and approvals were submitted/.test(error.message));
});

test('saving shared biography or contact data retains onboarding choices while refreshing approval revisions',()=>{
 const state=fixture(),draft=onboardingDraft(state),current=structuredClone(state);
 draft[0].character='Detective';draft[0].castPlacement='lead';draft[0].billingOrder='2';draft[0].approve=true;draft[1].paperwork='complete';
 current.memberRevision='profile-saved';current.profileRevision='profile-new';current.profile.bio='New saved biography';
 const rebased=rebaseOnboardingProfile(state,current,draft);
 assert.equal(rebased.state.memberRevision,'profile-saved');assert.equal(rebased.profileChanged,true);
 assert.equal(rebased.draft[0].character,'Detective');assert.equal(rebased.draft[0].billingOrder,'2');
 assert.equal(rebased.draft[0].approve,false);assert.equal(rebased.draft[1].paperwork,'complete');
 assert.equal(draft[0].approve,true,'The caller retains its original choices until refresh succeeds.');
 current.productions[1].crewTitle='Edited elsewhere';
 assert.throws(()=>rebaseOnboardingProfile(state,current,draft),/Production settings changed/);
});

test('shared profile refresh cannot erase a concurrent conflict with dirty placement or paperwork',()=>{
 const state=fixture(),draft=onboardingDraft(state),current=structuredClone(state);
 draft[0].castPlacement='lead';draft[0].billingOrder='2';draft[1].paperwork='complete';
 current.memberRevision='other-admin';current.productions[0].placement={castPlacement:'supporting',revision:'changed'};
 assert.throws(()=>rebaseOnboardingProfile(state,current,draft),/Website placement changed/);
 current.productions[0].placement={castPlacement:'lead',billingOrder:2,revision:'changed'};
 current.productions[1].paperwork.reason='not-required';
 assert.throws(()=>rebaseOnboardingProfile(state,current,draft),/Agreement tracking changed/);
 current.productions[1].paperwork.reason='complete';
 const rebased=rebaseOnboardingProfile(state,current,draft);
 assert.equal(rebased.draft[1].paperwork,'');
 assert.equal(onboardingChanged(rebased.state,rebased.draft),false,'An independently saved matching intent is already satisfied.');
});
