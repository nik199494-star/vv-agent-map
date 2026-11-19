import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {assets} from '../build.mjs';

// Optional Chromium checks. Set VV_AGENT_PLAYWRIGHT to the absolute path to
// playwright-core/index.mjs and VV_AGENT_CHROME to a Chromium executable.
const playwrightPath = process.env.VV_AGENT_PLAYWRIGHT;
const chromePath = process.env.VV_AGENT_CHROME;
const skip = (!playwrightPath || !chromePath) && 'Requires Playwright Core and a local Chromium';
const origin = 'http://vv-agent.test';
const mimeTypes = {html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml'};
const station = {
  properties: {countrycode: 'RU', name: 'Станция проверки', city: 'Москва', osm_key: 'railway', osm_value: 'station'},
  geometry: {coordinates: [37, 55]},
};

function point(id, city, roles, addressConflict = false) {
  return {
    id, city, address: `Тестовая улица, ${id}`, addressConflict, searchText: `${city.toLowerCase()} ${id}`,
    roles: roles.map(([transport, schedule, priority, need], index) => ({
      id: `${id}-${index + 1}`, transport, schedule: [schedule], priority, need,
      title: transport === 'auto' ? 'Авто-курьер' : 'Электровело-курьер',
      coverage: '', perOrder: '', distance: '', ageRaw: '', scheduleRaw: '', conditions: '',
      superFocus: false, nsv: null, inProgress: null, shift: null, income: null, age: null,
    })),
  };
}

const autoDay = (priority, need) => ['auto', 'day', priority, need];
const points = [
  point('103', 'Москва', [autoDay('Критичный', 20)]),
  point('104', 'Москва', [autoDay('Низкий', 30)]),
  point('101', 'Москва', [autoDay('Высокий', 5)]),
  point('106', 'Москва', [autoDay('Критичный', 7)], true),
  point('102', 'Москва', [autoDay('Высокий', 4)]),
  point('105', 'Москва', [['electric', 'night', 'Критичный', 90], autoDay('Критичный', 10)]),
  point('107', 'Москва', [['electric', 'night', 'Высокий', 6]]),
  point('108', 'Тула', [autoDay('Высокий', 8)]),
];
const coordinates = Object.fromEntries(
  Object.entries({'101': [55, 37.01], '102': [55, 37.03], '103': [55, 37.17], '107': [55.015, 37]})
    .map(([id, xy]) => {
      const {city, address} = points.find(item => item.id === id);
      return [id, {city, address, xy}];
    }),
);

async function openMap(page, stores = points) {
  await page.route('https://photon.komoot.io/api/**', route => route.fulfill({
    headers: {'access-control-allow-origin': '*'}, json: {features: [station]},
  }));
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route(`${origin}/**`, async route => {
    const asset = new URL(route.request().url()).pathname.slice(1) || 'index.html';
    if (!assets.includes(asset)) return route.fulfill({status: 404});
    if (asset === 'coordinates.json') return route.fulfill({json: coordinates});
    if (asset === 'demand.json') {
      return route.fulfill({json: {schema: 3, sourceDate: '19.11.2026', publishedAt: '2026-11-19T12:00:00Z', points: stores}});
    }
    return route.fulfill({
      body: await readFile(new URL(`../${asset}`, import.meta.url)),
      contentType: mimeTypes[asset.split('.').pop()] || 'application/json',
    });
  });
  await page.goto(origin);
  await page.locator('#refresh:enabled').waitFor();
  await page.locator('#candidate-search').fill('метро Станция проверки');
  await page.getByRole('option', {name: /Станция проверки/}).click();
}

const unknownGroup = '#without-coordinates-results';
const groupIds = (page, selector) => page.locator(`${selector} .point-card`).evaluateAll(cards => cards.map(card => card.dataset.point));
const content = (page, selector) => page.locator(selector).textContent();

async function assertGroups(page, nearest, unresolved, need) {
  assert.deepEqual(await groupIds(page, '#results'), nearest);
  assert.deepEqual(await groupIds(page, unknownGroup), unresolved);
  assert.equal(new Set(await groupIds(page, '#result-body')).size, nearest.length + unresolved.length);
  assert.equal(await content(page, '#count'), String(nearest.length + unresolved.length));
  assert.equal(await content(page, '#total'), String(need));
  assert.equal(await page.locator(`${unknownGroup} .point-distance`).count(), 0);
}

async function applyFilters(page, mobile, update, count) {
  if (mobile) await page.locator('#open-filters').click();
  await update();
  await page.waitForFunction(expected => document.getElementById('count').textContent === expected, String(count));
  if (mobile) {
    assert.equal(await content(page, '#apply-filters'), `Показать ТТ · ${count}`);
    await page.locator('#apply-filters').click();
  }
}

test('Chromium: two result groups survive mode, radius and filter changes on desktop and mobile', {skip, timeout: 90_000}, async t => {
  const {chromium} = await import(pathToFileURL(playwrightPath));
  const browser = await chromium.launch({executablePath: chromePath});
  t.after(() => browser.close());

  for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}, {width: 320, height: 700}]) {
    await t.test(`${viewport.width} × ${viewport.height}`, {timeout: 25_000}, async t => {
      const page = await browser.newPage({viewport, isMobile: viewport.width < 720, hasTouch: viewport.width < 720});
      t.after(() => page.close());
      await openMap(page);
      await assertGroups(page, ['101', '107', '102'], ['105', '106', '108', '104'], 160);
      assert.equal(await content(page, '#map-count'), 'В радиусе по прямой · 3');
      assert.equal(await content(page, '#nearby-missing'), 'ТТ без координат · 4');
      assert.equal(await page.locator('#map-frame').isVisible(), true);
      assert.equal(await page.locator('.leaflet-marker-icon[title*="№104"]').count(), 0);

      await page.locator('#nearby-missing').click();
      assert.equal(await page.locator('#map-frame').isVisible(), false);
      assert.equal(await page.locator('#list-view').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#without-coordinates-title:focus').count(), 1);
      assert.equal(await content(page, '#map-count'), 'В радиусе по прямой · 3');
      assert.equal(await content(page, '#nearby-results-title'), 'Ближайшие ТТ · 3');
      assert.equal(await content(page, '#without-coordinates-description'), 'Расстояние до этих ТТ пока неизвестно');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

      const mobile = viewport.width <= 720;
      await applyFilters(page, mobile, async () => {
        await page.locator('[data-transport="auto"]').click();
        await page.locator('#schedule').selectOption('day');
        await page.locator('#city-search').fill('Москва');
        await page.getByRole('option', {name: 'Москва', exact: true}).click();
      }, 5);
      await assertGroups(page, ['101', '102'], ['105', '106', '104'], 56);

      await page.locator(`${unknownGroup} [data-point="105"]`).click();
      assert.match(await content(page, '#detail-title'), /№105/);
      assert.equal(await content(page, '#detail .detail-role h3'), 'Авто-курьер');
      assert.equal(await page.locator('#detail .distance-detail').count(), 0);
      await page.locator('#close-detail').click();

      await page.locator('#map-view').click();
      await page.locator('#radius').selectOption('1');
      await assertGroups(page, ['101'], ['105', '106', '104'], 52);
      await page.locator('#radius').selectOption('');
      await assertGroups(page, ['101', '102', '103'], ['105', '106', '104'], 76);
      assert.equal(await content(page, '#map-count'), 'С известным расстоянием · 3');
      await page.locator('#clear-candidate').click();
      await assertGroups(page, ['103', '105', '106', '101', '102', '104'], [], 76);
      assert.equal(await page.locator('#nearby-missing').isVisible(), false);
      assert.equal(await page.locator('#without-coordinates').isVisible(), false);
      assert.equal(await page.locator('#results .point-distance').count(), 0);
    });
  }
});

test('Chromium: unknown-only, independent pagination and fully empty results', {skip, timeout: 30_000}, async t => {
  const {chromium} = await import(pathToFileURL(playwrightPath));
  const browser = await chromium.launch({executablePath: chromePath});
  t.after(() => browser.close());
  const page = await browser.newPage();
  const stores = Array.from({length: 47}, (_, i) => point(String(200 + i), 'Москва', [autoDay('Высокий', 1)]));
  await openMap(page, stores);
  assert.equal(await content(page, '#map-count'), 'В радиусе по прямой · 0');
  assert.equal(await content(page, '#count'), '47');
  await page.locator('#nearby-missing').click();
  assert.equal(await content(page, '#nearby-results-title'), 'Ближайшие ТТ · 0');
  assert.equal(await content(page, '#without-coordinates-title'), 'ТТ без координат · 47');
  assert.equal((await groupIds(page, unknownGroup)).length, 45);
  await page.locator('#more-without-coordinates').click();
  assert.deepEqual(await groupIds(page, unknownGroup), stores.map(item => item.id));
  assert.equal(await page.locator('#more-without-coordinates').isVisible(), false);
  await page.locator(`${unknownGroup} [data-point="246"]`).click();
  assert.match(await content(page, '#detail-title'), /№246/);
  await page.locator('#close-detail').click();
  await applyFilters(page, false, () => page.locator('[data-transport="moto"]').click(), 0);
  await assertGroups(page, [], [], 0);
  assert.equal(await page.locator('#without-coordinates').isVisible(), false);
  assert.match(await content(page, '#results'), /Подходящих ТТ рядом не найдено/);
});
