import {UNKNOWN, TRANSPORT, SCHEDULE, applyPointRules, findPoints, normalize, rank, tone, number, incomeText, ageText} from './model.js';
import {isOutdated} from './source.js';
import {fetchRelease, selectRelease} from './rollback.js';
import {readSnapshot, saveSnapshot} from './release-cache.js';
import {attachLocations, findCityCenter, locationReasons} from './locations.js';
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
const emptyLocations = {coordinates: {}, cities: {}};
let locations = emptyLocations;
let currentRelease = null;
let updateError = false;
let filtered = [];
let withoutCoordinates = [];
let candidate = null;
let candidateMarker, candidateRange, previewPointId;
let selectedCity = '';
let cityOptions = [];
let optionIndex = -1;
let map, cluster, tiles, tileKey = '', markerKey = '', tileBroken = false;
let movedByUser = false, cityZoomed = '';
let view = 'map';
const pageSize = 45;
let visible = pageSize, visibleWithoutCoordinates = pageSize;
let selectedPoint, selectedRole;
let inputTimer, toastTimer, fetching = false;
const selectedTransports = new Set();
const mobile = window.matchMedia('(max-width: 759px)');
const periods = ['day', 'evening', 'night'];
const roleNoun = new Intl.PluralRules('ru');
const roleCount = {one: 'роль', few: 'роли', many: 'ролей', other: 'ролей'};

const roleIcon = transport => transport.endsWith('-night') ? 'night' : (transport || 'shop');
const rolePriority = role => role.priority ? `<span class="priority ${tone(role.priority)}"><span class="priority-dot"></span>${html(role.priority)}</span>` : '';
const focusBadge = '<span class="focus-badge">Суперфокус</span>';
const numberField = id => $(id).value && $(id).validity.valid ? $(id).valueAsNumber : null;
function getFilters() {
  return {
    city: selectedCity, transport: [...selectedTransports], priority: $('priority').value,
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
  document.querySelectorAll('[data-hrm-date]').forEach(date => {
    date.textContent = data.sourceDate ?? '—';
  });
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

function renderRoleConditions(role) {
  const partTime = role.schedule.includes('part');
  const schedule = periods.filter(period => role.schedule.includes(period));
  return `<div class="role-conditions">
    <p class="${partTime ? 'part-confirmed' : 'unconfirmed'}">${partTime ? 'Подработка возможна' : 'Подработка не подтверждена'}</p>
    <p${role.shift === null ? ' class="unconfirmed"' : ''}>${role.shift === null ? 'Минимальная смена не подтверждена' : `Минимальная смена — ${number(role.shift)} ч`}</p>
    <dl class="role-periods"><dt>График</dt><dd>${schedule.length
      ? schedule.map(period => `<span class="period${period === 'night' ? ' period-night' : ''}">${SCHEDULE[period]}</span>`).join('')
      : '<span class="unconfirmed">Не подтверждён</span>'}</dd></dl>
  </div>`;
}

function renderPointCard(point, index = -1) {
  const role = point.matched[0];
  const id = html(point.id);
  const other = point.roles.length - 1;
  const loc = addressState(point);
  const knownDistance = point.distance !== undefined;
  return `<article class="point-card${previewPointId === point.id ? ' is-selected' : ''}" data-point="${id}">
    <div class="point-head"><h3 class="point-address">${html(point.address || point.city || 'Адрес уточняется')}</h3>
      ${knownDistance ? `<span class="point-distance" title="По прямой">${number(Math.round(point.distance * 10) / 10)} км</span>` : ''}
    </div>
    <section aria-label="Условия роли ${html(role.title)}">
      <div class="point-role"><span class="point-id">${knownDistance && index >= 0 ? `${index + 1} · ` : ''}ТТ №${id}</span>
        <strong>${html(role.title)}</strong>${other ? `<span class="other-count">Ещё ${number(other)} ${roleCount[roleNoun.select(other)]}</span>` : ''}
        <span class="point-badges">${role.superFocus ? focusBadge : ''}${rolePriority(role)}</span>
      </div>
      ${renderRoleConditions(role)}
    </section>
    ${loc ? `<p class="address-state">${loc}</p>` : ''}
    <div class="point-foot"><p>Недобор по ролям в выдаче — <strong>${number(point.need)} чел.</strong></p>
      <button type="button" class="text-button" data-open-point aria-label="Все роли и условия ТТ №${id}">Все роли и условия <span aria-hidden="true">›</span></button>
    </div>
  </article>`;
}

function renderMapPreview() {
  const preview = $('map-preview');
  const selected = candidate ? filtered.findIndex(point => point.id === previewPointId) : -1;
  const index = candidate && filtered.length ? Math.max(0, selected) : -1;
  previewPointId = filtered[index]?.id;
  preview.hidden = index < 0;
  preview.innerHTML = index < 0 ? '' : renderPointCard(filtered[index], index);
}

function renderResults() {
  const results = $('results');
  renderMapPreview();
  $('result-body').setAttribute('aria-busy', String(data.status === 'loading'));
  $('more').hidden = filtered.length <= visible;
  $('nearby-results-title').hidden = !candidate || (!filtered.length && !withoutCoordinates.length);
  $('nearby-results-title').textContent = `Ближайшие ТТ · ${number(filtered.length)}`;
  $('without-coordinates').hidden = !withoutCoordinates.length;
  $('without-coordinates-title').textContent = `ТТ без координат · ${number(withoutCoordinates.length)}`;
  $('without-coordinates-results').innerHTML = withoutCoordinates.slice(0, visibleWithoutCoordinates).map(renderPointCard).join('');
  $('more-without-coordinates').hidden = withoutCoordinates.length <= visibleWithoutCoordinates;

  if (filtered.length) {
    results.innerHTML = filtered.slice(0, visible).map(renderPointCard).join('');
    return;
  }

  const filters = getFilters();
  const invalidRange = filters.incomeFrom !== null && filters.incomeTo !== null && filters.incomeFrom > filters.incomeTo;
  const [title, description] = data.status === 'loading'
    ? ['Загружаем потребность', 'Торговые точки появятся автоматически.']
    : !data.sourceDate
      ? ['Потребность временно недоступна', 'Попробуйте открыть карту позже.']
      : invalidRange
        ? ['Проверьте диапазон дохода', 'Нижняя граница должна быть меньше верхней или равна ей.']
        : withoutCoordinates.length
          ? ['ТТ с известным расстоянием не найдено', 'Увеличьте радиус или посмотрите ТТ без координат ниже.']
          : candidate ? ['Подходящих ТТ рядом не найдено', 'Увеличьте радиус или измените фильтры.']
          : ['Подходящих ТТ не найдено', data.points.length ? 'Измените поиск или сбросьте фильтры.' : 'В листе пока нет ТТ с положительным недобором.'];
  results.innerHTML = `<div class="empty">${icon('search')}<h3>${title}</h3><p>${description}</p></div>`;
}

function renderMetrics(filters) {
  const isNearbySearch = Boolean(candidate);
  const radiusSet = $('radius').value !== '';
  const resultCount = filtered.length + withoutCoordinates.length;
  const need = [...filtered, ...withoutCoordinates].reduce((sum, point) => sum + point.need, 0);
  $('count-label').textContent = isNearbySearch ? (radiusSet ? 'В радиусе' : 'С известным расстоянием') : 'ТТ с открытой потребностью';
  $('count').textContent = data.sourceDate ? number(filtered.length) : '—';
  $('unknown-distance-metric').hidden = !isNearbySearch;
  $('nearby-missing').disabled = !withoutCoordinates.length;
  $('unknown-distance-count').textContent = data.sourceDate ? number(withoutCoordinates.length) : '—';
  $('total-label').textContent = isNearbySearch ? 'Недобор по обеим группам' : 'Суммарный недобор';
  $('total').textContent = data.sourceDate ? number(need) : '—';
  const mapped = filtered.filter(point => point.location.xy).length;
  const without = filtered.length - mapped;
  $('view-title').textContent = candidate ? 'Подбор по адресу' : 'Каталог ТТ';
  $('results-title').textContent = candidate ? 'Список ТТ' : 'ТТ с открытой потребностью';
  $('start-hint').hidden = isNearbySearch;
  const empty = data.status === 'loading' ? 'Загрузка…' : 'Временно недоступно';
  const viewCount = candidate
    ? `${radiusSet ? 'В радиусе по прямой' : 'С известным расстоянием'} · ${number(mapped)}`
    : view === 'map' ? `На карте ${number(mapped)} из ${number(resultCount)}` : `Найдено ТТ · ${number(resultCount)}`;
  $('map-count').textContent = data.sourceDate ? viewCount : empty;
  $('map-count').hidden = isNearbySearch || view === 'list' || !data.sourceDate;
  $('result-meta').textContent = data.sourceDate ? (!candidate && without ? `Без маркера · ${number(without)}` : `Всего · ${number(resultCount)}`) : empty;
  const count = [filters.city, filters.priority, filters.superFocus, filters.need, filters.schedule, filters.format, filters.shift, filters.age, filters.conditions, filters.incomeFrom ?? filters.incomeTo].filter(value => value !== null && value !== '').length + filters.transport.length + Number(filters.minor);
  $('filter-count').textContent = count;
  $('filter-count').hidden = !count;
  $('apply-filters').textContent = data.sourceDate ? `Показать ТТ · ${number(resultCount)}` : 'Показать ТТ';
  $('recenter').disabled = !map;
}

function renderMapMessage() {
  const message = !map ? 'Карта недоступна. Точки доступны в списке.'
    : tileBroken ? 'Подложка карты недоступна. Попробуйте изменить масштаб или открыть список.'
    : data.status === 'loading' ? 'Загружаем потребность…'
    : !data.sourceDate ? 'Потребность временно недоступна.'
    : !filtered.length ? (withoutCoordinates.length ? 'ТТ без координат доступны в списке.' : 'Подходящих точек нет.')
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
    if (force) {
      if (candidateRange) map.fitBounds(candidateRange.getBounds(), {padding: [18, 18], maxZoom: 14});
      else map.setView(candidate.xy, 14);
    }
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
    const radius = Number($('radius').value);
    if (candidate && radius) {
      if (!candidateRange) {
        candidateRange = L.circle(candidate.xy, {interactive: false, color: '#176d4b', fillOpacity: 0.08,
          opacity: 0.7, dashArray: '5 4', weight: 2}).addTo(map);
      }
      candidateRange.setLatLng(candidate.xy).setRadius(radius * 1000);
    } else {
      candidateRange?.remove();
      candidateRange = null;
    }
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
      const markers = located.map((point, index) => {
        const label = `ТТ №${point.id} — ${point.city}`;
        const content = candidate ? `<span class="map-marker-index" aria-hidden="true">${index + 1}</span>` : icon('shop');
        const marker = L.marker(point.location.xy, {
          title: label, alt: label, riseOnHover: true,
          icon: L.divIcon({className: 'map-marker-wrap', iconSize: [34, 34], iconAnchor: [17, 17], html: `<span class="map-marker ${tone(point.matched[0].priority)}${highlighted.has(point.id) ? ' marker-nearby' : ''}">${content}</span>`}),
        });
        marker.on('add', () => marker.getElement()?.setAttribute('aria-label', label));
        marker.on('click', () => {
          if (candidate) {
            previewPointId = point.id;
            visible = Math.max(visible, Math.ceil((index + 1) / pageSize) * pageSize);
            renderResults();
            if (!mobile.matches) scrollToResult($('results').children[index]);
          }
          showPoint(point.id);
        });
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
  // Keep the priority, need and ID order already established by findPoints.
  withoutCoordinates = candidate ? matching.filter(point => !point.location.xy) : [];
  filtered = nearbyPoints(matching, candidate?.xy, $('radius').value ? Number($('radius').value) : null);
  renderMetrics(filters);
  if (resetList) {
    visible = visibleWithoutCoordinates = pageSize;
    $('result-body').scrollTop = 0;
  }
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

function scrollToResult(target, focus = false) {
  if (focus) target.focus({preventScroll: true});
  if (mobile.matches) {
    target.scrollIntoView({block: 'nearest'});
    return;
  }
  const scroller = $('result-body');
  scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
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

function formatMetric(label, value) { return `<div><dt>${label}</dt><dd>${html(value)}</dd></div>`; }

function findResultPoint(id) {
  return filtered.find(point => point.id === id) ?? withoutCoordinates.find(point => point.id === id)
    ?? data.points.find(point => point.id === id);
}

function showPoint(id) {
  const point = findResultPoint(id);
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
  const matching = point.matched ?? findPoints([point], getFilters())[0]?.matched ?? [];
  const partial = role.schedule.includes('part');
  const limit = numberField('shift');
  const shiftNote = role.shift === null
    ? `<p class="confirmation-note unconfirmed">${limit === null ? 'Короткий выход по этой роли не подтверждён.' : `Выход на ${number(limit)} ч не подтверждён.`}</p>`
    : partial ? `<p class="confirmation-note">Подработка — формат занятости. Минимум ${number(role.shift)} ч относится к одному выходу по этой роли.</p>` : '';
  const url = routeUrl(point);
  const hint = addressState(point);
  const distance = candidate && point.location.xy ? distanceKm(candidate.xy, point.location.xy) : null;
  const radius = Number($('radius').value);
  const cleanUnits = (value, suffix) => value ? `${value}${/₽|руб|км/iu.test(value) ? '' : suffix}` : UNKNOWN;
  $('detail-content').innerHTML = `
    <h2 id="detail-title">ТТ №${point.id}${point.city ? ` — ${html(point.city)}` : ''}</h2>
    <p class="detail-address">${icon('pin')}${html(point.address || 'Адрес уточняется')}</p>
    ${distance === null ? '' : `<p class="distance-detail">${number(Math.round(distance * 10) / 10)} км по прямой от выбранного места${radius && distance > radius ? ' · за пределами радиуса' : ''}</p>`}
    ${hint ? `<p class="address-state">${hint}${candidate ? ' · расстояние неизвестно' : ''}</p>` : ''}
    ${point.roles.length > 1 ? `<p class="roles-label">Роли на ТТ</p><div class="role-navigation" role="group" aria-label="Выберите роль">${point.roles.map(item => `<button type="button" data-role="${html(item.id)}" aria-pressed="${item.id === role.id}" class="button"><span>${html(item.title)}</span>${matching.includes(item) ? '' : '<small>Вне фильтров</small>'}</button>`).join('')}</div>` : ''}
    <section class="selected-role" aria-label="Условия выбранной роли" aria-live="polite">
      <p class="selected-role-label">Условия выбранной роли</p>
      <div class="detail-role"><h3>${html(role.title)}</h3>${rolePriority(role)}${role.superFocus ? focusBadge : ''}</div>
      ${renderRoleConditions(role)}
      ${shiftNote}
      <p class="role-need">Недобор по выбранной роли — <strong>${number(role.need)} чел.</strong></p>
      <dl class="detail-grid">
        ${formatMetric('Кандидатов в работе', role.inProgress === null ? UNKNOWN : number(role.inProgress))}
        ${formatMetric('Покрытие воронкой', role.coverage || UNKNOWN)}
        ${point.adultOnly ? '' : formatMetric('Принимает несовершеннолетних', role.nsv === null ? UNKNOWN : role.nsv ? 'Да' : 'Нет')}
        ${formatMetric('Возраст', ageText(role.age))}
        ${formatMetric('Ориентир дохода', incomeText(role.income))}${formatMetric('Средний доход за заказ', cleanUnits(role.perOrder, ' ₽'))}
        ${formatMetric('Пробег', cleanUnits(role.distance, ' км/день'))}
        ${role.schedule.includes('full') ? formatMetric('Формат', 'Полная занятость') : ''}
      </dl>
      ${role.income ? '<p class="income-note">Доход ориентировочный и зависит от фактически выполненных заказов.</p>' : ''}
      ${role.scheduleRaw ? `<details class="detail-block"><summary>Исходный график HRM</summary><p>${html(role.scheduleRaw)}</p></details>` : ''}
      <details class="detail-block"><summary>Исходные условия роли в HRM</summary><p>${html(role.conditions || 'Условия не подтверждены')}</p></details>
    </section>
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

function displaySnapshot(release) {
  currentRelease = release;
  const snapshot = release?.snapshot;
  locations = release?.locations ?? emptyLocations;
  const points = attachLocations(applyPointRules(snapshot?.points ?? []), locations.coordinates);
  data = {...defaultState, sourceDate: snapshot?.sourceDate ?? null, points, status: snapshot ? 'ready' : 'unavailable',
    priorities: [...new Set(points.flatMap(point => point.roles.map(role => role.priority)).filter(Boolean))],
    cities: [...new Set(points.map(point => point.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'))};
  cityZoomed = '';
  updateSource();
  render(true);
  if ($('detail').open) {
    const point = findResultPoint(selectedPoint.id);
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
    const candidate = await fetchRelease();
    let release = selectRelease(candidate, currentRelease);
    try { release = await saveSnapshot(candidate); }
    catch (error) {
      if (error instanceof RangeError) throw error;
    }
    updateError = false;
    displaySnapshot(release);
    if (manual) showToast('Потребность обновлена');
  } catch {
    updateError = true;
    if (currentRelease) updateSource();
    else displaySnapshot(null);
    if (manual) showToast('Обновление не удалось');
  } finally {
    setBusy(false);
  }
}

for (const key of periods) $('schedule').append(new Option(SCHEDULE[key], key));
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
  if (event.key === 'Escape' && !$('city-options').hidden) {
    event.preventDefault();
    closeCities();
    return;
  }
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
function showLookupPoint(id) {
  $('store-lookup').close();
  showPoint(id);
}

$('search').addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  const id = normalize($('search').value).replace(/^тт /u, '');
  if (!/^\d+$/.test(id) || !data.points.some(point => point.id === id)) return;
  event.preventDefault();
  closeStoreLookup();
  showLookupPoint(id);
});

function selectCandidate(item) {
  candidate = item;
  previewPointId = undefined;
  movedByUser = false;
  $('candidate-label').textContent = [item.label, item.area, item.kind].filter(Boolean).join(' · ');
  $('nearby-panel').hidden = false;
  $('clear-candidate').hidden = false;
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
  }, onSelect: item => showLookupPoint(item.id), empty: 'ТТ не найдена.'});
$('radius').addEventListener('change', () => {
  render(true);
  if (!movedByUser) updateCity(true);
});
$('clear-candidate').addEventListener('click', () => {
  candidate = null;
  candidateMarker?.remove();
  candidateMarker = null;
  closeCandidateLookup();
  $('candidate-search').value = '';
  $('nearby-panel').hidden = true;
  $('clear-candidate').hidden = true;
  cityZoomed = '';
  movedByUser = false;
  if (map && view === 'map' && !selectedCity) mapOverview();
  render(true);
  $('candidate-search').focus();
});
$('reset-filters').addEventListener('click', () => {
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
$('nearby-missing').addEventListener('click', () => {
  if (mobile.matches) chooseView('list');
  scrollToResult($('without-coordinates-title'), true);
});
$('back-to-nearby').addEventListener('click', () => scrollToResult($('nearby-results-title'), true));
$('open-filters').addEventListener('click', () => $('filter-panel').showModal());
for (const id of ['close-filters', 'apply-filters']) {
  $(id).addEventListener('click', () => $('filter-panel').close());
}
$('open-store-lookup').addEventListener('click', () => {
  $('search').value = '';
  $('store-lookup').showModal();
  $('search').focus();
});
$('close-store-lookup').addEventListener('click', () => $('store-lookup').close());
$('store-lookup').addEventListener('close', closeStoreLookup);
$('recenter').addEventListener('click', () => { movedByUser = false; updateCity(true); });
for (const container of ['result-body', 'map-preview']) {
  $(container).addEventListener('click', event => {
    const id = event.target.closest('[data-point]')?.dataset.point;
    if (id) showPoint(id);
  });
}
function revealPage(group, firstNewPoint) {
  renderResults();
  if (firstNewPoint) $(group).querySelector(`[data-point="${firstNewPoint.id}"] [data-open-point]`)?.focus();
}
$('more').addEventListener('click', () => {
  visible += pageSize;
  revealPage('results', filtered[visible - pageSize]);
});
$('more-without-coordinates').addEventListener('click', () => {
  visibleWithoutCoordinates += pageSize;
  revealPage('without-coordinates-results', withoutCoordinates[visibleWithoutCoordinates - pageSize]);
});
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
  new ResizeObserver(() => {
    if (view === 'map') map.invalidateSize({pan: false});
  }).observe($('map-frame'));
} else {
  chooseView('list');
}

updateSource();
render();
setBusy(true);
const previousSnapshot = await readSnapshot().catch(() => null);
if (previousSnapshot) displaySnapshot(previousSnapshot);
setBusy(false);
refreshData();
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateSource(); });
