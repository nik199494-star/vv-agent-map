import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateQuery, nearbyPoints, photonSuggestions} from '../nearby.js';
import {confirmCatalogPoint, readCatalog} from '../scripts/locations-admin.mjs';
import {findPoints} from '../model.js';

test('nearby mode filters by radius, orders by distance and leaves the original list intact', () => {
  const points = [
    {id: '4', location: {xy: [55.75, 37.75]}},
    {id: '3', location: {xy: null}},
    {id: '2', location: {xy: [55.75, 37.62]}},
    {id: '1', location: {xy: [55.75, 37.60]}},
  ];
  assert.deepEqual(nearbyPoints(points, [55.75, 37.60], 1).map(row => row.id), ['1']);
  const nearby = nearbyPoints(points, [55.75, 37.60], null);
  assert.deepEqual(nearby.map(row => row.id), ['1', '2', '4']);
  assert.ok(nearby[1].distance > 1 && nearby[1].distance < 2);
  assert.equal(nearbyPoints(points, null, 1), points);
});

test('search strips apartment details and metro suggestions exclude bus stops', () => {
  assert.equal(candidateQuery('Москва, ул. Профсоюзная, 56, кв. 13, подъезд 4'), 'Москва, ул. Профсоюзная, 56,');
  const features = [
    {properties: {countrycode: 'RU', name: 'Метро Щёлковская', osm_key: 'highway', osm_value: 'bus_stop'}, geometry: {coordinates: [37.79, 55.80]}},
    {properties: {countrycode: 'RU', name: 'Щёлковская', city: 'Москва', osm_key: 'railway', osm_value: 'station'}, geometry: {coordinates: [37.79, 55.81]}},
  ];
  const suggestions = photonSuggestions(features, 'Метро Щёлковская');
  assert.equal(suggestions.length, 1);
  assert.deepEqual(suggestions[0].xy, [55.81, 37.79]);
  assert.equal(suggestions[0].area, 'Москва');
});

test('catalog importer confirms the exact store address and reports conflicts', () => {
  const source = 'https://vkusvill.ru/shops/';
  const catalog = {123: {ID: '123', NOMER_TT: '42', LAT: '55.77133', LON: '37.51781', CITY: 'г. Москва',
    ADDRESS: 'Даркстор ул. 1-я Магистральная, д.&nbsp;18, стр.&nbsp;1'}};
  const rows = readCatalog('shopListItems=' + JSON.stringify(catalog) + '; shop_points.features=[];', source);
  const point = {id: '42', city: 'Москва', address: 'Москва, ул. 1-я Магистральная, д. 18, стр. 1'};
  assert.equal(rows[0].id, point.id);
  assert.deepEqual(confirmCatalogPoint(point, rows).xy, [55.77133, 37.51781]);
  assert.equal(confirmCatalogPoint({...point, address: point.address.replace('стр. 1', 'стр. 2')}, rows).reason, 'different');
  assert.equal(confirmCatalogPoint({...point, addressConflict: true}, rows).reason, 'conflict');
  assert.equal(confirmCatalogPoint(point, [rows[0], {...rows[0], xy: [55.77, 37.55]}]).reason, 'ambiguous');
});

test('nearby role filters combine transport, schedule, work format and confirmed age', () => {
  const role = {transport: 'electric', schedule: ['evening', 'part'], nsv: true, age: {min: 16, max: 55}, conditions: 'Нужна медкнижка', need: 2};
  const points = [{id: '10', city: 'Москва', roles: [role, {...role, nsv: false}, {...role, age: null}, {...role, schedule: ['evening']}, {...role, transport: 'auto'}]}];
  const result = findPoints(points, {city: 'Москва', search: '', transport: ['electric'], schedule: 'evening', format: 'part',
    minor: true, age: 17, conditions: 'медкнижка', need: null, shift: null, incomeFrom: null, incomeTo: null});
  assert.deepEqual(result[0].matched, [role]);
});
