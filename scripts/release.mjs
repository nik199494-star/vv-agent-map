import {createSign} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {build} from '../build.mjs';
import {attachLocations, matchesAddress, isPosition} from '../locations.js';
import {dateKey, validateSnapshot} from '../source.js';
import {generateDemand} from './publish-demand.mjs';
import {project, sha256} from './projection.mjs';

export const publicSite = 'https://nik199494-star.github.io/vv-agent-map/';
const agentWorkbook = '1NPBnTgakkfiaa31ZznAg-iPw1e5Fi94Mu27IT8X_O-w';
const oauth = 'https://oauth2.googleapis.com/token';
const secretPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[0-9a-z]{20,}|github_pat_[0-9a-z_]{20,}|AIza[0-9A-Za-z_-]{30,})\b|[\w.+-]+@[\w.-]+\.[a-zа-я]{2,}|(?:\+7|\b8)[\s.(\-]*\d{3}[\s.)\-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}\b/iu;
const hash = /^[a-f0-9]{64}$/u;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const count = value => Number.isSafeInteger(value) && value >= 0;
const toCsv = rows => rows.map(row => row.map(value => '"' + String(value ?? '').replaceAll('"', '""') + '"').join(',')).join('\n');

export function metrics(points) {
  const roles = points.flatMap(point => point.roles);
  return {points: points.length, roles: roles.length, deficit: roles.reduce((sum, role) => sum + role.need, 0)};
}

function sameMetrics(left, right) {
  return ['points', 'roles', 'deficit'].every(key => left[key] === right[key]);
}

export function validateHandoff(value) {
  if (!value || !/^[a-z0-9-]{12,80}$/iu.test(value.id ?? '') || !dateKey(value.sourceDate) ||
      !timestamp(value.acceptedAt) || !timestamp(value.requestedAt) || Date.parse(value.requestedAt) < Date.parse(value.acceptedAt) ||
      !hash.test(value.digest ?? '') ||
      !value.metrics || !['points', 'roles', 'deficit'].every(key => count(value.metrics[key])) ||
      !Array.isArray(value.geo) || value.geo.length > 3990) throw Error('Некорректный паспорт снимка.');
  return value;
}

export function fence(handoff, previous, receipt) {
  const date = dateKey(handoff.sourceDate);
  if (date < dateKey(previous.sourceDate)) throw Error('Дата HRM старше опубликованной.');
  if (!receipt || receipt.id === 'legacy-baseline') return;
  const delta = Date.parse(handoff.acceptedAt) - Date.parse(receipt.acceptedAt);
  if (delta < 0 || delta === 0 && handoff.id !== receipt.id) throw Error('Снимок старше опубликованного или не совпадает с ним.');
  if (delta === 0 && receipt.requestedAt && Date.parse(handoff.requestedAt) < Date.parse(receipt.requestedAt)) {
    throw Error('Запрос старше опубликованного выпуска этого снимка.');
  }
}

function safeSource(url) {
  try {
    const value = new URL(url);
    return value.protocol === 'https:' && !value.username && !value.password &&
      ['vkusvill.ru', 'www.openstreetmap.org', 'openstreetmap.org', 'yandex.ru', '2gis.ru'].includes(value.hostname) &&
      !secretPattern.test(value.href) && [...value.searchParams.keys()].every(key => key === 'shop_id');
  } catch { return false; }
}

export function assemble(handoff, pointRows, cityRows, index, previous, receipt, now = new Date(), reviewedIndex = {}) {
  validateHandoff(handoff);
  fence(handoff, previous, receipt);
  const pointView = project(pointRows, 'agent');
  const cityView = project(cityRows, 'cities');
  if (pointView.date !== handoff.sourceDate || cityView.date !== pointView.date ||
    !sameMetrics(handoff.metrics, pointView) || cityView.cities !== pointView.cities ||
    sha256(pointView.signature) !== handoff.digest) throw Error('Витрины не совпали с принятым снимком и срезом городов.');

  for (const row of pointRows.slice(4)) {
    if (row.some(cell => /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[0-9a-z]{20,}|github_pat_[0-9a-z_]{20,}|AIza[0-9A-Za-z_-]{30,})\b/iu.test(cell))) {
      throw Error('Во входной витрине обнаружен секрет.');
    }
  }

  const snapshot = generateDemand(toCsv(pointRows), now, handoff.id);
  if (!sameMetrics(metrics(snapshot.points), handoff.metrics)) throw Error('Публичная проекция изменила количество ролей, точек или итог недобора.');
  if (secretPattern.test(JSON.stringify(snapshot))) throw Error('В публичном снимке обнаружены контакты или секрет.');

  const active = new Map(snapshot.points.map(point => [point.id, point]));
  const coordinates = {...index};
  for (const point of active.values()) {
    const known = coordinates[point.id], reviewed = reviewedIndex[point.id];
    if (!isPosition(known?.xy) && known?.reason !== 'changed' && isPosition(reviewed?.xy) &&
        matchesAddress(point, reviewed)) coordinates[point.id] = reviewed;
  }
  const reviewed = new Set();
  for (const row of handoff.geo) {
    const {id, city, address, xy, checkedOn, source, status} = row;
    const point = active.get(id);
    if (!point || reviewed.has(id) || !matchesAddress(point, {city, address})) throw Error('Геоконтроль не совпал с активным адресом ТТ.');
    if (status === 'pending') coordinates[id] = {city, address, reason: 'changed'};
    else if (status === 'confirmed' && isPosition(xy) && safeSource(source) && /^\d{4}-\d{2}-\d{2}$/.test(checkedOn)) {
      coordinates[id] = {city, address, xy, sources: [source], checkedOn};
    } else throw Error('Неподтверждённая или некорректная запись геоконтроля.');
    reviewed.add(id);
  }
  for (const point of active.values()) {
    const known = coordinates[point.id];
    if (point.addressConflict || isPosition(known?.xy) && !matchesAddress(point, known)) {
      throw Error('Геоконфликт ТТ ' + point.id + '. Проверьте изменившийся адрес.');
    }
  }
  if (secretPattern.test(JSON.stringify(coordinates))) throw Error('В координатах обнаружены чувствительные данные.');
  const mapped = attachLocations(snapshot.points, coordinates).filter(point => point.location.xy).length;
  return {snapshot, coordinates, totals: {...handoff.metrics, mapped}};
}

async function request(url, options = {}, fetcher = fetch) {
  return fetcher(url, {redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(25_000), ...options});
}

export async function accessToken(key, fetcher = fetch) {
  if (!key?.client_email || !key.private_key) throw Error('Отсутствует ключ читателя агентской книги.');
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const data = encode({alg: 'RS256', typ: 'JWT'}) + '.' + encode({
    iss: key.client_email, aud: oauth, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', iat, exp: iat + 300,
  });
  const assertion = data + '.' + createSign('RSA-SHA256').update(data).sign(key.private_key, 'base64url');
  const result = await request(oauth, {method: 'POST', body: new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion,
  })}, fetcher);
  if (!result.ok) throw Error('Google OAuth вернул HTTP ' + result.status + '.');
  return (await result.json()).access_token;
}

export const agentRanges = ["'Потребность точки'!A:P", "'Потребность города'!A:M"];

export async function readSheetValues(workbook, ranges, token, fetcher = fetch) {
  if (!/^[A-Za-z0-9_-]{30,100}$/u.test(workbook)) throw Error('Некорректный идентификатор агентской книги.');
  const params = new URLSearchParams({valueRenderOption: 'FORMATTED_VALUE'});
  for (const range of ranges) params.append('ranges', range);
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + workbook + '/values:batchGet?' + params;
  const result = await request(url, {headers: {authorization: 'Bearer ' + token}}, fetcher);
  if (!result.ok) throw Error('Агентская книга вернула HTTP ' + result.status + '.');
  const {valueRanges} = await result.json();
  if (valueRanges?.length !== ranges.length || valueRanges.some(range => !Array.isArray(range.values))) throw Error('В Google Sheets отсутствует одна из запрошенных витрин.');
  if (valueRanges.some(range => range.values.length >= 5000)) throw Error('Для размера витрины нужна настройка диапазона чтения.');
  return valueRanges.map(range => range.values);
}

export const readAgentViews = (token, fetcher = fetch) => readSheetValues(agentWorkbook, agentRanges, token, fetcher);

const assetPath = (directory, name) => new URL(name, new URL('../' + directory + '/', import.meta.url));
const file = async (directory, name) => JSON.parse(await readFile(assetPath(directory, name), 'utf8'));

async function liveAsset(name, optional = false, fetcher = fetch) {
  const result = await request(new URL(name + '?vv-check=' + Date.now(), publicSite), {}, fetcher);
  if (optional && result.status === 404) return null;
  if (!result.ok) throw Error('GitHub Pages вернул HTTP ' + result.status + ' для ' + name + '.');
  return result.text();
}

async function writeRelease(directory, snapshot, coordinates, handoff) {
  await build(assetPath(directory, ''));
  const demand = JSON.stringify(snapshot);
  const locations = JSON.stringify(coordinates);
  const receipt = {...handoff, demand: sha256(demand), locations: sha256(locations)};
  await Promise.all([
    writeFile(assetPath(directory, 'demand.json'), demand),
    writeFile(assetPath(directory, 'coordinates.json'), locations),
    writeFile(assetPath(directory, 'publication.json'), JSON.stringify(receipt)),
  ]);
  return receipt;
}

export async function verifyRelease(expected, fetcher = fetch) {
  const [receiptText, demand, coords, html, app] = await Promise.all([
    liveAsset('publication.json', false, fetcher), liveAsset('demand.json', false, fetcher), liveAsset('coordinates.json', false, fetcher),
    liveAsset('index.html', false, fetcher), liveAsset('app.js', false, fetcher),
  ]);
  const publicReceipt = JSON.parse(receiptText);
  if (publicReceipt.id !== expected.id || publicReceipt.digest !== expected.digest ||
      sha256(demand) !== expected.demand || sha256(coords) !== expected.locations ||
      !html.includes('candidate-search') || !app.includes('nearbyPoints')) throw Error('Публичная карта ещё не соответствует ожидаемой версии.');
  validateSnapshot(JSON.parse(demand));
}

async function plan() {
  await mkdir(assetPath('.data', ''), {recursive: true});
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const input = validateHandoff(JSON.parse(event.inputs?.handoff ?? 'null'));
  const previous = validateSnapshot(JSON.parse(await liveAsset('demand.json')));
  const previousCoordinates = JSON.parse(await liveAsset('coordinates.json'));
  const reviewedIndex = JSON.parse(await readFile(new URL('../coordinates.json', import.meta.url), 'utf8'));
  const receipt = JSON.parse(await liveAsset('publication.json', true));
  if (receipt) {
    if (receipt.id !== previous.snapshotId || receipt.demand !== sha256(JSON.stringify(previous)) ||
        receipt.locations !== sha256(JSON.stringify(previousCoordinates))) throw Error('Опубликованные файлы ещё не согласованы.');
  }
  fence(input, previous, receipt);
  const token = await accessToken(JSON.parse(process.env.VV_AGENT_READER ?? 'null'));
  let result, issue;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const [points, cities] = await readAgentViews(token);
      result = assemble(input, points, cities, previousCoordinates, previous, receipt, new Date(), reviewedIndex);
      break;
    } catch (error) { issue = error; }
    if (attempt < 7) await delay(15_000);
  }
  if (!result) throw issue;
  const {id, acceptedAt, requestedAt, sourceDate, digest} = input;
  const same = receipt?.id === id && receipt.digest === digest && receipt.locations === sha256(JSON.stringify(result.coordinates));
  const next = same ? receipt : await writeRelease('.data/next', result.snapshot, result.coordinates, {id, acceptedAt, requestedAt, sourceDate, digest, metrics: result.totals});
  if (!same) {
    const restored = {...previous, snapshotId: previous.snapshotId ?? 'legacy-baseline', rollbackOf: id,
      publishedAt: new Date().toISOString()};
    await writeRelease('.data/previous', restored, previousCoordinates, receipt ??
      {id: 'legacy-baseline', acceptedAt: previous.publishedAt, sourceDate: previous.sourceDate, digest: sha256(JSON.stringify(previous)), metrics: metrics(previous.points)});
  }
  await writeFile(assetPath('.data', 'next.json'), JSON.stringify(next));
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, 'changed=' + !same + '\n', {flag: 'a'});
  console.log('Снимок проверен. ТТ ' + result.totals.points + ', на карте ' + result.totals.mapped + ', позиций ' + result.totals.roles + '.');
}

async function verify(directory) {
  const expected = await file(directory, directory === '.data' ? 'next.json' : 'publication.json');
  let issue;
  for (let attempt = 0; attempt < 10; attempt++) {
    try { await verifyRelease(expected); return; } catch (error) { issue = error; }
    if (attempt < 9) await delay(15_000);
  }
  throw issue;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const mode = process.argv[2];
    if (mode === 'plan') await plan();
    else if (mode === 'verify') await verify('.data');
    else if (mode === 'verify-rollback') await verify('.data/previous');
    else throw Error('Выберите plan, verify или verify-rollback.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
