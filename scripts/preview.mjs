import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {build} from '../build.mjs';
import {agentHeaders} from './agent-data.mjs';
import {accessToken, agentRanges, assemble, metrics, readSheetValues} from './release.mjs';
import {project, sha256} from './projection.mjs';

export const productionBooks = new Set([
  '1jnZHSosr0d3PA7HaLcMFi48CHMHSpgVCG17MXT0Utzc',
  '1NPBnTgakkfiaa31ZznAg-iPw1e5Fi94Mu27IT8X_O-w',
]);
export const workingBookIdHash = '67fddc0aa38497a7b705dcf3ddad3fc2e9e9e50bc7dbea6c1ecdf662976d36fc';
const passportRanges = [...agentRanges, "'Паспорт preview'!A1:B2"];
const previewDirectory = new URL('../.data/preview-site/', import.meta.url);
const repoFile = async name => JSON.parse(await readFile(new URL('../' + name, import.meta.url), 'utf8'));

export function assertPreviewId(id) {
  if (!/^[A-Za-z0-9_-]{30,100}$/u.test(id ?? '') || productionBooks.has(id) || sha256(id) === workingBookIdHash) {
    throw Error('Для preview нужен ID отдельной испытательной книги.');
  }
  return id;
}

export function parseRequest(request) {
  if (request?.mode === 'fixture' && Object.keys(request).length === 1) return request;
  if (request?.mode === 'sheets' && Object.keys(request).length === 2 &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(request.requestId ?? '')) return request;
  throw Error('Некорректный запрос preview. Допустимы fixture или sheets с маркером UUID.');
}

export function readPassport(grid, requestId) {
  if (grid[0]?.[0] !== 'Маркер' || grid[0]?.[1] !== 'Паспорт' || grid[1]?.[0] !== requestId) {
    throw Error('Маркер запуска расходится с паспортом испытательной книги.');
  }
  try { return JSON.parse(grid[1][1]); }
  catch { throw Error('Некорректный паспорт испытательного снимка.'); }
}

export function fixtureViews(snapshot) {
  const rows = [];
  const cities = new Map();
  for (const point of snapshot.points) {
    for (const role of point.roles) {
      rows.push([
        role.priority, role.superFocus ? 'Да' : 'Нет', point.city, point.id, point.address, role.title,
        role.nsv === null ? '' : role.nsv ? 'Да' : 'Нет', String(role.need),
        String(role.inProgress ?? ''), role.coverage,
        role.income ? role.income.min === role.income.max ? String(role.income.min) : [role.income.min, role.income.max].join('–') : '',
        role.perOrder, role.distance, role.ageRaw, role.scheduleRaw, role.conditions,
      ]);
      cities.set(point.city, (cities.get(point.city) ?? 0) + role.need);
    }
  }
  const top = [[], [], ['Данные HRM на ' + snapshot.sourceDate]];
  return [[...top, agentHeaders, ...rows], [...top, ['Город', 'Недобор'], ...Array.from(cities, ([city, need]) => [city, String(need)])]];
}

export function assembleFixture(baseline, coordinates) {
  const [points, cities] = fixtureViews(baseline);
  const view = project(points, 'agent');
  const passport = {id: 'preview-fixture-accepted', acceptedAt: baseline.publishedAt, requestedAt: baseline.publishedAt,
    sourceDate: baseline.sourceDate, digest: sha256(view.signature), metrics: metrics(baseline.points), geo: []};
  return assemble(passport, points, cities, coordinates, baseline, null);
}

export async function runPreview(request, env = process.env, fetcher = fetch, log = console.log) {
  const input = parseRequest(request);
  if (env.GITHUB_ACTIONS && (env.GITHUB_REF !== 'refs/heads/codex/demand-pipeline' || env.GITHUB_EVENT_NAME !== 'push')) {
    throw Error('Preview разрешён только при push в ветку codex/demand-pipeline.');
  }
  const baseline = await repoFile('demand.json');
  const coordinates = await repoFile('coordinates.json');
  if (input.mode === 'sheets') {
    const workbook = assertPreviewId(env.VV_PREVIEW_AGENT_ID);
    if (!env.VV_PREVIEW_SHEETS_READER) throw Error('В окружении demand-preview отсутствует ключ читателя.');
    let key;
    try { key = JSON.parse(env.VV_PREVIEW_SHEETS_READER); }
    catch { throw Error('Ключ читателя испытательной витрины должен быть JSON-файлом сервисной учётной записи.'); }
    const token = await accessToken(key, fetcher);
    if (!token) throw Error('Google OAuth не вернул токен читателя.');
    const [points, cities, passportGrid] = await readSheetValues(workbook, passportRanges, token, fetcher);
    const passport = readPassport(passportGrid, input.requestId);
    assemble(passport, points, cities, coordinates, {...baseline, sourceDate: passport.sourceDate}, null);
    log('Испытательная витрина, маркер и результаты расчёта совпали.');
    return;
  }
  const {snapshot, totals} = assembleFixture(baseline, coordinates);
  await build(previewDirectory);
  await writeFile(new URL('demand.json', previewDirectory), JSON.stringify(snapshot));
  log('Исторический preview: ' + totals.points + ' ТТ, ' + totals.roles + ' позиций, недобор ' + totals.deficit +
    ', на карте ' + totals.mapped + ' ТТ.');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await runPreview(await repoFile('.github/preview-request.json')); }
  catch (error) {
    const message = error instanceof SyntaxError ? 'Служебный файл preview не является корректным JSON.' : error.message;
    console.error(message);
    process.exitCode = 1;
  }
}
