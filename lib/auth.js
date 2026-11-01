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
// ---- samostatné přihlášení na relaci Vnitro 2 (heslo z VNITRO2_PASSWORD) ----
const V2_COOKIE = 'rkl_v2';
const v2Password = () => process.env.VNITRO2_PASSWORD || '';
const v2Token = () => crypto.createHmac('sha256', v2Password() + '|' + (process.env.SESSION_SECRET || 'rkl')).update('rklspedice-vnitro2-ok').digest('hex');
const isV2 = req => !!v2Password() && safeEq(readCookie(req, V2_COOKIE) || '', v2Token());

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
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#1d388f;font:15px/1.45 "IBM Plex Sans",system-ui,sans-serif;color:#e9edf7;padding:16px;overflow-x:hidden}
body::before{content:"";position:fixed;inset:-16px;background:url(/bg.jpg) center/cover no-repeat;filter:grayscale(1) contrast(1.35) brightness(.3) blur(1px);z-index:-4}
.hl{position:fixed;inset:-16px;z-index:-4;pointer-events:none;background:url(/bg.jpg) center/cover no-repeat;filter:grayscale(1) contrast(3.2) brightness(.85) blur(1.3px);mix-blend-mode:screen;opacity:.22}
body::after{content:"";position:fixed;inset:0;z-index:-3;background:radial-gradient(900px 500px at 15% -10%,rgba(94,138,255,.35),transparent 60%),radial-gradient(700px 500px at 90% 110%,rgba(242,165,22,.18),transparent 60%),linear-gradient(160deg,rgba(0,3,20,.9),rgba(4,14,56,.86))}
.grid-bg{position:fixed;inset:0;z-index:-2;pointer-events:none;background-image:linear-gradient(rgba(94,138,255,.14) 1px,transparent 1px),linear-gradient(90deg,rgba(94,138,255,.14) 1px,transparent 1px),repeating-linear-gradient(0deg,rgba(255,255,255,.04) 0 1px,transparent 1px 3px);background-size:48px 48px,48px 48px,auto;-webkit-mask-image:radial-gradient(ellipse at 50% 50%,#000 25%,transparent 80%);mask-image:radial-gradient(ellipse at 50% 50%,#000 25%,transparent 80%)}
.road{position:fixed;inset:0;pointer-events:none;z-index:-1;overflow:hidden}
.veh{position:absolute;left:0;color:#fff;opacity:.13;will-change:transform;animation-timing-function:linear;animation-iteration-count:infinite}
.veh svg{display:block;width:100%;height:auto}.veh.r{animation-name:driveR}.veh.l{animation-name:driveL}
@keyframes driveR{from{transform:translateX(-30vw)}to{transform:translateX(112vw)}}
@keyframes driveL{from{transform:translateX(112vw) scaleX(-1)}to{transform:translateX(-30vw) scaleX(-1)}}
@media (prefers-reduced-motion:reduce){.veh{animation:none}}
html::after{content:"";position:fixed;inset:0;z-index:100;pointer-events:none;background:radial-gradient(900px 500px at 15% -10%,rgba(94,138,255,.4),transparent 60%),linear-gradient(160deg,#00030f,#04123f);clip-path:circle(150vmax at 50% 50%);animation:arrR .7s .05s cubic-bezier(.65,0,.25,1) forwards}
@keyframes arrR{to{clip-path:circle(0 at 50% 50%)}}
.pickh,.tabs,form{animation:arrIn .7s .2s cubic-bezier(.2,.8,.2,1) both}
@keyframes arrIn{from{opacity:0;transform:translateY(14px) scale(.98);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}
@media (prefers-reduced-motion:reduce){html::after{display:none}.pickh,.tabs,form{animation:none}}
form{position:relative;width:100%;max-width:380px;background:linear-gradient(155deg,rgba(14,22,52,.9),rgba(4,8,22,.92));-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border:1px solid rgba(94,138,255,.5);padding:28px 26px;clip-path:polygon(22px 0,100% 0,100% calc(100% - 22px),calc(100% - 22px) 100%,0 100%,0 22px);box-shadow:0 0 50px rgba(94,138,255,.25)}
form::before{content:"";position:absolute;left:0;top:0;width:74px;height:2px;background:#5e8aff;box-shadow:0 0 12px #5e8aff}
.b{display:flex;align-items:center;gap:12px;font-weight:700;font-size:18px;letter-spacing:2px;text-transform:uppercase;margin-bottom:18px;color:#fff}.b small{display:block;font-weight:400;font-size:11.5px;letter-spacing:1px;text-transform:none;color:#8793ad}
.b img{box-shadow:0 0 0 1px rgba(94,138,255,.5),0 0 16px rgba(94,138,255,.35)}
label{display:block;font-size:11.5px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#8793ad;margin-bottom:6px}
input{width:100%;font:inherit;padding:11px 12px;border:1px solid rgba(94,138,255,.5);border-radius:0;background:#000;color:#fff}
input:focus{outline:0;box-shadow:0 0 12px rgba(94,138,255,.6)}
button{margin-top:14px;width:100%;font:inherit;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:11px;border:1px solid #5e8aff;border-radius:0;background:#1d388f;color:#fff;cursor:pointer}
button:hover{background:#2747b8}.e{color:#ff6b5e;font-size:13.5px;margin-top:10px;min-height:1em}
</style></head><body>
<div class="hl"></div><div class="grid-bg"></div>
<div class="road" aria-hidden="true">
<div class="veh r" style="top:78%;width:330px;animation-duration:24s;animation-delay:-4s"><svg viewBox="0 0 240 70" fill="currentColor"><rect x="0" y="6" width="156" height="46" rx="3"/><path d="M162 18h42l22 20v18h-64z"/><rect x="170" y="23" width="26" height="13" rx="2" fill="#050b24"/><circle cx="34" cy="58" r="10"/><circle cx="62" cy="58" r="10"/><circle cx="124" cy="58" r="10"/><circle cx="196" cy="58" r="10"/></svg></div>
<div class="veh l" style="top:66%;width:170px;animation-duration:19s;animation-delay:-1s"><svg viewBox="0 0 130 64" fill="currentColor"><path d="M4 12h66l-1 0h18l24 22v22H4z"/><rect x="92" y="22" width="18" height="11" rx="2" fill="#050b24"/><circle cx="30" cy="54" r="9"/><circle cx="96" cy="54" r="9"/></svg></div>
<div class="veh r" style="top:52%;width:250px;animation-duration:21s;animation-delay:-12s"><svg viewBox="0 0 190 70" fill="currentColor"><rect x="0" y="8" width="118" height="44" rx="3"/><path d="M124 22h34l22 18v16h-56z"/><rect x="132" y="27" width="20" height="11" rx="2" fill="#050b24"/><circle cx="28" cy="58" r="10"/><circle cx="92" cy="58" r="10"/><circle cx="154" cy="58" r="10"/></svg></div>
<div class="veh l" style="top:40%;width:300px;animation-duration:28s;animation-delay:-9s"><svg viewBox="0 0 240 70" fill="currentColor"><rect x="0" y="6" width="156" height="46" rx="3"/><path d="M162 18h42l22 20v18h-64z"/><rect x="170" y="23" width="26" height="13" rx="2" fill="#050b24"/><circle cx="34" cy="58" r="10"/><circle cx="62" cy="58" r="10"/><circle cx="124" cy="58" r="10"/><circle cx="196" cy="58" r="10"/></svg></div>
<div class="veh r" style="top:28%;width:150px;animation-duration:17s;animation-delay:-8s"><svg viewBox="0 0 130 64" fill="currentColor"><path d="M4 12h66l-1 0h18l24 22v22H4z"/><rect x="92" y="22" width="18" height="11" rx="2" fill="#050b24"/><circle cx="30" cy="54" r="9"/><circle cx="96" cy="54" r="9"/></svg></div>
<div class="veh l" style="top:14%;width:230px;animation-duration:23s;animation-delay:-3s"><svg viewBox="0 0 190 70" fill="currentColor"><rect x="0" y="8" width="118" height="44" rx="3"/><path d="M124 22h34l22 18v16h-56z"/><rect x="132" y="27" width="20" height="11" rx="2" fill="#050b24"/><circle cx="28" cy="58" r="10"/><circle cx="92" cy="58" r="10"/><circle cx="154" cy="58" r="10"/></svg></div>
</div>
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
${(v1Password() || v2Password()) ? `<div class="pickh" id="pickh"><h1>Vyber relaci</h1><p>Klikni na dlaždici a přihlas se</p></div><div class="tabs" id="tabs"><button type="button" data-t="z" class="tile"><span class="hud"><span>01</span><i>relace</i></span><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg></span><span class="tt">Západ 1</span><span class="td">Přepravy v prodeji – Západ 1</span><span class="go">Vybrat</span></button>${v1Password() ? '<button type="button" data-t="v" class="tile"><span class="hud"><span>02</span><i>relace</i></span><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg></span><span class="tt">Vnitro 1</span><span class="td">Přepravy – ZV/</span><span class="go">Vybrat</span></button>' : ''}${v2Password() ? '<button type="button" data-t="w" class="tile"><span class="hud"><span>03</span><i>relace</i></span><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 3v4M21 5h-4"/></svg></span><span class="tt">Vnitro 2</span><span class="td">Přepravy – Vnitro 2</span><span class="go">Vybrat</span></button>' : ''}</div>
${v1Password() ? `<form id="v1f" hidden><div class="b"><img src="/logo.jpg" alt="RKL" width="46" height="46" style="border-radius:9px;display:block"><div>Relace Vnitro 1<small>Přepravy – ZV/</small></div></div>
<label for="v1p">Heslo</label><input id="v1p" type="password" autocomplete="current-password" required>
<button>Přihlásit</button><div class="e" id="v1e"></div></form>` : ''}
${v2Password() ? `<form id="v2f" hidden><div class="b"><img src="/logo.jpg" alt="RKL" width="46" height="46" style="border-radius:9px;display:block"><div>Relace Vnitro 2<small>Přepravy – Vnitro 2</small></div></div>
<label for="v2p">Heslo</label><input id="v2p" type="password" autocomplete="current-password" required>
<button>Přihlásit</button><div class="e" id="v2e"></div></form>` : ''}
<style>.pickh{text-align:center;margin:0 0 22px}.pickh h1{margin:0 0 6px;font-size:clamp(24px,5vw,38px);font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#fff;text-shadow:0 0 30px rgba(94,138,255,.55)}.pickh p{margin:0;color:#8793ad;font-size:13px;letter-spacing:2px;text-transform:uppercase}
.tabs{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:22px;width:100%;max-width:1040px}
.tabs button.tile{--c:#5e8aff;position:relative;display:flex;flex-direction:column;align-items:stretch;gap:10px;text-align:left;width:auto;margin:0;min-height:230px;padding:26px 26px 22px;font:inherit;letter-spacing:0;text-transform:none;color:#e9edf7;background:linear-gradient(155deg,rgba(14,22,52,.88),rgba(4,8,22,.9));-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border:1px solid color-mix(in srgb,var(--c) 55%,transparent);border-radius:0;clip-path:polygon(26px 0,100% 0,100% calc(100% - 26px),calc(100% - 26px) 100%,0 100%,0 26px);box-shadow:0 0 44px -8px var(--c);transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease;overflow:hidden;cursor:pointer}
.tabs button.tile:nth-child(2){--c:#3ddc97}.tabs button.tile:nth-child(3){--c:#f2a516}
.tabs button.tile::before{content:"";position:absolute;left:0;top:0;width:84px;height:2px;background:var(--c);box-shadow:0 0 14px var(--c)}
.tabs button.tile::after{content:"";position:absolute;right:0;bottom:0;width:60px;height:2px;background:var(--c);box-shadow:0 0 14px var(--c);opacity:.7}
.tabs button.tile:hover,.tabs button.tile:focus-visible{transform:translateY(-5px);border-color:var(--c);box-shadow:0 0 70px -6px var(--c);background:linear-gradient(155deg,rgba(20,32,72,.92),rgba(6,12,30,.94));outline:none}
.tile .hud{display:flex;align-items:center;justify-content:space-between;font:500 11px "IBM Plex Mono",ui-monospace,monospace;letter-spacing:2px;color:#8793ad;text-transform:uppercase}
.tile .hud i{display:inline-flex;align-items:center;gap:7px;font-style:normal;color:var(--c)}.tile .hud i::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--c);box-shadow:0 0 10px var(--c);animation:blink 2.4s ease-in-out infinite}
@keyframes blink{50%{opacity:.35}}
.tile .ic{width:58px;height:58px;display:grid;place-items:center;margin-top:6px;color:var(--c);background:radial-gradient(circle at 30% 25%,color-mix(in srgb,var(--c) 28%,transparent),transparent 70%);border:1px solid var(--c);box-shadow:0 0 22px -2px var(--c),inset 0 0 16px -6px var(--c);clip-path:polygon(12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%,0 12px)}
.tile .ic svg{width:32px;height:32px;filter:drop-shadow(0 0 6px var(--c))}
.tile .tt{margin-top:8px;font-size:25px;font-weight:700;letter-spacing:4px;text-transform:uppercase;text-shadow:0 0 18px color-mix(in srgb,var(--c) 70%,transparent)}
.tile .td{color:#9aa6c2;font-size:14px}
.tile .go{margin-top:auto;font:600 12px "IBM Plex Mono",ui-monospace,monospace;color:var(--c);letter-spacing:3px;text-transform:uppercase}.tile .go::after{content:" ▸"}
.tabs[hidden],.pickh[hidden]{display:none}
.backl{display:inline-block;margin:0 0 14px;background:none;border:0;padding:0;width:auto;color:#8793ad;font:600 11.5px "IBM Plex Mono",ui-monospace,monospace;letter-spacing:2px;text-transform:uppercase;cursor:pointer}.backl:hover{background:none;color:#fff}
form[hidden]{display:none}
@media (max-width:600px){.tabs{grid-template-columns:1fr;gap:16px}.tabs button.tile{min-height:0}}
@media (prefers-reduced-motion:reduce){.tile .hud i::before{animation:none}}</style>
<script>
(function(){var g=function(i){return document.getElementById(i)};
var forms={z:g('f'),v:g('v1f'),w:g('v2f')};
function open(t){if(!forms[t])return;g('tabs').hidden=true;g('pickh').hidden=true;
 for(var k in forms){if(forms[k])forms[k].hidden=k!==t}
 var i=t==='v'?g('v1p'):t==='w'?g('v2p'):(g('m')||g('p'));if(i)i.focus()}
function pick(){g('tabs').hidden=false;g('pickh').hidden=false;for(var k in forms){if(forms[k])forms[k].hidden=true}}
for(var k in forms){if(forms[k]){var b=document.createElement('button');b.type='button';b.className='backl';b.textContent='\u2190 Zp\u011bt na v\u00fdb\u011br';b.onclick=pick;forms[k].insertBefore(b,forms[k].firstChild)}}
[].forEach.call(document.querySelectorAll('#tabs button'),function(b){b.onclick=function(){open(b.dataset.t)}});
pick();
function login(path,pid,eid){return async function(e){e.preventDefault();
 var r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:g(pid).value})});
 if(r.ok)location.href='/';else{var j=await r.json().catch(function(){return{}});g(eid).textContent=j.error||'Nesprávné heslo.';g(pid).select()}}}
if(g('v1f'))g('v1f').onsubmit=login('/api/login/vnitro1','v1p','v1e');
if(g('v2f'))g('v2f').onsubmit=login('/api/login/vnitro2','v2p','v2e');})();
</script>` : ''}
</body></html>`;

function setup(app, { title = 'RKL Spedice', subtitle = 'Přepravy v prodeji' } = {}) {
  const LOGIN_HTML = loginHtml(title, subtitle, mailMode());
  app.set('trust proxy', 1);

  app.get('/login', (req, res) => {
    if ((isAuthed(req) && (password() || mailMode())) || isV1(req) || isV2(req)) return res.redirect('/');
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
    res.clearCookie(V1_COOKIE, { path: '/' }); res.clearCookie(V2_COOKIE, { path: '/' });
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
    res.clearCookie(V1_COOKIE, { path: '/' }); res.clearCookie(V2_COOKIE, { path: '/' });
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
    res.clearCookie(COOKIE, { path: '/' }); res.clearCookie(V2_COOKIE, { path: '/' });
    res.cookie(V1_COOKIE, v1Token(), { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: MAX_AGE_DAYS * 864e5 });
    res.json({ ok: true });
  });

  app.post('/api/login/vnitro2', (req, res) => {
    if (!v2Password()) return res.status(404).json({ error: 'Přihlášení na relaci Vnitro 2 není zapnuté.' });
    const ip = 'v2:' + (req.ip || 'x');
    if (tooMany(ip)) return res.status(429).json({ error: 'Příliš mnoho pokusů, zkus to za pár minut.' });
    const pw = String((req.body && req.body.password) || '');
    if (!safeEq(pw, v2Password())) { tries.get(ip).push(Date.now()); return res.status(401).json({ error: 'Nesprávné heslo.' }); }
    tries.delete(ip);
    res.clearCookie(COOKIE, { path: '/' }); res.clearCookie(V1_COOKIE, { path: '/' });
    res.cookie(V2_COOKIE, v2Token(), { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: MAX_AGE_DAYS * 864e5 });
    res.json({ ok: true });
  });

  app.get('/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.clearCookie(V1_COOKIE, { path: '/' }); res.clearCookie(V2_COOKIE, { path: '/' }); res.redirect('/login'); });

  // vše ostatní jen po přihlášení
  app.use((req, res, next) => {
    req.tenantId = isV2(req) ? 'vnitro2' : isV1(req) ? 'vnitro1' : 'main';   // která instance dat (hlavní / Vnitro 1) se obsluhuje
    if (req.method === 'GET' && req.path === '/api/board' && internalOk(req)) return next();
    if (req.path === '/healthz' || ['/bg.jpg', '/logo.jpg', '/favicon.png'].includes(req.path) || isAuthed(req) || isV1(req) || isV2(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Nepřihlášen' });
    return res.redirect('/login');
  });
}

module.exports = { setup, internalToken };
