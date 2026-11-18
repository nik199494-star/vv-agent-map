export const schemaVersion = 3;

const dayFormat = new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'});

export function dateKey(value) {
  const parts = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value ?? '');
  if (!parts) return '';
  const iso = `${parts[3]}-${parts[2]}-${parts[1]}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === iso ? iso : '';
}

export function isOutdated(sourceDate, now = new Date()) {
  return dateKey(sourceDate) < dateKey(dayFormat.format(now));
}

export function assertFreshEnough(next, previous) {
  if (!previous) return;
  if (next.rollbackOf && previous.snapshotId === next.rollbackOf &&
      Date.parse(next.publishedAt) >= Date.parse(previous.publishedAt)) return;
  const source = dateKey(next.sourceDate).localeCompare(dateKey(previous.sourceDate));
  if (source < 0 || (source === 0 && Date.parse(next.publishedAt) < Date.parse(previous.publishedAt))) {
    throw new RangeError('Получена более ранняя версия потребности.');
  }
}

const isText = value => typeof value === 'string';
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isNumber = value => Number.isFinite(value) && value >= 0;
const optional = (value, check) => value === null || check(value);

function validRole(role, pointId) {
  return role && /^\d+-\d+$/.test(role.id) && role.id.startsWith(`${pointId}-`)
    && [role.title, role.priority, role.transport, role.coverage, role.perOrder, role.distance, role.ageRaw, role.scheduleRaw, role.conditions].every(isText)
    && typeof role.superFocus === 'boolean' && optional(role.nsv, value => typeof value === 'boolean')
    && isCount(role.need) && role.need > 0 && optional(role.inProgress, isCount) && optional(role.shift, isNumber)
    && optional(role.income, value => value && isNumber(value.min) && isNumber(value.max) && value.min <= value.max)
    && optional(role.age, value => value && isCount(value.min) && optional(value.max, isCount))
    && Array.isArray(role.schedule) && role.schedule.every(isText);
}

export function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.schema !== schemaVersion || !dateKey(snapshot.sourceDate)
    || !Number.isFinite(Date.parse(snapshot.publishedAt)) || !Array.isArray(snapshot.points)) throw new Error('Неверный формат опубликованной потребности.');
  const ids = new Set();
  for (const point of snapshot.points) {
    if (!point || !isText(point.id) || !/^\d+$/.test(point.id) || ids.has(point.id)
      || ![point.city, point.address, point.searchText].every(isText) || typeof point.addressConflict !== 'boolean'
      || !Array.isArray(point.roles) || !point.roles.length || !point.roles.every(role => validRole(role, point.id))) {
      throw new Error('Некорректная запись в опубликованной потребности.');
    }
    ids.add(point.id);
  }
  return snapshot;
}

export async function fetchSnapshot(request = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await request(new URL('./demand.json', import.meta.url), {cache: 'no-store', signal: controller.signal});
    if (!response.ok) throw new Error(`Потребность недоступна (HTTP ${response.status}).`);
    return validateSnapshot(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}
