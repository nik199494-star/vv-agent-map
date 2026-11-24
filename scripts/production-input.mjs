import {matchesAddress, isPosition} from '../locations.js';
import {readAgentRows, shapePoints} from './agent-data.mjs';
import {readDispatchPassport, PreviewInputError} from './dispatch-preview.mjs';
import {accessToken, readSheetValues, validateHandoff} from './release.mjs';

export const productionRanges = ["'Публикация точки'!A1:P4999", "'Публикация города'!A1:M4999", "'Паспорт публикации'!A1:B2"];
export const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const day = new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'});
export const toCsv = rows => rows.map(row => row.map(cell => '"' + String(cell ?? '').replaceAll('"', '""') + '"').join(',')).join('\n');

export function productionRequest(event, env) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' ||
      !['main', 'refs/heads/main'].includes(event?.ref) || !event.inputs ||
      Object.keys(event.inputs).length !== 1 || !uuid.test(event.inputs.request_id ?? '')) {
    throw Error('Обновление разрешено только из main с UUID зарегистрированного запроса.');
  }
  return event.inputs.request_id;
}

export function productionPassport(grid, requestId, now = new Date()) {
  const value = validateHandoff(readDispatchPassport(grid, requestId, now));
  if (value.kind !== 'production' || value.sourceDateKind !== 'accepted' || !uuid.test(value.id) ||
      !uuid.test(value.sourceSnapshotId ?? '') || !/^[a-f0-9]{64}$/u.test(value.rawDigest ?? '') || value.geo.length ||
      value.sourceDate !== day.format(new Date(value.acceptedAt)) || value.sourceDate !== day.format(now) ||
      Date.parse(value.acceptedAt) > now.getTime()) {
    throw Error('Рабочий паспорт не подтверждает текущее принятие HRM.');
  }
  return value;
}

export async function readProductionInput(env, fetcher = fetch) {
  // Set once by the owner in the protected environment; never accepted as workflow input.
  const productionAgent = env.VV_PRODUCTION_AGENT_ID?.trim();
  if (!/^[A-Za-z0-9_-]{30,100}$/u.test(productionAgent ?? '')) {
    throw new PreviewInputError('Не задана рабочая агентская витрина в закрытых настройках окружения.');
  }
  let key;
  try { key = JSON.parse(env.VV_SHEETS_READER ?? 'null'); }
  catch { throw new PreviewInputError('Ключ читателя не содержит корректный JSON.'); }
  try {
    const token = await accessToken(key, fetcher);
    if (typeof token !== 'string' || !token) throw Error();
    const [points, cities, passportGrid] = await readSheetValues(productionAgent, productionRanges, token, fetcher);
    return {points, cities, passportGrid};
  } catch (error) {
    const safe = /^(?:Google OAuth вернул|Агентская книга вернула) HTTP [1-5]\d{2}\.$/u;
    throw new PreviewInputError(safe.test(error?.message ?? '') ? error.message :
      'Не удалось прочитать рабочую агентскую витрину и паспорт публикации.');
  }
}

// Changed addresses lose their marker until a person confirms new coordinates.
export function pendingAddressChanges(pointRows, coordinates) {
  return shapePoints(readAgentRows(toCsv(pointRows))).points.filter(point =>
    isPosition(coordinates[point.id]?.xy) && !matchesAddress(point, coordinates[point.id]))
    .map(({id, city, address}) => ({id, city, address, status: 'pending'}));
}
