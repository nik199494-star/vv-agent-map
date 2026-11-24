/* Add alongside the existing normalization/history script and Projection.gs. */
var VV_UPDATE = {
  site: 'https://nik199494-star.github.io/vv-agent-map/',
  api: 'https://api.github.com/repos/nik199494-star/vv-agent-map/',
  workflow: 'actions/workflows/update-demand.yml',
  state: 'VV_UNIFIED_UPDATE_STATE',
  token: 'VV_PREVIEW_DISPATCH_TOKEN'
};

function vvUnifiedOnOpen() {
  var menu = SpreadsheetApp.getUi().createMenu('ВВ Потребность')
    .addItem('Обновить потребность', 'vvUpdateDemand')
    .addItem('Проверить обновление', 'vvCheckDemandUpdate');
  if (PropertiesService.getScriptProperties().getProperty('VV_UNIFIED_READY') !== '1') {
    menu.addSeparator().addItem('Принять RAW (прежняя схема)', 'refreshDemand');
  }
  menu.addToUi();
}

function vvInstallUnifiedUpdate() {
  var book = vvUpdateBook_();
  vvUpdateBookId_('VV_KNOWLEDGE_BOOK_ID'); vvUpdateBookId_('VV_AGENT_BOOK_ID');
  if (typeof refreshDemand !== 'function' || typeof vvProjection_ !== 'function') throw Error('Нет действующей нормализации или Projection.gs.');
  vvUpdateApi_(VV_UPDATE.workflow); // Read-only preflight; no release is started.
  PropertiesService.getScriptProperties().setProperty('VV_UNIFIED_READY', '1');
  ['vvUnifiedOnOpen', 'vvContinueDemandUpdate'].forEach(function (handler) {
    ScriptApp.getProjectTriggers().filter(function (trigger) { return trigger.getHandlerFunction() === handler; })
      .forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  });
  vvUpdateStatus_(book, {message: 'Готово к обновлению. Вставьте свежую FULL-выгрузку в HRM FULL и выберите «Обновить потребность».', stage: 'Готово'});
  vvUnifiedOnOpen();
}

function vvUpdateBook_() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  var id = vvUpdateBookId_('VV_WORK_BOOK_ID');
  if (active && active.getId() !== id) throw Error('Команда доступна только в основной рабочей книге.');
  return active || SpreadsheetApp.openById(id);
}

function vvUpdateBookId_(name) {
  var value = PropertiesService.getScriptProperties().getProperty(name) || '';
  if (!/^[A-Za-z0-9_-]{30,100}$/.test(value)) throw Error('Техническая настройка не завершена: задайте ' + name + '.');
  return value;
}

function vvUpdateHash_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (n) { return ('0' + (n & 255).toString(16)).slice(-2); }).join('');
}

function vvUpdateReadState_() {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty(VV_UPDATE.state) || 'null');
}

function vvUpdateSave_(state) {
  PropertiesService.getScriptProperties().setProperty(VV_UPDATE.state, JSON.stringify(state));
  return state;
}

function vvUpdateStatus_(book, state) {
  var sh = book.getSheetByName('Обновление') || book.insertSheet('Обновление');
  var stamp = state.acceptedAt ? Utilities.formatDate(new Date(state.acceptedAt), 'Europe/Moscow', 'dd.MM.yyyy HH:mm:ss') + ' МСК' : '';
  var rows = [
    ['Обновление потребности', ''], ['Этап', state.stage || ''], ['Результат', state.message || ''],
    ['Данные приняты', stamp], ['Запрос', state.marker || ''], ['Снимок карты', state.id || ''],
    ['Сообщение агентам', state.announcement || 'Пока не отправлять: обновление карты не подтверждено.'],
    ['Карта', VV_UPDATE.site], ['Как обновить', '1. Замените выгрузку на листе HRM FULL целиком, с заголовками. 2. ВВ Потребность → Обновить потребность.'],
    ['Если обработка ещё идёт', 'Дождитесь результата здесь или выберите ВВ Потребность → Проверить обновление.'],
    ['Важно', 'Время выше — принятие данных системой. Дата формирования выгрузки HRM отсутствует в её столбцах.']
  ];
  sh.getRange(1, 1, rows.length, 2).setValues(rows).setWrap(true).setVerticalAlignment('top');
  sh.setColumnWidth(1, 180); sh.setColumnWidth(2, 660);
  sh.getRange('A1:B1').setBackground('#287a35').setFontColor('#ffffff').setFontWeight('bold');
  sh.setFrozenRows(1); sh.autoResizeRows(1, rows.length);
  return state;
}

function vvUpdateFull_(book) {
  var sheet = book.getSheetByName('HRM FULL');
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastRow() >= 1200) throw Error('HRM FULL пуст или достиг предела 1200 строк. Нужна полная выгрузка и проверка диапазонов.');
  var rows = sheet.getDataRange().getValues();
  var cols = vvColumns_(rows[0], ['ID', 'Название', 'Вакансия', 'Кол-во позиций', 'Закрыто позиций', 'Недобор']);
  var ids = new Set();
  rows.slice(1).forEach(function (row, i) {
    if (!row.some(function (v) { return vvText_(v); })) return;
    var id = vvText_(row[cols[0]]);
    if (!id || ids.has(id) || !vvText_(row[cols[1]]) || !vvText_(row[cols[2]])) throw Error('Дубль ID или пустая заявка HRM FULL в строке ' + (i + 2) + '.');
    ids.add(id);
    var counts = cols.slice(3).map(function (c) { return vvNumber_(row[c]); });
    if (counts.some(function (n) { return n === null; }) || counts[0] !== counts[1] + counts[2]) throw Error('Неверный план, факт или недобор HRM FULL, строка ' + (i + 2) + '.');
  });
  if (!ids.size) throw Error('В HRM FULL нет заявок.');
  return vvUpdateHash_(JSON.stringify(rows.map(function (row) { return row.map(function (v) { return v instanceof Date ? v.toISOString() : v; }); })));
}

function vvUpdateControl_(book) {
  var rows = book.getSheetByName('Контроль').getRange('A1:B18').getDisplayValues();
  if (!/^Снимок принят/.test(rows[1][1])) throw Error('Снимок HRM не принят. Исправьте замечания в Контроле.');
  [8, 9, 11, 12, 16, 17].forEach(function (i) {
    if (vvNumber_(rows[i][1]) !== 0) throw Error('Контроль: ' + rows[i][0] + ' = ' + rows[i][1] + '. Обновление остановлено.');
  });
}

function vvUpdateGrid_(book, name, width) {
  var sh = book.getSheetByName(name);
  if (!sh || sh.getLastRow() >= 4999) throw Error('Отсутствует витрина или превышен диапазон ' + name + '.');
  return sh.getRange(1, 1, Math.max(4, sh.getLastRow()), width).getDisplayValues();
}

// Compare business columns across the three existing views, preserving their formulas/layouts.
function vvUpdateCompare_(work, agentPoints, agentCities, bzPoints, bzCities, date) {
  var normalizedWork = work.slice(0, 3).concat(work.slice(4)); // Working header is row 5.
  var core = vvProjection_(normalizedWork, 'core');
  var agent = vvProjection_(agentPoints, 'core');
  var knowledge = vvProjection_(bzPoints, 'core');
  var ac = vvProjection_(agentCities, 'cities'), bc = vvProjection_(bzCities, 'cities');
  if (core.core !== agent.core || core.core !== knowledge.core || core.cities !== ac.cities || core.cities !== bc.cities) {
    throw Error('Витрины ещё не совпали: ожидаем пересчёт точек и городов.');
  }
  [agentPoints, agentCities, bzPoints, bzCities].forEach(function (grid) {
    if (vvProjection_(grid, grid === agentCities || grid === bzCities ? 'cities' : 'core').date !== core.date) {
      throw Error('Витрины ещё не совпали: дата не обновилась.');
    }
  });
  // Check all common published role conditions, not only totals.
  var columns = ['ID ТТ', 'Роль', 'Город', 'Адрес', 'Приоритет', 'Недобор', 'В работе', 'Покрытие воронкой',
    'Доход, ₽/день', 'Средний ₽/заказ', 'Пробег, км/день', 'Возраст', 'График HRM', 'Доп. условия'];
  var signature = function (grid) {
    var ix = vvColumns_(grid[3], columns);
    return JSON.stringify(grid.slice(4).filter(function (r) { return ix.some(function (c) { return vvText_(r[c]); }); })
      .map(function (r) { return JSON.stringify(ix.map(function (c) { return vvText_(r[c]); })); }).sort());
  };
  if (signature(normalizedWork) !== signature(agentPoints) || signature(normalizedWork) !== signature(bzPoints)) {
    throw Error('Витрины ещё не совпали: условия ролей расходятся.');
  }
  var points = agentPoints.map(function (r) { return r.slice(); });
  var cities = agentCities.map(function (r) { return r.slice(); });
  var focus = vvColumns_(points[3], ['Супер фокус'])[0];
  points.slice(4).forEach(function (r) { if (vvText_(r[focus]) === '—') r[focus] = ''; });
  points[2] = ['Данные приняты ' + date + ' · время формирования HRM не указано'];
  cities[2] = points[2].slice();
  var projection = vvProjection_(points, 'agent');
  return {points: points, cities: cities, projection: projection};
}

function vvUpdateViews_(book, state) {
  var agent = SpreadsheetApp.openById(vvUpdateBookId_('VV_AGENT_BOOK_ID')),
    knowledge = SpreadsheetApp.openById(vvUpdateBookId_('VV_KNOWLEDGE_BOOK_ID'));
  return vvUpdateCompare_(vvUpdateGrid_(book, 'Потребность точки v2', 17),
    vvUpdateGrid_(agent, 'Потребность точки', 16), vvUpdateGrid_(agent, 'Потребность города', 13),
    vvUpdateGrid_(knowledge, 'Потребность точки', 16), vvUpdateGrid_(knowledge, 'Потребность города', 13), state.sourceDate);
}

function vvUpdateFreeze_(state, views) {
  var agent = SpreadsheetApp.openById(vvUpdateBookId_('VV_AGENT_BOOK_ID')), p = views.projection;
  var passport = {kind: 'production', sourceDateKind: 'accepted', id: state.id, sourceSnapshotId: state.sourceSnapshotId,
    sourceDate: state.sourceDate, acceptedAt: state.acceptedAt, requestedAt: state.requestedAt, rawDigest: state.rawDigest,
    digest: vvUpdateHash_(p.signature), metrics: {points: p.points, roles: p.roles, deficit: p.deficit}, geo: []};
  var write = function (name, grid, width) {
    var sh = agent.getSheetByName(name) || agent.insertSheet(name);
    if (sh.getMaxRows() < grid.length) sh.insertRowsAfter(sh.getMaxRows(), grid.length - sh.getMaxRows());
    if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
    sh.clearContents();
    sh.getRange(1, 1, grid.length, width).setValues(grid.map(function (row) {
      return Array.from({length: width}, function (_, i) { var v = row[i] == null ? '' : String(row[i]); return /^[=+\-@]/.test(v) ? "'" + v : v; });
    }));
    sh.hideSheet();
  };
  // Commit marker is written last; readers reject a partially replaced projection by digest.
  write('Публикация точки', views.points, 16);
  write('Публикация города', views.cities, 13);
  SpreadsheetApp.flush();
  write('Паспорт публикации', [['Маркер', 'Паспорт'], [state.marker, JSON.stringify(passport)]], 2);
  SpreadsheetApp.flush();
  state.digest = passport.digest; state.metrics = passport.metrics;
}

function vvUpdateApi_(path, body) {
  var token = (PropertiesService.getScriptProperties().getProperty(VV_UPDATE.token) || '').trim();
  if (!/^github_pat_[A-Za-z0-9_-]+$/.test(token)) throw Error('Техническая настройка не завершена: отсутствует токен запуска обновления.');
  var options = {method: body ? 'post' : 'get', muteHttpExceptions: true, followRedirects: false,
    escaping: false,
    headers: {Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10'}};
  if (body) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }
  var response;
  try { response = UrlFetchApp.fetch(VV_UPDATE.api + path, options); }
  catch (_) { throw Error('Связь с GitHub прервалась. Статус отправки проверяется без повторного запуска.'); }
  var status = response.getResponseCode();
  if (status === 204) return {};
  if (status < 200 || status >= 300) { var error = Error('GitHub вернул HTTP ' + status + '. Техническому владельцу нужно проверить настройку.'); error.httpStatus = status; throw error; }
  try { return JSON.parse(response.getContentText()); }
  catch (_) { throw Error('GitHub вернул некорректный ответ.'); }
}

function vvUpdateRunMatches_(run, state) {
  return run && run.event === 'workflow_dispatch' && run.head_branch === 'main' &&
    run.path === '.github/workflows/update-demand.yml' && run.display_title === 'VV update ' + state.marker;
}

function vvUpdateFindRun_(state) {
  var since = new Date(Date.parse(state.requestedAt) - 300000).toISOString();
  var runs = vvUpdateApi_(VV_UPDATE.workflow + '/runs?event=workflow_dispatch&branch=main&per_page=100&created=' + encodeURIComponent('>=' + since));
  if (!Array.isArray(runs.workflow_runs) || runs.total_count !== runs.workflow_runs.length) throw Error('Получен неполный список запусков. Автоповтор остановлен.');
  var matches = runs.workflow_runs.filter(function (r) { return vvUpdateRunMatches_(r, state); });
  if (matches.length > 1) throw Error('Найдено несколько запусков с одним UUID. Требуется техническая проверка.');
  return matches.length ? matches[0].id : null;
}

function vvUpdateSchedule_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'vvContinueDemandUpdate'; });
  if (!exists) ScriptApp.newTrigger('vvContinueDemandUpdate').timeBased().everyMinutes(1).create();
}

function vvUpdateStopSchedule_() {
  ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'vvContinueDemandUpdate'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

function vvUpdateDemand() { return vvUpdateLocked_(true); }
function vvCheckDemandUpdate() { return vvUpdateLocked_(false); }
function vvContinueDemandUpdate() { return vvUpdateLocked_(false); }

function vvUpdateLocked_(start) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  var book, state;
  try {
    book = vvUpdateBook_(); state = vvUpdateReadState_();
    if (state && !state.done) return vvUpdateAdvance_(book, state);
    if (!start) {
      vvUpdateStopSchedule_();
      return vvUpdateStatus_(book, state || {stage: 'Готово', message: 'Обновление ещё не запускалось.'});
    }
    vvUpdateApi_(VV_UPDATE.workflow); // Check configuration before changing the book.
    var rawDigest = vvUpdateFull_(book);
    // Only a script lock is held: refreshDemand has its own document lock.
    SpreadsheetApp.setActiveSpreadsheet(book);
    refreshDemand(); SpreadsheetApp.flush(); vvUpdateControl_(book);
    if (vvUpdateFull_(book) !== rawDigest) throw Error('HRM FULL изменился во время принятия. Повторите обновление после завершения вставки.');
    var now = new Date(), sourceDate = Utilities.formatDate(now, 'Europe/Moscow', 'dd.MM.yyyy');
    if (state && state.success && state.rawDigest === rawDigest && state.sourceDate === sourceDate) {
      var current = vvUpdateViews_(book, state);
      if (vvUpdateHash_(current.projection.signature) === state.digest) return vvUpdateStatus_(book, state);
    }
    var log = book.getSheetByName('Снимки'), sourceSnapshotId = String(log.getRange(log.getLastRow(), 1).getValue());
    state = {marker: Utilities.getUuid(), id: Utilities.getUuid(), sourceSnapshotId: sourceSnapshotId,
      sourceDate: sourceDate, rawDigest: rawDigest, acceptedAt: now.toISOString(), requestedAt: now.toISOString(),
      stage: 'Сверка витрин', message: 'Снимок принят. Проверяем базу знаний и агентскую таблицу.', done: false};
    vvUpdateSave_(state); vvUpdateStatus_(book, state); vvUpdateSchedule_();
    return vvUpdateAdvance_(book, state);
  } catch (error) {
    // Never expose raw network exceptions or credentials in a cell.
    var message = /^GitHub |^Связь с GitHub|^Техническая |^Витрины |^Контроль:|^HRM FULL |^Снимок HRM|^Неверный |^Дубль ID|^В HRM FULL|^Опубликованная карта|^Обновление превысило|^Получен неполный|^Найдено несколько/.test(error.message) ? error.message : 'Обновление остановлено. Техническому владельцу нужно проверить выполнение скрипта.';
    if (book) {
      state = state || {done: true}; state.stage = 'Требуется проверка'; state.message = message;
      state.announcement = ''; vvUpdateSave_(state); vvUpdateStatus_(book, state);
    }
    // Keep an ambiguous dispatch pending; scheduled reads may recover it, never resend it.
    return state;
  } finally { lock.releaseLock(); }
}

function vvUpdateAdvance_(book, state) {
  if (Date.now() - Date.parse(state.requestedAt) > 6 * 3600000) {
    state.done = true; state.message = 'Обновление превысило 6 часов. Карта не подтверждена. Запустите новое обновление.';
    state.stage = 'Не завершено'; vvUpdateStopSchedule_(); vvUpdateSave_(state); return vvUpdateStatus_(book, state);
  }
  if (!state.dispatchAttempted) {
    if (vvUpdateFull_(book) !== state.rawDigest) {
      state.done = true; state.message = 'HRM FULL изменился. Дождитесь завершения вставки и нажмите «Обновить потребность».';
      state.stage = 'Нужен новый снимок'; vvUpdateStopSchedule_(); vvUpdateSave_(state); return vvUpdateStatus_(book, state);
    }
    var views;
    try { views = vvUpdateViews_(book, state); }
    catch (error) {
      if (String(error.message).indexOf('Витрины ещё не совпали') !== 0) throw error;
      state.stage = 'Сверка витрин'; state.message = error.message; vvUpdateSave_(state); return vvUpdateStatus_(book, state);
    }
    vvUpdateFreeze_(state, views);
    var found = vvUpdateFindRun_(state);
    state.runId = found; state.dispatchAttempted = true; state.stage = 'Обновление карты';
    state.message = 'Таблицы сверены. Идёт резервирование, публикация и проверка карты.';
    vvUpdateSave_(state); vvUpdateStatus_(book, state); // Persist BEFORE the non-idempotent POST.
    if (!found) {
      try { vvUpdateApi_(VV_UPDATE.workflow + '/dispatches', {ref: 'main', inputs: {request_id: state.marker}}); }
      catch (error) {
        if ([401, 403, 404, 422, 429].indexOf(error.httpStatus) >= 0) {
          state.done = true; state.stage = 'Не опубликовано'; state.message = error.message; vvUpdateStopSchedule_(); vvUpdateSave_(state);
        }
        throw error;
      }
    }
    return state;
  }
  state.runId = state.runId || vvUpdateFindRun_(state);
  if (!state.runId) { state.message = 'Запрос отправлен. Ожидаем номер запуска, повторно не отправляем.'; vvUpdateSave_(state); return vvUpdateStatus_(book, state); }
  var run = vvUpdateApi_('actions/runs/' + state.runId);
  if (!vvUpdateRunMatches_(run, state) || run.id !== state.runId) throw Error('Найдено несколько или несоответствующий запуск.');
  if (run.status !== 'completed') { state.message = 'Обновление карты выполняется. Можно закрыть таблицу: проверка продолжится автоматически.'; vvUpdateSave_(state); return vvUpdateStatus_(book, state); }
  state.success = false;
  if (run.conclusion !== 'success') {
    state.done = true; vvUpdateStopSchedule_();
    state.stage = 'Карта не подтверждена'; state.message = 'Таблицы сверены, но выпуск карты не завершён. Не отправляйте сообщение агентам. Техническому владельцу: запуск #' + state.runId;
  } else {
    var jobs = vvUpdateApi_('actions/runs/' + state.runId + '/jobs?per_page=100');
    var publish = (jobs.jobs || []).filter(function (j) { return j.name === 'publish'; });
    var steps = publish.length === 1 ? publish[0].steps || [] : [];
    var verified = steps.filter(function (s) { return s.name === 'Опубликовать и сверить 24 файла' && s.conclusion === 'success'; });
    if (jobs.total_count !== (jobs.jobs || []).length || verified.length !== 1) throw Error('Опубликованная карта не подтверждена шагом сверки.');
    var result = UrlFetchApp.fetch(VV_UPDATE.site + 'demand.json?request=' + state.marker, {muteHttpExceptions: true, followRedirects: false});
    var publicSnapshot;
    try { publicSnapshot = result.getResponseCode() === 200 ? JSON.parse(result.getContentText()) : null; } catch (_) {}
    if (!publicSnapshot || publicSnapshot.snapshotId !== state.id || publicSnapshot.sourceDateKind !== 'accepted' || publicSnapshot.acceptedAt !== state.acceptedAt) throw Error('Опубликованная карта не совпала с запросом таблицы.');
    var latest = vvUpdateViews_(book, state);
    if (vvUpdateFull_(book) !== state.rawDigest || vvUpdateHash_(latest.projection.signature) !== state.digest) {
      state.stage = 'Появились новые данные'; state.message = 'Предыдущий снимок опубликован. HRM или условия изменились: нажмите «Обновить потребность» для новых данных.';
    } else {
      state.success = true; state.stage = 'Готово'; state.message = 'Потребность обновлена в базе знаний и на карте. Можно сообщать агентам.';
      state.announcement = 'Потребность обновлена. Данные приняты ' + Utilities.formatDate(new Date(state.acceptedAt), 'Europe/Moscow', 'dd.MM.yyyy HH:mm') + ' МСК. Берите в работу: ' + VV_UPDATE.site + '\nЕсли карта была открыта, нажмите «Обновить». Сверяйте время обновления.';
    }
    state.done = true; vvUpdateStopSchedule_();
  }
  vvUpdateSave_(state); return vvUpdateStatus_(book, state);
}
