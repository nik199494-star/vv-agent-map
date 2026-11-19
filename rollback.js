import {assertFreshEnough, validateSnapshot} from './source.js';

const hash = /^[a-f0-9]{64}$/;
const id = /^[a-z0-9-]{1,80}$/i;
const files = ['demand.json', 'coordinates.json', 'ru-city-centers.json'];

export function publicationIdentity(snapshot) {
  return JSON.stringify([snapshot.snapshotId ?? null, snapshot.publishedAt, snapshot.sourceDate]);
}

export function validateRollbackReceipt(receipt, now = Date.now()) {
  const failed = Date.parse(receipt?.failedPublishedAt);
  const restored = Date.parse(receipt?.restoredAt);
  if (receipt?.schema !== 1 || !id.test(receipt.failedSnapshotId ?? '') ||
      !Number.isFinite(failed) || !Number.isFinite(restored) || restored < failed || restored > now + 5 * 60_000 ||
      !files.every(name => hash.test(receipt.hashes?.[name] ?? ''))) {
    throw Error('Неверная квитанция отката.');
  }
  return receipt;
}

async function readAsset(name, request, timeout) {
  const response = await request(new URL(name, import.meta.url), {
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw Error('Файл недоступен (HTTP ' + response.status + '): ' + name);
  const bytes = await response.arrayBuffer();
  return {bytes, json: JSON.parse(new TextDecoder().decode(bytes))};
}

async function matchesHash(asset, expected) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', asset.bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') === expected;
}

const dictionary = value => value && typeof value === 'object' && !Array.isArray(value);

export async function fetchRelease(request = fetch, now = Date.now()) {
  const [demand, notice] = await Promise.all([
    readAsset('demand.json', request, 15000),
    readAsset('rollback.json', request, 3000).catch(() => null),
  ]);
  const snapshot = validateSnapshot(demand.json);
  if (!notice) return {snapshot};
  let receipt;
  try {
    receipt = validateRollbackReceipt(notice.json, now);
    if (snapshot.snapshotId === receipt.failedSnapshotId || Date.parse(snapshot.publishedAt) >= Date.parse(receipt.failedPublishedAt) ||
        !await matchesHash(demand, receipt.hashes[files[0]])) return {snapshot};
  } catch {
    return {snapshot};
  }
  try {
    const [coordinates, cities] = await Promise.all(files.slice(1).map(name => readAsset(name, request, 5000)));
    if (!dictionary(coordinates.json) || !dictionary(cities.json) ||
        !await matchesHash(coordinates, receipt.hashes[files[1]]) ||
        !await matchesHash(cities, receipt.hashes[files[2]])) throw Error('Несовпадение файлов.');
    return {snapshot, receipt, locations: {coordinates: coordinates.json, cities: cities.json}};
  } catch {
    throw Error('Файлы отката ещё не согласованы.');
  }
}

export function selectRelease(candidate, previous) {
  const {snapshot, receipt, locations} = candidate;
  const before = previous?.snapshot;
  const floor = previous?.restoredAt ?? 0;
  const same = before && publicationIdentity(before) === publicationIdentity(snapshot);
  const attemptedRollback = receipt ? Date.parse(receipt.restoredAt) : 0;
  if (receipt && locations && attemptedRollback >= floor && (!before || same ||
      before.snapshotId === receipt.failedSnapshotId && Date.parse(before.publishedAt) === Date.parse(receipt.failedPublishedAt))) {
    return {snapshot, restoredAt: attemptedRollback, locations};
  }
  if (same && floor) return previous;
  if (floor && Date.parse(snapshot.publishedAt) <= floor) throw new RangeError('Выпуск уже отменён.');
  assertFreshEnough(snapshot, before);
  return {snapshot, restoredAt: floor, locations: null};
}
