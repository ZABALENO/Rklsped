// Dohled listů „Log…“ v tabulce s pozicemi (jen čtení): server každých 10 s načte všechny listy, jejichž název začíná na „Log“,
// a vyhodnotí je. Název agenta = to, co je v názvu listu za slovem „Log“. Doslovná zadání uživatelů se zobrazují beze změny.
const { parseCsv } = require('./kontrola');
const SHEET_ID = process.env.LOGWATCH_SHEET_ID || '13pguzJn3gQV0dK_ZUerxyTjaXSrvtukpYGgf_bdZE2s';
const PULL_MS = 10 * 1000, NAMES_MS = 60 * 1000;

const deacc = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const isLogSheet = n => /^log(\s|\+|[-–:]|$)/i.test(String(n).trim());
const agentName = n => String(n).trim().replace(/^log/i, '').replace(/^[\s+\-–:]+/, '').trim() || '(bez názvu)';

// sloupce se poznají podle záhlaví (jednotlivé listy je mají v různém pořadí a se lehce odlišnými názvy)
const COLS = [
  ['when', /^datum/], ['agent', /^agent$/], ['request', /doslovn/], ['wants', /^co (po mne )?(presne )?(po mne )?uzivatel|^co po mne/],
  ['doing', /^co (presne )?zacinam/], ['steps', /^kroky/], ['expected', /^ocekavany/], ['progress', /^prubeh/],
  ['problem', /^problem/], ['solution', /^reseni/], ['result', /^vysledek/], ['check', /zaverecn/], ['status', /^stav$/], ['link', /^navazuje/],
];
function mapHeader(hd) {
  const m = {}; (hd || []).forEach((h, i) => { const t = deacc(h); for (const [k, re] of COLS) if (!(k in m) && re.test(t)) { m[k] = i; break; } });
  return m;
}
const NONE = /^(zadn[yaeé]?|žádn[ýáé]?|-+|—|–|ne|nic|bez problem[uů]?|n\/?a)\.?$/i;
const blank = s => !String(s || '').trim() || NONE.test(deacc(String(s)).replace(/\s+/g, ' ')) || NONE.test(String(s).trim());
const DONE = s => /^(hotov|splnen|done|vyresen|dokonc)/.test(deacc(s));
const ERR = /(chyb|nepodar|selhal|neuspes|nelze|nefunguj|zablok|zasekl|vypadl|timeout|hlaska)/;
const MISU = /(nedorozum|nerozum|spatne pochop|pochopil jsem spatne|omylem|mylne|nejasn|nejednoznac|upresn|zeptat|ptam se)/;

function ptime(s) {   // „10.11. 8:00“, „10. 11. 2026 08:00:05“, „2026-11-10 08:00“ → číslo pro řazení (0 když nejde přečíst)
  s = String(s || ''); let y, mo, d, h = 0, mi = 0, se = 0, m;
  if ((m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = s.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})?/))) { d = +m[1]; mo = +m[2]; y = m[3] ? +m[3] : new Date().getFullYear(); }
  else return 0;
  if ((m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/))) { h = +m[1]; mi = +m[2]; se = +(m[3] || 0); }
  return Date.UTC(y, mo - 1, d, h, mi, se);
}
function analyze(sheetName, rows) {
  const hd = rows[0] || [], m = mapHeader(hd), get = (r, k) => (k in m && r[m[k]] != null ? String(r[m[k]]) : '');
  const entries = [];
  rows.slice(1).forEach((r, i) => {
    if (!r || r.every(x => !String(x || '').trim())) return;
    const e = {}; for (const [k] of COLS) e[k] = get(r, k);
    e.row = i + 2; e.ts = ptime(e.when);
    const flags = [];
    const prob = !blank(e.problem), solved = !blank(e.solution);
    const text = deacc([e.problem, e.result, e.check, e.progress].join(' \n '));
    if (!e.request.trim()) flags.push({ k: 'nodoslovne', t: 'chybí doslovné zadání uživatele', lv: 'orange' });
    if (prob) flags.push(solved ? { k: 'problem-ok', t: 'problém vyřešen', lv: 'orange' } : { k: 'problem', t: 'problém bez řešení', lv: 'red' });
    if (prob && ERR.test(deacc(e.problem))) flags.push({ k: 'err', t: 'hlášena chyba', lv: solved ? 'orange' : 'red' });
    else if (!prob && ERR.test(deacc(e.result + ' ' + e.check)) && !/(bez chyb|zadna chyba|bez chyby)/.test(text)) flags.push({ k: 'err', t: 've výsledku / kontrole je zmínka o chybě', lv: 'orange' });
    if (MISU.test(text)) flags.push({ k: 'misu', t: 'možné nedorozumění', lv: 'orange' });
    if (e.status && !DONE(e.status)) flags.push({ k: 'open', t: 'stav: ' + e.status.trim(), lv: /chyb|blok|ceka|čeká/.test(deacc(e.status)) ? 'red' : 'orange' });
    if (DONE(e.status) && !e.result.trim() && !e.check.trim() && !e.progress.trim()) flags.push({ k: 'noresult', t: 'hotovo, ale bez výsledku', lv: 'orange' });
    // odvozené údaje ze zápisu agenta
    const stepsL = String(e.steps).split(/\n|;|(?:^|\s)\d{1,2}[.)]\s+/).map(x => x.trim()).filter(x => x.length > 1);
    e.nSteps = stepsL.length; e.nTicks = (String(e.progress).match(/✔|✓|☑/g) || []).length;
    const tms = [...String(e.progress).matchAll(/(\d{1,2}):(\d{2})/g)].map(x => (+x[1]) * 60 + (+x[2]));
    if (e.ts && tms.length) { const sm = new Date(e.ts); let lastMin = tms[tms.length - 1], base = Date.UTC(sm.getUTCFullYear(), sm.getUTCMonth(), sm.getUTCDate()); let t = base + lastMin * 60000; if (t < e.ts - 60000) t += 864e5; e.lastTs = Math.max(t, e.ts); } else e.lastTs = e.ts || 0;
    e.ids = [...new Set((e.request + ' ' + e.wants).match(/\b[A-Z]{1,3}\/\d{2}[A-Z]?\d{3,}\b|\b\d{2}[A-Z]\d{4,}\b|\b\d{8,}\b/g) || [])].slice(0, 8);
    const warns = [];
    if (/^hotov/.test(deacc(e.status))) {
      if (!e.check.trim()) warns.push('Hotovo bez závěrečné kontroly');
      if (!e.result.trim()) warns.push('Hotovo bez výsledku');
      if (e.nSteps && e.nTicks < e.nSteps) warns.push('splněno ' + e.nTicks + ' z ' + e.nSteps + ' plánovaných kroků');
    }
    if (!e.steps.trim()) warns.push('chybí plán kroků');
    if (!e.wants.trim()) warns.push('chybí „co uživatel chce“');
    e.warns = warns;
    e.flags = flags;
    const st = deacc(e.status), unsolved = prob && !solved;   // Stav podle skillu: Zahájeno / Hotovo / Problém / Čeká na uživatele
    e.done = /^hotov/.test(st) ? (unsolved ? 'no' : 'ok') : /^problem/.test(st) ? 'no' : /^ceka/.test(st) ? 'user' : /^zahajen|^probih|^rozpracov/.test(st) ? 'run'
      : (e.result.trim() || e.check.trim() ? (flags.some(f => ['problem', 'err', 'misu'].includes(f.k)) ? 'no' : 'ok') : 'wait');
    e.level = flags.some(f => f.lv === 'red') ? 'red' : flags.length ? 'orange' : 'ok';
    entries.push(e);
  });
  entries.forEach(e => e.ts = ptime(e.when));
  entries.sort((a, b) => (b.ts - a.ts) || (b.row - a.row));   // nejnovější nahoře (podle data a času, jinak podle řádku)
  const cnt = { total: entries.length, open: entries.filter(e => e.flags.some(f => f.k === 'open')).length, red: entries.filter(e => e.level === 'red').length, orange: entries.filter(e => e.level === 'orange').length,
    problems: entries.filter(e => e.flags.some(f => f.k === 'problem' || f.k === 'problem-ok')).length, misu: entries.filter(e => e.flags.some(f => f.k === 'misu')).length };
  return { sheet: sheetName, agent: agentName(sheetName), known: Object.keys(m), unknown: COLS.map(c => c[0]).filter(k => !(k in m) && ['request', 'result', 'status'].includes(k)), cnt, entries: entries.slice(0, 120), last: entries.length ? entries[0].ts : 0 };
}

// ---- stahování ----
const state = { at: null, error: null, names: [], namesAt: 0, sheets: {}, fallback: null };
async function gviz(name) {
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(name)}`, { redirect: 'follow', headers: { 'user-agent': 'rkl-logwatch' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const t = await r.text();
  if (/^\s*<(!doctype|html)/i.test(t)) throw new Error('tabulka není veřejná („Kdokoli s odkazem“)');
  return parseCsv(t);
}
async function refreshNames() {
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`, { redirect: 'follow', headers: { 'user-agent': 'rkl-logwatch' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, raw: false });
  state.names = wb.SheetNames.filter(isLogSheet); state.namesAt = Date.now();
  state.fallback = {};
  for (const n of state.names) state.fallback[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '', blankrows: false });
}
async function pull() {
  try {
    if (!state.names.length || Date.now() - state.namesAt > NAMES_MS) { try { await refreshNames(); } catch (e) { if (!state.names.length) throw e; state.error = 'Seznam listů: ' + e.message; } }
    const out = {}; let err = null;
    await Promise.all(state.names.map(async n => {
      let rows;
      try { rows = await gviz(n); } catch (e) { err = e.message; rows = state.fallback && state.fallback[n]; if (!rows) return; }
      out[n] = analyze(n, rows);
    }));
    state.sheets = out; state.at = new Date().toISOString(); state.error = err ? 'Rychlé čtení listu selhalo (' + err + '), používám poslední úplné načtení.' : null;
  } catch (e) { state.error = e.message; console.error('Dohled Log:', e.message); }
}
function start() { if (process.env.LOGWATCH_PULL === '0') return; setTimeout(pull, 8000); setInterval(pull, PULL_MS).unref(); }
function view() {
  const sheets = Object.values(state.sheets).sort((a, b) => (b.last - a.last) || a.agent.localeCompare(b.agent, 'cs'));   // agent s nejnovějším zadáním nahoře
  const all = sheets.flatMap(s => s.entries.filter(e => e.level !== 'ok').map(e => ({ agent: s.agent, sheet: s.sheet, row: e.row, when: e.when, request: e.request, level: e.level, flags: e.flags, problem: e.problem, solution: e.solution, result: e.result }))).slice(0, 60);
  const feed = sheets.flatMap(s => s.entries.map(e => ({ agent: s.agent, when: e.when, ts: e.ts, row: e.row, request: e.request, sheet: s.sheet, nSteps: e.nSteps, nTicks: e.nTicks, lastTs: e.lastTs, ids: e.ids, warns: e.warns, status: e.status, wants: e.wants, doing: e.doing, steps: e.steps, expected: e.expected, progress: e.progress, result: e.result, check: e.check, problem: e.problem, solution: e.solution, done: e.done }))).sort((a, b) => (b.ts - a.ts) || (b.row - a.row)).slice(0, 300);
  const pn = new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date()).reduce((o, x) => (o[x.type] = +x.value, o), {});
  const nowN = Date.UTC(pn.year, pn.month - 1, pn.day, pn.hour % 24, pn.minute);
  const agents = sheets.map(sh => { const es = sh.entries, c = k => es.filter(e => e.done === k).length, dur = es.filter(e => e.done === 'ok' && e.ts && e.lastTs > e.ts).map(e => e.lastTs - e.ts);
    return { agent: sh.agent, sheet: sh.sheet, total: es.length, ok: c('ok'), bad: c('no') + c('user'), run: c('run') + c('wait'), warn: es.filter(e => e.warns.length).length, last: sh.last, avgMin: dur.length ? Math.round(dur.reduce((a, b) => a + b, 0) / dur.length / 60000) : null, problems: es.filter(e => !blank(e.problem)).length, solved: es.filter(e => !blank(e.problem) && !blank(e.solution)).length }; });
  return { feed, agents, nowN, at: state.at, error: state.error, namesAt: state.namesAt ? new Date(state.namesAt).toISOString() : null, sheets, alerts: all,
    summary: { sheets: sheets.length, entries: sheets.reduce((a, s) => a + s.cnt.total, 0), open: sheets.reduce((a, s) => a + s.cnt.open, 0), red: sheets.reduce((a, s) => a + s.cnt.red, 0), orange: sheets.reduce((a, s) => a + s.cnt.orange, 0) } };
}
module.exports = { start, view, analyze, isLogSheet, agentName, pull };
