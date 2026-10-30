// TV stanice: trojklik na logo RKL otevře seznam kanálů z IPTV playlistu (m3u) a malé okno s přehrávačem (HLS).
(() => {
  const LIST = 'https://iptv-org.github.io/iptv/countries/cz.m3u';
  const HLS_JS = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js';
  let panel = null, chans = null, hidden = 0, hls = null, box = null, curUrl = '';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = document.createElement('style');
  css.textContent = `
  #iptvP{position:fixed;left:12px;bottom:12px;width:min(360px,calc(100vw - 24px));max-height:70vh;display:flex;flex-direction:column;background:#fff;color:#0f1b2d;border:1px solid #cfd8e6;border-radius:12px;box-shadow:0 10px 40px rgba(10,20,50,.35);z-index:9000;font:14px/1.3 system-ui,sans-serif}
  #iptvP header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e3e9f2;font-weight:700}
  #iptvP header span{flex:1}#iptvP button{font:inherit;border:1px solid #cfd8e6;background:#f3f6fa;border-radius:8px;padding:3px 9px;cursor:pointer}
  #iptvP input{margin:8px 12px;padding:6px 9px;border:1px solid #cfd8e6;border-radius:8px;font:inherit}
  #iptvP ul{list-style:none;margin:0;padding:0 6px 8px;overflow:auto;flex:1}
  #iptvP li{padding:7px 10px;border-radius:8px;cursor:pointer;display:flex;gap:8px;align-items:center}
  #iptvP li:hover{background:#eef3ff}#iptvP li.on{background:#1d388f;color:#fff}
  #iptvP li small{opacity:.6;margin-left:auto;white-space:nowrap}
  #iptvP .note{padding:0 12px 8px;font-size:12px;opacity:.65}
  #iptvV{position:fixed;right:12px;bottom:12px;width:min(380px,calc(100vw - 24px));background:#000;border-radius:12px;overflow:hidden;box-shadow:0 10px 40px rgba(10,20,50,.5);z-index:9001;color:#fff;font:13px system-ui,sans-serif}
  #iptvV.big{width:min(900px,calc(100vw - 24px))}
  #iptvV video{display:block;width:100%;aspect-ratio:16/9;background:#000}
  #iptvV .bar{display:flex;gap:6px;align-items:center;padding:6px 8px;background:#101a33}
  #iptvV .bar b{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #iptvV button{font:inherit;border:0;background:#2a3a66;color:#fff;border-radius:6px;padding:3px 8px;cursor:pointer}
  #iptvV .err{padding:6px 10px;background:#7a1f1f;display:none}`;
  document.head.appendChild(css);

  function parse(t) {
    const out = []; let cur = null, skip = 0;
    for (const raw of t.split(/\r?\n/)) {
      const l = raw.trim();
      if (l.startsWith('#EXTINF')) { const g = l.match(/group-title="([^"]*)"/); const bare = l.replace(/"[^"]*"/g, '""'); const k = bare.lastIndexOf(','); cur = { name: (k >= 0 ? bare.slice(k + 1) : '').trim() || 'Kanál', group: g ? g[1] : '' }; }
      else if (l && !l.startsWith('#') && cur) { if (/^https:\/\//i.test(l)) out.push({ ...cur, url: l }); else skip++; cur = null; }
    }
    hidden = skip; return out;
  }
  async function load() {
    if (chans) return chans;
    const r = await fetch(LIST, { cache: 'no-store' }); if (!r.ok) throw new Error('seznam se nenačetl (' + r.status + ')');
    chans = parse(await r.text()); return chans;
  }
  function stop() { curUrl = ''; if (hls) { hls.destroy(); hls = null; } if (box) { const v = box.querySelector('video'); v.pause(); v.removeAttribute('src'); v.load(); box.remove(); box = null; } panel && panel.querySelectorAll('li.on').forEach(x => x.classList.remove('on')); }
  function hlsLib() { return window.Hls ? Promise.resolve() : new Promise((ok, no) => { const s = document.createElement('script'); s.src = HLS_JS; s.onload = ok; s.onerror = () => no(new Error('knihovna přehrávače se nenačetla')); document.head.appendChild(s); }); }
  async function play(ch) {
    stop(); curUrl = ch.url;
    box = document.createElement('div'); box.id = 'iptvV';
    box.innerHTML = `<video playsinline muted autoplay controls></video><div class="err"></div><div class="bar"><b>${esc(ch.name)}</b><button data-a="mute" title="Zvuk">🔇</button><button data-a="big" title="Větší / menší">⤢</button><button data-a="x" title="Zavřít">✕</button></div>`;
    document.body.appendChild(box);
    const v = box.querySelector('video'), er = box.querySelector('.err');
    const fail = m => { er.textContent = 'Kanál se nepodařilo přehrát: ' + m; er.style.display = 'block'; };
    box.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const a = b.dataset.a; if (a === 'x') stop(); if (a === 'big') box.classList.toggle('big'); if (a === 'mute') { v.muted = !v.muted; b.textContent = v.muted ? '🔇' : '🔊'; } });
    try {
      if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = ch.url; v.onerror = () => fail('stream není dostupný'); }
      else {
        await hlsLib();
        if (!window.Hls.isSupported()) return fail('prohlížeč nepodporuje HLS');
        hls = new window.Hls({ lowLatencyMode: false });
        hls.on(window.Hls.Events.ERROR, (_, d) => { if (d.fatal) fail(d.details === 'manifestLoadError' ? 'stream není dostupný nebo ho server nepovoluje (CORS / geo blokace)' : d.details); });
        hls.loadSource(ch.url); hls.attachMedia(v);
      }
      v.play().catch(() => {});
    } catch (e) { fail(e.message); }
  }
  async function toggle() {
    if (panel) { panel.remove(); panel = null; return; }   // zavření seznamu nechá video běžet
    panel = document.createElement('div'); panel.id = 'iptvP';
    panel.innerHTML = '<header><span>TV stanice</span><button data-a="x">✕</button></header><input placeholder="Hledat kanál…"><ul><li>Načítám…</li></ul><div class="note"></div>';
    document.body.appendChild(panel);
    panel.querySelector('[data-a=x]').onclick = toggle;
    const ul = panel.querySelector('ul'), inp = panel.querySelector('input');
    try {
      const list = await load();
      const draw = () => {
        const q = inp.value.trim().toLowerCase();
        const f = list.filter(c => !q || c.name.toLowerCase().includes(q));
        ul.innerHTML = f.map(c => `<li data-i="${list.indexOf(c)}"${c.url === curUrl ? ' class="on"' : ''}>${esc(c.name)}<small>${esc(c.group)}</small></li>`).join('') || '<li>Nic nenalezeno</li>';
      };
      draw(); inp.oninput = draw;
      panel.querySelector('.note').textContent = list.length + ' kanálů' + (hidden ? ' (' + hidden + ' skryto – nešifrovaný odkaz http)' : '') + '. Část kanálů nemusí jít přehrát (omezení vysílatele).';
      ul.onclick = e => { const li = e.target.closest('li[data-i]'); if (!li) return; ul.querySelectorAll('li.on').forEach(x => x.classList.remove('on')); li.classList.add('on'); play(list[+li.dataset.i]); };
    } catch (e) { ul.innerHTML = '<li>Seznam se nepodařilo načíst: ' + esc(e.message) + '</li>'; }
  }
  // trojklik na logo RKL v záhlaví
  let n = 0, t0 = 0;
  document.addEventListener('click', e => {
    const img = e.target.closest && e.target.closest('img'); if (!img || !/logo\.jpg/.test(img.getAttribute('src') || '')) return;
    const now = Date.now(); n = now - t0 < 700 ? n + 1 : 1; t0 = now;
    if (n >= 3) { n = 0; toggle(); }
  });
})();
