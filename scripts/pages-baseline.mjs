import {lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {resolve, join, dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {assets} from '../build.mjs';
import {sha256} from './projection.mjs';
import {isLocationDictionary, readRollbackNotice, releaseFiles, snapshotIdPattern, validatePublicationReceipt, validateRollbackReceipt} from '../rollback.js';
import {assertFreshEnough, validateSnapshot} from '../source.js';

const site = 'https://nik199494-star.github.io/vv-agent-map/';
const optional = new Set(['.nojekyll', 'publication.json', 'rollback.json', 'rollback.js', 'release-cache.js']);
const names = assets;
export const releaseClientFiles = ['app.js', 'index.html', 'model.js', 'styles.css'];
const hash = /^[a-f0-9]{64}$/;
const transientCodes = new Set([
  'AbortError', 'TimeoutError', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

function describeTransport(error) {
  const nested = error?.cause?.errors;
  const causes = [error, error?.cause, ...(Array.isArray(nested) ? nested : [])].filter(Boolean);
  const codes = [...new Set(causes.flatMap(cause => [cause.code, cause.name])
    .filter(value => typeof value === 'string' && (/^[A-Z][A-Z0-9_]+$/.test(value) || transientCodes.has(value))))];
  return {codes, retry: codes.some(code => transientCodes.has(code))};
}

async function readPublished(name, fetcher, wait) {
  const label = name || '/';
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetcher(new URL(name, site), {
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(60_000),
      });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      const {codes, retry} = describeTransport(error);
      if (!retry || attempt === 2) {
        throw Error('Сетевая ошибка Pages для ' + label + (codes.length ? ' (' + codes.join(', ') + ')' : '') + '.');
      }
      await wait(250 * 2 ** attempt);
      continue;
    }
    if (response.status === 404 && optional.has(name)) return null;
    if (response.status !== 503 || attempt === 2) throw Error('Pages вернул HTTP ' + response.status + ' для ' + label + '.');
    const seconds = Number(response.headers.get('retry-after'));
    await wait(Math.min(5000, seconds > 0 ? seconds * 1000 : 250 * 2 ** attempt));
  }
}

const digest = bytes => bytes === null ? null : sha256(bytes);

async function readPublicFiles(fetcher, wait) {
  const entries = [];
  for (let i = 0; i < names.length; i += 4) {
    entries.push(...await Promise.all(names.slice(i, i + 4).map(async name => [name, await readPublished(name, fetcher, wait)])));
  }
  const files = Object.fromEntries(entries);
  const root = await readPublished('', fetcher, wait);
  if (!root.equals(files['index.html'])) throw Error('Главная страница Pages отличается от index.html.');
  return files;
}

function assertManifest(manifest) {
  if (!manifest || Object.keys(manifest).length !== names.length ||
      names.some(name => !Object.hasOwn(manifest, name) || !(hash.test(manifest[name] ?? '') ||
        (manifest[name] === null && optional.has(name))))) {
    throw Error('Манифест предыдущего выпуска неполный.');
  }
}

function verifyFiles(files, manifest) {
  assertManifest(manifest);
  for (const name of names) {
    if (!Object.hasOwn(files, name) || digest(files[name]) !== manifest[name]) {
      throw Error('Публичный файл не совпадает с предыдущим выпуском: ' + name + '.');
    }
  }
}

export async function verifyPagesBaseline(manifest, fetcher = fetch, wait = delay) {
  assertManifest(manifest);
  const files = await readPublicFiles(fetcher, wait);
  verifyFiles(files, manifest);
  assertReleaseFiles(files, manifest);
}

const toJson = bytes => JSON.parse(bytes.toString('utf8'));
const fromJson = value => Buffer.from(JSON.stringify(value) + '\n');

function assertReleaseFiles(files, manifest, now = Date.now()) {
  const snapshot = validateSnapshot(toJson(files['demand.json']));
  const protectedClient = files['app.js'].toString('utf8').includes('./rollback.js');
  if (protectedClient && (!files['rollback.js'] || !files['release-cache.js'] || !files['publication.json'] || !files['rollback.json'])) {
    throw Error('В выпуске отсутствует модуль или квитанция отката или выпуска.');
  }
  for (const name of [releaseFiles.locations, releaseFiles.cities]) {
    if (!isLocationDictionary(toJson(files[name]))) throw Error('Некорректный справочник: ' + name + '.');
  }
  if (files['publication.json']) {
    const receipt = validatePublicationReceipt(toJson(files['publication.json']));
    if (Object.entries(releaseFiles).some(([key, name]) => receipt[key] !== manifest[name])) {
      throw Error('Данные не совпадают с квитанцией выпуска.');
    }
  }
  const rollback = files['rollback.json'] ? readRollbackNotice(toJson(files['rollback.json']), now) : null;
  const published = Date.parse(snapshot.publishedAt);
  if (rollback && (snapshot.snapshotId === rollback.failedSnapshotId ||
      (published <= Date.parse(rollback.restoredAt) &&
       (published >= Date.parse(rollback.failedPublishedAt) ||
        Object.values(releaseFiles).some(name => rollback.hashes[name] !== manifest[name]))))) {
    throw Error('Данные не совпадают с квитанцией отката.');
  }
  return {snapshot, rollback, protectedClient};
}

export async function capturePagesBaseline(fetcher = fetch, wait = delay) {
  const files = await readPublicFiles(fetcher, wait);
  const manifest = Object.fromEntries(names.map(name => [name, digest(files[name])]));
  assertReleaseFiles(files, manifest);
  await verifyPagesBaseline(manifest, fetcher, wait);
  return {files, manifest};
}

export async function readStoredBaseline(folder, now = Date.now()) {
  const manifest = JSON.parse(await readFile(join(folder, 'baseline-manifest.json'), 'utf8'));
  assertManifest(manifest);
  const expected = new Set(['baseline-manifest.json', ...names.filter(name => manifest[name] !== null)]);
  const entries = await readdir(folder);
  if (entries.length !== expected.size || entries.some(name => !expected.has(name))) {
    throw Error('Состав архива не совпадает с манифестом.');
  }
  const files = Object.fromEntries(await Promise.all(names.map(async name => {
    try { return [name, await readFile(join(folder, name))]; }
    catch (error) {
      if (error.code === 'ENOENT' && manifest[name] === null) return [name, null];
      throw error;
    }
  })));
  verifyFiles(files, manifest);
  return {files, manifest, ...assertReleaseFiles(files, manifest, now)};
}

export async function savePagesBaseline(folder, fetcher = fetch, wait = delay) {
  await writeVerifiedBackup(folder, await capturePagesBaseline(fetcher, wait));
}

async function writeVerifiedBackup(folder, {files, manifest}, now = Date.now()) {
  verifyFiles(files, manifest);
  const target = resolve(folder);
  const parent = dirname(target);
  try {
    await lstat(target);
    throw Error('Папка выпуска уже существует.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(parent, {recursive: true});
  const staging = await mkdtemp(join(parent, '.incomplete-'));
  if (dirname(staging) !== parent) throw Error('Временный архив находится вне указанной папки.');
  try {
    for (const [name, bytes] of Object.entries(files)) {
      if (bytes !== null) await writeFile(join(staging, name), bytes, {flag: 'wx'});
    }
    await writeFile(join(staging, 'baseline-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
    await readStoredBaseline(staging, now);
    await rename(staging, target);
  } finally {
    await rm(staging, {recursive: true, force: true});
  }
}

export function createRollbackReceipt(manifest, failed, now = new Date()) {
  assertManifest(manifest);
  return validateRollbackReceipt({
    schema: 1, failedSnapshotId: failed.snapshotId, failedPublishedAt: failed.publishedAt, restoredAt: now.toISOString(),
    hashes: Object.fromEntries(Object.values(releaseFiles).map(name => [name, manifest[name]])),
  }, now.getTime());
}

export async function prepareRollback(archive, failedFile, folder, now = new Date()) {
  const {files, manifest, snapshot: target, protectedClient} = await readStoredBaseline(archive, now.getTime());
  const failed = validateSnapshot(toJson(await readFile(failedFile)));
  if (!protectedClient) {
    throw Error('Предыдущий выпуск должен поддерживать откат из прогретого кеша.');
  }
  if (failed.snapshotId === target.snapshotId || Date.parse(target.publishedAt) >= Date.parse(failed.publishedAt)) {
    throw Error('Нужен отдельный отменяемый выпуск новее резервной копии.');
  }
  files['rollback.json'] = fromJson(createRollbackReceipt(manifest, failed, now));
  manifest['rollback.json'] = sha256(files['rollback.json']);
  assertReleaseFiles(files, manifest, now.getTime());
  await writeVerifiedBackup(folder, {files, manifest}, now.getTime());
}

export async function prepareRelease(archive, demandFile, coordinatesFile, folder, now = new Date(), clientFolder) {
  const {files, manifest, snapshot: previous, rollback, protectedClient} = await readStoredBaseline(archive, now.getTime());
  if (!protectedClient) throw Error('Сначала сохраните выпуск с поддержкой отката.');

  const demand = await readFile(demandFile);
  const snapshot = validateSnapshot(toJson(demand));
  assertFreshEnough(snapshot, previous);
  const published = Date.parse(snapshot.publishedAt);
  const after = Math.max(Date.parse(previous.publishedAt), rollback ? Date.parse(rollback.restoredAt) : 0);
  if (!snapshotIdPattern.test(snapshot.snapshotId ?? '') || snapshot.snapshotId === previous.snapshotId ||
      snapshot.snapshotId === rollback?.failedSnapshotId || published <= after || published > now.getTime()) {
    throw Error('Нужен новый ID и корректное время публикации после предыдущего выпуска или отката.');
  }
  files[releaseFiles.demand] = demand;
  files[releaseFiles.locations] = await readFile(coordinatesFile);
  if (clientFolder) {
    for (const name of releaseClientFiles) {
      files[name] = await readFile(join(clientFolder, name));
      manifest[name] = sha256(files[name]);
    }
  }
  for (const name of Object.values(releaseFiles)) manifest[name] = sha256(files[name]);
  files['publication.json'] = fromJson({schema: 1,
    ...Object.fromEntries(Object.entries(releaseFiles).map(([key, name]) => [key, manifest[name]]))});
  manifest['publication.json'] = sha256(files['publication.json']);
  if (!assertReleaseFiles(files, manifest, now.getTime()).protectedClient) {
    throw Error('Новый клиент должен поддерживать откат из прогретого кеша.');
  }
  await writeVerifiedBackup(folder, {files, manifest}, now.getTime());
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [command = 'capture', ...args] = process.argv.slice(2);
    if (command === 'capture' && args.length <= 1) {
      const folder = args[0] ?? join('.data', 'pages-baseline', new Date().toISOString().replaceAll(':', '-'));
      await savePagesBaseline(folder);
      console.log('Предыдущий выпуск сохранён локально вместе с манифестом.');
    } else if (command === 'verify' && args.length === 1) {
      await verifyPagesBaseline(JSON.parse(await readFile(args[0], 'utf8')));
      console.log('Все файлы Pages совпали с манифестом.');
    } else if (command === 'verify-local' && args.length === 1) {
      const {manifest, protectedClient} = await readStoredBaseline(args[0]);
      console.log(JSON.stringify({files: Object.values(manifest).filter(Boolean).length,
        absent: Object.keys(manifest).filter(name => manifest[name] === null), protectedClient}));
    } else if (command === 'restore' && args.length === 3) {
      await prepareRollback(...args);
      console.log('Пакет восстановления проверен и сохранён локально.');
    } else if (command === 'stage' && args.length === 4) {
      await prepareRelease(...args);
      console.log('Пакет нового выпуска проверен и сохранён локально.');
    } else throw Error('Команды: capture [папка], verify манифест, verify-local архив, stage архив demand.json coordinates.json папка, restore архив отменяемый-demand.json папка.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
