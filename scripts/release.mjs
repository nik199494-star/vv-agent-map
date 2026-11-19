import {createSign} from 'node:crypto';
import {attachLocations, matchesAddress, isPosition} from '../locations.js';
import {dateKey} from '../source.js';
import {generateDemand} from './publish-demand.mjs';
import {project, sha256} from './projection.mjs';

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
