import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Script} from 'node:vm';

export async function bundleUnifiedScript(inputPath, outputPath) {
  if (!inputPath || !outputPath || resolve(inputPath) === resolve(outputPath)) throw Error('Укажите отдельные пути резерва и нового файла.');
  const original = await readFile(inputPath, 'utf8');
  const menu = /^function onOpen\(\)\{SpreadsheetApp\.getUi\(\)\.createMenu\('ВВ Потребность'\)\.addItem\('Принять RAW и сохранить снимок','refreshDemand'\)\.addToUi\(\);\}/m;
  if (!menu.test(original) || original.includes('var VV_UPDATE =') || !original.includes('function refreshDemand()')) {
    throw Error('Действующий код изменился или модуль уже установлен. Нужна проверка перед заменой.');
  }
  const legacy = original.replace('/** @OnlyCurrentDoc */', '').replace(menu, 'function onOpen(){vvUnifiedOnOpen();}');
  const projection = await readFile(new URL('../automation/Projection.gs', import.meta.url), 'utf8');
  const addon = await readFile(new URL('../automation/UnifiedDemand.gs', import.meta.url), 'utf8');
  const result = legacy + '\n\n' + projection + '\n\n' + addon + '\n';
  new Script(result);
  await writeFile(outputPath, result, {flag: 'wx'});
  return {originalBytes: Buffer.byteLength(original), bundleBytes: Buffer.byteLength(result)};
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { console.log(JSON.stringify(await bundleUnifiedScript(process.argv[2], process.argv[3]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
