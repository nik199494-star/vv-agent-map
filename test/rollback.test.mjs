import assert from 'node:assert/strict';
import test from 'node:test';
import {fetchRelease, releaseFiles, selectRelease} from '../rollback.js';
import {sha256} from '../scripts/projection.mjs';

const older = {schema: 3, sourceDate: '18.11.2026', publishedAt: '2026-11-18T08:00:00Z', points: []};
const failed = {...older, sourceDate: '19.11.2026', publishedAt: '2026-11-19T08:00:00Z', snapshotId: 'failed-version'};
const now = Date.parse('2026-11-19T08:01:00Z');
const next = {...failed, snapshotId: 'approved-new-release', publishedAt: new Date(now + 60000).toISOString()};

function bundle(snapshot = older, notice) {
  const files = {
    'demand.json': JSON.stringify(snapshot) + '\n',
    'coordinates.json': '{}',
    'ru-city-centers.json': '{"москва":[55.75,37.6]}',
  };
  const receipt = {
    schema: 1, failedSnapshotId: failed.snapshotId, failedPublishedAt: failed.publishedAt,
    restoredAt: new Date(now).toISOString(),
    hashes: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, sha256(value)])),
  };
  files['publication.json'] = JSON.stringify({schema: 1,
    ...Object.fromEntries(Object.entries(releaseFiles).map(([key, name]) => [key, receipt.hashes[name]]))});
  files['rollback.json'] = JSON.stringify(notice ?? {schema: 1, active: false});
  return {files, receipt, request: async (url, options) => {
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    const value = files[url.pathname.split('/').at(-1)];
    return value === undefined ? new Response(null, {status: 404}) : new Response(value);
  }};
}

function restored() {
  const target = bundle();
  target.files['rollback.json'] = JSON.stringify(target.receipt);
  return target;
}

test('all data files and both receipts are required for a normal or restored release', async () => {
  for (const create of [bundle, restored]) {
    for (const name of [...Object.values(releaseFiles), 'publication.json', 'rollback.json']) {
      const mock = create();
      delete mock.files[name];
      await assert.rejects(fetchRelease(mock.request, now), /HTTP 404/);
    }
    for (const name of Object.values(releaseFiles)) {
      const mock = create();
      mock.files[name] += ' ';
      await assert.rejects(fetchRelease(mock.request, now), /квитанцией выпуска/);
    }
  }
  const {request} = bundle(failed);
  const loaded = await fetchRelease(request, now);
  assert.equal(loaded.snapshot.snapshotId, failed.snapshotId);
  assert.deepEqual(loaded.locations.cities['москва'], [55.75, 37.6]);
});

test('an intact rollback updates a warm or legacy cache and rejects a late copy of the failed release', async () => {
  const {request, receipt} = restored();
  const proof = await fetchRelease(request, now);
  const selected = selectRelease(proof, {snapshot: failed});
  assert.equal(selected.snapshot, proof.snapshot);
  assert.equal(selected.restoredAt, now);
  assert.equal(selectRelease(proof, null).restoredAt, now);
  const behind = {...older, sourceDate: '17.11.2026', publishedAt: '2026-11-17T08:00:00Z'};
  assert.equal(selectRelease(proof, {snapshot: behind}).restoredAt, now);
  assert.equal(selectRelease(await fetchRelease(bundle().request, now), selected), selected);
  assert.throws(() => selectRelease({snapshot: failed}, selected), /уже отменён/);
  await assert.rejects(fetchRelease(bundle(failed, receipt).request, now), /уже отменён/);
  const nextRelease = selectRelease(await fetchRelease(bundle(next, receipt).request, now), selected);
  assert.equal(nextRelease.snapshot.snapshotId, next.snapshotId);
  assert.equal(nextRelease.restoredAt, now);
  assert.throws(() => selectRelease(proof, nextRelease), /не соответствует/);
});

test('a bad or mismatched rollback receipt never authorizes a lower release', async () => {
  const {receipt} = restored();
  const corrupted = {...receipt, hashes: {...receipt.hashes, 'coordinates.json': 'f'.repeat(64)}};
  await assert.rejects(fetchRelease(bundle(older, corrupted).request, now), /не согласованы/);
  const future = {...receipt, restoredAt: '2026-11-19T09:00:00Z'};
  await assert.rejects(fetchRelease(bundle(older, future).request, now), /Неверная квитанция/);
  const proof = await fetchRelease(restored().request, now);
  assert.throws(() => selectRelease(proof, {snapshot: {...failed, snapshotId: 'unrelated'}}), /не соответствует/);
  assert.throws(() => selectRelease(proof, {snapshot: {...failed, publishedAt: '2026-11-19T07:59:00Z'}}), /не соответствует/);
});

test('a complete but altered payload with the same launch identity does not replace the verified copy', async () => {
  const first = selectRelease(await fetchRelease(bundle().request, now), null);
  const changed = bundle();
  changed.files['coordinates.json'] = '{"another":true}';
  const manifest = JSON.parse(changed.files['publication.json']);
  manifest.locations = sha256(changed.files['coordinates.json']);
  changed.files['publication.json'] = JSON.stringify(manifest);
  const incoming = await fetchRelease(changed.request, now);
  assert.throws(() => selectRelease(incoming, first), /без нового выпуска/);
});

test('a temporary receipt error fails closed until a complete release is served', async () => {
  const full = bundle(failed);
  await assert.rejects(fetchRelease((url, options) => url.pathname.endsWith('/rollback.json')
    ? new Response(null, {status: 503}) : full.request(url, options), now), /HTTP 503/);
  assert.equal((await fetchRelease(full.request, now)).snapshot.snapshotId, failed.snapshotId);
});

test('a forward release must have a later publication time and a distinct snapshot ID', async () => {
  const previous = selectRelease(await fetchRelease(bundle(failed).request, now), null);
  for (const snapshot of [
    {...failed, snapshotId: 'other-at-same-time'},
    {...next, snapshotId: failed.snapshotId},
  ]) {
    const incoming = await fetchRelease(bundle(snapshot).request, now);
    assert.throws(() => selectRelease(incoming, previous), /повторный ID/);
  }
});
