// Historie vozidel a souhrny (reporty) z EchoTracku: server projde stejné kroky jako člověk na stránce Historie
// (Parametry -> Zobrazit -> Tabulka) a z odpovědi přečte body trasy a tabulku. Relace EchoTracku je jedna (stav je na serveru),
// proto se požadavky řadí za sebe.
const H = require('./historie-parse');
const P = require('./polohy');

const F = 'ctl00$MainContent$';
let chain = Promise.resolve();
const lock = fn => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };
const cache = new Map();   // klíč -> { at, data }
const TTL = 3 * 60 * 1000, MAX_DAYS = 32;

const pad = n => String(n).padStart(2, '0');
// "2026-11-16" nebo "2026-11-16T08:30" -> "16.11.2026 08:30:00"
function cz(s, end) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  const time = m[4] ? m[4] + ':' + m[5] + ':' + (end ? '59' : '00') : (end ? '23:59:59' : '00:00:00');
  return `${m[3]}.${m[2]}.${m[1]} ${time}`;
}

async function run(carId, fromCz, toCz) {
  const s = P.session;
  await s.ensure();
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url = s.BASE() + '/HisMap.aspx';
      let g = await s.http(url);
      if (/type\s*=\s*["']?password/i.test(g.text)) { await s.relogin(); g = await s.http(url); }
      let form = H.parseForm(g.text);
      if (!form.has(F + 'T_SelectedCarId')) {            // stránka je v jiném zobrazení – přepnout na Parametry
        const b = new URLSearchParams(form); b.set(F + 'Img_Pars.x', '5'); b.set(F + 'Img_Pars.y', '5');
        g = await s.http(url, { method: 'POST', body: b.toString() });
        form = H.parseForm(g.text);
      }
      if (!form.has(F + 'T_SelectedCarId')) throw new Error('Na stránce Historie EchoTracku chybí výběr vozidla (změnil se vzhled?).');
      form.set(F + 'T_SelectedCarId', String(carId)); form.set(F + 'UC_FromTo$T_From', fromCz); form.set(F + 'UC_FromTo$T_To', toCz);
      const b1 = new URLSearchParams(form); b1.set(F + 'B_HisMap', 'Zobrazit');
      const r1 = await s.http(url, { method: 'POST', body: b1.toString() });
      const points = H.parsePoints(H.hidden(r1.text, F + 'hdnfCarHistoryDataForMap'));
      const f2 = H.parseForm(r1.text);
      const b2 = new URLSearchParams(f2); b2.set(F + 'Img_List.x', '5'); b2.set(F + 'Img_List.y', '5');
      const r2 = await s.http(url, { method: 'POST', body: b2.toString() });
      const rows = H.parseRows(r2.text);
      return { rows, points };
    } catch (e) {
      lastErr = e;
      if (attempt === 0) { try { await s.relogin(); } catch (e2) { lastErr = e2; break; } }
    }
  }
  throw lastErr;
}

async function history(carId, from, to, light) {
  const f = cz(from, false), t = cz(to, true);
  if (!f || !t) throw Object.assign(new Error('Neplatné datum.'), { status: 400 });
  const a = H.pragueMs(f), b = H.pragueMs(t);
  if (!(b > a)) throw Object.assign(new Error('Konec období musí být po začátku.'), { status: 400 });
  if (b - a > MAX_DAYS * 864e5) throw Object.assign(new Error('Nejdéle ' + MAX_DAYS + ' dní.'), { status: 400 });
  const key = [carId, f, t].join('|');
  const hit = cache.get(key);
  let d;
  if (hit && Date.now() - hit.at < TTL) d = hit.data;
  else {
    d = await lock(() => run(carId, f, t));
    cache.set(key, { at: Date.now(), data: d });
    if (cache.size > 40) cache.delete(cache.keys().next().value);
  }
  const summary = H.summarize(d.rows, d.points);
  const iso = ms => new Date(ms).toISOString();
  const res = {
    carId, from: f, to: t, summary: {
      total: summary.total,
      days: summary.days,
      stops: summary.stops.map(x => ({ ...x, from: iso(x.from), to: iso(x.to) })),
      trips: summary.trips.map(x => ({ ...x, from: iso(x.from), to: iso(x.to) })),
    },
  };
  if (!light) {
    res.points = d.points.map(p => [p.lat, p.lon, p.t]);
    res.rows = d.rows.map(r => ({ t: iso(r.t), country: r.country, place: r.place, speed: r.speed, driver: r.driver, trailer: r.trailer, odo: r.odo }));
  }
  return res;
}

function setup(app, ok) {
  app.get('/api/polohy/historie', async (req, res) => {
    if (!ok(req)) return res.status(401).json({ error: 'Nepřihlášeno.' });
    res.set('Cache-Control', 'no-store');
    const car = String(req.query.car || '');
    if (!/^\d{1,9}$/.test(car)) return res.status(400).json({ error: 'Chybí vozidlo.' });
    try { res.json(await history(car, req.query.from, req.query.to, req.query.light === '1')); }
    catch (e) { console.error('Historie:', e.message); res.status(e.status || 502).json({ error: e.status ? e.message : 'Historii se nepodařilo načíst: ' + e.message }); }
  });
}

module.exports = { setup, history, cz };
