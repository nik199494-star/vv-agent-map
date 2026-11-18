import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import {assemble, fence, readAgentViews, verifyRelease, metrics} from '../scripts/release.mjs';
import {project, sha256} from '../scripts/projection.mjs';
import {agentHeaders} from '../scripts/agent-data.mjs';
import {schemaVersion} from '../source.js';

const source = ['Projection', 'Diagnostics', 'Geocontrol', 'DemandPipeline'].map(name =>
  readFileSync(new URL('../automation/' + name + '.gs', import.meta.url), 'utf8')).join('\n');
const gas = runInNewContext(source + '\n({vvCheckRaw_,vvDictionaryPlan_,vvAcceptAndPublish,vvGithub_,vvViews_})', {});
const role = ['Критичный', 'Да', 'Москва', '123', 'Москва, ул. Тестовая, д. 1', 'Авто-курьер', 'Нет', '4', '0', '0%', '7000', '', '', '18', 'Дневные', 'Формат: фултайм'];
const rows = [['Потребность'], [], ['Данные HRM на 18.11.2026'], agentHeaders, role];
const cities = [[], [], ['Данные HRM на 18.11.2026'], ['Город', 'Недобор'], ['Москва', '4']];
const previous = {schema: schemaVersion, sourceDate: '17.11.2026', publishedAt: '2026-11-17T07:00:00Z', points: []};
const acceptedAt = '2026-11-18T09:00:00.000Z';

function passport(grid = rows, geo = []) {
  const p = project(grid, 'agent');
  return {id: 'fresh-test-snapshot', acceptedAt, requestedAt: acceptedAt, sourceDate: p.date, digest: sha256(p.signature),
    metrics: {points: p.points, roles: p.roles, deficit: p.deficit}, geo};
}

const geo = {id: '123', address: role[4], city: role[2], xy: [55.75, 37.62],
  checkedOn: '2026-11-18', source: 'https://www.openstreetmap.org/way/987', status: 'confirmed'};
const index = entries => Object.fromEntries(entries.map(row => [row.id, row]));
const fullHeaders = ['Приоритет', 'Заявка', 'Вакансия', 'В работе', 'Финалисты', 'Открыто позиций', 'Позиции', 'График', 'Ответственный', 'Заказчик', 'Дата открытия', 'Дата закрытия', 'Сколько дней в работе', 'updated_at'];
const fullRow = ['Критичный', '123ДС_Москва', 'Авто-курьер', 4, 6, 10, '', '', '', '', '', '', '', '2026-11-18 10:00:00'];
const ageLimit = 36;
const now = Date.parse(acceptedAt);

test('FULL resolves reordered columns and rejects stale times, duplicates and numerical drift', () => {
  const values = fullRow.concat('Москва', role[4]);
  const raw = gas.vvCheckRaw_([fullHeaders.concat('Город', 'Адрес').reverse(), values.reverse()], fullHeaders, now, 0, ageLimit, null);
  assert.equal(raw.deficit, 4);
  assert.equal(raw.entries[0].city, 'Москва');
  const bad = [...fullRow];
  bad[5] = 11;
  assert.throws(() => gas.vvCheckRaw_([fullHeaders, bad], fullHeaders, now, 0, ageLimit, null), /не равен 0/);
  assert.throws(() => gas.vvCheckRaw_([fullHeaders, fullRow, fullRow], fullHeaders, now, 0, ageLimit, null), /дубль/);
  assert.throws(() => gas.vvCheckRaw_([fullHeaders, fullRow], fullHeaders, now + 37 * 3600000, 0, ageLimit, null), /устарела/);
  assert.throws(() => gas.vvCheckRaw_([fullHeaders, fullRow], fullHeaders, now, now, ageLimit, null), /устарела/);
});

test('diagnostics makes a full or partial entry and preserves authoritative values', () => {
  const dictionary = [['ID ТТ', 'Тег ТТ', 'Город', 'Адрес']];
  const find = (entries, dict = dictionary, tag = 'ДС') =>
    gas.vvDictionaryPlan_(entries, dict, ['Москва'], [[]], () => ['00123', tag], () => '');
  const entry = {raw: fullRow, row: 2, id: 123, city: 'Москва', address: 'Москва, улица Тестовая, дом 1'};
  assert.equal(find([entry]).changes[0].after.join('|'), '123|ДС|Москва|' + role[4]);
  const partial = find([entry], dictionary, '');
  assert.equal(partial.changes[0].after[1], '');
  assert.equal(partial.issues[0].state, 'Требует подтверждения');
  assert.ok(find([{...entry, city: 'Не определено'}]).issues.some(i => i.state === 'Критическая ошибка'));
  const existing = dictionary.concat([[123, 'ДС', 'Москва', role[4]]]);
  assert.equal(find([entry], existing).changes.length, 0);
  const conflict = find([{...entry, address: role[4].replace('д. 1', 'д. 2')}], existing);
  assert.equal(conflict.changes.length, 0);
  assert.ok(conflict.issues.some(i => /конфликт/.test(i.kind) && i.state === 'Критическая ошибка'));
  assert.ok(find([entry], existing.concat([['00123', 'ДС', 'Москва', role[4]]])).issues.some(i => /Дубликат/.test(i.kind)));
});

test('verified projection preserves frontend schema and strips contacts', () => {
  const edited = rows.slice(0, 4).concat([[...role.slice(0, 15), 'Формат: фултайм\nКонтакт: +7 (900) 123-45-67']]);
  const model = assemble(passport(edited, [geo]), edited, cities, {}, previous, null);
  assert.deepEqual(metrics(model.snapshot.points), {points: 1, roles: 1, deficit: 4});
  assert.equal(model.totals.mapped, 1);
  assert.deepEqual(model.coordinates['123'].xy, geo.xy);
  assert.doesNotMatch(JSON.stringify(model.snapshot), /123-45-67/);
  assert.equal(model.snapshot.points[0].roles[0].superFocus, true);
  assert.equal(assemble(passport(), rows, cities, {}, previous, null).totals.mapped, 0);
});

test('publication rejects sensitive tokens, duplicate roles and drift between expected and rendered source', () => {
  const badCity = cities.slice(0, 4).concat([['Москва', '9']]);
  assert.throws(() => assemble(passport(), rows, badCity, {}, previous, null), /не совпали/);
  assert.throws(() => project(rows.concat([role]), 'agent'), /повторная позиция/);
  const bad = [...role];
  bad[15] = 'ghp_' + '0'.repeat(40);
  const cells = rows.slice(0, 4).concat([bad]);
  assert.throws(() => assemble(passport(cells), cells, cities, {}, previous, null), /секрет/);
  assert.throws(() => assemble({...passport(), digest: 'a'.repeat(64)}, rows, cities, {}, previous, null), /не совпали/);
});

test('changed addresses cannot attach their previous marker without review', () => {
  const outdated = {...geo, address: 'Москва, ул. Тестовая, д. 2'};
  const places = index([outdated]);
  assert.throws(() => assemble(passport(), rows, cities, places, previous, null), /Геоконфликт/);
  const pending = {id: geo.id, city: geo.city, address: role[4], status: 'pending'};
  assert.equal(assemble(passport(rows, [pending]), rows, cities, places, previous, null).totals.mapped, 0);
  assert.throws(() => assemble(passport(rows, [outdated]), rows, cities, places, previous, null), /не совпал/);
  assert.throws(() => assemble(passport(rows, [{...geo, xy: [0, 0]}]), rows, cities, {}, previous, null), /некорректная запись/);
});

test('a queued older run cannot overwrite a newer release, identical acceptance can be retried', () => {
  const accepted = passport();
  assert.doesNotThrow(() => fence(accepted, previous, accepted));
  assert.throws(() => fence({...accepted, id: 'different-snapshot'}, previous, accepted), /не совпадает/);
  assert.throws(() => fence({...accepted, acceptedAt: '2026-11-18T08:00:00Z'}, previous, accepted), /старше/);
  assert.throws(() => fence(accepted, previous, {...accepted, requestedAt: '2026-11-18T12:00:00Z'}), /Запрос старше/);
  assert.throws(() => fence({...accepted, sourceDate: '16.11.2026'}, previous, null), /старше/);
});

test('Google network error stops the read, Sheets credentials are only sent to Sheets', async () => {
  await assert.rejects(readAgentViews('fixture', async (url, options) => {
    assert.equal(new URL(url).hostname, 'sheets.googleapis.com');
    assert.equal(options.headers.authorization, 'Bearer fixture');
    return new Response('{}', {status: 503});
  }), /HTTP 503/);
  const values = await readAgentViews('fixture', async () => Response.json({valueRanges: [{values: rows}, {values: cities}]}));
  assert.equal(values[0][4][3], '123');
});

test('public check identifies broken or partial deploy and accepts the verified baseline after rollback', async () => {
  const result = assemble(passport(), rows, cities, {}, previous, null);
  const demand = JSON.stringify(result.snapshot);
  const locations = JSON.stringify(result.coordinates);
  const receipt = {...passport(), demand: sha256(demand), locations: sha256(locations)};
  const files = {'publication.json': JSON.stringify(receipt), 'demand.json': demand, 'coordinates.json': locations,
    'index.html': '<input id="candidate-search">', 'app.js': 'function nearbyPoints() {}'};
  const fromFiles = async url => new Response(files[url.pathname.split('/').at(-1)], {status: 200});
  await verifyRelease(receipt, fromFiles);
  files['coordinates.json'] = '{"wrong":true}';
  await assert.rejects(verifyRelease(receipt, fromFiles), /не соответствует/);
  files['coordinates.json'] = locations;
  await verifyRelease(receipt, fromFiles);
  await assert.rejects(verifyRelease(receipt, async () => new Response('', {status: 503})), /HTTP 503/);
});

test('Apps Script refuses concurrent runs and redacts failing GitHub API payload', () => {
  let banner, calls = 0;
  const environment = {
    SpreadsheetApp: {getActiveSpreadsheet: () => ({toast: text => banner = text})},
    LockService: {getDocumentLock: () => ({tryLock: () => false})},
    UrlFetchApp: {fetch: () => { calls++; return {getResponseCode: () => 503, getContentText: () => 'secret body'}; }},
  };
  const api = runInNewContext(source + '\n({vvAcceptAndPublish,vvGithub_})', environment);
  api.vvAcceptAndPublish();
  assert.match(banner, /Уже выполняется/);
  assert.equal(calls, 0);
  assert.throws(() => api.vvGithub_({getProperty: () => 'fixture-token'}, 'actions/runs/1'), /^Error: GitHub API вернул HTTP 503\.$/);
  assert.equal(calls, 1);
});
