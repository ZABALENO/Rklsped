// RKL Doprava – přehled vlastních přeprav RKL na dnešní den (rkldoprava.onrender.com)
// Sdílí kód, heslo, pozadí i databázi (Neon) s RKL Spedice, data má ve vlastní tabulce kv_doprava.
// Tabulka se nikam neukládá – server ji jen stahuje z veřejného odkazu.

const express = require('express');
const path = require('path');
const { loadSheet, validUrl } = require('./lib/sheet');
const { createStore } = require('./lib/store');
const { buildTrips } = require('./lib/trips');
const geo = require('./lib/geo');
const { pragueToday } = require('./lib/workdays');

const PORT = process.env.PORT || 3000;
const SHEET_TTL = 60 * 1000;
const BG_REFRESH = 3 * 60 * 1000;
const RATE_TTL = 3 * 3600 * 1000;
const DEFAULT_RATE = 25;

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
    } catch (e) {
      sheet = { ...sheet, error: e.message, url, rows: sheet.url === url ? sheet.rows : [], fetchedAt: sheet.url === url ? sheet.fetchedAt : null };
    } finally { inflight = null; }
  })();
  return inflight;
}

/* ---------- kurz EUR (ČNB) ---------- */
async function eurRate() {
  const c = store.mem.cfg.rate;
  if (c && Date.now() - c.t < RATE_TTL) return c;
  try {
    const r = await fetch('https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt',
      { signal: AbortSignal.timeout(8000) });
    const txt = await r.text();
    const date = (txt.split('\n')[0].match(/^(\d{2}\.\d{2}\.\d{4})/) || [])[1] || '';
    const line = txt.split('\n').find(l => l.includes('|EUR|'));
    const parts = line.split('|');
    const value = parseFloat(parts[4].replace(',', '.')) / (parseFloat(parts[2]) || 1);
    if (value > 10 && value < 60) {
      const v = { value, date, t: Date.now(), src: 'ČNB' };
      await store.put('cfg', 'rate', v);
      return v;
    }
  } catch (e) { console.error('Kurz ČNB nedostupný:', e.message); }
  return c || { value: DEFAULT_RATE, date: '', t: 0, src: 'výchozí' };
}

/* ---------- HTTP ---------- */
const app = express();
app.use(express.json({ limit: '1mb' }));
require('./lib/auth').setup(app, { title: 'RKL Doprava', subtitle: 'Vlastní doprava – dnes' });
// sdílené obrázky (pozadí, logo) z RKL Spedice
for (const f of ['bg.jpg', 'logo.jpg', 'favicon.png']) app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, 'public', f)));
app.use(express.static(path.join(__dirname, 'public-doprava'), { maxAge: 0 }));

app.get('/api/trips', async (req, res) => {
  await refreshSheet(req.query.force === '1');
  const today = pragueToday();
  const rate = await eurRate();
  const trips = sheet.rows.length ? await buildTrips(sheet.rows, today, rate.value) : [];
  const missing = sheet.columns ? ['spz', 'prepr', 'carrier', 'date', 'unlTo', 'incCzk', 'incEur'].filter(k => !sheet.columns[k]) : [];
  res.json({
    configured: !!(store.mem.cfg.sheet && store.mem.cfg.sheet.url),
    url: store.mem.cfg.sheet ? store.mem.cfg.sheet.url : '',
    fetchedAt: sheet.fetchedAt, error: sheet.error, sheetName: sheet.sheet, totalRows: sheet.rows.length,
    missing, today, rate, trips, storage: store.kind,
  });
});

app.post('/api/config', async (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  if (url && !validUrl(url)) return res.status(400).json({ error: 'Podporované jsou veřejné odkazy z Google Sheets / Google Drive a OneDrive / SharePoint (Excel online).' });
  await store.put('cfg', 'sheet', url ? { url, u: new Date().toISOString() } : null);
  await refreshSheet(true);
  res.json({ ok: true, error: sheet.error, totalRows: sheet.rows.length, sheetName: sheet.sheet });
});

app.get('/healthz', (req, res) => res.send('ok'));

createStore('kv_doprava', ['cfg', 'geo'], 'doprava.json').then(s => {
  store = s;
  geo.useCache(store.mem.geo, (k, v) => store.put('geo', k, v));
  app.listen(PORT, () => console.log('RKL Doprava běží na portu ' + PORT));
  refreshSheet(true);
  setInterval(() => refreshSheet(true), BG_REFRESH);
}).catch(e => { console.error('Start selhal:', e); process.exit(1); });
