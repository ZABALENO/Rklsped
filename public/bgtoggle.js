/* Přepínač pozadí (hvězdička): krajina / modelky. Výchozí: Vnitro 2 = modelky, ostatní = krajina. Volba se pamatuje v prohlížeči. */
(function () {
  var KEY = 'rkl_bg';   // klíč se doplní podle relace (Vnitro 2 má vlastní volbu)
  function key() { return KEY + (document.body && document.body.classList.contains('t-v2') ? '_v2' : ''); }
  function get() { try { return localStorage.getItem(key()) || ''; } catch (e) { return ''; } }
  function set(v) { try { localStorage.setItem(key(), v); } catch (e) {} }
  var st = document.createElement('style');
  st.textContent = 'html.bgm body::before{background:url(/bg-v2.jpg) center 55%/cover no-repeat !important;filter:none !important}' +
    '.bgstar{position:fixed;left:14px;bottom:14px;z-index:50;width:42px;height:42px;border-radius:50%;border:1px solid rgba(255,255,255,.5);background:rgba(20,30,70,.55);color:#ffd54a;font-size:22px;line-height:1;cursor:pointer;backdrop-filter:blur(4px);opacity:.7}' +
    '.bgstar:hover{opacity:1}@media print{.bgstar{display:none}}';
  document.head.appendChild(st);
  function model() { var p = get(); return p ? p === 'model' : document.body.classList.contains('t-v2'); }
  function apply() { document.documentElement.classList.toggle('bgm', model()); }
  function init() {
    apply();
    var b = document.createElement('button');
    b.className = 'bgstar'; b.type = 'button'; b.textContent = '★'; b.title = 'Přepnout pozadí (krajina / modelky)'; b.setAttribute('aria-label', 'Přepnout pozadí');
    b.onclick = function () { set(model() ? 'land' : 'model'); apply(); };
    document.body.appendChild(b);
  }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
