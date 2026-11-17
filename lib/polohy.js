// Polohy vozidel z GPS systému EchoTrack (stránka /polohy na rkldoprava).
// Server se do EchoTracku přihlásí stejně jako člověk (formulář ASP.NET), drží si relaci a čte
// /MapData.ashx – stejný textový výstup, který používá jejich mapa. Data se sdílí v paměti (cache ~25 s).
//
// Proměnné prostředí (Render → Environment):
//   ECHOTRACK_USER, ECHOTRACK_PASS   přihlašovací údaje do EchoTracku (v kódu nejsou)
//   ECHOTRACK_URL                    základní adresa, výchozí http://80.188.14.114:8080
//   ECHOTRACK_IDUSER                 volitelně, pokud by se ID uživatele nepodařilo přečíst ze stránky (výchozí 19)
//   POLOHY_PASSWORD                  vlastní heslo stránky /polohy (jsou na ní jména řidičů)
const crypto = require('crypto');
const path = require('path');

const BASE = () => (process.env.ECHOTRACK_URL || 'http://80.188.14.114:8080').replace(/\/+$/, '');
const CACHE_MS = 25 * 1000;
const UA = 'Mozilla/5.0 (compatible; RKL-polohy/1.0)';

/* ---------- parsování MapData.ashx ----------
   Záznam vozidla (oddělovač [CAR]):  typ |-| f1 |-| f2 |-| "SPZ, rychlost[LBL]datum čas[LBL]řidič[LBL]návěs" |-| id |-| 3907 |-| lon*1e5 |-| lat*1e5 |-| směr(-1 = neznámý)
   První záznam má před sebou hlavičku oddělenou "|##|". */
function parseMapData(text) {
  const out = [];
  for (let chunk of String(text || '').split('[CAR]')) {
    const k = chunk.lastIndexOf('|##|');
    if (k >= 0) chunk = chunk.slice(k + 4);
    const f = chunk.split('|-|');
    if (f.length < 9) continue;
    const lbl = f[3].split('[LBL]');
    const m = /^(.*?),\s*(-?\d+)\s*$/.exec(lbl[0].trim());
    const spz = (m ? m[1] : lbl[0]).split(';')[0].trim();
    const speed = m ? +m[2] : 0;
    const lon = +f[6] / 1e5, lat = +f[7] / 1e5;
    if (!spz || !isFinite(lon) || !isFinite(lat) || (lon === 0 && lat === 0)) continue;
    const heading = +f[8];
    out.push({
      spz,
      id: +f[4] || null,
      speed,
      time: parseCzDate(lbl[1]),
      driver: (lbl[2] || '').trim(),
      trailer: (lbl[3] || '').trim(),
      lat, lon,
      heading: isFinite(heading) && heading >= 0 ? heading : null,
      on: f[1] === '1',            // příznak ze systému (význam není dokumentovaný – v UI se nepoužívá k nadpisům)
    });
  }
  return out;
}
// "17.11.2026 8:36:53" (čas v Praze) -> ISO řetězec s offsetem; bez převodu do UTC, aby se nemíchaly zóny
function parseCzDate(s) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2}):?(\d{2})?/.exec(String(s || '').trim());
  if (!m) return null;
  const [, d, mo, y, h, mi, se] = m;
  // Praha: leden–březen/říjen–listopad +01:00, léto +02:00 – určí se přes Intl, ne pevně
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se || 0));
  const off = pragueOffsetMin(guess);
  return new Date(guess - off * 60000).toISOString();
}
function pragueOffsetMin(utcMs) {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(utcMs));
    const g = t => +p.find(x => x.type === t).value;
    return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - Math.floor(utcMs / 60000) * 60000) / 60000);
  } catch { return 60; }
}

/* ---------- doplňující údaje z tabulky na stránce ActMap.aspx (skupina, místo, stát, vzdálenost) ----------
   Nepovinné a „best effort“: hledá <table> se záhlavím obsahujícím „Auto“ a „Skupina“. Když se nic nenajde, mapa funguje dál. */
function parseTable(html) {
  const res = new Map();
  const strip = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  for (const t of String(html || '').match(/<table[\s\S]*?<\/table>/gi) || []) {
    const rows = (t.match(/<tr[\s\S]*?<\/tr>/gi) || []).map(r => (r.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(strip));
    const hi = rows.findIndex(r => r.includes('Auto') && r.includes('Skupina'));
    if (hi < 0) continue;
    const h = rows[hi], ix = n => h.indexOf(n);
    for (const r of rows.slice(hi + 1)) {
      const auto = r[ix('Auto')]; if (!auto) continue;
      const spz = auto.split(';')[0].trim(); if (!spz) continue;
      res.set(spz, { group: r[ix('Skupina')] || '', place: r[ix('Místo')] || '', country: r[ix('Stát')] || '', odometer: +(r[ix('Vzdálenost')] || '') || null });
    }
  }
  return res;
}

/* ---------- klient EchoTracku (přihlášení, cookie, opakované přihlášení) ---------- */
class Jar {
  constructor() { this.c = new Map(); }
  take(res) { for (const s of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) { const [kv] = s.split(';'); const i = kv.indexOf('='); if (i > 0) this.c.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); } }
  get header() { return [...this.c].map(([k, v]) => k + '=' + v).join('; '); }
  clear() { this.c.clear(); }
}
const jar = new Jar();
let idUser = null;

async function http(url, opt = {}) {
  let cur = url, method = opt.method || 'GET', body = opt.body;
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(cur, {
      method, body, redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': UA, Cookie: jar.header, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    });
    jar.take(res);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { cur = new URL(res.headers.get('location'), cur).href; method = 'GET'; body = undefined; continue; }
    if (opt.binary) return { res, url: cur, buf: Buffer.from(await res.arrayBuffer()) };
    return { res, url: cur, text: await res.text() };
  }
  throw new Error('příliš mnoho přesměrování');
}
const attr = (tag, a) => { const m = new RegExp('\\b' + a + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i').exec(tag); return m ? (m[2] !== undefined ? m[2] : m[3]) : ''; };
const unesc = s => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function login() {
  const user = process.env.ECHOTRACK_USER, pass = process.env.ECHOTRACK_PASS;
  if (!user || !pass) throw new Error('Nejsou nastaveny ECHOTRACK_USER a ECHOTRACK_PASS.');
  jar.clear(); idUser = null;
  const first = await http(BASE() + '/');
  const inputs = first.text.match(/<input\b[^>]*>/gi) || [];
  const form = new URLSearchParams();
  let userField = '', passField = '', submit = null;
  for (const tag of inputs) {
    const name = unesc(attr(tag, 'name')), type = (attr(tag, 'type') || 'text').toLowerCase();
    if (!name) continue;
    if (type === 'hidden') form.set(name, unesc(attr(tag, 'value')));
    else if (type === 'password') passField = name;
    else if (type === 'text' && !userField) userField = name;
    else if ((type === 'submit' || type === 'image') && !submit) submit = { name, type, value: unesc(attr(tag, 'value')) };
  }
  if (!userField || !passField) throw new Error('Na přihlašovací stránce EchoTracku se nenašla pole pro jméno a heslo (změnil se vzhled?).');
  form.set(userField, user); form.set(passField, pass);
  if (submit) { if (submit.type === 'image') { form.set(submit.name + '.x', '5'); form.set(submit.name + '.y', '5'); } else form.set(submit.name, submit.value); }
  else { const a = /<a\b[^>]*href="javascript:__doPostBack\('([^']+)'/i.exec(first.text); if (a) { form.set('__EVENTTARGET', a[1]); form.set('__EVENTARGUMENT', ''); } }
  const after = await http(first.url, { method: 'POST', body: form.toString() });
  if (/type\s*=\s*["']?password/i.test(after.text) && !/ActMap|Odhlášení/i.test(after.text)) throw new Error('EchoTrack odmítl přihlášení (špatné jméno nebo heslo).');
  // ID uživatele pro MapData.ashx se čte ze stránky aktuálních pozic
  const act = await http(BASE() + '/ActMap.aspx');
  if (/type\s*=\s*["']?password/i.test(act.text)) throw new Error('EchoTrack po přihlášení nepustil na mapu.');
  const m = /IdUser\D{0,6}(\d+)/i.exec(act.text);
  idUser = m ? m[1] : (process.env.ECHOTRACK_IDUSER || '19');
  return act.text;
}

// sdílení přihlášené relace s modulem Historie
const session = { http, BASE, ensure: async () => { if (!jar.header || !idUser) await login(); }, relogin: async () => { await login(); } };

let cache = { at: 0, data: null }, inflight = null, status = { ok: false, error: 'Zatím nenačteno.', lastOk: null, lastTry: null };

async function fetchOnce(retry) {
  if (!jar.header || !idUser) await login();
  const url = BASE() + '/MapData.ashx?MapType=4&MapIdCar=-1&MapFrom=0&MapTo=0&IdUser=' + idUser + '&Language=1029&Group=&Selected=-1&_=' + Date.now();
  const r = await http(url);
  const cars = parseMapData(r.text);
  if (!cars.length) {
    if (retry) throw new Error('EchoTrack nevrátil žádná vozidla.');
    jar.clear(); idUser = null;               // relace nejspíš vypršela – přihlásit znovu
    return fetchOnce(true);
  }
  // doplnění skupiny/místa/státu z tabulky (nepovinné)
  let extra = new Map();
  try { extra = parseTable((await http(BASE() + '/ActMap.aspx')).text); } catch { /* nevadí */ }
  for (const c of cars) { const e = extra.get(c.spz); if (e) Object.assign(c, e); }
  return cars;
}

/* ---------- jak dlouho vozidlo stojí (EchoTrack to v poloze nedává, proto si to pamatujeme sami) ---------- */
// trk[spz] = { s: ISO od kdy stojí, u: 1 = začátek stání neznámý (viděno poprvé už stát) }
let trk = {}, trkLoaded = false, trkDirty = false, trkSavedAt = 0;
const hist = {};            // spz -> [[tMs, lat, lon], …] posledních HIST_H hodin (jen v paměti)
const HIST_H = 8, STILL_R = [50, 100, 200, 500, 1000];
let tripCtx = {};           // normalizované SPZ -> [{ side:'L'|'U', name, ll:[lat,lon] }] místa aktuální přepravy
const dKm = (a, b, c, d) => { const R = 6371, r = x => x * Math.PI / 180, dl = r(c - a), dn = r(d - b), h = Math.sin(dl / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
function sample(c, now) {
  const h = hist[c.spz] || (hist[c.spz] = []), l = h[h.length - 1];
  if (!l || now - l[0] >= 90e3) h.push([now, c.lat, c.lon]);
  while (h.length && now - h[0][0] > HIST_H * 3600e3) h.shift();
  return h;
}
// od kdy se vozidlo nepohnulo o víc než R metrů od současné polohy; stillSpan = jak dlouhou historii máme
function motion(c, h, now) {
  c.span = h.length ? Math.round((now - h[0][0]) / 60000) : 0;
  c.still = {};
  for (const R of STILL_R) {
    let t = h.length ? h[0][0] : now;
    for (let i = h.length - 1; i >= 0; i--) if (dKm(c.lat, c.lon, h[i][1], h[i][2]) * 1000 > R) { t = h[i][0]; break; }
    c.still[R] = Math.max(0, Math.round((now - t) / 60000));
  }
  const pl = tripCtx[String(c.spz).toUpperCase().replace(/[\s-]+/g, '')];
  if (pl && pl.length) {
    c.trip = true;
    const near = side => { let b = null; for (const p of pl) if (p.side === side && p.ll) { const d = dKm(c.lat, c.lon, p.ll[0], p.ll[1]); if (!b || d < b.d) b = { d, p }; } return b; };
    const L = near('L'), U = near('U');
    if (L) { c.dL = +L.d.toFixed(1); c.nL = L.p.name; }
    if (U) {
      c.dU = +U.d.toFixed(1); c.nU = U.p.name;
      // změna vzdálenosti k vykládce za posledních ~25 min (kladná = blíží se)
      let ref = null; for (let i = h.length - 1; i >= 0; i--) if (now - h[i][0] >= 20 * 60e3) { ref = h[i]; break; }
      if (ref && now - ref[0] <= 45 * 60e3) c.dUd = +(dKm(ref[1], ref[2], U.p.ll[0], U.p.ll[1]) - U.d).toFixed(1);
    }
  }
}

function track(cars, now) {
  const seen = new Set();
  for (const c of cars) {
    seen.add(c.spz);
    const moving = c.speed > 0;
    if (moving) { if (trk[c.spz]) { delete trk[c.spz]; trkDirty = true; } }
    else if (!trk[c.spz]) { trk[c.spz] = { s: new Date(now).toISOString(), u: trkLoaded && Object.keys(trk).length ? 0 : 1 }; trkDirty = true; }
    motion(c, sample(c, now), now);
    const t = trk[c.spz];
    c.stopMin = t ? Math.max(0, Math.round((now - Date.parse(t.s)) / 60000)) : 0;
    c.stopKnown = t ? !t.u : true;
  }
  for (const k of Object.keys(trk)) if (!seen.has(k)) { delete trk[k]; trkDirty = true; }
  for (const k of Object.keys(hist)) if (!seen.has(k)) delete hist[k];   // vozidlo zmizelo ze seznamu
}
async function trkPersist(stFn) {
  const st = stFn && stFn();
  if (!trkLoaded) {
    if (st && st.mem && st.mem.gpstrk) { const v = st.mem.gpstrk.state; if (v && v.trk) { for (const [k, o] of Object.entries(v.trk)) if (trk[k] ? trk[k].u : !cache.data) trk[k] = o; } }
    trkLoaded = true; return;   // bez úložiště se začíná od nuly
  }
  if (!st || !st.mem || !st.mem.gpstrk) return;
  if (trkDirty && Date.now() - trkSavedAt > 4 * 60 * 1000) { trkDirty = false; trkSavedAt = Date.now(); try { await st.put('gpstrk', 'state', { trk, at: new Date().toISOString() }); } catch (e) { console.error('Polohy (stání):', e.message); } }
}

async function getCars() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache;
  if (!inflight) {
    status.lastTry = new Date().toISOString();
    inflight = fetchOnce(false).then(cars => {
      track(cars, Date.now());
      cache = { at: Date.now(), data: cars };
      status = { ok: true, error: '', lastOk: new Date().toISOString(), lastTry: status.lastTry };
    }).catch(e => {
      status = { ok: false, error: String(e.message || e), lastOk: status.lastOk, lastTry: status.lastTry };
      console.error('Polohy (EchoTrack):', e.message);
    }).finally(() => { inflight = null; });
  }
  await inflight;
  return cache;
}

/* ---------- vlastní heslo stránky /polohy ---------- */
const pw = () => process.env.POLOHY_PASSWORD || '';
const tok = () => crypto.createHmac('sha256', pw() + '|' + (process.env.SESSION_SECRET || 'rkl')).update('rkl-polohy-v1').digest('hex');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const cookie = req => { for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0 && p.slice(0, i).trim() === 'rkl_polohy') return decodeURIComponent(p.slice(i + 1).trim()); } return ''; };
const ok = req => !!pw() && eq(cookie(req), tok());
const tries = new Map();
// přístup pro cizí aplikace: klíč v hlavičce Authorization: Bearer <klíč> nebo X-API-Key (env GPS_API_KEY, více klíčů čárkou); jen pro čtení
const apiKeys = () => String(process.env.GPS_API_KEY || '').split(',').map(x => x.trim()).filter(x => x.length >= 16);
const keyOk = req => {
  const ks = apiKeys(); if (!ks.length) return false;
  const h = String(req.headers['x-api-key'] || (/^Bearer\s+(.+)$/i.exec(req.headers.authorization || '') || [])[1] || '').trim();
  return !!h && ks.some(k => eq(h, k));
};
const okApi = req => ok(req) || keyOk(req);
const apiCors = (req, res, next) => {   // klíč (ne cookie) smí i z prohlížeče cizí domény
  if (req.headers['x-api-key'] || req.headers.authorization) { res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, X-API-Key', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' }); }
  if (req.method === 'OPTIONS') { res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, X-API-Key', 'Access-Control-Allow-Methods': 'GET, OPTIONS' }); return res.sendStatus(204); }
  next();
};

/* ---------- předání přihlášení z dashboardů (tlačítko GPS): krátkodobý podepsaný odkaz ----------
   Dashboard (rklspedice i rkldoprava) po ověření svým přihlášením přesměruje na /polohy?sso=<čas>.<podpis>.
   Podpis vychází ze sdíleného klíče (RKL_INTERNAL_KEY, jinak DATABASE_URL – stejný, jaký už služby sdílejí). Platí 3 minuty. */
const ssoKey = () => { const k = process.env.RKL_INTERNAL_KEY || process.env.DATABASE_URL; return k ? crypto.createHmac('sha256', k).update('rkl-polohy-sso-v1').digest() : null; };
const ssoSign = ts => crypto.createHmac('sha256', ssoKey()).update('polohy|' + ts).digest('hex');
function ssoUrl(extra) {
  const base = process.env.POLOHY_URL || 'https://dashboard.airkl.cz/polohy';
  const ex = extra ? '&' + extra : '';
  if (!ssoKey()) return extra ? base + '?' + extra : base;
  const ts = String(Date.now());
  return base + '?sso=' + ts + '.' + ssoSign(ts) + ex;
}
function ssoValid(v) {
  if (!ssoKey()) return false;
  const [ts, sig] = String(v || '').split('.');
  return !!ts && !!sig && /^\d{10,15}$/.test(ts) && Math.abs(Date.now() - +ts) < 3 * 60 * 1000 && eq(sig, ssoSign(ts));
}
// tlačítko GPS v dashboardech: volající server si předem ověří přihlášení uživatele (vlastní heslo / relace)
// ?spz=…&p=… (trasa přepravy) se předá dál, aby se po přihlášení rovnou zobrazila trasa vozidla
/* ---------- omezený přístup „jen jedno vozidlo“ (řidiči): odkaz podepsaný i s SPZ, cookie nese SPZ + podpis ---------- */
const normSpz = x => String(x || '').toUpperCase().replace(/[\s-]+/g, '');
const oneSig = (ts, spz) => crypto.createHmac('sha256', ssoKey()).update('polohy1|' + ts + '|' + normSpz(spz)).digest('hex');
const oneCookieVal = spz => Buffer.from(String(spz)).toString('base64url') + '.' + crypto.createHmac('sha256', (pw() || 'x') + '|' + (process.env.SESSION_SECRET || 'rkl')).update('rkl-polohy-one-v1|' + normSpz(spz)).digest('hex');
const oneSpz = req => {
  let v = ''; for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0 && p.slice(0, i).trim() === 'rkl_polohy_one') v = decodeURIComponent(p.slice(i + 1).trim()); }
  const [b, sig] = v.split('.'); if (!b || !sig || !pw()) return '';
  let spz = ''; try { spz = Buffer.from(b, 'base64url').toString(); } catch { return ''; }
  return spz && spz.length <= 20 && eq(v, oneCookieVal(spz)) ? spz : '';
};
// tlačítko „GPS <SPZ>“ v aplikaci řidičů: volající si předem ověří, že řidič na SPZ smí
const gpsGoOne = spz => (req, res) => {
  if (!ssoKey()) return res.status(503).send('GPS není nastaveno.');
  const ts = String(Date.now());
  res.redirect(302, (process.env.POLOHY_URL || 'https://dashboard.airkl.cz/polohy') + '?sso1=' + ts + '.' + oneSig(ts, spz) + '&one=' + encodeURIComponent(spz));
};
const gpsGo = (req, res) => {
  const spz = String(req.query.spz || '').slice(0, 20), p = String(req.query.p || '');
  const extra = spz && p && p.length <= 3000 && /^[A-Za-z0-9_-]+$/.test(p) ? 'spz=' + encodeURIComponent(spz) + '&p=' + p : '';
  res.redirect(302, ssoUrl(extra));
};

function setup(app, opts) {
  const watchList = () => { const st = store(); const w = (st && st.mem.gpstrk && st.mem.gpstrk.tempwatch) || {}; return Object.values(w).filter(x => x && new Date(x.until) > new Date()); };
  const store = () => (opts && typeof opts.store === 'function' ? opts.store() : null);
  app.get('/polohy', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.query.sso !== undefined) {
      if (ssoValid(req.query.sso) && pw()) res.cookie('rkl_polohy', tok(), { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: 30 * 864e5 });
      const q = new URLSearchParams(); for (const k of ['spz', 'p']) if (typeof req.query[k] === 'string') q.set(k, req.query[k]);
      return res.redirect(302, '/polohy' + (q.toString() ? '?' + q : ''));   // adresa bez tokenu; neplatný token = běžné přihlášení heslem
    }
    if (req.query.sso1 !== undefined) {
      const [ts, sig] = String(req.query.sso1).split('.'), spz = String(req.query.one || '').slice(0, 20);
      if (ssoKey() && pw() && spz && /^\d{10,15}$/.test(ts || '') && sig && Math.abs(Date.now() - +ts) < 3 * 60 * 1000 && eq(sig, oneSig(ts, spz)))
        res.cookie('rkl_polohy_one', oneCookieVal(spz), { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: 7 * 864e5 });
      return res.redirect(302, '/polohy');
    }
    if (!ok(req) && oneSpz(req)) {   // omezený režim: stejná stránka, bez historie, reportů, profilů; data stejně filtruje server
      const spz = oneSpz(req);
      try {
        let h = require('fs').readFileSync(path.join(__dirname, '..', 'private', 'polohy.html'), 'utf8');
        const inj = '<style>#tabs,#pbar,#tvb,#q,#tools label,#tools .legend{display:none!important}</style><script>window.GPS_ONE=' + JSON.stringify(spz) + ';</script>';
        return res.type('html').send(h.includes('</head>') ? h.replace('</head>', inj + '</head>') : inj + h);
      } catch (e) { return res.status(500).send('Chyba.'); }
    }
    res.sendFile(path.join(__dirname, '..', 'private', ok(req) ? 'polohy.html' : 'polohy-login.html'));
  });
  app.post('/polohy/login', (req, res) => {
    const ip = req.ip || 'x', now = Date.now();
    const t = (tries.get(ip) || []).filter(x => now - x < 10 * 60 * 1000); tries.set(ip, t);
    if (t.length >= 10) return res.status(429).json({ error: 'Příliš mnoho pokusů, zkus to za pár minut.' });
    if (!pw()) return res.status(503).json({ error: 'Heslo stránky není nastaveno (POLOHY_PASSWORD).' });
    if (!eq(String((req.body && req.body.password) || ''), pw())) { t.push(now); return res.status(401).json({ error: 'Nesprávné heslo.' }); }
    tries.delete(ip);
    res.cookie('rkl_polohy', tok(), { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: 30 * 864e5 });
    res.json({ ok: true });
  });
  app.get('/polohy/logout', (req, res) => { res.clearCookie('rkl_polohy', { path: '/' }); res.clearCookie('rkl_polohy_one', { path: '/' }); res.redirect('/polohy'); });

  // ---- sdílené profily zobrazení (pojmenované výběry SPZ); vidí a upravuje je každý přihlášený ----
  const profList = () => { const st = store(); return st ? Object.values(st.mem.gps || {}).sort((a, b) => a.name.localeCompare(b.name, 'cs')) : []; };
  app.get('/api/polohy/profily', (req, res) => {
    if (!ok(req) && oneSpz(req)) return res.json({ profiles: [], editable: false });
    if (!ok(req)) return res.status(401).json({ error: 'Nepřihlášeno.' });
    res.set('Cache-Control', 'no-store'); res.json({ profiles: profList(), editable: !!store() });
  });
  app.post('/api/polohy/profily', async (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'Nepřihlášeno.' });
    const st = store(); if (!st || !st.mem.gps) return res.status(503).json({ error: 'Úložiště profilů není k dispozici.' });
    const b = req.body || {}, name = String(b.name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'Zadejte název profilu.' });
    const spz = [...new Set((Array.isArray(b.spz) ? b.spz : []).map(x => String(x).trim().slice(0, 24)).filter(Boolean))].slice(0, 300);
    let id = String(b.id || '');
    if (id && !st.mem.gps[id]) id = '';
    if (!id) id = crypto.randomBytes(5).toString('hex');
    if (profList().some(p => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'Profil s tímto názvem už existuje.' });
    // pravidla barev: až 5, každé { c: barva z palety, t: typ podmínky, a: čas/rychlost, r: poloměr, m: doplňková minuta }
    const COL = ['#ff4d4d', '#ff9f2e', '#ffd84d', '#b46bff', '#35c9e8'], TYP = ['still', 'speed', 'nosig', 'atL', 'atU', 'toU', 'awayU', 'idleOut'];
    const num = (v, lo, hi, d) => { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
    const rules = (Array.isArray(b.rules) ? b.rules : []).slice(0, 5).filter(r => r && COL.includes(r.c) && TYP.includes(r.t)).map(r => ({
      c: r.c, t: r.t, a: num(r.a, 0, 10080, 0), r: num(r.r, 0, 100000, 0), m: num(r.m, 0, 10080, 0),
    }));
    // štítek u vozidla na mapě: { on: zobrazit?, f: [pole] }
    const LF = ['spz', 'driver', 'trailer', 'speed', 'group', 'place', 'stop', 'nU', 'dU', 'rule', 'temp', 'fuel'];
    const lb = b.label && typeof b.label === 'object' ? b.label : null;
    const label = lb ? { on: lb.on !== false, f: [...new Set((Array.isArray(lb.f) ? lb.f : []).filter(x => LF.includes(x)))] } : null;
    // hlídání teploty (z reportu Teplota): { on, lo, hi } ve °C, mez může chybět
    const tb = b.temp && typeof b.temp === 'object' ? b.temp : null;
    const tn = v => (v === '' || v === null || v === undefined || !Number.isFinite(+v)) ? null : Math.min(60, Math.max(-60, +v));
    const temp = tb ? { on: !!tb.on, lo: tn(tb.lo), hi: tn(tb.hi) } : null;
    const prof = { id, name, spz, rules, ...(label ? { label } : {}), ...(temp ? { temp } : {}), u: new Date().toISOString() };
    await st.put('gps', id, prof);
    res.json({ ok: true, profile: prof });
  });
  // hlídání teploty u konkrétní SPZ na určitou dobu: { spz, target, tol, until } (ukládá se na serveru, platí pro všechna zařízení)
  app.get('/api/polohy/teplota-hlidani', (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'Nepřihlášeno.' });
    res.set('Cache-Control', 'no-store'); res.json({ watch: watchList() });
  });
  app.post('/api/polohy/teplota-hlidani', async (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'Nepřihlášeno.' });
    const st = store(); if (!st || !st.mem.gpstrk) return res.status(503).json({ error: 'Úložiště není k dispozici.' });
    const b = req.body || {}, spz = String(b.spz || '').trim().slice(0, 24);
    const target = +b.target, tol = +b.tol, hours = +b.hours;
    if (!spz || !Number.isFinite(target) || !Number.isFinite(tol) || tol <= 0 || tol > 60 || !Number.isFinite(hours) || hours <= 0) return res.status(400).json({ error: 'Zadejte SPZ, cílovou teplotu, odchylku a dobu hlídání.' });
    const w = Object.assign({}, st.mem.gpstrk.tempwatch || {});
    w[spz] = { spz, target: Math.max(-60, Math.min(60, target)), tol, until: new Date(Date.now() + Math.min(hours, 24 * 14) * 3600e3).toISOString() };
    await st.put('gpstrk', 'tempwatch', w);
    res.json({ ok: true, watch: watchList() });
  });
  app.delete('/api/polohy/teplota-hlidani', async (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'Nepřihlášeno.' });
    const st = store(); if (!st || !st.mem.gpstrk) return res.status(503).json({ error: 'Úložiště není k dispozici.' });
    const w = Object.assign({}, st.mem.gpstrk.tempwatch || {}); delete w[String(req.query.spz || '')];
    await st.put('gpstrk', 'tempwatch', w); res.json({ ok: true, watch: watchList() });
  });
  app.delete('/api/polohy/profily/:id', async (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'Nepřihlášeno.' });
    const st = store(); if (!st || !st.mem.gps) return res.status(503).json({ error: 'Úložiště profilů není k dispozici.' });
    const id = String(req.params.id || '');
    if (!st.mem.gps[id]) return res.status(404).json({ error: 'Profil neexistuje.' });
    await st.put('gps', id, null); res.json({ ok: true });
  });
  // na pozadí průběžně načítá polohy, aby se „stojí od“ měřilo i když nikdo nemá stránku otevřenou (GPS_TRACK_MIN minut, 0 = vypnuto)
  const everyMin = process.env.GPS_TRACK_MIN === undefined ? 3 : +process.env.GPS_TRACK_MIN;
  if (everyMin > 0 && process.env.ECHOTRACK_USER && process.env.ECHOTRACK_PASS) {
    let tripAt = 0;
    const refreshTrips = async () => {   // místa aktuálních přeprav (Západ) pro pravidla „nakládka / vykládka“
      if (!opts || typeof opts.trips !== 'function' || Date.now() - tripAt < 5 * 60e3) return; tripAt = Date.now();
      try {
        const list = await opts.trips(), geo = require('./geo'), m = {};
        for (const t of list || []) {
          const k = String(t.spz || '').toUpperCase().replace(/[\s-]+/g, ''); if (!k) continue;
          const pl = [];
          for (const r of t.route || []) { const ll = await geo.locate(r.cc || 'CZ', r.name, r.zip || '', false); if (ll) pl.push({ side: r.side === 'L' ? 'L' : 'U', name: r.name, ll }); }
          if (pl.length) m[k] = (m[k] || []).concat(pl);
        }
        tripCtx = m;
      } catch (e) { console.error('Polohy (přepravy):', e.message); }
    };
    const tick = async () => { try { await refreshTrips(); } catch {} try { await trkPersist(store); if (trkLoaded) await getCars(); await trkPersist(store); } catch {} };
    setTimeout(tick, 20000); setInterval(tick, everyMin * 60000).unref();
    // teploty: každých GPS_TEMP_MIN minut (výchozí 15, 0 = vypnuto) pro auta v profilech, kde je teplota zapnutá
    const tMin = process.env.GPS_TEMP_MIN === undefined ? 15 : +process.env.GPS_TEMP_MIN;
    if (process.env.GPS_PROBE) setTimeout(async () => { try { const c = await getCars(); const xs = (c.data || []).filter(v => v.id && v.speed > 20 && Date.now() - new Date(v.time) < 15 * 60e3).slice(0, 2); for (const x of xs) for (const t of String(process.env.GPS_PROBE).split(',')) await require('./teplota').probe(x, t.trim()); } catch (e) { console.error('Probe:', e.message); } }, 45000);
    if (tMin > 0) {
      const tt = async () => {
        try {
          const st = store(); if (!st || !st.mem.gps) return;
          const wt = new Set(), wf = new Set();
          for (const p of Object.values(st.mem.gps)) if (p) {
            const lf = (p.label && p.label.on !== false && p.label.f) || [];
            for (const x of p.spz || []) { const k = String(x).toLowerCase(); if ((p.temp && p.temp.on) || lf.includes('temp')) wt.add(k); if (lf.includes('fuel')) wf.add(k); }
          }
          for (const w of watchList()) wt.add(String(w.spz).toLowerCase());
          if (!wt.size && !wf.size) return;
          const c = await getCars(); if (!c.data) return;
          await require('./teplota').refresh(c.data.filter(x => wt.has(x.spz.toLowerCase()) || wf.has(x.spz.toLowerCase())).map(x => ({ id: x.id, spz: x.spz, _k: [wt.has(x.spz.toLowerCase()) ? 'temp' : '', wf.has(x.spz.toLowerCase()) ? 'fuel' : ''].filter(Boolean) })));
        } catch (e) { console.error('Teplota:', e.message); }
      };
      setTimeout(tt, 60000); setInterval(tt, tMin * 60000).unref();
    }
  }
  app.use(['/api/polohy', '/api/polohy/trasa', '/api/polohy/historie'], apiCors);
  app.get('/api/polohy/trasa', async (req, res) => {
    if (!okApi(req)) return res.status(401).json({ error: 'Nepřihlášeno.' });
    res.set('Cache-Control', 'no-store');
    try { const c = await getCars(); const r = await require('./trasa').build(req.query.spz, req.query.p, c.data); res.status(r.status).json(r.body); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  try { require('./historie').setup(app, okApi); } catch (e) { console.error('Historie:', e.message); }
  app.get('/api/polohy', async (req, res) => {
    const one = okApi(req) ? '' : oneSpz(req);
    if (!okApi(req) && !one) return res.status(401).json({ error: 'Nepřihlášeno.' });
    res.set('Cache-Control', 'no-store');
    const c = await getCars();
    if (!c.data) return res.status(502).json({ error: status.error, status });
    if (one) return res.json({ tempWatch: [], cars: c.data.filter(x => normSpz(x.spz) === normSpz(one)), fetchedAt: new Date(c.at).toISOString(), stale: !status.ok, error: status.ok ? '' : status.error });
    const T = require('./teplota').get();
    res.json({ tempWatch: watchList(), cars: c.data.map(x => T[x.spz] ? { ...x, ...(T[x.spz].temp ? { temp: T[x.spz].temp } : {}), ...(T[x.spz].fuel ? { fuel: T[x.spz].fuel } : {}) } : x), fetchedAt: new Date(c.at).toISOString(), stale: !status.ok, error: status.ok ? '' : status.error });
  });
}

module.exports = { gpsGoOne, _internal: { track, setTrips: m => { tripCtx = m; } }, getCars, session, setup, gpsGo, ssoUrl, ssoValid, parseMapData, parseTable, parseCzDate };
