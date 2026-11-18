import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const code = ['Projection', 'Diagnostics', 'HrmExport'].map(name =>
  readFileSync(new URL('../automation/' + name + '.gs', import.meta.url), 'utf8')).join('\n');
const {vvProjectPreviewHrm_, vvCheckPreviewFull_, vvPreviewRawMatches_} = runInNewContext(code +
  '\n({vvProjectPreviewHrm_, vvCheckPreviewFull_, vvPreviewRawMatches_})', {});
const rawHeaders = ['Приоритет', 'Заявка', 'Вакансия', 'В работе', 'Финалисты', 'Открыто позиций',
  'Позиции', 'График', 'Ответственный', 'Заказчик', 'Дата открытия', 'Дата закрытия', 'Сколько дней в работе', 'updated_at'];
const nativeHeaders = ['Приоритет', 'Статус', 'ID', 'Название', 'Город', 'Вакансия', 'В работе', 'Недобор',
  'График работы', 'Закрыто позиций', 'Кол-во позиций', 'Дата создания', 'дату закрытия', 'Заказчик', 'Ответственный'];
const source = ['Критичный', 'Актуальные', 72134, '999ДС Тестовый адрес', 'Москва', 'Авто курьер', 7, 3,
  'Дневные', 1, 4, '18.11.2026', '', '', ''];
const date = '2026-11-18T13:00:00+03:00';
const now = new Date(date).getTime();
const grid = [nativeHeaders, source];

test('FULL XLSX maps the deficit to legacy RAW and preserves the source row', () => {
  const original = JSON.stringify(grid);
  const actual = vvCheckPreviewFull_(grid, rawHeaders, now, 0, 36, date);
  assert.equal(actual.entries.length, 1);
  assert.equal(actual.entries[0].city, 'Москва');
  assert.deepEqual([...actual.raw[1].slice(3, 6)], [3, 1, 4]);
  assert.equal(actual.raw[1][13], '');
  assert.equal(actual.sourceTime, now);
  assert.equal(JSON.stringify(grid), original);
});

test('FULL XLSX rejects missing export metadata, duplicate request ID and inconsistent deficit', () => {
  assert.throws(() => vvCheckPreviewFull_(grid, rawHeaders, now, 0, 36, ''), /подтверждённую рабочую дату/);
  assert.throws(() => vvCheckPreviewFull_([nativeHeaders, source, source], rawHeaders, now, 0, 36, date), /повторный ID/);
  const broken = source.slice();
  broken[7] = 2;
  assert.throws(() => vvCheckPreviewFull_([nativeHeaders, broken], rawHeaders, now, 0, 36, date), /не равен 0/);
});

test('preview retains linked RAW and compares its common business fields', () => {
  const full = vvCheckPreviewFull_(grid, rawHeaders, now, 0, 36, date);
  const linked = [...full.raw[1]];
  linked[6] = 'Вычисляемое поле';
  linked[13] = date;
  assert.ok(vvPreviewRawMatches_(full, {raw: [rawHeaders, linked]}));
  linked[3] = 7;
  assert.equal(vvPreviewRawMatches_(full, {raw: [rawHeaders, linked]}), false);
  assert.equal(vvProjectPreviewHrm_([rawHeaders, linked], rawHeaders).extended, false);
});

test('day-only HRM uses the confirmed Moscow date for both FULL and linked RAW', () => {
  const accepted = vvCheckPreviewFull_(grid, rawHeaders, now, now - 3600000, 1, '2026-11-18');
  assert.equal(accepted.sourceTime, Date.parse('2026-11-18T00:00:00+03:00'));
  assert.equal(accepted.raw[1][13], '');
  assert.equal(vvCheckPreviewFull_(accepted.raw, rawHeaders, now, 0, 1, '2026-11-18').deficit, 3);
  assert.throws(() => vvCheckPreviewFull_(grid, rawHeaders, now, 0, 36, '2026-11-17'), /московским днём/);
  assert.throws(() => vvCheckPreviewFull_(grid, rawHeaders, now, 0, 36, '2026-11-19'), /московским днём/);
});
