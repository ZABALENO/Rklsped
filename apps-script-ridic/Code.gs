/**
 * Most mezi aplikací na Renderu a tabulkou "Řepa - evidence přeprav od řidičů".
 * Vložte do Rozšíření > Apps Script v dané tabulce, nastavte vlastnost skriptu TOKEN
 * a nasaďte jako Webová aplikace (Spustit jako: já, Přístup: kdokoli).
 *
 * Listy: "Řidiči" (Jméno, Příjmení, Dopravce, SPZ, Typ vozidla, PIN, Aktivní)
 *        "Záznamy" (zapisuje se sem: A–O ze skriptu, P = Cena vyplňuje kancelář, Q = ID záznamu (skrytý), R = Poznámka, S–AA = Tuny 2–10, AB–AJ = Cena 2–10 (ceny vyplňuje kancelář))
 */

var SHEET_DRIVERS = 'Řidiči';
var SHEET_RECORDS = 'Záznamy';
var SHEET_CUSTOMERS = 'Zákazníci';   // sloupec A = nabízení zákazníci (od řádku 2)

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token || body.token !== token) return out_({ ok: false, error: 'unauthorized' });

    if (body.action === 'login') return out_(login_(body));
    if (body.action === 'append') return out_(append_(body));
    if (body.action === 'list') return out_(list_(body));
    if (body.action === 'customers') return out_(customers_());
    if (body.action === 'update') return out_(update_(body));
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

var MAX_JIZD = 10;      // tuny/ceny jednotlivých jízd: Tuny 2–10 = sloupce S–AA, Cena 2–10 = sloupce AB–AJ
var COL_TUNY2 = 19;     // sloupec S

function append_(b) {
  var driver = findDriver_(b);
  if (!driver) return { ok: false, error: 'driver_inactive' };

  var n = Math.max(1, Math.min(MAX_JIZD, Math.floor(Number(b.jizd) || 1)));
  var tuny = Object.prototype.toString.call(b.tuny) === '[object Array]' ? b.tuny : [b.tuny];
  var spz = String(driver.spz || '').trim() || String(b.spz || '').trim();

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS);
    var row = sh.getLastRow() + 1;
    function tn(k) { var t = tuny[k]; return (t === null || t === undefined || t === '') ? '' : Number(t); }
    // jedna přeprava = jeden řádek; sloupec N = tuny 1. jízdy, další jízdy v S...
    var rng = sh.getRange(row, 1, 1, 15);
    rng.setNumberFormats([[
      'dd.MM.yyyy HH:mm', '@', '@', '@', '@',
      'dd.MM.yyyy', 'HH:mm', 'dd.MM.yyyy', 'HH:mm', '@', '@', '@',
      '0', '#,##0.00', '#,##0'
    ]]);
    rng.setValues([[
      new Date(),
      driver.jmeno + ' ' + driver.prijmeni,
      driver.dopravce,
      spz,
      'Sklápěč',            // typ vozidla je vždy sklápěč
      serialDate_(b.datumNakladky),
      serialTime_(b.casNakladky),
      serialDate_(b.datumVykladky),
      serialTime_(b.casVykladky),
      String(b.trasa),
      String(b.zakaznik),
      String(b.druh),
      n,
      tn(0),
      Number(b.km)
    ]]);
    // sloupec P (Cena 1) vyplňuje kancelář, skript do něj nezapisuje
    sh.getRange(row, 17).setNumberFormat('@').setValue(Utilities.getUuid());                       // Q = ID záznamu
    sh.getRange(row, 18).setNumberFormat('@').setValue(String(b.poznamka || '').slice(0, 300));    // R = Poznámka
    if (n > 1) {
      var extra = [];
      for (var k = 1; k < n; k++) extra.push(tn(k));
      var er = sh.getRange(row, COL_TUNY2, 1, n - 1);
      er.setNumberFormat('#,##0.00');
      er.setValues([extra]);
    }
    return { ok: true, row: row, jizd: n };
  } finally {
    lock.releaseLock();
  }
}

var SCAN_ROWS = 1500;   // kolik posledních řádků list prohledává

function findDriver_(b) {
  var list = drivers_();
  for (var i = 0; i < list.length; i++) {
    if (list[i].aktivni && norm_(list[i].jmeno) === norm_(b.jmeno) && norm_(list[i].prijmeni) === norm_(b.prijmeni)) return list[i];
  }
  return null;
}

function isoDate_(disp) { // "dd.MM.yyyy" -> "YYYY-MM-DD"
  var m = String(disp).match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/);
  if (!m) return '';
  return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
}

function hhmm_(disp) {
  var m = String(disp).match(/^(\d{1,2}):(\d{2})/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : '';
}

function num_(disp) {
  var t = String(disp).replace(/\s/g, '').replace(',', '.');
  return t === '' ? '' : t;
}

// záznamy přihlášeného řidiče (nejnovější první), jen ty s ID
function list_(b) {
  var driver = findDriver_(b);
  if (!driver) return { ok: false, error: 'driver_inactive' };
  var full = norm_(driver.jmeno + ' ' + driver.prijmeni);
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS);
  var last = sh.getLastRow();
  if (last < 2) return { ok: true, rows: [] };
  var start = Math.max(2, last - SCAN_ROWS + 1);
  var data = sh.getRange(start, 1, last - start + 1, COL_TUNY2 + MAX_JIZD - 2).getDisplayValues();
  var rows = [];
  for (var i = data.length - 1; i >= 0 && rows.length < 100; i--) {
    var r = data[i];
    if (!r[16] || norm_(r[1]) !== full) continue;
    var jz = Math.max(1, Math.min(MAX_JIZD, parseInt(r[12], 10) || 1));
    var tuny = [num_(r[13])];
    for (var k = 1; k < jz; k++) tuny.push(num_(r[COL_TUNY2 - 1 + k - 1]));
    rows.push({
      id: r[16], spz: r[3],
      datumNakladky: isoDate_(r[5]), casNakladky: hhmm_(r[6]),
      datumVykladky: isoDate_(r[7]), casVykladky: hhmm_(r[8]),
      trasa: r[9], zakaznik: r[10], druh: r[11], jizd: jz, tuny: tuny, km: num_(r[14]), poznamka: r[17]
    });
  }
  return { ok: true, rows: rows };
}

// úprava vlastního záznamu podle ID
function update_(b) {
  var driver = findDriver_(b);
  if (!driver) return { ok: false, error: 'driver_inactive' };
  var full = norm_(driver.jmeno + ' ' + driver.prijmeni);
  var id = String(b.id || '');
  if (!id) return { ok: false, error: 'not_found' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS);
    var last = sh.getLastRow();
    if (last < 2) return { ok: false, error: 'not_found' };
    var start = Math.max(2, last - SCAN_ROWS + 1);
    var data = sh.getRange(start, 1, last - start + 1, 18).getDisplayValues();
    var row = 0, jz = 1;
    for (var i = data.length - 1; i >= 0; i--) {
      if (data[i][16] === id) {
        if (norm_(data[i][1]) === full) { row = start + i; jz = Math.max(1, Math.min(MAX_JIZD, parseInt(data[i][12], 10) || 1)); }
        break;
      }
    }
    if (!row) return { ok: false, error: 'not_found' };
    var tuny = Object.prototype.toString.call(b.tuny) === '[object Array]' ? b.tuny : [b.tuny];
    function tn(k) { var t = tuny[k]; return (t === null || t === undefined || t === '') ? '' : Number(t); }
    sh.getRange(row, 6, 1, 7).setValues([[
      serialDate_(b.datumNakladky), serialTime_(b.casNakladky),
      serialDate_(b.datumVykladky), serialTime_(b.casVykladky),
      String(b.trasa), String(b.zakaznik), String(b.druh)
    ]]);
    sh.getRange(row, 14, 1, 2).setValues([[tn(0), Number(b.km)]]);
    if (jz > 1) {
      var extra = [];
      for (var k = 1; k < jz; k++) extra.push(tn(k));
      sh.getRange(row, COL_TUNY2, 1, jz - 1).setValues([extra]);
    }
    sh.getRange(row, 18).setNumberFormat('@').setValue(String(b.poznamka || '').slice(0, 300));   // R = Poznámka
    return { ok: true, row: row };
  } finally {
    lock.releaseLock();
  }
}

// seznam zákazníků pro našeptávač ve formuláři (list "Zákazníci", sloupec A)
function customers_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CUSTOMERS);
  if (!sh || sh.getLastRow() < 2) return { ok: true, customers: [] };
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getDisplayValues();
  var seen = {}, out = [];
  for (var i = 0; i < vals.length; i++) {
    var n = String(vals[i][0]).trim();
    if (n && n.length <= 120 && !seen[n.toLowerCase()]) { seen[n.toLowerCase()] = 1; out.push(n); }
  }
  return { ok: true, customers: out };
}
