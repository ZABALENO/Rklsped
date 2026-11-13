/**
 * Most mezi aplikací na Renderu a tabulkou "Řepa - evidence přeprav od řidičů".
 * Vložte do Rozšíření > Apps Script v dané tabulce, nastavte vlastnost skriptu TOKEN
 * a nasaďte jako Webová aplikace (Spustit jako: já, Přístup: kdokoli).
 *
 * Listy: "Řidiči" (Jméno, Příjmení, Dopravce, SPZ, Typ vozidla, PIN, Aktivní)
 *        "Záznamy" (zapisuje se sem: A–O ze skriptu, P = Cena vyplňuje kancelář)
 */

var SHEET_DRIVERS = 'Řidiči';
var SHEET_RECORDS = 'Záznamy';

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token || body.token !== token) return out_({ ok: false, error: 'unauthorized' });

    if (body.action === 'login') return out_(login_(body));
    if (body.action === 'append') return out_(append_(body));
    return out_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return out_({ ok: false, error: 'server_error' });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function norm_(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function drivers_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_DRIVERS);
  var rows = sh.getDataRange().getDisplayValues();
  var list = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[0] && !r[1]) continue;
    list.push({
      jmeno: r[0], prijmeni: r[1], dopravce: r[2], spz: r[3], typ: r[4],
      pin: String(r[5]).trim(), aktivni: norm_(r[6]) === 'ano'
    });
  }
  return list;
}

function publicDriver_(d) {
  return { jmeno: d.jmeno, prijmeni: d.prijmeni, dopravce: d.dopravce, spz: d.spz, typ: d.typ };
}

function login_(b) {
  var pin = String(b.pin || '').trim();
  var prijmeni = norm_(b.prijmeni);
  if (!pin || !prijmeni) return { ok: false, error: 'bad_credentials' };
  var list = drivers_();
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    if (d.aktivni && d.pin && d.pin === pin && norm_(d.prijmeni) === prijmeni) {
      return { ok: true, driver: publicDriver_(d) };
    }
  }
  return { ok: false, error: 'bad_credentials' };
}

function serialDate_(iso) { // "YYYY-MM-DD" -> číslo data v Sheets
  var p = iso.split('-');
  return Math.round((Date.UTC(+p[0], +p[1] - 1, +p[2]) - Date.UTC(1899, 11, 30)) / 86400000);
}

function serialTime_(hhmm) { // "HH:MM" -> zlomek dne
  var p = hhmm.split(':');
  return (+p[0] * 60 + +p[1]) / 1440;
}

function append_(b) {
  var list = drivers_();
  var driver = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i].aktivni && norm_(list[i].jmeno) === norm_(b.jmeno) && norm_(list[i].prijmeni) === norm_(b.prijmeni)) {
      driver = list[i];
      break;
    }
  }
  if (!driver) return { ok: false, error: 'driver_inactive' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS);
    var row = sh.getLastRow() + 1;
    var values = [[
      new Date(),
      driver.jmeno + ' ' + driver.prijmeni,
      driver.dopravce,
      driver.spz,
      driver.typ,
      serialDate_(b.datumNakladky),
      serialTime_(b.casNakladky),
      serialDate_(b.datumVykladky),
      serialTime_(b.casVykladky),
      String(b.trasa),
      String(b.zakaznik),
      String(b.druh),
      Number(b.jizd),
      Number(b.tuny),
      Number(b.km)
    ]];
    // sloupec P (Cena) vyplňuje kancelář, skript do něj nezapisuje
    var rng = sh.getRange(row, 1, 1, 15);
    rng.setNumberFormats([[
      'dd.MM.yyyy HH:mm', '@', '@', '@', '@',
      'dd.MM.yyyy', 'HH:mm', 'dd.MM.yyyy', 'HH:mm', '@', '@', '@',
      '0', '#,##0.00', '#,##0'
    ]]);
    rng.setValues(values);
    return { ok: true, row: row };
  } finally {
    lock.releaseLock();
  }
}
