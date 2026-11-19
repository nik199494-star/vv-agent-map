import assert from 'node:assert/strict';
import test from 'node:test';
import {findPoints} from '../model.js';
import {distanceKm, nearbyPoints} from '../nearby.js';

test('nearby search uses inclusive distances and preserves the ordinary list when the address is cleared', () => {
  const origin = [55, 37];
  const point = (id, xy) => ({id, location: {xy}});
  const boundary = point('1', [55, 37.03]);
  const unresolved = point('2', null);
  const far = point('3', [55, 37.2]);
  const close = point('4', [55, 37.01]);
  const points = [boundary, unresolved, far, close];
  const radius = distanceKm(origin, boundary.location.xy);

  const limited = nearbyPoints(points, origin, radius);
  assert.deepEqual(limited.map(point => point.id), ['4', '1']);
  assert.ok(limited[0].distance < limited[1].distance);
  assert.deepEqual(nearbyPoints(points, origin, null).map(point => point.id), ['4', '1', '3']);
  assert.deepEqual(nearbyPoints(points, origin, 0), []);
  assert.equal(nearbyPoints(points, null, radius), points);
  assert.ok(points.every(point => !Object.hasOwn(point, 'distance')));
});

test('matching roles determine priority, need and ID order for points without coordinates', () => {
  const role = (transport, schedule, priority, need) => ({transport, schedule, priority, need});
  const match = (priority, need) => role('auto', ['day'], priority, need);
  const point = (id, roles, city = 'Москва') => ({id, city, roles, location: {xy: null}});
  const points = [
    point('6', [match('Высокий', 50)]),
    point('4', [match('Критичный', 4)]),
    point('3', [match('Критичный', 4), role('electric', ['day'], 'Критичный', 50)]),
    point('2', [match('Критичный', 8), match('Критичный', 2)]),
    point('1', [role('auto', ['night'], 'Критичный', 30), role('electric', ['day'], 'Критичный', 20)]),
    point('5', [match('Критичный', 30)], 'Тула'),
  ];
  const matched = findPoints(points, {
    city: 'Москва', transport: ['auto'], schedule: 'day', need: 2,
    shift: null, age: null, incomeFrom: null, incomeTo: null,
  });
  assert.deepEqual(matched.map(({id, need}) => [id, need]), [['2', 10], ['3', 4], ['4', 4], ['6', 50]]);
  assert.equal(matched[1].matched[0].transport, 'auto');
});
