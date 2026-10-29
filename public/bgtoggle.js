/* Přepínač pozadí (hvězdička): krajina / modelky. Výchozí: Vnitro 2 = modelky, ostatní = krajina. Volba se pamatuje v prohlížeči. */
(function () {
  var KEY = 'rkl_bg';   // klíč se doplní podle relace (Vnitro 2 má vlastní volbu)
  function key() { return KEY + (document.body && document.body.classList.contains('t-v2') ? '_v2' : ''); }
  function get() { try { return localStorage.getItem(key()) || ''; } catch (e) { return ''; } }
  function set(v) { try { localStorage.setItem(key(), v); } catch (e) {} }
  var st = document.createElement('style');
  st.textContent = 'html.bgm body::before{background:url(/bg-v2.jpg) center 55%/cover no-repeat !important;filter:none !important}' +
    '.bgstar{background:none;border:0;color:rgba(255,255,255,.5);font-size:17px;line-height:1;cursor:pointer;padding:4px 6px;margin:0 6px;align-self:center}' +
    '.bgstar:hover{color:#ffd54a}.bgstar.fix{position:fixed;left:10px;bottom:10px;z-index:50;margin:0}@media print{.bgstar{display:none}}';
  document.head.appendChild(st);
  function model() { var p = get(); return p ? p === 'model' : document.body.classList.contains('t-v2'); }
  function apply() { document.documentElement.classList.toggle('bgm', model()); }
  function init() {
    apply();
    var b = document.createElement('button');
    b.className = 'bgstar'; b.type = 'button'; b.textContent = '★'; b.title = 'Přepnout pozadí (krajina / modelky)'; b.setAttribute('aria-label', 'Přepnout pozadí');
    b.onclick = function () { set(model() ? 'land' : 'model'); apply(); };
    var clk = document.querySelector('header .clock');
    if (clk && clk.parentNode) clk.parentNode.insertBefore(b, clk); else { b.className += ' fix'; document.body.appendChild(b); }
  }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
