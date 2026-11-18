var VV_STATUS = {
  fixed: 'Исправлено автоматически',
  review: 'Требует подтверждения',
  critical: 'Критическая ошибка',
  ok: 'Проверено, исправление не требуется'
};

function vvMoscowTime_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') return value.getTime();
  var text = vvText_(value);
  var local = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})$/);
  if (local) return Date.parse(local[1] + '-' + local[2] + '-' + local[3] + 'T' + local[4].padStart(2, '0') + ':' + local[5] + ':' + local[6] + '+03:00');
  return /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? Date.parse(text) : NaN;
}

function vvCheckRaw_(grid, rawHeaders, now, previousUpdated, hours, exportStamp) {
  var headers = grid[0] || [];
  var indices = vvColumns_(headers, rawHeaders);
  var names = headers.map(vvKey_);
  var optional = ['ID ТТ', 'Тег ТТ', 'Город', 'Адрес'].map(function (name) {
    var key = vvKey_(name);
    var i = names.indexOf(key);
    if (i >= 0 && i !== names.lastIndexOf(key)) throw Error('Повторяющийся заголовок «' + name + '» в FULL.');
    return i;
  });
  var checked = {raw: [rawHeaders], entries: [], updated: -Infinity, plan: 0, closed: 0, deficit: 0};
  var timestampIndex = rawHeaders.indexOf('updated_at');
  var seen = new Set();
  grid.slice(1).forEach(function (source, index) {
    var values = indices.map(function (column) { return source[column]; });
    if (!values.some(vvText_)) return;
    if (!vvText_(values[1]) || !vvText_(values[2])) throw Error('В строке ' + (index + 2) + ' нет заявки или вакансии.');
    var signature = JSON.stringify(values);
    if (seen.has(signature)) throw Error('Полный дубль строки ' + (index + 2) + '.');
    seen.add(signature);
    var amounts = [3, 4, 5].map(function (i) { return vvNumber_(values[i]); });
    if (amounts.some(function (value) { return value === null; }) || amounts[2] - amounts[1] - amounts[0] !== 0) {
      throw Error('Строка ' + (index + 2) + ': план − финалисты − недобор не равен 0.');
    }
    checked.plan += amounts[2];
    checked.closed += amounts[1];
    checked.deficit += amounts[0];
    if (vvText_(values[timestampIndex])) {
      var updated = vvMoscowTime_(values[timestampIndex]);
      if (!Number.isFinite(updated)) throw Error('Некорректный updated_at в строке ' + (index + 2) + '.');
      checked.updated = Math.max(checked.updated, updated);
    }
    var fields = optional.map(function (i) { return i < 0 ? '' : source[i]; });
    checked.entries.push({raw: values, row: index + 2, id: fields[0], tag: fields[1], city: fields[2], address: fields[3]});
    checked.raw.push(values);
  });
  if (!checked.entries.length) throw Error('FULL пуст.');
  var exportTime = exportStamp ? vvMoscowTime_(exportStamp) : checked.updated;
  if (!Number.isFinite(exportTime) || exportTime > now + 5 * 60000 || checked.updated > exportTime + 5 * 60000 ||
    now - exportTime > hours * 3600000 || (previousUpdated && exportTime < previousUpdated)) throw Error('Дата FULL устарела, отсутствует или находится в будущем.');
  checked.sourceTime = exportTime;
  return checked;
}

function vvAddress_(value) {
  var text = vvText_(value);
  if (!/[а-яa-z].*\d/iu.test(text) || text.length > 350 || /(?:@|https?:|телефон|см\.?\s*комментарий)/iu.test(text)) return '';
  return text.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ')
    .replace(/(^|[\s,])улица(?=\s)/giu, '$1ул.')
    .replace(/(^|[\s,])проспект(?=\s)/giu, '$1пр-т')
    .replace(/(^|[\s,])дом\s*№?\s*(?=\d)/giu, '$1д. ')
    .replace(/(^|[\s,])корпус\s*№?\s*(?=\d)/giu, '$1к. ')
    .replace(/(^|[\s,])строение\s*№?\s*(?=\d)/giu, '$1стр. ');
}

function vvAddressKey_(value) {
  return vvAddress_(value).toLowerCase().replace(/ё/g, 'е').replace(/[.№,]/g, '').replace(/\s+/g, ' ').trim();
}

function vvTag_(value) {
  var tag = vvText_(value).toUpperCase();
  return /^(?:ДС|ГС|М|Ш|Ж)$/.test(tag) ? tag : '';
}

function vvDictionaryPlan_(entries, dictionary, cities, aliases, identify, inferTown) {
  var index = new Map(), proposed = new Map(), issues = [], changes = [];
  var note = function (id, kind, before, after, source, state, why) {
    issues.push({id: id, kind: kind, before: before, after: after, source: source, state: state, why: why});
  };
  dictionary.slice(1).forEach(function (row, i) {
    var id = vvId_(row[0]);
    if (!id) return;
    if (index.has(id)) note(id, 'Дубликат справочника', row[0], '', 'Справочник ТТ', VV_STATUS.critical, 'Нужна одна запись на ID.');
    else index.set(id, {row: row, line: i + 2});
  });

  entries.forEach(function (entry) {
    var title = vvText_(entry.raw[1]);
    var vacancy = vvText_(entry.raw[2]);
    if (/(^|[^а-яa-z])тест[а-я]*|(^|[^a-z])test([^a-z]|$)/iu.test(title + ' ' + vacancy) || /мобильн/iu.test(vacancy)) return;
    var pair = identify(title);
    var explicit = vvId_(entry.id);
    var inferred = vvId_(pair[0]);
    var id = explicit || inferred;
    if (explicit && explicit !== inferred) {
      note(explicit, 'ID в FULL не совпал с разбором заявки', inferred, explicit, 'HRM FULL', VV_STATUS.critical, 'Нужно уточнить ID в источнике.');
      return;
    }
    if (!id) {
      if (vvNumber_(entry.raw[3]) > 0) note('', 'ID не распознан', 'Строка ' + entry.row, '', 'HRM FULL', VV_STATUS.critical, 'Нет однозначного ID в заявке.');
      return;
    }
    if (!proposed.has(id)) proposed.set(id, {towns: new Map(), addresses: new Map(), tags: new Map(), active: false});
    var item = proposed.get(id);
    item.active ||= vvNumber_(entry.raw[3]) > 0;
    var explicitCity = vvCity_(entry.city);
    var alias = aliases.slice(1).filter(function (row) {
      return vvKey_(row[0]) && vvKey_(row[0]) === vvKey_(title.split('_')[1]);
    });
    var town = explicitCity || vvCity_(inferTown(title, cities)) || (alias.length === 1 ? vvCity_(alias[0][1]) : '');
    var tag = vvTag_(entry.tag) || vvTag_(pair[1]);
    var address = vvAddress_(entry.address);
    if (town) item.towns.set(vvKey_(town), town);
    if (tag) item.tags.set(tag, tag);
    if (address) item.addresses.set(vvAddressKey_(address), address);
  });

  proposed.forEach(function (item, id) {
    var known = index.get(id);
    var stored = known ? known.row : [];
    var resolved = [id, '', '', ''];
    var fields = [
      [1, 'Тег', item.tags, vvTag_, 'Явный тег HRM'],
      [2, 'Город', item.towns, vvCity_, 'Поле, однозначное название или сокращение HRM'],
      [3, 'Адрес', item.addresses, vvAddress_, 'Явный адрес HRM']
    ];
    fields.forEach(function (info) {
      var column = info[0], label = info[1], choices = info[2], old = info[3](stored[column]), source = info[4];
      var next = choices.size === 1 ? Array.from(choices.values())[0] : '';
      if (old) {
        resolved[column] = stored[column];
        var identity = column === 3 ? vvAddressKey_ : vvKey_;
        if (choices.size > 1 || next && identity(next) !== identity(old)) {
          note(id, label + ': конфликт источников', stored[column], next, source,
            column === 3 && item.active ? VV_STATUS.critical : VV_STATUS.review, 'Подтверждённое значение сохранено.');
        }
        return;
      }
      if (next) resolved[column] = next;
      else if (item.active) note(id, label + ' не подтверждён', stored[column] || '', '', source,
        column === 2 || column === 3 ? VV_STATUS.critical : VV_STATUS.review, 'Нет однозначного значения.');
    });
    if (!known || !vvTag_(stored[1]) && resolved[1] || !vvCity_(stored[2]) && resolved[2] || !vvAddress_(stored[3]) && resolved[3]) {
      var before = [0, 1, 2, 3].map(function (column) { return stored[column] == null ? '' : stored[column]; });
      var after = before.map(function (value, column) {
        return (column === 3 ? vvText_(value) : column === 2 ? vvCity_(value) : column === 1 ? vvText_(value) : vvId_(value))
          ? value : resolved[column] || value;
      });
      changes.push({id: id, line: known ? known.line : 0, before: before, after: after});
    }
  });
  return {issues: issues, changes: changes};
}
