// Evidence přeprav od řidičů – mobilní formulář s přihlášením (příjmení + PIN z listu „Řidiči“),
// záznamy se zapisují do tabulky „Řepa - evidence přeprav od řidičů“ (list „Záznamy“) přes Google Apps Script.
// Nezávislé na heslech dashboardů; bez proměnných RIDIC_SCRIPT_URL a RIDIC_SCRIPT_TOKEN stránka jen hlásí, že není nastavená.
const crypto = require('crypto');
const path = require('path');

const SESSION_HOURS = 12;
const COOKIE = 'rkl_ridic';

const url = () => process.env.RIDIC_SCRIPT_URL || '';
const tok = () => process.env.RIDIC_SCRIPT_TOKEN || '';
const secret = () => (process.env.SESSION_SECRET || 'rkl') + '|' + tok() + '|ridic-v1';
const sign = p => crypto.createHmac('sha256', secret()).update(p).digest('base64url');

function makeSession(driver) {
  const p = Buffer.from(JSON.stringify({ d: driver, exp: Date.now() + SESSION_HOURS * 3600 * 1000 })).toString('base64url');
  return p + '.' + sign(p);
}
function readSession(req) {
  let raw = '';
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) raw = part.slice(i + 1).trim();
  }
  const [p, s] = raw.split('.');
  if (!p || !s) return null;
  const a = Buffer.from(s), b = Buffer.from(sign(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    return d.exp > Date.now() ? d.d : null;
  } catch { return null; }
}
function setCookie(req, res, value, maxAge) {
  const https = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (https ? '; Secure' : ''));
}

const fails = new Map();                       // ip -> {count, first}
const WINDOW = 15 * 60 * 1000, MAX = 8;
const blocked = ip => { const a = fails.get(ip); return !!a && Date.now() - a.first <= WINDOW && a.count >= MAX; };
const noteFail = ip => { const a = fails.get(ip), n = Date.now(); if (!a || n - a.first > WINDOW) fails.set(ip, { count: 1, first: n }); else a.count++; };
setInterval(() => { const n = Date.now(); for (const [k, a] of fails) if (n - a.first > WINDOW) fails.delete(k); }, 10 * 60 * 1000).unref();

async function callScript(payload) {
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(url(), {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
      body: JSON.stringify({ token: tok(), ...payload }), signal: ctrl.signal
    });
    return await r.json();
  } finally { clearTimeout(t); }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const recent = new Map();                      // requestId -> čas (ochrana proti dvojímu odeslání)

function setup(app) {
  const api = '/api/ridic';
  const needCfg = (req, res, next) => (url() && tok()) ? next() : res.status(503).json({ ok: false, error: 'not_configured' });
  const needJson = (req, res, next) => req.is('application/json') ? next() : res.status(415).json({ ok: false, error: 'bad_content_type' });
  const needAuth = (req, res, next) => { const d = readSession(req); if (!d) return res.status(401).json({ ok: false, error: 'not_logged_in' }); req.driver = d; next(); };
  const noStore = (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); };

  app.get('/ridic', (req, res) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, '..', 'ridic', 'index.html'));
  });

  app.post(api + '/login', noStore, needCfg, needJson, async (req, res) => {
    const ip = req.ip || 'x';
    if (blocked(ip)) return res.status(429).json({ ok: false, error: 'too_many_attempts' });
    const prijmeni = String((req.body && req.body.prijmeni) || '').slice(0, 60);
    const pin = String((req.body && req.body.pin) || '').slice(0, 30);
    try {
      const r = await callScript({ action: 'login', prijmeni, pin });
      if (!r.ok) {
        if (r.error === 'bad_credentials') { noteFail(ip); return res.status(401).json({ ok: false, error: 'bad_credentials' }); }
        return res.status(502).json({ ok: false, error: 'sheet_error' });
      }
      setCookie(req, res, makeSession(r.driver), SESSION_HOURS * 3600);
      res.json({ ok: true, driver: r.driver });
    } catch (e) { console.error('ridic login:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });

  app.post(api + '/logout', noStore, (req, res) => { setCookie(req, res, '', 0); res.json({ ok: true }); });
  app.get(api + '/me', noStore, needAuth, (req, res) => res.json({ ok: true, driver: req.driver }));

  app.post(api + '/zaznam', noStore, needCfg, needAuth, needJson, async (req, res) => {
    const b = req.body || {};
    const trasa = String(b.trasa || '').trim(), objednatel = String(b.objednatel || '').trim();
    const vaha = Number(String(b.vaha || '').replace(/\s/g, '').replace(',', '.'));
    const bad = [];
    for (const k of ['datumNakladky', 'datumVykladky']) if (!DATE_RE.test(String(b[k] || ''))) bad.push(k);
    for (const k of ['casNakladky', 'casVykladky']) if (!TIME_RE.test(String(b[k] || ''))) bad.push(k);
    if (!trasa || trasa.length > 200) bad.push('trasa');
    if (!objednatel || objednatel.length > 120) bad.push('objednatel');
    if (!Number.isFinite(vaha) || vaha <= 0 || vaha > 100000) bad.push('vaha');
    if (!bad.length && `${b.datumVykladky}T${b.casVykladky}` < `${b.datumNakladky}T${b.casNakladky}`) bad.push('vykladkaPredNakladkou');
    if (bad.length) return res.status(400).json({ ok: false, error: 'validation', fields: bad });

    const rid = String(b.requestId || '').slice(0, 64);
    if (rid && recent.has(rid)) return res.json({ ok: true, duplicate: true });
    try {
      const r = await callScript({
        action: 'append', jmeno: req.driver.jmeno, prijmeni: req.driver.prijmeni,
        datumNakladky: b.datumNakladky, casNakladky: b.casNakladky, datumVykladky: b.datumVykladky, casVykladky: b.casVykladky,
        trasa, objednatel, vaha
      });
      if (!r.ok) {
        if (r.error === 'driver_inactive') { setCookie(req, res, '', 0); return res.status(401).json({ ok: false, error: 'not_logged_in' }); }
        return res.status(502).json({ ok: false, error: 'sheet_error' });
      }
      if (rid) { recent.set(rid, Date.now()); if (recent.size > 500) recent.delete(recent.keys().next().value); }
      res.json({ ok: true });
    } catch (e) { console.error('ridic zaznam:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });
}

module.exports = { setup };
