// Widget pro iPhone (aplikace Scriptable): JSON se souhrnnými čísly pod tajným odkazem + hotový skript s variantami.
const crypto = require('crypto'), http = require('http');
const { pragueToday } = require('./workdays');

const pct = (a, m) => (a + m > 0 ? Math.round(100 * a / (a + m)) : null);

function summarize(j) {
  const S = j.split || { rels: [], days: [] }, today = pragueToday();
  const wds = []; for (const d of (S.days || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1))) { if (d.date < today && d.wd && wds.length < 5) wds.push(d); }
  const u5 = {}; for (const d of wds) for (const k in d.rels) { const q = (u5[k] = u5[k] || { a: 0, m: 0 }); q.a += d.rels[k].pA || 0; q.m += d.rels[k].pM || 0; }
  const rels = (S.rels || []).map(r => { const t = r.today || {}, c = (j.relations || []).find(x => x.key === r.key), u = u5[r.key] || { a: 0, m: 0 };
    return { name: r.name, count: c && c.count != null ? c.count : null, agentTotal: r.pA || 0, today: { a: t.pA || 0, m: t.pM || 0, pct: pct(t.pA || 0, t.pM || 0) }, all: { a: (t.pA || 0) + (t.tA || 0), m: (t.pM || 0) + (t.tM || 0), pct: pct((t.pA || 0) + (t.tA || 0), (t.pM || 0) + (t.tM || 0)) }, use5: { a: u.a, m: u.m, pct: pct(u.a, u.m) } }; });
  const sum = f => rels.reduce((a, r) => a + f(r), 0);
  const ta = sum(r => r.today.a), tm = sum(r => r.today.m), a5 = sum(r => r.use5.a), m5 = sum(r => r.use5.m);
  const aa = sum(r => r.all.a), am = sum(r => r.all.m);
  const nm = {}; for (const r of S.rels || []) nm[r.key] = r.name;
  const days = (S.days || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 21).map(dd => ({ date: dd.date, rels: Object.keys(dd.rels).map(k => { const q = dd.rels[k]; return { name: nm[k] || k, a: q.pA || 0, m: q.pM || 0, all: { a: (q.pA || 0) + (q.tA || 0), m: (q.pM || 0) + (q.tM || 0) } }; }) }));
  return { changedAt: (j.changedAt || S.changedAt || null), todayDate: today, days, updated: new Date().toISOString(), total: j.total || 0, agentTotal: sum(r => r.agentTotal), today: { a: ta, m: tm, pct: pct(ta, tm), all: { a: aa, m: am, pct: pct(aa, am) } }, use5: { a: a5, m: m5, pct: pct(a5, m5) }, rels };
}

function setup(app, o) {   // o: { aiOk, aiTok, port }
  const key = () => crypto.createHmac('sha256', o.aiTok()).update('widget-v1').digest('hex').slice(0, 28);
  const self = () => new Promise((res, rej) => {
    const rq = http.get({ host: '127.0.0.1', port: o.port, path: '/api/agents', headers: { 'x-widget-self': '1', Cookie: 'rkl_ai=' + encodeURIComponent(o.aiTok()) } }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); });
    rq.on('error', rej); rq.setTimeout(20000, () => rq.destroy(new Error('timeout')));
  });
  const keyOk = req => { const k = String(req.query.k || ''), kk = key(); return k.length === kk.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(kk)); };
  // Apple Watch: stránka i data bez přihlášení, jen s klíčem v odkazu (stejný klíč jako widget; odkaz vrací /api/agents/watch-url po přihlášení)
  app.get('/ai/hodinky', (req, res) => {
    if (!o.aiOk(req) && !keyOk(req)) return res.status(401).type('text/plain; charset=utf-8').send('Neplatný odkaz.');
    res.set('Cache-Control', 'no-store').sendFile(require('path').join(__dirname, '..', 'private', 'hodinky.html'));
  });
  app.get('/api/agents/watch', async (req, res) => {
    if (!o.aiOk(req) && !keyOk(req)) return res.status(401).json({ error: 'Neplatný klíč.' });
    try { res.set('Cache-Control', 'no-store').json(await self()); } catch (e) { res.status(500).json({ error: 'Chyba serveru.' }); }
  });
  app.get('/api/agents/watch-url', (req, res) => {
    if (!o.aiOk(req)) return res.status(401).json({ error: 'Nepřihlášen' });
    res.type('text/plain; charset=utf-8').send(`${req.protocol === 'http' && !/localhost|127\./.test(req.get('host')) ? 'https' : req.protocol}://${req.get('host')}/ai/hodinky?k=${key()}`);
  });
  app.get('/api/agents/widget', async (req, res) => {
    const k = String(req.query.k || ''), kk = key();
    if (!o.aiOk(req) && !(k.length === kk.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(kk)))) return res.status(401).json({ error: 'Neplatný klíč.' });
    try {
      const d = summarize(await self());
      if (String(req.query.fmt || '') === 'text') {   // jen text – pro Zkratky / Apple Watch: v = total | today | use | use5 | all
        const v = String(req.query.v || 'total'), n = x => (x == null ? '–' : String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')), p = x => (x == null ? '–' : x + ' %');
        const out = v === 'today' ? n(d.today.a + d.today.m) : v === 'use' ? p(d.today.pct) : v === 'use5' ? p(d.use5.pct) : v === 'changed' ? (d.changedAt ? new Date(d.changedAt).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–')
          : v === 'all' ? `Celkem ${n(d.total)}\nDnes ${n(d.today.a + d.today.m)} (agent ${n(d.today.a)})\nVyužití dnes ${p(d.today.pct)}\nVyužití 5 dní ${p(d.use5.pct)}\nZměna v tabulce ${d.changedAt ? new Date(d.changedAt).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–'}` : n(d.total);
        return res.set('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send(out);
      }
      res.set('Cache-Control', 'no-store').json(d);
    } catch (e) { res.status(500).json({ error: 'Chyba serveru.' }); }
  });
  app.get('/api/agents/widget-url', (req, res) => {   // základ odkazu pro Zkratky
    if (!o.aiOk(req)) return res.status(401).send('Nepřihlášeno');
    res.type('text/plain; charset=utf-8').send(`${req.protocol === 'http' && !/localhost|127\./.test(req.get('host')) ? 'https' : req.protocol}://${req.get('host')}/api/agents/widget?k=${key()}&fmt=text&v=total`);
  });
  app.get('/api/agents/widget-script', (req, res) => {
    if (!o.aiOk(req)) return res.status(401).send('Nepřihlášeno');
    const url = `${req.protocol === 'http' && !/localhost|127\./.test(req.get('host')) ? 'https' : req.protocol}://${req.get('host')}/api/agents/widget?k=${key()}`;
    res.type('text/plain; charset=utf-8').send(SCRIPT.replace('__URL__', url));
  });
}

// Scriptable: parametr widgetu = varianta (total | today | use | use5 | all | název relace, např. „Západ 1“)
const SCRIPT = String.raw`// RKL Agentizace – widget (Scriptable). Parametr widgetu: total | today | use | use5 | all | bars | název relace (např. Západ 1); volitelně za svislítkem den: bars|1 (včera), all|2 (předevčírem), all|2026-11-05
const URL_ = "__URL__";
const RAW = (args.widgetParameter || "all").trim(), PS = RAW.split(/[|;]/).map(x => x.trim());
const P = PS[0];
let OFF = 0, WANT = null; { const o = (PS[1] || "").toLowerCase(); if (o === "včera" || o === "vcera") OFF = 1; else if (/^\d{4}-\d{2}-\d{2}$/.test(o)) WANT = o; else if (/^\d+$/.test(o)) OFF = +o; }
let d; try { d = await new Request(URL_).loadJSON(); } catch (e) { d = null; }
function shiftDay(d) {   // zobrazení jiného dne: nahradí „dnes“ údaji z vybraného dne (parametr např. „bars|1“ = včera, „all|2026-11-05“)
  const base = new Date(d.todayDate + "T12:00:00Z"); const iso = WANT || new Date(base.getTime() - OFF * 864e5).toISOString().slice(0, 10);
  if (iso === d.todayDate) return { d, label: "dnes" };
  const dd = d.days.find(x => x.date === iso); const pc = (a, m) => a + m > 0 ? Math.round(100 * a / (a + m)) : null;
  d.rels.forEach(r => { const q = dd && dd.rels.find(x => x.name === r.name) || { a: 0, m: 0, all: { a: 0, m: 0 } }; r.today = { a: q.a, m: q.m, pct: pc(q.a, q.m) }; r.all = { a: q.all.a, m: q.all.m, pct: pc(q.all.a, q.all.m) }; });
  const sm = f => d.rels.reduce((a, r) => a + f(r), 0), ta = sm(r => r.today.a), tm = sm(r => r.today.m), aa = sm(r => r.all.a), am = sm(r => r.all.m);
  d.today = { a: ta, m: tm, pct: pc(ta, tm), all: { a: aa, m: am, pct: pc(aa, am) } };
  const p = iso.split("-"); return { d, label: OFF === 1 && !WANT ? "včera" : (+p[2]) + ". " + (+p[1]) + ".", noData: !dd };
}
const chg = iso => { if (!iso) return "–"; const x = new Date(iso); return x.getDate() + ". " + (x.getMonth() + 1) + ". " + x.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" }); };
const nf = n => n == null ? "–" : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const col = p => p == null ? "#8d98ad" : p >= 50 ? "#2fbf71" : p >= 25 ? "#f2a516" : p > 0 ? "#ff6b6b" : "#c62828";
function barsWidget(d, fam) {   // přehled dne: agent vs. ručně po relacích (objednávky + přepravy), řazeno podle součtu
  const rows = d.rels.map(r => ({ n: r.name, a: r.all.a, m: r.all.m })).filter(r => r.a + r.m > 0).sort((x, y) => (y.a + y.m) - (x.a + x.m));
  const W = 640, rh = 52, top = 128, H = top + 20 + Math.max(rows.length, 1) * rh + 56, dc = new DrawContext(); dc.size = new Size(W, H); dc.opaque = false; dc.respectScreenScale = true;
  const txt = (s, x, y, w, size, color, al, bold) => { dc.setFont(bold ? Font.heavySystemFont(size) : Font.mediumSystemFont(size)); dc.setTextColor(new Color(color)); if (al === "r") dc.setTextAlignedRight(); else if (al === "c") dc.setTextAlignedCenter(); else dc.setTextAlignedLeft(); dc.drawTextInRect(String(s), new Rect(x, y, w, size + 12)); };
  const tot = d.today.all, bn = nf(tot.a); txt(bn, 0, 0, 300, 84, "#7dd3a0", "l", true);
  txt("OBJ. + PŘEP. AGENT" + (DAY === "dnes" ? "" : " · " + DAY.toUpperCase()), 30 + bn.length * 46, 44, W - 40 - bn.length * 46, 28, "#7dd3a0", "l", true);
  txt("AGENT", 300, top - 4, 100, 20, "#aab7d6", "r", true); txt("RUČNĚ", 400, top - 4, 100, 20, "#aab7d6", "r", true); txt("% AGENT", 510, top - 4, 130, 20, "#aab7d6", "r", true);
  const mx = Math.max(1, ...rows.map(r => r.a + r.m)), L = 150, BW = 170;
  if (!rows.length) txt("žádné pozice", 0, top + 30, W, 30, "#aab7d6", "l", true);
  rows.forEach((r, i) => { const y = top + 26 + i * rh, p = Math.round(100 * r.a / (r.a + r.m)), c = col(p), k = BW / mx;
    txt(r.n, 0, y, 140, 28, "#e3ebff", "r", true);
    if (r.a) { dc.setFillColor(new Color(c)); dc.fillRect(new Rect(L, y + 4, Math.max(r.a * k, 3), 28)); }
    if (r.m) { dc.setFillColor(new Color("#8d98ad", .5)); dc.fillRect(new Rect(L + r.a * k, y + 4, Math.max(r.m * k, 3), 28)); }
    txt(r.a, 300, y, 100, 30, c, "r", true); txt(r.m, 400, y, 100, 30, "#c3cfe8", "r", true); txt(p + " %", 510, y, 130, 30, c, "r", true); });
  txt("změna v tabulce: " + chg(d.changedAt), 0, H - 40, W, 24, "#aab7d6", "l", true);
  return dc.getImage();
}
let DAY = "dnes", NODATA = false; if (d && !d.error && (OFF || WANT)) { const r = shiftDay(d); DAY = r.label; NODATA = !!r.noData; }
const w = new ListWidget(); w.backgroundColor = new Color("#070d1f"); w.setPadding(12, 14, 12, 14);
const T = (s, size, color, bold) => { const t = w.addText(String(s)); t.font = bold ? Font.heavySystemFont(size) : Font.mediumSystemFont(size); t.textColor = new Color(color || "#ffffff"); t.minimumScaleFactor = .5; t.lineLimit = 1; return t; };
if (P === "bars" && d && !d.error && config.widgetFamily !== "small") { w.setPadding(10, 10, 6, 10); const im = w.addImage(barsWidget(d, config.widgetFamily || "large")); im.applyFittingContentMode(); im.leftAlignImage(); w.addSpacer(); }
else if (!d || d.error) { T("Bez dat", 16, "#ff6b6b", true); T("zkontroluj odkaz / připojení", 11, "#aab7d6"); }
else {
  const rel = d.rels.find(r => r.name.toLowerCase() === P.toLowerCase());
  let big, label, color = "#ffffff", extra = [];
  if (rel) { big = nf(rel.today.a + rel.today.m); label = "pozic " + DAY + " · " + rel.name; color = "#ffffff"; extra = ["agent " + nf(rel.today.a) + " / ručně " + nf(rel.today.m), "využití 5 dní: " + (rel.use5.pct == null ? "–" : rel.use5.pct + " %")]; }
  else if (P === "total") { big = nf(d.total); label = "pozic celkem"; }
  else if (P === "today") { big = nf(d.today.a + d.today.m); label = "pozic " + DAY; extra = ["agent " + nf(d.today.a) + " · ručně " + nf(d.today.m)]; }
  else if (P === "use") { big = d.today.pct == null ? "–" : d.today.pct + " %"; label = "využití agenta " + DAY; color = col(d.today.pct); }
  else if (P === "use5") { big = d.use5.pct == null ? "–" : d.use5.pct + " %"; label = "využití agenta · 5 pracovních dní"; color = col(d.use5.pct); }
  else { big = nf(d.total); label = "pozic celkem"; extra = [DAY + " " + nf(d.today.a + d.today.m) + " (agent " + nf(d.today.a) + ")", "využití " + DAY + " " + (d.today.pct == null ? "–" : d.today.pct + " %"), "5 dní " + (d.use5.pct == null ? "–" : d.use5.pct + " %")]; }
  const fam = config.widgetFamily || "small";
  if (fam === "accessoryInline") { T(label + ": " + big, 12); }
  else if (fam === "accessoryCircular") { T(big, 20, "#ffffff", true); }
  else {
    T(label.toUpperCase(), 10, "#aab7d6", true);
    T(big, fam === "small" ? 42 : 52, color, true);
    for (const e of extra) T(e, fam === "small" ? 11 : 13, "#c3cfe8");
    w.addSpacer();
    const u = new Date(d.updated); T("změna v tabulce: " + chg(d.changedAt), fam === "small" ? 10 : 11, "#aab7d6", true); T("načteno " + u.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" }), 9, "#6f7da1");
  }
}
w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
if (config.runsInWidget) Script.setWidget(w); else await w.presentMedium();
Script.complete();
`;
module.exports = { setup, summarize };
