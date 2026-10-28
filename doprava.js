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
const { pragueToday, subWorkdays, isWorkday } = require('./lib/workdays');
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
      if (out.counts) {                                   // kdy se hodnoty počtů v tabulce naposledy opravdu změnily
        const sig = require('crypto').createHash('sha1').update(JSON.stringify(out.counts.map(c => [nk(c.name), c.entries[0] ? c.entries[0].count : null, c.entries[0] ? c.entries[0].date : null]).sort())).digest('hex');
        const cur = store.mem.cfg.cnt;
        if (!cur || cur.h !== sig) await store.put('cfg', 'cnt', { h: sig, at: new Date().toISOString(), prev: cur ? cur.at : null });
      }
      try { await require('./lib/issues').snapshot(store, out.texts); } catch (e) { console.error('Přehled problémů:', e.message); }
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
const tripBase = n => { const m = nk(n).match(/^(.*?)\s+prepravy$/); return m ? m[1] : null; };   // sloupec „Západ 1 Přepravy“ = počet přeprav relace Západ 1
const AGENT_ORDER = ['zapad 1', 'zapad 2', 'zapad 3', 'zapad 4', 'vnitro 1', 'vnitro 2', 'vnitro 3', 'vnitro 4', 'jih', 'vychod'];
async function updateAgents(counts) {
  if (!counts) return;
  const byDay = new Map();
  for (const c of counts) if (!tripBase(c.name)) for (const e of c.entries) {
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
body::before{content:"";position:fixed;inset:-16px;background:url(/bg.jpg) center/cover no-repeat;filter:grayscale(1) contrast(1.35) brightness(.5) blur(1px);z-index:-3}
.hl{position:fixed;inset:-16px;z-index:-3;pointer-events:none;background:url(/bg.jpg) center/cover no-repeat;filter:grayscale(1) contrast(3.2) brightness(.85) blur(1.3px);mix-blend-mode:screen;opacity:.45}
body::after{content:"";position:fixed;inset:0;z-index:-2;background:radial-gradient(900px 500px at 15% -10%,rgba(94,138,255,.35),transparent 60%),radial-gradient(700px 500px at 90% 110%,rgba(242,165,22,.18),transparent 60%),linear-gradient(160deg,rgba(0,6,34,.78),rgba(8,24,86,.72))}
.grid{position:fixed;inset:0;z-index:-1;pointer-events:none;background-image:linear-gradient(rgba(94,138,255,.14) 1px,transparent 1px),linear-gradient(90deg,rgba(94,138,255,.14) 1px,transparent 1px),repeating-linear-gradient(0deg,rgba(255,255,255,.04) 0 1px,transparent 1px 3px);background-size:48px 48px,48px 48px,auto;mask-image:radial-gradient(ellipse at 50% 50%,#000 25%,transparent 80%);-webkit-mask-image:radial-gradient(ellipse at 50% 50%,#000 25%,transparent 80%)}
.scene{position:fixed;left:0;right:0;bottom:0;width:100%;height:62vh;min-height:300px;z-index:-1;pointer-events:none;opacity:.55}
form{position:relative;width:100%;max-width:380px;background:rgba(6,10,24,.82);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);border:1px solid rgba(94,138,255,.5);padding:30px 26px;clip-path:polygon(18px 0,100% 0,100% calc(100% - 18px),calc(100% - 18px) 100%,0 100%,0 18px);box-shadow:0 0 50px rgba(94,138,255,.3)}
form::before{content:"";position:absolute;left:0;top:0;width:60px;height:2px;background:#5e8aff;box-shadow:0 0 12px #5e8aff}
img{width:48px;height:48px;border-radius:10px;display:block;margin-bottom:14px}h1{margin:0 0 4px;font-size:20px;letter-spacing:3px;text-transform:uppercase}p{margin:0 0 18px;color:#8793ad;font-size:13px;letter-spacing:1px}
input{width:100%;padding:12px;background:#000;border:1px solid rgba(94,138,255,.5);color:#fff;font-size:16px;outline:0}input:focus{box-shadow:0 0 12px rgba(94,138,255,.6)}
button{margin-top:12px;width:100%;padding:12px;background:#1d388f;border:1px solid #5e8aff;color:#fff;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer}button:hover{background:#2747b8}
.by{margin-top:18px;text-align:center;font-size:10px;letter-spacing:2px;opacity:.28}.e{color:#ff6b5e;font-size:14px;min-height:20px;margin-top:10px}</style></head><body>
<div class="hl"></div><div class="grid"></div><form id="f"><img src="/logo.jpg" alt="RKL"><h1>Agentizace RKL Opava</h1><p>Monitoring AI agentů</p>
<input type="password" id="pw" placeholder="Heslo" autocomplete="current-password" autofocus><button>Vstoupit</button><div class="e" id="e"></div><div class="by">Robin Balcar</div></form>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const r=await fetch('/ai/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
if(r.ok)location.href='/ai';else{const j=await r.json().catch(()=>({}));document.getElementById('e').textContent=j.error||'Chyba';}};</script></body></html>`;
for (const f of ['bg.jpg', 'logo.jpg', 'favicon.png']) app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, 'public', f)));

// ---------- evidence přihlášených do /ai: anonymní ID zařízení (cookie rkl_aiv), IP, prohlížeč; historie připojení ----------
const aiSeen = new Map(); // id -> čas posledního pingu (v paměti)
const vCookie = req => { for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0 && p.slice(0, i).trim() === 'rkl_aiv') return decodeURIComponent(p.slice(i + 1).trim()); } return ''; };
const devLabel = ua => {
  ua = String(ua || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Neznámé zařízení';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '';
  return br ? os + ' · ' + br : os;
};
async function aiTrack(req, res, kind) {
  try {
    let id = vCookie(req);
    if (!/^[a-f0-9]{16}$/.test(id)) { id = crypto.randomBytes(8).toString('hex'); res.cookie('rkl_aiv', id, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: 365 * 864e5 }); }
    const now = Date.now(), iso = new Date(now).toISOString(), ua = String(req.headers['user-agent'] || '').slice(0, 300), ip = req.ip || '';
    const u = store.mem.aiuser[id], prevSeen = aiSeen.get(id) || (u && Date.parse(u.last)) || 0;
    aiSeen.set(id, now);
    const newVisit = kind === 'login' || !prevSeen || now - prevSeen > 30 * 60 * 1000;
    if (!u || newVisit || now - Date.parse(u.last) > 5 * 60 * 1000 || u.ip !== ip) {
      await store.put('aiuser', id, { id, ip, ua, label: (u && u.label) || '', first: (u && u.first) || iso, last: iso, n: ((u && u.n) || 0) + (newVisit ? 1 : 0) });
    }
    if (newVisit) {
      await store.put('alog', iso + '-' + id, { id, at: iso, ip, ua, kind: kind === 'login' ? 'přihlášení' : 'připojení' });
      const keys = Object.keys(store.mem.alog).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - 1000))) await store.put('alog', k, null);
    }
  } catch (e) { console.error('aiTrack:', e.message); }
}
app.post('/ai/login', (req, res) => {
  const ip = req.ip || 'x', now = Date.now();
  const t = (aiTries.get(ip) || []).filter(x => now - x < 10 * 60 * 1000); aiTries.set(ip, t);
  if (t.length >= 10) return res.status(429).json({ error: 'Příliš mnoho pokusů, zkus to za pár minut.' });
  if (!aiPw() || !aiEq(String((req.body && req.body.password) || ''), aiPw())) { t.push(now); return res.status(401).json({ error: 'Nesprávné heslo.' }); }
  aiTries.delete(ip);
  res.cookie('rkl_ai', aiTok(), { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: 30 * 864e5 });
  aiTrack(req, res, 'login').finally(() => res.json({ ok: true }));
});
app.get('/ai/logout', (req, res) => { aiSeen.delete(vCookie(req)); res.clearCookie('rkl_ai', { path: '/' }); res.redirect('/ai'); });
app.get('/ai', async (req, res) => { if (!aiOk(req)) return res.type('html').send(AI_LOGIN); await aiTrack(req, res, 'visit'); res.sendFile(path.join(__dirname, 'private', 'ai.html')); });
app.use('/api/agents', (req, res, next) => {
  if (!aiOk(req)) return res.status(401).json({ error: 'Nepřihlášen' });
  if (req.path === '/' || req.path === '') aiTrack(req, res, 'ping');
  next();
});
app.get('/api/agents/users', (req, res) => {
  const now = Date.now(), me = vCookie(req);
  const users = Object.values(store.mem.aiuser).map(u => { const seen = Math.max(aiSeen.get(u.id) || 0, Date.parse(u.last) || 0); return { id: u.id, short: u.id.slice(0, 4).toUpperCase(), label: u.label || '', device: devLabel(u.ua), ip: u.ip, first: u.first, last: new Date(seen).toISOString(), n: u.n || 0, online: now - (aiSeen.get(u.id) || 0) < 3 * 60 * 1000, me: u.id === me }; })
    .sort((a, b) => (b.online - a.online) || (Date.parse(b.last) - Date.parse(a.last)));
  const log = Object.values(store.mem.alog).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200).map(l => { const u = store.mem.aiuser[l.id]; return { at: l.at, id: l.id, short: l.id.slice(0, 4).toUpperCase(), label: (u && u.label) || '', device: devLabel(l.ua), ip: l.ip, kind: l.kind }; });
  res.json({ online: users.filter(u => u.online).length, total: users.length, users, log });
});
app.post('/api/agents/users/label', async (req, res) => {
  const id = String((req.body && req.body.id) || ''), u = store.mem.aiuser[id];
  if (!u) return res.status(404).json({ error: 'Neznámé zařízení' });
  await store.put('aiuser', id, { ...u, label: String((req.body && req.body.label) || '').trim().slice(0, 40) });
  res.json({ ok: true });
});
// skrytá stránka s přepisem souhrnu agentizace (odškrtávání + poznámky, sdílené mezi zařízeními)
app.get('/ai/plan', (req, res) => { if (!aiOk(req)) return res.redirect('/ai'); res.sendFile(path.join(__dirname, 'private', 'plan.html')); });
app.get('/api/agents/plan', (req, res) => res.json({ items: store.mem.plan || {} }));
app.post('/api/agents/plan', async (req, res) => {
  const id = String((req.body && req.body.id) || '').slice(0, 40);
  if (!/^[a-z0-9-]+$/i.test(id)) return res.status(400).json({ error: 'Neplatné ID.' });
  const cur = store.mem.plan[id] || {}, b = req.body || {};
  const next = { done: b.done === undefined ? !!cur.done : !!b.done, note: b.note === undefined ? (cur.note || '') : String(b.note).slice(0, 4000), at: new Date().toISOString() };
  await store.put('plan', id, next.done || next.note ? next : null);
  res.json({ ok: true });
});
app.get('/api/agents', async (req, res) => {
  await refreshSheet(false);
  const cur = new Map();
  const sheetTrips = {};
  for (const c of sheet.counts || []) {
    const e = c.entries[0], tb = tripBase(c.name);
    if (tb) { if (e) sheetTrips[tb] = e.count; continue; }
    if (e) cur.set(nk(c.name), { name: prettyName(c.name), count: e.count, date: e.date });
  }
  const isTripKey = k => / prepravy$/.test(k);
  const histKeys = new Set();
  for (const v of Object.values(store.mem.agent)) for (const k of Object.keys(v.c || {})) if (!isTripKey(k)) histKeys.add(k);
  const txtKeys = (sheet.texts || []).map(t => nk(t.name));
  const keys = [...AGENT_ORDER, ...[...cur.keys(), ...histKeys, ...txtKeys, ...(sheet.daily ? sheet.daily.relations.map(nk) : [])].filter((k, i, a) => !AGENT_ORDER.includes(k) && a.indexOf(k) === i)];
  const relations = keys.map(k => ({ key: k, name: (cur.get(k) && cur.get(k).name) || prettyName(k), count: cur.has(k) ? cur.get(k).count : null, date: cur.has(k) ? cur.get(k).date : null }));
  // „Zbývá“: dnešní řádky relace (sloupec Tuz.Z / Relace), jejichž číslo objednávky nebo přepravy má za lomítkem a rokem písmeno (např. ZZ/26N13892); řádek se počítá jednou
  const pend = {};
  for (const r of sheet.rows) if (r.date === pragueToday() && r.relace && /\/\d{2}[A-Za-z]/.test((r.order || '') + ' ' + (r.prepr || ''))) pend[nk(r.relace)] = (pend[nk(r.relace)] || 0) + 1;
  for (const r of relations) r.pending = pend[r.key] || 0;
  const sheetTexts = {};
  for (const t of sheet.texts || []) if (t.text) sheetTexts[nk(t.name)] = t.text;
  const adj = store.mem.cfg.adj, today = pragueToday();
  const adjOn = adj && (adj.always || adj.date === today) ? adj : null;           // ruční přičtení: trvale (always), nebo jen pro daný den
  for (const r of relations) if (sheetTrips[r.key] != null) r.trips = sheetTrips[r.key];
  if (adjOn) for (const r of relations) if (r.key === adjOn.key) {
    r.count = (r.count || 0) + (adjOn.count || 0); r.trips = (r.trips || 0) + (adjOn.trips || 0); r.date = r.date || today;
  }
  // agent vs. ručně (list „Počty pozic“, denní řádky); součty jen od dne nasazení agenta, Západ 1 + základ
  const SINCE = { 'zapad 1': '2026-10-12', 'vnitro 2': '2026-10-19', 'vnitro 1': '2026-10-26' };
  const split = (() => {
    // list „Počty pozic“ = snímky stavu (kumulativní počty ke dni); denní přírůstek = rozdíl oproti předchozímu snímku, víkend/svátek se přičte k dalšímu pracovnímu dni
    const dl = sheet.daily; if (!dl) return null;
    const dnames = {}; for (const n of dl.relations) dnames[nk(n)] = n;
    const F = ['pA', 'pM', 'tA', 'tM'], z = () => ({ pA: 0, pM: 0, tA: 0, tM: 0 });
    const incs = {}, rels = [];
    for (const k of Object.keys(dnames)) {
      let prev = null, pend = z(), cur = z(), td = z(), lastDate = null;
      for (const sn of dl.snaps) {
        const v = sn.rels[dnames[k]]; if (!v) continue;
        cur = v;
        const had = !!prev;
        if (prev) for (const f of F) pend[f] += Math.max(0, (v[f] || 0) - (prev[f] || 0));
        prev = v;
        // přírůstek se zapíše ke dni posledního snímku; víkend/svátek se přenese na další pracovní den (dnešní den se ukáže vždy hned)
        if (had && (sn.date === today || isWorkday(new Date(sn.date + 'T12:00:00Z')))) {
          const o = (incs[sn.date] = incs[sn.date] || {})[k] = (incs[sn.date] || {})[k] || z();
          for (const f of F) { o[f] += pend[f]; pend[f] = 0; }
        }
      }
      if (incs[today] && incs[today][k]) td = incs[today][k];
      const t = { pA: cur.pA || 0, pM: cur.pM || 0, tA: cur.tA || 0, tM: cur.tM || 0 };
      if (adjOn && adjOn.key === k) { t.pA += adjOn.count || 0; t.tA += adjOn.trips || 0; }
      rels.push(Object.assign({ key: k, name: prettyName(k), since: SINCE[k] || '', today: td }, t));
    }
    const lastDate = dl.snaps.length ? dl.snaps[dl.snaps.length - 1].date : null;
    const outDays = Object.keys(incs).sort().reverse().slice(0, 60).map(d => ({ date: d, wd: true, rels: incs[d] }));
    return { rels, days: outDays, lastDate, snapshot: true };
  })();
  if (split) for (const sr of split.rels) { const r = relations.find(x => x.key === sr.key); if (r) { r.count = sr.pA + sr.tA; r.agent = sr.pA; r.manual = sr.pM; r.trips = sr.tA; r.tripsManual = sr.tM; r.date = split.lastDate; r.todayAgent = sr.today.pA + sr.today.tA; r.todayManual = sr.today.pM + sr.today.tM; } }
  const hd = Object.keys(store.mem.agent);
  if (adjOn && !hd.includes(today)) hd.push(today);
  // každý den od prvního záznamu do dneška má řádek; úroveň relace se přenáší z předchozího dne (přírůstky počítá stránka)
  if (hd.length) {
    const first = hd.slice().sort()[0];
    for (let d = new Date(first + 'T12:00:00Z'), end = new Date(today + 'T12:00:00Z'); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const k = d.toISOString().slice(0, 10); if (!hd.includes(k)) hd.push(k);
    }
  }
  const lvl = {}, byDay = {};
  for (const d of hd.slice().sort()) {
    const c = (store.mem.agent[d] || {}).c || {};
    for (const k of Object.keys(c)) if (!isTripKey(k)) lvl[k] = c[k];
    const o = Object.assign({}, lvl);
    // výchozí hodnota (základ) se přičítá k úrovni každého dne, takže se v denních přírůstcích vyruší
    if (adjOn && (adjOn.always || d === today)) o[adjOn.key] = (o[adjOn.key] || 0) + (adjOn.count || 0);
    byDay[d] = o;
  }
  const history = Object.keys(byDay).sort().reverse().slice(0, 45).map(d => ({ date: d, wd: isWorkday(new Date(d + 'T12:00:00Z')), counts: byDay[d], total: Object.values(byDay[d]).reduce((a, b) => a + b, 0) }));
  res.json({
    changedAt: (store.mem.cfg.cnt || {}).at || null,
    trips: relations.reduce((a, r) => a + (r.trips || 0), 0),
    configured: !!(store.mem.cfg.sheet && store.mem.cfg.sheet.url), fetchedAt: sheet.fetchedAt, error: sheet.error,
    hasSheet: !!((sheet.counts && sheet.counts.length) || split), relations,
    total: relations.reduce((a, r) => a + (r.count || 0), 0),
    split, history, texts: Object.assign(Object.fromEntries(Object.entries(store.mem.atext).map(([k, v]) => [k, v.t || ''])), sheetTexts),
    workdaysSince: (() => {                       // pracovní dny od nejstaršího data v historii do dneška (včetně obou)
      const f = '2026-10-12';                         // pevný začátek měření ušetřeného času
      let n = 0; for (let d = new Date(f + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= today; d = new Date(d.getTime() + 864e5)) if (isWorkday(d)) n++;
      return n;
    })(),
    sheetKeys: Object.keys(sheetTexts), hasTexts: !!sheet.texts,
  });
});

// popis, jak relace agenta využívá (sdílený pro všechny)
app.get('/api/agents/issues', (req, res) => res.json(require('./lib/issues').report(store, sheet.texts)));
// ruční přičtení k relaci pro dnešní den: {key, count, trips}
app.post('/api/agents/adjust', async (req, res) => {
  const key = nk(req.body && req.body.key);
  if (!key) return res.status(400).json({ error: 'Chybí relace.' });
  await store.put('cfg', 'adj', { date: pragueToday(), key, count: Math.round(+req.body.count) || 0, trips: Math.round(+req.body.trips) || 0 });
  res.json({ ok: true });
});
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

createStore('kv_doprava', ['cfg', 'geo', 'hist', 'agent', 'atext', 'issue', 'isnap', 'aiuser', 'alog', 'plan'], 'doprava.json').then(async s => {
  store = s;
  geo.useCache(store.mem.geo, (k, v) => store.put('geo', k, v));
  app.listen(PORT, () => console.log('RKL Doprava běží na portu ' + PORT));
  if (!store.mem.cfg.adj || (store.mem.cfg.adj.v || 1) < 6) await store.put('cfg', 'adj', { v: 6, always: true, date: pragueToday(), key: 'zapad 1', count: 134, trips: 21 }); // jednorázově: +108 (90 + 18) pozic a +21 přeprav k Západu 1 (k hodnotě přeprav z tabulky) (jen 24. 10. 2026)
  refreshSheet(true);
  setInterval(() => refreshSheet(true), BG_REFRESH);
}).catch(e => { console.error('Start selhal:', e); process.exit(1); });
