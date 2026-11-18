import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {makePreviewCode} from '../scripts/build-preview-apps-script.mjs';
import {verifyPreviewPush} from '../scripts/check-preview-push.mjs';
import {assembleFixture, assertPreviewId, fixtureViews, parseRequest, productionBooks, runPreview} from '../scripts/preview.mjs';
import {project, sha256} from '../scripts/projection.mjs';
import {metrics} from '../scripts/release.mjs';

const json = async name => JSON.parse(await readFile(new URL('../' + name, import.meta.url), 'utf8'));
const previewId = 'staging_agent_workbook_id_for_unit_test';
const marker = '02d849cd-88d0-4936-acc4-245811a1a21b';
const sheets = {mode: 'sheets', requestId: marker};
const branch = {GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/codex/demand-pipeline', GITHUB_EVENT_NAME: 'push'};

test('preview rebuilds historical demand and preserves distinct TTs and deficit', async () => {
  const baseline = await json('demand.json');
  const result = assembleFixture(baseline, await json('coordinates.json'));
  assert.deepEqual(metrics(result.snapshot.points), metrics(baseline.points));
  assert.equal(new Set(result.snapshot.points.map(point => point.id)).size, result.totals.points);
  assert.equal(result.snapshot.sourceDate, baseline.sourceDate);
});

test('staging gates reject production references, extra request fields and a main run before fetching', async () => {
  for (const id of productionBooks) assert.throws(() => assertPreviewId(id), /отдельной/);
  assert.throws(() => parseRequest({...sheets, payload: 'private'}), /Некорректный/);
  const unexpectedFetch = () => assert.fail('Unexpected external call');
  await assert.rejects(runPreview(sheets, {...branch, GITHUB_REF: 'refs/heads/main'}, unexpectedFetch), /только при push/);
  await assert.rejects(runPreview(sheets, {...branch, GITHUB_EVENT_NAME: 'pull_request'}, unexpectedFetch), /только при push/);
  await assert.rejects(runPreview(sheets, {...branch, VV_PREVIEW_AGENT_ID: previewId}, unexpectedFetch), /отсутствует ключ/);
});

test('staging integrates OAuth, the two Sheet views and sealed passport without public data logs', async () => {
  const baseline = await json('demand.json');
  const [points, cities] = fixtureViews(baseline);
  const view = project(points, 'agent');
  const passport = {
    id: 'staging-accepted-123456', acceptedAt: baseline.publishedAt, requestedAt: baseline.publishedAt,
    sourceDate: view.date, digest: sha256(view.signature), metrics: metrics(baseline.points), geo: [],
  };
  const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048, privateKeyEncoding: {type: 'pkcs8', format: 'pem'},
    publicKeyEncoding: {type: 'spki', format: 'pem'}});
  const env = {...branch, VV_PREVIEW_AGENT_ID: previewId,
    VV_PREVIEW_SHEETS_READER: JSON.stringify({client_email: 'test@example.invalid', private_key: privateKey})};
  let publishedMarker = marker;
  let publishedPassport = passport;
  let sheetsStatus = 200;
  const calls = [];
  const fetcher = async (url, options) => {
    const endpoint = new URL(url);
    calls.push(endpoint.hostname);
    if (endpoint.hostname === 'oauth2.googleapis.com') return Response.json({access_token: 'fake-test-token'});
    assert.equal(endpoint.hostname, 'sheets.googleapis.com');
    assert.match(endpoint.pathname, new RegExp(previewId));
    assert.equal(options.headers.authorization, 'Bearer fake-test-token');
    assert.ok(endpoint.searchParams.getAll('ranges').includes("'Паспорт preview'!A1:B2"));
    if (sheetsStatus !== 200) return new Response('private error body', {status: sheetsStatus});
    const values = [points, cities, [['Маркер', 'Паспорт'], [publishedMarker, JSON.stringify(publishedPassport)]]];
    return Response.json({valueRanges: values.map(values => ({values}))});
  };
  const logs = [];
  const now = new Date(passport.requestedAt);
  const failLog = () => assert.fail('Unexpected log');
  await runPreview(sheets, env, fetcher, value => logs.push(value), now);
  assert.deepEqual(calls, ['oauth2.googleapis.com', 'sheets.googleapis.com']);
  assert.deepEqual(logs, ['Испытательная витрина, маркер и результаты расчёта совпали.']);
  publishedMarker = 'stale';
  await assert.rejects(runPreview(sheets, env, fetcher, failLog, now), /расходится с паспортом/);
  publishedMarker = marker;
  publishedPassport = {...passport, sourceDate: 'не дата'};
  await assert.rejects(runPreview(sheets, env, fetcher, failLog, now), /Некорректный паспорт/);
  publishedPassport = {...passport, metrics: {...passport.metrics, points: passport.metrics.points + 1}};
  await assert.rejects(runPreview(sheets, env, fetcher, failLog, now), /не совпали/);
  publishedPassport = passport;
  await assert.rejects(runPreview(sheets, env, fetcher, failLog, new Date(+now + 7 * 3_600_000)), /просрочен/);
  sheetsStatus = 503;
  await assert.rejects(runPreview(sheets, env, fetcher, failLog, now), /HTTP 503/);
});

test('GitHub preview refuses reruns, unchanged requests and reused markers', () => {
  verifyPreviewPush(marker, [['new', marker], ['old', 'previous']], 'new', '1');
  assert.throws(() => verifyPreviewPush(marker, [['new', marker]], 'new', '2'), /повторный/);
  assert.throws(() => verifyPreviewPush(marker, [['old', marker]], 'new', '1'), /повторный/);
  assert.throws(() => verifyPreviewPush(marker, [['new', marker], ['old', marker]], 'new', '1'), /повторный/);
});

test('compiled preview blocks installation hooks on a production workbook and has no deployment call', async () => {
  const files = Object.fromEntries(await Promise.all(['Projection','Diagnostics','HrmExport','Geocontrol','DemandPipeline','Preview'].map(async name =>
    [name, await readFile(new URL('../automation/' + name + '.gs', import.meta.url), 'utf8')])));
  const legacy = "/** @OnlyCurrentDoc */\nfunction onOpen(){SpreadsheetApp.getUi().createMenu('ВВ Потребность').addItem('Принять RAW и сохранить снимок','refreshDemand').addToUi();}\n" +
    "function onEdit(e){writes++;}\nfunction refreshDemand(){\n var lock=LockService.getDocumentLock();if(!lock.tryLock(1000))return;\n" +
    " try{writes++;}catch(err){throw err;}finally{lock.releaseLock();}\n}\n" +
    "function pointOf(id,tag){return [id,tag];}\nfunction normalize(dict,p,r){return [dict.find(d=>clean(d[0])===p[0]&&p[0]),dict.find(d=>clean(d[0])===r[3])];}\n";
  const compiled = makePreviewCode(legacy, files, {});
  assert.doesNotMatch(compiled, /UrlFetchApp|workflow_dispatch|VV_GITHUB_ACTIONS_TOKEN/);
  assert.match(compiled, /vvCheckPreviewFull_\(fullSheet\.getDataRange\(\)/);
  const book = {getId: () => [...productionBooks][0]};
  const context = {SpreadsheetApp: {getActiveSpreadsheet: () => book}, PropertiesService: {getScriptProperties: () => ({getProperty: () => ''})}, writes: 0};
  runInNewContext(compiled + '\nonOpen();onEdit({source: SpreadsheetApp.getActiveSpreadsheet()});refreshDemand();', context);
  assert.equal(context.writes, 0);
});
