// RKL Spedice – dashboard přeprav v prodeji
// Tabulka se NIKAM neukládá: server ji jen stáhne z veřejného odkazu, v paměti
// vybere řádky k prodeji a pošle je prohlížeči.
// Trvale (Postgres, příp. soubor) se ukládá jen: odkaz na tabulku, stav „Prodáno“,
// poznámky k přepravám a skóre prodejců (číslo objednávky, číslo přepravy, trasa, čas).

const express = require('express');
const fs = require('fs');
const path = require('path');
const { loadSheet, validUrl } = require('./lib/sheet');

const PORT = process.env.PORT || 3000;
const OFFER_MARK = '@@@';                 // ve sloupci „CODE nakl.“ = přeprava je v prodeji
const SHEET_TTL = 60 * 1000;              // jak dlouho držet staženou tabulku v paměti
const BG_REFRESH = 3 * 60 * 1000;         // obnova tabulky na pozadí
const SELLERS = { J: 'Jirka', G: 'Gabka', N: 'Pavel', U: 'Petr', H: 'Robin' };
const SELLER_ORDER = ['Jirka', 'Gabka', 'Pavel', 'Petr', 'Robin'];

/* ================= úložiště ================= */
// mem[ns][key] = value; ns: cfg | sold | note | sale | track
const NS = ['cfg', 'sold', 'note', 'sale', 'track'];
const mem = Object.fromEntries(NS.map(n => [n, {}]));
let pool = null;
const FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'store.json');

async function initStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    // Funguje s Neon (zdarma natrvalo), Render Postgres i lokálním Postgresem.
    const u = new URL(process.env.DATABASE_URL.trim().replace(/^psql\s+'?|'$/g, ''));
    const host = u.hostname;
    const needSsl = host.includes('.') && host !== '127.0.0.1' && u.searchParams.get('sslmode') !== 'disable';
    for (const p of ['sslmode', 'channel_binding', 'sslrootcert']) u.searchParams.delete(p);
    pool = new Pool({ connectionString: u.toString(), ssl: needSsl ? { rejectUnauthorized: false } : false, max: 4, idleTimeoutMillis: 30000 });
    pool.on('error', e => console.error('DB:', e.message));
    await pool.query(`CREATE TABLE IF NOT EXISTS kv (
      ns text NOT NULL, k text NOT NULL, v jsonb NOT NULL, u timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (ns, k))`);
    const { rows } = await pool.query('SELECT ns, k, v FROM kv');
    for (const r of rows) if (mem[r.ns]) mem[r.ns][r.k] = r.v;
    console.log(`Úložiště: Postgres (${rows.length} záznamů)`);
  } else {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      if (fs.existsSync(FILE)) Object.assign(mem, JSON.parse(fs.readFileSync(FILE, 'utf8')));
      for (const n of NS) mem[n] = mem[n] || {};
    } catch (e) { console.error('Soubor úložiště nelze načíst:', e.message); }
    console.log('Úložiště: soubor (dočasné – nastav DATABASE_URL)');
  }
}

let fileTimer = null;
async function put(ns, k, v) {
  if (v == null) delete mem[ns][k]; else mem[ns][k] = v;
  if (pool) {
    try {
      if (v == null) await pool.query('DELETE FROM kv WHERE ns=$1 AND k=$2', [ns, k]);
      else await pool.query(
        `INSERT INTO kv (ns,k,v,u) VALUES ($1,$2,$3,now())
         ON CONFLICT (ns,k) DO UPDATE SET v=EXCLUDED.v, u=now()`, [ns, k, JSON.stringify(v)]);
    } catch (e) { console.error('DB zápis selhal:', e.message); }
  } else {
    clearTimeout(fileTimer);
    fileTimer = setTimeout(() => { try { fs.writeFileSync(FILE, JSON.stringify(mem)); } catch (e) { console.error(e.message); } }, 300);
  }
}

/* ================= tabulka + vyhodnocení prodejů ================= */
let sheet = { rows: [], fetchedAt: null, error: null, sheet: null, columns: null, url: null };
let inflight = null;

function sellerOf(prepr) {
  const m = String(prepr).match(/^\s*PZ\s*\/\s*\d{2}\s*([A-Z])/i);
  if (!m) return null;
  const L = m[1].toUpperCase();
  return { letter: L, name: SELLERS[L] || `Ostatní (${L})` };
}
const fmtDate = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${+d}. ${+m}. ${y}`; };
const labelOf = r => `${fmtDate(r.date)} · ${r.route}`.replace(/^ · /, '');

async function evaluateSales(rows) {
  const now = new Date().toISOString();
  for (const r of rows) {
    const offered = r.code.includes(OFFER_MARK);
    if (offered && !r.prepr && !mem.track[r.key]) await put('track', r.key, { t: now, label: labelOf(r) });
    if (!r.prepr) continue;
    const s = sellerOf(r.prepr);
    if (!s) continue;
    const cur = mem.sale[r.key];
    const known = offered || mem.track[r.key] || (mem.sold[r.key] && mem.sold[r.key].sold);
    if (!cur && known) {
      const manual = mem.sold[r.key] && mem.sold[r.key].sold && mem.sold[r.key].at;
      await put('sale', r.key, { at: manual || now, prepr: r.prepr, seller: s.name, label: labelOf(r) });
    } else if (cur && cur.prepr !== r.prepr) {
      await put('sale', r.key, { ...cur, prepr: r.prepr, seller: s.name });
    }
  }
}

async function refreshSheet(force) {
  const url = mem.cfg.sheet && mem.cfg.sheet.url;
  if (!url) { sheet = { rows: [], fetchedAt: null, error: null, sheet: null, columns: null, url: null }; return; }
  const fresh = sheet.url === url && sheet.fetchedAt && Date.now() - Date.parse(sheet.fetchedAt) < SHEET_TTL;
  if (!force && fresh) return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const out = await loadSheet(url);
      sheet = { ...out, fetchedAt: new Date().toISOString(), error: null, url };
      await evaluateSales(out.rows);
    } catch (e) {
      sheet = { ...sheet, error: e.message, url, fetchedAt: sheet.url === url ? sheet.fetchedAt : null, rows: sheet.url === url ? sheet.rows : [] };
      sheet.errorAt = new Date().toISOString();
    } finally { inflight = null; }
  })();
  return inflight;
}

function cleanup() {
  const limit = new Date(Date.now() - 150 * 864e5).toISOString();
  for (const [k, v] of Object.entries(mem.track)) if (v.t < limit) put('track', k, null);
  for (const [k, v] of Object.entries(mem.sold)) if ((v.u || '') < limit) put('sold', k, null);
  for (const [k, v] of Object.entries(mem.note)) if ((v.u || '') < limit) put('note', k, null);
}

function board() {
  const offered = sheet.rows
    .filter(r => r.code.includes(OFFER_MARK) && !r.prepr && !(mem.sold[r.key] && mem.sold[r.key].sold))
    .map(({ key, order, date, route, goods, weight }) => ({ key, order, date, route, goods, weight }))
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  const weekAgo = new Date(Date.now() - 9 * 864e5).toISOString();
  const sold = Object.fromEntries(Object.entries(mem.sold).filter(([, v]) => v.sold && (v.at || '') > weekAgo));
  const missing = sheet.columns ? ['date', 'route', 'goods', 'weight', 'code', 'prepr'].filter(k => !sheet.columns[k]) : [];
  return {
    configured: !!(mem.cfg.sheet && mem.cfg.sheet.url),
    url: mem.cfg.sheet ? mem.cfg.sheet.url : '',
    fetchedAt: sheet.fetchedAt, error: sheet.error, sheetName: sheet.sheet, totalRows: sheet.rows.length, missing,
    offered,
    sold,
    sales: Object.entries(mem.sale).map(([k, v]) => [k, v.at, v.seller, v.prepr, v.label]),
    notes: Object.fromEntries(Object.entries(mem.note).map(([k, v]) => [k, v.text])),
    sellers: SELLER_ORDER,
    storage: pool ? 'db' : 'file',
  };
}

/* ================= HTTP ================= */
const app = express();
app.use(express.json({ limit: '5mb' }));
require('./lib/auth').setup(app);   // heslo z APP_PASSWORD – bez přihlášení nic nezobrazí
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

app.get('/api/board', async (req, res) => {
  await refreshSheet(req.query.force === '1');
  res.json(board());
});

app.post('/api/config', async (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  if (url && !validUrl(url)) return res.status(400).json({ error: 'Podporované jsou veřejné odkazy z Google Sheets / Google Drive a OneDrive / SharePoint (Excel online).' });
  await put('cfg', 'sheet', url ? { url, u: new Date().toISOString() } : null);
  await refreshSheet(true);
  res.json(board());
});

app.post('/api/sold', async (req, res) => {
  const { key, sold, label } = req.body || {};
  if (typeof key !== 'string' || !key || key.length > 300) return res.status(400).json({ error: 'Chybný klíč' });
  const now = new Date().toISOString();
  await put('sold', key, { sold: !!sold, at: sold ? now : null, u: now, label: String(label || '').slice(0, 200) });
  res.json({ ok: true, at: now });
});

app.post('/api/note', async (req, res) => {
  const { key, text } = req.body || {};
  if (typeof key !== 'string' || !key || key.length > 300) return res.status(400).json({ error: 'Chybný klíč' });
  const t = String(text || '').slice(0, 500);
  await put('note', key, t.trim() ? { text: t, u: new Date().toISOString() } : null);
  res.json({ ok: true });
});

// záloha všech uložených dat (skóre, poznámky, prodáno)
app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="rklspedice-zaloha-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exportedAt: new Date().toISOString(), data: mem });
});
// obnova ze zálohy – jen doplní, co chybí (nic nepřepíše)
app.post('/api/import', async (req, res) => {
  const data = req.body && req.body.data;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Neplatný soubor zálohy' });
  let n = 0;
  for (const ns of ['sold', 'note', 'sale', 'track']) {
    for (const [k, v] of Object.entries(data[ns] || {})) {
      if (!mem[ns][k] && v && typeof v === 'object' && k.length <= 300) { await put(ns, k, v); n++; }
    }
  }
  res.json({ ok: true, imported: n });
});

app.get('/healthz', (req, res) => res.send('ok'));

if (require.main === module) {
  initStore().then(() => {
    cleanup();
    app.listen(PORT, () => console.log('RKL Spedice běží na portu ' + PORT));
    refreshSheet(true);
    setInterval(() => refreshSheet(true), BG_REFRESH);
  }).catch(e => { console.error('Start selhal:', e); process.exit(1); });
}
module.exports = { app, sellerOf, evaluateSales, mem };
