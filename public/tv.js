// Režim TV: zvětší celou stránku podle šířky obrazovky (televize ~140 cm).
// Zapíná se tlačítkem „Režim TV“ nebo adresou ?tv=1 (vypnutí ?tv=0); pamatuje si ho prohlížeč.
(() => {
  const KEY = 'rkl_tv';
  const h = document.documentElement;
  const q = new URLSearchParams(location.search);
  try { if (q.has('tv')) localStorage.setItem(KEY, q.get('tv') === '0' ? '0' : '1'); } catch {}
  let on = false, stored = null;
  try { stored = localStorage.getItem(KEY); } catch {}
  // bez uložené volby: stránka s data-tv-auto se na velké obrazovce (TV) zapne sama
  if (stored === null && h.dataset.tvAuto) on = window.innerWidth >= +h.dataset.tvAuto;
  else on = stored === '1';
  const base = +(h.dataset.tvBase || 1400);   // šířka rozložení v CSS px, na kterou se stránka zvětší
  function apply() {
    h.classList.toggle('tv', on);
    h.style.zoom = on ? String(Math.max(1, Math.min(3, window.innerWidth / base))) : '';
    const b = document.getElementById('tvBtn');
    if (b) { b.setAttribute('aria-pressed', on); b.textContent = on ? 'Režim TV: zapnuto' : 'Režim TV'; }
  }
  apply();
  addEventListener('resize', apply);
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('tvBtn');
    if (b) b.addEventListener('click', () => { on = !on; try { localStorage.setItem(KEY, on ? '1' : '0'); } catch {} apply(); });
    apply();
  });
})();
