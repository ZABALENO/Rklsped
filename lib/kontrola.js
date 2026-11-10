// Počet zkontrolovaných objednávek z tabulky „Kontrola zásilek RKL“ (list Kontrola: Zásilka | Stav | Komentář).
// Tabulka se načítá jako CSV (sdílení „kdokoli s odkazem“); denní stavy se ukládají, aby šly spočítat přírůstky.
const ID = '1tSYrEc8q3Hu6EWLIFNXvPMNt0srJgVZAuzhq_d96lFo', GID = '1836563687';
const { pragueToday } = require('./workdays');

function parseCsv(t) {
  const rows = []; let r = [], c = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { r.push(c); c = ''; }
    else if (ch === '\n') { r.push(c); rows.push(r); r = []; c = ''; }
    else if (ch !== '\r') c += ch;
  }
  if (c !== '' || r.length) { r.push(c); rows.push(r); }
  return rows;
}

async function refresh(store) {
  const cur = store.mem.cfg.kont || {};
  try {
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=${GID}`, { redirect: 'follow', signal: AbortSignal.timeout(25000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rows = parseCsv(await res.text());
    const hd = (rows[0] || []).map(x => String(x).trim().toLowerCase());
    const iZ = Math.max(0, hd.findIndex(x => x.startsWith('zasilk') || x.startsWith('zásilk'))), iS = hd.findIndex(x => x === 'stav');
    const data = rows.slice(1).filter(r => String(r[iZ] || '').trim());
    const by = {}; for (const r of data) { const s = (iS >= 0 ? String(r[iS] || '').trim() : '') || '(bez stavu)'; by[s] = (by[s] || 0) + 1; }
    const n = data.length, today = pragueToday(), days = Object.assign({}, cur.days || {});
    days[today] = n;
    for (const k of Object.keys(days).sort().slice(0, -60)) delete days[k];
    const changed = cur.n !== n || JSON.stringify(cur.by) !== JSON.stringify(by);
    await store.put('cfg', 'kont', { n, by, days, at: changed || !cur.at ? new Date().toISOString() : cur.at, fetchedAt: new Date().toISOString(), error: null, first: cur.first || today });
  } catch (e) {
    try { await store.put('cfg', 'kont', Object.assign({}, cur, { error: e.message, fetchedAt: new Date().toISOString() })); } catch (e2) {}
  }
}

// přírůstek za den = stav na konci dne − stav na konci předchozího zaznamenaného dne (první zaznamenaný den: 0)
function view(k) {
  if (!k) return null;
  const ds = Object.keys(k.days || {}).sort(), today = pragueToday(), inc = {};
  ds.forEach((d, i) => { inc[d] = i ? k.days[d] - k.days[ds[i - 1]] : 0; });
  return { n: k.n, by: k.by, at: k.at, fetchedAt: k.fetchedAt, error: k.error || null, first: k.first || ds[0] || null, today: inc[today] || 0, days: ds.slice(-14).map(d => ({ date: d, n: k.days[d], inc: inc[d] })) };
}
module.exports = { refresh, view, parseCsv };
