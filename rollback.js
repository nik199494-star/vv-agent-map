import {assertFreshEnough, validateSnapshot} from './source.js';

const hash = /^[a-f0-9]{64}$/;
export const snapshotIdPattern = /^[a-z0-9-]{1,80}$/i;
export const releaseFiles = {
  demand: 'demand.json',
  locations: 'coordinates.json',
  cities: 'ru-city-centers.json',
};
const clockSkew = 5 * 60_000;

export function publicationIdentity(snapshot) {
  return JSON.stringify([snapshot.snapshotId ?? null, snapshot.publishedAt, snapshot.sourceDate]);
}

export function validatePublicationReceipt(receipt) {
  if (receipt?.schema !== 1 || !Object.keys(releaseFiles).every(key => hash.test(receipt[key] ?? ''))) {
    throw Error('Неверная квитанция выпуска.');
  }
  return receipt;
}

export function validateRollbackReceipt(receipt, now = Date.now()) {
  const failed = Date.parse(receipt?.failedPublishedAt);
  const restored = Date.parse(receipt?.restoredAt);
  if (receipt?.schema !== 1 || !snapshotIdPattern.test(receipt.failedSnapshotId ?? '') ||
      !Number.isFinite(failed) || !Number.isFinite(restored) || restored < failed || restored > now + clockSkew ||
      !Object.values(releaseFiles).every(name => hash.test(receipt.hashes?.[name] ?? ''))) {
    throw Error('Неверная квитанция отката.');
  }
  return receipt;
}

export function readRollbackNotice(notice, now = Date.now()) {
  if (notice?.schema === 1 && notice.active === false && Object.keys(notice).length === 2) return null;
  return validateRollbackReceipt(notice, now);
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

export const isLocationDictionary = value => value && typeof value === 'object' && !Array.isArray(value);

export async function fetchRelease(request = fetch, now = Date.now()) {
  const [demand, coordinates, cities, publication, notice] = await Promise.all(
    [...Object.values(releaseFiles), 'publication.json', 'rollback.json'].map(name => readAsset(name, request, 15000)),
  );
  const manifest = validatePublicationReceipt(publication.json);
  const hashes = [manifest.demand, manifest.locations, manifest.cities];
  const checked = await Promise.all([demand, coordinates, cities].map((asset, i) => matchesHash(asset, hashes[i])));
  if (!checked.every(Boolean)) throw Error('Файлы не совпадают с квитанцией выпуска.');

  const snapshot = validateSnapshot(demand.json);
  const published = Date.parse(snapshot.publishedAt);
  if (published > now + clockSkew) throw Error('Дата выпуска находится в будущем.');
  if (!isLocationDictionary(coordinates.json) || !isLocationDictionary(cities.json)) {
    throw Error('Некорректные справочники географии.');
  }
  const result = {snapshot, locations: {coordinates: coordinates.json, cities: cities.json}, fingerprint: hashes.join(':')};
  const receipt = readRollbackNotice(notice.json, now);
  if (!receipt) return result;
  if (snapshot.snapshotId === receipt.failedSnapshotId) throw new RangeError('Выпуск уже отменён.');
  if (published < Date.parse(receipt.failedPublishedAt) &&
      Object.entries(releaseFiles).every(([key, name]) => manifest[key] === receipt.hashes[name])) {
    return {...result, receipt};
  }
  if (published <= Date.parse(receipt.restoredAt)) throw new RangeError('Выпуск уже отменён или файлы отката ещё не согласованы.');
  return result;
}

export function selectRelease(candidate, previous) {
  const {snapshot, receipt, locations, fingerprint} = candidate;
  const before = previous?.snapshot;
  const floor = previous?.restoredAt ?? 0;
  const same = before && publicationIdentity(before) === publicationIdentity(snapshot);
  if (same && previous.fingerprint && previous.fingerprint !== fingerprint) {
    throw new RangeError('Файлы изменились без нового выпуска.');
  }
  const attemptedRollback = receipt ? Date.parse(receipt.restoredAt) : 0;
  const cancelsPrevious = before?.snapshotId === receipt?.failedSnapshotId &&
    Date.parse(before?.publishedAt) === Date.parse(receipt?.failedPublishedAt);
  if (receipt) {
    const olderCache = before && Date.parse(before.publishedAt) < Date.parse(snapshot.publishedAt);
    if (!locations || !(attemptedRollback > floor || same && attemptedRollback === floor) ||
        !(!before || same || cancelsPrevious || olderCache)) {
      throw new RangeError('Откат не соответствует сохранённому выпуску.');
    }
    if (olderCache) assertFreshEnough(snapshot, before);
    return {snapshot, locations, fingerprint, restoredAt: attemptedRollback};
  }
  if (same && floor) return previous;
  if (floor && Date.parse(snapshot.publishedAt) <= floor) throw new RangeError('Выпуск уже отменён.');
  if (before && !same && (Date.parse(snapshot.publishedAt) <= Date.parse(before.publishedAt) ||
      (snapshot.snapshotId && snapshot.snapshotId === before.snapshotId))) {
    throw new RangeError('Получена более ранняя версия потребности или повторный ID выпуска.');
  }
  assertFreshEnough(snapshot, before);
  return {snapshot, locations, fingerprint, restoredAt: floor};
}
