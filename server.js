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
const HORIZON_WORKDAYS = 7;               // nabídka = nakládka nejpozději dnes + 7 pracovních dní
const { pragueToday, addWorkdays, pragueDay } = require('./lib/workdays');
const { eurRate } = require('./lib/rate');
const OFFER_MARK = '@@@';               // „Označeno k prodeji“ = CODE nakl. obsahuje @@@
const isRKL = c => /RKL/i.test(c || '');
// dopravci, jejichž prodeje se NEpočítají do dnešní provize
const deacc = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const PROV_EXCLUDE = [
  { name: 'RKL', re: /rkl/ },
];
const NEG_LIMIT = -5000;                 // záporná provize pod tuto hranici se do součtu nepočítá
const provExcluded = c => PROV_EXCLUDE.find(x => x.re.test(deacc(c)));
const hasPZ = prepr => /PZ\s*\//i.test(prepr || '');  // řádek má číslo přepravy = prodáno
const SHEET_TTL = 60 * 1000;              // jak dlouho držet staženou tabulku v paměti
const BG_REFRESH = 3 * 60 * 1000;         // obnova tabulky na pozadí
const SELLERS = { J: 'Jirka', G: 'Gabka', N: 'Pavel', U: 'Petr', H: 'Robin' };
const SELLER_ORDER = ['Jirka', 'Gabka', 'Pavel', 'Petr', 'Robin'];

/* ================= úložiště ================= */
// mem[ns][key] = value; ns: cfg | sold | note | sale | track | pin
const NS = ['cfg', 'sold', 'note', 'sale', 'track', 'pin'];
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
  const today = pragueToday();
  // Které řádky (objednávky) už jsme v tabulce někdy viděli. Při úplně prvním načtení se jen
  // zapamatují (historie se do leaderboardu nepočítá). Když přibude víc než 30 % nových řádků
  // najednou, jde nejspíš o jinou tabulku – i tehdy se jen zapamatují.
  const seenDoc = mem.cfg.seen;
  const seen = new Set(seenDoc ? seenDoc.keys : []);
  const newKeys = rows.filter(r => !seen.has(r.key)).map(r => r.key);
  const baseline = !seenDoc || newKeys.length > Math.max(100, rows.length * 0.3);
  if (seenDoc && baseline) console.log(`Nových řádků ${newKeys.length} – bráno jako nová tabulka, do leaderboardu se nepočítají`);

  for (const r of rows) {
    // řádek bez čísla přepravy si zapamatujeme – až u něj číslo PZ/ přibude, připíše se prodej
    if (!hasPZ(r.prepr)) { if (!mem.track[r.key]) await put('track', r.key, { t: now, label: labelOf(r) }); continue; }
    const s = sellerOf(r.prepr);
    if (!s) continue;
    const cur = mem.sale[r.key];
    const known = mem.track[r.key] || (mem.sold[r.key] && mem.sold[r.key].sold);
    // nový řádek, který už rovnou má číslo PZ, dopravce bez „RKL“ a nakládku dnes nebo později
    // = prodej dispečera podle prefixu PZ
    const newExternal = !baseline && !seen.has(r.key) && !isRKL(r.carrier) && !!r.date && r.date >= today;
    if (!cur && (known || newExternal)) {
      const manual = mem.sold[r.key] && mem.sold[r.key].sold && mem.sold[r.key].at;
      await put('sale', r.key, { at: manual || now, prepr: r.prepr, seller: s.name, label: labelOf(r), carrier: r.carrier, via: known ? 'pz' : 'new' });
    } else if (cur && (cur.prepr !== r.prepr || (cur.carrier || '') !== r.carrier)) {
      // změna čísla přepravy nebo dopravce (např. na RKL) se promítne i zpětně
      await put('sale', r.key, { ...cur, prepr: r.prepr, seller: s.name, carrier: r.carrier });
    }
  }
  if (newKeys.length || !seenDoc) {
    for (const k of newKeys) seen.add(k);
    await put('cfg', 'seen', { keys: [...seen], u: now });
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
  for (const [k, v] of Object.entries(mem.pin)) if ((v.t || '') < limit) put('pin', k, null);
}

// od kdy se počítají statistiky (leaderboard, dnes prodané, graf, provize) – nastavuje „vynulování“
const statsFrom = () => (mem.cfg.stats && mem.cfg.stats.from) || '';

function board(rate) {
  const today = pragueToday();
  const until = addWorkdays(today, HORIZON_WORKDAYS);
  const pinT = k => (mem.pin[k] ? mem.pin[k].t : null);
  const offered = sheet.rows
    .filter(r => !hasPZ(r.prepr) && (!r.date || r.date <= until) && !(mem.sold[r.key] && mem.sold[r.key].sold))
    .map(({ key, order, date, route, goods, weight, code, zipTo, incCzk, incEur }) => ({ key, order, date, route, goods, weight, zipTo, incCzk, incEur, marked: code.includes(OFFER_MARK), pinned: pinT(key) }))
    .sort((a, b) => (a.pinned && b.pinned ? a.pinned.localeCompare(b.pinned) : a.pinned ? -1 : b.pinned ? 1 : 0)
      || (a.date || '9999').localeCompare(b.date || '9999'));
  const from = statsFrom();
  const weekAgo = new Date(Date.now() - 9 * 864e5).toISOString();
  const sold = Object.fromEntries(Object.entries(mem.sold).filter(([, v]) => v.sold && (v.at || '') > weekAgo && (v.at || '') >= from));
  const sales = Object.entries(mem.sale).filter(([, v]) => (v.at || '') >= from);

  // Dnešní provize = (Příjem CZK + Příjem EUR × kurz) − (Výdaj CZK + Výdaj EUR × kurz) u dnes prodaných přeprav
  const byKey = new Map(sheet.rows.map(r => [r.key, r]));
  const todayKeys = new Set([
    ...Object.entries(sold).filter(([, v]) => pragueDay(v.at) === today).map(([k]) => k),
    ...sales.filter(([, v]) => pragueDay(v.at) === today).map(([k]) => k),
  ]);
  // provize se počítá jen u přeprav prodaných externímu dopravci (bez RKL)
  const prov = { value: 0, income: 0, expense: 0, count: 0, rkl: 0, noCarrier: 0, excluded: {}, exKeys: [], negSkipped: [], missing: 0, rate: rate.value, perKey: {} };
  // dopravce ke všem prodaným přepravám (z aktuální tabulky, jinak z uloženého prodeje)
  const carriers = {};
  for (const k of new Set([...Object.keys(sold), ...sales.map(([k]) => k)])) {
    const r = byKey.get(k);
    carriers[k] = (r && r.carrier) || (mem.sale[k] && mem.sale[k].carrier) || '';
  }
  for (const k of todayKeys) {
    const r = byKey.get(k);
    const carrier = (r && r.carrier) || (mem.sale[k] && mem.sale[k].carrier) || '';
    carriers[k] = carrier;
    if (!carrier.trim()) { prov.noCarrier++; prov.exKeys.push(k); continue; }   // dopravce ještě nevznikl
    const ex = provExcluded(carrier);
    if (ex) { prov.rkl++; prov.excluded[ex.name] = (prov.excluded[ex.name] || 0) + 1; prov.exKeys.push(k); continue; }
    if (!r) { prov.missing++; continue; }
    prov.count++;
    const inc = (r.incCzk || 0) + (r.incEur || 0) * rate.value;
    const exp = (r.expCzk || 0) + (r.expEur || 0) * rate.value;
    prov.perKey[k] = Math.round(inc - exp);
    // provize jedné přepravy horší než −5 000 Kč se do součtu nepočítá (nejspíš chyba v datech)
    if (inc - exp < NEG_LIMIT) { prov.negSkipped.push(k); prov.count--; continue; }
    prov.income += inc; prov.expense += exp;
  }
  prov.value = Math.round(prov.income - prov.expense);
  prov.income = Math.round(prov.income); prov.expense = Math.round(prov.expense);

  const missing = sheet.columns ? ['date', 'route', 'goods', 'weight', 'prepr', 'carrier'].filter(k => !sheet.columns[k]) : [];
  return {
    configured: !!(mem.cfg.sheet && mem.cfg.sheet.url),
    url: mem.cfg.sheet ? mem.cfg.sheet.url : '',
    fetchedAt: sheet.fetchedAt, error: sheet.error, sheetName: sheet.sheet, totalRows: sheet.rows.length, missing,
    offered, until, statsFrom: from,
    sold,
    sales: sales.map(([k, v]) => [k, v.at, v.seller, v.prepr, v.label, v.carrier || '']),
    notes: Object.fromEntries(Object.entries(mem.note).map(([k, v]) => [k, v.text])),
    provize: prov, rate, carriers,
    sellers: SELLER_ORDER,
    storage: pool ? 'db' : 'file',
  };
}

/* ================= HTTP ================= */
const app = express();
app.use(express.json({ limit: '5mb' }));
require('./lib/auth').setup(app);   // heslo z APP_PASSWORD – bez přihlášení nic nezobrazí
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

const store = { mem, put };
async function boardNow() { return board(await eurRate(store)); }

app.get('/api/board', async (req, res) => {
  await refreshSheet(req.query.force === '1');
  res.json(await boardNow());
});

// připnutí řádku nahoru (urgentní) – sdílené pro všechny
app.post('/api/pin', async (req, res) => {
  const { key, pinned } = req.body || {};
  if (typeof key !== 'string' || !key || key.length > 300) return res.status(400).json({ error: 'Chybný klíč' });
  await put('pin', key, pinned ? { t: new Date().toISOString() } : null);
  res.json({ ok: true });
});

// vynulování leaderboardu a dnes prodaných (počítá se od teď; stav „Prodáno“ u řádků zůstává)
app.post('/api/reset', async (req, res) => {
  await put('cfg', 'stats', { from: new Date().toISOString(), reset1: true });
  res.json(await boardNow());
});

app.post('/api/config', async (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  if (url && !validUrl(url)) return res.status(400).json({ error: 'Podporované jsou veřejné odkazy z Google Sheets / Google Drive a OneDrive / SharePoint (Excel online).' });
  await put('cfg', 'sheet', url ? { url, u: new Date().toISOString() } : null);
  await refreshSheet(true);
  res.json(await boardNow());
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
  initStore().then(async () => {
    // jednorázové vynulování statistik (požadavek 12. 10. 2026)
    if (!mem.cfg.stats || !mem.cfg.stats.reset1) await put('cfg', 'stats', { from: new Date().toISOString(), reset1: true });
    cleanup();
    app.listen(PORT, () => console.log('RKL Spedice běží na portu ' + PORT));
    refreshSheet(true);
    setInterval(() => refreshSheet(true), BG_REFRESH);
  }).catch(e => { console.error('Start selhal:', e); process.exit(1); });
}
module.exports = { app, sellerOf, evaluateSales, mem };
