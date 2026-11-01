(function(){
  /* Výchozí je tmavý motiv; měsíc vpravo nahoře přepíná na světlý a volba se pamatuje v prohlížeči */
  var K='rkl_light2',d=document.documentElement,LAT=49.9387,LON=17.9026,R=Math.PI/180;
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
  function isNight(){var n=new Date();return n.getTime()<ut(n,true)||n.getTime()>=ut(n,false)}
  function ov(){try{return JSON.parse(localStorage.getItem(K)||'null')}catch(e){return null}}
  function setOv(o){try{if(o)localStorage.setItem(K,JSON.stringify(o));else localStorage.removeItem(K)}catch(e){}}
  function wantLight(){var o=ov();return !!(o&&o.v)}
  function paint(){
    var on=wantLight();d.classList.toggle('light',on);
    var b=document.getElementById('thBtn');if(b){b.setAttribute('aria-pressed',on?'false':'true');b.title=(on?'Světlý motiv – klikni pro tmavý':'Tmavý motiv – klikni pro světlý')+''}
  }
  paint();
  function init(){
    var b=document.getElementById('thBtn');
    if(!b){b=document.createElement('button');b.type='button';b.id='thBtn';b.className='thbtn';b.setAttribute('aria-label','Světlý / tmavý motiv');
      b.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
      document.body.appendChild(b)}
    b.onclick=function(){setOv({v:!d.classList.contains('light')});paint()};
    paint();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
  setInterval(paint,60000);document.addEventListener('visibilitychange',paint);
})();
