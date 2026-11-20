import {readFile} from 'node:fs/promises';
import {assets} from '../build.mjs';
import {agentHeaders} from './agent-data.mjs';
import {project, sha256} from './projection.mjs';

export async function demandPackageFixture() {
  const request = {
    request_id: 'ef53a51d-5741-496c-8b84-c868661cb9e2',
    snapshot_id: 'ce65c029-cfa6-4b1f-8a14-135a014e6add',
    hrm_date: '20.11.2026',
  };
  const sourceDate = request.hrm_date;
  const row = (id, address, role, need) => ['Высокий', '', 'Москва', id, address, role, '', need, '', '', '', '', '', '', '', ''];
  const points = [[], [], [sourceDate], agentHeaders,
    row('999001', 'Москва, Тестовая улица 1', 'Авто-курьер', 3),
    row('999001', 'Москва, Тестовая улица 1', 'Пеший курьер', 2),
    row('999002', 'Москва, Тестовая улица 2', 'Электровелокурьер', 5)];
  const cities = [[], [], [sourceDate], ['Город', 'Недобор'], ['Москва', 10]];
  const {signature, ...projection} = project(points, 'agent');
  const passport = {
    id: request.snapshot_id, sourceDate,
    acceptedAt: '2026-11-20T08:00:00.000Z', requestedAt: '2026-11-20T08:01:00.000Z',
    digest: sha256(signature), metrics: {points: projection.points, roles: projection.roles, deficit: projection.deficit},
    geo: [
      {id: '999001', city: 'Москва', address: 'Москва, Тестовая улица 1', status: 'confirmed',
        xy: [55.75, 37.62], source: 'https://www.openstreetmap.org/', checkedOn: '2026-11-20'},
      {id: '999002', city: 'Москва', address: 'Москва, Тестовая улица 2', status: 'pending'},
    ],
  };
  const files = new Map(await Promise.all(assets.map(async name => [name, await readFile(new URL('../' + name, import.meta.url))])));
  return {
    request,
    input: {points, cities, passportGrid: [['Маркер', 'Паспорт'], [request.request_id, JSON.stringify(passport)]]},
    passport,
    now: new Date('2026-11-20T08:02:00.000Z'),
    fetcher: url => {
      const pathname = new URL(url).pathname.replace(/^\/vv-agent-map\//u, '');
      return new Response(files.get(pathname || 'index.html'), {status: files.has(pathname || 'index.html') ? 200 : 404});
    },
  };
}
