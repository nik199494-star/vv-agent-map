function vvGeoReview_(book, grid, index, journal, run) {
  var tab = vvTable_(book, 'Геоконтроль', VV_GEO);
  var key = function (id, city, address) { return JSON.stringify([vvId_(id), vvKey_(city), vvAddressKey_(address)]); };
  var rows = new Map();
  tab.getDataRange().getValues().slice(1).forEach(function (row) {
    if (!vvId_(row[0])) return;
    var identity = key(row[0], row[1], row[2]);
    if (rows.has(identity)) throw Error('Повторяется адрес в геоконтроле для ТТ ' + vvId_(row[0]) + '.');
    rows.set(identity, row);
  });
  var indices = vvColumns_(grid[3], ['ID ТТ', 'Город', 'Адрес', 'Недобор']);
  var seen = new Map();
  var updates = [];
  var journalRows = [];
  grid.slice(4).forEach(function (fields) {
    var values = indices.map(function (i) { return fields[i]; });
    if (!(vvNumber_(values[3]) > 0)) return;
    var id = vvId_(values[0]), city = vvCity_(values[1]), address = vvText_(values[2]);
    var identity = key(id, city, address);
    if (seen.has(id)) {
      if (seen.get(id) !== identity) throw Error('Разные адреса у ролей ТТ ' + id + '.');
      return;
    }
    seen.set(id, identity);
    var known = Object.hasOwn(index, id) ? index[id] : null;
    var normalized = vvAddress_(address);
    if (!normalized) throw Error('В витрине неполный адрес ТТ ' + id + '.');
    var previousKey = known ? key(id, known.city, known.address) : '';
    if (Array.isArray(known?.xy) && !rows.has(previousKey)) {
      var old = [id, known.city, vvAddress_(known.address) || known.address, known.xy[0], known.xy[1],
        known.sources?.[0] || '', known.checkedOn || '', 'Подтверждено', '', '', known.address];
      rows.set(previousKey, old);
      journalRows.push(old);
    }
    var row = rows.get(identity);
    if (!row) {
      var why = Array.isArray(known?.xy) ? 'Адрес изменился'
        : known?.reason === 'different' ? 'Адрес расходится с каталогом' : 'Координаты требуют подтверждения';
      row = [id, city, normalized, '', '', '', '', 'На проверке', why, previousKey && previousKey !== identity ? new Date() : '', address];
      rows.set(identity, row);
      journalRows.push(row);
    }
    if (row[7] === 'Подтверждено') {
      var xy = [Number(String(row[3]).replace(',', '.')), Number(String(row[4]).replace(',', '.'))];
      var checkedOn = Object.prototype.toString.call(row[6]) === '[object Date]'
        ? Utilities.formatDate(row[6], 'Europe/Moscow', 'yyyy-MM-dd') : vvText_(row[6]);
      if (!vvText_(row[3]) || !vvText_(row[4]) || !xy.every(Number.isFinite) ||
          xy[0] < 40 || xy[0] > 83 || Math.abs(xy[1]) > 180 || !/^https:\/\//u.test(row[5]) ||
          !/^\d{4}-\d{2}-\d{2}$/u.test(checkedOn)) throw Error('Подтверждение координат неполное для ТТ ' + id + '.');
      if (known?.xy?.[0] === xy[0] && known?.xy?.[1] === xy[1] && known.city === city && known.address === address) return;
      updates.push({id: id, city: city, address: address, xy: xy, source: vvText_(row[5]), checkedOn: checkedOn, status: 'confirmed'});
    } else if (row[7] === 'Принят без маркера') {
      if (known?.reason === 'changed' && known.city === city && known.address === address) return;
      updates.push({id: id, city: city, address: address, status: 'pending'});
    } else if (known?.xy) {
      vvLog_(journal, run, {id: id, kind: 'Геоконфликт', before: known.address, after: address, state: VV_STATUS.critical,
        why: 'Старый адрес нельзя использовать для маркера.'});
    }
  });
  vvAppend_(tab, journalRows);
  return updates.sort(function (a, b) { return Number(a.id) - Number(b.id); });
}

function vvRollbackDictionary() {
  var ui = SpreadsheetApp.getUi();
  var answer = ui.prompt('Откат автоисправлений', 'Введите идентификатор запуска из листа «Автодиагностика».', ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return;
  var run = answer.getResponseText().trim();
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(1000)) { book.toast('Идёт обновление. Повторите после завершения.'); return; }
  try {
    var journal = vvTable_(book, 'Автодиагностика', VV_JOURNAL);
    var dictionary = vvSheet_(book, 'Справочник ТТ');
    var records = journal.getDataRange().getValues().filter(function (row) { return row[8] === run && row[9]; });
    if (!records.length) { book.toast('Для запуска нет записанных автоисправлений.'); return; }
    var restored = 0;
    records.reverse().forEach(function (entry) {
      var record = JSON.parse(entry[9]);
      var target = dictionary.getRange(record.row, 1, 1, 4);
      var current = target.getValues()[0];
      if (vvId_(current[0]) !== record.id || target.getFormulas()[0].some(Boolean)) return;
      if (JSON.stringify(current.slice(1)) !== JSON.stringify(record.after.slice(1))) return;
      if (!record.before[0] && dictionary.getRange(record.row, 5, 1, dictionary.getLastColumn() - 4).getDisplayValues()[0].some(Boolean)) return;
      target.setValues([record.before]);
      vvLog_(journal, run, {id: record.id, kind: 'Откат автоисправления', before: JSON.stringify(record.after), after: JSON.stringify(record.before),
        source: 'Справочник ТТ', state: VV_STATUS.ok});
      restored++;
    });
    book.toast('Восстановлено записей ' + restored + ' из ' + records.length + '.');
  } finally { lock.releaseLock(); }
}
