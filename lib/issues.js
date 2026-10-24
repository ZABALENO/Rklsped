// Hodinový přehled problémů z listu „Popisy agentů“ (část „Chyby“ každé relace). Záznamy se jen přidávají, nic se nemaže.
const nk = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const LABELS = { agent: 'agent', funkce: 'fn', vyuziti: 'use', chyby: 'err', problemy: 'err', 'caste dotazy': 'q', aktualizovano: 'upd' };
function parseDesc(t) {
  const o = {}; let cur = null;
  for (const line of String(t || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([^:()\n]{2,30}?)(?:\s*\([^)]*\))?\s*:\s*(.*)$/);
    const k = m && LABELS[nk(m[1])];
    if (k) { cur = k; o[k] = [m[2]]; } else if (cur) o[cur].push(line);
  }
  for (const k in o) o[k] = o[k].join('\n').trim();
  return o;
}

const FIXED = /opraven|overen|vyresen|hotovo|funguje/;
const NOTFIXED = /neopraven|nevyresen|neoverene?/;
const WAIT = /ceka|cekam|na uzivatel|potvrzeni uzivatel|vyzaduje uzivatel|pozadavek na uzivatel/;
const REPEAT = /opakuj|opet|znovu|opakovan|casto/;
const HIGH = /blok|nelze|selhal|selhani|ztrac|duplic|chybn|spatn|smlouv|cen[auy]|platb|nespravn|nevyr|nefung|odeslan/;
const LOW = /drobn|kosmet|upozorneni|informativ/;

function splitItems(s) {
  return String(s || '').split(/\n|;|•|(?<=[^\d][.!?])\s+(?=[A-ZÁ-Ž0-9])|\s-\s(?=[A-ZÁ-Ž])/)
    .map(x => x.replace(/^(?:[\s\-–•*›]+|\d{1,2}[.)]\s+(?!\d))/, '').trim()).filter(x => x.length > 3);
}
function isoFrom(text, fallbackIso) {
  const m = text.match(/(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}))?/);
  if (!m) return fallbackIso || null;
  const y = m[3] || (fallbackIso || '2026').slice(0, 4);
  return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}
function parseIssues(errText, updIso) {
  const items = splitItems(errText);
  if (!items.length || items.every(x => /^(zadn|nic|bez |nejsou|nehlasen)/.test(nk(x)))) return [];
  return items.map(text => {
    const n = nk(text);
    const status = NOTFIXED.test(n) ? 'otevřeno' : FIXED.test(n) ? 'opraveno' : WAIT.test(n) ? 'čeká na uživatele' : REPEAT.test(n) ? 'opakuje se' : 'otevřeno';
    let sev = LOW.test(n) ? 'nízká' : (HIGH.test(n) || WAIT.test(n)) ? 'vysoká' : 'střední';
    if (REPEAT.test(n) && sev === 'nízká') sev = 'střední';
    return { text, status, sev, date: isoFrom(text, updIso), key: n.replace(/\([^)]*\)/g, '').replace(/\b(opraveno|overeno|vyreseno|hotovo|opakuje se|ceka na uzivatele)\b/g, '').replace(/\d+/g, '#').replace(/[^a-z# ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 70) };
  }).filter(x => x.key);
}

const hourKey = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}`;
};

// store: {mem:{issue,isnap}, put}; texts: [{name,text}]
async function snapshot(store, texts, hour = hourKey()) {
  if (!texts) return false;
  if (store.mem.isnap[hour]) return false;                 // jednou za hodinu
  const byRel = {}; let open = 0, total = 0;
  for (const t of texts) {
    const rel = nk(t.name); if (!rel || !String(t.text || '').trim()) continue;
    const d = parseDesc(t.text);
    const upd = d.upd && isoFrom(d.upd, hour.slice(0, 10));
    const agent = (d.agent || '').split('\n')[0].trim();
    for (const it of parseIssues(d.err, upd || hour.slice(0, 10))) {
      const id = rel + '|' + it.key, old = store.mem.issue[id];
      let rec;
      if (!old) rec = { rel, relName: t.name, agent, ...it, first: hour, last: hour, changed: hour, n: 1, hours: [hour] };
      else {
        const diff = old.status !== it.status || old.sev !== it.sev || old.text !== it.text;
        rec = { ...old, agent: agent || old.agent, relName: t.name, text: it.text, status: it.status, sev: it.sev, date: it.date || old.date, last: hour, n: old.n + 1, changed: diff ? hour : old.changed,
          hours: (old.hours || []).concat(hour).slice(-400) };
        if (diff) rec.prev = old.text !== it.text ? old.text : old.prev;
      }
      await store.put('issue', id, rec);
      total++; if (rec.status !== 'opraveno') { open++; byRel[rel] = (byRel[rel] || 0) + 1; }
    }
  }
  await store.put('isnap', hour, { open, total, byRel, at: new Date().toISOString() });
  return true;
}

const SEV = { 'vysoká': 0, 'střední': 1, 'nízká': 2 };
function report(store, texts) {
  const hours = Object.keys(store.mem.isnap).sort(), latest = hours[hours.length - 1] || null;
  const rank = i => (i.status === 'opraveno' || i.last !== latest ? 3 : SEV[i.sev]) * 10 + (i.status === 'čeká na uživatele' ? 0 : i.status === 'opakuje se' ? 1 : 2);
  const rels = new Map();
  for (const i of Object.values(store.mem.issue)) {
    if (!rels.has(i.rel)) rels.set(i.rel, { key: i.rel, name: i.relName, agent: i.agent, issues: [] });
    const r = rels.get(i.rel); r.agent = i.agent || r.agent; r.name = i.relName;
    r.issues.push({ ...i, isNew: i.first === latest && hours.length > 1, isChanged: i.changed === latest && i.first !== latest, current: i.last === latest, hours: undefined, days: new Set((i.hours || []).map(h => h.slice(0, 10))).size });
  }
  const order = (texts || []).map(t => nk(t.name));
  const list = [...rels.values()].sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99));
  for (const r of list) r.issues.sort((a, b) => rank(a) - rank(b) || b.n - a.n);
  const noDesc = (texts || []).filter(t => !String(t.text || '').trim()).map(t => t.name);
  const all = list.flatMap(r => r.issues);
  return {
    latest, snapshots: hours.length,
    open: all.filter(i => i.current && i.status !== 'opraveno').length, total: all.length,
    relations: list, noDesc,
    byProblem: all.slice().sort((a, b) => b.n - a.n).slice(0, 12).map(i => ({ rel: i.relName, text: i.text, n: i.n, days: i.days, status: i.status })),
    byRelation: list.map(r => ({ name: r.name, open: r.issues.filter(i => i.current && i.status !== 'opraveno').length, total: r.issues.length, hits: r.issues.reduce((s, i) => s + i.n, 0) })),
    history: hours.slice(-96).map(h => ({ hour: h, open: store.mem.isnap[h].open })),
  };
}
module.exports = { snapshot, report, parseIssues, parseDesc, hourKey };
