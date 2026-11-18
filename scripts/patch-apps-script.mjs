import {readFile, writeFile, mkdir, cp} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';

export function patchLegacy(code) {
  let text = code.replace(/\r\n/g, '\n');
  const replace = (pattern, value) => {
    if ([...text.matchAll(new RegExp(pattern.source, 'g' + pattern.flags.replace('g', '')))].length !== 1) {
      throw Error('Версия привязанного кода отличается от проверенной. Сверьте точки интеграции: ' + pattern.source);
    }
    text = text.replace(pattern, value);
  };
  replace(/^\/\*\* @OnlyCurrentDoc \*\//m, '/** @NotOnlyCurrentDoc */');
  replace(/function onOpen\(\)\{SpreadsheetApp\.getUi\(\)\.createMenu\('ВВ Потребность'\)\.addItem\('Принять RAW и сохранить снимок','refreshDemand'\)\.addToUi\(\);\}/,
    "function onOpen(){SpreadsheetApp.getUi().createMenu('ВВ Потребность')\n" +
    " .addItem('Принять снимок и обновить карту','vvAcceptAndPublish')\n" +
    " .addItem('Проверить публикацию','vvCheckMapStatus')\n" +
    " .addSeparator().addItem('Принять RAW и сохранить снимок','refreshDemand')\n" +
    " .addItem('Откатить автоисправления','vvRollbackDictionary').addToUi();}");
  replace(/function refreshDemand\(\)\{\n var lock=LockService\.getDocumentLock\(\);if\(!lock\.tryLock\(1000\)\)return;\n/,
    'function refreshDemand(){\n var lock=LockService.getDocumentLock();if(!lock.tryLock(1000))return;\n' +
    ' try{return refreshDemandCore_();}finally{lock.releaseLock();}\n}\nfunction refreshDemandCore_(){\n');
  replace(/throw err;\}finally\{lock\.releaseLock\(\);\}\n\}/, 'throw err;}\n}');
  replace(/return \[id,tag\];/, 'return [vvId_(id),tag];');
  replace(/d=>clean\(d\[0\]\)===p\[0\]&&p\[0\]/, 'd=>vvId_(d[0])===p[0]&&p[0]');
  replace(/d=>clean\(d\[0\]\)===r\[3\]/, 'd=>vvId_(d[0])===r[3]');
  return text;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [, , source, output = '.data/apps-script-install'] = process.argv;
    if (!source) throw Error('Укажите путь к приватной копии действующего Код.gs.');
    const folder = resolve(output);
    const code = patchLegacy(await readFile(resolve(source), 'utf8'));
    await mkdir(folder, {recursive: true});
    await writeFile(join(folder, 'Code.patched.gs'), code);
    for (const name of ['Projection.gs', 'Diagnostics.gs', 'Geocontrol.gs', 'DemandPipeline.gs']) {
      await cp(new URL('../automation/' + name, import.meta.url), join(folder, name));
    }
    console.log('Локальный патч готов. Файлы рабочей книги не изменялись.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
