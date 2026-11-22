import test from 'node:test';
import assert from 'node:assert/strict';
import {manualCampaignChoices,manualCampaignAssignment} from '../members/supporters.js';
import {saveManualSupporter} from '../netlify/lib/supporters.mjs';

const campaigns=[
  {id:'e2ozh2',title:'Take Two',active:true},
  {id:'b2mXyf',title:'Double Feature Fundraiser',active:false}
];

test('manual campaign choices default to lifetime-only and clearly label current and historic campaigns',()=>{
  const before=structuredClone(campaigns);
  assert.deepEqual(manualCampaignChoices(campaigns),[
    {value:'',label:'Lifetime support only'},
    {value:'e2ozh2',label:'Current · Take Two'},
    {value:'b2mXyf',label:'Historic · Double Feature Fundraiser'}
  ]);
  assert.deepEqual(campaigns,before,'Building the selector does not change campaign configuration.');
});

test('new records and changed campaign choices send explicit assignments while unchanged edits omit them',()=>{
  assert.deepEqual(manualCampaignAssignment(''),{campaignId:''});
  assert.deepEqual(manualCampaignAssignment('e2ozh2'),{campaignId:'e2ozh2'});
  assert.deepEqual(manualCampaignAssignment('e2ozh2','e2ozh2'),{});
  assert.deepEqual(manualCampaignAssignment('b2mXyf','e2ozh2'),{campaignId:'b2mXyf'});
  assert.deepEqual(manualCampaignAssignment('',''),{},'An existing unassigned payment is distinct from a new blank form.');
});

test('clearing an edited campaign explicitly returns the existing payment to lifetime-only support',()=>{
  assert.deepEqual(manualCampaignAssignment('','e2ozh2'),{campaignId:''});
  assert.deepEqual(manualCampaignAssignment('','removed-campaign'),{campaignId:''});
});

test('an unavailable saved campaign remains selectable and survives an unrelated edit',()=>{
  const choices=manualCampaignChoices(campaigns,'removed-campaign');
  assert.deepEqual(choices.at(-1),{value:'removed-campaign',label:'Unavailable campaign — lifetime only until reassigned'});
  assert.deepEqual(manualCampaignAssignment('removed-campaign','removed-campaign'),{});
  assert.deepEqual(manualCampaignAssignment('e2ozh2','removed-campaign'),{campaignId:'e2ozh2'});
});

test('a newly unavailable selection is sent for server validation rather than silently becoming unassigned',()=>{
  assert.deepEqual(manualCampaignAssignment('removed-campaign'),{campaignId:'removed-campaign'});
});

test('refreshing an open form cannot restore its stale campaign over another administrator’s saved choice',()=>{
  const state={sales:{},supporterLedger:{transactions:{},moderation:{},publicFeed:{campaigns}}};
  const form={id:'manual:11111111-1111-4111-8111-111111111111',name:'Fictional Supporter',gross:2500,status:'paid',refunded:null,channel:'Cash',processor:'',reference:'FICTITIOUS-REF',showName:true,showAmount:false,hidden:true};
  saveManualSupporter(state,{...form,campaignId:'e2ozh2'});
  const originalSelection='e2ozh2';
  saveManualSupporter(state,{...form,campaignId:'b2mXyf'});
  const payload={...form,revision:'fresh-ledger-after-other-admin-save',...manualCampaignAssignment(originalSelection,originalSelection)};
  assert.equal(Object.hasOwn(payload,'campaignId'),false);
  saveManualSupporter(state,payload);
  const saved=state.supporterLedger.transactions[form.id];
  assert.equal(saved.campaignId,'b2mXyf');
  assert.equal(saved.gross,2500);assert.equal(saved.hidden,true);assert.equal(saved.showName,true);assert.equal(saved.showAmount,false);
});

test('registry IDs preserve case and malformed or duplicate entries cannot replace the lifetime choice',()=>{
  const choices=manualCampaignChoices([null,{id:'',title:'Invalid'},{id:'AbC',title:'<img src=x>',active:true},{id:'AbC',title:'Duplicate',active:false},{id:'abc',title:'Different campaign',active:false}]);
  assert.deepEqual(choices,[{value:'',label:'Lifetime support only'},{value:'AbC',label:'Current · <img src=x>'},{value:'abc',label:'Historic · Different campaign'}]);
});
