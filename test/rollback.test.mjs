import assert from 'node:assert/strict';
import test from 'node:test';
import {fetchRelease, selectRelease} from '../rollback.js';
import {sha256} from '../scripts/projection.mjs';

const older = {schema: 3, sourceDate: '18.11.2026', publishedAt: '2026-11-18T08:00:00Z', points: []};
const current = {...older, sourceDate: '19.11.2026', publishedAt: '2026-11-19T08:00:00Z', snapshotId: 'failed-version'};
const now = Date.parse('2026-11-19T08:01:00Z');

function restored() {
  const files = {
    'demand.json': JSON.stringify(older) + '\n',
    'coordinates.json': '{}',
    'ru-city-centers.json': '{"москва":[55.75,37.6]}',
  };
  const receipt = {
    schema: 1, failedSnapshotId: current.snapshotId, failedPublishedAt: current.publishedAt,
    restoredAt: new Date(now).toISOString(),
    hashes: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, sha256(value)])),
  };
  files['rollback.json'] = JSON.stringify(receipt);
  return {files, receipt, request: async url => {
    const value = files[url.pathname.split('/').at(-1)];
    return value === undefined ? new Response(null, {status: 404}) : new Response(value);
  }};
}

test('an intact rollback updates a warm or legacy cache and rejects a late copy of the failed release', async () => {
  const {request} = restored();
  const proof = await fetchRelease(request, now);
  const selected = selectRelease(proof, {snapshot: current});
  assert.equal(selected.snapshot, proof.snapshot);
  assert.equal(selected.restoredAt, now);
  assert.deepEqual(selected.locations.cities['москва'], [55.75, 37.6]);
  assert.equal(selectRelease(proof, null).restoredAt, now);
  assert.equal(selectRelease({snapshot: older}, selected), selected);
  assert.throws(() => selectRelease({snapshot: current}, selected), /уже отменён/);
  const next = {...current, snapshotId: 'approved-new-release', publishedAt: new Date(now + 60000).toISOString()};
  const nextRelease = selectRelease({snapshot: next}, selected);
  assert.equal(nextRelease.snapshot, next);
  assert.equal(nextRelease.restoredAt, now);
  assert.throws(() => selectRelease(proof, nextRelease), /уже отменён/);
});

test('a partial restore, old response, wrong failed identity and future receipt cannot replace a warm cache', async () => {
  for (const changed of ['demand.json', 'coordinates.json', 'ru-city-centers.json', 'rollback.json']) {
    const mock = restored();
    if (changed === 'demand.json') mock.files[changed] = JSON.stringify(older);
    else if (changed === 'rollback.json') mock.files[changed] = JSON.stringify({...mock.receipt, restoredAt: '2026-11-19T09:00:00Z'});
    else mock.files[changed] = '{"unexpected":true}';
    if (changed === 'coordinates.json' || changed === 'ru-city-centers.json') {
      await assert.rejects(fetchRelease(mock.request, now), /не согласованы/);
      continue;
    }
    const candidate = await fetchRelease(mock.request, now);
    assert.equal(candidate.receipt, undefined, changed);
    assert.throws(() => selectRelease(candidate, {snapshot: current}), /более ранняя версия/);
  }
  const good = restored();
  const candidate = await fetchRelease(good.request, now);
  assert.throws(() => selectRelease(candidate, {snapshot: {...current, snapshotId: 'unrelated'}}), /более ранняя версия/);
});

test('ordinary refresh remains available when the optional rollback endpoint fails', async () => {
  const release = await fetchRelease(async url => url.pathname.endsWith('/demand.json')
    ? Response.json(current) : new Response(null, {status: 503}), now);
  assert.equal(release.receipt, undefined);
  assert.deepEqual(selectRelease(release, {snapshot: older}).snapshot, current);
});
