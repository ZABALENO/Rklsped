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
const POS_LIMIT = 10000;                 // provize vyšší než tato hranice se do součtu nepočítá
const provExcluded = c => PROV_EXCLUDE.find(x => x.re.test(deacc(c)));
const hasPZ = prepr => /PZ\s*\//i.test(prepr || '');  // řádek má číslo přepravy = prodáno
const SHEET_TTL = 60 * 1000;              // jak dlouho držet staženou tabulku v paměti
const BG_REFRESH = 3 * 60 * 1000;         // obnova tabulky na pozadí
const { SELLER_ORDER, sellerOf } = require('./lib/sellers');

/* ================= instance dashboardu (hlavní + relace Vnitro 1) ================= */
// Každá instance má vlastní úložiště (tabulku v databázi), vlastní zdrojovou tabulku a vlastní stav.
function makeTenant({ id, table, fileName, rowFilter, sharedUrl, sheetName }) {
/* ================= úložiště ================= */
// mem[ns][key] = value; ns: cfg | sold | note | sale | track | pin
const NS = ['cfg', 'sold', 'note', 'sale', 'track', 'pin', 'folder', 'manual', 'tpl', 'hist'];
const mem = Object.fromEntries(NS.map(n => [n, {}]));
let pool = null;
const FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), fileName);

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
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
      ns text NOT NULL, k text NOT NULL, v jsonb NOT NULL, u timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (ns, k))`);
    const { rows } = await pool.query(`SELECT ns, k, v FROM ${table}`);
    for (const r of rows) if (mem[r.ns]) mem[r.ns][r.k] = r.v;
    console.log(`Úložiště ${id}: Postgres/${table} (${rows.length} záznamů)`);
  } else {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      if (fs.existsSync(FILE)) Object.assign(mem, JSON.parse(fs.readFileSync(FILE, 'utf8')));
      for (const n of NS) mem[n] = mem[n] || {};
    } catch (e) { console.error('Soubor úložiště nelze načíst:', e.message); }
    console.log(`Úložiště ${id}: soubor (dočasné – nastav DATABASE_URL)`);
  }
}

let fileTimer = null;
async function put(ns, k, v) {
  if (v == null) delete mem[ns][k]; else mem[ns][k] = v;
  if (pool) {
    try {
      if (v == null) await pool.query(`DELETE FROM ${table} WHERE ns=$1 AND k=$2`, [ns, k]);
      else await pool.query(
        `INSERT INTO ${table} (ns,k,v,u) VALUES ($1,$2,$3,now())
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
// zdrojová tabulka: vlastní odkaz (nastavený v nastavení této relace), jinak sdílená tabulka hlavního dashboardu
const sheetUrl = () => (mem.cfg.sheet && mem.cfg.sheet.url) || (sharedUrl ? sharedUrl() : '') || '';

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
  const url = sheetUrl();
  if (!url) { sheet = { rows: [], fetchedAt: null, error: null, sheet: null, columns: null, url: null }; return; }
  const fresh = sheet.url === url && sheet.fetchedAt && Date.now() - Date.parse(sheet.fetchedAt) < SHEET_TTL;
  if (!force && fresh) return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const out = await loadSheet(url, { sheetName });
      // když existuje samostatný list s názvem relace (např. „Vnitro 2“), jsou v něm jen její řádky a filtr se nepoužije
      const own = sheetName && out.sheet && deacc(out.sheet).replace(/\s+/g, '') === deacc(sheetName).replace(/\s+/g, '');
      out.ownSheet = !!own;
      if (rowFilter && !own) { const all = out.rows.length; out.rows = rowFilter(out.rows, out); out.hiddenByFilter = all - out.rows.length; }
      sheet = { ...out, fetchedAt: new Date().toISOString(), error: null, url };
      await require('./lib/change').trackChange(mem.cfg, put, out, url);
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
    .filter(r => !hasPZ(r.prepr) && (!['vnitro1', 'vnitro2'].includes(id) || !String(r.prepr || '').trim()) && (!r.date || r.date <= until) && !(mem.sold[r.key] && mem.sold[r.key].sold))
    .map(({ key, order, date, route, goods, weight, code, codeU, cust, dateLoadTo, zipTo, incCzk, incEur }) => ({ key, order, date, route, goods, weight, cust, dateLoadTo, zipTo, incCzk, incEur, codeL: code, codeU, marked: code.includes(OFFER_MARK), pinned: pinT(key) }))
    .sort((a, b) => (a.pinned && b.pinned ? a.pinned.localeCompare(b.pinned) : a.pinned ? -1 : b.pinned ? 1 : 0)
      || (a.date || '9999').localeCompare(b.date || '9999'));
  const from = statsFrom();
  const sold = Object.fromEntries(Object.entries(mem.sold).filter(([, v]) => v.sold && (v.at || '') >= from));
  const sales = Object.entries(mem.sale).filter(([, v]) => (v.at || '') >= from);

  // Dnešní provize = (Příjem CZK + Příjem EUR × kurz) − (Výdaj CZK + Výdaj EUR × kurz) u dnes prodaných přeprav
  const byKey = new Map(sheet.rows.map(r => [r.key, r]));
  const todayKeys = new Set([
    ...Object.entries(sold).filter(([, v]) => pragueDay(v.at) === today).map(([k]) => k),
    ...sales.filter(([, v]) => pragueDay(v.at) === today).map(([k]) => k),
  ]);
  // provize se počítá jen u přeprav prodaných externímu dopravci (bez RKL)
  const prov = { value: 0, income: 0, expense: 0, count: 0, rkl: 0, noCarrier: 0, excluded: {}, exKeys: [], negSkipped: [], highSkipped: [], missing: 0, rate: rate.value, perKey: {} };
  // dopravce ke všem prodaným přepravám (z aktuální tabulky, jinak z uloženého prodeje)
  const carriers = {};
  const provAll = {};   // provize každé prodané přepravy (pro historii po dnech)
  for (const k of new Set([...Object.keys(sold), ...sales.map(([k]) => k)])) {
    const r = byKey.get(k);
    carriers[k] = (r && r.carrier) || (mem.sale[k] && mem.sale[k].carrier) || '';
    if (r) provAll[k] = Math.round((r.incCzk || 0) + (r.incEur || 0) * rate.value - (r.expCzk || 0) - (r.expEur || 0) * rate.value);
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
    // provize jedné přepravy horší než −5 000 Kč nebo vyšší než 10 000 Kč se do součtu nepočítá
    if (inc - exp < NEG_LIMIT) { prov.negSkipped.push(k); prov.count--; continue; }
    if (inc - exp > POS_LIMIT) { prov.highSkipped.push(k); prov.count--; continue; }
    prov.income += inc; prov.expense += exp;
  }
  const soldToday = [...todayKeys].filter(k => (carriers[k] || '').trim() && !/rkl/i.test(carriers[k])).length;
  prov.value = Math.round(prov.income - prov.expense);
  prov.income = Math.round(prov.income); prov.expense = Math.round(prov.expense);

  // Vnitro 2: složky Vývoz / Dovoz a ručně psané objednávky (s návrhem párování na nový řádek z Lori)
  let v2 = null;
  if (id === 'vnitro2') {
    const fold = t => deacc(t);
    const hay = r => fold([r.order, r.route, r.goods, r.zipTo, r.code, r.date, r.date ? r.date.split('-').reverse().map(Number).join('.') : '', r.date ? (+r.date.slice(8)) + '.' + (+r.date.slice(5, 7)) + '.' : ''].join(' '));
    const toks = t => [...new Set(fold(t).split(/[^a-z0-9.]+/).map(x => x.replace(/^\.+|\.+$/g, '')).filter(x => x.length >= 3))];
    const score = (m, r) => { const T = toks(m.text); if (!T.length) return 0; const h = hay(r); let hit = 0; for (const t of T) if (h.includes(t) || (t.length >= 6 && h.includes(t.slice(0, t.length - 1)))) hit++; return (hit >= 2 || (T.length === 1 && hit === 1 && T[0].length >= 5)) && hit / T.length >= 0.5 ? hit / T.length : 0; };
    const taken = new Set();
    const manual = Object.values(mem.manual).sort((a, b) => (a.created || '').localeCompare(b.created || '')).map(m => {
      const base = new Set(m.base || []), dis = new Set(m.dismissed || []);
      let best = null;
      for (const r of offered) {
        if (base.has(r.key) || dis.has(r.key) || taken.has(r.key)) continue;
        const sc = score(m, r); if (sc && (!best || sc > best.score)) best = { key: r.key, score: Math.round(sc * 100) / 100 };
      }
      if (best) taken.add(best.key);
      return { id: m.id, text: m.text, created: m.created, folder: (mem.folder['m:' + m.id] || {}).f || null, suggest: best };
    });
    const hist = Object.values(mem.hist).sort((a, b) => b.t.localeCompare(a.t)).slice(0, 200);
    v2 = { hist, manual, folders: Object.fromEntries(Object.entries(mem.folder).filter(([k]) => !k.startsWith('m:')).map(([k, v]) => [k, v.f])) };
  }
  const missing = sheet.columns ? ['date', 'route', 'goods', 'weight', 'prepr', 'carrier'].filter(k => !sheet.columns[k]) : [];
  return {
    tenant: id,
    hiddenByFilter: sheet.hiddenByFilter || 0, ownSheet: !!sheet.ownSheet, relaceCol: !!(sheet.columns && sheet.columns.relace),
    configured: !!sheetUrl(),
    url: sheetUrl(),
    fetchedAt: sheet.fetchedAt, changedAt: mem.cfg.chg ? mem.cfg.chg.at : null, error: sheet.error, sheetName: sheet.sheet, totalRows: sheet.rows.length, missing,
    offered, until, statsFrom: from, soldToday,
    sold,
    sales: sales.map(([k, v]) => [k, v.at, v.seller, v.prepr, v.label, v.carrier || '']),
    notes: Object.fromEntries(Object.entries(mem.note).map(([k, v]) => [k, v.text])),
    provize: prov, rate, carriers, provAll, provLimits: [NEG_LIMIT, POS_LIMIT],
    sellers: SELLER_ORDER,
    storage: pool ? 'db' : 'file',
    ...(v2 || {}),
  };
}

const store = { mem, put };
async function boardNow() { return board(await eurRate(store)); }
const sheetKeys = () => sheet.rows.map(r => r.key).slice(0, 5000);
return { id, mem, put, store, sheetKeys, initStore, refreshSheet, evaluateSales, board, boardNow, cleanup, isDb: () => !!pool };
}

/* ================= HTTP ================= */
// Každá relace vidí jen řádky se svou hodnotou ve sloupci „Relace“ (zapad 1 / vnitro 1; bez ohledu na diakritiku a velikost písmen).
// Relace Vnitro 1 navíc jen objednávky začínající na ZV/. Když tabulka sloupec „Relace“ nemá, filtr relace se nepoužije.
const byRelace = (re, extra) => (rows, out) => {
  const has = !!(out.columns && out.columns.relace);
  return rows.filter(r => (!has || re.test(deacc(r.relace))) && (!extra || extra(r)));
};
const zapad1Filter = byRelace(/zapad\s*1/);
const vnitro1Filter = byRelace(/vnitro\s*1/, r => /^ZV\s*\//i.test(r.order || ''));
const main = makeTenant({ id: 'main', table: 'kv', fileName: 'store.json', rowFilter: zapad1Filter });
const v1 = makeTenant({ id: 'vnitro1', table: 'kv_vnitro1', fileName: 'store-vnitro1.json', rowFilter: vnitro1Filter, sharedUrl: () => main.mem.cfg.sheet && main.mem.cfg.sheet.url });
const vnitro2Filter = byRelace(/vnitro\s*2/);
const v2 = makeTenant({ id: 'vnitro2', table: 'kv_vnitro2', fileName: 'store-vnitro2.json', rowFilter: vnitro2Filter, sheetName: 'Vnitro 2', sharedUrl: () => main.mem.cfg.sheet && main.mem.cfg.sheet.url });
const tenants = { main, vnitro1: v1, vnitro2: v2 };
const { mem, put, refreshSheet, evaluateSales } = main;

const app = express();
app.use(express.json({ limit: '5mb' }));
require('./lib/auth').setup(app);   // heslo z APP_PASSWORD (hlavní) / VNITRO1_PASSWORD (relace Vnitro 1) – bez přihlášení nic nezobrazí
// aktuální instance podle přihlášení (req.tenantId nastavuje lib/auth)
app.use((req, res, next) => { req.t = tenants[req.tenantId] || main; next(); });
// hlavní stránka: pro relaci Vnitro 1 se přidá třída, která schová leaderboard a historii
const INDEX = path.join(__dirname, 'public', 'index.html');
app.get(['/', '/index.html'], (req, res, next) => {
  let h; try { h = fs.readFileSync(INDEX, 'utf8'); } catch { return next(); }
  if (req.t.id === 'vnitro2') h = h.replace('<body>', '<body class="t-v1 t-v2">').replace('<div>RKL Spedice<small>Přepravy v prodeji</small></div>', '<div>RKL Spedice · Vnitro 2<small>Přepravy – Vnitro 2</small></div>').replace('<title>RKL Spedice – přepravy v prodeji</title>', '<title>RKL Spedice – Vnitro 2</title>');
  if (req.t.id === 'vnitro1') h = h.replace('<body>', '<body class="t-v1">').replace('<div>RKL Spedice<small>Přepravy v prodeji</small></div>', '<div>RKL Spedice · Vnitro 1<small>Přepravy v prodeji – ZV/</small></div>').replace('<title>RKL Spedice – přepravy v prodeji</title>', '<title>RKL Spedice – Vnitro 1</title>');
  res.set('Cache-Control', 'no-store').type('html').send(h);
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

app.get('/api/board', async (req, res) => {
  await req.t.refreshSheet(req.query.force === '1');
  res.json(await req.t.boardNow());
});

// připnutí řádku nahoru (urgentní) – sdílené pro všechny v dané instanci
app.post('/api/pin', async (req, res) => {
  const { key, pinned } = req.body || {};
  if (typeof key !== 'string' || !key || key.length > 300) return res.status(400).json({ error: 'Chybný klíč' });
  await req.t.put('pin', key, pinned ? { t: new Date().toISOString() } : null);
  res.json({ ok: true });
});

// vynulování leaderboardu a dnes prodaných (počítá se od teď; stav „Prodáno“ u řádků zůstává)
// ---- Vnitro 2: složky Vývoz / Dovoz a ruční objednávky ----
const needV2 = (req, res) => { if (req.t.id !== 'vnitro2') { res.status(404).json({ error: 'Tato funkce je jen v relaci Vnitro 2.' }); return false; } return true; };

// ---- Vnitro 2: historie přesunů (kdo / odkud / kdy) ----
function whoOf(req) {
  const ua = String(req.headers['user-agent'] || '');
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'prohlížeč';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  const dev = String(req.headers['x-device'] || '').replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const ip = String(req.ip || '').replace(/^::ffff:/, '');
  return { dev, ip, ua: [br, os].filter(Boolean).join(' / ') };
}
async function logHist(req, act, to, label) {
  const t = req.t; if (t.id !== 'vnitro2') return;
  const now = new Date().toISOString(), id = now + Math.random().toString(36).slice(2, 5);
  await t.put('hist', id, { t: now, act, to: to || null, label: String(label || '').slice(0, 200), who: whoOf(req) });
  const ks = Object.keys(t.mem.hist).sort();
  for (const k of ks.slice(0, Math.max(0, ks.length - 1000))) await t.put('hist', k, null);
}
app.post('/api/folder', async (req, res) => {
  if (!needV2(req, res)) return;
  const { key, folder } = req.body || {};
  if (typeof key !== 'string' || !key || key.length > 300) return res.status(400).json({ error: 'Chybný klíč' });
  if (folder != null && !['vyvoz', 'dovoz'].includes(folder)) return res.status(400).json({ error: 'Neznámá složka' });
  const prev = (req.t.mem.folder[key] || {}).f || null;
  await req.t.put('folder', key, folder ? { f: folder, t: new Date().toISOString() } : null);
  const lab = key.startsWith('m:') ? '✎ ' + ((req.t.mem.manual[key.slice(2)] || {}).text || 'ruční objednávka') : (req.body.label || key);
  if (prev !== folder) await logHist(req, 'move', folder || 'none', lab + (prev ? '|' + prev : '|none'));
  res.json({ ok: true });
});
app.post('/api/manual', async (req, res) => {
  if (!needV2(req, res)) return;
  const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Napiš text objednávky.' });
  const folder = ['vyvoz', 'dovoz'].includes(req.body.folder) ? req.body.folder : null;
  const mid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await req.t.put('manual', mid, { id: mid, text, created: new Date().toISOString(), base: req.t.sheetKeys(), dismissed: [] });
  if (folder) await req.t.put('folder', 'm:' + mid, { f: folder, t: new Date().toISOString() });
  res.json({ ok: true, id: mid });
});
app.post('/api/manual/edit', async (req, res) => {
  if (!needV2(req, res)) return;
  const m = req.t.mem.manual[String((req.body && req.body.id) || '')];
  const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
  if (!m || !text) return res.status(400).json({ error: 'Neplatná ruční objednávka.' });
  await req.t.put('manual', m.id, { ...m, text });
  res.json({ ok: true });
});
app.post('/api/manual/delete', async (req, res) => {
  if (!needV2(req, res)) return;
  const id = String((req.body && req.body.id) || '');
  await req.t.put('manual', id, null); await req.t.put('folder', 'm:' + id, null);
  res.json({ ok: true });
});
// odpověď na návrh „je to ta samá objednávka?“: accept = ruční řádek se nahradí řádkem z Lori (složka a text se přenesou), jinak se návrh odmítne
app.post('/api/manual/resolve', async (req, res) => {
  if (!needV2(req, res)) return;
  const { id, key, accept } = req.body || {};
  const m = req.t.mem.manual[String(id || '')];
  if (!m || typeof key !== 'string' || !key) return res.status(400).json({ error: 'Neplatná ruční objednávka.' });
  if (accept) {
    const f = req.t.mem.folder['m:' + m.id];
    if (f) await req.t.put('folder', key, { f: f.f, t: new Date().toISOString() });
    if (!(req.t.mem.note[key] && req.t.mem.note[key].text)) await req.t.put('note', key, { text: m.text.slice(0, 500), u: new Date().toISOString() });
    await req.t.put('manual', m.id, null); await req.t.put('folder', 'm:' + m.id, null);
  } else {
    await req.t.put('manual', m.id, { ...m, dismissed: [...(m.dismissed || []), key].slice(-200) });
  }
  res.json({ ok: true });
});

// šablony řazení a filtrů (sdílené v rámci relace – kdokoli je může načíst)
const TPL_COLS = ['date', 'route', 'cust', 'goods', 'weight', 'price', 'note'];
const cleanView = v => {
  const out = { sort: null, f: {} };
  if (v && v.sort && TPL_COLS.includes(v.sort.c)) out.sort = { c: v.sort.c, d: v.sort.d === 'desc' ? 'desc' : 'asc' };
  if (v && v.f && typeof v.f === 'object') for (const c of TPL_COLS) { const t = String(v.f[c] || '').slice(0, 100); if (t.trim()) out.f[c] = t; }
  return out;
};
app.get('/api/tpl', (req, res) => {
  if (!needV2(req, res)) return;
  res.json({ items: Object.values(req.t.mem.tpl).sort((a, b) => (b.created || '').localeCompare(a.created || '')) });
});
app.post('/api/tpl', async (req, res) => {
  if (!needV2(req, res)) return;
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Napiš název šablony.' });
  const same = Object.values(req.t.mem.tpl).find(t => t.name.toLowerCase() === name.toLowerCase());
  const id = same ? same.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  await req.t.put('tpl', id, { id, name, view: cleanView(req.body.view), created: new Date().toISOString() });
  res.json({ ok: true, id });
});
app.post('/api/tpl/delete', async (req, res) => {
  if (!needV2(req, res)) return;
  await req.t.put('tpl', String((req.body && req.body.id) || ''), null);
  res.json({ ok: true });
});

app.post('/api/reset', async (req, res) => {
  await req.t.put('cfg', 'stats', { from: new Date().toISOString(), reset1: true });
  res.json(await req.t.boardNow());
});

app.post('/api/config', async (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  if (url && !validUrl(url)) return res.status(400).json({ error: 'Podporované jsou veřejné odkazy z Google Sheets / Google Drive a OneDrive / SharePoint (Excel online).' });
  await req.t.put('cfg', 'sheet', url ? { url, u: new Date().toISOString() } : null);
  await req.t.refreshSheet(true);
  res.json(await req.t.boardNow());
});

app.post('/api/sold', async (req, res) => {
  const { key, sold, label } = req.body || {};
  if (typeof key !== 'string' || !key || key.length > 300) return res.status(400).json({ error: 'Chybný klíč' });
  const now = new Date().toISOString();
  await req.t.put('sold', key, { sold: !!sold, at: sold ? now : null, u: now, label: String(label || '').slice(0, 200) });
  await logHist(req, sold ? 'done' : 'undone', null, label || key);
  res.json({ ok: true, at: now });
});

app.post('/api/note', async (req, res) => {
  const { key, text } = req.body || {};
  if (typeof key !== 'string' || !key || key.length > 300) return res.status(400).json({ error: 'Chybný klíč' });
  const t = String(text || '').slice(0, 500);
  await req.t.put('note', key, t.trim() ? { text: t, u: new Date().toISOString() } : null);
  res.json({ ok: true });
});

// záloha všech uložených dat (skóre, poznámky, prodáno)
app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="rklspedice${req.t.id === 'main' ? '' : '-' + req.t.id}-zaloha-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exportedAt: new Date().toISOString(), data: req.t.mem });
});
// obnova ze zálohy – jen doplní, co chybí (nic nepřepíše)
app.post('/api/import', async (req, res) => {
  const data = req.body && req.body.data;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Neplatný soubor zálohy' });
  let n = 0;
  for (const ns of ['sold', 'note', 'sale', 'track']) {
    for (const [k, v] of Object.entries(data[ns] || {})) {
      if (!req.t.mem[ns][k] && v && typeof v === 'object' && k.length <= 300) { await req.t.put(ns, k, v); n++; }
    }
  }
  res.json({ ok: true, imported: n });
});

app.get('/healthz', (req, res) => res.send('ok'));

if (require.main === module) {
  Promise.all([main.initStore(), v1.initStore(), v2.initStore()]).then(async () => {
    // jednorázové vynulování statistik (požadavek 12. 10. 2026)
    if (!main.mem.cfg.stats || !main.mem.cfg.stats.reset1) await main.put('cfg', 'stats', { from: new Date().toISOString(), reset1: true });
    main.cleanup(); v1.cleanup(); v2.cleanup();
    app.listen(PORT, () => console.log('RKL Spedice běží na portu ' + PORT));
    for (const t of [main, v1, v2]) { t.refreshSheet(true); setInterval(() => t.refreshSheet(true), BG_REFRESH); }
  }).catch(e => { console.error('Start selhal:', e); process.exit(1); });
}
module.exports = { app, sellerOf, evaluateSales, mem };
