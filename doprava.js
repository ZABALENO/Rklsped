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
      await require('./lib/change').trackChange(store.mem.cfg, store.put, out, url);
      await updateHistory(out.rows);
      await updateAgents(out.counts);
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

/* ---------- Agentizace RKL Opava: počty pozic z listu „Počty pozic“ ----------
   Aktuální hodnoty čte server ze zdrojové tabulky; pro přehled po dnech se každý (relace, datum) uloží do databáze. */
const nk = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const PRETTY = { zapad: 'Západ', vychod: 'Východ', vnitro: 'Vnitro', jih: 'Jih' };
const prettyName = raw => String(raw || '').trim().split(/\s+/).map(w => PRETTY[nk(w)] || (w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
const AGENT_ORDER = ['zapad 1', 'zapad 2', 'zapad 3', 'zapad 4', 'vnitro 1', 'vnitro 2', 'vnitro 3', 'vnitro 4', 'jih', 'vychod'];
async function updateAgents(counts) {
  if (!counts) return;
  const byDay = new Map();
  for (const c of counts) for (const e of c.entries) {
    if (!byDay.has(e.date)) byDay.set(e.date, {});
    byDay.get(e.date)[nk(c.name)] = e.count;
  }
  for (const [day, c] of byDay) {
    const prev = (store.mem.agent[day] && store.mem.agent[day].c) || {};
    const merged = { ...prev, ...c };
    if (JSON.stringify(merged) !== JSON.stringify(prev)) await store.put('agent', day, { c: merged, u: new Date().toISOString() });
  }
}

/* ---------- HTTP ---------- */
const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- AI dashboard: vlastní heslo (AI_PASSWORD), nezávislé na hlavním přihlášení ----------
const crypto = require('crypto');
const aiPw = () => process.env.AI_PASSWORD || '';
const aiTok = () => crypto.createHmac('sha256', aiPw() + '|' + (process.env.SESSION_SECRET || 'rkl')).update('rkl-ai-dashboard-v1').digest('hex');
const aiEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const aiCookie = req => { for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0 && p.slice(0, i).trim() === 'rkl_ai') return decodeURIComponent(p.slice(i + 1).trim()); } return ''; };
const aiOk = req => !!aiPw() && aiEq(aiCookie(req), aiTok());
const aiTries = new Map();
const AI_LOGIN = `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agentizace RKL Opava – přihlášení</title><link rel="icon" type="image/png" href="/favicon.png">
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1d388f;color:#e9edf7;font:16px/1.4 system-ui,sans-serif;padding:16px;overflow:hidden}
body::before{content:"";position:fixed;inset:-16px;background:url(/bg.jpg) center/cover no-repeat;filter:blur(1.5px);z-index:-3}
body::after{content:"";position:fixed;inset:0;z-index:-2;background:radial-gradient(900px 500px at 15% -10%,rgba(94,138,255,.35),transparent 60%),radial-gradient(700px 500px at 90% 110%,rgba(242,165,22,.18),transparent 60%),linear-gradient(160deg,rgba(0,0,10,.55),rgba(10,20,60,.82))}
.grid{position:fixed;inset:0;z-index:-1;pointer-events:none;background-image:linear-gradient(rgba(94,138,255,.14) 1px,transparent 1px),linear-gradient(90deg,rgba(94,138,255,.14) 1px,transparent 1px),repeating-linear-gradient(0deg,rgba(255,255,255,.04) 0 1px,transparent 1px 3px);background-size:48px 48px,48px 48px,auto;mask-image:radial-gradient(ellipse at 50% 50%,#000 25%,transparent 80%);-webkit-mask-image:radial-gradient(ellipse at 50% 50%,#000 25%,transparent 80%)}
.scan{position:fixed;left:0;right:0;height:120px;z-index:-1;pointer-events:none;background:linear-gradient(180deg,transparent,rgba(94,138,255,.18),transparent);animation:sc 6s linear infinite}@keyframes sc{from{top:-120px}to{top:100%}}
form{position:relative;width:100%;max-width:380px;background:rgba(6,10,24,.82);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);border:1px solid rgba(94,138,255,.5);padding:30px 26px;clip-path:polygon(18px 0,100% 0,100% calc(100% - 18px),calc(100% - 18px) 100%,0 100%,0 18px);box-shadow:0 0 50px rgba(94,138,255,.3)}
form::before{content:"";position:absolute;left:0;top:0;width:60px;height:2px;background:#5e8aff;box-shadow:0 0 12px #5e8aff}
@media (prefers-reduced-motion:reduce){.scan{animation:none}}
img{width:48px;height:48px;border-radius:10px;display:block;margin-bottom:14px}h1{margin:0 0 4px;font-size:20px;letter-spacing:3px;text-transform:uppercase}p{margin:0 0 18px;color:#8793ad;font-size:13px;letter-spacing:1px}
input{width:100%;padding:12px;background:#000;border:1px solid rgba(94,138,255,.5);color:#fff;font-size:16px;outline:0}input:focus{box-shadow:0 0 12px rgba(94,138,255,.6)}
button{margin-top:12px;width:100%;padding:12px;background:#1d388f;border:1px solid #5e8aff;color:#fff;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer}button:hover{background:#2747b8}
.e{color:#ff6b5e;font-size:14px;min-height:20px;margin-top:10px}</style></head><body>
<div class="grid"></div><div class="scan"></div><form id="f"><img src="/logo.jpg" alt="RKL"><h1>Agentizace RKL Opava</h1><p>Monitoring AI agentů</p>
<input type="password" id="pw" placeholder="Heslo" autocomplete="current-password" autofocus><button>Vstoupit</button><div class="e" id="e"></div></form>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const r=await fetch('/ai/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
if(r.ok)location.href='/ai';else{const j=await r.json().catch(()=>({}));document.getElementById('e').textContent=j.error||'Chyba';}};</script></body></html>`;
for (const f of ['bg.jpg', 'logo.jpg', 'favicon.png']) app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, 'public', f)));
app.post('/ai/login', (req, res) => {
  const ip = req.ip || 'x', now = Date.now();
  const t = (aiTries.get(ip) || []).filter(x => now - x < 10 * 60 * 1000); aiTries.set(ip, t);
  if (t.length >= 10) return res.status(429).json({ error: 'Příliš mnoho pokusů, zkus to za pár minut.' });
  if (!aiPw() || !aiEq(String((req.body && req.body.password) || ''), aiPw())) { t.push(now); return res.status(401).json({ error: 'Nesprávné heslo.' }); }
  aiTries.delete(ip);
  res.cookie('rkl_ai', aiTok(), { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: 30 * 864e5 });
  res.json({ ok: true });
});
app.get('/ai/logout', (req, res) => { res.clearCookie('rkl_ai', { path: '/' }); res.redirect('/ai'); });
app.get('/ai', (req, res) => aiOk(req) ? res.sendFile(path.join(__dirname, 'private', 'ai.html')) : res.type('html').send(AI_LOGIN));
app.use('/api/agents', (req, res, next) => aiOk(req) ? next() : res.status(401).json({ error: 'Nepřihlášen' }));
app.get('/api/agents', async (req, res) => {
  await refreshSheet(false);
  const cur = new Map();
  for (const c of sheet.counts || []) { const e = c.entries[0]; if (e) cur.set(nk(c.name), { name: prettyName(c.name), count: e.count, date: e.date }); }
  const histKeys = new Set();
  for (const v of Object.values(store.mem.agent)) for (const k of Object.keys(v.c || {})) histKeys.add(k);
  const keys = [...AGENT_ORDER, ...[...cur.keys(), ...histKeys].filter((k, i, a) => !AGENT_ORDER.includes(k) && a.indexOf(k) === i)];
  const relations = keys.map(k => ({ key: k, name: (cur.get(k) && cur.get(k).name) || prettyName(k), count: cur.has(k) ? cur.get(k).count : null, date: cur.has(k) ? cur.get(k).date : null }));
  const history = Object.keys(store.mem.agent).sort().reverse().slice(0, 45).map(d => {
    const c = store.mem.agent[d].c || {};
    return { date: d, counts: c, total: Object.values(c).reduce((a, b) => a + b, 0) };
  });
  res.json({
    configured: !!(store.mem.cfg.sheet && store.mem.cfg.sheet.url), fetchedAt: sheet.fetchedAt, error: sheet.error,
    hasSheet: !!(sheet.counts && sheet.counts.length), relations,
    total: relations.reduce((a, r) => a + (r.count || 0), 0),
    history, texts: Object.fromEntries(Object.entries(store.mem.atext).map(([k, v]) => [k, v.t || ''])),
  });
});

// popis, jak relace agenta využívá (sdílený pro všechny)
app.post('/api/agents/text', async (req, res) => {
  const key = nk(req.body && req.body.key), text = String((req.body && req.body.text) || '').slice(0, 6000);
  if (!key) return res.status(400).json({ error: 'Chybí relace.' });
  await store.put('atext', key, text ? { t: text, u: new Date().toISOString() } : null);
  res.json({ ok: true });
});

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
    fetchedAt: sheet.fetchedAt, changedAt: store.mem.cfg.chg ? store.mem.cfg.chg.at : null, error: sheet.error, sheetName: sheet.sheet, totalRows: sheet.rows.length,
    missing, today, from: subWorkdays(today, 3), rate, trips, storage: store.kind,
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

// nabídka přeprav z RKL Spedice pro přepínání pohledu (bez provizí): server si ji čte od rklspedice vlastním tokenem
const SPEDICE_URL = (process.env.SPEDICE_URL || 'https://rklspedice.onrender.com').replace(/\/$/, '');
let spCache = { at: 0, data: null, error: null }, spInflight = null;
async function loadSpedice() {
  const tok = require('./lib/auth').internalToken();
  if (!tok) throw new Error('chybí DATABASE_URL');
  const r = await fetch(SPEDICE_URL + '/api/board', { headers: { 'x-rkl-internal': tok, Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('RKL Spedice odpověděla ' + r.status + (r.status === 401 ? ' (zatím neběží nová verze?)' : ''));
  const b = await r.json();
  return {
    configured: b.configured, fetchedAt: b.fetchedAt, changedAt: b.changedAt, until: b.until, soldToday: b.soldToday,
    open: (b.offered || []).length,
    offered: (b.offered || []).slice(0, 60).map(o => ({ key: o.key, order: o.order, date: o.date, route: o.route, goods: o.goods, weight: o.weight,
      zipTo: o.zipTo, incCzk: o.incCzk, incEur: o.incEur, codeL: o.codeL, codeU: o.codeU, marked: o.marked, pinned: o.pinned })),
    notes: b.notes || {},
  };
}
app.get('/api/spedice', async (req, res) => {
  const fresh = spCache.data && Date.now() - spCache.at < 15000;
  if (!fresh && !spInflight) {
    spInflight = loadSpedice()
      .then(d => { spCache = { at: Date.now(), data: d, error: null }; })
      .catch(e => { spCache = { ...spCache, at: Date.now() - 10000, error: e.message }; })
      .finally(() => { spInflight = null; });
  }
  if (!spCache.data && spInflight) await spInflight;
  res.json({ ...(spCache.data || {}), error: spCache.error, ok: !!spCache.data });
});


app.get('/healthz', (req, res) => res.send('ok'));

createStore('kv_doprava', ['cfg', 'geo', 'hist', 'agent', 'atext'], 'doprava.json').then(s => {
  store = s;
  geo.useCache(store.mem.geo, (k, v) => store.put('geo', k, v));
  app.listen(PORT, () => console.log('RKL Doprava běží na portu ' + PORT));
  refreshSheet(true);
  setInterval(() => refreshSheet(true), BG_REFRESH);
}).catch(e => { console.error('Start selhal:', e); process.exit(1); });
