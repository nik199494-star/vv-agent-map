import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {assets} from '../build.mjs';

// Optional Chromium checks. Set VV_AGENT_PLAYWRIGHT to the absolute path to
// playwright-core/index.mjs and VV_AGENT_CHROME to a Chromium executable.
const playwrightPath = process.env.VV_AGENT_PLAYWRIGHT;
const chromePath = process.env.VV_AGENT_CHROME;
const skip = (!playwrightPath || !chromePath) && 'Requires Playwright Core and a local Chromium';
const origin = 'http://127.0.0.1:38165';
const mimeTypes = {html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml'};
const viewports = [{width: 1440, height: 900}, {width: 1280, height: 800}, {width: 390, height: 844}, {width: 320, height: 700}];
const station = {
  properties: {countrycode: 'RU', name: 'Станция проверки', city: 'Москва', osm_key: 'railway', osm_value: 'station'},
  geometry: {coordinates: [37, 55]},
};

function point(id, city, roles, addressConflict = false) {
  return {
    id, city, address: `Тестовая улица, ${id}`, addressConflict, searchText: `${city.toLowerCase()} ${id}`,
    roles: roles.map(([transport, schedule, priority, need, shift = null], index) => ({
      id: `${id}-${index + 1}`, transport, schedule: [schedule].flat(), priority, need,
      title: transport === 'auto' ? 'Авто-курьер' : 'Электровело-курьер',
      coverage: '', perOrder: '', distance: '', ageRaw: '', scheduleRaw: '', conditions: '',
      superFocus: false, nsv: null, inProgress: null, shift, income: null, age: null,
    })),
  };
}

const autoDay = (priority, need) => ['auto', 'day', priority, need];
const points = [
  point('103', 'Москва', [autoDay('Критичный', 20)]),
  point('104', 'Москва', [autoDay('Низкий', 30)]),
  point('101', 'Москва', [['auto', 'day', 'Высокий', 5, 4]]),
  point('106', 'Москва', [autoDay('Критичный', 7)], true),
  point('102', 'Москва', [autoDay('Высокий', 4)]),
  point('105', 'Москва', [['electric', 'night', 'Критичный', 90], ['auto', ['day', 'part'], 'Критичный', 10, 8]]),
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

async function openMap(page, stores = points, coordinateRows = coordinates) {
  const data = {
    'coordinates.json': Buffer.from(JSON.stringify(coordinateRows)),
    'ru-city-centers.json': await readFile(new URL('../ru-city-centers.json', import.meta.url)),
    'rollback.json': Buffer.from(JSON.stringify({schema: 1, active: false})),
  };
  const hash = name => createHash('sha256').update(data[name]).digest('hex');
  function publish(stores) {
    data['demand.json'] = Buffer.from(JSON.stringify({schema: 3, sourceDate: '19.11.2026', publishedAt: new Date().toISOString(), points: stores}));
    data['publication.json'] = Buffer.from(JSON.stringify({
      schema: 1, demand: hash('demand.json'), locations: hash('coordinates.json'), cities: hash('ru-city-centers.json'),
    }));
  }
  publish(stores);
  await page.route('https://photon.komoot.io/api/**', route => route.fulfill({
    headers: {'access-control-allow-origin': '*'}, json: {features: [station]},
  }));
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route(`${origin}/**`, async route => {
    const asset = new URL(route.request().url()).pathname.slice(1) || 'index.html';
    if (!assets.includes(asset)) return route.fulfill({status: 404});
    if (Object.hasOwn(data, asset)) return route.fulfill({body: data[asset], contentType: 'application/json'});
    return route.fulfill({
      body: await readFile(new URL(`../${asset}`, import.meta.url)),
      contentType: mimeTypes[asset.split('.').pop()] || 'application/json',
    });
  });
  await page.goto(origin);
  await page.locator('#refresh:enabled').waitFor();
  assert.equal(await content(page, '#count-label'), 'ТТ с открытой потребностью');
  assert.equal(await page.locator('#start-hint').isVisible(), true);
  await page.locator('#candidate-search').fill('метро Станция проверки');
  await page.getByRole('option', {name: /Станция проверки/}).click();
  return publish;
}

const unknownGroup = '#without-coordinates-results';
const groupIds = (page, selector) => page.locator(`${selector} .point-card`).evaluateAll(cards => cards.map(card => card.dataset.point));
const content = (page, selector) => page.locator(selector).textContent();

async function assertGroups(page, nearest, unresolved, need) {
  const isNearbySearch = await page.locator('#nearby-panel').isVisible();
  assert.deepEqual(await groupIds(page, '#results'), nearest);
  assert.deepEqual(await groupIds(page, unknownGroup), unresolved);
  assert.equal(new Set(await groupIds(page, '#result-body')).size, nearest.length + unresolved.length);
  assert.equal(await content(page, '#count'), String(nearest.length));
  assert.equal(await page.locator('#unknown-distance-metric').isVisible(), isNearbySearch);
  if (isNearbySearch) assert.equal(await content(page, '#unknown-distance-count'), String(unresolved.length));
  assert.equal(await content(page, '#total-label'), isNearbySearch ? 'Недобор по обеим группам' : 'Суммарный недобор');
  assert.equal(await content(page, '#total'), String(need));
  assert.equal(await page.locator(`${unknownGroup} .point-distance`).count(), 0);
}

async function applyFilters(page, update, count) {
  await page.locator('#open-filters').click();
  await update();
  await page.waitForFunction(expected => document.getElementById('apply-filters').textContent === expected, `Показать ТТ · ${count}`);
  await page.locator('#apply-filters').click();
}

test('Chromium: two result groups survive mode, radius and filter changes on desktop and mobile', {skip, timeout: 90_000}, async t => {
  const {chromium} = await import(pathToFileURL(playwrightPath));
  const browser = await chromium.launch({executablePath: chromePath});
  t.after(() => browser.close());

  for (const viewport of viewports) {
    await t.test(`${viewport.width} × ${viewport.height}`, {timeout: 25_000}, async t => {
      const mobile = viewport.width <= 759;
      const page = await browser.newPage({viewport, isMobile: mobile, hasTouch: mobile});
      t.after(() => page.close());
      await openMap(page);
      await assertGroups(page, ['101', '107', '102'], ['105', '106', '108', '104'], 160);
      assert.equal(await content(page, '#count-label'), 'В радиусе');
      assert.equal(await content(page, '#map-count'), 'В радиусе по прямой · 3');
      assert.equal(await content(page, '#nearby-missing'), 'Расстояние неизвестно 4');
      assert.equal(await page.locator('#map-frame').isVisible(), true);
      assert.equal(await page.locator('.leaflet-marker-icon[title*="№104"]').count(), 0);
      assert.equal(await page.locator('.leaflet-overlay-pane path[stroke-dasharray="5 4"]').count(), 1);
      assert.equal(await page.locator('#map-preview [data-point="101"]').isVisible(), mobile);
      assert.equal(await page.locator('.result-panel').isVisible(), !mobile);
      if (!mobile) {
        const [map, list] = await Promise.all([page.locator('#map-frame').boundingBox(), page.locator('.result-panel').boundingBox()]);
        assert.equal(map.y, list.y);
        assert.equal(map.height, list.height);
        assert.ok(Math.abs(map.width - 2 * list.width) < 2);
        assert.ok(list.y + list.height < viewport.height);
      }

      await page.locator('#nearby-missing').click();
      assert.equal(await page.locator('#map-frame').isVisible(), !mobile);
      assert.equal(await page.locator('#list-view').getAttribute('aria-pressed'), String(mobile));
      assert.equal(await page.locator('#without-coordinates-title:focus').count(), 1);
      if (!mobile) {
        assert.equal(await page.locator('#result-body').evaluate(node => node.scrollTop > 0), true);
        assert.equal(await page.evaluate(() => window.scrollY), 0);
      }
      assert.equal(await content(page, '#map-count'), 'В радиусе по прямой · 3');
      assert.equal(await content(page, '#nearby-results-title'), 'Ближайшие ТТ · 3');
      assert.equal(await content(page, '#without-coordinates-description'), 'Расстояние до этих ТТ пока неизвестно');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);

      await applyFilters(page, async () => {
        await page.locator('[data-transport="auto"]').click();
        await page.locator('#schedule').selectOption('day');
        await page.locator('#city-search').fill('Москва');
        await page.getByRole('option', {name: 'Москва', exact: true}).click();
      }, 5);
      await assertGroups(page, ['101', '102'], ['105', '106', '104'], 56);

      const multiple = page.locator(`${unknownGroup} [data-point="105"]`);
      assert.match(await multiple.textContent(), /Ещё 1 роль/);
      assert.match(await multiple.locator('.point-foot').textContent(), /по ролям в выдаче —\s*10 чел/);
      await multiple.getByRole('button', {name: /Все роли и условия/}).click();
      assert.match(await content(page, '#detail-title'), /№105/);
      assert.equal(await content(page, '#detail .detail-role h3'), 'Авто-курьер');
      assert.equal(await page.locator('#detail .distance-detail').count(), 0);
      const conditions = page.locator('#detail .selected-role');
      assert.match(await conditions.textContent(), /Подработка возможна/);
      assert.match(await conditions.textContent(), /Минимальная смена — 8 ч/);
      assert.match(await conditions.textContent(), /относится к одному выходу/);
      assert.match(await conditions.locator('.role-need').textContent(), /по выбранной роли —\s*10 чел/);
      const outOfScope = page.getByRole('button', {name: /Электровело-курьер.*Вне фильтров/});
      await outOfScope.click();
      assert.equal(await outOfScope.getAttribute('aria-pressed'), 'true');
      assert.match(await conditions.textContent(), /Минимальная смена не подтверждена/);
      assert.match(await conditions.textContent(), /Подработка не подтверждена/);
      assert.equal(await conditions.locator('.period-night').textContent(), 'Ночные');
      assert.match(await conditions.locator('.role-need').textContent(), /по выбранной роли —\s*90 чел/);
      await page.locator('#close-detail').click();

      const located = page.locator('#results [data-point="101"]');
      assert.match(await located.locator('.point-distance').textContent(), /км/);
      await located.getByRole('button', {name: /Все роли и условия/}).click();
      assert.match(await content(page, '#detail-title'), /№101/);
      assert.match(await content(page, '#detail .distance-detail'), /км по прямой от выбранного места/);
      await page.locator('#close-detail').click();

      await page.locator('#open-store-lookup').click();
      await page.locator('#search').fill('105');
      await page.getByRole('option', {name: /ТТ №105/}).click();
      assert.match(await content(page, '#detail-title'), /№105/);
      await page.locator('#close-detail').click();
      await assertGroups(page, ['101', '102'], ['105', '106', '104'], 56);

      await page.locator('#map-view').click();
      await page.locator('#radius').selectOption('1');
      await assertGroups(page, ['101'], ['105', '106', '104'], 52);
      await page.locator('#radius').selectOption('');
      await assertGroups(page, ['101', '102', '103'], ['105', '106', '104'], 76);
      assert.equal(await content(page, '#count-label'), 'С известным расстоянием');
      assert.equal(await content(page, '#map-count'), 'С известным расстоянием · 3');
      await applyFilters(page, () => page.locator('#shift').fill('4'), 1);
      await assertGroups(page, ['101'], [], 5);
      assert.equal(await page.locator('#nearby-missing').isEnabled(), false);
      await applyFilters(page, () => page.locator('#shift').fill(''), 6);
      await page.locator('#clear-candidate').click();
      await assertGroups(page, ['103', '105', '106', '101', '102', '104'], [], 76);
      assert.equal(await content(page, '#count-label'), 'ТТ с открытой потребностью');
      assert.equal(await page.locator('#nearby-missing').isVisible(), false);
      assert.equal(await page.locator('#without-coordinates').isVisible(), false);
      assert.equal(await page.locator('#results .point-distance').count(), 0);
    });
  }
});

test('Chromium: independent pagination, unknown-only and empty results on desktop and mobile', {skip, timeout: 90_000}, async t => {
  const {chromium} = await import(pathToFileURL(playwrightPath));
  const browser = await chromium.launch({executablePath: chromePath});
  t.after(() => browser.close());
  const nearby = Array.from({length: 47}, (_, i) => point(String(300 + i), 'Москва', [autoDay('Высокий', 1)]));
  const unresolved = Array.from({length: 47}, (_, i) =>
    point(String(400 + i), 'Москва', [['electric', 'day', 'Высокий', 1]]));
  const coordinateRows = Object.fromEntries(nearby.map(({id, city, address}, i) =>
    [id, {city, address, xy: [55, 37 + (i + 1) / 10000]}]));
  const nearbyIds = nearby.map(store => store.id);
  const unresolvedIds = unresolved.map(store => store.id);

  for (const viewport of viewports) {
    await t.test(`${viewport.width} × ${viewport.height}`, {timeout: 25_000}, async t => {
      const mobile = viewport.width <= 759;
      const page = await browser.newPage({viewport, isMobile: mobile, hasTouch: mobile});
      t.after(() => page.close());
      await openMap(page, [...nearby, ...unresolved], coordinateRows);
      await page.locator('#nearby-missing').click();
      assert.equal(await content(page, '#nearby-results-title'), 'Ближайшие ТТ · 47');
      assert.equal(await content(page, '#without-coordinates-title'), 'ТТ без координат · 47');
      assert.equal(await content(page, '#total'), '94');
      assert.deepEqual(await groupIds(page, '#results'), nearbyIds.slice(0, 45));
      assert.deepEqual(await groupIds(page, unknownGroup), unresolvedIds.slice(0, 45));

      await page.locator('#more-without-coordinates').click();
      assert.deepEqual(await groupIds(page, unknownGroup), unresolvedIds);
      assert.deepEqual(await groupIds(page, '#results'), nearbyIds.slice(0, 45));
      assert.equal(await page.locator('#more-without-coordinates').isVisible(), false);
      assert.equal(await page.locator('#more').isVisible(), true);
      await page.locator('#more').click();
      await assertGroups(page, nearbyIds, unresolvedIds, 94);
      assert.equal(await page.locator('#more').isVisible(), false);

      await page.locator(`${unknownGroup} [data-point="446"] [data-open-point]`).click();
      assert.match(await content(page, '#detail-title'), /№446/);
      assert.equal(await page.locator('#detail .distance-detail').count(), 0);
      await page.locator('#close-detail').click();

      await applyFilters(page, () => page.locator('[data-transport="electric"]').click(), 47);
      assert.equal(await content(page, '#map-count'), 'В радиусе по прямой · 0');
      assert.equal(await content(page, '#count'), '0');
      assert.equal(await content(page, '#unknown-distance-count'), '47');
      assert.equal(await content(page, '#without-coordinates-title'), 'ТТ без координат · 47');
      assert.deepEqual(await groupIds(page, unknownGroup), unresolvedIds.slice(0, 45));
      await applyFilters(page, async () => {
        await page.locator('[data-transport="electric"]').click();
        await page.locator('[data-transport="moto"]').click();
      }, 0);
      await assertGroups(page, [], [], 0);
      assert.equal(await page.locator('#without-coordinates').isVisible(), false);
      assert.match(await content(page, '#results'), /Подходящих ТТ рядом не найдено/);
    });
  }
});

test('Chromium: clicking reset clears the filters and restores nearby results without losing the address or radius', {skip, timeout: 45_000}, async t => {
  const {chromium} = await import(pathToFileURL(playwrightPath));
  const browser = await chromium.launch({executablePath: chromePath});
  t.after(() => browser.close());
  for (const viewport of [viewports[0], viewports[2]]) {
    await t.test(`${viewport.width} × ${viewport.height}`, {timeout: 20_000}, async t => {
      const mobile = viewport.width <= 759;
      const page = await browser.newPage({viewport, isMobile: mobile, hasTouch: mobile});
      t.after(() => page.close());
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await openMap(page);
      const address = await page.locator('#candidate-search').inputValue();

      for (const radius of ['5', '3']) {
        await page.locator('#radius').selectOption(radius);
        await page.locator('#open-filters').click();
        await page.getByRole('button', {name: 'Авто', exact: true}).click();
        await page.locator('#shift').fill('4');
        await page.waitForFunction(() => document.getElementById('apply-filters').textContent === 'Показать ТТ · 1');
        assert.equal(await content(page, '#filter-count'), '2');
        await page.getByRole('button', {name: 'Сбросить фильтры', exact: true}).click();
        assert.deepEqual(errors, []);
        assert.equal(await page.locator('#shift').inputValue(), '');
        assert.equal(await page.locator('[data-transport="auto"]').getAttribute('aria-pressed'), 'false');
        assert.equal(await content(page, '#filter-count'), '0');
        assert.equal(await page.locator('#filter-count').isVisible(), false);
        assert.equal(await content(page, '#apply-filters'), 'Показать ТТ · 7');
        await page.locator('#apply-filters').click();
        assert.equal(await page.locator('#candidate-search').inputValue(), address);
        assert.equal(await page.locator('#radius').inputValue(), radius);
        await assertGroups(page, ['101', '107', '102'], ['105', '106', '108', '104'], 160);
      }
    });
  }
});

test('Chromium: all roles at ТТ №4743 are adult-only in the card and clipboard after refresh and cache reload', {skip, timeout: 30_000}, async t => {
  const {chromium} = await import(pathToFileURL(playwrightPath));
  const browser = await chromium.launch({executablePath: chromePath});
  t.after(() => browser.close());
  const page = await browser.newPage({permissions: ['clipboard-read', 'clipboard-write']});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const conflictingRole = {age: {min: 16, max: null}, ageRaw: '16', nsv: true,
    conditions: 'Формат: фултайм + подработка\nПрочее: Студенты — да; НСВ — да; Выходные — да',
    scheduleRaw: 'По 8 часов · Несовершеннолетние допускаются · Вечерние часы'};
  const store = point('4743', 'Москва', [autoDay('Критичный', 2), ['electric', ['night', 'part'], 'Критичный', 3, 8]]);
  const other = point('4744', 'Москва', [autoDay('Критичный', 1)]);
  for (const role of [...store.roles, ...other.roles]) Object.assign(role, conflictingRole);
  const publish = await openMap(page, [store, other], {});
  const openPoint = async id => {
    await page.locator('#open-store-lookup').click();
    await page.locator('#search').fill(id);
    await page.getByRole('option', {name: new RegExp(`ТТ №${id}`)}).click();
  };
  const noMinors = /нсв|несовершеннолетн|(?:от|с)\s*16\s*лет/iu;
  const checkRoles = async () => {
    await openPoint('4743');
    const roleButtons = page.locator('#detail [data-role]');
    assert.equal(await roleButtons.count(), store.roles.length);
    for (const button of await roleButtons.all()) {
      const roleId = await button.getAttribute('data-role');
      const role = store.roles.find(role => role.id === roleId);
      await button.click();
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
      await page.locator('#detail summary').first().click();
      await page.getByText('Исходные условия роли в HRM', {exact: true}).click();
      const text = await page.locator('#detail').innerText();
      assert.match(text, /Возраст\s+От 18 лет/);
      assert.doesNotMatch(text, noMinors);
      assert.match(text, /Студенты — да; Выходные — да/);
      assert.match(text, /По 8 часов · Вечерние часы/);
      await page.getByRole('button', {name: 'Скопировать данные ТТ', exact: true}).click();
      await page.getByRole('button', {name: 'Данные скопированы', exact: true}).waitFor();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      assert.equal(copied.split(/\r?\n/u)[2], role.title);
      assert.match(copied, /Возраст: От 18 лет/);
      assert.match(copied, /Студенты — да; Выходные — да/);
      assert.doesNotMatch(copied, noMinors);
    }
    await page.locator('#close-detail').click();
  };
  await checkRoles();
  await openPoint('4744');
  assert.match(await page.locator('#detail').innerText(), /Принимает несовершеннолетних\s+Да/);
  assert.match(await page.locator('#detail').innerText(), /Возраст\s+От 16 лет/);
  await page.getByText('Исходные условия роли в HRM', {exact: true}).click();
  assert.match(await page.locator('#detail').innerText(), /НСВ — да/);
  await page.locator('#close-detail').click();

  const fresh = structuredClone(store);
  for (const role of fresh.roles) role.conditions += '\nВозраст: от 16 лет';
  publish([fresh, other]);
  await page.locator('#refresh').click();
  await page.getByText('Потребность обновлена', {exact: true}).waitFor();
  await checkRoles();
  await page.route(`${origin}/publication.json`, route => route.fulfill({status: 503}));
  await page.reload();
  await page.getByText(/Показана последняя сохранённая потребность/).waitFor();
  await checkRoles();
  await applyFilters(page, async () => {
    await page.locator('#filters summary').click();
    await page.locator('#minor').check();
    await page.locator('#age').fill('17');
  }, 1);
  assert.deepEqual(await groupIds(page, '#results'), ['4744']);
  await applyFilters(page, async () => {
    await page.locator('#minor').uncheck();
    await page.locator('#age').fill('18');
  }, 2);
  assert.deepEqual(await groupIds(page, '#results'), ['4743', '4744']);
  assert.deepEqual(errors, []);
});
