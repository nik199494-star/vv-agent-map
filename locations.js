import {normalize} from './model.js';

export const isPosition = (xy) => Array.isArray(xy) && xy.length === 2 && xy.every(Number.isFinite)
  && xy[0] >= 40 && xy[0] <= 83 && Math.abs(xy[1]) <= 180;

export const locationReasons = {
  pending: 'Адрес ожидает проверки', changed: 'Адрес изменился, нужна проверка', conflict: 'В данных указаны разные адреса',
  missing: 'Адрес отсутствует в справочнике', ambiguous: 'Найдено несколько адресов', incomplete: 'Адрес нужно уточнить',
  different: 'Адрес отличается от официального справочника',
};

export const addressIdentity = value => String(value ?? '').toLocaleLowerCase('ru').replaceAll('ё', 'е')
  .replace(/[^\p{L}\d/—–-]+/gu, ' ').trim().replace(/[—–]/g, '-').replace(/\s*([/-])\s*/g, '$1');

export function matchesAddress(point, known) {
  return known && !point.addressConflict && normalize(known.city) === normalize(point.city)
    && (known.address === point.address || addressIdentity(known.address) === addressIdentity(point.address));
}

export function attachLocations(points, coordinates) {
  return points.map(point => {
    const known = Object.hasOwn(coordinates, point.id) ? coordinates[point.id] : null;
    const matches = matchesAddress(point, known);
    if (matches && isPosition(known.xy)) return {...point, location: {state: 'mapped', xy: known.xy}};
    const reason = point.addressConflict ? 'conflict' : !known ? 'pending' : !matches ? 'changed' : known.reason || 'pending';
    return {...point, location: {state: 'unresolved', xy: null, reason}};
  });
}

export function findCityCenter(cities, city) {
  const key = normalize(city).replace(/^(?:г|город|рп|рабочий поселок|поселок|пгт) /u, '');
  return Object.hasOwn(cities, key) && isPosition(cities[key]) ? cities[key] : null;
}

export async function loadLocations() {
  const read = async (name) => {
    try {
      const response = await fetch(new URL(name, import.meta.url), {cache: 'no-store'});
      if (response.ok) return await response.json();
    } catch { /* The list remains available when location assets cannot load. */ }
    return {};
  };
  const [coordinates, cities] = await Promise.all([read('coordinates.json'), read('ru-city-centers.json')]);
  return {coordinates, cities};
}
