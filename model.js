export const UNKNOWN = 'Требует уточнения';

export const TRANSPORT = {
  auto: 'Авто', electric: 'Электровело', moto: 'Мото', walk: 'Пеший',
  'auto-night': 'Авто · ночь', 'electric-night': 'Электровело · ночь',
  'moto-night': 'Мото · ночь', 'walk-night': 'Пеший · ночь',
};

export const SCHEDULE = {
  day: 'Дневные', evening: 'Вечерние', night: 'Ночные', part: 'Подработка', full: 'Фултайм',
};

export const normalize = value => String(value ?? '').toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/[^\p{L}\d]+/gu, ' ').trim();
const priorityOrder = ['критичный', 'наивысший', 'горящий', 'высокий', 'средний', 'обычный', 'низкий'];
export function rank(priority) {
  const index = priorityOrder.indexOf(normalize(priority));
  return index < 0 ? priorityOrder.length : index;
}

export function tone(priority) {
  return ['urgent', 'top', 'top', 'high'][rank(priority)] ?? 'normal';
}

const underageNote = /(?<![\p{L}\p{N}])(?:нсв|несовершеннолетн\p{L}*|(?:от|с)\s+1[0-7]\s+лет|(?:до|младше)\s+18\s+лет)(?![\p{L}\p{N}])/iu;
const ageField = /^возраст(?:ные ограничения)?\s*[:—–-]/iu;

function withoutAgeNotes(text) {
  return text.split(/\r?\n/u).flatMap(line => {
    const prefix = line.match(/^\s*Прочее:\s*/iu)?.[0] ?? '';
    const parts = line.slice(prefix.length).split(/[;·]/u).map(part => part.trim());
    const kept = parts.filter(part => !underageNote.test(part) && !ageField.test(part));
    if (kept.length === parts.length) return [line];
    const remaining = kept.filter(Boolean).join(line.includes('·') ? ' · ' : '; ');
    return remaining ? [prefix + remaining] : [];
  }).join('\n');
}

// The project owner confirmed an 18+ policy for every role at this store.
// Apply it to each display snapshot without changing the verified release or cache.
export function applyPointRules(points) {
  return points.map(point => point.id !== '4743' ? point : {
    ...point,
    adultOnly: true,
    roles: point.roles.map(role => ({
      ...role,
      age: {min: 18, max: null},
      ageRaw: '18',
      nsv: false,
      conditions: withoutAgeNotes(role.conditions),
      scheduleRaw: withoutAgeNotes(role.scheduleRaw),
    })),
  });
}

export function findPoints(points, filters) {
  const terms = normalize(filters.search).split(' ').filter(term => term && term !== 'тт');
  const conditionTerms = normalize(filters.conditions).split(' ').filter(Boolean);
  const byRole = (role) => {
    const {transport, priority, superFocus, need, schedule, format, minor, shift, age, incomeFrom, incomeTo} = filters;
    const acceptsMinor = role.nsv === true && (!role.age || role.age.min < 18 && (role.age.max === null || role.age.max >= 14));
    return (!transport.length || transport.includes(role.transport))
      && (!priority || role.priority === priority)
      && (need === null || role.need >= need)
      && (!schedule || role.schedule.includes(schedule))
      && (!format || role.schedule.includes(format))
      && (!(minor || (age !== null && age < 18)) || acceptsMinor)
      && (!conditionTerms.length || conditionTerms.every(term => normalize(role.conditions).includes(term)))
      && (shift === null || (role.shift !== null && role.shift <= shift))
      && (age === null || (role.age && age >= role.age.min && (role.age.max === null || age <= role.age.max)))
      && (incomeFrom === null || (role.income && role.income.max >= incomeFrom))
      && (incomeTo === null || (role.income && role.income.min <= incomeTo))
      && (!superFocus || role.superFocus === (superFocus === 'yes'));
  };
  if (filters.incomeFrom !== null && filters.incomeTo !== null && filters.incomeFrom > filters.incomeTo) return [];
  return points.flatMap(point => {
    if (filters.city && filters.city !== point.city) return [];
    if (terms.length && !terms.every(term => point.searchText.includes(term))) return [];
    const roles = point.roles.filter(byRole);
    if (!roles.length) return [];
    return [{...point, matched: roles, need: roles.reduce((total, role) => total + role.need, 0)}];
  }).sort((a, b) => rank(a.matched[0].priority) - rank(b.matched[0].priority) || b.need - a.need || a.id.localeCompare(b.id, 'ru'));
}

export const number = value => new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2}).format(value);
export const incomeText = value => value ? `${number(value.min)}${value.max === value.min ? '' : `–${number(value.max)}`} ₽/день` : UNKNOWN;
export const ageText = value => {
  if (!value) return UNKNOWN;
  if (value.min === 0 && value.max === null) return 'Ограничения не указаны в листе';
  if (value.min === 0) return `До ${value.max} лет`;
  return value.max === null ? `От ${value.min} лет` : `${value.min}–${value.max} лет`;
};
