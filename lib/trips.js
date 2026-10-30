// Sestavení přeprav RKL: seskupení objednávek podle čísla přepravy, trasa seřazená
// od nejbližšího místa k Opavě po nejvzdálenější a součet příjmů v Kč.
const { locate, distKm, OPAVA } = require('./geo');

// vlastní doprava = jen tito dopravci (RKL Opava a spolupracující firmy)
const OWN = [/\bRKL\b/i, /tondavi/i, /du[\s-]*al\b/i, /\btrx\b.*thermo|thermologistics/i];
const isRKL = c => OWN.some(rx => rx.test(c || ''));
const ownShort = c => /tondavi/i.test(c) ? 'Tondavi' : /du[\s-]*al/i.test(c) ? 'Du-AL' : /thermo|trx/i.test(c) ? 'TRX' : '';
// SPZ: bez mezer a velkými písmeny; české značky se zobrazí jako „2TL 0380“
const normSpz = s => String(s || '').toUpperCase().replace(/[\s-]+/g, '');
const prettySpz = s => { const n = normSpz(s); return /^\d[A-Z]{2}\d{4}$/.test(n) ? n.slice(0, 3) + ' ' + n.slice(3) : n; };
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
  load.forEach(p => { p.side = 'L'; }); unl.forEach(p => { p.side = 'U'; });
  return [...load, ...unl];
}
const cleanCode = c => String(c || '').replace(/@@@/g, '').replace(/\s+/g, ' ').trim();

const inWin = (today, a, b) => !!a && today >= a && today <= (b && b >= a ? b : a);
const { subWorkdays, addWorkdays } = require('./workdays');

// termín vykládky objednávky už prošel (vykládka do < dnes); bez data = ještě neprošel
const unloadPassed = (r, today) => { const d = r.unlTo || r.unlFrom; return !!d && d < today; };

// Ložné metry jedné objednávky: sloupec „Ložné metry“, jinak odhad z počtu kusů a rozměrů v popisu.
function ldmOf(r) {
  if (r.ldm && r.ldm > 0) return { v: Math.min(r.ldm, 13.6), est: false };
  const g = String(r.goods || '');
  if (/\bFTL\b|kompletn/i.test(g)) return { v: 13.6, est: true };
  const pcs = r.pcs && r.pcs > 0 ? r.pcs : 1;
  let per = 0.4;                                             // EUR paleta 120×80
  const m = g.match(/(\d{2,3})\s*(?:cm)?\s*[x×*\/]\s*(\d{2,3})/i);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a >= 30 && a <= 400 && b >= 30 && b <= 300) per = (a * b) / 24000;   // m² / 2,4 m šířky návěsu
  } else if (/IBC/i.test(g)) per = 0.5;                      // IBC 120×100
  return { v: Math.min(pcs * per, 13.6), est: true };
}

// rows = všechny řádky tabulky; vrací přepravy RKL s nakládkou (Datum nakl.od) dnes až 4 pracovní dny
// zpět, pokud ještě nemají všechny objednávky prošlý termín vykládky
async function buildTrips(rows, today, eurRate, { online = true, backDays = 5, fwdDays = 2, unlGrace = 2 } = {}) {
  const from = subWorkdays(today, backDays), to = addWorkdays(today, fwdDays);
  const groups = new Map(), seenRows = new Set();
  for (const r of rows) {
    if (!isRKL(r.carrier)) continue;
    if (!String(r.prepr || '').trim()) continue;   // jen objednávky, které už mají číslo přepravy
    if (seenRows.has(r.key)) continue;             // stejná objednávka dvakrát = jen jednou
    seenRows.add(r.key);
    const key = r.prepr.toUpperCase().replace(/\s+/g, '') + (normSpz(r.spz) ? '|' + normSpz(r.spz) : '');   // přeprava + SPZ
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const trips = [];
  for (const [key, list] of groups) {
    // zobrazí se, když aspoň jedna objednávka v období začíná (nakládka) nebo končí (vykládka)
    const inRange = d => !!d && d >= from && d <= to;
    if (!list.some(r => inRange(r.date) || inRange(r.dateLoadTo) || inRange(r.unlFrom) || inRange(r.unlTo))) continue;
    // místa – bez duplicit
    const seen = new Map();
    for (const r of list) for (const p of placesOfRow(r)) {
      const k = p.cc + '|' + npl(p.name);
      if (!seen.has(k)) { p.codes = new Set(); seen.set(k, p); }
      const cc = cleanCode(p.side === 'L' ? r.code : r.codeU);   // CODE nakl. patří k nakládce, CODE vykl. k vykládce
      if (cc) seen.get(k).codes.add(cc);
    }
    const places = [...seen.values()];
    for (const p of places) {
      p.ll = await locate(p.cc, p.name, p.zip, online);
      p.km = p.ll ? Math.round(distKm(OPAVA, p.ll)) : null;
    }
    places.forEach((p, i) => (p.i = i));
    places.sort((a, b) => (a.km == null ? 1e9 + a.i : a.km) - (b.km == null ? 1e9 + b.i : b.km));

    // trasa každé objednávky zvlášť (řazená od nejbližšího místa k Opavě)
    const lines = [];
    for (const r of [...list].sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.key).localeCompare(String(b.key)))) {
      const ps = placesOfRow(r);
      for (const p of ps) { p.ll = await locate(p.cc, p.name, p.zip, online); p.km = p.ll ? Math.round(distKm(OPAVA, p.ll)) : null; }
      ps.forEach((p, i) => (p.i = i));
      ps.sort((a, b) => (a.km == null ? 1e9 + a.i : a.km) - (b.km == null ? 1e9 + b.i : b.km));
      lines.push({ order: r.order || '', route: ps.map(p => ({ name: p.name, cc: p.cc, km: p.km, zip: p.zip || '', code: cleanCode(p.side === 'L' ? r.code : r.codeU) })) });
    }
    let czk = 0, eur = 0, kg = 0, ldm = 0, ldmEst = false;
    for (const r of list) {
      czk += r.incCzk || 0; eur += r.incEur || 0; kg += r.weight || 0;
      const l = ldmOf(r); ldm += l.v; ldmEst = ldmEst || l.est;
    }
    const spz = prettySpz(list.map(r => r.spz).find(Boolean));
    const carrier = ownShort(list[0].carrier);
    const loadsToday = list.filter(r => inWin(today, r.date, r.dateLoadTo)).length;
    const unloadsToday = list.filter(r => inWin(today, r.unlFrom, r.unlTo)).length;
    trips.push({
      key, prepr: list[0].prepr, spz, carrier,
      orders: list.length,
      route: places.map(p => ({ name: p.name, cc: p.cc, km: p.km, zip: p.zip || '', code: [...p.codes].join(' · ') })),
      lines,
      czk: Math.round(czk), eur: Math.round(eur * 100) / 100,
      total: Math.round(czk + eur * eurRate),
      loadsToday, unloadsToday,
      kg: Math.round(kg), ldm: Math.round(Math.min(ldm, 99) * 10) / 10, ldmEst,
      firstLoad: list.map(r => r.date).filter(Boolean).sort()[0] || null,
      lastUnload: list.map(r => r.unlTo || r.unlFrom).filter(Boolean).sort().pop() || null,
      unloaded: list.filter(r => unloadPassed(r, today)).length,
    });
  }
  trips.sort((a, b) => (a.spz || '~').localeCompare(b.spz || '~', 'cs') || a.key.localeCompare(b.key));
  return trips;
}

module.exports = { buildTrips, placesOfRow, ldmOf, isRKL, ownShort, prettySpz };
