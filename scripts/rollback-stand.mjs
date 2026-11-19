import {createServer} from 'node:http';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {join, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build, assets} from '../build.mjs';
import {prepareRollback, readStoredBaseline, savePagesBaseline, verifyPagesBaseline} from './pages-baseline.mjs';
import {matchesAddress, isPosition} from '../locations.js';
import {sha256} from './projection.mjs';

const port = Number(process.argv[2] ?? 38159);
const origin = 'http://127.0.0.1:' + port;
await build();
const dist = new URL('../dist/', import.meta.url);
const data = new URL('../.data/', import.meta.url);
await mkdir(data, {recursive: true});
const folder = await mkdtemp(fileURLToPath(new URL('rollback-stand-', data)));
const phaseFile = join(folder, 'phase.txt');
const archive = join(folder, 'baseline');
const names = new Set([...assets, 'publication.json', 'rollback.json']);
const base = Object.fromEntries(await Promise.all(assets.map(async name => [name, await readFile(new URL(name, dist))])));
const body = value => Buffer.from(JSON.stringify(value));
const source = JSON.parse(base['demand.json']);
const coordinates = JSON.parse(base['coordinates.json']);
const first = source.points.find(point => matchesAddress(point, coordinates[point.id]) && isPosition(coordinates[point.id].xy));
if (!first) throw Error('В публичной фикстуре стенда нет точки с координатами.');

const time = Date.now() - 10_000;
const olderAt = new Date(time - 172_800_000);
const failedAt = new Date(time - 86_400_000);
const hrm = date => new Intl.DateTimeFormat('ru-RU', {
  year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Europe/Moscow',
}).format(date);
const samePoint = need => ({
  ...first, roles: [{...first.roles[0], need}],
});
const original = {...source, sourceDate: hrm(olderAt), publishedAt: olderAt.toISOString(), points: [samePoint(10)]};
const failed = {...source, sourceDate: hrm(failedAt), publishedAt: failedAt.toISOString(), snapshotId: 'stand-failed', points: [samePoint(20)]};
const forwarded = {...source, sourceDate: hrm(new Date(time)), publishedAt: new Date(time+21000).toISOString(),
  snapshotId: 'stand-forward', points: [samePoint(30)]};

base['demand.json'] = body(original);
base['coordinates.json'] = body({[first.id]: coordinates[first.id]});
base['publication.json'] = body({demand: sha256(base['demand.json']), locations: sha256(base['coordinates.json'])});
const pending = {...base, 'demand.json': body(failed), 'coordinates.json': body({})};
pending['publication.json'] = body({demand: sha256(pending['demand.json']), locations: sha256(pending['coordinates.json'])});

await writeFile(phaseFile, 'baseline');
let restoredFiles, receipt, retries = 0;
const types = {'.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.html':'text/html', '.svg':'image/svg+xml'};
const server = createServer(async (request,response) => {
  try {
    const name = new URL(request.url, origin).pathname.slice(1) || 'index.html';
    if (!names.has(name)) { response.writeHead(404).end(); return; }
    const phase = (await readFile(phaseFile, 'utf8')).trim();
    if (phase === 'baseline' && name === 'publication.json' && retries < 2) {
      retries++;
      response.writeHead(503, {'Retry-After':'0'}).end();
      return;
    }
    if (phase === 'offline' && ['demand.json','coordinates.json','rollback.json','ru-city-centers.json'].includes(name)) {
      response.writeHead(503).end();
      return;
    }
    let file = base[name];
    if (phase === 'failed' || phase === 'stale') file = pending[name];
    if (['mixed','restored','offline','forward'].includes(phase)) file = restoredFiles?.[name];
    if (phase === 'mixed' && name === 'coordinates.json') file = pending[name];
    if (phase === 'forward' && name === 'demand.json') file = body(forwarded);
    if (name === 'rollback.json' && ['mixed','restored','stale','forward'].includes(phase)) file = body(receipt);
    if (!file) { response.writeHead(404).end(); return; }
    response.writeHead(200, {'Content-Type':types[extname(name)] ?? 'text/plain', 'Cache-Control':'no-store'}).end(file);
  } catch {
    response.writeHead(500).end();
  }
});
await new Promise((resolve, reject) => {server.once('error', reject); server.listen(port, '127.0.0.1', resolve);});
try {
  const readStand = (url, options) => fetch(origin + '/' + url.pathname.split('/').at(-1), options);
  await savePagesBaseline(archive, readStand);
  const backup = await readStoredBaseline(archive);
  const failedFile = join(folder, 'failed-demand.json');
  const output = join(folder, 'restore');
  await writeFile(failedFile, pending['demand.json']);
  await prepareRollback(archive, failedFile, output, new Date(time + 1_000));
  restoredFiles = (await readStoredBaseline(output)).files;
  receipt = JSON.parse(restoredFiles['rollback.json']);
  await verifyPagesBaseline(backup.manifest, readStand);
  console.log(JSON.stringify({origin, folder, phaseFile, archive, retries, files:assets.length,
    hrmDates:[original.sourceDate, failed.sourceDate, forwarded.sourceDate]}));
} catch (error) {
  server.close();
  throw error;
}
