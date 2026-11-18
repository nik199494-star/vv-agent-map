import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {attachLocations, isPosition, locationReasons, matchesAddress} from '../locations.js';

const indexPath = new URL('../coordinates.json', import.meta.url);
const dataDir = new URL('../.data/', import.meta.url);
const catalogUrl = 'https://vkusvill.ru/shops/';

function town(value) {
  return value.toLowerCase().replaceAll('ё', 'е').trim().replace(/^(?:город|г[.]?|рабочий поселок|р[.]?п[.]?|пгт[.]?|пос[.]?|п[.]?|поселок|с[.]?|село|д[.]?|деревня)\s+/u, '');
}

function address(value, city) {
  const name = town(city);
  const repeatedCity = new RegExp('^(?:(?:г|город|рп|пгт|п|пос|поселок|деревня|д|село)(?:[.] *| +))?' +
    name.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&') + '(?:[ ,]+|$)', 'u');
  let cleaned = value.toLowerCase().replace(/&nbsp;|&#160;|&#xa0;/giu, ' ').replaceAll('ё', 'е')
    .replace(/[\u2010-\u2014]/g, '-').replace(/\s+/g, ' ').trim()
    .replace(/^даркстор(?:\s+вкусвилл)?[ ,]+/u, '').replace(/^≈\s*/u, '');
  while (repeatedCity.test(cleaned)) cleaned = cleaned.replace(repeatedCity, '');
  const house = /(?:^|[ ,])(?:д[.]?|дом|вл[.]?|влад[.]?|владение|стр[.]?|строение|к[.]?|корп[.]?|корпус)\s*№?\s*([0-9].*)$/u.exec(cleaned)
    ?? /[,]\s*([0-9].*)$/u.exec(cleaned);
  if (!house) return null;
  const street = cleaned.slice(0, house.index).replace(/[^а-я0-9-]+/g, ' ').trim()
    .replace(/\b(\d+)-(?:й|я|ый|ая)(?= |$)/gu, '$1').replace(/(?:^| )им[.]? /gu, ' имени ')
    .replace(/(?:^| )(?:улица|ул|проспект|пр-кт|пр-т|просп|проезд|пр-д|пр|переулок|пер|бул|б-р|бульвар|аллея|ал|шоссе|ш|набережная|наб|площадь|пл|линия|мкр|микрорайон)(?= |$)/gu, ' ')
    .replace(/\s+/g, ' ').trim();
  const prefix = /(?:^|[ ,])(?:стр[.]?|строение)\s*№?\s*$/u.test(house[0].slice(0, -house[1].length)) ? 'с'
    : /(?:^|[ ,])(?:к[.]?|корп[.]?|корпус)\s*№?\s*$/u.test(house[0].slice(0, -house[1].length)) ? 'к' : '';
  const numbers = prefix + house[1].replace(/(?:корпус|корп|к)[.]?\s*(?=\d)/gu, 'к')
    .replace(/(?:строение|стр)[.]?\s*(?=\d)/gu, 'с')
    .replace(/(?:литера|литер|лит)[.]?\s*(?=[а-я])/gu, 'лит')
    .replace(/[ ,№.]/g, '').replace(/[abcehkmoptxy]/g, char => 'авсенкмортху'['abcehkmoptxy'.indexOf(char)]);
  return /^[ск]?\d[а-я\d/-]*$/u.test(numbers) ? {street, house: numbers} : null;
}

export function readCatalog(html, source) {
  const payload = /\bshopListItems\s*=\s*(\{[^\r\n]*?\});\s*shop_points\b/u.exec(html)?.[1];
  if (!payload) throw new Error('В сохранённой странице нет данных официальной карты магазинов.');
  return Object.values(JSON.parse(payload)).filter(row => /^[0-9]+$/u.test(String(row.NOMER_TT)) &&
    typeof row.CITY === 'string' && typeof row.ADDRESS === 'string' && row.LAT && row.LON)
    .map(row => ({id: String(row.NOMER_TT), city: row.CITY, address: row.ADDRESS, xy: [Number(row.LAT), Number(row.LON)],
      source: source + '?shop_id=' + encodeURIComponent(row.ID)}))
    .filter(row => isPosition(row.xy));
}

export function confirmCatalogPoint(point, rows) {
  const base = {city: point.city, address: point.address};
  if (point.addressConflict) return {...base, reason: 'conflict'};
  if (!rows?.length) return {...base, reason: 'missing'};
  const expected = address(point.address, point.city);
  if (!expected) return {...base, reason: 'incomplete'};
  const matched = rows.filter(row => {
    const full = address(row.address, row.city);
    return town(row.city) === town(point.city) && full && expected.street === full.street
      && (expected.house === full.house || new RegExp('^' + expected.house + '(?:к\\d|с\\d|лит[а-я])', 'u').test(full.house));
  });
  if (!matched.length) return {...base, reason: 'different'};
  if (matched.some(row => row.xy.some((value, index) => Math.abs(value - matched[0].xy[index]) > 0.00015))) return {...base, reason: 'ambiguous'};
  return {...base, xy: matched[0].xy, sources: [matched[0].source], checkedOn: new Date().toISOString().slice(0, 10)};
}

export async function writeLocationReview(points, index = null) {
  const locations = index ?? JSON.parse(await readFile(indexPath, 'utf8'));
  const review = attachLocations(points, locations).filter(point => !point.location.xy);
  const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
  const reasons = Object.create(null);
  const csv = [['ID ТТ', 'Город', 'Адрес', 'Причина'], ...review.map(point => {
    const reason = point.location.reason;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    return [point.id, point.city, point.address, locationReasons[reason] ?? locationReasons.pending];
  })].map(row => row.map(quote).join(';')).join('\r\n');
  await mkdir(dataDir, {recursive: true});
  await writeFile(new URL('locations-review.csv', dataDir), '\uFEFF' + csv + '\r\n');
  return {mapped: points.length - review.length, unresolved: review.length, reasons};
}

export async function prepareLocations(points, files) {
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const catalog = [];
  for (const file of files) {
    const region = /[\\/]?(?:vv-shops)-([a-z]+)\.html$/u.exec(file)?.[1];
    const source = region ? catalogUrl + region + '/' : catalogUrl;
    catalog.push(...readCatalog(await readFile(file, 'utf8'), source));
  }
  const byId = Object.groupBy(catalog, row => row.id);
  for (const point of points) {
    const known = index[point.id];
    if (matchesAddress(point, known) && isPosition(known.xy)) continue;
    index[point.id] = confirmCatalogPoint(point, byId[point.id]);
  }
  const temporary = new URL('../.coordinates.' + process.pid + '.tmp', import.meta.url);
  await writeFile(temporary, JSON.stringify(index, null, 2) + '\n');
  await rename(temporary, indexPath);
  return writeLocationReview(points, index);
}
