import {readFile, rename, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readAgentRows, shapePoints, maxCsvSize} from './agent-data.mjs';
import {assertFreshEnough, schemaVersion, validateSnapshot} from '../source.js';
import {writeLocationReview} from './locations-admin.mjs';
import {build} from '../build.mjs';

const source = 'https://docs.google.com/spreadsheets/d/1NPBnTgakkfiaa31ZznAg-iPw1e5Fi94Mu27IT8X_O-w/export?format=csv&gid=1532730449';
const output = new URL('../demand.json', import.meta.url);
const temporary = new URL(`../.demand.${process.pid}.tmp`, import.meta.url);

async function loadInput(file) {
  if (file) return readFile(resolve(file));
  const result = await fetch(source, {signal: AbortSignal.timeout(20000)});
  if (!result.ok || !/^text\/csv\b/i.test(result.headers.get('content-type') ?? '')) {
    throw new Error('Не удалось читать вкладку «Потребность точки». Скачайте CSV этой вкладки в Google Sheets и передайте путь к файлу.');
  }
  return result.arrayBuffer();
}

export function generateDemand(csv, now = new Date(), snapshotId = '') {
  return validateSnapshot({schema: schemaVersion, publishedAt: now.toISOString(),
    ...(snapshotId ? {snapshotId} : {}), ...shapePoints(readAgentRows(csv))});
}

async function publishLocal() {
  const [file, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Укажите только путь к CSV или запустите команду без аргументов.');
  const input = await loadInput(file);
  if (input.byteLength > maxCsvSize) throw new Error('Размер CSV превышает 5 МБ.');
  let csv;
  try { csv = new TextDecoder('utf-8', {fatal: true}).decode(input); }
  catch { csv = new TextDecoder('windows-1251').decode(input); }
  const snapshot = generateDemand(csv);
  const previous = await readFile(output, 'utf8').then(JSON.parse).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  assertFreshEnough(snapshot, previous);
  await writeFile(temporary, JSON.stringify(snapshot));
  await rename(temporary, output);
  const locations = await writeLocationReview(snapshot.points);
  await build();
  const roles = snapshot.points.flatMap(point => point.roles);
  console.log(`HRM ${snapshot.sourceDate} · ${snapshot.points.length} ТТ · недобор ${roles.reduce((total, role) => total + role.need, 0)} · ${roles.filter(role => role.superFocus).length} ролей в суперфокусе`);
  console.log(`Подтверждено координат: ${locations.mapped}. Очередь проверки: ${locations.unresolved} (.data/locations-review.csv).`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await publishLocal(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
