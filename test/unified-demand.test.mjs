import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {generateKeyPairSync} from 'node:crypto';
import test from 'node:test';
import {assets} from '../build.mjs';
import {buildDemandPackage} from '../scripts/demand-package.mjs';
import {demandPackageFixture} from '../scripts/demand-package-fixture.mjs';
import {productionRequest, productionPassport, pendingAddressChanges, productionRanges, readProductionInput} from '../scripts/production-input.mjs';
import {publishDaily, waitForPublication, assertDailyFiles, updateDemand} from '../scripts/update-demand.mjs';
import {project, sha256} from '../scripts/projection.mjs';
import {sourceLabel, validateSnapshot} from '../source.js';

async function productionFixture() {
  const f = await demandPackageFixture();
  const passport = {...f.passport, kind: 'production', sourceDateKind: 'accepted', sourceSnapshotId: f.passport.id,
    rawDigest: 'f'.repeat(64), geo: []};
  const input = {...f.input, passportGrid: [['Маркер', 'Паспорт'], [f.request.request_id, JSON.stringify(passport)]]};
  return {...f, passport, input};
}

test('only a UUID from main can request production; stale or trial passports fail', async () => {
  const f = await productionFixture();
  const env = {GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main'};
  const event = {ref: 'main', inputs: {request_id: f.request.request_id}};
  assert.equal(productionRequest(event, env), f.request.request_id);
  for (const bad of [{...event, inputs: {...event.inputs, book: 'private'}}, {...event, ref: 'feature'},
    {...event, inputs: {request_id: 'x'}}]) assert.throws(() => productionRequest(bad, env));
  assert.throws(() => productionRequest(event, {...env, GITHUB_EVENT_NAME: 'pull_request'}));
  assert.equal(productionPassport(f.input.passportGrid, f.request.request_id, f.now).kind, 'production');
  for (const changed of [{kind: 'preview'}, {sourceDateKind: 'hrm'}, {rawDigest: 'x'}, {sourceSnapshotId: 'x'},
    {geo: f.passport.geo.concat({})}, {acceptedAt: '2026-11-20T09:00:00Z'}]) {
    assert.throws(() => productionPassport([f.input.passportGrid[0], [f.request.request_id,
      JSON.stringify({...f.passport, ...changed})]], f.request.request_id, f.now));
  }
  assert.throws(() => productionPassport(f.input.passportGrid, f.request.request_id, new Date('2026-11-21T01:00:00Z')));
});

test('production builds a complete protected release, and changed addresses lose old coordinates', async t => {
  const f = await productionFixture();
  const parent = await mkdtemp(join(tmpdir(), 'vv-oneclick-'));
  t.after(() => rm(parent, {recursive: true, force: true}));
  const coordinates = {'999001': {city: 'Москва', address: 'Старый адрес', xy: [55.75, 37.62]},
    '999002': {city: 'Москва', address: 'Москва, Тестовая улица 2', xy: [55.8, 37.6]}};
  assert.deepEqual(pendingAddressChanges(f.input.points, coordinates),
    [{id: '999001', city: 'Москва', address: 'Москва, Тестовая улица 1', status: 'pending'}]);
  const report = await buildDemandPackage({...f, input: () => f.input, mode: 'production', folder: join(parent, 'release')});
  assert.equal(report.status, 'READY_FOR_REVIEW');
  assertDailyFiles(report.previousFiles, report.files);
  const snapshot = JSON.parse(await readFile(join(parent, 'release/release/demand.json')));
  assert.equal(snapshot.sourceDateKind, 'accepted');
  assert.equal(snapshot.acceptedAt, f.passport.acceptedAt);
  assert.equal(validateSnapshot(snapshot), snapshot);
  assert.match(sourceLabel(snapshot).value, /20\.11\.2026 11:00 МСК/);
  assert.equal(sourceLabel(snapshot).label, 'Обновлено');
  assert.match(sourceLabel(snapshot).title, /Дата формирования/);
  assert.equal(sourceLabel({sourceDate: '20.11.2026'}).label, 'Потребность на');
  assert.throws(() => validateSnapshot({...snapshot, acceptedAt: '2026-11-21T00:00:00Z'}));
  const wrong = {...report.files, 'app.js': '0'.repeat(64)};
  assert.throws(() => assertDailyFiles(report.previousFiles, wrong), /интерфейс/);
});

function mockGithub({committed = false, moved = false} = {}) {
  const previous = Object.fromEntries(assets.map(name => [name, sha256(Buffer.from('old:' + name))]));
  const files = Object.fromEntries(assets.map(name => [name, Buffer.from(['demand.json', 'publication.json'].includes(name) ? 'new:' + name : 'old:' + name)]));
  const release = Object.fromEntries(assets.map(name => [name, sha256(files[name])]));
  const calls = [];
  const api = async (path, body, method) => {
    calls.push({path, body, method});
    if (path === 'git/ref/heads/main') return {object: {sha: moved ? 'other' : 'head'}};
    if (path === 'git/commits/head') return {tree: {sha: 'tree'}};
    if (path.startsWith('git/trees/tree')) return {tree: assets.map(path => ({path, sha: path, mode: '100644', type: 'blob'}))};
    if (path.startsWith('git/blobs/')) {
      const name = path.slice('git/blobs/'.length);
      return {encoding: 'base64', content: (committed ? files[name] : Buffer.from('old:' + name)).toString('base64')};
    }
    if (path === 'git/blobs') return {sha: 'blob'};
    if (path === 'git/trees') return {sha: 'new-tree'};
    if (path === 'git/commits') return {sha: 'new-head'};
    if (path === 'git/refs/heads/main') { assert.equal(body.force, false); return {}; }
    if (path === 'pages/builds') return {status: 'queued'};
    throw Error('Unexpected API path: ' + path);
  };
  return {previous, release, files, api, calls, expectedHead: 'head', requestId: 'request'};
}

test('publication uses only data blobs and explicitly builds Pages; retry resumes the same commit', async () => {
  const f = mockGithub();
  assert.equal((await publishDaily(f)).commit, 'new-head');
  assert.deepEqual(f.calls.find(c => c.path === 'git/trees').body.tree.map(x => x.path), ['demand.json', 'publication.json']);
  assert.equal(f.calls.at(-1).path, 'pages/builds');
  const resumed = mockGithub({committed: true});
  assert.equal((await publishDaily(resumed)).resumed, true);
  assert.equal(resumed.calls.some(c => c.body && c.path.startsWith('git/')), false);
  assert.equal(resumed.calls.at(-1).path, 'pages/builds');
  const moved = mockGithub({moved: true});
  await assert.rejects(publishDaily(moved), /main изменился/);
  assert.equal(moved.calls.length, 1);
});

test('public verification never returns success for an incomplete or changing publication', async () => {
  const f = await demandPackageFixture();
  const manifest = {};
  for (const name of assets) manifest[name] = sha256(Buffer.from(await (await f.fetcher(new URL(name, 'https://example.org/vv-agent-map/'))).arrayBuffer()));
  await waitForPublication(manifest, f.fetcher, async () => {}, 1);
  await assert.rejects(waitForPublication(manifest, url => new URL(url).pathname.endsWith('demand.json') ?
    new Response('{}') : f.fetcher(url), async () => {}, 2), /Публикация не подтверждена/);
});

async function appsScript() {
  const projection = await readFile(new URL('../automation/Projection.gs', import.meta.url), 'utf8');
  const addon = await readFile(new URL('../automation/UnifiedDemand.gs', import.meta.url), 'utf8');
  const ctx = {};
  runInNewContext(projection + '\n' + addon, ctx);
  return ctx;
}

test('the sheet checks changed role conditions, not just totals; a dash focus is normalized', async () => {
  const c = await appsScript(), f = await productionFixture();
  const points = f.input.points.map(r => r.slice());
  points[4][1] = '—';
  const work = [...points.slice(0, 3), [], ...points.slice(3)];
  const views = c.vvUpdateCompare_(work, points, f.input.cities, points, f.input.cities, f.passport.sourceDate);
  assert.equal(views.points[4][1], '');
  assert.equal(project(views.points, 'agent').deficit, 10);
  const changed = points.map(r => r.slice()); changed[4][13] = '18';
  assert.throws(() => c.vvUpdateCompare_(work, changed, f.input.cities, points, f.input.cities, f.passport.sourceDate), /условия ролей/);
  const changedNeed = points.map(r => r.slice()); changedNeed[4][7] = 4;
  assert.throws(() => c.vvUpdateCompare_(work, changedNeed, f.input.cities, points, f.input.cities, f.passport.sourceDate), /пересчёт/);
});

test('an uncertain dispatch is persisted before POST and is never blindly repeated', async () => {
  const c = await appsScript();
  const state = {marker: 'request', requestedAt: new Date().toISOString(), rawDigest: 'full'};
  let posts = 0, savedBeforePost = false;
  c.vvUpdateFull_ = () => 'full'; c.vvUpdateViews_ = () => ({}); c.vvUpdateFreeze_ = () => {};
  c.vvUpdateFindRun_ = () => null; c.vvUpdateStatus_ = (_, s) => s;
  c.vvUpdateSave_ = s => { savedBeforePost = Boolean(s.dispatchAttempted); return s; };
  c.vvUpdateApi_ = () => { posts++; assert.ok(savedBeforePost); throw Error('Uncertain transport'); };
  assert.throws(() => c.vvUpdateAdvance_({}, state), /Uncertain/);
  assert.equal(state.dispatchAttempted, true);
  c.vvUpdateAdvance_({}, state);
  assert.equal(posts, 1);
  assert.equal(state.runId, null);
});

test('a complete cloud update verifies the new public bytes, while a repeated run makes no second commit', async t => {
  const f = await productionFixture();
  const parent = await mkdtemp(join(tmpdir(), 'vv-cloud-update-'));
  t.after(() => rm(parent, {recursive: true, force: true}));
  const folder = join(parent, 'package');
  const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const env = {GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'head',
    VV_PRODUCTION_AGENT_ID: 'production_fixture_workbook_identifier',
    VV_SHEETS_READER: JSON.stringify({client_email: 'test@example.invalid', private_key: privateKey.export({type: 'pkcs8', format: 'pem'})})};
  const publicFiles = new Map();
  for (const name of assets) publicFiles.set(name, Buffer.from(await (await f.fetcher(new URL(name, 'https://example.org/vv-agent-map/'))).arrayBuffer()));
  const previousFiles = new Map(publicFiles);
  let commits = 0, builds = 0;
  const fetcher = async (url, options) => {
    const target = new URL(url);
    if (target.hostname === 'oauth2.googleapis.com') {
      const claim = JSON.parse(Buffer.from(options.body.get('assertion').split('.')[1], 'base64url'));
      assert.equal(claim.scope, 'https://www.googleapis.com/auth/spreadsheets.readonly');
      return Response.json({access_token: 'fixture-token'});
    }
    if (target.hostname === 'sheets.googleapis.com') {
      assert.ok(target.pathname.includes(env.VV_PRODUCTION_AGENT_ID));
      assert.deepEqual(target.searchParams.getAll('ranges'), productionRanges);
      return Response.json({valueRanges: [f.input.points, f.input.cities, f.input.passportGrid].map(values => ({values}))});
    }
    const name = target.pathname.replace(/^\/vv-agent-map\//u, '') || 'index.html';
    return new Response(publicFiles.get(name), {status: publicFiles.has(name) ? 200 : 404});
  };
  const api = async (path, body) => {
    if (path === 'git/ref/heads/main') return {object: {sha: 'head'}};
    if (path === 'git/commits/head') return {tree: {sha: 'tree'}};
    if (path.startsWith('git/trees/tree')) return {tree: assets.map(path => ({path, sha: path, type: 'blob', mode: '100644'}))};
    if (path.startsWith('git/blobs/')) return {encoding: 'base64', content: previousFiles.get(path.slice(10)).toString('base64')};
    if (path === 'git/blobs') return {sha: 'new-blob'};
    if (path === 'git/trees') { assert.ok(body.tree.every(x => ['demand.json', 'coordinates.json', 'publication.json'].includes(x.path))); return {sha: 'new-tree'}; }
    if (path === 'git/commits') { commits++; return {sha: 'new-head'}; }
    if (path === 'git/refs/heads/main') { assert.equal(body.force, false); return {}; }
    if (path === 'pages/builds') {
      builds++;
      for (const name of assets) publicFiles.set(name, await readFile(join(folder, 'release', name)));
      return {status: 'queued'};
    }
    throw Error('Unexpected GitHub call: ' + path);
  };
  const event = {ref: 'main', inputs: {request_id: f.request.request_id}};
  const result = await updateDemand({event, env, folder, fetcher, now: f.now, wait: async () => {}, api});
  assert.equal(result.status, 'PUBLISHED');
  assert.equal(result.snapshotId, f.passport.id);
  assert.equal(commits, 1); assert.equal(builds, 1);
  const repeated = await updateDemand({event, env, folder: join(parent, 'repeated'), fetcher, now: f.now, wait: async () => {}, api});
  assert.equal(repeated.repeated, true);
  assert.equal(commits, 1); assert.equal(builds, 1);
  await assert.rejects(readProductionInput({}, fetcher), /закрытых настройках/);
});
