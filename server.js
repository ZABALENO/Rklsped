// RKL Spedice – dashboard přeprav v prodeji
// Tabulka se NIKAM neukládá: server ji jen na požádání stáhne z veřejného odkazu,
// v paměti vytáhne potřebné sloupce a pošle je prohlížeči.
// Na serveru se ukládá pouze stav "Prodáno" (číslo objednávky, trasa, čas).

const express = require('express');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_BYTES = 25 * 1024 * 1024;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

/* ---------------- stav "Prodáno" ---------------- */
// records: { [key]: { sold: bool, at: ISO (kdy prodáno), u: ISO (poslední změna), label: string } }
let state = { records: {} };
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (!state.records) state.records = {};
} catch (e) { console.error('Stav se nepodařilo načíst:', e.message); }

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) { console.error(e.message); }
  }, 300);
}

function mergeRecords(incoming) {
  if (!incoming || typeof incoming !== 'object') return;
  for (const [k, r] of Object.entries(incoming)) {
    if (!r || typeof r.u !== 'string' || k.length > 300) continue;
    const cur = state.records[k];
    if (!cur || r.u > cur.u) {
      state.records[k] = {
        sold: !!r.sold,
        at: typeof r.at === 'string' ? r.at : null,
        u: r.u,
        label: typeof r.label === 'string' ? r.label.slice(0, 200) : '',
      };
    }
  }
  // úklid: záznamy starší než 120 dní
  const limit = new Date(Date.now() - 120 * 864e5).toISOString();
  for (const [k, r] of Object.entries(state.records)) if (r.u < limit) delete state.records[k];
  saveState();
}

app.get('/api/state', (req, res) => res.json(state));
app.post('/api/state', (req, res) => {
  mergeRecords(req.body && req.body.records);
  res.json(state);
});

/* ---------------- stažení tabulky z veřejného odkazu ---------------- */
const ALLOWED_HOSTS = [
  'docs.google.com', 'drive.google.com', 'drive.usercontent.google.com',
  '.googleusercontent.com', 'onedrive.live.com', '1drv.ms', 'api.onedrive.com',
  '.sharepoint.com', '.livefilestore.com', '.1drv.com', 'onedrive.com', '.onedrive.com',
  'my.microsoftpersonalcontent.com', '.microsoftpersonalcontent.com',
];
function hostAllowed(u) {
  try {
    const { hostname, protocol } = new URL(u);
    if (protocol !== 'https:') return false;
    return ALLOWED_HOSTS.some(h => h.startsWith('.') ? hostname.endsWith(h) : hostname === h);
  } catch { return false; }
}

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

// Z odkazu, který uživatel vloží, udělá seznam adres, ze kterých se zkusí stáhnout soubor
function candidateUrls(raw) {
  const url = raw.trim();
  const out = [];
  let u;
  try { u = new URL(url); } catch { return out; }
  const h = u.hostname;

  if (h === 'docs.google.com' && u.pathname.includes('/spreadsheets/')) {
    const pub = u.pathname.match(/\/spreadsheets\/d\/e\/([^/]+)/);
    const id = u.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
    const gid = (u.hash.match(/gid=(\d+)/) || u.search.match(/gid=(\d+)/) || [])[1];
    if (pub) {
      out.push(`https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=xlsx`);
      if (gid) out.push(`https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?gid=${gid}&single=true&output=csv`);
    } else if (id) {
      if (gid) out.push(`https://docs.google.com/spreadsheets/d/${id[1]}/export?format=csv&gid=${gid}`);
      out.push(`https://docs.google.com/spreadsheets/d/${id[1]}/export?format=xlsx`);
    }
  } else if (h === 'drive.google.com') {
    const id = (u.pathname.match(/\/file\/d\/([^/]+)/) || [])[1] || u.searchParams.get('id');
    if (id) {
      out.push(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`);
      out.push(`https://drive.google.com/uc?export=download&id=${id}`);
    }
  } else if (h.endsWith('.sharepoint.com')) {
    const d = new URL(url); d.searchParams.set('download', '1'); out.push(d.toString());
    out.push(`https://api.onedrive.com/v1.0/shares/u!${b64url(url)}/root/content`);
  } else if (h === '1drv.ms' || h.endsWith('onedrive.live.com') || h === 'onedrive.com' || h.endsWith('.onedrive.com')) {
    out.push(`https://api.onedrive.com/v1.0/shares/u!${b64url(url)}/root/content`);
    if (h.endsWith('onedrive.live.com')) {
      out.push(url.replace('/redir?', '/download?').replace('/edit.aspx?', '/download.aspx?').replace('/view.aspx?', '/download.aspx?'));
    }
    out.push(url.includes('?') ? url + '&download=1' : url + '?download=1');
  }
  out.push(url);
  return [...new Set(out)];
}

async function fetchFollow(url, hops = 0) {
  if (hops > 8) throw new Error('Příliš mnoho přesměrování');
  if (!hostAllowed(url)) throw new Error('Nepovolená adresa: ' + new URL(url).hostname);
  const r = await fetch(url, {
    redirect: 'manual',
    headers: { 'User-Agent': 'Mozilla/5.0 (RKL Spedice dashboard)', Accept: '*/*' },
    signal: AbortSignal.timeout(25000),
  });
  if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
    return fetchFollow(new URL(r.headers.get('location'), url).toString(), hops + 1);
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('Soubor je příliš velký');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('Soubor je příliš velký');
  return { buf, type: r.headers.get('content-type') || '' };
}

function looksLikeSheet(buf, type) {
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'xlsx'; // ZIP (xlsx)
  if (buf[0] === 0xd0 && buf[1] === 0xcf) return 'xls';
  const head = buf.slice(0, 600).toString('utf8').toLowerCase();
  if (head.includes('<html') || head.includes('<!doctype')) return null;
  if (type.includes('csv') || type.includes('text/plain') || head.includes(';') || head.includes(',')) return 'csv';
  return null;
}

/* ---------------- rozpoznání sloupců ---------------- */
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const COLS = {
  date: ['datum nakl.od', 'datum nakl', 'datum nakladky', 'nakladka datum', 'datum'],
  route: ['trasa', 'relace trasa', 'route'],
  goods: ['popis zbozi', 'zbozi', 'popis'],
  weight: ['hmotnost(kg)', 'hmotnost (kg)', 'hmotnost', 'vaha', 'kg'],
  order: ['objednavka', 'cislo objednavky', 'zakazka'],
  from: ['mesto nakl.', 'mesto nakl', 'misto nakladky'],
  to: ['mesto vykl.', 'mesto vykl', 'misto vykladky'],
};
function findCol(headers, names) {
  for (const n of names) { const i = headers.findIndex(h => h === n); if (i >= 0) return i; }
  for (const n of names) { const i = headers.findIndex(h => h.startsWith(n)); if (i >= 0) return i; }
  return -1;
}

function toIsoDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[.\/-]\s*(\d{1,2})[.\/-]\s*(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
function toNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.').replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? null : n;
}

function extractRows(wb) {
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
    // hlavička = první řádek (v prvních 15), kde je sloupec "Trasa"
    let hi = -1;
    for (let i = 0; i < Math.min(15, aoa.length); i++) {
      const hs = (aoa[i] || []).map(norm);
      if (findCol(hs, COLS.route) >= 0 && (findCol(hs, COLS.date) >= 0 || findCol(hs, COLS.goods) >= 0)) { hi = i; break; }
    }
    if (hi < 0) continue;
    const hs = aoa[hi].map(norm);
    const c = Object.fromEntries(Object.entries(COLS).map(([k, n]) => [k, findCol(hs, n)]));
    const rows = [];
    for (let i = hi + 1; i < aoa.length; i++) {
      const r = aoa[i] || [];
      const get = k => (c[k] >= 0 ? r[c[k]] : null);
      let route = get('route');
      if (!route && (get('from') || get('to'))) route = `${get('from') || '?'} // ${get('to') || '?'}`;
      const goods = get('goods');
      const date = toIsoDate(get('date'));
      const weight = toNum(get('weight'));
      if (!route && !goods && !date) continue;
      const order = get('order') ? String(get('order')).trim() : '';
      const key = order || ['h', date, route, goods, weight].map(x => String(x ?? '')).join('|');
      rows.push({ key, order, date, route: route ? String(route).trim() : '', goods: goods ? String(goods).trim() : '', weight });
    }
    return { sheet: name, rows, columns: Object.fromEntries(Object.entries(c).map(([k, i]) => [k, i >= 0 ? aoa[hi][i] : null])) };
  }
  throw new Error('V tabulce jsem nenašel hlavičku se sloupcem „Trasa“.');
}

app.post('/api/sheet', async (req, res) => {
  const url = req.body && typeof req.body.url === 'string' ? req.body.url : '';
  if (!url) return res.status(400).json({ error: 'Chybí odkaz na tabulku.' });
  // pouze pro lokální testování (na Renderu se nepoužívá)
  if (process.env.DEV_SHEET_FILE && url === 'dev') {
    const out = extractRows(XLSX.read(fs.readFileSync(process.env.DEV_SHEET_FILE), { type: 'buffer', cellDates: false }));
    return res.json({ ...out, fetchedAt: new Date().toISOString() });
  }
  const cands = candidateUrls(url);
  if (!cands.length || !cands.some(hostAllowed)) {
    return res.status(400).json({ error: 'Podporované jsou veřejné odkazy z Google Sheets / Google Drive a OneDrive / SharePoint (Excel online).' });
  }
  const errors = [];
  for (const cu of cands) {
    try {
      const { buf, type } = await fetchFollow(cu);
      const kind = looksLikeSheet(buf, type);
      if (!kind) { errors.push('nejde o tabulku'); continue; }
      const wb = kind === 'csv'
        ? XLSX.read(buf.toString('utf8'), { type: 'string', raw: true, cellDates: false })
        : XLSX.read(buf, { type: 'buffer', cellDates: false });
      const out = extractRows(wb);
      return res.json({ ...out, fetchedAt: new Date().toISOString() });
    } catch (e) {
      errors.push(e.message);
    }
  }
  res.status(502).json({
    error: 'Tabulku se nepodařilo stáhnout. Zkontroluj, že je odkaz veřejný („Kdokoli s odkazem“).',
    detail: [...new Set(errors)].join(' · '),
  });
});

app.get('/healthz', (req, res) => res.send('ok'));

if (require.main === module) app.listen(PORT, () => console.log('RKL Spedice běží na portu ' + PORT));
module.exports = { app, extractRows, candidateUrls };
