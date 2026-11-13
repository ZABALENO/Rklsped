// Widget pro iPhone (aplikace Scriptable): JSON se souhrnnými čísly pod tajným odkazem + hotový skript s variantami.
const crypto = require('crypto'), http = require('http');
const { pragueToday } = require('./workdays');

const pct = (a, m) => (a + m > 0 ? Math.round(100 * a / (a + m)) : null);

// výchozí den: dnes, pokud už dnes agent zapsal aspoň jednu objednávku; jinak poslední den, kdy ji zapsal
function autoDate(S, today) {
  const ok = d => Object.values(d.rels || {}).some(q => (q.pA || 0) > 0);
  const ds = (S.days || []).filter(d => ok(d)).map(d => d.date).filter(d => d <= today).sort();
  return ds.includes(today) ? today : (ds.length ? ds[ds.length - 1] : today);
}
function summarize(j) {
  const S = j.split || { rels: [], days: [] }, today = pragueToday();
  const wds = []; for (const d of (S.days || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1))) { if (d.date < today && d.wd && wds.length < 5) wds.push(d); }
  const u5 = {}; for (const d of wds) for (const k in d.rels) { const q = (u5[k] = u5[k] || { a: 0, m: 0 }); q.a += d.rels[k].pA || 0; q.m += d.rels[k].pM || 0; }
  const rels = (S.rels || []).map(r => { const t = r.today || {}, c = (j.relations || []).find(x => x.key === r.key), u = u5[r.key] || { a: 0, m: 0 };
    return { agAll: (t.pA || 0) + (t.tA || 0), name: r.name, count: c && c.count != null ? c.count : null, agentTotal: r.pA || 0, today: { a: t.pA || 0, m: t.pM || 0, pct: pct(t.pA || 0, t.pM || 0) }, all: { a: (t.pA || 0), m: (t.pM || 0), pct: pct((t.pA || 0), (t.pM || 0)) }, use5: { a: u.a, m: u.m, pct: pct(u.a, u.m) } }; });
  const defaultDate = autoDate(S, today);
  if (defaultDate !== today) { const dd = (S.days || []).find(x => x.date === defaultDate), nmk = {}; for (const r of S.rels || []) nmk[r.key] = r.name;
    for (const r of rels) { const k = Object.keys(nmk).find(x => nmk[x] === r.name), q = (dd && dd.rels && dd.rels[k]) || {}; r.agAll = (q.pA || 0) + (q.tA || 0); r.today = { a: q.pA || 0, m: q.pM || 0, pct: pct(q.pA || 0, q.pM || 0) }; r.all = { a: (q.pA || 0), m: (q.pM || 0), pct: pct((q.pA || 0), (q.pM || 0)) }; } }
  // Zpracování dat (kontrola podkladu k fakturaci): přidáno jako další „relace“, aby ho zobrazil beze změn i hotový skript; délka = OK + ruční kontrola
  const KD = (j.kontrola && j.kontrola.days) || [], kTot = iso => { const q = KD.find(x => x.date === iso); return q ? (q.ok || 0) + (q.man || 0) : 0; };
  if (j.kontrola) rels.push({ agAll: 0, name: 'Zprac. dat', count: null, agentTotal: 0, today: { a: 0, m: 0, pct: null }, all: { a: kTot(defaultDate), m: 0, pct: 100 }, use5: { a: 0, m: 0, pct: null } });
  const sum = f => rels.reduce((a, r) => a + f(r), 0);
  const ta = sum(r => r.today.a), tm = sum(r => r.today.m), a5 = sum(r => r.use5.a), m5 = sum(r => r.use5.m);
  const aa = sum(r => r.agAll), am = sum(r => r.all.m);   // jako /ai: řádky = jen objednávky; velké číslo = všechny pozice agenta (obj. + přep.)
  const nm = {}; for (const r of S.rels || []) nm[r.key] = r.name;
  const days = (S.days || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 21).map(dd => ({ date: dd.date, rels: (j.kontrola ? [{ name: 'Zprac. dat', a: 0, m: 0, all: { a: kTot(dd.date), m: 0 } }] : []).concat(Object.keys(dd.rels).map(k => { const q = dd.rels[k]; return { name: nm[k] || k, a: q.pA || 0, m: q.pM || 0, all: { a: (q.pA || 0), m: (q.pM || 0) } }; })) }));
  return { changedAt: (j.changedAt || S.changedAt || null), todayDate: today, defaultDate, days, updated: new Date().toISOString(), total: j.total || 0, agentTotal: sum(r => r.agentTotal), today: { a: ta, m: tm, pct: pct(ta, tm), all: { a: aa, m: am, pct: pct(aa, am) } }, use5: { a: a5, m: m5, pct: pct(a5, m5) }, rels };
}

function setup(app, o) {   // o: { aiOk, aiTok, port }
  const key = () => crypto.createHmac('sha256', o.aiTok()).update('widget-v1').digest('hex').slice(0, 28);
  const self = () => new Promise((res, rej) => {
    const rq = http.get({ host: '127.0.0.1', port: o.port, path: '/api/agents', headers: { 'x-widget-self': '1', Cookie: 'rkl_ai=' + encodeURIComponent(o.aiTok()) } }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); });
    rq.on('error', rej); rq.setTimeout(20000, () => rq.destroy(new Error('timeout')));
  });
  // pevný unikátní odkaz pro hodinky: /h/<token>; v kódu je jen otisk SHA-256 (nebo proměnná WATCH_KEY), samotný token se v repozitáři neukládá
  const WATCH_SHA = '35e67898be1f96bcff784413f1c8fc6324443ebeda19cfd235181d849aa448a0';
  const watchTok = t => { t = String(t || ''); if (!t) return false; if (process.env.WATCH_KEY && t.length === process.env.WATCH_KEY.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(process.env.WATCH_KEY))) return true; const kk = key(); if (t.length === kk.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(kk))) return true; return crypto.createHash('sha256').update(t).digest('hex') === WATCH_SHA; };
  const keyOk = req => { const k = String(req.query.k || ''), kk = key(); return watchTok(k) || (k.length === kk.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(kk))); };
  // data pro hodinky z /api/agents (server-side; prohlížeč na hodinkách neumí JavaScript); sel = vybraný den (YYYY-MM-DD)
  const watchData = async sel => {
    const j = await self(), S = j.split, rels = j.relations || [], days = (S && S.days) || [];
    const t = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' });
    sel = /^\d{4}-\d{2}-\d{2}$/.test(String(sel || '')) && sel <= t ? sel : autoDate(S || { days: [] }, t);
    const monOf = iso => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
    const sh = n => { const m = String(n || '').trim().match(/^(\S+)\s*(\d+)?/); return m ? m[1].normalize('NFD').replace(/[̀-ͯ]/g, '')[0].toUpperCase() + (m[2] || '') : String(n || ''); };
    const agg = (from, to) => { const sum = {}; let a = 0, m = 0; days.filter(x => x.date >= from && x.date <= to).forEach(x => Object.entries(x.rels).forEach(([k, q]) => { const z = sum[k] || (sum[k] = { a: 0, m: 0 }); const A = q.pA || 0, M = q.pM || 0; z.a += A; z.m += M; a += A; m += M; }));
      const items = ((S && S.rels) || []).map(r => { const z = sum[r.key]; return z && z.a + z.m > 0 ? { name: sh(r.name), a: z.a, m: z.m } : null; }).filter(Boolean).sort((p, q) => (q.a - p.a) || (q.m - p.m)); return { a, m, items }; };
    const ds = days.map(x => x.date).filter(x => x <= t);
    const prev = ds.filter(x => x < sel).sort().pop() || null;
    const next = sel >= t ? null : (ds.filter(x => x > sel).sort()[0] || t);
    const au = autoDate(S || { days: [] }, t);
    const chg = j.changedAt || (S && S.changedAt) || null;
    return { chg: chg ? new Date(chg).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : null, total: j.total || 0, legend: rels.filter(x => x.count).sort((a, b) => b.count - a.count).map(x => ({ name: sh(x.name), n: x.count })), day: agg(sel, sel), week: agg(monOf(sel), sel), sel, today: t, auto: au, prev, next,
      time: new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Prague' }) };
  };
  const nfz = n => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // čistý text pro Zkratky: /h/<token>/text
  app.get('/h/:t/text', async (req, res) => {
    if (!watchTok(req.params.t)) return res.status(404).type('text/plain; charset=utf-8').send('Nenalezeno.');
    try {
      const dlab = iso => { const q = iso.split('-'); return `${+q[2]}. ${+q[1]}.`; }, w = await watchData(), line = g => g.items.map(x => `${x.name} ${x.a}/${x.m}`).join('\n');
      res.set('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send((`Celkem ${nfz(w.total)}\n` + w.legend.map(x => `${x.name} ${nfz(x.n)}`).join(' · ') + `\n\n${w.sel === w.today ? 'Dnes' : dlab(w.sel)}: agent ${w.day.a}, ručně ${w.day.m}\n` + line(w.day) + `\n\nTýden: agent ${w.week.a}, ručně ${w.week.m}\n` + line(w.week)).trim());
    } catch (e) { res.status(500).type('text/plain; charset=utf-8').send('Chyba serveru.'); }
  });
  const COL = ['#4d8bff', '#ffb020', '#2bffb0', '#c06bff', '#19e3ff', '#ff4fa8', '#b8ff5e', '#ff8a5e', '#9db6ff', '#ffd0f5', '#39ff88', '#e6d3a1'];
  const STRIPE = 'repeating-linear-gradient(45deg,#ffb020 0,#ffb020 2px,rgba(255,176,32,.25) 2px,rgba(255,176,32,.25) 5px)';
  const WD = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];
  const dlabel = (iso, today) => { const [y, m, d] = iso.split('-'); return (iso === today ? 'Dnes' : WD[new Date(iso + 'T12:00:00Z').getUTCDay()]) + ` ${+d}. ${+m}.`; };
  const ring = (legend, total) => { const c = 70, r = 50, w = 14, C = 2 * Math.PI * r, n = legend.length; let acc = 0, arcs = '';
    legend.forEach((x, i) => { const len = C * x.n / (total || 1), gap = n > 1 ? 3 : 0, col = COL[i % COL.length];
      arcs += `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${col}" stroke-opacity=".28" stroke-width="${w + 7}" stroke-dasharray="${Math.max(0, len - gap).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 ${c} ${c})"/><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="butt" stroke-dasharray="${Math.max(0, len - gap).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`; acc += len; });
    if (!total) arcs = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="rgba(255,255,255,.15)" stroke-width="${w}"/>`;
    return `<svg viewBox="0 0 140 140" style="display:block;width:65.21vw;height:65.21vw;margin:0 auto"><circle cx="${c}" cy="${c}" r="${r + w + 3}" fill="none" stroke="rgba(120,160,255,.35)" stroke-dasharray="1.5 5"/>${arcs}<text x="${c}" y="${c + 9}" text-anchor="middle" fill="#fff" font-family="Helvetica,Arial,sans-serif" font-weight="800" font-size="30">${nfz(total)}</text><text x="${c}" y="${c + 24}" text-anchor="middle" fill="#8fa6d9" font-family="Helvetica,Arial,sans-serif" font-weight="700" font-size="8" letter-spacing="2">POZIC</text></svg>`; };
  const barsHtml = (g, idx) => { if (!g.items.length) return '<div class="e">Zatím nic nového</div>'; const max = Math.max(...g.items.map(x => x.a + x.m)) || 1;
    return g.items.map(x => { const col = COL[(idx[x.name] || 0) % COL.length], pc = (x.a + x.m) ? Math.round(100 * x.a / (x.a + x.m)) : 0;
      return `<div class="row"><div class="rt"><span class="n" style="color:${col}">${esc(x.name)}</span><span class="v">+${x.a}<span class="m"> / +${x.m}</span></span></div><div class="bw"><i style="width:${(100 * x.a / max).toFixed(1)}%;background:${col};box-shadow:0 0 2.04vw ${col}"></i>${x.m ? `<i style="width:${(100 * x.m / max).toFixed(1)}%;background:${STRIPE}"></i>` : ''}<span class="pc">${pc} %</span></div></div>`; }).join(''); };
  // CNN Prima: server si z IPTV playlistu (m3u) najde odkaz na stream; stránka je jen <video> bez JavaScriptu (WebKit přehraje HLS nativně)
  const IPTV_LIST = 'https://iptv-org.github.io/iptv/countries/cz.m3u';
  let primaCache = { url: null, at: 0 };
  const findPrima = async () => {
    if (primaCache.url && Date.now() - primaCache.at < 6 * 3600 * 1000) return primaCache.url;
    const r = await fetch(IPTV_LIST, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('playlist ' + r.status);
    let cur = null, found = null;
    for (const raw of (await r.text()).split(/\r?\n/)) {
      const l = raw.trim();
      if (l.startsWith('#EXTINF')) { const k = l.replace(/"[^"]*"/g, '""').lastIndexOf(','); cur = k >= 0 ? l.replace(/"[^"]*"/g, '""').slice(k + 1).trim() : ''; }
      else if (l && !l.startsWith('#') && cur !== null) { if (/cnn\s*prima/i.test(cur) && /^https?:\/\//i.test(l)) { found = l; break; } cur = null; }
    }
    if (!found) throw new Error('CNN Prima není v playlistu');
    try { hlsHosts.add(new URL(found).host); } catch (e) {}
    primaCache = { url: found, at: Date.now() };
    return found;
  };
  // HLS proxy: stream CNN Prima je v playlistu jen na http:// (stránka je https → prohlížeč by ho zablokoval); server ho přeposílá a přepisuje odkazy v m3u8
  const hlsHosts = new Set();
  const b64 = u => Buffer.from(u).toString('base64url'), unb64 = x => Buffer.from(String(x), 'base64url').toString();
  app.get('/h/:t/hls', async (req, res) => {
    if (!watchTok(req.params.t)) return res.status(404).type('text/plain; charset=utf-8').send('Nenalezeno.');
    let u; try { u = new URL(unb64(req.query.u)); } catch (e) { return res.status(400).send('Chybný odkaz.'); }
    if (!/^https?:$/.test(u.protocol)) return res.status(400).send('Chybný odkaz.');
    try { if (!hlsHosts.size) await findPrima(); } catch (e) {}
    if (!hlsHosts.has(u.host)) return res.status(403).send('Nepovolený server.');
    try {
      const h = {}; if (req.headers.range) h.Range = req.headers.range;
      const r = await fetch(u.href, { headers: h, signal: AbortSignal.timeout(20000), redirect: 'follow' });
      if (!r.ok && r.status !== 206) return res.status(502).send('Zdroj streamu neodpovídá (' + r.status + ').');
      const ct = r.headers.get('content-type') || '', isM3 = /mpegurl/i.test(ct) || /\.m3u8?(\?|$)/i.test(u.pathname + u.search);
      if (isM3) {
        const base = r.url || u.href, px = x => { const a = new URL(x, base); hlsHosts.add(a.host); return `/h/${req.params.t}/hls?u=${b64(a.href)}`; };
        const txt = (await r.text()).split(/\r?\n/).map(l => { const t = l.trim(); if (!t) return l; if (t.startsWith('#')) return l.replace(/URI="([^"]+)"/g, (m, x) => `URI="${px(x)}"`); return px(t); }).join('\n');
        return res.set('Cache-Control', 'no-store').type('application/vnd.apple.mpegurl').send(txt);
      }
      res.status(r.status); for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (r.headers.get(k)) res.set(k, r.headers.get(k));
      res.set('Cache-Control', 'no-store'); require('stream').Readable.fromWeb(r.body).on('error', () => res.end()).pipe(res);
    } catch (e) { if (!res.headersSent) res.status(502).send('Stream se nepodařilo načíst.'); }
  });
  // "obrázkové video" pro hodinky: server rozloží stream na JPEG snímky (ffmpeg-static) a posílá je jako multipart MJPEG do obyčejného <img>; jeden divák najednou, max. 10 min
  let mjCur = null;
  app.get('/h/:t/mjpeg', async (req, res) => {
    if (!watchTok(req.params.t)) return res.status(404).type('text/plain; charset=utf-8').send('Nenalezeno.');
    let ff; try { ff = process.env.FFMPEG_BIN || require('ffmpeg-static'); } catch (e) { ff = null; } if (!ff) return res.status(501).send('ffmpeg není k dispozici.');
    let src; try { src = await findPrima(); } catch (e) { return res.status(502).send('Stream nenalezen.'); }
    if (mjCur) { try { mjCur.kill('SIGKILL'); } catch (e) {} }
    const fps = Math.max(1, Math.min(8, +req.query.fps || 4)), w = Math.max(120, Math.min(480, +req.query.w || 320));
    const p = require('child_process').spawn(ff, ['-loglevel', 'error', '-fflags', 'nobuffer', '-i', src, '-an', '-vf', `fps=${fps},scale=${w}:-2`, '-q:v', '8', '-f', 'mpjpeg', '-boundary_tag', 'frame', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    mjCur = p; let got = false;
    const stop = () => { try { p.kill('SIGKILL'); } catch (e) {} if (mjCur === p) mjCur = null; };
    const to = setTimeout(stop, 10 * 60 * 1000);
    res.set({ 'Content-Type': 'multipart/x-mixed-replace;boundary=frame', 'Cache-Control': 'no-store', Connection: 'close' });
    p.stdout.on('data', d => { got = true; res.write(d); });
    p.on('close', () => { clearTimeout(to); if (mjCur === p) mjCur = null; try { res.end(); } catch (e) {} });
    res.on('close', stop);
    setTimeout(() => { if (!got) stop(); }, 25000);
  });
  app.get('/h/:t/prima', async (req, res) => {
    if (!watchTok(req.params.t)) return res.status(404).type('text/plain; charset=utf-8').send('Nenalezeno.');
    const back = `/h/${esc(req.params.t)}`;
    const page = body => res.set('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(`<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CNN Prima</title><style>html,body{margin:0;background:#000;color:#fff;font:700 5vw Helvetica,Arial,sans-serif;text-align:center}video{display:block;width:100%;background:#000}a{display:block;margin:4vw 2vw;padding:3vw;border-radius:7vw;background:#1d388f;color:#fff;text-decoration:none}</style></head><body>${body}<a href="${back}">‹ Zpět</a></body></html>`);
    try {
      const u0 = await findPrima(), u = `/h/${req.params.t}/hls?u=${b64(u0)}`;
      let dg = '';
      try {   // diagnostika: odpovídá zdroj streamu serveru? (zeměpisné omezení, vypnutý stream…)
        const r1 = await fetch(u0, { signal: AbortSignal.timeout(8000) });
        if (!r1.ok) dg = 'Zdroj streamu: HTTP ' + r1.status;
        else { const t1 = await r1.text(), seg = t1.split(/\r?\n/).find(x => x.trim() && !x.startsWith('#')); dg = 'Zdroj OK (' + (/#EXT-X-STREAM-INF/.test(t1) ? 'více kvalit' : (t1.match(/#EXTINF/g) || []).length + ' dílků') + ')';
          if (seg) { const r2 = await fetch(new URL(seg.trim(), r1.url || u0).href, { signal: AbortSignal.timeout(8000) }); dg += ' · další soubor HTTP ' + r2.status; } }
      } catch (e) { dg = 'Zdroj streamu nedostupný ze serveru: ' + String(e.cause && e.cause.code || e.message).slice(0, 60); }
      page(`<img src="/h/${req.params.t}/mjpeg" alt="" style="display:block;width:100%;background:#111;border-radius:3vw;min-height:20vw"><p style="font-size:3.6vw;margin:1vw 0 2vw;color:#8fa6d9">obraz bez zvuku (snímky ze serveru)</p><audio controls autoplay preload="auto" src="${esc(u)}" style="width:100%;margin:3vw 0"></audio><p style="font-size:3.8vw;margin:0 0 2vw">🔊 Jen zvuk – klepni na ▶</p><video controls playsinline src="${esc(u)}"></video><a href="${esc(u)}">▶ Otevřít přímo</a><p style="font-size:3.6vw;color:#8fa6d9">${esc(dg)}</p>`);
    } catch (e) { page(`<p>CNN Prima se nepodařilo načíst.</p><a href="?r=${Date.now()}">↻ Znovu</a>`); }
  });
  // stránka pro prohlížeč v hodinkách (Apple Watch Ultra 2): škáluje se podle šířky (vw), bez JavaScriptu, přepínání dnů přes ?d=; /h/<token>
  app.get('/h/:t', async (req, res) => {
    if (!watchTok(req.params.t)) return res.status(404).type('text/plain; charset=utf-8').send('Nenalezeno.');
    try {
      const w = await watchData(String(req.query.d || '')), tot = w.legend.reduce((o, x) => o + x.n, 0) || w.total, idx = {}; w.legend.forEach((x, i) => { idx[x.name] = i; });
      const nav = `<div class="nav">${w.prev ? `<a href="?d=${w.prev}">‹ Dříve</a>` : '<span>‹ Dříve</span>'}<span class="gap"></span>${w.next ? `<a href="?d=${w.next}">Dál ›</a>` : '<span>Dál ›</span>'}</div>`;
      const refresh = `<a class="ref" href="?d=${w.sel}&r=${Date.now()}">↻ Obnovit</a>`;
      res.set('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(`<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no"><meta http-equiv="refresh" content="1800"><meta name="robots" content="noindex,nofollow"><title>Dispečinky</title>
<style>html{background:#000;-webkit-text-size-adjust:100%;overflow-x:hidden;width:100%;touch-action:pan-y}*{box-sizing:border-box}body{margin:0;padding:0 12vw 10.8vw 1vw;width:100%;box-sizing:border-box;overflow-x:hidden;min-height:100vh;color:#e8f0ff;font:600 5.3vw/1.25 -apple-system,Helvetica,Arial,sans-serif;background:#000}
.top{height:24.45vw}h1{margin:0 0 2.54vw;font:800 3.86vw Helvetica,Arial,sans-serif;letter-spacing:.8.15vw;text-transform:uppercase;text-align:center;color:#8fb2ff}.dtl{text-align:center;font:800 8.57vw Helvetica,Arial,sans-serif;margin:0 0 3.06vw;color:#fff;text-shadow:0 0 4.08vw rgba(122,162,255,.6)}
.nav{display:flex;margin:0 0 4.08vw}.nav a,.nav span{flex:1;height:14.27vw;text-align:center;border-radius:7.13vw;font:800 5.1vw Helvetica,Arial,sans-serif;line-height:14.27vw;text-decoration:none;color:#fff;background:linear-gradient(180deg,rgba(77,139,255,.45),rgba(77,139,255,.18));border:.4.08vw solid rgba(122,162,255,.8);box-shadow:0 0 3.06vw rgba(77,139,255,.35);white-space:nowrap}.nav span{opacity:.25;box-shadow:none}.nav .gap{flex:none;width:3.06vw;background:none;border:0;box-shadow:none;opacity:1}.ref{display:block;margin:0 0 4.08vw;height:14.27vw;text-align:center;border-radius:7.13vw;font:800 5.1vw Helvetica,Arial,sans-serif;line-height:14.27vw;text-decoration:none;color:#fff;background:linear-gradient(180deg,rgba(43,255,176,.35),rgba(43,255,176,.12));border:.4.08vw solid rgba(43,255,176,.7)}
.card{background:#000;border:.35.66vw solid rgba(122,162,255,.4);border-radius:5.1vw;padding:3.56vw 3.56vw 2.54vw;margin-bottom:3.56vw;overflow:hidden;box-shadow:0 0 5.1vw rgba(77,139,255,.25)}
h2{margin:0 0 2.04vw;font:800 3.86vw Helvetica,Arial,sans-serif;letter-spacing:.8.15vw;text-transform:uppercase;color:#8fa6d9}
.lg{display:flex;align-items:center;margin:2.04vw 0;font-size:5.51vw}.lg i{width:3.47vw;height:3.47vw;border-radius:1.02vw;margin-right:2.64vw;flex:none}.lg span{flex:1;font-weight:800}.lg b{font-weight:800}.lg small{color:#8fa6d9;min-width:13.25vw;text-align:right;font-weight:600;font-size:4.68vw}
.big{font-size:17.33vw;font-weight:800;line-height:1;margin:0 0 2.54vw;color:#fff;text-shadow:0 0 4.08vw rgba(122,162,255,.6)}.big small{font-size:4.68vw;color:#8fa6d9;font-weight:700;text-shadow:none;letter-spacing:.2.04vw}
.row{margin:3.06vw 0}.rt{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:1.22vw}.n{font-weight:800;font-size:5.7vw}.v{font-weight:800;font-size:5.1vw}.m{color:#ffb020}
.bw{position:relative;height:5.7vw;display:flex;background:rgba(255,255,255,.1);border-radius:3.06vw;overflow:hidden}.bw i{display:block;height:100%}.pc{position:absolute;right:2.45vw;top:0;line-height:5.7vw;font:800 3.66vw Helvetica,Arial,sans-serif;color:#fff;text-shadow:0 0 2.04vw #000,0 0 1.02vw #000}
.e{color:#8fa6d9;font-size:4.88vw;padding:1.02vw 0 2.04vw}.u{text-align:center;color:#6f7fae;font-size:3.86vw;margin-top:3.06vw;line-height:1.5}.u b{color:#bcd0ff}</style></head><body>
<div class="top"></div><h1>Podíl dispečinků</h1><div class="dtl">${dlabel(w.sel, w.today)}</div>${nav}
<div class="card"><h2>${w.sel === w.today ? 'Dnes přibylo' : 'Přibylo ' + dlabel(w.sel, w.today)}</h2><div class="big">${w.day.a} <small>agent · ručně ${w.day.m}</small></div>${barsHtml(w.day, idx)}</div>
<div class="card"><h2>${w.sel === w.today ? 'Tento týden' : 'Týden do ' + dlabel(w.sel, w.today)}</h2><div class="big">${w.week.a} <small>agent · ručně ${w.week.m}</small></div>${barsHtml(w.week, idx)}</div>
<div class="card"><h2>Celkem · klepni pro obnovení</h2><a href="?d=${w.sel}&r=${Date.now()}" style="display:block;text-decoration:none;-webkit-tap-highlight-color:transparent">${ring(w.legend, tot)}</a><div style="margin-top:3.06vw">${w.legend.map((x, i) => `<div class="lg"><i style="background:${COL[i % COL.length]};box-shadow:0 0 2.04vw ${COL[i % COL.length]}"></i><span style="color:${COL[i % COL.length]}">${esc(x.name)}</span><b>${nfz(x.n)}</b><small>${tot ? Math.round(100 * x.n / tot) : 0} %</small></div>`).join('')}</div></div>
${refresh}<a class="ref" href="/h/${esc(req.params.t)}/prima" style="background:linear-gradient(180deg,rgba(255,79,168,.35),rgba(255,79,168,.12));border-color:rgba(255,79,168,.7)">▶ CNN Prima</a>${nav}<div class="u">Změna v tabulce: <b>${w.chg ? esc(w.chg) : 'neznámá'}</b><br>Stránka načtena ${w.time} · agent / ručně</div></body></html>`);
    } catch (e) { res.status(500).type('text/plain; charset=utf-8').send('Chyba serveru.'); }
  });
  // ikonka na /ai: přihlášený uživatel se přesměruje na svůj odkaz pro hodinky
  app.get('/ai/hodinky', (req, res) => { if (!o.aiOk(req)) return res.redirect('/ai'); res.redirect('/h/' + key()); });
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
        const dn = d.defaultDate === d.todayDate ? 'Dnes' : d.defaultDate.split('-').slice(1).reverse().map(Number).join('. ') + '.', v = String(req.query.v || 'total'), n = x => (x == null ? '–' : String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')), p = x => (x == null ? '–' : x + ' %');
        const out = v === 'today' ? n(d.today.a + d.today.m) : v === 'use' ? p(d.today.pct) : v === 'use5' ? p(d.use5.pct) : v === 'changed' ? (d.changedAt ? new Date(d.changedAt).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–')
          : v === 'all' ? `Celkem ${n(d.total)}\n${dn} ${n(d.today.a + d.today.m)} (agent ${n(d.today.a)})\nVyužití ${dn.toLowerCase()} ${p(d.today.pct)}\nVyužití 5 dní ${p(d.use5.pct)}\nZměna v tabulce ${d.changedAt ? new Date(d.changedAt).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–'}` : n(d.total);
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
const SCRIPT = String.raw`// RKL Agentizace – widget (Scriptable). Parametr widgetu: total | agent (objednávky + přepravy zapsané agentem – vhodné na zamykací obrazovku) | today | use | use5 | all | bars | název relace (např. Západ 1); volitelně za svislítkem den: bars|1 (včera), all|2 (předevčírem), all|2026-11-05
const URL_ = "__URL__";
const RAW = (args.widgetParameter || "all").trim(), PS = RAW.split(/[|;]/).map(x => x.trim());
const P = PS[0];
let OFF = 0, WANT = null; { const o = (PS[1] || "").toLowerCase(); if (o === "včera" || o === "vcera") OFF = 1; else if (/^\d{4}-\d{2}-\d{2}$/.test(o)) WANT = o; else if (/^\d+$/.test(o)) OFF = +o; }
let d; try { d = await new Request(URL_).loadJSON(); } catch (e) { d = null; }
function shiftDay(d) {   // zobrazení jiného dne: nahradí „dnes“ údaji z vybraného dne (parametr např. „bars|1“ = včera, „all|2026-11-05“)
  const base = new Date(d.todayDate + "T12:00:00Z"); const iso = WANT || new Date(base.getTime() - OFF * 864e5).toISOString().slice(0, 10);
  if (iso === d.defaultDate) return { d, label: iso === d.todayDate ? "dnes" : (+iso.split("-")[2]) + ". " + (+iso.split("-")[1]) + "." };
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
let DAY = (d && !d.error && d.defaultDate && d.defaultDate !== d.todayDate) ? (+d.defaultDate.split("-")[2]) + ". " + (+d.defaultDate.split("-")[1]) + "." : "dnes", NODATA = false; if (d && !d.error && (OFF || WANT)) { const r = shiftDay(d); DAY = r.label; NODATA = !!r.noData; }
const w = new ListWidget(); w.backgroundColor = new Color("#070d1f"); w.setPadding(12, 14, 12, 14);
const T = (s, size, color, bold) => { const t = w.addText(String(s)); t.font = bold ? Font.heavySystemFont(size) : Font.mediumSystemFont(size); t.textColor = new Color(color || "#ffffff"); t.minimumScaleFactor = .5; t.lineLimit = 1; return t; };
if (P === "bars" && d && !d.error && config.widgetFamily !== "small") { w.setPadding(10, 10, 6, 10); const im = w.addImage(barsWidget(d, config.widgetFamily || "large")); im.applyFittingContentMode(); im.leftAlignImage(); w.addSpacer(); }
else if (!d || d.error) { T("Bez dat", 16, "#ff6b6b", true); T("zkontroluj odkaz / připojení", 11, "#aab7d6"); }
else {
  const rel = d.rels.find(r => r.name.toLowerCase() === P.toLowerCase());
  let big, label, color = "#ffffff", extra = [];
  if (rel) { big = nf(rel.today.a + rel.today.m); label = "pozic " + DAY + " · " + rel.name; color = "#ffffff"; extra = ["agent " + nf(rel.today.a) + " / ručně " + nf(rel.today.m), "využití 5 dní: " + (rel.use5.pct == null ? "–" : rel.use5.pct + " %")]; }
  else if (P === "total") { big = nf(d.total); label = "pozic celkem"; }
  else if (P === "agent") { big = nf(d.today.all.a); label = "agentem zapsáno " + DAY; extra = ["objednávky + přepravy", "ručně " + nf(d.today.all.m)]; }
  else if (P === "today") { big = nf(d.today.a + d.today.m); label = "pozic " + DAY; extra = ["agent " + nf(d.today.a) + " · ručně " + nf(d.today.m)]; }
  else if (P === "use") { big = d.today.pct == null ? "–" : d.today.pct + " %"; label = "využití agenta " + DAY; color = col(d.today.pct); }
  else if (P === "use5") { big = d.use5.pct == null ? "–" : d.use5.pct + " %"; label = "využití agenta · 5 pracovních dní"; color = col(d.use5.pct); }
  else { big = nf(d.total); label = "pozic celkem"; extra = [DAY + " " + nf(d.today.a + d.today.m) + " (agent " + nf(d.today.a) + ")", "využití " + DAY + " " + (d.today.pct == null ? "–" : d.today.pct + " %"), "5 dní " + (d.use5.pct == null ? "–" : d.use5.pct + " %")]; }
  const fam = config.widgetFamily || "small";
  if (P === "agent") { const sz = { accessoryCircular: 34, accessoryInline: 16, accessoryRectangular: 52, small: 64 }[fam] || 72; if (fam === "accessoryCircular" || fam === "accessoryRectangular") w.addSpacer(); const t = T(big, sz, "#ffffff", true); t.centerAlignText(); if (fam === "accessoryCircular" || fam === "accessoryRectangular") w.addSpacer(); }   // jen číslo, bez textu
  else if (fam === "accessoryInline") { T(label + ": " + big, 12); }
  else if (fam === "accessoryCircular") { T(big, 22, "#ffffff", true); }
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
module.exports = { setup, summarize, autoDate };
