import {readFile} from 'node:fs/promises';
import {prepareLocations, writeLocationReview} from './locations-admin.mjs';

try {
  const {points} = JSON.parse(await readFile(new URL('../demand.json', import.meta.url), 'utf8'));
  const [option, ...files] = process.argv.slice(2);
  if (option && (option !== '--catalog' || !files.length)) throw new Error('Укажите --catalog и пути к сохранённым страницам карты магазинов ВкусВилла.');
  const report = files.length ? await prepareLocations(points, files) : await writeLocationReview(points);
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
