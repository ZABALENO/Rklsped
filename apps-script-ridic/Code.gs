/**
 * Most mezi aplikací na Renderu a tabulkou "Řepa - evidence přeprav od řidičů".
 * Vložte do Rozšíření > Apps Script v dané tabulce, nastavte vlastnost skriptu TOKEN
 * a nasaďte jako Webová aplikace (Spustit jako: já, Přístup: kdokoli).
 *
 * Listy: "Řidiči" (Jméno, Příjmení, Dopravce, SPZ, Typ vozidla, PIN, Aktivní)
 *        "Záznamy" (zapisuje se sem: J = Místo nakládky, K = Místo vykládky, O = Poznámka, P = Příloha (odkaz), pak střídavě Tuny 1, Cena 1, Tuny 2, Cena 2 … (od Q; ceny vyplňuje kancelář), AK = ID záznamu (skrytý))
 */

var SHEET_DRIVERS = 'Řidiči';
var SHEET_RECORDS = 'Záznamy';
var SHEET_DONE = 'Zpracováno';
var SHEET_LORI = 'Přepravy do Lori';
var LORI_DELAY_MS = 30 * 60 * 1000;
var SHEET_CUSTOMERS = 'Zákazníci';   // sloupec A = nabízení zákazníci (od řádku 2)

function layout_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS);
  O = String(sh.getRange(1, 1).getDisplayValue()).trim() === 'Příloha' || String(sh.getRange(1, 1).getDisplayValue()).trim() === 'Doklad' ? 1 : 0;
  COL_NOTE = 15 + O; COL_DOC = O ? 1 : 16;
  // nové rozložení: za každou Cenu k je ještě sloupec Směna k (STRIDE 3), jinak jen Tuny+Cena (STRIDE 2)
  STRIDE = /^Sm[eě]na/i.test(String(sh.getRange(1, COL_T1 + 2).getDisplayValue()).trim()) ? 3 : 2;
  COL_ID = COL_T1 + STRIDE * MAX_JIZD;
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token || body.token !== token) return out_({ ok: false, error: 'unauthorized' });
    layout_();

    if (body.action === 'login') return out_(login_(body));
    if (body.action === 'append') return out_(append_(body));
    if (body.action === 'list') return out_(list_(body));
    if (body.action === 'customers') return out_(customers_());
    if (body.action === 'update') return out_(update_(body));
    if (body.action === 'delete') return out_(delete_(body));
    if (body.action === 'napad') return out_(napad_(body));
    if (body.action === 'doc') return out_(doc_(body));
    if (body.action === 'ceny') return out_(prices_list_(body));
    if (body.action === 'cenySet') return out_(prices_set_(body));
    if (body.action === 'docGet') return out_(docGet_(body));
    if (body.action === 'vse') return out_(vse_(body));
    if (body.action === 'bunka') return out_(bunka_(body));
    if (body.action === 'skup') return out_(skup_(body));
    if (body.action === 'zprac') return out_(zprac_(body));
    if (body.action === 'docDel') return out_(docDel_(body));
    if (body.action === 'docRepl') return out_(docRepl_(body));
    if (body.action === 'radek') return out_(radek_(body));
    if (body.action === 'adminList') return out_(adminList_(body));
    if (body.action === 'adminSet') return out_(adminSet_(body));
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
  // sloupec H = Admin (ano = vidí ikonku peněz); dokud sloupec v listu není, je admin jen Soukeník
  var hasAdminCol = rows.length > 0 && rows[0].length >= 8;
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[0] && !r[1]) continue;
    list.push({
      jmeno: r[0], prijmeni: r[1], dopravce: r[2], spz: r[3], typ: r[4],
      pin: String(r[5]).trim(), aktivni: norm_(r[6]) === 'ano',
      admin: hasAdminCol ? norm_(r[7]) === 'ano' : norm_(r[1]) === 'soukenik'
    });
  }
  return list;
}

function publicDriver_(d) {
  return { jmeno: d.jmeno, prijmeni: d.prijmeni, dopravce: d.dopravce, spz: d.spz, typ: d.typ, admin: !!d.admin };
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

var MAX_JIZD = 10;      // jízdy 1–10: ve sloupcích Q… jsou střídavě Tuny k, Cena k (Tuny 1 = Q, Cena 1 = R, Tuny 2 = S, Cena 2 = T …)
var O = 0;              // posun prvních 15 sloupců: 1 = nové rozložení (A = Příloha), 0 = staré
var COL_NOTE = 15;      // Poznámka (nové rozložení: P)
var COL_DOC = 16;       // Doklad (nové rozložení: A) – odkazy na PDF na Google Disku
var COL_T1 = 17;        // Q = Tuny 1
var STRIDE = 2;         // počet sloupců na jízdu: 2 = Tuny, Cena; 3 = Tuny, Cena, Směna
var COL_ID = 37;        // ID záznamu (skrytý; za posledním sloupcem jízd)
var DOC_FOLDER = 'Přílohy řidičů - Řepa';
var DOC_FOLDER_OLD = 'Doklady řidičů - Řepa';
function colTuny_(k) { return COL_T1 + STRIDE * k; }
function colSmena_(k) { return COL_T1 + STRIDE * k + 2; }   // jen při STRIDE 3
var SM_DEN = 'denní', SM_NOC = 'noční';
function smenaVal_(c) { return c === 'N' ? SM_NOC : (c === 'D' ? SM_DEN : ''); }
function smenaCode_(disp) {   // rozumí textu i starším emoji
  var t = String(disp).toLowerCase();
  if (t.indexOf('no\u010d') >= 0 || t.indexOf('\uD83C\uDF19') >= 0) return 'N';
  if (t.indexOf('denn') >= 0 || t.indexOf('den\u0148') >= 0 || t.indexOf('\u2600') >= 0) return 'D';
  return '';
}
function smenyArr_(b) { return Object.prototype.toString.call(b.smeny) === '[object Array]' ? b.smeny : []; }
function writeSmeny_(sh, row, n, smeny) {
  if (STRIDE < 3) return;
  for (var k = 0; k < n; k++) sh.getRange(row, colSmena_(k)).setNumberFormat('@').setHorizontalAlignment('center').setValue(smenaVal_(smeny[k] === 'N' ? 'N' : 'D'));
}   // k = 0 pro 1. jízdu; Cena k je o sloupec dál (vyplňuje kancelář)

// odkazy na přílohy z buňky (hypertextové úseky; záloha: starší vzorec HYPERLINK)
function docUrls_(rt, formula) {
  var out = [];
  if (rt) { var runs = rt.getRuns(); for (var i = 0; i < runs.length; i++) { var u = runs[i].getLinkUrl(); if (u && out.indexOf(u) < 0) out.push(u); } }
  if (!out.length && formula) { var m = /"(https:[^"]+)"/.exec(String(formula)); if (m) out.push(m[1]); }
  return out;
}
// text buňky: jedna ikona 📄 na přílohu (každá s vlastním odkazem)
function docRich_(urls) {
  if (!urls.length) return SpreadsheetApp.newRichTextValue().setText('').build();
  var text = '', pos = [];
  for (var i = 0; i < urls.length; i++) { if (i) text += ' '; pos.push([text.length, text.length + 2]); text += '\uD83D\uDCC4'; }
  var b = SpreadsheetApp.newRichTextValue().setText(text);
  for (var j = 0; j < urls.length; j++) b.setLinkUrl(pos[j][0], pos[j][1], urls[j]);
  return b.build();
}

function append_(b) {
  var driver = findDriver_(b);
  if (!driver) return { ok: false, error: 'driver_inactive' };

  var n = Math.max(1, Math.min(MAX_JIZD, Math.floor(Number(b.jizd) || 1)));
  var tuny = Object.prototype.toString.call(b.tuny) === '[object Array]' ? b.tuny : [b.tuny];
  var spz = String(b.spz || '').trim() || String(driver.spz || '').trim();   // zvolená SPZ má přednost před tabulkou

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS);
    var row = sh.getLastRow() + 1;
    function tn(k) { var t = tuny[k]; return (t === null || t === undefined || t === '') ? '' : Number(t); }
    // jedna přeprava = jeden řádek
    var rng = sh.getRange(row, 1 + O, 1, 14);
    rng.setNumberFormats([[
      'dd.MM.yyyy HH:mm', '@', '@', '@', '@',
      'dd.MM.yyyy', 'HH:mm', 'dd.MM.yyyy', 'HH:mm', '@', '@', '@', '@',
      '0'
    ]]);
    rng.setValues([[
      new Date(),
      driver.jmeno + ' ' + driver.prijmeni,
      driver.dopravce,
      spz,
      'Sklápěč',            // typ vozidla je vždy sklápěč
      serialDate_(b.datumNakladky),
      '',
      serialDate_(b.datumVykladky),
      '',
      String(b.mistoNakladky),
      String(b.mistoVykladky),
      String(b.zakaznik),
      String(b.druh),
      n
    ]]);
    sh.getRange(row, COL_NOTE).setNumberFormat('@').setValue(String(b.poznamka || '').slice(0, 300));
    for (var k = 0; k < n; k++) {      // ceny jízd (sloupec za tunami) vyplňuje kancelář, skript do nich nezapisuje
      var t = tn(k);
      if (t !== '') sh.getRange(row, colTuny_(k)).setNumberFormat('#,##0.00').setValue(t);
    }
    writeSmeny_(sh, row, n, smenyArr_(b));
    var newId = Utilities.getUuid();
    sh.getRange(row, COL_ID).setNumberFormat('@').setValue(newId);
    return { ok: true, row: row, jizd: n, id: newId };
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

function isoDt_(disp) { // "dd.MM.yyyy HH:mm" -> "YYYY-MM-DDTHH:mm"
  var m = String(disp).match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return '';
  return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) + 'T' + ('0' + m[4]).slice(-2) + ':' + m[5];
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
  var data = sh.getRange(start, 1, last - start + 1, COL_ID).getDisplayValues();
  var rts = sh.getRange(start, COL_DOC, last - start + 1, 1).getRichTextValues();
  var fms = sh.getRange(start, COL_DOC, last - start + 1, 1).getFormulas();
  var rows = [];
  for (var i = data.length - 1; i >= 0 && rows.length < 100; i--) {
    var r = data[i];
    if (!r[COL_ID - 1] || norm_(r[1+O]) !== full) continue;
    var jz = Math.max(1, Math.min(MAX_JIZD, parseInt(r[13+O], 10) || 1));
    var tuny = [], smeny = [];
    for (var k = 0; k < jz; k++) { tuny.push(num_(r[colTuny_(k) - 1])); smeny.push(STRIDE > 2 ? smenaCode_(r[colSmena_(k) - 1]) : ''); }
    rows.push({
      id: r[COL_ID - 1], spz: r[3+O],
      datumNakladky: isoDate_(r[5+O]),
      datumVykladky: isoDate_(r[7+O]),
      mistoNakladky: r[9+O], mistoVykladky: r[10+O], zakaznik: r[11+O], druh: r[12+O], jizd: jz, tuny: tuny, smeny: smeny, poznamka: r[COL_NOTE - 1], hasDoc: !!r[COL_DOC - 1], docs: docUrls_(rts[i][0], fms[i][0]).length
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
    var data = sh.getRange(start, 1, last - start + 1, COL_ID).getDisplayValues();
    var row = 0, jz = 1;
    for (var i = data.length - 1; i >= 0; i--) {
      if (data[i][COL_ID - 1] === id) {
        if (norm_(data[i][1+O]) === full) { row = start + i; jz = Math.max(1, Math.min(MAX_JIZD, parseInt(data[i][13+O], 10) || 1)); }
        break;
      }
    }
    if (!row) return { ok: false, error: 'not_found' };
    var tuny = Object.prototype.toString.call(b.tuny) === '[object Array]' ? b.tuny : [b.tuny];
    function tn(k) { var t = tuny[k]; return (t === null || t === undefined || t === '') ? '' : Number(t); }
    sh.getRange(row, 6 + O).setValue(serialDate_(b.datumNakladky));
    sh.getRange(row, 8 + O).setValue(serialDate_(b.datumVykladky));
    sh.getRange(row, 10 + O, 1, 4).setValues([[String(b.mistoNakladky), String(b.mistoVykladky), String(b.zakaznik), String(b.druh)]]);
    sh.getRange(row, COL_NOTE).setNumberFormat('@').setValue(String(b.poznamka || '').slice(0, 300));
    // nový počet jízd (volitelný): přidá/odebere jízdy a upraví sloupec Počet jízd
    var nj = (b.jizd === undefined || b.jizd === null || b.jizd === '') ? jz : Math.max(1, Math.min(MAX_JIZD, Math.floor(Number(b.jizd) || jz)));
    if (nj !== jz) sh.getRange(row, 14 + O).setValue(nj);
    for (var k = 0; k < nj; k++) {
      sh.getRange(row, colTuny_(k)).setNumberFormat('#,##0.00').setValue(tn(k));
    }
    writeSmeny_(sh, row, nj, smenyArr_(b));
    for (var q = nj; q < jz; q++) {            // odebrané jízdy: smaže tuny, cenu i směnu
      sh.getRange(row, colTuny_(q), 1, STRIDE).clearContent();
    }
    return { ok: true, row: row, jizd: nj };
  } finally {
    lock.releaseLock();
  }
}

// nápad na zlepšení od řidiče -> list „Nápady od řidičů“ (vytvoří se při prvním použití)
var SHEET_IDEAS = 'Nápady od řidičů';
function napad_(b) {
  var driver = findDriver_(b);
  if (!driver) return { ok: false, error: 'driver_inactive' };
  var text = String(b.text || '').trim();
  if (text.length < 3 || text.length > 1000) return { ok: false, error: 'bad_request' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActive();
    var sh = ss.getSheetByName(SHEET_IDEAS);
    if (!sh) {
      sh = ss.insertSheet(SHEET_IDEAS);
      sh.getRange(1, 1, 1, 3).setValues([['Čas', 'Řidič', 'Nápad / návrh na úpravu']]).setFontWeight('bold');
      sh.setFrozenRows(1);
      sh.setColumnWidth(1, 130); sh.setColumnWidth(2, 160); sh.setColumnWidth(3, 620);
      sh.getRange('C:C').setWrap(true).setVerticalAlignment('top');
    }
    var row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, 3).setNumberFormats([['dd.MM.yyyy HH:mm', '@', '@']])
      .setValues([[new Date(), driver.jmeno + ' ' + driver.prijmeni, text]]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// smaže záznam (řádek) podle ID: řidič jen svůj, Soukeník (ceny) kterýkoli
function delete_(b) {
  var driver = b.owner === true ? { jmeno: 'Robin', prijmeni: 'Balcar' } : findDriver_(b);
  if (!driver) return { ok: false, error: 'driver_inactive' };
  var full = norm_(driver.jmeno + ' ' + driver.prijmeni);
  var isAdmin = !!admin_(b);
  var id = String(b.id || '');
  if (!id) return { ok: false, error: 'not_found' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS);
    var last = sh.getLastRow();
    if (last < 2) return { ok: false, error: 'not_found' };
    var start = Math.max(2, last - SCAN_ROWS + 1);
    var data = sh.getRange(start, 1, last - start + 1, COL_ID).getDisplayValues();
    for (var i = data.length - 1; i >= 0; i--) {
      if (data[i][COL_ID - 1] === id) {
        if (!isAdmin && norm_(data[i][1+O]) !== full) return { ok: false, error: 'not_found' };
        sh.deleteRow(start + i);
        return { ok: true };
      }
    }
    return { ok: false, error: 'not_found' };
  } finally {
    lock.releaseLock();
  }
}

// uloží přílohu (PDF, base64) k vlastnímu záznamu na Google Disk a vloží odkaz do tabulky (sloupec Příloha)
function doc_(b) {
  var driver = findDriver_(b);
  if (!driver) return { ok: false, error: 'driver_inactive' };
  var full = norm_(driver.jmeno + ' ' + driver.prijmeni);
  var id = String(b.id || '');
  if (!id || !b.pdf) return { ok: false, error: 'not_found' };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS);
    var last = sh.getLastRow();
    if (last < 2) return { ok: false, error: 'not_found' };
    var start = Math.max(2, last - SCAN_ROWS + 1);
    var data = sh.getRange(start, 1, last - start + 1, COL_ID).getDisplayValues();
    var row = 0, info = null;
    for (var i = data.length - 1; i >= 0; i--) {
      if (data[i][COL_ID - 1] === id) { if (norm_(data[i][1+O]) === full) { row = start + i; info = data[i]; } break; }
    }
    if (!row) return { ok: false, error: 'not_found' };
    var it = DriveApp.getFoldersByName(DOC_FOLDER), folder;
    if (it.hasNext()) folder = it.next();
    else { var old = DriveApp.getFoldersByName(DOC_FOLDER_OLD); if (old.hasNext()) { folder = old.next(); folder.setName(DOC_FOLDER); } else folder = DriveApp.createFolder(DOC_FOLDER); }
    var safe = function (t) { return String(t || '').replace(/[\\\/:*?"<>|]/g, '').replace(/\s+/g, '_').slice(0, 40); };
    var name = isoDate_(info[5+O]) + '_' + safe(driver.prijmeni) + '_' + safe(info[11+O]) + '_' + id.slice(0, 6) + '.pdf';
    var blob = Utilities.newBlob(Utilities.base64Decode(String(b.pdf)), 'application/pdf', name);
    var file = folder.createFile(blob);
    var dc = sh.getRange(row, COL_DOC), urls = docUrls_(dc.getRichTextValue(), dc.getFormula());
    urls.push(file.getUrl());
    dc.setRichTextValue(docRich_(urls));
    return { ok: true, row: row };
  } finally {
    lock.releaseLock();
  }
}

// seznam zákazníků pro našeptávač ve formuláři (list "Zákazníci", sloupec A)
// ---- ceny (jen přihlášený Soukeník) ----
var ADMIN_PRIJMENI = 'soukenik';
function admin_(b) {
  if (b.owner === true) return { jmeno: 'Robin', prijmeni: 'Balcar', admin: true };   // majitel (skryté přihlášení v aplikaci)
  var d = findDriver_(b);
  return (d && d.admin) ? d : null;
}

// všechny záznamy všech řidičů (nejnovější první) včetně tun a cen
function prices_list_(b) {
  if (!admin_(b)) return { ok: false, error: 'forbidden' };
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS);
  var last = sh.getLastRow();
  if (last < 2) return { ok: true, rows: [] };
  var start = Math.max(2, last - SCAN_ROWS + 1);
  var data = sh.getRange(start, 1, last - start + 1, COL_ID).getDisplayValues();
  var rts = sh.getRange(start, COL_DOC, last - start + 1, 1).getRichTextValues();
  var fms = sh.getRange(start, COL_DOC, last - start + 1, 1).getFormulas();
  var zp = zpracMap_();
  var rows = [];
  for (var i = data.length - 1; i >= 0 && rows.length < 400; i--) {
    var r = data[i];
    if (!r[COL_ID - 1]) continue;
    var jz = Math.max(1, Math.min(MAX_JIZD, parseInt(r[13+O], 10) || 1));
    var tuny = [], ceny = [], smeny = [];
    for (var k = 0; k < jz; k++) { tuny.push(num_(r[colTuny_(k) - 1])); ceny.push(num_(r[colTuny_(k)])); smeny.push(STRIDE > 2 ? smenaCode_(r[colSmena_(k) - 1]) : ''); }
    rows.push({
      id: r[COL_ID - 1], zapsano: isoDt_(r[O]), ridic: r[1+O], dopravce: r[2+O], spz: r[3+O],
      datumNakladky: isoDate_(r[5+O]), datumVykladky: isoDate_(r[7+O]),
      mistoNakladky: r[9+O], mistoVykladky: r[10+O], zakaznik: r[11+O], druh: r[12+O],
      jizd: jz, tuny: tuny, ceny: ceny, smeny: smeny, poznamka: r[COL_NOTE - 1], docs: docUrls_(rts[i][0], fms[i][0]).length, zprac: zp[r[COL_ID - 1]] ? 1 : 0
    });
  }
  return { ok: true, rows: rows };
}

// zapíše ceny k jízdám jednoho záznamu (prázdná hodnota cenu smaže)
function prices_set_(b) {
  if (!admin_(b)) return { ok: false, error: 'forbidden' };
  var id = String(b.id || '');
  if (!id) return { ok: false, error: 'not_found' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS);
    var last = sh.getLastRow();
    if (last < 2) return { ok: false, error: 'not_found' };
    var start = Math.max(2, last - SCAN_ROWS + 1);
    var data = sh.getRange(start, 1, last - start + 1, COL_ID).getDisplayValues();
    var row = 0, jz = 1;
    for (var i = data.length - 1; i >= 0; i--) {
      if (data[i][COL_ID - 1] === id) { row = start + i; jz = Math.max(1, Math.min(MAX_JIZD, parseInt(data[i][13+O], 10) || 1)); break; }
    }
    if (!row) return { ok: false, error: 'not_found' };
    var ceny = Object.prototype.toString.call(b.ceny) === '[object Array]' ? b.ceny : [];
    for (var k = 0; k < jz; k++) {
      var v = ceny[k], c = sh.getRange(row, colTuny_(k) + 1);
      if (v === null || v === undefined || v === '') c.clearContent();
      else c.setNumberFormat('#,##0.00').setValue(Number(v));
    }
    return { ok: true, row: row };
  } finally {
    lock.releaseLock();
  }
}

// vrátí PDF přílohy (base64) k záznamu – jen pro Soukeníka
function docGet_(b) {
  var adm = !!admin_(b);
  var drv = (b.owner === true) ? null : findDriver_(b);
  if (!adm && !drv) return { ok: false, error: 'forbidden' };   // admin kterýkoli doklad, řidič jen svůj
  var id = String(b.id || '');
  if (!id) return { ok: false, error: 'not_found' };
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS);
  var last = sh.getLastRow();
  if (last < 2) return { ok: false, error: 'not_found' };
  var start = Math.max(2, last - SCAN_ROWS + 1);
  var ids = sh.getRange(start, COL_ID, last - start + 1, 1).getDisplayValues();
  var row = 0;
  for (var i = ids.length - 1; i >= 0; i--) { if (ids[i][0] === id) { row = start + i; break; } }
  if (!row) return { ok: false, error: 'not_found' };
  if (!adm && norm_(sh.getRange(row, 2 + O).getDisplayValue()) !== norm_(drv.jmeno + ' ' + drv.prijmeni)) return { ok: false, error: 'forbidden' };
  var cell = sh.getRange(row, COL_DOC), urls = docUrls_(cell.getRichTextValue(), cell.getFormula());
  var m = /\/d\/([\w-]+)/.exec(urls[Math.max(0, Math.min(urls.length - 1, parseInt(b.n, 10) || 0))] || '');
  if (!m) return { ok: false, error: 'no_doc' };
  try {
    var blob = DriveApp.getFileById(m[1]).getBlob();
    return { ok: true, pdf: Utilities.base64Encode(blob.getBytes()) };
  } catch (e) { return { ok: false, error: 'no_doc' }; }
}

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

// JEDNORÁZOVÁ MIGRACE: sloupec Příloha přesune na začátek (A) jako ikony 📄 s odkazy; stará pozice (P) zanikne
function presunDoklad() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS);
  if (String(sh.getRange(1, 1).getDisplayValue()).trim() === 'Příloha') return 'uz hotovo';
  if (String(sh.getRange(1, 16).getDisplayValue()).trim() !== 'Doklad' && String(sh.getRange(1, 16).getDisplayValue()).trim() !== 'Příloha') return 'neocekavane rozlozeni';
  var last = sh.getLastRow(), urls = [];
  if (last >= 2) {
    var rg = sh.getRange(2, 16, last - 1, 1), rts = rg.getRichTextValues(), fms = rg.getFormulas();
    for (var i = 0; i < rts.length; i++) urls.push(docUrls_(rts[i][0], fms[i][0]));
  }
  sh.insertColumnBefore(1);
  sh.getRange(1, 2).copyTo(sh.getRange(1, 1), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  sh.getRange(1, 1).setValue('Příloha');
  sh.deleteColumn(17);
  if (urls.length) {
    var vals = urls.map(function (u) { return [docRich_(u)]; });
    sh.getRange(2, 1, urls.length, 1).setRichTextValues(vals).setHorizontalAlignment('center').setFontSize(14);
  }
  sh.showColumns(1, 37);
  var w = [48,105,110,85,75,70,80,52,80,52,105,105,100,80,50,110];
  for (var j = 0; j < w.length; j++) sh.setColumnWidth(j + 1, w[j]);
  sh.hideColumns(37);
  layout_();
  return 'ok A1=' + sh.getRange(1, 1).getValue() + ' Q1=' + sh.getRange(1, 17).getValue() + ' AK1=' + sh.getRange(1, 37).getValue();
}


// JEDNORÁZOVÁ MIGRACE: za každý sloupec Cena vloží sloupec Směna a skryje sloupce Čas nakládky / Čas vykládky
function pridatSmeny() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS);
  layout_();
  if (STRIDE === 3) return 'uz hotovo';
  if (!O) return 'neocekavane rozlozeni';
  for (var k = MAX_JIZD - 1; k >= 0; k--) {
    var cenaCol = COL_T1 + 2 * k + 1;
    sh.insertColumnAfter(cenaCol);
    sh.getRange(1, cenaCol).copyTo(sh.getRange(1, cenaCol + 1), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    sh.getRange(1, cenaCol + 1).setValue('Směna ' + (k + 1));
    sh.setColumnWidth(cenaCol + 1, 70);
  }
  sh.hideColumns(8); sh.hideColumns(10);   // Čas nakládky, Čas vykládky
  layout_();
  return 'hotovo, STRIDE=' + STRIDE + ', ID ve sloupci ' + COL_ID;
}


// JEDNORÁZOVĚ: sloupec Datum nakládky přejmenuje na Datum směny a skryje Datum vykládky
function jedenDatum() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS);
  sh.getRange(1, 7).setValue('Datum směny');
  sh.hideColumns(9);
  return 'hotovo';
}


// JEDNORÁZOVĚ: starší emoji ve sloupcích Směna přepíše na text denní / noční
function smenyNaText() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS);
  layout_();
  var last = sh.getLastRow();
  if (STRIDE !== 3 || last < 2) return 'nic';
  var n = 0;
  for (var k = 0; k < MAX_JIZD; k++) {
    var rg = sh.getRange(2, colSmena_(k), last - 1, 1), v = rg.getDisplayValues(), out = [];
    for (var i = 0; i < v.length; i++) {
      var c = smenaCode_(v[i][0]), nv = c ? smenaVal_(c) : v[i][0];
      if (nv !== v[i][0]) n++;
      out.push([nv]);
    }
    rg.setNumberFormat('@').setHorizontalAlignment('center').setValues(out);
  }
  return 'prepsano ' + n;
}


// ---- správa adminů (jen majitel; sloupec H "Admin" v listu Řidiči) ----
function adminList_(b) {
  if (b.owner !== true) return { ok: false, error: 'forbidden' };
  var cnt = {}, perDay = {};
  var rec = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS);
  var last = rec.getLastRow();
  if (last >= 2) {
    var vals = rec.getRange(2, 1, last - 1, 2 + O).getDisplayValues();
    for (var i = 0; i < vals.length; i++) {
      var nm = String(vals[i][1 + O]).trim(), k = norm_(nm);
      if (!k) continue;
      cnt[k] = (cnt[k] || 0) + 1;
      var den = isoDt_(vals[i][O]).slice(0, 10);
      if (den) { var key = den + '|' + nm; perDay[key] = (perDay[key] || 0) + 1; }
    }
  }
  var dny = Object.keys(perDay).sort().reverse().slice(0, 400).map(function (key) {
    var p = key.split('|'); return { den: p[0], ridic: p[1], n: perDay[key] };
  });
  return { ok: true, dny: dny, rows: drivers_().map(function (d) {
    return { jmeno: String(d.jmeno).trim(), prijmeni: String(d.prijmeni).trim(), aktivni: d.aktivni, admin: !!d.admin, pin: d.pin, pocet: cnt[norm_(d.jmeno + ' ' + d.prijmeni)] || 0 };
  }) };
}

function adminSet_(b) {
  if (b.owner !== true) return { ok: false, error: 'forbidden' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_DRIVERS);
    var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 8)).getDisplayValues()[0];
    var col = 0;
    for (var c = 7; c < head.length; c++) if (norm_(head[c]) === 'admin') { col = c + 1; break; }
    if (!col) { col = 8; sh.getRange(1, col).setValue('Admin'); }
    var rows = sh.getDataRange().getDisplayValues();
    var want = norm_(b.jmeno + ' ' + b.prijmeni);
    for (var i = 1; i < rows.length; i++) {
      if (norm_(rows[i][0] + ' ' + rows[i][1]) === want) {
        sh.getRange(i + 1, col).setValue(b.admin === true ? 'ANO' : '');
        SpreadsheetApp.flush();
        return { ok: true };
      }
    }
    return { ok: false, error: 'not_found' };
  } finally {
    lock.releaseLock();
  }
}


// ---- všechna data ze všech listů (jen admin; PIN vidí jen majitel) ----
function vse_(b) {
  if (!admin_(b)) return { ok: false, error: 'forbidden' };
  var owner = b.owner === true;
  var out = [];
  var zp = zpracMap_();
  SpreadsheetApp.getActive().getSheets().forEach(function (sh) {
    if (sh.getName() === SHEET_DONE) return;
    var vals = sh.getDataRange().getDisplayValues();
    if (!vals.length) { out.push({ name: sh.getName(), head: [], rows: [], total: 0 }); return; }
    var head = vals[0], rows = vals.slice(1);
    var isRec = sh.getName() === SHEET_RECORDS;
    var meta = null;
    if (isRec && rows.length) {
      var rt = sh.getRange(2, COL_DOC, rows.length, 1).getRichTextValues();
      var fm = sh.getRange(2, COL_DOC, rows.length, 1).getFormulas();
      meta = rows.map(function (r, i) { return { id: r[COL_ID - 1] || '', docs: docUrls_(rt[i][0], fm[i][0]).length, zprac: zp[r[COL_ID - 1]] ? 1 : 0 }; });
    }
    var keep = [];
    for (var c = 0; c < head.length; c++) {
      var has = String(head[c]).trim() !== '';
      for (var r = 0; r < rows.length && !has; r++) if (String(rows[r][c]).trim() !== '') has = true;
      if (has) keep.push(c);
    }
    var pinCol = (sh.getName() === SHEET_DRIVERS) ? head.indexOf('PIN') : -1;
    var res = [], mt = [], rn = [];
    rows.forEach(function (r, i) {
      if (!r.some(function (x) { return String(x).trim() !== ''; })) return;
      res.push(keep.map(function (c) { return (c === pinCol && !owner && String(r[c]).trim()) ? '••••' : r[c]; }));
      rn.push(i + 2);
      if (meta) mt.push(meta[i]);
    });
    var total = res.length;
    if (isRec) { res.reverse(); mt.reverse(); rn.reverse(); }
    var o = { name: sh.getName(), head: keep.map(function (c) { return head[c]; }), rows: res.slice(0, 3000), total: total };
    if (isRec) { o.meta = mt.slice(0, 3000); o.docCol = keep.indexOf(COL_DOC - 1); }
    o.rn = rn.slice(0, 3000);
    o.cn = keep.map(function (c) { return c + 1; });
    o.ro = isRec ? [keep.indexOf(COL_DOC - 1), keep.indexOf(COL_ID - 1)].filter(function (x) { return x >= 0; }) : [];
    if (sh.getName() === SHEET_DRIVERS && !owner) {   // PIN a Admin mění jen majitel
      [head.indexOf('PIN'), head.indexOf('Admin')].forEach(function (c) { var k = keep.indexOf(c); if (k >= 0) o.ro.push(k); });
    }
    out.push(o);
  });
  return { ok: true, sheets: out };
}


// ---- úpravy v tabulce (jen majitel) ----
function bunka_(b) {
  if (!admin_(b)) return { ok: false, error: 'forbidden' };
  var row = parseInt(b.row, 10), col = parseInt(b.col, 10);
  var sh = SpreadsheetApp.getActive().getSheetByName(String(b.sheet || ''));
  if (!sh || !(row >= 2) || !(col >= 1) || col > sh.getMaxColumns() || row > sh.getMaxRows()) return { ok: false, error: 'bad_request' };
  if (sh.getName() === SHEET_RECORDS && (col === COL_ID || col === COL_DOC)) return { ok: false, error: 'readonly' };
  if (sh.getName() === SHEET_DRIVERS && b.owner !== true) {
    var hn = norm_(sh.getRange(1, col).getDisplayValue());
    if (hn === 'pin' || hn === 'admin') return { ok: false, error: 'readonly' };   // PIN a Admin mění jen majitel
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var cell = sh.getRange(row, col);
    if (String(cell.getDisplayValue()) !== String(b.old === undefined ? '' : b.old)) return { ok: false, error: 'conflict' };
    var v = String(b.value === undefined ? '' : b.value);
    var head = String(sh.getRange(1, col).getDisplayValue()).trim();
    if ((sh.getName() === SHEET_DRIVERS && norm_(head) === 'pin') || /^0\d+$/.test(v)) cell.setNumberFormat('@');
    cell.setValue(v);
    SpreadsheetApp.flush();
    return { ok: true, value: cell.getDisplayValue() };
  } finally {
    lock.releaseLock();
  }
}

function radek_(b) {
  if (!admin_(b)) return { ok: false, error: 'forbidden' };
  var name = String(b.sheet || '');
  if (name !== SHEET_DRIVERS && name !== SHEET_CUSTOMERS) return { ok: false, error: 'bad_request' };
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  var vals = b.vals || {};
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var all = sh.getDataRange().getDisplayValues();
    if (name === SHEET_DRIVERS) {
      var jm = String(vals['1'] || '').trim(), pr = String(vals['2'] || '').trim(), pin = String(vals['6'] || '').trim();
      if (!jm || !pr || !pin) return { ok: false, error: 'missing' };
      for (var i = 1; i < all.length; i++) if (norm_(all[i][0] + ' ' + all[i][1]) === norm_(jm + ' ' + pr)) return { ok: false, error: 'duplicate' };
      if (!String(vals['7'] || '').trim()) vals['7'] = 'ANO';
      if (b.owner !== true) delete vals['8'];   // admina nastavuje jen majitel
    } else {
      var nm = String(vals['1'] || '').trim();
      if (!nm) return { ok: false, error: 'missing' };
      for (var j = 1; j < all.length; j++) if (norm_(all[j][0]) === norm_(nm)) return { ok: false, error: 'duplicate' };
    }
    var row = sh.getLastRow() + 1;
    if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 10);
    Object.keys(vals).forEach(function (k) {
      var c = parseInt(k, 10);
      if (!(c >= 1) || c > sh.getMaxColumns()) return;
      var cell = sh.getRange(row, c), v = String(vals[k]).trim();
      if (!v) return;
      if ((name === SHEET_DRIVERS && c === 6) || /^0\d+$/.test(v)) cell.setNumberFormat('@');
      cell.setValue(v);
    });
    SpreadsheetApp.flush();
    return { ok: true, row: row };
  } finally {
    lock.releaseLock();
  }
}


// ---- hromadná úprava: Cena / Směna přepravy se přepíše u všech jejích jízd (jen admin) ----
function skup_(b) {
  if (!admin_(b)) return { ok: false, error: 'forbidden' };
  var row = parseInt(b.row, 10), pole = String(b.pole || '');
  if (!(row >= 2) || (pole !== 'cena' && pole !== 'smena')) return { ok: false, error: 'bad_request' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS);
    if (row > sh.getLastRow()) return { ok: false, error: 'not_found' };
    var r = sh.getRange(row, 1, 1, COL_ID).getDisplayValues()[0];
    if (!r[COL_ID - 1]) return { ok: false, error: 'not_found' };
    var jz = Math.max(1, Math.min(MAX_JIZD, parseInt(r[13 + O], 10) || 1));
    var off = pole === 'cena' ? 1 : 2;
    if (pole === 'smena' && STRIDE < 3) return { ok: false, error: 'bad_request' };
    var cur = '';
    for (var k = 0; k < MAX_JIZD && !cur; k++) { var cv = String(r[colTuny_(k) + off - 1] || '').trim(); if (cv) cur = cv; }
    if (cur !== String(b.old === undefined ? '' : b.old).trim()) return { ok: false, error: 'conflict' };
    var v = String(b.value === undefined ? '' : b.value).trim();
    if (pole === 'cena') {
      var num = v === '' ? null : Number(v.replace(/\s/g, '').replace(',', '.'));
      if (v !== '' && (isNaN(num) || num < 0)) return { ok: false, error: 'bad_value' };
      for (var i = 0; i < jz; i++) {
        var c = sh.getRange(row, colTuny_(i) + 1);
        if (num === null) c.clearContent(); else c.setNumberFormat('#,##0.00').setValue(num);
      }
    } else {
      var code = /^d$/i.test(v) ? 'D' : /^n$/i.test(v) ? 'N' : smenaCode_(v);
      if (!code) return { ok: false, error: 'bad_value' };
      var arr = []; for (var j = 0; j < jz; j++) arr.push(code);
      writeSmeny_(sh, row, jz, arr);
    }
    SpreadsheetApp.flush();
    return { ok: true, value: sh.getRange(row, colTuny_(0) + off).getDisplayValue() };
  } finally {
    lock.releaseLock();
  }
}


// ---- potvrzení „zpracováno, lze předat do Lori“ (list Zpracováno: ID záznamu, Zpracoval, Čas) ----
function zpracSheet_(create) {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(SHEET_DONE);
  if (!sh && create) { sh = ss.insertSheet(SHEET_DONE); sh.getRange(1, 1, 1, 3).setValues([['ID záznamu', 'Zpracoval', 'Čas']]).setFontWeight('bold'); sh.setFrozenRows(1); }
  return sh;
}
function zpracMap_() {
  var sh = zpracSheet_(false), m = {};
  if (!sh || sh.getLastRow() < 2) return m;
  sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { if (r[0]) m[String(r[0])] = true; });
  return m;
}
function zprac_(b) {
  var d = admin_(b);
  if (!d) return { ok: false, error: 'forbidden' };
  var id = String(b.id || '');
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) return { ok: false, error: 'bad_request' };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = zpracSheet_(true), last = sh.getLastRow();
    var ids = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues() : [];
    var rows = [];
    for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) rows.push(i + 2);
    if (b.done === true) {
      if (!rows.length) {
        var who = (d.jmeno ? d.jmeno + ' ' : '') + (d.prijmeni || b.prijmeni || '');
        var now = new Date();
        sh.appendRow([id, String(who).trim(), Utilities.formatDate(now, Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm'), now.getTime(), '']);
      }
    } else {
      for (var j = rows.length - 1; j >= 0; j--) sh.deleteRow(rows[j]);
      loriRemove_(id);   // odfajfknuto = z listu Přepravy do Lori zmizí hned
    }
    syncLoriLocked_();
    SpreadsheetApp.flush();
    return { ok: true, done: b.done === true };
  } finally {
    lock.releaseLock();
  }
}

// ---- úprava příloh (jen admin): smazání přílohy a výměna PDF po odebrání stránek ----
function docFileId_(url) { var m = /\/d\/([\w-]+)/.exec(String(url || '')); return m ? m[1] : ''; }
function docRowById_(sh, id) {
  var last = sh.getLastRow(); if (last < 2) return 0;
  var ids = sh.getRange(2, COL_ID, last - 1, 1).getDisplayValues();
  for (var i = ids.length - 1; i >= 0; i--) if (ids[i][0] === id) return i + 2;
  return 0;
}
function docDel_(b) {
  if (!admin_(b)) return { ok: false, error: 'forbidden' };
  var id = String(b.id || ''), n = parseInt(b.n, 10);
  if (!id || !(n >= 0)) return { ok: false, error: 'bad_request' };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS), row = docRowById_(sh, id);
    if (!row) return { ok: false, error: 'not_found' };
    var dc = sh.getRange(row, COL_DOC), urls = docUrls_(dc.getRichTextValue(), dc.getFormula());
    if (n >= urls.length) return { ok: false, error: 'not_found' };
    var fid = docFileId_(urls[n]);
    urls.splice(n, 1);
    dc.setRichTextValue(docRich_(urls));
    if (fid) { try { DriveApp.getFileById(fid).setTrashed(true); } catch (e) {} }   // do koše na Disku (jde obnovit)
    return { ok: true, docs: urls.length };
  } finally { lock.releaseLock(); }
}
function docRepl_(b) {
  if (!admin_(b)) return { ok: false, error: 'forbidden' };
  var id = String(b.id || ''), n = parseInt(b.n, 10);
  if (!id || !(n >= 0) || !b.pdf) return { ok: false, error: 'bad_request' };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS), row = docRowById_(sh, id);
    if (!row) return { ok: false, error: 'not_found' };
    var dc = sh.getRange(row, COL_DOC), urls = docUrls_(dc.getRichTextValue(), dc.getFormula());
    if (n >= urls.length) return { ok: false, error: 'not_found' };
    var fid = docFileId_(urls[n]), old = null, folder = null;
    if (fid) { try { old = DriveApp.getFileById(fid); var ps = old.getParents(); if (ps.hasNext()) folder = ps.next(); } catch (e) {} }
    var name = (old ? old.getName().replace(/\.pdf$/i, '') : 'priloha_' + id.slice(0, 6)) + '_upr.pdf';
    var blob = Utilities.newBlob(Utilities.base64Decode(String(b.pdf)), 'application/pdf', name);
    var file = folder ? folder.createFile(blob) : DriveApp.createFile(blob);
    urls[n] = file.getUrl();
    dc.setRichTextValue(docRich_(urls));
    if (old) { try { old.setTrashed(true); } catch (e) {} }
    return { ok: true, docs: urls.length };
  } finally { lock.releaseLock(); }
}


// ---- přepravy do Lori: zaškrtnuté fajfkou se po 30 minutách zapíšou do listu „Přepravy do Lori“ ----
// List je určený pro agenta, který objednávky přepisuje do Lori: jeden řádek = jedna přeprava, čistý text, přílohy jako odkazy.
var LORI_HEAD = ['Datum nakládky', 'Datum vykládky', 'Zákazník', 'Místo nakládky', 'Místo vykládky', 'Druh materiálu', 'Řidič', 'Dopravce', 'SPZ', 'Počet jízd', 'Tuny po jízdách', 'Tuny celkem', 'Cena', 'Směna', 'Poznámka', 'Příloha 1', 'Příloha 2', 'Příloha 3', 'Potvrzeno (kdo, kdy)', 'Stav v Lori (vyplní agent)', 'ID záznamu'];
var LORI_ID_COL = 21;
function loriSheet_(create) {
  var ss = SpreadsheetApp.getActive(), lo = ss.getSheetByName(SHEET_LORI);
  if (!lo && create) {
    lo = ss.insertSheet(SHEET_LORI);
    lo.getRange(1, 1, lo.getMaxRows(), LORI_HEAD.length).setNumberFormat('@');
    lo.getRange(1, 1, 1, LORI_HEAD.length).setValues([LORI_HEAD]).setFontWeight('bold').setBackground('#1f3a6e').setFontColor('#ffffff').setWrap(true).setVerticalAlignment('middle');
    lo.setFrozenRows(1); lo.setFrozenColumns(3);
    var w = [95, 95, 170, 150, 150, 120, 140, 120, 90, 60, 150, 80, 80, 70, 200, 110, 110, 110, 160, 170, 80];
    for (var c = 0; c < w.length; c++) lo.setColumnWidth(c + 1, w[c]);
    lo.getRange(2, 1, lo.getMaxRows() - 1, LORI_HEAD.length).setVerticalAlignment('top');
    var rule = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$T2<>""').setBackground('#dcefe3').setRanges([lo.getRange(2, 1, lo.getMaxRows() - 1, LORI_HEAD.length)]).build();
    lo.setConditionalFormatRules([rule]);
  }
  return lo;
}
function loriIds_(lo) {
  var m = {}, last = lo.getLastRow();
  if (last < 2) return m;
  lo.getRange(2, LORI_ID_COL, last - 1, 1).getDisplayValues().forEach(function (r, i) { if (r[0]) m[r[0]] = i + 2; });
  return m;
}
function loriRemove_(id) {
  var lo = loriSheet_(false);
  if (!lo || lo.getLastRow() < 2) return;
  var vals = lo.getRange(2, LORI_ID_COL, lo.getLastRow() - 1, 1).getDisplayValues();
  for (var i = vals.length - 1; i >= 0; i--) if (vals[i][0] === id) lo.deleteRow(i + 2);
}
// jeden řádek Záznamů -> přehledný řádek pro Lori
function loriRow_(rec, pos, kdo, kdy) {
  var d = rec.getRange(pos, 1, 1, COL_ID).getDisplayValues()[0], v = rec.getRange(pos, 1, 1, COL_ID).getValues()[0];
  var dc = rec.getRange(pos, COL_DOC), urls = docUrls_(dc.getRichTextValue(), dc.getFormula());
  var jz = Math.max(1, Math.min(MAX_JIZD, parseInt(d[13 + O], 10) || 1)), tuny = [], sum = 0, cena = '';
  for (var k = 0; k < jz; k++) {
    var t = v[colTuny_(k) - 1];
    if (t !== '' && t !== null && !isNaN(Number(t))) { tuny.push((jz > 1 ? (k + 1) + ') ' : '') + String(Number(t)).replace('.', ',') + ' t'); sum += Number(t); }
    if (cena === '' && v[colTuny_(k)] !== '' && v[colTuny_(k)] !== null) cena = String(v[colTuny_(k)]).replace('.', ',');
  }
  var smena = STRIDE >= 3 ? d[colTuny_(0) + 1] : '';
  return [d[5 + O], d[7 + O], d[11 + O], d[9 + O], d[10 + O], d[12 + O], d[1 + O], d[2 + O], d[3 + O], String(jz), tuny.join('; '), sum ? String(Math.round(sum * 100) / 100).replace('.', ',') + ' t' : '', cena, smena, d[COL_NOTE - 1], urls[0] || '', urls[1] || '', urls[2] || '', kdo + (kdy ? ', ' + kdy : ''), '', d[COL_ID - 1]];
}
function zpracTs_(row) {
  if (Number(row[3]) > 0) return Number(row[3]);
  var m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(String(row[2] || ''));
  return m ? new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]).getTime() : 0;
}
function syncLoriLocked_() {
  var dn = zpracSheet_(false);
  if (!dn || dn.getLastRow() < 2) return 0;
  var data = dn.getRange(2, 1, dn.getLastRow() - 1, 5).getValues(), now = Date.now(), due = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][4]) continue;
    var ts = zpracTs_(data[i]);
    if (ts && now - ts >= LORI_DELAY_MS) due.push(i);
  }
  if (!due.length) return 0;
  var rec = SpreadsheetApp.getActive().getSheetByName(SHEET_RECORDS), lo = loriSheet_(true), have = loriIds_(lo);
  var recIds = rec.getRange(2, COL_ID, Math.max(1, rec.getLastRow() - 1), 1).getDisplayValues(), pos = {};
  for (var r = 0; r < recIds.length; r++) if (recIds[r][0]) pos[recIds[r][0]] = r + 2;
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm'), n = 0;
  for (var k = 0; k < due.length; k++) {
    var id = String(data[due[k]][0]);
    if (!have[id] && pos[id]) {
      var dest = lo.getLastRow() + 1;
      lo.getRange(dest, 1, 1, LORI_HEAD.length).setValues([loriRow_(rec, pos[id], String(data[due[k]][1] || ''), String(data[due[k]][2] || ''))]);
      have[id] = dest; n++;
    }
    dn.getRange(due[k] + 2, 5).setValue(stamp);
  }
  if (dn.getRange(1, 4).getValue() !== 'Čas (ms)') dn.getRange(1, 4, 1, 2).setValues([['Čas (ms)', 'Zkopírováno do Lori']]).setFontWeight('bold');
  return n;
}
function syncLoriTick() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { syncLoriLocked_(); SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
}
// jednorázově spustit v editoru: založí časovač (každých 5 minut)
function installLoriTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'syncLoriTick') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncLoriTick').timeBased().everyMinutes(5).create();
}
