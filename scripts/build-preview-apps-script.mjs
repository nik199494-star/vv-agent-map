import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Script} from 'node:vm';
import {patchLegacy} from './patch-apps-script.mjs';
import {productionBooks, workingBookIdHash} from './preview.mjs';

function replaceRequired(text, match, replacement) {
  if (text.split(match).length !== 2) throw Error('Изменились точки интеграции испытательного Apps Script.');
  return text.replace(match, () => replacement);
}

export function makePreviewCode(legacy, files, coordinates) {
  let code = patchLegacy(legacy);
  for (const name of ['onOpen()', 'refreshDemand()', 'refreshDemandCore_()']) {
    const start = 'function ' + name + '{';
    code = replaceRequired(code, start, start + 'if(!vvPreviewAllowed_(SpreadsheetApp.getActiveSpreadsheet()))return;');
  }
  code = replaceRequired(code, 'function onEdit(e){', 'function onEdit(e){if(!e||!vvPreviewAllowed_(e.source))return;');
  code = replaceRequired(code, "createMenu('ВВ Потребность')", "createMenu('ВВ Preview')");
  code = replaceRequired(code, ".addItem('Принять снимок и обновить карту','vvAcceptAndPublish')", ".addItem('Принять снимок и создать паспорт preview','vvAcceptAndPublish')");
  code = replaceRequired(code, ".addItem('Проверить публикацию','vvCheckMapStatus')", ".addItem('Связать испытательные копии','vvPreviewRebind')\n .addItem('Проверить ссылки и формулы v2','vvPreviewInspect')");

  let pipe = files.DemandPipeline.replace(/\r\n/g, '\n');
  pipe = pipe.replace(/^var VV_(HOME|GITHUB|KNOWLEDGE|AGENT) = .*;\n/gm, '');
  const head = pipe.indexOf('function vvGithub_('), tail = pipe.indexOf('function vvAcceptAndPublish(');
  if (head < 0 || tail <= head) throw Error('Не найдены точки подключения испытательного режима.');
  pipe = pipe.slice(0, head) + pipe.slice(tail);
  pipe = replaceRequired(pipe, '  var knowledge = SpreadsheetApp.openById(VV_KNOWLEDGE);\n  var agent = SpreadsheetApp.openById(VV_AGENT);',
    '  var ids = vvPreviewConfig_();\n  var knowledge = SpreadsheetApp.openById(ids[1]);\n  var agent = SpreadsheetApp.openById(ids[2]);');
  pipe = replaceRequired(pipe, "    vvSetState_(book, properties, state, 'Проверка данных');",
    "    vvPreviewCheckBeforeRun_(book);\n    vvSetState_(book, properties, state, 'Проверка данных');");
  pipe = replaceRequired(pipe, '  var book = SpreadsheetApp.getActiveSpreadsheet();\n  var lock = LockService.getDocumentLock();',
    '  var book = SpreadsheetApp.getActiveSpreadsheet();\n  vvPreviewAssert_(book);\n  var lock = LockService.getDocumentLock();');
  pipe = replaceRequired(pipe, "JSON.parse(vvPublic_('coordinates.json'))", 'VV_PREVIEW_COORDINATES');
  pipe = replaceRequired(pipe, "properties.getProperty('VV_DEPLOY_MODE') !== 'deploy'", 'true');
  pipe = replaceRequired(pipe, "(previous.status === 'Карта обновлена' || previous.status === 'Проверка GitHub Actions завершена')",
    "previous.status === 'Паспорт preview готов'");
  const dispatchStart = pipe.indexOf('    if (passport.length > 60000)');
  const dispatchEnd = pipe.indexOf('    vvScheduleStatus_();', dispatchStart);
  if (dispatchStart < 0 || dispatchEnd < 0) throw Error('Не найден блок отправки выпуска.');
  pipe = pipe.slice(0, dispatchStart) +
    "    state.marker = vvPreviewWrite_(book, passport);\n" +
    "    state.done = true;\n" +
    "    vvSetState_(book, properties, state, 'Паспорт preview готов');\n" +
    "    vvLog_(journal, state.run, {kind: 'Испытательный снимок', after: state.marker, source: 'Паспорт preview', state: VV_STATUS.ok});" +
    pipe.slice(dispatchEnd + '    vvScheduleStatus_();'.length);

  const geo = replaceRequired(files.Geocontrol, 'function vvRollbackDictionary() {',
    'function vvRollbackDictionary() {\n  vvPreviewAssert_(SpreadsheetApp.getActiveSpreadsheet());');
  const options = 'var VV_PREVIEW_PUBLIC_ORIGINALS = ' + JSON.stringify([...productionBooks]) + ';\n' +
    'var VV_PREVIEW_WORK_HASH = ' + JSON.stringify(workingBookIdHash) + ';\n' +
    'var VV_PREVIEW_COORDINATES = ' + JSON.stringify(coordinates) + ';\n';
  const result = [code, files.Projection, files.Diagnostics, geo, pipe, options, files.Preview].join('\n\n');
  if (/actions\/workflows\/|UrlFetchApp|ScriptApp\.newTrigger|VV_GITHUB_ACTIONS_TOKEN|VV_DEPLOY_MODE/u.test(result)) {
    throw Error('Испытательный Код.gs содержит сетевые или публикационные вызовы.');
  }
  new Script(result);
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [, , source, directory = '.data/preview-install'] = process.argv;
    if (!source) throw Error('Укажите путь к закрытой выгрузке действующего Код.gs.');
    const legacy = await readFile(resolve(source), 'utf8');
    const names = ['Projection', 'Diagnostics', 'Geocontrol', 'DemandPipeline', 'Preview'];
    const files = Object.fromEntries(await Promise.all(names.map(async name =>
      [name, await readFile(new URL('../automation/' + name + '.gs', import.meta.url), 'utf8')])));
    const coordinates = JSON.parse(await readFile(new URL('../coordinates.json', import.meta.url), 'utf8'));
    const compiled = makePreviewCode(legacy, files, coordinates);
    const folder = resolve(directory);
    await mkdir(folder, {recursive: true});
    await writeFile(join(folder, 'Code.preview.gs'), compiled);
    await writeFile(join(folder, 'source-sha256.txt'), createHash('sha256').update(legacy).digest('hex') + '\n');
    console.log('Пакет preview сгенерирован. Синтаксис проверен.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
