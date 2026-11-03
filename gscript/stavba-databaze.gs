// Apps Script pro list „Stavba-databáze“ (Rozšíření -> Apps Script v tabulce). Nasadit jako Webovou aplikaci:
// Spustit jako: Já · Kdo má přístup: Kdokoli. SECRET musí být stejné jako STAVBA_DB_SECRET na Renderu.
const SECRET = 'ZMEN_MNE';
const TAB = 'Stavba-databáze';
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function sheet_() { const ss = SpreadsheetApp.getActive(); return ss.getSheetByName(TAB) || ss.insertSheet(TAB); }
function doGet(e) {
  if (!e || !e.parameter || e.parameter.t !== SECRET) return out_({ error: 'denied' });
  const v = sheet_().getDataRange().getValues().map(function (r) { return r.map(String); });
  return out_({ rows: v });
}
function doPost(e) {
  const b = JSON.parse(e.postData.contents);
  if (b.t !== SECRET) return out_({ error: 'denied' });
  const sh = sheet_(), rows = b.rows || [];
  sh.clearContents();
  if (rows.length) sh.getRange(1, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
  return out_({ ok: true, n: rows.length });
}
