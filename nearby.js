import {normalize} from './model.js';

export function distanceKm([latA, lonA], [latB, lonB]) {
  const radians = Math.PI / 180;
  const sinLat = Math.sin((latB - latA) * radians / 2);
  const sinLon = Math.sin((lonB - lonA) * radians / 2);
  const a = sinLat * sinLat + Math.cos(latA * radians) * Math.cos(latB * radians) * sinLon * sinLon;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function nearbyPoints(points, origin, radius) {
  if (!origin) return points;
  return points.filter(point => point.location?.xy).map(point => ({...point, distance: distanceKm(origin, point.location.xy)}))
    .filter(point => radius === null || point.distance <= radius)
    .sort((left, right) => left.distance - right.distance);
}

export function candidateQuery(value) {
  return String(value).split(/(?:^|[\s,])(?:кв(?:артира)?\.?|подъезд|этаж|домофон|офис|комната)(?=\s|\d|№)/iu, 1)[0].trim().slice(0, 150);
}

function placeLabel(properties) {
  const {city, town, village, locality, state, district, street, housenumber, name, osm_key, osm_value, type} = properties;
  const townName = city || town || village || locality;
  const metro = osm_key === 'railway' && ['station', 'subway_entrance', 'halt'].includes(osm_value);
  const house = Boolean(street && housenumber);
  const label = house ? `${street}, ${housenumber}` : (name || street || townName);
  const tail = [townName, district, state].filter(Boolean).filter((item, index, list) => normalize(item) !== normalize(label) && list.findIndex(other => normalize(other) === normalize(item)) === index);
  const kind = house ? 'Дом' : metro ? (osm_value === 'subway_entrance' ? 'Вход на станцию' : 'Станция')
    : type === 'street' || osm_key === 'highway' ? 'Улица · ориентир' : 'Место · ориентир';
  return {label, area: tail.join(', '), kind, metro, house, weight: Number(house) * 2 + Number(metro)};
}

export function photonSuggestions(features, query) {
  const terms = normalize(query);
  const asksMetro = /(?:^| )метро(?: |$)/u.test(terms);
  const asksStreet = /(?:^| )(?:ул|улица|шоссе|проспект|пр т|пер|переулок|бульвар|набережная)(?: |$)/u.test(terms);
  const suggestions = [];
  const seen = new Set();
  for (const feature of features) {
    const p = feature?.properties;
    const [lon, lat] = feature?.geometry?.coordinates ?? [];
    if (!p || p.countrycode !== 'RU' || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const item = placeLabel(p);
    // Results for metro searches often include bus stops named after a station.
    if (!item.label || asksMetro && !item.metro) continue;
    const key = normalize(`${item.label} ${item.area}`);
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({...item, xy: [lat, lon]});
  }
  const score = item => item.weight + Number(asksStreet && item.kind.startsWith('Улица')) * 1.5;
  return suggestions.sort((a, b) => score(b) - score(a)).slice(0, 7);
}

const provider = 'https://photon.komoot.io/api/';
let nextRequest = 0;

export async function searchCandidate(value, signal) {
  const query = candidateQuery(value);
  if (query.length < 3) return [];
  const wait = nextRequest - Date.now();
  if (wait > 3000) throw new Error('Поиск адресов временно ограничен. Повторите немного позже.');
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  if (signal?.aborted) return [];
  nextRequest = Date.now() + 1200;
  const metro = /^метро\s+/iu.test(query);
  const q = metro ? query.replace(/^метро\s+/iu, '') : query;
  const params = new URLSearchParams({q, countrycode: 'RU', limit: '15'});
  if (metro) params.append('osm_tag', 'railway');
  const response = await fetch(`${provider}?${params}`, {signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store'});
  if (response.status === 429) {
    const header = response.headers.get('Retry-After');
    const retry = header && /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
    nextRequest = Date.now() + Math.max(30000, Number.isFinite(retry) ? retry : 0);
    throw new Error('Поиск адресов временно ограничен. Повторите немного позже.');
  }
  if (!response.ok) throw new Error('Поиск адресов временно недоступен.');
  const {features} = await response.json();
  if (!Array.isArray(features)) throw new Error('Поиск адресов временно недоступен.');
  return photonSuggestions(features, query);
}
