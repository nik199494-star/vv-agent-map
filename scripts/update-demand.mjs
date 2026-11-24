import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {assets} from '../build.mjs';
import {buildDemandPackage} from './demand-package.mjs';
import {productionRequest, productionPassport, readProductionInput} from './production-input.mjs';
import {assemble} from './release.mjs';
import {capturePagesBaseline, readStoredBaseline, verifyPagesBaseline} from './pages-baseline.mjs';
import {sha256} from './projection.mjs';

const repository = 'nik199494-star/vv-agent-map';
const allowed = new Set(['demand.json', 'coordinates.json', 'publication.json']);

export function assertDailyFiles(previous, release) {
  if (Object.keys(release).length !== assets.length || assets.some(name =>
    !(name in release) || !(name in previous) || !allowed.has(name) && release[name] !== previous[name])) {
    throw Error('Ежедневный выпуск изменяет интерфейс или содержит неполный набор файлов.');
  }
}

export function githubApi(token, fetcher = fetch) {
  if (!token) throw Error('Отсутствует временный токен GitHub Actions.');
  return async (path, body, method = body ? 'POST' : 'GET') => {
    let response;
    try {
      response = await fetcher('https://api.github.com/repos/' + repository + '/' + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: {authorization: 'Bearer ' + token, accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10', ...(body ? {'content-type': 'application/json'} : {})},
        ...(body ? {body: JSON.stringify(body)} : {}),
      });
    } catch { throw Error('Запрос GitHub не завершён. Повторный запуск сначала проверит опубликованный снимок и main.'); }
    if (!response.ok) throw Error('GitHub вернул HTTP ' + response.status + '.');
    return response.status === 204 ? null : response.json();
  };
}

export async function publishDaily({api, expectedHead, previous, release, files, requestId}) {
  assertDailyFiles(previous, release);
  const main = await api('git/ref/heads/main');
  if (main.object?.sha !== expectedHead) throw Error('main изменился. Запустите обновление заново на текущем main.');
  const commit = await api('git/commits/' + expectedHead);
  const tree = await api('git/trees/' + commit.tree.sha + '?recursive=1');
  if (tree.truncated || !Array.isArray(tree.tree)) throw Error('GitHub вернул неполное дерево main.');
  const entries = new Map(tree.tree.map(entry => [entry.path, entry]));
  const mainFiles = {};
  for (const name of assets) {
    const entry = entries.get(name);
    if (entry?.type !== 'blob' || entry.mode !== '100644') throw Error('Некорректный публичный файл в main: ' + name);
    const blob = await api('git/blobs/' + entry.sha);
    if (blob.encoding !== 'base64') throw Error('Неподдерживаемый формат файла main.');
    mainFiles[name] = sha256(Buffer.from(blob.content, 'base64'));
  }
  const alreadyCommitted = assets.every(name => mainFiles[name] === release[name]);
  if (!alreadyCommitted && assets.some(name => mainFiles[name] !== previous[name])) {
    throw Error('main расходится с действующей картой и подготовленным выпуском. Автозамена остановлена.');
  }
  let publishedCommit = expectedHead;
  if (!alreadyCommitted) {
    const changed = assets.filter(name => release[name] !== previous[name]);
    const newEntries = [];
    for (const name of changed) {
      if (!allowed.has(name) || sha256(files[name]) !== release[name]) throw Error('Состав выпуска изменён.');
      const blob = await api('git/blobs', {content: files[name].toString('base64'), encoding: 'base64'});
      newEntries.push({path: name, mode: '100644', type: 'blob', sha: blob.sha});
    }
    const nextTree = await api('git/trees', {base_tree: commit.tree.sha, tree: newEntries});
    const nextCommit = await api('git/commits', {message: 'Обновить потребность · ' + requestId,
      parents: [expectedHead], tree: nextTree.sha});
    // No force: a concurrent main commit cannot be overwritten.
    await api('git/refs/heads/main', {sha: nextCommit.sha, force: false}, 'PATCH');
    publishedCommit = nextCommit.sha;
  }
  // GITHUB_TOKEN pushes do not start Pages; request the existing branch build explicitly.
  await api('pages/builds', {});
  return {commit: publishedCommit, resumed: alreadyCommitted};
}

export async function waitForPublication(manifest, fetcher = fetch, wait = delay, attempts = 24) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await verifyPagesBaseline(manifest, fetcher); return; }
    catch { if (attempt + 1 === attempts) break; }
    await wait(15_000);
  }
  throw Error('Публикация не подтверждена: 24 публичных файла ещё не совпали с выпуском. Сообщение агентам не готово.');
}

export async function updateDemand({event, env, folder, fetcher = fetch, now = new Date(), wait = delay, api}) {
  const requestId = productionRequest(event, env);
  const input = await readProductionInput(env, fetcher);
  const passport = productionPassport(input.passportGrid, requestId, now);
  const github = api ?? githubApi(env.GITHUB_TOKEN, fetcher);
  // This also validates all public hashes and both release/rollback receipts.
  const publicFiles = await capturePagesBaseline(fetcher, wait);
  const snapshot = JSON.parse(publicFiles.files['demand.json']);
  if (snapshot.snapshotId === passport.id) {
    const rebuilt = assemble(passport, input.points, input.cities, JSON.parse(publicFiles.files['coordinates.json']),
      snapshot, null, new Date(passport.acceptedAt)).snapshot;
    if (sha256(JSON.stringify(rebuilt) + '\n') !== publicFiles.manifest['demand.json']) {
      throw Error('Опубликованный ID совпал, содержимое снимка расходится с рабочим паспортом.');
    }
    await mkdir(folder, {recursive: true});
    await writeFile(join(folder, 'result.json'), JSON.stringify({status: 'PUBLISHED', requestId, snapshotId: passport.id, repeated: true}));
    return {status: 'PUBLISHED', repeated: true};
  }
  const request = {request_id: requestId, snapshot_id: passport.id, hrm_date: passport.sourceDate};
  const report = await buildDemandPackage({request, mode: 'production', folder, input: () => input, fetcher, now});
  const release = await readStoredBaseline(join(folder, 'release'), now.getTime());
  const published = await publishDaily({api: github, expectedHead: env.GITHUB_SHA, previous: report.previousFiles,
    release: report.files, files: release.files, requestId});
  await waitForPublication(report.files, fetcher, wait);
  // Ensure the frozen request wasn't replaced while Pages was building.
  const latest = await readProductionInput(env, fetcher);
  const confirmed = productionPassport(latest.passportGrid, requestId, new Date(Math.max(now.getTime(), Date.parse(passport.requestedAt))));
  if (confirmed.digest !== passport.digest || confirmed.id !== passport.id) throw Error('Во время публикации сменился рабочий паспорт.');
  const result = {status: 'PUBLISHED', requestId, snapshotId: passport.id, ...published, totals: report.totals};
  await writeFile(join(folder, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const result = await updateDemand({event, env: process.env, folder: resolve(process.argv[2])});
    console.log(result.status, result.snapshotId ?? 'already-published');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
