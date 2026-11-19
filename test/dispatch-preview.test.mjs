import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {agentHeaders} from '../scripts/agent-data.mjs';
import {readDispatchPassport, runDispatchPreview, validateDispatch} from '../scripts/dispatch-preview.mjs';
import {project, sha256} from '../scripts/projection.mjs';

const uuid = '8b4e7763-b39a-414a-9d31-e35d5b4235bb';
const title = 'VV preview ' + uuid;
const id = 213;
const now = new Date('2026-11-19T08:00:00Z');
const points = [[], [], ['Данные HRM на 19.11.2026'], agentHeaders, [
  'Критичный', 'Нет', 'Москва', '99001', 'Москва, ул. Тестовая, д. 1',
  'Авто-курьер', 'Нет', '4', '0', '0%', '7000', '100', '50', '18', 'День', 'Фултайм',
]];
const cities = [[], [], ['Данные HRM на 19.11.2026'], ['Город', 'Недобор'], ['Москва', '4']];
const view = project(points, 'agent');
const passport = {
  id: 'snapshot-test', acceptedAt: now.toISOString(), requestedAt: now.toISOString(), sourceDate: view.date,
  digest: sha256(view.signature), metrics: {points: view.points, roles: view.roles, deficit: view.deficit}, geo: [],
};
const grid = [['Маркер', 'Паспорт'], [uuid, JSON.stringify(passport)]];
const env = {
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
  VV_PREVIEW_AGENT_ID: 'isolated_agent_workbook_for_test',
};
const input = {ref: 'refs/heads/main', inputs: {mode: 'preview', request_id: uuid}};
const gasCode = readFileSync(new URL('../automation/DispatchPreview.gs', import.meta.url), 'utf8');
const route = '/repos/nik199494-star/vv-agent-map/actions';
const runs = status => ({
  id, event: 'workflow_dispatch', path: '.github/workflows/publish-demand.yml', display_title: title,
  head_branch: 'main', status, conclusion: status === 'completed' ? 'success' : null, run_attempt: 2,
});
const passedJob = {name: 'preview', run_id: id, status: 'completed', conclusion: 'success',
  steps: [{name: 'Сверить испытательный паспорт', status: 'completed', conclusion: 'success'}]};
const listingPath = route + '/workflows/publish-demand.yml/runs';
const jobsPath = route + '/runs/' + id + '/attempts/2/jobs';
const fakePat = ['github', 'pat', 'TEST_ONLY'].join('_');
const fetchScope = 'https://www.googleapis.com/auth/script.external_request';
const list = (...workflow_runs) => ({value: {total_count: workflow_runs.length, workflow_runs}});
const jobs = (...items) => ({value: {total_count: items.length, jobs: items}});

function harness(handle, {allowed = false, token = fakePat, locked = false, externalAccess = true, initialState = null} = {}) {
  const log = [];
  const scopeChecks = [];
  const toasts = [];
  const lookups = [];
  const values = new Map([['VV_PREVIEW_DISPATCH_TOKEN', token],
    ['VV_MAIN_PREVIEW_STATE', JSON.stringify(initialState)]]);
  const properties = {
    getProperty: k => values.get(k) ?? null,
    setProperty: (k, v) => values.set(k, v),
  };
  let row = grid[1];
  const api = runInNewContext(gasCode + '\n({vvDispatchStart_, vvDispatchStatus_, vvStartDispatchPreview, vvConfirmDispatchPreview, vvAddDispatchPreviewMenu_, vvCheckDispatchPreviewConnection})', {
    Date: class extends Date { static now() { return now.getTime(); } },
    LockService: {getScriptLock: () => ({tryLock: () => !locked, releaseLock() {}})},
    ScriptApp: {
      AuthMode: {FULL: 'FULL'},
      AuthorizationStatus: {REQUIRED: 'REQUIRED'},
      getAuthorizationInfo: (mode, scopes) => {
        scopeChecks.push([mode, ...scopes]);
        return {getAuthorizationStatus: () => externalAccess ? 'NOT_REQUIRED' : 'REQUIRED'};
      },
    },
    UrlFetchApp: {fetch: (url, options) => {
      const target = new URL(url);
      const call = {target, path: target.pathname, method: options.method ?? 'get',
        body: options.payload && JSON.parse(options.payload), headers: options.headers, escaping: options.escaping,
        muteHttpExceptions: options.muteHttpExceptions,
        followsRedirects: options.followRedirects};
      log.push(call);
      const {status = 200, value, raw} = handle(call);
      return {getResponseCode: () => status, getContentText: () => raw ?? JSON.stringify(value)};
    }},
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({toast: (message) => toasts.push(message)}),
      openById: book => ({
        getSheetByName: sheet => ({
          getRange: range => ({getValues: () => { lookups.push([book, sheet, range]); return [row]; }}),
        }),
      }),
    },
    PropertiesService: {getScriptProperties: () => properties},
    vvPreviewAssert_: () => {
      if (!allowed) throw Error('Книга вне испытательного контура.');
      return ['work', 'knowledge', 'agent-preview'];
    },
  });
  return {start: (input = row, time = now.getTime()) => api.vvDispatchStart_(properties, input, time),
    check: (time = now.getTime()) => api.vvDispatchStatus_(properties, time),
    startFromBook: api.vvStartDispatchPreview, checkFromBook: api.vvConfirmDispatchPreview,
    checkConnection: api.vvCheckDispatchPreviewConnection, scopeChecks,
    addMenu: api.vvAddDispatchPreviewMenu_, setRow: next => { row = next; }, log, toasts, lookups};
}

test('manual workflow requires main, preview and a UUID before it reads credentials', async () => {
  assert.equal(validateDispatch(input, env), uuid);
  const bad = {...input, inputs: {...input.inputs, mode: 'deploy'}};
  await assert.rejects(runDispatchPreview(bad, env, now, () => assert.fail('Network forbidden')), /режим preview/);
  assert.throws(() => validateDispatch(input, {...env, GITHUB_REF: 'refs/heads/topic'}), /из main/);
  assert.throws(() => validateDispatch({...input, inputs: {request_id: uuid}}, env), /режим preview/);
  assert.throws(() => validateDispatch({...input, inputs: {...input.inputs, handoff: 'unexpected'}}, env), /режим preview/);
  assert.throws(() => readDispatchPassport(grid, uuid.replace('8', '9'), now), /расходится/);
  assert.throws(() => readDispatchPassport(grid, uuid, new Date(now.getTime() + 6*3600000+1)), /просрочен/);
});

test('menu callbacks read the registered agent passport, dispatch UUID only and confirm the exact attempt', async () => {
  let phase = 'queued';
  let sent;
  const h = harness(call => {
    if (call.method === 'post') {
      sent = call.body;
      return {value: {workflow_run_id: id}};
    }
    if (call.path === listingPath) return list();
    if (call.path === jobsPath) return jobs(passedJob);
    return {value: runs(phase)};
  }, {allowed: true});
  const items = [];
  const menu = {addSeparator() { return this; }, addItem(name, callback) { items.push([name, callback]); return this; }};
  assert.equal(h.addMenu(menu), menu);
  assert.deepEqual(items, [['Запустить проверку GitHub', 'vvStartDispatchPreview'],
    ['Проверить результат GitHub', 'vvConfirmDispatchPreview']]);
  assert.equal(h.startFromBook().runId, id);
  assert.deepEqual(h.lookups, [['agent-preview', 'Паспорт preview', 'A2:B2']]);
  assert.deepEqual(sent, {ref: 'main', inputs: {mode: 'preview', request_id: uuid}});
  assert.equal(h.startFromBook().runId, id);
  assert.equal(h.checkFromBook().done, false);
  assert.match(h.toasts.at(-1), /выполняется/);

  const guarded = harness(() => assert.fail('No network in another workbook'));
  assert.throws(guarded.startFromBook, /вне испытательного/);
  assert.throws(guarded.checkFromBook, /вне испытательного/);
  assert.equal(guarded.log.length, 0);

  const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const reader = {client_email: 'fixture@example.invalid', private_key: privateKey.export({type: 'pkcs8', format: 'pem'})};
  const sameRequest = await runDispatchPreview(sent, {...env, VV_PREVIEW_SHEETS_READER: JSON.stringify(reader)}, now,
    async (url, options) => {
      const target = new URL(url);
      if (target.hostname === 'oauth2.googleapis.com') {
        assert.equal(options.method, 'POST');
        return Response.json({access_token: 'fixture-reader'});
      }
      assert.equal(target.hostname, 'sheets.googleapis.com');
      assert.equal(options.headers.authorization, 'Bearer fixture-reader');
      assert.equal(options.method, undefined);
      return Response.json({valueRanges: [{values: points}, {values: cities}, {values: grid}]});
    });
  assert.deepEqual(sameRequest, {sourceDate: '19.11.2026', points: 1, roles: 1, deficit: 4, mapped: 0});
  phase = 'completed';
  assert.equal(h.checkFromBook().verified, true);
  assert.equal(h.toasts.at(-1), 'Испытательный паспорт подтверждён · #' + id);
  assert.deepEqual(h.log.map(call => call.path), [listingPath,
    route + '/workflows/publish-demand.yml/dispatches', route + '/runs/' + id, route + '/runs/' + id,
    route + '/runs/' + id, jobsPath]);
  for (const call of h.log) {
    assert.equal(call.target.hostname, 'api.github.com');
    assert.equal(call.headers['X-GitHub-Api-Version'], '2026-03-10');
    assert.equal(call.followsRedirects, false);
  }
  assert.equal(h.log.filter(call => call.method === 'post').length, 1);
});

test('confirmation rejects foreign runs, skipped or foreign jobs, and missing or unsuccessful passport steps', () => {
  const wrongJobs = {
    skipped: {...passedJob, conclusion: 'skipped', steps: []},
    foreignJob: {...passedJob, run_id: id + 1},
    failedStep: {...passedJob, steps: [{...passedJob.steps[0], conclusion: 'failure'}]},
    missingStep: {...passedJob, steps: []},
  };
  for (const outcome of [...Object.keys(wrongJobs), 'cancelled', 'foreign', 'wrongTitle', 'duplicateJobs', 'wrongId']) {
    const h = harness(call => {
      if (call.method === 'post') return {value: {workflow_run_id: id}};
      if (call.path === listingPath) return list();
      if (call.path === jobsPath) return outcome === 'duplicateJobs' ? jobs(passedJob, passedJob) : jobs(wrongJobs[outcome]);
      const run = runs('completed');
      if (outcome === 'cancelled') run.conclusion = 'cancelled';
      if (outcome === 'foreign') run.head_branch = 'another';
      if (outcome === 'wrongTitle') run.display_title += ' extra';
      if (outcome === 'wrongId') run.id++;
      return {value: run};
    });
    h.start();
    if (['foreign', 'wrongTitle', 'wrongId'].includes(outcome)) assert.throws(h.check, /не соответствует/);
    else assert.equal(h.check().verified, false);
  }
});

test('reconcile uncertain POST responses and recover the same UUID without posting again', () => {
  for (const response of ['timeout', 503, 204, 200, 'invalid-json']) {
    let visible = false;
    const h = harness(call => {
      if (call.method === 'post') {
        if (response === 'timeout') throw Error('private transport error');
        if (response === 'invalid-json') return {raw: 'private malformed response'};
        return {status: response, value: 'private HTTP response'};
      }
      if (call.path === listingPath) return visible ? list(runs('completed')) : list();
      if (call.path === jobsPath) return jobs(passedJob);
      return {value: runs('completed')};
    });
    assert.doesNotMatch(h.start().message, /private/);
    assert.equal(h.start().runId, null);
    assert.match(h.check().message, /пока не найден/);
    visible = true;
    assert.equal(h.check().verified, true);
    assert.equal(h.log.filter(call => call.method === 'post').length, 1);
  }
});

test('a definite authorization error can retry after a fresh lookup and errors never expose response bodies', () => {
  let denied = true;
  const definite = harness(call => {
    if (call.path === listingPath) return list();
    return denied ? {status: 403, value: 'private error body'} : {value: {workflow_run_id: id}};
  });
  assert.throws(definite.start, /^Error: GitHub Actions вернул HTTP 403 \(отправка preview\)\. Проверьте права токена Actions: write/);
  denied = false;
  assert.equal(definite.start().runId, id);
  assert.deepEqual(definite.log.map(call => call.method), ['get', 'post', 'get', 'post']);
  const config = harness(() => assert.fail('No request without a token'), {token: null});
  assert.throws(config.start, /VV_PREVIEW_DISPATCH_TOKEN/);
  assert.equal(config.log.length, 0);
});

test('connection check uses the production-shaped GET query and expected headers without dispatching', () => {
  const h = harness(() => list(), {allowed: true, token: '  ' + fakePat + '\n'});
  assert.equal(h.checkConnection(), 'Связь с GitHub Actions проверена. Запуск preview не отправлялся.');
  assert.deepEqual(h.scopeChecks, [['FULL', fetchScope]]);
  assert.equal(h.log.length, 1);
  const [request] = h.log;
  assert.equal(request.path, listingPath);
  assert.equal(request.method, 'get');
  assert.equal(request.body, undefined);
  assert.equal(request.headers.Authorization, 'Bearer ' + fakePat);
  assert.equal(request.headers.Accept, 'application/vnd.github+json');
  assert.equal(request.escaping, false);
  assert.equal(request.muteHttpExceptions, true);
  assert.equal(request.followsRedirects, false);
  assert.equal(request.target.search, '?event=workflow_dispatch&branch=main&per_page=100&created=%3E%3D2026-11-19T01%3A55%3A00.000Z');
  assert.throws(h.check, /ещё не запрошен/);
  const guarded = harness(() => assert.fail('No request outside the test workbook'));
  assert.throws(guarded.checkConnection, /вне испытательного контура/);
});

test('malformed PAT values and missing OAuth consent are caught before calling UrlFetchApp', () => {
  const noNetwork = () => assert.fail('Request with invalid setup');
  for (const token of ['Bearer ' + fakePat, '"' + fakePat + '"', fakePat + '\r\nInjected: value', 'ghp_INVALID', 'github_pat_']) {
    const h = harness(noNetwork, {token});
    assert.throws(h.start, error => {
      assert.match(error.message, /^\[VV_FETCH_TOKEN\]/);
      assert.doesNotMatch(error.message, /TEST_ONLY|Injected/);
      return true;
    });
    assert.equal(h.log.length, 0);
    assert.equal(h.scopeChecks.length, 0);
  }
  const h = harness(noNetwork, {externalAccess: false});
  assert.throws(h.start, /\[VV_FETCH_OAUTH\].*чтение списка запусков.*script\.external_request/);
  assert.equal(h.log.length, 0);
});

test('transport failures report a safe category and never dispatch when the list GET fails', () => {
  const failures = [
    ['HEADER', 'Invalid argument: Header Authorization contains a line break'],
    ['OAUTH', 'Exception: You do not have permission to call UrlFetchApp.fetch'],
    ['POLICY', 'UrlFetch calls to https://api.github.com are not permitted by your admin'],
    ['ARGUMENT', 'Invalid argument: https://example.invalid/'],
    ['TIMEOUT', 'Request timed out'],
    ['NETWORK', 'SSL certificate validation failed'],
    ['QUOTA', 'Service invoked too many times for one day: urlfetch'],
    ['UNKNOWN', 'Unexpected exception'],
  ];
  for (const [code, message] of failures) {
    const h = harness(() => { throw Error(message + ' confidential-response-marker'); });
    assert.throws(h.start, error => {
      assert.ok(error.message.startsWith('[VV_FETCH_' + code + '] GitHub Actions (чтение списка запусков).'));
      assert.doesNotMatch(error.message, /confidential-response-marker|example\.invalid/);
      return true;
    });
    assert.deepEqual(h.log.map(request => request.method), ['get']);
    assert.throws(h.check, /ещё не запрошен/);
  }
});

test('HTTP rejection from GitHub is separate from UrlFetchApp errors and cannot trigger POST', () => {
  const h = harness(() => ({status: 401, value: 'confidential-response-marker'}));
  assert.throws(h.start, error => {
    assert.equal(error.httpStatus, 401);
    assert.match(error.message, /^GitHub Actions вернул HTTP 401 \(чтение списка запусков\)/);
    assert.doesNotMatch(error.message, /confidential-response-marker/);
    return true;
  });
  assert.deepEqual(h.log.map(request => request.method), ['get']);
});

test('a fresh passport is required for a new dispatch, with a final lookup before retiring an unresolved old one', () => {
  const freshTime = now.getTime() + 6 * 3600000;
  const freshUuid = uuid.replace('8', '9');
  const fresh = [freshUuid, JSON.stringify({...passport, requestedAt: new Date(freshTime).toISOString()})];
  const h = harness(call => call.method === 'post' ? {status: 204} : list());
  assert.throws(() => h.start(grid[1], freshTime), /срок.*истёк/i);
  assert.equal(h.log.length, 0);
  h.start();
  assert.throws(() => h.start(fresh, freshTime - 1), /предыдущего/);
  assert.equal(h.check(freshTime).done, true);
  assert.match(h.start(grid[1], freshTime).message, /истёк/);
  assert.equal(h.start(fresh, freshTime).marker, freshUuid);
  assert.deepEqual(h.log.filter(call => call.method === 'post').map(call => call.body.inputs.request_id), [uuid, freshUuid]);
  assert.equal(h.log[0].target.searchParams.get('created'), '>=2026-11-19T07:55:00.000Z');
});

test('discover pre-existing runs and refuse duplicates or an incomplete lookup before POST', () => {
  const existing = harness(call => {
    if (call.path === listingPath) return list(runs('completed'));
    if (call.path === jobsPath) return jobs(passedJob);
    return {value: runs('completed')};
  });
  assert.equal(existing.start().verified, true);
  assert.ok(existing.log.every(call => call.method === 'get'));
  const duplicate = harness(() => list(runs('completed'), {...runs('queued'), id: id + 1}));
  assert.throws(duplicate.start, /несколько запусков/);
  assert.equal(duplicate.log.length, 1);
  const incomplete = harness(() => ({value: {total_count: 101, workflow_runs: []}}));
  assert.throws(incomplete.start, /неполный список/);
  assert.equal(incomplete.log.length, 1);
  const busy = harness(() => assert.fail('Lock failed before network'), {locked: true});
  assert.throws(busy.start, /обрабатывается/);
  assert.throws(busy.check, /обрабатывается/);
  assert.equal(busy.log.length, 0);
});

test('recover previous script state and retry a failed status lookup without a second dispatch', () => {
  let ready = false;
  const h = harness(call => call.path === jobsPath
    ? (ready ? jobs(passedJob) : {status: 503, value: 'private error detail'})
    : {value: runs('completed')}, {initialState: {marker: uuid, runId: id, done: false}});
  assert.throws(h.check, /^Error: GitHub Actions вернул HTTP 503 \(чтение заданий\)\.$/);
  ready = true;
  assert.equal(h.check().verified, true);
  assert.ok(h.log.every(call => call.method === 'get'));
});

test('a signed passport cannot be substituted or accepted with a failed Sheets read', async () => {
  const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const reader = {client_email: 'fixture@example.invalid', private_key: privateKey.export({type: 'pkcs8', format: 'pem'})};
  const configured = {...env, VV_PREVIEW_SHEETS_READER: JSON.stringify(reader)};
  const exchange = next => async url => new URL(url).hostname === 'oauth2.googleapis.com'
    ? Response.json({access_token: 'test'}) : next();
  await assert.rejects(runDispatchPreview(input, configured, now, exchange(() => new Response(null, {status: 403}))), /Агентская книга вернула HTTP 403/);
  const wrong = {...passport, digest: 'f'.repeat(64)};
  const read = () => Response.json({valueRanges: [{values: points}, {values: cities}, {values: [grid[0], [uuid, JSON.stringify(wrong)]]}]});
  await assert.rejects(runDispatchPreview(input, configured, now, exchange(read)), /не совпали/);
});
