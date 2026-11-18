import {mkdir, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {assets} from '../build.mjs';
import {sha256} from './projection.mjs';

const site = 'https://nik199494-star.github.io/vv-agent-map/';
const optional = new Set(['.nojekyll', 'publication.json']);
const names = [...assets, 'publication.json'];

async function readPublished(name, fetcher) {
  const response = await fetcher(new URL(name, site), {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404 && optional.has(name)) return null;
  if (!response.ok) throw Error('Pages вернул HTTP ' + response.status + ' для ' + name + '.');
  return Buffer.from(await response.arrayBuffer());
}

const digest = bytes => bytes === null ? null : sha256(bytes);

export async function verifyPagesBaseline(manifest, fetcher = fetch) {
  if (Object.keys(manifest).length !== names.length || names.some(name => !Object.hasOwn(manifest, name))) {
    throw Error('Манифест предыдущего выпуска неполный.');
  }
  await Promise.all(names.map(async name => {
    if (digest(await readPublished(name, fetcher)) !== manifest[name]) {
      throw Error('Публичный файл не совпадает с предыдущим выпуском: ' + name + '.');
    }
  }));
}

export async function capturePagesBaseline(fetcher = fetch) {
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await readPublished(name, fetcher)])));
  const manifest = Object.fromEntries(names.map(name => [name, digest(files[name])]));
  if (files['publication.json']) {
    const receipt = JSON.parse(files['publication.json'].toString('utf8'));
    if (receipt.demand !== manifest['demand.json'] || receipt.locations !== manifest['coordinates.json']) {
      throw Error('Текущие данные Pages не совпадают с квитанцией выпуска.');
    }
  }
  await verifyPagesBaseline(manifest, fetcher);
  return {files, manifest};
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = new URL('../.data/pages-baseline/', import.meta.url);
  try {
    const {files, manifest} = await capturePagesBaseline();
    const folder = new URL(new Date().toISOString().replaceAll(':', '-') + '/', root);
    await mkdir(folder, {recursive: true});
    await Promise.all(Object.entries(files).flatMap(([name, bytes]) =>
      bytes === null ? [] : [writeFile(new URL(name, folder), bytes, {flag: 'wx'})]));
    await writeFile(new URL('baseline-manifest.json', folder), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
    console.log('Предыдущий выпуск сохранён локально вместе с манифестом.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
