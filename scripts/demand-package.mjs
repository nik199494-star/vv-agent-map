import {mkdir, mkdtemp, readFile, rename, rm, writeFile, lstat, appendFile} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {dateKey} from '../source.js';
import {attachLocations} from '../locations.js';
import {readDispatchPassport, readPreviewInput} from './dispatch-preview.mjs';
import {assemble, metrics, validateHandoff} from './release.mjs';
import {prepareRelease, readStoredBaseline, savePagesBaseline, verifyPagesBaseline} from './pages-baseline.mjs';

const integrationRef = 'refs/heads/codex/demand-package-test';
const marker = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const moscowDay = new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'});
const publishable = new Set(['demand.json', 'coordinates.json', 'publication.json']);
const sources = {
  sheets: 'Испытательная агентская витрина Google Sheets',
  replay: 'Сохранённое чтение испытательной агентской витрины',
  fixture: 'Тестовая фикстура с условными данными',
};

export function parsePackageRequest(input) {
  if (!input || Object.keys(input).length !== 3 || !marker.test(input.request_id ?? '') ||
      !/^[a-z0-9-]{12,80}$/iu.test(input.snapshot_id ?? '') || !dateKey(input.hrm_date)) {
    throw Error('Нужны UUID строки паспорта, ID принятого снимка и дата HRM в формате ДД.ММ.ГГГГ.');
  }
  return input;
}

export function packageRequestForRun(event, env, requestOnBranch) {
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main' &&
      ['main', 'refs/heads/main'].includes(event?.ref)) return parsePackageRequest(event.inputs);
  if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === integrationRef && event?.ref === integrationRef &&
      event.deleted === false) return parsePackageRequest(requestOnBranch);
  throw Error('Запрос пакета разрешён из main или из выделенной ветки сквозного испытания.');
}

async function phase(message, run) {
  try { return await run(); }
  catch (cause) { throw Error(message, {cause}); }
}

function checkArchivedRelease(previous, release, passport, totals) {
  const actual = metrics(release.snapshot.points);
  const unresolved = new Map();
  for (const point of attachLocations(release.snapshot.points, JSON.parse(release.files['coordinates.json']))) {
    if (point.location.xy === null) {
      const reason = point.location.reason;
      unresolved.set(reason, (unresolved.get(reason) ?? 0) + 1);
    }
  }
  const withoutMarker = [...unresolved.values()].reduce((sum, count) => sum + count, 0);
  if (!release.protectedClient || release.snapshot.snapshotId !== passport.id || release.snapshot.sourceDate !== passport.sourceDate ||
      Object.keys(actual).some(key => actual[key] !== totals[key]) ||
      actual.points - withoutMarker !== totals.mapped ||
      Object.keys(previous.manifest).some(name => !publishable.has(name) && previous.manifest[name] !== release.manifest[name])) {
    throw Error('Проверенный архив расходится со снимком, геопокрытием или действующим клиентом.');
  }
  return {...actual, mapped: totals.mapped, withoutMarker, unresolvedByReason: Object.fromEntries([...unresolved].sort())};
}

export function formatPackageReport(report) {
  const {points, roles, deficit, mapped, withoutMarker, unresolvedByReason} = report.totals;
  const reasons = {pending: 'нуждается в проверке', different: 'адрес отличается', changed: 'адрес изменился', conflict: 'конфликт адресов'};
  const warnings = Object.entries(unresolvedByReason).map(([reason, count]) => `- Без маркера, ${reasons[reason] ?? 'адрес уточняется'} — ${count}.\n`).join('');
  return `# Пакет обновления потребности

${report.status === 'READY_FOR_REVIEW' ? 'Проверен, ожидает решения владельца о выпуске.' : 'Испытательный пакет для проверки цепочки.'}

- Источник — ${report.source}
- Дата HRM — ${report.hrmDate}
- ID снимка — \`${report.snapshotId}\`
- ТТ — ${points}, позиции ТТ+роль — ${roles}, недобор — ${deficit} чел.
- На карте — ${mapped}, без маркера — ${withoutMarker}
${warnings}
Проверены паспорт и обе витрины, свежесть и идентификатор снимка, привязка координат, SHA-256 файлов, квитанции выпуска и отката. Предыдущий выпуск включён в пакет.
`;
}

export async function buildDemandPackage({request, input, mode, folder, fetcher, now = new Date()}) {
  parsePackageRequest(request);
  if (!Object.hasOwn(sources, mode)) throw Error('Неизвестный источник пакета.');
  const target = resolve(folder);
  await mkdir(dirname(target), {recursive: true});
  try {
    await lstat(target);
    throw Error('Папка пакета уже существует.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const work = await mkdtemp(join(dirname(target), '.package-incomplete-'));
  try {
    const baseline = join(work, 'previous');
    const releaseDir = join(work, 'release');
    await phase('Резерв действующей карты не прошёл проверку. Пакет остановлен.', () => savePagesBaseline(baseline, fetcher));
    const previous = await readStoredBaseline(baseline, now.getTime());
    if (!previous.protectedClient) throw Error('Действующая карта должна поддерживать откат.');
    const {points, cities, passportGrid} = await phase('Не удалось прочитать зарегистрированную испытательную агентскую витрину.', input);
    const passport = validateHandoff(readDispatchPassport(passportGrid, request.request_id, now));
    if (passport.id !== request.snapshot_id || passport.sourceDate !== request.hrm_date) {
      throw Error('ID снимка или дата HRM расходятся с указанными в запросе.');
    }
    const {snapshot, coordinates, totals} = await assembleChecked(passport, points, cities, previous, now);

    const demandFile = join(work, 'input-demand.json');
    const coordinatesFile = join(work, 'input-coordinates.json');
    const report = await phase('Проверка состава, квитанций или сборка пакета завершилась ошибкой.', async () => {
      await Promise.all([[demandFile, snapshot], [coordinatesFile, coordinates]].map(([path, value]) =>
        writeFile(path, JSON.stringify(value) + '\n', {flag: 'wx'})));
      await prepareRelease(baseline, demandFile, coordinatesFile, releaseDir, now);
      const release = await readStoredBaseline(releaseDir, now.getTime());
      const verified = checkArchivedRelease(previous, release, passport, totals);
      await Promise.all([rm(demandFile), rm(coordinatesFile)]);
      return {
        status: mode === 'sheets' ? 'READY_FOR_REVIEW' : 'TEST_ONLY',
        source: sources[mode], hrmDate: passport.sourceDate, snapshotId: passport.id,
        acceptedAt: passport.acceptedAt, requestId: request.request_id, totals: verified,
        files: release.manifest, previousFiles: previous.manifest,
      };
    });
    await phase('Действующая карта изменилась или недоступна. Снимите новый резерв.',
      () => verifyPagesBaseline(previous.manifest, fetcher));
    await Promise.all([
      writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'}),
      writeFile(join(work, 'report.md'), formatPackageReport(report), {flag: 'wx'}),
    ]);
    await rename(work, target);
    return report;
  } finally {
    await rm(work, {recursive: true, force: true});
  }
}

function assembleChecked(passport, points, cities, previous, now) {
  const accepted = new Date(passport.acceptedAt);
  if (accepted > now || dateKey(passport.sourceDate) > dateKey(moscowDay.format(accepted))) {
    throw Error('Дата HRM или время принятия снимка находится в будущем.');
  }
  if (dateKey(passport.sourceDate) < dateKey(previous.snapshot.sourceDate) ||
      +accepted <= Math.max(Date.parse(previous.snapshot.publishedAt), Date.parse(previous.rollback?.restoredAt) || 0) ||
      [previous.snapshot.snapshotId, previous.rollback?.failedSnapshotId].includes(passport.id)) {
    throw Error('Снимок уже опубликован, отменён или старше действующей версии.');
  }
  return phase('Паспорт, точки, города или подтверждённые адреса не прошли сверку.', () =>
    assemble(passport, points, cities, JSON.parse(previous.files['coordinates.json']), previous.snapshot, null, accepted));
}

const json = async path => JSON.parse(await readFile(path, 'utf8'));

async function run(mode, paths) {
  const [folder, replayPath] = paths;
  if (!folder || paths.length > 2 || (mode === 'replay') !== Boolean(replayPath)) {
    throw Error('Команды: sheets папка, fixture папка, replay папка локальный-снимок.json.');
  }
  let report;
  switch (mode) {
    case 'sheets': {
      const env = process.env;
      const event = await json(env.GITHUB_EVENT_PATH);
      const requestFile = env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === integrationRef
        ? await json('.github/demand-package-test-request.json') : null;
      const request = packageRequestForRun(event, env, requestFile);
      report = await buildDemandPackage({mode, request, input: () => readPreviewInput(env), folder});
      break;
    }
    case 'fixture': {
      const {demandPackageFixture} = await import('./demand-package-fixture.mjs');
      const {request, input, fetcher, now} = await demandPackageFixture();
      report = await buildDemandPackage({mode, request, input: () => input, folder, fetcher, now});
      break;
    }
    case 'replay': {
      const {request, ...input} = await phase('Не удалось прочитать локальный снимок витрин.', () => json(replayPath));
      report = await buildDemandPackage({mode, request, input: () => input, folder});
      break;
    }
    default: throw Error('Выберите sheets, fixture или replay.');
  }
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, formatPackageReport(report));
  console.log(report.status, basename(resolve(folder)));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await run(process.argv[2], process.argv.slice(3)); }
  catch (error) {
    console.error(error instanceof SyntaxError ? 'Некорректный JSON во входе или архиве.' : error.message);
    process.exitCode = 1;
  }
}
