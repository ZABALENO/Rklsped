// Režimy TV (televize ~140 cm):
//   TV 1 – celá stránka zvětšená podle šířky obrazovky (jako dřív),
//   TV 2 – slidy: velké písmo, na jednom slidu jen několik přeprav (výchozí 4), po N sekundách (výchozí 20) další slide.
// Zapíná se tlačítky „TV 1“ / „TV 2“ nebo adresou ?tv=1 / ?tv=2 (vypnutí ?tv=0); pamatuje si ho prohlížeč.
// Volitelně ?per=5 (přeprav na slide) a ?sec=15 (sekund na slide).
(() => {
  const KEY = 'rkl_tv', KPER = 'rkl_tv_per', KSEC = 'rkl_tv_sec';
  const h = document.documentElement;
  const q = new URLSearchParams(location.search);
  const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  if (q.has('tv')) ls.set(KEY, ['0', '1', '2'].includes(q.get('tv')) ? q.get('tv') : '1');
  if (q.has('per') && +q.get('per') >= 1) ls.set(KPER, String(Math.min(12, +q.get('per'))));
  if (q.has('sec') && +q.get('sec') >= 5) ls.set(KSEC, String(Math.min(120, +q.get('sec'))));
  let mode = 0;
  const stored = ls.get(KEY);
  if (stored === null && h.dataset.tvAuto) mode = window.innerWidth >= +h.dataset.tvAuto ? 1 : 0;   // velká obrazovka (TV) se zapne sama
  else mode = stored === '2' ? 2 : stored === '1' ? 1 : 0;
  let per = Math.max(1, +(ls.get(KPER) || h.dataset.tvPer || 4));
  let sec = Math.max(5, +(ls.get(KSEC) || 20));
  const base1 = +(h.dataset.tvBase || 1400), base2 = +(h.dataset.tv2Base || 1000);
  const zoomNow = () => (mode ? Math.max(1, Math.min(3, window.innerWidth / (mode === 2 ? base2 : base1))) : 1);

  const R = window.RKL = { onWrap: null, onChange: null };
  R.mode = () => mode; R.per = () => per; R.sec = () => sec; R.zoom = zoomNow;

  let rows = [], cur = 0, timer = null, bar = null;
  function indicator(pages) {
    const el = document.getElementById('pgInd');
    if (el) el.textContent = mode === 2 && pages > 1 ? `${cur + 1} / ${pages}` : '';
    if (!bar) { bar = document.createElement('div'); bar.id = 'pgBar'; document.body.appendChild(bar); }
    bar.style.display = mode === 2 && pages > 1 ? '' : 'none';
    bar.style.animation = 'none'; void bar.offsetWidth;
    bar.style.animation = `pgbar ${sec}s linear forwards`;
  }
  // výška řádku tak, aby slide vyplnil obrazovku (CSS zoom: měření v reálných px, výška v CSS px)
  function fit() {
    if (mode !== 2) { h.style.removeProperty('--rowh'); return; }
    // místo pod hlavičkou viditelné tabulky (po zahlaví) až na spodek obrazovky
    const th = [...document.querySelectorAll('table thead')].find(t => t.offsetParent);
    const used = (th ? th.getBoundingClientRect().bottom : 0) + 22 * zoomNow();
    const avail = window.innerHeight - used;
    h.style.setProperty('--rowh', Math.max(60, Math.floor(avail / per / zoomNow())) + 'px');
  }
  function slice() {
    const pages = Math.max(1, Math.ceil(rows.length / per));
    if (cur >= pages) cur = 0;
    rows.forEach((tr, i) => tr.classList.toggle('pg-off', mode === 2 && Math.floor(i / per) !== cur));
    fit(); indicator(pages);
    return pages;
  }
  // stránka zavolá po každém vykreslení se seznamem řádků (tr) aktuálního pohledu
  R.page = list => { rows = list || []; if (mode !== 2) { rows.forEach(tr => tr.classList.remove('pg-off')); indicator(1); return; } slice(); };
  R.next = () => {
    if (mode !== 2) return;
    const pages = Math.max(1, Math.ceil(rows.length / per));
    cur++;
    if (cur >= pages) { cur = 0; if (R.onWrap && R.onWrap() === true) return; }
    slice();
  };
  R.reset = () => { cur = 0; };
  function restart() { clearInterval(timer); timer = setInterval(() => R.next(), sec * 1000); }
  R.setPer = n => { per = Math.max(1, Math.min(12, n)); ls.set(KPER, String(per)); cur = 0; if (R.onChange) R.onChange(); else slice(); };
  R.setSec = n => { sec = Math.max(5, Math.min(120, n)); ls.set(KSEC, String(sec)); restart(); if (R.onChange) R.onChange(); else slice(); };

  function apply() {
    h.classList.toggle('tv', mode > 0);
    h.classList.toggle('tv2', mode === 2);
    h.style.zoom = mode ? String(zoomNow()) : '';
    const b1 = document.getElementById('tvBtn'), b2 = document.getElementById('tv2Btn');
    if (b1) { b1.setAttribute('aria-pressed', mode === 1); b1.textContent = mode === 1 ? 'TV 1: zapnuto' : 'TV 1'; }
    if (b2) { b2.setAttribute('aria-pressed', mode === 2); b2.textContent = mode === 2 ? 'TV 2 (slidy): zapnuto' : 'TV 2 (slidy)'; }
    const ps = document.getElementById('perBtn'), ss = document.getElementById('secBtn');
    if (ps) ps.textContent = per + ' na slide';
    if (ss) ss.textContent = sec + ' s';
    if (document.body) slice();
  }
  function setMode(m) {
    mode = mode === m ? 0 : m; ls.set(KEY, String(mode)); cur = 0;
    apply(); restart();
    if (R.onChange) R.onChange();
  }
  apply();
  addEventListener('resize', apply);
  document.addEventListener('DOMContentLoaded', () => {
    const b1 = document.getElementById('tvBtn'), b2 = document.getElementById('tv2Btn');
    if (b1) b1.addEventListener('click', () => setMode(1));
    if (b2) b2.addEventListener('click', () => setMode(2));
    const ps = document.getElementById('perBtn'), ss = document.getElementById('secBtn');
    if (ps) ps.addEventListener('click', () => { const o = [3, 4, 5, 6]; R.setPer(o[(o.indexOf(per) + 1) % o.length] || 4); apply(); });
    if (ss) ss.addEventListener('click', () => { const o = [10, 15, 20, 30, 45]; R.setSec(o[(o.indexOf(sec) + 1) % o.length] || 20); apply(); });
    apply(); restart();
  });
})();
