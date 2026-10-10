// Stažení tabulky z veřejného odkazu (Google Sheets / Drive / OneDrive / SharePoint)
// a vytažení potřebných sloupců. Nic se neukládá na disk – vše jen v paměti.
const XLSX = require('xlsx');
const MAX_BYTES = 25 * 1024 * 1024;

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
  weight: ['hmotnost(kg)', 'hmotnost (kg)', 'hmotnost', 'vaha'],
  order: ['objednavka', 'cislo objednavky', 'zakazka'],
  prepr: ['preprava', 'cislo prepravy'],
  carrier: ['dopravce'],
  code: ['code nakl.', 'code nakl', 'kod nakl.', 'kod nakl'],
  from: ['mesto nakl.', 'mesto nakl', 'misto nakladky'],
  to: ['mesto vykl.', 'mesto vykl', 'misto vykladky'],
};
function findCol(headers, names) {
  for (const n of names) { const i = headers.findIndex(h => h === n); if (i >= 0) return i; }
  for (const n of names) { const i = headers.findIndex(h => h.startsWith(n)); if (i >= 0) return i; }
  return -1;
}
const p2 = n => String(n).padStart(2, '0');
function toIsoDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${p2(v.getMonth() + 1)}-${p2(v.getDate())}`;
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}-${p2(d.m)}-${p2(d.d)}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[.\/-]\s*(\d{1,2})[.\/-]\s*(\d{2,4})/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${p2(m[2])}-${p2(m[1])}`;
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
const str = v => (v == null ? '' : String(v).trim());

function extractRows(wb) {
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
    let hi = -1; // hlavička = první řádek (v prvních 15), kde je sloupec "Trasa"
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
      let route = str(get('route'));
      if (!route && (get('from') || get('to'))) route = `${str(get('from')) || '?'} // ${str(get('to')) || '?'}`;
      const goods = str(get('goods'));
      const date = toIsoDate(get('date'));
      const weight = toNum(get('weight'));
      if (!route && !goods && !date) continue;
      const order = str(get('order'));
      const key = order || ['h', date, route, goods, weight].map(x => String(x ?? '')).join('|');
      rows.push({ key, order, date, route, goods, weight, prepr: str(get('prepr')), code: str(get('code')), carrier: str(get('carrier')) });
    }
    return { sheet: name, rows, columns: Object.fromEntries(Object.entries(c).map(([k, i]) => [k, i >= 0 ? aoa[hi][i] : null])) };
  }
  throw new Error('V tabulce jsem nenašel hlavičku se sloupcem „Trasa“.');
}

function readWorkbook(buf, kind) {
  return kind === 'csv'
    ? XLSX.read(buf.toString('utf8'), { type: 'string', raw: true, cellDates: false })
    : XLSX.read(buf, { type: 'buffer', cellDates: false });
}

// Stáhne a zpracuje tabulku z odkazu. Vyhodí chybu s českým popisem.
async function loadSheet(url) {
  if (process.env.DEV_SHEET_FILE && url === 'dev') { // jen pro lokální test
    return extractRows(readWorkbook(require('fs').readFileSync(process.env.DEV_SHEET_FILE), 'xlsx'));
  }
  const cands = candidateUrls(url);
  if (!cands.length || !cands.some(hostAllowed)) {
    throw new Error('Podporované jsou veřejné odkazy z Google Sheets / Google Drive a OneDrive / SharePoint (Excel online).');
  }
  const errors = [];
  for (const cu of cands) {
    try {
      const { buf, type } = await fetchFollow(cu);
      const kind = looksLikeSheet(buf, type);
      if (!kind) { errors.push('nejde o tabulku'); continue; }
      return extractRows(readWorkbook(buf, kind));
    } catch (e) { errors.push(e.message); }
  }
  throw new Error('Tabulku se nepodařilo stáhnout – zkontroluj, že je odkaz veřejný („Kdokoli s odkazem“). (' + [...new Set(errors)].join(' · ') + ')');
}

function validUrl(url) {
  if (process.env.DEV_SHEET_FILE && url === 'dev') return true;
  return candidateUrls(url).some(hostAllowed);
}

module.exports = { loadSheet, extractRows, candidateUrls, validUrl };
