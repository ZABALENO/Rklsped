// Obousměrná synchronizace pinů a poznámek s listem Google Tabulky (účet služby Google, bez závislostí).
// Env: GOOGLE_SERVICE_ACCOUNT_JSON = obsah JSON klíče účtu služby; tabulka musí být sdílená s jeho e-mailem jako Editor.
const crypto = require('crypto');
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
let cached = null;

function creds() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null;
  try { const j = JSON.parse(raw); if (j.client_email && j.private_key) return j; } catch {}
  return null;
}
const enabled = () => !!creds();

async function token() {
  if (cached && cached.exp > Date.now() + 60000) return cached.t;
  const c = creds(); if (!c) throw new Error('Chybí GOOGLE_SERVICE_ACCOUNT_JSON');
  const b = x => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b({ alg: 'RS256', typ: 'JWT' }), claim = b({ iss: c.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(c.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + head + '.' + claim + '.' + sig });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Google přihlášení selhalo: ' + (j.error_description || j.error || r.status));
  cached = { t: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.t;
}

async function api(method, url, body) {
  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + url, { method, headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Google Sheets: ' + ((j.error && j.error.message) || r.status));
  return j;
}
const rng = (tab, a) => encodeURIComponent("'" + tab + "'!" + a);
async function read(id, tab) { const j = await api('GET', `${id}/values/${rng(tab, 'A1:F5000')}`); return j.values || []; }
async function write(id, tab, rows) {
  await api('POST', `${id}/values/${rng(tab, 'A1:F5000')}:clear`, {});
  await api('PUT', `${id}/values/${rng(tab, 'A1')}?valueInputOption=RAW`, { values: rows });
}
const idFromUrl = u => ((String(u || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/) || [])[1]) || '';

module.exports = { enabled, read, write, idFromUrl, email: () => (creds() || {}).client_email || '' };
