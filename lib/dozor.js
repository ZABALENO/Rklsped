// Dozor agentů – admin přehled na /ai/admin.
// Data (listy „Stav“ a „Log“ tabulky Dozor agentů) sem posílá naplánovaný agent přes konektor Google Sheets (jen čtení);
// web je jen ukládá a vyhodnocuje podle pravidel dozoru. Nic se nehádá: co v tabulce chybí nebo je nejasné, se tak i zobrazí.
const crypto = require('crypto');
const path = require('path');

const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const PRAGUE = 'Europe/Prague';
const pragueParts = d => new Intl.DateTimeFormat('en-GB', { timeZone: PRAGUE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  .formatToParts(d).reduce((o, x) => (o[x.type] = +x.value, o), {});
// „místní pražský“ čas -> epoch ms
function pragueEpoch(y, mo, d, h, mi, s) {
  const want = Date.UTC(y, mo - 1, d, h, mi, s || 0); let utc = want;
  for (let k = 0; k < 2; k++) { const p = pragueParts(new Date(utc)); utc += want - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second); }
  return utc;
}
// podporované tvary: ISO (s Z / offsetem = přesně; bez = pražský čas), „D.M.RRRR H:mm[:ss]“; jinak null (nejasné)
function parseTime(v) {
  const s = String(v == null ? '' : v).trim(); if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (m) {
    if (m[7]) return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2, '0')}:${m[5]}:${m[6] || '00'}${m[7] === 'Z' ? 'Z' : m[7].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`);
    return pragueEpoch(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  }
  m = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return pragueEpoch(+m[3], +m[2], +m[1], +m[4], +m[5], +m[6]);
  return null;
}
const deacc = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const SEV = s => { const t = deacc(s); return /krit|vysok|high|zavazn|vazn/.test(t) ? 3 : /stred|med|stredni/.test(t) ? 2 : /nizk|low|drob/.test(t) ? 1 : 0; }; // 0 = nejasné
const akey = s => deacc(s).replace(/\s+/g, '');                 // „Západ 1“ = „Zapad 1“ = „zapad1“
const RESOLVED = s => /vyres|hotov|uzavr|done|closed/.test(deacc(s));
const fmtPrague = ms => { const p = pragueParts(new Date(ms)); const z = n => String(n).padStart(2, '0'); return `${p.day}. ${p.month}. ${p.hour}:${z(p.minute)}`; };

function evaluate(data, nowMs = Date.now()) {
  const stav = (data && data.stav) || [], log = (data && data.log) || [];
  const p = pragueParts(new Date(nowMs)), dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const workTime = dow >= 1 && dow <= 5 && p.hour >= 6 && p.hour < 17;     // pracovní doba 6:00–17:00 Praha (po–pá; víkend v zadání není upřesněn)
  const since = nowMs - 60 * 60 * 1000;
  const problems = [], unclearLog = [];
  const openAsk = [], requests = [], misunder = [], hist = [];   // sloupce I–K: zásah člověka, doslovné zadání, stav řádku
  for (const r of log.slice(1)) {
    const [cas, agent, ucet, pc, udalost, codelam, typ, zav, zad, zasah, kst] = (r || []).map(x => (x == null ? '' : String(x)));
    if (!cas && !agent) continue;
    const t = parseTime(cas);
    const ev = deacc(udalost);
    // zásah člověka je otevřený jen při jasném signálu: stav „čeká na člověka / otevřeno / chyba“ nebo zásah začínající „ano“.
    // Samotné vyplnění J nestačí (agenti tam píšou „ne“ nebo i jiné údaje, např. číslo objednávky), a „vyřešeno/hotovo“ ho zavírá.
    const needs = /cek|otevre|chyb|zastav/.test(deacc(kst)) || /^ano\b/.test(deacc(zasah));
    if (needs && !RESOLVED(kst)) openAsk.push({ t, at: t == null ? cas : fmtPrague(t), agent: agent.trim(), key: akey(agent), zasah: (/^(ne|no|-|—)?$/.test(deacc(zasah)) ? (codelam || 'bez popisu zásahu') : zasah.trim()), codelam, typ: typ.trim() });
    if (t != null && zad.trim() && /zadani|start|nedorozum/.test(ev)) (/nedorozum/.test(ev) ? misunder : requests).push({ t, at: fmtPrague(t), agent: agent.trim(), zad: zad.trim(), codelam, typ: typ.trim(), kst });
    if (t == null) { unclearLog.push({ cas, agent }); continue; }
    // historie upozornění za 24 h (i vyřešená) – aby šla zpětně dohledat, i když je někdo na stránce potvrdil
    if (t >= nowMs - 24 * 3600 * 1000 && t <= nowMs + 5 * 60 * 1000 && (typ.trim() || needs || /nedorozum|problem/.test(ev))) hist.push({ t, at: fmtPrague(t), agent: agent.trim(), typ: typ.trim(), codelam, zav, sev: SEV(zav), zasah: zasah.trim(), kst, udalost, zad: zad.trim() });
    if (t < since || t > nowMs + 5 * 60 * 1000) continue;
    problems.push({ t, at: fmtPrague(t), agent: agent.trim(), key: akey(agent), ucet, pc, udalost, codelam, typ: typ.trim(), zav, sev: SEV(zav), zad: zad.trim(), zasah: zasah.trim(), kst });
  }
  const real = problems.filter(x => x.typ);           // problém = řádek s vyplněným typem problému
  const agents = [], head = stav[0] || [];
  for (const r of stav.slice(1)) {
    const [agent, ucet, pc, cinnost, posl, , poslProb, st] = (r || []).map(x => (x == null ? '' : String(x)));
    if (!agent) continue;
    const reported = !!(ucet || pc || cinnost || posl || poslProb || st);
    const ak = akey(agent);
    const mine = real.filter(x => x.key === ak);
    const asks = openAsk.filter(x => x.key === ak).sort((a, b) => (b.t || 0) - (a.t || 0));
    const byType = {}; for (const x of mine) byType[x.typ] = (byType[x.typ] || 0) + 1;
    const repeated = Object.entries(byType).filter(([, n]) => n >= 2).map(([typ, n]) => ({ typ, n }));
    const t = parseTime(posl), ageMin = t == null ? null : Math.max(0, Math.round((nowMs - t) / 60000));
    const stDe = deacc(st);
    const stopped = /chyb|zastav|stoj|error|stop/.test(stDe);
    const waiting = /cek/.test(stDe), running = /bez|run|aktiv|pracuj/.test(stDe);
    const idle = reported && workTime && t != null && ageMin > 30;
    const lastNoTime = reported && posl && t == null;
    let level = 'ok', why = [];
    if (!reported) { level = 'none'; }
    else {
      if (asks.length) { level = 'red'; why.push(`čeká na zásah člověka (${asks.length}×): ${asks[0].zasah.slice(0, 140)}`); }
      if (stopped) { level = 'red'; why.push('stav: ' + st); }
      if (idle) { level = 'red'; why.push(`nečinný ${ageMin} min`); }
      if (repeated.length) { level = 'red'; why.push('opakovaný problém: ' + repeated.map(x => `${x.typ} (${x.n}×)`).join(', ')); }
      if (mine.some(x => x.sev === 3)) { level = 'red'; why.push('závažný problém'); }
      if (level === 'ok' && mine.length) { level = 'orange'; why.push(`${mine.length} problém(ů) za hodinu`); }
      if (level === 'ok' && (lastNoTime || !st || (!stopped && !waiting && !running))) { level = 'orange'; why.push(lastNoTime ? 'čas poslední aktivity nelze přečíst' : !st ? 'stav není vyplněn' : 'neznámá hodnota stavu: ' + st); }
    }
    const score = level === 'none' ? -1 : (level === 'red' ? 1000 : level === 'orange' ? 300 : 0) + (asks.length ? 400 : 0) + (stopped ? 200 : 0) + (idle ? 150 : 0) + repeated.reduce((a, x) => a + 60 * x.n, 0) + mine.reduce((a, x) => a + 10 * (x.sev || 2), 0);
    agents.push({ agent: agent.trim(), ucet, pc, cinnost, posl, poslAgeMin: ageMin, poslProb, stav: st, kind: stopped ? 'stoji' : waiting ? 'ceka' : running ? 'bezi' : reported ? 'nejasne' : 'none',
      level, why, reported, idle, asks: asks.slice(0, 5), problemsHour: mine.length, byType, repeated, sev: { vysoka: mine.filter(x => x.sev === 3).length, stredni: mine.filter(x => x.sev === 2).length, nizka: mine.filter(x => x.sev === 1).length, nejasna: mine.filter(x => !x.sev).length }, score });
  }
  agents.sort((a, b) => b.score - a.score);
  const types = {}; for (const x of real) types[x.typ] = (types[x.typ] || 0) + 1;
  const summary = {
    total: agents.length, bezi: agents.filter(a => a.kind === 'bezi').length, ceka: agents.filter(a => a.kind === 'ceka').length, stoji: agents.filter(a => a.kind === 'stoji').length,
    nejasne: agents.filter(a => a.kind === 'nejasne').length, bezHlaseni: agents.filter(a => !a.reported).length, sProblemem: agents.filter(a => a.problemsHour > 0).length,
    zasah: openAsk.length, nedorozumeni: misunder.filter(x => x.t >= since).length,
    nectinne: agents.filter(a => a.idle).length, red: agents.filter(a => a.level === 'red').length, orange: agents.filter(a => a.level === 'orange').length, ok: agents.filter(a => a.level === 'ok').length,
  };
  const ageMs = data && data.readAt ? nowMs - Date.parse(data.readAt) : null;
  return { readAt: (data && data.readAt) || null, dataAgeMin: ageMs == null ? null : Math.round(ageMs / 60000), workTime, now: fmtPrague(nowMs), headers: head, summary, agents,
    recent: real.sort((a, b) => b.t - a.t).slice(0, 30),
    history: hist.sort((a, b) => b.t - a.t).slice(0, 150),
    openAsk: openAsk.sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 30),
    requests: requests.sort((a, b) => b.t - a.t).slice(0, 40), misunder: misunder.sort((a, b) => b.t - a.t).slice(0, 20), types: Object.entries(types).sort((a, b) => b[1] - a[1]).map(([typ, n]) => ({ typ, n })), unclearLog: unclearLog.length };
}

// Samostatné stahování tabulky z veřejného odkazu („Kdokoli s odkazem“) – stejný princip jako u tabulky s pozicemi.
// Server si listy Stav a Log stáhne sám (CSV export podle gid); naplánovaný agent a /api/dozor/push nejsou nutné.
const SHEET_ID = process.env.DOZOR_SHEET_ID || '1sOpHmM-MR-VgASPM78AAVSoJxiJTSCAiszg2YVG-8Gc';
const GID_STAV = process.env.DOZOR_GID_STAV || '0', GID_LOG = process.env.DOZOR_GID_LOG || '1';
const PULL_MS = 10 * 1000;   // stránka se obnovuje po 10 s, tabulku proto stahujeme stejně často
async function pullCsv(gid) {
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`, { redirect: 'follow', headers: { 'user-agent': 'rkl-dozor' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const txt = await r.text();
  if (/^\s*<(!doctype|html)/i.test(txt)) throw new Error('tabulka není veřejná („Kdokoli s odkazem“)');
  const XLSX = require('xlsx');
  const wb = XLSX.read(txt, { type: 'string', raw: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '', blankrows: true });
  while (rows.length && rows[rows.length - 1].every(x => String(x).trim() === '')) rows.pop();
  return rows;
}

function setup(app, o) {   // o: { aiOk, store: () => store }
  // klíč pro příjem dat: buď proměnná DOZOR_KEY, nebo (výchozí) otisk SHA-256 klíče uložený zde – samotný klíč v kódu není
  const KEY_SHA = '2981ec79cd5291b9212783c9df1383018483cfaf202a173ac1c3b566083d3475';
  const keyOk = k => { k = String(k || ''); if (!k) return false; return (process.env.DOZOR_KEY ? eq(k, process.env.DOZOR_KEY) : false) || eq(crypto.createHash('sha256').update(k).digest('hex'), KEY_SHA); };
  const admPw = () => process.env.AI_ADMIN_PASSWORD || '';
  const admTok = () => crypto.createHmac('sha256', admPw() + '|' + (process.env.SESSION_SECRET || 'rkl')).update('rkl-ai-admin-v1').digest('hex');
  const cookie = req => { for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0 && p.slice(0, i).trim() === 'rkl_aiadm') return decodeURIComponent(p.slice(i + 1).trim()); } return ''; };
  const admOk = req => o.aiOk(req) && (!admPw() || eq(cookie(req), admTok()));
  const tries = new Map();
  // vlastní stahování tabulky (vypnutí: DOZOR_PULL=0); při chybě zůstanou poslední známá data
  const pullState = { at: null, error: null };
  const pull = async () => {
    const st = o.store(); if (!st) return;
    try {
      const [stav, log] = await Promise.all([pullCsv(GID_STAV), pullCsv(GID_LOG)]);
      const cut = a => (a.length > 500 ? [a[0], ...a.slice(-499)] : a).map(r => r.slice(0, 12).map(x => String(x == null ? '' : x).slice(0, 2000)));
      await st.put('dozor', 'latest', { stav: cut(stav).slice(0, 31), log: cut(log), readAt: new Date().toISOString(), src: 'sheet' });
      pullState.at = new Date().toISOString(); pullState.error = null;
    } catch (e) { pullState.error = e.message; console.error('Dozor: stažení tabulky selhalo –', e.message); }
  };
  if (process.env.DOZOR_PULL !== '0') { setTimeout(pull, 15000); setInterval(pull, PULL_MS).unref(); }
  // příjem dat od naplánovaného agenta (klíč DOZOR_KEY v hlavičce x-dozor-key) – nejde přes přihlášení do /ai
  app.post('/api/dozor/push', async (req, res) => {
    if (!keyOk(req.headers['x-dozor-key'])) return res.status(401).json({ error: 'Neplatný klíč.' });
    const b = req.body || {};
    if (!Array.isArray(b.stav) || !Array.isArray(b.log)) return res.status(400).json({ error: 'Chybí stav[] nebo log[].' });
    const cut = a => (a.length > 500 ? [a[0], ...a.slice(-499)] : a).map(r => (Array.isArray(r) ? r.slice(0, 12).map(x => String(x == null ? '' : x).slice(0, 2000)) : []));
    await o.store().put('dozor', 'latest', { stav: cut(b.stav), log: cut(b.log), readAt: new Date().toISOString() });
    res.json({ ok: true });
  });
  // čtecí klíč pro widget (Scriptable): GET /api/dozor/widget?k=...; v kódu je jen otisk klíče
  const READ_SHA = 'b13497c79216298a3774c1c5cca4e637105881e9f6e50d699135ea8e41938ef7';
  app.get('/api/dozor/widget', (req, res) => {
    const k = String(req.query.k || '');
    if (!k || !eq(crypto.createHash('sha256').update(k).digest('hex'), READ_SHA)) return res.status(401).json({ error: 'Neplatný klíč.' });
    const e = evaluate(o.store().mem.dozor.latest);
    res.set('Cache-Control', 'no-store').json({ now: e.now, readAt: e.readAt, dataAgeMin: e.dataAgeMin, workTime: e.workTime, summary: e.summary, unclearLog: e.unclearLog,
      agents: e.agents.map(a => ({ agent: a.agent, level: a.level, kind: a.kind, stav: a.stav, cinnost: a.cinnost, ucet: a.ucet, pc: a.pc, posl: a.posl, poslProb: a.poslProb, poslAgeMin: a.poslAgeMin, problemsHour: a.problemsHour, asks: a.asks.map(x => ({ at: x.at, zasah: x.zasah })), byType: a.byType, repeated: a.repeated, why: a.why, reported: a.reported })),
      recent: e.recent.slice(0, 4).map(r => ({ at: r.at, agent: r.agent, typ: r.typ, zav: r.zav })) });
  });
  app.post('/ai/admin/login', async (req, res) => {
    if (!o.aiOk(req)) return res.status(401).json({ error: 'Nepřihlášen' });
    const ip = req.ip || 'x', now = Date.now(), t = (tries.get(ip) || []).filter(x => now - x < 10 * 60 * 1000); tries.set(ip, t);
    if (t.length >= 10) return res.status(429).json({ error: 'Příliš mnoho pokusů.' });
    if (!admPw() || !eq(String((req.body && req.body.password) || ''), admPw())) { t.push(now); return res.status(401).json({ error: 'Nesprávné heslo.' }); }
    res.cookie('rkl_aiadm', admTok(), { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: 30 * 864e5 });
    res.json({ ok: true });
  });
  app.get('/ai/admin', (req, res) => {
    if (!o.aiOk(req)) return res.redirect('/ai');
    res.sendFile(path.join(__dirname, '..', 'private', admOk(req) ? 'admin.html' : 'admin-login.html'));
  });
  app.get('/api/agents/dozor', (req, res) => {
    if (!admOk(req)) return res.status(401).json({ error: 'Nepřihlášen' });
    res.set('Cache-Control', 'no-store').json({ ...evaluate(o.store().mem.dozor.latest), pull: pullState });
  });
}
module.exports = { setup, evaluate, parseTime };
