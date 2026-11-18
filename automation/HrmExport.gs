var VV_HRM_EXPORT_COLUMNS = [
  'ID', 'Статус', 'Приоритет', 'Название', 'Вакансия', 'Недобор', 'Закрыто позиций',
  'Кол-во позиций', 'В работе', 'График работы', 'Ответственный', 'Заказчик',
  'Дата создания', 'дату закрытия', 'Город'
];

function vvProjectPreviewHrm_(grid, rawHeaders) {
  var headers = (grid[0] || []).map(vvKey_);
  if (!headers.includes(vvKey_('Кол-во позиций')) && !headers.includes(vvKey_('Недобор'))) return {grid: grid, extended: false};
  var indices = vvColumns_(grid[0], VV_HRM_EXPORT_COLUMNS);
  var projected = [rawHeaders.concat(['Город'])];
  var ids = new Set();
  grid.slice(1).forEach(function (row, index) {
    var values = indices.map(function (i) { return row[i] == null ? '' : row[i]; });
    if (!values.some(vvText_)) return;
    var [id, status, priority, label, vacancy, deficit, closed, plan, funnel, schedule, owner, customer, opened, ended, city] = values;
    var requestId = vvText_(id);
    if (!/^[1-9]\d*$/u.test(requestId) || ids.has(requestId)) {
      throw Error('Некорректный или повторный ID заявки HRM в строке ' + (index + 2) + '.');
    }
    if (vvKey_(status) !== 'актуальные') throw Error('В строке ' + (index + 2) + ' ожидается актуальная заявка HRM.');
    if ([deficit, closed, plan, funnel].some(function (value) { return vvNumber_(value) === null; })) {
      throw Error('Некорректные позиции или воронка HRM в строке ' + (index + 2) + '.');
    }
    ids.add(requestId);
    projected.push([
      priority, label, vacancy, vvNumber_(deficit), vvNumber_(closed), vvNumber_(plan), '', schedule,
      owner, customer, opened, ended, '', '', city
    ]);
  });
  return {grid: projected, extended: true};
}

function vvCheckPreviewFull_(grid, rawHeaders, now, previousUpdated, hours, exportStamp) {
  var input = vvProjectPreviewHrm_(grid, rawHeaders);
  if (input.extended && !exportStamp) {
    throw Error('Укажите подтверждённую рабочую дату HRM в ячейке VV_FULL_TIMESTAMP_CELL.');
  }
  var date = vvText_(exportStamp);
  var checked;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    var dayStart = Date.parse(date + 'T00:00:00+03:00');
    if (date !== new Date(now + 3 * 3600000).toISOString().slice(0, 10) ||
        previousUpdated >= dayStart + 24 * 3600000) {
      throw Error('Подтверждённая дата FULL должна совпадать с текущим московским днём и не предшествовать последнему снимку.');
    }
    checked = vvCheckRaw_(input.grid, rawHeaders, now, 0, hours, new Date(now));
    checked.sourceTime = dayStart;
  } else {
    checked = vvCheckRaw_(input.grid, rawHeaders, now, previousUpdated, hours, exportStamp);
  }
  checked.extended = input.extended;
  return checked;
}

function vvPreviewRawMatches_(full, staged) {
  if (!full.extended) return canonical(full.raw) === canonical(staged.raw);
  // Check the business fields the XLSX and a calculated RAW have in common.
  var core = function (rows) {
    return JSON.stringify(rows.slice(1).map(function (r) {
      return JSON.stringify([vvText_(r[0]), vvText_(r[1]), vvText_(r[2]),
        vvNumber_(r[3]), vvNumber_(r[4]), vvNumber_(r[5]), vvText_(r[7])]);
    }).sort());
  };
  return core(full.raw) === core(staged.raw);
}
