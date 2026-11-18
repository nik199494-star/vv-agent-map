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
  head_branch: 'main', status, conclusion: status === 'completed' ? 'success' : null,
});
const passedJob = {name: 'preview', conclusion: 'success', steps: [{name: 'Сверить испытательный паспорт', conclusion: 'success'}]};

function harness(handle) {
  const log = [];
  const values = new Map([['VV_PREVIEW_DISPATCH_TOKEN', 'test-auth']]);
  const properties = {
    getProperty: k => values.get(k) ?? null,
    setProperty: (k, v) => values.set(k, v),
  };
  const api = runInNewContext(gasCode + '\n({vvDispatchStart_, vvDispatchStatus_, vvStartDispatchPreview})', {
    LockService: {getScriptLock: () => ({tryLock: () => true, releaseLock() {}})},
    UrlFetchApp: {fetch: (url, options) => {
      assert.equal(new URL(url).hostname, 'api.github.com');
      assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
      assert.equal(options.followRedirects, false);
      const call = {path: new URL(url).pathname, method: options.method ?? 'get', body: options.payload && JSON.parse(options.payload)};
      log.push(call);
      const {status = 200, value} = handle(call);
      return {getResponseCode: () => status, getContentText: () => JSON.stringify(value)};
    }},
    SpreadsheetApp: {getActiveSpreadsheet: () => ({})},
    vvPreviewAssert_: () => { throw Error('Книга вне испытательного контура.'); },
  });
  return {start: () => api.vvDispatchStart_(properties, grid[1], now.getTime()),
    check: () => api.vvDispatchStatus_(properties), startFromBook: api.vvStartDispatchPreview, log};
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

test('Apps Script dispatch uses UUID only, follows the exact run and requires the successful verification step', async () => {
  let phase = 'queued';
  let sent;
  const h = harness(call => {
    if (call.method === 'post') {
      assert.equal(call.path, route + '/workflows/publish-demand.yml/dispatches');
      sent = call.body;
      assert.deepEqual(sent, {ref: 'main', inputs: {mode: 'preview', request_id: uuid}});
      return {value: {workflow_run_id: id}};
    }
    if (call.path.endsWith('/jobs')) return {value: {jobs: [passedJob]}};
    assert.equal(call.path, route + '/runs/' + id);
    return {value: runs(phase)};
  });
  assert.throws(h.startFromBook, /вне испытательного/);
  assert.equal(h.log.length, 0);
  assert.equal(h.start().runId, id);
  assert.equal(h.start().runId, id);
  assert.equal(h.check().done, false);

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
  assert.equal(h.check().verified, true);
  assert.equal(h.log.filter(call => call.method === 'post').length, 1);
});

test('terminal status does not mistake skipped jobs, cancelled runs or foreign runs for verification', () => {
  for (const outcome of ['skipped', 'cancelled', 'foreign']) {
    const h = harness(call => {
      if (call.method === 'post') return {value: {workflow_run_id: id}};
      if (call.path.endsWith('/jobs')) return {value: {jobs: [{...passedJob, conclusion: 'skipped', steps: []}]}};
      const run = runs('completed');
      if (outcome === 'cancelled') run.conclusion = 'cancelled';
      if (outcome === 'foreign') run.head_branch = 'another';
      return {value: run};
    });
    h.start();
    if (outcome === 'foreign') assert.throws(h.check, /не соответствует/);
    else assert.equal(h.check().verified, false);
  }
});

test('recover an ambiguous dispatch without posting twice and retry a definite denied request', () => {
  const ambiguous = harness(call => {
    if (call.method === 'post') return {status: 503, value: 'private error body'};
    if (call.path.endsWith('/workflows/publish-demand.yml/runs')) return {value: {workflow_runs: [{id, display_title: title}]}};
    if (call.path.endsWith('/jobs')) return {value: {jobs: [passedJob]}};
    return {value: runs('completed')};
  });
  assert.throws(ambiguous.start, /^Error: GitHub Actions вернул HTTP 503\.$/);
  assert.equal(ambiguous.start().runId, null);
  assert.equal(ambiguous.check().verified, true);
  assert.equal(ambiguous.log.filter(call => call.method === 'post').length, 1);

  let denied = true;
  const definite = harness(() => denied ? {status: 403, value: 'private error body'} : {value: {workflow_run_id: id}});
  assert.throws(definite.start, /^Error: GitHub Actions вернул HTTP 403\.$/);
  denied = false;
  assert.equal(definite.start().runId, id);
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
