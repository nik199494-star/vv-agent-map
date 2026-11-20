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
  const {points, cities, passportGrid} = await readPreviewInput(env, fetcher);
  const passport = readDispatchPassport(passportGrid, requestId, now);
  const coordinates = JSON.parse(await readFile(new URL('../coordinates.json', import.meta.url), 'utf8'));
  const baseline = JSON.parse(await readFile(new URL('../demand.json', import.meta.url), 'utf8'));
  const {totals} = assemble(passport, points, cities, coordinates, baseline, null, now);
  return {sourceDate: passport.sourceDate, ...totals};
}

export class PreviewInputError extends Error {}

function googleReadFailure(error, fallback) {
  const status = /^(?:Google OAuth вернул|Агентская книга вернула) HTTP [1-5]\d{2}\.$/u;
  return new PreviewInputError(status.test(error?.message ?? '') ? error.message : fallback);
}

export async function readPreviewInput(env, fetcher = fetch) {
  const workbook = env.VV_PREVIEW_AGENT_ID?.trim();
  if (!/^[A-Za-z0-9_-]{30,100}$/u.test(workbook ?? '') || productionViews.has(workbook)) {
    throw new PreviewInputError('VV_PREVIEW_AGENT_ID должен содержать ID отдельной испытательной агентской книги.');
  }
  let key;
  try { key = JSON.parse(env.VV_PREVIEW_SHEETS_READER?.replace(/^\uFEFF/u, '') ?? 'null'); }
  catch { throw new PreviewInputError('VV_PREVIEW_SHEETS_READER не содержит корректный JSON ключа.'); }
  if (typeof key?.client_email !== 'string' || typeof key?.private_key !== 'string' ||
      !key.client_email || !key.private_key) {
    throw new PreviewInputError('В VV_PREVIEW_SHEETS_READER отсутствуют client_email или приватный ключ сервисного аккаунта.');
  }

  let token;
  try { token = await accessToken(key, fetcher); }
  catch (error) {
    throw googleReadFailure(error, 'Не удалось получить токен Google OAuth. Проверьте ключ читателя и доступность Google.');
  }
  if (typeof token !== 'string' || !token) throw new PreviewInputError('Google OAuth не вернул токен читателя.');
  try {
    const [points, cities, passportGrid] = await readSheetValues(workbook, [...agentRanges, passportRange], token, fetcher);
    return {points, cities, passportGrid};
  } catch (error) {
    throw googleReadFailure(error, 'Не удалось прочитать обе витрины и лист «Паспорт preview» через Sheets API.');
  }
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
