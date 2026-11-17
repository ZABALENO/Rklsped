// Čisté funkce (bez závislostí) pro čtení stránky Historie z EchoTracku a výpočet souhrnů.
const attr = (tag, a) => { const m = new RegExp('\\b' + a + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i').exec(tag); return m ? (m[2] !== undefined ? m[2] : m[3]) : ''; };
const unesc = s => String(s == null ? '' : s).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

// všechna pojmenovaná pole formuláře (hidden + text), která prohlížeč při odeslání posílá
function parseForm(html) {
  const p = new Map();
  for (const tag of String(html).match(/<input\b[^>]*>/gi) || []) {
    const name = unesc(attr(tag, 'name')); if (!name) continue;
    const type = (attr(tag, 'type') || 'text').toLowerCase();
    if (['submit', 'image', 'button', 'checkbox', 'radio', 'file', 'reset'].includes(type)) continue;
    p.set(name, unesc(attr(tag, 'value')));
  }
  for (const m of String(html).matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = unesc(attr(m[1], 'name')); if (!name) continue;
    const opts = m[2].match(/<option\b[^>]*>/gi) || [];
    const sel = opts.find(o => /\bselected\b/i.test(o)) || opts[0];
    p.set(name, sel ? unesc(attr(sel, 'value')) : '');
  }
  return p;
}
const hidden = (html, name) => {
  for (const tag of String(html).match(/<input\b[^>]*>/gi) || []) if (unesc(attr(tag, 'name')) === name) return unesc(attr(tag, 'value'));
  return null;
};

const DT = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2}):?(\d{2})?$/;
// "16.11.2026 08:58:51" (Praha) -> ms od epochy (UTC); přechod letního času řeší Intl
function offMin(utcMs) {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(utcMs));
    const g = t => +p.find(x => x.type === t).value;
    return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - Math.floor(utcMs / 60000) * 60000) / 60000);
  } catch { return 60; }
}
function pragueMs(s) {
  const m = DT.exec(String(s || '').trim()); if (!m) return null;
  const g = Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
  return g - offMin(g) * 60000;
}
const dayKey = ms => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' }).format(new Date(ms));   // YYYY-MM-DD

// tabulka historie: Datum a čas | Stát | Místo | Rychlost | Řidič | Spolujezdec | Návěs | Vzdálenost (tachometr, km)
function parseRows(html) {
  const strip = s => unesc(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  const out = [];
  for (const tr of String(html).match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
    const c = (tr.match(/<td\b[\s\S]*?<\/td>/gi) || []).map(strip);
    if (c.length < 8 || !DT.test(c[0])) continue;
    const t = pragueMs(c[0]); if (t == null) continue;
    out.push({ t, country: c[1], place: c[2], speed: +c[3] || 0, driver: c[4], trailer: c[6], odo: +c[7] || null });
  }
  return out.sort((a, b) => a.t - b.t);
}
// mapové body: typ |-| čas |-| lon*1e5 |-| lat*1e5 |-| ... ; oddělovač záznamů "|--|"
function parsePoints(data) {
  const out = [];
  for (const rec of String(data || '').split('|--|')) {
    const f = rec.split('|-|'); if (f.length < 4) continue;
    const t = pragueMs(f[1]); const lon = +f[2] / 1e5, lat = +f[3] / 1e5;
    if (t == null || !isFinite(lon) || !isFinite(lat) || (!lon && !lat)) continue;
    out.push({ t, lat, lon });
  }
  return out.sort((a, b) => a.t - b.t);
}

const MOVE_GAP = 15 * 60000;      // mezera delší než 15 min = vozidlo nejelo (bez dat)
const STOP_MIN = 10 * 60000;      // zastávka = stání aspoň 10 min
function summarize(rows, points) {
  const r = rows;
  const near = t => { let best = null, bd = 1e18; for (const p of points || []) { const d = Math.abs(p.t - t); if (d < bd) { bd = d; best = p; } if (p.t > t && d > bd) break; } return best; };
  const days = {}; const countries = new Set(); const drivers = new Set();
  const day = k => days[k] || (days[k] = { day: k, km: 0, driveMs: 0, stopMs: 0, maxSpeed: 0, countries: new Set(), drivers: new Set(), first: null, last: null, odoFirst: null, odoLast: null });
  for (let i = 0; i < r.length; i++) {
    const x = r[i], d = day(dayKey(x.t));
    d.maxSpeed = Math.max(d.maxSpeed, x.speed); if (x.country) { d.countries.add(x.country); countries.add(x.country); } if (x.driver) { d.drivers.add(x.driver); drivers.add(x.driver); }
    if (d.first == null) d.first = x.t; d.last = x.t;
    if (x.odo != null) { if (d.odoFirst == null) d.odoFirst = x.odo; d.odoLast = x.odo; }
    const nx = r[i + 1];
    if (nx) { const dt = nx.t - x.t; if (dt <= MOVE_GAP && x.speed > 0) d.driveMs += dt; else d.stopMs += dt; }
  }
  // kilometry po dnech: tachometr na konci dne minus tachometr na konci předchozího dne (první den: od prvního záznamu)
  const keys = Object.keys(days).sort(); let prev = null;
  for (const k of keys) { const d = days[k]; const from = prev != null ? prev : d.odoFirst; d.km = d.odoLast != null && from != null ? Math.max(0, d.odoLast - from) : 0; if (d.odoLast != null) prev = d.odoLast; }
  // zastávky a jízdy
  const stops = [], trips = [];
  let i = 0, tripStart = null;
  while (i < r.length) {
    if (r[i].speed === 0) {
      let j = i; while (j + 1 < r.length && r[j + 1].speed === 0) j++;
      const end = j + 1 < r.length ? r[j + 1].t : r[j].t; const dur = end - r[i].t;
      if (dur >= STOP_MIN || i === 0 || j === r.length - 1) {
        const pt = near(r[i].t);
        stops.push({ from: r[i].t, to: end, durMs: dur, place: r[i].place, country: r[i].country, lat: pt ? pt.lat : null, lon: pt ? pt.lon : null, odo: r[i].odo, open: j === r.length - 1 });
        if (tripStart != null && tripStart.i < i) { const a = r[tripStart.i], b = r[i]; trips.push({ from: a.t, to: b.t, fromPlace: a.place, toPlace: b.place, km: a.odo != null && b.odo != null ? Math.max(0, b.odo - a.odo) : null, maxSpeed: Math.max(...r.slice(tripStart.i, i + 1).map(q => q.speed)) }); }
        tripStart = { i: j };
      }
      i = j + 1;
    } else { if (tripStart == null) tripStart = { i }; i++; }
  }
  if (tripStart != null && r.length && tripStart.i < r.length - 1 && r[r.length - 1].speed > 0) { const a = r[tripStart.i], b = r[r.length - 1]; trips.push({ from: a.t, to: b.t, fromPlace: a.place, toPlace: b.place, km: a.odo != null && b.odo != null ? Math.max(0, b.odo - a.odo) : null, maxSpeed: Math.max(...r.slice(tripStart.i).map(q => q.speed)), open: true }); }
  const dl = keys.map(k => { const d = days[k]; return { day: k, km: d.km, driveMs: d.driveMs, stopMs: d.stopMs, maxSpeed: d.maxSpeed, countries: [...d.countries], drivers: [...d.drivers] }; });
  const tot = dl.reduce((a, d) => ({ km: a.km + d.km, driveMs: a.driveMs + d.driveMs, stopMs: a.stopMs + d.stopMs, maxSpeed: Math.max(a.maxSpeed, d.maxSpeed) }), { km: 0, driveMs: 0, stopMs: 0, maxSpeed: 0 });
  return { total: { ...tot, countries: [...countries], drivers: [...drivers], records: r.length }, days: dl, stops, trips };
}

module.exports = { attr, unesc, parseForm, hidden, parseRows, parsePoints, summarize, pragueMs, dayKey };
