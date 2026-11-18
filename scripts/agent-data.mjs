import {normalize, rank} from '../model.js';
import {dateKey} from '../source.js';

export const agentHeaders = ['Приоритет', 'Супер фокус', 'Город', 'ID ТТ', 'Адрес', 'Роль', 'НСВ', 'Недобор', 'В работе', 'Покрытие воронкой', 'Доход, ₽/день', 'Средний ₽/заказ', 'Пробег, км/день', 'Возраст', 'График HRM', 'Доп. условия'];
export const maxCsvSize = 5 * 1024 * 1024;
const sheetError = /^#(?:REF!|ERROR!|N\/A|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)(?:\s|$)/i;

const absent = /^(?:[—–-]+|нет|не указан[оа]?|н\/д|#(?:N\/A|REF!|ERROR!|VALUE!|DIV\/0!))?$/i;
const clean = value => {
  const text = String(value ?? '').trim();
  return absent.test(text) ? '' : text;
};

export function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted || !cell) quoted = !quoted;
      else cell += char;
    } else if (!quoted && (char === delimiter || char === '\n' || char === '\r')) {
      row.push(cell);
      cell = '';
      if (char === delimiter) continue;
      rows.push(row);
      row = [];
      if (char === '\r' && source[i + 1] === '\n') i++;
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error('Незавершённая строка CSV');
  if (row.length || cell) rows.push([...row, cell]);
  return rows;
}

const amountPattern = '\\d+(?:[,.]\\d{1,2})?';
const amountRegex = new RegExp(`^(${amountPattern})(?:[-–—](${amountPattern}))?$`);
export function amount(value) {
  const match = clean(value).toLowerCase().replace(/\s+/g, '').replace(/(?:руб(?:лей|ля|ль)?\.?|₽)(?:\/день|\/заказ)?/g, '').match(amountRegex);
  if (!match) return null;
  const min = Number(match[1].replace(',', '.'));
  const max = Number((match[2] ?? match[1]).replace(',', '.'));
  return Number.isFinite(max) && max >= min ? {min, max} : null;
}

function count(value) {
  const digits = String(value ?? '').replace(/\s/g, '');
  return /^\d+$/.test(digits) && Number.isSafeInteger(Number(digits)) ? Number(digits) : null;
}

export function parseAge(value) {
  const text = clean(value).toLowerCase().replace(/[–—]/g, '-').trim();
  if (/^(?:без возрастных ограничений|без ограничений|ограничений нет)$/.test(text)) return {min: 0, max: null};
  const phrase = text.replace(/^строго\s+/, '').replace(/\s*(?:лет|года|год)$/, '');
  const range = phrase.match(/^(?:(?:от|с)\s+)?(\d{1,2})\s*(?:-|\s+до\s+)\s*(\d{1,2})$/);
  const lower = phrase.match(/^(?:(?:любой\s+)?(?:от|с)\s+)?(\d{1,2})\s*\+?$/);
  const upper = phrase.match(/^до\s+(\d{1,2})$/);
  if (range && +range[1] <= +range[2] && +range[1] >= 14) return {min: +range[1], max: +range[2]};
  if (lower && +lower[1] >= 14) return {min: +lower[1], max: null};
  if (upper && +upper[1] >= 14) return {min: 0, max: +upper[1]};
  return null;
}

function candidateAge(value, conditions) {
  const age = parseAge(value);
  if (!age) return null;
  const restrictions = [...conditions.matchAll(/(?<!\p{L})(?:(?:возраст|строго|кандидат\p{L}*)[^\n.;:]{0,30}?)?((?:(?:от|с|до)\s+)?\d{2}(?:\s*(?:[-–—]|до)\s*\d{2})?)\s*(?:лет|год(?:а)?)(?!\p{L})/giu)];
  for (const [, restriction] of restrictions) {
    const additional = parseAge(restriction);
    if (!additional) return null;
    age.min = Math.max(age.min, additional.min);
    age.max = Math.min(age.max ?? Infinity, additional.max ?? Infinity);
    if (age.max < age.min) return null;
    if (!Number.isFinite(age.max)) age.max = null;
  }
  return age;
}

// Strip contact lines and common personal identifiers from free-form source cells.
export function safeText(value) {
  return clean(value)
    .split(/\r?\n/)
    .filter(line => !/(?:^|\s)(?:фио|контакты?|телефон|паспорт|снилс|инн|дата рождения|фамилия и имя|данные кандидата|кандидат \d+|(?:список|реестр) (?:ка|кандидатов|выплат))(?=\s*[:№]|\s+\d)/iu.test(line))
    .join('\n')
    .replace(/https?:\/\/[^\s<>]+/gi, '[ссылка скрыта]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-zа-я]{2,}/giu, '[контакт скрыт]')
    .replace(/@[\p{L}\d_.]{2,}/gu, '[контакт скрыт]')
    .replace(/(?:\+7|\b8)[\s.(\-]*\d{3}[\s.)\-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}\b/g, '[контакт скрыт]');
}

function confirmedShift(conditions) {
  const fields = [...conditions.matchAll(/^\s*мин(?:имальная)?\.?\s+смена\s*:\s*([^\n]+)/gimu)];
  if (fields.length !== 1) return null;
  const value = fields[0][1].trim().match(/^(?:от\s+)?(\d{1,2}(?:[.,]\d)?)\s*(?:час(?:а|ов)?|ч\.?)$/iu);
  const hours = value ? Number(value[1].replace(',', '.')) : 0;
  if (hours <= 0 || hours > 24 || /(?:мин\.?\s*смен|короче)\s*\d+[.,]?\d*\s*час[^\n]*уточн/iu.test(conditions)) return null;
  const limits = [...conditions.matchAll(/короче\s+(\d+(?:[.,]\d)?)\s+час/giu)];
  return limits.every(([, limit]) => Number(limit.replace(',', '.')) === hours) ? hours : null;
}

function classifyTransport(title) {
  const role = normalize(title);
  const base = /^авто/.test(role) ? 'auto' : /^электровел/.test(role) ? 'electric' : /^мото/.test(role) ? 'moto' : /^пеш/.test(role) ? 'walk' : '';
  return base && /(?:^| )ноч[ьн]/u.test(role) ? `${base}-night` : base;
}

function confirmedSchedule(raw, conditions, transport) {
  const options = new Set();
  const acceptable = value => value && !/(?:уточн|согласован|возможн|обсужд|\?|не\s+(?:рассматр|доступ|принима|берем))/iu.test(value);
  const format = conditions.match(/^\s*формат\s*:\s*([^\n]+)/imu)?.[1];
  for (const part of format?.toLowerCase().split(/\s*\+\s*/) ?? []) {
    if (/^(?:фултайм|полный рабочий день)$/.test(part.trim())) options.add('full');
    if (/^(?:(?:вечерняя|дневная|ночная) )?подработка$/.test(part.trim())) {
      options.add('part');
      if (/^вечерняя /.test(part)) options.add('evening');
      if (/^дневная /.test(part)) options.add('day');
      if (/^ночная /.test(part)) options.add('night');
    }
  }
  const hours = conditions.match(/^\s*часы\s*:\s*([^\n]+)/imu)?.[1] ?? '';
  const explicit = raw.split(/[·;\n]+/u).concat(hours.split(';'));
  for (const option of explicit.filter(acceptable).map(value => value.toLowerCase())) {
    if (/(?:^|\d|\s)(?:день(?!\p{L})|дневн\p{L}*|утренн\p{L}*)/u.test(option)) options.add('day');
    if (/(?:^|\s)вечерн\p{L}*/u.test(option)) options.add('evening');
    if (/(?:^|\d|\s)ноч(?:ь(?!\p{L})|н\p{L}*)/u.test(option)) options.add('night');
  }
  if (transport.endsWith('-night') || /(?:^|\s)только\s+(?:ночь|ночные смены)(?!\p{L})/iu.test(hours)) {
    options.delete('day');
    options.delete('evening');
    options.add('night');
  }
  return [...options];
}

export function readAgentRows(text) {
  if (text.length > maxCsvSize) throw new Error('CSV превышает 5 МБ. Проверьте, что выгружена только потребность точек.');
  for (const delimiter of [',', ';']) {
    let rows;
    try { rows = parseCsv(text, delimiter); }
    catch { continue; }
    const names = rows[3]?.map(normalize) ?? [];
    const indices = agentHeaders.map(label => names.indexOf(normalize(label)));
    if (indices.some(index => index < 0) || names.some((name, index) => name && names.indexOf(name) !== index)) continue;
    const position = 3;
    const date = rows[position - 1].join(' ').match(/\b\d{2}\.\d{2}\.\d{4}\b/)?.[0];
    if (!dateKey(date)) throw new Error('Укажите действительную дату HRM над строкой заголовков.');
    const approved = [];
    for (const [index, row] of rows.slice(position + 1).entries()) {
      if (!row.some(value => value.trim())) continue;
      const fields = indices.map(column => row[column] ?? '');
      if (!fields.some(value => value.trim())) continue;
      const required = [0, 2, 3, 4, 5].every(column => clean(fields[column])) && /^\d+$/.test(fields[3].trim());
      const invalidNumbers = count(fields[7]) === null || (clean(fields[8]) && count(fields[8]) === null);
      const validFocus = ['', 'да', 'нет'].includes(normalize(fields[1]));
      const validNsv = ['', 'да', 'нет'].includes(normalize(fields[6]));
      const validCoverage = !clean(fields[9]) || /^[\d]+(?:[,.]\d+)?\s*%$/u.test(fields[9].trim());
      if (!required || !validFocus || !validNsv || !validCoverage || invalidNumbers || fields.some(value => sheetError.test(value.trim()))) {
        throw new Error(`Строка ${position + index + 2} CSV содержит ошибку в столбцах потребности. Проверьте ID, адрес, роль и числовые поля.`);
      }
      approved.push(fields.map((value, column) => column === 6 ? normalize(value) : safeText(value)));
    }
    return {date, rows: approved};
  }
  throw new Error('В строке 4 нужны заголовки новой вкладки «Потребность точки», включая «Супер фокус».');
}

export function shapePoints({date, rows}) {
  const points = new Map();
  const roleKeys = new Map();
  for (const row of rows) {
    const [priority, focus, city, id, address, title, nsv, needText, progress, coverage, daily, perOrder, distance, ageRaw, scheduleRaw, conditions] = row;
    const need = count(needText);
    if (!(need > 0)) continue;
    const transport = classifyTransport(title);
    if (!points.has(id)) {
      points.set(id, {id, city, address, roles: [], addressConflict: false});
      roleKeys.set(id, new Set());
    }
    const point = points.get(id);
    if ((address && point.address && normalize(point.address) !== normalize(address)) || (city && point.city && normalize(point.city) !== normalize(city))) point.addressConflict = true;
    point.address ||= address;
    point.city ||= city;
    const key = JSON.stringify(row);
    if (roleKeys.get(id).has(key)) continue;
    roleKeys.get(id).add(key);
    point.roles.push({
      id: `${id}-${point.roles.length + 1}`, title, transport,
      priority, superFocus: normalize(focus) === 'да', nsv: nsv ? nsv === 'да' : null, need, inProgress: count(progress), coverage,
      income: amount(daily), perOrder, distance,
      age: candidateAge(ageRaw, conditions), ageRaw,
      schedule: confirmedSchedule(scheduleRaw, conditions, transport), scheduleRaw,
      shift: confirmedShift(conditions), conditions,
    });
  }
  for (const point of points.values()) {
    point.searchText = normalize(`${point.id} ${point.city} ${point.address}`);
    point.roles.sort((a, b) => rank(a.priority) - rank(b.priority) || b.need - a.need);
  }
  return {sourceDate: date, points: [...points.values()]};
}
