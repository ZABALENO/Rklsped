// RKL Doprava – přehled vlastních přeprav RKL na dnešní den (rkldoprava.onrender.com)
// Sdílí kód, heslo, pozadí i databázi (Neon) s RKL Spedice, data má ve vlastní tabulce kv_doprava.
// Tabulka se nikam neukládá – server ji jen stahuje z veřejného odkazu.

const express = require('express');
const path = require('path');
const { loadSheet, validUrl } = require('./lib/sheet');
const { createStore } = require('./lib/store');
const { buildTrips, isRKL } = require('./lib/trips');
const { sellerOf } = require('./lib/sellers');
const geo = require('./lib/geo');
const { pragueToday, subWorkdays } = require('./lib/workdays');
const { eurRate } = require('./lib/rate');

const PORT = process.env.PORT || 3000;
const SHEET_TTL = 60 * 1000;
const BG_REFRESH = 3 * 60 * 1000;

let store;
let sheet = { rows: [], fetchedAt: null, error: null, sheet: null, columns: null, url: null };
let inflight = null;

/* ---------- tabulka ---------- */
async function refreshSheet(force) {
  const url = store.mem.cfg.sheet && store.mem.cfg.sheet.url;
  if (!url) { sheet = { rows: [], fetchedAt: null, error: null, sheet: null, columns: null, url: null }; return; }
  const fresh = sheet.url === url && sheet.fetchedAt && Date.now() - Date.parse(sheet.fetchedAt) < SHEET_TTL;
  if (!force && fresh) return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const out = await loadSheet(url);
      sheet = { ...out, fetchedAt: new Date().toISOString(), error: null, url };
      await updateHistory(out.rows);
    } catch (e) {
      sheet = { ...sheet, error: e.message, url, rows: sheet.url === url ? sheet.rows : [], fetchedAt: sheet.url === url ? sheet.fetchedAt : null };
    } finally { inflight = null; }
  })();
  return inflight;
}

/* ---------- historie nakládek ----------
   Pro každý den (Datum nakl.od) se v databázi drží seznam zásilek RKL: SPZ, dispečer, přeprava, trasa…
   Záznamy se jen doplňují/aktualizují – když řádek z tabulky zmizí, v historii zůstane. */
const HIST_DAYS = 400;
function histRow(r) {
  const s = sellerOf(r.prepr);
  return { k: r.key, spz: r.spz || '', pz: r.prepr || '', who: s ? s.name : '', route: r.route || '', goods: r.goods || '',
    kg: r.weight || 0, to: r.zipTo || '', ul: r.unlTo || r.unlFrom || '' };
}
async function updateHistory(rows) {
  const limit = subWorkdays(pragueToday(), Math.round(HIST_DAYS * 5 / 7));
  const byDay = new Map();
  for (const r of rows) {
    if (!isRKL(r.carrier) || !r.date || r.date < limit) continue;
    if (!byDay.has(r.date)) byDay.set(r.date, []);
    byDay.get(r.date).push(histRow(r));
  }
  for (const [day, list] of byDay) {
    const prev = (store.mem.hist[day] && store.mem.hist[day].o) || [];
    const map = new Map(prev.map(o => [o.k, o]));
    for (const o of list) map.set(o.k, o);
    const merged = [...map.values()].sort((a, b) => (a.spz || '~').localeCompare(b.spz || '~', 'cs') || a.pz.localeCompare(b.pz));
    if (JSON.stringify(merged) !== JSON.stringify(prev)) await store.put('hist', day, { o: merged });
  }
}

/* ---------- HTTP ---------- */
const app = express();
app.use(express.json({ limit: '1mb' }));
require('./lib/auth').setup(app, { title: 'RKL Doprava', subtitle: 'Vlastní doprava na cestě' });
// sdílené obrázky (pozadí, logo) z RKL Spedice
for (const f of ['bg.jpg', 'logo.jpg', 'favicon.png', 'tv.js']) app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, 'public', f)));
app.use(express.static(path.join(__dirname, 'public-doprava'), { maxAge: 0 }));

app.get('/api/trips', async (req, res) => {
  await refreshSheet(req.query.force === '1');
  const today = pragueToday();
  const rate = await eurRate(store);
  const trips = sheet.rows.length ? await buildTrips(sheet.rows, today, rate.value) : [];
  const missing = sheet.columns ? ['spz', 'prepr', 'carrier', 'date', 'unlTo', 'incCzk', 'incEur'].filter(k => !sheet.columns[k]) : [];
  res.json({
    configured: !!(store.mem.cfg.sheet && store.mem.cfg.sheet.url),
    url: store.mem.cfg.sheet ? store.mem.cfg.sheet.url : '',
    fetchedAt: sheet.fetchedAt, error: sheet.error, sheetName: sheet.sheet, totalRows: sheet.rows.length,
    missing, today, from: subWorkdays(today, 4), rate, trips, storage: store.kind,
  });
});

app.post('/api/config', async (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  if (url && !validUrl(url)) return res.status(400).json({ error: 'Podporované jsou veřejné odkazy z Google Sheets / Google Drive a OneDrive / SharePoint (Excel online).' });
  await store.put('cfg', 'sheet', url ? { url, u: new Date().toISOString() } : null);
  await refreshSheet(true);
  res.json({ ok: true, error: sheet.error, totalRows: sheet.rows.length, sheetName: sheet.sheet });
});

// historie nakládek pro jeden den + seznam dnů, pro které historie existuje
app.get('/api/history', async (req, res) => {
  await refreshSheet(false);
  const days = Object.keys(store.mem.hist).sort();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : pragueToday();
  res.json({ date, days, orders: (store.mem.hist[date] && store.mem.hist[date].o) || [] });
});

app.get('/healthz', (req, res) => res.send('ok'));

createStore('kv_doprava', ['cfg', 'geo', 'hist'], 'doprava.json').then(s => {
  store = s;
  geo.useCache(store.mem.geo, (k, v) => store.put('geo', k, v));
  app.listen(PORT, () => console.log('RKL Doprava běží na portu ' + PORT));
  refreshSheet(true);
  setInterval(() => refreshSheet(true), BG_REFRESH);
}).catch(e => { console.error('Start selhal:', e); process.exit(1); });
