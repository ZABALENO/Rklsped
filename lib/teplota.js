// Teplota vozidel z reportu „Teplota“ v EchoTracku. Živá mapa teplotu nedává, proto server (pro auta v profilech s teplotou)
// postupně projde stejné kroky jako člověk na stránce Reporty (vybrat auto -> Generovat report) a stáhne vzniklý .xls.
// Relace EchoTracku je jedna, proto jdou požadavky za sebou. Výsledek: get()[SPZ] = { v, at, min, max, n, upd }.
const XLSX = require('xlsx');
const H = require('./historie-parse');
const P = require('./polohy');

const F = 'ctl00$MainContent$';
const out = {};                 // spz -> { v, at, min, max, n, upd }
let chain = Promise.resolve(), busy = false;
const lock = fn => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };
const pad = n => String(n).padStart(2, '0');
const stamp = (d, end) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${end ? '23:59:59' : '00:00:00'}`;

// od dnešní půlnoci do teď (pražský čas) jako [od, do] ve tvaru dd.mm.rrrr hh:mm:ss; „do“ se mění, takže název souboru reportu je pokaždé jiný
function dayRange(now) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(now));
  const g = t => +p.find(x => x.type === t).value;
  const d = `${pad(g('day'))}.${pad(g('month'))}.${g('year')}`;
  return [d + ' 00:00:00', `${d} ${pad(g('hour'))}:${pad(g('minute'))}:${pad(g('second'))}`];
}
// „dd.mm.rrrr hh:mm:ss“ -> .NET ticks (tak jsou pojmenované soubory reportů)
function ticks(cz) {
  const m = /^(\d+)\.(\d+)\.(\d+) (\d+):(\d+):(\d+)$/.exec(cz);
  return (BigInt(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]) + 62135596800000) * 10000n).toString();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// .xls -> { rows:[{at(ISO), v}], … }; hlavička „Datum a čas … Teplota“, hodnoty pod ní
function parseXls(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]]; if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const hi = rows.findIndex(r => r && r.some(c => String(c || '').trim() === 'Datum a čas') && r.some(c => String(c || '').trim() === 'Teplota'));
  if (hi < 0) return [];
  const ti = rows[hi].findIndex(c => String(c || '').trim() === 'Teplota'), di = rows[hi].findIndex(c => String(c || '').trim() === 'Datum a čas');
  const res = [];
  for (const r of rows.slice(hi + 1)) {
    if (!r || r[di] == null || r[ti] == null || r[ti] === '') continue;
    let at = r[di];
    if (typeof at === 'number') { const d = XLSX.SSF.parse_date_code(at); at = `${d.y}-${pad(d.m)}-${pad(d.d)} ${pad(d.H)}:${pad(d.M)}:${pad(Math.floor(d.S))}`; }
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2}):?(\d{2})?/.exec(String(at).trim());
    if (!m) continue;
    const iso = P.parseCzDate(`${+m[3]}.${+m[2]}.${m[1]} ${m[4]}:${m[5]}:${m[6] || '00'}`);
    const v = typeof r[ti] === 'number' ? r[ti] : parseFloat(String(r[ti]).replace(',', '.'));
    if (!iso || !Number.isFinite(v)) continue;
    res.push({ at: iso, v });
  }
  return res;
}

async function fetchReport(carId, name, now, typName) {
  const s = P.session; await s.ensure();
  const url = s.BASE() + '/Reports.aspx';
  let g = await s.http(url);
  if (/type\s*=\s*["']?password/i.test(g.text)) { await s.relogin(); g = await s.http(url); }
  const html = g.text;
  const form = H.parseForm(html);
  if (!form.has(F + 'T_SelectedCars')) throw new Error('Na stránce Reporty chybí výběr vozidel (změnil se vzhled?).');
  // hodnota typu reportu „Teplota“
  let typ = '';
  for (const m of html.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/gi)) if (H.unesc(m[2]).trim().toLowerCase() === typName.toLowerCase()) typ = H.unesc(H.attr(m[1], 'value'));
  if (!typ) throw new Error('V EchoTracku není report „' + typName + '“.');
  const typId = +String(typ).split('|')[0];
  const [from, to] = dayRange(now);
  form.delete(F + 'LV_SelectedCars');
  form.set(F + 'T_SelectedCars', '|' + carId + '|' + name);
  form.set(F + 'UC_FromTo$T_From', from); form.set(F + 'UC_FromTo$T_To', to);
  form.set(F + 'LV_Reports', typ);
  for (const tag of html.match(/<input\b[^>]*type\s*=\s*["']?radio[^>]*>/gi) || []) if (/\bchecked\b/i.test(tag)) form.set(H.unesc(H.attr(tag, 'name')), H.unesc(H.attr(tag, 'value')));
  const body = new URLSearchParams(form); body.set(F + 'B_GenerateReport', 'Generovat report');
  const r = await s.http(url, { method: 'POST', body: body.toString() });
  // report se „vyrábí“ chvíli (ve výpisu „Ve výrobě“) – stránku načítáme znovu, dokud se neobjeví odkaz na náš soubor
  const want = `C_${String(carId).padStart(6, '0')}_${String(typId).padStart(6, '0')}_${ticks(from)}_${ticks(to)}.xls`;
  const find = text => { for (const m of text.matchAll(/ReportGet\.ashx\?([^"'<>\s]+)/gi)) { const q = H.unesc(m[1]); if ((new URLSearchParams(q).get('f') || '').toLowerCase() === want.toLowerCase()) return q; } return null; };
  let link = find(r.text), last = r.text;
  for (let i = 0; !link && i < 16; i++) { await sleep(2500); last = (await s.http(url)).text; link = find(last); }
  const best = link ? { q: link } : null;
  if (!best) {
    const txt = H.unesc(last.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');
    const k = txt.indexOf('Seznam vytvořených reportů');
    console.log('Teplota debug: čekáno na ' + want + ' seznam: ' + (k >= 0 ? txt.slice(k, k + 300) : txt.slice(0, 300)));
    throw new Error('Report ' + typName + ' se nevytvořil.');
  }
  if (process.env.GPS_PROBE) { const a = last.indexOf(want); console.log('Teplota debug akce: ' + last.slice(Math.max(0, a - 400), a + 700).replace(/\s+/g, ' ')); }
  const d = await s.http(s.BASE() + '/ReportGet.ashx?' + best.q, { binary: true });
  if (!d.buf || d.buf.length < 2000) throw new Error('Report ' + typName + ' je prázdný.');
  return d.buf;
}
const fetchTemp = async (carId, name, now) => parseXls(await fetchReport(carId, name, now, 'Teplota'));

// jednorázový náhled struktury libovolného reportu do logu (hlavička + poslední řádky) – k doplnění nových údajů
async function probe(c, typName) {
  const buf = await lock(() => fetchReport(c.id, c.spz, Date.now(), typName));
  const wb = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  console.log('Probe ' + typName + ' ' + c.spz + ' řádků ' + rows.length + ': ' + JSON.stringify(rows.slice(0, 14)) + ' ... ' + JSON.stringify(rows.slice(-4)));
}

async function one(c, now) {
  if (!c.id) return;
  let rows;
  try { rows = await fetchTemp(c.id, c.spzFull || c.spz, now); }
  catch (e) { out[c.spz] = { ...(out[c.spz] || {}), err: String(e.message || e).slice(0, 120), upd: new Date(now).toISOString() }; throw e; }
  if (!rows.length) { out[c.spz] = { v: null, at: null, none: true, upd: new Date(now).toISOString() }; return; }
  const last = rows[rows.length - 1], vs = rows.map(x => x.v);
  out[c.spz] = { v: last.v, at: last.at, min: Math.min(...vs), max: Math.max(...vs), n: rows.length, upd: new Date(now).toISOString() };
}

// obnoví teploty pro dané auta (jedno po druhém); neběží dvakrát současně
async function refresh(cars) {
  if (busy) return; busy = true;
  let ok = 0, bad = 0, lastErr = '';
  try {
    for (const c of cars.slice(0, 80)) {
      try { await lock(() => one(c, Date.now())); ok++; } catch (e) { bad++; lastErr = e.message; if (bad >= 3 && ok === 0) break; }
    }
  } finally { busy = false; }
  console.log('Teplota: aktualizováno ' + ok + ', chyb ' + bad + (lastErr ? ' (' + lastErr + ')' : ''));
}

module.exports = { probe, refresh, get: () => out, parseXls, fetchTemp };
