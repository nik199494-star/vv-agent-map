var VV_PREVIEW_PROPERTIES = ['VV_PREVIEW_WORK_ID', 'VV_PREVIEW_KB_ID', 'VV_PREVIEW_AGENT_ID'];
var VV_PREVIEW_HIDDEN = ['_NORM v2', '_FULL v2 live', '_POINTS v2 calc', '_CITIES v2 calc', '_Telegram calc'];

function vvPreviewOriginals_() {
  var original = PropertiesService.getScriptProperties().getProperty('VV_PREVIEW_ORIGINAL_WORK_ID') || '';
  if (!original || vvHash_(original) !== VV_PREVIEW_WORK_HASH) throw Error('Сверьте VV_PREVIEW_ORIGINAL_WORK_ID с ID исходной рабочей книги.');
  return [original].concat(VV_PREVIEW_PUBLIC_ORIGINALS);
}

function vvPreviewConfig_() {
  var props = PropertiesService.getScriptProperties();
  var ids = VV_PREVIEW_PROPERTIES.map(function (name) { return props.getProperty(name) || ''; });
  var originals = vvPreviewOriginals_();
  if (new Set(ids).size !== 3 || ids.some(function (id) {
    return !/^[A-Za-z0-9_-]{30,100}$/u.test(id) || originals.includes(id);
  })) throw Error('Укажите ID трёх разных испытательных копий в свойствах скрипта.');
  return ids;
}

function vvPreviewAllowed_(book) {
  try { return Boolean(book && book.getId() === vvPreviewConfig_()[0]); } catch (_) { return false; }
}

function vvPreviewAssert_(book) {
  if (!vvPreviewAllowed_(book)) throw Error('Установочный пакет разрешён только в зарегистрированной рабочей копии.');
  return vvPreviewConfig_();
}

function vvPreviewWrite_(book, passport) {
  var ids = vvPreviewAssert_(book);
  if (passport.length > 45000) throw Error('Паспорт preview слишком длинный для ячейки Google Sheets.');
  var agent = SpreadsheetApp.openById(ids[2]);
  var tab = vvTable_(agent, 'Паспорт preview', ['Маркер', 'Паспорт']);
  var marker = Utilities.getUuid();
  tab.getRange('A2:B2').setValues([[marker, passport]]);
  SpreadsheetApp.flush();
  return marker;
}

function vvPreviewReferencePlan_(value, ids, originals) {
  return originals.reduce(function (next, original, i) { return next.split(original).join(ids[i]); }, value);
}

function vvPreviewWorkbookRefs_(book, ids, apply) {
  var hits = new Map();
  var originals = vvPreviewOriginals_();
  originals.forEach(function (original) {
    book.createTextFinder(original).matchCase(true).matchFormulaText(true).findAll().forEach(function (cell) {
      var key = cell.getSheet().getSheetId() + '!' + cell.getA1Notation();
      hits.set(key, cell);
    });
  });
  var formulas = 0, inputs = 0, other = 0;
  hits.forEach(function (cell) {
    var formula = cell.getFormula();
    var value = formula || cell.getValue();
    var next = typeof value === 'string' && vvPreviewReferencePlan_(value, ids, originals);
    if (!next || next === value) { other++; return; }
    if (formula) {
      formulas++;
      if (apply) cell.setFormula(next);
    } else if (/^(?:https:\/\/docs\.google\.com\/spreadsheets\/d\/)?[A-Za-z0-9_-]{30,100}(?:\/edit(?:[?#][^\s]*)?\/?)?$/u.test(value.trim())) {
      inputs++;
      if (apply) cell.setValue(next);
    } else {
      other++;
    }
  });
  return {formulas: formulas, inputCells: inputs, otherMatches: other};
}

function vvPreviewHiddenAudit_(book) {
  return VV_PREVIEW_HIDDEN.map(function (name) {
    var tab = book.getSheetByName(name);
    if (!tab) return {name: name, exists: false};
    var width = Math.max(1, tab.getLastColumn());
    var height = Math.max(1, Math.min(30, tab.getLastRow()));
    var top = tab.getRange(1, 1, height, width);
    var formulas = top.getFormulas().flat().filter(Boolean);
    var errors = top.getDisplayValues().flat().filter(function (value) {
      return /^#(?:REF!|ERROR!|N\/A|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)/iu.test(value);
    });
    var links = new Set();
    formulas.forEach(function (formula) {
      var m = formula.match(/IMPORTRANGE\s*\(\s*"(?:https:\/\/docs\.google\.com\/spreadsheets\/d\/)?([A-Za-z0-9_-]{30,100})/giu) || [];
      m.forEach(function (entry) { links.add(entry); });
    });
    return {name: name, exists: true, hidden: tab.isSheetHidden(), formulas: formulas.length, errors: errors.length, externalImports: links.size};
  });
}

function vvPreviewAudit_(apply) {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var ids = vvPreviewAssert_(book);
  var books = [book, SpreadsheetApp.openById(ids[1]), SpreadsheetApp.openById(ids[2])];
  if (apply) {
    books.forEach(function (copy) { vvPreviewWorkbookRefs_(copy, ids, true); });
    SpreadsheetApp.flush();
  }
  return {references: books.map(function (copy) { return vvPreviewWorkbookRefs_(copy, ids, false); }),
    hidden: vvPreviewHiddenAudit_(book)};
}

function vvPreviewRebind() {
  var report = vvPreviewAudit_(true);
  SpreadsheetApp.getUi().alert('Остаточные ссылки и формулы v2\n' + JSON.stringify(report, null, 2));
}

function vvPreviewInspect() {
  var report = vvPreviewAudit_(false);
  SpreadsheetApp.getUi().alert('Ссылки и формулы v2\n' + JSON.stringify(report, null, 2));
}

function vvPreviewCheckBeforeRun_(book) {
  vvPreviewAssert_(book);
  var report = vvPreviewAudit_(false);
  if (report.references.some(function (row) { return row.formulas || row.inputCells; })) {
    throw Error('В копиях остались формулы или исходные ячейки со ссылками на production.');
  }
  if (report.hidden.some(function (sheet) { return !sheet.exists || !sheet.formulas || sheet.errors; })) {
    throw Error('Проверьте формулы v2 и разрешения IMPORTRANGE в испытательном контуре.');
  }
}
