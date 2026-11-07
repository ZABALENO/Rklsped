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
  return { updated: new Date().toISOString(), total: j.total || 0, agentTotal: sum(r => r.agentTotal), today: { a: ta, m: tm, pct: pct(ta, tm), all: { a: aa, m: am, pct: pct(aa, am) } }, use5: { a: a5, m: m5, pct: pct(a5, m5) }, rels };
}

function setup(app, o) {   // o: { aiOk, aiTok, port }
  const key = () => crypto.createHmac('sha256', o.aiTok()).update('widget-v1').digest('hex').slice(0, 28);
  const self = () => new Promise((res, rej) => {
    const rq = http.get({ host: '127.0.0.1', port: o.port, path: '/api/agents', headers: { 'x-widget-self': '1', Cookie: 'rkl_ai=' + encodeURIComponent(o.aiTok()) } }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); });
    rq.on('error', rej); rq.setTimeout(20000, () => rq.destroy(new Error('timeout')));
  });
  app.get('/api/agents/widget', async (req, res) => {
    const k = String(req.query.k || ''), kk = key();
    if (!o.aiOk(req) && !(k.length === kk.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(kk)))) return res.status(401).json({ error: 'Neplatný klíč.' });
    try { res.set('Cache-Control', 'no-store').json(summarize(await self())); } catch (e) { res.status(500).json({ error: 'Chyba serveru.' }); }
  });
  app.get('/api/agents/widget-script', (req, res) => {
    if (!o.aiOk(req)) return res.status(401).send('Nepřihlášeno');
    const url = `${req.protocol === 'http' && !/localhost|127\./.test(req.get('host')) ? 'https' : req.protocol}://${req.get('host')}/api/agents/widget?k=${key()}`;
    res.type('text/plain; charset=utf-8').send(SCRIPT.replace('__URL__', url));
  });
}

// Scriptable: parametr widgetu = varianta (total | today | use | use5 | all | název relace, např. „Západ 1“)
const SCRIPT = String.raw`// RKL Agentizace – widget (Scriptable). Parametr widgetu: total | today | use | use5 | all | bars | název relace (např. Západ 1)
const URL_ = "__URL__";
const P = (args.widgetParameter || "all").trim();
let d; try { d = await new Request(URL_).loadJSON(); } catch (e) { d = null; }
const nf = n => n == null ? "–" : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const col = p => p == null ? "#8d98ad" : p >= 50 ? "#2fbf71" : p >= 25 ? "#f2a516" : p > 0 ? "#ff6b6b" : "#c62828";
function barsWidget(d, fam) {   // přehled dnešního dne: agent vs. ručně po relacích (objednávky + přepravy), řazeno podle součtu
  const rows = d.rels.map(r => ({ n: r.name, a: r.all.a, m: r.all.m })).filter(r => r.a + r.m > 0).sort((x, y) => (y.a + y.m) - (x.a + x.m));
  const W = 700, rh = fam === "large" ? 44 : 34, H = 130 + rows.length * rh, dc = new DrawContext(); dc.size = new Size(W, H); dc.opaque = false; dc.respectScreenScale = true;
  const txt = (s, x, y, w, size, color, al, bold) => { dc.setFont(bold ? Font.heavySystemFont(size) : Font.mediumSystemFont(size)); dc.setTextColor(new Color(color)); if (al === "r") dc.setTextAlignedRight(); else if (al === "c") dc.setTextAlignedCenter(); else dc.setTextAlignedLeft(); dc.drawTextInRect(String(s), new Rect(x, y, w, size + 10)); };
  const tot = d.today.all; txt(nf(tot.a), 0, 0, 260, 76, "#7dd3a0", "l", true); txt("OBJ. + PŘEP. AGENT", 250, 40, 450, 30, "#7dd3a0", "l", true);
  const top = 112; txt("AGENT", 395, top, 90, 20, "#aab7d6", "r"); txt("RUČNĚ", 495, top, 90, 20, "#aab7d6", "r"); txt("% AGENT", 600, top, 100, 20, "#aab7d6", "r");
  const mx = Math.max(1, ...rows.map(r => r.a + r.m)), L = 170, BW = 220;
  rows.forEach((r, i) => { const y = top + 34 + i * rh, p = Math.round(100 * r.a / (r.a + r.m)), c = col(p), k = BW / mx;
    txt(r.n, 0, y, 160, 22, "#e3ebff", "r", true);
    dc.setFillColor(new Color(c)); dc.fillRect(new Rect(L, y + 2, Math.max(r.a * k, r.a ? 2 : 0), 22));
    dc.setFillColor(new Color("#8d98ad", .45)); dc.fillRect(new Rect(L + r.a * k, y + 2, Math.max(r.m * k, r.m ? 2 : 0), 22));
    txt(r.a, 395, y, 90, 24, c, "r", true); txt(r.m, 495, y, 90, 24, "#c3cfe8", "r", true); txt(p + " %", 600, y, 100, 24, c, "r", true); });
  return dc.getImage();
}
const w = new ListWidget(); w.backgroundColor = new Color("#070d1f"); w.setPadding(12, 14, 12, 14);
const T = (s, size, color, bold) => { const t = w.addText(String(s)); t.font = bold ? Font.heavySystemFont(size) : Font.mediumSystemFont(size); t.textColor = new Color(color || "#ffffff"); t.minimumScaleFactor = .5; t.lineLimit = 1; return t; };
if (P === "bars" && d && !d.error && config.widgetFamily !== "small") { w.setPadding(10, 10, 6, 10); const im = w.addImage(barsWidget(d, config.widgetFamily || "large")); im.applyFittingContentMode(); }
else if (!d || d.error) { T("Bez dat", 16, "#ff6b6b", true); T("zkontroluj odkaz / připojení", 11, "#aab7d6"); }
else {
  const rel = d.rels.find(r => r.name.toLowerCase() === P.toLowerCase());
  let big, label, color = "#ffffff", extra = [];
  if (rel) { big = nf(rel.today.a + rel.today.m); label = "pozic dnes · " + rel.name; color = "#ffffff"; extra = ["agent " + nf(rel.today.a) + " / ručně " + nf(rel.today.m), "využití 5 dní: " + (rel.use5.pct == null ? "–" : rel.use5.pct + " %")]; }
  else if (P === "total") { big = nf(d.total); label = "pozic celkem"; }
  else if (P === "today") { big = nf(d.today.a + d.today.m); label = "pozic dnes"; extra = ["agent " + nf(d.today.a) + " · ručně " + nf(d.today.m)]; }
  else if (P === "use") { big = d.today.pct == null ? "–" : d.today.pct + " %"; label = "využití agenta dnes"; color = col(d.today.pct); }
  else if (P === "use5") { big = d.use5.pct == null ? "–" : d.use5.pct + " %"; label = "využití agenta · 5 pracovních dní"; color = col(d.use5.pct); }
  else { big = nf(d.total); label = "pozic celkem"; extra = ["dnes " + nf(d.today.a + d.today.m) + " (agent " + nf(d.today.a) + ")", "využití dnes " + (d.today.pct == null ? "–" : d.today.pct + " %"), "5 dní " + (d.use5.pct == null ? "–" : d.use5.pct + " %")]; }
  const fam = config.widgetFamily || "small";
  if (fam === "accessoryInline") { T(label + ": " + big, 12); }
  else if (fam === "accessoryCircular") { T(big, 20, "#ffffff", true); }
  else {
    T(label.toUpperCase(), 10, "#aab7d6", true);
    T(big, fam === "small" ? 42 : 52, color, true);
    for (const e of extra) T(e, fam === "small" ? 11 : 13, "#c3cfe8");
    w.addSpacer();
    const u = new Date(d.updated); T("aktualizováno " + u.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" }), 9, "#6f7da1");
  }
}
w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
if (config.runsInWidget) Script.setWidget(w); else await w.presentMedium();
Script.complete();
`;
module.exports = { setup, summarize };
