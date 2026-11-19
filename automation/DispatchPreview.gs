var VV_DISPATCH_STATE = 'VV_MAIN_PREVIEW_STATE';
var VV_DISPATCH_WORKFLOW = 'actions/workflows/publish-demand.yml';
var VV_DISPATCH_ENDPOINT = 'https://api.github.com/repos/nik199494-star/vv-agent-map/';

function vvDispatchPreviewRequest_(properties, path, body) {
  var token = properties.getProperty('VV_PREVIEW_DISPATCH_TOKEN');
  if (!token) throw Error('В испытательном проекте отсутствует токен Apps Script для запуска проверки.');
  var options = {
    headers: {Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10'},
    followRedirects: false,
    muteHttpExceptions: true
  };
  if (body) {
    options.method = 'post';
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }
  var result;
  try { result = UrlFetchApp.fetch(VV_DISPATCH_ENDPOINT + path, options); }
  catch (_) { throw Error('GitHub Actions недоступен. Проверьте статус запроса перед повтором.'); }
  var status = result.getResponseCode();
  if (status !== 200) {
    var error = Error('GitHub Actions вернул HTTP ' + status + '.');
    error.httpStatus = status;
    throw error;
  }
  try { return JSON.parse(result.getContentText()); }
  catch (_) { throw Error('GitHub Actions вернул некорректный ответ.'); }
}

function vvStartDispatchPreview() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var ids = vvPreviewAssert_(book);
  var agent = SpreadsheetApp.openById(ids[2]);
  var passport = agent.getSheetByName('Паспорт preview');
  if (!passport) throw Error('Создайте испытательный паспорт в меню ВВ Preview.');
  var row = passport.getRange('A2:B2').getValues()[0];
  var report = vvDispatchStart_(PropertiesService.getScriptProperties(), row, Date.now());
  book.toast(report.message, 'GitHub preview', 10);
  return report;
}

function vvConfirmDispatchPreview() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  vvPreviewAssert_(book);
  var report = vvDispatchStatus_(PropertiesService.getScriptProperties());
  book.toast(report.message, 'GitHub preview', 10);
  return report;
}

function vvDispatchReadState_(properties) {
  return JSON.parse(properties.getProperty(VV_DISPATCH_STATE) || 'null');
}

function vvDispatchSave_(properties, state) {
  properties.setProperty(VV_DISPATCH_STATE, JSON.stringify(state));
  return state;
}

function vvDispatchStart_(properties, passportRow, now) {
  var marker = String(passportRow[0] || '');
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(marker)) throw Error('Некорректный маркер испытательного паспорта.');
  var passport;
  try { passport = JSON.parse(passportRow[1]); }
  catch (_) { throw Error('Некорректный испытательный паспорт.'); }
  var age = now - Date.parse(passport && passport.requestedAt);
  if (!Number.isFinite(age) || age < -5 * 60000 || age > 6 * 3600000) throw Error('Срок испытательного паспорта истёк.');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw Error('Другой запрос preview уже обрабатывается.');
  try {
    var current = vvDispatchReadState_(properties);
    if (current && current.marker === marker && !current.rejected) return current;
    if (current && !current.done) throw Error('Сначала подтвердите статус предыдущего preview.');
    if (!properties.getProperty('VV_PREVIEW_DISPATCH_TOKEN')) throw Error('В испытательном проекте отсутствует токен Apps Script для запуска проверки.');
    var state = vvDispatchSave_(properties, {marker: marker, runId: null, done: false,
      message: 'Запрос отправляется. Если номер запуска не получен, проверьте статус.'});
    var dispatched;
    try {
      dispatched = vvDispatchPreviewRequest_(properties, VV_DISPATCH_WORKFLOW + '/dispatches',
        {ref: 'main', inputs: {mode: 'preview', request_id: marker}});
    } catch (error) {
      if ([401, 403, 404, 422].includes(error.httpStatus)) {
        state.done = true;
        state.rejected = true;
        state.message = error.message;
        vvDispatchSave_(properties, state);
      }
      throw error;
    }
    if (!Number.isSafeInteger(dispatched.workflow_run_id) || dispatched.workflow_run_id <= 0) {
      throw Error('GitHub не вернул номер запуска. Выполните проверку статуса.');
    }
    state.runId = dispatched.workflow_run_id;
    state.message = 'Проверка GitHub Actions запрошена · #' + state.runId;
    return vvDispatchSave_(properties, state);
  } finally { lock.releaseLock(); }
}

function vvDispatchStatus_(properties) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw Error('Другой запрос preview уже обрабатывается.');
  try {
    var state = vvDispatchReadState_(properties);
    if (!state) throw Error('Запуск preview ещё не запрошен.');
    if (state.done) return state;
    var title = 'VV preview ' + state.marker;
    if (state.runId === null) {
      var listing = vvDispatchPreviewRequest_(properties, VV_DISPATCH_WORKFLOW + '/runs?event=workflow_dispatch&branch=main&per_page=30');
      var matches = listing.workflow_runs.filter(function (run) { return run.display_title === title; });
      if (matches.length > 1) throw Error('GitHub вернул несколько запусков с этим маркером.');
      if (matches.length === 0) return state;
      if (!Number.isSafeInteger(matches[0].id) || matches[0].id <= 0) throw Error('Некорректный номер запуска в GitHub.');
      state.runId = matches[0].id;
      vvDispatchSave_(properties, state);
    }
    var result = vvDispatchPreviewRequest_(properties, 'actions/runs/' + state.runId);
    if (result.id !== state.runId || result.event !== 'workflow_dispatch' || result.head_branch !== 'main' ||
        result.path !== '.github/workflows/publish-demand.yml' || result.display_title !== title) {
      throw Error('GitHub вернул запуск, который не соответствует этому запросу.');
    }
    if (result.status !== 'completed') {
      state.message = 'Проверка GitHub Actions выполняется · #' + state.runId;
      return vvDispatchSave_(properties, state);
    }
    var confirmed = false;
    if (result.conclusion === 'success') {
      var jobList = vvDispatchPreviewRequest_(properties, 'actions/runs/' + state.runId + '/jobs?filter=latest&per_page=100');
      confirmed = jobList.jobs.some(function (job) {
        return job.name === 'preview' && job.conclusion === 'success' && job.steps.some(function (step) {
          return step.name === 'Сверить испытательный паспорт' && step.conclusion === 'success';
        });
      });
    }
    state.done = true;
    state.verified = confirmed;
    state.message = (confirmed ? 'Испытательный паспорт подтверждён' : 'Испытательный паспорт не подтверждён') + ' · #' + state.runId;
    return vvDispatchSave_(properties, state);
  } finally { lock.releaseLock(); }
}
