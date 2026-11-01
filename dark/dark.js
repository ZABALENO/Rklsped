(function(){
  /* Tmavý režim: automaticky podle východu/západu slunce v Opavě (74601); měsíc vpravo nahoře přepíná ručně do příštího východu/západu */
  var K='rkl_dark2',d=document.documentElement,LAT=49.9387,LON=17.9026,R=Math.PI/180;
  function ut(day,rise){
    var N=Math.floor((Date.UTC(day.getFullYear(),day.getMonth(),day.getDate())-Date.UTC(day.getFullYear(),0,0))/864e5);
    var lh=LON/15,t=N+((rise?6:18)-lh)/24,M=0.9856*t-3.289;
    var L=(M+1.916*Math.sin(M*R)+0.020*Math.sin(2*M*R)+282.634)%360;if(L<0)L+=360;
    var RA=Math.atan(0.91764*Math.tan(L*R))/R;RA=(RA+360)%360;RA+=Math.floor(L/90)*90-Math.floor(RA/90)*90;RA/=15;
    var sd=0.39782*Math.sin(L*R),cd=Math.cos(Math.asin(sd));
    var ch=(Math.cos(90.833*R)-sd*Math.sin(LAT*R))/(cd*Math.cos(LAT*R));
    if(ch>1)return rise?1e15:-1e15;if(ch<-1)return rise?-1e15:1e15;
    var H=rise?360-Math.acos(ch)/R:Math.acos(ch)/R;H/=15;
    var T=H+RA-0.06571*t-6.622,U=((T-lh)%24+24)%24;
    return Date.UTC(day.getFullYear(),day.getMonth(),day.getDate())+U*36e5;
  }
  function autoDark(){var n=new Date();return n.getTime()<ut(n,true)||n.getTime()>=ut(n,false)}
  function ov(){try{return JSON.parse(localStorage.getItem(K)||'null')}catch(e){return null}}
  function setOv(o){try{if(o)localStorage.setItem(K,JSON.stringify(o));else localStorage.removeItem(K)}catch(e){}}
  function want(){var a=autoDark(),o=ov();if(o&&o.a===a)return !!o.v;if(o)setOv(null);return a}
  function paint(){
    var on=want();d.classList.toggle('dark',on);
    var b=document.getElementById('darkBtn');if(b){b.setAttribute('aria-pressed',on?'true':'false');b.title=(on?'Tmavý režim – klikni pro světlý':'Světlý režim – klikni pro tmavý')+' (automaticky podle východu a západu slunce v Opavě)'}
  }
  paint();
  function init(){
    var b=document.getElementById('darkBtn');
    if(!b){var bar=document.querySelector('header .bar')||document.querySelector('header');if(!bar)return;
      b=document.createElement('button');b.id='darkBtn';b.type='button';b.className='darkbtn';b.setAttribute('aria-label','Tmavý režim');
      b.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
      bar.appendChild(b)}
    b.onclick=function(){setOv({v:!d.classList.contains('dark'),a:autoDark()});paint()};
    paint();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
  setInterval(paint,60000);
  document.addEventListener('visibilitychange',paint);
})();
