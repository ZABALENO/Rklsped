// Ukládání pinů, poznámek a „hotovo“ relace Stavba do listu Google Tabulky přes Apps Script (webová aplikace v tabulce).
// Env: STAVBA_DB_URL = adresa nasazené webové aplikace, STAVBA_DB_SECRET = stejné heslo jako v skriptu (gscript/stavba-databaze.gs).
const url = () => (process.env.STAVBA_DB_URL || '').trim();
const secret = () => process.env.STAVBA_DB_SECRET || '';
const enabled = () => !!url() && !!secret();
async function read() {
  const r = await fetch(url() + (url().includes('?') ? '&' : '?') + 't=' + encodeURIComponent(secret()), { redirect: 'follow' });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) throw new Error('Apps Script: ' + ((j && j.error) || r.status));
  return j.rows || [];
}
async function write(rows) {
  const w = Math.max(5, ...rows.map(r => r.length)), pad = rows.map(r => Array.from({ length: w }, (_, i) => (r[i] == null ? '' : String(r[i]))));
  const r = await fetch(url(), { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ t: secret(), rows: pad }) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) throw new Error('Apps Script: ' + ((j && j.error) || r.status));
}
module.exports = { enabled, read, write };
