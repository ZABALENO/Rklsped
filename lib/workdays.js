// Pracovní dny v ČR: bez sobot, nedělí a státních svátků (vč. Velkého pátku a Velikonočního pondělí).
const p2 = n => String(n).padStart(2, '0');
const iso = d => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;

function easterSunday(y) { // anonymní gregoriánský algoritmus
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}
const cache = {};
function holidays(y) {
  if (cache[y]) return cache[y];
  const fixed = ['01-01', '05-01', '05-08', '07-05', '07-06', '09-28', '10-28', '11-17', '12-24', '12-25', '12-26'].map(md => `${y}-${md}`);
  const e = easterSunday(y);
  const fri = new Date(e); fri.setUTCDate(e.getUTCDate() - 2);
  const mon = new Date(e); mon.setUTCDate(e.getUTCDate() + 1);
  return (cache[y] = new Set([...fixed, iso(fri), iso(mon)]));
}
const isWorkday = d => { const w = d.getUTCDay(); return w !== 0 && w !== 6 && !holidays(d.getUTCFullYear()).has(iso(d)); };

// dnešní datum v Praze (YYYY-MM-DD)
function pragueToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
// dnešek + n pracovních dní (YYYY-MM-DD)
function addWorkdays(fromIso, n) {
  const d = new Date(fromIso + 'T00:00:00Z');
  let left = n;
  while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); if (isWorkday(d)) left--; }
  return iso(d);
}
// dnešek - n pracovních dní (YYYY-MM-DD)
function subWorkdays(fromIso, n) {
  const d = new Date(fromIso + 'T00:00:00Z');
  let left = n;
  while (left > 0) { d.setUTCDate(d.getUTCDate() - 1); if (isWorkday(d)) left--; }
  return iso(d);
}
// den (YYYY-MM-DD) v Praze pro časový údaj ISO
function pragueDay(isoTs) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(isoTs));
}
module.exports = { pragueToday, addWorkdays, subWorkdays, isWorkday, pragueDay };
