// Čas poslední skutečné změny dat zdrojové tabulky.
// Bere se otisk řádků, které relace ze zdrojové tabulky opravdu čte (sloupce a filtr relace), ne celého listu – změny jinde v listu
// (nesouvisející buňky, vzorce, prázdné řádky) čas neposouvají. Uloženo v cfg.chg {h, at, url, v}.
const crypto = require('crypto');
const rowsHash = rows => crypto.createHash('sha1').update(JSON.stringify((rows || []).map(r => [r.key, r.order, r.date, r.route, r.goods, r.weight, r.prepr, r.code, r.codeU, r.carrier, r.cust, r.dateLoadTo, r.unlFrom, r.unlTo, r.zipFrom, r.zipTo, r.incCzk, r.incEur, r.expCzk, r.expEur, r.relace, r.custOrd, r.ldm, r.pcs, r.spz]))).digest('hex');
async function trackChange(cfg, put, out, url, rows) {
  if (!out || !out.hash) return;
  const c = cfg.chg, h = rows ? rowsHash(rows) : out.hash, now = new Date().toISOString();
  if (!c || c.url !== url) return put('cfg', 'chg', { h, at: now, url, v: rows ? 2 : 1 });
  if (rows && c.v !== 2) return put('cfg', 'chg', { h, at: c.at, url, v: 2 });   // přechod na nový otisk: původní čas se zachová
  if (c.h !== h) return put('cfg', 'chg', { h, at: now, url, v: rows ? 2 : 1 });
}
module.exports = { trackChange };
