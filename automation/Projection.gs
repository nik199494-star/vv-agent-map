var VV_AGENT_COLUMNS = ['Приоритет', 'Супер фокус', 'Город', 'ID ТТ', 'Адрес', 'Роль', 'НСВ', 'Недобор', 'В работе', 'Покрытие воронкой', 'Доход, ₽/день', 'Средний ₽/заказ', 'Пробег, км/день', 'Возраст', 'График HRM', 'Доп. условия'];
var VV_CORE_COLUMNS = ['ID ТТ', 'Роль', 'Город', 'Недобор'];

function vvText_(value) {
  return String(value == null ? '' : value).normalize('NFC').replace(/\r\n?/g, '\n').trim();
}

function vvKey_(value) {
  return vvText_(value).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\d]+/gu, ' ').trim();
}

function vvId_(value) {
  var id = vvText_(value);
  return /^\d{1,9}$/.test(id) && Number(id) > 0 ? String(Number(id)) : '';
}

function vvCity_(value) {
  var city = vvText_(value);
  var key = vvKey_(city);
  return /[а-яa-z]/iu.test(city) && !/^(?:нет|н д|не определен[ао]?|не указан[ао]?|(?:город )?уточняется|неизвестно)$/iu.test(key) ? city : '';
}

function vvNumber_(value) {
  var text = vvText_(value).replace(/\s/g, '');
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
}

function vvColumns_(header, labels) {
  var names = (header || []).map(vvKey_);
  return labels.map(function (name) {
    var key = vvKey_(name);
    var index = names.indexOf(key);
    if (index < 0 || names.lastIndexOf(key) !== index) throw Error('Неоднозначный или отсутствующий заголовок «' + name + '».');
    return index;
  });
}

function vvProjection_(rows, kind) {
  var date = (rows[2] || []).map(vvText_).join(' ').match(/\b\d{2}\.\d{2}\.\d{4}\b/);
  if (!date) throw Error('В витрине отсутствует дата HRM.');
  var labels = kind === 'cities' ? ['Город', 'Недобор'] : kind === 'agent' ? VV_AGENT_COLUMNS : VV_CORE_COLUMNS;
  var index = vvColumns_(rows[3], labels);
  var cities = new Map();
  var ids = new Set();
  var positions = new Set();
  var signature = [];
  var core = [];
  var deficit = 0;
  rows.slice(4).forEach(function (row, offset) {
    var fields = index.map(function (i) { return vvText_(row[i]); });
    if (!fields.some(Boolean)) return;
    if (fields.some(function (cell) { return /^#(?:REF!|ERROR!|N\/A|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)/i.test(cell); })) {
      throw Error('Ошибка формулы в витрине, строка ' + (offset + 5) + '.');
    }
    var value = function (name) { return fields[labels.indexOf(name)]; };
    var city = vvCity_(value('Город'));
    var need = vvNumber_(value('Недобор'));
    if (!city || need === null) throw Error('Город или недобор не подтверждён, строка ' + (offset + 5) + '.');
    var cityKey = vvKey_(city);
    if (kind === 'cities' && cities.has(cityKey)) throw Error('В витрине городов есть дубли.');
    if (kind !== 'cities' && need > 0) {
      var id = vvId_(value('ID ТТ'));
      var role = vvKey_(value('Роль'));
      var key = JSON.stringify([id, role]);
      if (!id || !/^(авто|электровел|мото|пеш)/u.test(role) || positions.has(key) ||
          (kind === 'agent' && !/[а-яa-z0-9]/iu.test(value('Адрес')))) throw Error('Некорректная или повторная позиция ТТ и роли, строка ' + (offset + 5) + '.');
      ids.add(id);
      positions.add(key);
      core.push(JSON.stringify([id, role, cityKey, need]));
    }
    if (kind === 'agent') signature.push(JSON.stringify(fields));
    cities.set(cityKey, (cities.get(cityKey) || 0) + need);
    deficit += need;
  });
  if (!cities.size || !Number.isSafeInteger(deficit)) throw Error('Пустая витрина или некорректный итог недобора.');
  return {
    date: date[0], points: ids.size, roles: positions.size, deficit: deficit,
    cities: JSON.stringify(Array.from(cities).filter(function (entry) { return entry[1] > 0; }).sort()),
    core: JSON.stringify(core.sort()), signature: JSON.stringify([date[0], signature.sort()])
  };
}
