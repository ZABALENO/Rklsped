// Souřadnice míst podle PSČ a názvu (offline data GeoNames, CC BY 4.0) + záložně OpenStreetMap Nominatim.
// Slouží k seřazení míst trasy podle vzdálenosti od Opavy.
const path = require('path');
const DATA = require(path.join(__dirname, 'geo-data.json'));

const OPAVA = [49.9387, 17.9026];

const nz = z => String(z || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const npl = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// vyčištění názvu z tabulky: "Opava - Kylešovice •" -> varianty k hledání
function nameVariants(name) {
  const clean = String(name || '').replace(/[•*#]/g, ' ').replace(/\s+/g, ' ').trim();
  const v = [clean, clean.replace(/\s+\d+$/, ''), clean.split(/\s+-\s+|-|,|\//)[0], clean.split(' ')[0]];
  return [...new Set(v.map(npl).filter(x => x.length >= 2))];
}

function zipLookup(cc, zip) {
  const c = DATA[cc]; if (!c) return null;
  let z = nz(zip); if (!z) return null;
  if (cc === 'NL') z = z.slice(0, 4);
  if (cc === 'PL' && z.length === 5) { /* PL v datech bez pomlčky */ }
  if (c.z[z]) return c.z[z];
  // nejbližší kratší shoda (např. PSČ s překlepem) – průměr podle prefixu
  for (let len = z.length - 1; len >= 2; len--) {
    const pre = z.slice(0, len);
    const hits = Object.entries(c.z).filter(([k]) => k.startsWith(pre));
    if (hits.length) return [hits.reduce((a, [, v]) => a + v[0], 0) / hits.length, hits.reduce((a, [, v]) => a + v[1], 0) / hits.length];
  }
  return null;
}
function nameLookup(cc, name) {
  const c = DATA[cc]; if (!c) return null;
  for (const v of nameVariants(name)) if (c.p[v]) return c.p[v];
  return null;
}

function distKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLa = rad(b[0] - a[0]), dLo = rad(b[1] - a[1]);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---- záloha: Nominatim (max 1 dotaz/s, výsledky se ukládají do databáze) ---- */
let cache = null, saveFn = null;
function useCache(obj, save) { cache = obj; saveFn = save; }
const queue = []; let busy = false;
function nominatim(cc, name, zip) {
  const key = `${cc}|${npl(name)}|${nz(zip)}`;
  if (cache && cache[key] !== undefined) return Promise.resolve(cache[key] && cache[key].ll);
  return new Promise(resolve => { queue.push({ key, cc, name, zip, resolve }); pump(); });
}
async function pump() {
  if (busy) return; busy = true;
  while (queue.length) {
    const q = queue.shift();
    if (cache && cache[q.key] !== undefined) { q.resolve(cache[q.key] && cache[q.key].ll); continue; }
    let ll = null;
    try {
      const params = new URLSearchParams({ format: 'json', limit: '1', countrycodes: q.cc.toLowerCase() });
      if (q.zip) params.set('postalcode', String(q.zip).trim()); else params.set('city', String(q.name).replace(/[•*#]/g, '').trim());
      const r = await fetch('https://nominatim.openstreetmap.org/search?' + params, {
        headers: { 'User-Agent': 'rkldoprava.onrender.com (RKL Opava dispatch dashboard)' }, signal: AbortSignal.timeout(10000),
      });
      const j = r.ok ? await r.json() : [];
      if (j[0]) ll = [Math.round(+j[0].lat * 100) / 100, Math.round(+j[0].lon * 100) / 100];
    } catch { /* bez sítě – zkusí se příště */ }
    if (cache && saveFn) { cache[q.key] = { ll, t: Date.now() }; saveFn(q.key, cache[q.key]); }
    q.resolve(ll);
    await new Promise(r => setTimeout(r, 1100));
  }
  busy = false;
}

// místo -> [lat, lon] | null ; offline hned, Nominatim jen když offline data nic nenajdou
async function locate(cc, name, zip, allowOnline = true) {
  cc = String(cc || '').toUpperCase();
  const ll = zipLookup(cc, zip) || nameLookup(cc, name);
  if (ll || !allowOnline) return ll;
  const key = `${cc}|${npl(name)}|${nz(zip)}`;
  if (cache && cache[key] !== undefined) return cache[key] && cache[key].ll;
  nominatim(cc, name, zip);   // dohledá na pozadí, výsledek se projeví při dalším obnovení
  return null;
}

module.exports = { locate, distKm, OPAVA, useCache, zipLookup, nameLookup };
