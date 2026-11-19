import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {assets} from '../build.mjs';
import {assertFreshEnough} from '../source.js';
import {capturePagesBaseline, prepareRollback, readStoredBaseline, savePagesBaseline, verifyPagesBaseline} from '../scripts/pages-baseline.mjs';
import {sha256} from '../scripts/projection.mjs';

function published() {
  const files = Object.fromEntries(assets.map(name => [name, Buffer.from(name + '\r\n')]));
  files['publication.json'] = Buffer.from(JSON.stringify({
    demand: sha256(files['demand.json']), locations: sha256(files['coordinates.json'])
  }));
  const fetcher = async url => {
    const name = url.pathname.split('/').at(-1);
    return files[name] ? new Response(files[name]) : new Response(null, {status: 404});
  };
  return {files, fetcher};
}

test('mixed browser bundle fails until the exact previous data and assets are restored', async () => {
  const {files, fetcher} = published();
  const baseline = await capturePagesBaseline(fetcher);
  files['demand.json'] = Buffer.from('new demand');
  files['source.js'] = Buffer.from('new browser build');
  await assert.rejects(verifyPagesBaseline(baseline.manifest, fetcher), /не совпадает/);
  files['demand.json'] = baseline.files['demand.json'];
  await assert.rejects(verifyPagesBaseline(baseline.manifest, fetcher), /source\.js/);
  Object.assign(files, baseline.files);
  await verifyPagesBaseline(baseline.manifest, fetcher);
});

test('baseline capture refuses a bad receipt and handles a first deploy without a receipt', async () => {
  const {files, fetcher} = published();
  files['coordinates.json'] = Buffer.from('wrong coordinates');
  await assert.rejects(capturePagesBaseline(fetcher), /квитанцией/);
  delete files['publication.json'];
  const baseline = await capturePagesBaseline(fetcher);
  assert.equal(baseline.manifest['publication.json'], null);
  files['publication.json'] = Buffer.from('{}');
  await assert.rejects(verifyPagesBaseline(baseline.manifest, fetcher), /publication\.json/);
  await assert.rejects(capturePagesBaseline(async () => new Response(null, {status: 503})), /HTTP 503/);
});

test('the current browser freshness guard rejects an older restored snapshot from a warm cache', () => {
  const cached = {sourceDate: '19.11.2026', publishedAt: '2026-11-19T09:00:00Z', snapshotId: 'failed-run'};
  const restored = {sourceDate: '18.11.2026', publishedAt: '2026-11-18T09:00:00Z', rollbackOf: 'failed-run'};
  assert.throws(() => assertFreshEnough(restored, cached), /более ранняя версия/);
  assert.doesNotThrow(() => assertFreshEnough(restored, null));
});

test('two 503 responses recover, but a persistent error leaves no published backup directory', async () => {
  const {fetcher} = published();
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'vv-pages-'));
  if (dirname(root) !== parent) throw Error('Временная папка находится вне каталога тестов.');
  try {
    const notices = [];
    const absent = join(root, 'not-created');
    let failures = 0;
    await assert.rejects(savePagesBaseline(absent, async url => {
      if (url.pathname.endsWith('/publication.json')) { failures++; return new Response(null, {status: 503}); }
      return fetcher(url);
    }, async value => notices.push(value)), /HTTP 503/);
    assert.equal(failures, 3);
    assert.deepEqual(notices, [250, 500]);
    assert.deepEqual(await readdir(root), []);

    let retries = 0;
    const valid = join(root, 'valid');
    await savePagesBaseline(valid, async url => {
      if (url.pathname.endsWith('/publication.json') && retries++ < 2) return new Response(null, {status: 503});
      return fetcher(url);
    }, async () => {});
    const saved = await readStoredBaseline(valid);
    assert.equal(saved.manifest['source.js'], sha256(saved.files['source.js']));
    await writeFile(join(valid, 'source.js'), 'migration bypass');
    await assert.rejects(readStoredBaseline(valid), /source\.js/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('restoration from the verified archive preserves every archived byte other than the new receipt', async () => {
  const {files, fetcher} = published();
  const prev = {schema: 3, sourceDate: '18.11.2026', publishedAt: '2026-11-18T08:00:00Z', points: []};
  const failed = {...prev, sourceDate: '19.11.2026', publishedAt: '2026-11-19T08:00:00Z', snapshotId: 'bad-snapshot'};
  files['demand.json'] = Buffer.from(JSON.stringify(prev) + '\n');
  files['app.js'] = Buffer.from("import './rollback.js';");
  delete files['publication.json'];
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'vv-restore-'));
  if (dirname(root) !== parent) throw Error('Временная папка находится вне каталога тестов.');
  try {
    const archive = join(root, 'archive'), cancelled = join(root, 'failed.json'), prepared = join(root, 'prepared');
    await savePagesBaseline(archive, fetcher);
    await writeFile(cancelled, JSON.stringify(failed));
    await prepareRollback(archive, cancelled, prepared, new Date('2026-11-19T08:15:00Z'));
    const expected = await readStoredBaseline(prepared);
    for (const name of assets) assert.deepEqual(expected.files[name], files[name]);
    const receipt = JSON.parse(await readFile(join(prepared, 'rollback.json'), 'utf8'));
    assert.equal(receipt.failedSnapshotId, failed.snapshotId);
    assert.equal(receipt.hashes['demand.json'], sha256(files['demand.json']));
    await assert.rejects(prepareRollback(archive, cancelled, prepared, new Date('2026-11-19T08:15:00Z')), /уже существует/);
  } finally { await rm(root, {recursive: true, force: true}); }
});
