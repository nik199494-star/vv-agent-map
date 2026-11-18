import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseRequest} from './preview.mjs';

const path = '.github/preview-request.json';

export function verifyPreviewPush(requestId, revisions, head, attempt) {
  if (attempt !== '1' || revisions[0]?.[0] !== head ||
      revisions[0]?.[1] !== requestId || revisions.slice(1).some(([, previous]) => previous === requestId)) {
    throw Error('Маркер повторный. Создайте новый паспорт и измените запрос отдельным коммитом.');
  }
}

function checkPush() {
  const head = process.env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/u.test(head ?? '')) throw Error('Не указан проверяемый коммит preview.');
  const request = parseRequest(JSON.parse(readFileSync(path, 'utf8')));
  if (request.mode !== 'sheets') throw Error('Проверка маркера ожидает sheets.');
  const git = (...args) => execFileSync('git', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  const commits = git('log', '--first-parent', '--format=%H', head, '--', path).trim().split('\n').filter(Boolean);
  const revisions = commits.map(commit => [commit, JSON.parse(git('show', commit + ':' + path)).requestId]);
  verifyPreviewPush(request.requestId, revisions, head, process.env.GITHUB_RUN_ATTEMPT);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { checkPush(); }
  catch (error) {
    console.error(error.status || error instanceof SyntaxError ? 'Историю запроса preview не удалось проверить.' : error.message);
    process.exitCode = 1;
  }
}
