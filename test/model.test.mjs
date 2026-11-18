import test from 'node:test';
import assert from 'node:assert/strict';
import {amount, parseAge, agentHeaders, readAgentRows, shapePoints} from '../scripts/agent-data.mjs';
import {attachLocations} from '../locations.js';
import {assertFreshEnough, fetchSnapshot, isOutdated, schemaVersion, validateSnapshot} from '../source.js';
import {findPoints} from '../model.js';

const filters = {city: 'Москва', search: 'ТТ №10', transport: [], priority: '', superFocus: '', need: null, schedule: '', shift: null, age: null, incomeFrom: null, incomeTo: null};
const standard = ['Критичный', '—', 'Москва', '10', 'Москва, ул. Тестовая, д. 1', 'Авто-курьер', 'Нет', '5', '2', '40%', '6 000руб.', '130', '50', '18', 'Дневные часы', 'Формат: фултайм\nМин. смена: 5 часов'];
const night = ['Критичный', 'Да', 'Москва', '10', standard[4], 'Электровело-курьер (ночь)', 'Да', '8', '1', '12%', '8000', '135', '25', '18–60', 'Ночные', 'Формат: фултайм\nМин. смена: 8 часов'];
const sourceDate = '18.11.2026';
const publishedAt = '2026-11-18T08:00:00.000Z';
const csv = (rows, headers = agentHeaders, date = sourceDate) => [['Потребность'], [], [`Данные HRM на ${date}`], headers, ...rows]
  .map(row => row.map(cell => `"${cell.replaceAll('"', '""')}"`).join(',')).join('\r\n');
const snapshot = rows => ({schema: schemaVersion, publishedAt, ...shapePoints(readAgentRows(csv(rows)))});

test('new headers are resolved by name and only agent columns are projected', () => {
  const raw = [...standard];
  raw[15] += '\nКонтакт: @example_user';
  const remap = [1, 0, ...agentHeaders.slice(2).map((_, i) => i + 2)];
  const approved = readAgentRows(csv([[...remap.map(i => raw[i]), 'secret']], [...remap.map(i => agentHeaders[i]), 'Внутренний список']));
  const {points} = shapePoints(approved);
  const role = points[0].roles[0];
  assert.equal(role.coverage, '40%');
  assert.equal(role.nsv, false);
  assert.equal(role.superFocus, false);
  assert.equal(role.shift, 5);
  assert.doesNotMatch(JSON.stringify(points), /secret|example_user/);
  assert.throws(() => readAgentRows(csv([standard], agentHeaders.map(x => x === 'Супер фокус' ? 'Другое' : x))), /Супер фокус/);
  assert.throws(() => readAgentRows(csv([standard], agentHeaders, '31.11.2026')), /дату HRM/);
});

test('superfocus combines with role filters, including two roles at one store', () => {
  const {points} = snapshot([standard, standard, night]);
  assert.equal(points.length, 1);
  assert.equal(points[0].roles.length, 2);
  assert.equal(findPoints(points, filters)[0].need, 13);
  assert.equal(findPoints(points, {...filters, superFocus: 'yes', transport: ['electric-night'], age: 30})[0].need, 8);
  assert.equal(findPoints(points, {...filters, superFocus: 'no', transport: ['auto']})[0].need, 5);
  assert.equal(findPoints(points, {...filters, superFocus: 'yes', transport: ['auto']}).length, 0);
  assert.deepEqual(parseAge('18–60'), {min: 18, max: 60});
  assert.deepEqual(amount('6 000руб.'), {min: 6000, max: 6000});
});

test('coordinates stay linked to the exact ID and address', () => {
  const point = snapshot([standard]).points[0];
  const index = {'10': {city: point.city, address: point.address, xy: [55.77, 37.51]}};
  assert.deepEqual(attachLocations([point], index)[0].location.xy, [55.77, 37.51]);
  assert.equal(attachLocations([{...point, address: `${point.address} стр 1`}], index)[0].location.xy, null);
});

test('refresh uses a same-origin asset, validates data and rejects older snapshots', async () => {
  const valid = snapshot([standard]);
  assert.equal(validateSnapshot(valid).sourceDate, sourceDate);
  assert.throws(() => validateSnapshot({...valid, points: [{...valid.points[0], id: 'bad'}]}));
  assert.throws(() => assertFreshEnough({...valid, sourceDate: '17.11.2026'}, valid), RangeError);
  const badRelease = {...valid, snapshotId: 'erroneous'};
  const restored = {...valid, sourceDate: '17.11.2026', publishedAt: '2026-11-18T08:05:00Z', rollbackOf: 'erroneous'};
  assert.doesNotThrow(() => assertFreshEnough(restored, badRelease));
  assert.throws(() => assertFreshEnough(restored, {...badRelease, snapshotId: 'else'}), RangeError);
  assert.throws(() => assertFreshEnough({...valid, publishedAt: '2026-11-18T07:30:00.000Z'}, valid), RangeError);
  assert.ok(isOutdated(sourceDate, new Date('2026-11-18T21:00:00Z')));
  const loaded = await fetchSnapshot(async (url, options) => {
    assert.ok(url.pathname.endsWith('/demand.json'));
    assert.equal(options.cache, 'no-store');
    return Response.json(valid);
  });
  assert.deepEqual(loaded, valid);
  await assert.rejects(fetchSnapshot(async () => new Response('', {status: 503})), /503/);
});
