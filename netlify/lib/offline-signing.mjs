import {createHash} from 'node:crypto';
import {signwell as providerSignwell} from './signing.mjs';

export const HEIDI_COUNTERSIGN_EMAIL = 'heidi@heidimikacfilms.com';
const mode = 'offline-countersign';
const productions = new Set(['written-in-the-dark', 'wherein-lies-continue']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (message, status = 409) => Object.assign(new Error(message), {status});

function scopedKey(profileId, productionId, prefix) {
  if (!productions.has(productionId) || !/^[a-z0-9_-]{1,128}$/i.test(profileId || ''))
    throw fail('Unknown film profile or production.', 400);
  const scope = productionId === 'written-in-the-dark' ? '' : 'productions/' + productionId + '/';
  return scope + prefix + '/' + profileId;
}

// All helpers take the raw strongly consistent store, not portal.mjs's scoped wrapper.
export const offlineSigningKey = (profileId, productionId) => scopedKey(profileId, productionId, 'offline-signing');
const offlineKey = (profileId, productionId) => scopedKey(profileId, productionId, 'offline');

async function withSourceState(store, agreement) {
  if (!agreement) return null;
  const source = await store.getWithMetadata(offlineKey(agreement.profileId, agreement.productionId), {type: 'arrayBuffer'});
  return {...agreement, sourceChanged: !source || digest(Buffer.from(source.data)) !== agreement.sourceHash};
}

export async function getOfflineCountersign({store, profileId, productionId}) {
  const record = await store.getWithMetadata(offlineSigningKey(profileId, productionId), {type: 'json'});
  return withSourceState(store, record?.data);
}

/** Prepare an unsent draft from the exact uploaded PDF. Never retries an existing reservation. */
export async function prepareOfflineCountersign({
  store, profile, productionId, film, live = false,
  signwell = providerSignwell, existingOnlineAgreement = false, beforeCreate
}) {
  const key = offlineSigningKey(profile?.id, productionId);
  const existing = await store.getWithMetadata(key, {type: 'json'});
  if (existing) return {agreement: await withSourceState(store, existing.data), created: false};
  if (existingOnlineAgreement)
    throw fail('An online agreement already exists for this profile. Reconcile it before preparing another request.');
  if (typeof profile.name !== 'string' || !profile.name.trim() || typeof film !== 'string' || !film.trim())
    throw fail('A profile name and film title are required.', 400);

  const uploadedKey = offlineKey(profile.id, productionId);
  const source = await store.getWithMetadata(uploadedKey, {type: 'arrayBuffer'});
  if (!source) throw fail('No uploaded agreement is on file.', 404);
  if (source.metadata?.status !== 'Waiting on Heidi')
    throw fail('Only a complete uploaded agreement marked Waiting on Heidi can be prepared.');
  const bytes = Buffer.from(source.data);
  if (bytes.length > 4 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== '%PDF-')
    throw fail('The uploaded agreement must be a PDF up to 4 MB.', 400);

  const sourceHash = digest(bytes);
  const sourceKey = scopedKey(profile.id, productionId, 'offline-signing-sources') + '/' + sourceHash + '.pdf';
  const reservation = {
    mode, profileId: profile.id, productionId, name: profile.name, film,
    recipientEmail: HEIDI_COUNTERSIGN_EMAIL, sourceHash, sourceKey,
    sourceStatus: source.metadata.status, status: 'Preparing draft', createdAt: Date.now(),
    testMode: live !== true
  };
  const locked = await store.setJSON(key, reservation, {onlyIfNew: true});
  if (!locked.modified) {
    const winner = await store.getWithMetadata(key, {type: 'json'});
    if (!winner) throw fail('Preparation is already reserved. Reload before continuing.');
    return {agreement: await withSourceState(store, winner.data), created: false};
  }
  const lock = await store.getWithMetadata(key, {type: 'json'});
  let document;
  try {
    // Keep an immutable copy even if the original uploaded file is later replaced.
    await store.set(sourceKey, bytes, {onlyIfNew: true, metadata: {sourceHash, profileId: profile.id, productionId}});
    const saved = await store.getWithMetadata(sourceKey, {type: 'arrayBuffer'});
    if (!saved || digest(Buffer.from(saved.data)) !== sourceHash)
      throw fail('The original agreement snapshot could not be verified.');
    const current = await store.getWithMetadata(uploadedKey, {type: 'arrayBuffer'});
    if (!current || digest(Buffer.from(current.data)) !== sourceHash || current.metadata?.status !== 'Waiting on Heidi')
      throw fail('The uploaded agreement changed during preparation. Review it before continuing.');

    // The portal rechecks regular agreement reservations after this reservation exists.
    if (beforeCreate) await beforeCreate();
    document = await signwell('documents/', {
      test_mode: live !== true,
      draft: true,
      with_signature_page: true,
      embedded_signing: true,
      name: film + ' — ' + profile.name + ' — Heidi countersignature',
      files: [{name: 'Original signed agreement.pdf', file_base64: bytes.toString('base64')}],
      recipients: [{id: '2', name: 'Heidi Mikac', email: HEIDI_COUNTERSIGN_EMAIL, send_email: true}]
    });
    if (!document?.id || typeof document.id !== 'string') throw fail('SignWell returned no document ID. Check the dashboard before continuing.', 502);
    const providerStatus = String(document.status || '').trim().toLowerCase();
    if (providerStatus && !['draft', 'created'].includes(providerStatus)) throw fail('SignWell returned an unexpected document state. Review it in the dashboard.', 502);
    const agreement = {...reservation, id: document.id, status: providerStatus === 'draft' ? 'Draft prepared' : 'Preparing draft', providerStatus: document.status || null, checkedAt: Date.now()};
    const committed = await store.setJSON(key, agreement, {onlyIfMatch: lock.etag});
    if (!committed.modified) throw fail('The draft was created but its record changed. Check SignWell before continuing.');
    return {agreement: await withSourceState(store, agreement), created: true};
  } catch (error) {
    // A timeout may occur after provider creation. The durable reservation must never expire or be automatically retried.
    const recovery = {...reservation, ...(typeof document?.id === 'string' ? {id: document.id} : {}),
      status: 'Needs recovery', failedAt: Date.now(),
      syncError: 'Draft preparation could not be confirmed. Check SignWell before any further request.'};
    try { await store.setJSON(key, recovery, {onlyIfMatch: lock.etag}); } catch { /* The original reservation still blocks duplicates. */ }
    throw error;
  }
}

export function offlineCountersignStatus(document) {
  const status = String(document.status || '').trim().toLowerCase();
  if (status === 'draft') return 'Draft prepared';
  if (status === 'created') return 'Preparing draft';
  if (status === 'completed') return 'Complete';
  if (['declined', 'canceled', 'cancelled', 'expired'].includes(status)) return status;
  if (status === 'bounced') return 'Delivery failed';
  if (['sent', 'viewed', 'pending', 'in_progress'].includes(status)) return 'Waiting on Heidi';
  return 'Needs review';
}

/** Read provider state without sending a draft, changing its source, or exposing a signing URL. */
export async function refreshOfflineCountersign({store, profileId, productionId, force = false, signwell = providerSignwell, onDocument}) {
  const key = offlineSigningKey(profileId, productionId);
  const record = await store.getWithMetadata(key, {type: 'json'}), agreement = record?.data;
  if (!agreement?.id || (!force && Date.now() - (agreement.checkedAt || 0) < 300000))
    return withSourceState(store, agreement);
  let next;
  try {
    const document = await signwell('documents/' + encodeURIComponent(agreement.id) + '/');
    const recipient = document.recipients?.[0];
    if (document.id !== agreement.id || document.recipients?.length !== 1 || String(recipient?.id) !== '2' || recipient?.email?.toLowerCase() !== HEIDI_COUNTERSIGN_EMAIL)
      throw fail('The provider document does not match the Heidi-only request.');
    // Authorized callers may extract transient provider URLs; those URLs are never persisted here.
    if (onDocument) await onDocument(document);
    next = {...agreement, status: offlineCountersignStatus(document), providerStatus: document.status, checkedAt: Date.now(), syncError: null};
  } catch {
    next = {...agreement, checkedAt: Date.now(), syncError: 'Status could not be refreshed. Last known status shown.'};
  }
  const saved = await store.setJSON(key, next, {onlyIfMatch: record.etag});
  if (!saved.modified) next = (await store.getWithMetadata(key, {type: 'json'}))?.data;
  return withSourceState(store, next);
}
