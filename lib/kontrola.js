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
    const daysBy = Object.assign({}, cur.daysBy || {}); daysBy[today] = by;
    for (const k of Object.keys(daysBy).sort().slice(0, -60)) delete daysBy[k];
    for (const k of Object.keys(days).sort().slice(0, -60)) delete days[k];
    // jednotlivé zásilky: den, kdy se v listu poprvé objevily, a jejich poslední známý stav (přežije i smazání řádků)
    const seen = Object.assign({}, cur.seen || {}), kd = JSON.parse(JSON.stringify(cur.kd || {}));
    const legacy = Object.keys(cur.days || {}).filter(d => d < today).sort().pop();   // zásilky, které už zná starší (snímkový) způsob počítání
    const firstRun = !cur.seen;
    const dayMap = kd[today] || {};
    for (const r of data) {
      const key = String(r[iZ] || '').trim(), st = (iS >= 0 ? String(r[iS] || '').trim() : '') || '(bez stavu)';
      if (!(key in seen)) { if (firstRun && legacy) { seen[key] = legacy; } else { seen[key] = today; dayMap[key] = st; } }
      else if (seen[key] === today) dayMap[key] = st;
    }
    kd[today] = dayMap;
    // vlastní trvalý log: každý unikátní řádek (Zásilka) ze zdroje se zapíše jednou, při změně stavu/komentáře se doplní, nikdy se nemaže
    const log = (cur.log || []).slice(), idx = {}; log.forEach((e, i) => { idx[e.k] = i; });
    const nowIso = new Date().toISOString();
    for (const r of data) {
      const k = String(r[iZ] || '').trim(), st = (iS >= 0 ? String(r[iS] || '').trim() : ''), c = String(r[iS >= 0 ? 2 : 1] || '').trim();
      if (!(k in idx)) { idx[k] = log.length; log.push({ k, st, c, t: nowIso, u: nowIso, d: today }); }
      else { const e = log[idx[k]]; if (e.st !== st || e.c !== c) { e.st = st; e.c = c; e.u = nowIso; } }
    }
    for (const k of Object.keys(kd).sort().slice(0, -60)) delete kd[k];
    const cutoff = Object.keys(kd).sort()[0] || today; for (const k of Object.keys(seen)) if (seen[k] < cutoff) delete seen[k];
    const changed = cur.n !== n || JSON.stringify(cur.by) !== JSON.stringify(by);
    await store.put('cfg', 'kont', { n, by, days, daysBy, kd, seen, log: log.slice(-20000), at: changed || !cur.at ? new Date().toISOString() : cur.at, fetchedAt: new Date().toISOString(), error: null, first: cur.first || today });
  } catch (e) {
    console.error('Kontrola zásilek – načtení selhalo:', e.message);
    try { await store.put('cfg', 'kont', Object.assign({}, cur, { error: e.message, fetchedAt: new Date().toISOString() })); } catch (e2) {}
  }
}

// přírůstek za den = stav na konci dne − stav na konci předchozího zaznamenaného dne; první zaznamenaný den = celý tehdejší stav (platí pro ten den)
// ručně doplněné stavy (kontroly, jejichž řádky už byly ze zdroje smazány): den -> počet zkontrolovaných, přičítá se k zachyceným zásilkám
const BASE = { '2026-11-11': 36 };
function view(k) {
  if (!k) return null;
  const cls = n => /ruč|ruc/i.test(n) ? 'man' : /^ok|v pořádku|schvál/i.test(n) ? 'ok' : 'oth', sum = (b, c) => Object.entries(b || {}).reduce((t, [n, v]) => t + (cls(n) === c ? v : 0), 0);
  const kd = k.kd || {}, today = pragueToday(), res = {};
  // dny sledované po zásilkách (nový způsob)
  for (const d of Object.keys(kd)) { const c = { ok: 0, man: 0, oth: 0 }; Object.values(kd[d]).forEach(st => { c[cls(st)]++; }); res[d] = c; }
  for (const d of Object.keys(BASE)) { res[d] = res[d] || { ok: 0, man: 0, oth: 0 }; res[d].ok += BASE[d]; }
  // starší dny, které znají jen snímky počtů (přírůstek proti předchozímu snímku; první den = celý stav)
  const ds = Object.keys(k.days || {}).sort(), inc = {};
  ds.forEach((d, i) => { inc[d] = i ? k.days[d] - k.days[ds[i - 1]] : k.days[d]; });
  ds.forEach((d, i) => { if (d in res && (kd[d] || BASE[d])) return;
    const a = k.daysBy && k.daysBy[d], b = i > 0 && k.daysBy && k.daysBy[ds[i - 1]];
    if (a && i === 0) res[d] = { ok: sum(a, 'ok'), man: sum(a, 'man'), oth: sum(a, 'oth') };
    else if (a && b) { const ok = Math.max(0, sum(a, 'ok') - sum(b, 'ok')), man = Math.max(0, sum(a, 'man') - sum(b, 'man')); res[d] = { ok, man, oth: Math.max(0, inc[d] - ok - man) }; }
    else res[d] = { ok: 0, man: 0, oth: Math.max(0, inc[d]) }; });
  const all = Object.keys(res).sort(), tot = { ok: 0, man: 0, oth: 0 }; all.forEach(d => { tot.ok += res[d].ok; tot.man += res[d].man; tot.oth += res[d].oth; });
  const n = tot.ok + tot.man + tot.oth, by = {}; if (tot.ok) by['OK'] = tot.ok; if (tot.man) by['Ruční kontrola'] = tot.man; if (tot.oth) by['(jiný stav)'] = tot.oth;
  const tm = {}; (k.log || []).forEach(e => { const z = tm[e.d] || (tm[e.d] = { a: e.t, b: e.t }); if (e.t < z.a) z.a = e.t; if (e.t > z.b) z.b = e.t; });
  const t = res[today] || { ok: 0, man: 0, oth: 0 };
  return { n, by, tot, rows: k.n, logN: (k.log || []).length, at: k.at, fetchedAt: k.fetchedAt, error: k.error || null, first: k.first || all[0] || null, today: t.ok + t.man + t.oth,
    days: all.slice(-14).map(d => ({ date: d, n: res[d].ok + res[d].man + res[d].oth, inc: res[d].ok + res[d].man + res[d].oth, t1: tm[d] && tm[d].a, t2: tm[d] && tm[d].b, ...res[d] })) };
}
function logCsv(k) {
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  return '\ufeff' + ['Zásilka,Stav,Komentář,Poprvé zachyceno,Naposledy změněno,Den'].concat(((k && k.log) || []).map(e => [e.k, e.st, e.c, e.t, e.u, e.d].map(q).join(','))).join('\r\n');
}
module.exports = { refresh, view, parseCsv, logCsv };
