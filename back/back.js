(function(){
  /* tlačítko „zpět“ na předchozí stránku; bez historie vede na rozcestník */
  var css='.rklback{flex:none;width:34px;height:34px;padding:0;margin-right:4px;display:inline-flex;align-items:center;justify-content:center;border-radius:10px;border:1px solid rgba(94,138,255,.55);background:rgba(94,138,255,.18);color:#fff;cursor:pointer;box-shadow:0 0 14px -2px rgba(94,138,255,.5);font:inherit}.rklback:hover{background:rgba(94,138,255,.35)}.rklback.fx{position:fixed;left:10px;top:10px;z-index:300;margin:0;background:rgba(4,10,34,.8)}.rklback svg{display:block}@media print{.rklback{display:none}}';
  function go(){
    var r=document.referrer,same=false;
    try{var u=new URL(r);same=u.origin===location.origin&&u.pathname.indexOf('/login')>=0}catch(e){}
    if(r&&history.length>1&&!same)history.back();else location.href='https://airkl.cz/';
  }
  function init(){
    if(document.getElementById('rklBack'))return;
    var st=document.createElement('style');st.textContent=css;document.head.appendChild(st);
    var b=document.createElement('button');b.type='button';b.id='rklBack';b.className='rklback';b.title='Zpět na předchozí stránku';b.setAttribute('aria-label','Zpět');
    b.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
    b.onclick=go;
    var h=document.querySelector('header .bar')||document.querySelector('header');
    if(h)h.insertBefore(b,h.firstChild);else{b.className+=' fx';document.body.appendChild(b)}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
