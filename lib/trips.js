// Sestavení přeprav RKL: seskupení objednávek podle čísla přepravy, trasa seřazená
// od nejbližšího místa k Opavě po nejvzdálenější a součet příjmů v Kč.
const { locate, distKm, OPAVA } = require('./geo');

const isRKL = c => /RKL/i.test(c || '');
const npl = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// "A(CZ) + B(CZ)" -> [{name:'A', cc:'CZ'}, ...]
function parseSide(text, fallbackCc) {
  return String(text || '').split(/\s*\+\s*/).map(p => p.trim()).filter(Boolean).map(p => {
    const m = p.match(/^(.*?)\s*\(([A-Za-z]{2})\)\s*[•*#]?\s*$/);
    const name = (m ? m[1] : p).replace(/[•*#]/g, '').replace(/\s+/g, ' ').trim();
    return { name, cc: (m ? m[2] : fallbackCc || '').toUpperCase() };
  }).filter(p => p.name);
}
function splitZips(z) {
  const s = String(z || '').trim();
  if (!s) return [];
  if (/^\d{2}-\d{3}$/.test(s)) return [s];                 // polské PSČ
  return s.split(/\s*[-;,/+]\s*/).filter(Boolean);
}

// místa jedné objednávky (nakládky i vykládky)
function placesOfRow(r) {
  const [left, right] = String(r.route || '').split(/\s*\/\/\s*/);
  let load = parseSide(left, r.ccFrom), unl = parseSide(right, r.ccTo);
  if (!load.length && r.from) load = [{ name: r.from, cc: r.ccFrom }];
  if (!unl.length && r.to) unl = parseSide(String(r.to).replace(/\s*\+\s*/g, ' + '), r.ccTo);
  const zl = splitZips(r.zipFrom), zu = splitZips(r.zipTo);
  load.forEach((p, i) => { p.zip = zl.length === load.length ? zl[i] : (i === 0 ? zl[0] : ''); p.cc = p.cc || r.ccFrom; });
  unl.forEach((p, i) => { p.zip = zu.length === unl.length ? zu[i] : (unl.length === 1 ? zu[0] : ''); p.cc = p.cc || r.ccTo; });
  return [...load, ...unl];
}

const inWin = (today, a, b) => !!a && today >= a && today <= (b && b >= a ? b : a);
const rowActiveToday = (r, today) => inWin(today, r.date, r.dateLoadTo) || inWin(today, r.unlFrom, r.unlTo);

// rows = všechny řádky tabulky; vrací přepravy RKL, které mají dnes nakládku nebo vykládku
async function buildTrips(rows, today, eurRate, { online = true } = {}) {
  const groups = new Map();
  for (const r of rows) {
    if (!isRKL(r.carrier)) continue;
    const key = r.prepr ? r.prepr.toUpperCase().replace(/\s+/g, '') : 'OBJ:' + r.key;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const trips = [];
  for (const [key, list] of groups) {
    if (!list.some(r => rowActiveToday(r, today))) continue;
    // místa – bez duplicit
    const seen = new Map();
    for (const r of list) for (const p of placesOfRow(r)) {
      const k = p.cc + '|' + npl(p.name);
      if (!seen.has(k)) seen.set(k, p);
    }
    const places = [...seen.values()];
    for (const p of places) {
      p.ll = await locate(p.cc, p.name, p.zip, online);
      p.km = p.ll ? Math.round(distKm(OPAVA, p.ll)) : null;
    }
    places.forEach((p, i) => (p.i = i));
    places.sort((a, b) => (a.km == null ? 1e9 + a.i : a.km) - (b.km == null ? 1e9 + b.i : b.km));

    let czk = 0, eur = 0;
    for (const r of list) { czk += r.incCzk || 0; eur += r.incEur || 0; }
    const spz = [...new Set(list.map(r => r.spz).filter(Boolean))].join(', ');
    const loadsToday = list.filter(r => inWin(today, r.date, r.dateLoadTo)).length;
    const unloadsToday = list.filter(r => inWin(today, r.unlFrom, r.unlTo)).length;
    trips.push({
      key, prepr: key.startsWith('OBJ:') ? '' : list[0].prepr, spz,
      orders: list.length,
      route: places.map(p => ({ name: p.name, cc: p.cc, km: p.km })),
      czk: Math.round(czk), eur: Math.round(eur * 100) / 100,
      total: Math.round(czk + eur * eurRate),
      loadsToday, unloadsToday,
      firstLoad: list.map(r => r.date).filter(Boolean).sort()[0] || null,
      lastUnload: list.map(r => r.unlTo || r.unlFrom).filter(Boolean).sort().pop() || null,
    });
  }
  trips.sort((a, b) => (a.spz || '~').localeCompare(b.spz || '~', 'cs') || a.key.localeCompare(b.key));
  return trips;
}

module.exports = { buildTrips, placesOfRow, rowActiveToday, isRKL };
