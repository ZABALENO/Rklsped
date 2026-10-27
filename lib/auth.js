// Jednoduché přihlášení heslem. Heslo se nastavuje v proměnné prostředí APP_PASSWORD
// (na Renderu v Environment) – v kódu ani v repozitáři není.
const crypto = require('crypto');

const COOKIE = 'rkl_auth';
const MAX_AGE_DAYS = 180;

const password = () => process.env.APP_PASSWORD || '';
const token = () => crypto.createHmac('sha256', password() + '|' + (process.env.SESSION_SECRET || 'rkl'))
  .update('rklspedice-ok').digest('hex');

/* ---- přihlášení e-mailem s jednorázovým kódem (jen adresy @rkl.cz) ----
   Zapne se, když je nastaven poskytovatel e-mailů: BREVO_API_KEY nebo RESEND_API_KEY + MAIL_FROM.
   Bez nich zůstává přihlášení heslem (APP_PASSWORD). */
const DOMAIN = () => (process.env.ALLOWED_DOMAIN || 'rkl.cz').toLowerCase();
const mailMode = () => !!(process.env.MAIL_FROM && (process.env.BREVO_API_KEY || process.env.RESEND_API_KEY || process.env.DEV_MAIL_LOG === '1'));
const secret = () => process.env.SESSION_SECRET || 'rkl';
const sign = v => crypto.createHmac('sha256', secret() + '|mail').update(v).digest('hex');
const emailOk = e => typeof e === 'string' && e.length <= 120 && new RegExp('^[a-z0-9._%+\\-]+@' + DOMAIN().replace(/\./g, '\\.') + '$').test(e);
const mailToken = (email, days) => {
  const body = email + '|' + (Date.now() + days * 864e5);
  return Buffer.from(body).toString('base64url') + '.' + sign(body);
};
function mailTokenEmail(tok) {
  const [b, sig] = String(tok || '').split('.');
  if (!b || !sig) return null;
  let body; try { body = Buffer.from(b, 'base64url').toString('utf8'); } catch { return null; }
  const [email, exp] = body.split('|');
  if (!safeEq(sig, sign(body)) || !(+exp > Date.now()) || !emailOk(email)) return null;
  return email;
}

async function sendMail(to, code) {
  const from = process.env.MAIL_FROM, name = process.env.MAIL_NAME || 'RKL dashboardy';
  const subject = 'Přihlašovací kód: ' + code;
  const text = `Tvůj přihlašovací kód je ${code}\n\nPlatí 10 minut. Pokud ses nepokoušel/a přihlásit, tento e-mail ignoruj.`;
  const html = `<p>Tvůj přihlašovací kód:</p><p style="font:700 28px monospace;letter-spacing:4px">${code}</p><p style="color:#667">Platí 10 minut. Pokud ses nepokoušel/a přihlásit, tento e-mail ignoruj.</p>`;
  if (process.env.DEV_MAIL_LOG === '1') { console.log('[DEV mail]', to, code); return; }
  let r;
  if (process.env.BREVO_API_KEY) {
    r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sender: { email: from, name }, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
      signal: AbortSignal.timeout(15000),
    });
  } else {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${name} <${from}>`, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(15000),
    });
  }
  if (!r.ok) throw new Error('mail HTTP ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200));
}
const codes = new Map();            // email -> {h, exp, tries}
const reqLog = new Map();           // klíč (ip / e-mail) -> časy žádostí
function limited(key, max) {
  const now = Date.now(), t = (reqLog.get(key) || []).filter(x => now - x < 10 * 60 * 1000);
  t.push(now); reqLog.set(key, t);
  return t.length > max;
}

function readCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// rkldoprava si z rklspedice čte nabídku přeprav (/api/board) serverem; ověřuje se tokenem odvozeným ze sdílené DATABASE_URL
const internalToken = () => (process.env.RKL_INTERNAL_KEY || process.env.DATABASE_URL)
  ? crypto.createHmac('sha256', process.env.RKL_INTERNAL_KEY || process.env.DATABASE_URL).update('rkl-internal-board-v1').digest('hex') : null;
const internalOk = req => { const t = internalToken(), h = req.headers['x-rkl-internal']; return !!t && typeof h === 'string' && safeEq(h, t); };

// ---- samostatné přihlášení na relaci Vnitro 1 (heslo z VNITRO1_PASSWORD, vlastní cookie, vlastní data) ----
const V1_COOKIE = 'rkl_v1';
const v1Password = () => process.env.VNITRO1_PASSWORD || '';
const v1Token = () => crypto.createHmac('sha256', v1Password() + '|' + (process.env.SESSION_SECRET || 'rkl')).update('rklspedice-vnitro1-ok').digest('hex');
const isV1 = req => !!v1Password() && safeEq(readCookie(req, V1_COOKIE) || '', v1Token());

const isAuthed = req => mailMode()
  ? !!mailTokenEmail(readCookie(req, COOKIE))
  : (!password() || safeEq(readCookie(req, COOKIE) || '', token()));

// ochrana proti zkoušení hesel: max 10 pokusů / 10 min z jedné IP
const tries = new Map();
function tooMany(ip) {
  const now = Date.now();
  const t = (tries.get(ip) || []).filter(x => now - x < 10 * 60 * 1000);
  tries.set(ip, t);
  return t.length >= 10;
}

const loginHtml = (title, subtitle, mail) => `<!doctype html><html lang="cs"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} – přihlášení</title><link rel="icon" type="image/png" href="/favicon.png">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1d388f;font:15px/1.45 "IBM Plex Sans",system-ui,sans-serif;color:#0f1b2d;padding:16px}
body::before{content:"";position:fixed;inset:-16px;background:url(/bg.jpg) center/cover no-repeat;filter:blur(1.5px);z-index:-2}
body::after{content:"";position:fixed;inset:0;background:linear-gradient(160deg,rgba(21,42,110,.35),rgba(21,42,110,.72));z-index:-1}
form{background:#fff;border-radius:14px;padding:28px 26px;width:100%;max-width:360px;box-shadow:0 20px 50px rgba(0,0,0,.35)}
.b{display:flex;align-items:center;gap:10px;font-weight:700;font-size:19px;margin-bottom:18px}.b small{display:block;font-weight:400;font-size:12.5px;color:#5d6b80}
label{display:block;font-size:13px;font-weight:600;color:#5d6b80;margin-bottom:6px}
input{width:100%;font:inherit;padding:11px 12px;border:1px solid #dbe1ea;border-radius:9px;background:#f8fafc}
input:focus{outline:2px solid #9cc0ee;border-color:#6d9fdc;background:#fff}
button{margin-top:14px;width:100%;font:inherit;font-weight:600;padding:11px;border:0;border-radius:9px;background:#1d388f;color:#fff;cursor:pointer}
button:hover{background:#152a6e}.e{color:#b42318;font-size:13.5px;margin-top:10px;min-height:1em}
</style></head><body>
${mail ? `<form id="f"><div class="b"><img src="/logo.jpg" alt="RKL" width="46" height="46" style="border-radius:9px;display:block"><div>${title}<small>${subtitle}</small></div></div>
<div id="s1"><label for="m">Firemní e-mail (@rkl.cz)</label><input id="m" type="email" autocomplete="email" autofocus required placeholder="jmeno@rkl.cz">
<button>Poslat kód</button></div>
<div id="s2" hidden><label for="c">Kód z e-mailu</label><input id="c" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="123456" style="letter-spacing:4px;font-size:20px;text-align:center">
<button>Přihlásit</button><button type="button" id="back" style="background:#eef2f9;color:#1d388f;margin-top:8px">Jiný e-mail</button></div>
<div class="e" id="e"></div></form>
<script>
const $ = id => document.getElementById(id); let step = 1;
const post = (u, b) => fetch(u, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(async r => ({ok:r.ok, j: await r.json().catch(()=>({}))}));
$('back').onclick = () => { step = 1; $('s1').hidden = false; $('s2').hidden = true; $('e').textContent = ''; $('m').focus(); };
$('f').onsubmit = async e => {
  e.preventDefault(); $('e').textContent = '';
  if (step === 1) {
    const r = await post('/api/login/request', {email: $('m').value});
    if (!r.ok) { $('e').textContent = r.j.error || 'Nepodařilo se odeslat kód.'; return; }
    step = 2; $('s1').hidden = true; $('s2').hidden = false; $('c').focus();
    $('e').style.color = '#5d6b80'; $('e').textContent = 'Pokud je adresa povolená, poslali jsme na ni kód (platí 10 minut).';
  } else {
    $('e').style.color = '#b42318';
    const r = await post('/api/login/verify', {email: $('m').value, code: $('c').value});
    if (r.ok) location.href = '/'; else { $('e').textContent = r.j.error || 'Nesprávný kód.'; $('c').select(); }
  }
};
</script>` : `<form id="f"><div class="b"><img src="/logo.jpg" alt="RKL" width="46" height="46" style="border-radius:9px;display:block"><div>${title}<small>${subtitle}</small></div></div>
<label for="p">Heslo</label><input id="p" type="password" autocomplete="current-password" autofocus required>
<button>Přihlásit</button><div class="e" id="e"></div></form>
<script>
document.getElementById('f').onsubmit = async e => {
  e.preventDefault();
  const r = await fetch('/api/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});
  if (r.ok) location.href = '/';
  else { const j = await r.json().catch(()=>({})); document.getElementById('e').textContent = j.error || 'Nesprávné heslo.'; document.getElementById('p').select(); }
};
</script>`}
<div class="v1l"><button type="button" id="v1b">Přihlásit se na relaci Vnitro 1</button></div>
<div class="v1o" id="v1o" hidden><form id="v1f"><div class="b"><img src="/logo.jpg" alt="RKL" width="46" height="46" style="border-radius:9px;display:block"><div>Relace Vnitro 1<small>Přepravy v prodeji – ZV/</small></div></div>
<label for="v1p">Heslo</label><input id="v1p" type="password" autocomplete="current-password" required>
<button>Přihlásit</button><button type="button" id="v1x" style="background:#eef2f9;color:#1d388f;margin-top:8px">Zpět</button><div class="e" id="v1e"></div></form></div>
<style>.v1l{position:fixed;left:0;right:0;bottom:22px;text-align:center}.v1l button{width:auto;margin:0;padding:8px 16px;background:rgba(255,255,255,.14);color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:20px;font-size:14px}.v1l button:hover{background:rgba(255,255,255,.26)}
.v1o{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(15,27,70,.6);padding:16px}.v1o[hidden]{display:none}</style>
<script>
(function(){var g=function(i){return document.getElementById(i)};
g('v1b').onclick=function(){g('v1o').hidden=false;g('v1p').focus()};
g('v1x').onclick=function(){g('v1o').hidden=true;g('v1e').textContent=''};
g('v1f').onsubmit=async function(e){e.preventDefault();
 var r=await fetch('/api/login/vnitro1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:g('v1p').value})});
 if(r.ok)location.href='/';else{var j=await r.json().catch(function(){return{}});g('v1e').textContent=j.error||'Nesprávné heslo.';g('v1p').select()}};})();
</script></body></html>`;

function setup(app, { title = 'RKL Spedice', subtitle = 'Přepravy v prodeji' } = {}) {
  const LOGIN_HTML = loginHtml(title, subtitle, mailMode());
  app.set('trust proxy', 1);

  app.get('/login', (req, res) => {
    if ((isAuthed(req) && (password() || mailMode())) || isV1(req)) return res.redirect('/');
    res.type('html').send(LOGIN_HTML);
  });

  // 1) žádost o kód – odpověď je vždy stejná, aby se nedalo zjišťovat, které adresy existují
  app.post('/api/login/request', async (req, res) => {
    if (!mailMode()) return res.status(404).json({ error: 'Přihlášení e-mailem není zapnuté.' });
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!emailOk(email)) return res.status(400).json({ error: 'Povolené jsou jen e-maily ve tvaru jmeno@' + DOMAIN() + '.' });
    if (limited('ip:' + (req.ip || 'x'), 10) || limited('m:' + email, 4)) return res.status(429).json({ error: 'Příliš mnoho pokusů, zkus to za pár minut.' });
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    codes.set(email, { h: sign('code|' + email + '|' + code), exp: Date.now() + 10 * 60 * 1000, tries: 0 });
    try { await sendMail(email, code); }
    catch (e) { console.error('Odeslání kódu selhalo:', e.message); codes.delete(email); return res.status(502).json({ error: 'Kód se nepodařilo odeslat, zkus to znovu.' }); }
    res.json({ ok: true });
  });

  // 2) ověření kódu -> cookie
  app.post('/api/login/verify', (req, res) => {
    if (!mailMode()) return res.status(404).json({ error: 'Přihlášení e-mailem není zapnuté.' });
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const code = String((req.body && req.body.code) || '').replace(/\s/g, '');
    if (limited('v:' + (req.ip || 'x'), 20)) return res.status(429).json({ error: 'Příliš mnoho pokusů, zkus to za pár minut.' });
    const c = codes.get(email);
    if (!emailOk(email) || !c || c.exp < Date.now() || c.tries >= 5) {
      codes.delete(email);
      return res.status(401).json({ error: 'Kód vypršel nebo byl vyčerpán počet pokusů – pošli si nový.' });
    }
    c.tries++;
    if (!/^\d{6}$/.test(code) || !safeEq(sign('code|' + email + '|' + code), c.h)) return res.status(401).json({ error: 'Nesprávný kód.' });
    codes.delete(email);
    res.clearCookie(V1_COOKIE, { path: '/' });
    res.cookie(COOKIE, mailToken(email, MAX_AGE_DAYS), { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: MAX_AGE_DAYS * 864e5 });
    res.json({ ok: true });
  });

  app.post('/api/login', (req, res) => {
    if (mailMode()) return res.status(404).json({ error: 'Použij přihlášení e-mailem.' });
    const ip = req.ip || 'x';
    if (tooMany(ip)) return res.status(429).json({ error: 'Příliš mnoho pokusů, zkus to za pár minut.' });
    const pw = String((req.body && req.body.password) || '');
    if (!password() || !safeEq(pw, password())) {
      tries.get(ip).push(Date.now());
      return res.status(401).json({ error: 'Nesprávné heslo.' });
    }
    tries.delete(ip);
    res.clearCookie(V1_COOKIE, { path: '/' });
    res.cookie(COOKIE, token(), {
      httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/',
      maxAge: MAX_AGE_DAYS * 864e5,
    });
    res.json({ ok: true });
  });

  // přihlášení na relaci Vnitro 1 (vlastní heslo; odhlásí hlavní přihlášení, aby se data nepletla)
  app.post('/api/login/vnitro1', (req, res) => {
    if (!v1Password()) return res.status(404).json({ error: 'Přihlášení na relaci Vnitro 1 není zapnuté.' });
    const ip = 'v1:' + (req.ip || 'x');
    if (tooMany(ip)) return res.status(429).json({ error: 'Příliš mnoho pokusů, zkus to za pár minut.' });
    const pw = String((req.body && req.body.password) || '');
    if (!safeEq(pw, v1Password())) { tries.get(ip).push(Date.now()); return res.status(401).json({ error: 'Nesprávné heslo.' }); }
    tries.delete(ip);
    res.clearCookie(COOKIE, { path: '/' });
    res.cookie(V1_COOKIE, v1Token(), { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: MAX_AGE_DAYS * 864e5 });
    res.json({ ok: true });
  });

  app.get('/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.clearCookie(V1_COOKIE, { path: '/' }); res.redirect('/login'); });

  // vše ostatní jen po přihlášení
  app.use((req, res, next) => {
    req.tenantId = isV1(req) ? 'vnitro1' : 'main';   // která instance dat (hlavní / Vnitro 1) se obsluhuje
    if (req.method === 'GET' && req.path === '/api/board' && internalOk(req)) return next();
    if (req.path === '/healthz' || ['/bg.jpg', '/logo.jpg', '/favicon.png'].includes(req.path) || isAuthed(req) || isV1(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Nepřihlášen' });
    return res.redirect('/login');
  });
}

module.exports = { setup, internalToken };
