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

const normName = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
// admin = sloupec H v listu řidičů (ve skriptu); starší cookie bez příznaku: jen Soukeník
const isPriceUser = d => !!d && (d.admin === undefined ? normName(d.prijmeni) === 'soukenik' : d.admin === true);
const withFlags = d => ({ ...d, ceny: isPriceUser(d), owner: d.owner === true });
const cs = (req, payload, t) => callScript(req.driver && req.driver.owner === true ? { ...payload, owner: true } : payload, t);

async function callScript(payload, timeoutMs) {
  // nové spojení pro každý požadavek (Connection: close) a jeden opakovaný pokus při síťové chybě
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeoutMs || 25000);
    try {
      const r = await fetch(url(), {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8', Connection: 'close' }, redirect: 'follow',
        body: JSON.stringify({ token: tok(), ...payload }), signal: ctrl.signal
      });
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (e.name === 'AbortError') break;        // po vypršení času už neopakovat (zápis mohl proběhnout)
      await new Promise(r => setTimeout(r, 600));
    } finally { clearTimeout(t); }
  }
  throw lastErr;
}

const SPZ_LIST = ['3TB 0282', '2TC 3005', '1TH 3501', '5M8 7601'];   // vozidla k výběru pro řidiče bez přiřazené SPZ
const smenyOf = (arr, n) => { const a = Array.isArray(arr) ? arr : []; const o = []; for (let i = 0; i < n; i++) o.push(a[i] === 'N' ? 'N' : 'D'); return o; };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const recent = new Map();                      // requestId -> čas (ochrana proti dvojímu odeslání)

function setup(app) {
  const api = '/api/ridic';
  const needCfg = (req, res, next) => (url() && tok()) ? next() : res.status(503).json({ ok: false, error: 'not_configured' });
  const needJson = (req, res, next) => req.is('application/json') ? next() : res.status(415).json({ ok: false, error: 'bad_content_type' });
  const needAuth = (req, res, next) => { const d = readSession(req); if (!d) return res.status(401).json({ ok: false, error: 'not_logged_in' }); req.driver = d; next(); };
  const noStore = (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); };

  // sdílené soubory dostupné i bez přihlášení do dashboardu (pozadí, logo, TV přehrávač po 3× kliku na logo)
  for (const f of ['bg.jpg', 'logo.jpg', 'favicon.png', 'iptv.js']) app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', f)));

  app.get('/ridic/login-noc.jpg', (req, res) => { res.setHeader('Cache-Control', 'public, max-age=86400'); res.sendFile(path.join(__dirname, '..', 'ridic', 'login-noc.jpg')); });
  app.get('/ridic/dekuji4.jpg', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, '..', 'ridic', 'dekuji4.jpg')); });
  app.get('/ridic/dekuji3.jpg', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, '..', 'ridic', 'dekuji3.jpg')); });
  app.get('/ridic/dekuji2.jpg', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, '..', 'ridic', 'dekuji2.jpg')); });
  app.get('/ridic/dekuji.jpg', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, '..', 'ridic', 'dekuji.jpg')); });
  app.get('/ridic/scan.js', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, '..', 'ridic', 'scan.js')); });

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
    // skryté přihlášení majitele (heslo jen v proměnné prostředí RIDIC_OWNER_PASS, ne v kódu)
    const ownPass = process.env.RIDIC_OWNER_PASS || '';
    if (ownPass && normName(prijmeni) === 'balcar') {
      const A = Buffer.from(crypto.createHash('sha256').update(pin).digest('hex')), B = Buffer.from(crypto.createHash('sha256').update(ownPass).digest('hex'));
      if (!crypto.timingSafeEqual(A, B)) { noteFail(ip); return res.status(401).json({ ok: false, error: 'bad_credentials' }); }
      const me = { jmeno: 'Robin', prijmeni: 'Balcar', dopravce: 'RKL Opava', spz: '', typ: '', admin: true, owner: true };
      setCookie(req, res, makeSession(me), SESSION_HOURS * 3600);
      return res.json({ ok: true, driver: withFlags(me) });
    }
    try {
      const r = await callScript({ action: 'login', prijmeni, pin });
      if (!r.ok) {
        if (r.error === 'bad_credentials') { noteFail(ip); return res.status(401).json({ ok: false, error: 'bad_credentials' }); }
        return res.status(502).json({ ok: false, error: 'sheet_error' });
      }
      setCookie(req, res, makeSession(r.driver), SESSION_HOURS * 3600);
      res.json({ ok: true, driver: withFlags(r.driver) });
    } catch (e) { console.error('ridic login:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });

  app.post(api + '/logout', noStore, (req, res) => { setCookie(req, res, '', 0); res.json({ ok: true }); });
  app.get(api + '/me', noStore, needAuth, (req, res) => res.json({ ok: true, driver: withFlags(req.driver) }));

  const dayCount = new Map();
  app.post(api + '/zaznam', noStore, needCfg, needAuth, needJson, async (req, res) => {
    const b = req.body || {};
    const mistoN = String(b.mistoNakladky || '').trim(), mistoV = String(b.mistoVykladky || '').trim(), zakaznik = String(b.zakaznik || '').trim(), druh = String(b.druh || '').trim();
    const num = v => Number(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.'));
    const jizd = num(b.jizd);
    const poznamka = String(b.poznamka || '').trim();
    const bad = [];
    b.datumVykladky = b.datumNakladky;   // jedno datum = datum směny
    for (const k of ['datumNakladky', 'datumVykladky']) if (!DATE_RE.test(String(b[k] || ''))) bad.push(k);
    if (!mistoN || mistoN.length > 100) bad.push('mistoNakladky');
    if (!mistoV || mistoV.length > 100) bad.push('mistoVykladky');
    if (!zakaznik || zakaznik.length > 120) bad.push('zakaznik');
    if (!druh || druh.length > 80) bad.push('druh');
    if (poznamka.length > 300) bad.push('poznamka');
    if (!Number.isInteger(jizd) || jizd < 1 || jizd > 10) bad.push('jizd');
    // tuny jsou nepovinné: pole o délce = počet jízd, prázdné = neznámo
    let tuny = [];
    if (!bad.includes('jizd')) {
      const arr = Array.isArray(b.tuny) ? b.tuny : [];
      if (arr.length > jizd) bad.push('tuny');
      for (let i = 0; i < jizd; i++) {
        const raw = arr[i] == null ? '' : String(arr[i]).trim();
        if (raw === '') { tuny.push(null); continue; }
        const t = num(raw);
        if (!Number.isFinite(t) || t <= 0 || t > 100) bad.push('tuny'); else tuny.push(t);
      }
    }
    let spz = '';
    const own = String(req.driver.dopravce || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim() === 'rkl opava';
    if (own || !String(req.driver.spz || '').trim()) {   // řidiči RKL Opava si SPZ volí ze seznamu
      spz = String(b.spz || '').trim().toUpperCase().replace(/\s+/g, ' ');
      if (!SPZ_LIST.includes(spz)) bad.push('spz');
    }
    if (!bad.length && String(b.datumVykladky) < String(b.datumNakladky)) bad.push('vykladkaPredNakladkou');
    if (bad.length) return res.status(400).json({ ok: false, error: 'validation', fields: bad });

    const rid = String(b.requestId || '').slice(0, 64);
    if (rid && recent.has(rid)) return res.json({ ok: true, duplicate: true });
    try {
      const r = await callScript({
        action: 'append', jmeno: req.driver.jmeno, prijmeni: req.driver.prijmeni,
        datumNakladky: b.datumNakladky, datumVykladky: b.datumVykladky,
        mistoNakladky: mistoN, mistoVykladky: mistoV, zakaznik, druh, jizd, tuny, smeny: smenyOf(b.smeny, jizd), spz, poznamka
      });
      if (!r.ok) {
        if (r.error === 'driver_inactive') { setCookie(req, res, '', 0); return res.status(401).json({ ok: false, error: 'not_logged_in' }); }
        return res.status(502).json({ ok: false, error: 'sheet_error' });
      }
      if (rid) { recent.set(rid, Date.now()); if (recent.size > 500) recent.delete(recent.keys().next().value); }
      // počet záznamů zadaných dnes (pražský den) – podle něj se vybírá poděkovací fotka
      const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' }).format(new Date());
      const ck = day + '|' + req.driver.jmeno + '|' + req.driver.prijmeni;
      for (const k of dayCount.keys()) if (!k.startsWith(day)) dayCount.delete(k);
      dayCount.set(ck, (dayCount.get(ck) || 0) + 1);
      res.json({ ok: true, id: r.id || '', dnes: dayCount.get(ck) });
    } catch (e) { console.error('ridic zaznam:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });

  // příloha (PDF ze skeneru v telefonu) k vlastnímu záznamu: uloží se na Google Disk a odkaz do tabulky
  const bigJson = require('express').json({ limit: '14mb' });
  app.post(api + '/doklad', noStore, needCfg, needAuth, bigJson, async (req, res) => {
    const b = req.body || {};
    const id = String(b.id || '').slice(0, 64), pdf = String(b.pdf || '');
    if (!/^[0-9a-f-]{8,64}$/i.test(id) || !/^[A-Za-z0-9+/=]+$/.test(pdf) || pdf.length < 200 || pdf.length > 13 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'validation' });
    if (Buffer.from(pdf.slice(0, 8), 'base64').toString('latin1').slice(0, 4) !== '%PDF') return res.status(400).json({ ok: false, error: 'validation' });
    try {
      const r = await callScript({ action: 'doc', jmeno: req.driver.jmeno, prijmeni: req.driver.prijmeni, id, pdf, pages: Math.max(1, Math.min(40, Number(b.pages) || 1)) }, 90000);
      if (!r.ok) {
        if (r.error === 'driver_inactive') { setCookie(req, res, '', 0); return res.status(401).json({ ok: false, error: 'not_logged_in' }); }
        if (r.error === 'not_found') return res.status(404).json({ ok: false, error: 'not_found' });
        return res.status(502).json({ ok: false, error: 'sheet_error' });
      }
      res.json({ ok: true });
    } catch (e) { console.error('ridic doklad:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });

  // seznam zákazníků z listu „Zákazníci“ (cache 60 s)
  let custCache = { t: 0, list: null };
  app.get(api + '/zakaznici', noStore, needCfg, needAuth, async (req, res) => {
    if (custCache.list && Date.now() - custCache.t < 60000) return res.json({ ok: true, customers: custCache.list });
    try {
      const r = await callScript({ action: 'customers' });
      if (!r.ok || !Array.isArray(r.customers)) return res.status(502).json({ ok: false, error: 'sheet_error' });
      custCache = { t: Date.now(), list: r.customers };
      res.json({ ok: true, customers: r.customers });
    } catch (e) { console.error('ridic zakaznici:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });

  // správa adminů (ikonka peněz): jen majitel (skryté přihlášení)
  const needOwner = (req, res, next) => req.driver && req.driver.owner === true ? next() : res.status(403).json({ ok: false, error: 'forbidden' });
  app.get(api + '/admini', noStore, needCfg, needAuth, needOwner, async (req, res) => {
    try {
      const r = await cs(req, { action: 'adminList' }, 40000);
      if (!r.ok) return res.status(r.error === 'forbidden' ? 403 : 502).json({ ok: false, error: r.error || 'sheet_error' });
      res.json({ ok: true, rows: r.rows || [], dny: r.dny || [] });
    } catch (e) { console.error('ridic admini:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });
  app.post(api + '/admini', noStore, needCfg, needAuth, needOwner, needJson, async (req, res) => {
    const b = req.body || {}, jmeno = String(b.jmeno || '').slice(0, 60), prijmeni = String(b.prijmeni || '').slice(0, 60);
    if (!prijmeni) return res.status(400).json({ ok: false, error: 'bad_request' });
    try {
      const r = await cs(req, { action: 'adminSet', jmeno, prijmeni, admin: b.admin === true }, 40000);
      if (!r.ok) return res.status(r.error === 'not_found' ? 404 : r.error === 'forbidden' ? 403 : 502).json({ ok: false, error: r.error || 'sheet_error' });
      res.json({ ok: true });
    } catch (e) { console.error('ridic admini set:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });

  // ceny k tunám: pouze přihlášený Soukeník (kontrola i v Apps Scriptu)
  const needPrice = (req, res, next) => isPriceUser(req.driver) ? next() : res.status(403).json({ ok: false, error: 'forbidden' });
  // tlačítko GPS v aplikaci řidičů – jen pro adminy (stejné oprávnění jako 💵); přesměruje na /polohy bez dalšího hesla
  app.get(api + '/gps-go', noStore, needAuth, needPrice, require('./polohy').gpsGo);
  app.get(api + '/ceny', noStore, needCfg, needAuth, needPrice, async (req, res) => {
    try {
      const r = await cs(req, { action: 'ceny', jmeno: req.driver.jmeno, prijmeni: req.driver.prijmeni }, 40000);
      if (!r.ok) return res.status(r.error === 'forbidden' ? 403 : 502).json({ ok: false, error: r.error === 'forbidden' ? 'forbidden' : 'sheet_error' });
      res.json({ ok: true, rows: r.rows || [] });
    } catch (e) { console.error('ridic ceny:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });
  app.post(api + '/ceny', noStore, needCfg, needAuth, needPrice, needJson, async (req, res) => {
    const b = req.body || {}, id = String(b.id || '');
    if (!/^[0-9a-f-]{8,64}$/i.test(id) || !Array.isArray(b.ceny) || b.ceny.length > 10) return res.status(400).json({ ok: false, error: 'bad_request' });
    const ceny = [];
    for (const v of b.ceny) {
      const t = String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.');
      if (t === '') { ceny.push(''); continue; }
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0 || n > 1e7) return res.status(400).json({ ok: false, error: 'bad_price' });
      ceny.push(Math.round(n * 100) / 100);
    }
    try {
      const r = await cs(req, { action: 'cenySet', jmeno: req.driver.jmeno, prijmeni: req.driver.prijmeni, id, ceny });
      if (!r.ok) return res.status(r.error === 'not_found' ? 404 : r.error === 'forbidden' ? 403 : 502).json({ ok: false, error: r.error || 'sheet_error' });
      res.json({ ok: true });
    } catch (e) { console.error('ridic ceny set:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });

  // úpravy buněk a přidání řádků (jen majitel)
  app.post(api + '/bunka', noStore, needCfg, needAuth, needPrice, needJson, async (req, res) => {
    const b = req.body || {};
    const row = parseInt(b.row, 10), col = parseInt(b.col, 10);
    if (typeof b.sheet !== 'string' || b.sheet.length > 60 || !(row >= 2 && row <= 100000) || !(col >= 1 && col <= 80) || typeof b.value !== 'string' || b.value.length > 500 || typeof (b.old ?? '') !== 'string') return res.status(400).json({ ok: false, error: 'bad_request' });
    try {
      const r = await cs(req, { action: 'bunka', jmeno: req.driver.jmeno, prijmeni: req.driver.prijmeni, sheet: b.sheet, row, col, value: b.value, old: b.old ?? '' }, 40000);
      if (!r.ok) return res.status(r.error === 'conflict' ? 409 : r.error === 'readonly' || r.error === 'bad_request' ? 400 : r.error === 'forbidden' ? 403 : 502).json({ ok: false, error: r.error || 'sheet_error' });
      res.json({ ok: true, value: r.value });
    } catch (e) { console.error('ridic bunka:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });
  app.post(api + '/zprac', noStore, needCfg, needAuth, needPrice, needJson, async (req, res) => {
    const b = req.body || {}, id = String(b.id || '');
    if (!/^[0-9a-f-]{8,64}$/i.test(id) || typeof b.done !== 'boolean') return res.status(400).json({ ok: false, error: 'bad_request' });
    try {
      const r = await cs(req, { action: 'zprac', jmeno: req.driver.jmeno, prijmeni: req.driver.prijmeni, id, done: b.done }, 40000);
      if (!r.ok) return res.status(r.error === 'forbidden' ? 403 : r.error === 'bad_request' ? 400 : 502).json({ ok: false, error: r.error || 'sheet_error' });
      res.json({ ok: true, done: r.done });
    } catch (e) { console.error('ridic zprac:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });
  // úprava příloh (jen admin): počet stránek, smazání celé přílohy nebo vybraných stránek
  const loadDocPdf = async (req, id, n) => {
    const r = await cs(req, { action: 'docGet', jmeno: req.driver.jmeno, prijmeni: req.driver.prijmeni, id, n }, 60000);
    if (!r.ok || !r.pdf) return null;
    const buf = Buffer.from(r.pdf, 'base64');
    return buf.slice(0, 4).toString() === '%PDF' ? buf : null;
  };
  app.get(api + '/doklad-info/:id', noStore, needCfg, needAuth, needPrice, async (req, res) => {
    const id = String(req.params.id || ''), n = Math.max(0, Math.min(19, parseInt(req.query.n, 10) || 0));
    if (!/^[0-9a-f-]{8,64}$/i.test(id)) return res.status(400).json({ ok: false, error: 'bad_request' });
    try {
      const buf = await loadDocPdf(req, id, n);
      if (!buf) return res.status(404).json({ ok: false, error: 'not_found' });
      const { PDFDocument } = require('pdf-lib');
      const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
      res.json({ ok: true, pages: pdf.getPageCount() });
    } catch (e) { console.error('ridic doklad-info:', e.message); res.status(502).json({ ok: false, error: 'sheet_error' }); }
  });
  app.post(api + '/doklad-smaz', noStore, needCfg, needAuth, needPrice, needJson, async (req, res) => {
    const b = req.body || {}, id = String(b.id || ''), n = parseInt(b.n, 10);
    const strany = Array.isArray(b.strany) ? b.strany.map(Number) : null;
    if (!/^[0-9a-f-]{8,64}$/i.test(id) || !(n >= 0 && n <= 19) || (strany && (strany.length > 200 || strany.some(x => !Number.isInteger(x) || x < 1 || x > 500)))) return res.status(400).json({ ok: false, error: 'bad_request' });
    const fail = (r) => res.status(r.error === 'not_found' ? 404 : r.error === 'forbidden' ? 403 : 502).json({ ok: false, error: r.error || 'sheet_error' });
    try {
      const who = { jmeno: req.driver.jmeno, prijmeni: req.driver.prijmeni };
      let remove = true;
      if (strany && strany.length) {
        const buf = await loadDocPdf(req, id, n);
        if (!buf) return res.status(404).json({ ok: false, error: 'not_found' });
        const { PDFDocument } = require('pdf-lib');
        const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
        const cnt = pdf.getPageCount(), set = [...new Set(strany)];
        if (set.some(x => x > cnt)) return res.status(400).json({ ok: false, error: 'bad_request' });
        if (set.length < cnt) {
          set.sort((x, y) => y - x).forEach(x => pdf.removePage(x - 1));
          const out = Buffer.from(await pdf.save()).toString('base64');
          if (out.length > 13 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'too_big' });
          const r = await cs(req, { action: 'docRepl', ...who, id, n, pdf: out }, 90000);
          if (!r.ok) return fail(r);
          return res.json({ ok: true, docs: r.docs, pages: cnt - set.length });
        }
      }
      const r = await cs(req, { action: 'docDel', ...who, id, n }, 60000);
      if (!r.ok) return fail(r);
      res.json({ ok: true, docs: r.docs, pages: 0 });
    } catch (e) { console.error('ridic doklad-smaz:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });

  app.post(api + '/skup', noStore, needCfg, needAuth, needPrice, needJson, async (req, res) => {
    const b = req.body || {}, row = parseInt(b.row, 10);
    if (!(row >= 2 && row <= 100000) || (b.pole !== 'cena' && b.pole !== 'smena') || typeof b.value !== 'string' || b.value.length > 40 || typeof (b.old ?? '') !== 'string') return res.status(400).json({ ok: false, error: 'bad_request' });
    try {
      const r = await cs(req, { action: 'skup', jmeno: req.driver.jmeno, prijmeni: req.driver.prijmeni, row, pole: b.pole, value: b.value, old: b.old ?? '' }, 40000);
      if (!r.ok) return res.status(r.error === 'conflict' ? 409 : r.error === 'bad_value' || r.error === 'bad_request' || r.error === 'not_found' ? 400 : r.error === 'forbidden' ? 403 : 502).json({ ok: false, error: r.error || 'sheet_error' });
      res.json({ ok: true, value: r.value });
    } catch (e) { console.error('ridic skup:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });
  app.post(api + '/radek', noStore, needCfg, needAuth, needPrice, needJson, async (req, res) => {
    const b = req.body || {};
    if (typeof b.sheet !== 'string' || !b.vals || typeof b.vals !== 'object') return res.status(400).json({ ok: false, error: 'bad_request' });
    const vals = {};
    for (const [k, v] of Object.entries(b.vals)) { if (!/^\d{1,2}$/.test(k) || typeof v !== 'string' || v.length > 200) return res.status(400).json({ ok: false, error: 'bad_request' }); vals[k] = v; }
    try {
      const r = await cs(req, { action: 'radek', jmeno: req.driver.jmeno, prijmeni: req.driver.prijmeni, sheet: b.sheet, vals }, 40000);
      if (!r.ok) return res.status(r.error === 'duplicate' ? 409 : r.error === 'missing' || r.error === 'bad_request' ? 400 : r.error === 'forbidden' ? 403 : 502).json({ ok: false, error: r.error || 'sheet_error' });
      res.json({ ok: true });
    } catch (e) { console.error('ridic radek:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });

  // všechna data ze všech listů tabulky (jen admin)
  app.get(api + '/vse', noStore, needCfg, needAuth, needPrice, async (req, res) => {
    try {
      const r = await cs(req, { action: 'vse', jmeno: req.driver.jmeno, prijmeni: req.driver.prijmeni }, 60000);
      if (!r.ok) return res.status(r.error === 'forbidden' ? 403 : 502).json({ ok: false, error: r.error === 'forbidden' ? 'forbidden' : 'sheet_error' });
      res.json({ ok: true, sheets: r.sheets || [] });
    } catch (e) { console.error('ridic vse:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });

  app.get(api + '/doklad/:id', noStore, needCfg, needAuth, async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[0-9a-f-]{8,64}$/i.test(id)) return res.status(400).json({ ok: false, error: 'bad_request' });
    try {
      const r = await cs(req, { action: 'docGet', jmeno: req.driver.jmeno, prijmeni: req.driver.prijmeni, id, n: Math.max(0, Math.min(19, parseInt(req.query.n, 10) || 0)) }, 60000);
      if (!r.ok || !r.pdf) return res.status(r.error === 'forbidden' ? 403 : 404).type('text/plain').send('Příloha nenalezena.');
      const buf = Buffer.from(r.pdf, 'base64');
      if (buf.slice(0, 4).toString() !== '%PDF') return res.status(404).type('text/plain').send('Příloha nenalezena.');
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="priloha.pdf"', 'X-Content-Type-Options': 'nosniff' }).send(buf);
    } catch (e) { console.error('ridic doklad get:', e.message); res.status(502).type('text/plain').send('Přílohu se nepodařilo načíst.'); }
  });

  // město podle GPS telefonu (předvyplnění místa nakládky/vykládky); reverzní geokódování přes OpenStreetMap
  const geoLast = new Map();
  app.get(api + '/mesto', noStore, needAuth, async (req, res) => {
    const lat = Number(req.query.lat), lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return res.status(400).json({ ok: false, error: 'bad_request' });
    const key = String(req.driver.jmeno) + ' ' + String(req.driver.prijmeni), now = Date.now();
    if (now - (geoLast.get(key) || 0) < 3000) return res.status(429).json({ ok: false, error: 'rate' });
    geoLast.set(key, now); if (geoLast.size > 500) geoLast.clear();
    try {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 7000);
      const r = await fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&addressdetails=1&accept-language=cs&lat=' + lat.toFixed(5) + '&lon=' + lon.toFixed(5),
        { signal: ctl.signal, headers: { 'User-Agent': 'RKL-Opava-evidence-prepravy/1.0 (dopravni evidence rizicu)', 'Accept-Language': 'cs' } });
      clearTimeout(to);
      if (!r.ok) return res.status(502).json({ ok: false, error: 'geo_error' });
      const a = (await r.json()).address || {};
      const city = a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb || '';
      res.json({ ok: true, city: String(city).slice(0, 80) });
    } catch (e) { res.status(502).json({ ok: false, error: 'geo_unreachable' }); }
  });

  // PSČ podle názvu města (OpenStreetMap: vyhledání města -> adresa u středu -> PSČ); výsledky se pamatují
  const pscCache = new Map(), pscLast = new Map();
  const fmtPsc = (v) => { const m = /(\d{3})\s?(\d{2})(?!\d)/.exec(String(v || '')); return m ? m[1] + ' ' + m[2] : ''; };
  const nomi = async (path) => {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 7000);
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/' + path, { signal: ctl.signal, headers: { 'User-Agent': 'RKL-Opava-evidence-prepravy/1.0 (dopravni evidence rizicu)', 'Accept-Language': 'cs' } });
      if (!r.ok) throw new Error('nominatim ' + r.status);
      return await r.json();
    } finally { clearTimeout(to); }
  };
  app.get(api + '/psc', noStore, needAuth, async (req, res) => {
    const q = String(req.query.q || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (q.length < 2) return res.status(400).json({ ok: false, error: 'bad_request' });
    const ck = q.toLowerCase();
    if (pscCache.has(ck)) return res.json(Object.assign({ ok: true }, pscCache.get(ck)));
    const key = String(req.driver.jmeno) + ' ' + String(req.driver.prijmeni), now = Date.now();
    if (now - (pscLast.get(key) || 0) < 1500) return res.status(429).json({ ok: false, error: 'rate' });
    pscLast.set(key, now); if (pscLast.size > 500) pscLast.clear();
    try {
      const hits = await nomi('search?format=jsonv2&limit=6&addressdetails=1&countrycodes=cz&accept-language=cs&q=' + encodeURIComponent(q));
      const list = Array.isArray(hits) ? hits : [], h = list[0] || null;
      let psc = h ? fmtPsc(h.address && h.address.postcode) : '';
      if (!psc && h && h.lat && h.lon) {
        const rv = await nomi('reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=cs&lat=' + Number(h.lat).toFixed(5) + '&lon=' + Number(h.lon).toFixed(5));
        psc = fmtPsc(rv && rv.address && rv.address.postcode);
      }
      // další možná PSČ téhož názvu (velká města mají PSČ po částech) – řidič je může vybrat
      const alts = [...new Set(list.slice(0, 6).map(x => fmtPsc(x.address && x.address.postcode)).filter(x => x && x !== psc))].slice(0, 4);
      if (pscCache.size > 3000) pscCache.clear();
      const out = { psc, alts };
      pscCache.set(ck, out);
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { res.status(502).json({ ok: false, error: 'geo_unreachable' }); }
  });

  // historie přeprav přihlášeného řidiče (jen jeho záznamy)
  app.get(api + '/historie', noStore, needCfg, needAuth, async (req, res) => {
    try {
      const r = await callScript({ action: 'list', jmeno: req.driver.jmeno, prijmeni: req.driver.prijmeni });
      if (!r.ok) {
        if (r.error === 'driver_inactive') { setCookie(req, res, '', 0); return res.status(401).json({ ok: false, error: 'not_logged_in' }); }
        return res.status(502).json({ ok: false, error: 'sheet_error' });
      }
      res.json({ ok: true, rows: r.rows || [], editable: true });
    } catch (e) { console.error('ridic historie:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });

  // nápad / návrh na úpravu od řidiče -> list „Nápady od řidičů“
  const ideaLast = new Map();
  app.post(api + '/napad', noStore, needCfg, needAuth, needJson, async (req, res) => {
    const text = String((req.body || {}).text || '').trim();
    if (text.length < 3 || text.length > 1000) return res.status(400).json({ ok: false, error: 'bad_request' });
    const key = req.driver.jmeno + ' ' + req.driver.prijmeni, now = Date.now();
    if (now - (ideaLast.get(key) || 0) < 15000) return res.status(429).json({ ok: false, error: 'too_fast' });
    ideaLast.set(key, now);
    try {
      const r = await callScript({ action: 'napad', jmeno: req.driver.jmeno, prijmeni: req.driver.prijmeni, text });
      if (!r.ok) {
        if (r.error === 'driver_inactive') { setCookie(req, res, '', 0); return res.status(401).json({ ok: false, error: 'not_logged_in' }); }
        return res.status(502).json({ ok: false, error: 'sheet_error' });
      }
      res.json({ ok: true });
    } catch (e) { console.error('ridic napad:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });

  // smazání přepravy: řidič jen svou, uživatel s cenami (Soukeník) kteroukoli – kontroluje i Apps Script
  app.post(api + '/smazat', noStore, needCfg, needAuth, needJson, async (req, res) => {
    const id = String((req.body || {}).id || '').slice(0, 64);
    if (!/^[0-9a-f-]{8,64}$/i.test(id)) return res.status(400).json({ ok: false, error: 'bad_request' });
    try {
      const r = await cs(req, { action: 'delete', jmeno: req.driver.jmeno, prijmeni: req.driver.prijmeni, id });
      if (!r.ok) {
        if (r.error === 'driver_inactive') { setCookie(req, res, '', 0); return res.status(401).json({ ok: false, error: 'not_logged_in' }); }
        if (r.error === 'not_found') return res.status(404).json({ ok: false, error: 'not_found' });
        return res.status(502).json({ ok: false, error: 'sheet_error' });
      }
      res.json({ ok: true });
    } catch (e) { console.error('ridic smazat:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });

  // úprava jednoho vlastního záznamu (jedna jízda = jeden řádek)
  app.post(api + '/uprav', noStore, needCfg, needAuth, needJson, async (req, res) => {
    const b = req.body || {};
    const id = String(b.id || '').slice(0, 64);
    const mistoN = String(b.mistoNakladky || '').trim(), mistoV = String(b.mistoVykladky || '').trim(), zakaznik = String(b.zakaznik || '').trim(), druh = String(b.druh || '').trim();
    const num = v => Number(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.'));
    const poznamka = String(b.poznamka || '').trim();
    const bad = [];
    b.datumVykladky = b.datumNakladky;   // jedno datum = datum směny
    if (poznamka.length > 300) bad.push('poznamka');
    if (!/^[0-9a-f-]{8,64}$/i.test(id)) bad.push('id');
    for (const k of ['datumNakladky', 'datumVykladky']) if (!DATE_RE.test(String(b[k] || ''))) bad.push(k);
    if (!mistoN || mistoN.length > 100) bad.push('mistoNakladky');
    if (!mistoV || mistoV.length > 100) bad.push('mistoVykladky');
    if (!zakaznik || zakaznik.length > 120) bad.push('zakaznik');
    if (!druh || druh.length > 80) bad.push('druh');
    const arr = Array.isArray(b.tuny) ? b.tuny : [];
    const tuny = [];
    const jizd = Math.floor(num(b.jizd));
    if (!Number.isFinite(jizd) || jizd < 1 || jizd > 10) bad.push('jizd');
    if (arr.length > 10) bad.push('tuny');
    for (let i = 0; i < Math.min(arr.length, 10); i++) {
      const raw = arr[i] == null ? '' : String(arr[i]).trim();
      if (raw === '') { tuny.push(null); continue; }
      const t = num(raw);
      if (!Number.isFinite(t) || t <= 0 || t > 100) bad.push('tuny'); else tuny.push(t);
    }
    if (!bad.length && String(b.datumVykladky) < String(b.datumNakladky)) bad.push('vykladkaPredNakladkou');
    if (bad.length) return res.status(400).json({ ok: false, error: 'validation', fields: bad });
    while (tuny.length < jizd) tuny.push(null);
    tuny.length = jizd;
    try {
      const r = await callScript({
        action: 'update', jizd, jmeno: req.driver.jmeno, prijmeni: req.driver.prijmeni, id,
        datumNakladky: b.datumNakladky, datumVykladky: b.datumVykladky,
        mistoNakladky: mistoN, mistoVykladky: mistoV, zakaznik, druh, tuny, smeny: smenyOf(b.smeny, jizd), poznamka
      });
      if (!r.ok) {
        if (r.error === 'driver_inactive') { setCookie(req, res, '', 0); return res.status(401).json({ ok: false, error: 'not_logged_in' }); }
        if (r.error === 'not_found') return res.status(404).json({ ok: false, error: 'not_found' });
        return res.status(502).json({ ok: false, error: 'sheet_error' });
      }
      res.json({ ok: true });
    } catch (e) { console.error('ridic uprav:', e.message); res.status(502).json({ ok: false, error: 'sheet_unreachable' }); }
  });
}

module.exports = { setup };
