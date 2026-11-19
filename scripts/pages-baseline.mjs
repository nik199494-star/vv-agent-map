import {lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {resolve, join, dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {assets} from '../build.mjs';
import {sha256} from './projection.mjs';
import {validateRollbackReceipt} from '../rollback.js';
import {validateSnapshot} from '../source.js';

const site = 'https://nik199494-star.github.io/vv-agent-map/';
const optional = new Set(['.nojekyll', 'publication.json', 'rollback.json', 'rollback.js']);
const names = [...assets, 'publication.json', 'rollback.json'];
const hash = /^[a-f0-9]{64}$/;

async function readPublished(name, fetcher, wait) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetcher(new URL(name, site), {
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404 && optional.has(name)) return null;
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    if (response.status !== 503 || attempt === 2) throw Error('Pages вернул HTTP ' + response.status + ' для ' + name + '.');
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
  return Object.fromEntries(entries);
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
  verifyFiles(await readPublicFiles(fetcher, wait), manifest);
}

export async function capturePagesBaseline(fetcher = fetch, wait = delay) {
  const files = await readPublicFiles(fetcher, wait);
  const manifest = Object.fromEntries(names.map(name => [name, digest(files[name])]));
  if (files['app.js'].toString('utf8').includes('./rollback.js') && !files['rollback.js']) {
    throw Error('В публичном выпуске отсутствует модуль отката.');
  }
  if (files['publication.json']) {
    const receipt = JSON.parse(files['publication.json'].toString('utf8'));
    if (receipt.demand !== manifest['demand.json'] || receipt.locations !== manifest['coordinates.json']) {
      throw Error('Текущие данные Pages не совпадают с квитанцией выпуска.');
    }
  }
  await verifyPagesBaseline(manifest, fetcher, wait);
  return {files, manifest};
}

export async function readStoredBaseline(folder) {
  const manifest = JSON.parse(await readFile(join(folder, 'baseline-manifest.json'), 'utf8'));
  assertManifest(manifest);
  const files = Object.fromEntries(await Promise.all(names.map(async name => {
    try { return [name, await readFile(join(folder, name))]; }
    catch (error) {
      if (error.code === 'ENOENT' && manifest[name] === null) return [name, null];
      throw error;
    }
  })));
  verifyFiles(files, manifest);
  return {files, manifest};
}

export async function savePagesBaseline(folder, fetcher = fetch, wait = delay) {
  await writeVerifiedBackup(folder, await capturePagesBaseline(fetcher, wait));
}

async function writeVerifiedBackup(folder, {files, manifest}) {
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
    await readStoredBaseline(staging);
    await rename(staging, target);
  } finally {
    await rm(staging, {recursive: true, force: true});
  }
}

export function createRollbackReceipt(manifest, failed, now = new Date()) {
  assertManifest(manifest);
  return validateRollbackReceipt({
    schema: 1, failedSnapshotId: failed.snapshotId, failedPublishedAt: failed.publishedAt, restoredAt: now.toISOString(),
    hashes: Object.fromEntries(['demand.json', 'coordinates.json', 'ru-city-centers.json'].map(name => [name, manifest[name]])),
  }, now.getTime());
}

export async function prepareRollback(archive, failedFile, folder, now = new Date()) {
  const {files, manifest} = await readStoredBaseline(archive);
  const failed = validateSnapshot(JSON.parse(await readFile(failedFile, 'utf8')));
  const target = validateSnapshot(JSON.parse(files['demand.json'].toString('utf8')));
  if (!files['rollback.js'] || !files['app.js'].toString('utf8').includes('./rollback.js')) {
    throw Error('Предыдущий выпуск должен поддерживать откат из прогретого кеша.');
  }
  if (failed.snapshotId === target.snapshotId || Date.parse(target.publishedAt) >= Date.parse(failed.publishedAt)) {
    throw Error('Нужен отдельный отменяемый выпуск новее резервной копии.');
  }
  files['rollback.json'] = Buffer.from(JSON.stringify(createRollbackReceipt(manifest, failed, now)));
  manifest['rollback.json'] = sha256(files['rollback.json']);
  await writeVerifiedBackup(folder, {files, manifest});
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
    } else if (command === 'restore' && args.length === 3) {
      await prepareRollback(...args);
      console.log('Пакет восстановления проверен и сохранён локально.');
    } else throw Error('Команды: capture [папка], verify манифест, restore архив отменяемый-demand.json папка.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
