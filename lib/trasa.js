// Trasa přepravy na mapě: místa (název, země, PSČ) -> souřadnice, silniční trasa a vzdálenost/ETA od aktuální polohy vozidla.
// Souřadnice podle PSČ/obce (offline GeoNames, jinak Nominatim) jsou orientační – střed obce, ne přesná adresa.
const geo = require('./geo');
const norm = s => String(s || '').toUpperCase().replace(/[\s-]+/g, '');

const OSRM = process.env.OSRM_URL || 'https://router.project-osrm.org';
const cache = new Map();   // klíč -> { at, v }
const remember = (k, ttl, v) => { cache.set(k, { at: Date.now(), ttl, v }); if (cache.size > 300) cache.delete(cache.keys().next().value); return v; };
const recall = k => { const e = cache.get(k); return e && Date.now() - e.at < e.ttl ? e.v : undefined; };

async function osrm(path) {
  try {
    const r = await fetch(OSRM + path, { headers: { 'User-Agent': 'rkldoprava.onrender.com (RKL Opava dispatch)' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null; const j = await r.json(); return j && j.code === 'Ok' ? j : null;
  } catch { return null; }
}
const c2 = ll => ll[1].toFixed(5) + ',' + ll[0].toFixed(5);   // OSRM: lon,lat

// pole míst [{n,c,z,s}] z odkazu; max 12, jednoduchá kontrola
function parsePlaces(raw) {
  let a; try { a = JSON.parse(Buffer.from(String(raw || ''), 'base64url').toString('utf8')); } catch { return null; }
  if (!Array.isArray(a)) return null;
  return a.slice(0, 12).map(p => ({ name: String((p && p.n) || '').slice(0, 80), cc: String((p && p.c) || 'CZ').slice(0, 2).toUpperCase(), zip: String((p && p.z) || '').slice(0, 12), side: p && p.s === 'L' ? 'L' : 'U' })).filter(p => p.name);
}

async function build(spz, rawPlaces, cars) {
  const places = parsePlaces(rawPlaces);
  if (!places || !places.length) return { status: 400, body: { error: 'Chybí místa trasy.' } };
  const car = (cars || []).find(c => norm(c.spz) === norm(spz)) || null;
  for (const p of places) p.ll = await geo.locate(p.cc, p.name, p.zip, true);
  const pts = places.filter(p => p.ll);
  const key = 'r|' + pts.map(p => c2(p.ll)).join(';');
  let route = recall(key);
  if (route === undefined) {
    let v = null;
    if (pts.length >= 2) {
      const j = await osrm('/route/v1/driving/' + pts.map(p => c2(p.ll)).join(';') + '?overview=simplified&geometries=geojson');
      if (j && j.routes && j.routes[0]) v = { line: j.routes[0].geometry.coordinates.map(([x, y]) => [y, x]), km: Math.round(j.routes[0].distance / 1000), min: Math.round(j.routes[0].duration / 60) };
    }
    route = remember(key, 6 * 3600e3, v);
  }
  // od vozidla ke každému místu (silnice; záloha vzdušnou čarou × 1,25 při 65 km/h)
  if (car && pts.length) {
    const ck = 'c|' + car.lat.toFixed(2) + ',' + car.lon.toFixed(2) + '|' + pts.map(p => c2(p.ll)).join(';');
    let d = recall(ck);
    if (d === undefined) {
      const j = await osrm('/table/v1/driving/' + c2([car.lat, car.lon]) + ';' + pts.map(p => c2(p.ll)).join(';') + '?sources=0&annotations=duration,distance');
      d = j && j.durations && j.distances ? pts.map((_, i) => ({ km: Math.round(j.distances[0][i + 1] / 1000), min: Math.round(j.durations[0][i + 1] / 60), road: true })) : null;
      remember(ck, 3 * 60e3, d || null);
    }
    pts.forEach((p, i) => {
      if (d && d[i] && Number.isFinite(d[i].km)) p.fromCar = d[i];
      else { const km = Math.round(geo.distKm([car.lat, car.lon], p.ll) * 1.25); p.fromCar = { km, min: Math.round(km / 65 * 60), road: false }; }
    });
  }
  return { status: 200, body: {
    spz, car, route,
    places: places.map(p => ({ name: p.name, cc: p.cc, zip: p.zip, side: p.side, ll: p.ll || null, fromCar: p.fromCar || null })),
  } };
}

module.exports = { build, norm };
