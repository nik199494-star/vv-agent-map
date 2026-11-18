var VV_HOME = 'https://nik199494-star.github.io/vv-agent-map/';
var VV_GITHUB = 'https://api.github.com/repos/nik199494-star/vv-agent-map/';
var VV_KNOWLEDGE = '1jnZHSosr0d3PA7HaLcMFi48CHMHSpgVCG17MXT0Utzc';
var VV_AGENT = '1NPBnTgakkfiaa31ZznAg-iPw1e5Fi94Mu27IT8X_O-w';
var VV_JOURNAL = ['Время', 'ID ТТ', 'Проблема', 'Исходное', 'Исправление', 'Источник', 'Статус', 'Причина', 'Запуск', 'Обратимая запись'];
var VV_GEO = ['ID ТТ', 'Город', 'Нормализованный адрес', 'Широта', 'Долгота', 'Источник', 'Дата проверки', 'Статус', 'Причина', 'Изменение адреса', 'Адрес из витрины'];

function vvSheet_(book, name) {
  var tab = book.getSheetByName(name);
  if (!tab) throw Error('Не найден лист «' + name + '».');
  return tab;
}

function vvTable_(book, name, headings) {
  var tab = book.getSheetByName(name);
  if (!tab) {
    tab = book.insertSheet(name);
    tab.getRange(1, 1, 1, headings.length).setValues([headings]).setFontWeight('bold');
    tab.setFrozenRows(1);
  }
  var actual = tab.getRange(1, 1, 1, headings.length).getDisplayValues()[0];
  if (JSON.stringify(actual) !== JSON.stringify(headings)) throw Error('Изменились заголовки «' + name + '».');
  return tab;
}

function vvAppend_(tab, rows) {
  if (!rows.length) return;
  var start = tab.getLastRow() + 1;
  var excess = start + rows.length - 1 - tab.getMaxRows();
  if (excess > 0) tab.insertRowsAfter(tab.getMaxRows(), excess);
  tab.getRange(start, 1, rows.length, rows[0].length).setValues(rows.map(function (row) {
    return row.map(function (value) { return typeof value === 'string' && /^[=+@-]/.test(value) ? "'" + value : value; });
  }));
}

function vvLog_(journal, run, item, reverse) {
  vvAppend_(journal, [[new Date(), item.id || '', item.kind, item.before || '', item.after || '', item.source || '',
    item.state, item.why || '', run, reverse ? JSON.stringify(reverse) : '']]);
}

function vvHash_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(function (byte) { return ((byte + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}

function vvReadState_(properties) {
  return JSON.parse(properties.getProperty('VV_FLOW_STATE') || '{}');
}

function vvSetState_(book, properties, state, status) {
  var changed = state.status !== status;
  state.status = status;
  properties.setProperty('VV_FLOW_STATE', JSON.stringify(state));
  book.toast(status + (state.snapshot ? ' · ' + state.snapshot.slice(0, 8) : ''), 'ВВ Потребность', 8);
  var journal = book.getSheetByName('Автодиагностика');
  if (changed && journal) vvLog_(journal, state.run, {kind: 'Ход обновления', before: state.snapshot || '',
    after: status, source: state.runId ? 'GitHub Actions · ' + state.runId : 'Рабочая книга', state: VV_STATUS.ok});
}

function vvWriteDictionary_(tab, plan, journal, run) {
  plan.changes.forEach(function (change) {
    if (JSON.stringify(change.after) === JSON.stringify(change.before)) return;
    var line = change.line || tab.getLastRow() + 1;
    if (line > tab.getMaxRows()) tab.insertRowsAfter(tab.getMaxRows(), 25);
    var cells = tab.getRange(line, 1, 1, 4);
    if (cells.getFormulas()[0].some(Boolean) || JSON.stringify(cells.getValues()[0]) !== JSON.stringify(change.before)) {
      throw Error('Запись справочника ТТ ' + change.id + ' изменилась во время проверки.');
    }
    var record = {id: change.id, row: line, before: change.before, after: change.after};
    vvLog_(journal, run, {id: change.id, kind: 'План безопасной правки справочника', before: JSON.stringify(change.before),
      after: JSON.stringify(change.after), source: 'HRM и справочники', state: VV_STATUS.review}, record);
    cells.setValues([change.after]);
    SpreadsheetApp.flush();
    vvLog_(journal, run, {id: change.id, kind: 'Изменение справочника', after: JSON.stringify(change.after),
      source: 'HRM и справочники', state: VV_STATUS.fixed});
  });
}

function vvMapExpected_(normalized) {
  var index = new Map();
  var sums = new Map();
  normalized.forEach(function (row) {
    if (row[24] === 'Да' || row[6] === 'Мобильный' || row[13] <= 0) return;
    var id = vvId_(row[3]), role = vvKey_(row[5]), city = vvCity_(row[7]);
    var key = JSON.stringify([id, role]);
    if (!id || !role || !city) throw Error('В расчёте есть активная ТТ без ID, роли или города.');
    var cityKey = vvKey_(city);
    var previous = index.get(key);
    if (previous && previous[2] !== cityKey) throw Error('Конфликт городов у активной ТТ ' + id + '.');
    index.set(key, [id, role, cityKey, (previous ? previous[3] : 0) + row[13]]);
    sums.set(cityKey, (sums.get(cityKey) || 0) + row[13]);
  });
  return {core: JSON.stringify(Array.from(index.values()).map(function (row) { return JSON.stringify(row); }).sort()),
    cities: JSON.stringify(Array.from(sums).sort())};
}

function vvRawTable_(sheet) {
  var range = sheet.getDataRange();
  return {values: range.getValues(), linked: range.getFormulas().some(function (row) { return row.some(Boolean); })};
}

function vvStageRaw_(sheet, raw, staged) {
  if (staged.linked) return;
  if (canonical(staged.values) === canonical(raw) && JSON.stringify(staged.values[0]) === JSON.stringify(raw[0])) return;
  var width = raw[0].length;
  if (staged.values.some(function (row) { return row.slice(width).some(vvText_); })) {
    throw Error('В RAW есть дополнительные заполненные столбцы. Уточните схему перед обновлением.');
  }
  if (sheet.getMaxRows() < raw.length) sheet.insertRowsAfter(sheet.getMaxRows(), raw.length - sheet.getMaxRows());
  var size = Math.max(raw.length, staged.values.length);
  var values = Array.from({length: size}, function (_, i) {
    return (raw[i] || Array(width).fill('')).map(function (value) {
      return typeof value === 'string' && /^[=+@-]/.test(value) ? "'" + value : value == null ? '' : value;
    });
  });
  sheet.getRange(1, 1, size, width).setValues(values);
  SpreadsheetApp.flush();
}

function vvCheckHistory_(book, raw) {
  var log = vvSheet_(book, 'Снимки');
  if (log.getLastRow() < 2) throw Error('Запись о принятом снимке не найдена.');
  var last = log.getRange(log.getLastRow(), 1, 1, 6).getValues()[0];
  var history = vvSheet_(book, 'HISTORY');
  var size = vvNumber_(last[2]);
  if (!last[0] || !Number.isFinite(vvMoscowTime_(last[1])) || !size || history.getLastRow() <= size ||
      vvNumber_(last[3]) === null || vvNumber_(last[4]) === null || vvNumber_(last[5]) === null || last[3] - last[4] - last[5] !== 0) {
    throw Error('Метаданные сохранённого снимка не прошли проверку.');
  }
  var rows = history.getRange(history.getLastRow() - size + 1, 1, size, 16).getValues();
  if (rows.some(function (row) { return row[0] !== last[0]; }) ||
    canonical([RAW_HEADERS].concat(rows.map(function (row) { return row.slice(2, 16); }))) !== canonical(raw)) {
    throw Error('HISTORY не совпала с принятой FULL.');
  }
  return {id: String(last[0]), acceptedAt: new Date(vvMoscowTime_(last[1])).toISOString()};
}

function vvViews_(expected, sourceDate) {
  var knowledge = SpreadsheetApp.openById(VV_KNOWLEDGE);
  var agent = SpreadsheetApp.openById(VV_AGENT);
  var result, reason;
  for (var attempt = 0; attempt < 12; attempt++) {
    try {
      var basePoints = vvProjection_(vvSheet_(knowledge, 'Потребность точки').getDataRange().getDisplayValues(), 'core');
      var baseCities = vvProjection_(vvSheet_(knowledge, 'Потребность города').getDataRange().getDisplayValues(), 'cities');
      var pointsGrid = vvSheet_(agent, 'Потребность точки').getDataRange().getDisplayValues();
      var agentPoints = vvProjection_(pointsGrid, 'agent');
      var agentCities = vvProjection_(vvSheet_(agent, 'Потребность города').getDataRange().getDisplayValues(), 'cities');
      var dateMatch = [basePoints, baseCities, agentPoints, agentCities].every(function (view) { return view.date === sourceDate; });
      if (dateMatch && agentPoints.core === expected.core && basePoints.core === expected.core &&
          [basePoints, baseCities, agentPoints, agentCities].every(function (view) { return view.cities === expected.cities; })) {
        result = {summary: agentPoints, grid: pointsGrid};
        break;
      }
      reason = 'Дата, недобор, города или пары ТТ и роли ещё не совпадают с принятым снимком.';
    } catch (error) { reason = error.message; }
    if (attempt < 11) Utilities.sleep(5000);
  }
  if (!result) throw Error(reason);
  return result;
}

function vvGithub_(properties, path, body) {
  var token = properties.getProperty('VV_GITHUB_ACTIONS_TOKEN');
  if (!token) throw Error('Нет токена запуска GitHub Actions.');
  var options = {headers: {Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10'}, followRedirects: false, muteHttpExceptions: true};
  if (body) {
    options.method = 'post';
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }
  var response = UrlFetchApp.fetch(VV_GITHUB + path, options);
  if (response.getResponseCode() !== 200) throw Error('GitHub API вернул HTTP ' + response.getResponseCode() + '.');
  return JSON.parse(response.getContentText());
}

function vvPublic_(name) {
  var response = UrlFetchApp.fetch(VV_HOME + name + '?vv-check=' + Date.now(), {muteHttpExceptions: true, followRedirects: false});
  if (response.getResponseCode() !== 200) throw Error('GitHub Pages вернул HTTP ' + response.getResponseCode() + ' для ' + name + '.');
  return response.getContentText();
}

function vvScheduleStatus_() {
  if (!ScriptApp.getProjectTriggers().some(function (trigger) { return trigger.getHandlerFunction() === 'vvCheckMapStatus'; })) {
    ScriptApp.newTrigger('vvCheckMapStatus').timeBased().after(75000).create();
  }
}

function vvCheckMapStatus(e) {
  if (e && e.triggerUid) {
    ScriptApp.getProjectTriggers().filter(function (trigger) { return trigger.getUniqueId() === e.triggerUid; })
      .forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  }
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(1000)) { if (e) vvScheduleStatus_(); return; }
  try {
    var properties = PropertiesService.getScriptProperties();
    var state = vvReadState_(properties);
    var book = SpreadsheetApp.getActiveSpreadsheet();
    if (!book && state.book) book = SpreadsheetApp.openById(state.book);
    if (!state.runId || state.done) { book.toast(state.status || 'Публикация ещё не запрошена.', 'ВВ Потребность', 8); return; }
    state.checks++;
    try {
      if (state.checks > 24) throw Error('Проверка GitHub не завершилась за отведённое время.');
      var result = vvGithub_(properties, 'actions/runs/' + Number(state.runId));
      if (result.status !== 'completed') {
        vvSetState_(book, properties, state, result.status === 'queued' ? 'Публикация запрошена' : 'Публикация выполняется');
        vvScheduleStatus_();
        return;
      }
      if (result.conclusion !== 'success') throw Error('GitHub Actions завершился со статусом ' + result.conclusion + '.');
      if (state.preview) {
        state.done = true;
        vvSetState_(book, properties, state, 'Проверка GitHub Actions завершена');
        return;
      }
      var receipt = JSON.parse(vvPublic_('publication.json'));
      if (receipt.id !== state.snapshot || receipt.digest !== state.digest ||
          vvHash_(vvPublic_('demand.json')) !== receipt.demand || vvHash_(vvPublic_('coordinates.json')) !== receipt.locations) {
        throw Error('Публичные файлы не подтвердили снимок.');
      }
      state.done = true;
      vvSetState_(book, properties, state, 'Карта обновлена');
    } catch (error) {
      if (state.checks < 24 && !result?.conclusion) {
        vvSetState_(book, properties, state, 'Проверяем публикацию повторно');
        vvScheduleStatus_();
        return;
      }
      state.done = true;
      vvSetState_(book, properties, state, 'Ошибка публикации');
      vvLog_(vvTable_(book, 'Автодиагностика', VV_JOURNAL), state.run, {kind: 'Публикация', state: VV_STATUS.critical, why: error.message});
    }
  } finally { lock.releaseLock(); }
}

function vvAcceptAndPublish() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(1000)) { book.toast('Уже выполняется обновление.', 'ВВ Потребность'); return; }
  var properties = PropertiesService.getScriptProperties();
  var previous = vvReadState_(properties);
  var state = {book: book.getId(), run: Utilities.getUuid(), checks: 0, done: false};
  var journal;
  try {
    if (previous.runId && !previous.done) { book.toast(previous.status, 'ВВ Потребность'); return; }
    vvSetState_(book, properties, state, 'Проверка данных');
    journal = vvTable_(book, 'Автодиагностика', VV_JOURNAL);
    var fullSheet = vvSheet_(book, 'HRM FULL');
    var stampCell = properties.getProperty('VV_FULL_TIMESTAMP_CELL');
    var stamp = stampCell ? fullSheet.getRange(stampCell).getValue() : null;
    var now = Date.now();
    var hours = Number(properties.getProperty('VV_FULL_MAX_AGE_HOURS') || 36);
    if (!Number.isFinite(hours) || hours < 1 || hours > 96) throw Error('Укажите предельный возраст FULL от 1 до 96 часов.');
    var latest = Number(properties.getProperty('VV_LAST_SOURCE_TIME') || 0);
    var firstRow = Number(properties.getProperty('VV_FULL_HEADER_ROW') || 1);
    if (!Number.isSafeInteger(firstRow) || firstRow < 1 || firstRow > 20) throw Error('Некорректная строка заголовков FULL.');
    var full = vvCheckRaw_(fullSheet.getDataRange().getValues().slice(firstRow - 1), RAW_HEADERS, now, latest, hours, stamp);
    var rawSheet = vvSheet_(book, 'RAW');
    var staged = vvRawTable_(rawSheet);
    var next = staged.linked ? vvCheckRaw_(staged.values, RAW_HEADERS, now, 0, hours, stamp) : full;
    if (staged.linked && canonical(full.raw) !== canonical(next.raw)) throw Error('Связанный RAW ещё не совпадает с FULL. Проверьте пересчёт и правила отбора.');
    var dictionary = vvSheet_(book, 'Справочник ТТ');
    var dictionaryRows = dictionary.getDataRange().getValues();
    vvColumns_(dictionaryRows[0], ['ID ТТ', 'Тег ТТ', 'Город', 'Адрес']).forEach(function (column, index) {
      if (column !== index) throw Error('Порядок первых четырёх полей отличается от контракта действующего Apps Script.');
    });
    var aliases = vvSheet_(book, 'Сокращения городов').getDataRange().getValues();
    var cities = vvSheet_(book, 'Города').getDataRange().getValues().slice(1).map(function (row) { return row[0]; }).filter(vvCity_);
    var diagnosis = vvDictionaryPlan_(full.entries, dictionaryRows, cities, aliases, pointOf, cityIn);
    vvSetState_(book, properties, state, 'Автоисправление');
    diagnosis.issues.forEach(function (item) { vvLog_(journal, state.run, item); });
    vvWriteDictionary_(dictionary, diagnosis, journal, state.run);
    if (diagnosis.issues.some(function (issue) { return issue.state === VV_STATUS.critical; })) throw Error('Есть критические замечания в «Автодиагностике».');
    var normalized = normalize(next.raw, dictionary.getDataRange().getValues(), aliases, cities);
    var expected = vvMapExpected_(normalized);
    if (canonical(full.raw) !== canonical(vvCheckRaw_(fullSheet.getDataRange().getValues().slice(firstRow - 1), RAW_HEADERS, Date.now(), latest, hours, stamp).raw)) {
      throw Error('FULL изменилась во время проверки. Запустите команду повторно.');
    }
    vvStageRaw_(rawSheet, next.raw, staged);
    refreshDemandCore_();
    var snapshot = vvCheckHistory_(book, next.raw);
    state.snapshot = snapshot.id;
    properties.setProperty('VV_LAST_SOURCE_TIME', String(full.sourceTime));
    vvSetState_(book, properties, state, 'Снимок принят');
    var date = Utilities.formatDate(new Date(full.sourceTime), 'Europe/Moscow', 'dd.MM.yyyy');
    var views = vvViews_(expected, date);
    var geo = vvGeoReview_(book, views.grid, JSON.parse(vvPublic_('coordinates.json')), journal, state.run);
    var summary = views.summary;
    state.digest = vvHash_(summary.signature);
    state.geoDigest = vvHash_(JSON.stringify(geo));
    state.preview = properties.getProperty('VV_DEPLOY_MODE') !== 'deploy';
    if (previous.done && previous.snapshot === state.snapshot && previous.digest === state.digest &&
        previous.geoDigest === state.geoDigest && previous.preview === state.preview &&
        (previous.status === 'Карта обновлена' || previous.status === 'Проверка GitHub Actions завершена')) {
      vvSetState_(book, properties, previous, previous.status);
      return;
    }
    var passport = JSON.stringify({id: snapshot.id, acceptedAt: snapshot.acceptedAt, requestedAt: new Date().toISOString(), sourceDate: date, digest: state.digest,
      metrics: {points: summary.points, roles: summary.roles, deficit: summary.deficit}, geo: geo});
    if (passport.length > 60000) throw Error('Слишком много новых ручных поправок координат для одного выпуска.');
    var dispatch = vvGithub_(properties, 'actions/workflows/publish-demand.yml/dispatches',
      {ref: 'main', inputs: {handoff: passport, mode: state.preview ? 'preview' : 'deploy'}});
    if (!Number.isSafeInteger(dispatch.workflow_run_id)) throw Error('GitHub не вернул ID запуска.');
    state.runId = dispatch.workflow_run_id;
    vvSetState_(book, properties, state, 'Публикация запрошена');
    vvLog_(journal, state.run, {kind: 'Выпуск ' + state.snapshot, after: String(state.runId), source: 'GitHub Actions', state: VV_STATUS.ok});
    vvScheduleStatus_();
  } catch (error) {
    state.done = !state.runId;
    vvSetState_(book, properties, state, state.snapshot && /GitHub|токен/u.test(error.message) ? 'Ошибка публикации' : 'Публикация заблокирована');
    if (journal) vvLog_(journal, state.run, {kind: 'Обновление', state: VV_STATUS.critical, why: error.message});
    book.toast(error.message, 'ВВ Потребность', 12);
  } finally { lock.releaseLock(); }
}
