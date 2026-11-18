import assert from 'node:assert/strict';
import test from 'node:test';
import {assets} from '../build.mjs';
import {assertFreshEnough} from '../source.js';
import {capturePagesBaseline, verifyPagesBaseline} from '../scripts/pages-baseline.mjs';
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
