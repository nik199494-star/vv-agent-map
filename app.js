import {UNKNOWN, TRANSPORT, SCHEDULE, findPoints, normalize, rank, tone, number, incomeText, ageText} from './model.js';
import {assertFreshEnough, fetchSnapshot, isOutdated} from './source.js';
import {readSnapshot, saveSnapshot} from './cache.js';
import {attachLocations, findCityCenter, loadLocations, locationReasons} from './locations.js';
import {distanceKm, nearbyPoints, searchCandidate} from './nearby.js';
import {setupLookup} from './lookup.js';

const $ = id => document.getElementById(id);
const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const paths = {
  pin: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.4"/><path d="m16 16 4.2 4.2"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-13.7-5.6L4 8m0-4v4h4m-4 5a8 8 0 0 0 13.7 5.6L20 16m0 4v-4h-4"/>',
  users: '<circle cx="10" cy="8" r="3"/><path d="M4 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2m1-14a3 3 0 0 1 0 6m1 3a4 4 0 0 1 3 4v1"/>',
  calendar: '<rect x="4" y="6" width="16" height="14" rx="2"/><path d="M8 4v4m8-4v4M4 10h16m-12 5h2m4 0h2"/>',
  filter: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="white"/><circle cx="15" cy="12" r="2" fill="white"/><circle cx="10" cy="18" r="2" fill="white"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Zm6-3v15m6-12v15"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.1M4 12h.1M4 18h.1"/>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
  auto: '<path d="m4 11 2-5h12l2 5m0 6v2m-16-2v2M3 11h18v6H3zM7 14h1m8 0h1"/>',
  electric: '<circle cx="5" cy="16" r="3"/><circle cx="19" cy="16" r="3"/><path d="m5 16 4-7 3 7h-7m7 0 4-7m3 7-3-7-1-3h-2M7 9h4"/>',
  moto: '<circle cx="5" cy="17" r="3"/><circle cx="19" cy="17" r="3"/><path d="m5 17 4-5h4l3-4h-2m5 9-3-9h4m-7 9H9l3-4M4 11h5"/>',
  walk: '<circle cx="13" cy="4" r="2"/><path d="m8 21 4-6m5 6-3-5-2-3 1-5m-7 6 3-3 4-3 3 4 3 1"/>',
  night: '<path d="M20 15.1A8 8 0 0 1 8.9 4a8.5 8.5 0 1 0 11.1 11.1Z"/><path d="M16 4v4m-2-2h4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 4H6a2 2 0 0 0-2 2v10"/>',
  route: '<path d="m21 3-6.5 18-3.5-8-8-3.5L21 3Z"/>',
  shop: '<path d="M4 11v9h16v-9M3 11l2-6h14l2 6H3zm6 9v-5h6v5"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.pin}</svg>`;
document.querySelectorAll('[data-icon]').forEach(element => { element.innerHTML = icon(element.dataset.icon); });

const defaultState = {status: 'loading', points: [], priorities: [], cities: [], sourceDate: null,
  tiles: {url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'}};
let data = defaultState;
let locations = {coordinates: {}, cities: {}};
let currentSnapshot = null;
let updateError = false;
let filtered = [];
let candidate = null;
let missingNearby = 0;
let candidateMarker;
let selectedCity = '';
let cityOptions = [];
let optionIndex = -1;
let map, cluster, tiles, tileKey = '', markerKey = '', tileBroken = false;
let movedByUser = false, cityZoomed = '';
let view = 'map';
let visible = 45;
let selectedPoint, selectedRole;
let inputTimer, toastTimer, fetching = false;
const selectedTransports = new Set();
const mobile = window.matchMedia('(max-width: 720px)');

const roleIcon = transport => transport.endsWith('-night') ? 'night' : (transport || 'shop');
const rolePriority = role => role.priority ? `<span class="priority ${tone(role.priority)}"><span class="priority-dot"></span>${html(role.priority)}</span>` : '';
const focusBadge = '<span class="focus-badge">Суперфокус</span>';
const numberField = id => $(id).value && $(id).validity.valid ? $(id).valueAsNumber : null;
function getFilters() {
  return {
    search: candidate ? '' : $('search').value, city: selectedCity, transport: [...selectedTransports], priority: $('priority').value,
    need: numberField('need'), schedule: $('schedule').value, shift: numberField('shift'), age: numberField('age'),
    incomeFrom: numberField('income-from'), incomeTo: numberField('income-to'), superFocus: $('super-focus').value,
    format: $('work-format').value, minor: $('minor').checked, conditions: $('conditions').value,
  };
}

function showToast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3800);
}

function renderTransport() {
  const supported = new Set(data.points.flatMap(point => point.roles.map(role => role.transport)));
  const supportedLabels = Object.entries(TRANSPORT).filter(([value]) => !['moto-night', 'walk-night'].includes(value) || supported.has(value));
  const key = supportedLabels.map(([value]) => value).join('|');
  if ($('transport').dataset.key !== key) {
    $('transport').innerHTML = supportedLabels.map(([value, label]) => `<button type="button" class="transport ${value.endsWith('-night') ? 'night' : ''}" data-transport="${value}" aria-pressed="false">${icon(roleIcon(value))}<span>${label}</span></button>`).join('');
    $('transport').dataset.key = key;
  }
  document.querySelectorAll('[data-transport]').forEach(button => button.setAttribute('aria-pressed', String(selectedTransports.has(button.dataset.transport))));
}

function updateSource() {
  const outdated = data.sourceDate && isOutdated(data.sourceDate);
  $('hrm-date').textContent = data.sourceDate ?? '—';
  const notice = $('source-notice');
  const fallback = data.sourceDate ? `Показана последняя сохранённая потребность от ${data.sourceDate}.` : 'Потребность временно недоступна. Попробуйте позже.';
  notice.textContent = updateError ? fallback : outdated ? `Последняя опубликованная потребность от ${data.sourceDate}.` : '';
  notice.hidden = !notice.textContent;
  const priorities = [...data.priorities].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'ru'));
  const select = $('priority');
  const previous = select.value;
  const key = JSON.stringify(priorities);
  if (select.dataset.key !== key) {
    select.replaceChildren(new Option('Любой приоритет', ''), ...priorities.map(value => new Option(value, value)));
    select.value = priorities.includes(previous) ? previous : '';
    select.dataset.key = key;
    $('legend').hidden = !priorities.length;
    $('legend-items').innerHTML = priorities.map(value => `<span class="${tone(value)}"><i class="priority-dot"></i>${html(value)}</span>`).join('');
  }
  if (data.sourceDate && selectedCity && !data.cities.includes(selectedCity)) {
    selectedCity = '';
    $('city-search').value = '';
  }
  renderTransport();
}

function addressState(point) {
  return point.location.xy ? '' : locationReasons[point.location.reason] || locationReasons.pending;
}

function renderResults() {
  const results = $('results');
  $('result-body').setAttribute('aria-busy', String(data.status === 'loading'));
  $('more').hidden = filtered.length <= visible;
  if (!filtered.length) {
    const filters = getFilters();
    const invalidRange = filters.incomeFrom !== null && filters.incomeTo !== null && filters.incomeFrom > filters.incomeTo;
    const [title, description] = data.status === 'loading'
      ? ['Загружаем потребность', 'Торговые точки появятся автоматически.']
      : !data.sourceDate
        ? ['Потребность временно недоступна', 'Попробуйте открыть карту позже.']
        : invalidRange
          ? ['Проверьте диапазон дохода', 'Нижняя граница должна быть меньше верхней или равна ей.']
          : candidate ? ['Подходящих ТТ рядом не найдено', 'Увеличьте радиус или измените фильтры.']
          : ['Подходящих ТТ не найдено', data.points.length ? 'Измените поиск или сбросьте фильтры.' : 'В листе пока нет ТТ с положительным недобором.'];
    results.innerHTML = `<div class="empty">${icon('search')}<h3>${title}</h3><p>${description}</p></div>`;
    return;
  }
  results.innerHTML = filtered.slice(0, visible).map(point => {
    const role = point.matched[0];
    const other = point.matched.length - 1;
    const loc = addressState(point);
    return `<button type="button" class="point-card" data-point="${point.id}">
      <span class="point-title"><strong>ТТ №${point.id}</strong><span class="point-badges">${point.matched.some(item => item.superFocus) ? focusBadge : ''}${rolePriority(role)}</span></span>
      <span class="point-address">${html(point.address || point.city || 'Адрес уточняется')}</span>
      <span class="point-role">${icon(roleIcon(role.transport))}<span>${html(role.title)}</span>${other ? `<span class="other-count" aria-label="Других подходящих ролей: ${other}">+${other}</span>` : ''}</span>
      ${loc ? `<span class="address-state ${point.location.state}">${loc}</span>` : ''}
      <span class="point-bottom"><span>Недобор <strong>${number(point.need)}</strong></span>${role.income ? `<strong class="point-income" title="Ориентир дохода">≈ ${incomeText(role.income)}</strong>` : ''}${point.distance !== undefined ? `<strong class="point-distance" title="По прямой">${number(Math.round(point.distance * 10) / 10)} км</strong>` : ''}</span>
    </button>`;
  }).join('');
}

function renderMetrics(filters) {
  $('count').textContent = data.sourceDate ? number(filtered.length) : '—';
  $('total').textContent = data.sourceDate ? number(filtered.reduce((sum, point) => sum + point.need, 0)) : '—';
  const mapped = filtered.filter(point => point.location.xy).length;
  const without = filtered.length - mapped;
  $('view-title').textContent = candidate ? 'ТТ рядом' : 'Торговые точки';
  $('results-title').textContent = candidate ? 'Ближайшие ТТ' : 'Подходящие ТТ';
  $('nearby-missing').hidden = !candidate || !missingNearby;
  $('nearby-missing').textContent = `Без координат среди подходящих по фильтрам · ${number(missingNearby)}`;
  const empty = data.status === 'loading' ? 'Загрузка…' : 'Временно недоступно';
  $('map-count').textContent = data.sourceDate ? (view === 'map' ? `На карте ${number(mapped)} из ${number(filtered.length)}` : `Найдено ТТ · ${number(filtered.length)}`) : empty;
  $('result-meta').textContent = data.sourceDate ? (candidate ? 'По расстоянию по прямой' : without ? `Без маркера · ${number(without)}` : `Всего · ${number(filtered.length)}`) : empty;
  const count = [filters.city, filters.priority, filters.superFocus, filters.need, filters.schedule, filters.format, filters.shift, filters.age, filters.conditions, filters.incomeFrom ?? filters.incomeTo].filter(value => value !== null && value !== '').length + filters.transport.length + Number(filters.minor);
  $('filter-count').textContent = count;
  $('filter-count').hidden = !count;
  $('apply-filters').textContent = data.sourceDate ? `Показать ТТ · ${number(filtered.length)}` : 'Показать ТТ';
  $('recenter').disabled = !map;
}

function renderMapMessage() {
  const message = !map ? 'Карта недоступна. Точки доступны в списке.'
    : tileBroken ? 'Подложка карты недоступна. Попробуйте изменить масштаб или открыть список.'
    : data.status === 'loading' ? 'Загружаем потребность…'
    : !data.sourceDate ? 'Потребность временно недоступна.'
    : !filtered.length ? 'Подходящих точек нет.'
    : !filtered.some(point => point.location.xy) ? 'Для этих ТТ пока нет подтверждённых координат. Откройте список.' : '';
  $('map-message').hidden = !message;
  $('map-message').textContent = message;
}

function mapOverview() { map.setView([60, 75], map.getSize().x < 480 ? 2.5 : 3); }
function fit(positions) {
  if (positions.length === 1) map.setView(positions[0], 13);
  else map.fitBounds(positions, {padding: [44, 46], maxZoom: 13});
}

function updateCity(force = false) {
  if (!map || view !== 'map') return;
  if (candidate) {
    if (force) map.setView(candidate.xy, 14);
    return;
  }
  if (!selectedCity) {
    if (force || cityZoomed) {
      cityZoomed = '';
      const positions = filtered.flatMap(point => point.location.xy ? [point.location.xy] : []);
      if (force && positions.length) fit(positions);
      else mapOverview();
    }
    return;
  }
  const city = selectedCity;
  if (!force && (cityZoomed === city || movedByUser)) return;
  const positions = filtered.flatMap(point => point.location.xy ? [point.location.xy] : []);
  const fallback = data.points.filter(point => point.city === city && point.location.xy).map(point => point.location.xy);
  if (positions.length || fallback.length) {
    fit(positions.length ? positions : fallback);
    cityZoomed = city;
    return;
  }
  const center = findCityCenter(locations.cities, city);
  if (center) map.setView(center, 11);
  cityZoomed = city;
}

function renderMap() {
  if (map && view === 'map') {
    if (data.tiles && JSON.stringify(data.tiles) !== tileKey) {
      tileKey = JSON.stringify(data.tiles);
      tiles?.remove();
      let failed = 0;
      const tileOptions = {maxZoom: 19, attribution: data.tiles.attribution};
      tiles = L.tileLayer(data.tiles.url, tileOptions);
      tiles.on('tileload', () => { failed = 0; if (tileBroken) { tileBroken = false; renderMapMessage(); } });
      tiles.on('tileerror', () => { if (++failed >= 3) { tileBroken = true; renderMapMessage(); } });
      tiles.addTo(map);
    }
    const located = filtered.filter(point => point.location.xy);
    const highlighted = new Set(candidate ? located.slice(0, 3).map(point => point.id) : []);
    const key = located.map(point => [point.id, point.location.xy, point.matched[0].priority, highlighted.has(point.id)].join(':')).join('|');
    if (key !== markerKey) {
      cluster.clearLayers();
      const markers = located.map(point => {
        const label = `ТТ №${point.id} — ${point.city}`;
        const marker = L.marker(point.location.xy, {
          title: label, alt: label, riseOnHover: true,
          icon: L.divIcon({className: 'map-marker-wrap', iconSize: [34, 34], iconAnchor: [17, 17], html: `<span class="map-marker ${tone(point.matched[0].priority)}${highlighted.has(point.id) ? ' marker-nearby' : ''}">${icon('shop')}</span>`}),
        });
        marker.on('add', () => marker.getElement()?.setAttribute('aria-label', label));
        marker.on('click', () => showPoint(point.id));
        return marker;
      });
      cluster.addLayers(markers);
      markerKey = key;
    }
    updateCity();
  }
  renderMapMessage();
}

function render(resetList = false) {
  const filters = getFilters();
  const matching = findPoints(data.points, filters);
  missingNearby = candidate ? matching.filter(point => !point.location.xy).length : 0;
  filtered = nearbyPoints(matching, candidate?.xy, $('radius').value ? Number($('radius').value) : null);
  renderMetrics(filters);
  if (resetList) { visible = 45; $('result-body').scrollTop = 0; }
  renderResults();
  renderMap();
}

function chooseView(value) {
  if (view === value) return;
  view = value;
  $('workspace').classList.toggle('is-list', view === 'list');
  $('map-frame').hidden = view === 'list';
  $('map-view').setAttribute('aria-pressed', String(view === 'map'));
  $('list-view').setAttribute('aria-pressed', String(view === 'list'));
  if (view === 'map') requestAnimationFrame(() => { map?.invalidateSize(); renderMap(); });
  renderMetrics(getFilters());
}

function openCities(query = '') {
  const needle = normalize(query);
  cityOptions = ['', ...data.cities].filter(city => normalize(city || 'Все города').includes(needle));
  optionIndex = -1;
  $('city-options').innerHTML = cityOptions.length ? cityOptions.map((value, index) => `<li role="option" id="opt-${index}" aria-selected="false" data-index="${index}">${html(value || 'Все города')}</li>`).join('') : '<li role="presentation">Город не найден</li>';
  $('city-options').hidden = false;
  $('city-search').setAttribute('aria-expanded', 'true');
  $('city-search').removeAttribute('aria-activedescendant');
}

function closeCities() {
  $('city-options').hidden = true;
  $('city-search').setAttribute('aria-expanded', 'false');
  $('city-search').removeAttribute('aria-activedescendant');
  $('city-search').value = selectedCity;
}

function selectCity(value) {
  if (value !== selectedCity) {
    if (!value && selectedCity) cityZoomed = selectedCity;
    if (value) cityZoomed = '';
    movedByUser = false;
    selectedCity = value;
    render(true);
  }
  closeCities();
}

function setFiltersOpen(open) {
  if (!mobile.matches && open) return;
  $('workspace').classList.toggle('filters-open', open);
  $('open-filters').setAttribute('aria-expanded', String(open));
  $('filter-backdrop').hidden = !open;
  for (const node of [document.querySelector('.topbar'), document.querySelector('.overview'), $('nearby-panel'), $('source-notice'), document.querySelector('.map-panel'), document.querySelector('.result-panel')]) node.inert = open;
  if (open) $('close-filters').focus();
  else if (mobile.matches) $('open-filters').focus();
}

function formatMetric(label, value) { return `<div><dt>${label}</dt><dd>${html(value)}</dd></div>`; }

function showPoint(id) {
  const point = filtered.find(item => item.id === id) ?? data.points.find(item => item.id === id);
  if (!point) return;
  selectedPoint = point;
  selectedRole = point.matched?.[0] ?? point.roles[0];
  renderDetail();
  $('detail').showModal();
  $('close-detail').focus();
}

function routeUrl(point) {
  const address = point.city && !normalize(point.address).includes(normalize(point.city)) ? `${point.city}, ${point.address}` : point.address;
  const destination = point.location.xy?.join(',') || address;
  if (!destination || point.addressConflict) return '';
  const params = new URLSearchParams({api: '1', destination});
  if (candidate) params.set('origin', candidate.xy.join(','));
  return `https://www.google.com/maps/dir/?${params}`;
}

function renderDetail() {
  const point = selectedPoint;
  const role = selectedRole;
  const schedule = role.schedule.filter(value => ['day', 'evening', 'night'].includes(value)).map(value => SCHEDULE[value]).join(' · ');
  const format = role.schedule.filter(value => ['full', 'part'].includes(value)).map(value => SCHEDULE[value]).join(' · ');
  const url = routeUrl(point);
  const hint = addressState(point);
  const distance = candidate && point.location.xy ? distanceKm(candidate.xy, point.location.xy) : null;
  const cleanUnits = (value, suffix) => value ? `${value}${/₽|руб|км/iu.test(value) ? '' : suffix}` : UNKNOWN;
  $('detail-content').innerHTML = `
    <h2 id="detail-title">ТТ №${point.id}${point.city ? ` — ${html(point.city)}` : ''}</h2>
    <p class="detail-address">${icon('pin')}${html(point.address || 'Адрес уточняется')}</p>
    ${distance === null ? '' : `<p class="distance-detail">${number(Math.round(distance * 10) / 10)} км по прямой от выбранного места</p>`}
    ${hint ? `<p class="address-state ${point.location.state}">${hint}</p>` : ''}
    ${point.roles.length > 1 ? `<p class="roles-label">Посмотреть другие роли на этой ТТ</p><div class="role-navigation" role="group" aria-label="Роли на торговой точке">${point.roles.map(item => `<button type="button" data-role="${item.id}" aria-pressed="${item.id === role.id}" class="button">${html(item.title)} · ${number(item.need)}</button>`).join('')}</div>` : ''}
    <div class="detail-role"><h3>${html(role.title)}</h3>${rolePriority(role)}${role.superFocus ? focusBadge : ''}</div>
    <dl class="detail-grid">
      ${formatMetric('Недобор', `${number(role.need)} чел.`)}${formatMetric('Кандидатов в работе', role.inProgress === null ? UNKNOWN : number(role.inProgress))}
      ${formatMetric('Покрытие воронкой', role.coverage || UNKNOWN)}${formatMetric('Принимает несовершеннолетних', role.nsv === null ? UNKNOWN : role.nsv ? 'Да' : 'Нет')}
      ${formatMetric('Ориентир дохода', incomeText(role.income))}${formatMetric('Средний доход за заказ', cleanUnits(role.perOrder, ' ₽'))}
      ${formatMetric('Пробег', cleanUnits(role.distance, ' км/день'))}${formatMetric('Возраст', ageText(role.age))}
      ${formatMetric('Минимальная смена', role.shift === null ? UNKNOWN : `${number(role.shift)} ч.`)}
    </dl>
    ${role.income ? '<p class="income-note">Доход ориентировочный и зависит от фактически выполненных заказов.</p>' : ''}
    <div class="detail-block"><strong>График</strong><p>${schedule || UNKNOWN}${format ? `\nФормат: ${format}` : ''}</p>${role.scheduleRaw ? `<details><summary>Исходный график HRM</summary><p>${html(role.scheduleRaw)}</p></details>` : ''}</div>
    <div class="detail-block"><strong>Дополнительные условия</strong><p>${html(role.conditions || UNKNOWN)}</p></div>
    <div class="detail-actions"><button type="button" class="button primary" data-copy>${icon('copy')}Скопировать данные ТТ</button>${url ? `<a class="button" href="${html(url)}" target="_blank" rel="noopener noreferrer">${icon('route')}Построить маршрут</a>` : ''}</div>`;
}

async function copyPoint(button) {
  const point = selectedPoint;
  const role = selectedRole;
  const value = [
    `ВкусВилл · ТТ №${point.id}${point.city ? ` — ${point.city}` : ''}`, point.address || 'Адрес требует уточнения', role.title,
    role.income ? `Ориентир дохода: ${incomeText(role.income)}. Зависит от выполненных заказов.` : null,
    `График: ${role.schedule.map(item => SCHEDULE[item]).join(', ') || UNKNOWN}.`,
    `Минимальная смена: ${role.shift === null ? UNKNOWN : `${number(role.shift)} ч.`}`,
    `Возраст: ${ageText(role.age)}.`,
    role.conditions.split('\n').filter(line => !/^\s*(?:формат|мин\.?\s+смена)\s*:/iu.test(line)).join('\n'),
  ].filter(Boolean).join('\n');
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = 'Данные скопированы';
    setTimeout(() => { if (button.isConnected) button.innerHTML = `${icon('copy')}Скопировать данные ТТ`; }, 2300);
  } catch {
    $('copy-value').value = value;
    $('manual-copy').showModal();
    $('copy-value').select();
  }
}

function displaySnapshot(snapshot) {
  currentSnapshot = snapshot;
  const points = attachLocations(snapshot?.points ?? [], locations.coordinates);
  data = {...defaultState, sourceDate: snapshot?.sourceDate ?? null, points, status: snapshot ? 'ready' : 'unavailable',
    priorities: [...new Set(points.flatMap(point => point.roles.map(role => role.priority)).filter(Boolean))],
    cities: [...new Set(points.map(point => point.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'))};
  cityZoomed = '';
  updateSource();
  render(true);
  if ($('detail').open) {
    const point = filtered.find(item => item.id === selectedPoint.id) ?? data.points.find(item => item.id === selectedPoint.id);
    if (!point) { $('detail').close(); return; }
    selectedPoint = point;
    selectedRole = point.roles.find(role => role.title === selectedRole.title) ?? point.matched?.[0] ?? point.roles[0];
    renderDetail();
  }
}

function setBusy(busy) {
  fetching = busy;
  $('refresh').disabled = busy;
  $('refresh').setAttribute('aria-busy', String(busy));
}

async function refreshData(manual = false) {
  if (fetching) return;
  setBusy(true);
  try {
    let snapshot = await fetchSnapshot();
    assertFreshEnough(snapshot, currentSnapshot);
    try {
      await saveSnapshot(snapshot);
    } catch (error) {
      if (error instanceof RangeError) {
        snapshot = await readSnapshot();
        if (!snapshot) throw error;
      }
    }
    updateError = false;
    displaySnapshot(snapshot);
    if (manual) showToast('Потребность обновлена');
  } catch {
    updateError = true;
    if (currentSnapshot) updateSource();
    else displaySnapshot(null);
    if (manual) showToast('Обновление не удалось');
  } finally {
    setBusy(false);
  }
}

for (const key of ['day', 'evening', 'night']) $('schedule').append(new Option(SCHEDULE[key], key));
$('transport').addEventListener('click', event => {
  const button = event.target.closest('[data-transport]');
  if (!button) return;
  const value = button.dataset.transport;
  if (!selectedTransports.delete(value)) selectedTransports.add(value);
  renderTransport();
  render(true);
});
$('city-search').addEventListener('focus', () => openCities());
$('city-search').addEventListener('click', () => { if ($('city-options').hidden) openCities(); });
$('city-search').addEventListener('input', () => openCities($('city-search').value));
$('city-search').addEventListener('blur', closeCities);
$('city-search').addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeCities(); return; }
  if (event.key === 'Enter') {
    event.preventDefault();
    const city = cityOptions[optionIndex] ?? (cityOptions.length === 1 ? cityOptions[0] : cityOptions.find(value => normalize(value) === normalize($('city-search').value)));
    if (city !== undefined) selectCity(city);
  }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  if ($('city-options').hidden) openCities();
  if (!cityOptions.length) return;
  optionIndex = (optionIndex + (event.key === 'ArrowDown' ? 1 : optionIndex < 0 ? 0 : -1) + cityOptions.length) % cityOptions.length;
  $('city-options').querySelectorAll('[role="option"]').forEach((option, index) => option.setAttribute('aria-selected', String(index === optionIndex)));
  const active = $(`opt-${optionIndex}`);
  $('city-search').setAttribute('aria-activedescendant', active.id);
  active.scrollIntoView({block: 'nearest'});
});
$('city-options').addEventListener('pointerdown', event => event.preventDefault());
$('city-options').addEventListener('click', event => {
  const option = event.target.closest('[data-index]');
  if (option) selectCity(cityOptions[Number(option.dataset.index)]);
});
$('filters').addEventListener('submit', event => event.preventDefault());
function scheduleRender(event) {
  if (event.target.id === 'city-search') return;
  clearTimeout(inputTimer);
  inputTimer = setTimeout(() => render(true), 120);
}
$('filters').addEventListener('input', scheduleRender);
$('search').addEventListener('input', scheduleRender);
$('search').addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  const id = normalize($('search').value).replace(/^тт /u, '');
  if (!/^\d+$/.test(id) || !data.points.some(point => point.id === id)) return;
  event.preventDefault();
  closeStoreLookup();
  showPoint(id);
});

function selectCandidate(item) {
  candidate = item;
  $('candidate-label').textContent = [item.label, item.area, item.kind].filter(Boolean).join(' · ');
  $('nearby-panel').hidden = false;
  if (map) {
    candidateMarker?.remove();
    candidateMarker = L.marker(item.xy, {title: 'Местоположение кандидата', alt: 'Местоположение кандидата', zIndexOffset: 1000,
      icon: L.divIcon({className: 'candidate-marker-wrap', iconSize: [38, 38], iconAnchor: [19, 19], html: `<span class="candidate-marker">${icon('target')}</span>`}),
    }).addTo(map);
    chooseView('map');
    requestAnimationFrame(() => { map.invalidateSize(); updateCity(true); });
  }
  render(true);
}

const closeCandidateLookup = setupLookup({input: $('candidate-search'), options: $('candidate-options'), status: $('candidate-status'),
  lookup: searchCandidate, onSelect: selectCandidate, empty: 'Адрес не найден. Уточните город или название улицы.'});
const closeStoreLookup = setupLookup({input: $('search'), options: $('store-options'), status: $('store-status'), debounce: 120, min: 2,
  lookup(value) {
    const terms = normalize(value).split(' ').filter(term => term && term !== 'тт');
    if (!terms.length) return [];
    const exact = terms.length === 1 && data.points.find(point => point.id === terms[0]);
    return (exact ? [exact] : data.points.filter(point => terms.every(term => point.searchText.includes(term))).slice(0, 7))
      .map(point => ({id: point.id, label: `ТТ №${point.id}`, area: point.address || point.city}));
  }, onSelect: item => showPoint(item.id), empty: 'ТТ не найдена.'});
$('radius').addEventListener('change', () => render(true));
$('clear-candidate').addEventListener('click', () => {
  candidate = null;
  candidateMarker?.remove();
  candidateMarker = null;
  closeCandidateLookup();
  $('candidate-search').value = '';
  $('nearby-panel').hidden = true;
  cityZoomed = '';
  movedByUser = false;
  if (map && view === 'map' && !selectedCity) mapOverview();
  render(true);
  $('candidate-search').focus();
});
$('reset').addEventListener('click', () => {
  $('filters').reset();
  $('search').value = '';
  closeStoreLookup();
  selectedTransports.clear();
  movedByUser = false;
  if (selectedCity) cityZoomed = selectedCity;
  selectedCity = '';
  closeCities();
  renderTransport();
  render(true);
});
$('refresh').addEventListener('click', () => refreshData(true));
$('map-view').addEventListener('click', () => chooseView('map'));
$('list-view').addEventListener('click', () => chooseView('list'));
$('open-filters').addEventListener('click', () => setFiltersOpen(true));
for (const id of ['close-filters', 'filter-backdrop', 'apply-filters']) $(id).addEventListener('click', () => setFiltersOpen(false));
mobile.addEventListener('change', () => { if (!mobile.matches) setFiltersOpen(false); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('filter-backdrop').hidden && $('city-options').hidden) setFiltersOpen(false); });
$('recenter').addEventListener('click', () => { movedByUser = false; updateCity(true); });
$('results').addEventListener('click', event => {
  const id = event.target.closest('[data-point]')?.dataset.point;
  if (id) showPoint(id);
});
$('more').addEventListener('click', () => { visible += 45; renderResults(); });
$('close-detail').addEventListener('click', () => $('detail').close());
$('detail').addEventListener('click', event => {
  const button = event.target.closest('[data-role]');
  if (button) {
    selectedRole = selectedPoint.roles.find(role => role.id === button.dataset.role);
    renderDetail();
    $('detail').querySelector(`[data-role="${selectedRole.id}"]`).focus();
  } else if (event.target.closest('[data-copy]')) {
    copyPoint(event.target.closest('[data-copy]'));
  } else if (event.target === $('detail')) {
    const {left, right, top, bottom} = $('detail').getBoundingClientRect();
    if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) $('detail').close();
  }
});

if (window.L?.markerClusterGroup) {
  map = L.map('map', {zoomControl: false, minZoom: 2, maxZoom: 19, zoomSnap: 0.5, worldCopyJump: true});
  mapOverview();
  L.control.zoom({position: 'topright', zoomInTitle: 'Приблизить', zoomOutTitle: 'Отдалить'}).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com/" target="_blank" rel="noopener">Leaflet</a>');
  cluster = L.markerClusterGroup({maxClusterRadius: 55, showCoverageOnHover: false, spiderfyOnMaxZoom: true,
    iconCreateFunction: item => L.divIcon({className: 'map-cluster-wrap', iconSize: [44, 44], html: `<span class="map-cluster">${item.getChildCount()}</span>`}),
  }).addTo(map);
  map.on('dragstart', () => { movedByUser = true; });
} else {
  chooseView('list');
}

updateSource();
render();
setBusy(true);
const [mapLocations, previousSnapshot] = await Promise.all([
  loadLocations(),
  readSnapshot().catch(() => null),
]);
locations = mapLocations;
if (previousSnapshot) displaySnapshot(previousSnapshot);
setBusy(false);
refreshData();
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateSource(); });
