import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {
  HEIDI_COUNTERSIGN_EMAIL, getOfflineCountersign, offlineSigningKey,
  prepareOfflineCountersign, refreshOfflineCountersign
} from '../netlify/lib/offline-signing.mjs';

const original = Buffer.from('%PDF-1.7\nOriginal agreement with existing actor signature\n%%EOF');
const changed = Buffer.from('%PDF-1.7\nA replacement agreement\n%%EOF');
const profile = {id: 'profile-without-account', name: 'Example Performer'};
const productionId = 'written-in-the-dark';

function makeStore() {
  const data = new Map(); let revision = 0;
  return {
    data,
    async getWithMetadata(key) {
      const value = data.get(key);
      return value ? {data: structuredClone(value.data), etag: value.etag, metadata: structuredClone(value.metadata)} : null;
    },
    async set(key, value, options = {}) {
      const previous = data.get(key);
      if ((options.onlyIfNew && previous) || (options.onlyIfMatch && previous?.etag !== options.onlyIfMatch)) return {modified: false};
      data.set(key, {data: structuredClone(value), etag: String(++revision), metadata: options.metadata});
      return {modified: true};
    },
    async setJSON(key, value, options) { return this.set(key, value, options); }
  };
}
async function fixture(status = 'Waiting on Heidi') {
  const store = makeStore();
  await store.set('offline/' + profile.id, original, {metadata: {status}});
  return {store, profile, productionId, film: 'Written in the Dark'};
}
const providerDraft = {id: 'draft-1', status: 'draft'};

test('creates an unsent Heidi-only draft from exact original bytes without requiring a member account', async () => {
  const options = await fixture(); let payload;
  const result = await prepareOfflineCountersign({...options, live: true, signwell: async (path, body) => {
    assert.equal(path, 'documents/'); payload = body; return {...providerDraft, status: 'Draft'};
  }});
  assert.equal(result.created, true);
  assert.equal(payload.draft, true);
  assert.equal(payload.with_signature_page, false,'The existing document gets inline fields rather than an appended page.');
  assert.equal(payload.embedded_signing, true);
  assert.equal(payload.test_mode, false);
  assert.deepEqual(payload.recipients, [{id: '2', name: 'Heidi Mikac', email: HEIDI_COUNTERSIGN_EMAIL, send_email: true}]);
  assert.deepEqual(Buffer.from(payload.files[0].file_base64, 'base64'), original);
  assert.equal(result.agreement.sourceHash, createHash('sha256').update(original).digest('hex'));
  assert.equal(result.agreement.status, 'Draft prepared');
  assert.equal(result.agreement.mode, 'offline-countersign');
  assert.equal(result.agreement.recipientEmail, HEIDI_COUNTERSIGN_EMAIL);
  const snapshot = await options.store.getWithMetadata(result.agreement.sourceKey);
  assert.deepEqual(Buffer.from(snapshot.data), original);
  assert.deepEqual(Buffer.from((await options.store.getWithMetadata('offline/' + profile.id)).data), original);
});

test('concurrent and repeated preparations make exactly one provider request', async () => {
  const options = await fixture(); let calls = 0;
  const signwell = async () => { calls++; return providerDraft; };
  const results = await Promise.all(Array.from({length: 8}, () => prepareOfflineCountersign({...options, signwell})));
  assert.equal(calls, 1);
  assert.equal(results.filter(result => result.created).length, 1);
  const again = await prepareOfflineCountersign({...options, signwell});
  assert.equal(again.created, false);
  assert.equal(again.agreement.id, 'draft-1');
  assert.equal(calls, 1);
});

test('an ambiguous timeout leaves a durable recovery record and cannot recreate a document', async () => {
  const options = await fixture(); let calls = 0;
  const signwell = async () => { calls++; throw new Error('Timed out after provider may have created the document'); };
  await assert.rejects(prepareOfflineCountersign({...options, signwell}), /Timed out/);
  const record = await getOfflineCountersign({store: options.store, profileId: profile.id, productionId});
  assert.equal(record.status, 'Needs recovery');
  assert(record.sourceHash);
  assert(record.sourceKey);
  const again = await prepareOfflineCountersign({...options, signwell});
  assert.equal(again.created, false);
  assert.equal(again.agreement.status, 'Needs recovery');
  assert.equal(calls, 1);
});

test('recovery and preparing records never expire into automatic retries', async () => {
  for (const status of ['Needs recovery', 'Preparing draft']) {
    const options = await fixture(); let calls = 0;
    await options.store.setJSON(offlineSigningKey(profile.id, productionId), {
      profileId: profile.id, productionId, status, createdAt: 1,
      sourceHash: createHash('sha256').update(original).digest('hex')
    });
    const result = await prepareOfflineCountersign({...options, signwell: async () => { calls++; return providerDraft; }});
    assert.equal(result.created, false);
    assert.equal(result.agreement.status, status);
    assert.equal(calls, 0);
  }
});

test('only exact Waiting on Heidi is eligible and existing online requests block new drafts', async () => {
  for (const status of ['Complete', 'Missing page 1 · waiting on Heidi', 'Waiting on actor', '', 'waiting on heidi']) {
    const options = await fixture(status); let calls = 0;
    await assert.rejects(prepareOfflineCountersign({...options, signwell: async () => { calls++; return providerDraft; }}), /Only a complete uploaded agreement/);
    assert.equal(calls, 0);
    assert.equal(options.store.data.has(offlineSigningKey(profile.id, productionId)), false);
  }
  const options = await fixture();
  await assert.rejects(prepareOfflineCountersign({...options, existingOnlineAgreement: {id: 'existing'}, signwell: async () => assert.fail('Must not create')}), /online agreement already exists/);
});

test('production keys and original files stay isolated; test mode is the default', async () => {
  const options = await fixture();
  await options.store.set('productions/wherein-lies-continue/offline/' + profile.id, changed, {metadata: {status: 'Waiting on Heidi'}});
  const calls = [];
  const signwell = async (path, body) => { calls.push(body); return {id: 'draft-' + calls.length, status: 'draft'}; };
  const dark = await prepareOfflineCountersign({...options, signwell});
  const wherein = await prepareOfflineCountersign({...options, productionId: 'wherein-lies-continue', film: 'Wherein Lies Continue', signwell});
  assert.equal(calls.length, 2);
  assert(calls.every(body => body.test_mode === true && body.draft === true));
  assert.notEqual(dark.agreement.sourceKey, wherein.agreement.sourceKey);
  assert(options.store.data.has('offline-signing/' + profile.id));
  assert(options.store.data.has('productions/wherein-lies-continue/offline-signing/' + profile.id));
  assert.deepEqual(Buffer.from(calls[0].files[0].file_base64, 'base64'), original);
  assert.deepEqual(Buffer.from(calls[1].files[0].file_base64, 'base64'), changed);
});

test('a replaced source is reported and never silently generates another signing request', async () => {
  const options = await fixture(); let calls = 0;
  const signwell = async () => { calls++; return providerDraft; };
  const first = await prepareOfflineCountersign({...options, signwell});
  await options.store.set('offline/' + profile.id, changed, {metadata: {status: 'Waiting on Heidi'}});
  const repeat = await prepareOfflineCountersign({...options, signwell});
  assert.equal(repeat.agreement.sourceChanged, true);
  assert.equal(repeat.agreement.sourceHash, first.agreement.sourceHash);
  assert.equal(calls, 1);
  assert.deepEqual(Buffer.from((await options.store.getWithMetadata(first.agreement.sourceKey)).data), original);
});

test('source changed during preparation is blocked before a provider call and retained for recovery', async () => {
  const options = await fixture(), save = options.store.set.bind(options.store);
  options.store.set = async (key, value, settings) => {
    const result = await save(key, value, settings);
    if (key.startsWith('offline-signing-sources/')) await save('offline/' + profile.id, changed, {metadata: {status: 'Waiting on Heidi'}});
    return result;
  };
  await assert.rejects(prepareOfflineCountersign({...options, signwell: async () => assert.fail('Must not create')}), /changed during preparation/);
  const record = await getOfflineCountersign({store: options.store, profileId: profile.id, productionId});
  assert.equal(record.status, 'Needs recovery');
  assert.equal(record.sourceChanged, true);
});

test('refresh follows provider state, preserves source metadata, and never sends', async () => {
  const options = await fixture();
  await prepareOfflineCountersign({...options, signwell: async () => providerDraft});
  for (const [providerStatus, expected] of [
    ['draft', 'Draft prepared'], ['sent', 'Waiting on Heidi'], ['pending', 'Waiting on Heidi'],
    ['canceled', 'canceled'], ['cancelled', 'cancelled'], ['bounced', 'Delivery failed'],
    ['Created', 'Preparing draft'], [' Draft ', 'Draft prepared'], ['Sent', 'Waiting on Heidi'], [' Pending ', 'Waiting on Heidi'],
    ['Canceled', 'canceled'], ['Bounced', 'Delivery failed'], ['Completed', 'Complete']
  ]) {
    const result = await refreshOfflineCountersign({store: options.store, profileId: profile.id, productionId, force: true,
      signwell: async (path, body) => {
        assert.equal(path, 'documents/draft-1/'); assert.equal(body, undefined);
        return {...providerDraft, status: providerStatus, recipients: [{id: '2', email: HEIDI_COUNTERSIGN_EMAIL}]};
      }});
    assert.equal(result.status, expected);
    assert.equal(result.mode, 'offline-countersign');
    assert.equal(result.sourceHash, createHash('sha256').update(original).digest('hex'));
    assert.equal(result.sourceChanged, false);
  }
  const completed=await refreshOfflineCountersign({store:options.store,profileId:profile.id,productionId,force:true,
    signwell:async()=>{throw Error('A completed agreement must not be reopened.');}});
  assert.equal(completed.status,'Complete');
});

test('refresh cannot accept the wrong provider document or an actor recipient', async () => {
  const options = await fixture();
  await prepareOfflineCountersign({...options, signwell: async () => providerDraft});
  let callbackInvoked = false;
  const result = await refreshOfflineCountersign({store: options.store, profileId: profile.id, productionId, force: true,
    onDocument: () => { callbackInvoked = true; },
    signwell: async () => ({id: 'wrong-id', status: 'completed', recipients: [{id: '1', email: 'actor@example.com'}]})});
  assert.equal(result.status, 'Draft prepared');
  assert.match(result.syncError, /could not be refreshed/);
  assert.equal(callbackInvoked, false);
});

test('post-reservation conflict check blocks provider creation and leaves a durable recovery record', async () => {
  const options = await fixture(); let calls = 0;
  await assert.rejects(prepareOfflineCountersign({...options,
    beforeCreate: async () => {
      const reservation = await getOfflineCountersign({store: options.store, profileId: profile.id, productionId});
      assert.equal(reservation.status, 'Preparing draft');
      assert.equal(reservation.sourceChanged, false);
      assert(options.store.data.has(reservation.sourceKey));
      throw Object.assign(new Error('A regular agreement was reserved concurrently.'), {status: 409});
    },
    signwell: async () => { calls++; return providerDraft; }
  }), /reserved concurrently/);
  const result = await getOfflineCountersign({store: options.store, profileId: profile.id, productionId});
  assert.equal(result.status, 'Needs recovery');
  assert.equal(calls, 0);
});

test('validated provider callbacks expose transient links without storing them', async () => {
  const options = await fixture();
  await prepareOfflineCountersign({...options, signwell: async () => providerDraft});
  const signingUrl = 'https://www.signwell.com/mock-private-signing-link'; let observed;
  const refreshed = await refreshOfflineCountersign({store: options.store, profileId: profile.id, productionId, force: true,
    onDocument: async document => { observed = document.recipients[0].embedded_signing_url; },
    signwell: async () => ({...providerDraft, status: 'sent', recipients: [{id: '2', email: HEIDI_COUNTERSIGN_EMAIL, embedded_signing_url: signingUrl}]})});
  assert.equal(observed, signingUrl);
  assert.equal(refreshed.status, 'Waiting on Heidi');
  assert.equal(JSON.stringify(refreshed).includes(signingUrl), false);
  const stored = await options.store.getWithMetadata(offlineSigningKey(profile.id, productionId));
  assert.equal(JSON.stringify(stored.data).includes(signingUrl), false);
});

test('Created responses retain the document ID until a GET confirms Draft without recreating or sending', async () => {
  const options = await fixture(); let calls = 0;
  const signwell = async (path, body) => {
    calls++; assert.equal(path, 'documents/'); assert.equal(body.draft, true);
    assert.equal(body.recipients[0].send_email, true);
    return {...providerDraft, status: 'Created'};
  };
  const first = await prepareOfflineCountersign({...options, signwell});
  assert.equal(first.agreement.id, 'draft-1');
  assert.equal(first.agreement.status, 'Preparing draft');
  const repeated = await prepareOfflineCountersign({...options, signwell});
  assert.equal(repeated.created, false);
  assert.equal(calls, 1);
  const refreshed = await refreshOfflineCountersign({store: options.store, profileId: profile.id, productionId, force: true,
    signwell: async (path, body) => {
      assert.equal(path, 'documents/draft-1/'); assert.equal(body, undefined);
      return {...providerDraft, status: 'Draft', recipients: [{id: '2', email: HEIDI_COUNTERSIGN_EMAIL}]};
    }});
  assert.equal(refreshed.status, 'Draft prepared');
  assert.equal(refreshed.id, first.agreement.id);
});
