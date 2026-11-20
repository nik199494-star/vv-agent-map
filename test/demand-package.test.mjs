import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {buildDemandPackage, packageRequestForRun, parsePackageRequest} from '../scripts/demand-package.mjs';
import {demandPackageFixture} from '../scripts/demand-package-fixture.mjs';
import {readStoredBaseline} from '../scripts/pages-baseline.mjs';
import {attachLocations} from '../locations.js';
import {readPreviewInput} from '../scripts/dispatch-preview.mjs';

async function scenario(t) {
  const fixture = await demandPackageFixture();
  const parent = await mkdtemp(join(tmpdir(), 'vv-demand-package-'));
  t.after(() => rm(parent, {recursive: true, force: true}));
  return {...fixture, parent, run: (name, changes = {}) =>
    buildDemandPackage({...fixture, input: () => fixture.input, mode: 'fixture', folder: join(parent, name), ...changes})};
}

function withPassport(fixture, changes) {
  return {...fixture.input, passportGrid: [
    fixture.input.passportGrid[0],
    [fixture.request.request_id, JSON.stringify({...fixture.passport, ...changes})],
  ]};
}

test('restrict Sheets packages to main dispatch and the dedicated integration branch', async () => {
  const {request} = await demandPackageFixture();
  const dispatch = {GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main'};
  const integration = {GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/codex/demand-package-test'};
  assert.equal(packageRequestForRun({ref: 'main', inputs: request}, dispatch), request);
  assert.equal(packageRequestForRun({ref: integration.GITHUB_REF, deleted: false}, integration, request), request);
  assert.throws(() => packageRequestForRun({ref: 'main'}, {...dispatch, GITHUB_EVENT_NAME: 'pull_request'}, request), /разрешён/);
  assert.throws(() => packageRequestForRun({ref: integration.GITHUB_REF, deleted: true}, integration, request), /разрешён/);
  assert.throws(() => packageRequestForRun({ref: 'refs/heads/codex/p1-visual-v1', deleted: false}, integration, request), /разрешён/);
  assert.throws(() => parsePackageRequest({...request, hrm_date: '31.11.2026'}), /дата HRM/);
  assert.throws(() => parsePackageRequest({...request, mode: 'deploy'}), /Нужны UUID/);
});

test('build and repeat the same passport with unchanged data and both verified receipts', async t => {
  const f = await scenario(t);
  const first = await f.run('first');
  const second = await f.run('repeat', {now: new Date('2026-11-20T08:23:00.000Z')});
  assert.deepEqual(second, first);
  assert.equal(first.status, 'TEST_ONLY');
  assert.equal(first.hrmDate, f.request.hrm_date);
  assert.equal(first.snapshotId, f.passport.id);
  assert.deepEqual(first.totals, {points: 2, roles: 3, deficit: 10, mapped: 1, withoutMarker: 1, unresolvedByReason: {changed: 1}});
  const folder = join(f.parent, 'first');
  const release = await readStoredBaseline(join(folder, 'release'), f.now.getTime());
  const previous = await readStoredBaseline(join(folder, 'previous'), f.now.getTime());
  assert.ok(release.protectedClient && previous.protectedClient);
  assert.deepEqual(Object.keys(release.manifest).filter(name => release.manifest[name] !== previous.manifest[name]),
    ['demand.json', 'coordinates.json', 'publication.json']);
  const assigned = attachLocations(release.snapshot.points, JSON.parse(release.files['coordinates.json']));
  assert.equal(assigned.find(point => point.id === '999002').location.xy, null);
  assert.deepEqual((await readdir(folder)).sort(), ['previous', 'release', 'report.json', 'report.md']);
  await assert.rejects(f.run('first'), /уже существует/);
  assert.deepEqual(JSON.parse(await readFile(join(folder, 'report.json'))), first);
});

test('reject expired, stale and already published snapshots and a mismatched marker', async t => {
  const f = await scenario(t);
  await assert.rejects(f.run('expired', {now: new Date('2026-11-20T14:02:00.000Z')}), /просрочен/);
  const oldDate = '17.11.2026';
  await assert.rejects(f.run('old', {request: {...f.request, hrm_date: oldDate},
    input: () => withPassport(f, {sourceDate: oldDate})}), /старше действующей/);
  await assert.rejects(f.run('wrong-marker', {request: {...f.request, request_id: 'be5bf887-3def-4c63-9527-c6569347f8d4'}}), /Маркер.*расходится/);
  await assert.rejects(f.run('wrong-id', {request: {...f.request, snapshot_id: 'different-snapshot'}}), /ID снимка/);
  const first = await f.run('published');
  const archive = join(f.parent, 'published', 'release');
  const {files} = await readStoredBaseline(archive, f.now.getTime());
  const live = url => {
    const name = new URL(url).pathname.replace(/^\/vv-agent-map\//u, '') || 'index.html';
    return new Response(files[name], {status: files[name] ? 200 : 404});
  };
  await assert.rejects(f.run('already-published', {fetcher: live}), /уже опубликован/);
  assert.equal(first.status, 'TEST_ONLY');
  assert.deepEqual(await readdir(f.parent), ['published']);
});

test('reject disagreements between cities, points and the signed projection', async t => {
  const f = await scenario(t);
  const wrongCity = [...f.input.cities.slice(0, 4), ['Казань', 10]];
  await assert.rejects(f.run('wrong-city', {input: () => ({...f.input, cities: wrongCity})}),
    error => /не прошли сверку/.test(error.message) && /Витрины не совпали/.test(error.cause?.message));
  await assert.rejects(f.run('wrong-digest', {input: () => withPassport(f, {digest: '0'.repeat(64)})}), /не прошли сверку/);
  await assert.rejects(f.run('wrong-confirmed-address', {input: () => withPassport(f, {
    geo: [{...f.passport.geo[0], address: 'Москва, другой адрес'}],
  })}), error => /не прошли сверку/.test(error.message) && /Геоконтроль не совпал/.test(error.cause?.message));
  assert.deepEqual(await readdir(f.parent), []);
});

test('failed stage and changing Pages leave no downloadable package or ready status', async t => {
  const f = await scenario(t);
  await assert.rejects(f.run('bad-build', {input: async () => {
    const [temp] = await readdir(f.parent);
    await writeFile(join(f.parent, temp, 'previous', 'coordinates.json'), '{}');
    return f.input;
  }}), /сборка пакета завершилась ошибкой/);
  let reads = 0;
  await assert.rejects(f.run('changed-pages', {fetcher: url => {
    if (new URL(url).pathname.endsWith('/demand.json') && ++reads === 3) return new Response('{}');
    return f.fetcher(url);
  }}), /Действующая карта изменилась/);
  assert.deepEqual(await readdir(f.parent), []);
});

test('read an isolated workbook through Sheets and build a reviewable package', async t => {
  const f = await scenario(t);
  const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const env = {
    VV_PREVIEW_AGENT_ID: 'isolated_workbook_for_package_test',
    VV_PREVIEW_SHEETS_READER: JSON.stringify({
      client_email: 'package-test@example.invalid',
      private_key: privateKey.export({type: 'pkcs8', format: 'pem'}),
    }),
  };
  const requests = [];
  const exchange = async (url, options) => {
    const target = new URL(url);
    requests.push(target.hostname);
    if (target.hostname === 'oauth2.googleapis.com') {
      const [, encoded] = options.body.get('assertion').split('.');
      assert.equal(JSON.parse(Buffer.from(encoded, 'base64url')).scope, 'https://www.googleapis.com/auth/spreadsheets.readonly');
      return Response.json({access_token: 'fixture-token'});
    }
    assert.equal(target.hostname, 'sheets.googleapis.com');
    assert.match(target.pathname, /isolated_workbook_for_package_test\/values:batchGet$/);
    assert.deepEqual(target.searchParams.getAll('ranges'), ["'Потребность точки'!A:P", "'Потребность города'!A:M", "'Паспорт preview'!A1:B2"]);
    assert.equal(options.headers.authorization, 'Bearer fixture-token');
    return Response.json({valueRanges: [f.input.points, f.input.cities, f.input.passportGrid].map(values => ({values}))});
  };
  const report = await f.run('sheets', {mode: 'sheets', input: () => readPreviewInput(env, exchange)});
  assert.deepEqual(requests, ['oauth2.googleapis.com', 'sheets.googleapis.com']);
  assert.equal(report.status, 'READY_FOR_REVIEW');
  assert.equal(report.snapshotId, f.passport.id);
  await assert.rejects(f.run('denied', {mode: 'sheets', input: () => readPreviewInput(env, () => new Response(null, {status: 403}))}),
    /Не удалось прочитать/);
  assert.deepEqual(await readdir(f.parent), ['sheets']);
});
