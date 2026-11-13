/* Skenování dokladů v prohlížeči: fotka -> automatický ořez + vyrovnání perspektivy + vylepšení -> vícestránkové PDF.
   Vše běží v telefonu (bez knihoven), na server se posílá až hotové PDF.  Použití: RklScan.create(rootEl) */
(function () {
  'use strict';
  const MAXP = 20, LONG = 1700, MAXPDF = 9 * 1024 * 1024;
  const MODES = [['doc', 'Dokument'], ['color', 'Barevně'], ['raw', 'Originál']];
  const ICO = {
    cam: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="13" r="3.6"/></svg>',
    img: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>',
    rot: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-3-6.2M20 4v5h-5"/></svg>',
    crop: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v16h16M2 6h16v16"/></svg>',
    del: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5l14 14M19 5L5 19"/></svg>',
    pdf: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h10l4 4v14H5z"/><path d="M14 3v5h5"/></svg>'
  };

  const mk = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const cv = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
  const toBlob = (c, q) => new Promise(r => c.toBlob(r, 'image/jpeg', q));
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  async function decode(blob) {
    try { return await createImageBitmap(blob); }
    catch (e) {
      return await new Promise((res, rej) => { const u = URL.createObjectURL(blob), im = new Image(); im.onload = () => { res(im); }; im.onerror = rej; im.src = u; });
    }
  }
  function fit(src, long) {
    const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight, k = Math.min(1, long / Math.max(w, h));
    const c = cv(w * k, h * k), x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height); return c;
  }

  /* ---- hledání dokumentu: Otsu + největší souvislá oblast + čtyři extrémní rohy ---- */
  function boxBlur(g, w, h) {
    const t = new Float32Array(g.length), o = new Float32Array(g.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; t[i] = ((x > 0 ? g[i - 1] : g[i]) + g[i] + (x < w - 1 ? g[i + 1] : g[i])) / 3; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; o[i] = ((y > 0 ? t[i - w] : t[i]) + t[i] + (y < h - 1 ? t[i + w] : t[i])) / 3; }
    return o;
  }
  function otsu(g) {
    const hist = new Array(256).fill(0); for (let i = 0; i < g.length; i++) hist[clamp(Math.round(g[i]), 0, 255)]++;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sB = 0, wB = 0, best = 0, th = 128; const tot = g.length;
    for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sB += i * hist[i]; const d = sB / wB - (sum - sB) / wF, v = wB * wF * d * d; if (v > best) { best = v; th = i; } }
    return th;
  }
  function component(mask, w, h) {
    const lab = new Uint8Array(w * h), stack = new Int32Array(w * h); let bestN = 0, bestIdx = null;
    for (let s = 0; s < w * h; s++) {
      if (!mask[s] || lab[s]) continue;
      let sp = 0, n = 0; const idx = []; stack[sp++] = s; lab[s] = 1;
      while (sp) {
        const p = stack[--sp]; n++; idx.push(p); const x = p % w, y = (p - x) / w;
        if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = 1; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = 1; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !lab[p - w]) { lab[p - w] = 1; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !lab[p + w]) { lab[p + w] = 1; stack[sp++] = p + w; }
      }
      if (n > bestN) { bestN = n; bestIdx = idx; }
    }
    return { n: bestN, idx: bestIdx };
  }
  const polyArea = q => { let a = 0; for (let i = 0; i < 4; i++) { const p = q[i], r = q[(i + 1) % 4]; a += p[0] * r[1] - r[0] * p[1]; } return Math.abs(a) / 2; };
  function detect(c0) {
    const k = 300 / Math.max(c0.width, c0.height), w = Math.max(8, Math.round(c0.width * k)), h = Math.max(8, Math.round(c0.height * k));
    const sc = cv(w, h), sx = sc.getContext('2d'); sx.drawImage(c0, 0, 0, w, h);
    const d = sx.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = .299 * d[i * 4] + .587 * d[i * 4 + 1] + .114 * d[i * 4 + 2];
    const b = boxBlur(boxBlur(g, w, h), w, h), th = otsu(b);
    for (const bright of [true, false]) {
      const mask = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) mask[i] = (bright ? b[i] > th : b[i] <= th) ? 1 : 0;
      const comp = component(mask, w, h); if (!comp.idx) continue;
      const frac = comp.n / (w * h); if (frac < 0.12 || frac > 0.97) continue;
      let tl = null, tr = null, br = null, bl = null, mnS = 1e9, mxS = -1e9, mnD = 1e9, mxD = -1e9;
      for (const p of comp.idx) {
        const x = p % w, y = (p - x) / w, s = x + y, dd = x - y;
        if (s < mnS) { mnS = s; tl = [x, y]; } if (s > mxS) { mxS = s; br = [x, y]; }
        if (dd > mxD) { mxD = dd; tr = [x, y]; } if (dd < mnD) { mnD = dd; bl = [x, y]; }
      }
      const q = [tl, tr, br, bl]; if (q.some(p => !p)) continue;
      const area = polyArea(q); if (area < comp.n * 0.8 || area > comp.n * 1.6) continue;   // tvar by měl odpovídat oblasti
      const side = (a, c) => Math.hypot(a[0] - c[0], a[1] - c[1]), mn = Math.min(side(tl, tr), side(bl, br), side(tl, bl), side(tr, br));
      if (mn < 0.2 * Math.min(w, h)) continue;
      return q.map(p => [p[0] / k, p[1] / k]);
    }
    return null;
  }

  /* ---- vyrovnání perspektivy ---- */
  function solve(A, bv) {
    const n = bv.length; for (let i = 0; i < n; i++) A[i].push(bv[i]);
    for (let c = 0; c < n; c++) {
      let m = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r;
      [A[c], A[m]] = [A[m], A[c]]; const pv = A[c][c]; if (Math.abs(pv) < 1e-12) return null;
      for (let j = c; j <= n; j++) A[c][j] /= pv;
      for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; if (f) for (let j = c; j <= n; j++) A[r][j] -= f * A[c][j]; }
    }
    return A.map(r => r[n]);
  }
  function warp(c0, q) {
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let W = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    const k = Math.min(1, LONG / Math.max(W, H)); W = Math.round(W * k); H = Math.round(H * k);
    const dst = [[0, 0], [W, 0], [W, H], [0, H]], A = [], bv = [];
    for (let i = 0; i < 4; i++) {
      const [u, v] = dst[i], [x, y] = q[i];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); bv.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); bv.push(y);
    }
    const h = solve(A, bv); if (!h) return null;
    const sw = c0.width, sh = c0.height, src = c0.getContext('2d').getImageData(0, 0, sw, sh).data;
    const out = cv(W, H), ox = out.getContext('2d'), img = ox.createImageData(W, H), o = img.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dn = h[6] * x + h[7] * y + 1, fx = (h[0] * x + h[1] * y + h[2]) / dn, fy = (h[3] * x + h[4] * y + h[5]) / dn;
      const x0 = clamp(Math.floor(fx), 0, sw - 2), y0 = clamp(Math.floor(fy), 0, sh - 2), ax = clamp(fx - x0, 0, 1), ay = clamp(fy - y0, 0, 1);
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4, oi = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) o[oi + c] = (src[i00 + c] * (1 - ax) + src[i10 + c] * ax) * (1 - ay) + (src[i01 + c] * (1 - ax) + src[i11 + c] * ax) * ay;
      o[oi + 3] = 255;
    }
    ox.putImageData(img, 0, 0); return out;
  }

  /* ---- vylepšení: vyrovnání osvětlení (dělení pozadím) + kontrast ---- */
  function maxBlurSmall(ch, w, h) {   // odstraní text (max filtr) a vyhladí -> odhad pozadí
    const r = 2, t = new Float32Array(ch.length), o = new Float32Array(ch.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let k = -r; k <= r; k++) { const xx = clamp(x + k, 0, w - 1), v = ch[y * w + xx]; if (v > m) m = v; } t[y * w + x] = m; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let k = -r; k <= r; k++) { const yy = clamp(y + k, 0, h - 1), v = t[yy * w + x]; if (v > m) m = v; } o[y * w + x] = m; }
    let a = o; for (let i = 0; i < 3; i++) a = boxBlur(a, w, h); return a;
  }
  function enhance(c, mode) {
    if (mode === 'raw') return c;
    const W = c.width, H = c.height, x = c.getContext('2d'), img = x.getImageData(0, 0, W, H), d = img.data;
    const k = 1 / 8, sw = Math.max(8, Math.round(W * k)), sh = Math.max(8, Math.round(H * k)), sc = cv(sw, sh), sx = sc.getContext('2d'); sx.drawImage(c, 0, 0, sw, sh);
    const sd = sx.getImageData(0, 0, sw, sh).data, chs = [0, 1, 2].map(() => new Float32Array(sw * sh));
    for (let i = 0; i < sw * sh; i++) { chs[0][i] = sd[i * 4]; chs[1][i] = sd[i * 4 + 1]; chs[2][i] = sd[i * 4 + 2]; }
    const bgs = mode === 'doc' ? [maxBlurSmall(chs[0].map((_, i) => .299 * chs[0][i] + .587 * chs[1][i] + .114 * chs[2][i]), sw, sh)] : chs.map(ch => maxBlurSmall(ch, sw, sh));
    const bgc = bgs.map(b => { const bc = cv(sw, sh), bx = bc.getContext('2d'), bi = bx.createImageData(sw, sh); for (let i = 0; i < sw * sh; i++) { bi.data[i * 4] = bi.data[i * 4 + 1] = bi.data[i * 4 + 2] = clamp(b[i], 0, 255); bi.data[i * 4 + 3] = 255; } bx.putImageData(bi, 0, 0); const fc = cv(W, H), fx = fc.getContext('2d'); fx.imageSmoothingQuality = 'high'; fx.drawImage(bc, 0, 0, W, H); return fx.getImageData(0, 0, W, H).data; });
    const lo = mode === 'doc' ? 105 : 35, hi = mode === 'doc' ? 232 : 238, span = hi - lo;
    for (let i = 0; i < W * H; i++) {
      const p = i * 4;
      if (mode === 'doc') {
        const g = .299 * d[p] + .587 * d[p + 1] + .114 * d[p + 2], bg = Math.max(60, bgc[0][p]);
        const v = clamp((clamp(g * 255 / bg, 0, 255) - lo) / span, 0, 1) * 255; d[p] = d[p + 1] = d[p + 2] = v;
      } else {
        for (let ch = 0; ch < 3; ch++) { const bg = Math.max(60, bgc[ch][p]); d[p + ch] = clamp((clamp(d[p + ch] * 255 / bg, 0, 255) - lo) / span, 0, 1) * 255; }
      }
    }
    x.putImageData(img, 0, 0); return c;
  }
  function rotate(c, r) {
    r = ((r % 4) + 4) % 4; if (!r) return c;
    const o = r % 2 ? cv(c.height, c.width) : cv(c.width, c.height), x = o.getContext('2d');
    x.translate(o.width / 2, o.height / 2); x.rotate(r * Math.PI / 2); x.drawImage(c, -c.width / 2, -c.height / 2); return o;
  }
  async function render(p) {
    const bmp = await decode(p.orig), bw = bmp.width;
    const useCrop = p.crop && p.quad;
    let c0 = fit(bmp, useCrop ? LONG * 2 : LONG); if (bmp.close) bmp.close();
    let c = c0;
    if (useCrop) {
      const f = c0.width / Math.max(1, bw);
      const w = warp(c0, p.quad.map(pt => [pt[0] * f, pt[1] * f])); if (w) c = w;
    }
    c = enhance(c, p.mode); c = rotate(c, p.rot);
    const blob = await toBlob(c, 0.72);
    return { blob, w: c.width, h: c.height };
  }

  /* ---- PDF z JPEG stránek ---- */
  async function buildPdf(pages) {
    const enc = new TextEncoder(), parts = [], offs = []; let off = 0;
    const push = d => { const u = typeof d === 'string' ? enc.encode(d) : d; parts.push(u); off += u.length; };
    const N = 2 + pages.length * 3;
    push('%PDF-1.4\n%âãÏÓ\n');
    offs[1] = off; push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    offs[2] = off; push('2 0 obj\n<< /Type /Pages /Count ' + pages.length + ' /Kids [' + pages.map((_, i) => (3 + 3 * i) + ' 0 R').join(' ') + '] >>\nendobj\n');
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i], bytes = new Uint8Array(await p.out.arrayBuffer()), po = 3 + 3 * i, co = po + 1, io = po + 2;
      const land = p.w > p.h, pw = land ? 841.89 : 595.28, ph = land ? 595.28 : 841.89, s = Math.min(pw / p.w, ph / p.h), dw = p.w * s, dh = p.h * s, x = (pw - dw) / 2, y = (ph - dh) / 2;
      const content = 'q ' + dw.toFixed(2) + ' 0 0 ' + dh.toFixed(2) + ' ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' cm /Im0 Do Q';
      offs[po] = off; push(po + ' 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph + '] /Resources << /XObject << /Im0 ' + io + ' 0 R >> >> /Contents ' + co + ' 0 R >>\nendobj\n');
      offs[co] = off; push(co + ' 0 obj\n<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n');
      offs[io] = off; push(io + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + p.w + ' /Height ' + p.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + bytes.length + ' >>\nstream\n'); push(bytes); push('\nendstream\nendobj\n');
    }
    const xr = off; let t = 'xref\n0 ' + (N + 1) + '\n0000000000 65535 f \n';
    for (let i = 1; i <= N; i++) t += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
    push(t + 'trailer\n<< /Size ' + (N + 1) + ' /Root 1 0 R >>\nstartxref\n' + xr + '\n%%EOF');
    return new Blob(parts, { type: 'application/pdf' });
  }
  const b64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(blob); });

  /* ---- uživatelské rozhraní ---- */
  function create(root, opts) {
    opts = opts || {};
    let pages = [], pdfFile = null, busy = 0, seq = 0;
    root.classList.add('scn');
    root.innerHTML = '';
    const list = mk('div', 'scn-list'), info = mk('div', 'scn-info'), btns = mk('div', 'scn-btns');
    const camLbl = mk('label', 'scn-btn main', ICO.cam + '<span class="t">Naskenovat doklad</span>'), camIn = mk('input'); camIn.type = 'file'; camIn.accept = 'image/*'; camIn.setAttribute('capture', 'environment'); camIn.hidden = true; camLbl.appendChild(camIn);
    const galLbl = mk('label', 'scn-btn', ICO.img + '<span>Z galerie nebo PDF</span>'), galIn = mk('input'); galIn.type = 'file'; galIn.accept = 'image/*,application/pdf'; galIn.multiple = true; galIn.hidden = true; galLbl.appendChild(galIn);
    btns.append(camLbl, galLbl); root.append(list, info, btns);
    const lb = mk('div', 'scn-lb hidden'); lb.addEventListener('click', () => lb.classList.add('hidden')); document.body.appendChild(lb);

    function setInfo(t, err) { info.textContent = t || ''; info.className = 'scn-info' + (err ? ' err' : ''); }
    function refresh() {
      list.innerHTML = '';
      if (pdfFile) {
        const c = mk('div', 'scn-pdf', ICO.pdf + '<div><b>' + esc(pdfFile.name) + '</b><br><span>' + Math.round(pdfFile.size / 1024) + ' kB</span></div>');
        const x = mk('button', 'scn-ib', ICO.del + '<span>Odebrat</span>'); x.type = 'button'; x.onclick = () => { pdfFile = null; refresh(); changed(); }; c.appendChild(x); list.appendChild(c);
      }
      pages.forEach((p, i) => {
        const card = mk('div', 'scn-pg'), im = mk('img'); im.alt = 'Stránka ' + (i + 1); im.src = p.url || ''; im.onclick = () => { lb.innerHTML = '<img src="' + p.url + '" alt="">'; lb.classList.remove('hidden'); };
        const nb = mk('div', 'scn-n', String(i + 1));
        const row = mk('div', 'scn-act');
        const b = (ic, tx, fn) => { const e = mk('button', 'scn-ib', ic + '<span>' + tx + '</span>'); e.type = 'button'; e.onclick = fn; return e; };
        const modeName = MODES.find(m => m[0] === p.mode)[1];
        row.append(
          b(ICO.rot, 'Otočit', () => { p.rot = (p.rot + 1) % 4; reprocess(p); }),
          b(ICO.crop, 'Upravit ořez', () => editCrop(p)),
          mk('span', 'sp'),
          b('', modeName, () => { p.mode = MODES[(MODES.findIndex(m => m[0] === p.mode) + 1) % MODES.length][0]; reprocess(p); }),
          b(ICO.del, 'Smazat', () => { pages = pages.filter(x => x !== p); if (p.url) URL.revokeObjectURL(p.url); refresh(); changed(); })
        );
        card.append(im, nb, row); if (p.busy) card.classList.add('busy'); list.appendChild(card);
      });
      camLbl.querySelector('.t').textContent = (pages.length || pdfFile) ? 'Přidat další stránku' : 'Naskenovat doklad';
    }
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    function changed() { if (opts.onChange) opts.onChange(); }
    function editCrop(p) {
      const W = p.ow, H = p.oh, url = URL.createObjectURL(p.orig);
      const m = Math.min(W, H) * 0.06;
      let q = (p.quad || [[m, m], [W - m, m], [W - m, H - m], [m, H - m]]).map(pt => pt.slice());
      const ov = mk('div', 'scn-ed'), tip = mk('div', 'scn-ed-tip', 'Přetáhněte rohy tak, aby rámeček obepínal doklad'), wrap = mk('div', 'scn-ed-wrap'), box = mk('div', 'scn-ed-box'), img = mk('img'), bar = mk('div', 'scn-ed-bar');
      img.src = url; img.alt = ''; img.draggable = false;
      const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), poly = document.createElementNS(NS, 'polygon');
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.appendChild(poly);
      const hs = q.map((pt, i) => {
        const c = document.createElementNS(NS, 'circle'); c.setAttribute('class', 'h'); svg.appendChild(c);
        c.addEventListener('pointerdown', e => { e.preventDefault(); c.setPointerCapture(e.pointerId); c._d = true; });
        c.addEventListener('pointermove', e => {
          if (!c._d) return; const r = svg.getBoundingClientRect();
          q[i] = [Math.max(0, Math.min(W, (e.clientX - r.left) / r.width * W)), Math.max(0, Math.min(H, (e.clientY - r.top) / r.height * H))]; draw();
        });
        const up = () => { c._d = false; }; c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
        return c;
      });
      function draw() {
        const k = W / Math.max(1, svg.getBoundingClientRect().width || W);
        poly.setAttribute('points', q.map(pt => pt.join(',')).join(' ')); poly.setAttribute('stroke-width', 3 * k);
        hs.forEach((c, i) => { c.setAttribute('cx', q[i][0]); c.setAttribute('cy', q[i][1]); c.setAttribute('r', 22 * k); c.setAttribute('stroke-width', 3 * k); });
      }
      const btn = (cls, tx, fn) => { const e = mk('button', 'scn-btn ' + cls, '<span>' + tx + '</span>'); e.type = 'button'; e.onclick = fn; return e; };
      const close = () => { URL.revokeObjectURL(url); ov.remove(); };
      const row = mk('div', 'scn-ed-row');
      row.append(
        btn('', 'Celá fotka', () => { p.crop = false; close(); reprocess(p); }),
        ...(p.auto ? [btn('', 'Automaticky', () => { q = p.auto.map(pt => pt.slice()); draw(); })] : []),
        btn('', 'Zrušit', close)
      );
      bar.append(btn('main', 'Hotovo', () => { p.quad = q; p.crop = true; close(); reprocess(p); }), row);
      box.append(img, svg); wrap.appendChild(box); ov.append(tip, wrap, bar); document.body.appendChild(ov);
      img.onload = draw; if (img.complete) draw(); window.addEventListener('resize', draw, { once: true });
    }
    async function reprocess(p) {
      p.busy = true; refresh();
      try { const r = await render(p); if (p.url) URL.revokeObjectURL(p.url); p.out = r.blob; p.w = r.w; p.h = r.h; p.url = URL.createObjectURL(r.blob); } catch (e) { setInfo('Stránku se nepodařilo zpracovat.', true); }
      p.busy = false; refresh(); changed();
    }
    async function addImage(file) {
      if (pages.length >= MAXP) { setInfo('Maximálně ' + MAXP + ' stránek.', true); return; }
      busy++; setInfo('Zpracovávám stránku…');
      try {
        const bmp = await decode(file), big = fit(bmp, LONG * 2); if (bmp.close) bmp.close();
        const c0 = fit(big, LONG), orig = await toBlob(big, 0.9), fq = big.width / c0.width, q0 = detect(c0), quad = q0 && q0.map(pt => [pt[0] * fq, pt[1] * fq]);
        const p = { id: ++seq, orig, quad, auto: quad, ow: big.width, oh: big.height, crop: !!quad, mode: 'doc', rot: 0 };
        pages.push(p); await reprocess(p);
        setInfo(quad ? '' : 'Okraje dokladu se nepodařilo najít. Upravte ořez ručně.'); if (!quad) editCrop(p);
      } catch (e) { setInfo('Fotku se nepodařilo načíst.', true); }
      busy--; if (!busy && !info.classList.contains('err') && pages.every(x => x.quad || !x.busy) === false) { /* nic */ }
    }
    async function handle(files) {
      for (const f of Array.from(files || [])) {
        if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) {
          if (f.size > MAXPDF) { setInfo('PDF je příliš velké (max. 9 MB).', true); continue; }
          pages.forEach(p => p.url && URL.revokeObjectURL(p.url)); pages = []; pdfFile = f; refresh(); changed(); setInfo('');
        } else if (/^image\//.test(f.type) || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name)) { if (pdfFile) { pdfFile = null; } await addImage(f); }
      }
      refresh();
    }
    camIn.addEventListener('change', async () => { await handle(camIn.files); camIn.value = ''; });
    galIn.addEventListener('change', async () => { await handle(galIn.files); galIn.value = ''; });
    refresh();
    return {
      count: () => (pdfFile ? 1 : pages.length),
      isBusy: () => busy > 0 || pages.some(p => p.busy),
      clear() { pages.forEach(p => p.url && URL.revokeObjectURL(p.url)); pages = []; pdfFile = null; setInfo(''); refresh(); },
      async getPdf() {
        if (pdfFile) return { b64: await b64(pdfFile), pages: 1 };
        if (!pages.length) return null;
        const blob = await buildPdf(pages); if (blob.size > MAXPDF) throw new Error('too_big');
        return { b64: await b64(blob), pages: pages.length };
      }
    };
  }
  window.RklScan = { create };
})();
