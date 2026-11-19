var VV_DISPATCH_STATE = 'VV_MAIN_PREVIEW_STATE';
var VV_DISPATCH_WORKFLOW = 'actions/workflows/publish-demand.yml';
var VV_DISPATCH_ENDPOINT = 'https://api.github.com/repos/nik199494-star/vv-agent-map/';
var VV_DISPATCH_EXTERNAL_SCOPE = 'https://www.googleapis.com/auth/script.external_request';
var VV_DISPATCH_MAX_AGE = 6 * 3600000;
var VV_DISPATCH_CLOCK_SKEW = 5 * 60000;

function vvAddDispatchPreviewMenu_(menu) {
  return menu.addSeparator()
    .addItem('Запустить проверку GitHub', 'vvStartDispatchPreview')
    .addItem('Проверить результат GitHub', 'vvConfirmDispatchPreview');
}

function vvDispatchFetchError_(cause, operation) {
  // Исключение UrlFetchApp может содержать URL или заголовок. Наружу выходят только фиксированные сообщения.
  var detail = String(cause && cause.message || '');
  var code = 'VV_FETCH_UNKNOWN';
  var hint = 'UrlFetchApp завершился до получения HTTP-ответа. Проверьте подключение и повторите проверку связи.';
  if (/not permitted by your admin|not allowed by your admin|allowlist|whitelist|запрещ[её]н[оа]? администратором/i.test(detail)) {
    code = 'VV_FETCH_POLICY';
    hint = 'Политика Google запрещает запрос к api.github.com. Попросите администратора Google Workspace проверить разрешённые внешние URL.';
  } else if (/script\.external_request|required permissions|you do not have permission to call|authorization is required|invalid scope|oauth scope|необходима авторизация|недостаточно разрешений/i.test(detail)) {
    code = 'VV_FETCH_OAUTH';
    hint = 'Google не подтвердил разрешение script.external_request. Проверьте OAuth-область и подтвердите внешний доступ для испытательного проекта.';
  } else if (/invalid (?:http )?header|(?:header|authorization).*(?:line break|invalid|illegal|not allowed)|(?:invalid argument|illegal character).*(?:header|authorization)/i.test(detail)) {
    code = 'VV_FETCH_HEADER';
    hint = 'Google отклонил HTTP-заголовок. Проверьте, что VV_PREVIEW_DISPATCH_TOKEN содержит только fine-grained PAT.';
  } else if (/invalid argument|invalid url|malformed url|unsupported protocol|недопустимый (?:аргумент|url)/i.test(detail)) {
    code = 'VV_FETCH_ARGUMENT';
    hint = 'Google отклонил URL или параметры запроса. Проверьте, что установлена актуальная версия DispatchPreview.gs.';
  } else if (/quota|invoked too many times|service using too much computer time|превышен[ао]? квот/i.test(detail)) {
    code = 'VV_FETCH_QUOTA';
    hint = 'Google ограничил вызовы UrlFetchApp. Повторите проверку после восстановления квоты.';
  } else if (/timeout|timed out|deadline exceeded|тайм-аут|время ожидания/i.test(detail)) {
    code = 'VV_FETCH_TIMEOUT';
    hint = 'Google не дождался ответа от GitHub. Повторите проверку связи позже.';
  } else if (/dns|address unavailable|could not resolve|connection|socket|ssl|tls|certificate|network|соединен|сертификат/i.test(detail)) {
    code = 'VV_FETCH_NETWORK';
    hint = 'Google не смог установить соединение с api.github.com. Проверьте доступность GitHub и повторите проверку связи.';
  }
  return Error('[' + code + '] GitHub Actions (' + operation + '). ' + hint);
}

function vvDispatchPreviewRequest_(properties, path, operation, body) {
  var token = (properties.getProperty('VV_PREVIEW_DISPATCH_TOKEN') || '').trim();
  if (!token) throw Error('[VV_FETCH_TOKEN] Укажите VV_PREVIEW_DISPATCH_TOKEN в свойствах испытательного проекта.');
  if (!/^github_pat_[A-Za-z0-9_-]+$/.test(token)) {
    throw Error('[VV_FETCH_TOKEN] В VV_PREVIEW_DISPATCH_TOKEN нужен fine-grained PAT без кавычек, префикса Bearer и переносов внутри значения.');
  }
  var options = {
    headers: {Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10'},
    method: body ? 'post' : 'get',
    // Параметры URL кодируются при построении запроса.
    escaping: false,
    followRedirects: false,
    muteHttpExceptions: true
  };
  if (body) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }
  var result;
  try {
    result = UrlFetchApp.fetch(VV_DISPATCH_ENDPOINT + path, options);
  } catch (cause) {
    throw vvDispatchFetchError_(cause, operation);
  }
  var status = result.getResponseCode();
  if (body && status === 204) return {};
  if (status !== 200) {
    var hints = {
      401: ' Проверьте срок и действительность токена.',
      403: ' Проверьте права токена Actions: write и ограничения репозитория.',
      404: ' Проверьте доступ токена к репозиторию и наличие publish-demand.yml в main.',
      422: ' Проверьте параметры workflow и при необходимости создайте новый паспорт.',
      429: ' Лимит запросов исчерпан. Повторите проверку позже.'
    };
    var error = Error('GitHub Actions вернул HTTP ' + status + ' (' + operation + ').' + (hints[status] || ''));
    error.httpStatus = status;
    throw error;
  }
  try { return JSON.parse(result.getContentText()); }
  catch (_) { throw Error('GitHub Actions вернул некорректный JSON (' + operation + ').'); }
}

function vvDispatchAuthorizedBook_() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var ids = vvPreviewAssert_(book);
  // Apps Script ends this execution and opens the consent prompt if the scope is missing.
  ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, [VV_DISPATCH_EXTERNAL_SCOPE]);
  return {book: book, ids: ids};
}

function vvCheckDispatchPreviewConnection() {
  var book = vvDispatchAuthorizedBook_().book;
  vvDispatchListRuns_(PropertiesService.getScriptProperties(), Date.now() - VV_DISPATCH_MAX_AGE);
  var message = 'Связь с GitHub Actions проверена. Запуск preview не отправлялся.';
  book.toast(message, 'GitHub preview', 10);
  console.info(message);
  return message;
}

function vvStartDispatchPreview() {
  var context = vvDispatchAuthorizedBook_();
  var agent = SpreadsheetApp.openById(context.ids[2]);
  var passport = agent.getSheetByName('Паспорт preview');
  if (!passport) throw Error('Создайте испытательный паспорт в меню ВВ Preview.');
  var row = passport.getRange('A2:B2').getValues()[0];
  var report = vvDispatchStart_(PropertiesService.getScriptProperties(), row, Date.now());
  context.book.toast(report.message, 'GitHub preview', 10);
  return report;
}

function vvConfirmDispatchPreview() {
  var book = vvDispatchAuthorizedBook_().book;
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

function vvDispatchMatches_(run, marker) {
  return run && run.event === 'workflow_dispatch' && run.head_branch === 'main' &&
    run.path === '.github/workflows/publish-demand.yml' && run.display_title === 'VV preview ' + marker;
}

function vvDispatchListRuns_(properties, since) {
  var query = '/runs?event=workflow_dispatch&branch=main&per_page=100';
  if (Number.isFinite(since)) {
    query += '&created=' + encodeURIComponent('>=' + new Date(since - VV_DISPATCH_CLOCK_SKEW).toISOString());
  }
  var listing = vvDispatchPreviewRequest_(properties, VV_DISPATCH_WORKFLOW + query, 'чтение списка запусков');
  if (!listing || !Array.isArray(listing.workflow_runs) || listing.total_count !== listing.workflow_runs.length) {
    throw Error('GitHub вернул неполный список запусков. Проверьте Actions вручную.');
  }
  return listing.workflow_runs;
}

function vvDispatchFindRun_(properties, state) {
  var matches = vvDispatchListRuns_(properties, state.requestedAt).filter(function (run) {
    return run && run.display_title === 'VV preview ' + state.marker;
  });
  if (matches.length > 1) throw Error('В Actions несколько запусков с этим UUID. Сверьте их вручную.');
  if (matches.length === 0) return null;
  var run = matches[0];
  if (!vvDispatchMatches_(run, state.marker) || !Number.isSafeInteger(run.id) || run.id <= 0) {
    throw Error('Найденный запуск GitHub не соответствует испытательному запросу.');
  }
  return run.id;
}

function vvDispatchStart_(properties, passportRow, now) {
  var marker = String(passportRow[0] || '');
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(marker)) {
    throw Error('Некорректный UUID в Паспорте preview!A2. Создайте новый паспорт.');
  }
  var passport;
  try { passport = JSON.parse(passportRow[1]); }
  catch (_) { throw Error('Некорректный испытательный паспорт. Создайте новый в меню ВВ Preview.'); }
  var requestedAt = Date.parse(passport && passport.requestedAt);
  var age = now - requestedAt;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw Error('Другой запрос preview обрабатывается. Проверьте результат чуть позже.');
  try {
    var current = vvDispatchReadState_(properties);
    if (current && current.marker === marker && !current.rejected) {
      if (!Number.isFinite(current.requestedAt) && Number.isFinite(age) && age >= -VV_DISPATCH_CLOCK_SKEW) {
        current.requestedAt = requestedAt;
        vvDispatchSave_(properties, current);
      }
      return vvDispatchCheck_(properties, current, now);
    }
    if (!Number.isFinite(age) || age < -VV_DISPATCH_CLOCK_SKEW || age >= VV_DISPATCH_MAX_AGE) {
      throw Error('Срок испытательного паспорта истёк или его время некорректно. Создайте новый паспорт.');
    }
    if (current && !current.done && !vvDispatchCheck_(properties, current, now).done) {
      throw Error('Сначала завершите проверку предыдущего preview через пункт «Проверить результат GitHub».');
    }
    var state = {marker: marker, requestedAt: requestedAt, runId: null, done: false,
      message: 'Номер запуска ещё не получен. Выберите «Проверить результат GitHub».'};
    state.runId = vvDispatchFindRun_(properties, state);
    if (state.runId !== null) {
      vvDispatchSave_(properties, state);
      return vvDispatchCheck_(properties, state, now);
    }
    // Записываем состояние до запроса. Оно переживёт тайм-аут или остановку выполнения.
    vvDispatchSave_(properties, state);
    var dispatched;
    try {
      dispatched = vvDispatchPreviewRequest_(properties, VV_DISPATCH_WORKFLOW + '/dispatches', 'отправка preview',
        {ref: 'main', inputs: {mode: 'preview', request_id: marker}});
    } catch (error) {
      if ([401, 403, 404, 422, 429].includes(error.httpStatus)) {
        state.done = true;
        state.rejected = true;
        state.message = error.message;
        vvDispatchSave_(properties, state);
        throw error;
      }
      state.message = error.message + ' Статус отправки неизвестен. Выберите «Проверить результат GitHub».';
      return vvDispatchSave_(properties, state);
    }
    if (!dispatched || !Number.isSafeInteger(dispatched.workflow_run_id) || dispatched.workflow_run_id <= 0) return state;
    state.runId = dispatched.workflow_run_id;
    state.message = 'Проверка GitHub Actions запрошена · #' + state.runId;
    return vvDispatchSave_(properties, state);
  } finally { lock.releaseLock(); }
}

function vvDispatchStatus_(properties, now) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw Error('Другой запрос preview обрабатывается. Проверьте результат чуть позже.');
  try {
    var state = vvDispatchReadState_(properties);
    if (!state) throw Error('Запуск preview ещё не запрошен.');
    return vvDispatchCheck_(properties, state, now === undefined ? Date.now() : now);
  } finally { lock.releaseLock(); }
}

function vvDispatchCheck_(properties, state, now) {
  if (state.rejected || (state.done && state.runId === null)) return state;
  if (state.runId === null) {
    state.runId = vvDispatchFindRun_(properties, state);
    if (state.runId === null) {
      state.done = Number.isFinite(state.requestedAt) && now - state.requestedAt >= VV_DISPATCH_MAX_AGE;
      state.message = state.done
        ? 'Срок паспорта истёк, запуск с этим UUID не найден. Создайте новый паспорт.'
        : 'Запуск с этим UUID пока не найден. Проверьте результат позже.';
      return vvDispatchSave_(properties, state);
    }
    vvDispatchSave_(properties, state);
  }
  if (!Number.isSafeInteger(state.runId) || state.runId <= 0) throw Error('Некорректный номер запуска в GitHub.');
  var path = 'actions/runs/' + state.runId;
  var result = vvDispatchPreviewRequest_(properties, path, 'чтение запуска');
  if (!vvDispatchMatches_(result, state.marker) || result.id !== state.runId) {
    throw Error('GitHub вернул запуск, который не соответствует этому запросу.');
  }
  if (result.status !== 'completed') {
    state.done = false;
    state.verified = false;
    state.message = 'Проверка GitHub Actions выполняется · #' + state.runId;
    return vvDispatchSave_(properties, state);
  }

  var confirmed = false;
  if (result.conclusion === 'success') {
    if (!Number.isSafeInteger(result.run_attempt) || result.run_attempt <= 0) {
      throw Error('GitHub не вернул номер попытки запуска.');
    }
    var jobList = vvDispatchPreviewRequest_(properties, path + '/attempts/' + result.run_attempt + '/jobs?per_page=100', 'чтение заданий');
    if (!jobList || !Array.isArray(jobList.jobs) || jobList.total_count !== jobList.jobs.length) {
      throw Error('GitHub вернул неполный список заданий. Проверьте результат позже.');
    }
    var jobs = jobList.jobs.filter(function (job) { return job && job.name === 'preview'; });
    if (jobs.length === 1) {
      var job = jobs[0];
      var steps = Array.isArray(job.steps) ? job.steps.filter(function (step) {
        return step && step.name === 'Сверить испытательный паспорт';
      }) : [];
      confirmed = job.run_id === state.runId && job.status === 'completed' && job.conclusion === 'success' &&
        steps.length === 1 && steps[0].status === 'completed' && steps[0].conclusion === 'success';
    }
  }
  state.done = true;
  state.verified = confirmed;
  state.message = (confirmed ? 'Испытательный паспорт подтверждён' : 'Испытательный паспорт не подтверждён') + ' · #' + state.runId;
  return vvDispatchSave_(properties, state);
}
