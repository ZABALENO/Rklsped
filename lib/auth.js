// Jednoduché přihlášení heslem. Heslo se nastavuje v proměnné prostředí APP_PASSWORD
// (na Renderu v Environment) – v kódu ani v repozitáři není.
const crypto = require('crypto');

const COOKIE = 'rkl_auth';
const MAX_AGE_DAYS = 180;

const password = () => process.env.APP_PASSWORD || '';
const token = () => crypto.createHmac('sha256', password() + '|' + (process.env.SESSION_SECRET || 'rkl'))
  .update('rklspedice-ok').digest('hex');

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
const isAuthed = req => !password() || safeEq(readCookie(req, COOKIE) || '', token());

// ochrana proti zkoušení hesel: max 10 pokusů / 10 min z jedné IP
const tries = new Map();
function tooMany(ip) {
  const now = Date.now();
  const t = (tries.get(ip) || []).filter(x => now - x < 10 * 60 * 1000);
  tries.set(ip, t);
  return t.length >= 10;
}

const LOGIN_HTML = `<!doctype html><html lang="cs"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>RKL Spedice – přihlášení</title><link rel="icon" type="image/png" href="/favicon.png">
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
<form id="f"><div class="b"><img src="/logo.jpg" alt="RKL" width="46" height="46" style="border-radius:9px;display:block"><div>RKL Spedice<small>Přepravy v prodeji</small></div></div>
<label for="p">Heslo</label><input id="p" type="password" autocomplete="current-password" autofocus required>
<button>Přihlásit</button><div class="e" id="e"></div></form>
<script>
document.getElementById('f').onsubmit = async e => {
  e.preventDefault();
  const r = await fetch('/api/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});
  if (r.ok) location.href = '/';
  else { const j = await r.json().catch(()=>({})); document.getElementById('e').textContent = j.error || 'Nesprávné heslo.'; document.getElementById('p').select(); }
};
</script></body></html>`;

function setup(app) {
  app.set('trust proxy', 1);

  app.get('/login', (req, res) => {
    if (isAuthed(req) && password()) return res.redirect('/');
    res.type('html').send(LOGIN_HTML);
  });

  app.post('/api/login', (req, res) => {
    const ip = req.ip || 'x';
    if (tooMany(ip)) return res.status(429).json({ error: 'Příliš mnoho pokusů, zkus to za pár minut.' });
    const pw = String((req.body && req.body.password) || '');
    if (!password() || !safeEq(pw, password())) {
      tries.get(ip).push(Date.now());
      return res.status(401).json({ error: 'Nesprávné heslo.' });
    }
    tries.delete(ip);
    res.cookie(COOKIE, token(), {
      httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/',
      maxAge: MAX_AGE_DAYS * 864e5,
    });
    res.json({ ok: true });
  });

  app.get('/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.redirect('/login'); });

  // vše ostatní jen po přihlášení
  app.use((req, res, next) => {
    if (req.path === '/healthz' || ['/bg.jpg', '/logo.jpg', '/favicon.png'].includes(req.path) || isAuthed(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Nepřihlášen' });
    return res.redirect('/login');
  });
}

module.exports = { setup };
