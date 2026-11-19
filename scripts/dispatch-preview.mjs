import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {accessToken, agentRanges, assemble, readSheetValues} from './release.mjs';

const requestIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const productionViews = new Set([
  '1jnZHSosr0d3PA7HaLcMFi48CHMHSpgVCG17MXT0Utzc',
  '1NPBnTgakkfiaa31ZznAg-iPw1e5Fi94Mu27IT8X_O-w',
]);
const passportRange = "'Паспорт preview'!A1:B2";

export function validateDispatch(event, env) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' ||
      !['main', 'refs/heads/main'].includes(event?.ref)) {
    throw Error('Проверка выпуска разрешена только через workflow_dispatch из main.');
  }
  const input = event.inputs;
  if (!input || Object.keys(input).length !== 2 || input.mode !== 'preview' || !requestIdPattern.test(input.request_id ?? '')) {
    throw Error('Укажите режим preview и UUID из испытательного паспорта.');
  }
  return input.request_id;
}

export function readDispatchPassport(grid, requestId, now) {
  if (grid[0]?.[0] !== 'Маркер' || grid[0]?.[1] !== 'Паспорт' || grid[1]?.[0] !== requestId) {
    throw Error('Маркер запуска расходится с паспортом испытательной книги.');
  }
  let passport;
  try { passport = JSON.parse(grid[1][1]); }
  catch { throw Error('Некорректный паспорт испытательного снимка.'); }
  const age = now.getTime() - Date.parse(passport?.requestedAt);
  if (!Number.isFinite(age) || age < -5 * 60_000 || age > 6 * 3_600_000) {
    throw Error('Запрос preview просрочен или содержит неверное время.');
  }
  return passport;
}

export async function runDispatchPreview(event, env, now = new Date(), fetcher = fetch) {
  const requestId = validateDispatch(event, env);
  const workbook = env.VV_PREVIEW_AGENT_ID;
  if (!/^[A-Za-z0-9_-]{30,100}$/u.test(workbook ?? '') || productionViews.has(workbook)) {
    throw Error('Укажите ID отдельной испытательной агентской книги.');
  }
  let key;
  try { key = JSON.parse(env.VV_PREVIEW_SHEETS_READER ?? 'null'); }
  catch { throw Error('Ключ читателя должен быть JSON-файлом сервисной учётной записи.'); }

  const token = await accessToken(key, fetcher);
  if (typeof token !== 'string' || !token) throw Error('Google OAuth не вернул токен читателя.');
  const [points, cities, passportGrid] = await readSheetValues(workbook, [...agentRanges, passportRange], token, fetcher);
  const passport = readDispatchPassport(passportGrid, requestId, now);
  const coordinates = JSON.parse(await readFile(new URL('../coordinates.json', import.meta.url), 'utf8'));
  const baseline = JSON.parse(await readFile(new URL('../demand.json', import.meta.url), 'utf8'));
  const {totals} = assemble(passport, points, cities, coordinates, baseline, null, now);
  return {sourceDate: passport.sourceDate, ...totals};
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    switch (process.argv[2]) {
      case 'gate':
        validateDispatch(event, process.env);
        break;
      case 'verify':
        await runDispatchPreview(event, process.env);
        console.log('Испытательный паспорт подтверждён.');
        break;
      default:
        throw Error('Выберите gate или verify.');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
